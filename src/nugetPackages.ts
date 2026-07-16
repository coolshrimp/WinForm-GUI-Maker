// UI Maker — NuGet package manager (the Visual Studio "Manage NuGet
// Packages" window).
//
// Browse / Installed / Updates tabs against nuget.org:
//   * Installed  — PackageReference entries read from the project file
//                  (packages.config for classic projects, read-only).
//   * Browse     — nuget.org search (the same azuresearch service VS uses).
//   * Updates    — installed packages whose latest stable is newer.
// Install / update / uninstall shell out to `dotnet add|remove package`,
// which edits the project file and restores in one step. Classic (non-SDK)
// projects cannot be modified by the dotnet CLI, so their actions are
// disabled with an explanatory note.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as https from 'https';
import { DotnetTools } from './dotnetTools';
import { readProjectInfo } from './projectInfo';

const SEARCH_URL = 'https://azuresearch-usnc.nuget.org/query';

interface InstalledPackage { id: string; version: string; }
interface SearchResult {
    id: string;
    version: string;
    description: string;
    authors: string;
    totalDownloads: number;
    verified: boolean;
}

let panel: vscode.WebviewPanel | undefined;
/** Project currently loaded in the (reused) panel; message handlers always
 *  read this so a project switch can never write to the previous project. */
let currentProject: string | undefined;
/** Serialize dotnet add/remove operations — parallel restores fight over
 *  the project file and the package cache. */
let opChain: Promise<void> = Promise.resolve();

/** Open the NuGet manager for the working project. */
export async function openNugetPackages(dotnet: DotnetTools): Promise<void> {
    const project = await dotnet.findProject();
    if (!project) { return; }

    currentProject = project;

    if (panel) {
        panel.title = `NuGet — ${path.basename(project)}`;
        panel.webview.html = buildHtml(project);
        panel.reveal();
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'uimaker.nuget',
        `NuGet — ${path.basename(project)}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => { panel = undefined; currentProject = undefined; });
    panel.webview.html = buildHtml(project);

    panel.webview.onDidReceiveMessage(async (msg: any) => {
        const proj = currentProject;
        if (!proj || !panel) { return; }
        try {
            switch (msg?.type) {
                case 'installed': {
                    void panel.webview.postMessage({
                        type: 'installedResult',
                        packages: readInstalled(proj),
                        canModify: readProjectInfo(proj)?.sdkStyle ?? false
                    });
                    break;
                }
                case 'search': {
                    const q = String(msg.q ?? '').slice(0, 200);
                    const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&take=25&prerelease=${msg.prerelease ? 'true' : 'false'}&semVerLevel=2.0.0`;
                    const data = await getJson(url);
                    void panel.webview.postMessage({ type: 'searchResult', items: toSearchResults(data), q });
                    break;
                }
                case 'updates': {
                    const installed = readInstalled(proj);
                    const items: Array<{ id: string; current: string; latest: string }> = [];
                    // One query per package, but capped and sequential-batched.
                    for (const p of installed.slice(0, 40)) {
                        const latest = await latestVersion(p.id).catch(() => undefined);
                        if (latest && compareVersions(latest, p.version) > 0) {
                            items.push({ id: p.id, current: p.version, latest });
                        }
                    }
                    void panel.webview.postMessage({ type: 'updatesResult', items, checked: installed.length });
                    break;
                }
                case 'install':
                    await runPackageOp(proj, ['add', proj, 'package', String(msg.id), ...(msg.version ? ['--version', String(msg.version)] : [])],
                        `Installing ${msg.id}${msg.version ? ` ${msg.version}` : ''}…`);
                    break;
                case 'uninstall':
                    await runPackageOp(proj, ['remove', proj, 'package', String(msg.id)], `Removing ${msg.id}…`);
                    break;
            }
        } catch (err) {
            void panel.webview.postMessage({
                type: 'error',
                message: err instanceof Error ? err.message : String(err)
            });
        }
    });
}

// ------------------------------------------------------------- package I/O

