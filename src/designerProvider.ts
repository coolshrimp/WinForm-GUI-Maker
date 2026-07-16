// UI Maker — custom text editor that hosts the visual designer webview.
//
// The .xaml file remains a plain text document; the webview renders it and
// sends back full replacement text on every design change. Two-way sync:
//   document change  -> postMessage('update')  -> webview re-renders
//   designer change  -> postMessage('edit')    -> WorkspaceEdit on document

import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { ensureEventHandler } from './codeBehind';
import { pickAndImportImage, resolveImages, findProjectDir, ImageKey } from './resources';
import { projectDirOf, setWorkingFolder } from './workingFolder';
import { escapeRegExp, isCSharpIdentifier, renameCSharpIdentifier } from './csharpText';
import { decideDesignerEdit } from './designerSync';

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
        const containingWorkspace = vscode.workspace.getWorkspaceFolder(document.uri);
        if (containingWorkspace) { resourceRoots.push(containingWorkspace.uri); }
        const projDir = findProjectDir(document.uri.fsPath);
        resourceRoots.push(vscode.Uri.file(projDir ?? path.dirname(document.uri.fsPath)));

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: resourceRoots
        };
        panel.webview.html = this.buildHtml(panel.webview);

        DesignerProvider.activeDocumentUri = document.uri;
        const initialProjectDir = projectDirOf(document.uri.fsPath);
        if (initialProjectDir) { setWorkingFolder(initialProjectDir); }

        // One pending designer edit. It is consumed on the matching document
        // event; keeping it beyond that event would hide a later Undo that
        // happens to return to the same text.
        let pendingWebviewText: string | undefined;

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
            const changedText = e.document.getText();
            if (pendingWebviewText !== undefined && changedText === pendingWebviewText) {
                pendingWebviewText = undefined;
                return; // acknowledgement of our own edit
            }
            pendingWebviewText = undefined;
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

        // Serialize webview mutations. WorkspaceEdit is asynchronous; without
        // a queue, a fast drag can apply older full-document text after newer
        // text and make the canvas/document disagree.
        let messageQueue = Promise.resolve();
        subs.push(panel.webview.onDidReceiveMessage((msg: any) => {
            messageQueue = messageQueue
                .then(() => this.handleMessage(
                    msg,
                    document,
                    panel,
                    t => { pendingWebviewText = t; }
                ))
                .catch(err => {
                    pendingWebviewText = undefined;
                    void panel.webview.postMessage({
                        type: 'editResult',
                        ok: false,
                        text: document.getText()
                    });
                    void vscode.window.showWarningMessage(
                        `UI Maker: ${err instanceof Error ? err.message : String(err)}`);
                });
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
        setWebviewText: (t: string | undefined) => void
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
                    if (!isCSharpIdentifier(oldName) || !isCSharpIdentifier(newName)) { break; }

                    // Prefer the installed C# language service. This is a real
                    // symbol rename, so references in other project files and
                    // interpolated/raw strings follow the control just as they
                    // do in Visual Studio. The lexical pair-only path below is
                    // retained for machines without the C# extension.
                    const designerSource = document.getText();
                    const declaration = new RegExp(
                        `\\b(?:private|protected|internal|public)\\s+[\\w.<>,\\[\\]?]+\\s+(${escapeRegExp(oldName)})\\s*;`
                    ).exec(designerSource);
                    if (declaration) {
                        const oldNameOffset = declaration.index + declaration[0].lastIndexOf(oldName);
                        try {
                            const semanticEdit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
                                'vscode.executeDocumentRenameProvider',
                                document.uri,
                                document.positionAt(oldNameOffset),
                                newName
                            );
                            if (semanticEdit) {
                                // C# symbol rename intentionally ignores the
                                // WinForms designer's generated Name string;
                                // Visual Studio changes that identity too.
                                const ownName = new RegExp(
                                    `\\b(?:this\\.)?${escapeRegExp(oldName)}\\.Name\\s*=\\s*"(${escapeRegExp(oldName)})"`
                                ).exec(designerSource);
                                if (ownName) {
                                    const literalOffset = ownName.index + ownName[0].lastIndexOf(`"${oldName}"`) + 1;
                                    semanticEdit.replace(
                                        document.uri,
                                        new vscode.Range(
                                            document.positionAt(literalOffset),
                                            document.positionAt(literalOffset + oldName.length)
                                        ),
                                        newName
                                    );
                                }
                                if (await vscode.workspace.applyEdit(semanticEdit)) { break; }
                            }
                        } catch {
                            // Language service absent/not ready — use the safe
                            // dependency-free fallback below.
                        }
                    }

                    const codePath = document.uri.fsPath.replace(/\.designer\.cs$/i, '.cs');
                    if (codePath.toLowerCase() === document.uri.fsPath.toLowerCase()) { break; }
                    try {
                        const codeUri = vscode.Uri.file(codePath);
                        const codeDoc = await vscode.workspace.openTextDocument(codeUri);
                        const wasDirty = codeDoc.isDirty;
                        const before = codeDoc.getText();
                        const after = renameCSharpIdentifier(before, oldName, newName);
                        if (after !== before) {
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(
                                codeUri,
                                new vscode.Range(codeDoc.positionAt(0), codeDoc.positionAt(before.length)),
                                after
                            );
                            const applied = await vscode.workspace.applyEdit(edit);
                            if (!applied) {
                                void vscode.window.showWarningMessage(
                                    'UI Maker: control references could not be renamed in the code-behind.');
                                break;
                            }
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
                    const current = document.getText();
                    const decision = decideDesignerEdit(current, msg);
                    if (decision === 'invalid') {
                        throw new Error('the designer sent an invalid edit transaction');
                    }
                    const text = msg.text as string;
                    // Apply only against the source revision the canvas
                    // rendered. A newer split-editor change always wins.
                    if (decision === 'conflict') {
                        setWebviewText(undefined);
                        void panel.webview.postMessage({
                            type: 'editResult',
                            ok: false,
                            text: current,
                            reason: 'The source changed before the designer edit could be applied.'
                        });
                        break;
                    }
                    if (decision === 'noop') {
                        setWebviewText(undefined);
                        void panel.webview.postMessage({ type: 'editResult', ok: true, text });
                        break;
                    }
                    setWebviewText(text);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        document.uri,
                        new vscode.Range(document.positionAt(0), document.positionAt(current.length)),
                        text
                    );
                    const ok = await vscode.workspace.applyEdit(edit);
                    if (!ok) {
                        setWebviewText(undefined);
                        void panel.webview.postMessage({
                            type: 'editResult',
                            ok: false,
                            text: document.getText(),
                            reason: 'The file may be read-only.'
                        });
                        void vscode.window.showWarningMessage(
                            'UI Maker: the designer edit could not be applied — the file may be read-only.');
                    } else {
                        void panel.webview.postMessage({ type: 'editResult', ok: true, text });
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
        <div id="ff-toolbar" role="toolbar" aria-label="Designer commands">
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
            <div id="ff-toolbox" role="region" aria-label="Toolbox">
                <div class="ff-panel-title">Toolbox</div>
                <div id="ff-toolbox-items"></div>
            </div>

            <!-- Design surface -->
            <div id="ff-canvas-host" role="region" aria-label="Design surface">
                <div id="ff-banner" role="alert" hidden></div>
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
            <div id="ff-props" role="region" aria-label="Properties and events">
                <div class="ff-tabs" role="tablist" aria-label="Inspector">
                    <button id="ff-tab-props" class="active" role="tab" aria-selected="true">Properties</button>
                    <button id="ff-tab-events" role="tab" aria-selected="false">Events</button>
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

        <div id="ff-status" role="status" aria-live="polite">Ready</div>
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
    return renameCSharpIdentifier(source, oldName, newName);
}

function makeNonce(): string {
    return randomBytes(32).toString('base64url');
}
