// UI Maker — classic → SDK-style project conversion.
//
// Old .NET Framework projects use the "classic" MSBuild format that modern
// tooling (C# Dev Kit, the dotnet CLI, this extension's NuGet manager) cannot
// load — Dev Kit shows "The project file is in unsupported format". This
// module rewrites such a project as a minimal SDK-style .csproj:
//
//   * same TargetFramework (v4.8 -> net48 etc.), OutputType, names, icon,
//     manifest, startup object, build events;
//   * UseWPF / UseWindowsForms inferred from the old references;
//   * packages.config entries become PackageReference (the config file is
//     renamed to packages.config.bak);
//   * explicit items, metadata, conditions, assembly/COM/project references,
//     and configuration-specific properties are carried over;
//   * GenerateAssemblyInfo=false keeps the existing AssemblyInfo.cs valid.
//
// The original project file is saved next to the new one as
// <name>.csproj.legacy.bak, so the conversion is a two-file rename to undo.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readProjectInfo } from './projectInfo';
import { DotnetTools } from './dotnetTools';

export async function convertToSdkStyle(dotnet: DotnetTools, explicitProject?: string): Promise<void> {
    const project = explicitProject ?? await dotnet.findProject();
    if (!project) { return; }
    if (!/\.(cs|vb)proj$/i.test(project) || !fs.existsSync(project)) {
        vscode.window.showWarningMessage('UI Maker: the selected project no longer exists.');
        return;
    }
    const info = readProjectInfo(project);
    if (!info) {
        vscode.window.showErrorMessage('UI Maker: could not read the project file.');
        return;
    }
    if (info.sdkStyle) {
        vscode.window.showInformationMessage(`UI Maker: ${path.basename(project)} is already an SDK-style project.`);
        return;
    }

    const proceed = 'Convert (backup kept)';
    const choice = await vscode.window.showWarningMessage(
        `Convert ${path.basename(project)} to the modern SDK project format? ` +
        'This fixes the “project file is in unsupported format” warning from C# Dev Kit and enables the NuGet manager here. ' +
        `The original file is kept as ${path.basename(project)}.legacy.bak.`,
        { modal: true },
        proceed
    );
    if (choice !== proceed) { return; }

    try {
        const result = convertProjectFile(project);
        const open = 'Open Project File';
        const build = 'Build Now';
        const notes = result.warnings.length ? ` Notes: ${result.warnings.join(' ')}` : '';
        void vscode.window.showInformationMessage(
            `UI Maker: converted ${path.basename(project)} to SDK style (backup: ${path.basename(result.backup)}).${notes}`,
            open, build
        ).then(pick => {
            if (pick === open) { void vscode.window.showTextDocument(vscode.Uri.file(project)); }
            if (pick === build) { void vscode.commands.executeCommand('uimaker.build'); }
        });
    } catch (err) {
        vscode.window.showErrorMessage(`UI Maker: conversion stopped safely — ${err instanceof Error ? err.message : err}`);
    }
}

interface ConversionResult { backup: string; warnings: string[]; }

interface XmlElement {
    name: string;
    startTag: string;
    inner: string;
    raw: string;
}

interface PackageSpec {
    id: string;
    version: string;
    developmentDependency: boolean;
}

const DEFAULT_ITEM_TYPES = new Set(['compile', 'embeddedresource', 'none', 'page', 'applicationdefinition']);

