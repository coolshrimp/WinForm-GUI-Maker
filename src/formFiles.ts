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
import { escapeRegExp, isCSharpIdentifier, sanitizeCSharpNamespace } from './csharpText';
import { isVbIdentifier } from './vbText';
import { decodeXmlEntities } from './xmlText';
import { createFilesAtomically, replaceFileAtomically } from './atomicFile';

/** The language a project compiles: file pairs must match it exactly. */
function projectLanguage(project: string): 'cs' | 'vb' {
    return /\.vbproj$/i.test(project) ? 'vb' : 'cs';
}

// ------------------------------------------------------------------ commands

/** Create a new WPF Window (<Name>.xaml + <Name>.xaml.cs / .xaml.vb). */
export async function addXamlWindow(dotnet: DotnetTools): Promise<void> {
    const project = await dotnet.findProject();
    if (!project) { return; }
    const lang = projectLanguage(project);
    const dir = path.dirname(project);

    const name = await askName('NewWindow', dir, n =>
        [path.join(dir, `${n}.xaml`), path.join(dir, `${n}.xaml.${lang}`)]);
    if (!name) { return; }

    const ns = namespaceFor(project);
    const xamlPath = path.join(dir, `${name}.xaml`);
    const csPath = path.join(dir, `${name}.xaml.${lang}`);

    // VB WPF applies the project root namespace implicitly, so its x:Class
    // is the bare class name (exactly what Visual Studio generates).
    const xamlSource =
        `<Window x:Class="${lang === 'vb' ? name : `${ns}.${name}`}"\r\n` +
        `        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\r\n` +
        `        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"\r\n` +
        `        Title="${name}" Width="800" Height="450">\r\n` +
        `    <Grid>\r\n` +
        `    </Grid>\r\n` +
        `</Window>\r\n`;
    const codeSource = lang === 'vb'
        ? `Class ${name}\r\n` +
          `\r\n` +
          `End Class\r\n`
        : `using System.Windows;\r\n` +
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
          `}\r\n`;
    try {
        createFilesAtomically([
            { target: xamlPath, contents: xamlSource },
            { target: csPath, contents: codeSource }
        ]);
    } catch (err) {
        vscode.window.showErrorMessage(`UI Maker: could not create the window files — ${err}`);
        return;
    }

    registerInClassicProject(project, [
        { tag: 'Page', include: relTo(project, xamlPath), generator: 'MSBuild:Compile', subType: 'Designer' },
        { tag: 'Compile', include: relTo(project, csPath), dependentUpon: `${name}.xaml`, subType: 'Code' }
    ]);

    await vscode.commands.executeCommand('uimaker.openDesigner', vscode.Uri.file(xamlPath));
    void vscode.commands.executeCommand('uimaker.refreshSidebar');
}

/** Create a new WinForms Form (<Name>.cs/.vb + matching Designer file). */
export async function addWinForm(dotnet: DotnetTools): Promise<void> {
    const project = await dotnet.findProject();
    if (!project) { return; }
    const lang = projectLanguage(project);
    const dir = path.dirname(project);

    const name = await askName('NewForm', dir, n =>
        [path.join(dir, `${n}.${lang}`), path.join(dir, `${n}.Designer.${lang}`)]);
    if (!name) { return; }

    if (lang === 'vb') { return addVbWinForm(project, dir, name); }

    const ns = namespaceFor(project);
    const csPath = path.join(dir, `${name}.cs`);
    const designerPath = path.join(dir, `${name}.Designer.cs`);

    const codeSource =
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
        `}\r\n`;

    // Classic fully-qualified designer code — compiles on every framework and
    // carries all the anchors the visual designer edits against.
    const designerSource =
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
        `}\r\n`;
    try {
        createFilesAtomically([
            { target: csPath, contents: codeSource },
            { target: designerPath, contents: designerSource }
        ]);
    } catch (err) {
        vscode.window.showErrorMessage(`UI Maker: could not create the form files — ${err}`);
        return;
    }

    registerInClassicProject(project, [
        { tag: 'Compile', include: relTo(project, csPath), subType: 'Form' },
        { tag: 'Compile', include: relTo(project, designerPath), dependentUpon: `${name}.cs` }
    ]);

    await vscode.commands.executeCommand('uimaker.openDesigner', vscode.Uri.file(designerPath));
    void vscode.commands.executeCommand('uimaker.refreshSidebar');
}

