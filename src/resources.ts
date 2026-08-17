// UI Maker — project image resources (the Visual Studio "Select Resource"
// dialog's Import flow).
//
// When the user assigns an Image/BackgroundImage/Icon in the property grid,
// this module reproduces what Visual Studio does for a *project resource*:
//
//   1. copy the picked file into  <project>/Resources/
//   2. register it as a ResXFileRef in  Properties/Resources.resx
//   3. regenerate  Properties/Resources.Designer.cs  (ResXFileCodeGenerator
//      compatible, so the project still round-trips with Visual Studio)
//   4. classic (non-SDK) csproj: add the file entries VS would add
//
// The Designer.cs then references the image as
//   global::<RootNamespace>.Properties.Resources.<name>
//
// Reading goes the other way: the designer webview asks for the images its
// document references, and resolveImages() maps resource names back to files
// (project resources) or data URIs (legacy images embedded base64 in the
// form's own .resx).

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EXCLUDE_GLOB, getWorkingFolder, pickWorkingFolder } from './workingFolder';
import { isCSharpIdentifier, sanitizeCSharpNamespace } from './csharpText';
import { decodeXmlEntities } from './xmlText';
import { createFilesAtomically, replaceFileAtomically } from './atomicFile';

export interface ImportedImage {
    /** Resource name — a valid C# identifier. */
    key: string;
    /** C# expression for the Designer.cs assignment. */
    code: string;
    /** Absolute path of the imported image file. */
    fsPath: string;
}

/** A reference the webview wants resolved: project resx, local form resx,
 *  or a XAML project-relative image path ('x'). */
export interface ImageKey {
    scope: 'p' | 'l' | 'x';
    key: string;
}

const IMAGE_FILTERS = { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico'] };
const ICON_FILTERS = { 'Icons': ['ico'] };

/** Walk up from a file to the directory containing a .csproj/.vbproj (or null).
 *  Resource IMPORTS additionally require a .csproj (see importResourceFile);
 *  resolution and webview roots work for both languages. */
export function findProjectDir(startFile: string): string | null {
    let dir = path.dirname(startFile);
    for (let i = 0; i < 24; i++) {
        try {
            if (fs.readdirSync(dir).some(f => /\.(cs|vb)proj$/i.test(f))) { return dir; }
        } catch { return null; }
        const parent = path.dirname(dir);
        if (parent === dir) { return null; }
        dir = parent;
    }
    return null;
}

function csprojPath(projDir: string): string | null {
    const name = fs.readdirSync(projDir).find(f => /\.csproj$/i.test(f));
    return name ? path.join(projDir, name) : null;
}

/** Any project file (C# or VB) in the folder. */
function projectPathAny(projDir: string): string | null {
    const name = fs.readdirSync(projDir).find(f => /\.(cs|vb)proj$/i.test(f));
    return name ? path.join(projDir, name) : null;
}

/** Root namespace: csproj RootNamespace, else the sanitized project name. */
function rootNamespace(csproj: string): string {
    try {
        const xml = fs.readFileSync(csproj, 'utf8');
        const root = /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/.exec(xml)?.[1];
        if (root) { return sanitizeCSharpNamespace(decodeXmlEntities(root)); }
    } catch { /* fall through to the file name */ }
    const base = path.basename(csproj).replace(/\.csproj$/i, '');
    return sanitizeCSharpNamespace(base);
}

/** File base name -> valid C# identifier ("refresh icon.png" -> "refresh_icon"). */
function resourceKey(file: string): string {
    const base = path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9_]/g, '_');
    const candidate = /^[0-9]/.test(base) ? `_${base}` : (base || '_image');
    return isCSharpIdentifier(candidate) ? candidate : `_${candidate}`;
}

/**
 * Ask the user for an image, import it as a project resource, and return the
 * C# expression that references it. Returns undefined when cancelled.
 */
export async function pickAndImportImage(docPath: string, iconOnly: boolean): Promise<ImportedImage | undefined> {
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use Image',
        filters: iconOnly ? ICON_FILTERS : IMAGE_FILTERS
    });
    if (!picked?.length) { return undefined; }
    return importResourceFile(docPath, picked[0].fsPath);
}

/** An image imported for XAML use (Image.Source / ImageBrush.ImageSource). */
export interface XamlImage {
    /** Path relative to the XAML document, with forward slashes. */
    rel: string;
    /** Absolute path of the imported file. */
    fsPath: string;
}