/** Rewrite one classic .csproj as SDK-style. Throws before writing on error. */
export function convertProjectFile(project: string): ConversionResult {
    if (!/\.(cs|vb)proj$/i.test(project)) { throw new Error('only C#/VB project files can be converted'); }

    const dir = path.dirname(project);
    const xml = fs.readFileSync(project, 'utf8');
    const semanticXml = xml.replace(/<!--[\s\S]*?-->/g, '');
    const eol = xml.includes('\r\n') ? '\r\n' : '\n';
    const warnings: string[] = [];
    const topLevel = parseElements(projectBody(xml), 'project');
    const propertyGroups = topLevel.filter(e => e.name.toLowerCase() === 'propertygroup');

    // A conditional or ambiguous TargetFrameworkVersion cannot be represented
    // faithfully by one SDK-style TargetFramework property. Stop before writing.
    const frameworkVersions: string[] = [];
    for (const group of propertyGroups) {
        const matches = [...group.inner.matchAll(/<TargetFrameworkVersion\b([^>]*)>([\s\S]*?)<\/TargetFrameworkVersion\s*>/gi)];
        if (matches.length && getAttribute(group.startTag, 'Condition')) {
            throw new Error('conditional TargetFrameworkVersion is not supported; convert this project manually');
        }
        for (const match of matches) {
            if (getAttribute(`<TargetFrameworkVersion${match[1]}>`, 'Condition')) {
                throw new Error('conditional TargetFrameworkVersion is not supported; convert this project manually');
            }
            frameworkVersions.push(xmlUnescape(match[2].trim()));
        }
        for (const profile of group.inner.matchAll(/<TargetFrameworkProfile\b[^>]*>([\s\S]*?)<\/TargetFrameworkProfile\s*>/gi)) {
            if (xmlUnescape(profile[1].trim())) {
                throw new Error('TargetFrameworkProfile is not supported by the automatic converter');
            }
        }
    }
    const uniqueFrameworks = [...new Set(frameworkVersions.filter(Boolean))];
    if (uniqueFrameworks.length !== 1 || !/^v\d+(?:\.\d+){1,2}$/i.test(uniqueFrameworks[0])) {
        throw new Error('the project must have one unconditional .NET Framework TargetFrameworkVersion');
    }
    const tfm = `net${uniqueFrameworks[0].replace(/^v/i, '').replace(/\./g, '')}`;

    const prop = (name: string) => {
        const match = new RegExp(`<${name}\\b[^>]*>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(semanticXml);
        return match ? xmlUnescape(match[1]) : '';
    };
    const useWinForms = /<Reference\b[^>]*\bInclude=["']System\.Windows\.Forms(?:,|["'])/i.test(semanticXml)
        || /<UseWindowsForms>\s*true/i.test(semanticXml);
    const useWpf = /<Reference\b[^>]*\bInclude=["']PresentationFramework(?:,|["'])/i.test(semanticXml)
        || /<UseWPF>\s*true/i.test(semanticXml);

    const packagesConfig = path.join(dir, 'packages.config');
    const migratePackages = fs.existsSync(packagesConfig);
    const packages = migratePackages ? readPackagesConfig(packagesConfig) : [];
    const existingPackageIds = new Set<string>();
    const packageReferences: string[] = [];
    const removes = new Set<string>();
    const preservedProperties: string[] = [];
    const preservedItems: string[] = [];
    let hasComReferences = false;

    for (const element of topLevel) {
        const kind = element.name.toLowerCase();
        if (kind === 'propertygroup') {
            let raw = removeElement(rawWithoutOuterIndent(element.raw), 'TargetFrameworkVersion');
            raw = removeElement(raw, 'TargetFrameworkProfile');
            raw = removeElement(raw, 'GenerateAssemblyInfo');
            preservedProperties.push(normalizeEol(raw, eol));
            continue;
        }

        if (kind === 'itemgroup') {
            const kept: string[] = [];
            for (const item of parseElements(element.inner, 'ItemGroup')) {
                const itemKind = item.name.toLowerCase();
                const include = getAttribute(item.startTag, 'Include');

                if (itemKind === 'packagereference' && include) {
                    existingPackageIds.add(include.toLowerCase());
                }
                if (migratePackages && (itemKind === 'none' || itemKind === 'content')
                    && include?.replace(/\\/g, '/').toLowerCase() === 'packages.config') {
                    continue;
                }
                if (itemKind === 'reference') {
                    const hintMatch = /<HintPath\b[^>]*>\s*([^<]+?)\s*<\/HintPath\s*>/i.exec(item.inner);
                    const hint = hintMatch ? xmlUnescape(hintMatch[1]) : undefined;
                    if (migratePackages && hint && /[\\/]packages[\\/]/i.test(hint)) {
                        if (!packagePathMatches(hint, packages)) {
                            throw new Error(`cannot map package reference HintPath "${hint}" to packages.config`);
                        }
                        continue;
                    }
                }
                if (itemKind === 'comreference') { hasComReferences = true; }

                // SDK default globs would otherwise add an explicit classic
                // item twice. Remove the implicit item, then retain the exact
                // original Include, Condition, Link, Generator, and metadata.
                if (include && DEFAULT_ITEM_TYPES.has(itemKind)) {
                    removes.add(`    <${item.name} Remove="${xmlEscape(include)}" />`);
                }
                kept.push(indentXml(normalizeEol(item.raw, eol), 4, eol));
            }
            if (kept.length) {
                preservedItems.push(`${element.startTag}${eol}${kept.join(eol)}${eol}  </ItemGroup>`);
            }
            continue;
        }

        if (kind === 'import') {
            const imported = getAttribute(element.startTag, 'Project') ?? '';
            if (isStandardImport(imported)) { continue; }
            if (migratePackages && isNugetImport(imported, packages)) { continue; }
            throw new Error(`custom import "${imported || element.raw.trim()}" cannot be converted safely`);
        }

        if (kind === 'target' && migratePackages
            && getAttribute(element.startTag, 'Name')?.toLowerCase() === 'ensurenugetpackagebuildimports') {
            continue;
        }

        throw new Error(`top-level <${element.name}> cannot be converted safely; keep the legacy project or migrate it manually`);
    }

    if (hasComReferences) {
        warnings.push('COM references were carried over — they build in Visual Studio/MSBuild but may not with the plain dotnet CLI.');
    }
    if (prop('PreBuildEvent') || prop('PostBuildEvent')) {
        warnings.push('Build events were carried over — check any $(SolutionDir)-style macros they use.');
    }

    for (const pkg of packages) {
        if (existingPackageIds.has(pkg.id.toLowerCase())) { continue; }
        packageReferences.push(pkg.developmentDependency
            ? `    <PackageReference Include="${xmlEscape(pkg.id)}" Version="${xmlEscape(pkg.version)}" PrivateAssets="all" />`
            : `    <PackageReference Include="${xmlEscape(pkg.id)}" Version="${xmlEscape(pkg.version)}" />`);
    }

    const mainProps = [`    <TargetFramework>${xmlEscape(tfm)}</TargetFramework>`];
    if (useWinForms) { mainProps.push('    <UseWindowsForms>true</UseWindowsForms>'); }
    if (useWpf) { mainProps.push('    <UseWPF>true</UseWPF>'); }
    const hasAssemblyInfo = fs.existsSync(path.join(dir, 'Properties', 'AssemblyInfo.cs'))
        || fs.existsSync(path.join(dir, 'My Project', 'AssemblyInfo.vb'))
        || /<Compile\b[^>]*\bInclude=["'][^"']*AssemblyInfo\.(cs|vb)["']/i.test(semanticXml);
    const oldGenerateAssemblyInfo = prop('GenerateAssemblyInfo');
    if (hasAssemblyInfo) { mainProps.push('    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>'); }
    else if (oldGenerateAssemblyInfo) {
        mainProps.push(`    <GenerateAssemblyInfo>${xmlEscape(oldGenerateAssemblyInfo)}</GenerateAssemblyInfo>`);
    }

    const groups: string[] = [
        `  <PropertyGroup>${eol}${mainProps.join(eol)}${eol}  </PropertyGroup>`,
        ...preservedProperties.map(g => indentXml(g, 2, eol))
    ];
    if (removes.size) {
        groups.push(`  <ItemGroup>${eol}${[...removes].join(eol)}${eol}  </ItemGroup>`);
    }
    groups.push(...preservedItems.map(g => indentXml(g, 2, eol)));
    if (packageReferences.length) {
        groups.push(`  <ItemGroup>${eol}${packageReferences.join(eol)}${eol}  </ItemGroup>`);
    }

    const newXml = `<Project Sdk="Microsoft.NET.Sdk">${eol}${eol}${groups.join(eol + eol)}${eol}${eol}</Project>${eol}`;
    const backup = `${project}.legacy.bak`;
    replaceProjectAtomically(project, newXml, backup, migratePackages ? packagesConfig : undefined);
    return { backup, warnings };
}

function projectBody(xml: string): string {
    const open = /<Project\b[^>]*>/i.exec(xml);
    if (!open) { throw new Error('invalid project XML: <Project> was not found'); }
    const closeMatches = [...xml.matchAll(/<\/Project\s*>/gi)];
    const close = closeMatches[closeMatches.length - 1];
    if (!close || close.index === undefined || close.index < open.index + open[0].length) {
        throw new Error('invalid project XML: </Project> was not found');
    }
    return xml.slice(open.index + open[0].length, close.index);
}

/** Parse direct XML child elements while retaining their exact source text. */
function parseElements(fragment: string, context: string): XmlElement[] {
    const elements: XmlElement[] = [];
    let i = 0;
    while (i < fragment.length) {
        if (/\s/.test(fragment[i])) { i++; continue; }
        if (fragment.startsWith('<!--', i)) {
            const end = fragment.indexOf('-->', i + 4);
            if (end < 0) { throw new Error(`invalid XML comment in ${context}`); }
            i = end + 3;
            continue;
        }
        if (fragment.startsWith('<?', i)) {
            const end = fragment.indexOf('?>', i + 2);
            if (end < 0) { throw new Error(`invalid processing instruction in ${context}`); }
            i = end + 2;
            continue;
        }
        if (fragment[i] !== '<') { throw new Error(`unsupported text in ${context}`); }

        const start = i;
        const startEnd = findTagEnd(fragment, start);
        const startTag = fragment.slice(start, startEnd + 1);
        const nameMatch = /^<\s*([A-Za-z_][\w:.-]*)\b/.exec(startTag);
        if (!nameMatch || /^<\s*\//.test(startTag) || /^<\s*!/.test(startTag)) {
            throw new Error(`unsupported XML construct in ${context}`);
        }
        const name = nameMatch[1];
        if (/\/\s*>$/.test(startTag)) {
            elements.push({ name, startTag, inner: '', raw: startTag });
            i = startEnd + 1;
            continue;
        }

        const stack = [name.toLowerCase()];
        let cursor = startEnd + 1;
        let closeStart = -1;
        let closeEnd = -1;
        while (stack.length) {
            const next = fragment.indexOf('<', cursor);
            if (next < 0) { throw new Error(`unclosed <${name}> in ${context}`); }
            if (fragment.startsWith('<!--', next)) {
                const end = fragment.indexOf('-->', next + 4);
                if (end < 0) { throw new Error(`invalid XML comment in ${context}`); }
                cursor = end + 3;
                continue;
            }
            if (fragment.startsWith('<![CDATA[', next)) {
                const end = fragment.indexOf(']]>', next + 9);
                if (end < 0) { throw new Error(`invalid CDATA in ${context}`); }
                cursor = end + 3;
                continue;
            }
            if (fragment.startsWith('<?', next)) {
                const end = fragment.indexOf('?>', next + 2);
                if (end < 0) { throw new Error(`invalid processing instruction in ${context}`); }
                cursor = end + 2;
                continue;
            }
            const tagEnd = findTagEnd(fragment, next);
            const tag = fragment.slice(next, tagEnd + 1);
            const closing = /^<\s*\/\s*([A-Za-z_][\w:.-]*)\s*>$/.exec(tag);
            if (closing) {
                const expected = stack.pop();
                if (closing[1].toLowerCase() !== expected) { throw new Error(`mismatched XML tag in ${context}`); }
                if (!stack.length) { closeStart = next; closeEnd = tagEnd; break; }
            } else if (!/\/\s*>$/.test(tag)) {
                const child = /^<\s*([A-Za-z_][\w:.-]*)\b/.exec(tag);
                if (!child || /^<\s*!/.test(tag)) { throw new Error(`unsupported XML construct in ${context}`); }
                stack.push(child[1].toLowerCase());
            }
            cursor = tagEnd + 1;
        }
        elements.push({
            name,
            startTag,
            inner: fragment.slice(startEnd + 1, closeStart),
            raw: fragment.slice(start, closeEnd + 1)
        });
        i = closeEnd + 1;
    }
    return elements;
}

function findTagEnd(xml: string, start: number): number {
    let quote = '';
    for (let i = start + 1; i < xml.length; i++) {
        const ch = xml[i];
        if (quote) {
            if (ch === quote) { quote = ''; }
        } else if (ch === '"' || ch === '\'') {
            quote = ch;
        } else if (ch === '>') {
            return i;
        }
    }
    throw new Error('unterminated XML tag');
}

function getAttribute(startTag: string, name: string): string | undefined {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(startTag);
    return match ? xmlUnescape(match[1] ?? match[2] ?? '') : undefined;
}

function xmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xmlUnescape(s: string): string {
    return s
        .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function removeElement(xml: string, name: string): string {
    return xml
        .replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}\\s*>`, 'gi'), '')
        .replace(new RegExp(`<${name}\\b[^>]*/\\s*>`, 'gi'), '');
}

