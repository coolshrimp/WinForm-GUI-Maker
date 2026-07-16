// UI Maker — the built-in "How to Build an App" guide.
//
// A read-only webview page (no scripts) that teaches the anatomy of a .NET
// desktop project: the workflow from New Project to a shipped .exe, the file
// tree of a WPF app and of a WinForms app, which files are required vs.
// optional vs. generated, and what every single file is for.
//
// Opened from the side panel (Actions → Guide), the panel title-bar book
// icon, or the Command Palette. Only one guide panel exists at a time —
// re-running the command brings the existing one to the front.

import * as vscode from 'vscode';

let panel: vscode.WebviewPanel | undefined;

/** Show the guide panel, creating it on first use. */
export function openGuide(): void {
    if (panel) {
        panel.reveal();
        return;
    }
    panel = vscode.window.createWebviewPanel(
        'uimaker.guide',
        'UI Maker — How to Build an App',
        vscode.ViewColumn.One,
        { enableScripts: false }        // pure document — no scripts needed
    );
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.html = guideHtml();
}

// ---------------------------------------------------------------------------
// Page content. Plain HTML styled with VS Code theme variables so it looks
// native in every color theme. Badges mark each file as required / optional /
// generated so users can tell at a glance what they must keep.
// ---------------------------------------------------------------------------

/** A colored badge used in the file trees and tables. */
function badge(kind: 'req' | 'opt' | 'gen'): string {
    const map = {
        req: ['required', 'badge-req'],
        opt: ['optional', 'badge-opt'],
        gen: ['generated', 'badge-gen']
    } as const;
    const [label, cls] = map[kind];
    return `<span class="badge ${cls}">${label}</span>`;
}

function guideHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        max-width: 900px;
        margin: 0 auto;
        padding: 1rem 2rem 4rem;
        line-height: 1.55;
    }
    h1 { font-size: 1.6em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .3em; }
    h2 { font-size: 1.25em; margin-top: 2em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .2em; }
    h3 { font-size: 1.05em; margin-top: 1.5em; }
    code, pre {
        font-family: var(--vscode-editor-font-family, monospace);
        background: var(--vscode-textCodeBlock-background);
        border-radius: 4px;
    }
    code { padding: 1px 5px; }
    pre {
        padding: 12px 16px;
        overflow-x: auto;
        line-height: 1.65;
    }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; margin: .8em 0; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 10px; text-align: left; vertical-align: top; }
    th { background: var(--vscode-textCodeBlock-background); }
    .badge {
        display: inline-block;
        font-size: .72em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: .04em;
        padding: 1px 7px;
        border-radius: 8px;
        vertical-align: middle;
    }
    .badge-req { background: var(--vscode-charts-green); color: var(--vscode-editor-background); }
    .badge-opt { background: var(--vscode-charts-blue);  color: var(--vscode-editor-background); }
    .badge-gen { background: var(--vscode-charts-lines); color: var(--vscode-editor-background); opacity: .85; }
    .tip {
        border-left: 3px solid var(--vscode-charts-yellow);
        background: var(--vscode-textCodeBlock-background);
        padding: 8px 14px;
        margin: 1em 0;
        border-radius: 0 4px 4px 0;
    }
    li { margin: .25em 0; }
</style>
</head>
<body>

<h1>How to Build a .NET Desktop App</h1>
<p>
This guide explains the whole journey — from an empty folder to a working
Windows program — and what every file in your project is for.
Legend used below: ${badge('req')} the app cannot build or run without it &nbsp;·&nbsp;
${badge('opt')} nice to have, safe to delete &nbsp;·&nbsp;
${badge('gen')} created by the build — never edit, never commit to git.
</p>

<h2>1. The workflow</h2>
<ol>
    <li><strong>Create a project</strong> — run <code>UI Maker: New .NET Desktop Project</code>
        (side panel → Actions), pick WPF or Windows Forms, C# or VB, and a target framework.
        Or just open a folder that already contains a <code>.csproj</code>/<code>.vbproj</code>.</li>
    <li><strong>Design the UI</strong> — in the side panel click a window under
        <em>XAML Windows</em> or a form under <em>WinForms Forms</em>. Drag controls from
        the toolbox, position them on the canvas, set properties in the panel on the right.</li>
    <li><strong>Wire events</strong> — double-click a control (or use the Events panel) and
        UI Maker writes the handler stub into the code-behind file. Your logic goes inside it.</li>
    <li><strong>Run it</strong> — press the green <strong>▶ Run</strong> button in the status
        bar. It builds first, launches your app, and turns into a red stop button while it runs.</li>
    <li><strong>Debug it</strong> — set breakpoints in the <code>.cs</code> files and press
        <strong>Debug</strong> to step through your code.</li>
    <li><strong>Ship it</strong> — press <strong>Release</strong> to publish an optimized build.
        With <em>UI Maker › Publish › Single File</em> turned on you get one portable
        <code>.exe</code> you can hand to anyone.</li>
