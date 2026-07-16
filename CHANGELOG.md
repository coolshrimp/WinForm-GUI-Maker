# Changelog

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

- Renamed the extension to **UI Maker** (formerly FormForge). Internal IDs
  (`formforge.*` commands and settings, the extension ID) are unchanged, so
  existing installs and settings carry over.
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