/** PackageReference list from the project (or packages.config for classic). */
function readInstalled(project: string): InstalledPackage[] {
    const out: InstalledPackage[] = [];
    try {
        const xml = fs.readFileSync(project, 'utf8');
        // Attribute form: <PackageReference Include="X" Version="1.2.3" />
        for (const m of xml.matchAll(/<PackageReference\s+[^>]*Include="([^"]+)"[^>]*?(?:\sVersion="([^"]*)")?[^>]*?(?:\/>|>)/g)) {
            let version = m[2];
            if (version === undefined) {
                // Child form: <PackageReference Include="X"><Version>1.2.3</Version>…
                const block = new RegExp(`<PackageReference\\s+[^>]*Include="${escapeRegExp(m[1])}"[^>]*>([\\s\\S]*?)</PackageReference>`).exec(xml);
                version = block ? /<Version>\s*([^<]*?)\s*<\/Version>/.exec(block[1])?.[1] ?? '' : '';
            }
            out.push({ id: m[1], version: version ?? '' });
        }
        // Classic projects keep packages in packages.config.
        if (!out.length) {
            const config = path.join(path.dirname(project), 'packages.config');
            if (fs.existsSync(config)) {
                const cfg = fs.readFileSync(config, 'utf8');
                for (const m of cfg.matchAll(/<package\s+id="([^"]+)"\s+version="([^"]+)"/g)) {
                    out.push({ id: m[1], version: m[2] });
                }
            }
        }
    } catch { /* unreadable project — empty list */ }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Run one dotnet add/remove operation, then push the refreshed list. */
function runPackageOp(project: string, args: string[], label: string): Promise<void> {
    const info = readProjectInfo(project);
    if (!info?.sdkStyle) {
        void panel?.webview.postMessage({
            type: 'error',
            message: 'Classic (.NET Framework, non-SDK) projects cannot be modified by the dotnet CLI. ' +
                'Run "UI Maker: Convert Project to SDK Style" (also offered in Project Properties) to enable package management here.'
        });
        return Promise.resolve();
    }
    void panel?.webview.postMessage({ type: 'busy', message: label });
    opChain = opChain.then(() => new Promise<void>(resolve => {
        cp.execFile('dotnet', args, { cwd: path.dirname(project), timeout: 180000 }, (err, stdout, stderr) => {
            if (currentProject === project && panel) {
                if (err) {
                    const detail = `${stdout ?? ''}\n${stderr ?? ''}`.trim().split(/\r?\n/)
                        .filter(l => /error|warn/i.test(l)).slice(0, 4).join('\n');
                    void panel.webview.postMessage({
                        type: 'error',
                        message: `${label.replace('…', '')} failed.${detail ? `\n${detail}` : ' See the terminal for details.'}`
                    });
                } else {
                    void panel.webview.postMessage({ type: 'done', message: `${label.replace('…', '')} ✓` });
                }
                void panel.webview.postMessage({
                    type: 'installedResult',
                    packages: readInstalled(project),
                    canModify: true
                });
            }
            resolve();
        });
    }));
    return opChain;
}

// ----------------------------------------------------------------- nuget.org

function getJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'Accept': 'application/json' }, timeout: 15000 }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`nuget.org returned HTTP ${res.statusCode} — check your internet connection.`));
                return;
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => { body += d; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { reject(new Error('nuget.org returned an unreadable response.')); }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('nuget.org did not respond — check your internet connection.')); });
        req.on('error', reject);
    });
}

function toSearchResults(data: any): SearchResult[] {
    if (!Array.isArray(data?.data)) { return []; }
    return data.data.map((d: any) => ({
        id: String(d.id ?? ''),
        version: String(d.version ?? ''),
        description: String(d.description ?? '').slice(0, 400),
        authors: Array.isArray(d.authors) ? d.authors.join(', ') : String(d.authors ?? ''),
        totalDownloads: Number(d.totalDownloads ?? 0),
        verified: !!d.verified
    })).filter((d: SearchResult) => d.id);
}

/** Latest stable version of one package id (undefined when not found). */
async function latestVersion(id: string): Promise<string | undefined> {
    const data = await getJson(`${SEARCH_URL}?q=packageid:${encodeURIComponent(id)}&take=1&prerelease=false&semVerLevel=2.0.0`);
    const hit = data?.data?.[0];
    return hit && String(hit.id).toLowerCase() === id.toLowerCase() ? String(hit.version) : undefined;
}

/** NuGet-style version compare: dotted numerics, then prerelease tags. */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) => {
        const [nums, pre] = v.split(/-(.+)/);
        return { nums: nums.split('.').map(n => parseInt(n, 10) || 0), pre: pre ?? '' };
    };
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
        const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
        if (d !== 0) { return d; }
    }
    // Release > prerelease; otherwise compare tags lexically.
    if (!pa.pre && pb.pre) { return 1; }
    if (pa.pre && !pb.pre) { return -1; }
    return pa.pre.localeCompare(pb.pre);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------------------ webview

