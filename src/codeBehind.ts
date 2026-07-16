// UI Maker — C# code-behind integration.
//
// When the user wires an event in the designer, the XAML gets the attribute
// (done by the webview) and this module makes sure a matching handler method
// exists in the .xaml.cs file, then reveals it in a split editor.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { findCSharpClassEnd, findCSharpVoidMethod, isCSharpIdentifier } from './csharpText';
import {
    addVbHandlesTarget, findVbClassBounds, findVbSub, isVbHandlesTarget,
    isVbIdentifier, removeVbHandlesTarget
} from './vbText';
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

/** Code-behind path for a designer document, honoring the file's language:
 *  Main.Designer.cs -> Main.cs, Main.Designer.vb -> Main.vb,
 *  Window.xaml -> Window.xaml.cs (or .xaml.vb when that is what exists). */
export function codeBehindPathOf(designerPath: string): string {
    if (/\.designer\.cs$/i.test(designerPath)) { return designerPath.replace(/\.designer\.cs$/i, '.cs'); }
    if (/\.designer\.vb$/i.test(designerPath)) { return designerPath.replace(/\.designer\.vb$/i, '.vb'); }
    const vb = `${designerPath}.vb`;
    return !fs.existsSync(`${designerPath}.cs`) && fs.existsSync(vb) ? vb : `${designerPath}.cs`;
}

/**
 * Ensure `handler` exists in the code-behind of `designerPath`, creating a
 * stub when missing, and open the file beside the designer with the method
 * revealed. Works for every designer flavor:
 *   MainWindow.xaml     -> MainWindow.xaml.cs / .xaml.vb   (WPF)
 *   Main.Designer.cs    -> Main.cs                          (WinForms C#)
 *   Main.Designer.vb    -> Main.vb                          (WinForms VB)
 * `argsType` overrides the WPF event->args table (WinForms events send it).
 * `options.handles` is the VB Handles target ("Button1.Click" / "MyBase.Load");
 * `options.reveal: false` wires without opening the code-behind.
 */
