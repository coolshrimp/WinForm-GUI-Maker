// Small, dependency-free Visual Basic text helpers used by the WinForms
// designer's VB support. Deliberately lexical (like csharpText.ts): they must
// work without any VB language service installed.
//
// VB specifics handled here:
//   * identifiers are case-insensitive and have their own keyword list;
//   * comments start with an apostrophe (or REM) and run to end of line;
//   * strings escape quotes by doubling ("" inside "..."), no backslashes;
//   * event wiring lives in the code-behind as `Handles` clauses, not in
//     InitializeComponent.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reserved VB.NET keywords (compared case-insensitively). */
const VB_RESERVED_KEYWORDS = new Set([
    'addhandler', 'addressof', 'alias', 'and', 'andalso', 'as', 'boolean',
    'byref', 'byte', 'byval', 'call', 'case', 'catch', 'cbool', 'cbyte',
    'cchar', 'cdate', 'cdbl', 'cdec', 'char', 'cint', 'class', 'clng',
    'cobj', 'const', 'continue', 'csbyte', 'cshort', 'csng', 'cstr',
    'ctype', 'cuint', 'culng', 'cushort', 'date', 'decimal', 'declare',
    'default', 'delegate', 'dim', 'directcast', 'do', 'double', 'each',
    'else', 'elseif', 'end', 'endif', 'enum', 'erase', 'error', 'event',
    'exit', 'false', 'finally', 'for', 'friend', 'function', 'get',
    'gettype', 'getxmlnamespace', 'global', 'gosub', 'goto', 'handles',
    'if', 'implements', 'imports', 'in', 'inherits', 'integer', 'interface',
    'is', 'isnot', 'let', 'lib', 'like', 'long', 'loop', 'me', 'mod',
    'module', 'mustinherit', 'mustoverride', 'mybase', 'myclass', 'nameof',
    'namespace', 'narrowing', 'new', 'next', 'not', 'nothing',
    'notinheritable', 'notoverridable', 'object', 'of', 'on', 'operator',
    'option', 'optional', 'or', 'orelse', 'overloads', 'overridable',
    'overrides', 'paramarray', 'partial', 'private', 'property',
    'protected', 'public', 'raiseevent', 'readonly', 'redim', 'rem',
    'removehandler', 'resume', 'return', 'sbyte', 'select', 'set',
    'shadows', 'shared', 'short', 'single', 'static', 'step', 'stop',
    'string', 'structure', 'sub', 'synclock', 'then', 'throw', 'to', 'true',
    'try', 'trycast', 'typeof', 'uinteger', 'ulong', 'ushort', 'using',
    'variant', 'wend', 'when', 'while', 'widening', 'with', 'withevents',
    'writeonly', 'xor'
]);

export function isVbIdentifier(value: unknown): value is string {
    return typeof value === 'string'
        && IDENTIFIER.test(value)
        && !VB_RESERVED_KEYWORDS.has(value.toLowerCase());
}