/**
 * Ask the user for an image and import it for a XAML document: copy into
 * <project>/Resources and register a <Resource Include> so relative pack
 * URIs keep working in published builds. No resx involved — WPF references
 * images by path, not through Properties.Resources.
 */
export async function pickXamlImage(docPath: string): Promise<XamlImage | undefined> {
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use Image',
        filters: IMAGE_FILTERS
    });
    if (!picked?.length) { return undefined; }
    return importXamlImage(docPath, picked[0].fsPath);
}

export function importXamlImage(docPath: string, src: string): XamlImage | undefined {
    const projDir = findProjectDir(docPath);
    if (!projDir) {
        vscode.window.showWarningMessage('UI Maker: no project file found — images need a project folder to import into.');
        return undefined;
    }
    try {
        // 1) Copy into <project>/Resources (deduping identical content).
        const resDir = path.join(projDir, 'Resources');
        if (!fs.existsSync(resDir)) { fs.mkdirSync(resDir, { recursive: true }); }
        let destName = path.basename(src);
        let dest = path.join(resDir, destName);
        if (path.resolve(path.dirname(src)) === path.resolve(resDir)) {
            dest = src; // picked from Resources/ itself — reuse in place
        } else if (fs.existsSync(dest) && !fs.readFileSync(dest).equals(fs.readFileSync(src))) {
            const ext = path.extname(destName);
            const stem = path.basename(destName, ext);
            for (let i = 1; ; i++) {
                destName = `${stem}${i}${ext}`;
                dest = path.join(resDir, destName);
                if (!fs.existsSync(dest) || fs.readFileSync(dest).equals(fs.readFileSync(src))) { break; }
            }
            if (!fs.existsSync(dest)) { fs.copyFileSync(src, dest); }
        } else if (!fs.existsSync(dest)) {
            fs.copyFileSync(src, dest);
        }

        // 2) Make sure the project compiles it as a WPF Resource.
        ensureXamlResourceInclude(projDir, path.relative(projDir, dest));

        const rel = path.relative(path.dirname(docPath), dest).split(path.sep).join('/');
        return { rel, fsPath: dest };
    } catch (err) {
        vscode.window.showWarningMessage(`UI Maker: could not import the image — ${err instanceof Error ? err.message : err}`);
        return undefined;
    }
}

/**
 * Add <Resource Include="Resources\file.png"/> to the project file unless an
 * equivalent Resource/Content entry (or a wildcard) already covers it. Both
 * SDK-style and classic projects need the entry — WPF only packs images
 * whose build action is Resource.
 */
function ensureXamlResourceInclude(projDir: string, relFromProj: string): void {
    const projFile = fs.readdirSync(projDir).find(f => /\.(cs|vb)proj$/i.test(f));
    if (!projFile) { return; }
    const projPath = path.join(projDir, projFile);
    const xml = fs.readFileSync(projPath, 'utf8');
    const msbuildRel = relFromProj.split(path.sep).join('\\');
    const escaped = msbuildRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`<(Resource|Content)\\s+Include="${escaped}"`, 'i').test(xml)) { return; }
    if (/<(Resource|Content)\s+Include="Resources\\[^"]*\*/i.test(xml)) { return; } // wildcard covers it
    const closing = /^[ \t]*<\/Project>/m.exec(xml);
    if (!closing) { return; }
    const entry = `    <ItemGroup>\n        <Resource Include="${msbuildRel}" />\n    </ItemGroup>\n`;
    replaceFileAtomically(projPath, xml.slice(0, closing.index) + entry + xml.slice(closing.index));
}

/**
 * Import one file as a project resource (copy to Resources/, resx entry,
 * regenerated accessor class, csproj bookkeeping). Shared by the designer's
 * image picker and the side panel's Add Image / Add Resource buttons.
 */