function buildHtml(project: string): string {
    const nonce = Math.random().toString(36).slice(2);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
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
        line-height: 1.45;
    }
    h1 { font-size: 1.4em; margin-bottom: .1em; }
    .project { opacity: .75; font-size: .9em; margin-bottom: 1em; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: .8em; }
    .tabs button {
        background: none; border: none; color: var(--vscode-foreground);
        padding: 8px 14px; cursor: pointer; font-size: 1em;
        border-bottom: 2px solid transparent; opacity: .8;
    }
    .tabs button.active {
        border-bottom-color: var(--vscode-focusBorder, #007acc);
        opacity: 1; font-weight: 600;
    }
    .searchrow { display: flex; gap: 8px; margin: .6em 0 1em; align-items: center; }
    .searchrow input[type=text] {
        flex: 1; max-width: 420px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 6px 10px; border-radius: 2px; font: inherit;
    }
    .pkg {
        display: flex; gap: 12px; align-items: flex-start;
        padding: 10px 6px; border-bottom: 1px solid var(--vscode-panel-border);
    }
    .pkg .logo {
        width: 34px; height: 34px; flex: none; border-radius: 4px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: .8em;
    }
    .pkg .body { flex: 1; min-width: 0; }
    .pkg .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .pkg .id { font-weight: 600; }
    .pkg .meta { opacity: .7; font-size: .88em; }
    .pkg .desc { opacity: .85; font-size: .92em; margin-top: 2px;
        overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .pkg .actions { flex: none; display: flex; gap: 6px; align-items: center; }
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
    button.act[disabled] { opacity: .5; cursor: default; }
    .note { opacity: .8; margin: .8em 0; }
    #status { min-height: 1.4em; margin: .5em 0; }
    #status.error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
    .check { font-size: .92em; opacity: .9; user-select: none; }
    .badge { font-size: .8em; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 0 7px; opacity: .8; }
</style>
</head>
<body>
<h1>NuGet Packages</h1>
<div class="project">Project: <code>${esc(path.basename(project))}</code> · packages install with <code>dotnet add package</code> (edits the project file and restores)</div>

<div class="tabs">
    <button id="tab-browse">Browse</button>
    <button id="tab-installed" class="active">Installed</button>
    <button id="tab-updates">Updates</button>
</div>

<div class="searchrow" id="browse-controls" style="display:none">
    <input type="text" id="q" placeholder="Search nuget.org  (e.g. Newtonsoft.Json, serial port, sqlite)">
    <label class="check"><input type="checkbox" id="prerelease"> Include prerelease</label>
    <button class="act" id="go">Search</button>
</div>

<div id="status"></div>
<div id="list"></div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let tab = 'installed';
    let installed = [];          // [{id, version}]
    let canModify = false;
    let lastSearch = [];
    let lastUpdates = [];
    let busy = false;

    const listEl = document.getElementById('list');
    const statusEl = document.getElementById('status');
    const tabs = { browse: document.getElementById('tab-browse'),
                   installed: document.getElementById('tab-installed'),
                   updates: document.getElementById('tab-updates') };

    function setStatus(text, isError) {
        statusEl.textContent = text || '';
        statusEl.className = isError ? 'error' : '';
    }

    function setTab(t) {
        tab = t;
        for (const k of Object.keys(tabs)) { tabs[k].classList.toggle('active', k === t); }
        document.getElementById('browse-controls').style.display = t === 'browse' ? 'flex' : 'none';
        setStatus('');
        if (t === 'installed') { vscode.postMessage({ type: 'installed' }); renderInstalled(); }
        if (t === 'browse') { renderSearch(); document.getElementById('q').focus(); }
        if (t === 'updates') { setStatus('Checking nuget.org for newer versions…'); listEl.innerHTML = ''; vscode.postMessage({ type: 'updates' }); }
    }
    tabs.browse.addEventListener('click', () => setTab('browse'));
    tabs.installed.addEventListener('click', () => setTab('installed'));
    tabs.updates.addEventListener('click', () => setTab('updates'));

    function fmtDownloads(n) {
        if (n >= 1e9) { return (n / 1e9).toFixed(1) + 'B'; }
        if (n >= 1e6) { return (n / 1e6).toFixed(1) + 'M'; }
        if (n >= 1e3) { return (n / 1e3).toFixed(0) + 'K'; }
        return String(n);
    }

    function pkgRow({ id, title, meta, desc, buttons }) {
        const row = document.createElement('div');
        row.className = 'pkg';
        const logo = document.createElement('div');
        logo.className = 'logo';
        logo.textContent = '.NET';
        const body = document.createElement('div');
        body.className = 'body';
        const head = document.createElement('div');
        head.className = 'head';
        const idEl = document.createElement('span');
        idEl.className = 'id';
        idEl.textContent = title ?? id;
        head.appendChild(idEl);
        if (meta) {
            const m = document.createElement('span');
            m.className = 'meta';
            m.textContent = meta;
            head.appendChild(m);
        }
        body.appendChild(head);
        if (desc) {
            const d = document.createElement('div');
            d.className = 'desc';
            d.textContent = desc;
            body.appendChild(d);
        }
        const actions = document.createElement('div');
        actions.className = 'actions';
        for (const b of buttons ?? []) { actions.appendChild(b); }
        row.appendChild(logo);
        row.appendChild(body);
        row.appendChild(actions);
        return row;
    }

    function actButton(text, onClick, secondary) {
        const b = document.createElement('button');
        b.className = 'act' + (secondary ? ' secondary' : '');
        b.textContent = text;
        b.disabled = busy || !canModify;
        b.addEventListener('click', onClick);
        return b;
    }

    function renderInstalled() {
        if (tab !== 'installed') { return; }
        listEl.innerHTML = '';
        if (!installed.length) {
            setStatus('No NuGet packages installed in this project. Use Browse to find some.');
            return;
        }
        setStatus(canModify ? '' :
            'This is a classic (.NET Framework, non-SDK) project — the list is read-only here. Convert it to SDK style (see Project Properties) to install and update packages.');
        for (const p of installed) {
            listEl.appendChild(pkgRow({
                id: p.id,
                meta: p.version ? 'v' + p.version : '',
                buttons: canModify ? [actButton('Uninstall', () => {
                    busy = true;
                    vscode.postMessage({ type: 'uninstall', id: p.id });
                    renderCurrent();
                }, true)] : []
            }));
        }
    }

    function renderSearch() {
        if (tab !== 'browse') { return; }
        listEl.innerHTML = '';
        for (const r of lastSearch) {
            const isInstalled = installed.some(p => p.id.toLowerCase() === r.id.toLowerCase());
            const buttons = [];
            if (isInstalled) {
                const tag = document.createElement('span');
                tag.className = 'badge';
                tag.textContent = 'installed';
                buttons.push(tag);
            } else {
                buttons.push(actButton('Install', () => {
                    busy = true;
                    vscode.postMessage({ type: 'install', id: r.id, version: r.version });
                    renderCurrent();
                }));
            }
            listEl.appendChild(pkgRow({
                id: r.id,
                meta: 'v' + r.version + (r.authors ? ' · by ' + r.authors : '') +
                      (r.totalDownloads ? ' · ' + fmtDownloads(r.totalDownloads) + ' downloads' : ''),
                desc: r.description,
                buttons
            }));
        }
    }

    function renderUpdates() {
        if (tab !== 'updates') { return; }
        listEl.innerHTML = '';
        if (!lastUpdates.length) {
            setStatus('Everything is up to date. ✓');
            return;
        }
        setStatus(lastUpdates.length + ' update' + (lastUpdates.length === 1 ? '' : 's') + ' available');
        for (const u of lastUpdates) {
            listEl.appendChild(pkgRow({
                id: u.id,
                meta: 'v' + u.current + '  →  v' + u.latest,
                buttons: [actButton('Update', () => {
                    busy = true;
                    vscode.postMessage({ type: 'install', id: u.id, version: u.latest });
                    renderCurrent();
                })]
            }));
        }
    }

    function renderCurrent() {
        if (tab === 'installed') { renderInstalled(); }
        else if (tab === 'browse') { renderSearch(); }
        else { renderUpdates(); }
    }

    function doSearch() {
        const q = document.getElementById('q').value.trim();
        setStatus('Searching nuget.org…');
        vscode.postMessage({ type: 'search', q, prerelease: document.getElementById('prerelease').checked });
    }
    document.getElementById('go').addEventListener('click', doSearch);
    document.getElementById('q').addEventListener('keydown', e => { if (e.key === 'Enter') { doSearch(); } });

    window.addEventListener('message', e => {
        const msg = e.data;
        if (msg.type === 'installedResult') {
            installed = msg.packages;
            canModify = msg.canModify;
            renderCurrent();
        } else if (msg.type === 'searchResult') {
            lastSearch = msg.items;
            if (tab === 'browse') {
                setStatus(msg.items.length ? '' : 'No packages matched "' + msg.q + '".');
                renderSearch();
            }
        } else if (msg.type === 'updatesResult') {
            lastUpdates = msg.items;
            renderUpdates();
        } else if (msg.type === 'busy') {
            busy = true;
            setStatus(msg.message);
            renderCurrent();
        } else if (msg.type === 'done') {
            busy = false;
            setStatus(msg.message);
            renderCurrent();
        } else if (msg.type === 'error') {
            busy = false;
            setStatus(msg.message, true);
            renderCurrent();
        }
    });

    // Default tab shows the currently installed packages.
    vscode.postMessage({ type: 'installed' });
</script>
</body>
</html>`;
}
