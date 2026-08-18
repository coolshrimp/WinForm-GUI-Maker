// UI Maker — custom control discovery ("Toolbox auto-population").
//
// Visual Studio fills the toolbox with every control the solution defines;
// this module does the same for the designer webview:
//   * Project scan   — classes in the working project's source deriving from
//                      a WinForms control base (C# and VB), plus WPF
//                      UserControls declared in .xaml files.
//   * Library        — controls the user registered by hand in the
//                      uimaker.customControls setting (e.g. controls that
//                      live in a NuGet package or a referenced DLL, which a
//                      source scan cannot see).
// The results feed the designer toolbox ("Project Controls" / "Custom
// Library" sections) and the Control Library panel.

import * as fs from 'fs';
import * as path from 'path';

export interface CustomControl {
    /** Short class name, e.g. RJButton. */
    name: string;
    /** Namespace ('' when the class sits in the global namespace). */
    ns: string;
    /** Name the generated code uses, e.g. CustomControls.RJControls.RJButton. */
    qualified: string;
    /** Short name of the designer base the canvas mimics, e.g. Button. */
    base: string;
    designer: 'winforms' | 'wpf';
    source: 'project' | 'library';
    /** Project-relative source file (project controls only). */
    file?: string;
    /** xmlns the XAML insert declares (WPF only). */
    xmlns?: string;
    width?: number;
    height?: number;
}

/** WinForms classes that are valid designer bases. Deriving from any of
 *  these (directly or through another project class) makes a class a
 *  designable custom control. Form is deliberately absent. */
const WF_BASES = new Set([
    'UserControl', 'Control', 'ContainerControl', 'ScrollableControl',
    'ButtonBase', 'TextBoxBase', 'ListControl', 'UpDownBase',
    'Button', 'Label', 'LinkLabel', 'TextBox', 'MaskedTextBox', 'RichTextBox',
    'CheckBox', 'RadioButton', 'CheckedListBox', 'ComboBox', 'DomainUpDown',
    'ListBox', 'ListView', 'TreeView', 'PictureBox', 'ProgressBar', 'TrackBar',
    'NumericUpDown', 'DateTimePicker', 'MonthCalendar', 'HScrollBar', 'VScrollBar',
    'WebBrowser', 'PropertyGrid', 'GroupBox', 'Panel', 'FlowLayoutPanel',
    'TableLayoutPanel', 'SplitContainer', 'TabControl', 'DataGridView'
]);

/** WPF classes accepted as bases for code-defined WPF controls. */
const WPF_BASES = new Set([
    'UserControl', 'Control', 'ContentControl', 'ItemsControl', 'Button',
    'TextBox', 'Label', 'CheckBox', 'RadioButton', 'ComboBox', 'ListBox',
    'Slider', 'ProgressBar', 'Border', 'Panel', 'Grid', 'StackPanel', 'Canvas'
]);

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', 'packages', '.git', '.vs', '.vscode']);
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 1024 * 1024;

interface ScanCache { stamp: string; controls: CustomControl[]; }
const scanCache = new Map<string, ScanCache>();

/** Source files a control class can live in, with their mtimes (cache key). */
function candidateFiles(projDir: string): Array<{ file: string; mtime: number }> {
    const out: Array<{ file: string; mtime: number }> = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 12 || out.length >= MAX_FILES) { return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (out.length >= MAX_FILES) { return; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) {
                    walk(full, depth + 1);
                }
                continue;
            }
            if (!entry.isFile()) { continue; }
            const lower = entry.name.toLowerCase();
            // Designer partials never carry the base type; XAML code-behind is
            // represented by its .xaml file.
            if (lower.endsWith('.designer.cs') || lower.endsWith('.designer.vb') || lower.endsWith('.xaml.cs') || lower.endsWith('.xaml.vb')) { continue; }
            if (lower.endsWith('.cs') || lower.endsWith('.vb') || lower.endsWith('.xaml')) {
                try { out.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* transient */ }
            }
        }
    };
    walk(projDir, 0);
    return out;
}

/** Strip generic arguments and global:: from a base-type expression. */
function cleanTypeName(raw: string): string {
    return raw.replace(/^global::/, '').replace(/<[^>]*>/g, '').trim();
}

function shortName(qualified: string): string {
    const parts = qualified.split('.');
    return parts[parts.length - 1];
}

