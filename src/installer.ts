// UI Maker — "Create an Installer" (Inno Setup) for the working project.
//
// Opens a customization page, generates an Inno Setup script (.iss) from the
// project's publish output, and compiles it with ISCC.exe when Inno Setup is
// installed (the .iss always works standalone otherwise).
//
// Settings memory (user request): by default ONE uniform template is shared
// across every project ("same installer look for everything I ship"). The
// `uimaker.installer.settingsScope` setting flips to per-project storage for
// multi-brand work. The installer output folder defaults to
// <project>\Installer and both it and every field are remembered.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { DotnetTools } from './dotnetTools';
import { webviewNonce } from './webviewSecurity';

export interface InstallerSettings {
    appName: string;
    appVersion: string;
    publisher: string;
    publisherUrl: string;
    /** Inno AppId GUID — stable per app so upgrades replace, not duplicate. */
    appId: string;
    iconPath: string;
    licensePath: string;
    /** '' = <project>\Installer */
    outputDir: string;
    outputBase: string;
    /** '' = auto-detect the newest publish folder under bin\ */
    sourceDir: string;
    desktopIcon: boolean;
    launchAfter: boolean;
    perUser: boolean;
    arch: 'x64' | 'x86';
}

const TEMPLATE_KEY = 'uimaker.installer.template';
const PER_PROJECT_KEY = 'uimaker.installer.byProject';

let extContext: vscode.ExtensionContext | undefined;
let panel: vscode.WebviewPanel | undefined;
let currentProject: string | undefined;

export function initInstaller(context: vscode.ExtensionContext): void {
    extContext = context;
}

function newGuid(): string {
    const hex = () => Math.floor(Math.random() * 16).toString(16).toUpperCase();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c =>
        c === 'x' ? hex() : ((Math.floor(Math.random() * 4) + 8).toString(16).toUpperCase()));
}

function usePerProject(): boolean {
    return vscode.workspace.getConfiguration('uimaker').get<string>('installer.settingsScope', 'uniform') === 'perProject';
}

/** Defaults derived from the project file, overlaid with remembered settings. */
function loadSettings(project: string): InstallerSettings {
    const projDir = path.dirname(project);
    let xml = '';
    try { xml = fs.readFileSync(project, 'utf8'); } catch { /* defaults */ }
    const prop = (n: string) => new RegExp(`<${n}>\\s*([^<]+?)\\s*</${n}>`, 'i').exec(xml)?.[1] ?? '';
    const base = path.basename(projDir);
    const defaults: InstallerSettings = {
        appName: prop('AssemblyName') || base,
        appVersion: prop('Version') || prop('AssemblyVersion')?.split('.').slice(0, 3).join('.') || '1.0.0',
        publisher: prop('Authors') || prop('Company') || '',
        publisherUrl: '',
        appId: newGuid(),
        iconPath: prop('ApplicationIcon') ? path.join(projDir, prop('ApplicationIcon')) : '',
        licensePath: '',
        outputDir: '',
        outputBase: `${(prop('AssemblyName') || base).replace(/[^\w.-]/g, '')}-Setup`,
        sourceDir: '',
        desktopIcon: true,
        launchAfter: true,
        perUser: false,
        arch: 'x64'
    };
    const remembered = usePerProject()
        ? (extContext?.globalState.get<Record<string, Partial<InstallerSettings>>>(PER_PROJECT_KEY) ?? {})[project.toLowerCase()]
        : extContext?.globalState.get<Partial<InstallerSettings>>(TEMPLATE_KEY);
    const merged = { ...defaults, ...(remembered ?? {}) };
    // App name/version always track the project — remembering another
    // project's identity under the uniform template would be wrong.
    if (!usePerProject()) {
        merged.appName = defaults.appName;
        merged.appVersion = defaults.appVersion;
        merged.iconPath = remembered?.iconPath ? merged.iconPath : defaults.iconPath;
        merged.outputBase = defaults.outputBase;
        merged.appId = ((extContext?.globalState.get<Record<string, string>>('uimaker.installer.appIds') ?? {})[project.toLowerCase()]) ?? defaults.appId;
    }
    return merged;
}