/** VB flavor of Add Form: the same file pair Visual Studio generates. */
async function addVbWinForm(project: string, dir: string, name: string): Promise<void> {
    const vbPath = path.join(dir, `${name}.vb`);
    const designerPath = path.join(dir, `${name}.Designer.vb`);

    const codeSource =
        `Public Class ${name}\r\n` +
        `\r\n` +
        `End Class\r\n`;

    // Classic fully-qualified designer code with the anchors the visual
    // designer edits against (SuspendLayout, comment trio, ResumeLayout).
    const designerSource =
        `<Global.Microsoft.VisualBasic.CompilerServices.DesignerGenerated()> _\r\n` +
        `Partial Class ${name}\r\n` +
        `    Inherits System.Windows.Forms.Form\r\n` +
        `\r\n` +
        `    'Form overrides dispose to clean up the component list.\r\n` +
        `    <System.Diagnostics.DebuggerNonUserCode()> _\r\n` +
        `    Protected Overrides Sub Dispose(ByVal disposing As Boolean)\r\n` +
        `        Try\r\n` +
        `            If disposing AndAlso components IsNot Nothing Then\r\n` +
        `                components.Dispose()\r\n` +
        `            End If\r\n` +
        `        Finally\r\n` +
        `            MyBase.Dispose(disposing)\r\n` +
        `        End Try\r\n` +
        `    End Sub\r\n` +
        `\r\n` +
        `    'Required by the Windows Form Designer\r\n` +
        `    Private components As System.ComponentModel.IContainer\r\n` +
        `\r\n` +
        `    'NOTE: The following procedure is required by the Windows Form Designer\r\n` +
        `    'It can be modified using the Windows Form Designer.\r\n` +
        `    'Do not modify it using the code editor.\r\n` +
        `    <System.Diagnostics.DebuggerStepThrough()> _\r\n` +
        `    Private Sub InitializeComponent()\r\n` +
        `        Me.SuspendLayout()\r\n` +
        `        '\r\n` +
        `        '${name}\r\n` +
        `        '\r\n` +
        `        Me.AutoScaleDimensions = New System.Drawing.SizeF(7.0!, 15.0!)\r\n` +
        `        Me.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font\r\n` +
        `        Me.ClientSize = New System.Drawing.Size(800, 450)\r\n` +
        `        Me.Name = "${name}"\r\n` +
        `        Me.Text = "${name}"\r\n` +
        `        Me.ResumeLayout(False)\r\n` +
        `    End Sub\r\n` +
        `End Class\r\n`;
    try {
        createFilesAtomically([
            { target: vbPath, contents: codeSource },
            { target: designerPath, contents: designerSource }
        ]);
    } catch (err) {
        vscode.window.showErrorMessage(`UI Maker: could not create the form files — ${err}`);
        return;
    }

    registerInClassicProject(project, [
        { tag: 'Compile', include: relTo(project, vbPath), subType: 'Form' },
        { tag: 'Compile', include: relTo(project, designerPath), dependentUpon: `${name}.vb` }
    ]);

    await vscode.commands.executeCommand('uimaker.openDesigner', vscode.Uri.file(designerPath));
    void vscode.commands.executeCommand('uimaker.refreshSidebar');
}

/**
 * Duplicate a designable file pair under a new class name.
 * `uri` is a .xaml file or a *.Designer.cs / *.Designer.vb file.
 */
