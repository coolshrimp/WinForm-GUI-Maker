// Small, dependency-free C# text helpers used by source-generation paths.
// These are deliberately lexical rather than semantic: the extension must
// still work when the C# language service is not installed.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reserved C# keywords cannot be used as generated bare identifiers. */
const RESERVED_KEYWORDS = new Set([
    'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch',
    'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default',
    'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit',
    'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach',
    'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is',
    'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out',
    'override', 'params', 'private', 'protected', 'public', 'readonly',
    'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc',
    'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try',
    'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using',
    'virtual', 'void', 'volatile', 'while'
]);

export function isCSharpIdentifier(value: unknown): value is string {
    return typeof value === 'string'
        && IDENTIFIER.test(value)
        && !RESERVED_KEYWORDS.has(value);
}

/** Convert a display/file name into a safe generated bare C# identifier. */
export function sanitizeCSharpIdentifier(value: string, fallback = 'Generated'): string {
    let result = value.replace(/[^A-Za-z0-9_]/g, '_');
    if (!result) { result = fallback.replace(/[^A-Za-z0-9_]/g, '_') || 'Generated'; }
    if (/^[0-9]/.test(result)) { result = `_${result}`; }
    if (RESERVED_KEYWORDS.has(result)) { result = `_${result}`; }
    return result;
}