function saveSettings(project: string, s: InstallerSettings): void {
    if (!extContext) { return; }
    if (usePerProject()) {
        const map = extContext.globalState.get<Record<string, Partial<InstallerSettings>>>(PER_PROJECT_KEY) ?? {};
        map[project.toLowerCase()] = s;
        void extContext.globalState.update(PER_PROJECT_KEY, map);
    } else {
        // Uniform template: remember the branding/behavior, not the identity.
        const { appName, appVersion, outputBase, appId, ...template } = s;
        void extContext.globalState.update(TEMPLATE_KEY, template);
        const ids = extContext.globalState.get<Record<string, string>>('uimaker.installer.appIds') ?? {};
        ids[project.toLowerCase()] = appId;
        void extContext.globalState.update('uimaker.installer.appIds', ids);
    }
}

/** Newest folder literally named "publish" under bin/ (any depth ≤ 6). */
function detectPublishDir(projDir: string): string | undefined {
    const bin = path.join(projDir, 'bin');
    if (!fs.existsSync(bin)) { return undefined; }
    let best: { dir: string; mtime: number } | undefined;
    const walk = (dir: string, depth: number) => {
        if (depth > 6) { return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (!e.isDirectory()) { continue; }
            const full = path.join(dir, e.name);
            if (e.name.toLowerCase() === 'publish') {
                const mtime = fs.statSync(full).mtimeMs;
                if (!best || mtime > best.mtime) { best = { dir: full, mtime }; }
            } else {
                walk(full, depth + 1);
            }
        }
    };
    walk(bin, 0);
    return best?.dir;
}

/** The app's main exe inside the source folder. */
function mainExeIn(sourceDir: string, appName: string): string | undefined {
    let files: string[];
    try { files = fs.readdirSync(sourceDir).filter(f => /\.exe$/i.test(f)); } catch { return undefined; }
    return files.find(f => f.toLowerCase() === `${appName.toLowerCase()}.exe`) ?? files[0];
}

/** Common ISCC.exe locations, then PATH. */
function findIscc(): string | undefined {
    const candidates = [
        'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
        'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
        'C:\\Program Files (x86)\\Inno Setup 5\\ISCC.exe'
    ];
    for (const c of candidates) { if (fs.existsSync(c)) { return c; } }
    try {
        const out = cp.execSync('where ISCC.exe', { timeout: 4000 }).toString().split(/\r?\n/)[0].trim();
        if (out && fs.existsSync(out)) { return out; }
    } catch { /* not on PATH */ }
    return undefined;
}

