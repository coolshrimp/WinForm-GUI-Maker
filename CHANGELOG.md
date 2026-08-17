# Changelog

## 0.20.1

**Publish-mode assistant on Build Release** (user request). Release now asks
how to publish, with the size/portability trade-off explained in plain
words, the current default marked, and the choice written back as the new
default:

* **Folder (default)** — all files in a folder; smallest build; the target
  PC's Windows offers to install the .NET Desktop Runtime automatically on
  first run. This is the mode Create Installer packages best.
* **Single EXE — smallest** — one portable .exe a few MB in size; the
  runtime is not bundled, so the target PC gets a one-time install prompt
  if .NET is missing.
* **Single EXE — runs anywhere** — the .NET runtime is bundled so nothing
  is ever prompted; large (~70–150 MB), now built with single-file
  compression enabled to keep it as small as possible.
* **Always use my settings — stop asking** flips the new
  `uimaker.publish.askMode` setting off; the existing `uimaker.publish.*`
  settings are then honored silently. Classic .NET Framework targets skip
  the question (they always publish as folders).

## 0.20.0

**Create an Installer + full Visual Basic parity** (user requests):

* **Create Installer** (Actions panel + palette) — packages the project's
  newest publish output into a Windows installer via Inno Setup. A
  customization page covers app name/version/publisher, a stable App ID
  GUID (upgrades replace instead of duplicating), setup icon, license file,
  architecture, desktop-shortcut / launch-after / per-user options, source
  folder (auto-detects the newest `bin\…\publish`), and the output folder
  (defaults to `<project>\Installer`, customizable and remembered).
  Generate the ready-to-compile `.iss` script, or Generate + Compile when
  Inno Setup 6 is installed (auto-detected; offered for download otherwise).
* **Installer settings memory, your way** — by default one **uniform
  template** is shared across all projects (identity fields still follow
  each project); the new `uimaker.installer.settingsScope` setting flips to
  **per-project** storage for multi-brand work. Each project keeps its own
  stable App ID either way.
* **VB parity complete** — the last three C#-only features now handle
  Visual Basic projects: the **App Settings** editor writes
  `My Project/Settings.settings` + `Settings.Designer.vb` (use
  `My.Settings.X` — the usage snippet adapts), **classic→SDK conversion**
  rewrites `.vbproj` files (VB targets import, `My Project/AssemblyInfo.vb`
  handling), and **image/resource import** generates the `My.Resources`
  accessor module (`My Project/Resources.resx` + `Resources.Designer.vb`,
  classic-project bookkeeping with the VB generator metadata). The designer's
  image picker and the sidebar's Add Image / Add Resource buttons now work
  in VB projects.
* **Fixed: "Open Folder in File Explorer" error** — folder reveals went
  through app associations on Windows and failed with "cannot find the file
  specified (0x2)"; folders now open directly in Explorer (also fixes Open
  Working Folder).

## 0.19.5

**Cursor icons in the picker.** Every option in the Cursor dropdowns (WPF and
WinForms) now shows a small drawn icon of that cursor — pointer, hand,
I-beam, hourglass, crosshair, the resize arrows, splitters, no-entry — so
you can see them all at a glance before hovering; hovering an option still
previews the real cursor live. Icons are inline SVGs in the current theme
color, crisp at any zoom.

## 0.19.4

More visual pickers (user request):

* **Cursor dropdowns preview the real cursor** — the Cursor row (WPF) and
  the WinForms Cursors row are now editable combos where hovering each
  option shows the actual cursor (Hand, IBeam, Wait, the resize arrows, …)
  right on the list item.
* **Directional glyphs on enum options** — alignment, dock, orientation,
  and visibility dropdowns in both panels prefix each option with a small
  glyph (↖ TopLeft, ← Left, ⛶ Fill, ⊘ Collapsed, …) for at-a-glance
  selection; the written value is unchanged.

## 0.19.3

Zoom ergonomics (user request): clicking the **Zoom** word in the toolbar
resets to 100%; the status-bar percentage now opens a **drop-up** preset
menu (50%–300%, with "100% (Default)" and the current level highlighted),
and double-clicking it snaps straight back to 100%.

## 0.19.2

Fix: **color swatches and font previews now actually show their colors and
faces.** The webview's Content-Security-Policy blocked inline style
attributes in generated markup, silently stripping the swatch colors and
font styling from the 0.19.0 pickers — and, it turns out, ProgressBar fill
widths and Slider thumb positions on the canvas too. Inline styles are now
allowed (interpolated text stays HTML-escaped; scripts remain nonce-only),
so swatches render their real color and progress bars/sliders draw at their
actual values.

## 0.19.1

Zoom + text-metric fixes from live testing:

* **Component tray follows the zoom** — the canvas scales with
  `transform: scale`, which reserves no layout space, so zooming in made
  the window overlap (and hide) the SelectFolder/SaveFile tray beneath it,
  and zooming out left a dead gap. The window now adds compensating margins
  matching its scaled size, so the tray docks correctly at every zoom level.
* **AutoSize captions hug their text** — autosized labels/checkboxes use
  max-content width (no phantom right padding) with slight negative letter
  tracking to bring browser text widths in line with GDI's, so captions no
  longer run into the control sitting to their right.

## 0.19.0

**Rich pickers in the property grid** (user request). Native dropdowns can't
style their options, so the panel gained a custom editable combo — the text
box still accepts anything (bindings, resources, odd values), and the ▾
button (or just typing, which filters live) opens a styled list:

* **Color swatches on every choice** — brush/color rows list the project's
  own `{StaticResource …}` brushes first, each with a live swatch square,
  then all named colors with their actual color; Transparent and
  unresolvable entries show a checkerboard. Works in both the WPF and
  WinForms panels (system colors included).
* **Fonts preview as themselves** — FontFamily lists each family rendered in
  its own face, FontSize shows every size at its actual size, FontWeight
  options render at their weight, FontStyle in its style.
