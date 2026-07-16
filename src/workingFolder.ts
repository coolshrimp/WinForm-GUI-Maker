// UI Maker — the active working project folder.
//
// A workspace may be one project, or a parent folder holding many projects
// (like "C# Projects\"). Every project-scoped feature — the sidebar file
// lists, Run/Build/Debug/Release, App Settings — operates on ONE working
// project at a time, never on every project underneath the workspace root.
//
// The working folder follows the file being edited (the folder that owns the
// nearest .csproj/.vbproj), can be switched explicitly from the sidebar, and
// is remembered per workspace across sessions.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Folders never scanned for projects or files (build output, caches, deps). */
export const EXCLUDE_DIRS = ['bin', 'obj', 'node_modules', '.git', '.vs', 'packages', 'TestResults'];
export const EXCLUDE_GLOB = `**/{${EXCLUDE_DIRS.join(',')}}/**`;

const MEMENTO_KEY = 'uimaker.workingFolder';

let current: string | undefined;
let memento: vscode.Memento | undefined;
const changed = new vscode.EventEmitter<string | undefined>();

/** Fires when the working folder switches (sidebar refresh hook). */
export const onDidChangeWorkingFolder = changed.event;

export function getWorkingFolder(): string | undefined {
    return current;
}

export function setWorkingFolder(dir: string | undefined): void {
    if (dir === current) { return; }
    current = dir;
    void memento?.update(MEMENTO_KEY, dir);
    changed.fire(current);
}

/** True when `p` sits inside one of the excluded directories. */
export function inExcludedDir(p: string): boolean {
    const parts = p.split(/[\\/]/).map(s => s.toLowerCase());
    return EXCLUDE_DIRS.some(d => parts.includes(d));
}

/** Every project file in the workspace (excluding build output and caches). */
export function workspaceProjectFiles(limit = 200): Thenable<vscode.Uri[]> {
    return vscode.workspace.findFiles('**/*.{csproj,vbproj}', EXCLUDE_GLOB, limit);
}

/** Distinct folders that contain a project file, sorted by path. */
export async function workspaceProjectDirs(): Promise<string[]> {
    const files = await workspaceProjectFiles();
    const dirs = new Set<string>();
    for (const f of files) {
        if (!inExcludedDir(f.fsPath)) { dirs.add(path.dirname(f.fsPath)); }
    }
    return [...dirs].sort((a, b) => a.localeCompare(b));
}

/** The folder owning the nearest project file above `file`, if any. */
export function projectDirOf(file: string): string | undefined {
    if (inExcludedDir(file)) { return undefined; }
    let dir = path.dirname(file);
    const root = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath
        ?? path.parse(dir).root;
    for (;;) {
        try {
            if (fs.readdirSync(dir).some(f => /\.(cs|vb)proj$/i.test(f))) { return dir; }
        } catch { /* unreadable directory */ }
        if (dir.toLowerCase() === root.toLowerCase() || path.dirname(dir) === dir) { break; }
        dir = path.dirname(dir);
    }
    return undefined;
}

/** Let the user pick the working project from the workspace's projects. */
export async function pickWorkingFolder(): Promise<string | undefined> {
    const dirs = await workspaceProjectDirs();
    if (!dirs.length) {
        void vscode.window.showWarningMessage('UI Maker: no .NET project found in this workspace.');
        return undefined;
    }
    if (dirs.length === 1) {
        setWorkingFolder(dirs[0]);
        return dirs[0];
    }
    const pick = await vscode.window.showQuickPick(
        dirs.map(d => ({
            label: path.basename(d),
            description: vscode.workspace.asRelativePath(d),
            dir: d
        })),
        { placeHolder: 'UI Maker: select the working project (Run, Build, and file lists target it)' }
    );
    if (pick) { setWorkingFolder(pick.dir); }
    return pick?.dir;
}

/**
 * Start tracking: restore the remembered choice, then follow the active
 * editor — whenever a file inside some project gains focus, that project
 * becomes the working folder (like per-folder tools such as SFTP).
 */
export function initWorkingFolder(context: vscode.ExtensionContext): void {
    memento = context.workspaceState;

    const remembered = context.workspaceState.get<string>(MEMENTO_KEY);
    if (remembered && fs.existsSync(remembered)) { current = remembered; }

    const follow = (uri?: vscode.Uri) => {
        if (!uri || uri.scheme !== 'file') { return; }
        const dir = projectDirOf(uri.fsPath);
        if (dir) { setWorkingFolder(dir); }
    };
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(e => follow(e?.document.uri)));
    follow(vscode.window.activeTextEditor?.document.uri);

    // No remembered folder and nothing open: a single-project workspace
    // resolves itself; a multi-project one waits for the user.
    if (!current) {
        void workspaceProjectDirs().then(dirs => {
            if (!current && dirs.length === 1) { setWorkingFolder(dirs[0]); }
        });
    }
}
