// UI Maker — creating and duplicating designable windows/forms.
//
// "Add Window" (WPF) and "Add Form" (WinForms) scaffold the file pair next to
// the project and open it in the designer; "Duplicate" copies an existing
// pair under a new class name. Classic (non-SDK) projects do not glob source
// files, so new files are also registered in the .csproj for them.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readProjectInfo } from './projectInfo';
import { DotnetTools } from './dotnetTools';

/** Valid C# type name for a new window/form. */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ------------------------------------------------------------------ commands

/** Create a new WPF Window (<Name>.xaml + <Name>.xaml.cs). */
export async function addXamlWindow(dotnet: DotnetTools): Promise<void> {
    const project = await dotnet.findProject();
    if (!project) { return; }
    const dir = path.dirname(project);

    const name = await askName('NewWindow', dir, n =>
        [path.join(dir, `${n}.xaml`), path.join(dir, `${n}.xaml.cs`)]);
    if (!name) { return; }

    const ns = namespaceFor(project);
    const xamlPath = path.join(dir, `${name}.xaml`);
    const csPath = path.join(dir, `${name}.xaml.cs`);

    fs.writeFileSync(xamlPath,
        `<Window x:Class="${ns}.${name}"\r\n` +
        `        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\r\n` +
        `        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"\r\n` +
        `        Title="${name}" Width="800" Height="450">\r\n` +
        `    <Grid>\r\n` +
        `    </Grid>\r\n` +
        `</Window>\r\n`, 'utf8');

    fs.writeFileSync(csPath,
        `using System.Windows;\r\n` +
        `\r\n` +
        `namespace ${ns}\r\n` +
        `{\r\n` +
        `    /// <summary>Interaction logic for ${name}.xaml</summary>\r\n` +
        `    public partial class ${name} : Window\r\n` +
        `    {\r\n` +
        `        public ${name}()\r\n` +
        `        {\r\n` +
        `            InitializeComponent();\r\n` +
        `        }\r\n` +
        `    }\r\n` +
        `}\r\n`, 'utf8');

    registerInClassicProject(project, [
        { tag: 'Page', include: relTo(project, xamlPath), generator: 'MSBuild:Compile', subType: 'Designer' },
        { tag: 'Compile', include: relTo(project, csPath), dependentUpon: `${name}.xaml`, subType: 'Code' }
    ]);

    await vscode.commands.executeCommand('uimaker.openDesigner', vscode.Uri.file(xamlPath));
    void vscode.commands.executeCommand('uimaker.refreshSidebar');
}

/** Create a new WinForms Form (<Name>.cs + <Name>.Designer.cs). */
export async function addWinForm(dotnet: DotnetTools): Promise<void> {
    const project = await dotnet.findProject();
    if (!project) { return; }
    const dir = path.dirname(project);

    const name = await askName('NewForm', dir, n =>
        [path.join(dir, `${n}.cs`), path.join(dir, `${n}.Designer.cs`)]);
    if (!name) { return; }

    const ns = namespaceFor(project);
    const csPath = path.join(dir, `${name}.cs`);
    const designerPath = path.join(dir, `${name}.Designer.cs`);

    fs.writeFileSync(csPath,
        `using System;\r\n` +
        `using System.Windows.Forms;\r\n` +
        `\r\n` +
        `namespace ${ns}\r\n` +
        `{\r\n` +
        `    public partial class ${name} : Form\r\n` +
        `    {\r\n` +
        `        public ${name}()\r\n` +
        `        {\r\n` +
        `            InitializeComponent();\r\n` +
        `        }\r\n` +
        `    }\r\n` +
        `}\r\n`, 'utf8');

    // Classic fully-qualified designer code — compiles on every framework and
    // carries all the anchors the visual designer edits against.
    fs.writeFileSync(designerPath,
        `namespace ${ns}\r\n` +
        `{\r\n` +
        `    partial class ${name}\r\n` +
        `    {\r\n` +
        `        /// <summary>Required designer variable.</summary>\r\n` +
        `        private System.ComponentModel.IContainer components = null;\r\n` +
        `\r\n` +
        `        /// <summary>Clean up any resources being used.</summary>\r\n` +
        `        protected override void Dispose(bool disposing)\r\n` +
        `        {\r\n` +
        `            if (disposing && (components != null))\r\n` +
        `            {\r\n` +
        `                components.Dispose();\r\n` +
        `            }\r\n` +
        `            base.Dispose(disposing);\r\n` +
        `        }\r\n` +
        `\r\n` +
        `        #region Windows Form Designer generated code\r\n` +
        `\r\n` +
        `        /// <summary>Required method for Designer support.</summary>\r\n` +
        `        private void InitializeComponent()\r\n` +
        `        {\r\n` +
        `            this.SuspendLayout();\r\n` +
        `            // \r\n` +
        `            // ${name}\r\n` +
        `            // \r\n` +
        `            this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);\r\n` +
        `            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;\r\n` +
        `            this.ClientSize = new System.Drawing.Size(800, 450);\r\n` +
        `            this.Name = "${name}";\r\n` +
        `            this.Text = "${name}";\r\n` +
        `            this.ResumeLayout(false);\r\n` +
        `        }\r\n` +
        `\r\n` +
        `        #endregion\r\n` +
        `    }\r\n` +
        `}\r\n`, 'utf8');

    registerInClassicProject(project, [
        { tag: 'Compile', include: relTo(project, csPath), subType: 'Form' },
        { tag: 'Compile', include: relTo(project, designerPath), dependentUpon: `${name}.cs` }
    ]);

    await vscode.commands.executeCommand('uimaker.openDesigner', vscode.Uri.file(designerPath));
    void vscode.commands.executeCommand('uimaker.refreshSidebar');
}