</ol>

<h2>2. A WPF project (windows described in XAML)</h2>
<p>WPF keeps the <em>look</em> of each window in a <code>.xaml</code> markup file and the
<em>behavior</em> in a matching <code>.xaml.cs</code> "code-behind" file. This is what the
designer edits when you work on a window.</p>

<pre><code>MyApp/
├── MyApp.csproj          ${badge('req')}  the project file
├── App.xaml              ${badge('req')}  application definition + shared resources
├── App.xaml.cs           ${badge('req')}  application startup/shutdown code
├── MainWindow.xaml       ${badge('req')}  a window's layout — what the designer edits
├── MainWindow.xaml.cs    ${badge('req')}  that window's code-behind (your event handlers)
├── AssemblyInfo.cs       ${badge('opt')}  assembly metadata attributes
├── app.ico, images…      ${badge('opt')}  icons and other assets you add
├── bin/                  ${badge('gen')}  build output — your .exe lives here
└── obj/                  ${badge('gen')}  intermediate build files
</code></pre>

<table>
    <tr><th>File</th><th>What it does</th><th>Do you edit it?</th></tr>
    <tr><td><code>MyApp.csproj</code></td>
        <td>The project file: which framework to target (<code>net8.0-windows</code>, …),
            the output type, NuGet package references. The build starts from here.</td>
        <td>Rarely — mostly to add packages or change the target framework.</td></tr>
    <tr><td><code>App.xaml</code></td>
        <td>The application object. <code>StartupUri</code> says which window opens first;
            <code>Application.Resources</code> holds styles/colors shared by every window.</td>
        <td>Sometimes — change the startup window or add app-wide styles.</td></tr>
    <tr><td><code>App.xaml.cs</code></td>
        <td>Code-behind for the application: startup and exit events, unhandled-exception
            handling, command-line argument processing.</td>
        <td>Sometimes.</td></tr>
    <tr><td><code>MainWindow.xaml</code></td>
        <td>One window's entire UI as markup: the layout panels, the controls, their
            positions and properties. Every window you add is another <code>.xaml</code> file.</td>
        <td>Yes — visually with UI Maker, or by hand in the split code view.</td></tr>
    <tr><td><code>MainWindow.xaml.cs</code></td>
        <td>The window's logic: the event handler stubs UI Maker generates land here, and
            this is where you write what the app actually <em>does</em>.</td>
        <td>Yes — this is where most of your code goes.</td></tr>
    <tr><td><code>AssemblyInfo.cs</code></td>
        <td>Assembly-level attributes (theme info for WPF, version metadata).</td>
        <td>Almost never.</td></tr>
    <tr><td><code>bin/</code> and <code>obj/</code></td>
        <td>Everything the compiler produces. <code>bin/Debug/…/MyApp.exe</code> is the
            program Run launches; <code>obj</code> holds temporary build state.</td>
        <td>Never — both are safely deletable and belong in <code>.gitignore</code>.</td></tr>
</table>

