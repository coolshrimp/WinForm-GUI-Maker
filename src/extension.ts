// UI Maker — extension entry point.
//
// Responsibilities:
//   * Register the visual designer (custom editor for *.xaml / *.Designer.cs).
//   * Register the UI Maker activity-bar side panel.
//   * Register the Build / Run / Debug / Release commands. Run and Debug are
//     play/stop toggles that follow the app state (green play <-> red stop).
//   * Register window/form creation and duplication commands.
//   * Show status-bar buttons whenever the workspace contains a .NET project.
//   * Register the "New .NET Desktop Project" scaffolding command.

import * as vscode from 'vscode';
import { DesignerProvider } from './designerProvider';
import { DotnetTools } from './dotnetTools';
import { newProject, generateProjectFile } from './scaffold';
import { registerSidebar } from './sidebar';
import { addXamlWindow, addWinForm, duplicateDesignFile } from './formFiles';
import { addCsFile, addResourceFiles } from './resources';
import { openGuide } from './guide';
import { openAppSettings } from './appSettings';
import { openProjectProperties } from './projectProperties';
import { openNugetPackages } from './nugetPackages';
import { openControlLibrary } from './controlLibrary';
import { initInstaller, openInstallerCreator, pickInstallerScope, revealFolder } from './installer';
import { convertToSdkStyle } from './convertToSdk';
import { registerXamlIntellisense } from './xamlIntellisense';
import {
    EXCLUDE_GLOB, findProjectDirsUnder, getWorkingFolder, initWorkingFolder,
    onDidChangeWorkingFolder, setWorkingFolder
} from './workingFolder';
import { touchRecentProject } from './sidebar';
import { ensureSolutionFor } from './solutionFile';
import * as fs from 'fs';
import * as path from 'path';

