# Changelog

## 0.28.4

Connect the WPF collection editor to dropdown choices, tab items, list and tree items, toolbars, status bars, inline context menus, DataGrid and ListView columns, and Grid row/column definitions. Use the appropriate item types and properties for each collection, including nested tree branches and plain string choices. Preserve bindings, templates, expanded property syntax, and custom-control namespaces; keep binding-supplied collections protected from manual insertion. Preview saved choices, selected tabs and their content, tree branches, and column headers. Keep numeric properties such as UniformGrid.Columns separate from collection editors.

## 0.28.3

Add the WPF menu `Items` property and a collection editor with a hierarchy, item properties, add/remove/reorder controls, and submenu editing. Configure headers, shortcut hints, icons, checkmarks, commands, styling, and events. OK applies the draft as one document edit; Cancel leaves the XAML unchanged. Preserve existing bindings and expanded property content, and reject saving over source changes made while the editor was open. Add menu context actions for Edit Items, Add MenuItem, Add Separator, Edit Text, Move Up/Down, and Handle Click.

## 0.28.2

Render WPF menu bars with their actual headers and compact spacing instead of stacked placeholder boxes. Click menu items to preview floating dropdowns and nested submenus, including shortcut hints, separators, icons, and checkmarks. Menu previews keep the app layout in place and never change the XAML; select a menu item to edit its header and command properties.

## 0.28.1

Fix WPF preview text inheritance so window and parent font settings and foreground colors reach child controls. Load window-linked resource dictionaries (including nested dictionaries) so theme caption sizes, brushes, and styles appear in the designer.

## 0.28.0