export async function ensureEventHandler(
    designerPath: string,
    handler: string,
    eventName: string,
    argsType?: string,
    options?: { handles?: string; reveal?: boolean }
): Promise<void> {
    if (argsType !== undefined && !TYPE_REF.test(argsType)) { argsType = undefined; }

    const csPath = codeBehindPathOf(designerPath);
    const isVb = /\.vb$/i.test(csPath);

    // The webview is untrusted input — never interpolate anything that is
    // not a plain identifier / type reference into generated code.
    const validName = isVb ? isVbIdentifier(handler) : isCSharpIdentifier(handler);
    if (!validName) {
        vscode.window.showWarningMessage(
            `UI Maker: "${handler}" is not a valid handler name — use a non-keyword ${isVb ? 'Visual Basic' : 'C#'} identifier.`);
        return;
    }
    const validEvent = isVb ? isVbIdentifier(eventName) : isCSharpIdentifier(eventName);
    if (!validEvent) { return; }

    if (!fs.existsSync(csPath)) {
        vscode.window.showWarningMessage(`UI Maker: no code-behind file found (${csPath}).`);
        return;
    }
    if (isVb) {
        return ensureVbEventHandler(csPath, designerPath, handler, eventName, argsType, options);
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
    const isIdentifier = (name: string | undefined) =>
        /\.vb$/i.test(designerPath) ? isVbIdentifier(name) : isCSharpIdentifier(name);
    try {
        const source = fs.readFileSync(designerPath, 'utf8');
        if (/\.xaml$/i.test(designerPath)) {
            const qualified = /\b[A-Za-z_][A-Za-z0-9_]*:Class\s*=\s*["']([^"']+)["']/.exec(source)?.[1];
            const name = qualified ? decodeXmlEntities(qualified).split(/[.+]/).pop() : undefined;
            if (isIdentifier(name)) { return name; }
        } else if (/\.designer\.vb$/i.test(designerPath)) {
            const declared = /\bPartial\s+(?:Public\s+|Friend\s+)?Class\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(source)?.[1];
            if (isVbIdentifier(declared)) { return declared; }
        } else {
            const declared = /\bpartial\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(source)?.[1];
            if (isCSharpIdentifier(declared)) { return declared; }
        }
    } catch { /* use the conventional file name */ }
    const base = /\.designer\.(cs|vb)$/i.test(designerPath)
        ? path.basename(designerPath).replace(/\.designer\.(cs|vb)$/i, '')
        : path.basename(designerPath, path.extname(designerPath));
    return isIdentifier(base) ? base : undefined;
}

// ------------------------------------------------------------- Visual Basic

/**
 * VB event wiring lives in the code-behind: `Sub Handler(...) Handles a.B`.
 * Wiring therefore means editing the .vb file — move the Handles target onto
 * the requested handler (creating a stub when it does not exist yet).
 */
async function ensureVbEventHandler(
    csPath: string,
    designerPath: string,
    handler: string,
    eventName: string,
    argsType: string | undefined,
    options?: { handles?: string; reveal?: boolean }
): Promise<void> {
    const handles = options?.handles;
    if (handles !== undefined && !isVbHandlesTarget(handles)) { return; }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));
    const wasDirty = doc.isDirty;
    const before = doc.getText();
    const targetClass = designerClassName(designerPath);

    let after = handles ? removeVbHandlesTarget(before, handles, handler) : before;
    let revealOffset = findVbSub(after, handler, targetClass);

    if (revealOffset >= 0) {
        // Handler exists — make sure it handles this event (WinForms only).
        if (handles) {
            const wired = addVbHandlesTarget(after, handler, handles);
            if (wired !== null) { after = wired; }
        }
    } else {
        const bounds = findVbClassBounds(after, targetClass);
        if (!bounds) {
            vscode.window.showWarningMessage('UI Maker: could not find a class body in the code-behind.');
            return;
        }
        const lineStart = after.lastIndexOf('\n', bounds.end - 1) + 1;
        const classIndent = /^[ \t]*/.exec(after.slice(lineStart, bounds.end))?.[0] ?? '';
        const indent = classIndent + '    ';
        const args = argsType ?? EVENT_ARGS[eventName] ?? 'System.EventArgs';
        const stub =
            `\n${indent}Private Sub ${handler}(sender As Object, e As ${args})${handles ? ` Handles ${handles}` : ''}\n` +
            `${indent}    ' TODO: handle the ${eventName} event\n` +
            `${indent}End Sub\n`;
        after = `${after.slice(0, lineStart)}${stub.replace(/^\n/, '')}\n${after.slice(lineStart)}`;
        revealOffset = lineStart + stub.indexOf("' TODO") - 1;
    }

    if (after !== before) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), after);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            vscode.window.showWarningMessage('UI Maker: the event handler could not be added — the code-behind may be read-only.');
            return;
        }
        if (!wasDirty) { await doc.save(); }
    }

    if (options?.reveal === false) { return; }
    const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false
    });
    const at = findVbSub(doc.getText(), handler, targetClass);
    const pos = doc.positionAt(Math.max(0, at >= 0 ? at : revealOffset));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/**
 * Unwire a VB event: remove `handles` (e.g. "Button1.Click") from every
 * Handles clause in the code-behind. The handler methods themselves stay —
 * exactly what Visual Studio does when an event is cleared in the grid.
 */
export async function removeEventHandles(designerPath: string, handles: string): Promise<void> {
    if (!isVbHandlesTarget(handles)) { return; }
    const csPath = codeBehindPathOf(designerPath);
    if (!/\.vb$/i.test(csPath) || !fs.existsSync(csPath)) { return; }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(csPath));
    const wasDirty = doc.isDirty;
    const before = doc.getText();
    const after = removeVbHandlesTarget(before, handles);
    if (after === before) { return; }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), after);
    if (await vscode.workspace.applyEdit(edit) && !wasDirty) { await doc.save(); }
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