export async function duplicateDesignFile(uri: vscode.Uri): Promise<void> {
    const src = uri.fsPath;
    if (!fs.existsSync(src)) {
        vscode.window.showErrorMessage('UI Maker: the source file no longer exists.');
        return;
    }
    const dir = path.dirname(src);
    const isXaml = /\.xaml$/i.test(src);
    const oldName = isXaml
        ? path.basename(src, path.extname(src))
        : path.basename(src).replace(/\.Designer\.(cs|vb)$/i, '');
    // The file set's language comes from the files themselves, so the pair
    // stays intact even when the designer file sits outside any project.
    const lang: 'cs' | 'vb' = isXaml
        ? (!fs.existsSync(path.join(dir, `${oldName}.xaml.cs`))
            && fs.existsSync(path.join(dir, `${oldName}.xaml.vb`)) ? 'vb' : 'cs')
        : (/\.designer\.vb$/i.test(src) ? 'vb' : 'cs');

    const name = await askName(`${oldName}Copy`, dir, n => isXaml
        ? [path.join(dir, `${n}.xaml`), path.join(dir, `${n}.xaml.${lang}`)]
        : [path.join(dir, `${n}.${lang}`), path.join(dir, `${n}.Designer.${lang}`)]);
    if (!name) { return; }

    // Source file set: designer + code-behind (+ resx for WinForms).
    const pairs: Array<[string, string]> = isXaml
        ? [
            [src, path.join(dir, `${name}.xaml`)],
            [path.join(dir, `${oldName}.xaml.${lang}`), path.join(dir, `${name}.xaml.${lang}`)]
        ]
        : [
            [path.join(dir, `${oldName}.${lang}`), path.join(dir, `${name}.${lang}`)],
            [src, path.join(dir, `${name}.Designer.${lang}`)],
            [path.join(dir, `${oldName}.resx`), path.join(dir, `${name}.resx`)]
        ];

    const required = isXaml
        ? pairs.slice(0, /\bx:Class\s*=/.test(fs.readFileSync(src, 'utf8')) ? 2 : 1)
        : pairs.slice(0, 2);
    const project = projectAbove(dir);
    const missing = required.find(([from]) => !fs.existsSync(from));
    if (missing) {
        vscode.window.showErrorMessage(
            `UI Maker: cannot duplicate an incomplete file set — ${path.basename(missing[0])} is missing.`);
        return;
    }

    // Publish the complete copy set together. A failed read/write or a target
    // created concurrently cannot leave half of a window/form pair behind.
    let written: string[] = [];
    try {
        const files = pairs.filter(([from]) => fs.existsSync(from)).map(([from, target]) => {
            let text = fs.readFileSync(from, 'utf8');
            if (!/\.resx$/i.test(from)) { text = renameClass(text, oldName, name); }
            return { target, contents: text };
        });
        createFilesAtomically(files);
        written = files.map(file => file.target);
    } catch (err) {
        vscode.window.showErrorMessage(
            `UI Maker: duplication failed; no partial copy was kept. ${err instanceof Error ? err.message : String(err)}`);
        return;
    }

    // Register the copies in classic projects.
    if (project) {
        registerInClassicProject(project, isXaml
            ? [
                { tag: 'Page', include: relTo(project, path.join(dir, `${name}.xaml`)), generator: 'MSBuild:Compile', subType: 'Designer' },
                { tag: 'Compile', include: relTo(project, path.join(dir, `${name}.xaml.${lang}`)), dependentUpon: `${name}.xaml`, subType: 'Code' }
            ]
            : [
                { tag: 'Compile', include: relTo(project, path.join(dir, `${name}.${lang}`)), subType: 'Form' },
                { tag: 'Compile', include: relTo(project, path.join(dir, `${name}.Designer.${lang}`)), dependentUpon: `${name}.${lang}` },
                ...(fs.existsSync(path.join(dir, `${name}.resx`))
                    ? [{ tag: 'EmbeddedResource', include: relTo(project, path.join(dir, `${name}.resx`)), dependentUpon: `${name}.${lang}` }]
                    : [])
            ]);
    }

    const openTarget = isXaml ? written[0] : written.find(f => /\.Designer\.(cs|vb)$/i.test(f)) ?? written[0];
    await vscode.commands.executeCommand('uimaker.openDesigner', vscode.Uri.file(openTarget));
    void vscode.commands.executeCommand('uimaker.refreshSidebar');
    vscode.window.showInformationMessage(`UI Maker: duplicated ${oldName} as ${name}.`);
}

