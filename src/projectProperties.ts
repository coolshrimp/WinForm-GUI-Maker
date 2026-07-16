// UI Maker — Project Properties page (the Visual Studio "Application" tab).
//
// Shows and edits the MSBuild properties Visual Studio exposes under
// Project → Properties: output type, target framework, assembly name,
// default namespace, startup object, application icon, manifest, and the
// assembly/package info (version, company, description, …).
//
// Editing writes the properties straight into the .csproj/.vbproj:
//   * an existing <Prop>value</Prop> is updated in place,
//   * a new property is inserted into the first unconditional <PropertyGroup>,
//   * clearing a field removes the property (falling back to SDK defaults).
// Both SDK-style and classic projects are supported — the page only offers
// what applies to the loaded project style.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DotnetTools } from './dotnetTools';
import { webviewNonce } from './webviewSecurity';
import { replaceFileAtomically } from './atomicFile';
import { readProjectInfo, installedSdkMajors, isLtsDotnet, frameworkLabel } from './projectInfo';
import { getMsbuildProperty, setMsbuildProperty } from './msbuildXml';

export { setMsbuildProperty } from './msbuildXml';

/** One editable MSBuild property shown on the page. */
interface PropField {
    /** MSBuild property tag name, e.g. "AssemblyName". */
    name: string;
    label: string;
    description: string;
    /** Current value ('' when unset). */
    value: string;
    /** 'text' | 'select'. */
    kind: 'text' | 'select';
    /** Placeholder for text fields (usually the effective default). */
    placeholder?: string;
    /** Options for selects: [value, label]. '' means "not set / default". */
    options?: Array<[string, string]>;
    /** Show a Browse… button that picks a file with these extensions. */
    browse?: string[];
    /** Section header the field renders under. */
    section: string;
}

let panel: vscode.WebviewPanel | undefined;
/** Project currently loaded in the (reused) panel — the save handler and
 *  message listeners always read this, never a captured stale value. */
let currentProject: string | undefined;
/** Invalidates asynchronous renders when the user switches projects, closes
 *  the panel, or starts a newer reload before an older one completes. */
let renderGeneration = 0;