* **WinForms Font row** gets a family dropdown too — each face previewed,
  and picking one keeps the existing `, 9pt, style=…` part of the value.
* Popups follow the input, flip upward when out of room, close on outside
  click/Escape, and typing filters the list.

## 0.18.7

Fix: WinForms labels, checkboxes, and radio buttons rendered a few pixels
right of their true position — the designer chrome added a 4px inner inset
that real WinForms controls don't have. Label-style controls now start their
glyph/text exactly at Location, and the check-glyph gap matches the native
4px spacing.

## 0.18.6

**Hover tooltips on every property row.** Both property panels (WPF and
WinForms) now show a native tooltip when hovering any row — the property
name plus the same plain-English description the bottom pane shows, without
needing to click first. Filled in ~26 missing WPF descriptions (Content,
Text, IsChecked, SelectedIndex, Stretch, Header, Orientation, scrollbar
visibilities, and friends); all 165 WinForms property definitions already
carried descriptions.

## 0.18.5

Canvas fidelity, from overlaying designer vs runtime screenshots:

* **Real check/radio glyphs** — CheckBox and RadioButton marks are now drawn
  13px Windows-11-style boxes and circles (blue fill + white check when
  checked) instead of undersized unicode characters.
* **Correct default text size** — the canvas previously inherited the
  editor's 13px UI font; controls now render with Segoe UI at 12px (9pt),
  the actual WinForms/WPF default, so text metrics line up with the running
  app. Explicit Font/FontSize properties still override per control.

## 0.18.4

Fix: **AutoSize checkboxes, radio buttons, and labels no longer wrap or clip
their captions** on the WinForms canvas. These controls size to their text at
runtime, but the designer was enforcing the Designer-file Size — a snapshot
that is often too small (different DPI/font when it was written). AutoSize
controls now grow naturally with the stored size as a floor, keeping captions
on one line exactly like the running app. Explicit AutoSize=False and docked
controls keep their stored dimensions.

## 0.18.3

Fix: opening a project in a new window (single-project workspace) showed no
**Working Folder** row in the Actions panel, so it looked like the project
was not targeted even though Run/Build were using it. The row now always
shows the active project — external working folders, multi-project picks,
and single-project workspaces alike.

## 0.18.2

Canvas quality-of-life (user requests):

* **Shift+scroll zoom** — hold Shift (or Ctrl) and scroll over the canvas to
  zoom in 5% steps, 25%–300%. The toolbar dropdown stays in sync (odd values
  show as a custom entry).
* **Zoom readout in a real status bar** — the bottom strip now shows the
  current zoom percentage on the right; click it to snap back to 100%.
* **Better image placeholders** — Image/PictureBox controls without a
  resolvable picture draw a clean scalable SVG photo glyph instead of the
  emoji, on a softer checkerboard; the placeholder disappears entirely once
  a real image resolves (set images always render — project resources,
  local resx bitmaps, and imported files alike).

## 0.18.1

**Windows 11 chrome on the WinForms canvas.** WinForms apps run with modern
visual styles, but the designer was drawing Windows-7-era control chrome —
dark-gray button borders, harsh outlines. WinForms documents now render with
the Windows 11 look: buttons are #FDFDFD with soft #D0D0D0 borders and 4px
rounded corners, text boxes and lists get the lighter #ACACAC outline,
GroupBoxes the near-invisible #D5D5D5 frame with normal-sized captions, and
progress bars/separators match. Dark BackColor forms also get the adaptive
designer chrome introduced in 0.16.2. WPF documents intentionally keep the
flatter gray defaults — that is what unstyled WPF really looks like.

## 0.18.0

**Recent Projects switch the working folder + auto-generated project files**
(user requests from live testing):

* **Clicking a Recent Project no longer hijacks your workspace** — it now
  switches UI Maker's *working folder* (Run, Build, and the file lists all
  retarget instantly), leaving your open folder and editors alone. The row's
  hover buttons still offer **Open in New Window** / **Open Folder in File
  Explorer** when you do want it as a workspace, and the "current" badge now
  follows the working folder.
* **Generate Project File** — pointing Open Project… at a folder of orphan
  sources (a WinForms/WPF app with no `.csproj`/`.vbproj` — copied code,
  legacy folders, loose source dumps) now offers to generate one: UI Maker
  detects the language (C#/VB) and UI flavor (WinForms/WPF/both) from the
  files, derives the RootNamespace from the namespaces the sources actually
  declare, keeps a legacy `AssemblyInfo.cs` authoritative
  (`GenerateAssemblyInfo=false`) to avoid duplicate-attribute errors, and
  writes a minimal SDK-style project targeting an installed .NET SDK (or
  net48 for classic-framework code). The folder then builds, runs, and
  designs like any other project — no Visual Studio needed to rescue it.

## 0.17.0

**Open Project — work on any project, from anywhere** (user request: run the
extension independent of the opened folder, FAP-Studio style). UI Maker no
longer requires the VS Code workspace to contain your .NET project:

* **Open Project… action** — first row of the side panel's Actions (also in
  the Command Palette): browse to any folder on disk, UI Maker finds the
  `.csproj`/`.vbproj` inside (up to 3 levels deep, with a picker when several
  are found) and makes it the working folder — without switching the VS Code
  workspace.
