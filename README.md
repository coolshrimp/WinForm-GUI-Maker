# UI Maker

**Design, build, and run .NET desktop apps — without ever leaving VS Code.**

UI Maker is an open-source Visual Studio Code extension that brings a drag-and-drop
form designer, one-click build/run/debug/release buttons, and project scaffolding for
.NET desktop applications (WPF and Windows Forms, **C# and Visual Basic**) directly
into the editor. No more switching to full Visual Studio just to lay out a window.

![The UI Maker designer, side panel, and run buttons](screenshots/main.png)

| Visual designer | Side panel |
|---|---|
| ![Drag-and-drop designer with the VS-style property grid](screenshots/designer.png) | ![Actions, recent projects, and per-project file lists](screenshots/panel.png) |

---

## Why UI Maker?

The .NET CLI (`dotnet`) can create, build, and run desktop apps entirely from VS Code,
but there has never been a good *visual* way to design the UI here. Editing
`MainWindow.xaml` by hand is fine for experts — and a wall for everyone else.

UI Maker closes that gap:

| Pain point | UI Maker answer |
|---|---|
| Hand-writing XAML layout | Drag-and-drop visual designer with snap-to-grid canvas |
| No IntelliSense when you *do* edit XAML by hand | Element/attribute/value completions, snippets, hover docs, and an inline color picker in the text editor |
| Guessing property names | A real Properties window — categorized like Visual Studio's, with dropdowns, color pickers, Anchor toggles, and a description pane |
| Adding images and icons | Pick a file → it's imported into `Resources/`, registered in `Resources.resx`, and referenced from the Designer.cs — exactly like VS |
| Wiring events by hand | Events panel — one click writes the handler stub into the code-behind |
| Switching between design and markup | Split view: designer on one side, live XAML source on the other |
| CLI-only build workflow | Build / Run / Debug / Release buttons in the status bar and editor title |
| Starting a new app | "New .NET Desktop Project" scaffolds WPF, WinForms, or Console apps (C# or VB) via `dotnet new` |
| "Works on my machine" builds | Detects missing .NET Framework reference assemblies (MSB3644) and offers the fix; classic projects build through Visual Studio's MSBuild automatically |

## Features

### 🧰 UI Maker side panel
Click the **UI Maker icon in the activity bar** (the window-with-controls glyph on
the far left) to open the side panel:

- **Actions** — New Project, Build, Run, Debug, Release, App Settings, Open
  Working Folder, and the built-in Guide, one click away. Run and Debug are
  toggles: a green play button while idle that becomes a red stop button while
  your app is running. The first row shows the **Working Folder** — the one
  project that Run/Build/Debug/Release/App Settings and every file list
  target. It follows the file you are editing and is per-project (like SFTP
  configs), so opening a parent folder full of projects never lets one
  project's action touch another. Click the row to switch projects.
- **Recent Projects** — every .NET project you open or create, tagged with its
  type (`WinForms · .NET 8`, `WPF · .NET Framework 4.7.2`, …); click to switch.
  Hover a project for one-click **Open in New Window**, **Open Folder in File
  Explorer**, and **Remove**.
- **XAML Windows** and **WinForms Forms** — every designable file in the
  *working project*, C# (`*.Designer.cs`) and Visual Basic (`*.Designer.vb`)
  alike; click one to open it straight in the visual designer. Use
  the **+** button on a group to add a new window/form, or a row's
  **Duplicate** action to copy an existing one (new class name, registered in
  the project, opened in the designer). The lists update automatically as
  files change. When the opened folder contains **several** projects, nothing
  is listed wholesale — the panel asks you to choose a working folder first,
  and build output / caches (`bin`, `obj`, `packages`, `.vs`, `node_modules`)
  are never scanned. Files with no visual surface (App.xaml, resource
  dictionaries, Designer.cs files without `InitializeComponent`) skip the
  designer and open straight in the code editor.
- **Project Files** — everything else in the workspace, sorted into
  solution-explorer-style categories: **Code**, **Images & Icons**,
  **Resources**, **Data & Config**, **Project & Solution**, and **Other**,
  with real file icons and click-to-open. The categories have inline **＋**
  buttons: *New Class File* (a `.cs` or `.vb` stub matching the working
  project's language, registered in the project),
  *Add Image*, and *Add Resource* — files are imported into `Resources/`,
  registered in `Properties/Resources.resx` with the right CLR type (Bitmap,
  Icon, String, or byte[]), and exposed through a regenerated
  `Resources.Designer.cs`, so `Properties.Resources.name` just works.

### 🎨 Visual Designer for XAML
Open any `.xaml` window in the UI Maker Designer:

- **Toolbox** with a search box and Visual Studio's sections. WPF: Button,
  Label, TextBox, TextBlock, CheckBox, RadioButton, ComboBox, ListBox,
  DataGrid, Image, ProgressBar, Slider, Border, GroupBox, DatePicker, and
  more. WinForms mirrors the VS toolbox: **Common Controls** (Button, Label,
  LinkLabel, TextBox, MaskedTextBox, RichTextBox, CheckBox, RadioButton,
  CheckedListBox, ComboBox, DomainUpDown, ListBox, ListView, TreeView,
  PictureBox, ProgressBar, TrackBar, NumericUpDown, DateTimePicker,
  MonthCalendar, HScrollBar, VScrollBar, WebBrowser, PropertyGrid),
  **Containers** (GroupBox, Panel, FlowLayoutPanel, TableLayoutPanel,
  SplitContainer, Splitter, TabControl), **Menus & Toolbars**, **Data**
  (DataGridView, BindingSource), **Components**, **Dialogs**, and
  **Printing** (PrintDialog, PrintDocument, PrintPreviewDialog,
  PageSetupDialog). Drag a tool onto the form or **double-click** it to add
  one at a default spot.
- **Right-click context menus everywhere** — on any control: Cut / Copy /
  Paste / Duplicate / Delete, **Bring to Front / Send to Back**, Select
  Parent, wire the default event, and jump to Properties/Events. Per-type
  verbs match VS: **Add Tab / Remove Tab** on TabControls and tab pages,
  **Add Item / Edit Items…** on MenuStrip/ToolStrip/StatusStrip, and **Edit
  Items…** on ListBox, ComboBox, CheckedListBox, and DomainUpDown (one line
  per item, written back as `Items.AddRange`). Right-click the form or the
  component tray for their own menus.
- **Collapsible side panels** — the ⮜ / ⮞ chevron in the Toolbox and
  Properties headers folds either panel into a thin strip, giving the canvas
  the full editor width; click the strip to bring the panel back. The designer
  remembers the choice while the tab stays open.
- **Design canvas** that mimics a real window (title bar, client area) with
  snap-to-grid placement, drag to move, 8-point resize handles — and grips on
  the window's own edges to resize the form/window itself.
- **Properties window, Visual Studio style** — properties grouped under
  collapsible categories (Accessibility, Appearance, Behavior, Data, Design,
  Focus, Layout, Window Style) with a Categorized / A–Z toggle and a
  description pane at the bottom. Enums and booleans are dropdowns with their
  defaults shown, colors get a picker + named/system color autocomplete,
  fonts use the familiar `Segoe UI, 9pt, style=Bold` format, and WinForms
  `Anchor` is edited with Top/Bottom/Left/Right toggle buttons.
  Explicitly-set values render **bold**, and clearing a value removes it from
  the file — exactly like VS.
- **Images and icons** — `Image`, `BackgroundImage`, and the form `Icon`
  (.png/.jpg/.gif/.bmp/.ico) are picked with a file dialog and imported the
  way Visual Studio does it: copied into `Resources/`, registered in
  `Properties/Resources.resx`, exposed through a regenerated
  `Resources.Designer.cs`, and referenced as
  `Properties.Resources.name` in the form code. Placement and scaling are
  full VS: `ImageAlign`, `TextImageRelation`, `BackgroundImageLayout`, and
  PictureBox `SizeMode` — all previewed live on the canvas.
- **Events panel** — type a handler name (or accept the default) and UI Maker sets
  the XAML attribute *and* generates the C# method stub in the `.xaml.cs` code-behind.
- **Double-click a control** to wire its default event, exactly like classic designers.
- **Multi-select and alignment tools** — Ctrl/Shift+click controls, drag the
  group, then use the toolbar to align edges, match sizes, or distribute
  evenly. **⇥ Tab Order** overlays TabIndex badges; click controls in
  sequence to re-number them (WinForms).
- **Rename controls safely** — edit `(Name)` in the grid and, when the C#
  language service is installed, UI Maker performs a solution-wide symbol
  rename just like VS (with a safe Designer/code-behind fallback). Visual
  Basic renames are case-insensitive and update `Handles` clauses in the
  code-behind. Handler names and user-visible strings are kept.
- **Component tray** — Timer, ToolTip, ContextMenuStrip, NotifyIcon,
  BackgroundWorker, ImageList, ErrorProvider, HelpProvider, BindingSource,
  FileSystemWatcher, Process, the file/color/font/folder dialogs, and the
  printing components drop into a tray below the form, VS-style, with their
  own properties and events (WinForms). Components that need extra NuGet
  packages on modern .NET (SerialPort, EventLog, PerformanceCounter,
  ServiceController, MessageQueue) are left out on purpose so generated code
  always compiles.
- **Menus & status bars** — MenuStrip, ToolStrip, and StatusStrip with an
  *Items* editor (one line per item) that generates the ToolStrip item
  classes in the Designer.cs; docked strips push each other for space like
  the real layout engine, and TabControl drops with two ready pages.
- Keyboard support: arrow keys nudge, `Shift`+arrows move by grid, `Delete` removes,
  `Ctrl+D` duplicates, `Ctrl+X`/`Ctrl+C`/`Ctrl+V` cut, copy & paste —
  including onto a *different* form. Structural containers/items are guarded
  from shallow Cut/Duplicate operations until deep cloning can preserve their
  children. `Esc` closes menus and clears the selection.

### ↔️ Split Design / Code view
The **View Code** button opens the raw XAML beside the designer. Edits flow both ways:
change the markup and the canvas refreshes; move a control and the markup updates.

### ⌨️ XAML IntelliSense in the text editor
Prefer typing markup by hand sometimes? The plain text editor now understands
XAML too — no Visual Studio, no extra extensions:

- **Element completion** — type `<` and get the whole WPF catalog (panels,
  controls, shapes, menus, Grid plumbing) with one-line descriptions.
  Containers insert an open/close pair, leaf controls self-close. Type `</`
  and the innermost still-open tag closes itself.
- **Attribute completion** — inside a tag you're offered exactly what that
  element supports: its own properties, the common layout set (`Margin`,
  `HorizontalAlignment`, `Grid.Row`, `DockPanel.Dock`, …), and its events.
  Attributes already on the tag aren't offered twice.
- **Value completion** — inside the quotes, enums list their members
  (`Visibility` → `Visible / Hidden / Collapsed`), booleans offer
  `True`/`False`, and brush properties offer all 141 named XAML colors with
  a preview swatch.
- **Code snippets** — type a prefix and expand a ready block: `window`
  (full Window skeleton), `grid2x2`, `gridrows`/`gridcols`, `stack`, `dock`
  (menu + status bar + content shell), `button`, `labeltext`, `combo`,
  `listbox`, `datagrid`, `tabs`, `menu`, `groupbox`, `scroll`, `image`,
  `style`, `buttonrow` (OK/Cancel), `statusbar`, and `contextmenu` — with
  tab stops on the parts you'll want to rename.
- **Hover documentation** — hover any element or attribute for a plain-English
  description, its type, and the allowed values.
- **Inline color swatches & picker** — every `Background`, `Foreground`,
  `BorderBrush`, `Fill`, `Stroke`, … value shows a color chip right in the
  code; click it to open VS Code's native color picker. Picking a color writes
  the hex back (or the friendly name when one matches exactly).

Everything is scoped to `.xaml` files only and can be switched off with the
`uimaker.xamlIntelliSense` setting.

### 🔨 Build, Run, Debug, Release buttons
Status-bar buttons (and editor-title shortcuts) drive the .NET CLI for you:

- **Build** — builds with errors reported in the Problems panel.
- **Run** — builds and launches your app; the button turns into a red **Stop**
  while it runs and flips back when the app exits.
- **Debug** — builds, then attaches the right .NET debugger (`coreclr` for
  modern .NET, `clr` for .NET Framework — uses the
  [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp)
  when installed; falls back to plain run otherwise).
- **Release** — publishes a Release build, then jumps you to the output folder.
  Settings under **UI Maker › Publish** turn this into a real installer-free
  distribution: **Single File** (one .exe), **Self Contained** (bundles the
  .NET runtime so the target PC needs nothing installed), and the target
  **Runtime** (win-x64 / win-x86 / win-arm64).
- **Multi-target projects** — Run, Debug, and Publish ask for the active
  target framework once and reuse it for the session; build/output discovery
  and the debugger all use that same TFM.

Builds are protected so they work on any dev machine: projects targeting
.NET Framework without the reference assemblies installed (error MSB3644) get
an offer to add the `Microsoft.NETFramework.ReferenceAssemblies` build helper,
and classic non-SDK projects are built with Visual Studio's MSBuild (found via
vswhere) since the `dotnet` CLI cannot load them. Apps whose manifest requests
administrator rights are detected too — Run builds them and launches the exe
through a UAC prompt instead of failing with "requires elevation".

### 🚀 Project scaffolding
`UI Maker: New .NET Desktop Project` asks for a template (WPF, Windows Forms,
or Console), a language (C# or Visual Basic), a target framework, a name, and
a folder — then generates a ready-to-run app and offers to open it.

### 🛠️ Project Properties page
**Project Properties** (side panel → Actions) is Visual Studio's *Application*
tab inside VS Code: output type, target framework (offering the SDKs actually
installed on your machine), assembly name, default namespace, startup object,
application icon and manifest (with Browse… pickers), plus the package/assembly
info (version, authors, product, description, copyright) for SDK-style
projects. Changes are written straight into the `.csproj` — an existing
property is updated in place, a cleared one is removed so the SDK default
applies again.

Old-format projects get a **Convert to SDK style** button right on this page —
see below.

### 📦 NuGet package manager
**NuGet Packages** (side panel → Actions) is the *Manage NuGet Packages*
window: **Browse** searches nuget.org (with an *include prerelease* toggle),
**Installed** lists the project's `PackageReference`s with one-click
uninstall, and **Updates** checks every installed package against the latest
stable release. Install/update/uninstall run `dotnet add|remove package`, so
the project file and restore stay consistent.

### ⬆️ Convert classic projects to SDK style
Old .NET Framework projects use a project format modern tooling can't load —
C# Dev Kit shows *“The project file is in unsupported format”*. **UI Maker:
Convert Project to SDK Style** rewrites the `.csproj` as a minimal SDK-style
project with the same target framework, names, icon, manifest, and build
events; `packages.config` entries become `PackageReference`s; framework
references become implicit; `Settings.settings`/`Resources.resx` keep their
designers. The original file is kept as `<name>.csproj.legacy.bak`, so undoing
the conversion is a two-file rename.

### ⚙️ App Settings editor
**App Settings** (side panel → Actions) is the Visual Studio *Project
Properties → Settings* page, inside VS Code: a grid of settings your built app
remembers — name, type (string/int/bool/double/long/DateTime), **User** or
**Application** scope, and a default value. Saving writes the same
`Properties/Settings.settings` + `Settings.Designer.cs` pair Visual Studio
generates, so the project stays fully compatible with VS. In your app:

```csharp
var name = Properties.Settings.Default.PlayerName;   // read
Properties.Settings.Default.PlayerName = "Ada";      // change (User scope)
Properties.Settings.Default.Save();                  // persist per user
```

### 📖 Built-in guide
New to .NET desktop apps? **Guide — How to Build an App** (side panel, the book
icon, or the Command Palette) opens an illustrated walkthrough: the workflow
from empty folder to shipped `.exe`, the full file tree of a WPF and a WinForms
project, which files are required / optional / generated, and what every single
file is for.

## Getting started

1. Install the [.NET SDK](https://dotnet.microsoft.com/download) (8.0 or newer recommended).
2. Install UI Maker (from source, see below — Marketplace listing planned).
3. Run **`UI Maker: New .NET Desktop Project`** from the Command Palette
   (`Ctrl+Shift+P`), or open a folder that already contains a `.csproj`.
4. Click the **UI Maker icon in the activity bar** and pick a window under
   **XAML Windows** — or right-click a `.xaml` file → **Open With… →
   UI Maker Designer** (or click the designer icon in the editor title bar).
5. Drag controls from the toolbox, set properties, wire events.
6. Hit **▶ Run** in the status bar.

### Running from source

```bash
git clone <this repo>
cd uimaker
npm install
npm run compile
```

Before packaging or submitting a change, run the complete local gate:

```bash
npm run check
```

Open the folder in VS Code and press `F5` — an Extension Development Host window
launches with UI Maker loaded.

## Commands

| Command | What it does |
|---|---|
| `UI Maker: New .NET Desktop Project` | Scaffold a WPF, WinForms, or Console app (C#/VB) via `dotnet new` |
| `UI Maker: New WPF Window` | Add a `.xaml` + code-behind pair (`.xaml.cs` / `.xaml.vb`) to the project |
| `UI Maker: New WinForms Form` | Add a Form in the project's language (`.cs` + `.Designer.cs`, or `.vb` + `.Designer.vb`) |
| `UI Maker: Open in Designer` | Open the current `.xaml`, `*.Designer.cs`, or `*.Designer.vb` file in the visual designer |
| `UI Maker: View XAML Source (Beside)` | Split view — XAML text editor next to the designer |
| `UI Maker: Build` | Build (Debug configuration) |
| `UI Maker: Run / Stop App` | Build and launch the app, or stop it if running |
| `UI Maker: Debug / Stop Debugging` | Build and debug the app, or stop the session |
| `UI Maker: Build Release (Publish)` | Publish a Release build (honors the single-exe settings) |
| `UI Maker: Stop Running App` | Terminate the app started by Run |
| `UI Maker: App Settings` | Grid editor for the settings your app remembers (`Properties.Settings`) |
| `UI Maker: Project Properties` | VS-style Application page — output type, framework, assembly name, icon, manifest, version info |
| `UI Maker: NuGet Packages` | Browse / install / update / remove nuget.org packages for the working project |
| `UI Maker: Convert Project to SDK Style` | Rewrite a classic .NET Framework `.csproj` in the modern SDK format (backup kept) |
| `UI Maker: Open Working Folder` | Show the current project folder in File Explorer |
| `UI Maker: Guide: How to Build an App` | Open the built-in guide (project anatomy, required vs. optional files) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `uimaker.gridSize` | `8` | Snap grid size in pixels on the design canvas |
| `uimaker.snapToGrid` | `true` | Snap control positions/sizes to the grid |
| `uimaker.xamlIntelliSense` | `true` | XAML completions, snippets, hover docs, and inline color swatches in the text editor |
| `uimaker.publish.singleFile` | `false` | Build Release (Publish) produces one portable `.exe` |
| `uimaker.publish.selfContained` | `false` | Bundle the .NET runtime so the target PC needs nothing installed |
| `uimaker.publish.runtime` | `win-x64` | Target runtime for single-file / self-contained publishing |

## How it works

- The designer is a [Custom Text Editor](https://code.visualstudio.com/api/extension-guides/custom-editors)
  bound to `*.xaml`. It parses the XAML into a document model, renders an HTML
  approximation of each control on a canvas, and writes changes back as plain text —
  so the `.xaml` file stays the single source of truth and normal git diffs still work.
- Controls are positioned the same way Visual Studio's designer does it:
  `HorizontalAlignment="Left" VerticalAlignment="Top" Margin="x,y,0,0"` inside the
  root `Grid` (or `Canvas.Left`/`Canvas.Top` when the root panel is a `Canvas`).
- Build/Run/Release are thin, transparent wrappers over the `dotnet` CLI — nothing
  proprietary, no lock-in, and everything it runs is visible in the terminal.

### A note on WPF vs. Windows Forms

Files like `MainWindow.xaml` belong to **WPF** (or WinUI), the markup-based way
to build Windows desktop UIs. **Windows Forms** stores its layout in generated
code (`*.Designer.cs` in C#, `*.Designer.vb` in Visual Basic) instead — and UI
Maker designs all of them: open a `.xaml` window, a `Form.Designer.cs`, or a
`Form.Designer.vb` file in the designer and get the same drag-and-drop canvas,
properties panel, and event wiring. WinForms edits are surgical — only the
affected `this.control.Prop = …;` / `Me.Control.Prop = …` statements change, so
diffs stay clean, and generated code follows the file's own dialect (`Me.` vs
`this.`, qualified vs. implicit namespaces, VB literals like `True` and `9.75!`).

Visual Basic events work the VB way: wiring an event writes a
`Private Sub … Handles Button1.Click` into the code-behind (creating the stub
if needed), the events panel reads existing `Handles` clauses live, and
clearing an event removes just its `Handles` target — handler code is never
deleted.

## Known limitations

- Nested layouts (Grid rows/columns, StackPanel, DockPanel, TabControl,
  ScrollViewer, …) **render** faithfully, and any element can be selected,
  resized, and edited in the panels — but drag-to-move is only offered for
  Canvas children and absolutely-placed Grid children (`Left`/`Top`
  alignment), because moving a stacked/docked child would rewrite its layout.
- Styles are resolved for `{StaticResource}` setters; templates, triggers, and
  bindings are ignored in the preview.
- Images assigned in old projects as *local* form resources
  (`resources.GetObject(...)` with base64 in the form's `.resx`) render on the
  canvas when they are plain image bytes; BinaryFormatter-serialized ones
  cannot be previewed. Newly assigned images always use project resources.
- Strip *Items* editing covers one level — nested sub-menus and per-item
  icons/events still need the code view (roadmapped).
- Structural WinForms containers can be deleted safely, but deep
  Cut/Copy/Duplicate of containers, generated menu items, and grid columns is
  intentionally disabled until every nested object can be cloned losslessly.
- Without the C# language service, control rename falls back to the
  Designer.cs/code-behind pair; project-wide references then need a manual rename.
- Visual Basic parity covers the WinForms designer (`*.Designer.vb`
  round-tripping), Add Form/Window, Duplicate, New Class, event stubs with
  `Handles` clauses, and control rename. Still C#-only for now: the App
  Settings editor, classic→SDK conversion, and importing new images as
  project resources in VB projects (`My.Resources` generation) — existing VB
  images render fine on the canvas.
- The classic-project converter deliberately stops before writing when it finds
  custom imports/targets, conditional target frameworks, framework profiles,
  or package install-script/content semantics it cannot migrate safely.
- Saving from the designer normalizes the XAML formatting (like most visual designers).
- The visual preview is an approximation — always confirm with **Run**.
- Windows-only targets (WPF/WinForms are Windows frameworks).

## Roadmap

- [x] Windows Forms visual designer (`*.Designer.cs` round-tripping)
- [x] Nested layout rendering (StackPanel / DockPanel / Grid rows & columns / TabControl)
- [x] Visual Studio-style categorized property grid (Anchor/Dock, colors, fonts, full form properties)
- [x] Images & icons imported as project resources, with VS placement/scaling options
- [x] Control renaming that safely updates the code-behind
- [x] MenuStrip / ToolStrip / StatusStrip designers and a component tray (Timer, ToolTip, ContextMenuStrip, dialogs)
- [x] Multi-select, alignment & distribution tools, tab-order view, copy/paste across forms
- [x] Docked controls that push each other for space; TabControl and tab-page drops
- [x] Visual Basic WinForms designer (`*.Designer.vb` round-tripping, `Handles`-based events, VB scaffolding)
- [ ] Remaining VB parity: App Settings editor, classic→SDK conversion, `My.Resources` image import
- [ ] Sub-menu (nested menu item) designing and item icons
- [ ] Drag-reordering inside StackPanel / DockPanel children
- [ ] "Create an Installer" for multi-file releases (Inno Setup script generation)
- [ ] Style/resource editing and live theme preview
- [ ] Marketplace publishing and prebuilt VSIX releases

### Beyond 1.0 — premium ideas (v2.0)

The long-term vision is a complete build-and-release studio, with a premium
tier on top of the free core:

- **Third-party UI library packs** — design-time support for modern control
  suites like **Guna UI**, **Telerik UI for WinForms**, Krypton, and
  MaterialSkin: their controls in the toolbox, rendered previews, and the
  right NuGet references added automatically.
- **Themed chrome presets** — one-click looks such as Office-2007-style
  ribbons and menus, dark mode, and rounded "modern app" styling.
- **One-click releasing** — installer builds (Inno Setup), code signing,
  version bumping, and update feeds, from the same Release button.

## Contributing

Issues and pull requests are welcome. The codebase is intentionally small and heavily
commented — `src/` holds the extension host code (TypeScript), `media/` holds the
designer webview (plain JS/CSS).

## License

MIT — see the LICENSE file.