export function importResourceFile(startPath: string, src: string): ImportedImage | undefined {
    const projDir = findProjectDir(startPath);
    const proj = projDir ? projectPathAny(projDir) : null;
    if (!projDir || !proj) {
        vscode.window.showWarningMessage('UI Maker: no project file found — resources need a project to import into.');
        return undefined;
    }
    const isVb = /\.vbproj$/i.test(proj);

    try {
        // 1) Copy into <project>/Resources (VS behavior), deduping by content.
        const resDir = path.join(projDir, 'Resources');
        if (!fs.existsSync(resDir)) { fs.mkdirSync(resDir, { recursive: true }); }
        let destName = path.basename(src);
        let dest = path.join(resDir, destName);
        if (path.resolve(path.dirname(src)) === path.resolve(resDir)) {
            dest = src; // picked from Resources/ itself — reuse in place
        } else if (fs.existsSync(dest) && !fs.readFileSync(dest).equals(fs.readFileSync(src))) {
            const ext = path.extname(destName);
            const stem = path.basename(destName, ext);
            for (let i = 1; ; i++) {
                destName = `${stem}${i}${ext}`;
                dest = path.join(resDir, destName);
                if (!fs.existsSync(dest) || fs.readFileSync(dest).equals(fs.readFileSync(src))) { break; }
            }
            if (!fs.existsSync(dest)) { fs.copyFileSync(src, dest); }
        } else if (!fs.existsSync(dest)) {
            fs.copyFileSync(src, dest);
        }

        // 2) Register in the project resx with the right CLR type
        // (Properties/ for C#, "My Project"/ for VB — VS's own layout).
        const key = addResxFileRef(projDir, dest, resourceTypeFor(dest), isVb);

        // 3) Regenerate the typed accessor class in the project's language.
        const ns = rootNamespace(proj);
        if (isVb) { writeResourcesDesignerVb(projDir, ns); }
        else { writeResourcesDesigner(projDir, ns); }

        // 4) Classic project bookkeeping.
        registerResourceFiles(proj, path.relative(projDir, dest), isVb);

        return {
            key,
            code: isVb ? `My.Resources.${key}` : `global::${ns}.Properties.Resources.${key}`,
            fsPath: dest
        };
    } catch (err) {
        vscode.window.showErrorMessage(`UI Maker: could not import the resource — ${err}`);
        return undefined;
    }
}

// ------------------------------------------------------------------- resx IO

const RESX_HEADER = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <resheader name="resmimetype">
    <value>text/microsoft-resx</value>
  </resheader>
  <resheader name="version">
    <value>2.0</value>
  </resheader>
  <resheader name="reader">
    <value>System.Resources.ResXResourceReader, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value>
  </resheader>
  <resheader name="writer">
    <value>System.Resources.ResXResourceWriter, System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089</value>
  </resheader>
  <assembly alias="System.Windows.Forms" name="System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089" />
</root>
`;

const BITMAP_TYPE = 'System.Drawing.Bitmap, System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a4a';
const ICON_TYPE = 'System.Drawing.Icon, System.Drawing, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a4a';
const STRING_TYPE = 'System.String, mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089;utf-8';
const BYTES_TYPE = 'System.Byte[], mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089';

/** ResXFileRef type spec for a file, by extension (VS picks the same way). */
function resourceTypeFor(file: string): string {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.ico') { return ICON_TYPE; }
    if (['.png', '.jpg', '.jpeg', '.gif', '.bmp'].includes(ext)) { return BITMAP_TYPE; }
    if (['.txt', '.json', '.xml', '.csv', '.md'].includes(ext)) { return STRING_TYPE; }
    return BYTES_TYPE;
}

function resxPath(projDir: string, isVb = false): string {
    return path.join(projDir, isVb ? 'My Project' : 'Properties', 'Resources.resx');
}

/** One `<data>` entry of a resx, with everything needed to round-trip it. */
interface ResxEntry {
    name: string;
    /** ResXFileRef value ("path;Type, Assembly[;encoding]") or null. */
    fileRef: string | null;
    /** The entry's declared type attribute, or null. */
    typeAttr: string | null;
    /** The entry's mimetype attribute (binary payloads), or null. */
    mimeType: string | null;
    /** Plain inline string entry (no type, no mimetype). */
    isString: boolean;
}

/** Every <data name=...> entry in a resx, with its fileref value when present. */
function parseResxEntries(xml: string): ResxEntry[] {
    const out: ResxEntry[] = [];
    const re = /<data\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/data>/g;
    for (let m = re.exec(xml); m; m = re.exec(xml)) {
        const attr = (name: string) => {
            const value = new RegExp(`\\b${name}="([^"]*)"`).exec(m![2])?.[1];
            return value === undefined ? null : decodeXmlEntities(value);
        };
        const value = decodeXmlEntities(/<value>([\s\S]*?)<\/value>/.exec(m[3])?.[1] ?? '');
        const typeAttr = attr('type');
        const mimeType = attr('mimetype');
        const isFileRef = !!typeAttr && /ResXFileRef/.test(typeAttr);
        out.push({
            name: decodeXmlEntities(m[1]),
            fileRef: isFileRef ? value : null,
            typeAttr,
            mimeType,
            isString: !isFileRef && !typeAttr && !mimeType
        });
    }
    return out;
}