/**
 * Duplicate a designable file pair under a new class name.
 * `uri` is either a .xaml file or a *.Designer.cs file.
 */
export async function duplicateDesignFile(uri: vscode.Uri): Promise<void> {
    const src = uri.fsPath;
    const dir = path.dirname(src);
    const isXaml = /\.xaml$/i.test(src);
    const oldName = isXaml
        ? path.basename(src, path.extname(src))
        : path.basename(src).replace(/\.Designer\.cs$/i, '');

    const name = await askName(`${oldName}Copy`, dir, n => isXaml
        ? [path.join(dir, `${n}.xaml`), path.join(dir, `${n}.xaml.cs`)]
        : [path.join(dir, `${n}.cs`), path.join(dir, `${n}.Designer.cs`)]);
    if (!name) { return; }

    // Source file set: designer + code-behind (+ resx for WinForms).
    const pairs: Array<[string, string]> = isXaml
        ? [
            [src, path.join(dir, `${name}.xaml`)],
            [path.join(dir, `${oldName}.xaml.cs`), path.join(dir, `${name}.xaml.cs`)]
        ]
        : [
            [path.join(dir, `${oldName}.cs`), path.join(dir, `${name}.cs`)],
            [src, path.join(dir, `${name}.Designer.cs`)],
            [path.join(dir, `${oldName}.resx`), path.join(dir, `${name}.resx`)]
        ];

    const written: string[] = [];
    for (const [from, to] of pairs) {
        if (!fs.existsSync(from)) { continue; }
        let text = fs.readFileSync(from, 'utf8');
        if (!/\.resx$/i.test(from)) {
            text = renameClass(text, oldName, name);
        }
        fs.writeFileSync(to, text, 'utf8');
        written.push(to);
    }
    if (!written.length) {
        vscode.window.showErrorMessage('UI Maker: nothing to duplicate — the source files were not found.');
        return;
    }

    // Register the copies in classic projects.
    const project = projectAbove(dir);
    if (project) {
        registerInClassicProject(project, isXaml
            ? [
                { tag: 'Page', include: relTo(project, path.join(dir, `${name}.xaml`)), generator: 'MSBuild:Compile', subType: 'Designer' },
                { tag: 'Compile', include: relTo(project, path.join(dir, `${name}.xaml.cs`)), dependentUpon: `${name}.xaml`, subType: 'Code' }
            ]
            : [
                { tag: 'Compile', include: relTo(project, path.join(dir, `${name}.cs`)), subType: 'Form' },
                { tag: 'Compile', include: relTo(project, path.join(dir, `${name}.Designer.cs`)), dependentUpon: `${name}.cs` },
                ...(fs.existsSync(path.join(dir, `${name}.resx`))
                    ? [{ tag: 'EmbeddedResource', include: relTo(project, path.join(dir, `${name}.resx`)), dependentUpon: `${name}.cs` }]
                    : [])
            ]);
    }

    const openTarget = isXaml ? written[0] : written.find(f => /\.Designer\.cs$/i.test(f)) ?? written[0];
    await vscode.commands.executeCommand('uimaker.openDesigner', vscode.Uri.file(openTarget));
    void vscode.commands.executeCommand('uimaker.refreshSidebar');
    vscode.window.showInformationMessage(`UI Maker: duplicated ${oldName} as ${name}.`);
}

// ------------------------------------------------------------------- helpers