function readPackagesConfig(file: string): PackageSpec[] {
    const xml = fs.readFileSync(file, 'utf8');
    const packages = new Map<string, PackageSpec>();
    for (const match of xml.matchAll(/<package\b[^>]*\/?>/gi)) {
        const tag = match[0];
        const id = getAttribute(tag, 'id');
        const version = getAttribute(tag, 'version');
        if (!id || !version) { throw new Error('packages.config contains a package without id/version'); }
        const key = id.toLowerCase();
        if (packages.has(key)) { throw new Error(`packages.config contains duplicate package "${id}"`); }
        packages.set(key, {
            id,
            version,
            developmentDependency: getAttribute(tag, 'developmentDependency')?.toLowerCase() === 'true'
        });
    }
    return [...packages.values()];
}

function packagePathMatches(value: string, packages: PackageSpec[]): boolean {
    const normalized = value.replace(/\\/g, '/').toLowerCase();
    return packages.some(p => normalized.includes(`packages/${`${p.id}.${p.version}`.toLowerCase()}/`));
}

function isStandardImport(value: string): boolean {
    const normalized = value.replace(/\\/g, '/').toLowerCase();
    return normalized.endsWith('/microsoft.csharp.targets')
        || normalized.endsWith('/microsoft.visualbasic.targets')
        || normalized.endsWith('/microsoft.common.props');
}

