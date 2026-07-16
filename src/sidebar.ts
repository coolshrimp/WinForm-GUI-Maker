// UI Maker — activity-bar side panel.
//
// A single tree view with five groups:
//   * Actions          — the project commands. Run and Debug are play/stop
//                        toggles: a green play button while idle that turns
//                        into a red stop button while the app is running.
//   * Recent Projects  — .NET projects seen before, tagged with their type
//                        (WinForms/WPF + framework); click to switch over.
//   * XAML Windows     — every .xaml file in the workspace (+ add/duplicate)
//   * WinForms Forms   — every Form's *.Designer.cs (+ add/duplicate)
//   * Project Files    — everything else, sorted into type categories
//                        (Code, Images & Icons, Resources, Data & Config,
//                        Project & Solution, Other) like a solution explorer.
//
// Clicking a designable file opens it straight in the visual designer; other
// files open in their default editor. The lists refresh automatically when
// files are created, deleted, or renamed.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DotnetTools } from './dotnetTools';
import { folderTypeLabel } from './projectInfo';
import {
    EXCLUDE_GLOB, getWorkingFolder, onDidChangeWorkingFolder,
    pickWorkingFolder, workspaceProjectDirs
} from './workingFolder';

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
            /** Start category groups collapsed to keep the panel tidy. */
            collapsed?: boolean;
        } = {}
    ) {
        super(label, options.children
            ? (options.collapsed
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.Expanded)
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

        // A parent folder holding several projects is never listed whole:
        // every file group scopes to the active working project.
        const scope = await this.resolveScope();

        return [
            new SidebarItem('Actions', {
                icon: 'zap',
                children: this.actionItems(scope)
            }),
            new SidebarItem('Recent Projects', {
                icon: 'history',
                children: this.recentItems()
            }),
            new SidebarItem('XAML Windows', {
                icon: 'layout',
                contextValue: 'uimakerXamlGroup',
                children: await this.designerFileItems(scope, '**/*.xaml', 'window', 'gear')
            }),
            new SidebarItem('WinForms Forms', {
                icon: 'window',
                contextValue: 'uimakerFormGroup',
                children: await this.winFormsItems(scope)
            }),
            new SidebarItem('Project Files', {
                icon: 'files',
                children: await this.projectFileItems(scope)
            })
        ];
    }

    /**
     * Where the file lists look:
     *   dir     — the working project folder (multi-project workspace)
     *   'all'   — the whole workspace (single project, or none at all)
     *   'pick'  — multi-project workspace with no working folder chosen yet
     */
    private async resolveScope(): Promise<{ mode: 'dir' | 'all' | 'pick'; dir?: string; multi: boolean }> {
        const dirs = await workspaceProjectDirs();
        const working = getWorkingFolder();
        if (dirs.length <= 1) { return { mode: 'all', multi: false }; }
        if (working && fs.existsSync(working)) { return { mode: 'dir', dir: working, multi: true }; }
        return { mode: 'pick', multi: true };
    }

    /** findFiles pattern for the active scope. */
    private scopedPattern(scope: { mode: string; dir?: string }, glob: string): vscode.GlobPattern {
        return scope.mode === 'dir' && scope.dir
            ? new vscode.RelativePattern(vscode.Uri.file(scope.dir), glob)
            : glob;
    }

    private static pickHint(): SidebarItem {
        return new SidebarItem('Multiple projects here — choose a working folder', {
            icon: 'folder-opened',
            command: 'uimaker.selectWorkingFolder',
            tooltip: 'This workspace contains several .NET projects. Pick the one to design, run, and build — the file lists then show only that project.'
        });
    }

    /** Everything that is not a designable file, grouped by type category. */
    private async projectFileItems(scope: { mode: string; dir?: string }): Promise<SidebarItem[]> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return [new SidebarItem('Open a folder to list its files', { icon: 'info' })];
        }
        if (scope.mode === 'pick') { return [UiMakerSidebar.pickHint()]; }
        const files = await vscode.workspace.findFiles(
            this.scopedPattern(scope, '**/*'), EXCLUDE_GLOB, 800);

        // contextValue drives the inline add buttons (package.json menus).
        const cats: Record<string, { icon: string; context?: string; files: vscode.Uri[] }> = {
            'Code':               { icon: 'file-code', context: 'uimakerCatCode', files: [] },
            'Images & Icons':     { icon: 'file-media', context: 'uimakerCatImages', files: [] },
            'Resources':          { icon: 'library', context: 'uimakerCatResources', files: [] },
            'Data & Config':      { icon: 'gear', files: [] },
            'Project & Solution': { icon: 'project', files: [] },
            'Other':              { icon: 'file', files: [] }
        };

        for (const uri of files) {
            const base = path.basename(uri.fsPath).toLowerCase();
            const ext = path.extname(base);
            // Designable files already have their own groups above.
            if (ext === '.xaml' || /\.designer\.cs$/.test(base)) { continue; }
            if (ext === '.cs' || ext === '.vb') { cats['Code'].files.push(uri); }
            else if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.cur'].includes(ext)) { cats['Images & Icons'].files.push(uri); }
            else if (['.resx', '.settings'].includes(ext)) { cats['Resources'].files.push(uri); }
            else if (['.csproj', '.vbproj', '.sln', '.slnx', '.props', '.targets'].includes(ext)) { cats['Project & Solution'].files.push(uri); }
            else if (['.json', '.xml', '.config', '.manifest', '.ini', '.csv', '.txt', '.md', '.yml', '.yaml'].includes(ext)) { cats['Data & Config'].files.push(uri); }
            else { cats['Other'].files.push(uri); }
        }

        const groups: SidebarItem[] = [];
        for (const [name, cat] of Object.entries(cats)) {
            if (!cat.files.length) { continue; }
            cat.files.sort((a, b) => path.basename(a.fsPath).localeCompare(path.basename(b.fsPath)));
            const children = cat.files.map(uri => {
                const rel = vscode.workspace.asRelativePath(uri);
                const dir = path.dirname(rel);
                const item = new SidebarItem(path.basename(uri.fsPath), {
                    command: 'vscode.open',
                    args: [uri],
                    description: dir === '.' ? undefined : dir,
                    tooltip: rel
                });
                // Real file-theme icon (same as the Explorer shows).
                item.resourceUri = uri;
                item.iconPath = vscode.ThemeIcon.File;
                return item;
            });
            groups.push(new SidebarItem(name, {
                icon: cat.icon,
                description: String(cat.files.length),
                contextValue: cat.context,
                collapsed: true,
                children
            }));
        }
        // Categories with add buttons always show, even while empty.
        for (const [name, cat] of Object.entries(cats)) {
            if (cat.context && !cat.files.length) {
                groups.push(new SidebarItem(name, {
                    icon: cat.icon,
                    description: '0',
                    contextValue: cat.context,
                    collapsed: true,
                    children: [new SidebarItem('Empty — use the + button to add', { icon: 'info' })]
                }));
            }
        }
        return groups.length ? groups : [new SidebarItem('No other files in this workspace', { icon: 'info' })];
    }

    /** The command rows; Run and Debug reflect the current run state. */
    private actionItems(scope: { mode: string; dir?: string; multi: boolean }): SidebarItem[] {
        const state = this.dotnet.state;
        const running = state === 'running';
        const debugging = state === 'debugging';

        // The working folder every action below targets. Shown first so it is
        // always clear WHICH project Run/Build/App Settings will touch.
        const working = scope.mode === 'dir' ? scope.dir : undefined;
        const workingRow = working
            ? new SidebarItem(`Working Folder: ${path.basename(working)}`, {
                icon: 'root-folder-opened',
                iconColor: 'charts.blue',
                command: 'uimaker.selectWorkingFolder',
                description: folderTypeLabel(working) || undefined,
                tooltip: `${working}\n\nRun, Build, Debug, Release, App Settings, and the file lists all target this project only. Click to switch projects.`,
                contextValue: 'uimakerWorkingFolder'
            })
            : scope.multi
                ? new SidebarItem('Select Working Folder…', {
                    icon: 'root-folder',
                    iconColor: 'charts.yellow',
                    command: 'uimaker.selectWorkingFolder',
                    description: 'multiple projects',
                    tooltip: 'This workspace contains several .NET projects. Pick the one to design, run, and build.'
                })
                : undefined;

        return [
            ...(workingRow ? [workingRow] : []),
            new SidebarItem('New .NET Desktop Project', { icon: 'new-folder', command: 'uimaker.newProject', tooltip: 'Scaffold a WPF, Windows Forms, or Console app via dotnet new (C# or Visual Basic)' }),
            new SidebarItem('Build', { icon: 'tools', command: 'uimaker.build', tooltip: 'Build the project (Debug)' }),
            running
                ? new SidebarItem('Stop App', { icon: 'debug-stop', iconColor: 'charts.red', command: 'uimaker.runToggle', description: 'running', tooltip: 'The app is running — click to stop it' })
                : new SidebarItem('Run App', { icon: 'play', iconColor: 'charts.green', command: 'uimaker.runToggle', tooltip: 'Build and launch the app' }),
            debugging
                ? new SidebarItem('Stop Debugging', { icon: 'debug-stop', iconColor: 'charts.red', command: 'uimaker.debugToggle', description: 'debugging', tooltip: 'The debugger is attached — click to stop it' })
                : new SidebarItem('Debug App', { icon: 'debug-alt', iconColor: 'charts.green', command: 'uimaker.debugToggle', tooltip: 'Build and launch under the debugger' }),
            new SidebarItem('Build Release (Publish)', { icon: 'package', command: 'uimaker.release', tooltip: 'Publish a Release build (honors the single .exe settings — see UI Maker settings)' }),
            new SidebarItem('App Settings', { icon: 'settings-gear', command: 'uimaker.appSettings', tooltip: 'Define the settings your app remembers (Properties.Settings) — names, types, User/Application scope, defaults' }),
            new SidebarItem('Open Working Folder', { icon: 'folder-opened', command: 'uimaker.openWorkingFolder', tooltip: 'Open the current project folder in File Explorer' }),
            new SidebarItem('Guide — How to Build an App', { icon: 'book', command: 'uimaker.openGuide', tooltip: 'Required and optional project files, what each one is for, and the path from empty folder to shipped .exe' })
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
                command: isActive ? undefined : 'uimaker.recentOpen',
                args: [r.path],
                description: isActive ? (type ? `current · ${type}` : 'current') : (type || undefined),
                tooltip: `${r.path}${type ? `\n${type}` : ''}\nClick to open this project in the current window`,
                contextValue: 'uimakerRecent'
            });
            item.projectPath = r.path;
            return item;
        });
    }

    /** Every designable .xaml file in scope (skips build output). */
    private async designerFileItems(scope: { mode: string; dir?: string }, glob: string, icon: string, appIcon: string): Promise<SidebarItem[]> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return [new SidebarItem('Open a folder to list its files', { icon: 'info' })];
        }
        if (scope.mode === 'pick') { return [UiMakerSidebar.pickHint()]; }
        const files = await vscode.workspace.findFiles(this.scopedPattern(scope, glob), EXCLUDE_GLOB, 200);
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
                command: 'uimaker.openDesigner',
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
    private async winFormsItems(scope: { mode: string; dir?: string }): Promise<SidebarItem[]> {
        if (!vscode.workspace.workspaceFolders?.length) {
            return [new SidebarItem('Open a folder to list its files', { icon: 'info' })];
        }
        if (scope.mode === 'pick') { return [UiMakerSidebar.pickHint()]; }
        const files = await vscode.workspace.findFiles(this.scopedPattern(scope, '**/*.Designer.cs'), EXCLUDE_GLOB, 200);
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
                command: 'uimaker.openDesigner',
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
        vscode.window.createTreeView('uimaker.sidebar', { treeDataProvider: sidebar }),
        vscode.commands.registerCommand('uimaker.refreshSidebar', () => sidebar.refresh()),

        // Keep the Run/Debug toggle rows in sync with the actual app state.
        dotnet.onDidChangeState(() => sidebar.refresh()),

        // Switch the working project (multi-project parent folders).
        vscode.commands.registerCommand('uimaker.selectWorkingFolder', () => pickWorkingFolder()),
        onDidChangeWorkingFolder(() => sidebar.refresh()),

        vscode.commands.registerCommand('uimaker.recentOpen', async (p: unknown) => {
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

        vscode.commands.registerCommand('uimaker.recentOpenNewWindow', async (item: unknown) => {
            const folder = (item as SidebarItem)?.projectPath;
            if (!folder || !fs.existsSync(folder)) { return; }
            touchRecentProject(folder);
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
        }),

        // Open the project folder in the OS file manager (Windows Explorer).
        vscode.commands.registerCommand('uimaker.recentRevealFolder', async (item: unknown) => {
            const folder = (item as SidebarItem)?.projectPath;
            if (!folder || !fs.existsSync(folder)) { return; }
            await vscode.env.openExternal(vscode.Uri.file(folder));
        }),

        vscode.commands.registerCommand('uimaker.recentRemove', (item: unknown) => {
            const folder = (item as SidebarItem)?.projectPath;
            if (!folder) { return; }
            removeRecent(folder);
            sidebar.refresh();
        })
    );

    // Keep the file lists in sync with the workspace.
    for (const glob of ['**/*.xaml', '**/*.Designer.cs', '**/*.{csproj,vbproj}',
        '**/*.{cs,vb,png,jpg,jpeg,gif,bmp,ico,svg,resx,settings,json,xml,config,manifest,txt,md,sln}']) {
        const watcher = vscode.workspace.createFileSystemWatcher(glob);
        watcher.onDidCreate(() => sidebar.refresh());
        watcher.onDidDelete(() => sidebar.refresh());
        context.subscriptions.push(watcher);
    }

    // Remember the current workspace as a recent project — but only when it
    // IS a single project. A parent folder holding many projects is a browsing
    // location, not a project, and must not autoload into the recents.
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        void workspaceProjectDirs().then(dirs => {
            if (dirs.length === 1) {
                touchRecentProject(ws);
                sidebar.refresh();
            }
        });
    }

    return sidebar;
}
