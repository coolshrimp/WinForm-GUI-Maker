// UI Maker — extension entry point.
//
// Responsibilities:
//   * Register the visual designer (custom editor for *.xaml files).
//   * Register the UI Maker activity-bar side panel.
//   * Register the Build / Run / Debug / Release / Stop commands.
//   * Show status-bar buttons whenever the workspace contains a .csproj.
//   * Register the "New .NET Desktop Project" scaffolding command.

import * as vscode from 'vscode';
import { DesignerProvider } from './designerProvider';
import { DotnetTools } from './dotnetTools';
import { newProject } from './scaffold';
import { registerSidebar } from './sidebar';

/** Status-bar buttons, created once on activation and toggled with project presence. */
const statusItems: vscode.StatusBarItem[] = [];

export function activate(context: vscode.ExtensionContext): void {
    const dotnet = new DotnetTools();
    context.subscriptions.push(dotnet);

    // --- Visual designer (custom editor for .xaml) -------------------------
    context.subscriptions.push(DesignerProvider.register(context));

    // --- Activity-bar side panel --------------------------------------------
    registerSidebar(context);

    // --- Commands -----------------------------------------------------------
    context.subscriptions.push(
        vscode.commands.registerCommand('formforge.newProject', () => newProject()),

        // Re-open the given (or active) designable file in the designer editor.
        vscode.commands.registerCommand('formforge.openDesigner', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            const p = target?.fsPath.toLowerCase() ?? '';
            if (!target || !(p.endsWith('.xaml') || p.endsWith('.designer.cs'))) {
                vscode.window.showWarningMessage('UI Maker: select a .xaml or *.Designer.cs file to open in the designer.');
                return;
            }
            return vscode.commands.executeCommand('vscode.openWith', target, DesignerProvider.viewType);
        }),

        // Open the raw XAML text editor next to the designer (split view).
        vscode.commands.registerCommand('formforge.openCodeBeside', (uri?: vscode.Uri) => {
            const target = uri ?? DesignerProvider.activeDocumentUri;
            if (!target) {
                return;
            }
            return vscode.commands.executeCommand('vscode.openWith', target, 'default', vscode.ViewColumn.Beside);
        }),

        // Build / run / debug / release all resolve the project nearest to the
        // active editor so multi-project workspaces behave sensibly.
        vscode.commands.registerCommand('formforge.build', () => dotnet.build()),
        vscode.commands.registerCommand('formforge.run', () => dotnet.run()),
        vscode.commands.registerCommand('formforge.debug', () => dotnet.debug()),
        vscode.commands.registerCommand('formforge.release', () => dotnet.release()),
        vscode.commands.registerCommand('formforge.stop', () => dotnet.stop())
    );

    // --- Status bar buttons -------------------------------------------------
    createStatusItems(context);

    // Show the buttons only when the workspace actually contains a .NET project,
    // and keep watching in case one is created or removed later.
    void refreshProjectContext();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
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
        ['formforge.build',   '$(tools) Build',      'UI Maker: dotnet build'],
        ['formforge.run',     '$(play) Run',         'UI Maker: build and launch the app'],
        ['formforge.debug',   '$(debug-alt) Debug',  'UI Maker: build and debug the app'],
        ['formforge.release', '$(package) Release',  'UI Maker: dotnet publish -c Release'],
        ['formforge.stop',    '$(debug-stop)',       'UI Maker: stop the running app']
    ];
    let priority = 100;
    for (const [command, text, tooltip] of defs) {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority--);
        item.command = command;
        item.text = text;
        item.tooltip = tooltip;
        statusItems.push(item);
        context.subscriptions.push(item);
    }
}

/** Toggle status-bar buttons and the `formforge.hasProject` context key. */
async function refreshProjectContext(): Promise<void> {
    const found = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**', 1);
    const hasProject = found.length > 0;
    await vscode.commands.executeCommand('setContext', 'formforge.hasProject', hasProject);
    for (const item of statusItems) {
        if (hasProject) {
            item.show();
        } else {
            item.hide();
        }
    }
}