/** Prompt for a type name; rejects names whose target files already exist. */
async function askName(
    suggestion: string,
    dir: string,
    targets: (name: string) => string[]
): Promise<string | undefined> {
    // Bump a trailing number until the suggestion is free.
    let candidate = suggestion;
    for (let i = 2; targets(candidate).some(f => fs.existsSync(f)); i++) {
        candidate = `${suggestion}${i}`;
    }
    return vscode.window.showInputBox({
        prompt: 'Name for the new window/form (also the class name)',
        value: candidate,
        validateInput: v => {
            if (!NAME_PATTERN.test(v)) { return 'Use letters, digits, and underscores (must not start with a digit).'; }
            const clash = targets(v).find(f => fs.existsSync(f));
            return clash ? `${path.basename(clash)} already exists here.` : undefined;
        }
    });
}

/**
 * Rename the class inside copied designer/code-behind text. Targeted
 * replacements only — free-form identifiers in user code are left alone.
 */
function renameClass(text: string, oldName: string, newName: string): string {
    return text
        // class declarations: "partial class Old", "class Old : Form"
        .replace(new RegExp(`\\bclass\\s+${oldName}\\b`, 'g'), `class ${newName}`)
        // constructor: "public Old("
        .replace(new RegExp(`\\bpublic\\s+${oldName}\\s*\\(`, 'g'), `public ${newName}(`)
        // resources: "typeof(Old)"
        .replace(new RegExp(`\\btypeof\\(${oldName}\\)`, 'g'), `typeof(${newName})`)
        // designer identity: this.Name = "Old"; / Name = "Old";
        .replace(new RegExp(`(\\bName\\s*=\\s*)"${oldName}"`, 'g'), `$1"${newName}"`)
        // XAML: x:Class="Ns.Old"
        .replace(new RegExp(`(x:Class="[^"]*?)\\b${oldName}"`, 'g'), `$1${newName}"`)
        // XML doc header: "Interaction logic for Old.xaml"
        .replace(new RegExp(`\\b${oldName}\\.xaml\\b`, 'g'), `${newName}.xaml`);
}

/** Root namespace: csproj RootNamespace, else the sanitized project name. */
function namespaceFor(project: string): string {
    try {
        const xml = fs.readFileSync(project, 'utf8');
        const root = /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/.exec(xml)?.[1];
        if (root) { return root; }
    } catch { /* fall through to the file name */ }
    const base = path.basename(project).replace(/\.(cs|vb)proj$/i, '');
    const ns = base.replace(/[^A-Za-z0-9_.]/g, '_');
    return /^[0-9]/.test(ns) ? `_${ns}` : ns;
}

/** Nearest .csproj/.vbproj walking up from `dir`. */
function projectAbove(dir: string): string | undefined {
    let current = dir;
    for (;;) {
        try {
            const hit = fs.readdirSync(current).find(f => /\.(cs|vb)proj$/i.test(f));
            if (hit) { return path.join(current, hit); }
        } catch { /* unreadable */ }
        const parent = path.dirname(current);
        if (parent === current) { return undefined; }
        current = parent;
    }
}

function relTo(project: string, file: string): string {
    return path.relative(path.dirname(project), file);
}

interface ProjectEntry {
    tag: string;                 // Compile | Page | EmbeddedResource
    include: string;
    dependentUpon?: string;
    subType?: string;
    generator?: string;
}

/**
 * Classic (non-SDK) projects list every source file explicitly; append an
 * ItemGroup with the new entries. SDK-style projects glob and need nothing.
 */
function registerInClassicProject(project: string, entries: ProjectEntry[]): void {
    const info = readProjectInfo(project);
    if (!info || info.sdkStyle) { return; }
    try {
        let xml = fs.readFileSync(project, 'utf8');
        if (!/<\/Project>/.test(xml)) { return; }
        const eol = xml.includes('\r\n') ? '\r\n' : '\n';
        const body = entries.map(e => {
            const children = [
                e.generator ? `      <Generator>${e.generator}</Generator>` : '',
                e.subType ? `      <SubType>${e.subType}</SubType>` : '',
                e.dependentUpon ? `      <DependentUpon>${e.dependentUpon}</DependentUpon>` : ''
            ].filter(Boolean);
            return children.length
                ? `    <${e.tag} Include="${e.include}">${eol}${children.join(eol)}${eol}    </${e.tag}>`
                : `    <${e.tag} Include="${e.include}" />`;
        }).join(eol);
        xml = xml.replace(/<\/Project>/, `  <ItemGroup>${eol}${body}${eol}  </ItemGroup>${eol}</Project>`);
        fs.writeFileSync(project, xml, 'utf8');
    } catch {
        vscode.window.showWarningMessage('UI Maker: could not add the new files to the project file — add them manually.');
    }
}
