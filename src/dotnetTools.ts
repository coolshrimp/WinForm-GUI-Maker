// UI Maker — thin wrappers around the .NET CLI.
//
// Build and Release run as VS Code Tasks so compiler errors land in the
// Problems panel (via the $msCompile problem matcher). Run executes as a task
// too, which is how the extension knows when the app exits — the Run button
// is a play/stop toggle and `onDidChangeState` lets the sidebar and status
// bar mirror the current state. Debug builds first, then starts a debug
// session against the output assembly (requires the C# extension).
//
// Protections for "works on any dev machine":
//   * SDK-style projects that target .NET Framework build fine with the
//     dotnet CLI **if** the reference assemblies exist; when they don't
//     (error MSB3644), the user is offered the
//     Microsoft.NETFramework.ReferenceAssemblies NuGet helper.
//   * Classic non-SDK projects cannot be built by the dotnet CLI at all;
//     those are routed to Visual Studio's MSBuild.exe (found via vswhere)
//     and the built .exe is launched directly.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import {
    readProjectInfo, isNetFrameworkTfm, frameworkLabel,
    refAssembliesInstalled, addRefAssembliesHelper, findMsBuild
} from './projectInfo';
import { EXCLUDE_GLOB, getWorkingFolder, inExcludedDir, setWorkingFolder } from './workingFolder';

export type RunState = 'idle' | 'running' | 'debugging';

const DEBUG_SESSION_NAME = 'UI Maker: Debug';