/** "Button1.Click", "Me.Load", "MyBase.Load" — one Handles clause target. */
const HANDLES_TARGET = /^(?:MyBase|Me|[A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*$/i;

export function isVbHandlesTarget(value: unknown): value is string {
    return typeof value === 'string' && HANDLES_TARGET.test(value.trim());
}

/**
 * Blank comment and string-literal contents while preserving offsets and
 * newlines, so structural searches never match text inside either. VB
 * comments are ' or REM to end of line; strings double their quotes.
 */
export function maskVbCommentsAndStrings(source: string): string {
    const chars = [...source];
    const n = source.length;
    const blank = (start: number, end: number) => {
        for (let j = start; j < end; j++) {
            if (chars[j] !== '\r' && chars[j] !== '\n') { chars[j] = ' '; }
        }
    };
    let i = 0;
    let lineStart = true;
    while (i < n) {
        const ch = source[i];
        if (ch === '\n') { lineStart = true; i++; continue; }
        if (ch === '"') {
            let j = i + 1;
            while (j < n) {
                if (source[j] === '"' && source[j + 1] === '"') { j += 2; continue; }
                if (source[j] === '"') { j++; break; }
                if (source[j] === '\n') { break; } // unterminated — VB strings are single-line
                j++;
            }
            blank(i + 1, source[j - 1] === '"' ? j - 1 : j);
            i = j;
            lineStart = false;
            continue;
        }
        if (ch === '\'') {
            let end = source.indexOf('\n', i);
            if (end < 0) { end = n; }
            blank(i, end);
            i = end;
            continue;
        }
        // REM comments only count at the start of a statement.
        if (lineStart && /^rem\b/i.test(source.slice(i, i + 4))) {
            let end = source.indexOf('\n', i);
            if (end < 0) { end = n; }
            blank(i, end);
            i = end;
            continue;
        }
        if (!/[ \t]/.test(ch)) { lineStart = ch === ':'; }
        i++;
    }
    return chars.join('');
}

/**
 * Rename an identifier in VB source, case-insensitively (VB identifiers are
 * case-insensitive), while leaving comments and string literals untouched.
 */
export function renameVbIdentifier(source: string, oldName: string, newName: string): string {
    if (!isVbIdentifier(oldName) || !isVbIdentifier(newName)
        || oldName.toLowerCase() === newName.toLowerCase()) {
        return source;
    }
    const masked = maskVbCommentsAndStrings(source);
    const re = new RegExp(`\\b${oldName}\\b`, 'gi');
    let out = '';
    let last = 0;
    for (let m = re.exec(masked); m; m = re.exec(masked)) {
        out += source.slice(last, m.index) + newName;
        last = m.index + m[0].length;
    }
    return out + source.slice(last);
}

/**
 * Bounds of a class declared in the file: offset just past the declaration
 * line and the offset of its matching `End Class` line. Nested classes are
 * tracked so the outer class closes at the right place.
 */
export function findVbClassBounds(
    source: string,
    className?: string
): { open: number; end: number } | undefined {
    const masked = maskVbCommentsAndStrings(source);
    const declPattern = className && isVbIdentifier(className)
        ? new RegExp(`^[ \\t]*(?:[\\w<>().,= ]*\\b)?(?:Partial\\s+)?(?:Public\\s+|Friend\\s+|Private\\s+|Protected\\s+|NotInheritable\\s+|MustInherit\\s+)*Class\\s+${className}\\b`, 'im')
        : /^[ \t]*(?:Partial\s+)?(?:Public\s+|Friend\s+|Private\s+|Protected\s+|NotInheritable\s+|MustInherit\s+)*Class\s+[A-Za-z_]\w*/im;
    const decl = declPattern.exec(masked);
    if (!decl) { return undefined; }
    const open = decl.index + decl[0].length;

    const tokens = /^[ \t]*(End\s+Class\b|(?:Partial\s+)?(?:Public\s+|Friend\s+|Private\s+|Protected\s+|Shadows\s+|NotInheritable\s+|MustInherit\s+)*Class\s+[A-Za-z_]\w*)/gim;
    tokens.lastIndex = open;
    let depth = 1;
    for (let m = tokens.exec(masked); m; m = tokens.exec(masked)) {
        if (/^End\s+Class/i.test(m[1])) {
            if (--depth === 0) {
                return { open, end: m.index + m[0].indexOf(m[1]) };
            }
        } else {
            depth++;
        }
    }
    return undefined;
}

/** Offset of a `Sub <name>(` declaration inside the class (or file), or -1. */
export function findVbSub(source: string, name: string, className?: string): number {
    if (!isVbIdentifier(name)) { return -1; }
    const masked = maskVbCommentsAndStrings(source);
    const bounds = className ? findVbClassBounds(source, className) : undefined;
    const start = bounds ? bounds.open : 0;
    const end = bounds ? bounds.end : masked.length;
    const m = new RegExp(`\\bSub\\s+${name}\\s*\\(`, 'i').exec(masked.slice(start, end));
    return m ? start + m.index : -1;
}

export interface VbHandlesEntry {
    /** Method name of the handler Sub. */
    handler: string;
    /** One Handles target exactly as written, e.g. "Button1.Click". */
    target: string;
}

/** Every `Sub ... Handles a.B, c.D` wiring in the source, one row per target. */
export function parseVbHandles(source: string): VbHandlesEntry[] {
    const masked = maskVbCommentsAndStrings(source);
    const out: VbHandlesEntry[] = [];
    const re = /\bSub\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*Handles\s+([^\r\n]+)/gi;
    for (let m = re.exec(masked); m; m = re.exec(masked)) {
        // Read targets from the ORIGINAL text so casing is preserved.
        const raw = source.slice(m.index + m[0].length - m[2].length, m.index + m[0].length);
        for (const target of raw.split(',')) {
            const t = target.trim();
            if (HANDLES_TARGET.test(t)) { out.push({ handler: m[1], target: t }); }
        }
    }
    return out;
}

const sameTarget = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Remove `target` from every Handles clause (except the Sub named `except`).
 * A clause left empty loses its `Handles` keyword entirely.
 */
export function removeVbHandlesTarget(source: string, target: string, except?: string): string {
    const masked = maskVbCommentsAndStrings(source);
    const re = /\b(Sub\s+([A-Za-z_]\w*)\s*\([^)]*\))(\s*Handles\s+)([^\r\n]+)/gi;
    let out = '';
    let last = 0;
    for (let m = re.exec(masked); m; m = re.exec(masked)) {
        if (except && m[2].toLowerCase() === except.toLowerCase()) { continue; }
        const clauseStart = m.index + m[1].length + m[3].length;
        const clauseEnd = m.index + m[0].length;
        const clause = source.slice(clauseStart, clauseEnd);
        const kept = clause.split(',').map(s => s.trim()).filter(t => t && !sameTarget(t, target));
        if (kept.length === clause.split(',').map(s => s.trim()).filter(Boolean).length) { continue; }
        out += source.slice(last, m.index + m[1].length);
        if (kept.length) { out += `${source.slice(m.index + m[1].length, clauseStart)}${kept.join(', ')}`; }
        last = clauseEnd;
    }
    return out + source.slice(last);
}

/**
 * Ensure the Sub named `subName` handles `target`: appends to an existing
 * Handles clause or adds one after the parameter list. Returns null when the
 * Sub is not present (the caller then generates a stub instead).
 */
export function addVbHandlesTarget(source: string, subName: string, target: string): string | null {
    const masked = maskVbCommentsAndStrings(source);
    const re = new RegExp(`\\b(Sub\\s+${subName}\\s*\\([^)]*\\))((?:\\s*Handles\\s+)([^\\r\\n]+))?`, 'i');
    const m = re.exec(masked);
    if (!m) { return null; }
    if (m[3] !== undefined) {
        const clauseEnd = m.index + m[0].length;
        const clause = source.slice(clauseEnd - m[3].length, clauseEnd);
        if (clause.split(',').some(t => sameTarget(t, target))) { return source; }
        return `${source.slice(0, clauseEnd)}, ${target}${source.slice(clauseEnd)}`;
    }
    const at = m.index + m[1].length;
    return `${source.slice(0, at)} Handles ${target}${source.slice(at)}`;
}