/** Open the Project Properties editor for the working project. */
export async function openProjectProperties(dotnet: DotnetTools): Promise<void> {
    const project = await dotnet.findProject();
    if (!project) { return; }

    const generation = ++renderGeneration;
    let html: string;
    try {
        html = await buildHtml(project);
    } catch (err) {
        if (generation === renderGeneration) {
            vscode.window.showErrorMessage(`UI Maker: could not load the project properties — ${err}`);
        }
        return;
    }
    if (generation !== renderGeneration) { return; }

    if (panel) {
        const targetPanel = panel;
        currentProject = project;
        targetPanel.title = `${path.basename(project)} — Properties`;
        targetPanel.webview.html = html;
        targetPanel.reveal();
        return;
    }

    const createdPanel = vscode.window.createWebviewPanel(
        'uimaker.projectProperties',
        `${path.basename(project)} — Properties`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );
    panel = createdPanel;
    currentProject = project;
    createdPanel.onDidDispose(() => {
        if (panel === createdPanel) {
            panel = undefined;
            currentProject = undefined;
            renderGeneration++;
        }
    });
    createdPanel.webview.html = html;

    createdPanel.webview.onDidReceiveMessage(async (msg: { type: string; values?: Record<string, string>; field?: string; exts?: string[] }) => {
        const proj = currentProject;
        if (!proj || panel !== createdPanel) { return; }
        if (msg.type === 'save' && msg.values) {
            try {
                saveProperties(proj, msg.values);
                vscode.window.showInformationMessage(`UI Maker: saved ${path.basename(proj)} properties.`);
            } catch (err) {
                vscode.window.showErrorMessage(`UI Maker: could not save the project file — ${err}`);
                return;
            }
            const reloadGeneration = ++renderGeneration;
            try {
                const refreshed = await buildHtml(proj);
                if (reloadGeneration === renderGeneration && panel === createdPanel && currentProject === proj) {
                    createdPanel.webview.html = refreshed;
                }
            } catch (err) {
                if (reloadGeneration === renderGeneration && panel === createdPanel && currentProject === proj) {
                    vscode.window.showWarningMessage(`UI Maker: properties were saved, but the page could not reload — ${err}`);
                }
            }
        } else if (msg.type === 'browse' && msg.field) {
            const exts = msg.exts?.length ? msg.exts : ['*'];
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Select',
                defaultUri: vscode.Uri.file(path.dirname(proj)),
                filters: { 'Files': exts }
            });
            if (picked?.length && panel === createdPanel && currentProject === proj) {
                // VS stores these as project-relative paths.
                const rel = path.relative(path.dirname(proj), picked[0].fsPath);
                void createdPanel.webview.postMessage({ type: 'picked', field: msg.field, value: rel });
            }
        } else if (msg.type === 'openAppSettings') {
            void vscode.commands.executeCommand('uimaker.appSettings', proj);
        } else if (msg.type === 'openNuget') {
            void vscode.commands.executeCommand('uimaker.nugetPackages', proj);
        } else if (msg.type === 'openProjectFile') {
            await vscode.window.showTextDocument(vscode.Uri.file(proj));
        } else if (msg.type === 'convertToSdk') {
            const convertGeneration = ++renderGeneration;
            await vscode.commands.executeCommand('uimaker.convertToSdk', proj);
            // Rebuild the page — after a conversion the project is SDK-style.
            if (convertGeneration !== renderGeneration || panel !== createdPanel || currentProject !== proj) { return; }
            try {
                const refreshed = await buildHtml(proj);
                if (convertGeneration === renderGeneration && panel === createdPanel && currentProject === proj) {
                    createdPanel.webview.html = refreshed;
                }
            } catch (err) {
                if (convertGeneration === renderGeneration && panel === createdPanel && currentProject === proj) {
                    vscode.window.showWarningMessage(`UI Maker: conversion finished, but the page could not reload — ${err}`);
                }
            }
        }
    });
}

// -------------------------------------------------------------- field model

/** Read one MSBuild property value out of project XML ('' when absent). */
function propValue(xml: string, name: string): string {
    return getMsbuildProperty(xml, name);
}

