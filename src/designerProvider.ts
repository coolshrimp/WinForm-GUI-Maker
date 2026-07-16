// UI Maker — custom text editor that hosts the visual designer webview.
//
// The .xaml file remains a plain text document; the webview renders it and
// sends back full replacement text on every design change. Two-way sync:
//   document change  -> postMessage('update')  -> webview re-renders
//   designer change  -> postMessage('edit')    -> WorkspaceEdit on document

import * as vscode from 'vscode';
import * as path from 'path';
import { ensureEventHandler } from './codeBehind';
import { pickAndImportImage, resolveImages, findProjectDir, ImageKey } from './resources';
import { projectDirOf, setWorkingFolder } from './workingFolder';

export class DesignerProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'uimaker.designer';

    /** Document shown in the most recently focused designer (for commands). */
    public static activeDocumentUri: vscode.Uri | undefined;

    /** Designer clipboard shared across forms (webviews are isolated). */
    private static clipboard: unknown;

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            DesignerProvider.viewType,
            new DesignerProvider(context),
            {
                // Keep designer state (selection, zoom) when the tab is hidden.
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false
            }
        );
    }

    private constructor(private readonly context: vscode.ExtensionContext) { }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // The canvas renders project images (Button.Image, PictureBox, form
        // icons), so the workspace and the form's project folder must be
        // readable by the webview alongside the extension's own media.
        const resourceRoots = [vscode.Uri.joinPath(this.context.extensionUri, 'media')];
        for (const f of vscode.workspace.workspaceFolders ?? []) { resourceRoots.push(f.uri); }
        const projDir = findProjectDir(document.uri.fsPath);
        resourceRoots.push(vscode.Uri.file(projDir ?? path.dirname(document.uri.fsPath)));

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: resourceRoots
        };
        panel.webview.html = this.buildHtml(panel.webview);

        DesignerProvider.activeDocumentUri = document.uri;

        // Text most recently produced BY the webview. Used to break the echo
        // loop: when the document change matches it, the webview already has it.
        let webviewText: string | undefined;

        const postUpdate = () => {
            void panel.webview.postMessage({ type: 'update', text: document.getText() });
        };
        const postConfig = () => {
            const cfg = vscode.workspace.getConfiguration('uimaker');
            void panel.webview.postMessage({
                type: 'config',
                gridSize: cfg.get<number>('gridSize', 8),
                snap: cfg.get<boolean>('snapToGrid', true),
                docName: path.basename(document.uri.fsPath)
            });
        };

        const subs: vscode.Disposable[] = [];

        subs.push(vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() !== document.uri.toString()) { return; }
            if (e.document.getText() === webviewText) { return; } // our own edit
            postUpdate();
        }));

        subs.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('uimaker')) { postConfig(); }
        }));

        subs.push(panel.onDidChangeViewState(() => {
            if (panel.active) {
                DesignerProvider.activeDocumentUri = document.uri;
                // The designer is not a text editor, so the working-folder
                // tracker cannot see it — follow the designed file here.
                const dir = projectDirOf(document.uri.fsPath);
                if (dir) { setWorkingFolder(dir); }
            }
        }));

        subs.push(panel.webview.onDidReceiveMessage(async (msg: any) => {
            try {
                await this.handleMessage(msg, document, panel, t => { webviewText = t; });
            } catch (err) {
                void vscode.window.showWarningMessage(
                    `UI Maker: ${err instanceof Error ? err.message : String(err)}`);
            }
        }));

        panel.onDidDispose(() => {
            if (DesignerProvider.activeDocumentUri?.toString() === document.uri.toString()) {
                DesignerProvider.activeDocumentUri = undefined;
            }
            subs.forEach(d => d.dispose());
        });
    }

    /** One designer→host message. Throwing here surfaces a warning toast. */
    private async handleMessage(
        msg: any,
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel,
        setWebviewText: (t: string) => void
    ): Promise<void> {
        const postConfig = () => {
            const cfg = vscode.workspace.getConfiguration('uimaker');
            void panel.webview.postMessage({
                type: 'config',
                gridSize: cfg.get<number>('gridSize', 8),
                snap: cfg.get<boolean>('snapToGrid', true),
                docName: path.basename(document.uri.fsPath)
            });
        };
        const postUpdate = () => {
            void panel.webview.postMessage({ type: 'update', text: document.getText() });
        };
        switch (msg?.type) {
                // Webview finished loading — send settings and initial content.
                case 'ready':
                    postConfig();
                    postUpdate();
                    if (DesignerProvider.clipboard) {
                        void panel.webview.postMessage({ type: 'clipboard', data: DesignerProvider.clipboard });
                    }
                    break;

                // Designer clipboard (copy on one form, paste on another).
                case 'setClipboard':
                    DesignerProvider.clipboard = msg.data;
                    break;

                // Control rename: the webview already rewrote the Designer.cs;
                // mirror the identifier rename into the code-behind .cs file.
                case 'renameControl': {
                    const { oldName, newName } = msg as { oldName: string; newName: string };
                    if (!/^[A-Za-z_]\w*$/.test(oldName ?? '') || !/^[A-Za-z_]\w*$/.test(newName ?? '')) { break; }
                    const codePath = document.uri.fsPath.replace(/\.designer\.cs$/i, '.cs');
                    if (codePath.toLowerCase() === document.uri.fsPath.toLowerCase()) { break; }
                    try {
                        const codeUri = vscode.Uri.file(codePath);
                        const codeDoc = await vscode.workspace.openTextDocument(codeUri);
                        const wasDirty = codeDoc.isDirty;
                        const before = codeDoc.getText();
                        const after = renameIdentifier(before, oldName, newName);
                        if (after !== before) {
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(codeUri, new vscode.Range(0, 0, codeDoc.lineCount, 0), after);
                            await vscode.workspace.applyEdit(edit);
                            // Save only what we own: if the user already had
                            // unsaved edits, leave the buffer dirty for them.
                            if (!wasDirty) { await codeDoc.save(); }
                        }
                    } catch {
                        // No code-behind next to this designer file — nothing to update.
                    }
                    break;
                }

                // Designer produced new XAML — replace the whole document.
                case 'edit': {
                    const text = msg.text as string;
                    setWebviewText(text);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        document.uri,
                        new vscode.Range(0, 0, document.lineCount, 0),
                        text
                    );
                    const ok = await vscode.workspace.applyEdit(edit);
                    if (!ok) {
                        void vscode.window.showWarningMessage(
                            'UI Maker: the designer edit could not be applied — the file may be read-only.');
                    }
                    break;
                }

                // Split view: open the XAML source next to the designer.
                case 'openCode':
                    await vscode.commands.executeCommand(
                        'vscode.openWith', document.uri, 'default', vscode.ViewColumn.Beside
                    );
                    break;

                // Nothing to design here (App.xaml, resource dictionaries,
                // Designer.cs without InitializeComponent) — close the
                // designer tab and show the plain text editor instead.
                case 'noDesign': {
                    const column = panel.viewColumn ?? vscode.ViewColumn.Active;
                    panel.dispose();
                    await vscode.window.showTextDocument(document.uri, { viewColumn: column, preview: false });
                    break;
                }

                // Event wiring: guarantee the C# handler stub exists.
                case 'addHandler':
                    await ensureEventHandler(document.uri.fsPath, msg.handler, msg.event, msg.argsType);
                    break;

                // Property grid "…" on an Image/Icon property: import the
                // picked file as a project resource and hand back the C#
                // expression plus a URI the canvas can render.
                case 'pickImage': {
                    const res = await pickAndImportImage(document.uri.fsPath, !!msg.iconOnly);
                    if (res) {
                        void panel.webview.postMessage({
                            type: 'imageSet',
                            ctrl: msg.ctrl ?? null,
                            prop: msg.prop,
                            isForm: !!msg.isForm,
                            code: res.code,
                            key: res.key,
                            uri: String(panel.webview.asWebviewUri(vscode.Uri.file(res.fsPath)))
                        });
                    }
                    break;
                }

                // Canvas asks for the images the document references.
                case 'resolveImages': {
                    const resolved = resolveImages(document.uri.fsPath, (msg.keys ?? []) as ImageKey[]);
                    const images: Record<string, string> = {};
                    for (const [k, v] of resolved) {
                        images[k] = v.startsWith('data:') ? v : String(panel.webview.asWebviewUri(vscode.Uri.file(v)));
                    }
                    void panel.webview.postMessage({ type: 'images', images });
                    break;
                }
        }
    }

    /** Static shell page; all designer logic lives in media/designer.js. */
    private buildHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'designer.js'));
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'designer.css'));
        const nonce = makeNonce();

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>UI Maker Designer</title>
</head>
<body>
    <div id="ff-root">
        <!-- Top toolbar: view + canvas options -->
        <div id="ff-toolbar">
            <span class="ff-brand">UI Maker</span>
            <button id="ff-btn-code" title="Open XAML source in a split editor">&lt;/&gt; View Code</button>
            <label class="ff-check"><input type="checkbox" id="ff-snap" checked> Snap</label>
            <label class="ff-field">Grid <input type="number" id="ff-grid" min="1" max="64" value="8"></label>
            <label class="ff-field">Zoom
                <select id="ff-zoom">
                    <option value="0.5">50%</option>
                    <option value="0.75">75%</option>
                    <option value="1" selected>100%</option>
                    <option value="1.25">125%</option>
                    <option value="1.5">150%</option>
                </select>
            </label>
            <button id="ff-btn-taborder" title="Tab order: click controls in the order Tab should visit them (Esc to finish)">⇥ Tab Order</button>
            <span id="ff-align-tools" hidden>
                <button id="ff-al-left" title="Align lefts (to the primary selection)">⫞</button>
                <button id="ff-al-top" title="Align tops">⫠</button>
                <button id="ff-al-right" title="Align rights">⫟</button>
                <button id="ff-al-bottom" title="Align bottoms">⫡</button>
                <button id="ff-al-samew" title="Same width as the primary selection">⇔</button>
                <button id="ff-al-sameh" title="Same height">⇕</button>
                <button id="ff-al-samesize" title="Same size">▣</button>
                <button id="ff-al-disth" title="Distribute horizontally">⇹</button>
                <button id="ff-al-distv" title="Distribute vertically">⇳</button>
            </span>
            <button id="ff-btn-delete" title="Delete selected control (Del)">🗑 Delete</button>
        </div>

        <div id="ff-main">
            <!-- Toolbox: drag controls onto the canvas -->
            <div id="ff-toolbox">
                <div class="ff-panel-title">Toolbox</div>
                <div id="ff-toolbox-items"></div>
            </div>

            <!-- Design surface -->
            <div id="ff-canvas-host">
                <div id="ff-banner" hidden></div>
                <div id="ff-window">
                    <div id="ff-titlebar">
                        <span id="ff-title-text">Window</span>
                        <span class="ff-chrome"><i>─</i><i>□</i><i>✕</i></span>
                    </div>
                    <div id="ff-surface"></div>
                </div>
                <!-- Non-visual components (Timer, ToolTip, dialogs, ...) -->
                <div id="ff-tray" hidden></div>
            </div>

            <!-- Properties / Events -->
            <div id="ff-props">
                <div class="ff-tabs">
                    <button id="ff-tab-props" class="active">Properties</button>
                    <button id="ff-tab-events">Events</button>
                </div>
                <div id="ff-props-target" class="ff-panel-title"></div>
                <div id="ff-props-tools">
                    <button id="ff-sort-cat" class="active" title="Categorized">▤ Categorized</button>
                    <button id="ff-sort-az" title="Alphabetical">A–Z</button>
                </div>
                <div id="ff-props-body"></div>
                <div id="ff-prop-desc"></div>
            </div>
        </div>

        <div id="ff-status">Ready</div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

