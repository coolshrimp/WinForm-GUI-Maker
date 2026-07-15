// UI Maker — thin wrappers around the .NET CLI.
//
// Build and Release run as VS Code Tasks so compiler errors land in the
// Problems panel (via the $msCompile problem matcher). Run uses a dedicated
// terminal so app output streams live and the process can be stopped.
// Debug builds first, then starts a `coreclr` debug session against the
// output assembly (requires the C# extension; falls back to plain Run).

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class DotnetTools implements vscode.Disposable {
    /** Terminal used by Run; recreated on every launch so Stop is reliable. */
    private runTerminal: vscode.Terminal | undefined;

    dispose(): void {
        this.stop();
    }

    // ------------------------------------------------------------------ Build

    async build(): Promise<void> {
        const project = await this.findProject();
        if (!project) { return; }
        await this.execTask('build', ['build', project, '-c', 'Debug']);
    }

    // -------------------------------------------------------------------- Run

    async run(): Promise<void> {
        const project = await this.findProject();
        if (!project) { return; }
        this.stop();
        this.runTerminal = vscode.window.createTerminal({
            name: 'UI Maker: Run',
            cwd: path.dirname(project)
        });
        this.runTerminal.show(true);
        // `dotnet run` builds first, so a stale binary is never launched.
        this.runTerminal.sendText(`dotnet run --project "${project}"`);
    }

    stop(): void {
        this.runTerminal?.dispose();
        this.runTerminal = undefined;
    }

    // ------------------------------------------------------------------ Debug

    async debug(): Promise<void> {
        const project = await this.findProject();
        if (!project) { return; }

        // Build first; a failed build should surface errors, not a debugger.
        const exitCode = await this.execTaskAndWait('build', ['build', project, '-c', 'Debug']);
        if (exitCode !== 0) {
            vscode.window.showErrorMessage('UI Maker: build failed — fix the errors before debugging.');
            return;
        }

        const program = this.findOutputAssembly(project);
        if (!program) {
            vscode.window.showWarningMessage('UI Maker: could not locate the build output. Launching without the debugger.');
            await this.run();
            return;
        }

        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project));
        const config: vscode.DebugConfiguration = {
            name: 'UI Maker: Debug',
            type: 'coreclr',
            request: 'launch',
            program,
            cwd: path.dirname(program),
            console: 'internalConsole',
            stopAtEntry: false
        };

        // `coreclr` is provided by the C# extension. If it is missing the call
        // rejects, in which case we offer the install and fall back to Run.
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
        const exitCode = await this.execTaskAndWait('publish', ['publish', project, '-c', 'Release']);
        if (exitCode !== 0) { return; }

        // Point the user at the publish folder that was just produced.
        const publishDir = this.findPublishDir(project);
        const open = 'Open Output Folder';
        const choice = await vscode.window.showInformationMessage(
            `UI Maker: release build published${publishDir ? ` to ${publishDir}` : ''}.`,
            ...(publishDir ? [open] : [])
        );
        if (choice === open && publishDir) {
            void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(publishDir));
        }
    }

    // ------------------------------------------------------- project location

    /**
     * Locate the .csproj to operate on: walk up from the active editor's file,
     * then fall back to a workspace search (with a picker if several exist).
     */
    async findProject(): Promise<string | undefined> {
        const active = vscode.window.activeTextEditor?.document.uri ?? DesignerActiveUri();
        if (active?.scheme === 'file') {
            let dir = path.dirname(active.fsPath);
            const stopAt = vscode.workspace.getWorkspaceFolder(active)?.uri.fsPath ?? path.parse(dir).root;
            for (;;) {
                const hit = this.csprojIn(dir);
                if (hit) { return hit; }
                if (dir === stopAt || path.dirname(dir) === dir) { break; }
                dir = path.dirname(dir);
            }
        }

        const found = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**', 16);
        if (found.length === 0) {
            const create = 'New Project';
            const choice = await vscode.window.showWarningMessage('UI Maker: no .csproj found in this workspace.', create);
            if (choice === create) { void vscode.commands.executeCommand('formforge.newProject'); }
            return undefined;
        }
        if (found.length === 1) { return found[0].fsPath; }

        const pick = await vscode.window.showQuickPick(
            found.map(f => ({
                label: path.basename(f.fsPath),
                description: vscode.workspace.asRelativePath(f),
                fsPath: f.fsPath
            })),
            { placeHolder: 'UI Maker: select the project' }
        );
        return pick?.fsPath;
    }

    private csprojIn(dir: string): string | undefined {
        try {
            const hit = fs.readdirSync(dir).find(f => f.toLowerCase().endsWith('.csproj'));
            return hit ? path.join(dir, hit) : undefined;
        } catch {
            return undefined;
        }
    }

    // --------------------------------------------------------- task plumbing

    /** Run `dotnet <args>` as a shared task with MSBuild problem matching. */
    private execTask(name: string, args: string[]): Thenable<vscode.TaskExecution> {
        const task = new vscode.Task(
            { type: 'formforge', task: name },
            vscode.TaskScope.Workspace,
            name,
            'UI Maker',
            new vscode.ShellExecution('dotnet', args),
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
    private async execTaskAndWait(name: string, args: string[]): Promise<number | undefined> {
        const execution = await this.execTask(name, args);
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

    /** Resolve bin/Debug/<tfm>/<assembly>.dll for the given project. */
    private findOutputAssembly(project: string): string | undefined {
        const dir = path.dirname(project);
        const xml = this.tryRead(project) ?? '';
        const assembly =
            /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/.exec(xml)?.[1] ??
            path.basename(project, '.csproj');

        // Prefer the declared target framework, otherwise scan bin/Debug.
        const tfm =
            /<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/.exec(xml)?.[1] ??
            /<TargetFrameworks>\s*([^<;]+)/.exec(xml)?.[1];

        const candidates: string[] = [];
        if (tfm) {
            candidates.push(path.join(dir, 'bin', 'Debug', tfm, `${assembly}.dll`));
        }
        const debugDir = path.join(dir, 'bin', 'Debug');
        try {
            for (const sub of fs.readdirSync(debugDir)) {
                candidates.push(path.join(debugDir, sub, `${assembly}.dll`));
            }
        } catch { /* no build output yet */ }

        return candidates.find(c => fs.existsSync(c));
    }

    /** Locate the newest bin/Release/<tfm>/publish folder after a publish. */
    private findPublishDir(project: string): string | undefined {
        const releaseDir = path.join(path.dirname(project), 'bin', 'Release');
        try {
            const dirs = fs.readdirSync(releaseDir)
                .map(sub => path.join(releaseDir, sub, 'publish'))
                .filter(p => fs.existsSync(p))
                .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            return dirs[0];
        } catch {
            return undefined;
        }
    }

    private tryRead(file: string): string | undefined {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return undefined;
        }
    }
}

// Late import accessor to avoid a circular import at module load time:
// designerProvider imports nothing from here, but extension.ts wires both.
function DesignerActiveUri(): vscode.Uri | undefined {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DesignerProvider } = require('./designerProvider') as typeof import('./designerProvider');
    return DesignerProvider.activeDocumentUri;
}
