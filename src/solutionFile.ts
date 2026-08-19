// UI Maker — Visual Studio solution (.sln) generation.
//
// Visual Studio's WPF/WinForms designers need PROJECT CONTEXT: a .xaml or
// form opened as a loose file (no solution loaded) cannot resolve
// StaticResources, custom-control namespaces, or assets, so the VS designer
// refuses to load. UI Maker projects are plain SDK projects that build fine
// from the CLI — but without a .sln, double-clicking into Visual Studio was
// a coin toss. Every project UI Maker creates or adopts therefore gets a
// minimal single-project .sln so both designers stay interchangeable.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { replaceFileAtomically } from './atomicFile';

/** Visual Studio's language project-type GUIDs (same ones dotnet sln uses). */
const PROJECT_TYPE = {
    cs: 'FAE04EC0-301F-11D3-BF4B-00C04F79EFBC',
    vb: 'F184B08F-C81C-45F6-A57F-5ABD9991F28F'
} as const;

/** Deterministic project GUID from the project file name — regenerating the
 *  solution never churns the GUID (keeps diffs and .suo caches stable). */
export function projectGuid(projectFileName: string): string {
    const hex = crypto.createHash('sha1')
        .update(`uimaker-sln:${projectFileName.toLowerCase()}`)
        .digest('hex')
        .toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Text of a minimal single-project solution (the dotnet-sln shape VS makes). */
export function solutionText(projectFileName: string): string {
    const name = projectFileName.replace(/\.(cs|vb)proj$/i, '');
    const lang = /\.vbproj$/i.test(projectFileName) ? 'vb' : 'cs';
    const guid = projectGuid(projectFileName);
    return [
        '',
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        '# Visual Studio Version 17',
        'VisualStudioVersion = 17.0.31903.59',
        'MinimumVisualStudioVersion = 10.0.40219.1',
        `Project("{${PROJECT_TYPE[lang]}}") = "${name}", "${projectFileName}", "{${guid}}"`,
        'EndProject',
        'Global',
        '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
        '\t\tDebug|Any CPU = Debug|Any CPU',
        '\t\tRelease|Any CPU = Release|Any CPU',
        '\tEndGlobalSection',
        '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
        `\t\t{${guid}}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`,
        `\t\t{${guid}}.Debug|Any CPU.Build.0 = Debug|Any CPU`,
        `\t\t{${guid}}.Release|Any CPU.ActiveCfg = Release|Any CPU`,
        `\t\t{${guid}}.Release|Any CPU.Build.0 = Release|Any CPU`,
        '\tEndGlobalSection',
        '\tGlobalSection(SolutionProperties) = preSolution',
        '\t\tHideSolutionNode = FALSE',
        '\tEndGlobalSection',
        'EndGlobal',
        ''
    ].join('\r\n');
}

/**
 * Guarantee the project's folder has a solution Visual Studio can open.
 * Respects anything already there: an existing .sln (or the modern .slnx) in
 * the project folder or either parent level means the project is already
 * reachable from a solution — nothing is written.
 * Returns the created .sln path, or null when nothing needed creating.
 */
export function ensureSolutionFor(projectPath: string): string | null {
    const dir = path.dirname(projectPath);
    const projectFileName = path.basename(projectPath);
    const solutionsIn = (d: string): string[] => {
        try {
            return fs.readdirSync(d).filter(f => /\.(sln|slnx)$/i.test(f)).map(f => path.join(d, f));
        } catch {
            return [];
        }
    };
    // Any solution in the project's own folder counts as covering it.
    if (solutionsIn(dir).length) { return null; }
    // A parent-level solution counts only when it actually references this
    // project (multi-project layouts) — an unrelated neighbor's .sln does not.
    const parent = path.dirname(dir);
    if (parent !== dir) {
        for (const sln of solutionsIn(parent)) {
            try {
                if (fs.readFileSync(sln, 'utf8').toLowerCase().includes(projectFileName.toLowerCase())) {
                    return null;
                }
            } catch { /* unreadable — ignore */ }
        }
    }
    const slnPath = path.join(dir, `${projectFileName.replace(/\.(cs|vb)proj$/i, '')}.sln`);
    replaceFileAtomically(slnPath, solutionText(projectFileName));
    return slnPath;
}
