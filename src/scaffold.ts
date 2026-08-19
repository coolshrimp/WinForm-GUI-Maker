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
import { listFilesUnder } from './workingFolder';
import { ensureSolutionFor } from './solutionFile';

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

    // A minimal .sln so the project ALSO opens cleanly in Visual Studio —
    // without one, VS's XAML/forms designers have no project context.
    try {
        const proj = path.join(target, `${name}.${language.id === 'VB' ? 'vbproj' : 'csproj'}`);
        if (fs.existsSync(proj)) { ensureSolutionFor(proj); }
    } catch { /* the solution is a convenience — never block creation */ }

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

/**
 * Generate a minimal SDK-style project file for a folder of orphan sources —
 * a WinForms/WPF app with no .csproj/.vbproj (copied code, legacy folders,
 * loose source dumps). Detects the language and UI flavor from the files,
 * derives the root namespace from the sources so Properties.Resources and
 * friends keep working, asks for the target framework, and writes
 * <Folder>.csproj so `dotnet build/run` and every UI Maker feature work.
 * Returns the created project file path, or undefined when cancelled.
 */
export async function generateProjectFile(dir: string): Promise<string | undefined> {
    const files = listFilesUnder(dir, 2000);
    const cs = files.filter(f => /\.cs$/i.test(f));
    const vb = files.filter(f => /\.vb$/i.test(f));
    const xaml = files.filter(f => /\.xaml$/i.test(f));
    if (!cs.length && !vb.length && !xaml.length) {
        void vscode.window.showWarningMessage(
            'UI Maker: no C#, VB, or XAML source files found in this folder — nothing to build a project from.');
        return undefined;
    }
    const lang: 'cs' | 'vb' = vb.length > cs.length ? 'vb' : 'cs';
    const sources = lang === 'vb' ? vb : cs;

    // UI flavor + declared namespaces, from a bounded scan of the sources.
    let winforms = false;
    let wpf = xaml.length > 0;
    const nsCounts = new Map<string, number>();
    for (const f of sources.slice(0, 120)) {
        let text: string;
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (text.includes('System.Windows.Forms')) { winforms = true; }
        if (/System\.Windows\.(Controls|Media|Window)/.test(text)) { wpf = true; }
        const ns = /(?:^|\n)\s*[Nn]amespace\s+([A-Za-z_][\w.]*)/.exec(text)?.[1];
        if (ns) { nsCounts.set(ns, (nsCounts.get(ns) ?? 0) + 1); }
    }
    if (!winforms && !wpf) { winforms = true; } // desktop default keeps the designer usable

    // Target framework: what this machine's SDKs can build, plus classic 4.8.
    const majors = await installedSdkMajors();
    const offered = (majors.length ? majors : [8]).filter(m => m >= 6);
    const tfmPick = await vscode.window.showQuickPick(
        [
            ...offered.map(m => ({
                label: `.NET ${m} (net${m}.0-windows)`,
                description: isLtsDotnet(m) ? 'Long-term support — recommended for old WinForms/WPF code' : undefined,
                tfm: `net${m}.0-windows`
            })),
            {
                label: '.NET Framework 4.8 (net48)',
                description: 'Classic framework — for code that will not run on modern .NET',
                tfm: 'net48'
            }
        ],
        {
            placeHolder: `Generate ${path.basename(dir)}.${lang}proj — choose the target framework `
                + `(${winforms && wpf ? 'WinForms + WPF' : winforms ? 'WinForms' : 'WPF'}, ${lang === 'vb' ? 'Visual Basic' : 'C#'} detected)`
        }
    );
    if (!tfmPick) { return undefined; }

    const name = path.basename(dir).replace(/[^A-Za-z0-9_.]/g, '_').replace(/^(\d)/, '_$1') || 'App';
    const projPath = path.join(dir, `${name}.${lang}proj`);
    if (fs.existsSync(projPath)) {
        void vscode.window.showWarningMessage(`UI Maker: ${path.basename(projPath)} already exists.`);
        return projPath;
    }

    // Most common namespace declared in the sources wins as RootNamespace.
    // VB prepends the root namespace to declared ones, so when VB files
    // declare their own namespaces the root must be empty.
    const topNs = [...nsCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const rootNs = lang === 'vb' ? (nsCounts.size ? '' : name) : (topNs ?? name);

    // Legacy AssemblyInfo.cs files carry the same attributes the SDK now
    // generates — keep the old file authoritative to avoid duplicate errors.
    const hasAssemblyInfo = files.some(f => /assemblyinfo\.(cs|vb)$/i.test(f));

    const lines = [
        '<Project Sdk="Microsoft.NET.Sdk">',
        '    <PropertyGroup>',
        '        <OutputType>WinExe</OutputType>',
        `        <TargetFramework>${tfmPick.tfm}</TargetFramework>`,
        ...(winforms ? ['        <UseWindowsForms>true</UseWindowsForms>'] : []),
        ...(wpf ? ['        <UseWPF>true</UseWPF>'] : []),
        `        <AssemblyName>${name}</AssemblyName>`,
        `        <RootNamespace>${rootNs}</RootNamespace>`,
        ...(hasAssemblyInfo ? ['        <GenerateAssemblyInfo>false</GenerateAssemblyInfo>'] : []),
        '    </PropertyGroup>',
        '</Project>',
        ''
    ];
    try {
        fs.writeFileSync(projPath, lines.join('\n'), 'utf8');
    } catch (err) {
        void vscode.window.showErrorMessage(
            `UI Maker: could not write ${path.basename(projPath)} — ${err instanceof Error ? err.message : err}`);
        return undefined;
    }
    try { ensureSolutionFor(projPath); } catch { /* convenience only */ }
    void vscode.window.showInformationMessage(
        `UI Maker: created ${path.basename(projPath)} (${tfmPick.tfm}${winforms ? ', WinForms' : ''}${wpf ? ', WPF' : ''}) — the folder now builds with dotnet.`);
    return projPath;
}