async function buildFields(project: string): Promise<{ fields: PropField[]; sdkStyle: boolean }> {
    const xml = fs.readFileSync(project, 'utf8');
    const info = readProjectInfo(project);
    const sdkStyle = info?.sdkStyle ?? true;
    const baseName = path.basename(project).replace(/\.(cs|vb)proj$/i, '');
    const multiTarget = sdkStyle && /<TargetFrameworks\b/.test(xml);
    const targetProperty = sdkStyle
        ? (multiTarget ? 'TargetFrameworks' : 'TargetFramework')
        : 'TargetFrameworkVersion';
    const targetValue = propValue(xml, targetProperty);

    // Target-framework choices: current value + every installed SDK. Desktop
    // UI frameworks need the -windows TFM on modern .NET.
    const needsWindows = !!(info?.useWPF || info?.useWinForms);
    const tfmOptions: Array<[string, string]> = [];
    if (sdkStyle && !multiTarget) {
        // SDK discovery launches `dotnet`; keep property viewing/editing
        // available in Restricted Mode without starting workspace processes.
        const majors = vscode.workspace.isTrusted ? await installedSdkMajors() : [];
        const seen = new Set<string>();
        const push = (tfm: string) => {
            if (tfm && !seen.has(tfm)) {
                seen.add(tfm);
                tfmOptions.push([tfm, `${frameworkLabel(tfm)}${/^net(\d+)\.0/.test(tfm) && isLtsDotnet(Number(/^net(\d+)\./.exec(tfm)![1])) ? ' (LTS)' : ''}`]);
            }
        };
        push(targetValue);
        for (const major of majors.filter(m => m >= 5)) {
            push(needsWindows ? `net${major}.0-windows` : `net${major}.0`);
        }
    } else if (!sdkStyle) {
        for (const v of [targetValue, 'v4.8.1', 'v4.8', 'v4.7.2', 'v4.7', 'v4.6.2']) {
            if (v && !tfmOptions.some(o => o[0] === v)) { tfmOptions.push([v, frameworkLabel(v)]); }
        }
    }

    const targetField: PropField = multiTarget
        ? {
            name: targetProperty,
            label: 'Target frameworks',
            description: 'The semicolon-separated .NET target frameworks this project builds for.',
            value: targetValue,
            kind: 'text',
            placeholder: 'net8.0-windows;net10.0-windows',
            section: 'Application'
        }
        : {
            name: targetProperty,
            label: 'Target framework',
            description: 'The version of .NET that the application targets.',
            value: targetValue,
            kind: 'select',
            section: 'Application',
            options: tfmOptions
        };

    const fields: PropField[] = [
        {
            name: 'OutputType', label: 'Output type',
            description: 'The type of application to build.',
            value: propValue(xml, 'OutputType'), kind: 'select', section: 'Application',
            options: [
                ['WinExe', 'Windows Application'],
                ['Exe', 'Console Application'],
                ['Library', 'Class Library'],
                ...(propValue(xml, 'OutputType') === '' ? [['', '(default)'] as [string, string]] : [])
            ]
        },
        targetField,
        {
            name: 'AssemblyName', label: 'Assembly name',
            description: 'The name of the output file that will hold the assembly manifest (your .exe name).',
            value: propValue(xml, 'AssemblyName'), kind: 'text', placeholder: baseName, section: 'Application'
        },
        {
            name: 'RootNamespace', label: 'Default namespace',
            description: 'The base namespace for files added to the project.',
            value: propValue(xml, 'RootNamespace'), kind: 'text', placeholder: baseName, section: 'Application'
        },
        {
            name: 'StartupObject', label: 'Startup object',
            description: 'The entry point called when the application loads (e.g. MyApp.Program). Leave empty to let the compiler find Main automatically.',
            value: propValue(xml, 'StartupObject'), kind: 'text', placeholder: '(Not set)', section: 'Application'
        },
        {
            name: 'ApplicationIcon', label: 'Icon',
            description: 'The .ico file used as your program icon (shown in Explorer and the taskbar).',
            value: propValue(xml, 'ApplicationIcon'), kind: 'text', placeholder: '(Default Icon)',
            browse: ['ico'], section: 'Win32 Resources'
        },
        {
            name: 'ApplicationManifest', label: 'Manifest',
            description: 'A custom app.manifest controls UAC elevation, DPI awareness, and Windows compatibility. Leave empty for the default manifest.',
            value: propValue(xml, 'ApplicationManifest'), kind: 'text', placeholder: '(Default manifest)',
            browse: ['manifest'], section: 'Win32 Resources'
        }
    ];

    if (sdkStyle) {
        fields.push(
            {
                name: 'Version', label: 'Version',
                description: 'The application version (also used for the file and product version unless set separately).',
                value: propValue(xml, 'Version'), kind: 'text', placeholder: '1.0.0', section: 'Package'
            },
            {
                name: 'Authors', label: 'Authors',
                description: 'Who made this app (shown in the file details).',
                value: propValue(xml, 'Authors'), kind: 'text', placeholder: baseName, section: 'Package'
            },
            {
                name: 'Company', label: 'Company',
                description: 'The company name baked into the assembly info.',
                value: propValue(xml, 'Company'), kind: 'text', placeholder: '(Authors)', section: 'Package'
            },
            {
                name: 'Product', label: 'Product',
                description: 'The product name shown in the .exe file properties.',
                value: propValue(xml, 'Product'), kind: 'text', placeholder: baseName, section: 'Package'
            },
            {
                name: 'Description', label: 'Description',
                description: 'A short description of the application.',
                value: propValue(xml, 'Description'), kind: 'text', placeholder: '', section: 'Package'
            },
            {
                name: 'Copyright', label: 'Copyright',
                description: 'The copyright notice baked into the assembly info.',
                value: propValue(xml, 'Copyright'), kind: 'text', placeholder: '', section: 'Package'
            }
        );
    }

    return { fields, sdkStyle };
}