/** Sanitize every segment of a dotted generated namespace. */
export function sanitizeCSharpNamespace(value: string, fallback = 'Application'): string {
    const segments = value.split('.').filter(Boolean)
        .map(segment => sanitizeCSharpIdentifier(segment));
    return segments.length ? segments.join('.') : sanitizeCSharpIdentifier(fallback);
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rename a C# identifier while leaving comments and literal text untouched.
 * Normal interpolated-string expressions are code and are rewritten; their
 * visible text is not. Single-dollar raw interpolation is handled too;
 * uncommon multi-dollar raw strings stay verbatim in the lexical fallback.
 */
export function renameCSharpIdentifier(source: string, oldName: string, newName: string): string {
    if (!isCSharpIdentifier(oldName) || !isCSharpIdentifier(newName) || oldName === newName) {
        return source;
    }

    const n = source.length;

    const scanQuoted = (start: number, quote: string, verbatim = false): number => {
        let i = start + 1;
        while (i < n) {
            if (verbatim && source[i] === quote && source[i + 1] === quote) { i += 2; continue; }
            if (!verbatim && source[i] === '\\') { i += 2; continue; }
            if (source[i] === quote) { return i + 1; }
            i++;
        }
        return n;
    };

    const scanRawString = (quoteStart: number): number => {
        let quoteCount = 0;
        while (source[quoteStart + quoteCount] === '"') { quoteCount++; }
        const delimiter = '"'.repeat(quoteCount);
        const end = source.indexOf(delimiter, quoteStart + quoteCount);
        return end < 0 ? n : end + quoteCount;
    };

    /** Rewrite an ordinary code range, optionally stopping at its matching }. */
    const rewriteCode = (start: number, stopAtBrace: boolean): { text: string; next: number } => {
        let out = '';
        let i = start;
        let braceDepth = stopAtBrace ? 1 : 0;

        const appendProtected = (end: number) => {
            out += source.slice(i, end);
            i = end;
        };

        const rewriteInterpolated = (prefixLength: number, verbatim: boolean): void => {
            const tokenStart = i;
            const quoteAt = tokenStart + prefixLength - 1;
            out += source.slice(tokenStart, quoteAt + 1);
            i = quoteAt + 1;
            while (i < n) {
                if (verbatim && source[i] === '"' && source[i + 1] === '"') {
                    out += '""'; i += 2; continue;
                }
                if (!verbatim && source[i] === '\\') {
                    out += source.slice(i, Math.min(i + 2, n)); i += 2; continue;
                }
                if (source[i] === '"') { out += '"'; i++; return; }
                if ((source[i] === '{' && source[i + 1] === '{')
                    || (source[i] === '}' && source[i + 1] === '}')) {
                    out += source.slice(i, i + 2); i += 2; continue;
                }
                if (source[i] === '{') {
                    out += '{';
                    const expression = rewriteCode(i + 1, true);
                    out += expression.text;
                    i = expression.next;
                    continue;
                }
                out += source[i++];
            }
        };

        const rewriteRawInterpolated = (rawQuoteAt: number): void => {
            let quoteCount = 0;
            while (source[rawQuoteAt + quoteCount] === '"') { quoteCount++; }
            const delimiter = '"'.repeat(quoteCount);
            out += source.slice(i, rawQuoteAt + quoteCount);
            i = rawQuoteAt + quoteCount;
            while (i < n) {
                if (source.startsWith(delimiter, i)) {
                    out += delimiter;
                    i += quoteCount;
                    return;
                }
                if ((source[i] === '{' && source[i + 1] === '{')
                    || (source[i] === '}' && source[i + 1] === '}')) {
                    out += source.slice(i, i + 2);
                    i += 2;
                    continue;
                }
                if (source[i] === '{') {
                    out += '{';
                    const expression = rewriteCode(i + 1, true);
                    out += expression.text;
                    i = expression.next;
                    continue;
                }
                out += source[i++];
            }
        };

        while (i < n) {
            const two = source.slice(i, i + 2);
            const three = source.slice(i, i + 3);

            if (two === '//') {
                const end = source.indexOf('\n', i + 2);
                appendProtected(end < 0 ? n : end);
                continue;
            }
            if (two === '/*') {
                const end = source.indexOf('*/', i + 2);
                appendProtected(end < 0 ? n : end + 2);
                continue;
            }

            // One-dollar raw interpolation uses ordinary {expression}
            // delimiters. Multi-dollar brace grammars stay indivisible here.
            let dollars = 0;
            while (source[i + dollars] === '$') { dollars++; }
            const rawQuoteAt = i + dollars;
            if (source.slice(rawQuoteAt, rawQuoteAt + 3) === '"""') {
                if (dollars === 1) { rewriteRawInterpolated(rawQuoteAt); }
                else { appendProtected(scanRawString(rawQuoteAt)); }
                continue;
            }

            if (three === '$@"' || three === '@$"') { rewriteInterpolated(3, true); continue; }
            if (two === '$"') { rewriteInterpolated(2, false); continue; }
            if (two === '@"') { appendProtected(scanQuoted(i + 1, '"', true)); continue; }
            if (source[i] === '"') { appendProtected(scanQuoted(i, '"')); continue; }
            if (source[i] === '\'') { appendProtected(scanQuoted(i, '\'')); continue; }

            if (stopAtBrace) {
                if (source[i] === '{') { braceDepth++; out += source[i++]; continue; }
                if (source[i] === '}') {
                    braceDepth--;
                    out += source[i++];
                    if (braceDepth === 0) { return { text: out, next: i }; }
                    continue;
                }
            }

            if (/[A-Za-z_]/.test(source[i])) {
                let end = i + 1;
                while (end < n && /[A-Za-z0-9_]/.test(source[end])) { end++; }
                const identifier = source.slice(i, end);
                out += identifier === oldName ? newName : identifier;
                i = end;
                continue;
            }

            out += source[i++];
        }
        return { text: out, next: i };
    };

    return rewriteCode(0, false).text;
}

/**
 * Offset of the closing brace of the first real class declaration. Text in
 * comments and every C# string/char form is masked before structural search.
 */
export function findCSharpClassEnd(source: string, className?: string): number {
    const masked = maskCSharpLiteralsAndComments(source);
    return classBounds(masked, className)?.end ?? -1;
}

function classBounds(masked: string, className?: string): { open: number; end: number } | undefined {
    const classPattern = className && isCSharpIdentifier(className)
        ? new RegExp(`\\bclass\\s+${escapeRegExp(className)}\\b`)
        : /\bclass\s+[A-Za-z_][A-Za-z0-9_]*/;
    const classDecl = classPattern.exec(masked);
    if (!classDecl) { return undefined; }
    const open = masked.indexOf('{', classDecl.index + classDecl[0].length);
    if (open < 0) { return undefined; }

    let depth = 0;
    for (let i = open; i < masked.length; i++) {
        if (masked[i] === '{') { depth++; }
        else if (masked[i] === '}' && --depth === 0) { return { open, end: i }; }
    }
    return undefined;
}

/** Find a real `void Name(` declaration, excluding comments and literals. */
export function findCSharpVoidMethod(source: string, name: string, className?: string): number {
    if (!isCSharpIdentifier(name)) { return -1; }
    const masked = maskCSharpLiteralsAndComments(source);
    const bounds = className ? classBounds(masked, className) : undefined;
    const start = bounds ? bounds.open + 1 : 0;
    const end = bounds ? bounds.end : masked.length;
    const match = new RegExp(`\\bvoid\\s+${escapeRegExp(name)}\\s*\\(`).exec(masked.slice(start, end));
    return match ? start + match.index : -1;
}

/** Preserve indexes/newlines while blanking non-code regions. */
function maskCSharpLiteralsAndComments(source: string): string {
    const chars = [...source];
    const n = source.length;
    const blank = (start: number, end: number) => {
        for (let j = start; j < end; j++) {
            if (chars[j] !== '\r' && chars[j] !== '\n') { chars[j] = ' '; }
        }
    };
    const quotedEnd = (quoteAt: number, quote: string, verbatim = false): number => {
        let j = quoteAt + 1;
        while (j < n) {
            if (verbatim && source[j] === quote && source[j + 1] === quote) { j += 2; continue; }
            if (!verbatim && source[j] === '\\') { j += 2; continue; }
            if (source[j] === quote) { return j + 1; }
            j++;
        }
        return n;
    };

    let i = 0;
    while (i < n) {
        const two = source.slice(i, i + 2);
        const three = source.slice(i, i + 3);
        let end = i;
        if (two === '//') {
            end = source.indexOf('\n', i + 2); if (end < 0) { end = n; }
        } else if (two === '/*') {
            end = source.indexOf('*/', i + 2); end = end < 0 ? n : end + 2;
        } else {
            let prefix = 0;
            while (source[i + prefix] === '$') { prefix++; }
            const rawAt = i + prefix;
            if (source.slice(rawAt, rawAt + 3) === '"""') {
                let count = 0;
                while (source[rawAt + count] === '"') { count++; }
                const close = source.indexOf('"'.repeat(count), rawAt + count);
                end = close < 0 ? n : close + count;
            } else if (three === '$@"' || three === '@$"') {
                end = quotedEnd(i + 2, '"', true);
            } else if (two === '$"') {
                end = quotedEnd(i + 1, '"');
            } else if (two === '@"') {
                end = quotedEnd(i + 1, '"', true);
            } else if (source[i] === '"' || source[i] === '\'') {
                end = quotedEnd(i, source[i]);
            }
        }
        if (end > i) { blank(i, end); i = end; }
        else { i++; }
    }
    return chars.join('');
}
