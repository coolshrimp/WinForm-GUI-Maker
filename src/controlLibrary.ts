// UI Maker — Control Library (custom controls manager).
//
// One panel with two lists:
//   * Project Controls — classes the source scan found deriving from a
//                        control base (WinForms C#/VB) plus WPF UserControls.
//                        Read-only: they follow the source code.
//   * Custom Library   — controls registered by hand (from NuGet packages or
//                        referenced DLLs the scan cannot see), stored in the
//                        uimaker.customControls setting so the whole team
//                        shares them via .vscode/settings.json.
// Both lists feed the designer toolbox ("Project Controls" / "Custom
// Library" sections).

import * as vscode from 'vscode';
import * as path from 'path';
import { DotnetTools } from './dotnetTools';
import { scanProjectControls, libraryControls, CustomControl } from './customControls';
import { webviewNonce } from './webviewSecurity';

let panel: vscode.WebviewPanel | undefined;
let currentProjDir: string | undefined;

/** Open (or reveal) the Control Library panel. */
export async function openControlLibrary(dotnet: DotnetTools, explicitProject?: string): Promise<void> {
    const project = explicitProject ?? await dotnet.findProject();
    currentProjDir = project ? path.dirname(project) : undefined;

    if (panel) {
        panel.reveal();
        postState();
        return;
    }

    const createdPanel = vscode.window.createWebviewPanel(
        'uimaker.controlLibrary',
        'Control Library',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel = createdPanel;
    createdPanel.onDidDispose(() => {
        if (panel === createdPanel) { panel = undefined; }
    });
    createdPanel.webview.html = buildHtml();

    createdPanel.webview.onDidReceiveMessage(async (msg: any) => {
        if (panel !== createdPanel) { return; }
        try {
            switch (msg?.type) {
                case 'refresh':
                    postState();
                    break;
                case 'add': {
                    const entry = sanitizeEntry(msg.entry);
                    if (!entry) {
                        void createdPanel.webview.postMessage({
                            type: 'error',
                            message: 'Enter a valid full type name (e.g. MyControls.FancyButton).'
                        });
                        return;
                    }
                    const entries = rawEntries().filter(e =>
                        String((e as any)?.type ?? '').toLowerCase() !== String(entry.type).toLowerCase());
                    entries.push(entry);
                    await saveEntries(entries);
                    postState();
                    break;
                }
                case 'remove': {
                    const target = String(msg.qualified ?? '').toLowerCase();
                    await saveEntries(rawEntries().filter(e =>
                        String((e as any)?.type ?? '').toLowerCase() !== target));
                    postState();
                    break;
                }
                case 'openFile': {
                    if (!currentProjDir || typeof msg.file !== 'string') { return; }
                    const abs = path.resolve(currentProjDir, msg.file);
                    // Never follow a path that escapes the project folder.
                    if (!abs.toLowerCase().startsWith(currentProjDir.toLowerCase() + path.sep)) { return; }
                    await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
                    break;
                }
            }
        } catch (err) {
            void createdPanel.webview.postMessage({
                type: 'error',
                message: err instanceof Error ? err.message : String(err)
            });
        }
    });

    postState();
}

/** Current raw uimaker.customControls array (unvalidated). */
function rawEntries(): unknown[] {
    const raw = vscode.workspace.getConfiguration('uimaker').get<unknown[]>('customControls', []);
    return Array.isArray(raw) ? [...raw] : [];
}

async function saveEntries(entries: unknown[]): Promise<void> {
    const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('uimaker')
        .update('customControls', entries.length ? entries : undefined, target);
}

/** Validate one add-form submission into a settings entry. */
function sanitizeEntry(raw: unknown): Record<string, unknown> | undefined {
    const e = raw as Record<string, unknown>;
    const type = typeof e?.type === 'string' ? e.type.trim() : '';
    if (!/^[A-Za-z_]\w*(\.\w+)*$/.test(type) || type.length > 200) { return undefined; }
    const entry: Record<string, unknown> = { type };
    if (e.designer === 'wpf') { entry.designer = 'wpf'; }
    if (typeof e.base === 'string' && /^[A-Za-z_]\w*$/.test(e.base.trim())) { entry.base = e.base.trim(); }
    if (typeof e.assembly === 'string' && /^[\w.]+$/.test(e.assembly.trim())) { entry.assembly = e.assembly.trim(); }
    for (const key of ['width', 'height'] as const) {
        const n = Math.round(Number(e[key]));
        if (Number.isFinite(n) && n > 0 && n <= 4000) { entry[key] = n; }
    }
    return entry;
}

/** Send both lists to the webview. */
function postState(): void {
    if (!panel) { return; }
    let project: CustomControl[] = [];
    try { project = currentProjDir ? scanProjectControls(currentProjDir) : []; } catch { /* unreadable project */ }
    void panel.webview.postMessage({
        type: 'state',
        projectDir: currentProjDir ? path.basename(currentProjDir) : null,
        project,
        library: libraryControls()
    });
}

function buildHtml(): string {
    const nonce = webviewNonce();
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
        max-width: 1000px;
        margin: 0 auto;
        padding: 1rem 2rem 3rem;
        line-height: 1.45;
    }
    h1 { font-size: 1.4em; margin-bottom: .1em; }
    h2 { font-size: 1.05em; margin: 1.4em 0 .4em; }
    .sub { opacity: .75; font-size: .9em; margin-bottom: 1em; }
    .row {
        display: flex; gap: 12px; align-items: center;
        padding: 8px 6px; border-bottom: 1px solid var(--vscode-panel-border);
    }
    .row .glyph {
        width: 30px; height: 30px; flex: none; border-radius: 4px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        display: flex; align-items: center; justify-content: center;
        font-size: 1em;
    }
    .row .body { flex: 1; min-width: 0; }
    .row .name { font-weight: 600; }
    .row .meta { opacity: .7; font-size: .88em; }
    .row .file {
        opacity: .8; font-size: .85em; cursor: pointer;
        text-decoration: underline; background: none; border: none;
        color: var(--vscode-textLink-foreground); padding: 0;
    }
    button.act {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none; padding: 5px 12px; border-radius: 2px; cursor: pointer;
    }
    button.act:hover { background: var(--vscode-button-hoverBackground); }
    button.act.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    .note { opacity: .75; margin: .6em 0; font-size: .92em; }
    #status { min-height: 1.3em; margin: .4em 0; }
    #status.error { color: var(--vscode-errorForeground); }
    form {
        display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 80px 80px auto;
        gap: 8px; align-items: end; margin-top: .6em;
    }
    form label { display: flex; flex-direction: column; font-size: .85em; opacity: .9; gap: 3px; }
    form input, form select {
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 5px 8px; border-radius: 2px; font: inherit;
    }
    @media (max-width: 800px) { form { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<h1>Control Library</h1>
<div class="sub">Custom controls the designer toolbox offers, beyond the built-in .NET ones.</div>
<div id="status"></div>

<h2>Project Controls <button class="act secondary" id="refresh" title="Rescan the project source">↻ Refresh</button></h2>
<div class="note">Found automatically in <span id="proj">the working project</span>: classes deriving from a control base (UserControl, Button, Panel, …) and WPF UserControls. They appear in the toolbox's <b>Project Controls</b> section — nothing to configure.</div>
<div id="project-list"></div>

<h2>Custom Library</h2>
<div class="note">Controls from NuGet packages or referenced DLLs (e.g. Guna.UI2, ReaLTaiizor) that a source scan cannot see. Register the type once and it appears in the toolbox's <b>Custom Library</b> section for every form. Install the package itself with <b>NuGet Packages</b> first so the project builds. Saved to workspace settings (uimaker.customControls).</div>
<div id="library-list"></div>

<form id="add">
    <label>Full type name
        <input id="f-type" placeholder="Guna.UI2.WinForms.Guna2Button" spellcheck="false" required>
    </label>
    <label>Designer
        <select id="f-designer">
            <option value="winforms" selected>WinForms</option>
            <option value="wpf">WPF</option>
        </select>
    </label>
    <label>Looks like (base)
        <input id="f-base" placeholder="Button" spellcheck="false">
    </label>
    <label>Assembly (WPF)
        <input id="f-assembly" placeholder="MyControls" spellcheck="false">
    </label>
    <label>Width
        <input id="f-width" type="number" min="1" max="4000" placeholder="150">
    </label>
    <label>Height
        <input id="f-height" type="number" min="1" max="4000" placeholder="46">
    </label>
    <button class="act" type="submit">Add Control</button>
</form>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const statusEl = document.getElementById('status');

    function setStatus(text, isError) {
        statusEl.textContent = text || '';
        statusEl.className = isError ? 'error' : '';
    }

    function row({ glyph, name, meta, file, removeId }) {
        const div = document.createElement('div');
        div.className = 'row';
        const g = document.createElement('div');
        g.className = 'glyph';
        g.textContent = glyph;
        const body = document.createElement('div');
        body.className = 'body';
        const n = document.createElement('span');
        n.className = 'name';
        n.textContent = name;
        body.appendChild(n);
        if (meta) {
            const m = document.createElement('div');
            m.className = 'meta';
            m.textContent = meta;
            body.appendChild(m);
        }
        if (file) {
            const f = document.createElement('button');
            f.className = 'file';
            f.textContent = file;
            f.title = 'Open ' + file;
            f.addEventListener('click', () => vscode.postMessage({ type: 'openFile', file }));
            body.appendChild(f);
        }
        div.appendChild(g);
        div.appendChild(body);
        if (removeId) {
            const b = document.createElement('button');
            b.className = 'act secondary';
            b.textContent = 'Remove';
            b.addEventListener('click', () => vscode.postMessage({ type: 'remove', qualified: removeId }));
            div.appendChild(b);
        }
        return div;
    }

    function renderList(hostId, controls, removable, emptyText) {
        const host = document.getElementById(hostId);
        host.replaceChildren();
        if (!controls.length) {
            const empty = document.createElement('div');
            empty.className = 'note';
            empty.textContent = emptyText;
            host.appendChild(empty);
            return;
        }
        for (const c of controls) {
            host.appendChild(row({
                glyph: c.designer === 'wpf' ? '🪟' : '🧩',
                name: c.name,
                meta: c.qualified + ' · inherits ' + c.base + ' · ' + (c.designer === 'wpf' ? 'WPF' : 'WinForms'),
                file: removable ? null : c.file,
                removeId: removable ? c.qualified : null
            }));
        }
    }

    window.addEventListener('message', e => {
        const msg = e.data;
        if (msg.type === 'state') {
            setStatus('');
            document.getElementById('proj').textContent = msg.projectDir ? msg.projectDir : 'the working project (none found)';
            renderList('project-list', msg.project, false,
                'No custom controls found in the project source yet. Add a class deriving from UserControl (or any control base) and hit Refresh.');
            renderList('library-list', msg.library, true,
                'Nothing registered yet — add a control below.');
        } else if (msg.type === 'error') {
            setStatus(msg.message, true);
        }
    });

    document.getElementById('refresh').addEventListener('click', () => {
        setStatus('Rescanning…');
        vscode.postMessage({ type: 'refresh' });
    });

    document.getElementById('add').addEventListener('submit', e => {
        e.preventDefault();
        vscode.postMessage({
            type: 'add',
            entry: {
                type: document.getElementById('f-type').value,
                designer: document.getElementById('f-designer').value,
                base: document.getElementById('f-base').value,
                assembly: document.getElementById('f-assembly').value,
                width: document.getElementById('f-width').value,
                height: document.getElementById('f-height').value
            }
        });
        document.getElementById('f-type').value = '';
    });
</script>
</body>
</html>`;
}