/** Status-bar buttons, created once on activation and toggled with project presence. */
const statusItems: vscode.StatusBarItem[] = [];
let runStatusItem: vscode.StatusBarItem | undefined;
let debugStatusItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const dotnet = new DotnetTools();
    context.subscriptions.push(dotnet);

    // Track which project folder the user is working in. Everything
    // project-scoped (run/build, sidebar lists) targets this folder only —
    // a parent folder full of projects is never operated on as a whole.
    initWorkingFolder(context);
    initInstaller(context);

    // --- Visual designer (custom editor) ------------------------------------
    context.subscriptions.push(DesignerProvider.register(context));

    // --- Activity-bar side panel --------------------------------------------
    registerSidebar(context, dotnet);

    // --- XAML IntelliSense in the text editor -------------------------------
    // Completions, snippets, hover docs, and inline color swatches for .xaml —
    // hand-editing markup no longer needs Visual Studio either.
    registerXamlIntellisense(context);

    // --- Commands -----------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('uimaker.newProject', async () => {
            if (await requireWorkspaceTrust('create a project with the .NET CLI')) {
                return newProject();
            }
        }),

        // Point UI Maker at ANY .NET project folder on disk (FAP-Studio
        // style): the picked project becomes the working folder for Run,
        // Build, and the sidebar lists — no workspace switch required.
        vscode.commands.registerCommand('uimaker.openProject', async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Open .NET Project',
                title: 'UI Maker: open a .NET project folder'
            });
            if (!picked?.length) { return; }
            const root = picked[0].fsPath;
            const dirs = findProjectDirsUnder(root);
            if (!dirs.length) {
                // Orphan sources (no project file): offer to generate one so
                // the folder builds — the usual case for copied/legacy code.
                const gen = 'Generate Project File';
                const choice = await vscode.window.showWarningMessage(
                    `UI Maker: no .csproj/.vbproj under "${path.basename(root)}". Generate one from the sources so it builds and runs?`,
                    gen);
                if (choice !== gen) { return; }
                const proj = await generateProjectFile(root);
                if (!proj) { return; }
                dirs.push(path.dirname(proj));
            }
            let dir = dirs[0];
            if (dirs.length > 1) {
                const pick = await vscode.window.showQuickPick(
                    dirs.map(d => ({ label: path.basename(d), description: d, dir: d })),
                    { placeHolder: 'Several projects found — pick the one to work on' });
                if (!pick) { return; }
                dir = pick.dir;
            }
            setWorkingFolder(dir);
            touchRecentProject(dir);
            await refreshProjectContext();
            void vscode.window.showInformationMessage(
                `UI Maker: working folder set to ${path.basename(dir)} — Run, Build, and the side panel now target it.`);
        }),

        // Re-open the given (or active) designable file in the designer editor.
        vscode.commands.registerCommand('uimaker.openDesigner', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            const p = target?.fsPath.toLowerCase() ?? '';
            if (!target || !(p.endsWith('.xaml') || p.endsWith('.designer.cs') || p.endsWith('.designer.vb'))) {
                vscode.window.showWarningMessage('UI Maker: select a .xaml, *.Designer.cs, or *.Designer.vb file to open in the designer.');
                return;
            }
            return vscode.commands.executeCommand('vscode.openWith', target, DesignerProvider.viewType);
        }),

        // Open the raw source text editor next to the designer (split view).
        vscode.commands.registerCommand('uimaker.openCodeBeside', (uri?: vscode.Uri) => {
            const target = uri ?? DesignerProvider.activeDocumentUri;
            if (!target) {
                return;
            }
            return vscode.commands.executeCommand('vscode.openWith', target, 'default', vscode.ViewColumn.Beside);
        }),

        // Build / run / debug / release all resolve the project nearest to the
        // active editor so multi-project workspaces behave sensibly.
        vscode.commands.registerCommand('uimaker.build', async () => {
            if (await requireWorkspaceTrust('build this project')) { return dotnet.build(); }
        }),
        vscode.commands.registerCommand('uimaker.run', async () => {
            if (await requireWorkspaceTrust('run this project')) { return dotnet.run(); }
        }),
        vscode.commands.registerCommand('uimaker.debug', async () => {
            if (await requireWorkspaceTrust('debug this project')) { return dotnet.debug(); }
        }),
        vscode.commands.registerCommand('uimaker.release', async () => {
            if (await requireWorkspaceTrust('publish this project')) { return dotnet.release(); }
        }),
        vscode.commands.registerCommand('uimaker.stop', () => dotnet.stop()),
        vscode.commands.registerCommand('uimaker.runToggle', async () => {
            if (dotnet.state === 'running' || await requireWorkspaceTrust('run this project')) {
                return dotnet.runToggle();
            }
        }),
        vscode.commands.registerCommand('uimaker.debugToggle', async () => {
            if (dotnet.state === 'debugging' || await requireWorkspaceTrust('debug this project')) {
                return dotnet.debugToggle();
            }
        }),

        // The built-in "How to Build an App" guide (side panel + palette).
        vscode.commands.registerCommand('uimaker.openGuide', () => openGuide()),

        // Settings editor for the app being built (Properties.Settings grid).
        vscode.commands.registerCommand('uimaker.appSettings', (project?: string) => openAppSettings(dotnet, project)),

        // Visual Studio-style project property page and NuGet manager.
        vscode.commands.registerCommand('uimaker.projectProperties', () => openProjectProperties(dotnet)),

        // Package the publish output into a Windows installer (Inno Setup).
        vscode.commands.registerCommand('uimaker.createInstaller', async (project?: string) => {
            if (await requireWorkspaceTrust('create an installer')) {
                return openInstallerCreator(dotnet, project);
            }
        }),
        vscode.commands.registerCommand('uimaker.installerSettingsScope', () => pickInstallerScope()),

        // The full UI Maker settings page — same view as Extensions → UI Maker
        // → the gear → Settings, but reachable from the sidebar and palette.
        vscode.commands.registerCommand('uimaker.openSettings', () =>
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:coolshrimp.uimaker')),
        vscode.commands.registerCommand('uimaker.nugetPackages', (project?: string) => openNugetPackages(dotnet, project)),

        // Custom controls: project scan results + hand-registered library.
        vscode.commands.registerCommand('uimaker.controlLibrary', (project?: string) => openControlLibrary(dotnet, project)),

        // Visual Studio interop: make sure a .sln exists so VS's own
        // designers get project context (loose .xaml files won't load there).
        vscode.commands.registerCommand('uimaker.createSolution', () => ensureVsSolution(true)),

        // Classic .NET Framework project -> modern SDK format (fixes the
        // C# Dev Kit "project file is in unsupported format" warning).
        vscode.commands.registerCommand('uimaker.convertToSdk', async (project?: string) => {
            if (await requireWorkspaceTrust('convert this project')) {
                return convertToSdkStyle(dotnet, project);
            }
        }),

        // Show the current WORKING project folder in the OS file manager
        // (falls back to the workspace root when no project is active).
        vscode.commands.registerCommand('uimaker.openWorkingFolder', () => {
            const working = getWorkingFolder();
            const target = working
                ? vscode.Uri.file(working)
                : vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!target) {
                vscode.window.showWarningMessage('UI Maker: open a folder first.');
                return;
            }
            return revealFolder(target.fsPath);
        }),

        // Window/form creation and duplication (sidebar buttons + context menus).
        vscode.commands.registerCommand('uimaker.addWindow', () => addXamlWindow(dotnet)),
        vscode.commands.registerCommand('uimaker.addForm', () => addWinForm(dotnet)),

        // Project Files category buttons: new class, import images/resources.
        vscode.commands.registerCommand('uimaker.addCsFile', () => addCsFile()),
        vscode.commands.registerCommand('uimaker.addImage', () => addResourceFiles(true)),
        vscode.commands.registerCommand('uimaker.addResource', () => addResourceFiles(false)),
        vscode.commands.registerCommand('uimaker.duplicateDesignFile', (item?: { designUri?: vscode.Uri } | vscode.Uri) => {
            const uri = item instanceof vscode.Uri ? item : item?.designUri;
            if (!uri) { return; }
            return duplicateDesignFile(uri);
        })
    );

    // --- Status bar buttons -------------------------------------------------
    createStatusItems(context);
    context.subscriptions.push(dotnet.onDidChangeState(() => updateRunStatusItems(dotnet)));
    updateRunStatusItems(dotnet);

    // Show the buttons only when a .NET project is reachable (workspace or an
    // externally opened working folder), and keep watching for changes.
    void refreshProjectContext();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{csproj,vbproj}');
    watcher.onDidCreate(() => refreshProjectContext());
    watcher.onDidDelete(() => refreshProjectContext());
    context.subscriptions.push(watcher);
    context.subscriptions.push(onDidChangeWorkingFolder(() => {
        void refreshProjectContext();
        // Keep every project UI Maker touches openable in Visual Studio.
        ensureVsSolution(false);
    }));
    ensureVsSolution(false);
}