/** Custom controls declared in one C# file. */
function scanCsFile(text: string, rel: string): CustomControl[] {
    const out: CustomControl[] = [];
    // File-scoped or block namespace — the first declaration wins; nested
    // namespaces are rare in WinForms projects and out of scope here.
    const ns = /^\s*namespace\s+([\w.]+)\s*[;{\r\n]/m.exec(text)?.[1] ?? '';
    const usesWinForms = /\bSystem\.Windows\.Forms\b/.test(text) || /^\s*using\s+System\.Windows\.Forms\s*;/m.test(text);
    const usesWpf = /\bSystem\.Windows\.Controls\b/.test(text);
    for (const m of text.matchAll(/\bclass\s+([A-Za-z_]\w*)\s*:\s*([^{\r\n]+)/g)) {
        const name = m[1];
        const base = cleanTypeName(m[2].split(',')[0] ?? '');
        const baseShort = shortName(base);
        if (baseShort === 'Form' || baseShort === 'Window') { continue; }
        const wfBase = WF_BASES.has(baseShort) && (usesWinForms || /System\.Windows\.Forms\./.test(base) || !usesWpf);
        const wpfBase = !wfBase && WPF_BASES.has(baseShort) && (usesWpf || /System\.Windows\.Controls\./.test(base));
        // A class deriving from ANOTHER project class is resolved later by
        // resolveChains once every declared class is known.
        const chained = !wfBase && !wpfBase && /^[A-Za-z_]\w*(\.\w+)*$/.test(base);
        if (!wfBase && !wpfBase && !chained) { continue; }
        out.push({
            name,
            ns,
            qualified: ns ? `${ns}.${name}` : name,
            base: baseShort,
            designer: wpfBase ? 'wpf' : 'winforms',
            source: 'project',
            file: rel
        });
    }
    return out;
}

/** Custom controls declared in one VB file. */
function scanVbFile(text: string, rel: string): CustomControl[] {
    const out: CustomControl[] = [];
    const ns = /^\s*Namespace\s+([\w.]+)/im.exec(text)?.[1] ?? '';
    for (const m of text.matchAll(/\bClass\s+([A-Za-z_]\w*)[^\r\n]*\r?\n(?:\s*(?:'[^\r\n]*)?\r?\n)*\s*Inherits\s+([\w.]+)/gi)) {
        const name = m[1];
        const base = cleanTypeName(m[2]);
        const baseShort = shortName(base);
        if (baseShort === 'Form' || baseShort === 'Window') { continue; }
        if (!WF_BASES.has(baseShort) && !/^[A-Za-z_]\w*(\.\w+)*$/.test(base)) { continue; }
        out.push({
            name,
            ns,
            qualified: ns ? `${ns}.${name}` : name,
            base: baseShort,
            designer: 'winforms',
            source: 'project',
            file: rel
        });
    }
    return out;
}

/** WPF UserControls: .xaml whose root element is <UserControl x:Class="…">. */
function scanXamlFile(text: string, rel: string): CustomControl[] {
    const head = text.slice(0, 4000);
    const root = /<\s*UserControl\b[^>]*>/i.exec(head)?.[0];
    if (!root) { return []; }
    const cls = /x:Class\s*=\s*"([\w.]+)"/.exec(root)?.[1];
    if (!cls) { return []; }
    const name = shortName(cls);
    const ns = cls.slice(0, cls.length - name.length - 1);
    return [{
        name,
        ns,
        qualified: cls,
        base: 'UserControl',
        designer: 'wpf',
        source: 'project',
        file: rel,
        xmlns: ns ? `clr-namespace:${ns}` : undefined
    }];
}

/** Follow project-internal inheritance (MyButton : RJButton : Button) so
 *  every control ends on a real designer base; drop unresolvable chains. */
function resolveChains(controls: CustomControl[]): CustomControl[] {
    const byName = new Map(controls.map(c => [c.name, c]));
    const resolved: CustomControl[] = [];
    for (const c of controls) {
        let base = c.base;
        let designer = c.designer;
        const seen = new Set<string>([c.name]);
        for (let hop = 0; hop < 8; hop++) {
            if (designer === 'wpf' ? WPF_BASES.has(base) : WF_BASES.has(base)) { break; }
            const parent = byName.get(base);
            if (!parent || seen.has(parent.name)) { base = ''; break; }
            seen.add(parent.name);
            base = parent.base;
            designer = parent.designer;
        }
        if (!base) { continue; } // base type is not designable — skip it
        resolved.push({ ...c, base, designer });
    }
    return resolved;
}

/** Scan one project folder for custom controls (mtime-cached). */
export function scanProjectControls(projDir: string): CustomControl[] {
    let files: Array<{ file: string; mtime: number }>;
    try { files = candidateFiles(projDir); } catch { return []; }
    const stamp = files.map(f => `${f.file}:${f.mtime}`).join('|');
    const cached = scanCache.get(projDir);
    if (cached && cached.stamp === stamp) { return cached.controls; }

    const found: CustomControl[] = [];
    for (const { file } of files) {
        let text: string;
        try {
            if (fs.statSync(file).size > MAX_FILE_BYTES) { continue; }
            text = fs.readFileSync(file, 'utf8');
        } catch { continue; }
        const rel = path.relative(projDir, file);
        const lower = file.toLowerCase();
        if (lower.endsWith('.cs')) { found.push(...scanCsFile(text, rel)); }
        else if (lower.endsWith('.vb')) { found.push(...scanVbFile(text, rel)); }
        else if (lower.endsWith('.xaml')) { found.push(...scanXamlFile(text, rel)); }
    }

    // One entry per class name (partial classes, duplicated hits).
    const unique = new Map<string, CustomControl>();
    for (const c of resolveChains(found)) {
        if (!unique.has(c.qualified.toLowerCase())) { unique.set(c.qualified.toLowerCase(), c); }
    }
    const controls = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
    scanCache.set(projDir, { stamp, controls });
    return controls;
}

/** Manual entries from the uimaker.customControls setting. */
export function libraryControls(): CustomControl[] {
    // Loaded lazily so the scanner stays usable from plain Node (unit tests).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode') as typeof import('vscode');
    const raw = vscode.workspace.getConfiguration('uimaker').get<unknown[]>('customControls', []);
    if (!Array.isArray(raw)) { return []; }
    const out: CustomControl[] = [];
    for (const entry of raw) {
        const e = entry as Record<string, unknown>;
        const qualified = typeof e?.type === 'string' ? e.type.trim() : '';
        if (!/^[A-Za-z_]\w*(\.\w+)*$/.test(qualified)) { continue; }
        const name = shortName(qualified);
        const ns = qualified.slice(0, qualified.length - name.length - (qualified.includes('.') ? 1 : 0));
        const designer = e.designer === 'wpf' ? 'wpf' : 'winforms';
        const baseRaw = typeof e.base === 'string' ? shortName(cleanTypeName(e.base)) : '';
        const bases = designer === 'wpf' ? WPF_BASES : WF_BASES;
        const base = bases.has(baseRaw) ? baseRaw : (designer === 'wpf' ? 'UserControl' : 'Control');
        const assembly = typeof e.assembly === 'string' && /^[\w.]+$/.test(e.assembly) ? e.assembly : '';
        const size = (v: unknown) => {
            const n = Math.round(Number(v));
            return Number.isFinite(n) && n > 0 && n <= 4000 ? n : undefined;
        };
        out.push({
            name,
            ns,
            qualified,
            base,
            designer,
            source: 'library',
            xmlns: designer === 'wpf' && ns ? `clr-namespace:${ns}${assembly ? `;assembly=${assembly}` : ''}` : undefined,
            width: size(e.width),
            height: size(e.height)
        });
    }
    return out;
}

/** Project scan + library entries, deduplicated (library wins on conflict). */
export function allCustomControls(projDir: string | undefined): CustomControl[] {
    const merged = new Map<string, CustomControl>();
    if (projDir) {
        for (const c of scanProjectControls(projDir)) { merged.set(c.qualified.toLowerCase(), c); }
    }
    for (const c of libraryControls()) { merged.set(c.qualified.toLowerCase(), c); }
    return [...merged.values()];
}

/** The 'customControls' message for the designer webview. */
export function customControlsMessage(projDir: string | undefined): Record<string, unknown> {
    const controls = allCustomControls(projDir);
    return {
        type: 'customControls',
        winforms: controls.filter(c => c.designer === 'winforms').map(c => ({
            name: c.name,
            qualified: c.qualified,
            base: c.base,
            source: c.source,
            width: c.width,
            height: c.height
        })),
        wpf: controls.filter(c => c.designer === 'wpf').map(c => ({
            name: c.name,
            ns: c.ns,
            xmlns: c.xmlns ?? (c.ns ? `clr-namespace:${c.ns}` : ''),
            base: c.base,
            source: c.source,
            width: c.width,
            height: c.height
        }))
    };
}