// ------------------------------------------------------------------- helpers

/** Prompt for a type name; rejects names whose target files already exist.
 *  Generated names must be identifiers in BOTH languages (the target files
 *  decide which compiler sees them, so reject either keyword set). */
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
            if (!isCSharpIdentifier(v) || !isVbIdentifier(v)) {
                return 'Use a non-keyword identifier (letters, digits, and underscores).';
            }
            const clash = targets(v).find(f => fs.existsSync(f));
            return clash ? `${path.basename(clash)} already exists here.` : undefined;
        }
    });
}

/**
 * Rename the class inside copied designer/code-behind text. Targeted
 * replacements only — free-form identifiers in user code are left alone.
 * The patterns cover both languages: C# `class`/`typeof` and VB (case-kept)
 * `Class`/`GetType`; VB constructors are `Sub New` and carry no name.
 */
function renameClass(text: string, oldName: string, newName: string): string {
    const old = escapeRegExp(oldName);
    return text
        // class declarations: "partial class Old" / "Partial Class Old"
        .replace(new RegExp(`\\b([Cc]lass\\s+)${old}\\b`, 'g'), `$1${newName}`)
        // C# constructor: "public Old("
        .replace(new RegExp(`\\bpublic\\s+${old}\\s*\\(`, 'g'), `public ${newName}(`)
        // resources: "typeof(Old)" / "GetType(Old)"
        .replace(new RegExp(`\\b(typeof|GetType)\\(${old}\\)`, 'g'), `$1(${newName})`)
        // designer identity: this.Name = "Old"; / Me.Name = "Old" / Name = "Old"
        .replace(new RegExp(`(\\bName\\s*=\\s*)"${old}"`, 'g'), `$1"${newName}"`)
        // XAML: x:Class="Ns.Old" (or bare "Old" in VB)
        .replace(new RegExp(`(x:Class="[^"]*?)\\b${old}"`, 'g'), `$1${newName}"`)
        // XML doc header: "Interaction logic for Old.xaml"
        .replace(new RegExp(`\\b${old}\\.xaml\\b`, 'g'), `${newName}.xaml`);
}

/** Root namespace: csproj RootNamespace, else the sanitized project name. */
function namespaceFor(project: string): string {
    try {
        const xml = fs.readFileSync(project, 'utf8');
        const root = /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/.exec(xml)?.[1];
        if (root) { return sanitizeCSharpNamespace(decodeXmlEntities(root)); }
    } catch { /* fall through to the file name */ }
    const base = path.basename(project).replace(/\.(cs|vb)proj$/i, '');
    return sanitizeCSharpNamespace(base);
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

/** Escape a value for use inside an XML attribute or text node — a valid
 *  directory name like "R&D" must not corrupt the project file. */
function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
                e.generator ? `      <Generator>${xmlEscape(e.generator)}</Generator>` : '',
                e.subType ? `      <SubType>${xmlEscape(e.subType)}</SubType>` : '',
                e.dependentUpon ? `      <DependentUpon>${xmlEscape(e.dependentUpon)}</DependentUpon>` : ''
            ].filter(Boolean);
            return children.length
                ? `    <${e.tag} Include="${xmlEscape(e.include)}">${eol}${children.join(eol)}${eol}    </${e.tag}>`
                : `    <${e.tag} Include="${xmlEscape(e.include)}" />`;
        }).join(eol);
        xml = xml.replace(/<\/Project>/, `  <ItemGroup>${eol}${body}${eol}  </ItemGroup>${eol}</Project>`);
        replaceFileAtomically(project, xml);
    } catch {
        vscode.window.showWarningMessage('UI Maker: could not add the new files to the project file — add them manually.');
    }
}
