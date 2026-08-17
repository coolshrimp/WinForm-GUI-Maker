// UI Maker — XAML IntelliSense for the plain text editor.
//
// Makes hand-editing .xaml comfortable without Visual Studio:
//   * Completion: element names after "<", closing tags after "</", attribute
//     names inside a tag, and attribute values (enum members, True/False,
//     named colors) inside quotes.
//   * Snippets: ready-made blocks (Grid with rows, menu bar, OK/Cancel row…)
//     offered in child/text positions.
//   * Hover: plain-English documentation for elements and attributes.
//   * Color: every Background/Foreground/Fill/… value gets an inline swatch
//     and VS Code's native color picker — pick a color, the hex is written.
//
// All the metadata + string analysis lives in xamlLanguageData.ts (pure,
// unit-tested); this file is only the vscode plumbing.

import * as vscode from 'vscode';
import {
    analyzeContext, attributesForElement, valuesForAttribute, openTagStack,
    parseXamlColor, formatXamlColor,
    ELEMENTS, SNIPPETS, NAMED_COLORS, COLOR_ATTRIBUTES, COMMON_PROPERTIES
} from './xamlLanguageData';

/** Both saved .xaml files and not-yet-saved editors. */
const XAML_SELECTOR: vscode.DocumentSelector = [
    { scheme: 'file', pattern: '**/*.xaml' },
    { scheme: 'untitled', pattern: '**/*.xaml' }
];

function enabled(): boolean {
    return vscode.workspace.getConfiguration('uimaker').get<boolean>('xamlIntelliSense', true);
}

export function registerXamlIntellisense(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            XAML_SELECTOR, new XamlCompletionProvider(), '<', '/', ' ', '"', '.', '='
        ),
        vscode.languages.registerHoverProvider(XAML_SELECTOR, new XamlHoverProvider()),
        vscode.languages.registerColorProvider(XAML_SELECTOR, new XamlColorProvider())
    );
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

class XamlCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] | undefined {
        if (!enabled()) { return undefined; }
        const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const ctx = analyzeContext(before);

        switch (ctx.kind) {
            case 'closingTag': return this.closingTagItems(before);
            case 'element': return [...this.elementItems(), ...this.snippetItems()];
            case 'attribute': return this.attributeItems(ctx.elementName ?? '', document, position);
            case 'attributeValue': return this.valueItems(ctx.elementName ?? '', ctx.attributeName ?? '');
            case 'text': return [...this.snippetItems(), ...this.elementItems(true)];
        }
    }

    /** "</" → close the innermost still-open tag (plus any outer ones). */
    private closingTagItems(before: string): vscode.CompletionItem[] {
        const stack = openTagStack(before.slice(0, before.lastIndexOf('<')));
        const seen = new Set<string>();
        const items: vscode.CompletionItem[] = [];
        for (let i = stack.length - 1; i >= 0; i--) {
            const name = stack[i];
            if (seen.has(name)) { continue; }
            seen.add(name);
            const item = new vscode.CompletionItem(name + '>', vscode.CompletionItemKind.Property);
            item.detail = i === stack.length - 1 ? 'Close tag (innermost open)' : 'Close tag';
            item.sortText = String(stack.length - i).padStart(3, '0');
            items.push(item);
        }
        return items;
    }

    /** Element name completions after "<" (or with the bracket in text position). */
    private elementItems(includeBracket = false): vscode.CompletionItem[] {
        return Object.entries(ELEMENTS).map(([name, info]) => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
            item.detail = info.container ? 'WPF container' : 'WPF element';
            item.documentation = new vscode.MarkdownString(info.doc);
            // Containers get an open/close pair, leaf elements self-close.
            const open = includeBracket ? '<' + name : name;
            item.insertText = new vscode.SnippetString(
                info.container ? `${open} $1>\n\t$0\n</${name}>` : `${open} $1/>$0`
            );
            // Let plain "Button" + Tab keep working: also match without '<'.
            item.filterText = name;
            return item;
        });
    }

    /** Attribute name completions inside an open tag. */
    private attributeItems(
        elementName: string,
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        // Skip attributes already present on this tag.
        const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const tagText = before.slice(before.lastIndexOf('<'));
        const used = new Set([...tagText.matchAll(/([\w.:-]+)\s*=/g)].map(m => m[1]));

        return attributesForElement(elementName)
            .filter(a => !used.has(a.name))
            .map(({ name, info }) => {
                const kind = info.type === 'event'
                    ? vscode.CompletionItemKind.Event
                    : vscode.CompletionItemKind.Property;
                const item = new vscode.CompletionItem(name, kind);
                item.detail = info.type === 'event' ? `event` : info.type;
                if (info.doc) { item.documentation = new vscode.MarkdownString(info.doc); }
                item.insertText = new vscode.SnippetString(`${name}="$1"$0`);
                // Events sort after properties, common attached props last.
                item.sortText = (info.type === 'event' ? '2' : name.includes('.') ? '3' : '1') + name;
                // Enum/bool/color values exist → pop the value list right away.
                if (info.values || info.type === 'brush' || info.type === 'color') {
                    item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest values' };
                }
                return item;
            });
    }

    /** Attribute value completions inside quotes. */
    private valueItems(elementName: string, attributeName: string): vscode.CompletionItem[] {
        const { values, isColor } = valuesForAttribute(elementName, attributeName);
        return values.map((value, i) => {
            const item = new vscode.CompletionItem(
                value,
                isColor ? vscode.CompletionItemKind.Color : vscode.CompletionItemKind.EnumMember
            );
            if (isColor) {
                // VS Code renders a swatch when documentation is a plain hex string.
                const hex = NAMED_COLORS[value];
                item.documentation = hex.length === 9 ? hex.slice(0, 1) + hex.slice(3) : hex;
            }
            item.sortText = String(i).padStart(3, '0');
            return item;
        });
    }

    /** Ready-made block snippets, offered in child/element positions. */
    private snippetItems(): vscode.CompletionItem[] {
        return SNIPPETS.map(s => {
            const item = new vscode.CompletionItem(s.prefix, vscode.CompletionItemKind.Snippet);
            item.detail = `UI Maker: ${s.label}`;
            item.documentation = new vscode.MarkdownString(s.doc + '\n\n```xml\n' + previewOf(s.body) + '\n```');
            item.insertText = new vscode.SnippetString(s.body);
            item.sortText = 'zz' + s.prefix; // group snippets after the element list
            return item;
        });
    }
}

