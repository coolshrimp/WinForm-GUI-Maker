// UI Maker — activity-bar side panel.
//
// A single tree view with four groups:
//   * Actions          — the project commands. Run and Debug are play/stop
//                        toggles: a green play button while idle that turns
//                        into a red stop button while the app is running.
//   * Recent Projects  — .NET projects seen before, tagged with their type
//                        (WinForms/WPF + framework); click to switch over.
//   * XAML Windows     — every .xaml file in the workspace (+ add/duplicate)
//   * WinForms Forms   — every Form's *.Designer.cs (+ add/duplicate)
//
// Clicking a file opens it straight in the visual designer. The lists refresh
// automatically when matching files are created, deleted, or renamed.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DotnetTools } from './dotnetTools';
import { folderTypeLabel } from './projectInfo';

const RECENTS_KEY = 'uimaker.recentProjects';
const MAX_RECENTS = 10;

interface RecentProject {
    path: string;
    lastOpened: number;
}

/** Set once by registerSidebar so other modules can record recents. */
let extContext: vscode.ExtensionContext | undefined;

/** Record a project folder in the recent-projects list (most recent first). */
export function touchRecentProject(folder: string): void {
    if (!extContext) { return; }
    const list = (extContext.globalState.get<RecentProject[]>(RECENTS_KEY) ?? [])
        .filter(r => r.path.toLowerCase() !== folder.toLowerCase());
    list.unshift({ path: folder, lastOpened: Date.now() });
    void extContext.globalState.update(RECENTS_KEY, list.slice(0, MAX_RECENTS));
}

function getRecents(): RecentProject[] {
    return extContext?.globalState.get<RecentProject[]>(RECENTS_KEY) ?? [];
}

function removeRecent(folder: string): void {
    if (!extContext) { return; }
    void extContext.globalState.update(
        RECENTS_KEY,
        getRecents().filter(r => r.path !== folder)
    );
}

/** One row in the side panel. */
export class SidebarItem extends vscode.TreeItem {
    public children: SidebarItem[] | undefined;
    public projectPath: string | undefined;
    /** File behind a designable-file row (used by duplicate/open commands). */
    public designUri: vscode.Uri | undefined;

    constructor(
        label: string,
        options: {
            icon?: string;
            /** Theme color id for the icon, e.g. 'charts.green'. */
            iconColor?: string;
            command?: string;
            args?: unknown[];
            tooltip?: string;
            description?: string;
            contextValue?: string;
            children?: SidebarItem[];
        } = {}
    ) {
        super(label, options.children
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None);
        if (options.icon) {
            this.iconPath = new vscode.ThemeIcon(
                options.icon,
                options.iconColor ? new vscode.ThemeColor(options.iconColor) : undefined
            );
        }
        if (options.command) {
            this.command = { command: options.command, title: label, arguments: options.args };
        }
        this.tooltip = options.tooltip;
        this.description = options.description;
        this.contextValue = options.contextValue;
        this.children = options.children;
    }
}