/**
 * Rename an identifier in C# source, skipping string/char literals and
 * comments — a control rename must never rewrite user-visible text like
 * MessageBox.Show("clicked button1") or notes in comments.
 */
export function renameIdentifier(source: string, oldName: string, newName: string): string {
    const idRe = new RegExp(`\\b${oldName}\\b`, 'g');
    const n = source.length;
    let out = '';
    let codeStart = 0;   // start of the current plain-code run
    let i = 0;

    /** Emit source[codeStart..end) with the rename applied. */
    const flushCode = (end: number) => { out += source.slice(codeStart, end).replace(idRe, newName); };
    /** Emit source[from..to) verbatim and continue scanning at `to`. */
    const skipVerbatim = (from: number, to: number) => {
        flushCode(from);
        out += source.slice(from, to);
        codeStart = i = to;
    };

    while (i < n) {
        const ch = source[i];
        const two = source.substr(i, 2);
        if (two === '//') {                                     // line comment
            let end = source.indexOf('\n', i);
            if (end < 0) { end = n; }
            skipVerbatim(i, end);
        } else if (two === '/*') {                              // block comment
            let end = source.indexOf('*/', i + 2);
            end = end < 0 ? n : end + 2;
            skipVerbatim(i, end);
        } else if (two === '@"' || source.substr(i, 3) === '$@"' || source.substr(i, 3) === '@$"') {
            // Verbatim string: "" is the only escape.
            const open = i + (ch === '@' ? 2 : 3);
            let j = open;
            while (j < n) {
                if (source[j] === '"' && source[j + 1] === '"') { j += 2; continue; }
                if (source[j] === '"') { j++; break; }
                j++;
            }
            skipVerbatim(i, j);
        } else if (ch === '"' || (ch === '$' && source[i + 1] === '"')) {
            // Regular (possibly interpolated) string with backslash escapes.
            let j = i + (ch === '$' ? 2 : 1);
            while (j < n && source[j] !== '"' && source[j] !== '\n') {
                if (source[j] === '\\') { j++; }
                j++;
            }
            if (j < n && source[j] === '"') { j++; }
            skipVerbatim(i, j);
        } else if (ch === '\'') {                               // char literal
            let j = i + 1;
            while (j < n && source[j] !== '\'' && source[j] !== '\n') {
                if (source[j] === '\\') { j++; }
                j++;
            }
            if (j < n && source[j] === '\'') { j++; }
            skipVerbatim(i, j);
        } else {
            i++;
        }
    }
    flushCode(n);
    return out;
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}
