/** Pure decision logic for full-document designer edits. */
export type DesignerEditDecision = 'invalid' | 'conflict' | 'noop' | 'apply';

export interface DesignerEditEnvelope {
    text?: unknown;
    baseText?: unknown;
}

/**
 * A visual edit is an optimistic transaction: it may replace the document
 * only when the current source is byte-for-byte the revision the canvas used.
 */
export function decideDesignerEdit(
    currentText: string,
    message: DesignerEditEnvelope
): DesignerEditDecision {
    if (typeof message.text !== 'string' || typeof message.baseText !== 'string') {
        return 'invalid';
    }
    // Concurrent paths can legitimately converge (for example, a semantic
    // C# rename and the designer's surgical rewrite). No replacement is
    // needed when both already produced the same document.
    if (message.text === currentText) { return 'noop'; }
    if (message.baseText !== currentText) { return 'conflict'; }
    return 'apply';
}