/** Strip snippet placeholders for the documentation preview. */
function previewOf(body: string): string {
    return body
        .replace(/\$\{\d+:([^}]*)\}/g, '$1')
        .replace(/\$\d+/g, '');
}

// ---------------------------------------------------------------------------
// Hover documentation
// ---------------------------------------------------------------------------

class XamlHoverProvider implements vscode.HoverProvider {
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        if (!enabled()) { return undefined; }
        const wordRange = document.getWordRangeAtPosition(position, /[\w.:]+/);
        if (!wordRange) { return undefined; }
        const word = document.getText(wordRange);
        const line = document.lineAt(position.line).text;
        const charBefore = wordRange.start.character > 0 ? line[wordRange.start.character - 1] : '';

        // Element hover: word directly follows '<' or '</'.
        if (charBefore === '<' || (charBefore === '/' && line[wordRange.start.character - 2] === '<')) {
            const info = ELEMENTS[word];
            if (info) {
                const md = new vscode.MarkdownString();
                md.appendMarkdown(`**${word}** — ${info.doc}`);
                return new vscode.Hover(md, wordRange);
            }
            return undefined;
        }

        // Attribute hover: word is followed by '='.
        const after = line.slice(wordRange.end.character).trimStart();
        if (after.startsWith('=')) {
            const before = document.getText(new vscode.Range(new vscode.Position(0, 0), wordRange.start));
            const ctx = analyzeContext(before);
            const element = ctx.elementName ?? '';
            const attr = attributesForElement(element).find(a => a.name === word)
                ?? (COMMON_PROPERTIES[word] ? { name: word, info: COMMON_PROPERTIES[word] } : undefined);
            if (attr) {
                const md = new vscode.MarkdownString();
                const kind = attr.info.type === 'event' ? 'event' : `property · ${attr.info.type}`;
                md.appendMarkdown(`**${word}** *(${kind})*`);
                if (attr.info.doc) { md.appendMarkdown(`\n\n${attr.info.doc}`); }
                if (attr.info.values && attr.info.type === 'enum') {
                    md.appendMarkdown(`\n\nValues: ${attr.info.values.map(v => '`' + v + '`').join(', ')}`);
                }
                return new vscode.Hover(md, wordRange);
            }
        }
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Inline color swatches + picker
// ---------------------------------------------------------------------------

class XamlColorProvider implements vscode.DocumentColorProvider {
    provideDocumentColors(document: vscode.TextDocument): vscode.ColorInformation[] {
        if (!enabled()) { return []; }
        const out: vscode.ColorInformation[] = [];
        const text = document.getText();
        // Attribute="value" pairs where the attribute is brush/color-typed.
        const re = /([\w.]+)\s*=\s*"([^"{}]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const attrName = m[1].includes('.') ? m[1].split('.').pop()! : m[1];
            if (!COLOR_ATTRIBUTES.has(attrName)) { continue; }
            const value = m[2];
            const rgba = parseXamlColor(value);
            if (!rgba) { continue; }
            const valueStart = m.index + m[0].length - value.length - 1;
            out.push(new vscode.ColorInformation(
                new vscode.Range(document.positionAt(valueStart), document.positionAt(valueStart + value.length)),
                new vscode.Color(rgba.r, rgba.g, rgba.b, rgba.a)
            ));
        }
        return out;
    }

    provideColorPresentations(color: vscode.Color): vscode.ColorPresentation[] {
        const hex = formatXamlColor(color.red, color.green, color.blue, color.alpha);
        const presentations = [new vscode.ColorPresentation(hex)];
        // Exact named-color match? Offer the friendly name too.
        const named = Object.entries(NAMED_COLORS).find(([, v]) => v.toUpperCase() === hex.toUpperCase());
        if (named) { presentations.unshift(new vscode.ColorPresentation(named[0])); }
        return presentations;
    }
}