// ----------------------------------------------------------------- file I/O

function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function saveProperties(project: string, values: Record<string, string>): void {
    let xml = fs.readFileSync(project, 'utf8');
    const before = xml;
    const targetProperty = /<TargetFrameworks\b/.test(xml)
        ? 'TargetFrameworks'
        : /<TargetFramework\b/.test(xml)
            ? 'TargetFramework'
            : 'TargetFrameworkVersion';
    const allowed = new Set([
        'OutputType', 'TargetFramework', 'TargetFrameworks', 'TargetFrameworkVersion',
        'AssemblyName', 'RootNamespace', 'StartupObject', 'ApplicationIcon',
        'ApplicationManifest', 'Version', 'Authors', 'Company', 'Product',
        'Description', 'Copyright'
    ]);
    for (const [name, value] of Object.entries(values)) {
        if (!allowed.has(name) || typeof value !== 'string' || value.length > 4096) { continue; }
        if (/^TargetFramework(?:s|Version)?$/.test(name) && name !== targetProperty) { continue; }
        xml = setMsbuildProperty(xml, name, value.trim());
    }
    if (xml !== before) {
        replaceFileAtomically(project, xml);
    }
}

// ------------------------------------------------------------------ webview

async function buildHtml(project: string): Promise<string> {
    const { fields, sdkStyle } = await buildFields(project);
    const info = readProjectInfo(project);
    const nonce = webviewNonce();
    const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
    const ui = info?.useWPF && info?.useWinForms ? 'WPF + Windows Forms'
        : info?.useWPF ? 'WPF' : info?.useWinForms ? 'Windows Forms' : 'None / Console';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        max-width: 900px;
        margin: 0 auto;
        padding: 1rem 2rem 4rem;
        line-height: 1.5;
    }
    h1 { font-size: 1.5em; margin-bottom: .2em; }
    h2 {
        font-size: 1.05em;
        margin: 2em 0 .4em;
        padding-bottom: .3em;
        border-bottom: 1px solid var(--vscode-panel-border);
    }
    .project { opacity: .75; font-size: .9em; margin-bottom: 1.2em; }
    .field { margin: 1.1em 0; padding-left: 12px; border-left: 3px solid var(--vscode-panel-border); }
    .field label { display: block; font-weight: 600; margin-bottom: 2px; }
    .field .desc { opacity: .8; font-size: .9em; margin-bottom: 6px; }
    .row { display: flex; gap: 8px; max-width: 480px; }
    input, select {
        flex: 1;
        box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 5px 8px;
        border-radius: 2px;
        font-family: inherit;
        font-size: inherit;
    }
    button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 14px;
        border-radius: 2px;
        cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    .toolbar {
        position: sticky; top: 0; z-index: 5;
        background: var(--vscode-editor-background);
        padding: .6em 0; margin-bottom: .5em;
        border-bottom: 1px solid var(--vscode-panel-border);
        display: flex; gap: 8px; align-items: center;
    }
    .dirty { opacity: .85; font-size: .9em; display: none; }
    .links { margin-top: 2.5em; opacity: .9; font-size: .92em; }
    .links button { margin-right: 8px; }
    .static { opacity: .85; }
    .convert-banner {
        border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
        border-radius: 4px;
        padding: 10px 14px;
        margin: 0 0 1.2em;
        background: var(--vscode-inputValidation-warningBackground, transparent);
    }
</style>
</head>
<body>
<h1>Project Properties</h1>
<div class="project">Project: <code>${xmlEscape(path.basename(project))}</code>
 · ${sdkStyle ? 'SDK-style project' : 'classic (.NET Framework) project'} · UI framework: ${xmlEscape(ui)}</div>
