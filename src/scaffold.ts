// FormForge — "New .NET Desktop Project" scaffolding.
//
// Wraps `dotnet new wpf|winforms` behind a short wizard:
// template -> project name -> destination folder -> open the result.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { promisify } from 'util';

const execFile = promisify(cp.execFile);

/** Valid C#/.NET project name: identifier segments separated by dots. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export async function newProject(): Promise<void> {
    // 1) Template ------------------------------------------------------------
    const template = await vscode.window.showQuickPick(
        [
            {
                label: '$(layout) WPF Application',
                description: 'XAML-based UI — full visual designer support',
                id: 'wpf'
            },
            {
                label: '$(window) Windows Forms Application',
                description: 'Code-based forms — build/run supported, designer on the roadmap',
                id: 'winforms'
            }
        ],
        { placeHolder: 'Choose a project template' }
    );
    if (!template) { return; }

    // 2) Name ----------------------------------------------------------------
    const name = await vscode.window.showInputBox({
        prompt: 'Project name (also used as the default namespace)',
        value: 'MyDesktopApp',
        validateInput: v => NAME_PATTERN.test(v) ? undefined
            : 'Use letters, digits, underscores and dots (must start with a letter).'
    });
    if (!name) { return; }

    // 3) Destination folder ----------------------------------------------------
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Create Project Here',
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
    });
    if (!picked || picked.length === 0) { return; }

    const target = path.join(picked[0].fsPath, name);
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
        vscode.window.showErrorMessage(`FormForge: "${target}" already exists and is not empty.`);
        return;
    }

    // 4) Generate --------------------------------------------------------------
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Creating ${name}…` },
            () => execFile('dotnet', ['new', template.id, '-n', name, '-o', target])
        );
    } catch (err) {
        vscode.window.showErrorMessage(`FormForge: dotnet new failed — ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    // 5) Open ------------------------------------------------------------------
    const here = 'Open';
    const newWindow = 'Open in New Window';
    const choice = await vscode.window.showInformationMessage(
        `FormForge: project "${name}" created.`, here, newWindow
    );
    if (choice) {
        await vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(target),
            { forceNewWindow: choice === newWindow }
        );
    }
}
