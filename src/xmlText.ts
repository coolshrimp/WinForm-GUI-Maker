/** Decode XML character/entity references found in simple project attributes/text. */
export function decodeXmlEntities(value: string): string {
    const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: '\''
    };
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, token: string) => {
        if (token[0] !== '#') { return named[token.toLowerCase()] ?? whole; }
        const codePoint = token[1].toLowerCase() === 'x'
            ? Number.parseInt(token.slice(2), 16)
            : Number.parseInt(token.slice(1), 10);
        if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
            || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
            return whole;
        }
        return String.fromCodePoint(codePoint);
    });
}
