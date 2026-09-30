import * as fs from 'fs';
import * as path from 'path';
import { decodeXmlEntities } from './xmlText';

/** Load local dictionaries in dependency order, followed by their overrides. */
export function xamlResourcesFor(docPath: string, projectDir: string, documentText: string): string[] {
    const texts: string[] = [];
    const active = new Set<string>();
    const clean = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '');
    function visit(file: string, supplied?: string, include = true): void {
        const key = path.resolve(file).toLowerCase();
        if (active.has(key)) { return; }
        active.add(key);
        try {
            const text = supplied ?? fs.readFileSync(file, 'utf8');
            for (const tag of clean(text).matchAll(/<(?:\w+:)?ResourceDictionary\b[^>]*>/g)) {
                const source = /\bSource\s*=\s*(["'])(.*?)\1/.exec(tag[0]);
                if (!source) { continue; }
                let relative = decodeXmlEntities(source[2]);
                const rooted = /^pack:\/\/application:,,,\//i.test(relative) || relative.startsWith('/');
                relative = relative.replace(/^pack:\/\/application:,,,\//i, '').replace(/^\//, '');
                // Assembly resources and remote URIs cannot be read as local files.
                if (relative.includes(';component') || /^[\w+.-]+:/.test(relative)) { continue; }
                visit(path.resolve(rooted ? projectDir : path.dirname(file), relative));
            }
            if (include) { texts.push(text); }
        } catch { /* A missing dictionary must not hide the remaining resources. */ }
        finally { active.delete(key); }
    }
    for (const name of fs.readdirSync(projectDir)) {
        if (!/\.xaml$/i.test(name)) { continue; }
        const file = path.join(projectDir, name);
        try {
            const text = fs.readFileSync(file, 'utf8');
            if (/<Application[\s>]/.test(clean(text))) { visit(file, text); break; }
        } catch { /* Skip unreadable entries. */ }
    }
    // The webview already has the document itself, including unsaved edits.
    visit(docPath, documentText, false);
    return texts;
}