const q = (s: string) => s.replace(/"/g, '');

/** The generated Inno Setup script. */
export function buildIssScript(s: InstallerSettings, sourceDir: string, exeName: string | undefined): string {
    const lines: string[] = [
        '; Installer script generated by UI Maker — https://github.com/coolshrimp/WinForm-GUI-Maker',
        '; Compile with Inno Setup (https://jrsoftware.org/isinfo.php) or the Create Installer button.',
        '',
        '[Setup]',
        `AppId={{${q(s.appId)}}`,
        `AppName=${q(s.appName)}`,
        `AppVersion=${q(s.appVersion)}`,
        ...(s.publisher ? [`AppPublisher=${q(s.publisher)}`] : []),
        ...(s.publisherUrl ? [`AppPublisherURL=${q(s.publisherUrl)}`] : []),
        `DefaultDirName={autopf}\\${q(s.appName)}`,
        `DefaultGroupName=${q(s.appName)}`,
        'DisableProgramGroupPage=yes',
        `OutputBaseFilename=${q(s.outputBase) || 'Setup'}`,
        'Compression=lzma',
        'SolidCompression=yes',
        'WizardStyle=modern',
        ...(s.arch === 'x64' ? ['ArchitecturesInstallIn64BitMode=x64compatible'] : []),
        ...(s.perUser ? ['PrivilegesRequired=lowest'] : []),
        ...(s.iconPath && fs.existsSync(s.iconPath) ? [`SetupIconFile=${q(s.iconPath)}`] : []),
        ...(s.licensePath && fs.existsSync(s.licensePath) ? [`LicenseFile=${q(s.licensePath)}`] : []),
        '',
        '[Languages]',
        'Name: "english"; MessagesFile: "compiler:Default.isl"',
        '',
        '[Tasks]',
        `Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"${s.desktopIcon ? '' : '; Flags: unchecked'}`,
        '',
        '[Files]',
        `Source: "${q(sourceDir)}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
        ''
    ];
    if (exeName) {
        lines.push(
            '[Icons]',
            `Name: "{group}\\${q(s.appName)}"; Filename: "{app}\\${q(exeName)}"`,
            `Name: "{autodesktop}\\${q(s.appName)}"; Filename: "{app}\\${q(exeName)}"; Tasks: desktopicon`,
            ''
        );
        if (s.launchAfter) {
            lines.push(
                '[Run]',
                `Filename: "{app}\\${q(exeName)}"; Description: "{cm:LaunchProgram,${q(s.appName)}}"; Flags: nowait postinstall skipifsilent`,
                ''
            );
        }
    }
    return lines.join('\r\n');
}

/** Open the Create Installer page for the current project. */
export async function openInstallerCreator(dotnet: DotnetTools, explicitProject?: string): Promise<void> {
    const project = explicitProject ?? await dotnet.findProject();
    if (!project) { return; }
    currentProject = project;
    const settings = loadSettings(project);

    const title = `Create Installer — ${path.basename(path.dirname(project))}`;
    if (panel) {
        panel.title = title;
        panel.webview.html = installerHtml(panel.webview, project, settings);
        panel.reveal();
        return;
    }
    panel = vscode.window.createWebviewPanel('uimaker.installer', title, vscode.ViewColumn.One, { enableScripts: true });
    panel.onDidDispose(() => { panel = undefined; currentProject = undefined; });
    panel.webview.html = installerHtml(panel.webview, project, settings);

    panel.webview.onDidReceiveMessage(async (msg: { type: string; settings?: InstallerSettings; field?: string }) => {
        const proj = currentProject;
        if (!proj) { return; }
        if (msg.type === 'save' && msg.settings) {
            saveSettings(proj, msg.settings);
            void vscode.window.showInformationMessage(
                `UI Maker: installer settings saved (${usePerProject() ? 'this project' : 'uniform template for all projects'}).`);
        } else if (msg.type === 'browse' && msg.field) {
            const isFolder = msg.field === 'outputDir' || msg.field === 'sourceDir';
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: !isFolder,
                canSelectFolders: isFolder,
                canSelectMany: false,
                openLabel: 'Select',
                filters: msg.field === 'iconPath' ? { Icons: ['ico'] }
                    : msg.field === 'licensePath' ? { 'License files': ['txt', 'rtf', 'md'] } : undefined
            });
            if (picked?.length) {
                void panel?.webview.postMessage({ type: 'picked', field: msg.field, value: picked[0].fsPath });
            }
        } else if (msg.type === 'generate' && msg.settings) {
            saveSettings(proj, msg.settings);
            await generateInstaller(proj, msg.settings, !!(msg as { compile?: boolean }).compile);
        } else if (msg.type === 'openOutput' && msg.settings) {
            const dir = msg.settings.outputDir || path.join(path.dirname(proj), 'Installer');
            if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
            revealFolder(dir);
        }
    });
}

/** Open a folder in the OS file manager (explorer.exe direct on Windows —
 *  openExternal misroutes folder URIs through app associations there). */
export function revealFolder(dir: string): void {
    if (process.platform === 'win32') {
        try {
            cp.spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
            return;
        } catch { /* fall through */ }
    }
    void vscode.env.openExternal(vscode.Uri.file(dir));
}

async function generateInstaller(project: string, s: InstallerSettings, compile: boolean): Promise<void> {
    const projDir = path.dirname(project);
    const sourceDir = s.sourceDir || detectPublishDir(projDir);
    if (!sourceDir || !fs.existsSync(sourceDir)) {
        const release = 'Build Release Now';
        const pick = await vscode.window.showWarningMessage(
            'UI Maker: no publish output found — run Build Release (Publish) first, or set a custom source folder.',
            release);
        if (pick === release) { void vscode.commands.executeCommand('uimaker.release'); }
        return;
    }
    const outDir = s.outputDir || path.join(projDir, 'Installer');
    if (!fs.existsSync(outDir)) { fs.mkdirSync(outDir, { recursive: true }); }
    const exe = mainExeIn(sourceDir, s.appName);
    const iss = buildIssScript(s, sourceDir, exe);
    const issPath = path.join(outDir, `${(s.appName || 'App').replace(/[^\w.-]/g, '_')}.iss`);
    fs.writeFileSync(issPath, iss, 'utf8');

    if (!compile) {
        void vscode.window.showTextDocument(vscode.Uri.file(issPath));
        void vscode.window.showInformationMessage(
            `UI Maker: installer script written to ${path.basename(issPath)}. Compile it with Inno Setup, or use Generate + Compile here.`);
        return;
    }

    const iscc = findIscc();
    if (!iscc) {
        const get = 'Get Inno Setup';
        void vscode.window.showWarningMessage(
            'UI Maker: Inno Setup (ISCC.exe) was not found — the .iss script was written; install Inno Setup 6 to compile it here.',
            get
        ).then(pick => {
            if (pick === get) { void vscode.env.openExternal(vscode.Uri.parse('https://jrsoftware.org/isdl.php')); }
        });
        void vscode.window.showTextDocument(vscode.Uri.file(issPath));
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Compiling installer for ${s.appName}…` },
        () => new Promise<void>(resolve => {
            cp.execFile(iscc, [`/O${outDir}`, issPath], { timeout: 300000 }, (err, _stdout, stderr) => {
                if (err) {
                    void vscode.window.showErrorMessage(
                        `UI Maker: installer compile failed — ${(stderr || err.message).toString().slice(0, 400)}`);
                } else {
                    const open = 'Open Folder';
                    void vscode.window.showInformationMessage(
                        `UI Maker: installer created — ${s.outputBase}.exe in ${path.basename(outDir)}.`, open
                    ).then(pick => { if (pick === open) { revealFolder(outDir); } });
                }
                resolve();
            });
        })
    );
}

