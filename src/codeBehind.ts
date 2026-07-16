// UI Maker — C# code-behind integration.
//
// When the user wires an event in the designer, the XAML gets the attribute
// (done by the webview) and this module makes sure a matching handler method
// exists in the .xaml.cs file, then reveals it in a split editor.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findCSharpClassEnd, findCSharpVoidMethod, isCSharpIdentifier } from './csharpText';
import { decodeXmlEntities } from './xmlText';

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
    if (!isCSharpIdentifier(handler)) {
        vscode.window.showWarningMessage(`UI Maker: "${handler}" is not a valid handler name — use a non-keyword C# identifier.`);
        return;
    }
    if (!isCSharpIdentifier(eventName)) { return; }
    if (argsType !== undefined && !TYPE_REF.test(argsType)) { argsType = undefined; }

    const csPath = /\.designer\.cs$/i.test(designerPath)
        ? designerPath.replace(/\.designer\.cs$/i, '.cs')
        : `${designerPath}.cs`;
    if (!fs.existsSync(csPath)) {
        vscode.window.showWarningMessage(`UI Maker: no code-behind file found (${csPath}).`);
        return;
    }

    const doc = await vscode.workspace.openTextDocument(csPath);
    const wasDirty = doc.isDirty;
    let text = doc.getText();
    const targetClass = designerClassName(designerPath);

    // Already defined? Just jump to it.
    const existing = findCSharpVoidMethod(text, handler, targetClass);
    let revealOffset: number;

    if (existing >= 0) {
        revealOffset = existing;
    } else {
        const insertAt = findCSharpClassEnd(text, targetClass);
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
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showWarningMessage('UI Maker: the event handler could not be added — the code-behind may be read-only.');
            return;
        }
        // Do not silently commit unrelated edits the user already had in this
        // buffer. Clean generated files are still saved for project systems
        // that inspect the on-disk file.
        if (!wasDirty) { await doc.save(); }
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

/** Class that owns the designer surface, even when it differs from the file name. */
function designerClassName(designerPath: string): string | undefined {
    try {
        const source = fs.readFileSync(designerPath, 'utf8');
        if (/\.xaml$/i.test(designerPath)) {
            const qualified = /\b[A-Za-z_][A-Za-z0-9_]*:Class\s*=\s*["']([^"']+)["']/.exec(source)?.[1];
            const name = qualified ? decodeXmlEntities(qualified).split(/[.+]/).pop() : undefined;
            if (isCSharpIdentifier(name)) { return name; }
        } else {
            const declared = /\bpartial\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(source)?.[1];
            if (isCSharpIdentifier(declared)) { return declared; }
        }
    } catch { /* use the conventional file name */ }
    const base = /\.designer\.cs$/i.test(designerPath)
        ? path.basename(designerPath).replace(/\.designer\.cs$/i, '')
        : path.basename(designerPath, path.extname(designerPath));
    return isCSharpIdentifier(base) ? base : undefined;
}

/**
 * Offset of the closing brace of the first class declared in the file
 * (works with both block-scoped and file-scoped namespaces), or -1.
 * Braces inside strings, chars, and comments are ignored, so a method
 * containing "{" in a string can never derail the insertion point.
 */
export function findClassEnd(text: string, className?: string): number {
    return findCSharpClassEnd(text, className);
}

/** Leading whitespace of the line containing `offset`. */
function lineIndentAt(text: string, offset: number): string {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
    return match ? match[0] : '';
}
