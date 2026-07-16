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
//   * non-framework assembly references (HintPath) and COM references are
//     carried over; framework references become implicit;
//   * Settings.settings / Resources.resx keep their designer generators;
//   * GenerateAssemblyInfo=false keeps the existing AssemblyInfo.cs valid.
//
// The original project file is saved next to the new one as
// <name>.csproj.legacy.bak, so the conversion is a two-file rename to undo.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { readProjectInfo } from './projectInfo';
import { DotnetTools } from './dotnetTools';

/** Framework references that SDK-style desktop projects get implicitly. */
const IMPLICIT_REFS = new Set([
    'system', 'system.core', 'system.data', 'system.data.datasetextensions',
    'system.deployment', 'system.drawing', 'system.net.http', 'system.numerics',
    'system.runtime.serialization', 'system.windows.forms', 'system.xml',
    'system.xml.linq', 'microsoft.csharp', 'presentationcore',
    'presentationframework', 'windowsbase', 'system.xaml', 'uiautomationprovider',
    'uiautomationtypes', 'system.configuration'
]);

export async function convertToSdkStyle(dotnet: DotnetTools): Promise<void> {
    const project = await dotnet.findProject();
    if (!project) { return; }
    if (/\.vbproj$/i.test(project)) {
        vscode.window.showWarningMessage('UI Maker: automatic conversion supports C# projects only (for now).');
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
        vscode.window.showErrorMessage(`UI Maker: conversion failed — ${err instanceof Error ? err.message : err}. The project file was not changed.`);
    }
}

interface ConversionResult { backup: string; warnings: string[]; }

