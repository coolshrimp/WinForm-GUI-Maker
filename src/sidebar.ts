// UI Maker — activity-bar side panel.
//
// A single tree view with two groups:
//   * Actions       — the project commands (new / build / run / debug / ...)
//   * XAML Windows  — every .xaml file in the workspace; click one to open
//                     it in the visual designer.
//
// The XAML list refreshes automatically when .xaml files are created,
// deleted, or renamed anywhere in the workspace.

import * as vscode from 'vscode';
import * as path from 'path';

/** One row in the side panel. */
class SidebarItem extends vscode.TreeItem {
    public children: SidebarItem[] | undefined;

    constructor(
        label: string,
        options: {
            icon?: string;
            command?: string;
            args?: unknown[];
            tooltip?: string;
            description?: string;
            children?: SidebarItem[];
        } = {}
    ) {
        super(label, options.children
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None);
        if (options.icon) { this.iconPath = new vscode.ThemeIcon(options.icon); }
        if (options.command) {
            this.command = { command: options.command, title: label, arguments: options.args };
        }
        this.tooltip = options.tooltip;
        this.description = options.description;
        this.children = options.children;
    }
}

export class UiMakerSidebar implements vscode.TreeDataProvider<SidebarItem> {
    private readonly changed = new vscode.EventEmitter<SidebarItem | undefined>();
    public readonly onDidChangeTreeData = this.changed.event;

    public refresh(): void {
        this.changed.fire(undefined);
    }

    public getTreeItem(item: SidebarItem): vscode.TreeItem {
        return item;
    }

    public async getChildren(item?: SidebarItem): Promise<SidebarItem[]> {
        if (item) { return item.children ?? []; }

        return [
            new SidebarItem('Actions', {
                icon: 'zap',
                children: [
                    new SidebarItem('New .NET Desktop Project', { icon: 'new-folder', command: 'formforge.newProject', tooltip: 'Scaffold a WPF or Windows Forms app via dotnet new' }),
                    new SidebarItem('Build', { icon: 'tools', command: 'formforge.build', tooltip: 'dotnet build (Debug)' }),
                    new SidebarItem('Run App', { icon: 'play', command: 'formforge.run', tooltip: 'Build and launch the app' }),
                    new SidebarItem('Debug App', { icon: 'debug-alt', command: 'formforge.debug', tooltip: 'Build and launch under the debugger' }),
                    new SidebarItem('Build Release (Publish)', { icon: 'package', command: 'formforge.release', tooltip: 'dotnet publish -c Release' }),
                    new SidebarItem('Stop Running App', { icon: 'debug-stop', command: 'formforge.stop', tooltip: 'Terminate the app started by Run' })
                ]
            }),
            new SidebarItem('XAML Windows', {
                icon: 'layout',
                children: await this.xamlItems()
            })
        ];
    }

    /** Every designable .xaml file in the workspace (skips build output). */
    private async xamlItems(): Promise<SidebarItem[]> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return [new SidebarItem('Open a folder to list its XAML files', { icon: 'info' })];
        }

        const files = await vscode.workspace.findFiles('**/*.xaml', '**/{bin,obj,node_modules}/**', 200);
        if (!files.length) {
            return [new SidebarItem('No .xaml files in this workspace', { icon: 'info' })];
        }

        files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        return files.map(uri => {
            const rel = vscode.workspace.asRelativePath(uri);
            const dir = path.dirname(rel);
            return new SidebarItem(path.basename(uri.fsPath), {
                icon: uri.fsPath.toLowerCase().endsWith('app.xaml') ? 'gear' : 'window',
                command: 'formforge.openDesigner',
                args: [uri],
                description: dir === '.' ? undefined : dir,
                tooltip: `Open ${rel} in the designer`
            });
        });
    }
}

/** Wire the side panel into the extension: view, refresh command, watcher. */
export function registerSidebar(context: vscode.ExtensionContext): void {
    const sidebar = new UiMakerSidebar();

    context.subscriptions.push(
        vscode.window.createTreeView('formforge.sidebar', { treeDataProvider: sidebar }),
        vscode.commands.registerCommand('formforge.refreshSidebar', () => sidebar.refresh())
    );

    // Keep the XAML list in sync with the workspace.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.xaml');
    watcher.onDidCreate(() => sidebar.refresh());
    watcher.onDidDelete(() => sidebar.refresh());
    context.subscriptions.push(watcher);
}