// ------------------------------------------------------------------ webview

function installerHtml(webview: vscode.Webview, project: string, s: InstallerSettings): string {
    const nonce = webviewNonce();
    const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
    const scope = usePerProject() ? 'per-project' : 'uniform (shared across all projects)';
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           background: var(--vscode-editor-background); max-width: 860px; margin: 0 auto;
           padding: 1rem 2rem 3rem; line-height: 1.5; }
    h1 { font-size: 1.4em; }
    .project { opacity: .75; font-size: .9em; margin-bottom: 1em; }
    .grid { display: grid; grid-template-columns: 170px 1fr auto; gap: 6px 10px; align-items: center; }
    label { white-space: nowrap; }
    input[type=text] { width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
        color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
        padding: 4px 6px; border-radius: 2px; }
    select { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; border-radius: 2px; }
    .checks { margin: 12px 0; display: flex; gap: 22px; flex-wrap: wrap; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; margin: 0 8px 8px 0; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.browse { padding: 4px 10px; margin: 0; }
    .hint { opacity: .8; font-size: .9em; }
    .scope { padding: 6px 10px; border-left: 3px solid var(--vscode-focusBorder, #007fd4);
        background: var(--vscode-textCodeBlock-background); margin: 10px 0 16px; font-size: .92em; }
    code { font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body>
<h1>Create an Installer</h1>
<div class="project">Project: <code>${path.basename(project)}</code> — packages the newest <code>publish</code> output into a Windows installer (Inno Setup)</div>
<div class="scope">Settings memory: <b>${scope}</b> — change it with the <code>uimaker.installer.settingsScope</code> setting.</div>

<div class="grid">
    <label>App name</label><input type="text" id="appName"><span></span>
    <label>Version</label><input type="text" id="appVersion"><span></span>
    <label>Publisher</label><input type="text" id="publisher"><span></span>
    <label>Publisher URL</label><input type="text" id="publisherUrl"><span></span>
    <label>App ID (GUID)</label><input type="text" id="appId" title="Stable per app so upgrades replace instead of duplicating"><span></span>
    <label>Setup icon (.ico)</label><input type="text" id="iconPath"><button class="browse secondary" data-b="iconPath">…</button>
    <label>License file</label><input type="text" id="licensePath"><button class="browse secondary" data-b="licensePath">…</button>
    <label>Source folder</label><input type="text" id="sourceDir" placeholder="(auto: newest bin\\…\\publish)"><button class="browse secondary" data-b="sourceDir">…</button>
    <label>Output folder</label><input type="text" id="outputDir" placeholder="(default: <project>\\Installer)"><button class="browse secondary" data-b="outputDir">…</button>
    <label>Output file name</label><input type="text" id="outputBase"><span></span>
    <label>Architecture</label><select id="arch"><option value="x64">64-bit (x64)</option><option value="x86">32-bit (x86)</option></select><span></span>
</div>

<div class="checks">
    <label><input type="checkbox" id="desktopIcon"> Desktop shortcut task</label>
    <label><input type="checkbox" id="launchAfter"> Launch app after install</label>
    <label><input type="checkbox" id="perUser"> Per-user install (no admin prompt)</label>
</div>

<button id="save" class="secondary">Save Settings</button>
<button id="gen">Generate Script</button>
<button id="genc">Generate + Compile Installer</button>
<button id="open" class="secondary">Open Output Folder</button>

<p class="hint">Run <b>Build Release (Publish)</b> first so there is fresh publish output to package.
Compiling needs <a href="https://jrsoftware.org/isdl.php">Inno Setup 6</a> installed; without it you still get the ready-to-compile <code>.iss</code> script.</p>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const s = ${json(s)};
    const F = ['appName','appVersion','publisher','publisherUrl','appId','iconPath','licensePath','sourceDir','outputDir','outputBase'];
    for (const f of F) { document.getElementById(f).value = s[f] ?? ''; }
    document.getElementById('arch').value = s.arch || 'x64';
    for (const c of ['desktopIcon','launchAfter','perUser']) { document.getElementById(c).checked = !!s[c]; }

    function collect() {
        for (const f of F) { s[f] = document.getElementById(f).value.trim(); }
        s.arch = document.getElementById('arch').value;
        for (const c of ['desktopIcon','launchAfter','perUser']) { s[c] = document.getElementById(c).checked; }
        return s;
    }
    for (const b of document.querySelectorAll('button.browse')) {
        b.addEventListener('click', () => vscode.postMessage({ type: 'browse', field: b.dataset.b }));
    }
    window.addEventListener('message', e => {
        if (e.data.type === 'picked') { document.getElementById(e.data.field).value = e.data.value; }
    });
    document.getElementById('save').addEventListener('click', () => vscode.postMessage({ type: 'save', settings: collect() }));
    document.getElementById('gen').addEventListener('click', () => vscode.postMessage({ type: 'generate', compile: false, settings: collect() }));
    document.getElementById('genc').addEventListener('click', () => vscode.postMessage({ type: 'generate', compile: true, settings: collect() }));
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'openOutput', settings: collect() }));
</script>
</body>
</html>`;
}
