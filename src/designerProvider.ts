// UI Maker — custom text editor that hosts the visual designer webview.
//
// The .xaml file remains a plain text document; the webview renders it and
// sends back full replacement text on every design change. Two-way sync:
//   document change  -> postMessage('update')  -> webview re-renders
//   designer change  -> postMessage('edit')    -> WorkspaceEdit on document

import * as vscode from 'vscode';
import * as path from 'path';
import { ensureEventHandler } from './codeBehind';

export class DesignerProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'formforge.designer';

    /** Document shown in the most recently focused designer (for commands). */
    public static activeDocumentUri: vscode.Uri | undefined;

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
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
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
            const cfg = vscode.workspace.getConfiguration('formforge');
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
            if (e.affectsConfiguration('formforge')) { postConfig(); }
        }));

        subs.push(panel.onDidChangeViewState(() => {
            if (panel.active) {
                DesignerProvider.activeDocumentUri = document.uri;
            }
        }));

        subs.push(panel.webview.onDidReceiveMessage(async (msg: any) => {
            switch (msg?.type) {
                // Webview finished loading — send settings and initial content.
                case 'ready':
                    postConfig();
                    postUpdate();
                    break;

                // Designer produced new XAML — replace the whole document.
                case 'edit': {
                    webviewText = msg.text as string;
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(
                        document.uri,
                        new vscode.Range(0, 0, document.lineCount, 0),
                        webviewText
                    );
                    await vscode.workspace.applyEdit(edit);
                    break;
                }

                // Split view: open the XAML source next to the designer.
                case 'openCode':
                    await vscode.commands.executeCommand(
                        'vscode.openWith', document.uri, 'default', vscode.ViewColumn.Beside
                    );
                    break;

                // Event wiring: guarantee the C# handler stub exists.
                case 'addHandler':
                    await ensureEventHandler(document.uri.fsPath, msg.handler, msg.event, msg.argsType);
                    break;
            }
        }));

        panel.onDidDispose(() => {
            if (DesignerProvider.activeDocumentUri?.toString() === document.uri.toString()) {
                DesignerProvider.activeDocumentUri = undefined;
            }
            subs.forEach(d => d.dispose());
        });
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
            </div>

            <!-- Properties / Events -->
            <div id="ff-props">
                <div class="ff-tabs">
                    <button id="ff-tab-props" class="active">Properties</button>
                    <button id="ff-tab-events">Events</button>
                </div>
                <div id="ff-props-target" class="ff-panel-title"></div>
                <div id="ff-props-body"></div>
            </div>
        </div>

        <div id="ff-status">Ready</div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}