/** Rewrite one classic .csproj as SDK-style. Throws before writing on error. */
export function convertProjectFile(project: string): ConversionResult {
    const dir = path.dirname(project);
    const xml = fs.readFileSync(project, 'utf8');
    const warnings: string[] = [];

    const prop = (name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1] ?? '';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // ---- target framework ------------------------------------------------
    const tfv = prop('TargetFrameworkVersion');           // e.g. v4.7.2
    const tfm = tfv ? `net${tfv.replace(/^v/, '').split('.').join('')}` : 'net48';

    // ---- UI stack ---------------------------------------------------------
    const useWinForms = /Include="System\.Windows\.Forms"/.test(xml)
        || /<UseWindowsForms>\s*true/i.test(xml);
    const useWpf = /Include="PresentationFramework"/.test(xml) || /<UseWPF>\s*true/i.test(xml);

    // ---- assembly references ----------------------------------------------
    // Keep non-framework references; ones resolved out of the NuGet packages
    // folder are covered by the PackageReference conversion below.
    const keptRefs: string[] = [];
    for (const m of xml.matchAll(/<Reference\s+Include="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/Reference>)/g)) {
        const name = m[1].split(',')[0].trim();
        const body = m[2] ?? '';
        const hint = /<HintPath>\s*([^<]+?)\s*<\/HintPath>/.exec(body)?.[1];
        if (hint && /[\\/]packages[\\/]/i.test(hint)) { continue; }       // from packages.config
        if (!hint && IMPLICIT_REFS.has(name.toLowerCase())) { continue; } // implicit in SDK style
        keptRefs.push(hint
            ? `    <Reference Include="${esc(name)}">\n      <HintPath>${esc(hint)}</HintPath>\n    </Reference>`
            : `    <Reference Include="${esc(name)}" />`);
    }

    // ---- COM references ----------------------------------------------------
    const comRefs = [...xml.matchAll(/<COMReference\s[\s\S]*?<\/COMReference>|<COMReference\s[^>]*\/>/g)]
        .map(m => `    ${m[0].replace(/\n\s*/g, '\n    ')}`);
    if (comRefs.length) {
        warnings.push('COM references were carried over — they build in Visual Studio/MSBuild but may not with the plain dotnet CLI.');
    }

    // ---- NuGet packages -----------------------------------------------------
    const packages: string[] = [];
    const packagesConfig = path.join(dir, 'packages.config');
    if (fs.existsSync(packagesConfig)) {
        const cfg = fs.readFileSync(packagesConfig, 'utf8');
        for (const m of cfg.matchAll(/<package\s+id="([^"]+)"\s+version="([^"]+)"[^>]*>/g)) {
            packages.push(`    <PackageReference Include="${esc(m[1])}" Version="${esc(m[2])}" />`);
        }
    }

    // ---- designer file generators ------------------------------------------
    const genEntries: string[] = [];
    if (fs.existsSync(path.join(dir, 'Properties', 'Settings.settings'))) {
        genEntries.push(
            `    <None Update="Properties\\Settings.settings">\n` +
            `      <Generator>SettingsSingleFileGenerator</Generator>\n` +
            `      <LastGenOutput>Settings.Designer.cs</LastGenOutput>\n` +
            `    </None>`,
            `    <Compile Update="Properties\\Settings.Designer.cs">\n` +
            `      <AutoGen>True</AutoGen>\n` +
            `      <DesignTimeSharedInput>True</DesignTimeSharedInput>\n` +
            `      <DependentUpon>Settings.settings</DependentUpon>\n` +
            `    </Compile>`);
    }
    if (fs.existsSync(path.join(dir, 'Properties', 'Resources.resx'))) {
        genEntries.push(
            `    <EmbeddedResource Update="Properties\\Resources.resx">\n` +
            `      <Generator>ResXFileCodeGenerator</Generator>\n` +
            `      <LastGenOutput>Resources.Designer.cs</LastGenOutput>\n` +
            `    </EmbeddedResource>`,
            `    <Compile Update="Properties\\Resources.Designer.cs">\n` +
            `      <AutoGen>True</AutoGen>\n` +
            `      <DesignTime>True</DesignTime>\n` +
            `      <DependentUpon>Resources.resx</DependentUpon>\n` +
            `    </Compile>`);
    }

    // ---- custom build steps -------------------------------------------------
    if (/<Import\s+Project="(?![^"]*Microsoft\.(?:CSharp|Common|VisualBasic)\.targets)[^"]*"/.test(xml)) {
        warnings.push('Custom .targets imports were NOT carried over — re-add them manually if the build needs them.');
    }

    // ---- assemble ------------------------------------------------------------
    const props: string[] = [];
    const addProp = (name: string, value: string) => {
        if (value) { props.push(`    <${name}>${esc(value)}</${name}>`); }
    };
    addProp('OutputType', prop('OutputType') || 'WinExe');
    addProp('TargetFramework', tfm);
    if (useWinForms) { addProp('UseWindowsForms', 'true'); }
    if (useWpf) { addProp('UseWPF', 'true'); }
    addProp('RootNamespace', prop('RootNamespace'));
    addProp('AssemblyName', prop('AssemblyName'));
    addProp('ApplicationIcon', prop('ApplicationIcon'));
    addProp('ApplicationManifest', prop('ApplicationManifest'));
    addProp('StartupObject', prop('StartupObject'));
    addProp('LangVersion', prop('LangVersion'));
    if (prop('PlatformTarget') && prop('PlatformTarget').toLowerCase() !== 'anycpu') {
        addProp('PlatformTarget', prop('PlatformTarget'));
    }
    // The old AssemblyInfo.cs stays the source of truth for version info.
    addProp('GenerateAssemblyInfo', 'false');
    addProp('AutoGenerateBindingRedirects', 'true');

    const groups: string[] = [`  <PropertyGroup>\n${props.join('\n')}\n  </PropertyGroup>`];
    const preBuild = prop('PreBuildEvent');
    const postBuild = prop('PostBuildEvent');
    if (preBuild || postBuild) {
        const events: string[] = [];
        if (preBuild) { events.push(`    <PreBuildEvent>${esc(preBuild)}</PreBuildEvent>`); }
        if (postBuild) { events.push(`    <PostBuildEvent>${esc(postBuild)}</PostBuildEvent>`); }
        groups.push(`  <PropertyGroup>\n${events.join('\n')}\n  </PropertyGroup>`);
        warnings.push('Build events were carried over — check any $(SolutionDir)-style macros they use.');
    }
    if (packages.length) { groups.push(`  <ItemGroup>\n${packages.join('\n')}\n  </ItemGroup>`); }
    if (keptRefs.length) { groups.push(`  <ItemGroup>\n${keptRefs.join('\n')}\n  </ItemGroup>`); }
    if (comRefs.length) { groups.push(`  <ItemGroup>\n${comRefs.join('\n')}\n  </ItemGroup>`); }
    if (genEntries.length) { groups.push(`  <ItemGroup>\n${genEntries.join('\n')}\n  </ItemGroup>`); }

    const newXml = `<Project Sdk="Microsoft.NET.Sdk">\n\n${groups.join('\n\n')}\n\n</Project>\n`;

    // ---- write (backup first, then atomic-ish swap) ---------------------------
    const backup = `${project}.legacy.bak`;
    if (fs.existsSync(backup)) {
        throw new Error(`${path.basename(backup)} already exists — a previous conversion backup would be overwritten`);
    }
    fs.copyFileSync(project, backup);
    fs.writeFileSync(project, newXml, 'utf8');
    if (packages.length) {
        try { fs.renameSync(packagesConfig, `${packagesConfig}.bak`); } catch { /* keep going — harmless leftover */ }
    }
    return { backup, warnings };
}
