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
import { newProject } from './scaffold';
import { registerSidebar } from './sidebar';
import { addXamlWindow, addWinForm, duplicateDesignFile } from './formFiles';
import { openGuide } from './guide';
import { openAppSettings } from './appSettings';

/** Status-bar buttons, created once on activation and toggled with project presence. */
const statusItems: vscode.StatusBarItem[] = [];
let runStatusItem: vscode.StatusBarItem | undefined;
let debugStatusItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const dotnet = new DotnetTools();
    context.subscriptions.push(dotnet);

    // --- Visual designer (custom editor) ------------------------------------
    context.subscriptions.push(DesignerProvider.register(context));

    // --- Activity-bar side panel --------------------------------------------
    registerSidebar(context, dotnet);

    // --- Commands -----------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('uimaker.newProject', () => newProject()),

        // Re-open the given (or active) designable file in the designer editor.
        vscode.commands.registerCommand('uimaker.openDesigner', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            const p = target?.fsPath.toLowerCase() ?? '';
            if (!target || !(p.endsWith('.xaml') || p.endsWith('.designer.cs'))) {
                vscode.window.showWarningMessage('UI Maker: select a .xaml or *.Designer.cs file to open in the designer.');
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
        vscode.commands.registerCommand('uimaker.build', () => dotnet.build()),
        vscode.commands.registerCommand('uimaker.run', () => dotnet.run()),
        vscode.commands.registerCommand('uimaker.debug', () => dotnet.debug()),
        vscode.commands.registerCommand('uimaker.release', () => dotnet.release()),
        vscode.commands.registerCommand('uimaker.stop', () => dotnet.stop()),
        vscode.commands.registerCommand('uimaker.runToggle', () => dotnet.runToggle()),
        vscode.commands.registerCommand('uimaker.debugToggle', () => dotnet.debugToggle()),

        // The built-in "How to Build an App" guide (side panel + palette).
        vscode.commands.registerCommand('uimaker.openGuide', () => openGuide()),

        // Settings editor for the app being built (Properties.Settings grid).
        vscode.commands.registerCommand('uimaker.appSettings', () => openAppSettings(dotnet)),

        // Show the current project folder in the OS file manager.
        vscode.commands.registerCommand('uimaker.openWorkingFolder', () => {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (!ws) {
                vscode.window.showWarningMessage('UI Maker: open a folder first.');
                return;
            }
            return vscode.env.openExternal(ws);
        }),

        // Window/form creation and duplication (sidebar buttons + context menus).
        vscode.commands.registerCommand('uimaker.addWindow', () => addXamlWindow(dotnet)),
        vscode.commands.registerCommand('uimaker.addForm', () => addWinForm(dotnet)),
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

    // Show the buttons only when the workspace actually contains a .NET project,
    // and keep watching in case one is created or removed later.
    void refreshProjectContext();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{csproj,vbproj}');
    watcher.onDidCreate(() => refreshProjectContext());
    watcher.onDidDelete(() => refreshProjectContext());
    context.subscriptions.push(watcher);
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
    const found = await vscode.workspace.findFiles('**/*.{csproj,vbproj}', '**/{bin,obj,node_modules}/**', 1);
    const hasProject = found.length > 0;
    await vscode.commands.executeCommand('setContext', 'uimaker.hasProject', hasProject);
    for (const item of statusItems) {
        if (hasProject) {
            item.show();
        } else {
            item.hide();
        }
    }
}
