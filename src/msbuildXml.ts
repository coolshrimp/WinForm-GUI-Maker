import { decodeXmlEntities } from './xmlText';

function xmlEscape(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unconditionalPropertyGroups(xml: string): RegExpMatchArray[] {
    return [...xml.matchAll(/<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi)]
        .filter(group => !/\bCondition\s*=/i.test(group[1]));
}

/** First simple property value from an unconditional group. */
export function getMsbuildProperty(xml: string, name: string): string {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) { return ''; }
    const property = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`);
    for (const group of unconditionalPropertyGroups(xml)) {
        const value = property.exec(group[2])?.[1];
        if (value !== undefined) { return decodeXmlEntities(value); }
    }
    return '';
}

/**
 * Set/update/remove one simple MSBuild property in an unconditional group.
 * Values are escaped and replacement tokens such as $& remain literal.
 */
export function setMsbuildProperty(xml: string, name: string, value: string): string {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) { return xml; }
    const property = new RegExp(`(<${name}>)\\s*[\\s\\S]*?\\s*(</${name}>)`);
    const groups = unconditionalPropertyGroups(xml);

    if (value === '') {
        if (name === 'TargetFramework' || name === 'TargetFrameworks' || name === 'TargetFrameworkVersion') {
            return xml;
        }
        let result = xml;
        const line = new RegExp(`[ \\t]*<${name}>[\\s\\S]*?</${name}>[ \\t]*\\r?\\n?`);
        for (const group of groups.reverse()) {
            if (group.index === undefined || !line.test(group[2])) { continue; }
            const innerStart = group.index + group[0].indexOf('>') + 1;
            const updatedInner = group[2].replace(line, '');
            result = `${result.slice(0, innerStart)}${updatedInner}${result.slice(innerStart + group[2].length)}`;
        }
        return result;
    }

    const escaped = xmlEscape(value);
    const existingGroup = groups.find(group => property.test(group[2]));
    if (existingGroup?.index !== undefined) {
        const innerStart = existingGroup.index + existingGroup[0].indexOf('>') + 1;
        const updatedInner = existingGroup[2].replace(property, (_match, open: string, close: string) =>
            `${open}${escaped}${close}`);
        return `${xml.slice(0, innerStart)}${updatedInner}${xml.slice(innerStart + existingGroup[2].length)}`;
    }

    const eol = xml.includes('\r\n') ? '\r\n' : '\n';
    const group = /<PropertyGroup\b(?![^>]*\bCondition\s*=)[^>]*>/i.exec(xml);
    if (group) {
        const at = group.index + group[0].length;
        return `${xml.slice(0, at)}${eol}    <${name}>${escaped}</${name}>${xml.slice(at)}`;
    }
    return xml.replace(/<\/Project>/,
        `  <PropertyGroup>${eol}    <${name}>${escaped}</${name}>${eol}  </PropertyGroup>${eol}</Project>`);
}
