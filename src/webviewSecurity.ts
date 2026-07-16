import { randomBytes } from 'crypto';

/** Cryptographically strong CSP nonce for one rendered webview document. */
export function webviewNonce(): string {
    return randomBytes(32).toString('base64url');
}