**Multi-select property editing** (user request: "select 3 Labels and set
color, or font, etc."). Ctrl/Shift-click a group of controls and the
Properties panel switches to "N controls selected", showing only the
properties **every** selected control supports (the Visual Studio
intersection rule). Any edit — color pickers, fonts, enums, alignment
buttons, sizes, free text — applies to **all** selected controls in one
batched change, so a single Undo reverts the whole group. Works in both
designers: XAML (mixed types included — 2 Labels + a TextBlock edit their
shared properties) and WinForms (batched into one Designer.cs rewrite; tray
components are excluded). Name stays per-control and is hidden in
multi-mode, and the Events tab shows a hint since events wire to one control
at a time.

## 0.27.2

Two fixes found while designing a real app (HashcatGUI):

**Theme colors defined as brush→color chains now load.** App.xaml resources
written as `<Color x:Key="BgColor">…</Color>` +
`<SolidColorBrush x:Key="BgBrush" Color="{StaticResource BgColor}"/>` — the
common palette pattern — used to fall back to white on the canvas because
only literal brush colors were resolved. Resource collection now runs a
second pass that resolves brush→color references (chains included), and
gradient stops may reference Color resources too. Dark-themed apps preview
dark again.

**The Window is clickable again.** When the layout fills the whole window
there was no blank surface left to click, so selecting the Window meant
right-click → Properties. Clicking the mock window's **title bar** — or the
empty canvas area around the window — now selects the Window/Form directly,
like clicking the root in Visual Studio.

## 0.27.1

**The "anchor" rows, VS-style** (user follow-up: "no anchor options for tabs,
buttons etc"). WPF has no Anchor property — its equivalent is the alignment
pair, which Visual Studio shows as segmented icon buttons. UI Maker now
renders **HorizontalAlignment / VerticalAlignment (and the content
alignments) as the same segmented icon buttons** (← ↔ → ⇿ / ↑ ↕ ↓ ⇳): the
active value highlights, clicking it again resets to default. WinForms
already had real Anchor toggles on every control, tabs and buttons included.

**Property parity, round 2:**

- *Every element:* Style, DataContext, OpacityMask (with the color/brush
  picker), Clip, Language, OverridesDefaultStyle, ForceCursor,
  IsManipulationEnabled, and the **Automation** category
  (AutomationProperties.Name / AutomationId / HelpText / AcceleratorKey /
  AccessKey)
- *Buttons:* CommandTarget, ContentStringFormat
- *ItemsControls (ComboBox, ListBox, ListView, TreeView, TabControl):*
  AlternationCount, IsTextSearchEnabled, IsSynchronizedWithCurrentItem,
  ItemStringFormat; TabControl also gets ItemsSource

All with category placement, dropdown/boolean validation, and description
pane entries stating the WPF defaults.

## 0.27.0

**Visual Studio property parity for the WPF Properties panel** (user request
after comparing side-by-side with VS):

- **~60 new properties**, validated the way VS validates them (enum
  dropdowns, True/False dropdowns with a "(default)" entry, color pickers),
  each with a description-pane entry that states the WPF default:
  - *Every control:* DockPanel.Dock, FlowDirection, AllowDrop, ClipToBounds,
    Focusable, IsHitTestVisible, IsTabStop, TabIndex, SnapsToDevicePixels,
    UseLayoutRounding, RenderTransformOrigin, Uid
  - *Buttons/toggles:* Command, CommandParameter, IsDefault, IsCancel,
    ClickMode, IsThreeState, Horizontal/VerticalContentAlignment
  - *Text:* TextAlignment, TextTrimming, TextDecorations, LineHeight,
    CharacterCasing, Min/MaxLines, IsReadOnly, scrollbar visibilities,
    PasswordChar, AcceptsTab
  - *Lists & data:* ItemsSource, DisplayMemberPath, SelectionMode,
    SelectedIndex, ComboBox dropdown properties, the full DataGrid CanUser*
    family, GridLinesVisibility, HeadersVisibility
  - *TabControl:* **TabStripPlacement** (the "missing anchor for tabs") and
    SelectedIndex
  - *Sliders/progress:* Orientation, TickPlacement, IsSnapToTickEnabled,
    IsDirectionReversed, Small/LargeChange
  - *Misc:* Expander.ExpandDirection, Grid.ShowGridLines, WrapPanel
    Item sizes, Image/Viewbox StretchDirection, Frame.NavigationUIVisibility,
    DatePicker/Calendar date properties
  - *Window:* Min/Max sizes, ShowInTaskbar, Opacity, Icon, FlowDirection
  (WinForms already had VS parity — Anchor/Dock and friends apply to every
  control there, TabControl included.)
- **Wheel gestures now match Visual Studio**: plain scroll pans vertically,
  **Shift+scroll pans horizontally**, and **Ctrl+scroll zooms** the canvas
  (or resizes the Toolbox/Properties panel when over one). Shift+scroll no
  longer zooms.

## 0.26.0

**Projects stay Visual Studio-compatible** (user request: opening a UI Maker
project in VS to compare designers failed). VS's WPF/WinForms designers need
a loaded solution for project context — a `.xaml` opened as a loose file
can't resolve StaticResources or custom-control namespaces, so the VS
designer refuses to load. UI Maker projects built fine but had no `.sln`.
Now:

- **New projects** (New .NET Desktop Project, and the generate-a-project
  flow for orphan source folders) get a minimal single-project `.sln`
  automatically.
- **Existing projects are fixed on contact**: whenever a project becomes the
  working folder (open, switch, activate), UI Maker quietly adds the missing
  `.sln` — projects that already have a `.sln`/`.slnx` in their folder or one
  level up are left untouched.
- **`UI Maker: Create Visual Studio Solution (.sln)`** command for doing it
  on demand.

The generated solution matches what `dotnet new sln` + `dotnet sln add`
produce (Format 12.00, VS 17, Debug/Release Any CPU, correct C#/VB
project-type GUIDs), with a deterministic project GUID so regenerating never
churns diffs. Open the `.sln` in Visual Studio and its designer gets full
context.

## 0.25.3

**Flat toolbox icons** (user report: mixed colored emoji among flat glyphs).
Every toolbox icon that Windows rendered as a colored emoji (🔑 🖼 📅 🌲 🍏
🔗 ⌨ and ~25 more across the WPF, Modern, WinForms, and custom-control
catalogs) was replaced with a flat monochrome symbol that follows the editor
theme, and the icon column now requests text presentation
(`font-variant-emoji: text` + Segoe UI Symbol) so dual-presentation
characters can never flip to emoji either. The properties panel's image
button and the canvas DatePicker glyph were de-emojied to match.

## 0.25.2

**Toggle labels no longer get a colored highlight box on the canvas** (user
report). The generic "style-aware chrome" pass painted every styled
control's `Background`/`BorderBrush`/`CornerRadius` onto its rendered
surface — correct for buttons and text boxes, wrong for toggle-templated
CheckBoxes, where those properties are the TRACK colors. Once a toggle style
declared `Background` (the new per-instance color plumbing), the whole
control — including the label text — got painted with a rounded accent
highlight. Toggle-rendered controls are now exempt from surface chrome:
only the switch track uses those brushes, the label stays plain (Foreground
still applies). Also removed a duplicated corner-radius application.

## 0.25.1

Property-panel fixes from live use:

**Color "show choices" popups fixed.** The named-color/resource dropdown on
every color row now opens reliably, clamps itself inside the viewport (it
could open half off-screen next to the right-hand panel), and **follows its
row when the Properties panel scrolls or the window resizes** — before, the
popup stayed at stale coordinates and drifted away or got hidden. It closes
itself when its row scrolls out of view, repositions as the filtered list
changes height, and the ▾ button now sits next to the text field on color
rows just like the font rows.

**OnColor / OffColor now show the toggle's real colors.** For toggles whose
template bakes the colors in (like a `{StaticResource Accent}` purple), the
swatches used to show black because the instance had no Background set. The
swatch fallback now resolves the color the template actually paints —
through StaticResources, App.xaml, and TemplatedParent bindings — so a
purple app toggle shows purple in both rows.

**Hover = a lighter shade of the active color.** The injected ToggleSwitch
template gained the same `IsMouseOver → track Opacity 0.85` trigger the
Context Menu Editor app uses, so hovering lightens whatever OnColor/OffColor
is showing — automatically matching, no extra property.

## 0.25.0

Three user requests in one release:

**Friendly toggle color properties.** Toggle-styled controls now show
**OnColor** and **OffColor** rows at the top of the Properties panel
(Appearance) with color-picker swatches — no need to know that they map to
`Background`/`BorderBrush` under the hood (the raw rows are hidden to avoid
duplicates, and the description pane explains the mapping).

**The Modern (Styled) toolbox grew from 4 to 24 entries** — Apple-ish,
dependency-free, all injected as plain Styles/ControlTemplates you can edit,
most recoloring per instance via TemplateBinding:

- *Toggles:* ToggleSwitch, **iOSToggle** (green iOS look)
- *Buttons:* ModernButton, **SuccessButton**, **DangerButton**,
  **OutlineButton** (ghost), **LinkButton** (underlined accent),
  **RoundIconButton** (FAB with shadow)
- *Inputs:* **ModernTextBox** (rounded, accent focus ring), **SearchBox**
  (pill with 🔍), **ModernSlider** (round thumb, accent track)
- *Progress & status:* **ModernProgressBar** (pill), **iOSProgressBar**
  (thin blue), **Spinner** (ring that actually rotates at runtime via a
  storyboard — and spins on the canvas too), **StatusDot**, **Badge**
  (red counter), PillBadge, **Chip**
- *Text:* **TitleText**, **SubtitleText**
- *Cards & decor:* Card, **GlassCard** (translucent), **GradientPanel**
  (purple→blue LinearGradientBrush), **SectionDivider**

Shared templates are injected once no matter how many variants you drop
(SuccessButton/DangerButton reuse ModernButton's template and differ only by
attributes). The canvas previews all of them: outline/link/round chrome,
pill progress with per-instance track/fill colors, spinning ring, shapes,
inline gradient backgrounds (`<Border.Background><LinearGradientBrush>`),
and style-lifted corner rounding on text boxes.

**More designer elements + toolbox sorting.** `Ellipse` and `Rectangle`
shapes joined the WPF toolbox (with Fill/Stroke color pickers and proper
canvas rendering), and the toolbox now has **▤ Categorized / A–Z** sort
buttons like the Properties panel — A–Z flattens every tool (built-ins,
Modern, custom controls) into one alphabetical list; the search box works in
both modes.

## 0.24.0

**Per-toggle colors** (user request: "do the toggles have a color property so
each could be set and render unique colors"): the injected **ToggleSwitch**
style now takes its colors from each CheckBox instance —

- **Background** = the CHECKED track color (style default `#FF7C4DFF`)
- **BorderBrush** = the unchecked track color (style default `#FFB9B9C3`)

Set them per toggle in the Properties panel (both have color-picker swatches)
and every switch can look different; leave them unset to inherit the style's
defaults. The template routes them with `TemplateBinding`, so the same works
at runtime, and the canvas preview resolves the instance colors too —
including for your own toggle templates that use `TemplateBinding` /
`TemplatedParent` bindings. The canvas also stops painting a toggle's
surface with its Background (that property is the track color, and the real
control surface is transparent).

Note for projects that already dropped a ToggleSwitch with 0.23.x: the old
hard-coded style stays untouched in your `Window.Resources` — delete the
`UimToggleSwitch` style there and drop a new ToggleSwitch to get the
color-aware version.

## 0.23.1

**Your own toggle switches now look like toggles on the canvas** (user
report: "my project has a toggle check box but it's not showing in Designer
as a toggle"). The designer previously only knew how to draw its own
injected UimToggleSwitch style; a CheckBox restyled by the app's own
Style/ControlTemplate fell back to a plain checkbox glyph. The style
collector now recognizes toggle-switch templates generically — a rounded
track Border holding an Ellipse thumb, and/or an IsChecked trigger that
slides a named part (HorizontalAlignment / Margin / RenderTransform) — from
the document's resources, App.xaml, and merged dictionaries, through keyed,
implicit (TargetType), and BasedOn-chained styles. Detected toggles render
as a real switch using the template's own brushes: track color, checked
color from the IsChecked trigger, thumb fill. Plain restyled checkboxes
(colors/fonts only) stay checkboxes. `ToggleButton` elements get the same
treatment (switch when toggle-templated, button chrome otherwise).

## 0.23.0

Design-surface overhaul for XAML (user request: "I'm not able to drag items
in the grid… multi select and move together… add all the UI design features
we can"):

**Drag anything, anywhere.**

- **Grid children all drag now.** Left/Top-aligned children keep their exact
  margin math; centered/stretched children are *promoted* on the first drag —
  pinned to `Left`/`Top` + `Margin` where you dropped them, keeping their
  `Grid.Row`/`Grid.Column` (cell origins are computed from the rendered
  grid tracks), exactly like Blend.
- **Flow panels reorder by drag.** StackPanel / WrapPanel / DockPanel
  children show a live insertion marker while dragging and reorder on drop;
  arrow keys also move them earlier/later in the flow.
- **Drag between panels.** A drag can carry a control into a *different*
  panel — out of a WrapPanel into the Grid, into a Canvas, into another
  StackPanel. The drop target highlights while you hover, and the layout
  attributes are rewritten for the new parent (Canvas coords ↔ Grid
  margin+cell ↔ flow order); releases outside the surface never re-parent.
- **Group move.** Ctrl/Shift-click a multi-selection, drag any member, and
  every movable member follows — in XAML as well as WinForms. Arrow-key
  nudging moves the whole selection too (Shift = one grid step).
- **Alignment tools for XAML.** The align/size/distribute toolbar (align
  lefts/tops, same width/height/size, distribute) now works on XAML sibling
  multi-selections positioned by Canvas coords or Left/Top margins.

**Modern (Styled) toolbox section — the fancy controls.** ToggleSwitch,
Modern Button (rounded accent), Card (rounded corners + drop shadow), and
Pill Badge. These are plain WPF elements (CheckBox, Button, Border, Label)
dressed by a Style/ControlTemplate that UI Maker injects into
`Window.Resources` the first time one is dropped — zero dependencies, fully
restylable, and previewed on the canvas (real switch track/thumb, rounded
chrome, shadows). Existing `Border.Effect` → `DropShadowEffect` markup now
previews as a shadow as well.

**More host controls in the WPF toolbox.** ContentControl, Frame, Viewbox,
and UniformGrid — the shapes apps use as placeholders/hosts that get filled
from code-behind at runtime (e.g. an Explorer-preview host panel).

Also: the toolbox tweaks in tests run against a harness that can now
serialize XAML edits end-to-end, adding regression coverage for movability,
reordering, style injection, and custom-control xmlns insertion.

## 0.22.0

Two user requests:

**Custom C# controls in the designer + a Control Library.** UI Maker builds
C# apps, so your own controls now work like the built-in ones:

- **Project Controls (automatic)** — the project source is scanned for
  classes deriving from a control base (`UserControl`, `Button`, `Panel`,
  any WinForms control — inheritance chains like
  `FancyButton : RJButton : Button` resolve too, in C# *and* VB) and for WPF
  `UserControl` XAML files. They appear in a new **Project Controls**
  toolbox section with a **↻ rescan** button; the list also refreshes when a
  designer tab regains focus. Dropping one generates correct code — a
  fully-qualified instantiation (`this.rjButton1 = new
  CustomControls.RJControls.RJButton();`), the typed field declaration, and
  `Controls.Add` — in the file's own dialect (classic/modern, C#/VB).
- **Custom Library (registered)** — controls living in NuGet packages or
  referenced DLLs (Guna.UI2, ReaLTaiizor, Krypton, …) are invisible to a
  source scan, so the new **Control Library** panel (side panel → Actions)
  registers them by hand: full type name, the base they look like, default
  size, WinForms or WPF. Saved to the `uimaker.customControls` workspace
  setting (shareable via `.vscode/settings.json`), and shown in a **Custom
  Library** toolbox section for every form.
- On the canvas, a custom control renders with the **look of its designer
  base** (an `RJButton : Button` draws as a Button; its true owner-drawn
  chrome shows at Run) and falls back to a neutral labelled box when the
  base is unknown. Properties, events (inherited from the base's catalog),
  move/resize, rename, duplicate, copy/paste, and delete all work; custom
  Panel-likes accept dropped children. WPF customs insert with the right
  `xmlns:` declaration (`clr-namespace:…;assembly=…`) added automatically.
- Forms that already used custom controls keep opening exactly as before —
  parsing was always tolerant; now the toolbox can create them too.

**NuGet Packages panel opens useful instead of empty.** The panel now opens
on the **Browse** tab pre-filled with nuget.org's most popular packages
(instead of a bare Installed list until a search was typed), searches as you
type (350 ms debounce, stale responses dropped), and re-searches when the
prerelease toggle changes. Installed badges still load alongside.

## 0.21.1

The Toolbox and Properties panel sizes are now independent (user request):
`uimaker.panelScale` is replaced by **`uimaker.toolboxScale`** and
**`uimaker.propertiesScale`** (each 60–200 %, default 100). Shift/Ctrl +
scroll over a panel resizes only that panel, and double-clicking a panel's
title resets only it.

## 0.21.0

Three user requests:

**Stop App now actually stops the app.** Stop used to report success while
the process kept running in two cases: `dotnet run` launches, where killing
the console host can leave a detached WinForms/WPF window alive, and apps
whose manifest demands administrator rights, which a normal taskkill cannot
touch (Access Denied). Stop now runs a verification pass behind the scenes:
it re-checks whether the app's .exe (matched by full path under the project
— never an unrelated same-name app) is still alive, force-kills the process
tree if so, and when the survivor is elevated it offers **Close It (Admin)**
— one UAC confirmation and the app is gone. A restart (Run right after
Stop) can never have its fresh instance shot down: every step re-checks the
lifecycle generation first.

**Copy controls between VS Code windows.** Ctrl+C in a designer now mirrors
the copied controls to the Windows clipboard (with a marker — normal text
copy/paste is untouched), and Ctrl+V asks for the freshest clipboard before
pasting. Copy a footer Label, a TextBox, a whole multi-selection in one
project's designer and paste it into a designer in a completely separate
VS Code window/project. Same rules as before apply across windows: WinForms
controls paste into forms of the same language (C#↔C#, VB↔VB), XAML
elements into XAML windows.

**Toolbox & Properties panel sizing (accessibility).** New setting
`uimaker.panelScale` (60–200 %, default 100) scales the fonts *and* icons of
the designer's two side panels — roughly 80 = Small, 100 = Medium,
125 = Large. Or just hold Shift (or Ctrl) and scroll over either panel, the
same gesture the canvas uses for zoom; the value is saved globally so every
window keeps it. Reset by double-clicking a panel title or setting it back
to 100. The canvas itself is not affected.

## 0.20.5

The sidebar row from 0.20.4 is replaced per feedback: instead of the
scope quick-pick, an **Extension Settings** row (under Create Installer)
opens the full UI Maker settings page — the same `@ext:coolshrimp.uimaker`
view previously reachable only through Extensions → UI Maker → gear →
Settings. All uimaker.* settings live there: installer scope, single-exe
publish options, XAML IntelliSense, and the rest. Also added as a palette
command: **UI Maker: Open Settings (UI Maker)**. The scope quick-pick
still exists via the Create Installer page's Change… button and its own
palette command.

## 0.20.4

The installer settings scope now has a visible home in the sidebar (user
request — the palette command and webview button weren't discoverable):
a new **Installer Settings Scope** row in Actions, right under Create
Installer, showing the current mode (`uniform template` / `per-project`)
as its description. Clicking it opens the same switcher quick-pick, and
the row's label updates live whenever the setting changes from anywhere
(the row, the Create Installer page's Change… button, the Command
Palette, or the Settings UI).

## 0.20.3

Safety hardening for multi-project parent folders: every file-creating
action already resolves its target by locating a real `.csproj`/`.vbproj`
and writing next to it (New Window/Form, New Class, Add Image/Resource,
imports, App Settings, installer output) — and now the one silent fallback
is closed too: when the selected **working folder no longer contains a
project file** (renamed/deleted since it was chosen), Run/Build/creation
actions stop with a clear warning offering Open Project… / Select Working
Folder… instead of quietly retargeting some other project in the workspace.

## 0.20.2

The installer settings scope is now one click away (user request): a
**Change…** button on the Create Installer page's scope banner, plus a new
palette command **UI Maker: Installer Settings — Uniform Template or
Per-Project…**. Both open a quick-pick explaining the two modes, mark the
current one, and an open installer page refreshes immediately with the
newly-scoped settings.

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