* **Everything follows the external working folder** — Run / Build / Debug /
  Release, App Settings, Project Properties, and NuGet already resolved the
  working folder first; now the sidebar's XAML Windows, WinForms Forms, and
  Project Files lists walk the external folder directly (workspace search
  can't see outside folders), the status-bar buttons appear, and file rows
  show project-relative paths.
* **No more dead ends** — the "no .NET project found in this workspace"
  warnings from Run and the working-folder picker now offer **Open
  Project…** right on the toast, and the working-folder quick-pick has an
  "Open Project (any folder)…" entry and keeps an externally opened project
  in its list.
* Opened projects are added to Recent Projects as usual.

## 0.16.2

**Adaptive designer chrome for light and dark apps.** The designer-only UI
drawn on the canvas — tab headers (which many apps hide at runtime; the strip
exists in the designer purely for switching pages), GroupBox captions, and
the unknown-control placeholder box — now picks its colors from the effective
window background: dark themes get bright, high-contrast tab text (the 0.16.1
gray-on-dark was hard to read), light themes keep dark text, and the active
tab is bolder with a brighter accent in both. The switch is automatic per
window, driven by the resolved background's luminance, so mixed light/dark
projects each look right.

## 0.16.1

Theme-preview polish after testing 0.16.0 against a real dark-themed app:

* **Tab strip and tab content blend with the app theme** — the TabControl
  header row and content area no longer use hardcoded white/light chrome;
  they draw with translucent neutral tones over whatever background the
  window/style provides, so dark apps stay dark in the designer.
* **No phantom borders** — `<Border>` elements without a `BorderThickness`
  no longer show the designer's old 1px gray outline (WPF's real default is
  0), so cards and status boxes match the running app exactly.

## 0.16.0