/**
 * The C# type an entry's generated accessor should return. Every declared
 * type is preserved — an integer, color, or custom resource added by Visual
 * Studio must never come back as a Bitmap accessor after we regenerate.
 */
function accessorTypeFor(e: ResxEntry): string {
    // File references carry "path;Full.Type, Assembly[;encoding]".
    const clr = e.fileRef
        ? (e.fileRef.split(';')[1] ?? '').split(',')[0].trim()
        : e.typeAttr && !/ResXFileRef/.test(e.typeAttr)
            ? e.typeAttr.split(',')[0].trim()
            : '';
    if (e.isString || clr === 'System.String') { return 'string'; }
    if (clr === 'System.Byte[]') { return 'byte[]'; }
    if (/^[A-Za-z_][A-Za-z0-9_.]*(\[\])?$/.test(clr)) { return `global::${clr}`; }
    // Unknown payload (e.g. BinaryFormatter blob without a usable type):
    // an object accessor is always correct and always compiles.
    return 'object';
}

/**
 * Add (or reuse) a fileref entry for the file; returns the resource name.
 * Creates Properties/Resources.resx when the project has none.
 */
function addResxFileRef(projDir: string, fileAbs: string, type: string, isVb = false): string {
    const file = resxPath(projDir, isVb);
    if (!fs.existsSync(path.dirname(file))) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
    let xml = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : RESX_HEADER;

    // The fileref path is relative to the resx (Properties/) directory.
    const rel = path.relative(path.dirname(file), fileAbs).split('/').join('\\');
    const value = `${rel};${type}`;

    const entries = parseResxEntries(xml);
    // Same file already registered? Reuse its name.
    const existing = entries.find(e => e.fileRef?.toLowerCase().startsWith(rel.toLowerCase() + ';'));
    if (existing) { return existing.name; }

    // Unique name derived from the file name.
    let key = resourceKey(fileAbs);
    const names = new Set(entries.map(e => e.name));
    for (let i = 1; names.has(key); i++) { key = `${resourceKey(fileAbs)}${i}`; }

    // VS declares the alias once; older/minimal resx files may lack it.
    if (!/assembly alias="System.Windows.Forms"/.test(xml)) {
        xml = xml.replace(/<\/root>/,
            `  <assembly alias="System.Windows.Forms" name="System.Windows.Forms, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089" />\n</root>`);
    }
    const entry =
        `  <data name="${key}" type="System.Resources.ResXFileRef, System.Windows.Forms">\n` +
        `    <value>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</value>\n` +
        `  </data>\n`;
    xml = xml.replace(/<\/root>/, `${entry}</root>`);
    replaceFileAtomically(file, xml);
    return key;
}

