# UI Maker

**Design, build, and run .NET desktop apps — without ever leaving VS Code.**

UI Maker is an open-source Visual Studio Code extension that brings a drag-and-drop
form designer, one-click build/run/debug/release buttons, and project scaffolding for
.NET desktop applications (WPF and Windows Forms) directly into the editor. No more
switching to full Visual Studio just to lay out a window.

---

## Why UI Maker?

The .NET CLI (`dotnet`) can create, build, and run desktop apps entirely from VS Code,
but there has never been a good *visual* way to design the UI here. Editing
`MainWindow.xaml` by hand is fine for experts — and a wall for everyone else.

UI Maker closes that gap:

| Pain point | UI Maker answer |
|---|---|
| Hand-writing XAML layout | Drag-and-drop visual designer with snap-to-grid canvas |
| Guessing property names | Properties panel with the common properties per control |
| Wiring events by hand | Events panel — one click writes the handler stub into the code-behind |
| Switching between design and markup | Split view: designer on one side, live XAML source on the other |
| CLI-only build workflow | Build / Run / Debug / Release buttons in the status bar and editor title |
| Starting a new app | "New .NET Desktop Project" command scaffolds WPF or WinForms via `dotnet new` |

## Features

### 🧰 UI Maker side panel
Click the **UI Maker icon in the activity bar** (the window-with-controls glyph on
the far left) to open the side panel:

- **Actions** — New Project, Build, Run, Debug, Release, and Stop, one click away.
- **XAML Windows** — every `.xaml` file in the workspace; click one to open it
  straight in the visual designer. The list updates automatically as files are
  added, renamed, or removed.

### 🎨 Visual Designer for XAML
Open any `.xaml` window in the UI Maker Designer:

- **Toolbox** of common WPF controls — Button, Label, TextBox, TextBlock, CheckBox,
  RadioButton, ComboBox, ListBox, DataGrid, Image, ProgressBar, Slider, Border,
  GroupBox, DatePicker.
- **Design canvas** that mimics a real window (title bar, client area) with
  snap-to-grid placement, drag to move, and 8-point resize handles.
- **Properties panel** — edit Name, size, margins, content, colors, fonts, and more.
- **Events panel** — type a handler name (or accept the default) and UI Maker sets
  the XAML attribute *and* generates the C# method stub in the `.xaml.cs` code-behind.
- **Double-click a control** to wire its default event, exactly like classic designers.
- Keyboard support: arrow keys nudge, `Shift`+arrows move by grid, `Delete` removes,
  `Ctrl+D` duplicates.

### ↔️ Split Design / Code view
The **View Code** button opens the raw XAML beside the designer. Edits flow both ways:
change the markup and the canvas refreshes; move a control and the markup updates.

### 🔨 Build, Run, Debug, Release buttons
Status-bar buttons (and editor-title shortcuts) drive the .NET CLI for you:

- **Build** — `dotnet build` with errors reported in the Problems panel.
- **Run** — builds and launches your app in a dedicated terminal.
- **Debug** — builds, then attaches the .NET debugger (uses the
  [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp)
  when installed; falls back to plain run otherwise).
- **Release** — `dotnet publish -c Release`, then jumps you to the publish folder.
- **Stop** — kills the running app.

### 🚀 Project scaffolding
`UI Maker: New .NET Desktop Project` asks for a template (WPF or Windows Forms),
a name, and a folder — then generates a ready-to-run app and offers to open it.

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
cd formforge
npm install
npm run compile
```

Open the folder in VS Code and press `F5` — an Extension Development Host window
launches with UI Maker loaded.

## Commands

| Command | What it does |
|---|---|
| `UI Maker: New .NET Desktop Project` | Scaffold a WPF or WinForms app via `dotnet new` |
| `UI Maker: Open in Designer` | Open the current `.xaml` file in the visual designer |
| `UI Maker: View XAML Source (Beside)` | Split view — XAML text editor next to the designer |
| `UI Maker: Build` | `dotnet build` (Debug configuration) |
| `UI Maker: Run App` | Build and launch the app |
| `UI Maker: Debug App` | Build and launch under the debugger |
| `UI Maker: Build Release (Publish)` | `dotnet publish -c Release` |
| `UI Maker: Stop Running App` | Terminate the app started by Run |

## Settings

| Setting | Default | Description |
|---|---|---|
| `formforge.gridSize` | `8` | Snap grid size in pixels on the design canvas |
| `formforge.snapToGrid` | `true` | Snap control positions/sizes to the grid |

> UI Maker started life as "FormForge", and the internal identifiers
> (settings keys, command IDs, the extension ID) keep that name so existing
> installs and settings continue to work.

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
C# (`*.Designer.cs`) instead — and UI Maker designs both: open a `.xaml` window
or a `Form.Designer.cs` file in the designer and get the same drag-and-drop
canvas, properties panel, and event wiring. WinForms edits are surgical — only
the affected `this.control.Prop = …;` statements change, so diffs stay clean.

## Known limitations (v0.3)

- Nested layouts (Grid rows/columns, StackPanel, DockPanel, TabControl,
  ScrollViewer, …) **render** faithfully, and any element can be selected,
  resized, and edited in the panels — but drag-to-move is only offered for
  Canvas children and absolutely-placed Grid children (`Left`/`Top`
  alignment), because moving a stacked/docked child would rewrite its layout.
- Styles are resolved for `{StaticResource}` setters; templates, triggers, and
  bindings are ignored in the preview.
- Saving from the designer normalizes the XAML formatting (like most visual designers).
- The visual preview is an approximation — always confirm with **Run**.
- Windows-only targets (WPF/WinForms are Windows frameworks).

## Roadmap

- [x] Windows Forms visual designer (`*.Designer.cs` round-tripping)
- [x] Nested layout rendering (StackPanel / DockPanel / Grid rows & columns / TabControl)
- [ ] WinForms Anchor/Dock-aware preview and control renaming
- [ ] Drag-reordering inside StackPanel / DockPanel children
- [ ] Alignment & distribution tools, multi-select
- [ ] Style/resource editing and live theme preview
- [ ] Marketplace publishing and prebuilt VSIX releases

## Contributing

Issues and pull requests are welcome. The codebase is intentionally small and heavily
commented — `src/` holds the extension host code (TypeScript), `media/` holds the
designer webview (plain JS/CSS).

## License

MIT — see the LICENSE file.