function isNugetImport(value: string, packages: PackageSpec[]): boolean {
    const normalized = value.replace(/\\/g, '/').toLowerCase();
    return normalized.endsWith('/.nuget/nuget.targets') || packagePathMatches(value, packages);
}

function normalizeEol(text: string, eol: string): string {
    return text.replace(/\r\n|\r|\n/g, eol).trim();
}

function indentXml(text: string, spaces: number, eol: string): string {
    const prefix = ' '.repeat(spaces);
    return text.split(eol).map(line => prefix + line.trimEnd()).join(eol);
}

function rawWithoutOuterIndent(text: string): string {
    return text.trim();
}

/** Write and verify a sibling temp file, then atomically replace the project. */
function replaceProjectAtomically(project: string, contents: string, backup: string, packagesConfig?: string): void {
    const packagesBackup = packagesConfig ? `${packagesConfig}.bak` : undefined;
    if (fs.existsSync(backup)) {
        throw new Error(`${path.basename(backup)} already exists — a previous conversion backup would be overwritten`);
    }
    if (packagesBackup && fs.existsSync(packagesBackup)) {
        throw new Error(`${path.basename(packagesBackup)} already exists — the packages.config backup would be overwritten`);
    }

    const stat = fs.statSync(project);
    if (!stat.isFile()) { throw new Error(`${path.basename(project)} is not a regular file`); }
    const temp = `${project}.uimaker-${process.pid}-${Date.now()}.tmp`;
    let backupCreated = false;
    let packagesMoved = false;
    let fd: number | undefined;
    try {
        fd = fs.openSync(temp, 'wx', stat.mode);
        fs.writeFileSync(fd, contents, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        if (fs.readFileSync(temp, 'utf8') !== contents) { throw new Error('temporary project verification failed'); }

        fs.copyFileSync(project, backup, fs.constants.COPYFILE_EXCL);
        backupCreated = true;
        if (packagesConfig && packagesBackup) {
            fs.renameSync(packagesConfig, packagesBackup);
            packagesMoved = true;
        }
        // rename() is an atomic replacement on the same volume; the original
        // remains intact if this operation fails.
        fs.renameSync(temp, project);
    } catch (err) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
        if (packagesMoved && packagesConfig && packagesBackup) {
            try { fs.renameSync(packagesBackup, packagesConfig); } catch { /* surfaced below */ }
        }
        if (fs.existsSync(temp)) { try { fs.unlinkSync(temp); } catch { /* best effort */ } }
        if (backupCreated && fs.existsSync(project)) {
            try { fs.unlinkSync(backup); } catch { /* keep the safety copy */ }
        }
        throw err;
    }
}