/** Regenerate Properties/Resources.Designer.cs from the resx entries. */
function writeResourcesDesigner(projDir: string, rootNs: string): void {
    const file = resxPath(projDir);
    const entries = fs.existsSync(file) ? parseResxEntries(fs.readFileSync(file, 'utf8')) : [];
    const ns = `${rootNs}.Properties`;

    const props = entries.map(e => {
        // Names must stay valid identifiers — anything else would corrupt
        // the generated class (spaces etc. can appear in hand-edited files).
        if (!isCSharpIdentifier(e.name)) { return ''; }
        const type = accessorTypeFor(e);
        // Text resources (inline strings and string filerefs) use GetString.
        if (type === 'string') {
            return `        internal static string ${e.name} {\r\n` +
                `            get {\r\n` +
                `                return ResourceManager.GetString("${e.name}", resourceCulture);\r\n` +
                `            }\r\n` +
                `        }`;
        }
        return `        internal static ${type} ${e.name} {\r\n` +
            `            get {\r\n` +
            `                object obj = ResourceManager.GetObject("${e.name}", resourceCulture);\r\n` +
            `                return ((${type})(obj));\r\n` +
            `            }\r\n` +
            `        }`;
    }).filter(Boolean).join('\r\n\r\n');

    const code =
        `//------------------------------------------------------------------------------\r\n` +
        `// <auto-generated>\r\n` +
        `//     This code was generated by a tool.\r\n` +
        `//     Changes to this file may cause incorrect behavior and will be lost if\r\n` +
        `//     the code is regenerated.\r\n` +
        `// </auto-generated>\r\n` +
        `//------------------------------------------------------------------------------\r\n` +
        `\r\n` +
        `namespace ${ns} {\r\n` +
        `    using System;\r\n` +
        `\r\n` +
        `\r\n` +
        `    /// <summary>\r\n` +
        `    ///   A strongly-typed resource class, for looking up localized strings, etc.\r\n` +
        `    /// </summary>\r\n` +
        `    [global::System.CodeDom.Compiler.GeneratedCodeAttribute("System.Resources.Tools.StronglyTypedResourceBuilder", "17.0.0.0")]\r\n` +
        `    [global::System.Diagnostics.DebuggerNonUserCodeAttribute()]\r\n` +
        `    [global::System.Runtime.CompilerServices.CompilerGeneratedAttribute()]\r\n` +
        `    internal class Resources {\r\n` +
        `\r\n` +
        `        private static global::System.Resources.ResourceManager resourceMan;\r\n` +
        `\r\n` +
        `        private static global::System.Globalization.CultureInfo resourceCulture;\r\n` +
        `\r\n` +
        `        [global::System.Diagnostics.CodeAnalysis.SuppressMessageAttribute("Microsoft.Performance", "CA1811:AvoidUncalledPrivateCode")]\r\n` +
        `        internal Resources() {\r\n` +
        `        }\r\n` +
        `\r\n` +
        `        /// <summary>\r\n` +
        `        ///   Returns the cached ResourceManager instance used by this class.\r\n` +
        `        /// </summary>\r\n` +
        `        [global::System.ComponentModel.EditorBrowsableAttribute(global::System.ComponentModel.EditorBrowsableState.Advanced)]\r\n` +
        `        internal static global::System.Resources.ResourceManager ResourceManager {\r\n` +
        `            get {\r\n` +
        `                if (object.ReferenceEquals(resourceMan, null)) {\r\n` +
        `                    global::System.Resources.ResourceManager temp = new global::System.Resources.ResourceManager("${ns}.Resources", typeof(Resources).Assembly);\r\n` +
        `                    resourceMan = temp;\r\n` +
        `                }\r\n` +
        `                return resourceMan;\r\n` +
        `            }\r\n` +
        `        }\r\n` +
        `\r\n` +
        `        /// <summary>\r\n` +
        `        ///   Overrides the current thread's CurrentUICulture property for all\r\n` +
        `        ///   resource lookups using this strongly typed resource class.\r\n` +
        `        /// </summary>\r\n` +
        `        [global::System.ComponentModel.EditorBrowsableAttribute(global::System.ComponentModel.EditorBrowsableState.Advanced)]\r\n` +
        `        internal static global::System.Globalization.CultureInfo Culture {\r\n` +
        `            get {\r\n` +
        `                return resourceCulture;\r\n` +
        `            }\r\n` +
        `            set {\r\n` +
        `                resourceCulture = value;\r\n` +
        `            }\r\n` +
        `        }\r\n` +
        (props ? `\r\n${props}\r\n` : '') +
        `    }\r\n` +
        `}\r\n`;

    replaceFileAtomically(path.join(projDir, 'Properties', 'Resources.Designer.cs'), code);
}

/** VB accessor type for a resx entry ("string" -> String, etc.). */
function vbAccessorTypeFor(e: ResxEntry): string {
    const cs = accessorTypeFor(e);
    if (cs === 'string') { return 'String'; }
    if (cs === 'byte[]') { return 'Byte()'; }
    if (cs === 'object') { return 'Object'; }
    return cs.replace(/^global::/, 'Global.').replace(/\[\]$/, '()');
}