${sdkStyle ? '' : `<div class="convert-banner">
    <strong>Old project format detected.</strong>
    This classic .NET Framework project format is what causes the
    “project file is in unsupported format” warning from C# Dev Kit, and the dotnet CLI
    cannot manage its NuGet packages. Converting keeps the same target framework and
    a <code>.legacy.bak</code> backup of the original file.
    <div style="margin-top:8px"><button id="convert-sdk">⬆ Convert to SDK style…</button></div>
</div>`}

<div class="toolbar">
    <button id="save">Save</button>
    <button id="reload" class="secondary">Discard Changes</button>
    <span class="dirty" id="dirty">● unsaved changes</span>
</div>

<div id="form"></div>

<div class="links">
    <h2>Related</h2>
    <button id="open-settings" class="secondary">App Settings (values your app remembers)</button>
    <button id="open-nuget" class="secondary">NuGet Packages</button>
    <button id="open-csproj" class="secondary">Open ${xmlEscape(path.basename(project))} as text</button>
</div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const FIELDS = ${json(fields)};
    const original = {};
    const inputs = {};

    const form = document.getElementById('form');
    const dirtyEl = document.getElementById('dirty');
    let section = '';
    for (const f of FIELDS) {
        if (f.section !== section) {
            section = f.section;
            const h = document.createElement('h2');
            h.textContent = section;
            form.appendChild(h);
        }
        const wrap = document.createElement('div');
        wrap.className = 'field';
        const label = document.createElement('label');
        label.textContent = f.label;
        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = f.description;
        const row = document.createElement('div');
        row.className = 'row';

        let input;
        if (f.kind === 'select') {
            input = document.createElement('select');
            for (const [value, text] of (f.options ?? [])) {
                const o = document.createElement('option');
                o.value = value; o.textContent = text;
                if (value === f.value) { o.selected = true; }
                input.appendChild(o);
            }
        } else {
            input = document.createElement('input');
            input.value = f.value;
            input.placeholder = f.placeholder ?? '';
        }
        input.addEventListener('input', markDirty);
        input.addEventListener('change', markDirty);
        inputs[f.name] = input;
        original[f.name] = f.value;
        row.appendChild(input);

        if (f.browse) {
            const b = document.createElement('button');
            b.className = 'secondary';
            b.textContent = 'Browse…';
            b.addEventListener('click', () => vscode.postMessage({ type: 'browse', field: f.name, exts: f.browse }));
            row.appendChild(b);
        }

        wrap.appendChild(label);
        wrap.appendChild(desc);
        wrap.appendChild(row);
        form.appendChild(wrap);
    }

    function isDirty() {
        return Object.keys(inputs).some(k => inputs[k].value !== original[k]);
    }
    function markDirty() {
        dirtyEl.style.display = isDirty() ? 'inline' : 'none';
    }

    document.getElementById('save').addEventListener('click', () => {
        const values = {};
        for (const k of Object.keys(inputs)) {
            if (inputs[k].value !== original[k]) { values[k] = inputs[k].value; }
        }
        if (Object.keys(values).length) { vscode.postMessage({ type: 'save', values }); }
    });
    document.getElementById('reload').addEventListener('click', () => {
        for (const k of Object.keys(inputs)) { inputs[k].value = original[k]; }
        markDirty();
    });
    const convertBtn = document.getElementById('convert-sdk');
    if (convertBtn) { convertBtn.addEventListener('click', () => vscode.postMessage({ type: 'convertToSdk' })); }
    document.getElementById('open-settings').addEventListener('click', () => vscode.postMessage({ type: 'openAppSettings' }));
    document.getElementById('open-nuget').addEventListener('click', () => vscode.postMessage({ type: 'openNuget' }));
    document.getElementById('open-csproj').addEventListener('click', () => vscode.postMessage({ type: 'openProjectFile' }));

    window.addEventListener('message', e => {
        const msg = e.data;
        if (msg.type === 'picked' && inputs[msg.field]) {
            inputs[msg.field].value = msg.value;
            markDirty();
        }
    });
</script>
</body>
</html>`;
}
