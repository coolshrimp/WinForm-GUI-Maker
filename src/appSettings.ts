// UI Maker — App Settings editor (the Visual Studio "Settings" page).
//
// Lets the user define saved settings for the app they are building — the
// grid of Name / Type / Scope / Default value that Visual Studio shows under
// Project Properties → Settings. Saving writes the same two files VS writes:
//
//   Properties/Settings.settings     — the XML source of truth
//   Properties/Settings.Designer.cs  — generated typed accessor class
//
// The generated code is byte-compatible with Visual Studio's
// SettingsSingleFileGenerator output, so a project edited here still opens
// cleanly in full Visual Studio and vice-versa. At runtime the app reads
// `Properties.Settings.Default.Name`, assigns User-scoped settings, and calls
// `Properties.Settings.Default.Save()` to persist them per user.
//
// Scope rules (same as VS):
//   * User        — read/write; saved per Windows user; survives restarts.
//   * Application — read-only at runtime; a fixed value baked into the app.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DotnetTools } from './dotnetTools';

/** One row of the settings grid. */
interface AppSetting {
    name: string;
    /** Full CLR type name, e.g. "System.String". */
    type: string;
    scope: 'User' | 'Application';
    /** Serialized default value ("" allowed). */
    value: string;
}

/** The types offered in the grid and their C# keyword for codegen. */
const SETTING_TYPES: Array<{ clr: string; cs: string; label: string }> = [
    { clr: 'System.String',   cs: 'string',                    label: 'string (text)' },
    { clr: 'System.Int32',    cs: 'int',                       label: 'int (whole number)' },
    { clr: 'System.Boolean',  cs: 'bool',                      label: 'bool (true/false)' },
    { clr: 'System.Double',   cs: 'double',                    label: 'double (decimal number)' },
    { clr: 'System.Int64',    cs: 'long',                      label: 'long (big whole number)' },
    { clr: 'System.DateTime', cs: 'global::System.DateTime',   label: 'DateTime (date & time)' }
];

let panel: vscode.WebviewPanel | undefined;