/** Regenerate "My Project"/Resources.Designer.vb — the My.Resources module. */
function writeResourcesDesignerVb(projDir: string, rootNs: string): void {
    const file = resxPath(projDir, true);
    const entries = fs.existsSync(file) ? parseResxEntries(fs.readFileSync(file, 'utf8')) : [];

    const props = entries.map(e => {
        if (!isCSharpIdentifier(e.name)) { return ''; }
        const type = vbAccessorTypeFor(e);
        if (type === 'String') {
            return `        Friend ReadOnly Property ${e.name}() As String\r\n` +
                `            Get\r\n` +
                `                Return ResourceManager.GetString("${e.name}", resourceCulture)\r\n` +
                `            End Get\r\n` +
                `        End Property`;
        }
        return `        Friend ReadOnly Property ${e.name}() As ${type}\r\n` +
            `            Get\r\n` +
            `                Dim obj As Object = ResourceManager.GetObject("${e.name}", resourceCulture)\r\n` +
            `                Return CType(obj, ${type})\r\n` +
            `            End Get\r\n` +
            `        End Property`;
    }).filter(Boolean).join('\r\n\r\n');

    const code =
        `'------------------------------------------------------------------------------\r\n` +
        `' <auto-generated>\r\n` +
        `'     This code was generated by a tool.\r\n` +
        `'     Changes to this file may cause incorrect behavior and will be lost if\r\n` +
        `'     the code is regenerated.\r\n` +
        `' </auto-generated>\r\n` +
        `'------------------------------------------------------------------------------\r\n` +
        `\r\n` +
        `Option Strict On\r\n` +
        `Option Explicit On\r\n` +
        `\r\n` +
        `Namespace My.Resources\r\n` +
        `\r\n` +
        `    <Global.System.CodeDom.Compiler.GeneratedCodeAttribute("System.Resources.Tools.StronglyTypedResourceBuilder", "17.0.0.0"), Global.System.Diagnostics.DebuggerNonUserCodeAttribute(), Global.System.Runtime.CompilerServices.CompilerGeneratedAttribute(), Global.Microsoft.VisualBasic.HideModuleNameAttribute()>\r\n` +
        `    Friend Module Resources\r\n` +
        `\r\n` +
        `        Private resourceMan As Global.System.Resources.ResourceManager\r\n` +
        `\r\n` +
        `        Private resourceCulture As Global.System.Globalization.CultureInfo\r\n` +
        `\r\n` +
        `        <Global.System.ComponentModel.EditorBrowsableAttribute(Global.System.ComponentModel.EditorBrowsableState.Advanced)>\r\n` +
        `        Friend ReadOnly Property ResourceManager() As Global.System.Resources.ResourceManager\r\n` +
        `            Get\r\n` +
        `                If Object.ReferenceEquals(resourceMan, Nothing) Then\r\n` +
        `                    Dim temp As Global.System.Resources.ResourceManager = New Global.System.Resources.ResourceManager("${rootNs}.Resources", GetType(Resources).Assembly)\r\n` +
        `                    resourceMan = temp\r\n` +
        `                End If\r\n` +
        `                Return resourceMan\r\n` +
        `            End Get\r\n` +
        `        End Property\r\n` +
        `\r\n` +
        `        <Global.System.ComponentModel.EditorBrowsableAttribute(Global.System.ComponentModel.EditorBrowsableState.Advanced)>\r\n` +
        `        Friend Property Culture() As Global.System.Globalization.CultureInfo\r\n` +
        `            Get\r\n` +
        `                Return resourceCulture\r\n` +
        `            End Get\r\n` +
        `            Set(ByVal value As Global.System.Globalization.CultureInfo)\r\n` +
        `                resourceCulture = value\r\n` +
        `            End Set\r\n` +
        `        End Property\r\n` +
        (props ? `\r\n${props}\r\n` : '') +
        `    End Module\r\n` +
        `End Namespace\r\n`;

    replaceFileAtomically(path.join(projDir, 'My Project', 'Resources.Designer.vb'), code);
}

/**
 * Classic (non-SDK) projects list every file explicitly — register the resx
 * pair once and each imported image. SDK projects glob everything.
 */
function registerResourceFiles(proj: string, imageRel: string, isVb = false): void {
    try {
        let xml = fs.readFileSync(proj, 'utf8');
        if (/<Project\s[^>]*\bSdk\s*=/.test(xml)) { return; }
        if (!/<\/Project>/.test(xml)) { return; }
        const eol = xml.includes('\r\n') ? '\r\n' : '\n';
        const dir = isVb ? 'My Project' : 'Properties';
        const generator = isVb ? 'VbMyResourcesResXFileCodeGenerator' : 'ResXFileCodeGenerator';
        const designer = isVb ? 'Resources.Designer.vb' : 'Resources.Designer.cs';
        let block = '';
        if (!xml.includes(`${dir}\\Resources.resx`)) {
            block +=
                `    <EmbeddedResource Include="${dir}\\Resources.resx">${eol}` +
                `      <Generator>${generator}</Generator>${eol}` +
                `      <LastGenOutput>${designer}</LastGenOutput>${eol}` +
                (isVb ? `      <CustomToolNamespace>My.Resources</CustomToolNamespace>${eol}` : '') +
                `    </EmbeddedResource>${eol}` +
                `    <Compile Include="${dir}\\${designer}">${eol}` +
                `      <AutoGen>True</AutoGen>${eol}` +
                `      <DesignTime>True</DesignTime>${eol}` +
                `      <DependentUpon>Resources.resx</DependentUpon>${eol}` +
                `    </Compile>${eol}`;
        }
        const imgEntry = imageRel.split('/').join('\\')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        if (!xml.includes(`"${imgEntry}"`)) {
            block += `    <None Include="${imgEntry}" />${eol}`;
        }
        if (!block) { return; }
        xml = xml.replace(/<\/Project>/, `  <ItemGroup>${eol}${block}  </ItemGroup>${eol}</Project>`);
        replaceFileAtomically(proj, xml);
    } catch {
        vscode.window.showWarningMessage('UI Maker: could not register the resource files in the project — add them manually.');
    }
}