**The canvas now matches your running app** (user request: "the designer
should match the runtime"). The designer reads your project's application
resources instead of falling back to plain gray:

* **App.xaml awareness** — the extension host finds the project's App.xaml
  (plus one level of merged `ResourceDictionary Source="…"` files) and hands
  it to the designer. `{StaticResource}` brushes now resolve everywhere:
  window background, control backgrounds/foregrounds, borders, shapes, and
  the property-grid color swatches.
* **Implicit styles & BasedOn chains** — `<Style TargetType="Button">`
  restyles every button on the canvas; keyed styles chain through
  `BasedOn="{StaticResource {x:Type Button}}"` correctly, so themed apps
  (nav buttons, card borders, dark text boxes) preview like they run.
  Setter values that reference resources are no longer skipped, style
  `Padding`/`Margin`/`FontWeight` apply, and WPF weight names (SemiBold …)
  map to real CSS weights.
* **Templates & gradients, approximated** — a `ControlTemplate`'s first
  `<Border CornerRadius>` rounds the control's corners, and
  Linear/RadialGradientBrush resources render as CSS gradients with correct
  angles and stops.
* **Resource-aware brush editing** — brush rows in the property grid now
  autocomplete your own `{StaticResource …}` keys ahead of the named colors,
  and the swatch shows the resolved resource color.
* **Resizable side panels** — drag the splitter between the Toolbox /
  Properties panels and the canvas; widths persist per editor session,
  alongside the existing collapse chevrons.
* **More VS-parity property rows** — Padding, Min/Max Width/Height,
  Grid.RowSpan/ColumnSpan, Panel.ZIndex, BorderBrush, BorderThickness,
  Opacity, Cursor (dropdown), and Tag on every element.
* Window/app resource precedence follows WPF (the document's own resources
  override App.xaml), and new regression tests cover the resolution chain,
  gradients, template corners, and overrides.

## 0.15.0

**Smarter WPF property grid + real-world rendering fixes** (user request,
tested against a real production WPF app). The XAML side of the designer
catches up with the WinForms side:

* **Dropdowns for enums and booleans** — `Visibility`, alignments,
  `FontWeight`, `TextWrapping`, `ResizeMode`, `IsEnabled`, and every other
  enum-like property is now a real `<select>` with a `(default)` / `(reset)`
  entry, so nobody has to guess accepted values. Values that aren't in the
  list (bindings, resources) stay visible and selectable.
* **Color picker for brushes** — `Background`, `Foreground`, `BorderBrush`,
  `Fill`, and `Stroke` rows get a color swatch that opens the native picker
  (writes clean hex) next to a text box with autocomplete for all named
  colors; `{StaticResource}` brushes can still be typed, and the swatch
  previews the style-resolved color.
* **Image backgrounds** — the `Background` row's new 🖼 button imports a
  picture (copied to `Resources/`, registered as a `<Resource>` build item)
  and writes `<Element.Background><ImageBrush …/></Element.Background>`;
  `Image.Source` gets the same `…` picker. Both render as real images on
  the canvas now (correct `Stretch` mapping) instead of a placeholder glyph.
* **Font editing without guesswork** — new `FontFamily` and `FontStyle` rows
  plus curated suggestion lists for family and size on every element and the
  Window; the Window also gains `WindowStyle`, `WindowState`,
  `SizeToContent`, and `Topmost` rows.
* **Fixed: overlapping text in nested layouts** — `UniformGrid` (the usual
  card/stat-tile layout) now renders as a true equal-cell grid honoring
  `Rows`/`Columns`, `Viewbox` renders its child, `Menu`/`ToolBar`/`StatusBar`
  lay out horizontally, and *unknown* multi-child containers (ItemsControl,
  custom panels) approximate as a vertical stack instead of piling every
  child into the same cell — the cause of the garbled, overlapping text when
  opening real-world projects.
* The test harness gained a small XML DOM, so the XAML render pipeline now
  runs under Node tests; new regressions cover UniformGrid layouts, image
  resolution requests, pack URIs, and binding-valued sources.

## 0.14.0

**XAML IntelliSense in the text editor** (user request — "avoid Visual Studio
completely"). Hand-editing `.xaml` files now gets the full treatment without
any extra extensions:

* **Completions everywhere** — element names after `<` (containers insert an
  open/close pair, leaf controls self-close), `</` closes the innermost open
  tag, attribute names are scoped to what the element actually supports
  (own properties + common layout set + events, minus attributes already on
  the tag), and attribute values complete enum members, `True`/`False`, and
  all 141 named XAML colors with preview swatches. Picking an enum-typed
  attribute pops the value list automatically.
* **20 code snippets** — `window`, `grid2x2`, `gridrows`, `gridcols`,
  `stack`, `dock` (menu + status bar app shell), `button`, `labeltext`,
  `combo`, `listbox`, `datagrid`, `tabs`, `menu`, `groupbox`, `scroll`,
  `image`, `style`, `buttonrow` (OK/Cancel), `statusbar`, and `contextmenu`,
  each with tab stops on the names you'll want to change and a rendered
  preview in the completion docs.
* **Hover documentation** — plain-English docs for every cataloged element
  and attribute, including the property type and allowed values.
* **Surprise: inline color swatches + picker** — brush-typed attribute values
  (`Background`, `Foreground`, `BorderBrush`, `Fill`, `Stroke`, …) render a
  color chip in the editor and open VS Code's native color picker; picking a
  color writes clean hex (alpha only when translucent) or the exact named
  color when one matches. Bindings and `{StaticResource}` values are left
  alone.
* The whole feature is scoped to `.xaml` files and gated behind a new
  `uimaker.xamlIntelliSense` setting (default on) — flipping it off takes
  effect immediately, no reload needed.
* Under the hood the catalog (60+ elements, per-type properties/events, WPF
  enum tables, the full named-color table) and the cursor-context analyzer
  are a pure, dependency-free module with its own Node test suite (24 tests).

## 0.13.0

**Collapsible designer panels.** The Toolbox and Properties panels now have a
collapse chevron in their headers (user request): either panel folds into a
thin vertical strip so the design canvas gets the full editor width, and
clicking the strip (or pressing Enter/Space on it) restores the panel. The
collapsed/expanded choice is kept in the webview state, so it survives
switching editor tabs. In narrow editor groups the collapsed panel hands its
grid track back to the canvas, and the bottom-docked Properties strip renders
horizontally.

## 0.12.0

**Visual Basic WinForms designer.** `*.Designer.vb` files now open in the same
drag-and-drop designer as C#:

* **Full round-tripping** — VB `InitializeComponent` bodies parse (controls,
  hierarchy, `Me.` receivers, `New` instantiations, AddRange arrays, VB string
  and number literals like `15.75!`), and every edit is written back in VB
  syntax: no semicolons, `Me.`/implicit receivers matching the file's dialect,
  `True`/`False`, `CType` anchor casts, apostrophe comment trios, and
  `Friend WithEvents … As …` field declarations.
* **VB events, the VB way** — wiring an event creates a
  `Private Sub … Handles Button1.Click` stub in the code-behind (or moves the
  Handles target when rewiring); the events panel reads existing `Handles`
  clauses live, including `MyBase.Load`-style form events, and clearing an
  event removes only its Handles target — handler code is never deleted.
* **Rename** — case-insensitive VB identifier rename across the designer file
  and code-behind (Handles clauses included), preserving comments and string
  literals; the generated block-header comment trio now follows renames in
  both languages.
* **Scaffolding parity** — Add Form and New WPF Window generate VB file pairs
  in VB projects, Duplicate copies `.vb`/`.Designer.vb`/`.resx` sets, the
  sidebar lists VB forms (excluding `My Project` codegen), and the Code
  category's New Class button emits a `.vb` stub in VB projects.
* **Resources** — existing VB images (`My.Resources.*` and local form resx)
  render on the canvas. Cross-language clipboard pastes are blocked so C# code
  can never be injected into a VB designer file (and vice versa).
* Still C#-only for now: the App Settings editor, classic→SDK conversion, and
  importing new images as project resources into VB projects.

Also in this release: the designer's text-surgery core now has a Node test
harness exercising both languages end-to-end (parse → edit → re-parse), CRLF
line endings are preserved exactly on replaced/inserted lines, and the README
gained screenshots plus updated feature/command tables.

## 0.11.2

**Marketplace identity.** Added the final UI Maker app icon to the extension
manifest: a compact Visual Studio Code extension badge, `.NET` identity, and
visual form-designer mark optimized for Marketplace thumbnail sizes. The
packaged icon is a crisp 256×256 PNG without shipping the oversized source.

## 0.11.1

Reliability and VS-parity hardening after the 0.11 project-tools release.

**Designer transactions and XAML safety.**
* Designer edits now carry the exact source revision they were based on.
  Split-editor changes, Undo, read-only files, and fast consecutive drags can
  no longer be overwritten by a stale full-document replacement; rejected
  edits refresh the canvas from the authoritative document.
* XAML round-tripping now retains document-level comments/processing
  instructions/doctype nodes, mixed inline text, inherited
  `xml:space="preserve"`, CDATA, and namespace-aliased `x:Code`.
* WinForms insertions reset the primary/multi-selection consistently.
  Generated-name and handler inputs reject C# keywords; rename skips comments
  and every ordinary/verbatim/raw literal. When the C# language service is
  available, a control rename is a real solution-wide symbol rename.
* WinForms deletion is bounded to `InitializeComponent` plus the exact
  generated field, so helper-method references are never erased. Cut/copy and
  Duplicate now fail closed for structural controls they cannot deep-clone;
  SplitContainer/TableLayout placement and DataGridView-column cleanup are
  preserved, and incomplete insertions are cancelled before any edit applies.

**Project correctness and safety.**
* Project Properties and NuGet use project/view generations so late async
  results can never cross from project A into project B. Multi-target
  `TargetFrameworks` values are preserved, `$` is literal in MSBuild values,
  and NuGet prerelease comparison follows SemVer.
* Run, Debug, and Publish prompt for and remember an active TFM in
  multi-target projects. Target-path evaluation and output discovery use that
  same TFM. Task/debug/process lifecycle guards prevent stale completions from
  launching or stopping the wrong app.
* Classic-to-SDK conversion now preserves explicit items, metadata,
  conditions, project/assembly/COM references, and conditional property
  groups. It fails closed on constructs it cannot prove safe, validates
  package migrations, preflights backups, and commits through a verified
  atomic replacement.
* Generated file pairs and project/resource writes use staged or atomic
  replacement. Root namespaces and RESX file references decode XML entities,
  while generated C# identifiers are sanitized and keyword-safe.
* Restricted Mode is declared and blocks .NET/MSBuild/NuGet/conversion
  execution. Webviews use cryptographic CSP nonces, and the designer gains
  keyboard-accessible toolbox items, focus indicators, ARIA state, and a
  responsive narrow layout.

**Verification.** Added a dependency-free Node regression suite for C# lexical
rewrites, designer edit conflicts, atomic file sets, XML decoding, SemVer,
and multi-target project inspection. Use `npm test` or the full `npm run check`.

## 0.11.0

Project Properties, NuGet manager, classic-project conversion, and a
release-hardening pass over every path that writes source files.

**Project Properties page.** Visual Studio's *Application* tab inside VS
Code: output type, target framework (listing the SDKs actually installed),
assembly name, default namespace, startup object, icon and manifest with
Browse… pickers, and package/assembly info (version, authors, product,
description, copyright). Saving updates the `.csproj` in place; clearing a
field removes the property so the SDK default applies.

**NuGet package manager.** Browse (nuget.org search with prerelease toggle),
Installed (with uninstall), and Updates (latest-stable check per package).
Operations run `dotnet add|remove package` against the working project and
are serialized so parallel restores can't fight. Classic projects list
read-only with a pointer to the converter.

**Convert to SDK style.** One command (also a banner button on Project
Properties) rewrites a classic .NET Framework `.csproj` in the modern SDK
format — fixing C# Dev Kit's *“project file is in unsupported format”*
warning. Same TFM, names, icon, manifest, and build events; packages.config
→ `PackageReference`; framework references become implicit; settings and
resources keep their designers; the original file survives as
`.csproj.legacy.bak`.

**Data-loss fixes (designer).**
* XAML that fails to parse now locks the canvas **read-only** (dimmed, with a
  banner) instead of leaving the previous model live — a stale model can no
  longer overwrite newer text on the next designer action.
* The serializer preserves the XML declaration, CDATA sections, processing
  instructions, `x:Code`, and `xml:space="preserve"` subtrees.
* Selection state is rebuilt consistently after drops, duplicates, pastes,
  and re-parses, so group deletion can never target stale or wrong controls.
* WinForms **delete** prunes the doomed control out of shared
  `Controls.AddRange` lists instead of deleting the whole line, and matches
  identifiers only outside string literals (a ListBox item named like a
  control no longer vanishes).
* WinForms **rename** rewrites identifiers only outside strings/comments
  (plus the `Name = "…"` string, like VS) — user-visible text is untouched;
  the code-behind mirror does the same and no longer force-saves a file that
  already had unsaved edits.

**Correctness fixes (project system).**
* Run/Build/Debug/Release now treat the selected **working folder** as
  authoritative — switching projects in the sidebar takes effect immediately
  even while an editor from the previous project has focus.
* Add Class / Add Image / Add Resource target the working project instead of
  the first `.csproj` in the workspace.
* Reopening App Settings for another project rebinds the save handler — it
  can no longer write project B's settings into project A.
* Importing a resource preserves every existing RESX entry's declared type
  when regenerating `Resources.Designer.cs` (ints, colors, custom types no
  longer come back as Bitmap accessors).
* The build preflight identifies running app instances by **full executable
  path** inside the project folder — an unrelated app that shares the .exe
  name is never offered for kill.
* Debug/Run locate the output binary via MSBuild's evaluated `TargetPath`
  (honoring custom output paths and RIDs), falling back to the bin scan.
* Event-handler stubs: brace matching skips strings/comments (no more stubs
  inserted inside methods), and handler/args names from the webview are
  validated before they reach generated C#.
* WPF event stubs use fully-qualified args types, so they compile in
  code-behind files that import only `System.Windows`.
* Add Window/Form refuse Visual Basic projects with a clear message instead
  of dropping C# files into them.
* Classic-project XML edits escape paths (`R&D` no longer corrupts the
  project file).

**Hygiene.** Scaffolding offers the frameworks of the SDKs installed on the
machine (LTS-labeled) instead of a stale hardcoded list; `@types/vscode` is
pinned to the 1.85 engine minimum; the lockfile version matches the package
again.

## 0.10.0

Toolbox parity, right-click menus, and per-project scoping.

**The WinForms toolbox now mirrors Visual Studio.** New controls:
CheckedListBox, DomainUpDown, MonthCalendar, HScrollBar, VScrollBar,
WebBrowser, PropertyGrid, FlowLayoutPanel, TableLayoutPanel (cell grid
preview, `Controls.Add(child, col, row)` parsing), SplitContainer (Panel1/
Panel2 parsing, per-panel drops, live splitter preview), and Splitter. New
tray components: HelpProvider, BindingSource, FileSystemWatcher, Process,
PrintDialog, PrintDocument, PrintPreviewDialog, PageSetupDialog. Components
that need extra NuGet packages on modern .NET (SerialPort, EventLog,
PerformanceCounter, ServiceController, MessageQueue, DirectoryEntry) are
deliberately excluded so generated code always compiles. The toolbox is
grouped into VS-style sections (Common Controls, Containers, Menus &
Toolbars, Data, Components, Dialogs, Printing) with a **search box**, and
**double-clicking a tool adds it** without dragging. Event wiring knows the
new delegate types (ItemCheck, DateChanged, SplitterMoved, PrintPage,
FileSystemWatcher events, scrollbar Scroll, …).

**Right-click context menus, everywhere.** Controls, tab pages, the form,
and tray components all have VS-style menus: Cut / Copy / Paste / Duplicate /
Delete, **Bring to Front / Send to Back** (rewrites `Controls.Add` order),
Select Parent, wire-default-event, View Code, and Properties/Events shortcuts.
Per-type verbs: **Add Tab / Remove Tab** on TabControls and pages (both
WinForms and XAML), **Add Item / Edit Items…** on strips, **Edit Items…** on
ListBox / ComboBox / CheckedListBox / DomainUpDown — items are edited one per
line and written back as `Items.AddRange(new object[] { … })`, and the list
previews render them. `Ctrl+X` cut joins the keyboard shortcuts; `Esc` closes
the menu.

**Working folder — projects stay in their lane.** Opening a parent folder
that contains many projects no longer lists every project's files or lets a
build touch the wrong app. All file lists and actions (Run, Build, Debug,
Release, App Settings) target one **working project**, shown at the top of
the Actions panel; it follows the file you are editing, is remembered per
workspace, and can be switched with one click. Multi-project workspaces ask
you to pick before listing anything, `bin`/`obj`/`packages`/`.vs`/
`node_modules` are never scanned (no more NuGet `*.Designer.cs` in the forms
list), and a parent folder is no longer auto-added to Recent Projects.

**No dead designers.** Files with nothing to design — App.xaml, resource
dictionaries, `Designer.cs` files without `InitializeComponent` — close the
designer and open straight in the code editor.

**Hardening.** A global error trap keeps the canvas alive and reports issues
in the status bar instead of dying silently; designer→host messages and
render passes are guarded; failed workspace edits (read-only files) warn
instead of vanishing; tab-strip clicks keep the multi-selection consistent;
stale drag payloads and missing drop anchors are ignored safely.

## 0.9.0

The "full-fledged app builder" release — every item from the pre-release gap
list, plus project-file management from the side panel.

**Control rename that's actually safe.** `(Name)` in the property grid is now
editable: every reference in the Designer.cs (field, instantiation, property
block, comment banner, `Name = "..."` string, event wiring) is renamed, and
the code-behind `.cs` file is updated too. Event handler names are left
untouched, exactly like Visual Studio. Collisions and invalid identifiers are
rejected.

**Multi-select, alignment tools, and tab order.**
- Ctrl/Shift+click builds a multi-selection (dashed outlines); dragging any
  member moves the whole group; arrows nudge the group; Delete removes it.
- New alignment toolbar (appears with 2+ selected): align lefts/tops/rights/
  bottoms to the primary selection, same width/height/size, distribute
  horizontally/vertically.
- **⇥ Tab Order** button — VS's View → Tab Order: badges show each control's
  TabIndex; click controls in sequence to assign 0, 1, 2, …; Esc to finish.

**Copy & paste.** Ctrl+C / Ctrl+V for controls — including cross-form: the
designer clipboard lives in the extension host, so you can copy a button on
one form and paste it onto another. Works for XAML elements too.

**Component tray, like VS.** A new *Components* toolbox section: Timer,
ToolTip, ContextMenuStrip, NotifyIcon, BackgroundWorker, ImageList,
ErrorProvider, OpenFileDialog, SaveFileDialog, FolderBrowserDialog,
ColorDialog, FontDialog. Dropped components appear in a tray below the form
(chips: click to edit properties, double-click to wire the default event —
Timer.Tick, BackgroundWorker.DoWork, FileOk, …). The generated code uses the
`components` IContainer exactly like VS. Controls also gain a
`ContextMenuStrip` property listing the trays' menus.

**Menus, toolbars, status bars.** MenuStrip / ToolStrip / StatusStrip in the
toolbox (they dock themselves; MenuStrip also sets `MainMenuStrip`), plus an
**Items** editor in the property grid — one line per item; adding, renaming,
reordering, or deleting lines creates/updates/removes the ToolStripMenuItem /
ToolStripStatusLabel / ToolStripButton declarations in the Designer.cs.
Strips render on the canvas; deleting a strip cleans up its items too.

**Real container behavior.** TabControl is back in the WinForms toolbox
(inserted with two pages, VS-style) and controls can be dropped onto tab
pages. Docked siblings now **push each other** for space — the canvas runs
the same reverse-order dock layout as WinForms, so MenuStrip + ToolStrip +
StatusStrip + Fill panels lay out correctly. Deleting a container now removes
everything inside it from the code.

**Side panel: category actions.** The Project Files categories grew inline
buttons: **＋ New C# Class File** (stubbed class, registered in classic
csproj), **＋ Add Image**, and **＋ Add Resource** (any file type — images,
icons, text, or binary, each imported into `Resources/` + `Resources.resx`
with the right CLR type and a regenerated `Resources.Designer.cs`).

## 0.8.1

Documentation — README rewritten for the Visual Studio-style property grid,
image/icon importing, the resizable form, and the categorized Project Files
panel; roadmap refreshed.

## 0.8.0

**Images and icons, imported like Visual Studio.** `Image`, `BackgroundImage`,
and the form `Icon` are now editable in the property grid (all common formats:
.png, .jpg, .jpeg, .gif, .bmp, .ico):

- The **… button** opens a file picker; the chosen file is **copied into the
  project's `Resources/` folder**, registered in `Properties/Resources.resx`
  (as a ResXFileRef, exactly like VS), and `Properties/Resources.Designer.cs`
  is regenerated ResXFileCodeGenerator-style — so the project still round-trips
  with full Visual Studio. Classic (non-SDK) csproj files get the entries VS
  would add. The Designer.cs references the image as
  `global::YourApp.Properties.Resources.name`.
- **Sizing and placement options like VS**: `ImageAlign` (ContentAlignment),
  `TextImageRelation` (overlay / image above / below / before / after the
  text), `BackgroundImageLayout` (None, Tile, Center, Stretch, Zoom), and
  PictureBox `SizeMode` (Normal, StretchImage, AutoSize, CenterImage, Zoom).
- **The canvas draws the real images** — button glyphs, PictureBox content
  (with SizeMode), tiled/stretched background images, and the form icon in the
  mock title bar. Legacy images embedded base64 in the form's own `.resx`
  (`resources.GetObject(...)`) render too.
- **✕** on the row removes the image assignment from the Designer.cs.

**Project Files in the side panel.** The UI Maker sidebar now has a *Project
Files* group that sorts everything that is not a designable file into
categories, solution-explorer style: **Code**, **Images & Icons**,
**Resources**, **Data & Config**, **Project & Solution**, and **Other** — with
real file-theme icons and click-to-open.

## 0.7.0

**Visual Studio-style Properties window.** The properties panel is now a real
property grid, modeled on the VS Properties window:

- **Categories** — properties are grouped under collapsible headers
  (Accessibility, Appearance, Behavior, Data, Design, Focus, Layout,
  Window Style), with a **Categorized / A–Z** toggle like the VS toolbar.
- **Full WinForms property catalog** — every control now exposes the VS set:
  `Anchor` (Top/Bottom/Left/Right toggle buttons), `Dock`, `AutoSize`,
  `Margin`, `Padding`, `MinimumSize`/`MaximumSize`, `BackColor`/`ForeColor`
  (color picker + named/system colors), `Font`, `Cursor`, `TextAlign`,
  `FlatStyle`, `BorderStyle`, `TabIndex`/`TabStop`, `Tag`, accessibility
  properties, and per-type extras (`Multiline`, `PasswordChar`, `SizeMode`,
  `DropDownStyle`, `View`, numeric ranges, …).
- **Form properties** — `StartPosition`, `FormBorderStyle`, `WindowState`,
  `ControlBox`/`MaximizeBox`/`MinimizeBox`, `ShowIcon`, `ShowInTaskbar`,
  `TopMost`, `Opacity`, `KeyPreview`, `AcceptButton`/`CancelButton`, and more.
- **Proper editors** — enums and booleans use dropdowns (with a
  *(default: …)* reset entry), colors get a swatch picker, Anchor gets edge
  toggles. Explicitly-set values render **bold**, exactly like VS, and
  clearing a value removes the line from the Designer.cs.
- **Description pane** — the bar at the bottom of the panel explains the
  focused property, like the VS help area.
- Everything is written back as compilable C# in the file's own dialect
  (classic `this.` + qualified names, or modern .NET style), including
  `AnchorStyles` cast expressions, `Color.FromArgb`, `new Font(...)`,
  `Padding(...)`, and `decimal` values for NumericUpDown.

**Resizable form.** Drag the grips on the mock window's right/bottom edges to
resize the form on the canvas — writes `ClientSize` for WinForms and
`Width`/`Height` for XAML windows, with grid snapping.

**Designer previews for the new properties** — `TextAlign`, `BorderStyle`,
and flat buttons now render on the canvas.

The XAML properties panel uses the same categorized grid.

## 0.6.0

**App Settings editor** — the Visual Studio *Project Properties → Settings*
page, inside VS Code. Define the settings your built app remembers — name,
type (string/int/bool/double/long/DateTime), **User** or **Application**
scope, and a default value — in a grid. Saving writes the same
`Properties/Settings.settings` + `Settings.Designer.cs` pair Visual Studio
generates, so the project stays fully VS-compatible; the app reads them via
`Properties.Settings.Default.Name` and persists User-scoped values with
`.Save()`.

**Built-in guide** — *Guide: How to Build an App* (the book icon in the side
panel, the Actions list, or the Command Palette) opens a walkthrough of the
whole journey: the workflow from empty folder to shipped `.exe`, the full
file tree of a WPF and a WinForms project, which files are required /
optional / generated, and what every single file is for.

**Quicker folder access** — recent projects now have an **Open Folder in
File Explorer** hover button next to *Open in New Window*, and the Actions
list gains **Open Working Folder** for the current project.

**Apps that need administrator rights now Run** — when the app's manifest
requests elevation (`requireAdministrator`/`highestAvailable`),
`dotnet run` and plain launches fail with "The requested operation requires
elevation". UI Maker now detects the manifest, builds, and launches the
built `.exe` through a UAC prompt instead; the play/stop toggle still
follows the app. Debugging such apps requires an elevated VS Code, and a
warning now says so.

**WinForms designer parity fixes** — found by rendering the same
Designer.cs in UI Maker and Visual Studio side by side:

- Modern-dialect form properties (`ClientSize = new Size(954, 1028);`,
  `MinimumSize`, `AutoScaleDimensions`) were mistaken for control
  declarations, so the form fell back to 600×400 and clipped every control
  beyond that. Forms now render at their real size.
- Controls with `Visible = false` are now drawn normally, exactly like the
  Visual Studio designer, so hidden panels stay fully designable
  (previously they were faded and easy to mistake for missing).
- **LinkLabel** is now a real control: toolbox entry, blue underlined
  rendering, and `LinkClicked` event wiring.
- Image-only buttons show a placeholder glyph instead of their clipped
  variable name.

**Internal identifiers renamed** — commands, settings keys, and the
extension ID now use `uimaker.*` throughout. Because this changes the
extension ID: uninstall the previously installed version once, re-apply any
customized UI Maker settings (`uimaker.gridSize`, `uimaker.publish.*`, …),
and expect the Recent Projects list to start fresh.

## 0.5.1

**Locked-output protection (MSB3026).** Building while a previous instance
of the app is still running used to spin through long "file is locked by
csAutoTyper (PID)" retries and fail. Build/Run/Debug/Release now check for
a running instance of the project's .exe first: an instance UI Maker
launched is stopped automatically; anything else prompts
**Stop It and Continue** / **Build Anyway**.

## 0.5.0

**Modern Designer.cs support** — WinForms designer files generated by
VS 2022 / .NET 6+ (no `this.` prefix, unqualified type names) now parse and
render; previously those forms previewed empty. Edits are written back in
whichever code dialect the file already uses, so classic .NET Framework
projects keep their `this.`-style code and modern projects stay modern.

- `Controls.AddRange(...)` hierarchies, `Dock` preview (Fill/Top/Bottom/
  Left/Right; docked controls are select-only), unqualified `Font`/`Size`/
  `Point`/`Color` values, and `x.Click += handler;` event wiring all parse.
- **Ctrl+D duplicates the selected control** in WinForms mode too — copies
  every property, drops the copy one grid step away in the same container.

**Run and Debug are now play/stop toggles.** One button: green play when
idle, red stop while the app is running (sidebar + status bar). The state
follows the app — when it exits on its own, the button flips back. The
separate Stop entries are gone.

**Windows/forms management in the side panel** — the XAML Windows and
WinForms Forms groups have a **+** button (New WPF Window / New WinForms
Form), and every file row has **Duplicate** (icon + right-click menu).
New/duplicated files land next to the project, get the right namespace and
class names, open in the designer immediately, and are registered in the
`.csproj` for classic non-SDK projects.

**Recent Projects show the project type** — each entry is tagged like
`WinForms · .NET 8` or `WPF · .NET Framework 4.7.2`.

**App-creator options:**

- New Project wizard: choose the **language (C# or Visual Basic)** and the
  **target framework** (SDK default / .NET 9 / 8 / 6), plus a Console
  template. (C++ desktop apps are not supported by the dotnet CLI.)
- New settings under **UI Maker › Publish**: *Single File* (one .exe),
  *Self Contained* (bundle the .NET runtime), and *Runtime*
  (win-x64/x86/arm64). Build Release (Publish) honors them.

**Builds work on any dev machine:**

- Projects targeting .NET Framework without the reference assemblies
  installed (error **MSB3644**) are detected before building, and UI Maker
  offers to add the `Microsoft.NETFramework.ReferenceAssemblies` package —
  a build-only helper that makes such projects compile anywhere.
- Classic non-SDK projects (which `dotnet` can't build at all) are routed
  to Visual Studio's MSBuild automatically (located via vswhere), and Run
  launches the built .exe directly.
- Debugging picks the right engine: `clr` for .NET Framework, `coreclr`
  for modern .NET. VB projects (`.vbproj`) are picked up by Build/Run too.

## 0.4.0

**Windows Forms designer** — `*.Designer.cs` files now open in the visual
designer, closing the biggest gap with the Visual Studio workflow.

- Parses `InitializeComponent` (the standard VS-generated format) and renders
  the form: Button, Label, TextBox, CheckBox, RadioButton, ComboBox, ListBox,
  ListView, TreeView, DataGridView (with real column headers), PictureBox,
  ProgressBar, TrackBar, NumericUpDown, DateTimePicker, MaskedTextBox,
  RichTextBox, GroupBox, Panel, TabControl/TabPage (clickable tabs), MenuStrip.
- Colors (`SystemColors`, `Color.*`, `FromArgb`), fonts, Enabled/Visible states.
- Full editing: drag to move, resize handles, keyboard nudge, property panel
  (Text, Location, Size, Enabled, …), toolbox drag-and-drop (into the form,
  GroupBoxes, Panels, and TabPages), delete.
- Every change is a surgical statement edit — only the affected
  `this.control.Prop = …;` lines change, the rest of the file stays untouched.
- Events panel + double-click wiring writes the `+=` line and generates the
  handler stub in the matching `Form.cs` with the correct `EventArgs` type.
- WinForms designer files get their own **WinForms Forms** list in the side
  panel (Settings/Resources codegen files are filtered out).

Side panel: **Recent Projects** — .NET projects you open or scaffold are
remembered; click to switch the window to that project, with hover actions to
open in a new window or remove from the list.

WPF toolbox: added Calendar, ListView, TreeView, RichTextBox, Expander,
Separator, TabControl, and the layout panels (Grid, StackPanel, WrapPanel,
DockPanel, Canvas, ScrollViewer).

## 0.3.0

- Renamed the extension to **UI Maker**.
- New **activity-bar side panel** with its own icon:
  - **Actions** — New Project / Build / Run / Debug / Release / Stop
  - **XAML Windows** — all `.xaml` files in the workspace; click to open in
    the designer. Auto-refreshes as files come and go, with a manual refresh
    button in the panel title.

## 0.2.0

Nested layout rendering — the designer now previews real-world XAML the way
Visual Studio does, instead of only absolutely-positioned root-Grid children.

- Full recursive layout engine:
  - `Grid` rows/columns (`Auto`, `*`, `2*`, pixel) with `Grid.Row/Column/RowSpan/ColumnSpan`
  - `StackPanel` (both orientations), `WrapPanel`, `DockPanel` (incl. `LastChildFill`)
  - `ScrollViewer` (scrollable in the preview), `Border`, `GroupBox`, `Canvas`
  - `TabControl` / `TabItem` — click tab headers in the designer to switch tabs
  - `GridSplitter` and `Separator` placeholders
  - `HorizontalAlignment` / `VerticalAlignment`, `Margin`, `Padding`,
    `Min/MaxWidth/Height` honored everywhere
- `{StaticResource}` style resolution: `<Style>` setters from `Window.Resources`
  (including `BasedOn` chains and implicit styles) now affect the preview
- TextBlocks render inline element text, wrapping, alignment, and font styles
- Selection works on any nested element; the properties panel gains
  alignment, `Grid.Row`/`Grid.Column`, and panel-specific properties
- Drag-to-move is offered where it is safe: Canvas children and Grid children
  placed VS-style (`Left`/`Top` alignment). Everything else shows
  "layout managed by <parent>" in the status bar instead of breaking layout
- Toolbox drops now land in the panel under the cursor (Grid, Canvas,
  StackPanel, WrapPanel, DockPanel), not just the root

## 0.1.0

Initial release.

- Visual XAML designer as a VS Code custom editor (`*.xaml`)
  - Drag-and-drop toolbox with 15 common WPF controls
  - Snap-to-grid canvas with move/resize handles and keyboard nudging
  - Properties panel and Events panel with code-behind stub generation
  - Split Design / Code view with two-way sync
- Build / Run / Debug / Release / Stop commands with status-bar buttons
- New Project scaffolding for WPF and Windows Forms via `dotnet new`