export class DotnetTools implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    /** Task execution backing Run (dotnet run), when that path is used. */
    private runExecution: vscode.TaskExecution | undefined;
    /** Direct child process backing Run for classic .NET Framework exes. */
    private runProcess: cp.ChildProcess | undefined;
    private output: vscode.OutputChannel | undefined;

    /** Projects already asked about the reference-assemblies helper. */
    private readonly askedRefAssemblies = new Set<string>();

    private _state: RunState = 'idle';
    private readonly stateEmitter = new vscode.EventEmitter<RunState>();
    /** Fires whenever the app starts or stops (running / debugging / idle). */
    public readonly onDidChangeState = this.stateEmitter.event;

    public get state(): RunState {
        return this._state;
    }

    constructor() {
        // Run (task flavor) ends -> back to idle.
        this.disposables.push(vscode.tasks.onDidEndTaskProcess(e => {
            if (e.execution === this.runExecution) {
                this.runExecution = undefined;
                this.setState('idle');
            }
        }));
        // Our debug session starts/ends -> mirror the state.
        this.disposables.push(vscode.debug.onDidStartDebugSession(s => {
            if (s.name === DEBUG_SESSION_NAME) { this.setState('debugging'); }
        }));
        this.disposables.push(vscode.debug.onDidTerminateDebugSession(s => {
            if (s.name === DEBUG_SESSION_NAME) { this.setState('idle'); }
        }));
    }

    dispose(): void {
        this.stop();
        this.disposables.forEach(d => d.dispose());
        this.output?.dispose();
    }

    private setState(state: RunState): void {
        if (this._state === state) { return; }
        this._state = state;
        this.stateEmitter.fire(state);
    }

    // ---------------------------------------------------------------- toggles

    /** Play/stop behavior for the Run button. */
    async runToggle(): Promise<void> {
        if (this._state === 'running') { this.stop(); return; }
        this.stop();
        await this.run();
    }

    /** Play/stop behavior for the Debug button. */
    async debugToggle(): Promise<void> {
        if (this._state === 'debugging') { this.stop(); return; }
        this.stop();
        await this.debug();
    }

    // ------------------------------------------------------------------ Build

    async build(): Promise<void> {
        const project = await this.findProject();
        if (!project) { return; }
        const pre = await this.preflight(project);
        if (!pre) { return; }
        if (pre.msbuild) {
            await this.execTask('build', [project, '/p:Configuration=Debug', '/v:m'], pre.msbuild);
        } else {
            await this.execTask('build', ['build', project, '-c', 'Debug']);
        }
    }

    // -------------------------------------------------------------------- Run

    async run(): Promise<void> {
        const project = await this.findProject();
        if (!project) { return; }
        const pre = await this.preflight(project);
        if (!pre) { return; }
        this.stop();

        // Classic projects: build with MSBuild, then launch the exe directly
        // (dotnet run does not understand non-SDK projects).
        if (pre.msbuild) {
            const code = await this.execTaskAndWait('build', [project, '/p:Configuration=Debug', '/v:m'], pre.msbuild);
            if (code !== 0) {
                vscode.window.showErrorMessage('UI Maker: build failed — see the terminal output.');
                return;
            }
            const exe = this.findOutputBinary(project, '.exe');
            if (!exe) {
                vscode.window.showErrorMessage('UI Maker: build succeeded but the output .exe was not found.');
                return;
            }
            if (this.requiresElevation(project)) {
                this.launchExeElevated(exe);
            } else {
                this.launchExe(exe);
            }
            return;
        }

        // Apps whose manifest demands administrator rights cannot be started
        // by `dotnet run` — the launch dies with "The requested operation
        // requires elevation" (error 740). Build, then launch the exe through
        // a UAC prompt instead.
        if (this.requiresElevation(project)) {
            const code = await this.execTaskAndWait('build', ['build', project, '-c', 'Debug']);
            if (code !== 0) {
                vscode.window.showErrorMessage('UI Maker: build failed — see the terminal output.');
                return;
            }
            const exe = this.findOutputBinary(project, '.exe');
            if (exe) {
                this.launchExeElevated(exe);
                return;
            }
            // No apphost .exe found — fall through and let dotnet run try.
        }

        // `dotnet run` builds first, so a stale binary is never launched.
        // Running it as a task tells us when the app exits (play/stop toggle).
        this.runExecution = await this.execTask('run', ['run', '--project', project]);
        this.setState('running');
    }

    // -------------------------------------------------------------- elevation

    /**
     * True when the app's manifest asks Windows for administrator rights
     * (requireAdministrator or highestAvailable). Such apps cannot be started
     * by `dotnet run` or a plain process spawn.
     */
    private requiresElevation(project: string): boolean {
        const dir = path.dirname(project);
        const xml = this.tryRead(project) ?? '';
        // The csproj can point at the manifest; otherwise check the two
        // places Visual Studio puts app.manifest by default.
        const declared = /<ApplicationManifest>\s*([^<]+?)\s*<\/ApplicationManifest>/.exec(xml)?.[1];
        const candidates = declared
            ? [path.isAbsolute(declared) ? declared : path.join(dir, declared)]
            : [path.join(dir, 'app.manifest'), path.join(dir, 'Properties', 'app.manifest')];
        for (const file of candidates) {
            const manifest = this.tryRead(file);
            if (manifest && /requestedExecutionLevel\s[^>]*level\s*=\s*"(requireAdministrator|highestAvailable)"/i.test(manifest)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Launch an admin-manifested .exe through the UAC prompt
     * (Start-Process -Verb RunAs). The PowerShell wrapper waits for the app,
     * so the play/stop toggle still follows it; if the user cancels the UAC
     * prompt the wrapper exits and the state flips straight back to idle.
     */
    private launchExeElevated(exe: string): void {
        this.output ??= vscode.window.createOutputChannel('UI Maker: Run');
        this.output.appendLine(`[UI Maker] ${path.basename(exe)} requests administrator rights — launching with a UAC prompt.`);
        this.output.appendLine('[UI Maker] note: Stop cannot force-close an elevated app; close its window instead.');
        const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
        const child = cp.spawn('powershell', [
            '-NoProfile', '-Command',
            `Start-Process -FilePath ${psQuote(exe)} -WorkingDirectory ${psQuote(path.dirname(exe))} -Verb RunAs -Wait`
        ], { windowsHide: true });
        child.stderr?.on('data', d => this.output?.append(String(d)));
        child.on('error', err => {
            this.output?.appendLine(`[UI Maker] failed to start: ${err.message}`);
            this.runProcess = undefined;
            this.setState('idle');
        });
        child.on('exit', code => {
            this.output?.appendLine(`[UI Maker] exited with code ${code ?? 'unknown'}`);
            this.runProcess = undefined;
            this.setState('idle');
        });
        this.runProcess = child;
        this.setState('running');
    }

    /** Launch a built .exe as a tracked child process (classic projects). */
    private launchExe(exe: string): void {
        this.output ??= vscode.window.createOutputChannel('UI Maker: Run');
        this.output.appendLine(`[UI Maker] launching ${exe}`);
        const child = cp.spawn(exe, [], { cwd: path.dirname(exe) });
        child.stdout?.on('data', d => this.output?.append(String(d)));
        child.stderr?.on('data', d => this.output?.append(String(d)));
        child.on('error', err => {
            this.output?.appendLine(`[UI Maker] failed to start: ${err.message}`);
            this.runProcess = undefined;
            this.setState('idle');
        });
        child.on('exit', code => {
            this.output?.appendLine(`[UI Maker] exited with code ${code ?? 'unknown'}`);
            this.runProcess = undefined;
            this.setState('idle');
        });
        this.runProcess = child;
        this.setState('running');
    }

    stop(): void {
        if (vscode.debug.activeDebugSession?.name === DEBUG_SESSION_NAME) {
            void vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
        }
        this.runExecution?.terminate();
        this.runExecution = undefined;
        if (this.runProcess) {
            this.runProcess.kill();
            this.runProcess = undefined;
        }
        this.setState('idle');
    }

    // ------------------------------------------------------------------ Debug

    async debug(): Promise<void> {
        const project = await this.findProject();
        if (!project) { return; }
        const pre = await this.preflight(project);
        if (!pre) { return; }

        // Build first; a failed build should surface errors, not a debugger.
        const exitCode = pre.msbuild
            ? await this.execTaskAndWait('build', [project, '/p:Configuration=Debug', '/v:m'], pre.msbuild)
            : await this.execTaskAndWait('build', ['build', project, '-c', 'Debug']);
        if (exitCode !== 0) {
            vscode.window.showErrorMessage('UI Maker: build failed — fix the errors before debugging.');
            return;
        }

        const info = readProjectInfo(project);
        const netFramework = info?.netFramework ?? false;
        // .NET Framework apps debug with the 'clr' engine against the .exe;
        // modern .NET uses 'coreclr' against the .dll.
        const program = netFramework
            ? this.findOutputBinary(project, '.exe')
            : this.findOutputBinary(project, '.dll');
        if (!program) {
            vscode.window.showWarningMessage('UI Maker: could not locate the build output. Launching without the debugger.');
            await this.run();
            return;
        }

        // Elevated apps can only be debugged from an elevated VS Code —
        // warn up front so a failed launch is not a mystery.
        if (this.requiresElevation(project)) {
            vscode.window.showWarningMessage(
                'UI Maker: this app requests administrator rights — debugging it requires running VS Code as Administrator. (Run works: it shows a UAC prompt.)');
        }

        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project));
        const config: vscode.DebugConfiguration = {
            name: DEBUG_SESSION_NAME,
            type: netFramework ? 'clr' : 'coreclr',
            request: 'launch',
            program,
            cwd: path.dirname(program),
            console: 'internalConsole',
            stopAtEntry: false
        };

        // The debug engines come from the C# extension. If it is missing the
        // call rejects, in which case we offer the install and fall back to Run.
        const started = await Promise.resolve(vscode.debug.startDebugging(folder, config)).then(
            ok => ok,
            () => false
        );
        if (!started) {
            const install = 'Install C# Extension';
            const choice = await vscode.window.showWarningMessage(
                'UI Maker: debugging needs the C# extension (ms-dotnettools.csharp). The app was launched without the debugger.',
                install
            );
            if (choice === install) {
                void vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-dotnettools.csharp');
            }
            await this.run();
        }
    }

    // ---------------------------------------------------------------- Release

    async release(): Promise<void> {
        const project = await this.findProject();
        if (!project) { return; }
        const pre = await this.preflight(project);
        if (!pre) { return; }

        let exitCode: number | undefined;
        if (pre.msbuild) {
            exitCode = await this.execTaskAndWait('publish', [project, '/p:Configuration=Release', '/v:m'], pre.msbuild);
        } else {
            exitCode = await this.execTaskAndWait('publish', this.publishArgs(project));
        }
        if (exitCode !== 0) { return; }

        // Point the user at the output folder that was just produced.
        const publishDir = pre.msbuild
            ? this.findReleaseDir(project)
            : (this.findPublishDir(project) ?? this.findReleaseDir(project));
        const open = 'Open Output Folder';
        const choice = await vscode.window.showInformationMessage(
            `UI Maker: release build published${publishDir ? ` to ${publishDir}` : ''}.`,
            ...(publishDir ? [open] : [])
        );
        if (choice === open && publishDir) {
            void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(publishDir));
        }
    }

    /**
     * `dotnet publish` arguments honoring the UI Maker publish settings:
     * single .exe, self-contained runtime, target runtime identifier.
     * (.NET Framework targets ignore them — single-file needs modern .NET.)
     */
    private publishArgs(project: string): string[] {
        const args = ['publish', project, '-c', 'Release'];
        const info = readProjectInfo(project);
        if (info?.netFramework) { return args; }

        const cfg = vscode.workspace.getConfiguration('uimaker');
        const singleFile = cfg.get<boolean>('publish.singleFile', false);
        const selfContained = cfg.get<boolean>('publish.selfContained', false);
        const runtime = cfg.get<string>('publish.runtime', 'win-x64');

        if (singleFile) {
            args.push('-r', runtime, '-p:PublishSingleFile=true', '--self-contained', String(selfContained));
            if (selfContained) {
                // Bundle native libraries too, so the output really is one file.
                args.push('-p:IncludeNativeLibrariesForSelfExtract=true');
            }
        } else if (selfContained) {
            args.push('-r', runtime, '--self-contained', 'true');
        }
        return args;
    }

    // ------------------------------------------------------- build protection

    /**
     * Pre-build check that keeps projects working on any dev machine.
     * Returns undefined to abort, `{}` to proceed with the dotnet CLI, or
     * `{ msbuild }` to route the build through Visual Studio's MSBuild.
     */
    private async preflight(project: string): Promise<{ msbuild?: string } | undefined> {
        await this.stopLockedInstances(project);

        const info = readProjectInfo(project);
        if (!info) { return {}; }

        // Classic non-SDK project: dotnet CLI cannot load it — use MSBuild.
        if (!info.sdkStyle) {
            const msbuild = await findMsBuild();
            if (msbuild) { return { msbuild }; }
            const get = 'Get Build Tools';
            const choice = await vscode.window.showErrorMessage(
                `UI Maker: ${path.basename(project)} is a classic .NET Framework project — the dotnet CLI cannot build it and Visual Studio MSBuild was not found. Install Visual Studio (or Build Tools) with the ".NET desktop" workload.`,
                get
            );
            if (choice === get) {
                void vscode.env.openExternal(vscode.Uri.parse('https://visualstudio.microsoft.com/downloads/'));
            }
            return undefined;
        }

        // SDK-style project targeting .NET Framework: without the reference
        // assemblies the build dies with MSB3644 — offer the NuGet helper.
        const tfm = info.targetFrameworks.find(isNetFrameworkTfm);
        if (tfm && !info.hasRefAssembliesHelper && !refAssembliesInstalled(tfm)
            && !this.askedRefAssemblies.has(project)) {
            this.askedRefAssemblies.add(project);
            const fix = 'Add Build Helper (Recommended)';
            const anyway = 'Try Anyway';
            const choice = await vscode.window.showWarningMessage(
                `UI Maker: this project targets ${frameworkLabel(tfm)} but its reference assemblies are not installed on this PC, so the build would fail (MSB3644). ` +
                'Add the Microsoft.NETFramework.ReferenceAssemblies package so it builds on any machine?',
                fix, anyway
            );
            if (choice === fix) {
                if (addRefAssembliesHelper(project)) {
                    vscode.window.showInformationMessage('UI Maker: build helper added to the project file.');
                } else {
                    vscode.window.showErrorMessage('UI Maker: could not update the project file.');
                }
            }
        }
        return {};
    }

    /**
     * A still-running instance of the app locks the output .exe and makes the
     * build fail after long MSB3026 retries. Detect instances by image name
     * before building: stop our own launch outright, ask about foreign ones.
     */
    private async stopLockedInstances(project: string): Promise<void> {
        if (process.platform !== 'win32') { return; }
        const exeName = `${this.assemblyNameOf(project)}.exe`;
        let pids = await listProcessIds(exeName);
        if (!pids.length) { return; }

        // If we launched the app, just stop it and re-check.
        if (this._state !== 'idle' || this.runProcess || this.runExecution) {
            this.stop();
            await delay(1000);
            pids = await listProcessIds(exeName);
            if (!pids.length) { return; }
        }

        const stopIt = 'Stop It and Continue';
        const anyway = 'Build Anyway';
        const choice = await vscode.window.showWarningMessage(
            `UI Maker: ${exeName} is still running (PID ${pids.join(', ')}) and locks the build output. Stop it before building?`,
            stopIt, anyway
        );
        if (choice === stopIt) {
            await killProcessIds(pids);
            await delay(500);
        }
    }

    /** The assembly name declared in the project, else the project file name. */
    private assemblyNameOf(project: string): string {
        const xml = this.tryRead(project) ?? '';
        return /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/.exec(xml)?.[1]
            ?? path.basename(project).replace(/\.(cs|vb)proj$/i, '');
    }

    // ------------------------------------------------------- project location

    /**
     * Locate the project to operate on: walk up from the active editor's file,
     * then fall back to a workspace search (with a picker if several exist).
     */
    async findProject(): Promise<string | undefined> {
        const active = vscode.window.activeTextEditor?.document.uri ?? DesignerActiveUri();
        if (active?.scheme === 'file' && !inExcludedDir(active.fsPath)) {
            let dir = path.dirname(active.fsPath);
            const stopAt = vscode.workspace.getWorkspaceFolder(active)?.uri.fsPath ?? path.parse(dir).root;
            for (;;) {
                const hit = this.projectIn(dir);
                if (hit) { return hit; }
                if (dir === stopAt || path.dirname(dir) === dir) { break; }
                dir = path.dirname(dir);
            }
        }

        // The sidebar's working folder decides in multi-project workspaces —
        // a parent folder of many projects is never operated on wholesale.
        const working = getWorkingFolder();
        if (working) {
            const hit = this.projectIn(working);
            if (hit) { return hit; }
        }

        const found = await vscode.workspace.findFiles('**/*.{csproj,vbproj}', EXCLUDE_GLOB, 16);
        if (found.length === 0) {
            const create = 'New Project';
            const choice = await vscode.window.showWarningMessage('UI Maker: no .NET project found in this workspace.', create);
            if (choice === create) { void vscode.commands.executeCommand('uimaker.newProject'); }
            return undefined;
        }
        if (found.length === 1) { return found[0].fsPath; }

        const pick = await vscode.window.showQuickPick(
            found.map(f => ({
                label: path.basename(f.fsPath),
                description: vscode.workspace.asRelativePath(f),
                fsPath: f.fsPath
            })),
            { placeHolder: 'UI Maker: select the project (becomes the working folder)' }
        );
        if (pick) { setWorkingFolder(path.dirname(pick.fsPath)); }
        return pick?.fsPath;
    }

    private projectIn(dir: string): string | undefined {
        try {
            const hit = fs.readdirSync(dir).find(f => /\.(cs|vb)proj$/i.test(f));
            return hit ? path.join(dir, hit) : undefined;
        } catch {
            return undefined;
        }
    }

    // --------------------------------------------------------- task plumbing

    /** Run a build tool as a shared task with MSBuild problem matching. */
    private execTask(name: string, args: string[], executable = 'dotnet'): Thenable<vscode.TaskExecution> {
        const task = new vscode.Task(
            { type: 'uimaker', task: name },
            vscode.TaskScope.Workspace,
            name,
            'UI Maker',
            new vscode.ShellExecution(
                { value: executable, quoting: vscode.ShellQuoting.Strong },
                args.map(a => ({ value: a, quoting: vscode.ShellQuoting.Strong }))
            ),
            '$msCompile'
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            clear: true
        };
        return vscode.tasks.executeTask(task);
    }

    /** Run a task and resolve with its process exit code. */
    private async execTaskAndWait(name: string, args: string[], executable = 'dotnet'): Promise<number | undefined> {
        const execution = await this.execTask(name, args, executable);
        return new Promise(resolve => {
            const sub = vscode.tasks.onDidEndTaskProcess(e => {
                if (e.execution === execution) {
                    sub.dispose();
                    resolve(e.exitCode);
                }
            });
        });
    }

    // ------------------------------------------------------- output discovery

    /**
     * Resolve the Debug build output with the given extension: checks
     * bin/Debug/<file> (classic layout) and bin/Debug/<tfm>/<file>.
     */
    private findOutputBinary(project: string, ext: '.dll' | '.exe'): string | undefined {
        const dir = path.dirname(project);
        const xml = this.tryRead(project) ?? '';
        const assembly = this.assemblyNameOf(project);

        // Prefer the declared target framework, otherwise scan bin/Debug.
        const tfm =
            /<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/.exec(xml)?.[1] ??
            /<TargetFrameworks>\s*([^<;]+)/.exec(xml)?.[1];

        const debugDir = path.join(dir, 'bin', 'Debug');
        const candidates: string[] = [path.join(debugDir, `${assembly}${ext}`)];
        if (tfm) {
            candidates.push(path.join(debugDir, tfm, `${assembly}${ext}`));
        }
        try {
            for (const sub of fs.readdirSync(debugDir)) {
                candidates.push(path.join(debugDir, sub, `${assembly}${ext}`));
            }
        } catch { /* no build output yet */ }
        // Classic projects sometimes build to bin/x86|x64/Debug.
        for (const arch of ['x86', 'x64']) {
            candidates.push(path.join(dir, 'bin', arch, 'Debug', `${assembly}${ext}`));
        }

        return candidates.find(c => fs.existsSync(c));
    }

    /** Locate the newest publish folder after `dotnet publish` (handles -r). */
    private findPublishDir(project: string): string | undefined {
        const releaseDir = path.join(path.dirname(project), 'bin', 'Release');
        const hits: string[] = [];
        try {
            for (const sub of fs.readdirSync(releaseDir)) {
                // bin/Release/<tfm>/publish
                const direct = path.join(releaseDir, sub, 'publish');
                if (fs.existsSync(direct)) { hits.push(direct); }
                // bin/Release/<tfm>/<rid>/publish (runtime-specific publishes)
                const tfmDir = path.join(releaseDir, sub);
                try {
                    for (const rid of fs.readdirSync(tfmDir)) {
                        const nested = path.join(tfmDir, rid, 'publish');
                        if (fs.existsSync(nested)) { hits.push(nested); }
                    }
                } catch { /* not a directory */ }
            }
        } catch {
            return undefined;
        }
        return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    }

    /** bin/Release itself — the classic MSBuild output location. */
    private findReleaseDir(project: string): string | undefined {
        const dir = path.join(path.dirname(project), 'bin', 'Release');
        return fs.existsSync(dir) ? dir : undefined;
    }

    private tryRead(file: string): string | undefined {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return undefined;
        }
    }
}

/** PIDs of all running processes with the given image name (Windows). */
function listProcessIds(imageName: string): Promise<number[]> {
    return new Promise(resolve => {
        cp.execFile('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], (err, stdout) => {
            if (err) { resolve([]); return; }
            const pids: number[] = [];
            for (const line of stdout.split(/\r?\n/)) {
                const m = /^"[^"]+","(\d+)"/.exec(line.trim());
                if (m) { pids.push(Number(m[1])); }
            }
            resolve(pids);
        });
    });
}

/** Force-kill the given process trees (Windows). */
function killProcessIds(pids: number[]): Promise<void> {
    return new Promise(resolve => {
        const args = ['/F', '/T'];
        for (const pid of pids) { args.push('/PID', String(pid)); }
        cp.execFile('taskkill', args, () => resolve());
    });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Late import accessor to avoid a circular import at module load time:
// designerProvider imports nothing from here, but extension.ts wires both.
function DesignerActiveUri(): vscode.Uri | undefined {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DesignerProvider } = require('./designerProvider') as typeof import('./designerProvider');
    return DesignerProvider.activeDocumentUri;
}