/** Open the App Settings editor for the current project. */
export async function openAppSettings(dotnet: DotnetTools): Promise<void> {
    const project = await dotnet.findProject();
    if (!project) { return; }
    if (/\.vbproj$/i.test(project)) {
        vscode.window.showWarningMessage('UI Maker: the App Settings editor supports C# projects only (for now).');
        return;
    }

    const settingsPath = path.join(path.dirname(project), 'Properties', 'Settings.settings');
    const existing = fs.existsSync(settingsPath) ? parseSettingsFile(fs.readFileSync(settingsPath, 'utf8')) : [];

    if (panel) {
        // Refresh the existing panel with the current project's settings.
        panel.webview.html = editorHtml(panel.webview, project, existing);
        panel.reveal();
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'uimaker.appSettings',
        'App Settings',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.html = editorHtml(panel.webview, project, existing);

    panel.webview.onDidReceiveMessage((msg: { type: string; settings?: AppSetting[] }) => {
        if (msg.type === 'save' && msg.settings) {
            try {
                saveSettings(project, msg.settings);
                vscode.window.showInformationMessage(
                    `UI Maker: saved ${msg.settings.length} setting${msg.settings.length === 1 ? '' : 's'} — use Properties.Settings.Default in your code.`);
            } catch (err) {
                vscode.window.showErrorMessage(`UI Maker: could not save settings — ${err}`);
            }
        }
    });
}

// ---------------------------------------------------------------- file I/O

/** XML-escape a value for the .settings file. */
function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xmlUnescape(s: string): string {
    return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** Escape a default value for use inside a C# string literal. */
function csEscape(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/**
 * Read the settings out of an existing Settings.settings file. Attributes are
 * matched individually so files written by any Visual Studio version parse.
 */
export function parseSettingsFile(xml: string): AppSetting[] {
    const result: AppSetting[] = [];
    const settingRe = /<Setting\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Setting>)/g;
    for (let m = settingRe.exec(xml); m; m = settingRe.exec(xml)) {
        const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m![1])?.[1] ?? '';
        const name = attr('Name');
        if (!name) { continue; }
        const value = /<Value\s+Profile="\(Default\)"\s*>([\s\S]*?)<\/Value>/.exec(m[2] ?? '')?.[1] ?? '';
        result.push({
            name,
            type: attr('Type') || 'System.String',
            scope: attr('Scope') === 'Application' ? 'Application' : 'User',
            value: xmlUnescape(value)
        });
    }
    return result;
}

/** Write Settings.settings + Settings.Designer.cs and register them in classic projects. */
function saveSettings(project: string, settings: AppSetting[]): void {
    const propsDir = path.join(path.dirname(project), 'Properties');
    if (!fs.existsSync(propsDir)) { fs.mkdirSync(propsDir, { recursive: true }); }

    const ns = `${rootNamespace(project)}.Properties`;
    fs.writeFileSync(path.join(propsDir, 'Settings.settings'), settingsXml(ns, settings), 'utf8');
    fs.writeFileSync(path.join(propsDir, 'Settings.Designer.cs'), designerCs(ns, settings), 'utf8');
    registerSettingsFiles(project);
}

/** Root namespace: csproj RootNamespace, else the sanitized project name. */
function rootNamespace(project: string): string {
    try {
        const xml = fs.readFileSync(project, 'utf8');
        const root = /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/.exec(xml)?.[1];
        if (root) { return root; }
    } catch { /* fall through to the file name */ }
    const base = path.basename(project).replace(/\.(cs|vb)proj$/i, '');
    const ns = base.replace(/[^A-Za-z0-9_.]/g, '_');
    return /^[0-9]/.test(ns) ? `_${ns}` : ns;
}

/** The Settings.settings XML — same shape Visual Studio writes. */
function settingsXml(ns: string, settings: AppSetting[]): string {
    const rows = settings.map(s =>
        `    <Setting Name="${s.name}" Type="${s.type}" Scope="${s.scope}">\r\n` +
        `      <Value Profile="(Default)">${xmlEscape(s.value)}</Value>\r\n` +
        `    </Setting>`).join('\r\n');
    return `<?xml version='1.0' encoding='utf-8'?>\r\n` +
        `<SettingsFile xmlns="http://schemas.microsoft.com/VisualStudio/2004/01/settings" ` +
        `CurrentProfile="(Default)" GeneratedClassNamespace="${ns}" GeneratedClassName="Settings">\r\n` +
        `  <Profiles />\r\n` +
        (settings.length
            ? `  <Settings>\r\n${rows}\r\n  </Settings>\r\n`
            : `  <Settings />\r\n`) +
        `</SettingsFile>\r\n`;
}

/** The generated typed accessor class — mirrors SettingsSingleFileGenerator. */
function designerCs(ns: string, settings: AppSetting[]): string {
    const props = settings.map(s => {
        const cs = SETTING_TYPES.find(t => t.clr === s.type)?.cs ?? 'string';
        const scopeAttr = s.scope === 'Application'
            ? 'global::System.Configuration.ApplicationScopedSettingAttribute()'
            : 'global::System.Configuration.UserScopedSettingAttribute()';
        // Empty defaults are omitted for non-string types (an empty string
        // cannot convert to int/bool/…); strings keep "" as a real default.
        const defaultAttr = (s.value !== '' || s.type === 'System.String')
            ? `        [global::System.Configuration.DefaultSettingValueAttribute("${csEscape(s.value)}")]\r\n`
            : '';
        // Application-scoped settings are read-only at runtime, so no setter.
        const setter = s.scope === 'User'
            ? `            set {\r\n                this["${s.name}"] = value;\r\n            }\r\n`
            : '';
        return `        [${scopeAttr}]\r\n` +
            `        [global::System.Diagnostics.DebuggerNonUserCodeAttribute()]\r\n` +
            defaultAttr +
            `        public ${cs} ${s.name} {\r\n` +
            `            get {\r\n` +
            `                return ((${cs})(this["${s.name}"]));\r\n` +
            `            }\r\n` +
            setter +
            `        }`;
    }).join('\r\n\r\n');

    return `//------------------------------------------------------------------------------\r\n` +
        `// <auto-generated>\r\n` +
        `//     This code was generated by a tool.\r\n` +
        `//     Changes to this file may cause incorrect behavior and will be lost if\r\n` +
        `//     the code is regenerated.\r\n` +
        `// </auto-generated>\r\n` +
        `//------------------------------------------------------------------------------\r\n` +
        `\r\n` +
        `namespace ${ns} {\r\n` +
        `\r\n` +
        `    [global::System.Runtime.CompilerServices.CompilerGeneratedAttribute()]\r\n` +
        `    [global::System.CodeDom.Compiler.GeneratedCodeAttribute("Microsoft.VisualStudio.Editors.SettingsDesigner.SettingsSingleFileGenerator", "17.0.0.0")]\r\n` +
        `    internal sealed partial class Settings : global::System.Configuration.ApplicationSettingsBase {\r\n` +
        `\r\n` +
        `        private static Settings defaultInstance = ((Settings)(global::System.Configuration.ApplicationSettingsBase.Synchronized(new Settings())));\r\n` +
        `\r\n` +
        `        public static Settings Default {\r\n` +
        `            get {\r\n` +
        `                return defaultInstance;\r\n` +
        `            }\r\n` +
        `        }\r\n` +
        (props ? `\r\n${props}\r\n` : '') +
        `    }\r\n` +
        `}\r\n`;
}

/**
 * Classic (non-SDK) projects list every file explicitly — add the settings
 * pair with the same metadata Visual Studio uses. Safe to call repeatedly:
 * does nothing when the entries are already present (or the project globs).
 */
function registerSettingsFiles(project: string): void {
    try {
        let xml = fs.readFileSync(project, 'utf8');
        if (/<Project\s[^>]*\bSdk\s*=/.test(xml)) { return; }          // SDK-style globs
        if (xml.includes('Settings.settings')) { return; }             // already registered
        if (!/<\/Project>/.test(xml)) { return; }
        const eol = xml.includes('\r\n') ? '\r\n' : '\n';
        const block =
            `  <ItemGroup>${eol}` +
            `    <None Include="Properties\\Settings.settings">${eol}` +
            `      <Generator>SettingsSingleFileGenerator</Generator>${eol}` +
            `      <LastGenOutput>Settings.Designer.cs</LastGenOutput>${eol}` +
            `    </None>${eol}` +
            `    <Compile Include="Properties\\Settings.Designer.cs">${eol}` +
            `      <AutoGen>True</AutoGen>${eol}` +
            `      <DesignTimeSharedInput>True</DesignTimeSharedInput>${eol}` +
            `      <DependentUpon>Settings.settings</DependentUpon>${eol}` +
            `    </Compile>${eol}` +
            `  </ItemGroup>${eol}`;
        xml = xml.replace(/<\/Project>/, `${block}</Project>`);
        fs.writeFileSync(project, xml, 'utf8');
    } catch {
        vscode.window.showWarningMessage('UI Maker: could not register the settings files in the project — add them manually.');
    }
}

// ------------------------------------------------------------------ webview

/** The grid editor page. State lives in the webview; Save posts it back. */
function editorHtml(webview: vscode.Webview, project: string, settings: AppSetting[]): string {
    const nonce = Math.random().toString(36).slice(2);
    const typeOptions = SETTING_TYPES.map(t => ({ clr: t.clr, label: t.label }));
    // "<" is escaped so a value containing "</script>" cannot break the page.
    const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        max-width: 1000px;
        margin: 0 auto;
        padding: 1rem 2rem 3rem;
        line-height: 1.5;
    }
    h1 { font-size: 1.4em; }
    .project { opacity: .75; font-size: .9em; margin-bottom: 1em; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; text-align: left; }
    th { background: var(--vscode-textCodeBlock-background); }
    input, select {
        width: 100%;
        box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 4px 6px;
        border-radius: 2px;
        font-family: inherit;
        font-size: inherit;
    }
    input.invalid { border-color: var(--vscode-inputValidation-errorBorder, #f00); }
    button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 14px;
        border-radius: 2px;
        cursor: pointer;
        margin-right: 8px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    button.row-del { padding: 2px 8px; }
    .error { color: var(--vscode-errorForeground); min-height: 1.3em; margin: .4em 0; }
    code, pre {
        font-family: var(--vscode-editor-font-family, monospace);
        background: var(--vscode-textCodeBlock-background);
        border-radius: 4px;
    }
    code { padding: 1px 5px; }
    pre { padding: 10px 14px; overflow-x: auto; }
    .hint { opacity: .85; font-size: .92em; }
</style>
</head>
<body>
<h1>App Settings</h1>
<div class="project">Project: <code>${path.basename(project)}</code> →
    writes <code>Properties/Settings.settings</code> + <code>Settings.Designer.cs</code></div>

<p class="hint">
Settings are values your <em>built app</em> remembers — window positions, user names,
options screens. <strong>User</strong> scope: the app can change and
<code>Save()</code> them per Windows user. <strong>Application</strong> scope: fixed
values the app only reads.</p>

<table id="grid">
    <thead>
        <tr><th style="width:26%">Name</th><th style="width:26%">Type</th>
            <th style="width:18%">Scope</th><th>Default value</th><th style="width:1%"></th></tr>
    </thead>
    <tbody></tbody>
</table>

<div class="error" id="error"></div>
<button id="add" class="secondary">＋ Add Setting</button>
<button id="save">Save</button>

<h3>Using them in your code</h3>
<pre><code>// read
var name = Properties.Settings.Default.PlayerName;

// change + persist (User scope only)
Properties.Settings.Default.PlayerName = "Ada";
Properties.Settings.Default.Save();</code></pre>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const TYPES = ${json(typeOptions)};
    let settings = ${json(settings)};

    const tbody = document.querySelector('#grid tbody');
    const errorBox = document.getElementById('error');

    // Rebuild the grid from the settings array (tiny, so full re-render is fine).
    function render() {
        tbody.innerHTML = '';
        settings.forEach((s, i) => {
            const tr = document.createElement('tr');

            const name = document.createElement('input');
            name.value = s.name;
            name.placeholder = 'SettingName';
            name.addEventListener('input', () => { s.name = name.value.trim(); validate(); });

            const type = document.createElement('select');
            for (const t of TYPES) {
                const o = document.createElement('option');
                o.value = t.clr; o.textContent = t.label;
                if (t.clr === s.type) { o.selected = true; }
                type.appendChild(o);
            }
            type.addEventListener('change', () => { s.type = type.value; render(); });

            const scope = document.createElement('select');
            for (const sc of ['User', 'Application']) {
                const o = document.createElement('option');
                o.value = sc; o.textContent = sc;
                if (sc === s.scope) { o.selected = true; }
                scope.appendChild(o);
            }
            scope.addEventListener('change', () => { s.scope = scope.value; });

            // Booleans get a True/False dropdown; everything else a text box.
            let value;
            if (s.type === 'System.Boolean') {
                value = document.createElement('select');
                for (const b of ['False', 'True']) {
                    const o = document.createElement('option');
                    o.value = b; o.textContent = b;
                    if (b === s.value) { o.selected = true; }
                    value.appendChild(o);
                }
                if (s.value !== 'True') { s.value = 'False'; }
                value.addEventListener('change', () => { s.value = value.value; });
            } else {
                value = document.createElement('input');
                value.value = s.value;
                value.placeholder = s.type === 'System.DateTime' ? 'e.g. 2026-01-31 (or empty)' : '';
                value.addEventListener('input', () => { s.value = value.value; validate(); });
            }

            const del = document.createElement('button');
            del.textContent = '✕';
            del.className = 'row-del secondary';
            del.title = 'Remove this setting';
            del.addEventListener('click', () => { settings.splice(i, 1); render(); validate(); });

            for (const el of [name, type, scope, value, del]) {
                const td = document.createElement('td');
                td.appendChild(el);
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        });
    }

    // Names must be unique C# identifiers; numeric types need numeric defaults.
    function validate() {
        const seen = new Set();
        for (const s of settings) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name)) {
                return fail('Setting names must be valid identifiers (letters, digits, underscore; not starting with a digit).');
            }
            if (seen.has(s.name.toLowerCase())) { return fail('Duplicate setting name: ' + s.name); }
            seen.add(s.name.toLowerCase());
            if (s.value !== '') {
                if ((s.type === 'System.Int32' || s.type === 'System.Int64') && !/^-?\\d+$/.test(s.value)) {
                    return fail(s.name + ': default must be a whole number.');
                }
                if (s.type === 'System.Double' && isNaN(Number(s.value))) {
                    return fail(s.name + ': default must be a number.');
                }
            }
        }
        errorBox.textContent = '';
        return true;
    }
    function fail(msg) { errorBox.textContent = msg; return false; }

    document.getElementById('add').addEventListener('click', () => {
        // Suggest a free SettingN name.
        let n = 1;
        while (settings.some(s => s.name === 'Setting' + n)) { n++; }
        settings.push({ name: 'Setting' + n, type: 'System.String', scope: 'User', value: '' });
        render();
    });

    document.getElementById('save').addEventListener('click', () => {
        if (!validate()) { return; }
        vscode.postMessage({ type: 'save', settings });
    });

    render();
</script>
</body>
</html>`;
}