export class UiMakerSidebar implements vscode.TreeDataProvider<SidebarItem> {
    private readonly changed = new vscode.EventEmitter<SidebarItem | undefined>();
    public readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly dotnet: DotnetTools) { }

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
                children: this.actionItems()
            }),
            new SidebarItem('Recent Projects', {
                icon: 'history',
                children: this.recentItems()
            }),
            new SidebarItem('XAML Windows', {
                icon: 'layout',
                contextValue: 'uimakerXamlGroup',
                children: await this.designerFileItems('**/*.xaml', 'window', 'gear')
            }),
            new SidebarItem('WinForms Forms', {
                icon: 'window',
                contextValue: 'uimakerFormGroup',
                children: await this.winFormsItems()
            })
        ];
    }

    /** The command rows; Run and Debug reflect the current run state. */
    private actionItems(): SidebarItem[] {
        const state = this.dotnet.state;
        const running = state === 'running';
        const debugging = state === 'debugging';

        return [
            new SidebarItem('New .NET Desktop Project', { icon: 'new-folder', command: 'formforge.newProject', tooltip: 'Scaffold a WPF, Windows Forms, or Console app via dotnet new (C# or Visual Basic)' }),
            new SidebarItem('Build', { icon: 'tools', command: 'formforge.build', tooltip: 'Build the project (Debug)' }),
            running
                ? new SidebarItem('Stop App', { icon: 'debug-stop', iconColor: 'charts.red', command: 'formforge.runToggle', description: 'running', tooltip: 'The app is running — click to stop it' })
                : new SidebarItem('Run App', { icon: 'play', iconColor: 'charts.green', command: 'formforge.runToggle', tooltip: 'Build and launch the app' }),
            debugging
                ? new SidebarItem('Stop Debugging', { icon: 'debug-stop', iconColor: 'charts.red', command: 'formforge.debugToggle', description: 'debugging', tooltip: 'The debugger is attached — click to stop it' })
                : new SidebarItem('Debug App', { icon: 'debug-alt', iconColor: 'charts.green', command: 'formforge.debugToggle', tooltip: 'Build and launch under the debugger' }),
            new SidebarItem('Build Release (Publish)', { icon: 'package', command: 'formforge.release', tooltip: 'Publish a Release build (honors the single .exe settings — see UI Maker settings)' })
        ];
    }

    /** Recent .NET project folders — click to switch this window over. */
    private recentItems(): SidebarItem[] {
        const active = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase();
        const recents = getRecents();
        if (!recents.length) {
            return [new SidebarItem('Projects you open or create appear here', { icon: 'info' })];
        }
        return recents.map(r => {
            const isActive = r.path.toLowerCase() === active;
            const type = folderTypeLabel(r.path);
            const item = new SidebarItem(path.basename(r.path), {
                icon: isActive ? 'folder-active' : 'folder',
                command: isActive ? undefined : 'formforge.recentOpen',
                args: [r.path],
                description: isActive ? (type ? `current · ${type}` : 'current') : (type || undefined),
                tooltip: `${r.path}${type ? `\n${type}` : ''}\nClick to open this project in the current window`,
                contextValue: 'uimakerRecent'
            });
            item.projectPath = r.path;
            return item;
        });
    }

    /** Every designable .xaml file in the workspace (skips build output). */
    private async designerFileItems(glob: string, icon: string, appIcon: string): Promise<SidebarItem[]> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return [new SidebarItem('Open a folder to list its files', { icon: 'info' })];
        }
        const files = await vscode.workspace.findFiles(glob, '**/{bin,obj,node_modules}/**', 200);
        if (!files.length) {
            return [new SidebarItem('No matching files in this workspace', { icon: 'info' })];
        }
        files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        return files.map(uri => {
            const rel = vscode.workspace.asRelativePath(uri);
            const dir = path.dirname(rel);
            const isApp = uri.fsPath.toLowerCase().endsWith('app.xaml');
            const item = new SidebarItem(path.basename(uri.fsPath), {
                icon: isApp ? appIcon : icon,
                command: 'formforge.openDesigner',
                args: [uri],
                description: dir === '.' ? undefined : dir,
                tooltip: `Open ${rel} in the designer`,
                contextValue: isApp ? undefined : 'uimakerXaml'
            });
            item.designUri = uri;
            return item;
        });
    }

    /** WinForms *.Designer.cs files (excluding Settings/Resources codegen). */
    private async winFormsItems(): Promise<SidebarItem[]> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return [new SidebarItem('Open a folder to list its files', { icon: 'info' })];
        }
        const files = await vscode.workspace.findFiles('**/*.Designer.cs', '**/{bin,obj,node_modules}/**', 200);
        const forms = files.filter(uri => {
            const base = path.basename(uri.fsPath).toLowerCase();
            if (base === 'resources.designer.cs' || base === 'settings.designer.cs') { return false; }
            return !uri.fsPath.toLowerCase().includes(`${path.sep}properties${path.sep}`);
        });
        if (!forms.length) {
            return [new SidebarItem('No WinForms designer files found', { icon: 'info' })];
        }
        forms.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        return forms.map(uri => {
            const rel = vscode.workspace.asRelativePath(uri);
            const dir = path.dirname(rel);
            const item = new SidebarItem(path.basename(uri.fsPath), {
                icon: 'window',
                command: 'formforge.openDesigner',
                args: [uri],
                description: dir === '.' ? undefined : dir,
                tooltip: `Open ${rel} in the designer`,
                contextValue: 'uimakerForm'
            });
            item.designUri = uri;
            return item;
        });
    }
}

/** Wire the side panel into the extension: view, commands, watchers, recents. */
export function registerSidebar(context: vscode.ExtensionContext, dotnet: DotnetTools): UiMakerSidebar {
    extContext = context;
    const sidebar = new UiMakerSidebar(dotnet);

    context.subscriptions.push(
        vscode.window.createTreeView('formforge.sidebar', { treeDataProvider: sidebar }),
        vscode.commands.registerCommand('formforge.refreshSidebar', () => sidebar.refresh()),

        // Keep the Run/Debug toggle rows in sync with the actual app state.
        dotnet.onDidChangeState(() => sidebar.refresh()),

        vscode.commands.registerCommand('formforge.recentOpen', async (p: unknown) => {
            const folder = typeof p === 'string' ? p : (p as SidebarItem)?.projectPath;
            if (!folder) { return; }
            if (!fs.existsSync(folder)) {
                const remove = 'Remove from list';
                const pick = await vscode.window.showWarningMessage(
                    `UI Maker: folder no longer exists — ${folder}`, remove);
                if (pick) { removeRecent(folder); sidebar.refresh(); }
                return;
            }
            touchRecentProject(folder);
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: false });
        }),

        vscode.commands.registerCommand('formforge.recentOpenNewWindow', async (item: unknown) => {
            const folder = (item as SidebarItem)?.projectPath;
            if (!folder || !fs.existsSync(folder)) { return; }
            touchRecentProject(folder);
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
        }),

        vscode.commands.registerCommand('formforge.recentRemove', (item: unknown) => {
            const folder = (item as SidebarItem)?.projectPath;
            if (!folder) { return; }
            removeRecent(folder);
            sidebar.refresh();
        })
    );

    // Keep the file lists in sync with the workspace.
    for (const glob of ['**/*.xaml', '**/*.Designer.cs', '**/*.{csproj,vbproj}']) {
        const watcher = vscode.workspace.createFileSystemWatcher(glob);
        watcher.onDidCreate(() => sidebar.refresh());
        watcher.onDidDelete(() => sidebar.refresh());
        context.subscriptions.push(watcher);
    }

    // Remember the current workspace as a recent project when it is a .NET one.
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        void vscode.workspace.findFiles('**/*.{csproj,vbproj}', '**/{bin,obj,node_modules}/**', 1).then(found => {
            if (found.length) {
                touchRecentProject(ws);
                sidebar.refresh();
            }
        });
    }

    return sidebar;
}