// -------------------------------------------------------- sidebar commands

/**
 * The project directory sidebar commands operate on: the WORKING folder when
 * one is set (multi-project workspaces are never guessed at), else the
 * workspace's single project, else a picker. `languages` limits which project
 * types qualify — resource IMPORTS generate C# accessors, so they stay
 * C#-only; file creation works for both languages.
 */
async function workspaceProjectDir(languages: 'cs' | 'any' = 'any'): Promise<string | null> {
    const working = getWorkingFolder();
    const projRe = languages === 'cs' ? /\.csproj$/i : /\.(cs|vb)proj$/i;
    const hasProject = (dir: string): boolean => {
        try { return fs.readdirSync(dir).some(f => projRe.test(f)); }
        catch { return false; }
    };

    // A selected working project is authoritative. In particular, never fall
    // through from a VB project to some unrelated C# project in the workspace.
    if (working) { return hasProject(working) ? working : null; }

    const found = await vscode.workspace.findFiles('**/*.{csproj,vbproj}', EXCLUDE_GLOB, 2);
    if (found.length === 1) {
        return projRe.test(found[0].fsPath) ? path.dirname(found[0].fsPath) : null;
    }
    if (found.length === 0) { return null; }
    // Several projects and no working folder chosen — ask, don't guess.
    const picked = await pickWorkingFolder();
    return picked && hasProject(picked) ? picked : null;
}

/** Any project file in the folder (used to pick the class-file language). */
function anyProjectPath(projDir: string): string | null {
    const name = fs.readdirSync(projDir).find(f => /\.(cs|vb)proj$/i.test(f));
    return name ? path.join(projDir, name) : null;
}

/** Side panel "Add Class" on the Code category: create a class-file stub in
 *  the working project's language (Name.cs or Name.vb). */
export async function addCsFile(): Promise<void> {
    const projDir = await workspaceProjectDir('any');
    if (!projDir) {
        vscode.window.showWarningMessage('UI Maker: this action requires a .NET working project.');
        return;
    }
    const project = anyProjectPath(projDir);
    const isVb = !!project && /\.vbproj$/i.test(project);
    const ext = isVb ? 'vb' : 'cs';
    const name = await vscode.window.showInputBox({
        prompt: `Class name for the new .${ext} file`,
        placeHolder: 'FileProcessor',
        validateInput: v => isCSharpIdentifier(v.trim())
            ? undefined
            : 'Use a non-keyword class name (letters, digits, underscore).'
    });
    if (!name) { return; }
    const cls = name.trim();
    const file = path.join(projDir, `${cls}.${ext}`);
    if (fs.existsSync(file)) {
        vscode.window.showWarningMessage(`UI Maker: ${cls}.${ext} already exists.`);
        return;
    }

    const ns = project && !isVb ? rootNamespace(project) : 'App';
    // VB projects apply their root namespace implicitly — no wrapper needed.
    const classSource = isVb
        ? `Public Class ${cls}\r\n` +
          `\r\n` +
          `End Class\r\n`
        : `using System;\r\n` +
          `\r\n` +
          `namespace ${ns}\r\n` +
          `{\r\n` +
          `    public class ${cls}\r\n` +
          `    {\r\n` +
          `    }\r\n` +
          `}\r\n`;
    try {
        createFilesAtomically([{ target: file, contents: classSource }]);
    } catch (err) {
        vscode.window.showErrorMessage(`UI Maker: could not create ${cls}.${ext} — ${err}`);
        return;
    }

    // Classic projects list every file; SDK projects glob sources automatically.
    if (project) {
        try {
            let xml = fs.readFileSync(project, 'utf8');
            if (!/<Project\s[^>]*\bSdk\s*=/.test(xml) && /<\/Project>/.test(xml)) {
                const eol = xml.includes('\r\n') ? '\r\n' : '\n';
                xml = xml.replace(/<\/Project>/,
                    `  <ItemGroup>${eol}    <Compile Include="${cls}.${ext}" />${eol}  </ItemGroup>${eol}</Project>`);
                replaceFileAtomically(project, xml);
            }
        } catch { /* non-fatal — the file still exists */ }
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
}

/** Side panel "Add Image" / "Add Resource": import files as project resources. */
export async function addResourceFiles(imagesOnly: boolean): Promise<void> {
    const projDir = await workspaceProjectDir();
    if (!projDir) {
        vscode.window.showWarningMessage(
            'UI Maker: resource import currently requires a C# (.csproj) working project — Visual Basic projects manage resources in Visual Studio (My.Resources).');
        return;
    }
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: imagesOnly ? 'Add Image(s)' : 'Add Resource(s)',
        filters: imagesOnly ? IMAGE_FILTERS : { 'All files': ['*'] }
    });
    if (!picked?.length) { return; }

    const keys: string[] = [];
    for (const uri of picked) {
        const res = importResourceFile(path.join(projDir, 'placeholder'), uri.fsPath);
        if (res) { keys.push(res.key); }
    }
    if (keys.length) {
        vscode.window.showInformationMessage(
            `UI Maker: added ${keys.length} resource${keys.length === 1 ? '' : 's'} — ` +
            `use Properties.Resources.${keys[0]} in your code.`);
    }
}

