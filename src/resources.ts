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

export interface ImportedImage {
    /** Resource name — a valid C# identifier. */
    key: string;
    /** C# expression for the Designer.cs assignment. */
    code: string;
    /** Absolute path of the imported image file. */
    fsPath: string;
}

/** A reference the webview wants resolved: project resx or local form resx. */
export interface ImageKey {
    scope: 'p' | 'l';
    key: string;
}

const IMAGE_FILTERS = { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico'] };
const ICON_FILTERS = { 'Icons': ['ico'] };

/** Walk up from a file to the directory containing a .csproj (or null). */
export function findProjectDir(startFile: string): string | null {
    let dir = path.dirname(startFile);
    for (let i = 0; i < 24; i++) {
        try {
            if (fs.readdirSync(dir).some(f => /\.csproj$/i.test(f))) { return dir; }
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

/** Root namespace: csproj RootNamespace, else the sanitized project name. */
function rootNamespace(csproj: string): string {
    try {
        const xml = fs.readFileSync(csproj, 'utf8');
        const root = /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/.exec(xml)?.[1];
        if (root) { return root; }
    } catch { /* fall through to the file name */ }
    const base = path.basename(csproj).replace(/\.csproj$/i, '');
    const ns = base.replace(/[^A-Za-z0-9_.]/g, '_');
    return /^[0-9]/.test(ns) ? `_${ns}` : ns;
}

/** File base name -> valid C# identifier ("refresh icon.png" -> "refresh_icon"). */
function resourceKey(file: string): string {
    const base = path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9_]/g, '_');
    return /^[0-9]/.test(base) ? `_${base}` : (base || '_image');
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
    const src = picked[0].fsPath;

    const projDir = findProjectDir(docPath);
    const csproj = projDir ? csprojPath(projDir) : null;
    if (!projDir || !csproj) {
        vscode.window.showWarningMessage('UI Maker: no .csproj found above this form — images need a project to import into.');
        return undefined;
    }

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

        // 2) Register in Properties/Resources.resx.
        const isIcon = /\.ico$/i.test(dest);
        const key = addResxFileRef(projDir, dest, isIcon);

        // 3) Regenerate the typed accessor class.
        const ns = rootNamespace(csproj);
        writeResourcesDesigner(projDir, ns);

        // 4) Classic csproj bookkeeping.
        registerResourceFiles(csproj, path.relative(projDir, dest));

        return { key, code: `global::${ns}.Properties.Resources.${key}`, fsPath: dest };
    } catch (err) {
        vscode.window.showErrorMessage(`UI Maker: could not import the image — ${err}`);
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

function resxPath(projDir: string): string {
    return path.join(projDir, 'Properties', 'Resources.resx');
}

/** Every <data name=...> entry in a resx, with its fileref value when present. */
function parseResxEntries(xml: string): Array<{ name: string; fileRef: string | null; isString: boolean }> {
    const out: Array<{ name: string; fileRef: string | null; isString: boolean }> = [];
    const re = /<data\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/data>/g;
    for (let m = re.exec(xml); m; m = re.exec(xml)) {
        const value = /<value>([\s\S]*?)<\/value>/.exec(m[3])?.[1] ?? '';
        const isFileRef = /ResXFileRef/.test(m[2]);
        out.push({
            name: m[1],
            fileRef: isFileRef ? value : null,
            isString: !isFileRef && !/type=|mimetype=/.test(m[2])
        });
    }
    return out;
}

/**
 * Add (or reuse) a fileref entry for the image; returns the resource name.
 * Creates Properties/Resources.resx when the project has none.
 */
function addResxFileRef(projDir: string, imageAbs: string, isIcon: boolean): string {
    const file = resxPath(projDir);
    if (!fs.existsSync(path.dirname(file))) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
    let xml = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : RESX_HEADER;

    // The fileref path is relative to the resx (Properties/) directory.
    const rel = path.relative(path.dirname(file), imageAbs).split('/').join('\\');
    const type = isIcon ? ICON_TYPE : BITMAP_TYPE;
    const value = `${rel};${type}`;

    const entries = parseResxEntries(xml);
    // Same file already registered? Reuse its name.
    const existing = entries.find(e => e.fileRef?.toLowerCase().startsWith(rel.toLowerCase() + ';'));
    if (existing) { return existing.name; }

    // Unique name derived from the file name.
    let key = resourceKey(imageAbs);
    const names = new Set(entries.map(e => e.name));
    for (let i = 1; names.has(key); i++) { key = `${resourceKey(imageAbs)}${i}`; }

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
    fs.writeFileSync(file, xml, 'utf8');
    return key;
}

/** Regenerate Properties/Resources.Designer.cs from the resx entries. */
function writeResourcesDesigner(projDir: string, rootNs: string): void {
    const file = resxPath(projDir);
    const entries = fs.existsSync(file) ? parseResxEntries(fs.readFileSync(file, 'utf8')) : [];
    const ns = `${rootNs}.Properties`;

    const props = entries.map(e => {
        if (e.isString) {
            return `        internal static string ${e.name} {\r\n` +
                `            get {\r\n` +
                `                return ResourceManager.GetString("${e.name}", resourceCulture);\r\n` +
                `            }\r\n` +
                `        }`;
        }
        const type = e.fileRef && /System\.Drawing\.Icon/.test(e.fileRef)
            ? 'System.Drawing.Icon' : 'System.Drawing.Bitmap';
        return `        internal static ${type} ${e.name} {\r\n` +
            `            get {\r\n` +
            `                object obj = ResourceManager.GetObject("${e.name}", resourceCulture);\r\n` +
            `                return ((${type})(obj));\r\n` +
            `            }\r\n` +
            `        }`;
    }).join('\r\n\r\n');

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

    fs.writeFileSync(path.join(projDir, 'Properties', 'Resources.Designer.cs'), code, 'utf8');
}

/**
 * Classic (non-SDK) projects list every file explicitly — register the resx
 * pair once and each imported image. SDK projects glob everything.
 */
function registerResourceFiles(csproj: string, imageRel: string): void {
    try {
        let xml = fs.readFileSync(csproj, 'utf8');
        if (/<Project\s[^>]*\bSdk\s*=/.test(xml)) { return; }
        if (!/<\/Project>/.test(xml)) { return; }
        const eol = xml.includes('\r\n') ? '\r\n' : '\n';
        let block = '';
        if (!xml.includes('Properties\\Resources.resx')) {
            block +=
                `    <EmbeddedResource Include="Properties\\Resources.resx">${eol}` +
                `      <Generator>ResXFileCodeGenerator</Generator>${eol}` +
                `      <LastGenOutput>Resources.Designer.cs</LastGenOutput>${eol}` +
                `    </EmbeddedResource>${eol}` +
                `    <Compile Include="Properties\\Resources.Designer.cs">${eol}` +
                `      <AutoGen>True</AutoGen>${eol}` +
                `      <DesignTime>True</DesignTime>${eol}` +
                `      <DependentUpon>Resources.resx</DependentUpon>${eol}` +
                `    </Compile>${eol}`;
        }
        const imgEntry = imageRel.split('/').join('\\');
        if (!xml.includes(`"${imgEntry}"`)) {
            block += `    <None Include="${imgEntry}" />${eol}`;
        }
        if (!block) { return; }
        xml = xml.replace(/<\/Project>/, `  <ItemGroup>${eol}${block}  </ItemGroup>${eol}</Project>`);
        fs.writeFileSync(csproj, xml, 'utf8');
    } catch {
        vscode.window.showWarningMessage('UI Maker: could not register the resource files in the project — add them manually.');
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
        const file = projDir ? resxPath(projDir) : null;
        if (file && fs.existsSync(file)) {
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

    const localKeys = keys.filter(k => k.scope === 'l');
    if (localKeys.length) {
        // Main.Designer.cs -> Main.resx (next to the designer file).
        const resx = docPath.replace(/\.designer\.cs$/i, '.resx');
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
