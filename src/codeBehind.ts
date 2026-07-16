// UI Maker — C# code-behind integration.
//
// When the user wires an event in the designer, the XAML gets the attribute
// (done by the webview) and this module makes sure a matching handler method
// exists in the .xaml.cs file, then reveals it in a split editor.

import * as vscode from 'vscode';
import * as fs from 'fs';

/** Event -> args type for the generated handler signature. */
const EVENT_ARGS: Record<string, string> = {
    Click: 'RoutedEventArgs',
    Loaded: 'RoutedEventArgs',
    Checked: 'RoutedEventArgs',
    Unchecked: 'RoutedEventArgs',
    GotFocus: 'RoutedEventArgs',
    LostFocus: 'RoutedEventArgs',
    TextChanged: 'TextChangedEventArgs',
    SelectionChanged: 'SelectionChangedEventArgs',
    SelectedDateChanged: 'SelectionChangedEventArgs',
    ValueChanged: 'RoutedPropertyChangedEventArgs<double>',
    KeyDown: 'KeyEventArgs',
    KeyUp: 'KeyEventArgs',
    MouseDown: 'MouseButtonEventArgs',
    MouseUp: 'MouseButtonEventArgs',
    MouseDoubleClick: 'MouseButtonEventArgs',
    Closing: 'System.ComponentModel.CancelEventArgs'
};

/**
 * Ensure `handler` exists in the code-behind of `designerPath`, creating a
 * stub when missing, and open the file beside the designer with the method
 * revealed. Works for both designer flavors:
 *   MainWindow.xaml     -> MainWindow.xaml.cs   (WPF)
 *   Main.Designer.cs    -> Main.cs              (WinForms)
 * `argsType` overrides the WPF event->args table (WinForms events send it).
 */
export async function ensureEventHandler(designerPath: string, handler: string, eventName: string, argsType?: string): Promise<void> {
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
        const args = argsType ?? EVENT_ARGS[eventName] ?? 'RoutedEventArgs';
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
 */
function findClassEnd(text: string): number {
    const classDecl = /class\s+[A-Za-z_][A-Za-z0-9_]*/.exec(text);
    if (!classDecl) { return -1; }

    const open = text.indexOf('{', classDecl.index);
    if (open < 0) { return -1; }

    // Brace-count to the matching close. Naive about strings/comments, which
    // is acceptable for typical designer code-behind files.
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') { depth++; }
        else if (ch === '}') {
            depth--;
            if (depth === 0) { return i; }
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