// ------------------------------------------------------------------ resolve

/**
 * Resolve the image references a designer document uses so the canvas can
 * draw them. Project resources ("p") map to files via Resources.resx
 * filerefs; local form resources ("l") are read out of the form's own .resx
 * (bytearray-base64 entries) and returned as data: URIs.
 */
export function resolveImages(docPath: string, keys: ImageKey[]): Map<string, string> {
    const out = new Map<string, string>();
    if (!keys.length) { return out; }

    const projKeys = keys.filter(k => k.scope === 'p');
    if (projKeys.length) {
        const projDir = findProjectDir(docPath);
        // C# keeps the project resx in Properties/; VB in "My Project".
        const file = projDir
            ? [resxPath(projDir), path.join(projDir, 'My Project', 'Resources.resx')]
                .find(f => fs.existsSync(f)) ?? null
            : null;
        if (file) {
            const entries = parseResxEntries(fs.readFileSync(file, 'utf8'));
            for (const k of projKeys) {
                const e = entries.find(x => x.name === k.key && x.fileRef);
                if (!e?.fileRef) { continue; }
                const rel = e.fileRef.split(';')[0].split('\\').join(path.sep);
                const abs = path.resolve(path.dirname(file), rel);
                if (fs.existsSync(abs)) { out.set(`p:${k.key}`, abs); }
            }
        }
    }

    // XAML paths resolve relative to the document, then the project folder.
    const xamlKeys = keys.filter(k => k.scope === 'x');
    if (xamlKeys.length) {
        const projDir = findProjectDir(docPath);
        const baseDirs = [path.dirname(docPath), ...(projDir ? [projDir] : [])];
        for (const k of xamlKeys) {
            const rel = k.key.split('/').join(path.sep);
            for (const base of baseDirs) {
                const abs = path.resolve(base, rel);
                try {
                    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                        out.set(`x:${k.key}`, abs);
                        break;
                    }
                } catch { /* unreadable — skip */ }
            }
        }
    }

    const localKeys = keys.filter(k => k.scope === 'l');
    if (localKeys.length) {
        // Main.Designer.cs/.Designer.vb -> Main.resx (next to the designer file).
        const resx = docPath.replace(/\.designer\.(cs|vb)$/i, '.resx');
        if (fs.existsSync(resx)) {
            const xml = fs.readFileSync(resx, 'utf8');
            for (const k of localKeys) {
                const uri = localResxImage(xml, k.key);
                if (uri) { out.set(`l:${k.key}`, uri); }
            }
        }
    }
    return out;
}

/** Decode one bytearray-base64 image from a form resx into a data URI. */
function localResxImage(xml: string, name: string): string | null {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(
        `<data name="${esc}"[^>]*mimetype="application/x-microsoft\\.net\\.object\\.bytearray\\.base64"[^>]*>\\s*<value>([\\s\\S]*?)</value>`,
        'i').exec(xml);
    if (!m) { return null; }
    const b64 = m[1].replace(/\s+/g, '');
    let bytes: Buffer;
    try { bytes = Buffer.from(b64, 'base64'); } catch { return null; }
    const mime =
        bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
        : bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
        : bytes.length > 3 && bytes.toString('ascii', 0, 3) === 'GIF' ? 'image/gif'
        : bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d ? 'image/bmp'
        : bytes.length > 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 ? 'image/x-icon'
        : null;
    if (!mime) { return null; } // BinaryFormatter payloads etc. — not renderable
    return `data:${mime};base64,${bytes.toString('base64')}`;
}