<h2>3. A Windows Forms project (layout generated as C#)</h2>
<p>WinForms has no markup language — the designer stores each form's layout as generated
C# inside <code>*.Designer.cs</code>. Every form is a <strong>pair</strong>:
<code>Form1.cs</code> (your code) + <code>Form1.Designer.cs</code> (the layout), usually
with a <code>Form1.resx</code> resource file alongside.</p>

<pre><code>MyApp/
├── MyApp.csproj            ${badge('req')}  the project file
├── Program.cs              ${badge('req')}  Main() — the entry point that opens the first form
├── Form1.cs                ${badge('req')}  your code: event handlers and app logic
├── Form1.Designer.cs       ${badge('req')}  the form's layout — what the designer edits
├── Form1.resx              ${badge('opt')}  the form's resources (embedded images, strings)
├── Properties/             ${badge('opt')}  (classic .NET Framework projects have this)
│   ├── AssemblyInfo.cs     ${badge('opt')}  version and product metadata
│   ├── Resources.resx      ${badge('opt')}  project-wide resources + generated accessor
│   └── Settings.settings   ${badge('opt')}  user/app settings + generated accessor
├── App.config              ${badge('opt')}  runtime configuration (classic projects)
├── packages.config         ${badge('opt')}  NuGet list used by classic projects
├── bin/                    ${badge('gen')}  build output — your .exe lives here
└── obj/                    ${badge('gen')}  intermediate build files
</code></pre>

<table>
    <tr><th>File</th><th>What it does</th><th>Do you edit it?</th></tr>
    <tr><td><code>Program.cs</code></td>
        <td>The application entry point: <code>Main()</code> calls
            <code>Application.Run(new Form1())</code>. Change it to open a different form first.</td>
        <td>Rarely.</td></tr>
    <tr><td><code>Form1.cs</code></td>
        <td>Your half of the form. Event handler stubs are generated into this file, and all
            of your logic belongs here.</td>
        <td>Yes — this is where most of your code goes.</td></tr>
    <tr><td><code>Form1.Designer.cs</code></td>
        <td>The generated half: <code>InitializeComponent()</code> creates every control and
            sets every property. UI Maker edits it surgically — only the exact statements
            that change — so the file always stays valid.</td>
        <td>Not by hand — open it in the designer instead.</td></tr>
    <tr><td><code>Form1.resx</code></td>
        <td>Resources embedded in the form (a PictureBox image, localized strings).</td>
        <td>Indirectly, through the designer.</td></tr>
    <tr><td><code>Properties/</code>, <code>App.config</code>, <code>packages.config</code></td>
        <td>Classic .NET Framework plumbing: assembly metadata, saved user settings,
            runtime config, and the pre-SDK NuGet package list. Modern (.NET 6/8/9) projects
            usually need none of them.</td>
        <td>Occasionally (settings); leave the <code>*.Designer.cs</code> ones alone.</td></tr>
</table>

<div class="tip"><strong>Rule of thumb:</strong> files ending in
<code>.Designer.cs</code> are machine-written. Design them visually; put your own code in
the matching plain <code>.cs</code> file. That split is what keeps the designer and your
logic from stepping on each other.</div>

<h2>4. Files around the project</h2>
<table>
    <tr><th>File</th><th></th><th>What it does</th></tr>
    <tr><td><code>MyApp.sln</code></td><td>${badge('opt')}</td>
        <td>A solution file — just a list that groups several projects together. One
            project alone doesn't need it.</td></tr>
    <tr><td><code>.gitignore</code></td><td>${badge('opt')}</td>
        <td>Tells git to skip <code>bin/</code> and <code>obj/</code>. Add one before your
            first commit (see below).</td></tr>
    <tr><td><code>*.vbproj</code>, <code>.vb</code> files</td><td></td>
        <td>The Visual Basic equivalents of <code>.csproj</code>/<code>.cs</code> — same
            structure, different language.</td></tr>
</table>

<h3>A .gitignore to start with</h3>
<pre><code>bin/
obj/
*.user
</code></pre>

<h2>5. Settings your app remembers</h2>
<p>
Apps usually need to remember things between runs — the last window position, a user
name, options the user picked. .NET has a built-in mechanism for this:
<code>Properties/Settings.settings</code> defines the values, a generated
<code>Settings.Designer.cs</code> exposes them as typed properties, and Windows stores
the saved values per user.
</p>
<p>
Open <strong>App Settings</strong> from the side panel (Actions) to define them in a
grid — name, type, <em>User</em> or <em>Application</em> scope, and a default value —
exactly like Visual Studio's Settings page. Then, in your code:
</p>
<pre><code>// read a setting
var name = Properties.Settings.Default.PlayerName;

// change and persist it (User scope only)
Properties.Settings.Default.PlayerName = "Ada";
Properties.Settings.Default.Save();
</code></pre>
<ul>
    <li><strong>User</strong> scope — read/write; <code>Save()</code> persists the value
        for the current Windows user.</li>
    <li><strong>Application</strong> scope — read-only constants baked into the app.</li>
</ul>

<h2>6. Where things end up</h2>
<ul>
    <li><strong>Run / Debug</strong> build to <code>bin/Debug/&lt;framework&gt;/MyApp.exe</code>.</li>
    <li><strong>Build Release (Publish)</strong> writes an optimized build to
        <code>bin/Release/&lt;framework&gt;/publish/</code> and opens it for you.</li>
    <li>With <em>UI Maker › Publish › Single File</em> enabled, the publish folder contains a
        single portable <code>.exe</code>; add <em>Self Contained</em> and it runs even on
        machines with no .NET installed (at the cost of a bigger file).</li>
</ul>

<div class="tip"><strong>Sharing your app:</strong> send the contents of the
<code>publish</code> folder — never the <code>Debug</code> folder. Debug builds are slower,
unoptimized, and may depend on files only present on your machine.</div>

</body>
</html>`;
}
