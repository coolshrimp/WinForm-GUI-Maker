// UI Maker — .NET project inspection helpers.
//
// Reads a .csproj/.vbproj and answers the questions the rest of the extension
// keeps asking: SDK-style or classic? Which framework? WPF or WinForms?
// Also hosts the ".NET Framework on any machine" build protections:
//   * detect missing reference assemblies (the MSB3644 error) and offer the
//     Microsoft.NETFramework.ReferenceAssemblies NuGet helper, which lets the
//     dotnet CLI build .NET Framework targets without a Developer Pack;
//   * locate Visual Studio's MSBuild.exe via vswhere for classic projects the
//     dotnet CLI cannot build at all.

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { replaceFileAtomically } from './atomicFile';

export interface ProjectInfo {
    /** Full path of the project file this info was read from. */
    project: string;
    /** True for SDK-style projects (`<Project Sdk="...">`). */
    sdkStyle: boolean;
    /** Raw target monikers: ["net8.0-windows"], ["v4.6"], ... */
    targetFrameworks: string[];
    /** True when any target is .NET Framework (net4x / v4.x). */
    netFramework: boolean;
    useWPF: boolean;
    useWinForms: boolean;
    /** WinExe / Exe / Library / '' when unspecified. */
    outputType: string;
    /** Project already references Microsoft.NETFramework.ReferenceAssemblies. */
    hasRefAssembliesHelper: boolean;
}

/** True for classic .NET Framework monikers: net46, net472, net48, v4.6 ... */
export function isNetFrameworkTfm(tfm: string): boolean {
    return /^v\d/.test(tfm) || /^net[1-4]\d{1,2}$/.test(tfm);
}

/** Parse the project file; undefined when it cannot be read. */
export function readProjectInfo(project: string): ProjectInfo | undefined {
    let xml: string;
    try {
        xml = fs.readFileSync(project, 'utf8');
    } catch {
        return undefined;
    }

    const tfms: string[] = [];
    const single = /<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/.exec(xml);
    const multi = /<TargetFrameworks>\s*([^<]+?)\s*<\/TargetFrameworks>/.exec(xml);
    const classic = /<TargetFrameworkVersion>\s*([^<]+?)\s*<\/TargetFrameworkVersion>/.exec(xml);
    if (single) { tfms.push(single[1]); }
    if (multi) { tfms.push(...multi[1].split(';').map(t => t.trim()).filter(Boolean)); }
    if (classic) { tfms.push(classic[1]); }

    return {
        project,
        sdkStyle: /<Project\s[^>]*\bSdk\s*=/.test(xml),
        targetFrameworks: tfms,
        netFramework: tfms.some(isNetFrameworkTfm),
        useWPF: /<UseWPF>\s*true\s*<\/UseWPF>/i.test(xml) || /Include="PresentationFramework"/.test(xml),
        useWinForms: /<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(xml) || /Include="System\.Windows\.Forms"/.test(xml),
        outputType: /<OutputType>\s*([^<]+?)\s*<\/OutputType>/.exec(xml)?.[1] ?? '',
        hasRefAssembliesHelper: xml.includes('Microsoft.NETFramework.ReferenceAssemblies')
    };
}

/** ".NET 8" / ".NET Framework 4.7.2" / ".NET Standard 2.0" from a moniker. */
export function frameworkLabel(tfm: string): string {
    if (/^v\d/.test(tfm)) { return `.NET Framework ${tfm.slice(1)}`; }
    const std = /^netstandard(\d+\.\d+)$/.exec(tfm);
    if (std) { return `.NET Standard ${std[1]}`; }
    const core = /^netcoreapp(\d+\.\d+)$/.exec(tfm);
    if (core) { return `.NET Core ${core[1]}`; }
    const modern = /^net(\d+)\.(\d+)/.exec(tfm);
    if (modern) { return modern[2] === '0' ? `.NET ${modern[1]}` : `.NET ${modern[1]}.${modern[2]}`; }
    const framework = /^net(\d)(\d)(\d)?$/.exec(tfm);
    if (framework) { return `.NET Framework ${framework[1]}.${framework[2]}${framework[3] ? `.${framework[3]}` : ''}`; }
    return tfm;
}

/** Short "WinForms · .NET 8" style tag for one project. */
export function projectTypeLabel(info: ProjectInfo): string {
    let ui: string;
    if (info.useWPF && info.useWinForms) { ui = 'WPF+WinForms'; }
    else if (info.useWPF) { ui = 'WPF'; }
    else if (info.useWinForms) { ui = 'WinForms'; }
    else if (/exe/i.test(info.outputType)) { ui = 'Console'; }
    else if (info.outputType) { ui = 'Library'; }
    else { ui = '.NET'; }
    const fw = info.targetFrameworks[0] ? frameworkLabel(info.targetFrameworks[0]) : '';
    return fw ? `${ui} · ${fw}` : ui;
}

/**
 * Type tag for a whole project folder: first project file found in the folder
 * itself or one directory down. Results are cached per session.
 */
const folderTypeCache = new Map<string, string>();

