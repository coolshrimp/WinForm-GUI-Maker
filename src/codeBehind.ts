// UI Maker — C# code-behind integration.
//
// When the user wires an event in the designer, the XAML gets the attribute
// (done by the webview) and this module makes sure a matching handler method
// exists in the .xaml.cs file, then reveals it in a split editor.

import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * Event -> args type for the generated handler signature. Types are fully
 * qualified so the stub compiles regardless of which using directives the
 * code-behind happens to have (new files import only System.Windows).
 */
const EVENT_ARGS: Record<string, string> = {
    Click: 'System.Windows.RoutedEventArgs',
    Loaded: 'System.Windows.RoutedEventArgs',
    Checked: 'System.Windows.RoutedEventArgs',
    Unchecked: 'System.Windows.RoutedEventArgs',
    GotFocus: 'System.Windows.RoutedEventArgs',
    LostFocus: 'System.Windows.RoutedEventArgs',
    TextChanged: 'System.Windows.Controls.TextChangedEventArgs',
    SelectionChanged: 'System.Windows.Controls.SelectionChangedEventArgs',
    SelectedDateChanged: 'System.Windows.Controls.SelectionChangedEventArgs',
    ValueChanged: 'System.Windows.RoutedPropertyChangedEventArgs<double>',
    KeyDown: 'System.Windows.Input.KeyEventArgs',
    KeyUp: 'System.Windows.Input.KeyEventArgs',
    MouseDown: 'System.Windows.Input.MouseButtonEventArgs',
    MouseUp: 'System.Windows.Input.MouseButtonEventArgs',
    MouseDoubleClick: 'System.Windows.Input.MouseButtonEventArgs',
    Closing: 'System.ComponentModel.CancelEventArgs'
};

/** Valid C# identifier (handler and event names). */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Valid C# type reference: dotted identifiers with optional generics/arrays.
 *  Everything interpolated into generated code must match this. */
const TYPE_REF = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*(<[A-Za-z0-9_.,<> \[\]]+>)?(\[\])?$/;

/**
 * Ensure `handler` exists in the code-behind of `designerPath`, creating a
 * stub when missing, and open the file beside the designer with the method
 * revealed. Works for both designer flavors:
 *   MainWindow.xaml     -> MainWindow.xaml.cs   (WPF)
 *   Main.Designer.cs    -> Main.cs              (WinForms)
 * `argsType` overrides the WPF event->args table (WinForms events send it).
 */
export async function ensureEventHandler(designerPath: string, handler: string, eventName: string, argsType?: string): Promise<void> {
    // The webview is untrusted input — never interpolate anything that is
    // not a plain identifier / type reference into generated C#.
    if (!IDENT.test(handler ?? '')) {
        vscode.window.showWarningMessage(`UI Maker: "${handler}" is not a valid handler name — use letters, digits, and underscores.`);
        return;
    }
    if (!IDENT.test(eventName ?? '')) { return; }
    if (argsType !== undefined && !TYPE_REF.test(argsType)) { argsType = undefined; }

    const csPath = /\.designer\.cs$/i.test(designerPath)
        ? designerPath.replace(/\.designer\.cs$/i, '.cs')
        : `${designerPath}.cs`;
    if (!fs.existsSync(csPath)) {
        vscode.window.showWarningMessage(`UI Maker: no code-behind file found (${csPath}).`);
        return;
    }

    const doc = await vscode.workspace.openTextDocument(csPath);
    let text = doc.getText();

    // Already defined? Just jump to it.
    const existing = new RegExp(`void\\s+${escapeRegExp(handler)}\\s*\\(`).exec(text);
    let revealOffset: number;

    if (existing) {
        revealOffset = existing.index;
    } else {
        const insertAt = findClassEnd(text);
        if (insertAt < 0) {
            vscode.window.showWarningMessage('UI Maker: could not find a class body in the code-behind.');
            return;
        }

        // Match the file's indentation style: members sit one level inside the class.
        const classIndent = lineIndentAt(text, insertAt);
        const indent = classIndent + '    ';
        const args = argsType ?? EVENT_ARGS[eventName] ?? 'System.Windows.RoutedEventArgs';
        const stub =
            `\n${indent}private void ${handler}(object sender, ${args} e)\n` +
            `${indent}{\n` +
            `${indent}    // TODO: handle the ${eventName} event\n` +
            `${indent}}\n${classIndent}`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, doc.positionAt(insertAt), stub);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        text = doc.getText();
        revealOffset = insertAt + stub.indexOf('// TODO');
    }

    const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false
    });
    const pos = doc.positionAt(revealOffset);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/**
 * Offset of the closing brace of the first class declared in the file
 * (works with both block-scoped and file-scoped namespaces), or -1.
 * Braces inside strings, chars, and comments are ignored, so a method
 * containing "{" in a string can never derail the insertion point.
 */
export function findClassEnd(text: string): number {
    const classDecl = /class\s+[A-Za-z_][A-Za-z0-9_]*/.exec(text);
    if (!classDecl) { return -1; }

    const open = text.indexOf('{', classDecl.index);
    if (open < 0) { return -1; }

    let depth = 0;
    let i = open;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        const two = text.substr(i, 2);
        if (two === '//') {                                     // line comment
            const end = text.indexOf('\n', i);
            i = end < 0 ? n : end + 1;
        } else if (two === '/*') {                              // block comment
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? n : end + 2;
        } else if (two === '@"' || text.substr(i, 3) === '$@"' || text.substr(i, 3) === '@$"') {
            let j = i + (ch === '@' ? 2 : 3);                   // verbatim string
            while (j < n) {
                if (text[j] === '"' && text[j + 1] === '"') { j += 2; continue; }
                if (text[j] === '"') { j++; break; }
                j++;
            }
            i = j;
        } else if (ch === '"' || (ch === '$' && text[i + 1] === '"')) {
            let j = i + (ch === '$' ? 2 : 1);                   // regular string
            while (j < n && text[j] !== '"' && text[j] !== '\n') {
                if (text[j] === '\\') { j++; }
                j++;
            }
            i = j < n ? j + 1 : n;
        } else if (ch === '\'') {                               // char literal
            let j = i + 1;
            while (j < n && text[j] !== '\'' && text[j] !== '\n') {
                if (text[j] === '\\') { j++; }
                j++;
            }
            i = j < n ? j + 1 : n;
        } else {
            if (ch === '{') { depth++; }
            else if (ch === '}') {
                depth--;
                if (depth === 0) { return i; }
            }
            i++;
        }
    }
    return -1;
}

/** Leading whitespace of the line containing `offset`. */
function lineIndentAt(text: string, offset: number): string {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
    return match ? match[0] : '';
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