/** First project file directly inside a folder (the working-folder shape). */
function projectFileIn(dir: string): string | undefined {
    try {
        const hit = fs.readdirSync(dir).find(f => /\.(cs|vb)proj$/i.test(f));
        return hit ? path.join(dir, hit) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Make sure the working project has a Visual Studio solution. Quiet mode
 * (automatic) only reports when it actually creates one; interactive mode
 * (the command) always answers.
 */
function ensureVsSolution(interactive: boolean): void {
    const dir = getWorkingFolder() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const proj = dir ? projectFileIn(dir) : undefined;
    if (!proj) {
        if (interactive) {
            void vscode.window.showWarningMessage(
                'UI Maker: no .csproj/.vbproj in the working folder — open or create a project first.');
        }
        return;
    }
    try {
        const created = ensureSolutionFor(proj);
        if (created) {
            vscode.window.setStatusBarMessage(
                `UI Maker: created ${path.basename(created)} — the project now opens cleanly in Visual Studio too.`, 8000);
        } else if (interactive) {
            void vscode.window.showInformationMessage(
                'UI Maker: this project already has a Visual Studio solution — nothing to do.');
        }
    } catch (err) {
        if (interactive) {
            void vscode.window.showWarningMessage(
                `UI Maker: could not write the solution file — ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

export function deactivate(): void {
    // Disposables registered on the context handle all cleanup.
}

/** Build the row of status-bar buttons (right-to-left priority ordering). */
function createStatusItems(context: vscode.ExtensionContext): void {
    const defs: Array<[string, string, string]> = [
        ['uimaker.build',       '$(tools) Build',     'UI Maker: build the project'],
        ['uimaker.runToggle',   '$(play) Run',        'UI Maker: build and launch the app'],
        ['uimaker.debugToggle', '$(debug-alt) Debug', 'UI Maker: build and debug the app'],
        ['uimaker.release',     '$(package) Release', 'UI Maker: publish a Release build']
    ];
    let priority = 100;
    for (const [command, text, tooltip] of defs) {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority--);
        item.command = command;
        item.text = text;
        item.tooltip = tooltip;
        statusItems.push(item);
        context.subscriptions.push(item);
        if (command === 'uimaker.runToggle') { runStatusItem = item; }
        if (command === 'uimaker.debugToggle') { debugStatusItem = item; }
    }
}

/** Flip the Run/Debug status-bar buttons between play and stop looks. */
function updateRunStatusItems(dotnet: DotnetTools): void {
    if (runStatusItem) {
        if (dotnet.state === 'running') {
            runStatusItem.text = '$(debug-stop) Stop';
            runStatusItem.tooltip = 'UI Maker: the app is running — click to stop it';
            runStatusItem.color = new vscode.ThemeColor('charts.red');
        } else {
            runStatusItem.text = '$(play) Run';
            runStatusItem.tooltip = 'UI Maker: build and launch the app';
            runStatusItem.color = new vscode.ThemeColor('charts.green');
        }
    }
    if (debugStatusItem) {
        if (dotnet.state === 'debugging') {
            debugStatusItem.text = '$(debug-stop) Stop Debug';
            debugStatusItem.tooltip = 'UI Maker: the debugger is attached — click to stop it';
            debugStatusItem.color = new vscode.ThemeColor('charts.red');
        } else {
            debugStatusItem.text = '$(debug-alt) Debug';
            debugStatusItem.tooltip = 'UI Maker: build and debug the app';
            debugStatusItem.color = undefined;
        }
    }
}

/** Toggle status-bar buttons and the `uimaker.hasProject` context key. */
async function refreshProjectContext(): Promise<void> {
    const found = await vscode.workspace.findFiles('**/*.{csproj,vbproj}', EXCLUDE_GLOB, 1);
    // An external project opened via Open Project… counts too.
    const hasProject = found.length > 0 || !!getWorkingFolder();
    await vscode.commands.executeCommand('setContext', 'uimaker.hasProject', hasProject);
    for (const item of statusItems) {
        if (hasProject) {
            item.show();
        } else {
            item.hide();
        }
    }
}

/** Block code/tool execution in Restricted Mode while keeping visual editing available. */
async function requireWorkspaceTrust(action: string): Promise<boolean> {
    if (vscode.workspace.isTrusted) { return true; }
    const manage = 'Manage Workspace Trust';
    const choice = await vscode.window.showWarningMessage(
        `UI Maker cannot ${action} while this workspace is in Restricted Mode.`,
        manage
    );
    if (choice === manage) {
        await vscode.commands.executeCommand('workbench.trust.manage');
    }
    return false;
}
