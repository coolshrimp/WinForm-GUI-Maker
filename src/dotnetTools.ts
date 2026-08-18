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
import { decodeXmlEntities } from './xmlText';

export type RunState = 'idle' | 'running' | 'debugging';

const DEBUG_SESSION_NAME = 'UI Maker: Debug';

export class DotnetTools implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];

    /** Task execution backing Run (dotnet run), when that path is used. */
    private runExecution: vscode.TaskExecution | undefined;
    /** Direct child process backing Run for classic .NET Framework exes. */
    private runProcess: cp.ChildProcess | undefined;
    /** Debug session started by this instance (name alone is not unique). */
    private debugSession: vscode.DebugSession | undefined;
    /** What the last Run/Debug launched — lets Stop verify the app really died. */
    private runTarget: { exeName: string; projectDir: string; elevated: boolean } | undefined;
    /** Completion events can beat executeTask()'s returned Thenable. */
    private readonly endedTaskProcesses = new WeakMap<vscode.TaskExecution, { exitCode: number | undefined }>();
    private output: vscode.OutputChannel | undefined;

    /** Projects already asked about the reference-assemblies helper. */
    private readonly askedRefAssemblies = new Set<string>();
    /** Active TFM for multi-target Run/Debug/Publish, remembered this session. */
    private readonly selectedFrameworks = new Map<string, string>();

    private _state: RunState = 'idle';
    /** Invalidates an older async Run/Debug continuation after Stop/restart. */
    private lifecycleGeneration = 0;
    private readonly stateEmitter = new vscode.EventEmitter<RunState>();
    /** Fires whenever the app starts or stops (running / debugging / idle). */
    public readonly onDidChangeState = this.stateEmitter.event;

    public get state(): RunState {
        return this._state;
    }

    constructor() {
        // Run (task flavor) ends -> back to idle.
        this.disposables.push(vscode.tasks.onDidEndTaskProcess(e => {
            this.endedTaskProcesses.set(e.execution, { exitCode: e.exitCode });
            if (e.execution === this.runExecution) {
                this.runExecution = undefined;
                if (!this.runProcess && !this.debugSession) { this.setState('idle'); }
            }
        }));
        // Our debug session starts/ends -> mirror the state.
        this.disposables.push(vscode.debug.onDidStartDebugSession(s => {
            const generation = s.configuration.__uimakerGeneration;
            if (s.name === DEBUG_SESSION_NAME && typeof generation === 'number') {
                if (generation !== this.lifecycleGeneration) {
                    void vscode.debug.stopDebugging(s);
                    return;
                }
                this.debugSession = s;
                this.setState('debugging');
            }
        }));
        this.disposables.push(vscode.debug.onDidTerminateDebugSession(s => {
            if (s === this.debugSession) {
                this.debugSession = undefined;
                if (!this.runProcess && !this.runExecution) { this.setState('idle'); }
            }
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
        this.lifecycleGeneration++;
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
        const generation = ++this.lifecycleGeneration;
        const project = await this.findProject();
        if (!project || generation !== this.lifecycleGeneration) { return; }
        const targetFramework = await this.selectTargetFramework(project, 'run');
        if (targetFramework === null || generation !== this.lifecycleGeneration) { return; }
        const pre = await this.preflight(project, targetFramework);
        if (!pre || generation !== this.lifecycleGeneration) { return; }
        this.stopCurrent();
        this.runTarget = {
            exeName: `${this.assemblyNameOf(project)}.exe`,
            projectDir: path.dirname(project),
            elevated: this.requiresElevation(project)
        };

        // Classic projects: build with MSBuild, then launch the exe directly
        // (dotnet run does not understand non-SDK projects).
        if (pre.msbuild) {
            const code = await this.execTaskAndWait('build', [project, '/p:Configuration=Debug', '/v:m'], pre.msbuild);
            if (generation !== this.lifecycleGeneration) { return; }
            if (code !== 0) {
                vscode.window.showErrorMessage('UI Maker: build failed — see the terminal output.');
                return;
            }
            const exe = await this.resolveOutputBinary(project, '.exe', pre.msbuild, targetFramework);
            if (generation !== this.lifecycleGeneration) { return; }
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
            const code = await this.execTaskAndWait('build', [
                'build', project, '-c', 'Debug',
                ...(targetFramework ? ['-f', targetFramework] : [])
            ]);
            if (generation !== this.lifecycleGeneration) { return; }
            if (code !== 0) {
                vscode.window.showErrorMessage('UI Maker: build failed — see the terminal output.');
                return;
            }
            const exe = await this.resolveOutputBinary(project, '.exe', undefined, targetFramework);
            if (generation !== this.lifecycleGeneration) { return; }
            if (exe) {
                this.launchExeElevated(exe);
                return;
            }
            // No apphost .exe found — fall through and let dotnet run try.
        }

        // `dotnet run` builds first, so a stale binary is never launched.
        // Running it as a task tells us when the app exits (play/stop toggle).
        const execution = await this.execTask('run', [
            'run', '--project', project,
            ...(targetFramework ? ['--framework', targetFramework] : [])
        ]);
        if (generation !== this.lifecycleGeneration) {
            execution.terminate();
            return;
        }
        // A missing executable can produce an end event before executeTask's
        // Thenable resumes. Do not retain an already-finished execution.
        if (this.endedTaskProcesses.has(execution)) {
            this.setState('idle');
            return;
        }
        this.runExecution = execution;
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
        const declaredRaw = /<ApplicationManifest>\s*([^<]+?)\s*<\/ApplicationManifest>/.exec(xml)?.[1];
        const declared = declaredRaw ? decodeXmlEntities(declaredRaw) : undefined;
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
        this.output.appendLine('[UI Maker] note: closing an elevated app from Stop needs a UAC confirmation — you will be asked.');
        const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
        const child = cp.spawn('powershell', [
            '-NoProfile', '-Command',
            `Start-Process -FilePath ${psQuote(exe)} -WorkingDirectory ${psQuote(path.dirname(exe))} -Verb RunAs -Wait`
        ], { windowsHide: true });
        child.stderr?.on('data', d => this.output?.append(String(d)));
        child.on('error', err => {
            this.output?.appendLine(`[UI Maker] failed to start: ${err.message}`);
            if (this.runProcess !== child) { return; }
            this.runProcess = undefined;
            if (!this.runExecution && !this.debugSession) { this.setState('idle'); }
        });
        child.on('exit', code => {
            this.output?.appendLine(`[UI Maker] exited with code ${code ?? 'unknown'}`);
            if (this.runProcess !== child) { return; }
            this.runProcess = undefined;
            if (!this.runExecution && !this.debugSession) { this.setState('idle'); }
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
            if (this.runProcess !== child) { return; }
            this.runProcess = undefined;
            if (!this.runExecution && !this.debugSession) { this.setState('idle'); }
        });
        child.on('exit', code => {
            this.output?.appendLine(`[UI Maker] exited with code ${code ?? 'unknown'}`);
            if (this.runProcess !== child) { return; }
            this.runProcess = undefined;
            if (!this.runExecution && !this.debugSession) { this.setState('idle'); }
        });
        this.runProcess = child;
        this.setState('running');
    }

    stop(): void {
        const generation = ++this.lifecycleGeneration;
        const target = this.runTarget;
        this.stopCurrent();
        // The synchronous teardown above can miss two cases on Windows:
        //   * dotnet run — terminating the task kills the console host, but a
        //     detached WinForms/WPF window can survive it;
        //   * elevated apps — a non-elevated taskkill gets Access Denied.
        // Verify the process actually died and escalate if it didn't.
        void this.verifyStopped(target, generation);
    }

    /**
     * A second, asynchronous pass behind Stop: confirm the launched .exe is
     * gone, force-kill the verified tree if not, and — when the app runs as
     * administrator — offer an elevated close through a UAC prompt.
     * Every await re-checks the lifecycle generation so a restart (Run right
     * after Stop) can never have its fresh instance shot down by this pass.
     */
    private async verifyStopped(
        target: { exeName: string; projectDir: string; elevated: boolean } | undefined,
        generation: number
    ): Promise<void> {
        if (!target || process.platform !== 'win32') { return; }
        await delay(900);
        if (generation !== this.lifecycleGeneration) { return; }

        // Pass 1: path-verified survivors (normal apps) — kill the whole tree.
        let pids = await listProjectProcessIds(target.exeName, target.projectDir);
        if (generation !== this.lifecycleGeneration) { return; }
        if (pids.length) {
            this.output?.appendLine(`[UI Maker] ${target.exeName} survived Stop (PID ${pids.join(', ')}) — force-closing.`);
            await killProcessIds(pids);
            await delay(600);
            if (generation !== this.lifecycleGeneration) { return; }
            pids = await listProjectProcessIds(target.exeName, target.projectDir);
        }

        // Pass 2: elevated survivors. Their executable path is unreadable from
        // a non-elevated query, so they never appear above — match by image
        // name with an unreadable path, and only when THIS launch was elevated.
        let elevatedPids: number[] = [];
        if (!pids.length && target.elevated) {
            elevatedPids = (await listNamedProcesses(target.exeName))
                .filter(p => !p.exePath)
                .map(p => p.pid);
        }
        if (generation !== this.lifecycleGeneration) { return; }
        if (!pids.length && !elevatedPids.length) { return; }

        const all = [...pids, ...elevatedPids];
        const closeIt = 'Close It (Admin)';
        const leave = 'Leave It Running';
        const why = elevatedPids.length
            ? 'it runs as administrator, so Windows needs a UAC confirmation to close it'
            : 'it did not respond to a normal close';
        const choice = await vscode.window.showWarningMessage(
            `UI Maker: ${target.exeName} is still running (PID ${all.join(', ')}) — ${why}.`,
            closeIt, leave
        );
        if (choice !== closeIt || generation !== this.lifecycleGeneration) { return; }
        await killProcessIdsElevated(all);
        await delay(800);
        const left = target.elevated
            ? (await listNamedProcesses(target.exeName)).filter(p => !p.exePath).length
            : (await listProjectProcessIds(target.exeName, target.projectDir)).length;
        if (left) {
            vscode.window.showWarningMessage(`UI Maker: ${target.exeName} could not be closed (UAC declined?). Close its window manually.`);
        } else {
            this.output?.appendLine(`[UI Maker] ${target.exeName} closed.`);
        }
    }

    /** Stop tracked state without invalidating the operation that requested it. */
    private stopCurrent(): void {
        const session = this.debugSession
            ?? (typeof vscode.debug.activeDebugSession?.configuration.__uimakerGeneration === 'number'
                ? vscode.debug.activeDebugSession : undefined);
        this.debugSession = undefined;
        if (session) { void vscode.debug.stopDebugging(session); }
        this.runExecution?.terminate();
        this.runExecution = undefined;
        const child = this.runProcess;
        this.runProcess = undefined;
        child?.kill();
        this.setState('idle');
    }

    // ------------------------------------------------------------------ Debug

    async debug(): Promise<void> {
        const generation = ++this.lifecycleGeneration;
        const project = await this.findProject();
        if (!project || generation !== this.lifecycleGeneration) { return; }
        const targetFramework = await this.selectTargetFramework(project, 'debug');
        if (targetFramework === null || generation !== this.lifecycleGeneration) { return; }
        const pre = await this.preflight(project, targetFramework);
        if (!pre || generation !== this.lifecycleGeneration) { return; }
        this.stopCurrent();
        this.runTarget = {
            exeName: `${this.assemblyNameOf(project)}.exe`,
            projectDir: path.dirname(project),
            elevated: this.requiresElevation(project)
        };

        // Build first; a failed build should surface errors, not a debugger.
        const exitCode = pre.msbuild
            ? await this.execTaskAndWait('build', [project, '/p:Configuration=Debug', '/v:m'], pre.msbuild)
            : await this.execTaskAndWait('build', [
                'build', project, '-c', 'Debug',
                ...(targetFramework ? ['-f', targetFramework] : [])
            ]);
        if (generation !== this.lifecycleGeneration) { return; }
        if (exitCode !== 0) {
            vscode.window.showErrorMessage('UI Maker: build failed — fix the errors before debugging.');
            return;
        }

        const info = readProjectInfo(project);
        const netFramework = targetFramework
            ? isNetFrameworkTfm(targetFramework)
            : info?.netFramework ?? false;
        // .NET Framework apps debug with the 'clr' engine against the .exe;
        // modern .NET uses 'coreclr' against the .dll.
        const program = netFramework
            ? await this.resolveOutputBinary(project, '.exe', pre.msbuild, targetFramework)
            : await this.resolveOutputBinary(project, '.dll', pre.msbuild, targetFramework);
        if (generation !== this.lifecycleGeneration) { return; }
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
            stopAtEntry: false,
            __uimakerGeneration: generation
        };

        // The debug engines come from the C# extension. If it is missing the
        // call rejects, in which case we offer the install and fall back to Run.
        const started = await Promise.resolve(vscode.debug.startDebugging(folder, config)).then(
            ok => ok,
            () => false
        );
        if (generation !== this.lifecycleGeneration) {
            if (this.debugSession?.configuration.__uimakerGeneration === generation) {
                void vscode.debug.stopDebugging(this.debugSession);
                this.debugSession = undefined;
            }
            return;
        }
        if (!started) {
            const install = 'Install C# Extension';
            const choice = await vscode.window.showWarningMessage(
                'UI Maker: debugging needs the C# extension (ms-dotnettools.csharp). The app was launched without the debugger.',
                install
            );
            if (generation !== this.lifecycleGeneration) { return; }
            if (choice === install) {
                void vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-dotnettools.csharp');
            }
            await this.run();
        }
    }

    // ---------------------------------------------------------------- Release

    async release(): Promise<void> {
        const generation = ++this.lifecycleGeneration;
        const project = await this.findProject();
        if (!project || generation !== this.lifecycleGeneration) { return; }
        if (!await this.pickPublishMode(project)) { return; }
        if (generation !== this.lifecycleGeneration) { return; }
        const targetFramework = await this.selectTargetFramework(project, 'publish');
        if (targetFramework === null || generation !== this.lifecycleGeneration) { return; }
        const pre = await this.preflight(project, targetFramework);
        if (!pre || generation !== this.lifecycleGeneration) { return; }

        let exitCode: number | undefined;
        if (pre.msbuild) {
            exitCode = await this.execTaskAndWait('publish', [project, '/p:Configuration=Release', '/v:m'], pre.msbuild);
        } else {
            exitCode = await this.execTaskAndWait('publish', this.publishArgs(project, targetFramework));
        }
        if (exitCode !== 0 || generation !== this.lifecycleGeneration) { return; }

        // Point the user at the output folder that was just produced.
        const publishDir = pre.msbuild
            ? this.findReleaseDir(project)
            : (this.findPublishDir(project, targetFramework) ?? this.findReleaseDir(project));
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
     * Publish-mode assistant shown before each Release (unless disabled):
     * explains the size/portability trade-off, preselects the current
     * settings, and writes the choice back so it becomes the default.
     * Returns false when the user cancels.
     */
    private async pickPublishMode(project: string): Promise<boolean> {
        const cfg = vscode.workspace.getConfiguration('uimaker');
        if (!cfg.get<boolean>('publish.askMode', true)) { return true; }
        const info = readProjectInfo(project);
        if (info?.netFramework) { return true; } // classic targets publish as folders

        const singleFile = cfg.get<boolean>('publish.singleFile', false);
        const selfContained = cfg.get<boolean>('publish.selfContained', false);
        const current = singleFile ? (selfContained ? 'portable' : 'single') : 'folder';
        const mark = (id: string) => (id === current ? ' — current default' : '');
        const pick = await vscode.window.showQuickPick(
            [
                {
                    label: '$(folder) Folder (default)',
                    description: 'all files in a folder' + mark('folder'),
                    detail: 'Smallest build. Target PC needs the .NET Desktop Runtime — Windows offers to install it automatically on first run. Best with Create Installer.',
                    id: 'folder'
                },
                {
                    label: '$(file-binary) Single EXE — smallest',
                    description: 'one portable .exe, runtime NOT bundled' + mark('single'),
                    detail: 'A few MB. Target PC is prompted to install the .NET Desktop Runtime once if missing.',
                    id: 'single'
                },
                {
                    label: '$(package) Single EXE — runs anywhere',
                    description: 'one .exe with the .NET runtime bundled' + mark('portable'),
                    detail: 'No install prompts ever, but large (~70–150 MB). Compression is enabled to keep it as small as possible.',
                    id: 'portable'
                },
                {
                    label: '$(gear) Always use my settings — stop asking',
                    description: 'honor uimaker.publish.* silently from now on',
                    id: 'quiet'
                }
            ],
            { placeHolder: 'How should this Release be published? (choice is remembered as the default)' }
        );
        if (!pick) { return false; }
        if (pick.id === 'quiet') {
            await cfg.update('publish.askMode', false, vscode.ConfigurationTarget.Global);
            return true;
        }
        await cfg.update('publish.singleFile', pick.id !== 'folder', vscode.ConfigurationTarget.Global);
        await cfg.update('publish.selfContained', pick.id === 'portable', vscode.ConfigurationTarget.Global);
        return true;
    }

    /**
     * `dotnet publish` arguments honoring the UI Maker publish settings:
     * single .exe, self-contained runtime, target runtime identifier.
     * (.NET Framework targets ignore them — single-file needs modern .NET.)
     */
    private publishArgs(project: string, targetFramework?: string): string[] {
        const args = ['publish', project, '-c', 'Release'];
        if (targetFramework) { args.push('-f', targetFramework); }
        const info = readProjectInfo(project);
        if (targetFramework ? isNetFrameworkTfm(targetFramework) : info?.netFramework) { return args; }

        const cfg = vscode.workspace.getConfiguration('uimaker');
        const singleFile = cfg.get<boolean>('publish.singleFile', false);
        const selfContained = cfg.get<boolean>('publish.selfContained', false);
        const runtime = cfg.get<string>('publish.runtime', 'win-x64');

        if (singleFile) {
            args.push('-r', runtime, '-p:PublishSingleFile=true', '--self-contained', String(selfContained));
            if (selfContained) {
                // Bundle native libraries too, so the output really is one
                // file, and compress the bundle to keep the size down.
                args.push('-p:IncludeNativeLibrariesForSelfExtract=true');
                args.push('-p:EnableCompressionInSingleFile=true');
            }
        } else if (selfContained) {
            args.push('-r', runtime, '--self-contained', 'true');
        }
        return args;
    }

    /**
     * Choose the active framework for an SDK project that targets more than
     * one TFM. The choice is reused for Run/Debug/Publish during this session,
     * mirroring Visual Studio's active target selector.
     *
     * undefined = no explicit TFM is needed; null = user cancelled.
     */
    private async selectTargetFramework(
        project: string,
        action: 'run' | 'debug' | 'publish'
    ): Promise<string | undefined | null> {
        const info = readProjectInfo(project);
        if (!info?.sdkStyle || info.targetFrameworks.length === 0) { return undefined; }
        if (info.targetFrameworks.length === 1) { return info.targetFrameworks[0]; }

        const key = path.resolve(project).toLowerCase();
        const remembered = this.selectedFrameworks.get(key);
        if (remembered && info.targetFrameworks.includes(remembered)) { return remembered; }

        const picked = await vscode.window.showQuickPick(
            info.targetFrameworks.map(tfm => ({
                label: frameworkLabel(tfm),
                description: tfm,
                tfm
            })),
            {
                placeHolder: `UI Maker: select the target framework to ${action}`,
                matchOnDescription: true
            }
        );
        if (!picked) { return null; }
        this.selectedFrameworks.set(key, picked.tfm);
        return picked.tfm;
    }

    // ------------------------------------------------------- build protection

    /**
     * Pre-build check that keeps projects working on any dev machine.
     * Returns undefined to abort, `{}` to proceed with the dotnet CLI, or
     * `{ msbuild }` to route the build through Visual Studio's MSBuild.
     */
    private async preflight(
        project: string,
        targetFramework?: string
    ): Promise<{ msbuild?: string } | undefined> {
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
        const tfm = targetFramework && isNetFrameworkTfm(targetFramework)
            ? targetFramework
            : targetFramework
                ? undefined
                : info.targetFrameworks.find(isNetFrameworkTfm);
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
     * build fail after long MSB3026 retries. Detect instances before
     * building: stop our own launch outright, ask about foreign ones.
     * Processes are matched by FULL EXECUTABLE PATH under this project's
     * folder — an unrelated app that merely shares the .exe name is never
     * touched.
     */
    private async stopLockedInstances(project: string): Promise<void> {
        if (process.platform !== 'win32') { return; }
        const exeName = `${this.assemblyNameOf(project)}.exe`;
        const projectDir = path.dirname(project);
        let pids = await listProjectProcessIds(exeName, projectDir);
        if (!pids.length) { return; }

        // If we launched the app, just stop it and re-check.
        if (this._state !== 'idle' || this.runProcess || this.runExecution) {
            this.stopCurrent();
            await delay(1000);
            pids = await listProjectProcessIds(exeName, projectDir);
            if (!pids.length) { return; }
        }

        const stopIt = 'Stop It and Continue';
        const anyway = 'Build Anyway';
        const choice = await vscode.window.showWarningMessage(
            `UI Maker: ${exeName} (from this project's output folder) is still running (PID ${pids.join(', ')}) and locks the build output. Stop it before building?`,
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
        const declared = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/.exec(xml)?.[1];
        return (declared ? decodeXmlEntities(declared) : undefined)
            ?? path.basename(project).replace(/\.(cs|vb)proj$/i, '');
    }

    // ------------------------------------------------------- project location

    /**
     * Locate the project to operate on. The WORKING FOLDER is authoritative:
     * it already follows the active editor, and when the user explicitly
     * switches projects in the sidebar, every command must follow that switch
     * immediately — even while an editor from the previous project still has
     * focus. Files outside any project fall back to walking up from the
     * active editor, then to a workspace search (with a picker).
     */
    async findProject(): Promise<string | undefined> {
        const working = getWorkingFolder();
        if (working) {
            const hit = this.projectIn(working);
            if (hit) { return hit; }
            // The selected working folder holds no project file (renamed or
            // deleted since it was chosen). NEVER fall through silently —
            // that could create/build files in some other project.
            const open = 'Open Project…';
            const select = 'Select Working Folder…';
            void vscode.window.showWarningMessage(
                `UI Maker: the working folder "${path.basename(working)}" contains no .csproj/.vbproj — nothing was created or built. Pick the right project first.`,
                open, select
            ).then(choice => {
                if (choice === open) { void vscode.commands.executeCommand('uimaker.openProject'); }
                if (choice === select) { void vscode.commands.executeCommand('uimaker.selectWorkingFolder'); }
            });
            return undefined;
        }

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

        const found = await vscode.workspace.findFiles('**/*.{csproj,vbproj}', EXCLUDE_GLOB, 16);
        if (found.length === 0) {
            const open = 'Open Project…';
            const create = 'New Project';
            const choice = await vscode.window.showWarningMessage(
                'UI Maker: no .NET project found in this workspace.', open, create);
            if (choice === open) { void vscode.commands.executeCommand('uimaker.openProject'); }
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
        const alreadyEnded = this.endedTaskProcesses.get(execution);
        if (alreadyEnded) { return alreadyEnded.exitCode; }
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

    /** project + selected TFM -> { csproj mtime, evaluated TargetPath } */
    private readonly targetPathCache = new Map<string, { mtime: number; value: string | undefined }>();

    /**
     * The Debug output binary, resolved the reliable way first: MSBuild
     * evaluates TargetPath (honoring custom output paths, RIDs, and the
     * selected TFM), with the bin-folder scan as fallback for older SDKs
     * and multi-target projects where -getProperty is unavailable.
     */
    private async resolveOutputBinary(
        project: string,
        ext: '.dll' | '.exe',
        msbuildExe?: string,
        targetFramework?: string
    ): Promise<string | undefined> {
        const evaluated = await this.evaluateTargetPath(project, msbuildExe, targetFramework);
        if (evaluated) {
            // TargetPath is the primary output (.dll on modern .NET, .exe on
            // .NET Framework) — the sibling extension sits next to it.
            const candidate = evaluated.toLowerCase().endsWith(ext)
                ? evaluated
                : evaluated.replace(/\.(dll|exe)$/i, ext);
            if (fs.existsSync(candidate)) { return candidate; }
        }
        return this.findOutputBinary(project, ext, targetFramework);
    }

    /** MSBuild-evaluated TargetPath (Debug), cached per project file mtime. */
    private evaluateTargetPath(
        project: string,
        msbuildExe?: string,
        targetFramework?: string
    ): Promise<string | undefined> {
        let mtime = 0;
        try { mtime = fs.statSync(project).mtimeMs; } catch { /* keep 0 */ }
        const cacheKey = `${project}\0${msbuildExe ?? ''}\0${targetFramework ?? ''}`;
        const cached = this.targetPathCache.get(cacheKey);
        if (cached && cached.mtime === mtime) { return Promise.resolve(cached.value); }

        return new Promise(resolve => {
            const frameworkArg = targetFramework ? [`-p:TargetFramework=${targetFramework}`] : [];
            const args = msbuildExe
                ? [project, '-getProperty:TargetPath', '-p:Configuration=Debug', ...frameworkArg, '-nologo']
                : ['msbuild', project, '-getProperty:TargetPath', '-p:Configuration=Debug', ...frameworkArg, '-nologo'];
            cp.execFile(msbuildExe ?? 'dotnet', args, { timeout: 30000, windowsHide: true }, (err, stdout) => {
                const line = err ? '' : stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
                const value = line && path.isAbsolute(line) ? line : undefined;
                this.targetPathCache.set(cacheKey, { mtime, value });
                resolve(value);
            });
        });
    }

    /**
     * Resolve the Debug build output with the given extension: checks
     * bin/Debug/<file> (classic layout) and bin/Debug/<tfm>/<file>.
     */
    private findOutputBinary(
        project: string,
        ext: '.dll' | '.exe',
        targetFramework?: string
    ): string | undefined {
        const dir = path.dirname(project);
        const xml = this.tryRead(project) ?? '';
        const assembly = this.assemblyNameOf(project);

        // Prefer the declared target framework, otherwise scan bin/Debug.
        const tfm = targetFramework ??
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
    private findPublishDir(project: string, targetFramework?: string): string | undefined {
        const releaseDir = path.join(path.dirname(project), 'bin', 'Release');
        const hits: string[] = [];
        const addPublishDirs = (tfmDir: string) => {
            const direct = path.join(tfmDir, 'publish');
            if (fs.existsSync(direct)) { hits.push(direct); }
            try {
                for (const rid of fs.readdirSync(tfmDir)) {
                    const nested = path.join(tfmDir, rid, 'publish');
                    if (fs.existsSync(nested)) { hits.push(nested); }
                }
            } catch { /* not a directory */ }
        };
        try {
            if (targetFramework) {
                addPublishDirs(path.join(releaseDir, targetFramework));
                if (hits.length) {
                    return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
                }
            }
            for (const sub of fs.readdirSync(releaseDir)) {
                addPublishDirs(path.join(releaseDir, sub));
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

/**
 * PIDs of running processes whose image name matches AND whose executable
 * path sits inside `projectDir` (Windows). Processes whose path cannot be
 * read (e.g. elevated) are excluded — never kill what cannot be verified.
 */
function listProjectProcessIds(imageName: string, projectDir: string): Promise<number[]> {
    return new Promise(resolve => {
        // Keep the PowerShell source completely static. AssemblyName comes
        // from the project file and must never be interpolated into a command
        // string (PowerShell expands `$()` even inside double-quoted text).
        const script =
            'Get-CimInstance Win32_Process | ' +
            'ForEach-Object { Write-Output ("$($_.ProcessId)|$($_.Name)|$($_.ExecutablePath)") }';
        cp.execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, timeout: 15000 }, (err, stdout) => {
                if (err) { resolve([]); return; }
                const prefix = (projectDir.endsWith(path.sep) ? projectDir : projectDir + path.sep).toLowerCase();
                const wantedName = imageName.toLowerCase();
                const pids: number[] = [];
                for (const line of stdout.split(/\r?\n/)) {
                    const first = line.indexOf('|');
                    const second = line.indexOf('|', first + 1);
                    if (first < 1 || second < 0) { continue; }
                    const pid = Number(line.slice(0, first).trim());
                    const name = line.slice(first + 1, second).trim().toLowerCase();
                    const exePath = line.slice(second + 1).trim().toLowerCase();
                    if (pid && name === wantedName && exePath.startsWith(prefix)) { pids.push(pid); }
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

/**
 * Every running process with this image name, including ones whose
 * executable path cannot be read (elevated processes look like that from a
 * non-elevated query — Name is visible, ExecutablePath comes back empty).
 */
function listNamedProcesses(imageName: string): Promise<{ pid: number; exePath: string }[]> {
    return new Promise(resolve => {
        // Static PowerShell source only — never interpolate the name.
        const script =
            'Get-CimInstance Win32_Process | ' +
            'ForEach-Object { Write-Output ("$($_.ProcessId)|$($_.Name)|$($_.ExecutablePath)") }';
        cp.execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, timeout: 15000 }, (err, stdout) => {
                if (err) { resolve([]); return; }
                const wanted = imageName.toLowerCase();
                const out: { pid: number; exePath: string }[] = [];
                for (const line of stdout.split(/\r?\n/)) {
                    const first = line.indexOf('|');
                    const second = line.indexOf('|', first + 1);
                    if (first < 1 || second < 0) { continue; }
                    const pid = Number(line.slice(0, first).trim());
                    const name = line.slice(first + 1, second).trim().toLowerCase();
                    const exePath = line.slice(second + 1).trim();
                    if (pid && name === wanted) { out.push({ pid, exePath }); }
                }
                resolve(out);
            });
    });
}

/**
 * Force-kill process trees WITH elevation — taskkill relaunched through a
 * UAC prompt (Start-Process -Verb RunAs). Resolves when the elevated
 * taskkill finishes or the user declines the prompt.
 */
function killProcessIdsElevated(pids: number[]): Promise<void> {
    return new Promise(resolve => {
        const argList = ['/F', '/T'];
        for (const pid of pids) { argList.push('/PID', String(pid)); }
        const psArgs = argList.map(a => `'${a}'`).join(',');
        cp.execFile('powershell', [
            '-NoProfile', '-Command',
            `Start-Process -FilePath taskkill -ArgumentList ${psArgs} -Verb RunAs -WindowStyle Hidden -Wait`
        ], { windowsHide: true, timeout: 60000 }, () => resolve());
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