export function folderTypeLabel(folder: string): string {
    const cached = folderTypeCache.get(folder);
    if (cached !== undefined) { return cached; }

    let label = '';
    const proj = findProjectFileIn(folder);
    if (proj) {
        const info = readProjectInfo(proj);
        if (info) { label = projectTypeLabel(info); }
    }
    folderTypeCache.set(folder, label);
    return label;
}

/** First .csproj/.vbproj in `folder` or its immediate subdirectories. */
export function findProjectFileIn(folder: string): string | undefined {
    const isProj = (f: string) => /\.(cs|vb)proj$/i.test(f);
    try {
        const entries = fs.readdirSync(folder, { withFileTypes: true });
        const direct = entries.find(e => e.isFile() && isProj(e.name));
        if (direct) { return path.join(folder, direct.name); }
        for (const e of entries) {
            if (!e.isDirectory() || ['bin', 'obj', 'node_modules', '.git'].includes(e.name)) { continue; }
            try {
                const hit = fs.readdirSync(path.join(folder, e.name)).find(isProj);
                if (hit) { return path.join(folder, e.name, hit); }
            } catch { /* unreadable subdir */ }
        }
    } catch { /* unreadable folder */ }
    return undefined;
}

// ------------------------------------------------- .NET Framework protections

/**
 * Are the .NET Framework reference assemblies for `tfm` installed locally?
 * Missing ones are what produces MSB3644 when building net4x targets.
 */
export function refAssembliesInstalled(tfm: string): boolean {
    let version: string;
    if (/^v\d/.test(tfm)) {
        version = tfm;
    } else {
        const digits = /^net(\d)(\d)(\d)?$/.exec(tfm);
        if (!digits) { return true; } // not a framework moniker — nothing to check
        version = `v${digits[1]}.${digits[2]}${digits[3] ? `.${digits[3]}` : ''}`;
    }
    const root = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return fs.existsSync(path.join(
        root, 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework', version));
}

/**
 * Add the Microsoft.NETFramework.ReferenceAssemblies package to the project.
 * It is a build-time-only helper (PrivateAssets=all) that supplies the
 * reference assemblies for every .NET Framework version, so the project
 * builds on machines without the Developer Pack. Returns false on failure.
 */
export function addRefAssembliesHelper(project: string): boolean {
    try {
        let xml = fs.readFileSync(project, 'utf8');
        if (xml.includes('Microsoft.NETFramework.ReferenceAssemblies')) { return true; }
        const eol = xml.includes('\r\n') ? '\r\n' : '\n';
        const block =
            `  <ItemGroup>${eol}` +
            `    <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />${eol}` +
            `  </ItemGroup>${eol}`;
        if (!/<\/Project>/.test(xml)) { return false; }
        xml = xml.replace(/<\/Project>/, `${block}</Project>`);
        replaceFileAtomically(project, xml);
        return true;
    } catch {
        return false;
    }
}

/**
 * Major versions of the .NET SDKs installed on this machine (from
 * `dotnet --list-sdks`), newest first. Cached per session; empty on failure
 * (no dotnet on PATH) so callers can fall back to a static list.
 */
let sdkMajorsCache: number[] | undefined;

export function installedSdkMajors(): Promise<number[]> {
    if (sdkMajorsCache) { return Promise.resolve(sdkMajorsCache); }
    return new Promise(resolve => {
        cp.execFile('dotnet', ['--list-sdks'], { timeout: 10000 }, (err, stdout) => {
            const majors = new Set<number>();
            if (!err) {
                for (const line of stdout.split(/\r?\n/)) {
                    const m = /^(\d+)\./.exec(line.trim());
                    if (m) { majors.add(Number(m[1])); }
                }
            }
            sdkMajorsCache = [...majors].sort((a, b) => b - a);
            resolve(sdkMajorsCache);
        });
    });
}

/** Even-numbered .NET releases are LTS (8, 10, 12, …); odd ones are STS. */
export function isLtsDotnet(major: number): boolean {
    return major >= 8 && major % 2 === 0;
}

/**
 * Locate Visual Studio's MSBuild.exe with vswhere (needed for classic
 * non-SDK projects, which the dotnet CLI cannot build). Cached per session.
 */
let msbuildPath: string | undefined | null = null; // null = not looked up yet

export function findMsBuild(): Promise<string | undefined> {
    if (msbuildPath !== null) { return Promise.resolve(msbuildPath); }
    return new Promise(resolve => {
        const vswhere = path.join(
            process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
            'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
        if (!fs.existsSync(vswhere)) {
            msbuildPath = undefined;
            resolve(undefined);
            return;
        }
        cp.execFile(vswhere, [
            '-latest', '-products', '*',
            '-requires', 'Microsoft.Component.MSBuild',
            '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'
        ], (err, stdout) => {
            const first = err ? '' : stdout.split(/\r?\n/).find(l => l.trim().length > 0)?.trim() ?? '';
            msbuildPath = first && fs.existsSync(first) ? first : undefined;
            resolve(msbuildPath);
        });
    });
}
