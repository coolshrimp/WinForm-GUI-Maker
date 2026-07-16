// UI Maker — "New .NET Desktop Project" scaffolding.
//
// Wraps `dotnet new` behind a short wizard:
// template -> language -> target framework -> name -> folder -> open.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { promisify } from 'util';
import { touchRecentProject } from './sidebar';
import { installedSdkMajors, isLtsDotnet } from './projectInfo';

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
                description: 'Classic forms — visual designer, build & run supported',
                id: 'winforms'
            },
            {
                label: '$(terminal) Console Application',
                description: 'No UI — plain command-line program',
                id: 'console'
            }
        ],
        { placeHolder: 'Choose a project template' }
    );
    if (!template) { return; }

    // 2) Language --------------------------------------------------------------
    const language = await vscode.window.showQuickPick(
        [
            { label: '$(code) C#', description: 'Default .NET language', id: '' },
            { label: '$(code) Visual Basic', description: 'VB.NET', id: 'VB' },
            { label: '$(circle-slash) C++', description: 'Not available — C++ desktop apps need Visual Studio with the C++ workload', id: 'cpp' }
        ],
        { placeHolder: 'Choose a language' }
    );
    if (!language) { return; }
    if (language.id === 'cpp') {
        vscode.window.showInformationMessage(
            'UI Maker: the dotnet CLI has no C++ desktop templates — use Visual Studio with the "Desktop development with C++" workload for C++ apps. C# and Visual Basic are supported here.');
        return;
    }

    // 3) Target framework ------------------------------------------------------
    // Offer the frameworks the SDKs on THIS machine can actually build —
    // a static list goes stale (and .NET 6 is already out of support).
    const majors = await installedSdkMajors();
    const offered = (majors.length ? majors : [10, 8]).filter(m => m >= 6);
    const framework = await vscode.window.showQuickPick(
        [
            { label: '$(star) SDK default', description: 'Latest .NET installed on this machine (recommended)', id: '' },
            ...offered.map(m => ({
                label: `.NET ${m}`,
                description: isLtsDotnet(m) ? 'Long-term support' : undefined,
                id: `net${m}.0`
            }))
        ],
        { placeHolder: 'Choose the target framework' }
    );
    if (!framework) { return; }

    // 4) Name ----------------------------------------------------------------
    const name = await vscode.window.showInputBox({
        prompt: 'Project name (also used as the default namespace)',
        value: 'MyDesktopApp',
        validateInput: v => NAME_PATTERN.test(v) ? undefined
            : 'Use letters, digits, underscores and dots (must start with a letter).'
    });
    if (!name) { return; }

    // 5) Destination folder ----------------------------------------------------
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
        vscode.window.showErrorMessage(`UI Maker: "${target}" already exists and is not empty.`);
        return;
    }

    // 6) Generate --------------------------------------------------------------
    const args = ['new', template.id, '-n', name, '-o', target];
    if (language.id) { args.push('-lang', language.id); }
    if (framework.id) { args.push('-f', framework.id); }
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Creating ${name}…` },
            () => execFile('dotnet', args)
        );
    } catch (err) {
        vscode.window.showErrorMessage(`UI Maker: dotnet new failed — ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    // 7) Open ------------------------------------------------------------------
    touchRecentProject(target);
    const here = 'Open';
    const newWindow = 'Open in New Window';
    const choice = await vscode.window.showInformationMessage(
        `UI Maker: project "${name}" created.`, here, newWindow
    );
    if (choice) {
        await vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(target),
            { forceNewWindow: choice === newWindow }
        );
    }
}
