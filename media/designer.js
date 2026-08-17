// UI Maker designer webview.
//
// Renders a XAML Window as an interactive canvas. The XAML text document is
// the single source of truth: this script parses it into an XML DOM, renders
// HTML approximations of each control, and serializes the DOM back to text
// whenever the user changes something on the canvas.
//
// Layout: WPF panels are approximated with CSS — Grid rows/columns become a
// CSS grid, StackPanel/WrapPanel/DockPanel become flexbox, ScrollViewer
// scrolls, TabControl shows one clickable tab at a time. Styles referenced
// with {StaticResource} from <Window.Resources> are resolved for the visual
// properties the preview understands.
//
// Messages to the extension host:
//   { type: 'ready' }                            webview loaded, send content
//   { type: 'edit', text, baseText }             replace text iff base matches
//   { type: 'openCode' }                         open XAML source split view
//   { type: 'addHandler', handler, event }       create/reveal C# handler stub
//
// Messages from the extension host:
//   { type: 'update', text }                     document text changed
//   { type: 'config', gridSize, snap, docName }  settings
//   { type: 'editResult', ok, text?, reason? }   optimistic edit acknowledgement

(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // Failsafe: an uncaught error must never leave a silently dead designer.
    // Surface it in the status bar; the document itself is always untouched
    // until an edit message is posted, so nothing can be corrupted.
    window.addEventListener('error', e => {
        try { setStatus(`UI Maker error: ${e.message} — open the code view if the canvas looks wrong.`); } catch { /* status bar missing */ }
    });
    window.addEventListener('unhandledrejection', e => {
        try { setStatus(`UI Maker error: ${e.reason?.message ?? e.reason}`); } catch { /* status bar missing */ }
    });

    // ------------------------------------------------------------- namespaces

    const PRES_NS = 'http://schemas.microsoft.com/winfx/2006/xaml/presentation';
    const X_NS = 'http://schemas.microsoft.com/winfx/2006/xaml';

    /** Reserved C# keywords cannot be emitted as generated bare identifiers. */
    const CSHARP_RESERVED_KEYWORDS = new Set([
        'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch',
        'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default',
        'delegate', 'do', 'double', 'else', 'enum', 'event', 'explicit',
        'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach',
        'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is',
        'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out',
        'override', 'params', 'private', 'protected', 'public', 'readonly',
        'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc',
        'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try',
        'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using',
        'virtual', 'void', 'volatile', 'while'
    ]);

    function isCSharpIdentifier(value) {
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
            && !CSHARP_RESERVED_KEYWORDS.has(value);
    }

    /** Reserved VB.NET keywords (VB identifiers are case-insensitive). */
    const VB_RESERVED_KEYWORDS = new Set([
        'addhandler', 'addressof', 'alias', 'and', 'andalso', 'as', 'boolean',
        'byref', 'byte', 'byval', 'call', 'case', 'catch', 'cbool', 'cbyte',
        'cchar', 'cdate', 'cdbl', 'cdec', 'char', 'cint', 'class', 'clng',
        'cobj', 'const', 'continue', 'csbyte', 'cshort', 'csng', 'cstr',
        'ctype', 'cuint', 'culng', 'cushort', 'date', 'decimal', 'declare',
        'default', 'delegate', 'dim', 'directcast', 'do', 'double', 'each',
        'else', 'elseif', 'end', 'endif', 'enum', 'erase', 'error', 'event',
        'exit', 'false', 'finally', 'for', 'friend', 'function', 'get',
        'gettype', 'getxmlnamespace', 'global', 'gosub', 'goto', 'handles',
        'if', 'implements', 'imports', 'in', 'inherits', 'integer',
        'interface', 'is', 'isnot', 'let', 'lib', 'like', 'long', 'loop',
        'me', 'mod', 'module', 'mustinherit', 'mustoverride', 'mybase',
        'myclass', 'nameof', 'namespace', 'narrowing', 'new', 'next', 'not',
        'nothing', 'notinheritable', 'notoverridable', 'object', 'of', 'on',
        'operator', 'option', 'optional', 'or', 'orelse', 'overloads',
        'overridable', 'overrides', 'paramarray', 'partial', 'private',
        'property', 'protected', 'public', 'raiseevent', 'readonly', 'redim',
        'rem', 'removehandler', 'resume', 'return', 'sbyte', 'select', 'set',
        'shadows', 'shared', 'short', 'single', 'static', 'step', 'stop',
        'string', 'structure', 'sub', 'synclock', 'then', 'throw', 'to',
        'true', 'try', 'trycast', 'typeof', 'uinteger', 'ulong', 'ushort',
        'using', 'variant', 'wend', 'when', 'while', 'widening', 'with',
        'withevents', 'writeonly', 'xor'
    ]);

    function isVbIdentifier(value) {
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
            && !VB_RESERVED_KEYWORDS.has(value.toLowerCase());
    }

    /** Generated identifiers must be valid in the DOCUMENT's language. */
    function validateCSharpIdentifier(value, subject) {
        const ok = wfLang === 'vb' ? isVbIdentifier(value) : isCSharpIdentifier(value);
        if (ok) { return true; }
        setStatus(`UI Maker: "${value}" is not a valid ${subject} — use a non-keyword ${wfLang === 'vb' ? 'Visual Basic' : 'C#'} identifier.`);
        return false;
    }

    // -------------------------------------------------------- control catalog
    //
    // Every entry describes how a WPF control appears in the toolbox, its
    // default size/attributes when dropped, which extra properties the panel
    // shows, its events, and the event wired on double-click.

    const CONTROLS = {
        Button:      { icon: '▭', w: 100, h: 32,  attrs: { Content: 'Button' },   props: ['Content'], events: ['Click', 'MouseDoubleClick', 'GotFocus', 'LostFocus'], defaultEvent: 'Click' },
        Label:       { icon: 'A',  w: 90,  h: 26,  attrs: { Content: 'Label' },    props: ['Content'], events: ['MouseDown', 'MouseUp'], defaultEvent: 'MouseDown' },
        TextBlock:   { icon: '¶',  w: 110, h: 20,  attrs: { Text: 'TextBlock' },   props: ['Text', 'TextWrapping'], events: ['MouseDown'], defaultEvent: 'MouseDown' },
        TextBox:     { icon: '⌨', w: 160, h: 28,  attrs: { Text: '' },            props: ['Text', 'MaxLength', 'TextWrapping', 'AcceptsReturn'], events: ['TextChanged', 'KeyDown', 'KeyUp', 'GotFocus', 'LostFocus'], defaultEvent: 'TextChanged' },
        PasswordBox: { icon: '🔑', w: 160, h: 28,  attrs: {},                      props: ['MaxLength'], events: ['PasswordChanged', 'KeyDown'], defaultEvent: 'PasswordChanged' },
        CheckBox:    { icon: '☑', w: 110, h: 22,  attrs: { Content: 'CheckBox' }, props: ['Content', 'IsChecked'], events: ['Checked', 'Unchecked', 'Click'], defaultEvent: 'Checked' },
        RadioButton: { icon: '◉', w: 120, h: 22,  attrs: { Content: 'RadioButton' }, props: ['Content', 'IsChecked', 'GroupName'], events: ['Checked', 'Unchecked', 'Click'], defaultEvent: 'Checked' },
        ComboBox:    { icon: '▾', w: 140, h: 28,  attrs: {},                      props: ['SelectedIndex', 'IsEditable'], events: ['SelectionChanged'], defaultEvent: 'SelectionChanged' },
        ListBox:     { icon: '≡', w: 160, h: 120, attrs: {},                      props: ['SelectedIndex'], events: ['SelectionChanged', 'MouseDoubleClick'], defaultEvent: 'SelectionChanged' },
        DataGrid:    { icon: '▦', w: 300, h: 160, attrs: { AutoGenerateColumns: 'True' }, props: ['AutoGenerateColumns', 'IsReadOnly'], events: ['SelectionChanged'], defaultEvent: 'SelectionChanged' },
        Image:       { icon: '🖼', w: 120, h: 90,  attrs: { Stretch: 'Uniform' },  props: ['Source', 'Stretch'], events: ['MouseDown'], defaultEvent: 'MouseDown' },
        ProgressBar: { icon: '▱', w: 180, h: 18,  attrs: { Value: '40' },         props: ['Minimum', 'Maximum', 'Value', 'IsIndeterminate'], events: ['ValueChanged'], defaultEvent: 'ValueChanged' },
        Slider:      { icon: '⬌', w: 180, h: 24,  attrs: { Minimum: '0', Maximum: '100', Value: '25' }, props: ['Minimum', 'Maximum', 'Value', 'TickFrequency'], events: ['ValueChanged'], defaultEvent: 'ValueChanged' },
        Border:      { icon: '▢', w: 200, h: 120, attrs: { BorderBrush: '#FF808080', BorderThickness: '1' }, props: ['BorderBrush', 'BorderThickness', 'CornerRadius', 'Padding'], events: ['MouseDown'], defaultEvent: 'MouseDown' },
        GroupBox:    { icon: '⬒', w: 220, h: 140, attrs: { Header: 'GroupBox' },  props: ['Header'], events: ['MouseDown'], defaultEvent: 'MouseDown' },
        DatePicker:  { icon: '📅', w: 140, h: 28,  attrs: {},                      props: ['SelectedDate'], events: ['SelectedDateChanged'], defaultEvent: 'SelectedDateChanged' },
        Calendar:    { icon: '📆', w: 180, h: 170, attrs: {},                      props: ['SelectedDate', 'DisplayMode'], events: ['SelectedDatesChanged'], defaultEvent: 'SelectedDatesChanged' },
        ListView:    { icon: '☰', w: 250, h: 150, attrs: {},                      props: ['SelectedIndex'], events: ['SelectionChanged', 'MouseDoubleClick'], defaultEvent: 'SelectionChanged' },
        TreeView:    { icon: '🌲', w: 200, h: 150, attrs: {},                      props: [], events: ['SelectedItemChanged', 'MouseDoubleClick'], defaultEvent: 'SelectedItemChanged' },
        RichTextBox: { icon: '📝', w: 220, h: 120, attrs: {},                      props: ['IsReadOnly', 'AcceptsReturn'], events: ['TextChanged'], defaultEvent: 'TextChanged' },
        Expander:    { icon: '▸', w: 220, h: 120, attrs: { Header: 'Expander', IsExpanded: 'True' }, props: ['Header', 'IsExpanded'], events: ['Expanded', 'Collapsed'], defaultEvent: 'Expanded' },
        Separator:   { icon: '─', w: 160, h: 4,   attrs: {},                      props: [], events: [], defaultEvent: 'Loaded' },
        TabControl:  { icon: '⧉', w: 320, h: 200, attrs: {},                      props: [], events: ['SelectionChanged'], defaultEvent: 'SelectionChanged' },
        Grid:        { icon: '#',  w: 260, h: 180, attrs: {},                      props: [], events: [], defaultEvent: 'Loaded' },
        StackPanel:  { icon: '☷', w: 220, h: 160, attrs: {},                      props: ['Orientation'], events: [], defaultEvent: 'Loaded' },
        WrapPanel:   { icon: '⠿', w: 220, h: 120, attrs: {},                      props: ['Orientation'], events: [], defaultEvent: 'Loaded' },
        DockPanel:   { icon: '◫', w: 260, h: 180, attrs: {},                      props: ['LastChildFill'], events: [], defaultEvent: 'Loaded' },
        Canvas:      { icon: '⬚', w: 260, h: 180, attrs: {},                      props: [], events: [], defaultEvent: 'Loaded' },
        ScrollViewer:{ icon: '↕', w: 240, h: 160, attrs: {},                      props: ['VerticalScrollBarVisibility'], events: [], defaultEvent: 'Loaded' }
    };

    /** Extra property-panel entries for layout containers (not in the toolbox). */
    const PANEL_PROPS = {
        StackPanel: ['Orientation'],
        WrapPanel: ['Orientation'],
        DockPanel: ['LastChildFill'],
        TabControl: [],
        TabItem: ['Header'],
        ScrollViewer: ['VerticalScrollBarVisibility', 'HorizontalScrollBarVisibility'],
        Grid: []
    };

    /** Properties shown for every control, in panel order (VS parity set). */
    const COMMON_PROPS = ['Width', 'Height', 'MinWidth', 'MinHeight', 'MaxWidth', 'MaxHeight',
        'Margin', 'Padding', 'HorizontalAlignment', 'VerticalAlignment',
        'Grid.Row', 'Grid.Column', 'Grid.RowSpan', 'Grid.ColumnSpan', 'Panel.ZIndex',
        'Background', 'Foreground', 'BorderBrush', 'BorderThickness', 'Opacity',
        'FontSize', 'FontFamily', 'FontWeight', 'FontStyle',
        'Cursor', 'IsEnabled', 'Visibility', 'ToolTip', 'Tag'];

    /** Window-level properties/events shown when nothing is selected. */
    const WINDOW_PROPS = ['Title', 'Width', 'Height', 'Background', 'FontSize', 'FontFamily',
        'ResizeMode', 'WindowStartupLocation', 'WindowStyle', 'WindowState', 'SizeToContent', 'Topmost'];
    const WINDOW_EVENTS = ['Loaded', 'Closing', 'KeyDown', 'KeyUp'];

    /** Suggested values for enum-like attributes (rendered as datalists). */
    const ENUM_VALUES = {
        Visibility: ['Visible', 'Hidden', 'Collapsed'],
        FontWeight: ['Thin', 'Light', 'Normal', 'Medium', 'SemiBold', 'Bold', 'Black'],
        HorizontalAlignment: ['Left', 'Center', 'Right', 'Stretch'],
        VerticalAlignment: ['Top', 'Center', 'Bottom', 'Stretch'],
        Orientation: ['Vertical', 'Horizontal'],
        IsEnabled: ['True', 'False'],
        IsChecked: ['True', 'False'],
        IsReadOnly: ['True', 'False'],
        IsEditable: ['True', 'False'],
        IsIndeterminate: ['True', 'False'],
        AcceptsReturn: ['True', 'False'],
        LastChildFill: ['True', 'False'],
        AutoGenerateColumns: ['True', 'False'],
        TextWrapping: ['NoWrap', 'Wrap', 'WrapWithOverflow'],
        Stretch: ['None', 'Fill', 'Uniform', 'UniformToFill'],
        VerticalScrollBarVisibility: ['Auto', 'Visible', 'Hidden', 'Disabled'],
        HorizontalScrollBarVisibility: ['Auto', 'Visible', 'Hidden', 'Disabled'],
        ResizeMode: ['NoResize', 'CanMinimize', 'CanResize', 'CanResizeWithGrip'],
        WindowStartupLocation: ['Manual', 'CenterScreen', 'CenterOwner'],
        WindowStyle: ['None', 'SingleBorderWindow', 'ThreeDBorderWindow', 'ToolWindow'],
        WindowState: ['Normal', 'Minimized', 'Maximized'],
        SizeToContent: ['Manual', 'Width', 'Height', 'WidthAndHeight'],
        Topmost: ['True', 'False'],
        FontStyle: ['Normal', 'Italic', 'Oblique'],
        SelectionMode: ['Single', 'Multiple', 'Extended'],
        DisplayMode: ['Month', 'Year', 'Decade'],
        Cursor: ['Arrow', 'Hand', 'Wait', 'Cross', 'IBeam', 'No', 'SizeAll', 'SizeNS', 'SizeWE', 'Help', 'AppStarting']
    };

    /** Brush-typed attributes: swatch + native color picker + named colors. */
    const XAML_BRUSH_PROPS = new Set(['Background', 'Foreground', 'BorderBrush', 'Fill', 'Stroke']);

    /** Suggested sizes/families for the font rows (free text still allowed). */
    const XAML_FONT_SIZES = ['8', '9', '10', '11', '12', '13', '14', '15', '16', '18',
        '20', '22', '24', '26', '28', '32', '36', '48', '72'];
    const XAML_FONT_FAMILIES = ['Segoe UI', 'Segoe UI Semibold', 'Arial', 'Bahnschrift', 'Calibri',
        'Cambria', 'Candara', 'Cascadia Code', 'Cascadia Mono', 'Comic Sans MS', 'Consolas',
        'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Impact', 'Lucida Console',
        'Malgun Gothic', 'MS Gothic', 'Sylfaen', 'Tahoma', 'Times New Roman',
        'Trebuchet MS', 'Verdana'];

    /** Panels that accept toolbox drops. */
    const DROP_PANELS = ['Grid', 'Canvas', 'StackPanel', 'WrapPanel', 'DockPanel'];

    /** Property-grid categories for XAML attributes (default: Common). */
    const XAML_CATS = {
        Width: 'Layout', Height: 'Layout', Margin: 'Layout', Padding: 'Layout',
        MinWidth: 'Layout', MinHeight: 'Layout', MaxWidth: 'Layout', MaxHeight: 'Layout',
        HorizontalAlignment: 'Layout', VerticalAlignment: 'Layout',
        'Grid.Row': 'Layout', 'Grid.Column': 'Layout',
        'Grid.RowSpan': 'Layout', 'Grid.ColumnSpan': 'Layout', 'Panel.ZIndex': 'Layout',
        Opacity: 'Appearance', Cursor: 'Behavior', Tag: 'Common',
        Background: 'Appearance', Foreground: 'Appearance', FontSize: 'Appearance',
        FontWeight: 'Appearance', FontFamily: 'Appearance', FontStyle: 'Appearance',
        BorderBrush: 'Appearance', BorderThickness: 'Appearance',
        CornerRadius: 'Appearance', Title: 'Appearance',
        Fill: 'Appearance', Stroke: 'Appearance',
        IsEnabled: 'Behavior', Visibility: 'Behavior', ToolTip: 'Behavior',
        ResizeMode: 'Window Style', WindowStartupLocation: 'Layout',
        WindowStyle: 'Window Style', WindowState: 'Window Style',
        SizeToContent: 'Layout', Topmost: 'Window Style'
    };

    /** Grid help-pane text for common XAML attributes. */
    const XAML_DESCS = {
        Name: 'The x:Name used to reference the element from code-behind.',
        Width: 'The explicit width of the element in device-independent pixels.',
        Height: 'The explicit height of the element in device-independent pixels.',
        Margin: 'The outer spacing around the element: left,top,right,bottom.',
        HorizontalAlignment: 'How the element aligns horizontally inside its layout slot.',
        VerticalAlignment: 'How the element aligns vertically inside its layout slot.',
        'Grid.Row': 'The Grid row this element occupies.',
        'Grid.Column': 'The Grid column this element occupies.',
        Background: 'The brush painted behind the content.',
        Foreground: 'The brush used to draw text and glyphs.',
        FontSize: 'The size of the text in device-independent pixels.',
        FontWeight: 'The weight (thickness) of the text.',
        IsEnabled: 'Whether the element responds to user interaction.',
        Visibility: 'Visible, Hidden (keeps space), or Collapsed (no space).',
        ToolTip: 'The tooltip shown when the pointer hovers over the element.',
        Title: 'The text shown in the window title bar.',
        ResizeMode: 'Whether and how the user can resize the window.',
        WindowStartupLocation: 'Where the window first appears on screen.',
        FontFamily: 'The font family used to draw text, e.g. Segoe UI or Consolas.',
        FontStyle: 'Normal, Italic, or Oblique text.',
        WindowStyle: 'The window chrome: standard border, tool window, or none.',
        WindowState: 'Whether the window starts normal, minimized, or maximized.',
        SizeToContent: 'Auto-size the window to its content in one or both directions.',
        Topmost: 'Keep the window above all non-topmost windows.',
        Source: 'The image file shown, as a project-relative path.',
        Fill: 'The brush that paints the interior of the shape.',
        Stroke: 'The brush that paints the outline of the shape.',
        Padding: 'Inner spacing between the border and the content: left,top,right,bottom.',
        MinWidth: 'The minimum width the element may shrink to.',
        MinHeight: 'The minimum height the element may shrink to.',
        MaxWidth: 'The maximum width the element may grow to.',
        MaxHeight: 'The maximum height the element may grow to.',
        'Grid.RowSpan': 'How many Grid rows this element spans.',
        'Grid.ColumnSpan': 'How many Grid columns this element spans.',
        'Panel.ZIndex': 'Stacking order — higher values render on top.',
        Opacity: '0.0 (transparent) through 1.0 (opaque).',
        Cursor: 'The mouse cursor shown while over the element.',
        Tag: 'Arbitrary data slot — not used by WPF itself.',
        BorderBrush: 'The brush that paints the border (with BorderThickness).',
        BorderThickness: 'Border width per edge: uniform or left,top,right,bottom.'
    };

    // ------------------------------------------------------------------ state

    let docMode = 'xaml';       // 'xaml' (WPF markup) | 'winforms' (*.Designer.cs)
    let xamlText = '';          // last text we parsed or produced
    let xamlDoc = null;         // XMLDocument of the current XAML
    let modelStale = false;     // document changed but did not parse — canvas
                                // shows the LAST GOOD state and must not write
    let xmlDeclaration = '';    // "<?xml …?>" line of the document, if any
    let windowEl = null;        // root element (Window / UserControl / Page)
    let contentRoot = null;     // the window's single content element
    let layoutRoot = null;      // top-level panel used for fallback drops
    let selected = null;        // selected XML element / WinForms record / null
    let selectedPath = '';      // index path of the selection (survives re-parse)
    let visuals = [];           // [{ el, div }] rendered this pass
    let styles = { byKey: new Map(), byType: new Map(), resources: new Map() }; // <Style> + brush resources
    let appResourceTexts = [];  // App.xaml / merged dictionaries sent by the host
    let wfControls = new Map(); // WinForms mode: name -> control record
    let wfForm = null;          // WinForms mode: the form itself
    let wfStyle = { thisPrefix: true, qualified: true }; // code dialect of the file
    let wfLang = 'cs';          // WinForms language: 'cs' (Designer.cs) | 'vb' (Designer.vb)
    let wfVbHandles = [];       // VB: [{handler, target}] Handles wiring from the code-behind
    const uiTabs = new Map();   // TabControl path/name -> active tab index
    let activeTab = 'props';    // 'props' | 'events'
    let zoom = 1;
    let config = { gridSize: 8, snap: true, docName: 'Window.xaml' };

    // --------------------------------------------------------------- dom refs

    const $ = id => document.getElementById(id);
    const surfaceEl = $('ff-surface');
    const windowBox = $('ff-window');
    const titleText = $('ff-title-text');
    const bannerEl = $('ff-banner');
    const statusEl = $('ff-status');
    const propsBody = $('ff-props-body');
    const propsTarget = $('ff-props-target');

    // ================================================================ messages

    window.addEventListener('message', e => {
        const msg = e.data;
        try { handleHostMessage(msg); }
        catch (err) {
            showBanner(`The designer hit an error rendering this file (${err?.message ?? err}). The document is unchanged.`,
                '</> View Code', () => vscode.postMessage({ type: 'openCode' }));
        }
    });

    function handleHostMessage(msg) {
        if (msg.type === 'update') {
            // VB event wiring lives in the code-behind (Handles clauses); the
            // host parses and sends it because the webview sees only THIS file.
            const handlesChanged = Array.isArray(msg.vbHandles)
                && JSON.stringify(msg.vbHandles) !== JSON.stringify(wfVbHandles);
            if (Array.isArray(msg.vbHandles)) { wfVbHandles = msg.vbHandles; }
            // Application-level resources (App.xaml + merged dictionaries):
            // when they change, styles must be re-collected even if this
            // document's text is unchanged.
            const appChanged = Array.isArray(msg.appResources)
                && JSON.stringify(msg.appResources) !== JSON.stringify(appResourceTexts);
            if (Array.isArray(msg.appResources)) { appResourceTexts = msg.appResources; }
            if (msg.text === xamlText && !handlesChanged && !appChanged) { return; } // echo of our own edit
            xamlText = msg.text;
            parseAndRender();
        } else if (msg.type === 'editResult') {
            // A text/code edit won the race after the designer built its
            // optimistic replacement. Restore the host's authoritative text
            // instead of leaving the preview on a version that was not saved.
            if (msg.ok === false) {
                xamlText = typeof msg.text === 'string' ? msg.text : '';
                parseAndRender();
                setStatus(msg.reason
                    ? `UI Maker: ${msg.reason}`
                    : 'UI Maker: the file changed before the designer edit could be applied; the designer has been refreshed.');
            }
        } else if (msg.type === 'config') {
            config.gridSize = msg.gridSize ?? config.gridSize;
            config.snap = msg.snap ?? config.snap;
            config.docName = msg.docName ?? config.docName;
            $('ff-grid').value = String(config.gridSize);
            $('ff-snap').checked = config.snap;
            render();
        } else if (msg.type === 'imageSet') {
            // Host imported an image for a property — write the assignment.
            if (msg.xaml) {
                imageCache.set(`x:${msg.rel}`, msg.uri);
                if (pendingXamlImage && !modelStale) {
                    const { el, prop } = pendingXamlImage;
                    pendingXamlImage = null;
                    if (prop === 'Source') {
                        el.setAttribute('Source', msg.rel);
                        commit();
                    } else {
                        setXamlImageBrush(el, prop, msg.rel);
                    }
                }
            } else {
                imageCache.set(`p:${msg.key}`, msg.uri);
                if (docMode === 'winforms') {
                    wfApply(msg.isForm
                        ? wfSetFormLine(msg.prop, msg.code)
                        : wfSetLine(msg.ctrl, msg.prop, msg.code));
                }
            }
        } else if (msg.type === 'images') {
            // Host resolved referenced images — cache and redraw.
            for (const [k, v] of Object.entries(msg.images ?? {})) { imageCache.set(k, v); }
            if (docMode === 'winforms') { wfRender(); } else if (xamlDoc) { render(); }
        } else if (msg.type === 'clipboard') {
            // Shared clipboard from the host — enables cross-form paste.
            if (msg.data) { clipboard = msg.data; }
        }
    }

    // ================================================================= parsing

    function parseAndRender() {
        bannerEl.hidden = true;

        // WinForms designer files are C# or Visual Basic, not XAML — hand
        // them to the dedicated parser/renderer.
        const wantWinForms = /\.designer\.(cs|vb)$/i.test(config.docName)
            || (/InitializeComponent\s*\(\s*\)/.test(xamlText) && /System\.Windows\.Forms/.test(xamlText));
        if (wantWinForms) {
            wfLang = /\.designer\.vb$/i.test(config.docName)
                || (!/\.designer\.cs$/i.test(config.docName) && /^\s*(?:Partial\s+Class|End\s+Sub)\b/mi.test(xamlText))
                ? 'vb' : 'cs';
            // WinForms edits are surgical rewrites of the CURRENT text (never
            // a model re-serialization), so the stale latch does not apply.
            setModelStale(false);
            if (docMode !== 'winforms') { docMode = 'winforms'; buildToolbox(); }
            wfParseAndRender();
            return;
        }
        if (docMode !== 'xaml') { docMode = 'xaml'; buildToolbox(); }

        if (!xamlText.trim()) {
            setModelStale(false);
            xamlDoc = windowEl = contentRoot = layoutRoot = selected = null;
            showBanner('This file is empty.', 'Insert starter window', insertStarterXaml);
            renderEmpty();
            return;
        }

        const parsed = new DOMParser().parseFromString(xamlText, 'text/xml');
        if (parsed.getElementsByTagName('parsererror').length) {
            // The canvas still shows the previous parse. Serializing that
            // stale model would overwrite the newer (broken) text, so lock
            // the canvas read-only until the document parses again.
            setModelStale(true);
            showBanner('The XAML has syntax errors — the designer is read-only until they are fixed in the code view.', '</> View Code',
                () => vscode.postMessage({ type: 'openCode' }));
            return;
        }
        setModelStale(false);
        xmlDeclaration = /^\s*<\?xml[^>]*\?>/.exec(xamlText)?.[0].trim() ?? '';

        xamlDoc = parsed;
        windowEl = xamlDoc.documentElement;
        collectStyles();
        selected = restoreSelection();
        // multiSel still points into the OLD DOM — rebuild it around the
        // restored selection so group actions (delete, align) cannot act on
        // detached nodes.
        multiSel.clear();
        if (selected) { multiSel.add(selected); }

        if (windowEl.localName === 'Application' || windowEl.localName === 'ResourceDictionary') {
            // Nothing to design — hand the file straight to the text editor.
            contentRoot = layoutRoot = null;
            showBanner(`${config.docName} holds application resources, not a visual layout. Opening the code view…`,
                '</> View Code', () => vscode.postMessage({ type: 'openCode' }));
            renderEmpty();
            vscode.postMessage({ type: 'noDesign' });
            return;
        }

        // The window's content is its first non-property element child
        // (skipping <Window.Resources> and friends).
        contentRoot = elementChildren(windowEl)[0] ?? null;
        layoutRoot = contentRoot && DROP_PANELS.includes(contentRoot.localName) ? contentRoot : null;

        render();
    }

    /**
     * Read-only latch for the design surface. While stale, the canvas keeps
     * showing the last good parse but every path that could write the
     * document (commit / wfApply) refuses, so out-of-date markup can never
     * overwrite newer source text.
     */
    function setModelStale(stale) {
        modelStale = stale;
        surfaceEl.classList.toggle('ff-stale', stale);
        windowBox.classList.toggle('ff-stale', stale);
    }

    /** Direct element children, excluding property elements like <Grid.RowDefinitions>. */
    function elementChildren(parent) {
        return [...parent.children].filter(c => !c.localName.includes('.'));
    }

    /** The property element <Type.Name> of `el`, or null. */
    function propertyElement(el, name) {
        return [...el.children].find(c => c.localName === `${el.localName}.${name}`) ?? null;
    }

    // ------------------------------------------------------------ xaml images
    // Image.Source and ImageBrush.ImageSource values are project-relative
    // paths; the extension host resolves them to webview URIs on request.
    // Cache keys are 'x:<relative path>'; null marks an in-flight request.

    let xamlImageWanted = [];      // batched resolveImages request
    let pendingXamlImage = null;   // { el, prop } awaiting the host's pick

    /** The <ImageBrush> inside <Element.Prop>, or null. */
    function xamlImageBrush(el, prop) {
        const pe = propertyElement(el, prop);
        return pe ? [...pe.children].find(c => c.localName === 'ImageBrush') ?? null : null;
    }

    /** ImageBrush Stretch -> CSS background-size. */
    function ibStretchCss(stretch) {
        switch (stretch) {
            case 'None': return 'auto';
            case 'Uniform': return 'contain';
            case 'UniformToFill': return 'cover';
            default: return '100% 100%'; // Fill
        }
    }

    /** Renderable URI for a XAML image path (queues host resolution once). */
    function xamlImageUri(src) {
        if (!src || src.includes('{')) { return null; }
        const rel = src.trim().replace(/^pack:\/\/[^,]*,,,\//i, '').replace(/^\//, '');
        if (!rel) { return null; }
        const ck = `x:${rel}`;
        if (!imageCache.has(ck)) {
            imageCache.set(ck, null); // pending — avoids re-request loops
            if (!xamlImageWanted.length) { setTimeout(flushXamlImageRequests, 0); }
            xamlImageWanted.push(rel);
        }
        return imageCache.get(ck) || null;
    }

    function flushXamlImageRequests() {
        if (!xamlImageWanted.length) { return; }
        vscode.postMessage({ type: 'resolveImages', keys: xamlImageWanted.map(k => ({ scope: 'x', key: k })) });
        xamlImageWanted = [];
    }

    /** Remove <Element.Prop> (used when an attribute value replaces a brush). */
    function removePropertyElement(el, name) {
        const pe = propertyElement(el, name);
        if (pe) { pe.remove(); }
    }

    /** Write <Element.Prop><ImageBrush ImageSource="rel"/></Element.Prop>. */
    function setXamlImageBrush(el, prop, rel) {
        el.removeAttribute(prop); // attribute + property element = XAML error
        removePropertyElement(el, prop);
        const ns = el.namespaceURI;
        const pe = xamlDoc.createElementNS(ns, `${el.localName}.${prop}`);
        const ib = xamlDoc.createElementNS(ns, 'ImageBrush');
        ib.setAttribute('ImageSource', rel);
        ib.setAttribute('Stretch', 'UniformToFill');
        pe.appendChild(ib);
        el.insertBefore(pe, el.firstChild);
        commit();
    }

    /** After a re-parse, re-select the element with the previous x:Name or path. */
    function restoreSelection() {
        if (!xamlDoc) { return null; }
        if (selected) {
            const name = getName(selected);
            if (name) {
                for (const el of xamlDoc.getElementsByTagName('*')) {
                    if (getName(el) === name) { return el; }
                }
            }
        }
        return selectedPath ? elAtPath(selectedPath) : null;
    }

    // --------------------------------------------------------- element paths
    // Re-parsing creates brand new DOM nodes, so per-element UI state (active
    // tab, selection fallback) is keyed by the element's child-index path.

    function pathOf(el) {
        const idx = [];
        let n = el;
        while (n && n !== xamlDoc.documentElement) {
            const p = n.parentNode;
            if (!p || p.nodeType !== Node.ELEMENT_NODE) { break; }
            idx.unshift([...p.children].indexOf(n));
            n = p;
        }
        return idx.join('/');
    }

    function elAtPath(path) {
        if (!xamlDoc) { return null; }
        let n = xamlDoc.documentElement;
        if (path === '') { return n; }
        for (const i of path.split('/')) {
            n = n.children[Number(i)];
            if (!n) { return null; }
        }
        return n;
    }

    // ================================================================== styles
    // Minimal StaticResource support: <Style x:Key TargetType> with
    // <Setter Property Value> pairs from any *.Resources block under the root.
    // Enough to preview styled TextBlocks/Borders the way VS renders them.

    function collectStyles() {
        styles = { byKey: new Map(), byType: new Map(), resources: new Map() };
        if (!windowEl) { return; }
        // Application-level resources first, so the document's own definitions
        // override them (same precedence as WPF resource lookup).
        for (const text of appResourceTexts) {
            const doc = new DOMParser().parseFromString(text, 'text/xml');
            if (doc.getElementsByTagName('parsererror').length) { continue; }
            const root = doc.documentElement;
            if (!root) { continue; }
            if (root.localName === 'ResourceDictionary') { collectStylesFrom(root); continue; }
            for (const child of root.children) {
                if (child.localName.endsWith('.Resources')) { collectStylesFrom(child); }
            }
        }
        for (const child of windowEl.children) {
            if (!child.localName.endsWith('.Resources')) { continue; }
            collectStylesFrom(child);
        }
    }

    function collectStylesFrom(container) {
        for (const node of container.children) {
            if (node.localName === 'ResourceDictionary') { collectStylesFrom(node); continue; }
            const key = node.getAttributeNS(X_NS, 'Key') || node.getAttribute('x:Key');

            // Brush/color resources referenced via {StaticResource}.
            if (key && node.localName === 'SolidColorBrush') {
                const css = toCssColor(node.getAttribute('Color') || collapse(node.textContent));
                if (css) { styles.resources.set(key, css); }
                continue;
            }
            if (key && node.localName === 'Color') {
                const css = toCssColor(collapse(node.textContent));
                if (css) { styles.resources.set(key, css); }
                continue;
            }
            if (key && (node.localName === 'LinearGradientBrush' || node.localName === 'RadialGradientBrush')) {
                const css = gradientCss(node);
                if (css) { styles.resources.set(key, css); }
                continue;
            }

            if (node.localName !== 'Style') { continue; }
            const setters = {};
            for (const s of node.children) {
                if (s.localName !== 'Setter') { continue; }
                const p = (s.getAttribute('Property') || '').split('.').pop();
                const v = s.getAttribute('Value');
                if (p === 'Template') {
                    // Approximate templated chrome: the template's first
                    // <Border> supplies corner rounding when no explicit
                    // CornerRadius setter exists.
                    const border = findDescendantElement(s, 'Border');
                    const cr = border?.getAttribute('CornerRadius');
                    if (cr && !cr.includes('{') && !('CornerRadius' in setters)) { setters.CornerRadius = cr; }
                    continue;
                }
                if (p && v !== null) { setters[p] = v; }
            }
            const basedOn = resourceKey(node.getAttribute('BasedOn'));
            const entry = { setters, basedOn };
            const target = (node.getAttribute('TargetType') || '').split(':').pop();
            if (key) { styles.byKey.set(key, entry); }
            else if (target) { styles.byType.set(target, entry); }
        }
    }

    /** First descendant element with the given localName (depth-first). */
    function findDescendantElement(node, name) {
        for (const c of node.children) {
            if (c.localName === name) { return c; }
            const d = findDescendantElement(c, name);
            if (d) { return d; }
        }
        return null;
    }

    /** CSS gradient for a Linear/RadialGradientBrush resource. */
    function gradientCss(node) {
        const stops = [];
        const walk = n => {
            for (const c of n.children) {
                if (c.localName === 'GradientStop') {
                    const color = toCssColor(c.getAttribute('Color') || '');
                    if (color) { stops.push({ color, offset: num(c.getAttribute('Offset'), stops.length ? 1 : 0) }); }
                } else { walk(c); }
            }
        };
        walk(node);
        if (!stops.length) { return ''; }
        stops.sort((a, b) => a.offset - b.offset);
        const list = stops.map(s => `${s.color} ${Math.round(s.offset * 100)}%`).join(', ');
        if (node.localName === 'RadialGradientBrush') { return `radial-gradient(circle, ${list})`; }
        // CSS angles: 0deg points up, clockwise; WPF y grows downward.
        const sp = (node.getAttribute('StartPoint') || '0,0').split(',').map(Number);
        const ep = (node.getAttribute('EndPoint') || '1,1').split(',').map(Number);
        const deg = Math.round(Math.atan2((ep[0] ?? 1) - (sp[0] ?? 0), -((ep[1] ?? 1) - (sp[1] ?? 0))) * 180 / Math.PI);
        return `linear-gradient(${deg}deg, ${list})`;
    }

    /** Extract KEY from "{StaticResource KEY}" / "{DynamicResource KEY}" —
     *  including nested forms like "{StaticResource {x:Type Button}}". */
    function resourceKey(v) {
        const m = /^\{\s*(?:StaticResource|DynamicResource)\s+([\s\S]+?)\s*\}$/.exec((v || '').trim());
        return m ? m[1] : null;
    }

    /** XAML brush value -> CSS: resolves {StaticResource} colors/gradients,
     *  then plain colors. Bindings/template bindings yield ''. */
    function resolveBrush(v) {
        if (!v) { return ''; }
        const key = resourceKey(v);
        if (key) { return styles.resources.get(key) ?? ''; }
        if (v.includes('{')) { return ''; }
        return toCssColor(v);
    }

    /**
     * Effective value of a visual property: explicit attribute first, then the
     * element's Style="{StaticResource ...}" setters, then the implicit style
     * for its type. Returns null when nothing applies.
     */
    function styleProp(el, name) {
        const attr = el.getAttribute(name);
        if (attr !== null && attr !== '') { return attr; }

        const seen = new Set();
        let entry = null;
        const key = resourceKey(el.getAttribute('Style'));
        if (key) { entry = styles.byKey.get(key) ?? null; }
        if (!entry) { entry = styles.byType.get(el.localName) ?? null; }
        while (entry) {
            if (name in entry.setters) { return entry.setters[name]; }
            if (!entry.basedOn || seen.has(entry.basedOn)) { break; }
            seen.add(entry.basedOn);
            // BasedOn="{StaticResource {x:Type Button}}" chains to the
            // implicit style for that type; plain keys chain by name.
            const typeRef = /^\{\s*x:Type\s+(?:\w+:)?(\w+)\s*\}$/.exec(entry.basedOn);
            entry = typeRef
                ? (styles.byType.get(typeRef[1]) ?? null)
                : (styles.byKey.get(entry.basedOn) ?? null);
        }
        return null;
    }

    // =============================================================== rendering

    function renderEmpty() {
        surfaceEl.innerHTML = '';
        visuals = [];
        titleText.textContent = config.docName;
        windowBox.classList.add('ff-noresize');
        renderPanel();
    }

    function render() {
        if (docMode === 'winforms') { wfRender(); return; }
        if (!windowEl || !xamlDoc) { renderEmpty(); return; }
        surfaceEl.style.display = 'grid';
        windowBox.classList.remove('ff-noresize');
        const titleIco = document.getElementById('ff-title-icon');
        if (titleIco) { titleIco.style.display = 'none'; } // WinForms-only

        // Window frame: size, title, background.
        const winW = num(windowEl.getAttribute('Width'), 800);
        const winH = num(windowEl.getAttribute('Height'), 450);
        titleText.textContent = windowEl.getAttribute('Title') || config.docName;
        windowBox.style.width = `${winW}px`;
        surfaceEl.style.height = `${winH - 32}px`; // minus mock title bar
        windowBox.style.transform = `scale(${zoom})`;

        // Window chrome follows the effective style (App.xaml implicit Window
        // style included) so themed apps preview like they run.
        const bg = resolveBrush(styleProp(windowEl, 'Background')) || '#ffffff';
        surfaceEl.style.background = bg;
        surfaceEl.style.setProperty('--ff-surface-bg', bg);
        // Designer-only chrome (tab headers, GroupBox captions, placeholder
        // boxes) flips to bright text on dark app themes for readability.
        surfaceEl.classList.toggle('ff-dark-surface', isDarkColor(bg));
        surfaceEl.style.color = resolveBrush(styleProp(windowEl, 'Foreground')) || '';
        const winFf = styleProp(windowEl, 'FontFamily');
        surfaceEl.style.fontFamily = winFf && !winFf.includes('{') ? winFf : '';

        // Grid dots follow the snap size.
        surfaceEl.style.backgroundImage = config.snap
            ? 'radial-gradient(circle, rgba(0,0,0,0.18) 1px, transparent 1px)' : 'none';
        surfaceEl.style.backgroundSize = `${config.gridSize}px ${config.gridSize}px`;

        // Content tree.
        surfaceEl.innerHTML = '';
        visuals = [];
        if (contentRoot) {
            surfaceEl.appendChild(renderElement(contentRoot, 'cell'));
        }

        drawSelection();
        renderPanel();
    }

    /**
     * Recursively create the HTML approximation of one element.
     * `kind` says how the PARENT positions this child:
     *   'cell'    single-cell grid (Window content, Border/GroupBox/TabItem child)
     *   'grid'    Grid child (row/column placement + alignment)
     *   'stack-v' vertical StackPanel child
     *   'stack-h' horizontal StackPanel child
     *   'wrap'    WrapPanel child
     *   'canvas'  Canvas child (absolute Canvas.Left/Top)
     *   'scroll'  ScrollViewer content (plain block flow)
     */
    function renderElement(el, kind) {
        const type = el.localName;
        const div = document.createElement('div');
        div.className = `ff-control ff-c-${type.toLowerCase()}`;

        applyVisual(div, el);
        placeChild(div, el, kind);
        buildContent(div, el);

        if (movability(el)) { div.classList.add('ff-movable'); }

        div.addEventListener('mousedown', e => {
            if (e.button !== 0) { return; }
            e.preventDefault();
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
                select(el, true); // multi-select (delete/copy work on the group)
                return;
            }
            select(el);
            startMove(e, el, div);
        });
        div.addEventListener('dblclick', e => {
            e.preventDefault();
            e.stopPropagation();
            wireDefaultEvent(el);
        });

        visuals.push({ el, div });
        return div;
    }

    /** Shared visual attributes (colors, fonts, visibility, enabled state). */
    function applyVisual(div, el) {
        const bg = resolveBrush(styleProp(el, 'Background'));
        const fg = resolveBrush(styleProp(el, 'Foreground'));
        if (bg) { div.style.background = bg; }
        if (fg) { div.style.color = fg; }
        // <Element.Background><ImageBrush ImageSource="…"/></Element.Background>
        const ib = xamlImageBrush(el, 'Background');
        if (ib) {
            const uri = xamlImageUri(ib.getAttribute('ImageSource'));
            if (uri) {
                div.style.backgroundImage = `url("${uri}")`;
                div.style.backgroundSize = ibStretchCss(ib.getAttribute('Stretch') || 'Fill');
                div.style.backgroundPosition = 'center';
                div.style.backgroundRepeat = 'no-repeat';
            }
        }
        const fs = num(styleProp(el, 'FontSize'), NaN);
        if (Number.isFinite(fs)) { div.style.fontSize = `${fs}px`; }
        const fw = styleProp(el, 'FontWeight');
        if (fw) { div.style.fontWeight = cssFontWeight(fw); }
        const fst = styleProp(el, 'FontStyle');
        if (fst && fst.toLowerCase() === 'italic') { div.style.fontStyle = 'italic'; }
        const ff = styleProp(el, 'FontFamily');
        if (ff && !ff.includes('{')) { div.style.fontFamily = ff; }
        const tt = el.getAttribute('ToolTip');
        if (tt && !tt.includes('{')) { div.title = tt; }
        const vis = styleProp(el, 'Visibility');
        if (vis && vis !== 'Visible') { div.classList.add('ff-hidden-control'); }
        if (el.getAttribute('IsEnabled') === 'False') { div.classList.add('ff-disabled-control'); }
    }

    /** Margin, size, and alignment inside the parent's layout model. */
    function placeChild(div, el, kind) {
        const m = parseMargin(styleProp(el, 'Margin'));
        if (m.l || m.t || m.r || m.b) {
            div.style.margin = `${m.t}px ${m.r}px ${m.b}px ${m.l}px`;
        }

        const w = num(styleProp(el, 'Width'), NaN);
        const h = num(styleProp(el, 'Height'), NaN);
        if (Number.isFinite(w)) { div.style.width = `${w}px`; }
        if (Number.isFinite(h)) { div.style.height = `${h}px`; }
        for (const [attr, css] of [['MinWidth', 'minWidth'], ['MinHeight', 'minHeight'],
                                   ['MaxWidth', 'maxWidth'], ['MaxHeight', 'maxHeight']]) {
            const v = num(styleProp(el, attr), NaN);
            if (Number.isFinite(v)) { div.style[css] = `${v}px`; }
        }

        // WPF quirk: an explicit size turns default Stretch into Center.
        let ha = styleProp(el, 'HorizontalAlignment') || 'Stretch';
        let va = styleProp(el, 'VerticalAlignment') || 'Stretch';
        if (Number.isFinite(w) && ha === 'Stretch') { ha = 'Center'; }
        if (Number.isFinite(h) && va === 'Stretch') { va = 'Center'; }
        const jh = alignCss(ha);
        const jv = alignCss(va);

        switch (kind) {
            case 'grid': {
                const r = int(el.getAttribute('Grid.Row'));
                const c = int(el.getAttribute('Grid.Column'));
                const rs = Math.max(1, int(el.getAttribute('Grid.RowSpan'), 1));
                const cs = Math.max(1, int(el.getAttribute('Grid.ColumnSpan'), 1));
                div.style.gridRow = `${r + 1} / span ${rs}`;
                div.style.gridColumn = `${c + 1} / span ${cs}`;
                div.style.justifySelf = jh;
                div.style.alignSelf = jv;
                break;
            }
            case 'cell':
                div.style.gridRow = '1';
                div.style.gridColumn = '1';
                div.style.justifySelf = jh;
                div.style.alignSelf = jv;
                break;
            case 'stack-v':
                div.style.flex = '0 0 auto';
                div.style.alignSelf = jh;
                break;
            case 'stack-h':
                div.style.flex = '0 0 auto';
                div.style.alignSelf = jv;
                break;
            case 'wrap':
                div.style.flex = '0 0 auto';
                div.style.alignSelf = jv === 'stretch' ? 'auto' : jv;
                break;
            case 'canvas':
                div.style.position = 'absolute';
                div.style.left = `${num(el.getAttribute('Canvas.Left'), 0)}px`;
                div.style.top = `${num(el.getAttribute('Canvas.Top'), 0)}px`;
                break;
            case 'flow':
                // Auto-flowing grid cell (UniformGrid) — alignment only, the
                // grid's auto-placement decides the cell.
                div.style.justifySelf = jh;
                div.style.alignSelf = jv;
                break;
            case 'scroll':
            default:
                break; // plain block flow
        }
    }

    function alignCss(a) {
        switch (a) {
            case 'Left': case 'Top': return 'start';
            case 'Center': return 'center';
            case 'Right': case 'Bottom': return 'end';
            default: return 'stretch';
        }
    }

    /** Per-type content: children for panels, chrome for leaf controls. */
    function buildContent(div, el) {
        const type = el.localName;
        switch (type) {
            case 'Grid': {
                div.style.display = 'grid';
                div.style.gridTemplateRows = gridTracks(el, 'Row');
                div.style.gridTemplateColumns = gridTracks(el, 'Column');
                for (const c of elementChildren(el)) { div.appendChild(renderElement(c, 'grid')); }
                break;
            }
            case 'StackPanel': {
                const horiz = (styleProp(el, 'Orientation') || 'Vertical') === 'Horizontal';
                div.style.display = 'flex';
                div.style.flexDirection = horiz ? 'row' : 'column';
                div.style.alignItems = 'stretch';
                for (const c of elementChildren(el)) { div.appendChild(renderElement(c, horiz ? 'stack-h' : 'stack-v')); }
                break;
            }
            case 'WrapPanel': {
                const vert = (styleProp(el, 'Orientation') || 'Horizontal') === 'Vertical';
                div.style.display = 'flex';
                div.style.flexWrap = 'wrap';
                div.style.flexDirection = vert ? 'column' : 'row';
                div.style.alignContent = 'flex-start';
                div.style.alignItems = 'flex-start';
                for (const c of elementChildren(el)) { div.appendChild(renderElement(c, 'wrap')); }
                break;
            }
            case 'DockPanel':
                buildDock(div, el);
                break;
            case 'UniformGrid': {
                // Equal cells filled in child order. Rows/Columns attributes
                // are honored; with neither, WPF picks a near-square layout.
                const kids = elementChildren(el);
                const rowsAttr = int(el.getAttribute('Rows'), 0);
                let cols = int(el.getAttribute('Columns'), 0);
                if (!cols) {
                    cols = rowsAttr > 0
                        ? Math.ceil((kids.length || 1) / rowsAttr)
                        : Math.ceil(Math.sqrt(kids.length || 1));
                }
                div.style.display = 'grid';
                div.style.gridTemplateColumns = `repeat(${Math.max(1, cols)}, minmax(0, 1fr))`;
                div.style.gridAutoRows = '1fr';
                for (const c of kids) { div.appendChild(renderElement(c, 'flow')); }
                break;
            }
            case 'Viewbox':
                singleCell(div);
                for (const c of elementChildren(el)) { div.appendChild(renderElement(c, 'cell')); }
                break;
            case 'Menu': case 'ToolBar': case 'StatusBar': {
                div.style.display = 'flex';
                div.style.flexDirection = 'row';
                div.style.alignItems = 'center';
                for (const c of elementChildren(el)) { div.appendChild(renderElement(c, 'stack-h')); }
                break;
            }
            case 'Canvas': {
                if (!div.style.position) { div.style.position = 'relative'; }
                div.style.overflow = 'hidden';
                for (const c of elementChildren(el)) { div.appendChild(renderElement(c, 'canvas')); }
                break;
            }
            case 'ScrollViewer': {
                const vs = el.getAttribute('VerticalScrollBarVisibility') || 'Visible';
                const hs = el.getAttribute('HorizontalScrollBarVisibility') || 'Disabled';
                div.style.overflowY = (vs === 'Disabled' || vs === 'Hidden') ? 'hidden' : 'auto';
                div.style.overflowX = (hs === 'Disabled' || hs === 'Hidden') ? 'hidden' : 'auto';
                for (const c of elementChildren(el)) { div.appendChild(renderElement(c, 'scroll')); }
                break;
            }
            case 'Border': {
                applyBorder(div, el);
                singleCell(div);
                for (const c of elementChildren(el)) { div.appendChild(renderElement(c, 'cell')); }
                break;
            }
            case 'GroupBox': {
                div.classList.add('ff-look-gb');
                const header = document.createElement('div');
                header.className = 'ff-gb-header';
                header.textContent = el.getAttribute('Header')
                    || collapse(propertyElement(el, 'Header')?.textContent) || 'GroupBox';
                const content = document.createElement('div');
                content.className = 'ff-gb-content';
                for (const c of elementChildren(el)) { content.appendChild(renderElement(c, 'cell')); }
                div.append(header, content);
                break;
            }
            case 'TabControl':
                buildTabControl(div, el);
                break;
            case 'Expander': {
                div.classList.add('ff-look-gb');
                const expanded = (styleProp(el, 'IsExpanded') ?? 'False') !== 'False';
                const header = document.createElement('div');
                header.className = 'ff-gb-header';
                header.textContent = `${expanded ? '▾' : '▸'} ${el.getAttribute('Header')
                    || collapse(propertyElement(el, 'Header')?.textContent) || 'Expander'}`;
                div.appendChild(header);
                if (expanded) {
                    const content = document.createElement('div');
                    content.className = 'ff-gb-content';
                    for (const c of elementChildren(el)) { content.appendChild(renderElement(c, 'cell')); }
                    div.appendChild(content);
                }
                break;
            }
            case 'GridSplitter':
                div.classList.add('ff-look-splitter');
                break;
            case 'Separator':
                div.classList.add('ff-look-separator');
                break;
            case 'TextBlock': {
                const inner = document.createElement('div');
                inner.className = 'ff-inner ff-look-text';
                inner.textContent = el.getAttribute('Text') ?? collapse(el.textContent);
                const wrapMode = styleProp(el, 'TextWrapping');
                if (wrapMode && wrapMode !== 'NoWrap') { inner.style.whiteSpace = 'normal'; }
                const ta = styleProp(el, 'TextAlignment');
                if (ta) { inner.style.textAlign = ta.toLowerCase(); }
                div.appendChild(inner);
                break;
            }
            default: {
                // Leaf control chrome; nested element content renders inside it.
                const inner = buildInner(type, el);
                const kids = elementChildren(el).filter(c => c.localName !== 'ListBoxItem');
                if (kids.length === 1) {
                    inner.textContent = '';
                    singleCell(inner);
                    inner.appendChild(renderElement(kids[0], 'cell'));
                } else if (kids.length > 1) {
                    // Unknown multi-child container (ItemsControl, custom
                    // panel, …): approximate as a vertical stack instead of
                    // piling every child into the same cell.
                    inner.textContent = '';
                    inner.style.display = 'flex';
                    inner.style.flexDirection = 'column';
                    inner.style.alignItems = 'stretch';
                    for (const c of kids) { inner.appendChild(renderElement(c, 'stack-v')); }
                }
                div.appendChild(inner);
            }
        }
    }

    /** Turn a container div into a single-cell CSS grid (stretchable child). */
    function singleCell(div) {
        div.style.display = 'grid';
        div.style.gridTemplateRows = 'minmax(0, 1fr)';
        div.style.gridTemplateColumns = 'minmax(0, 1fr)';
    }

    /** grid-template value for a Grid's Row/Column definitions. */
    function gridTracks(el, axis) {
        const defs = propertyElement(el, `${axis}Definitions`);
        if (!defs) { return 'minmax(0, 1fr)'; }
        const sizeAttr = axis === 'Row' ? 'Height' : 'Width';
        const out = [];
        for (const d of defs.children) {
            if (d.localName !== `${axis}Definition`) { continue; }
            out.push(trackSize(d.getAttribute(sizeAttr) || '*'));
        }
        return out.join(' ') || 'minmax(0, 1fr)';
    }

    function trackSize(v) {
        v = v.trim();
        if (/^auto$/i.test(v)) { return 'auto'; }
        const star = /^(\d*\.?\d*)\*$/.exec(v);
        if (star) { return `minmax(0, ${parseFloat(star[1] || '1') || 1}fr)`; }
        const n = parseFloat(v);
        return Number.isFinite(n) ? `${n}px` : 'auto';
    }

    /**
     * DockPanel approximation: each docked child slices off one side of the
     * remaining space via a nested flex container; the last child fills what
     * is left (unless LastChildFill="False").
     */
    function buildDock(div, el) {
        const kids = elementChildren(el);
        const lastFill = (el.getAttribute('LastChildFill') ?? 'True') !== 'False';
        let host = div;
        kids.forEach((child, i) => {
            const isLast = i === kids.length - 1;
            if (isLast && lastFill) {
                singleCell(host);
                host.appendChild(renderElement(child, 'cell'));
                return;
            }
            const dock = child.getAttribute('DockPanel.Dock') || 'Left';
            const vertical = dock === 'Top' || dock === 'Bottom';
            host.style.display = 'flex';
            host.style.flexDirection = (vertical ? 'column' : 'row') +
                (dock === 'Right' || dock === 'Bottom' ? '-reverse' : '');
            const v = renderElement(child, vertical ? 'stack-v' : 'stack-h');
            v.style.flex = '0 0 auto';
            const rest = document.createElement('div');
            rest.className = 'ff-dockrest';
            host.append(v, rest);
            host = rest;
        });
    }

    /** TabControl: clickable header strip + the active TabItem's content. */
    function buildTabControl(div, el) {
        div.classList.add('ff-look-tabs');
        div.style.display = 'flex';
        div.style.flexDirection = 'column';

        const items = elementChildren(el).filter(c => c.localName === 'TabItem');
        const key = pathOf(el);
        let active = uiTabs.get(key) ?? 0;
        if (active >= items.length) { active = 0; }

        const strip = document.createElement('div');
        strip.className = 'ff-tab-strip';
        items.forEach((ti, i) => {
            const head = document.createElement('div');
            head.className = 'ff-tab-head' + (i === active ? ' active' : '');
            head.textContent = ti.getAttribute('Header')
                || collapse(propertyElement(ti, 'Header')?.textContent) || `Tab ${i + 1}`;
            head.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
                uiTabs.set(key, i);
                selected = ti;
                multiSel.clear();
                multiSel.add(ti);
                selectedPath = pathOf(ti);
                render();
            });
            strip.appendChild(head);
        });

        const content = document.createElement('div');
        content.className = 'ff-tab-content';
        const activeItem = items[active];
        if (activeItem) {
            const cc = elementChildren(activeItem)[0];
            if (cc) { content.appendChild(renderElement(cc, 'cell')); }
            visuals.push({ el: activeItem, div: content });
        }
        div.append(strip, content);
    }

    /** Inner markup that mimics the WPF control's default look. */
    function buildInner(type, el) {
        const inner = document.createElement('div');
        inner.className = 'ff-inner';
        const content = el.getAttribute('Content') ?? collapse(el.textContent);
        const text = el.getAttribute('Text') ?? '';

        switch (type) {
            case 'Button':
                inner.classList.add('ff-look-button');
                inner.textContent = content || 'Button';
                break;
            case 'Label': {
                inner.classList.add('ff-look-label');
                inner.textContent = content || '';
                const pad = styleProp(el, 'Padding');
                const p = parseMargin(pad || '5');
                inner.style.padding = `${p.t}px ${p.r}px ${p.b}px ${p.l}px`;
                break;
            }
            case 'TextBox': {
                inner.classList.add('ff-look-input');
                // Multi-line-ish boxes read better top-left aligned.
                if (el.getAttribute('TextWrapping') || el.getAttribute('AcceptsReturn') === 'True'
                    || el.getAttribute('VerticalScrollBarVisibility')) {
                    inner.classList.add('ff-look-textarea');
                }
                inner.textContent = text;
                break;
            }
            case 'PasswordBox':
                inner.classList.add('ff-look-input');
                inner.textContent = '••••••';
                break;
            case 'CheckBox':
                inner.classList.add('ff-look-label');
                inner.innerHTML = `<span class="ff-glyph">${el.getAttribute('IsChecked') === 'True' ? '☑' : '☐'}</span>`;
                inner.append(content || 'CheckBox');
                break;
            case 'RadioButton':
                inner.classList.add('ff-look-label');
                inner.innerHTML = `<span class="ff-glyph">${el.getAttribute('IsChecked') === 'True' ? '◉' : '○'}</span>`;
                inner.append(content || 'RadioButton');
                break;
            case 'ComboBox':
                inner.classList.add('ff-look-input');
                inner.innerHTML = '<span class="ff-combo-arrow">▾</span>';
                break;
            case 'ListBox': {
                inner.classList.add('ff-look-list');
                // Show literal ListBoxItem children when present.
                const items = [...el.children].filter(c => c.localName === 'ListBoxItem');
                inner.innerHTML = items.length
                    ? items.map(i => `<div class="ff-list-item">${escapeHtml(i.textContent || i.getAttribute('Content') || '')}</div>`).join('')
                    : '';
                break;
            }
            case 'DataGrid':
                inner.classList.add('ff-look-list');
                inner.innerHTML = '<div class="ff-grid-header"><span>Col1</span><span>Col2</span><span>Col3</span></div>';
                break;
            case 'Image': {
                inner.classList.add('ff-look-image');
                const uri = xamlImageUri(el.getAttribute('Source'));
                if (uri) {
                    const img = document.createElement('img');
                    img.src = uri;
                    img.draggable = false;
                    img.style.width = '100%';
                    img.style.height = '100%';
                    const st = el.getAttribute('Stretch') || 'Uniform';
                    img.style.objectFit =
                        st === 'Fill' ? 'fill'
                        : st === 'UniformToFill' ? 'cover'
                        : st === 'None' ? 'none' : 'contain';
                    inner.textContent = '';
                    inner.appendChild(img);
                } else {
                    inner.textContent = '🖼';
                }
                break;
            }
            case 'ProgressBar': {
                inner.classList.add('ff-look-progress');
                const pct = progressPct(el);
                inner.innerHTML = `<div class="ff-progress-fill" style="width:${pct}%"></div>`;
                break;
            }
            case 'Slider': {
                const pct = progressPct(el);
                inner.classList.add('ff-look-slider');
                inner.innerHTML = `<div class="ff-slider-track"></div><div class="ff-slider-thumb" style="left:${pct}%"></div>`;
                break;
            }
            case 'DatePicker':
                inner.classList.add('ff-look-input');
                inner.innerHTML = 'Select a date <span class="ff-combo-arrow">📅</span>';
                break;
            case 'Calendar':
                inner.classList.add('ff-look-list', 'ff-look-calendar');
                inner.innerHTML = '<div class="ff-cal-head">◀ Month ▶</div>' +
                    '<div class="ff-cal-grid">' + 'SMTWTFS'.split('').map(d => `<span>${d}</span>`).join('') + '</div>';
                break;
            case 'ListView':
                inner.classList.add('ff-look-list');
                inner.innerHTML = '<div class="ff-grid-header"><span>Name</span><span>Value</span></div>';
                break;
            case 'TreeView':
                inner.classList.add('ff-look-list');
                break;
            case 'RichTextBox':
                inner.classList.add('ff-look-input', 'ff-look-textarea');
                break;
            default:
                // Unknown control: neutral placeholder box labelled with its type.
                inner.classList.add('ff-look-unknown');
                inner.textContent = type;
        }

        // Style-aware chrome: implicit/keyed styles (App.xaml included)
        // restyle the default look so themed apps preview like they run.
        const sBg = resolveBrush(styleProp(el, 'Background'));
        if (sBg) { inner.style.background = sBg; }
        const sFg = resolveBrush(styleProp(el, 'Foreground'));
        if (sFg) { inner.style.color = sFg; }
        const sBb = resolveBrush(styleProp(el, 'BorderBrush'));
        if (sBb) { inner.style.borderColor = sBb; inner.style.borderStyle = 'solid'; }
        const sBt = styleProp(el, 'BorderThickness');
        if (sBt && !String(sBt).includes('{')) {
            const t = parseMargin(sBt);
            inner.style.borderStyle = 'solid';
            inner.style.borderWidth = `${t.t}px ${t.r}px ${t.b}px ${t.l}px`;
        }
        const sCr = styleProp(el, 'CornerRadius'); // real or template-derived
        if (sCr && !String(sCr).includes('{')) {
            inner.style.borderRadius = `${parseFloat(sCr) || 0}px`;
        }
        const sPad = styleProp(el, 'Padding');
        if (sPad && !String(sPad).includes('{') && type !== 'Label') {
            const p = parseMargin(sPad);
            inner.style.padding = `${p.t}px ${p.r}px ${p.b}px ${p.l}px`;
        }
        const hca = styleProp(el, 'HorizontalContentAlignment');
        if (hca) {
            inner.style.justifyContent =
                hca === 'Left' ? 'flex-start' : hca === 'Right' ? 'flex-end' : 'center';
        }
        return inner;
    }

    /** True when a CSS color is dark (drives adaptive designer chrome). */
    function isDarkColor(css) {
        const hex = cssColorToHex(css || '#ffffff');
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
    }

    /** WPF font weight names -> CSS numeric weights. */
    function cssFontWeight(w) {
        const map = {
            thin: 100, extralight: 200, ultralight: 200, light: 300,
            normal: 400, regular: 400, medium: 500,
            semibold: 600, demibold: 600, bold: 700,
            extrabold: 800, ultrabold: 800, black: 900, heavy: 900
        };
        return map[String(w).toLowerCase()] ?? w;
    }

    function applyBorder(target, el) {
        const brush = resolveBrush(styleProp(el, 'BorderBrush')) || '#808080';
        // WPF's default BorderThickness is 0 — a <Border> with only a
        // Background/CornerRadius draws no outline at runtime.
        const t = parseMargin(styleProp(el, 'BorderThickness') || '0');
        target.style.borderStyle = 'solid';
        target.style.borderColor = brush;
        target.style.borderWidth = `${t.t}px ${t.r}px ${t.b}px ${t.l}px`;
        const radius = (styleProp(el, 'CornerRadius') || '0').split(',')[0];
        target.style.borderRadius = `${radius}px`;
        const pad = styleProp(el, 'Padding');
        if (pad) {
            const p = parseMargin(pad);
            target.style.padding = `${p.t}px ${p.r}px ${p.b}px ${p.l}px`;
        }
    }

    function progressPct(el) {
        const min = num(el.getAttribute('Minimum'), 0);
        const max = num(el.getAttribute('Maximum'), 100);
        const val = num(el.getAttribute('Value'), 0);
        return max > min ? Math.min(100, Math.max(0, ((val - min) / (max - min)) * 100)) : 0;
    }

    // ------------------------------------------------------------- selection
    // `selected` is the primary selection (drives the property panel and is
    // the anchor for alignment); `multiSel` holds every selected control —
    // including the primary — when anything is selected at all.

    const multiSel = new Set();

    function select(el, additive = false) {
        if (additive && el) {
            if (multiSel.has(el) && multiSel.size > 1) {
                multiSel.delete(el);
                if (selected === el) { selected = [...multiSel][multiSel.size - 1]; }
            } else {
                multiSel.add(el);
                selected = el;
            }
        } else {
            multiSel.clear();
            if (el) { multiSel.add(el); }
            selected = el;
        }
        selectedPath = (selected && !selected.__wf) ? pathOf(selected) : '';
        drawSelection();
        renderPanel();
    }

    /** Position/size of a rendered div relative to the design surface. */
    function rectOf(div) {
        const s = surfaceEl.getBoundingClientRect();
        const r = div.getBoundingClientRect();
        return {
            x: (r.left - s.left) / zoom,
            y: (r.top - s.top) / zoom,
            w: r.width / zoom,
            h: r.height / zoom
        };
    }

    /**
     * How the selected element may be dragged, if at all:
     *   'canvas'  parent is a Canvas — writes Canvas.Left/Top
     *   'margin'  parent is a Grid and the element is already absolutely
     *             placed VS-style (Left/Top alignment) — writes Margin
     *   null      layout is owned by the parent panel (StackPanel, cell, ...)
     */
    function movability(el) {
        if (el.__wf) { return el === wfForm ? null : 'wf'; } // WinForms: absolute by design
        const p = el.parentNode;
        if (!p || p.nodeType !== Node.ELEMENT_NODE) { return null; }
        if (p.localName === 'Canvas') { return 'canvas'; }
        if (p.localName === 'Grid'
            && el.getAttribute('HorizontalAlignment') === 'Left'
            && el.getAttribute('VerticalAlignment') === 'Top') { return 'margin'; }
        return null;
    }

    function drawSelection() {
        // Remove previous overlays.
        surfaceEl.querySelectorAll('.ff-selection').forEach(n => n.remove());
        updateAlignTools();
        // Highlight the selected component-tray chip, if any.
        document.querySelectorAll('.ff-tray-chip').forEach(chip => {
            chip.classList.toggle('active', selected?.__wf && chip.dataset.name === selected.name);
        });

        // Secondary selections: thin outline, no handles.
        for (const el of multiSel) {
            if (el === selected) { continue; }
            const h = visuals.find(v => v.el === el);
            if (!h) { continue; }
            const b = rectOf(h.div);
            const o = document.createElement('div');
            o.className = 'ff-selection ff-sel-secondary';
            o.style.left = `${b.x - 1}px`;
            o.style.top = `${b.y - 1}px`;
            o.style.width = `${b.w}px`;
            o.style.height = `${b.h}px`;
            surfaceEl.appendChild(o);
        }

        const hit = visuals.find(v => v.el === selected);
        if (!hit) {
            if (selected?.__wf && selected !== wfForm) {
                setStatus(`${selected.name} : ${selected.type} — non-visual component`);
            } else {
                setStatus(windowEl ? `${windowEl.localName} — click a control to select it` : 'Ready');
            }
            return;
        }

        const box = rectOf(hit.div);
        const sel = document.createElement('div');
        sel.className = 'ff-selection';
        sel.style.left = `${box.x - 1}px`;
        sel.style.top = `${box.y - 1}px`;
        sel.style.width = `${box.w}px`;
        sel.style.height = `${box.h}px`;

        // Name tag above the control.
        const tag = document.createElement('span');
        tag.className = 'ff-selection-tag';
        tag.textContent = getName(selected) || wfType(selected);
        sel.appendChild(tag);

        // Eight resize handles, named by compass direction.
        for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
            const h = document.createElement('div');
            h.className = `ff-handle ff-h-${dir}`;
            h.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
                startResize(e, selected, dir);
            });
            sel.appendChild(h);
        }
        surfaceEl.appendChild(sel);

        const mode = movability(selected);
        const owner = selected.__wf ? 'the form' : (selected.parentNode?.localName ?? 'parent');
        const place = mode ? `at (${Math.round(box.x)}, ${Math.round(box.y)})`
            : `— layout managed by ${owner}`;
        const extra = multiSel.size > 1 ? ` (+${multiSel.size - 1} selected)` : '';
        setStatus(`${getName(selected) || wfType(selected)} — ${Math.round(box.w)}×${Math.round(box.h)} ${place}${extra}`);
    }

    /** Show the alignment toolbar only for a WinForms multi-selection. */
    function updateAlignTools() {
        const tools = $('ff-align-tools');
        if (!tools) { return; }
        const usable = docMode === 'winforms'
            && [...multiSel].filter(c => c.__wf && c !== wfForm).length >= 2;
        tools.hidden = !usable;
    }

    // Clicking empty canvas selects the window itself.
    surfaceEl.addEventListener('mousedown', () => {
        select(null);
    });

    // Keep the overlay glued to the control when an inner ScrollViewer scrolls.
    surfaceEl.addEventListener('scroll', () => drawSelection(), true);

    // ------------------------------------------------------------ move/resize

    function startMove(e, el, div, group = false) {
        const mode = movability(el);
        if (!mode) { return; } // selection only — parent panel owns the position

        // Group move: every selected sibling with a Location follows the drag
        // (WinForms only — panel-managed XAML children cannot move together).
        const groupItems = (group && mode === 'wf')
            ? [...multiSel]
                .filter(c => c.__wf && c !== wfForm && wfPoint(c.props.Location))
                .map(c => ({
                    el: c,
                    div: visuals.find(v => v.el === c)?.div,
                    start: wfPoint(c.props.Location)
                }))
                .filter(it => it.div)
            : null;

        const m0 = mode === 'margin' ? parseMargin(el.getAttribute('Margin')) : { l: 0, t: 0, r: 0, b: 0 };
        const start =
            mode === 'wf' ? (wfPoint(el.props.Location) ?? { x: 0, y: 0 })
            : mode === 'canvas' ? { x: num(el.getAttribute('Canvas.Left'), 0), y: num(el.getAttribute('Canvas.Top'), 0) }
            : { x: m0.l, y: m0.t };
        const sx = e.clientX, sy = e.clientY;
        let moved = false;

        const apply = (nx, ny) => {
            if (mode === 'margin') {
                div.style.margin = `${ny}px ${m0.r}px ${m0.b}px ${nx}px`;
            } else {
                div.style.left = `${nx}px`;
                div.style.top = `${ny}px`;
            }
        };

        const onMove = ev => {
            const dx = (ev.clientX - sx) / zoom;
            const dy = (ev.clientY - sy) / zoom;
            if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) { return; }
            moved = true;
            if (groupItems) {
                for (const it of groupItems) {
                    it.div.style.left = `${snap(Math.max(0, it.start.x + dx))}px`;
                    it.div.style.top = `${snap(Math.max(0, it.start.y + dy))}px`;
                }
                drawSelection();
                setStatus(`${groupItems.length} controls — moving`);
                return;
            }
            const nx = snap(Math.max(0, start.x + dx));
            const ny = snap(Math.max(0, start.y + dy));
            apply(nx, ny);
            drawSelectionAround(div);
            setStatus(`${getName(el) || wfType(el)} — (${nx}, ${ny})`);
        };
        const onUp = ev => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (!moved) {
                // A plain click on a member of a multi-selection collapses it.
                if (group) { select(el); }
                return;
            }
            const dx = (ev.clientX - sx) / zoom;
            const dy = (ev.clientY - sy) / zoom;
            if (groupItems) {
                let text = xamlText;
                for (const it of groupItems) {
                    const nx = snap(Math.max(0, it.start.x + dx));
                    const ny = snap(Math.max(0, it.start.y + dy));
                    text = wfSetLine(it.el.name, 'Location', `new System.Drawing.Point(${nx}, ${ny})`, text);
                }
                wfApply(text);
                return;
            }
            const nx = snap(Math.max(0, start.x + dx));
            const ny = snap(Math.max(0, start.y + dy));
            if (mode === 'wf') {
                wfApply(wfSetLine(el.name, 'Location', `new System.Drawing.Point(${nx}, ${ny})`));
            } else if (mode === 'canvas') {
                el.setAttribute('Canvas.Left', String(nx));
                el.setAttribute('Canvas.Top', String(ny));
                commit();
            } else {
                el.setAttribute('Margin', `${nx},${ny},${m0.r},${m0.b}`);
                commit();
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    function startResize(e, el, dir) {
        const hit = visuals.find(v => v.el === el);
        if (!hit) { return; }
        const start = rectOf(hit.div);
        const mode = movability(el);
        const m0 = mode === 'margin' ? parseMargin(el.getAttribute('Margin')) : { l: 0, t: 0, r: 0, b: 0 };
        const pos0 =
            mode === 'wf' ? (wfPoint(el.props.Location) ?? { x: 0, y: 0 })
            : mode === 'canvas' ? { x: num(el.getAttribute('Canvas.Left'), 0), y: num(el.getAttribute('Canvas.Top'), 0) }
            : { x: m0.l, y: m0.t };
        const sx = e.clientX, sy = e.clientY;

        const compute = ev => {
            const dx = (ev.clientX - sx) / zoom;
            const dy = (ev.clientY - sy) / zoom;
            let w = start.w, h = start.h, px = pos0.x, py = pos0.y;
            if (dir.includes('e')) { w = Math.max(10, start.w + dx); }
            if (dir.includes('s')) { h = Math.max(10, start.h + dy); }
            if (dir.includes('w')) { w = Math.max(10, start.w - dx); if (mode) { px = pos0.x + start.w - w; } }
            if (dir.includes('n')) { h = Math.max(10, start.h - dy); if (mode) { py = pos0.y + start.h - h; } }
            return {
                w: snap(w), h: snap(h),
                px: snap(Math.max(0, px)), py: snap(Math.max(0, py))
            };
        };

        const onMove = ev => {
            const b = compute(ev);
            hit.div.style.width = `${b.w}px`;
            hit.div.style.height = `${b.h}px`;
            if (mode === 'canvas' || mode === 'wf') {
                hit.div.style.left = `${b.px}px`;
                hit.div.style.top = `${b.py}px`;
            } else if (mode === 'margin') {
                hit.div.style.margin = `${b.py}px ${m0.r}px ${m0.b}px ${b.px}px`;
            }
            drawSelectionAround(hit.div);
            setStatus(`${getName(el) || wfType(el)} — ${b.w}×${b.h}`);
        };
        const onUp = ev => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const b = compute(ev);
            if (mode === 'wf') {
                let t = wfSetLine(el.name, 'Size', `new System.Drawing.Size(${b.w}, ${b.h})`);
                t = wfSetLine(el.name, 'Location', `new System.Drawing.Point(${b.px}, ${b.py})`, t);
                wfApply(t);
                return;
            }
            el.setAttribute('Width', String(b.w));
            el.setAttribute('Height', String(b.h));
            if (mode === 'canvas') {
                el.setAttribute('Canvas.Left', String(b.px));
                el.setAttribute('Canvas.Top', String(b.py));
            } else if (mode === 'margin') {
                el.setAttribute('Margin', `${b.px},${b.py},${m0.r},${m0.b}`);
            }
            commit();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    /** Live-update the overlay during a drag without a full re-render. */
    function drawSelectionAround(div) {
        const sel = surfaceEl.querySelector('.ff-selection');
        if (!sel) { return; }
        const b = rectOf(div);
        sel.style.left = `${b.x - 1}px`;
        sel.style.top = `${b.y - 1}px`;
        sel.style.width = `${b.w}px`;
        sel.style.height = `${b.h}px`;
    }

    // -------------------------------------------------------------- tab order
    // VS's View → Tab Order: badges show each control's TabIndex; clicking
    // controls in sequence assigns 0, 1, 2, ... Esc or the button exits.

    let tabOrderMode = false;
    let tabOrderNext = 0;

    function toggleTabOrder(on) {
        tabOrderMode = on ?? !tabOrderMode;
        tabOrderNext = 0;
        const btn = $('ff-btn-taborder');
        if (btn) { btn.classList.toggle('active', tabOrderMode); }
        if (docMode === 'winforms') { wfRender(); }
        setStatus(tabOrderMode
            ? 'Tab order: click controls in the order the Tab key should visit them (Esc to finish).'
            : 'Ready');
    }

    function wfAssignTabIndex(ctrl) {
        if (!ctrl.__wf || ctrl === wfForm) { return; }
        wfApply(wfSetLine(ctrl.name, 'TabIndex', String(tabOrderNext++)));
    }

    /** TabIndex badges over every control while tab-order mode is active. */
    function drawTabOrderBadges() {
        if (!tabOrderMode) { return; }
        for (const v of visuals) {
            if (!v.el.__wf || v.el === wfForm || !v.el.name) { continue; }
            const b = rectOf(v.div);
            const badge = document.createElement('div');
            badge.className = 'ff-tab-badge';
            badge.textContent = (/^\d+$/.exec((v.el.props.TabIndex ?? '').trim())?.[0]) ?? '–';
            badge.style.left = `${b.x}px`;
            badge.style.top = `${b.y}px`;
            surfaceEl.appendChild(badge);
        }
    }

    // -------------------------------------------------------------- alignment
    // VS Format-menu style tools for a multi-selection (WinForms absolute
    // layout). The primary selection is the anchor everything aligns to.

    function wfAlign(op) {
        const items = [...multiSel].filter(c => c.__wf && c !== wfForm && wfPoint(c.props.Location));
        if (items.length < 2 || !selected?.__wf || selected === wfForm) { return; }
        const ap = wfPoint(selected.props.Location) ?? { x: 0, y: 0 };
        const asz = wfSizeVal(selected.props.Size) ?? { w: 75, h: 23 };
        let text = xamlText;

        const setLoc = (c, x, y) => {
            text = wfSetLine(c.name, 'Location', `new System.Drawing.Point(${Math.max(0, Math.round(x))}, ${Math.max(0, Math.round(y))})`, text);
        };
        const setSize = (c, w, h) => {
            text = wfSetLine(c.name, 'Size', `new System.Drawing.Size(${Math.max(1, Math.round(w))}, ${Math.max(1, Math.round(h))})`, text);
        };

        if (op === 'dist-h' || op === 'dist-v') {
            // Keep the outermost two in place; spread the rest evenly between.
            const key = op === 'dist-h' ? 'x' : 'y';
            const sorted = [...items].sort((a, b) => wfPoint(a.props.Location)[key] - wfPoint(b.props.Location)[key]);
            const first = wfPoint(sorted[0].props.Location)[key];
            const last = wfPoint(sorted[sorted.length - 1].props.Location)[key];
            const step = (last - first) / (sorted.length - 1);
            sorted.forEach((c, i) => {
                const p = wfPoint(c.props.Location);
                if (op === 'dist-h') { setLoc(c, first + step * i, p.y); }
                else { setLoc(c, p.x, first + step * i); }
            });
        } else {
            for (const c of items) {
                if (c === selected) { continue; }
                const p = wfPoint(c.props.Location) ?? { x: 0, y: 0 };
                const s = wfSizeVal(c.props.Size) ?? { w: 75, h: 23 };
                switch (op) {
                    case 'left':   setLoc(c, ap.x, p.y); break;
                    case 'right':  setLoc(c, ap.x + asz.w - s.w, p.y); break;
                    case 'top':    setLoc(c, p.x, ap.y); break;
                    case 'bottom': setLoc(c, p.x, ap.y + asz.h - s.h); break;
                    case 'same-w': setSize(c, asz.w, s.h); break;
                    case 'same-h': setSize(c, s.w, asz.h); break;
                    case 'same-size': setSize(c, asz.w, asz.h); break;
                }
            }
        }
        wfApply(text);
    }

    // ------------------------------------------------------------ form resize
    // Grips on the mock window's right/bottom edges, like resizing the form in
    // the Visual Studio designer. WinForms writes ClientSize; XAML writes the
    // Window's Width/Height attributes.

    function initFormGrips() {
        for (const dir of ['e', 's', 'se']) {
            const g = document.createElement('div');
            g.className = `ff-formgrip ff-fg-${dir}`;
            g.title = 'Resize the form';
            g.addEventListener('mousedown', e => startFormResize(e, dir));
            windowBox.appendChild(g);
        }
    }

    function startFormResize(e, dir) {
        if (e.button !== 0) { return; }
        const isWf = docMode === 'winforms';
        if (isWf ? !wfForm : !windowEl) { return; }
        e.preventDefault();
        e.stopPropagation();

        const r = surfaceEl.getBoundingClientRect();
        const start = { w: r.width / zoom, h: r.height / zoom };
        const sx = e.clientX, sy = e.clientY;

        const compute = ev => ({
            w: dir.includes('e') ? Math.max(120, snap(start.w + (ev.clientX - sx) / zoom)) : Math.round(start.w),
            h: dir.includes('s') ? Math.max(60, snap(start.h + (ev.clientY - sy) / zoom)) : Math.round(start.h)
        });

        const onMove = ev => {
            const b = compute(ev);
            windowBox.style.width = `${b.w}px`;
            surfaceEl.style.height = `${b.h}px`;
            drawSelection();
            setStatus(`${isWf ? wfForm.name : 'Window'} — ${b.w} × ${b.h}`);
        };
        const onUp = ev => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const b = compute(ev);
            if (isWf) {
                wfApply(wfSetFormLine('ClientSize', `new System.Drawing.Size(${b.w}, ${b.h})`));
            } else {
                windowEl.setAttribute('Width', String(b.w));
                windowEl.setAttribute('Height', String(b.h + 32)); // + mock title bar
                commit();
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    function parseMargin(str) {
        if (!str) { return { l: 0, t: 0, r: 0, b: 0 }; }
        const parts = str.split(',').map(s => parseFloat(s.trim()) || 0);
        if (parts.length === 1) { return { l: parts[0], t: parts[0], r: parts[0], b: parts[0] }; }
        if (parts.length === 2) { return { l: parts[0], t: parts[1], r: parts[0], b: parts[1] }; }
        return { l: parts[0] ?? 0, t: parts[1] ?? 0, r: parts[2] ?? 0, b: parts[3] ?? 0 };
    }

    function snap(v) {
        return config.snap ? Math.round(v / config.gridSize) * config.gridSize : Math.round(v);
    }

    // ================================================================= toolbox

    function buildToolbox() {
        const host = $('ff-toolbox-items');
        if (!host) { return; }
        host.innerHTML = '';

        // Search box: filters tools live; section headers hide when empty.
        let search = $('ff-tool-search');
        if (!search) {
            search = document.createElement('input');
            search.id = 'ff-tool-search';
            search.type = 'text';
            search.placeholder = '🔍 Search Toolbox';
            search.setAttribute('aria-label', 'Search toolbox');
            search.spellcheck = false;
            search.addEventListener('input', () => filterToolbox(search.value));
            search.addEventListener('keydown', e => e.stopPropagation());
            host.parentNode.insertBefore(search, host);
        }
        search.value = '';

        const addTool = (type, def) => {
            const item = document.createElement('div');
            item.className = 'ff-tool';
            item.draggable = true;
            item.tabIndex = 0;
            item.setAttribute('role', 'button');
            item.dataset.type = type;
            item.title = `Drag onto the form, or double-click to add ${type}`;
            item.innerHTML = `<span class="ff-tool-icon">${def.icon}</span>${type}`;
            item.addEventListener('dragstart', e => {
                e.dataTransfer.setData('text/uimaker-control', type);
                e.dataTransfer.effectAllowed = 'copy';
            });
            // Double-click adds the control at a default spot, like VS.
            item.addEventListener('dblclick', () => addControlDefault(type));
            item.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    addControlDefault(type);
                }
            });
            host.appendChild(item);
        };
        const addSection = label => {
            const head = document.createElement('div');
            head.className = 'ff-tool-section';
            head.textContent = label;
            host.appendChild(head);
        };

        if (docMode === 'winforms') {
            // VS-style sections, in a fixed order across both catalogs.
            const sections = ['Common Controls', 'Containers', 'Menus & Toolbars', 'Data',
                'Components', 'Dialogs', 'Printing'];
            const all = [...Object.entries(WF_CONTROLS), ...Object.entries(WF_TRAY)];
            for (const sec of sections) {
                const tools = all.filter(([, def]) => (def.sec ?? 'Common Controls') === sec);
                if (!tools.length) { continue; }
                addSection(sec);
                for (const [type, def] of tools) { addTool(type, def); }
            }
        } else {
            for (const [type, def] of Object.entries(CONTROLS)) { addTool(type, def); }
        }
    }

    /** Hide tools that do not match the query; hide headers with no matches. */
    function filterToolbox(query) {
        const q = query.trim().toLowerCase();
        const host = $('ff-toolbox-items');
        let section = null;
        let sectionHasHit = false;
        for (const node of host.children) {
            if (node.classList.contains('ff-tool-section')) {
                if (section) { section.hidden = !sectionHasHit; }
                section = node;
                sectionHasHit = false;
                continue;
            }
            const hit = !q || (node.dataset.type ?? '').toLowerCase().includes(q);
            node.hidden = !hit;
            if (hit) { sectionHasHit = true; }
        }
        if (section) { section.hidden = !sectionHasHit; }
    }

    /** Toolbox double-click: add the control near the top-left, like VS. */
    function addControlDefault(type) {
        if (docMode === 'winforms') {
            if (!wfForm) { return; }
            if (WF_TRAY[type]) { wfAddComponent(type); return; }
            if (type === 'MenuStrip' || type === 'ToolStrip' || type === 'StatusStrip') { wfAddStrip(type); return; }
            if (type === 'TabControl') { wfInsertTabControl(snap(20), snap(20)); return; }
            // Cascade a little so repeated double-clicks do not stack exactly.
            const off = snap(12 + (wfControls.size % 8) * config.gridSize);
            wfAddControl(type, off, off, null);
            return;
        }
        // XAML: synthesize a drop into the layout root at a default margin.
        if (!xamlDoc || !windowEl || !CONTROLS[type]) { return; }
        if (!ensureLayoutRoot()) { return; }
        const def = CONTROLS[type];
        const el = xamlDoc.createElementNS(PRES_NS, type);
        setName(el, uniqueName(type));
        for (const [k, v] of Object.entries(def.attrs)) { el.setAttribute(k, v); }
        el.setAttribute('Width', String(def.w));
        el.setAttribute('Height', String(def.h));
        if (layoutRoot.localName === 'Canvas') {
            el.setAttribute('Canvas.Left', '20');
            el.setAttribute('Canvas.Top', '20');
        } else if (layoutRoot.localName === 'Grid') {
            el.setAttribute('HorizontalAlignment', 'Left');
            el.setAttribute('VerticalAlignment', 'Top');
            el.setAttribute('Margin', '20,20,0,0');
        }
        layoutRoot.appendChild(el);
        selected = el;
        multiSel.clear();
        multiSel.add(el);
        commit();
        selectedPath = pathOf(el);
    }

    surfaceEl.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('text/uimaker-control')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });

    surfaceEl.addEventListener('drop', e => {
        const type = e.dataTransfer.getData('text/uimaker-control');
        if (!type) { return; }
        if (docMode === 'winforms') {
            e.preventDefault();
            wfDrop(e, type);
            return;
        }
        if (!xamlDoc || !windowEl) { return; }
        e.preventDefault();

        // Drop into the deepest panel under the cursor; fall back to the root.
        let target = null;
        let node = document.elementFromPoint(e.clientX, e.clientY);
        while (node && node !== surfaceEl) {
            const hit = visuals.find(v => v.div === node);
            if (hit && DROP_PANELS.includes(hit.el.localName)) { target = hit; break; }
            node = node.parentElement;
        }
        if (!target) {
            if (!ensureLayoutRoot()) { return; }
            const rootHit = visuals.find(v => v.el === layoutRoot);
            target = rootHit ?? { el: layoutRoot, div: surfaceEl };
        }

        const def = CONTROLS[type];
        if (!def) { return; } // stale drag payload from another mode
        const el = xamlDoc.createElementNS(PRES_NS, type);
        setName(el, uniqueName(type));
        for (const [k, v] of Object.entries(def.attrs)) {
            el.setAttribute(k, v);
        }
        el.setAttribute('Width', String(def.w));
        el.setAttribute('Height', String(def.h));

        const panel = target.el.localName;
        if (panel === 'Grid' || panel === 'Canvas') {
            const box = target.div === surfaceEl
                ? { x: 0, y: 0 }
                : rectOf(target.div);
            const sRect = surfaceEl.getBoundingClientRect();
            const x = snap(Math.max(0, (e.clientX - sRect.left) / zoom - box.x - def.w / 2));
            const y = snap(Math.max(0, (e.clientY - sRect.top) / zoom - box.y - def.h / 2));
            if (panel === 'Canvas') {
                el.setAttribute('Canvas.Left', String(x));
                el.setAttribute('Canvas.Top', String(y));
            } else {
                el.setAttribute('HorizontalAlignment', 'Left');
                el.setAttribute('VerticalAlignment', 'Top');
                el.setAttribute('Margin', `${x},${y},0,0`);
            }
        }
        // Stack/Wrap/Dock panels position their own children — just append.
        target.el.appendChild(el);

        selected = el;
        multiSel.clear();
        multiSel.add(el);
        selectedPath = null;
        commit();
        selectedPath = pathOf(selected);
    });

    /** Create a root Grid on demand so dropping onto an empty Window works. */
    function ensureLayoutRoot() {
        if (layoutRoot) { return true; }
        if (!windowEl || windowEl.localName === 'Application') { return false; }
        if (contentRoot) {
            setStatus(`Cannot drop here — the window content is a ${contentRoot.localName}.`);
            return false;
        }
        layoutRoot = xamlDoc.createElementNS(PRES_NS, 'Grid');
        windowEl.appendChild(layoutRoot);
        contentRoot = layoutRoot;
        return true;
    }

    // ============================================================ name helpers

    function getName(el) {
        if (el.__wf) { return el === wfForm ? '' : el.name; }
        return el.getAttributeNS(X_NS, 'Name') || el.getAttribute('Name') || '';
    }

    /** Type label that works for XML elements and WinForms records alike. */
    function wfType(el) {
        return el.__wf ? el.type : el.localName;
    }

    function setName(el, name) {
        if (name) {
            el.setAttributeNS(X_NS, 'x:Name', name);
        } else {
            el.removeAttributeNS(X_NS, 'Name');
            el.removeAttribute('Name');
        }
    }

    /** Next free "<Type><n>" name across the whole document. */
    function uniqueName(type) {
        const taken = new Set();
        for (const el of xamlDoc.getElementsByTagName('*')) {
            const n = getName(el);
            if (n) { taken.add(n); }
        }
        for (let i = 1; ; i++) {
            const candidate = `${type}${i}`;
            if (!taken.has(candidate)) { return candidate; }
        }
    }

    // ========================================================== property panel

    // ------------------------------------------------------ VS-style prop grid
    // Shared by the XAML and WinForms panels: rows are grouped under
    // collapsible category headers (or flat A-Z), values set explicitly in the
    // document render bold, and the pane at the bottom describes the property
    // under the cursor — mirroring the Visual Studio Properties window.

    let propSort = 'cat';              // 'cat' (categorized) | 'az' (alphabetical)
    const collapsedCats = new Set();   // category names the user collapsed
    const propDescEl = $('ff-prop-desc');

    /** Append rows [{label, cat, node}] grouped/sorted per the active mode. */
    function renderGrid(rows) {
        const frag = document.createDocumentFragment();
        if (propSort === 'az') {
            rows.sort((a, b) => a.label.localeCompare(b.label));
            for (const r of rows) { frag.appendChild(r.node); }
        } else {
            const cats = new Map();
            for (const r of rows) {
                const c = r.cat || 'Misc';
                if (!cats.has(c)) { cats.set(c, []); }
                cats.get(c).push(r);
            }
            for (const cat of [...cats.keys()].sort()) {
                const collapsed = collapsedCats.has(cat);
                const head = document.createElement('div');
                head.className = 'ff-cat-header';
                head.innerHTML = `<span class="ff-cat-arrow">${collapsed ? '▸' : '▾'}</span>${escapeHtml(cat)}`;
                head.addEventListener('mousedown', e => e.preventDefault());
                head.addEventListener('click', () => {
                    if (collapsed) { collapsedCats.delete(cat); } else { collapsedCats.add(cat); }
                    renderPanel();
                });
                frag.appendChild(head);
                if (collapsed) { continue; }
                for (const r of cats.get(cat).sort((a, b) => a.label.localeCompare(b.label))) {
                    frag.appendChild(r.node);
                }
            }
        }
        propsBody.appendChild(frag);
    }

    /** Update the description pane when a row is focused or clicked. */
    function attachDesc(row, name, desc) {
        const show = () => showPropDesc(name, desc);
        row.addEventListener('focusin', show);
        row.addEventListener('mousedown', show);
    }

    function showPropDesc(name, desc) {
        if (!propDescEl) { return; }
        propDescEl.innerHTML = `<b>${escapeHtml(name)}</b>${escapeHtml(desc || '')}`;
    }

    /** Get-or-create a shared <datalist>, returns its id. */
    function ensureDatalist(id, values) {
        if (!document.getElementById(id)) {
            const dl = document.createElement('datalist');
            dl.id = id;
            dl.append(...values.map(v => {
                const opt = document.createElement('option');
                opt.value = v;
                return opt;
            }));
            document.body.appendChild(dl);
        }
        return id;
    }

    function renderPanel() {
        propsBody.innerHTML = '';
        if (propDescEl) { propDescEl.innerHTML = ''; }

        if (docMode === 'winforms') { wfRenderPanel(); return; }

        const el = selected;
        const isWindow = !el;
        const type = isWindow ? (windowEl?.localName ?? 'Window') : el.localName;
        propsTarget.textContent = isWindow
            ? `${type} (${config.docName})`
            : `${getName(el) || '(unnamed)'} : ${type}`;

        if (!windowEl) { return; }

        if (activeTab === 'props') {
            renderPropsTab(isWindow ? windowEl : el, isWindow);
        } else {
            renderEventsTab(isWindow ? windowEl : el, isWindow);
        }
    }

    function renderPropsTab(el, isWindow) {
        const rows = [];
        if (!isWindow) {
            // Name is special: stored as x:Name.
            const nameRow = propRow('Name', getName(el), v => {
                const name = v.trim();
                if (name && !validateCSharpIdentifier(name, 'control name')) {
                    renderPanel();
                    return;
                }
                setName(el, name);
                commit();
            });
            if (getName(el)) { nameRow.classList.add('ff-set'); }
            attachDesc(nameRow, 'Name', XAML_DESCS.Name);
            rows.push({ label: 'Name', cat: 'Design', node: nameRow });
        }
        const names = isWindow
            ? WINDOW_PROPS
            : [...(CONTROLS[el.localName]?.props ?? PANEL_PROPS[el.localName] ?? []), ...COMMON_PROPS];

        for (const prop of names) {
            const node = xamlPropRow(el, prop);
            if (el.getAttribute(prop) !== null || propertyElement(el, prop)) { node.classList.add('ff-set'); }
            attachDesc(node, prop, XAML_DESCS[prop] ?? '');
            rows.push({ label: prop, cat: XAML_CATS[prop] ?? 'Common', node });
        }
        renderGrid(rows);
    }

    /**
     * Kind-aware XAML property row: brushes get a color swatch + picker (and
     * Background an image button), enums/booleans a dropdown, fonts curated
     * suggestion lists, Image.Source a file picker — everything else stays a
     * free text row so bindings and resources can always be typed.
     */
    function xamlPropRow(el, prop) {
        const write = v => {
            removePropertyElement(el, prop); // an attribute replaces any expanded form
            if (v === '') { el.removeAttribute(prop); } else { el.setAttribute(prop, v); }
            commit();
        };
        if (XAML_BRUSH_PROPS.has(prop)) { return xamlBrushRow(el, prop, write); }
        if (ENUM_VALUES[prop]) { return xamlEnumRow(el, prop, write); }
        if (prop === 'Source' && el.localName === 'Image') { return xamlImagePathRow(el, prop, write); }
        if (prop === 'FontSize') { return propRow(prop, el.getAttribute(prop) ?? '', write, XAML_FONT_SIZES); }
        if (prop === 'FontFamily') { return propRow(prop, el.getAttribute(prop) ?? '', write, XAML_FONT_FAMILIES); }
        return propRow(prop, el.getAttribute(prop) ?? '', write);
    }

    /** Dropdown row for enum/boolean attributes, VS-style with a default entry. */
    function xamlEnumRow(el, prop, write) {
        const row = document.createElement('div');
        row.className = 'ff-prop-row';
        const lab = document.createElement('label');
        lab.textContent = prop;
        row.appendChild(lab);

        const raw = el.getAttribute(prop) ?? '';
        const values = ENUM_VALUES[prop];
        const sel = document.createElement('select');
        const reset = document.createElement('option');
        reset.value = '';
        reset.textContent = raw ? '(reset)' : '(default)';
        sel.appendChild(reset);
        // Bindings/resources aren't in the list — keep the current value visible.
        const options = raw && !values.includes(raw) ? [raw, ...values] : values;
        for (const v of options) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            if (v === raw) { opt.selected = true; }
            sel.appendChild(opt);
        }
        sel.addEventListener('change', () => write(sel.value));
        sel.addEventListener('keydown', e => e.stopPropagation());
        row.appendChild(sel);
        return row;
    }

    /** Brush row: color swatch (native picker) + named-color text + image button. */
    function xamlBrushRow(el, prop, write) {
        const row = document.createElement('div');
        row.className = 'ff-prop-row';
        const lab = document.createElement('label');
        lab.textContent = prop;
        row.appendChild(lab);

        const raw = el.getAttribute(prop) ?? '';
        const imageBrush = xamlImageBrush(el, prop);

        const swatch = document.createElement('input');
        swatch.type = 'color';
        swatch.className = 'ff-color-swatch';
        // Show the effective color: explicit value, {StaticResource} brushes
        // resolved through App.xaml, else the style-resolved fallback.
        swatch.value = cssColorToHex(resolveBrush(raw) || resolveBrush(styleProp(el, prop) || ''));
        swatch.title = 'Pick a color';
        swatch.addEventListener('change', () => write(swatch.value.toUpperCase()));
        row.appendChild(swatch);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = imageBrush ? `(image) ${imageBrush.getAttribute('ImageSource') ?? ''}` : raw;
        input.placeholder = 'color, #hex, or {resource}';
        input.spellcheck = false;
        input.setAttribute('list', brushDatalist());
        input.addEventListener('change', () => {
            const v = input.value.trim();
            if (v.startsWith('(image)')) { renderPanel(); return; } // display text, not a value
            write(v);
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { input.blur(); }
            e.stopPropagation();
        });
        row.appendChild(input);

        if (prop === 'Background') {
            const pick = document.createElement('button');
            pick.type = 'button';
            pick.className = 'ff-img-btn';
            pick.textContent = '🖼';
            pick.title = 'Use an image as the background (imports it into the project and writes an ImageBrush)';
            pick.addEventListener('click', () => {
                pendingXamlImage = { el, prop };
                vscode.postMessage({ type: 'pickImage', xaml: true, prop });
            });
            row.appendChild(pick);
        }
        if (imageBrush || raw) {
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.className = 'ff-img-btn';
            clear.textContent = '✕';
            clear.title = 'Clear this brush';
            clear.addEventListener('click', () => write(''));
            row.appendChild(clear);
        }
        return row;
    }

    /**
     * Datalist for brush rows, rebuilt on every use: the project's own
     * {StaticResource …} brush keys first, then the named colors.
     */
    function brushDatalist() {
        const id = 'ff-dl-xaml-brushes';
        let dl = document.getElementById(id);
        if (!dl || dl.tagName !== 'DATALIST') {
            dl = document.createElement('datalist');
            dl.id = id;
            document.body.appendChild(dl);
        }
        dl.innerHTML = '';
        const values = [
            ...[...styles.resources.keys()].map(k => `{StaticResource ${k}}`),
            'Transparent', ...WF_NAMED_COLORS
        ];
        dl.append(...values.map(v => {
            const o = document.createElement('option');
            o.value = v;
            return o;
        }));
        return id;
    }

    /** Image.Source row: path text + "…" file picker. */
    function xamlImagePathRow(el, prop, write) {
        const row = propRow(prop, el.getAttribute(prop) ?? '', write);
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'ff-img-btn';
        pick.textContent = '…';
        pick.title = 'Import an image (.png, .jpg, .gif, .bmp, .ico) into the project';
        pick.addEventListener('click', () => {
            pendingXamlImage = { el, prop };
            vscode.postMessage({ type: 'pickImage', xaml: true, prop });
        });
        row.appendChild(pick);
        return row;
    }

    /** One labelled input row; commits on change (blur/Enter). */
    function propRow(label, value, onChange, options) {
        const row = document.createElement('div');
        row.className = 'ff-prop-row';

        const lab = document.createElement('label');
        lab.textContent = label;
        row.appendChild(lab);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.spellcheck = false;
        if (options) {
            const listId = `ff-dl-${label}`;
            let dl = document.getElementById(listId);
            if (!dl) {
                dl = document.createElement('datalist');
                dl.id = listId;
                dl.append(...options.map(o => {
                    const opt = document.createElement('option');
                    opt.value = o;
                    return opt;
                }));
                document.body.appendChild(dl);
            }
            input.setAttribute('list', listId);
        }
        input.addEventListener('change', () => onChange(input.value));
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { input.blur(); }
            e.stopPropagation(); // keep Delete/arrows from hitting canvas shortcuts
        });
        row.appendChild(input);
        return row;
    }

    function renderEventsTab(el, isWindow) {
        const events = isWindow
            ? WINDOW_EVENTS
            : [...(CONTROLS[el.localName]?.events ?? []), 'Loaded'];

        const hint = document.createElement('div');
        hint.className = 'ff-events-hint';
        hint.textContent = 'Type a handler name (or click ⚡ for the default) to wire the event and create the C# stub.';
        propsBody.appendChild(hint);

        for (const ev of events) {
            propsBody.appendChild(eventRow(el, ev, isWindow));
        }
    }

    function eventRow(el, eventName, isWindow) {
        const row = document.createElement('div');
        row.className = 'ff-prop-row';

        const lab = document.createElement('label');
        lab.textContent = eventName;
        row.appendChild(lab);

        const input = document.createElement('input');
        input.type = 'text';
        input.value = el.getAttribute(eventName) ?? '';
        input.placeholder = defaultHandlerName(el, eventName, isWindow);
        input.spellcheck = false;
        input.addEventListener('change', () => {
            const handler = input.value.trim();
            if (handler && !validateCSharpIdentifier(handler, 'handler name')) {
                input.value = el.getAttribute(eventName) ?? '';
                return;
            }
            if (handler === '') { el.removeAttribute(eventName); }
            else { el.setAttribute(eventName, handler); }
            commit();
        });
        input.addEventListener('keydown', e => e.stopPropagation());
        row.appendChild(input);

        // Wire button: fills the default name, sets the attribute, asks the
        // extension host to create/reveal the C# handler stub.
        const btn = document.createElement('button');
        btn.className = 'ff-wire';
        btn.title = 'Wire event and open the handler';
        btn.textContent = '⚡';
        btn.addEventListener('click', () => wireEvent(el, eventName, input.value.trim(), isWindow));
        row.appendChild(btn);

        return row;
    }

    function defaultHandlerName(el, eventName, isWindow) {
        if (!isWindow) {
            return `${getName(el) || el.localName}_${eventName}`;
        }
        // For the window itself, derive from x:Class ("Ns.MainWindow" -> "MainWindow").
        const cls = windowEl.getAttributeNS(X_NS, 'Class') || windowEl.getAttribute('x:Class') || 'Window';
        return `${cls.split('.').pop()}_${eventName}`;
    }

    function wireEvent(el, eventName, handler, isWindow) {
        const finalName = handler || defaultHandlerName(el, eventName, isWindow);
        if (!validateCSharpIdentifier(finalName, 'handler name')) { return; }
        el.setAttribute(eventName, finalName);
        commit();
        vscode.postMessage({ type: 'addHandler', handler: finalName, event: eventName });
    }

    function wireDefaultEvent(el) {
        if (el.__wf) {
            const wdef = WF_CONTROLS[el.type] ?? WF_TRAY[el.type];
            switchPanelTab('events');
            wfWireEvent(el, wdef?.defaultEvent ?? 'Click', el.events[wdef?.defaultEvent ?? 'Click'] || '');
            return;
        }
        const def = CONTROLS[el.localName];
        if (!def) { return; }
        // Switch to the events tab so the user sees what happened.
        switchPanelTab('events');
        const existing = el.getAttribute(def.defaultEvent);
        wireEvent(el, def.defaultEvent, existing || '', false);
    }

    // =========================================================== serialization

    /**
     * Serialize the XML DOM back to XAML text and push it to the document.
     * Formatting is normalized: 4-space indent, root attributes one per line.
     */
    function commit() {
        if (!xamlDoc) { return; }
        if (modelStale) {
            setStatus('UI Maker: the document has unparsed changes — fix the XAML in the code view before designing.');
            return;
        }
        const baseText = xamlText;
        xamlText = formatDocument(xamlDoc);
        vscode.postMessage({ type: 'edit', text: xamlText, baseText });
        render();
    }

    /**
     * Format the root while retaining document-level nodes that are legal
     * outside it. DOMParser keeps comments and processing instructions as
     * siblings of documentElement; serializing only the root silently dropped
     * those nodes on the first designer edit.
     */
    function formatDocument(documentNode) {
        const serializer = new XMLSerializer();
        const parts = [...documentNode.childNodes].map(node => {
            if (node === documentNode.documentElement) {
                return formatElement(node, 0).trimStart();
            }
            if (node.nodeType === Node.COMMENT_NODE
                || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE
                || node.nodeType === Node.DOCUMENT_TYPE_NODE) {
                return serializer.serializeToString(node);
            }
            return '';
        }).filter(Boolean);
        return (xmlDeclaration ? `${xmlDeclaration}\n` : '') + parts.join('\n') + '\n';
    }

    /** Effective xml:space value, including the nearest ancestor declaration. */
    function effectiveXmlSpace(node) {
        for (let el = node; el?.nodeType === Node.ELEMENT_NODE; el = el.parentNode) {
            const value = el.getAttribute('xml:space');
            if (value === 'preserve' || value === 'default') { return value; }
        }
        return 'default';
    }

    /**
     * Text content must stay inline. This includes CDATA, ordinary non-blank
     * text, and whitespace without a line break (for example the separator
     * between two Runs). Newline-bearing whitespace is the normal source
     * indentation that this formatter intentionally normalizes.
     */
    function hasSignificantInlineText(node) {
        return [...node.childNodes].some(child => child.nodeType === Node.CDATA_SECTION_NODE
            || (child.nodeType === Node.TEXT_NODE
                && (child.data.trim() !== '' || (child.data !== '' && !/[\r\n]/.test(child.data)))));
    }

    function formatElement(node, depth) {
        const pad = '    '.repeat(depth);

        if (node.nodeType === Node.COMMENT_NODE) {
            return `\n${pad}<!--${node.data}-->`;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            const t = node.data.trim();
            return t ? `\n${pad}${escapeXml(t)}` : '';
        }
        if (node.nodeType === Node.CDATA_SECTION_NODE) {
            return `\n${pad}<![CDATA[${node.data}]]>`;
        }
        if (node.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
            return `\n${pad}<?${node.target} ${node.data}?>`;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) { return ''; }

        // Whitespace-significant, mixed-text, or code-bearing subtrees are
        // emitted as one unit — inserting formatter newlines would alter their
        // logical text. xml:space is inherited unless a descendant resets it.
        if (effectiveXmlSpace(node) === 'preserve'
            || hasSignificantInlineText(node)
            || (node.namespaceURI === X_NS && node.localName === 'Code')) {
            return `\n${pad}${new XMLSerializer().serializeToString(node)}`;
        }

        // Attributes: the root element traditionally lists one per line
        // (matching the Visual Studio template layout); children stay inline.
        const attrs = [...node.attributes];
        let attrText = '';
        if (attrs.length) {
            if (depth === 0 && attrs.length > 1) {
                const contPad = `\n${pad}${' '.repeat(node.nodeName.length + 2)}`;
                attrText = ' ' + attrs.map(a => `${a.name}="${escapeXml(a.value)}"`).join(contPad);
            } else {
                attrText = ' ' + attrs.map(a => `${a.name}="${escapeXml(a.value)}"`).join(' ');
            }
        }

        const children = [...node.childNodes].filter(c =>
            c.nodeType === Node.ELEMENT_NODE ||
            c.nodeType === Node.COMMENT_NODE ||
            c.nodeType === Node.CDATA_SECTION_NODE ||
            c.nodeType === Node.PROCESSING_INSTRUCTION_NODE ||
            (c.nodeType === Node.TEXT_NODE && c.data.trim() !== ''));

        if (!children.length) {
            return `\n${pad}<${node.nodeName}${attrText}/>`;
        }
        const inner = children.map(c => formatElement(c, depth + 1)).join('');
        return `\n${pad}<${node.nodeName}${attrText}>${inner}\n${pad}</${node.nodeName}>`;
    }

    // ============================================================== keyboard

    document.addEventListener('keydown', e => {
        // Ignore shortcuts while interacting with panel inputs/selects/buttons.
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement
            || e.target instanceof HTMLButtonElement || e.target instanceof HTMLTextAreaElement) { return; }

        // Escape always closes an open context menu first.
        if (e.key === 'Escape' && ctxMenuEl) {
            hideContextMenu();
            e.preventDefault();
            return;
        }
        // Paste works without a selection.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
            pasteClipboard();
            e.preventDefault();
            return;
        }
        if (!selected) {
            if (e.key === 'Escape' && tabOrderMode) { toggleTabOrder(false); }
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            copySelection();
            e.preventDefault();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
            cutSelection();
            e.preventDefault();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            deleteSelected();
            e.preventDefault();
        } else if (e.key === 'Escape') {
            if (tabOrderMode) { toggleTabOrder(false); }
            select(null);
        } else if (e.key.startsWith('Arrow')) {
            const mode = movability(selected);
            if (!mode) { return; }
            const step = e.shiftKey ? config.gridSize : 1;
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
            if (mode === 'wf') {
                // Nudge every selected control in one batched edit.
                let text = xamlText;
                for (const c of multiSel) {
                    if (!c.__wf || c === wfForm) { continue; }
                    const p = wfPoint(c.props.Location) ?? { x: 0, y: 0 };
                    text = wfSetLine(c.name, 'Location',
                        `new System.Drawing.Point(${Math.max(0, p.x + dx)}, ${Math.max(0, p.y + dy)})`, text);
                }
                wfApply(text);
                e.preventDefault();
                return;
            }
            if (mode === 'canvas') {
                el2attr(selected, 'Canvas.Left', dx);
                el2attr(selected, 'Canvas.Top', dy);
            } else {
                const m = parseMargin(selected.getAttribute('Margin'));
                selected.setAttribute('Margin',
                    `${Math.max(0, m.l + dx)},${Math.max(0, m.t + dy)},${m.r},${m.b}`);
            }
            commit();
            e.preventDefault();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
            if (selected.__wf) {
                if (selected !== wfForm) { wfDuplicateControl(selected); }
                e.preventDefault();
                return;
            }
            // Duplicate: clone, offset, rename, insert next to the original.
            const clone = selected.cloneNode(true);
            setName(clone, uniqueName(selected.localName));
            const mode = movability(selected);
            if (mode === 'canvas') {
                el2attr(clone, 'Canvas.Left', config.gridSize);
                el2attr(clone, 'Canvas.Top', config.gridSize);
            } else if (mode === 'margin') {
                const m = parseMargin(clone.getAttribute('Margin'));
                clone.setAttribute('Margin', `${m.l + config.gridSize},${m.t + config.gridSize},${m.r},${m.b}`);
            }
            selected.parentNode.insertBefore(clone, selected.nextSibling);
            selected = clone;
            multiSel.clear();
            multiSel.add(clone);
            commit();
            selectedPath = pathOf(clone);
            e.preventDefault();
        }
    });

    /** Add `delta` to a numeric attribute (missing counts as 0, floor 0). */
    function el2attr(el, attr, delta) {
        if (!delta) { return; }
        el.setAttribute(attr, String(Math.max(0, num(el.getAttribute(attr), 0) + delta)));
    }

    function deleteSelected() {
        if (!selected) { return; }
        if (selected.__wf) {
            const doomed = [...multiSel].filter(c => c.__wf && c !== wfForm);
            if (doomed.length) { wfDeleteControls(doomed); }
            return;
        }
        // Deletion targets the multi-selection plus the primary selection,
        // skipping anything that no longer belongs to the current document
        // (a stale reference must never trigger a rogue serialize).
        const doomed = new Set([...multiSel, selected]);
        for (const el of doomed) {
            if (!el || el.__wf || el.ownerDocument !== xamlDoc) { continue; }
            el.remove();
        }
        multiSel.clear();
        selected = null;
        selectedPath = '';
        commit();
    }

    // ------------------------------------------------------------ copy/paste
    // The clipboard lives in the webview AND is mirrored to the extension
    // host, so controls copied on one form can be pasted onto another.

    let clipboard = null; // { mode: 'wf', items: [{type, props}] } | { mode: 'xaml', xml }

    function wfShallowCloneBlock(control) {
        if (control.type === 'TabPage') { return 'tab pages'; }
        if (control.children?.length) { return 'containers with child controls'; }
        if (control.items?.length) { return 'controls with generated items'; }
        if (control.columns?.length) { return 'grids with generated columns'; }
        return '';
    }

    function wfClipboardSelection() {
        return [...new Set([...multiSel, selected])]
            .filter(c => c?.__wf && c !== wfForm);
    }

    function copySelection() {
        if (!selected) { return false; }
        if (selected.__wf) {
            const controls = wfClipboardSelection();
            const blocked = controls.find(c => wfShallowCloneBlock(c));
            if (blocked) {
                setStatus(`UI Maker: copying ${wfShallowCloneBlock(blocked)} is disabled until deep cloning can preserve their structure.`);
                return false;
            }
            const items = controls
                .filter(c => c.__wf && c !== wfForm && (WF_CONTROLS[c.type] || WF_TRAY[c.type]))
                .map(c => ({ type: c.type, props: { ...c.props } }));
            if (!items.length) { return false; }
            // props carry raw source-language code, so the paste target must
            // speak the same language (see pasteClipboard).
            clipboard = { mode: 'wf', lang: wfLang, items };
            setStatus(`UI Maker: copied ${items.length} control${items.length === 1 ? '' : 's'} — Ctrl+V to paste.`);
        } else {
            clipboard = { mode: 'xaml', xml: new XMLSerializer().serializeToString(selected) };
            setStatus(`UI Maker: copied ${selected.localName} — Ctrl+V to paste.`);
        }
        vscode.postMessage({ type: 'setClipboard', data: clipboard });
        return true;
    }

    function pasteClipboard() {
        if (!clipboard) { setStatus('UI Maker: nothing to paste yet — copy a control first (Ctrl+C).'); return; }

        if (clipboard.mode === 'wf' && docMode === 'winforms' && wfForm) {
            // Copied property values are raw C# or VB code — never inject one
            // language's code into the other's designer file.
            if ((clipboard.lang ?? 'cs') !== wfLang) {
                setStatus('UI Maker: the clipboard holds controls from a different language project — paste them into a matching form.');
                return;
            }
            let pasted = 0;
            for (const item of clipboard.items) {
                if (WF_TRAY[item.type]) { wfAddComponent(item.type); pasted++; continue; }
                if (!WF_CONTROLS[item.type]) { continue; }
                if (wfPasteControl(item)) { pasted++; }
            }
            if (pasted) { setStatus(`UI Maker: pasted ${pasted} control${pasted === 1 ? '' : 's'}.`); }
            return;
        }

        if (clipboard.mode === 'xaml' && docMode === 'xaml' && xamlDoc) {
            const target = layoutRoot ?? contentRoot;
            if (!target) { return; }
            const parsed = new DOMParser().parseFromString(clipboard.xml, 'text/xml');
            if (parsed.getElementsByTagName('parsererror').length) { return; }
            const clone = xamlDoc.importNode(parsed.documentElement, true);
            setName(clone, uniqueName(clone.localName));
            const m = parseMargin(clone.getAttribute('Margin'));
            clone.setAttribute('Margin', `${m.l + config.gridSize},${m.t + config.gridSize},${m.r},${m.b}`);
            target.appendChild(clone);
            selected = clone;
            multiSel.clear();
            multiSel.add(clone);
            commit();
            selectedPath = pathOf(clone);
        }
    }

    /** Insert a copy of serialized control data (like duplicate, from clipboard). */
    function wfPasteControl(item) {
        const name = wfUniqueName(item.type);
        const loc = wfPoint(item.props.Location) ?? { x: 0, y: 0 };
        const props = [
            ['Location', `new System.Drawing.Point(${loc.x + config.gridSize}, ${loc.y + config.gridSize})`],
            ['Name', `"${name}"`],
            ['TabIndex', String(wfControls.size)]
        ];
        for (const [prop, code] of Object.entries(item.props)) {
            if (prop === 'Location' || prop === 'Name' || prop === 'TabIndex') { continue; }
            props.push([prop, code]);
        }
        return wfInsertControl(item.type, name, props, null);
    }

    function cutSelection() {
        if (selected?.__wf) {
            const controls = wfClipboardSelection();
            const unsafe = controls.find(c => wfShallowCloneBlock(c)
                || (c.parent && c.parent !== wfForm)
                || Object.keys(c.events ?? {}).length);
            if (unsafe) {
                setStatus('UI Maker: Cut was cancelled because the current clipboard cannot preserve this control’s structure, parent, or events.');
                return;
            }
        }
        if (copySelection()) { deleteSelected(); }
    }

    // ============================================================ context menu
    // Right-click menu on the canvas: standard clipboard/z-order commands plus
    // per-type verbs (Add Tab, Add Item, Edit Items…) like the VS designer.

    let ctxMenuEl = null;

    function hideContextMenu() {
        if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; }
    }

    /** items: '—' separators or { label, key?, header?, danger?, disabled?, action }. */
    function showContextMenu(x, y, items) {
        hideContextMenu();
        const menu = document.createElement('div');
        menu.id = 'ff-ctx';
        for (const it of items) {
            if (it === '—') {
                const sep = document.createElement('div');
                sep.className = 'ff-ctx-sep';
                menu.appendChild(sep);
                continue;
            }
            const row = document.createElement('div');
            row.className = 'ff-ctx-item'
                + (it.header ? ' header' : '')
                + (it.disabled ? ' disabled' : '')
                + (it.danger ? ' danger' : '');
            const lab = document.createElement('span');
            lab.className = 'ff-ctx-label';
            lab.textContent = it.label;
            row.appendChild(lab);
            if (it.key) {
                const key = document.createElement('span');
                key.className = 'ff-ctx-key';
                key.textContent = it.key;
                row.appendChild(key);
            }
            if (!it.header && !it.disabled && it.action) {
                row.addEventListener('click', () => {
                    hideContextMenu();
                    try { it.action(); }
                    catch (err) { setStatus(`UI Maker: ${err?.message ?? err}`); }
                });
            }
            menu.appendChild(row);
        }
        document.body.appendChild(menu);
        // Keep the menu inside the viewport.
        const r = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - r.width - 4))}px`;
        menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - r.height - 4))}px`;
        ctxMenuEl = menu;
    }

    document.addEventListener('mousedown', e => {
        if (ctxMenuEl && !ctxMenuEl.contains(e.target)) { hideContextMenu(); }
    });
    window.addEventListener('blur', hideContextMenu);

    /** Switch the right-hand panel to Properties or Events. */
    function switchPanelTab(tab) {
        activeTab = tab;
        const propsTab = $('ff-tab-props');
        const eventsTab = $('ff-tab-events');
        propsTab?.classList.toggle('active', tab === 'props');
        eventsTab?.classList.toggle('active', tab === 'events');
        propsTab?.setAttribute('aria-selected', String(tab === 'props'));
        eventsTab?.setAttribute('aria-selected', String(tab === 'events'));
        renderPanel();
    }

    /** Select the control and focus its Items editor in the property grid. */
    function editItemsAction(ctrl) {
        select(ctrl);
        collapsedCats.delete('Data');
        switchPanelTab('props');
        propsBody.querySelector('.ff-items-edit')?.focus();
    }

    const openCode = () => vscode.postMessage({ type: 'openCode' });
    const panelEntries = () => ['—',
        { label: '▤ Properties', action: () => switchPanelTab('props') },
        { label: '⚡ Events', action: () => switchPanelTab('events') }];
    const clipboardEntries = () => [
        { label: 'Cut', key: 'Ctrl+X', action: cutSelection },
        { label: 'Copy', key: 'Ctrl+C', action: copySelection },
        { label: 'Paste', key: 'Ctrl+V', disabled: !clipboard, action: pasteClipboard }];

    /** Menu for one WinForms control, tray component, or TabPage. */
    function wfControlMenu(ctrl) {
        const isTray = !!WF_TRAY[ctrl.type];
        const def = WF_CONTROLS[ctrl.type] ?? WF_TRAY[ctrl.type];
        const items = [{ label: `${ctrl.name} : ${ctrl.type}`, header: true }];

        // Content verbs first, like the VS designer's smart commands.
        if (ctrl.type === 'TabControl') {
            const pages = ctrl.children.filter(c => c.type === 'TabPage');
            const active = pages[Math.min(uiTabs.get(ctrl.name) ?? 0, Math.max(0, pages.length - 1))] ?? null;
            items.push({ label: 'Add Tab', action: () => wfAddTab(ctrl) });
            items.push({
                label: `Remove Tab${active ? ` (${wfString(active.props.Text) ?? active.name})` : ''}`,
                disabled: !active,
                action: () => { if (active) { wfRemoveTab(ctrl, active); } }
            });
            items.push('—');
        } else if (ctrl.type === 'TabPage') {
            const tc = ctrl.parent && ctrl.parent.type === 'TabControl' ? ctrl.parent : null;
            if (tc) {
                items.push({ label: 'Add Tab', action: () => wfAddTab(tc) });
                items.push({ label: 'Remove This Tab', danger: true, action: () => wfRemoveTab(tc, ctrl) });
                items.push({ label: `Select TabControl (${tc.name})`, action: () => select(tc) });
                items.push('—');
            }
        } else if (WF_STRIP_ITEM_TYPES[ctrl.type]) {
            items.push({ label: 'Add Item', action: () => wfAddStripItem(ctrl) });
            items.push({ label: 'Edit Items…', action: () => editItemsAction(ctrl) });
            items.push('—');
        } else if (WF_OBJECT_ITEM_TYPES.includes(ctrl.type)) {
            items.push({ label: 'Edit Items…', action: () => editItemsAction(ctrl) });
            items.push('—');
        }

        items.push({ label: `⚡ Handle ${def?.defaultEvent ?? 'Click'}`, action: () => wireDefaultEvent(ctrl) });
        items.push({ label: '</> View Code', action: openCode });
        items.push('—');
        items.push(...clipboardEntries());
        if (!isTray && ctrl.type !== 'TabPage' && WF_CONTROLS[ctrl.type]) {
            items.push({ label: 'Duplicate', key: 'Ctrl+D', action: () => wfDuplicateControl(ctrl) });
        }
        items.push({ label: 'Delete', key: 'Del', danger: true, action: deleteSelected });
        if (!isTray && ctrl.type !== 'TabPage') {
            items.push('—');
            items.push({ label: 'Bring to Front', action: () => wfReorderZ(ctrl, true) });
            items.push({ label: 'Send to Back', action: () => wfReorderZ(ctrl, false) });
        }
        if (!isTray && ctrl.parent && ctrl.parent !== wfForm) {
            items.push({ label: `Select Parent (${ctrl.parent.name})`, action: () => select(ctrl.parent) });
        }
        items.push(...panelEntries());
        return items;
    }

    /** Menu for the form background. */
    function wfFormMenu() {
        return [
            { label: `${wfForm?.name ?? 'Form'} : Form`, header: true },
            { label: 'Paste', key: 'Ctrl+V', disabled: !clipboard, action: pasteClipboard },
            { label: '⚡ Handle Load', action: () => wfWireEvent(wfForm, 'Load', wfForm.events?.Load || '') },
            { label: '</> View Code', action: openCode },
            ...panelEntries()
        ];
    }

    /** Menu for one XAML element. */
    function xamlControlMenu(el) {
        const type = el.localName;
        const items = [{ label: `${getName(el) || type} : ${type}`, header: true }];
        if (type === 'TabControl') {
            items.push({ label: 'Add Tab', action: () => xamlAddTab(el) });
            items.push('—');
        } else if (type === 'TabItem') {
            const tc = el.parentNode;
            if (tc && tc.nodeType === Node.ELEMENT_NODE) {
                items.push({ label: 'Add Tab', action: () => xamlAddTab(tc) });
                items.push({ label: 'Remove This Tab', danger: true, action: () => xamlRemoveTab(el) });
                items.push('—');
            }
        }
        if (CONTROLS[type]) {
            items.push({ label: `⚡ Handle ${CONTROLS[type].defaultEvent}`, action: () => wireDefaultEvent(el) });
        }
        items.push({ label: '</> View Code', action: openCode });
        items.push('—');
        items.push(...clipboardEntries());
        items.push({ label: 'Delete', key: 'Del', danger: true, action: deleteSelected });
        const p = el.parentNode;
        if (p && p.nodeType === Node.ELEMENT_NODE && p !== windowEl) {
            items.push('—');
            items.push({ label: `Select Parent (${getName(p) || p.localName})`, action: () => select(p) });
        }
        items.push(...panelEntries());
        return items;
    }

    /** Menu for the empty XAML surface. */
    function xamlSurfaceMenu() {
        return [
            { label: `${windowEl?.localName ?? 'Window'} (${config.docName})`, header: true },
            { label: 'Paste', key: 'Ctrl+V', disabled: !clipboard, action: pasteClipboard },
            { label: '</> View Code', action: openCode },
            ...panelEntries()
        ];
    }

    surfaceEl.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        // Deepest rendered control under the pointer, like the drop targeting.
        let node = e.target;
        let hit = null;
        while (node && node !== surfaceEl) {
            const h = visuals.find(v => v.div === node);
            if (h) { hit = h; break; }
            node = node.parentElement;
        }
        if (docMode === 'winforms') {
            if (!wfForm) { return; }
            if (hit && hit.el.__wf) {
                if (!multiSel.has(hit.el)) { select(hit.el); }
                else { selected = hit.el; drawSelection(); renderPanel(); }
                showContextMenu(e.clientX, e.clientY, wfControlMenu(hit.el));
            } else {
                select(null);
                showContextMenu(e.clientX, e.clientY, wfFormMenu());
            }
            return;
        }
        if (!windowEl) { return; }
        if (hit) {
            if (!multiSel.has(hit.el)) { select(hit.el); }
            showContextMenu(e.clientX, e.clientY, xamlControlMenu(hit.el));
        } else {
            select(null);
            showContextMenu(e.clientX, e.clientY, xamlSurfaceMenu());
        }
    });

    // Right-click on the window chrome (title bar, edges) → form/window menu.
    windowBox.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (docMode === 'winforms' ? !wfForm : !windowEl) { return; }
        select(null);
        showContextMenu(e.clientX, e.clientY, docMode === 'winforms' ? wfFormMenu() : xamlSurfaceMenu());
    });

    // ---------------------------------------------------- context menu verbs

    /** Append a new TabPage to a WinForms TabControl, like VS's Add Tab. */
    function wfAddTab(tc) {
        const eol = wfEol();
        let text = xamlText;
        const ind = wfIndent(text);
        const name = wfUniqueName('TabPage');
        const ins = wfInsertBeforeSuspend(text,
            `${ind}${wfRef(name)} = ${wfCode('new System.Windows.Forms.TabPage()')}${wfSemi()}`);
        if (!ins) {
            setStatus('UI Maker: could not find a place to insert the tab page.');
            return;
        }
        text = ins;

        const pages = tc.children.filter(c => c.type === 'TabPage');
        const size = wfSizeVal(tc.props.Size) ?? { w: 300, h: 200 };
        const semi = wfSemi();
        text = wfInsertBlockBeforeForm(text, [
            ...wfCommentTrio(ind, name),
            `${ind}${wfRef(name)}.Location = ${wfCode('new System.Drawing.Point(4, 24)')}${semi}`,
            `${ind}${wfRef(name)}.Name = "${name}"${semi}`,
            `${ind}${wfRef(name)}.Padding = ${wfCode('new System.Windows.Forms.Padding(3)')}${semi}`,
            `${ind}${wfRef(name)}.Size = ${wfCode(`new System.Drawing.Size(${Math.max(10, size.w - 8)}, ${Math.max(10, size.h - 28)})`)}${semi}`,
            `${ind}${wfRef(name)}.TabIndex = ${pages.length}${semi}`,
            `${ind}${wfRef(name)}.Text = "${name}"${semi}`,
            `${ind}${wfRef(name)}.UseVisualStyleBackColor = ${wfCode('true')}${semi}`
        ]) ?? text;

        // tc.Controls.Add(newPage) after the last existing page add (keeps
        // tab order), else after the TabControl's first statement.
        const addLine = `${ind}${wfRef(tc.name)}.Controls.Add(${wfRef(name)})${semi}`;
        let last = null;
        for (const m of text.matchAll(new RegExp(`^[ \\t]*(?:this\\.|Me\\.)?${tc.name}\\.Controls\\.Add\\([^\\r\\n]*$`, 'gm'))) { last = m; }
        const anchor = last
            ?? new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${tc.name}\\.[\\w\\.]+[^\\r\\n]*$`, 'm').exec(text);
        if (anchor) {
            const end = anchor.index + anchor[0].length;
            text = `${text.slice(0, end)}${eol}${addLine}${text.slice(end)}`;
        }
        text = wfInsertField(text, 'System.Windows.Forms.TabPage', name) ?? text;

        uiTabs.set(tc.name, pages.length); // activate the new tab
        wfSelectInserted(name, 'TabPage');
        wfApply(text);
        setStatus(`UI Maker: added ${name} to ${tc.name}.`);
    }

    /** Remove one TabPage (and everything on it) from a TabControl. */
    function wfRemoveTab(tc, page) {
        wfDeleteControls([page]);
        uiTabs.set(tc.name, 0);
        setStatus(`UI Maker: removed ${page.name} from ${tc.name}.`);
    }

    /** Append one item ("ItemN") to a strip's Items collection. */
    function wfAddStripItem(strip) {
        const texts = (strip.items ?? []).map(n => wfString(wfControls.get(n)?.props.Text) ?? n);
        texts.push(`Item${texts.length + 1}`);
        wfSetStripItems(strip, texts);
        setStatus(`UI Maker: added an item to ${strip.name} — use Edit Items… to rename it.`);
    }

    /**
     * Move a control's Controls.Add line to the start/end of its container's
     * add block. First in the collection paints on top (VS: Bring to Front).
     */
    function wfReorderZ(ctrl, toFront) {
        const eol = wfEol();
        let text = xamlText;
        const lineRe = new RegExp(
            `^[ \\t]*((?:this\\.|Me\\.)?[\\w\\.]*?Controls)\\.Add\\((?:this\\.|Me\\.)?${ctrl.name}(?:\\s*,[^)]*)?\\);?[ \\t]*\\r?\\n`, 'm');
        const m = lineRe.exec(text);
        if (!m) {
            setStatus('UI Maker: this control is added via AddRange — reorder it in the code view.');
            return;
        }
        const line = m[0];
        const prefix = m[1];
        text = text.replace(lineRe, '');
        const sibRe = new RegExp(`^[ \\t]*${reEsc(prefix)}\\.Add\\([^\\r\\n]*$`, 'gm');
        let first = null, lastSib = null;
        for (const s of text.matchAll(sibRe)) { if (!first) { first = s; } lastSib = s; }
        if (!first) {
            // Only child — put the line back where the block ends.
            const rm = /^[ \t]*(?:[\w\.]+\.)?ResumeLayout\(/m.exec(text);
            text = rm ? `${text.slice(0, rm.index)}${line}${text.slice(rm.index)}` : xamlText;
            wfApply(text);
            return;
        }
        if (toFront) {
            text = `${text.slice(0, first.index)}${line}${text.slice(first.index)}`;
        } else {
            const end = lastSib.index + lastSib[0].length;
            text = `${text.slice(0, end)}${eol}${line.replace(/\r?\n$/, '')}${text.slice(end)}`;
        }
        wfApply(text);
        setStatus(`UI Maker: ${ctrl.name} ${toFront ? 'brought to front' : 'sent to back'}.`);
    }

    /** Append a <TabItem> with an empty Grid to a XAML TabControl. */
    function xamlAddTab(tc) {
        if (!xamlDoc) { return; }
        const count = elementChildren(tc).filter(c => c.localName === 'TabItem').length;
        const ti = xamlDoc.createElementNS(PRES_NS, 'TabItem');
        ti.setAttribute('Header', `Tab ${count + 1}`);
        ti.appendChild(xamlDoc.createElementNS(PRES_NS, 'Grid'));
        tc.appendChild(ti);
        uiTabs.set(pathOf(tc), count);
        selected = ti;
        multiSel.clear();
        multiSel.add(ti);
        commit();
        selectedPath = pathOf(ti);
    }

    /** Remove one <TabItem> from its TabControl. */
    function xamlRemoveTab(ti) {
        const tc = ti.parentNode;
        ti.remove();
        if (tc && tc.nodeType === Node.ELEMENT_NODE) { uiTabs.set(pathOf(tc), 0); }
        selected = null;
        multiSel.clear();
        selectedPath = '';
        commit();
    }

    // ================================================================ toolbar

    $('ff-btn-code').addEventListener('click', () => vscode.postMessage({ type: 'openCode' }));
    $('ff-btn-delete').addEventListener('click', deleteSelected);

    // Tab order toggle (WinForms only — TabIndex lives in the Designer.cs).
    const tabOrderBtn = $('ff-btn-taborder');
    if (tabOrderBtn) {
        tabOrderBtn.addEventListener('click', () => {
            if (docMode !== 'winforms') {
                setStatus('UI Maker: tab order editing is available for WinForms designers.');
                return;
            }
            toggleTabOrder();
        });
    }

    // Alignment tools (visible only for a WinForms multi-selection).
    for (const [id, op] of [
        ['ff-al-left', 'left'], ['ff-al-top', 'top'], ['ff-al-right', 'right'], ['ff-al-bottom', 'bottom'],
        ['ff-al-samew', 'same-w'], ['ff-al-sameh', 'same-h'], ['ff-al-samesize', 'same-size'],
        ['ff-al-disth', 'dist-h'], ['ff-al-distv', 'dist-v']
    ]) {
        const btn = $(id);
        if (btn) { btn.addEventListener('click', () => wfAlign(op)); }
    }
    $('ff-snap').addEventListener('change', e => { config.snap = e.target.checked; render(); });
    $('ff-grid').addEventListener('change', e => {
        config.gridSize = Math.max(1, parseInt(e.target.value, 10) || 8);
        render();
    });
    $('ff-zoom').addEventListener('change', e => {
        zoom = parseFloat(e.target.value) || 1;
        render();
    });

    $('ff-tab-props').addEventListener('click', () => {
        switchPanelTab('props');
    });
    $('ff-tab-events').addEventListener('click', () => {
        switchPanelTab('events');
    });

    // Collapsible side panels: the chevron shrinks a panel to a thin strip;
    // clicking (or Enter/Space on) the strip brings it back. The choice is
    // remembered in the webview state so it survives tab switches.
    function setPanelCollapsed(panel, collapseBtn, collapsed) {
        panel.classList.toggle('ff-collapsed', collapsed);
        collapseBtn.setAttribute('aria-expanded', String(!collapsed));
        const state = vscode.getState() || {};
        const collapsedPanels = state.collapsedPanels || {};
        collapsedPanels[panel.id] = collapsed;
        vscode.setState({ ...state, collapsedPanels });
    }

    for (const [panelId, btnId, tabId] of [
        ['ff-toolbox', 'ff-toolbox-collapse', 'ff-toolbox-tab'],
        ['ff-props', 'ff-props-collapse', 'ff-props-tab']
    ]) {
        const panel = $(panelId);
        const btn = $(btnId);
        const tab = $(tabId);
        if (!panel || !btn || !tab) { continue; }
        btn.addEventListener('click', () => setPanelCollapsed(panel, btn, true));
        tab.addEventListener('click', () => setPanelCollapsed(panel, btn, false));
        tab.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setPanelCollapsed(panel, btn, false);
            }
        });
        const saved = (vscode.getState() || {}).collapsedPanels;
        if (saved && saved[panelId]) { setPanelCollapsed(panel, btn, true); }
    }

    // Resizable side panels: a drag splitter sits between each panel and the
    // canvas. Widths persist in the webview state (like the collapse choice).
    function makePanelResizable(panelId, edge) {
        const panel = $(panelId);
        const main = $('ff-main');
        if (!panel || !main || !panel.parentNode) { return; }

        const savedW = ((vscode.getState() || {}).panelWidths || {})[panelId];
        if (savedW) { panel.style.flexBasis = `${Math.max(120, Math.min(600, savedW))}px`; }

        const grip = document.createElement('div');
        grip.className = 'ff-panel-splitter';
        grip.title = 'Drag to resize';
        // The splitter sits on the canvas side of the panel.
        if (edge === 'right') {
            panel.parentNode.insertBefore(grip, panel.nextSibling);
        } else {
            panel.parentNode.insertBefore(grip, panel);
        }

        grip.addEventListener('mousedown', e => {
            if (panel.classList.contains('ff-collapsed')) { return; }
            e.preventDefault();
            const startX = e.clientX;
            const startW = panel.getBoundingClientRect().width;
            document.body.style.cursor = 'col-resize';
            const move = ev => {
                const dx = ev.clientX - startX;
                const w = Math.max(120, Math.min(600, edge === 'right' ? startW + dx : startW - dx));
                panel.style.flexBasis = `${w}px`;
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                document.body.style.cursor = '';
                const state = vscode.getState() || {};
                const panelWidths = state.panelWidths || {};
                panelWidths[panelId] = Math.round(panel.getBoundingClientRect().width);
                vscode.setState({ ...state, panelWidths });
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
    }
    makePanelResizable('ff-toolbox', 'right');
    makePanelResizable('ff-props', 'left');

    // Property grid sort mode: categorized (like VS) or flat alphabetical.
    const sortCatBtn = $('ff-sort-cat');
    const sortAzBtn = $('ff-sort-az');
    if (sortCatBtn && sortAzBtn) {
        sortCatBtn.addEventListener('click', () => {
            propSort = 'cat';
            sortCatBtn.classList.add('active');
            sortAzBtn.classList.remove('active');
            renderPanel();
        });
        sortAzBtn.addEventListener('click', () => {
            propSort = 'az';
            sortAzBtn.classList.add('active');
            sortCatBtn.classList.remove('active');
            renderPanel();
        });
    }

    // ================================================================= banner

    function showBanner(text, actionLabel, action) {
        bannerEl.hidden = false;
        bannerEl.innerHTML = '';
        bannerEl.append(text);
        if (actionLabel && action) {
            const btn = document.createElement('button');
            btn.textContent = actionLabel;
            btn.addEventListener('click', action);
            bannerEl.appendChild(btn);
        }
    }

    /** Minimal valid Window used when the .xaml file is empty. */
    function insertStarterXaml() {
        const title = config.docName.replace(/\.xaml$/i, '');
        const starter =
`<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="${title}" Width="800" Height="450">
    <!-- Set x:Class="YourNamespace.${title}" to match your code-behind -->
    <Grid>
    </Grid>
</Window>
`;
        const baseText = xamlText;
        xamlText = starter;
        vscode.postMessage({ type: 'edit', text: starter, baseText });
        parseAndRender();
    }

    // ============================================================ WinForms mode
    //
    // *.Designer.cs support. The InitializeComponent method that Visual Studio
    // generates is machine-written and highly regular, so it can be parsed with
    // line-oriented patterns and edited surgically: every change replaces or
    // inserts individual statements, leaving the rest of the file untouched.

    /** WinForms toolbox: default sizes match the Visual Studio toolbox.
     *  `props` lists only the type-SPECIFIC grid entries — every control also
     *  gets WF_COMMON_PROPS (layout, colors, behavior, accessibility).
     *  `sec` groups the toolbox into VS-style sections; `noSize` skips the
     *  Size line on insert (auto-sizing controls); `extra` adds fixed
     *  property lines VS also generates on drop. */
    const WF_CONTROLS = {
        // ---- Common Controls
        Button:         { sec: 'Common Controls', icon: '▭', w: 75,  h: 23,  text: 'button',      props: ['Text', 'TextAlign', 'Image', 'ImageAlign', 'TextImageRelation', 'BackgroundImage', 'BackgroundImageLayout', 'FlatStyle', 'UseVisualStyleBackColor', 'UseMnemonic', 'AutoEllipsis', 'DialogResult'], events: ['Click', 'MouseDown', 'MouseUp', 'DoubleClick'], defaultEvent: 'Click' },
        Label:          { sec: 'Common Controls', icon: 'A',  w: 60,  h: 15,  text: 'label',       props: ['Text', 'TextAlign', 'Image', 'ImageAlign', 'BorderStyle', 'UseMnemonic', 'AutoEllipsis'], events: ['Click', 'DoubleClick'], defaultEvent: 'Click' },
        LinkLabel:      { sec: 'Common Controls', icon: '🔗', w: 80,  h: 15,  text: 'linkLabel',   props: ['Text', 'TextAlign', 'BorderStyle', 'UseMnemonic', 'AutoEllipsis', 'LinkColor'], events: ['LinkClicked', 'Click'], defaultEvent: 'LinkClicked' },
        TextBox:        { sec: 'Common Controls', icon: '⌨', w: 100, h: 23,  text: '',            props: ['Text', 'PlaceholderText', 'ReadOnly', 'Multiline', 'WordWrap', 'MaxLength', 'PasswordChar', 'CharacterCasing', 'ScrollBars', 'TextAlign'], events: ['TextChanged', 'KeyDown', 'KeyPress', 'Leave'], defaultEvent: 'TextChanged' },
        MaskedTextBox:  { sec: 'Common Controls', icon: '#',  w: 100, h: 23,  text: '',            props: ['Text', 'Mask', 'ReadOnly', 'TextAlign'], events: ['TextChanged'], defaultEvent: 'TextChanged' },
        RichTextBox:    { sec: 'Common Controls', icon: '¶',  w: 150, h: 96,  text: '',            props: ['Text', 'ReadOnly', 'Multiline', 'WordWrap', 'MaxLength', 'ScrollBars'], events: ['TextChanged'], defaultEvent: 'TextChanged' },
        CheckBox:       { sec: 'Common Controls', icon: '☑', w: 90,  h: 19,  text: 'checkBox',    props: ['Text', 'Checked', 'ThreeState', 'TextAlign', 'CheckAlign', 'Image', 'ImageAlign', 'FlatStyle', 'UseVisualStyleBackColor', 'UseMnemonic'], events: ['CheckedChanged', 'Click'], defaultEvent: 'CheckedChanged' },
        RadioButton:    { sec: 'Common Controls', icon: '◉', w: 95,  h: 19,  text: 'radioButton', props: ['Text', 'Checked', 'TextAlign', 'CheckAlign', 'Image', 'ImageAlign', 'FlatStyle', 'UseVisualStyleBackColor', 'UseMnemonic'], events: ['CheckedChanged', 'Click'], defaultEvent: 'CheckedChanged' },
        CheckedListBox: { sec: 'Common Controls', icon: '☒', w: 120, h: 94,  text: '',            props: ['Items', 'CheckOnClick', 'Sorted', 'ThreeDCheckBoxes'], events: ['SelectedIndexChanged', 'ItemCheck'], defaultEvent: 'SelectedIndexChanged' },
        ComboBox:       { sec: 'Common Controls', icon: '▾', w: 121, h: 23,  text: '',            props: ['Text', 'Items', 'DropDownStyle', 'MaxDropDownItems', 'Sorted'], events: ['SelectedIndexChanged', 'TextChanged'], defaultEvent: 'SelectedIndexChanged' },
        DomainUpDown:   { sec: 'Common Controls', icon: '⇅', w: 120, h: 23,  text: '',            props: ['Text', 'Items', 'ReadOnly', 'Sorted', 'Wrap'], events: ['SelectedItemChanged'], defaultEvent: 'SelectedItemChanged' },
        ListBox:        { sec: 'Common Controls', icon: '≡', w: 120, h: 94,  text: '',            props: ['Items', 'SelectionMode', 'Sorted', 'MultiColumn'], events: ['SelectedIndexChanged', 'DoubleClick'], defaultEvent: 'SelectedIndexChanged' },
        ListView:       { sec: 'Common Controls', icon: '☰', w: 160, h: 97,  text: '',            props: ['View', 'FullRowSelect', 'GridLines', 'MultiSelect', 'CheckBoxes'], events: ['SelectedIndexChanged', 'DoubleClick'], defaultEvent: 'SelectedIndexChanged' },
        TreeView:       { sec: 'Common Controls', icon: '🌲', w: 160, h: 97,  text: '',            props: ['CheckBoxes', 'ShowLines', 'ShowRootLines'], events: ['AfterSelect', 'DoubleClick'], defaultEvent: 'AfterSelect' },
        PictureBox:     { sec: 'Common Controls', icon: '🖼', w: 100, h: 50,  text: '',            props: ['Image', 'SizeMode', 'BorderStyle', 'BackgroundImage', 'BackgroundImageLayout'], events: ['Click', 'DoubleClick'], defaultEvent: 'Click' },
        ProgressBar:    { sec: 'Common Controls', icon: '▱', w: 100, h: 23,  text: '',            props: ['Minimum', 'Maximum', 'Value', 'Style'], events: ['Click'], defaultEvent: 'Click' },
        TrackBar:       { sec: 'Common Controls', icon: '⬌', w: 104, h: 45,  text: '',            props: ['Minimum', 'Maximum', 'Value', 'TickFrequency', 'SmallChange', 'LargeChange', 'Orientation'], events: ['Scroll', 'ValueChanged'], defaultEvent: 'Scroll' },
        NumericUpDown:  { sec: 'Common Controls', icon: '↕', w: 120, h: 23,  text: '',            props: ['Minimum', 'Maximum', 'Value', 'Increment', 'DecimalPlaces', 'ThousandsSeparator', 'ReadOnly', 'TextAlign'], events: ['ValueChanged'], defaultEvent: 'ValueChanged' },
        DateTimePicker: { sec: 'Common Controls', icon: '📅', w: 200, h: 23,  text: '',            props: ['Format', 'CustomFormat', 'ShowUpDown'], events: ['ValueChanged'], defaultEvent: 'ValueChanged' },
        MonthCalendar:  { sec: 'Common Controls', icon: '📆', w: 227, h: 162, text: '', noSize: true, props: ['ShowToday', 'ShowTodayCircle', 'ShowWeekNumbers', 'MaxSelectionCount'], events: ['DateChanged'], defaultEvent: 'DateChanged' },
        HScrollBar:     { sec: 'Common Controls', icon: '⇔', w: 80,  h: 17,  text: '',            props: ['Minimum', 'Maximum', 'Value', 'SmallChange', 'LargeChange'], events: ['Scroll', 'ValueChanged'], defaultEvent: 'Scroll' },
        VScrollBar:     { sec: 'Common Controls', icon: '⇕', w: 17,  h: 80,  text: '',            props: ['Minimum', 'Maximum', 'Value', 'SmallChange', 'LargeChange'], events: ['Scroll', 'ValueChanged'], defaultEvent: 'Scroll' },
        WebBrowser:     { sec: 'Common Controls', icon: '🌐', w: 250, h: 150, text: '',            props: ['AllowNavigation', 'ScriptErrorsSuppressed'], events: ['DocumentCompleted', 'Navigated'], defaultEvent: 'DocumentCompleted' },
        PropertyGrid:   { sec: 'Common Controls', icon: '▤', w: 130, h: 130, text: '',            props: ['HelpVisible', 'ToolbarVisible', 'PropertySort'], events: ['PropertyValueChanged'], defaultEvent: 'PropertyValueChanged' },
        // ---- Containers
        GroupBox:        { sec: 'Containers', icon: '⬒', w: 200, h: 100, text: 'groupBox',    props: ['Text', 'FlatStyle', 'BackgroundImage', 'BackgroundImageLayout'], events: ['Enter'], defaultEvent: 'Enter' },
        Panel:           { sec: 'Containers', icon: '▢', w: 200, h: 100, text: '',            props: ['BorderStyle', 'AutoScroll', 'BackgroundImage', 'BackgroundImageLayout'], events: ['Click', 'Paint'], defaultEvent: 'Click' },
        FlowLayoutPanel: { sec: 'Containers', icon: '⠿', w: 200, h: 100, text: '',            props: ['FlowDirection', 'WrapContents', 'AutoScroll', 'BorderStyle'], events: ['Click', 'Paint'], defaultEvent: 'Click' },
        TableLayoutPanel:{ sec: 'Containers', icon: '▦', w: 200, h: 100, text: '',            props: ['ColumnCount', 'RowCount', 'CellBorderStyle', 'AutoScroll'], events: ['Click', 'Paint'], defaultEvent: 'Click',
                           extra: [['ColumnCount', '2'], ['RowCount', '2']] },
        SplitContainer:  { sec: 'Containers', icon: '◫', w: 150, h: 100, text: '',            props: ['Orientation', 'SplitterDistance', 'SplitterWidth', 'IsSplitterFixed', 'BorderStyle'], events: ['SplitterMoved'], defaultEvent: 'SplitterMoved',
                           extra: [['SplitterDistance', '50']] },
        Splitter:        { sec: 'Containers', icon: '┃', w: 3,   h: 100, text: '',            props: ['MinExtra', 'MinSize'], events: ['SplitterMoved'], defaultEvent: 'SplitterMoved',
                           extra: [['TabStop', 'false']] },
        TabControl:      { sec: 'Containers', icon: '⧉', w: 300, h: 200, text: '',            props: ['SelectedIndex', 'Alignment'], events: ['SelectedIndexChanged'], defaultEvent: 'SelectedIndexChanged' },
        // ---- Menus & Toolbars
        MenuStrip:      { sec: 'Menus & Toolbars', icon: '☰', w: 0,   h: 24,  text: '',            props: ['Items', 'BackColor'], events: ['ItemClicked'], defaultEvent: 'ItemClicked' },
        ToolStrip:      { sec: 'Menus & Toolbars', icon: '🔧', w: 0,   h: 25,  text: '',            props: ['Items', 'BackColor', 'GripStyle'], events: ['ItemClicked'], defaultEvent: 'ItemClicked' },
        StatusStrip:    { sec: 'Menus & Toolbars', icon: '▁', w: 0,   h: 22,  text: '',            props: ['Items', 'BackColor', 'SizingGrip'], events: ['ItemClicked'], defaultEvent: 'ItemClicked' },
        // ---- Data
        DataGridView:   { sec: 'Data', icon: '▦', w: 240, h: 150, text: '',            props: ['ReadOnly', 'AllowUserToAddRows', 'AllowUserToDeleteRows', 'MultiSelect', 'RowHeadersVisible'], events: ['CellClick', 'CellValueChanged', 'SelectionChanged'], defaultEvent: 'CellClick' }
    };

    /** Controls whose Items collection holds plain values ("object[]"). */
    const WF_OBJECT_ITEM_TYPES = ['ListBox', 'ComboBox', 'CheckedListBox', 'DomainUpDown'];

    /**
     * Non-visual components — shown in the component tray below the form,
     * exactly like the Visual Studio designer. `ctor` says whether the
     * generated constructor takes the components IContainer.
     */
    const WF_TRAY = {
        // ---- Components
        Timer:               { sec: 'Components', icon: '⏱', ctor: 'components', props: ['Interval', 'Enabled'], events: ['Tick'], defaultEvent: 'Tick' },
        ToolTip:             { sec: 'Components', icon: '💬', ctor: 'components', props: ['AutomaticDelay', 'InitialDelay', 'ReshowDelay', 'ShowAlways'], events: ['Popup'], defaultEvent: 'Popup' },
        ContextMenuStrip:    { sec: 'Components', icon: '≣', ctor: 'components', props: ['Items'], events: ['Opening', 'ItemClicked'], defaultEvent: 'Opening' },
        NotifyIcon:          { sec: 'Components', icon: '🔔', ctor: 'components', props: ['Text', 'Icon', 'Visible', 'BalloonTipTitle', 'BalloonTipText'], events: ['Click', 'DoubleClick', 'MouseClick'], defaultEvent: 'DoubleClick' },
        BackgroundWorker:    { sec: 'Components', icon: '⚙', ctor: '', ns: 'System.ComponentModel', props: ['WorkerReportsProgress', 'WorkerSupportsCancellation'], events: ['DoWork', 'ProgressChanged', 'RunWorkerCompleted'], defaultEvent: 'DoWork' },
        ImageList:           { sec: 'Components', icon: '🖼', ctor: 'components', props: ['ColorDepth', 'TransparentColor'], events: [], defaultEvent: 'Disposed' },
        ErrorProvider:       { sec: 'Components', icon: '⚠', ctor: 'components', props: ['BlinkRate'], events: [], defaultEvent: 'Disposed' },
        HelpProvider:        { sec: 'Components', icon: '❓', ctor: '',           props: ['HelpNamespace'], events: [], defaultEvent: 'Disposed' },
        BindingSource:       { sec: 'Components', icon: '🔗', ctor: 'components', props: ['DataMember'], events: ['CurrentChanged'], defaultEvent: 'CurrentChanged' },
        FileSystemWatcher:   { sec: 'Components', icon: '👁', ctor: '', ns: 'System.IO', props: ['Path', 'Filter', 'IncludeSubdirectories', 'EnableRaisingEvents'], events: ['Changed', 'Created', 'Deleted', 'Renamed'], defaultEvent: 'Changed' },
        Process:             { sec: 'Components', icon: '⚡', ctor: '', ns: 'System.Diagnostics', props: ['EnableRaisingEvents'], events: ['Exited'], defaultEvent: 'Exited' },
        // ---- Dialogs
        OpenFileDialog:      { sec: 'Dialogs', icon: '📂', ctor: '',           props: ['Title', 'Filter', 'FileName', 'DefaultExt', 'InitialDirectory', 'Multiselect'], events: ['FileOk'], defaultEvent: 'FileOk' },
        SaveFileDialog:      { sec: 'Dialogs', icon: '💾', ctor: '',           props: ['Title', 'Filter', 'FileName', 'DefaultExt', 'InitialDirectory'], events: ['FileOk'], defaultEvent: 'FileOk' },
        FolderBrowserDialog: { sec: 'Dialogs', icon: '🗂', ctor: '',           props: ['Description', 'SelectedPath'], events: [], defaultEvent: 'HelpRequest' },
        ColorDialog:         { sec: 'Dialogs', icon: '🎨', ctor: '',           props: ['AllowFullOpen', 'FullOpen'], events: [], defaultEvent: 'HelpRequest' },
        FontDialog:          { sec: 'Dialogs', icon: '🅵', ctor: '',           props: ['ShowColor', 'ShowEffects'], events: [], defaultEvent: 'HelpRequest' },
        // ---- Printing
        PrintDialog:         { sec: 'Printing', icon: '🖨', ctor: '',           props: ['AllowSomePages', 'UseEXDialog'], events: [], defaultEvent: 'HelpRequest' },
        PrintDocument:       { sec: 'Printing', icon: '📄', ctor: '', ns: 'System.Drawing.Printing', props: ['DocumentName'], events: ['PrintPage', 'BeginPrint', 'EndPrint'], defaultEvent: 'PrintPage' },
        PrintPreviewDialog:  { sec: 'Printing', icon: '🔍', ctor: '',           props: [], events: ['Load'], defaultEvent: 'Load' },
        PageSetupDialog:     { sec: 'Printing', icon: '📐', ctor: '',           props: ['AllowMargins', 'AllowOrientation', 'AllowPaper'], events: [], defaultEvent: 'HelpRequest' }
    };

    /** Item type generated for each strip's Items collection. */
    const WF_STRIP_ITEM_TYPES = {
        MenuStrip: 'ToolStripMenuItem',
        ContextMenuStrip: 'ToolStripMenuItem',
        StatusStrip: 'ToolStripStatusLabel',
        ToolStrip: 'ToolStripButton'
    };

    /** Delegate + args types for WinForms events that are not plain EventHandler. */
    const WF_EVENT_TYPES = {
        KeyDown:          { handler: 'System.Windows.Forms.KeyEventHandler', args: 'KeyEventArgs' },
        KeyUp:            { handler: 'System.Windows.Forms.KeyEventHandler', args: 'KeyEventArgs' },
        KeyPress:         { handler: 'System.Windows.Forms.KeyPressEventHandler', args: 'KeyPressEventArgs' },
        MouseDown:        { handler: 'System.Windows.Forms.MouseEventHandler', args: 'MouseEventArgs' },
        MouseUp:          { handler: 'System.Windows.Forms.MouseEventHandler', args: 'MouseEventArgs' },
        MouseMove:        { handler: 'System.Windows.Forms.MouseEventHandler', args: 'MouseEventArgs' },
        CellClick:        { handler: 'System.Windows.Forms.DataGridViewCellEventHandler', args: 'DataGridViewCellEventArgs' },
        CellValueChanged: { handler: 'System.Windows.Forms.DataGridViewCellEventHandler', args: 'DataGridViewCellEventArgs' },
        FormClosing:      { handler: 'System.Windows.Forms.FormClosingEventHandler', args: 'FormClosingEventArgs' },
        AfterSelect:      { handler: 'System.Windows.Forms.TreeViewEventHandler', args: 'TreeViewEventArgs' },
        LinkClicked:      { handler: 'System.Windows.Forms.LinkLabelLinkClickedEventHandler', args: 'LinkLabelLinkClickedEventArgs' },
        Paint:            { handler: 'System.Windows.Forms.PaintEventHandler', args: 'PaintEventArgs' },
        MouseClick:       { handler: 'System.Windows.Forms.MouseEventHandler', args: 'MouseEventArgs' },
        ItemClicked:      { handler: 'System.Windows.Forms.ToolStripItemClickedEventHandler', args: 'ToolStripItemClickedEventArgs' },
        Opening:          { handler: 'System.ComponentModel.CancelEventHandler', args: 'System.ComponentModel.CancelEventArgs' },
        FileOk:           { handler: 'System.ComponentModel.CancelEventHandler', args: 'System.ComponentModel.CancelEventArgs' },
        DoWork:           { handler: 'System.ComponentModel.DoWorkEventHandler', args: 'System.ComponentModel.DoWorkEventArgs' },
        ProgressChanged:  { handler: 'System.ComponentModel.ProgressChangedEventHandler', args: 'System.ComponentModel.ProgressChangedEventArgs' },
        RunWorkerCompleted: { handler: 'System.ComponentModel.RunWorkerCompletedEventHandler', args: 'System.ComponentModel.RunWorkerCompletedEventArgs' },
        ItemCheck:        { handler: 'System.Windows.Forms.ItemCheckEventHandler', args: 'ItemCheckEventArgs' },
        DateChanged:      { handler: 'System.Windows.Forms.DateRangeEventHandler', args: 'DateRangeEventArgs' },
        SplitterMoved:    { handler: 'System.Windows.Forms.SplitterEventHandler', args: 'SplitterEventArgs' },
        PrintPage:        { handler: 'System.Drawing.Printing.PrintPageEventHandler', args: 'System.Drawing.Printing.PrintPageEventArgs' },
        BeginPrint:       { handler: 'System.Drawing.Printing.PrintEventHandler', args: 'System.Drawing.Printing.PrintEventArgs' },
        EndPrint:         { handler: 'System.Drawing.Printing.PrintEventHandler', args: 'System.Drawing.Printing.PrintEventArgs' },
        Changed:          { handler: 'System.IO.FileSystemEventHandler', args: 'System.IO.FileSystemEventArgs' },
        Created:          { handler: 'System.IO.FileSystemEventHandler', args: 'System.IO.FileSystemEventArgs' },
        Deleted:          { handler: 'System.IO.FileSystemEventHandler', args: 'System.IO.FileSystemEventArgs' },
        Renamed:          { handler: 'System.IO.RenamedEventHandler', args: 'System.IO.RenamedEventArgs' },
        DocumentCompleted: { handler: 'System.Windows.Forms.WebBrowserDocumentCompletedEventHandler', args: 'WebBrowserDocumentCompletedEventArgs' },
        Navigated:        { handler: 'System.Windows.Forms.WebBrowserNavigatedEventHandler', args: 'WebBrowserNavigatedEventArgs' },
        PropertyValueChanged: { handler: 'System.Windows.Forms.PropertyValueChangedEventHandler', args: 'PropertyValueChangedEventArgs' }
    };
    const WF_DEFAULT_EVENT_TYPE = { handler: 'System.EventHandler', args: 'EventArgs' };

    /** Per-type overrides where the same event name uses a different delegate. */
    const WF_EVENT_TYPE_OVERRIDES = {
        // ScrollBar.Scroll is ScrollEventHandler; TrackBar.Scroll is plain EventHandler.
        HScrollBar: { Scroll: { handler: 'System.Windows.Forms.ScrollEventHandler', args: 'ScrollEventArgs' } },
        VScrollBar: { Scroll: { handler: 'System.Windows.Forms.ScrollEventHandler', args: 'ScrollEventArgs' } }
    };

    const WF_FORM_EVENTS = ['Load', 'Shown', 'FormClosing', 'Resize', 'KeyDown'];
    const WF_CONTAINERS = ['GroupBox', 'Panel', 'TabPage', 'FlowLayoutPanel', 'TableLayoutPanel', 'SplitContainer'];

    // ---------------------------------------------------- wf property catalog
    //
    // Visual Studio-style property grid metadata. Every property the grid can
    // edit is described once: category, editor kind, enum values, default
    // (shown greyed when the Designer.cs does not set the property), and the
    // description shown in the help pane at the bottom of the panel.

    /** Enum member lists, keyed by .NET enum type name. */
    const WF_ENUM_VALUES = {
        DockStyle: ['None', 'Top', 'Bottom', 'Left', 'Right', 'Fill'],
        FlatStyle: ['Flat', 'Popup', 'Standard', 'System'],
        ContentAlignment: ['TopLeft', 'TopCenter', 'TopRight', 'MiddleLeft', 'MiddleCenter', 'MiddleRight', 'BottomLeft', 'BottomCenter', 'BottomRight'],
        HorizontalAlignment: ['Left', 'Right', 'Center'],
        BorderStyle: ['None', 'FixedSingle', 'Fixed3D'],
        RightToLeft: ['No', 'Yes', 'Inherit'],
        DialogResult: ['None', 'OK', 'Cancel', 'Abort', 'Retry', 'Ignore', 'Yes', 'No'],
        AutoSizeMode: ['GrowOnly', 'GrowAndShrink'],
        ComboBoxStyle: ['Simple', 'DropDown', 'DropDownList'],
        PictureBoxSizeMode: ['Normal', 'StretchImage', 'AutoSize', 'CenterImage', 'Zoom'],
        ProgressBarStyle: ['Blocks', 'Continuous', 'Marquee'],
        Orientation: ['Horizontal', 'Vertical'],
        ScrollBars: ['None', 'Horizontal', 'Vertical', 'Both'],
        RichTextBoxScrollBars: ['None', 'Horizontal', 'Vertical', 'Both', 'ForcedHorizontal', 'ForcedVertical', 'ForcedBoth'],
        CharacterCasing: ['Normal', 'Upper', 'Lower'],
        SelectionMode: ['None', 'One', 'MultiSimple', 'MultiExtended'],
        View: ['LargeIcon', 'Details', 'SmallIcon', 'List', 'Tile'],
        DateTimePickerFormat: ['Long', 'Short', 'Time', 'Custom'],
        TextImageRelation: ['Overlay', 'ImageAboveText', 'TextAboveImage', 'ImageBeforeText', 'TextBeforeImage'],
        ImageLayout: ['None', 'Tile', 'Center', 'Stretch', 'Zoom'],
        TabAlignment: ['Top', 'Bottom', 'Left', 'Right'],
        ToolStripGripStyle: ['Hidden', 'Visible'],
        FlowDirection: ['LeftToRight', 'TopDown', 'RightToLeft', 'BottomUp'],
        TableLayoutPanelCellBorderStyle: ['None', 'Single', 'Inset', 'InsetDouble', 'Outset', 'OutsetDouble', 'OutsetPartial'],
        PropertySort: ['NoSort', 'Alphabetical', 'Categorized', 'CategorizedAlphabetical'],
        ColorDepth: ['Depth4Bit', 'Depth8Bit', 'Depth16Bit', 'Depth24Bit', 'Depth32Bit'],
        FormBorderStyle: ['None', 'FixedSingle', 'Fixed3D', 'FixedDialog', 'Sizable', 'FixedToolWindow', 'SizableToolWindow'],
        FormStartPosition: ['Manual', 'CenterScreen', 'WindowsDefaultLocation', 'WindowsDefaultBounds', 'CenterParent'],
        FormWindowState: ['Normal', 'Minimized', 'Maximized'],
        Cursors: ['Default', 'AppStarting', 'Arrow', 'Cross', 'Hand', 'Help', 'HSplit', 'IBeam', 'No', 'SizeAll', 'SizeNESW', 'SizeNS', 'SizeNWSE', 'SizeWE', 'UpArrow', 'VSplit', 'WaitCursor'],
        AccessibleRole: ['Default', 'None', 'TitleBar', 'MenuBar', 'ScrollBar', 'Grip', 'Sound', 'Cursor', 'Caret', 'Alert', 'Window', 'Client', 'MenuPopup', 'MenuItem', 'ToolTip', 'Application', 'Document', 'Pane', 'Chart', 'Dialog', 'Border', 'Grouping', 'Separator', 'ToolBar', 'StatusBar', 'Table', 'ColumnHeader', 'RowHeader', 'Column', 'Row', 'Cell', 'Link', 'HelpBalloon', 'Character', 'List', 'ListItem', 'Outline', 'OutlineItem', 'PageTab', 'PropertyPage', 'Indicator', 'Graphic', 'StaticText', 'Text', 'PushButton', 'CheckButton', 'RadioButton', 'ComboBox', 'DropList', 'ProgressBar', 'Dial', 'HotkeyField', 'Slider', 'SpinButton', 'Diagram', 'Animation', 'Equation', 'ButtonDropDown', 'ButtonMenu', 'ButtonDropDownGrid', 'WhiteSpace', 'PageTabList', 'Clock', 'SplitButton', 'IpAddress', 'OutlineButton']
    };

    /** System.Drawing.SystemColors member names (canonical casing). */
    const WF_SYSTEM_COLOR_NAMES = ['ActiveBorder', 'ActiveCaption', 'ActiveCaptionText', 'AppWorkspace',
        'ButtonFace', 'ButtonHighlight', 'ButtonShadow', 'Control', 'ControlDark', 'ControlDarkDark',
        'ControlLight', 'ControlLightLight', 'ControlText', 'Desktop', 'GradientActiveCaption',
        'GradientInactiveCaption', 'GrayText', 'Highlight', 'HighlightText', 'HotTrack', 'InactiveBorder',
        'InactiveCaption', 'InactiveCaptionText', 'Info', 'InfoText', 'Menu', 'MenuBar', 'MenuHighlight',
        'MenuText', 'ScrollBar', 'Window', 'WindowFrame', 'WindowText'];

    /** System.Drawing.Color named members offered in the color datalist. */
    const WF_NAMED_COLORS = ['Transparent', 'AliceBlue', 'AntiqueWhite', 'Aqua', 'Aquamarine', 'Azure', 'Beige',
        'Bisque', 'Black', 'BlanchedAlmond', 'Blue', 'BlueViolet', 'Brown', 'BurlyWood', 'CadetBlue',
        'Chartreuse', 'Chocolate', 'Coral', 'CornflowerBlue', 'Cornsilk', 'Crimson', 'Cyan', 'DarkBlue',
        'DarkCyan', 'DarkGoldenrod', 'DarkGray', 'DarkGreen', 'DarkKhaki', 'DarkMagenta', 'DarkOliveGreen',
        'DarkOrange', 'DarkOrchid', 'DarkRed', 'DarkSalmon', 'DarkSeaGreen', 'DarkSlateBlue', 'DarkSlateGray',
        'DarkTurquoise', 'DarkViolet', 'DeepPink', 'DeepSkyBlue', 'DimGray', 'DodgerBlue', 'Firebrick',
        'FloralWhite', 'ForestGreen', 'Fuchsia', 'Gainsboro', 'GhostWhite', 'Gold', 'Goldenrod', 'Gray',
        'Green', 'GreenYellow', 'Honeydew', 'HotPink', 'IndianRed', 'Indigo', 'Ivory', 'Khaki', 'Lavender',
        'LavenderBlush', 'LawnGreen', 'LemonChiffon', 'LightBlue', 'LightCoral', 'LightCyan',
        'LightGoldenrodYellow', 'LightGray', 'LightGreen', 'LightPink', 'LightSalmon', 'LightSeaGreen',
        'LightSkyBlue', 'LightSlateGray', 'LightSteelBlue', 'LightYellow', 'Lime', 'LimeGreen', 'Linen',
        'Magenta', 'Maroon', 'MediumAquamarine', 'MediumBlue', 'MediumOrchid', 'MediumPurple',
        'MediumSeaGreen', 'MediumSlateBlue', 'MediumSpringGreen', 'MediumTurquoise', 'MediumVioletRed',
        'MidnightBlue', 'MintCream', 'MistyRose', 'Moccasin', 'NavajoWhite', 'Navy', 'OldLace', 'Olive',
        'OliveDrab', 'Orange', 'OrangeRed', 'Orchid', 'PaleGoldenrod', 'PaleGreen', 'PaleTurquoise',
        'PaleVioletRed', 'PapayaWhip', 'PeachPuff', 'Peru', 'Pink', 'Plum', 'PowderBlue', 'Purple', 'Red',
        'RosyBrown', 'RoyalBlue', 'SaddleBrown', 'Salmon', 'SandyBrown', 'SeaGreen', 'SeaShell', 'Sienna',
        'Silver', 'SkyBlue', 'SlateBlue', 'SlateGray', 'Snow', 'SpringGreen', 'SteelBlue', 'Tan', 'Teal',
        'Thistle', 'Tomato', 'Turquoise', 'Violet', 'Wheat', 'White', 'WhiteSmoke', 'Yellow', 'YellowGreen'];

    /**
     * Property descriptors: { cat, kind, enum?, def?, desc }.
     * kind: string | bool | int | float | decimal | char | enum | ref |
     *       anchor | color | font | padding | size | point | name
     */
    const WF_PROP_DEFS = {
        // Design
        Name:                  { cat: 'Design', kind: 'name', desc: 'Indicates the name used in code to identify the object.' },
        // Layout
        Anchor:                { cat: 'Layout', kind: 'anchor', def: 'Top, Left', desc: 'Defines the edges of the container to which the control is bound. Anchored edges keep their distance when the parent resizes.' },
        Dock:                  { cat: 'Layout', kind: 'enum', enum: 'DockStyle', def: 'None', desc: 'Defines which borders of the control are bound to the container.' },
        Location:              { cat: 'Layout', kind: 'point', desc: 'The coordinates of the upper-left corner of the control relative to its container.' },
        Size:                  { cat: 'Layout', kind: 'size', desc: 'The size of the control in pixels.' },
        ClientSize:            { cat: 'Layout', kind: 'size', desc: 'The size of the client area of the form (excluding title bar and borders).' },
        MinimumSize:           { cat: 'Layout', kind: 'size', def: '0, 0', desc: 'The minimum size the control can be resized to.' },
        MaximumSize:           { cat: 'Layout', kind: 'size', def: '0, 0', desc: 'The maximum size the control can be resized to (0, 0 means unlimited).' },
        Margin:                { cat: 'Layout', kind: 'padding', def: '3, 3, 3, 3', desc: 'The space between this control and neighbouring controls (left, top, right, bottom).' },
        Padding:               { cat: 'Layout', kind: 'padding', def: '0, 0, 0, 0', desc: 'The interior spacing between the control edge and its content (left, top, right, bottom).' },
        AutoSize:              { cat: 'Layout', kind: 'bool', def: 'False', desc: 'Enables automatic resizing based on the control contents.' },
        AutoSizeMode:          { cat: 'Layout', kind: 'enum', enum: 'AutoSizeMode', def: 'GrowOnly', desc: 'Whether the control can only grow, or grow and shrink, when AutoSize is enabled.' },
        AutoScroll:            { cat: 'Layout', kind: 'bool', def: 'False', desc: 'Shows scroll bars when the content is larger than the visible area.' },
        StartPosition:         { cat: 'Layout', kind: 'enum', enum: 'FormStartPosition', def: 'WindowsDefaultLocation', desc: 'The starting position of the form at run time.' },
        WindowState:           { cat: 'Layout', kind: 'enum', enum: 'FormWindowState', def: 'Normal', desc: 'Whether the form starts minimized, maximized, or normal.' },
        // Appearance
        Text:                  { cat: 'Appearance', kind: 'string', desc: 'The text associated with the control.' },
        PlaceholderText:       { cat: 'Appearance', kind: 'string', desc: 'The hint text shown while the text box is empty (.NET 5+).' },
        TextAlign:             { cat: 'Appearance', kind: 'enum', enum: 'ContentAlignment', desc: 'The alignment of the text within the control.' },
        CheckAlign:            { cat: 'Appearance', kind: 'enum', enum: 'ContentAlignment', def: 'MiddleLeft', desc: 'The position of the check box within the control.' },
        BackColor:             { cat: 'Appearance', kind: 'color', desc: 'The background color of the control.' },
        ForeColor:             { cat: 'Appearance', kind: 'color', desc: 'The foreground color used to display text.' },
        LinkColor:             { cat: 'Appearance', kind: 'color', desc: 'The color of the link text.' },
        Font:                  { cat: 'Appearance', kind: 'font', def: 'Segoe UI, 9pt', desc: 'The font used to display text in the control. Format: Family, 9pt, style=Bold, Italic.' },
        Cursor:                { cat: 'Appearance', kind: 'enum', enum: 'Cursors', prefix: 'System.Windows.Forms.Cursors', def: 'Default', desc: 'The cursor shown when the mouse pointer is over the control.' },
        Image:                 { cat: 'Appearance', kind: 'image', desc: 'The image displayed on the control. Importing copies the file into the project Resources folder and registers it in Properties/Resources.resx — .png, .jpg, .gif, .bmp, .ico.' },
        ImageAlign:            { cat: 'Appearance', kind: 'enum', enum: 'ContentAlignment', def: 'MiddleCenter', desc: 'The alignment of the image within the control.' },
        TextImageRelation:     { cat: 'Appearance', kind: 'enum', enum: 'TextImageRelation', def: 'Overlay', desc: 'The relative placement of the text and the image: overlaid, image above/below the text, or image before/after it.' },
        BackgroundImage:       { cat: 'Appearance', kind: 'image', desc: 'The background image drawn behind the control content. Imported into the project Resources folder.' },
        BackgroundImageLayout: { cat: 'Appearance', kind: 'enum', enum: 'ImageLayout', def: 'Tile', desc: 'How the background image is drawn: None (top-left), Tile, Center, Stretch, or Zoom.' },
        Icon:                  { cat: 'Window Style', kind: 'icon', desc: 'The window icon (.ico) shown in the title bar and the taskbar. Imported into the project Resources folder.' },
        FlatStyle:             { cat: 'Appearance', kind: 'enum', enum: 'FlatStyle', def: 'Standard', desc: 'The flat style appearance of the control.' },
        BorderStyle:           { cat: 'Appearance', kind: 'enum', enum: 'BorderStyle', def: 'None', desc: 'The border style of the control.' },
        FormBorderStyle:       { cat: 'Appearance', kind: 'enum', enum: 'FormBorderStyle', def: 'Sizable', desc: 'The border style of the form: sizable, fixed, tool window, or none.' },
        RightToLeft:           { cat: 'Appearance', kind: 'enum', enum: 'RightToLeft', def: 'No', desc: 'Renders text right-to-left for RTL languages.' },
        UseMnemonic:           { cat: 'Appearance', kind: 'bool', def: 'True', desc: 'Treats "&" in Text as an access-key prefix character.' },
        UseVisualStyleBackColor: { cat: 'Appearance', kind: 'bool', def: 'True', desc: 'Uses the current visual style for the background instead of BackColor.' },
        UseWaitCursor:         { cat: 'Appearance', kind: 'bool', def: 'False', desc: 'Shows the wait cursor for the control and its children.' },
        Checked:               { cat: 'Appearance', kind: 'bool', def: 'False', desc: 'Whether the control is checked.' },
        ThreeState:            { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Allows the check box to show an indeterminate third state.' },
        GridLines:             { cat: 'Appearance', kind: 'bool', def: 'False', desc: 'Draws grid lines between items and subitems.' },
        ShowLines:             { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Draws lines between sibling and parent/child nodes.' },
        ShowRootLines:         { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Draws lines between root nodes.' },
        SizeMode:              { cat: 'Behavior', kind: 'enum', enum: 'PictureBoxSizeMode', def: 'Normal', desc: 'Controls how the image is positioned and scaled within the control.' },
        View:                  { cat: 'Appearance', kind: 'enum', enum: 'View', def: 'LargeIcon', desc: 'How items are displayed: large icons, details, small icons, list, or tiles.' },
        Style:                 { cat: 'Appearance', kind: 'enum', enum: 'ProgressBarStyle', def: 'Blocks', desc: 'Whether the bar shows blocks, a continuous fill, or a marquee animation.' },
        // Behavior
        Enabled:               { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Whether the control can respond to user interaction.' },
        Visible:               { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Whether the control is displayed at run time.' },
        TabIndex:              { cat: 'Behavior', kind: 'int', desc: 'The position of the control in the tab order of its container.' },
        TabStop:               { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Whether the user can focus the control with the Tab key.' },
        AllowDrop:             { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Whether the control accepts data the user drags onto it.' },
        AutoEllipsis:          { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Shows "…" when the text does not fit, with the full text as a tooltip.' },
        UseCompatibleTextRendering: { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Uses GDI+ (legacy) text rendering instead of GDI.' },
        DialogResult:          { cat: 'Behavior', kind: 'enum', enum: 'DialogResult', def: 'None', desc: 'The value returned to the parent form when the button is clicked.' },
        ReadOnly:              { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Whether the text can be changed by the user.' },
        Multiline:             { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Whether the text can span more than one line.' },
        WordWrap:              { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Wraps lines at the control edge in multiline mode.' },
        MaxLength:             { cat: 'Behavior', kind: 'int', def: '32767', desc: 'The maximum number of characters the user can type.' },
        PasswordChar:          { cat: 'Behavior', kind: 'char', desc: 'The character shown in place of typed characters (password masking).' },
        CharacterCasing:       { cat: 'Behavior', kind: 'enum', enum: 'CharacterCasing', def: 'Normal', desc: 'Forces typed characters to upper or lower case.' },
        ScrollBars:            { cat: 'Appearance', kind: 'enum', enum: 'ScrollBars', def: 'None', desc: 'Which scroll bars appear in multiline mode.' },
        Mask:                  { cat: 'Behavior', kind: 'string', desc: 'The input mask (e.g. 000-0000 or (999) 000-0000).' },
        DropDownStyle:         { cat: 'Appearance', kind: 'enum', enum: 'ComboBoxStyle', def: 'DropDown', desc: 'Whether the text is editable and whether the list drops down.' },
        MaxDropDownItems:      { cat: 'Behavior', kind: 'int', def: '8', desc: 'The maximum number of items shown in the drop-down list.' },
        Sorted:                { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Sorts the list items alphabetically.' },
        SelectionMode:         { cat: 'Behavior', kind: 'enum', enum: 'SelectionMode', def: 'One', desc: 'How many items can be selected, and how.' },
        MultiColumn:           { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Lays the items out in multiple columns.' },
        FullRowSelect:         { cat: 'Appearance', kind: 'bool', def: 'False', desc: 'Selecting an item selects its entire row.' },
        MultiSelect:           { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Whether multiple items can be selected at once.' },
        CheckBoxes:            { cat: 'Appearance', kind: 'bool', def: 'False', desc: 'Shows a check box next to each item.' },
        AllowUserToAddRows:    { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Shows the new-row placeholder so the user can add rows.' },
        AllowUserToDeleteRows: { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Whether the user can delete rows.' },
        RowHeadersVisible:     { cat: 'Appearance', kind: 'bool', def: 'True', desc: 'Shows the row header column.' },
        Minimum:               { cat: 'Behavior', kind: 'int', def: '0', desc: 'The minimum value of the range.' },
        Maximum:               { cat: 'Behavior', kind: 'int', def: '100', desc: 'The maximum value of the range.' },
        Value:                 { cat: 'Behavior', kind: 'int', def: '0', desc: 'The current value.' },
        TickFrequency:         { cat: 'Appearance', kind: 'int', def: '1', desc: 'The interval between tick marks.' },
        SmallChange:           { cat: 'Behavior', kind: 'int', def: '1', desc: 'The change applied by the arrow keys.' },
        LargeChange:           { cat: 'Behavior', kind: 'int', def: '5', desc: 'The change applied by Page Up / Page Down or clicking the track.' },
        Orientation:           { cat: 'Appearance', kind: 'enum', enum: 'Orientation', def: 'Horizontal', desc: 'Horizontal or vertical orientation.' },
        Increment:             { cat: 'Data', kind: 'decimal', def: '1', desc: 'The amount to add or subtract on each up/down click.' },
        DecimalPlaces:         { cat: 'Data', kind: 'int', def: '0', desc: 'The number of decimal places to display.' },
        ThousandsSeparator:    { cat: 'Data', kind: 'bool', def: 'False', desc: 'Shows a thousands separator when appropriate.' },
        Format:                { cat: 'Appearance', kind: 'enum', enum: 'DateTimePickerFormat', def: 'Long', desc: 'The date/time format: long, short, time, or custom.' },
        CustomFormat:          { cat: 'Behavior', kind: 'string', desc: 'The custom format string used when Format is Custom.' },
        ShowUpDown:            { cat: 'Appearance', kind: 'bool', def: 'False', desc: 'Uses a spin control instead of a drop-down calendar.' },
        // Form behavior / window style
        KeyPreview:            { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'The form receives key events before they reach the focused control.' },
        DoubleBuffered:        { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Redraws via a buffer to reduce flicker.' },
        ControlBox:            { cat: 'Window Style', kind: 'bool', def: 'True', desc: 'Shows the system menu box in the caption bar.' },
        MaximizeBox:           { cat: 'Window Style', kind: 'bool', def: 'True', desc: 'Shows the maximize button in the caption bar.' },
        MinimizeBox:           { cat: 'Window Style', kind: 'bool', def: 'True', desc: 'Shows the minimize button in the caption bar.' },
        HelpButton:            { cat: 'Window Style', kind: 'bool', def: 'False', desc: 'Shows a Help button in the caption bar (needs Min/MaximizeBox off).' },
        ShowIcon:              { cat: 'Window Style', kind: 'bool', def: 'True', desc: 'Shows the form icon in the caption bar.' },
        ShowInTaskbar:         { cat: 'Window Style', kind: 'bool', def: 'True', desc: 'Shows the form in the Windows taskbar.' },
        TopMost:               { cat: 'Window Style', kind: 'bool', def: 'False', desc: 'Keeps the form above all other windows.' },
        Opacity:               { cat: 'Window Style', kind: 'float', def: '1', desc: 'The opacity of the form from 0 (transparent) to 1 (opaque).' },
        AcceptButton:          { cat: 'Misc', kind: 'ref', refType: 'Button', def: '(none)', desc: 'The button clicked when the user presses Enter.' },
        CancelButton:          { cat: 'Misc', kind: 'ref', refType: 'Button', def: '(none)', desc: 'The button clicked when the user presses Esc.' },
        ContextMenuStrip:      { cat: 'Behavior', kind: 'ref', refType: 'ContextMenuStrip', def: '(none)', desc: 'The shortcut menu shown when the user right-clicks the control (add a ContextMenuStrip from the toolbox first).' },
        // Strips & tray components
        Items:                 { cat: 'Data', kind: 'items', desc: 'The items of this strip, one per line. Adding/removing lines creates or deletes the ToolStrip items in the Designer.cs.' },
        SelectedIndex:         { cat: 'Behavior', kind: 'int', def: '0', desc: 'The index of the selected tab page.' },
        Alignment:             { cat: 'Appearance', kind: 'enum', enum: 'TabAlignment', def: 'Top', desc: 'Where the tab headers are drawn.' },
        GripStyle:             { cat: 'Appearance', kind: 'enum', enum: 'ToolStripGripStyle', def: 'Visible', desc: 'Whether the move grip is shown.' },
        SizingGrip:            { cat: 'Appearance', kind: 'bool', def: 'True', desc: 'Shows the resize grip in the corner of the status strip.' },
        Interval:              { cat: 'Behavior', kind: 'int', def: '100', desc: 'The tick frequency in milliseconds.' },
        AutomaticDelay:        { cat: 'Behavior', kind: 'int', def: '500', desc: 'Sets InitialDelay/ReshowDelay from one base delay (ms).' },
        InitialDelay:          { cat: 'Behavior', kind: 'int', def: '500', desc: 'Time the pointer must stay still before the tip shows (ms).' },
        ReshowDelay:           { cat: 'Behavior', kind: 'int', def: '100', desc: 'Delay before subsequent tips show while moving between controls (ms).' },
        ShowAlways:            { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Shows tips even when the parent form is inactive.' },
        BalloonTipTitle:       { cat: 'Appearance', kind: 'string', desc: 'The title of the balloon tip shown by ShowBalloonTip().' },
        BalloonTipText:        { cat: 'Appearance', kind: 'string', desc: 'The text of the balloon tip shown by ShowBalloonTip().' },
        WorkerReportsProgress: { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Whether the worker raises ProgressChanged events.' },
        WorkerSupportsCancellation: { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Whether CancelAsync() is supported.' },
        ColorDepth:            { cat: 'Appearance', kind: 'enum', enum: 'ColorDepth', def: 'Depth8Bit', desc: 'The color depth of the image list.' },
        TransparentColor:      { cat: 'Appearance', kind: 'color', desc: 'The color treated as transparent in the images.' },
        BlinkRate:             { cat: 'Behavior', kind: 'int', def: '250', desc: 'The error icon blink rate in milliseconds.' },
        Title:                 { cat: 'Appearance', kind: 'string', desc: 'The dialog title.' },
        Filter:                { cat: 'Behavior', kind: 'string', desc: 'The file filter, e.g. "Text files|*.txt|All files|*.*".' },
        FileName:              { cat: 'Behavior', kind: 'string', desc: 'The file name pre-selected in the dialog.' },
        DefaultExt:            { cat: 'Behavior', kind: 'string', desc: 'The default extension appended when the user omits one.' },
        InitialDirectory:      { cat: 'Behavior', kind: 'string', desc: 'The directory the dialog starts in.' },
        Multiselect:           { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Whether multiple files can be selected.' },
        Description:           { cat: 'Appearance', kind: 'string', desc: 'The text shown above the folder tree.' },
        SelectedPath:          { cat: 'Behavior', kind: 'string', desc: 'The folder pre-selected in the dialog.' },
        AllowFullOpen:         { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Whether the custom-colors pane may be opened.' },
        FullOpen:              { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Opens with the custom-colors pane visible.' },
        ShowColor:             { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Shows the color choice in the font dialog.' },
        ShowEffects:           { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Shows underline/strikeout/color options.' },
        // New-control specifics
        CheckOnClick:          { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Toggles the check mark on the first click instead of requiring a second click.' },
        ThreeDCheckBoxes:      { cat: 'Appearance', kind: 'bool', def: 'False', desc: 'Draws the check boxes with a 3-D look.' },
        Wrap:                  { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Wraps around to the first item when scrolling past the last one.' },
        FlowDirection:         { cat: 'Layout', kind: 'enum', enum: 'FlowDirection', def: 'LeftToRight', desc: 'The direction in which child controls flow.' },
        WrapContents:          { cat: 'Layout', kind: 'bool', def: 'True', desc: 'Wraps child controls to the next row/column when they no longer fit.' },
        ColumnCount:           { cat: 'Layout', kind: 'int', def: '0', desc: 'The number of columns in the table layout.' },
        RowCount:              { cat: 'Layout', kind: 'int', def: '0', desc: 'The number of rows in the table layout.' },
        CellBorderStyle:       { cat: 'Appearance', kind: 'enum', enum: 'TableLayoutPanelCellBorderStyle', def: 'None', desc: 'The style of the border lines drawn between cells.' },
        SplitterDistance:      { cat: 'Layout', kind: 'int', def: '50', desc: 'The distance in pixels from the left/top edge to the splitter.' },
        SplitterWidth:         { cat: 'Layout', kind: 'int', def: '4', desc: 'The thickness of the splitter in pixels.' },
        IsSplitterFixed:       { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Prevents the user from moving the splitter.' },
        MinExtra:              { cat: 'Behavior', kind: 'int', def: '25', desc: 'The minimum size of the area left for the other controls.' },
        MinSize:               { cat: 'Behavior', kind: 'int', def: '25', desc: 'The minimum size of the docked control being resized.' },
        ShowToday:             { cat: 'Appearance', kind: 'bool', def: 'True', desc: 'Shows today’s date at the bottom of the calendar.' },
        ShowTodayCircle:       { cat: 'Appearance', kind: 'bool', def: 'True', desc: 'Circles today’s date on the calendar.' },
        ShowWeekNumbers:       { cat: 'Appearance', kind: 'bool', def: 'False', desc: 'Shows the week number next to each row of dates.' },
        MaxSelectionCount:     { cat: 'Behavior', kind: 'int', def: '7', desc: 'The maximum number of days that can be selected at once.' },
        AllowNavigation:       { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Whether the browser can navigate to another page after the first load.' },
        ScriptErrorsSuppressed: { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Hides script error dialogs raised by pages.' },
        HelpVisible:           { cat: 'Appearance', kind: 'bool', def: 'True', desc: 'Shows the description pane at the bottom of the grid.' },
        ToolbarVisible:        { cat: 'Appearance', kind: 'bool', def: 'True', desc: 'Shows the toolbar at the top of the grid.' },
        PropertySort:          { cat: 'Appearance', kind: 'enum', enum: 'PropertySort', def: 'CategorizedAlphabetical', desc: 'How the grid sorts the displayed properties.' },
        HelpNamespace:         { cat: 'Behavior', kind: 'string', desc: 'The path to the .chm/.html help file the provider serves.' },
        DataMember:            { cat: 'Data', kind: 'string', desc: 'The list within the data source this BindingSource binds to.' },
        Path:                  { cat: 'Behavior', kind: 'string', desc: 'The directory to watch for changes.' },
        IncludeSubdirectories: { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Also watches all subdirectories of Path.' },
        EnableRaisingEvents:   { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Whether the component raises its events.' },
        DocumentName:          { cat: 'Design', kind: 'string', desc: 'The document name shown in the printer queue.' },
        AllowSomePages:        { cat: 'Behavior', kind: 'bool', def: 'False', desc: 'Enables the page-range radio buttons in the dialog.' },
        UseEXDialog:           { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Uses the modern Windows print dialog (required on 64-bit).' },
        AllowMargins:          { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Enables the margins section of the dialog.' },
        AllowOrientation:      { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Enables the orientation section of the dialog.' },
        AllowPaper:            { cat: 'Behavior', kind: 'bool', def: 'True', desc: 'Enables the paper size/source section of the dialog.' },
        // Data / Focus / Accessibility
        Tag:                   { cat: 'Data', kind: 'string', desc: 'User-defined data associated with the object.' },
        CausesValidation:      { cat: 'Focus', kind: 'bool', def: 'True', desc: 'Whether the control triggers validation on controls losing focus to it.' },
        AccessibleName:        { cat: 'Accessibility', kind: 'string', desc: 'The name reported to accessibility client applications.' },
        AccessibleDescription: { cat: 'Accessibility', kind: 'string', desc: 'The description reported to accessibility client applications.' },
        AccessibleRole:        { cat: 'Accessibility', kind: 'enum', enum: 'AccessibleRole', def: 'Default', desc: 'The role reported to accessibility client applications.' }
    };

    /** Items editor for controls whose Items hold plain strings (object[]). */
    const WF_OBJ_ITEMS_DEF = { cat: 'Data', kind: 'items-obj', desc: 'The items of the list, one per line. Lines are written to the Designer.cs as Items.AddRange(new object[] { ... }).' };

    /** Per-type descriptor overrides (same property name, different type). */
    const WF_PROP_OVERRIDES = {
        ListBox:        { Items: WF_OBJ_ITEMS_DEF },
        ComboBox:       { Items: WF_OBJ_ITEMS_DEF },
        CheckedListBox: { Items: WF_OBJ_ITEMS_DEF },
        DomainUpDown:   { Items: WF_OBJ_ITEMS_DEF },
        TextBox:        { TextAlign: { cat: 'Appearance', kind: 'enum', enum: 'HorizontalAlignment', def: 'Left', desc: 'The horizontal alignment of the text.' } },
        MaskedTextBox:  { TextAlign: { cat: 'Appearance', kind: 'enum', enum: 'HorizontalAlignment', def: 'Left', desc: 'The horizontal alignment of the text.' } },
        NumericUpDown:  {
            TextAlign: { cat: 'Appearance', kind: 'enum', enum: 'HorizontalAlignment', def: 'Left', desc: 'The horizontal alignment of the value.' },
            Minimum:   { cat: 'Data', kind: 'decimal', def: '0', desc: 'The minimum allowed value.' },
            Maximum:   { cat: 'Data', kind: 'decimal', def: '100', desc: 'The maximum allowed value.' },
            Value:     { cat: 'Appearance', kind: 'decimal', def: '0', desc: 'The current value.' }
        },
        RichTextBox:    { ScrollBars: { cat: 'Appearance', kind: 'enum', enum: 'RichTextBoxScrollBars', def: 'Both', desc: 'Which scroll bars appear when text does not fit.' } },
        Label:          { TextAlign: { cat: 'Appearance', kind: 'enum', enum: 'ContentAlignment', def: 'TopLeft', desc: 'The alignment of the text within the control.' } },
        Button:         { TextAlign: { cat: 'Appearance', kind: 'enum', enum: 'ContentAlignment', def: 'MiddleCenter', desc: 'The alignment of the text within the control.' } },
        Form:           { AutoSize: { cat: 'Layout', kind: 'bool', def: 'False', desc: 'The form grows to fit its contents.' } }
    };

    /** Properties every control shows in addition to its type-specific list. */
    const WF_COMMON_PROPS = ['Anchor', 'Dock', 'Location', 'Size', 'MinimumSize', 'MaximumSize', 'Margin',
        'Padding', 'AutoSize', 'BackColor', 'ForeColor', 'Font', 'Cursor', 'RightToLeft', 'Enabled',
        'Visible', 'TabIndex', 'TabStop', 'AllowDrop', 'UseWaitCursor', 'Tag', 'CausesValidation',
        'AccessibleName', 'AccessibleDescription', 'AccessibleRole'];

    /** Properties shown for the form itself. */
    const WF_FORM_PROPS = ['Text', 'ClientSize', 'StartPosition', 'FormBorderStyle', 'WindowState',
        'MinimumSize', 'MaximumSize', 'AutoSize', 'Padding', 'BackColor', 'ForeColor', 'Font', 'Cursor',
        'RightToLeft', 'Icon', 'BackgroundImage', 'BackgroundImageLayout', 'ControlBox', 'MaximizeBox',
        'MinimizeBox', 'HelpButton', 'ShowIcon', 'ShowInTaskbar', 'TopMost', 'Opacity', 'KeyPreview',
        'DoubleBuffered', 'Enabled', 'AllowDrop', 'UseWaitCursor', 'AcceptButton', 'CancelButton', 'Tag',
        'AccessibleName', 'AccessibleDescription', 'AccessibleRole'];

    function wfPropDef(type, prop) {
        return WF_PROP_OVERRIDES[type]?.[prop] ?? WF_PROP_DEFS[prop] ?? { cat: 'Misc', kind: 'string' };
    }

    // ------------------------------------------------------------- wf parsing

    function wfParseAndRender() {
        wfControls = new Map();
        const text = xamlText;

        // Parsing is deliberately permissive across BOTH generated dialects
        // and languages: "this." or "Me." receivers, "new"/"New", optional
        // trailing semicolons. Generation is exact per language (see wfCode).
        const cls = wfLang === 'vb'
            ? /\bPartial\s+(?:Public\s+|Friend\s+)?Class\s+(\w+)/i.exec(text)
            : /partial\s+class\s+(\w+)/.exec(text);
        wfForm = { __wf: true, name: cls ? cls[1] : 'Form', type: 'Form', props: {}, events: {}, children: [] };

        if (!wfInitializeComponentBody(text)) {
            // Not a designable form — hand the file straight to the text editor.
            showBanner('No InitializeComponent method found — this file has no form layout to design. Opening the code view…');
            renderEmpty();
            vscode.postMessage({ type: 'noDesign' });
            return;
        }

        // The generated code comes in two dialects. Classic (.NET Framework /
        // VS pre-2022): "this.button1 = new System.Windows.Forms.Button();"
        // (VB: "Me.Button1 = New ..."). Modern (.NET 6+ / VS 2022):
        // "button1 = new Button();" — no receiver and no namespace
        // qualification. Parsing accepts both; edits are written back in
        // whichever dialect the file already uses.
        wfStyle = {
            thisPrefix: /^[ \t]*(?:this|Me)\.\w+\s*=\s*[Nn]ew\s/m.test(text),
            qualified: /[Nn]ew\s+System\.(?:Windows\.Forms|Drawing)\./.test(text)
        };

        // Control instantiations: [this.]name = new [System.Windows.Forms.]Type(...);
        // In the modern dialect, form-level value assignments look identical
        // ("ClientSize = new Size(954, 1028);"), so known value types must be
        // excluded here or they shadow the real form properties.
        const valueTypes = new Set([
            'Container', 'ComponentResourceManager', 'Size', 'SizeF', 'Point', 'PointF',
            'Font', 'Padding', 'Rectangle', 'RectangleF', 'Color', 'Icon', 'Bitmap'
        ]);
        for (const m of text.matchAll(/^[ \t]*(?:this\.|Me\.)?(\w+)\s*=\s*[Nn]ew\s+(?:[\w\.]+\.)?(\w+)\s*\(/gm)) {
            if (m[1].toLowerCase() === 'components' || valueTypes.has(m[2])) { continue; }
            wfControls.set(m[1], {
                __wf: true, name: m[1], type: m[2],
                props: {}, events: {}, children: [], columns: [], items: [], parent: null
            });
        }

        // Property assignments (single-line): [this.]name.Prop = value;
        // C# keeps its trailing-semicolon requirement so wrapped multi-line
        // statements are never half-captured; VB statements end at the line.
        const propLine = wfLang === 'vb'
            ? /^[ \t]*(?:Me\.)?(\w+)\.(\w+)\s*=\s*(.+?)[ \t]*$/gm
            : /^[ \t]*(?:this\.)?(\w+)\.([\w]+)\s*=\s*(.+);\s*$/gm;
        for (const m of text.matchAll(propLine)) {
            const ctrl = wfControls.get(m[1]);
            if (ctrl) { ctrl.props[m[2]] = m[3]; }
        }

        // Form-level assignments: [this.]Prop = value; (control names filtered out).
        const formLine = wfLang === 'vb'
            ? /^[ \t]*(?:Me\.)?(\w+)\s*=\s*(.+?)[ \t]*$/gm
            : /^[ \t]*(?:this\.)?(\w+)\s*=\s*(.+);\s*$/gm;
        for (const m of text.matchAll(formLine)) {
            if (!wfControls.has(m[1])) { wfForm.props[m[1]] = m[2]; }
        }

        // C# events, both "x.Click += new EventHandler(this.H);" and "x.Click += H;".
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?(\w+)\.(\w+)\s*\+=\s*(?:new\s+[\w\.]+\(\s*)?(?:this\.)?(\w+)\s*\)?\s*;/gm)) {
            const ctrl = wfControls.get(m[1]);
            if (ctrl) { ctrl.events[m[2]] = m[3]; }
        }
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?(\w+)\s*\+=\s*(?:new\s+[\w\.]+\(\s*)?(?:this\.)?(\w+)\s*\)?\s*;/gm)) {
            if (!wfControls.has(m[1])) { wfForm.events[m[1]] = m[2]; }
        }
        // VB events: hand-written AddHandler lines in the designer file plus
        // the Handles clauses the host parsed out of the code-behind.
        if (wfLang === 'vb') {
            for (const m of text.matchAll(/^[ \t]*AddHandler\s+(?:Me\.)?(\w+)\.(\w+)\s*,\s*AddressOf\s+(?:Me\.)?(\w+)[ \t]*$/gm)) {
                const ctrl = wfControls.get(m[1]);
                if (ctrl) { ctrl.events[m[2]] = m[3]; }
            }
            const byLowerName = new Map([...wfControls.values()].map(c => [c.name.toLowerCase(), c]));
            for (const h of wfVbHandles) {
                const dot = String(h.target ?? '').indexOf('.');
                if (dot < 1) { continue; }
                const receiver = h.target.slice(0, dot).toLowerCase();
                const eventName = h.target.slice(dot + 1);
                const owner = (receiver === 'me' || receiver === 'mybase')
                    ? wfForm
                    : byLowerName.get(receiver);
                if (!owner) { continue; }
                // Restore the catalog's event casing (VB is case-insensitive).
                const catalog = owner === wfForm
                    ? WF_FORM_EVENTS
                    : ((WF_CONTROLS[owner.type] ?? WF_TRAY[owner.type])?.events ?? []);
                const canonical = catalog.find(e => e.toLowerCase() === eventName.toLowerCase()) ?? eventName;
                owner.events[canonical] = h.handler;
            }
        }

        // Hierarchy: parent.Controls.Add(child) / Controls.Add(child).
        // TableLayoutPanel adds may carry a cell: Controls.Add(child, col, row).
        for (const m of text.matchAll(/^[ \t]*(?:this\.|Me\.)?(\w+)\.Controls\.Add\((?:this\.|Me\.)?(\w+)(?:\s*,\s*(\d+)\s*,\s*(\d+))?\);?/gm)) {
            const parent = wfControls.get(m[1]);
            const child = wfControls.get(m[2]);
            if (parent && child) {
                parent.children.push(child);
                child.parent = parent;
                if (m[3] !== undefined) { child.cell = { col: +m[3], row: +m[4] }; }
            }
        }
        // SplitContainer panels: split.Panel1.Controls.Add(child).
        for (const m of text.matchAll(/^[ \t]*(?:this\.|Me\.)?(\w+)\.(Panel1|Panel2)\.Controls\.Add\((?:this\.|Me\.)?(\w+)\);?/gm)) {
            const parent = wfControls.get(m[1]);
            const child = wfControls.get(m[3]);
            if (parent && child) {
                parent.children.push(child);
                child.parent = parent;
                child.panelSlot = m[2];
            }
        }
        for (const m of text.matchAll(/^[ \t]*(?:this\.|Me\.)?Controls\.Add\((?:this\.|Me\.)?(\w+)\);?/gm)) {
            const child = wfControls.get(m[1]);
            if (child) { wfForm.children.push(child); child.parent = wfForm; }
        }

        // Controls.AddRange(new Control[] { a, b, ... }) — parent and form
        // level; VB writes "New Control() { ... }".
        for (const m of text.matchAll(/^[ \t]*(?:this\.|Me\.)?(?:([\w]+(?:\.(?:Panel1|Panel2))?)\.)?Controls\.AddRange\([^{]*\{([\s\S]*?)\}\)/gm)) {
            const receiver = m[1] ?? '';
            const [parentName, panelSlot] = receiver.split('.');
            const parent = receiver ? wfControls.get(parentName) : wfForm;
            if (!parent) { continue; }
            for (const n of m[2].matchAll(/(?:this\.|Me\.)?(\w+)/g)) {
                const child = wfControls.get(n[1]);
                if (child && !child.parent) {
                    parent.children.push(child);
                    child.parent = parent;
                    if (panelSlot) { child.panelSlot = panelSlot; }
                }
            }
        }

        // DataGridView columns / MenuStrip items (multi-line AddRange arrays).
        for (const m of text.matchAll(/(?:this\.|Me\.)?(\w+)\.Columns\.AddRange\([^{]*\{([\s\S]*?)\}\)/g)) {
            const ctrl = wfControls.get(m[1]);
            if (ctrl) { ctrl.columns = [...m[2].matchAll(/(?:this\.|Me\.)?(\w+)/g)].map(x => x[1]).filter(n => wfControls.has(n)); }
        }
        for (const m of text.matchAll(/(?:this\.|Me\.)?(\w+)\.Items\.AddRange\([^{]*\{([\s\S]*?)\}\)/g)) {
            const ctrl = wfControls.get(m[1]);
            if (!ctrl) { continue; }
            // Strips reference generated item controls; list controls hold
            // plain string values — capture whichever the array contains.
            ctrl.items = [...m[2].matchAll(/(?:this\.|Me\.)?(\w+)/g)].map(x => x[1]).filter(n => wfControls.has(n));
            ctrl.strItems = wfLang === 'vb'
                ? [...m[2].matchAll(/"((?:[^"]|"")*)"/g)].map(x => x[1].replace(/""/g, '"'))
                : [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1].replace(/\\(.)/g, '$1'));
        }

        // Re-select the records with the same names after the re-parse.
        if (selected && selected.__wf) {
            const names = [...multiSel].filter(c => c.__wf && c !== wfForm).map(c => c.name);
            const primary = selected.type === 'Form' ? wfForm : (wfControls.get(selected.name) ?? null);
            multiSel.clear();
            for (const n of names) {
                const c = wfControls.get(n);
                if (c) { multiSel.add(c); }
            }
            selected = primary;
            if (primary && primary !== wfForm) { multiSel.add(primary); }
        } else if (selected) {
            selected = null; // switched over from a XAML document
            multiSel.clear();
        }

        bannerEl.hidden = true;
        wfRequestImages();
        wfRender();
    }

    // ------------------------------------------------------------ wf renderer

    function wfRender() {
        if (!wfForm) { renderEmpty(); return; }
        windowBox.classList.remove('ff-noresize');

        const cs = wfSizeVal(wfForm.props.ClientSize) ?? { w: 600, h: 400 };
        titleText.textContent = wfString(wfForm.props.Text) ?? config.docName;
        windowBox.style.width = `${cs.w}px`;
        windowBox.style.transform = `scale(${zoom})`;
        surfaceEl.style.display = 'block';
        surfaceEl.style.height = `${cs.h}px`;
        surfaceEl.style.background = wfColor(wfForm.props.BackColor) || '#f0f0f0';

        // Background layers: snap dots on top of the form's BackgroundImage.
        const layers = [], sizes = [], repeats = [], positions = [];
        if (config.snap) {
            layers.push('radial-gradient(circle, rgba(0,0,0,0.18) 1px, transparent 1px)');
            sizes.push(`${config.gridSize}px ${config.gridSize}px`);
            repeats.push('repeat');
            positions.push('0 0');
        }
        const formBg = wfImageUri(wfForm.props.BackgroundImage);
        if (formBg) {
            const layout = /ImageLayout\.(\w+)/.exec(wfForm.props.BackgroundImageLayout ?? '')?.[1] ?? 'Tile';
            layers.push(`url("${formBg}")`);
            sizes.push(layout === 'Stretch' ? '100% 100%' : layout === 'Zoom' ? 'contain' : 'auto');
            repeats.push(layout === 'Tile' ? 'repeat' : 'no-repeat');
            positions.push((layout === 'Center' || layout === 'Zoom') ? 'center' : '0 0');
        }
        surfaceEl.style.backgroundImage = layers.join(', ') || 'none';
        surfaceEl.style.backgroundSize = sizes.join(', ');
        surfaceEl.style.backgroundRepeat = repeats.join(', ');
        surfaceEl.style.backgroundPosition = positions.join(', ');

        // The form Icon shows in the mock title bar, like the real caption.
        let icoEl = document.getElementById('ff-title-icon');
        if (!icoEl) {
            icoEl = document.createElement('img');
            icoEl.id = 'ff-title-icon';
            titleText.parentNode.insertBefore(icoEl, titleText);
        }
        const icoUri = wfImageUri(wfForm.props.Icon);
        if (icoUri) { icoEl.src = icoUri; }
        icoEl.style.display = icoUri ? 'inline-block' : 'none';

        surfaceEl.innerHTML = '';
        visuals = [];
        // Docked children push each other for space, like the real layout
        // engine: later-added controls dock first (reverse collection order).
        const dockRects = wfDockRects(wfForm.children, cs.w, cs.h);
        // Controls.Add order is reverse z-order: first added paints on top.
        for (const child of [...wfForm.children].reverse()) {
            surfaceEl.appendChild(wfVisual(child, dockRects.get(child)));
        }

        wfRenderTray();
        drawSelection();
        drawTabOrderBadges();
        renderPanel();
    }

    /**
     * Dock layout for one container: walks the children the way the WinForms
     * DefaultLayout engine does (last in the Controls collection docks first)
     * and hands each docked control its rectangle; the rest keep Location.
     * MenuStrip/ToolStrip dock Top and StatusStrip Bottom by default.
     */
    function wfDockRects(children, w, h) {
        const rects = new Map();
        let top = 0, left = 0, right = w, bottom = h;
        for (const c of [...children].reverse()) {
            let dock = /DockStyle\.(\w+)/.exec(c.props.Dock ?? '')?.[1];
            if (!dock) {
                if (c.type === 'MenuStrip' || c.type === 'ToolStrip') { dock = 'Top'; }
                else if (c.type === 'StatusStrip') { dock = 'Bottom'; }
                else if (c.type === 'Splitter') { dock = 'Left'; } // Splitter docks Left by default
            }
            if (!dock || dock === 'None') { continue; }
            const size = wfSizeVal(c.props.Size) ?? { w: 100, h: 23 };
            if (dock === 'Top') { rects.set(c, { x: left, y: top, w: right - left, h: size.h }); top += size.h; }
            else if (dock === 'Bottom') { rects.set(c, { x: left, y: bottom - size.h, w: right - left, h: size.h }); bottom -= size.h; }
            else if (dock === 'Left') { rects.set(c, { x: left, y: top, w: size.w, h: bottom - top }); left += size.w; }
            else if (dock === 'Right') { rects.set(c, { x: right - size.w, y: top, w: size.w, h: bottom - top }); right -= size.w; }
            else if (dock === 'Fill') { rects.set(c, { x: left, y: top, w: right - left, h: bottom - top }); }
        }
        return rects;
    }

    /** The component tray below the form: chips for non-visual components. */
    function wfRenderTray() {
        const tray = $('ff-tray');
        if (!tray) { return; }
        const comps = [...wfControls.values()].filter(c => WF_TRAY[c.type]);
        tray.hidden = comps.length === 0;
        tray.innerHTML = '';
        for (const c of comps) {
            const chip = document.createElement('span');
            chip.className = 'ff-tray-chip' + (selected === c ? ' active' : '');
            chip.dataset.name = c.name;
            chip.innerHTML = `<i>${WF_TRAY[c.type].icon}</i>${escapeHtml(c.name)}`;
            chip.title = `${c.name} : ${c.type} — click to edit properties, double-click to wire ${WF_TRAY[c.type].defaultEvent}`;
            chip.addEventListener('mousedown', e => {
                e.preventDefault();
                select(c);
            });
            chip.addEventListener('dblclick', e => {
                e.preventDefault();
                wireDefaultEvent(c);
            });
            chip.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                select(c);
                showContextMenu(e.clientX, e.clientY, wfControlMenu(c));
            });
            tray.appendChild(chip);
        }
    }

    /** Absolute-positioned visual for one WinForms control (recursive). */
    function wfVisual(ctrl, dockRect) {
        const div = document.createElement('div');
        div.className = `ff-control ff-movable ff-c-wf-${ctrl.type.toLowerCase()}`;
        const loc = wfPoint(ctrl.props.Location) ?? { x: 0, y: 0 };
        const size = wfSizeVal(ctrl.props.Size) ?? { w: 100, h: 23 };
        div.style.position = 'absolute';
        div.style.left = `${loc.x}px`;
        div.style.top = `${loc.y}px`;
        div.style.width = `${size.w}px`;
        div.style.height = `${size.h}px`;

        // Docked controls get the rectangle the container's dock layout
        // computed — siblings push each other for space like the real engine.
        if (dockRect) {
            div.style.left = `${dockRect.x}px`;
            div.style.top = `${dockRect.y}px`;
            div.style.width = `${dockRect.w}px`;
            div.style.height = `${dockRect.h}px`;
            div.classList.add('ff-docked');
        }

        const bg = wfColor(ctrl.props.BackColor);
        const fg = wfColor(ctrl.props.ForeColor);
        if (bg) { div.style.background = bg; }
        if (fg) { div.style.color = fg; }
        const font = wfFont(ctrl.props.Font);
        if (font) {
            if (font.family) { div.style.fontFamily = font.family; }
            if (font.px) { div.style.fontSize = `${font.px}px`; }
            if (font.bold) { div.style.fontWeight = 'bold'; }
            if (font.italic) { div.style.fontStyle = 'italic'; }
        }
        if (ctrl.props.Enabled?.trim() === 'false') { div.classList.add('ff-disabled-control'); }
        // Visible=false is deliberately ignored: like Visual Studio, the
        // designer always shows every control so hidden panels stay editable.

        wfBuildContent(div, ctrl);
        wfApplyExtras(div, ctrl);

        div.addEventListener('mousedown', e => {
            if (e.button !== 0) { return; }
            e.preventDefault();
            e.stopPropagation();
            // Tab-order mode: clicking assigns the next TabIndex, VS-style.
            if (tabOrderMode) {
                wfAssignTabIndex(ctrl);
                return;
            }
            const additive = e.ctrlKey || e.metaKey || e.shiftKey;
            if (additive) {
                select(ctrl, true);
                return;
            }
            const wasGroup = multiSel.size > 1 && multiSel.has(ctrl);
            if (!wasGroup) {
                select(ctrl);
            } else {
                // Keep the group; just make this control the primary.
                selected = ctrl;
                drawSelection();
                renderPanel();
            }
            // Docked controls are laid out by the framework — select only.
            if (!div.classList.contains('ff-docked')) {
                startMove(e, ctrl, div, wasGroup);
            }
        });
        div.addEventListener('dblclick', e => {
            e.preventDefault();
            e.stopPropagation();
            wireDefaultEvent(ctrl);
        });

        visuals.push({ el: ctrl, div });
        return div;
    }

    function wfBuildContent(div, ctrl) {
        const text = wfString(ctrl.props.Text) ?? '';
        const inner = document.createElement('div');
        inner.className = 'ff-inner';

        const ownSize = wfSizeVal(ctrl.props.Size) ?? { w: 200, h: 100 };
        switch (ctrl.type) {
            case 'GroupBox': {
                div.classList.add('ff-wf-group');
                const header = document.createElement('span');
                header.className = 'ff-wf-group-header';
                header.textContent = text || ctrl.name;
                div.appendChild(header);
                const rects = wfDockRects(ctrl.children, ownSize.w, ownSize.h);
                for (const c of [...ctrl.children].reverse()) { div.appendChild(wfVisual(c, rects.get(c))); }
                return;
            }
            case 'Panel':
            case 'FlowLayoutPanel': {
                div.classList.add('ff-wf-panel');
                const rects = wfDockRects(ctrl.children, ownSize.w, ownSize.h);
                for (const c of [...ctrl.children].reverse()) { div.appendChild(wfVisual(c, rects.get(c))); }
                return;
            }
            case 'TableLayoutPanel': {
                div.classList.add('ff-wf-panel');
                const cols = Math.max(1, int(/\d+/.exec(ctrl.props.ColumnCount ?? '')?.[0], 2));
                const rows = Math.max(1, int(/\d+/.exec(ctrl.props.RowCount ?? '')?.[0], 2));
                const cellW = ownSize.w / cols;
                const cellH = ownSize.h / rows;
                // Cell borders as background gradients (like the VS designer).
                div.style.backgroundImage =
                    'linear-gradient(to right, rgba(120,120,120,0.45) 1px, transparent 1px), ' +
                    'linear-gradient(to bottom, rgba(120,120,120,0.45) 1px, transparent 1px)';
                div.style.backgroundSize = `${cellW}px ${cellH}px`;
                // Children are pinned to their cell; the panel owns the layout.
                for (const c of [...ctrl.children].reverse()) {
                    const cell = c.cell ?? { col: 0, row: 0 };
                    const size = wfSizeVal(c.props.Size) ?? { w: 75, h: 23 };
                    const v = wfVisual(c, {
                        x: Math.min(cols - 1, cell.col) * cellW + 3,
                        y: Math.min(rows - 1, cell.row) * cellH + 3,
                        w: size.w, h: size.h
                    });
                    div.appendChild(v);
                }
                return;
            }
            case 'SplitContainer': {
                div.classList.add('ff-wf-panel');
                const horiz = /Orientation\.Horizontal/.test(ctrl.props.Orientation ?? ''); // Horizontal = stacked panels
                const dist = Math.max(0, int(/\d+/.exec(ctrl.props.SplitterDistance ?? '')?.[0], 50));
                const sw = Math.max(1, int(/\d+/.exec(ctrl.props.SplitterWidth ?? '')?.[0], 4));
                const p1 = document.createElement('div');
                const p2 = document.createElement('div');
                p1.className = p2.className = 'ff-wf-splitpanel';
                if (horiz) {
                    p1.style.cssText = `left:0;top:0;width:${ownSize.w}px;height:${dist}px`;
                    p2.style.cssText = `left:0;top:${dist + sw}px;width:${ownSize.w}px;height:${Math.max(0, ownSize.h - dist - sw)}px`;
                } else {
                    p1.style.cssText = `left:0;top:0;width:${dist}px;height:${ownSize.h}px`;
                    p2.style.cssText = `left:${dist + sw}px;top:0;width:${Math.max(0, ownSize.w - dist - sw)}px;height:${ownSize.h}px`;
                }
                const kids1 = ctrl.children.filter(c => (c.panelSlot ?? 'Panel1') === 'Panel1');
                const kids2 = ctrl.children.filter(c => c.panelSlot === 'Panel2');
                const p1s = horiz ? { w: ownSize.w, h: dist } : { w: dist, h: ownSize.h };
                const p2s = horiz ? { w: ownSize.w, h: ownSize.h - dist - sw } : { w: ownSize.w - dist - sw, h: ownSize.h };
                const r1 = wfDockRects(kids1, p1s.w, p1s.h);
                const r2 = wfDockRects(kids2, p2s.w, p2s.h);
                for (const c of [...kids1].reverse()) { p1.appendChild(wfVisual(c, r1.get(c))); }
                for (const c of [...kids2].reverse()) { p2.appendChild(wfVisual(c, r2.get(c))); }
                div.append(p1, p2);
                return;
            }
            case 'Splitter':
                div.classList.add('ff-look-splitter');
                return;
            case 'StatusStrip': {
                div.classList.add('ff-wf-statusstrip');
                for (const itemName of ctrl.items) {
                    const item = wfControls.get(itemName);
                    const span = document.createElement('span');
                    span.textContent = item ? (wfString(item.props.Text) ?? itemName) : itemName;
                    div.appendChild(span);
                }
                return;
            }
            case 'ToolStrip': {
                div.classList.add('ff-wf-toolstrip');
                for (const itemName of ctrl.items) {
                    const item = wfControls.get(itemName);
                    const b = document.createElement('span');
                    b.className = 'ff-ts-btn';
                    b.textContent = item ? (wfString(item.props.Text) ?? itemName) : itemName;
                    div.appendChild(b);
                }
                return;
            }
            case 'TabControl': {
                div.classList.add('ff-look-tabs');
                const pages = ctrl.children.filter(c => c.type === 'TabPage');
                let active = uiTabs.get(ctrl.name) ?? 0;
                if (active >= pages.length) { active = 0; }
                const strip = document.createElement('div');
                strip.className = 'ff-tab-strip';
                pages.forEach((pg, i) => {
                    const head = document.createElement('div');
                    head.className = 'ff-tab-head' + (i === active ? ' active' : '');
                    head.textContent = wfString(pg.props.Text) ?? pg.name;
                    head.addEventListener('mousedown', e => {
                        e.preventDefault();
                        e.stopPropagation();
                        uiTabs.set(ctrl.name, i);
                        selected = pg;
                        multiSel.clear();
                        multiSel.add(pg);
                        render();
                    });
                    strip.appendChild(head);
                });
                div.appendChild(strip);
                const pg = pages[active];
                if (pg) {
                    const pgLoc = wfPoint(pg.props.Location) ?? { x: 4, y: 24 };
                    const pgSize = wfSizeVal(pg.props.Size);
                    const page = document.createElement('div');
                    page.className = 'ff-wf-page';
                    page.style.left = `${pgLoc.x}px`;
                    page.style.top = `${pgLoc.y}px`;
                    if (pgSize) {
                        page.style.width = `${pgSize.w}px`;
                        page.style.height = `${pgSize.h}px`;
                    }
                    const pgRects = wfDockRects(pg.children, pgSize?.w ?? 292, pgSize?.h ?? 172);
                    for (const c of [...pg.children].reverse()) { page.appendChild(wfVisual(c, pgRects.get(c))); }
                    div.appendChild(page);
                    visuals.push({ el: pg, div: page });
                }
                return;
            }
            case 'MenuStrip': {
                div.classList.add('ff-wf-menustrip');
                for (const itemName of ctrl.items) {
                    const item = wfControls.get(itemName);
                    const span = document.createElement('span');
                    span.textContent = item ? (wfString(item.props.Text) ?? itemName) : itemName;
                    div.appendChild(span);
                }
                return;
            }
            case 'DataGridView': {
                inner.classList.add('ff-look-list');
                const cells = ctrl.columns
                    .map(cn => wfControls.get(cn))
                    .map(c => escapeHtml((c && wfString(c.props.HeaderText)) || (c ? c.name : '')));
                inner.innerHTML = `<div class="ff-grid-header">${(cells.length ? cells : ['Col1', 'Col2', 'Col3'])
                    .map(h => `<span>${h}</span>`).join('')}</div>`;
                break;
            }
            case 'Button':
                inner.classList.add('ff-look-button');
                // Image-only buttons (Text empty, Image from resources) show a
                // placeholder glyph instead of their variable name.
                inner.textContent = text || (ctrl.props.Image ? '🖼' : ctrl.name);
                break;
            case 'Label':
                inner.classList.add('ff-look-label');
                inner.style.whiteSpace = 'nowrap';
                inner.textContent = text;
                break;
            case 'LinkLabel':
                inner.classList.add('ff-look-label');
                inner.style.whiteSpace = 'nowrap';
                inner.style.color = '#0066cc';
                inner.style.textDecoration = 'underline';
                inner.textContent = text || ctrl.name;
                break;
            case 'TextBox':
            case 'MaskedTextBox':
                inner.classList.add('ff-look-input');
                if (/^true$/i.test(ctrl.props.Multiline?.trim() ?? '')) { inner.classList.add('ff-look-textarea'); }
                inner.textContent = text;
                break;
            case 'RichTextBox':
                inner.classList.add('ff-look-input', 'ff-look-textarea');
                inner.textContent = text;
                break;
            case 'CheckBox':
                inner.classList.add('ff-look-label');
                inner.innerHTML = `<span class="ff-glyph">${/^true$/i.test(ctrl.props.Checked?.trim() ?? '') ? '☑' : '☐'}</span>`;
                inner.append(text || ctrl.name);
                break;
            case 'RadioButton':
                inner.classList.add('ff-look-label');
                inner.innerHTML = `<span class="ff-glyph">${/^true$/i.test(ctrl.props.Checked?.trim() ?? '') ? '◉' : '○'}</span>`;
                inner.append(text || ctrl.name);
                break;
            case 'ComboBox':
                inner.classList.add('ff-look-input');
                inner.innerHTML = `${escapeHtml(text || (ctrl.strItems?.[0] ?? ''))}<span class="ff-combo-arrow">▾</span>`;
                break;
            case 'ListBox':
                inner.classList.add('ff-look-list');
                inner.innerHTML = (ctrl.strItems ?? [])
                    .map(s => `<div class="ff-list-item">${escapeHtml(s)}</div>`).join('');
                break;
            case 'CheckedListBox':
                inner.classList.add('ff-look-list');
                inner.innerHTML = (ctrl.strItems ?? [])
                    .map(s => `<div class="ff-list-item">☐ ${escapeHtml(s)}</div>`).join('');
                break;
            case 'ListView':
            case 'TreeView':
                inner.classList.add('ff-look-list');
                break;
            case 'DomainUpDown':
                inner.classList.add('ff-look-input');
                inner.innerHTML = `${escapeHtml(text || (ctrl.strItems?.[0] ?? ''))}<span class="ff-combo-arrow">⇅</span>`;
                break;
            case 'MonthCalendar':
                inner.classList.add('ff-look-list', 'ff-look-calendar');
                inner.innerHTML = '<div class="ff-cal-head">◀ Month ▶</div>' +
                    '<div class="ff-cal-grid">' + 'SMTWTFS'.split('').map(d => `<span>${d}</span>`).join('') + '</div>';
                break;
            case 'HScrollBar':
                inner.classList.add('ff-look-scrollbar');
                inner.innerHTML = '<span class="ff-sb-arrow">◄</span><span class="ff-sb-thumb"></span><span class="ff-sb-arrow">►</span>';
                break;
            case 'VScrollBar':
                inner.classList.add('ff-look-scrollbar', 'ff-look-scrollbar-v');
                inner.innerHTML = '<span class="ff-sb-arrow">▲</span><span class="ff-sb-thumb"></span><span class="ff-sb-arrow">▼</span>';
                break;
            case 'WebBrowser':
                inner.classList.add('ff-look-list', 'ff-look-web');
                inner.innerHTML = `<span class="ff-web-glyph">🌐</span>${escapeHtml(ctrl.name)}`;
                break;
            case 'PropertyGrid':
                inner.classList.add('ff-look-list');
                inner.innerHTML = '<div class="ff-grid-header"><span>Property</span><span>Value</span></div>';
                break;
            case 'PictureBox':
                inner.classList.add('ff-look-image');
                inner.textContent = '🖼';
                break;
            case 'ProgressBar':
                inner.classList.add('ff-look-progress');
                inner.innerHTML = '<div class="ff-progress-fill" style="width:40%"></div>';
                break;
            case 'TrackBar':
                inner.classList.add('ff-look-slider');
                inner.innerHTML = '<div class="ff-slider-track"></div><div class="ff-slider-thumb" style="left:30%"></div>';
                break;
            case 'NumericUpDown':
                inner.classList.add('ff-look-input');
                inner.innerHTML = `${escapeHtml(text || '0')}<span class="ff-combo-arrow">↕</span>`;
                break;
            case 'DateTimePicker':
                inner.classList.add('ff-look-input');
                inner.innerHTML = 'Select a date <span class="ff-combo-arrow">▾</span>';
                break;
            default:
                inner.classList.add('ff-look-unknown');
                inner.textContent = ctrl.type;
        }
        div.appendChild(inner);
    }

    /** Preview a few appearance properties the grid can now edit. */
    function wfApplyExtras(div, ctrl) {
        const inner = div.querySelector(':scope > .ff-inner');

        const ta = /(?:ContentAlignment|HorizontalAlignment)\.(\w+)/.exec(ctrl.props.TextAlign ?? '')?.[1];
        if (ta && inner) {
            if (/^(Left|Center|Right)$/.test(ta)) {
                // HorizontalAlignment (TextBox and friends): horizontal only.
                inner.style.justifyContent = ta === 'Left' ? 'flex-start' : ta === 'Right' ? 'flex-end' : 'center';
            } else {
                inner.style.justifyContent = /Left$/.test(ta) ? 'flex-start' : /Right$/.test(ta) ? 'flex-end' : 'center';
                inner.style.alignItems = /^Top/.test(ta) ? 'flex-start' : /^Bottom/.test(ta) ? 'flex-end' : 'center';
            }
        }

        const bs = /BorderStyle\.(\w+)/.exec(ctrl.props.BorderStyle ?? '')?.[1];
        if (bs === 'FixedSingle') { div.style.border = '1px solid #828790'; }
        else if (bs === 'Fixed3D') { div.style.border = '2px inset #f0f0f0'; }

        const fs = /FlatStyle\.(\w+)/.exec(ctrl.props.FlatStyle ?? '')?.[1];
        if (fs === 'Flat' && inner && ctrl.type === 'Button') {
            inner.style.border = '1px solid #000';
            inner.style.background = wfColor(ctrl.props.BackColor) || '#e1e1e1';
        }

        // BackgroundImage + BackgroundImageLayout (None/Tile/Center/Stretch/Zoom).
        const bgUri = wfImageUri(ctrl.props.BackgroundImage);
        if (bgUri) { applyBackgroundImage(div, bgUri, ctrl.props.BackgroundImageLayout); }

        // PictureBox Image with SizeMode.
        const imgUri = wfImageUri(ctrl.props.Image);
        if (imgUri && ctrl.type === 'PictureBox' && inner) {
            inner.textContent = '';
            const img = document.createElement('img');
            img.className = 'ff-pic-img';
            img.src = imgUri;
            const mode = /PictureBoxSizeMode\.(\w+)/.exec(ctrl.props.SizeMode ?? '')?.[1] ?? 'Normal';
            img.style.objectFit = mode === 'StretchImage' ? 'fill' : mode === 'Zoom' ? 'contain' : 'none';
            img.style.objectPosition = (mode === 'CenterImage' || mode === 'Zoom') ? 'center' : 'left top';
            inner.appendChild(img);
        }

        // Image on Buttons/Labels/CheckBoxes/RadioButtons, placed per
        // TextImageRelation and ImageAlign like the real control.
        if (imgUri && ctrl.type !== 'PictureBox' && inner) {
            const img = document.createElement('img');
            img.className = 'ff-ctl-img';
            img.src = imgUri;
            const rel = /TextImageRelation\.(\w+)/.exec(ctrl.props.TextImageRelation ?? '')?.[1] ?? 'Overlay';
            if (rel === 'Overlay') {
                const ia = /ContentAlignment\.(\w+)/.exec(ctrl.props.ImageAlign ?? '')?.[1] ?? 'MiddleCenter';
                img.classList.add('ff-img-overlay');
                const h = /Left$/.test(ia) ? '0%' : /Right$/.test(ia) ? '100%' : '50%';
                const v = /^Top/.test(ia) ? '0%' : /^Bottom/.test(ia) ? '100%' : '50%';
                img.style.left = h;
                img.style.top = v;
                img.style.transform = `translate(-${h === '0%' ? '0' : h === '100%' ? '100%' : '50%'}, -${v === '0%' ? '0' : v === '100%' ? '100%' : '50%'})`;
                div.appendChild(img);
            } else {
                inner.style.flexDirection =
                    rel === 'ImageAboveText' ? 'column'
                    : rel === 'TextAboveImage' ? 'column-reverse'
                    : rel === 'TextBeforeImage' ? 'row-reverse' : 'row';
                inner.insertBefore(img, inner.firstChild);
            }
        }
    }

    /** Shared BackgroundImage/BackgroundImageLayout -> CSS mapping. */
    function applyBackgroundImage(el, uri, layoutProp) {
        const layout = /ImageLayout\.(\w+)/.exec(layoutProp ?? '')?.[1] ?? 'Tile';
        el.style.backgroundImage = `url("${uri}")`;
        el.style.backgroundRepeat = layout === 'Tile' ? 'repeat' : 'no-repeat';
        el.style.backgroundPosition = (layout === 'Center' || layout === 'Zoom') ? 'center' : '0 0';
        el.style.backgroundSize = layout === 'Stretch' ? '100% 100%' : layout === 'Zoom' ? 'contain' : 'auto';
    }

    // ------------------------------------------------------- wf value parsing

    function wfPoint(v) {
        const m = /Point\((-?\d+),\s*(-?\d+)\)/.exec(v ?? '');
        return m ? { x: +m[1], y: +m[2] } : null;
    }

    function wfSizeVal(v) {
        const m = /Size\((-?\d+),\s*(-?\d+)\)/.exec(v ?? '');
        return m ? { w: +m[1], h: +m[2] } : null;
    }

    function wfString(v) {
        const m = /^"([\s\S]*)"$/.exec((v ?? '').trim());
        if (!m) { return null; }
        if (wfLang === 'vb') {
            // VB strings escape quotes by doubling; no backslash escapes.
            return m[1].replace(/""/g, '"');
        }
        const esc = { '"': '"', '\\': '\\', r: '', n: ' ', t: ' ', '0': '' };
        return m[1].replace(/\\(.)/g, (_, c) => esc[c] ?? c);
    }

    const WF_SYSTEM_COLORS = {
        Control: '#f0f0f0', ControlLight: '#e3e3e3', ControlLightLight: '#ffffff',
        ControlDark: '#a0a0a0', ControlDarkDark: '#696969', ControlText: '#000000',
        Window: '#ffffff', WindowText: '#000000', ButtonFace: '#f0f0f0',
        Highlight: '#0078d7', HighlightText: '#ffffff', Info: '#ffffe1',
        InfoText: '#000000', ActiveCaption: '#99b4d1', GrayText: '#6d6d6d'
    };

    function wfColor(v) {
        if (!v) { return ''; }
        let m = /SystemColors\.(\w+)/.exec(v);
        if (m) { return WF_SYSTEM_COLORS[m[1]] ?? ''; }
        m = /Color\.FromArgb\(([\s\S]*?)\)$/.exec(v.trim());
        if (m) {
            const nums = [...m[1].matchAll(/\d+/g)].map(x => +x[0]);
            if (nums.length === 3) { return `rgb(${nums[0]},${nums[1]},${nums[2]})`; }
            if (nums.length === 4) { return `rgba(${nums[1]},${nums[2]},${nums[3]},${(nums[0] / 255).toFixed(3)})`; }
            return '';
        }
        m = /Color\.(\w+)/.exec(v);
        if (m) { return m[1].toLowerCase(); }
        return '';
    }

    function wfFont(v) {
        // C# writes "9.75F" size suffixes; VB writes "9.75!".
        const m = /[Nn]ew\s+(?:System\.Drawing\.)?Font\("([^"]+)",\s*([\d.]+)[F!]?/.exec(v ?? '');
        if (!m) { return null; }
        return {
            family: m[1],
            px: Math.round(parseFloat(m[2]) * 4 / 3), // points -> pixels
            bold: /FontStyle\.Bold/.test(v),
            italic: /FontStyle\.Italic/.test(v)
        };
    }

    // ----------------------------------------------------------- wf images
    // Image/BackgroundImage/Icon values reference either a project resource
    // ("global::Ns.Properties.Resources.name") or a legacy local form
    // resource ("resources.GetObject(\"btn.Image\")"). The extension host
    // resolves both to URIs the canvas can draw; results are cached here.

    const imageCache = new Map(); // 'p:name' | 'l:name' -> uri, or null while pending

    /** Parse an image expression into { scope: 'p'|'l', key } (or null).
     *  C# project resources read "Properties.Resources.name"; VB reads
     *  "My.Resources.name". Local form resources use GetObject in both. */
    function wfImageRef(raw) {
        if (!raw) { return null; }
        let m = /(?:Properties|My)\.Resources\.(\w+)/.exec(raw);
        if (m) { return { scope: 'p', key: m[1] }; }
        m = /resources\.GetObject\("([^"]+)"/.exec(raw);
        if (m) { return { scope: 'l', key: m[1] }; }
        return null;
    }

    /** Renderable URI for an image property value, when resolved. */
    function wfImageUri(raw) {
        const ref = wfImageRef(raw);
        return ref ? (imageCache.get(`${ref.scope}:${ref.key}`) || null) : null;
    }

    /** Ask the host for any referenced images we have not resolved yet. */
    function wfRequestImages() {
        if (!wfForm) { return; }
        const wanted = [];
        const collect = props => {
            for (const p of ['Image', 'BackgroundImage', 'Icon']) {
                const ref = wfImageRef(props[p]);
                if (!ref) { continue; }
                const ck = `${ref.scope}:${ref.key}`;
                if (!imageCache.has(ck)) {
                    imageCache.set(ck, null); // pending — avoids re-request loops
                    wanted.push(ref);
                }
            }
        };
        collect(wfForm.props);
        for (const c of wfControls.values()) { collect(c.props); }
        if (wanted.length) { vscode.postMessage({ type: 'resolveImages', keys: wanted }); }
    }

    // -------------------------------------- wf property grid value conversion
    // Each grid editor shows a friendly value ("Fill", "Top, Left", "255, 128,
    // 0", "Segoe UI, 9pt, style=Bold") parsed from the C# expression in the
    // Designer.cs, and serializes user input back to compilable C#.

    function wfPaddingVal(v) {
        const m = /Padding\((-?\d+)(?:,\s*(-?\d+),\s*(-?\d+),\s*(-?\d+))?\)/.exec(v ?? '');
        if (!m) { return null; }
        if (m[2] === undefined) { const a = +m[1]; return { l: a, t: a, r: a, b: a }; }
        return { l: +m[1], t: +m[2], r: +m[3], b: +m[4] };
    }

    /** AnchorStyles flags present in a C# expression, in canonical order. */
    function wfAnchorFlags(v) {
        return ['Top', 'Bottom', 'Left', 'Right'].filter(f => new RegExp(`AnchorStyles\\.${f}\\b`).test(v ?? ''));
    }

    function wfAnchorCode(flags) {
        if (!flags.length) { return 'System.Windows.Forms.AnchorStyles.None'; }
        if (flags.length === 1) { return `System.Windows.Forms.AnchorStyles.${flags[0]}`; }
        // Multi-flag combinations use the cast form Visual Studio generates.
        if (wfLang === 'vb') {
            return `CType(${flags.map(f => `System.Windows.Forms.AnchorStyles.${f}`).join(' Or ')}, System.Windows.Forms.AnchorStyles)`;
        }
        return `((System.Windows.Forms.AnchorStyles)(${flags.map(f => `System.Windows.Forms.AnchorStyles.${f}`).join(' | ')}))`;
    }

    /** "Control", "Red", or "255, 128, 0" from a C# color expression. */
    function wfColorDisplay(v) {
        let m = /SystemColors\.(\w+)/.exec(v);
        if (m) { return m[1]; }
        m = /Color\.FromArgb\(([\s\S]*?)\)\s*$/.exec(v.trim());
        if (m) {
            const nums = [...m[1].matchAll(/-?\d+/g)].map(x => +x[0] & 0xff);
            return nums.join(', ');
        }
        m = /Color\.(\w+)/.exec(v);
        if (m) { return m[1]; }
        return v;
    }

    /** Friendly color text -> C# color expression (null when unrecognized). */
    function wfColorCode(input) {
        const v = input.trim();
        let m = /^#([0-9a-fA-F]{6})$/.exec(v);
        if (m) {
            const n = parseInt(m[1], 16);
            return `System.Drawing.Color.FromArgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
        }
        const nums = v.split(',').map(s => s.trim());
        if (nums.length >= 3 && nums.every(s => /^\d+$/.test(s))) {
            return `System.Drawing.Color.FromArgb(${nums.slice(0, 4).map(s => Math.min(255, +s)).join(', ')})`;
        }
        if (!/^[A-Za-z]+$/.test(v)) { return null; }
        const sys = WF_SYSTEM_COLOR_NAMES.find(n => n.toLowerCase() === v.toLowerCase());
        if (sys) { return `System.Drawing.SystemColors.${sys}`; }
        const named = WF_NAMED_COLORS.find(n => n.toLowerCase() === v.toLowerCase());
        return `System.Drawing.Color.${named ?? v.charAt(0).toUpperCase() + v.slice(1)}`;
    }

    /** Any CSS color -> "#rrggbb" for the swatch input (via computed style). */
    function cssColorToHex(css) {
        if (!css) { return '#000000'; }
        const probe = document.createElement('span');
        probe.style.color = css;
        document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color;
        probe.remove();
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
        if (!m) { return '#000000'; }
        return '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
    }

    function wfFontDisplay(v) {
        const m = /[Nn]ew\s+(?:System\.Drawing\.)?Font\("([^"]+)",\s*([\d.]+)[F!]?/.exec(v ?? '');
        if (!m) { return v; }
        const styles = ['Bold', 'Italic', 'Underline', 'Strikeout']
            .filter(s => new RegExp(`FontStyle\\.${s}\\b`).test(v));
        return `${m[1]}, ${m[2]}pt${styles.length ? `, style=${styles.join(', ')}` : ''}`;
    }

    /** "Segoe UI, 9pt, style=Bold, Italic" -> new Font(...) code (or null). */
    function wfFontCode(input) {
        const m = /^([^,]+?)\s*,\s*([\d.]+)\s*(?:pt)?\s*(?:,\s*style\s*=\s*(.+))?$/i.exec(input.trim());
        if (!m) { return null; }
        const styles = (m[3] ?? '').split(/[,|\s]+/)
            .map(s => ['Bold', 'Italic', 'Underline', 'Strikeout'].find(k => k.toLowerCase() === s.toLowerCase()))
            .filter(Boolean);
        if (wfLang === 'vb') {
            const base = `New System.Drawing.Font("${m[1].trim()}", ${parseFloat(m[2])}!`;
            if (!styles.length) { return `${base})`; }
            if (styles.length === 1) { return `${base}, System.Drawing.FontStyle.${styles[0]})`; }
            return `${base}, ${styles.map(s => `System.Drawing.FontStyle.${s}`).join(' Or ')})`;
        }
        const size = `${parseFloat(m[2])}F`;
        const base = `new System.Drawing.Font("${m[1].trim()}", ${size}`;
        if (!styles.length) { return `${base})`; }
        if (styles.length === 1) { return `${base}, System.Drawing.FontStyle.${styles[0]})`; }
        return `${base}, (${styles.map(s => `System.Drawing.FontStyle.${s}`).join(' | ')}))`;
    }

    /** Numeric value of "new decimal(new int[] { lo, mid, hi, flags })"
     *  (VB: "New Decimal(New Integer() { ... })"). */
    function wfDecimalVal(v) {
        const m = /[Nn]ew\s+[Dd]ecimal\([Nn]ew\s+(?:int\[\]|Integer\(\))\s*\{\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}\)/.exec(v ?? '');
        if (!m) {
            const n = parseFloat(v);
            return Number.isFinite(n) ? n : null;
        }
        const lo = (+m[1]) >>> 0;
        const flags = +m[4];
        const scale = (flags >> 16) & 0xff;
        return (flags < 0 ? -1 : 1) * lo / Math.pow(10, scale);
    }

    function wfDecimalCode(input) {
        const v = input.trim();
        if (!/^-?\d+(\.\d+)?$/.test(v)) { return null; }
        const neg = v.startsWith('-');
        const scale = (v.split('.')[1] ?? '').length;
        const lo = Math.round(Math.abs(parseFloat(v)) * Math.pow(10, scale));
        if (!Number.isSafeInteger(lo) || lo > 0x7fffffff) { return null; }
        const flags = (neg ? -2147483648 : 0) + (scale << 16);
        return wfLang === 'vb'
            ? `New Decimal(New Integer() { ${lo}, 0, 0, ${flags} })`
            : `new decimal(new int[] { ${lo}, 0, 0, ${flags} })`;
    }

    /** Friendly display text for a raw C# property value, per editor kind. */
    function wfDisplay(def, raw) {
        if (raw === undefined || raw === null) { return null; }
        const v = String(raw).trim();
        switch (def.kind) {
            case 'string': return wfString(v) ?? v;
            case 'bool': return /^true$/i.test(v) ? 'True' : /^false$/i.test(v) ? 'False' : v;
            case 'int': case 'float': { const m = /-?[\d.]+/.exec(v); return m ? m[0] : v; }
            case 'decimal': { const d = wfDecimalVal(v); return d !== null ? String(d) : v; }
            case 'char': {
                const m = /^'\\?(.)'$/.exec(v) ?? /^"(""|.)"c$/.exec(v);
                return m ? (m[1] === '""' ? '"' : m[1]) : v;
            }
            case 'enum': case 'ref': { const m = /(\w+)\s*\)*\s*$/.exec(v); return m ? m[1] : v; }
            case 'anchor': { const f = wfAnchorFlags(v); return f.length ? f.join(', ') : 'None'; }
            case 'point': { const p = wfPoint(v); return p ? `${p.x}, ${p.y}` : v; }
            case 'size': { const s = wfSizeVal(v); return s ? `${s.w}, ${s.h}` : v; }
            case 'padding': { const p = wfPaddingVal(v); return p ? `${p.l}, ${p.t}, ${p.r}, ${p.b}` : v; }
            case 'color': return wfColorDisplay(v);
            case 'font': return wfFontDisplay(v);
            case 'image': case 'icon': { const r = wfImageRef(v); return r ? r.key : v; }
            default: return v;
        }
    }

    /** User input -> compilable code for the property (per the document's
     *  language), or null when invalid. */
    function wfSerialize(def, input) {
        const v = input.trim();
        switch (def.kind) {
            case 'string': return wfQuote(v);
            case 'bool': {
                const b = /^t/i.test(v);
                return wfLang === 'vb' ? (b ? 'True' : 'False') : (b ? 'true' : 'false');
            }
            case 'int': { const n = parseInt(v, 10); return Number.isFinite(n) ? String(n) : null; }
            case 'float': {
                const n = parseFloat(v);
                if (!Number.isFinite(n)) { return null; }
                return wfLang === 'vb' ? `${n}R` : `${n}D`;
            }
            case 'decimal': return wfDecimalCode(v);
            case 'char': {
                if (!v) { return null; }
                const c = v[0];
                if (wfLang === 'vb') { return `"${c === '"' ? '""' : c}"c`; }
                return c === "'" ? "'\\''" : c === '\\' ? "'\\\\'" : `'${c}'`;
            }
            case 'enum': {
                const ns = def.enum === 'ContentAlignment' ? 'System.Drawing' : 'System.Windows.Forms';
                return `${def.prefix ?? `${ns}.${def.enum}`}.${v}`;
            }
            case 'ref': return wfRef(v);
            case 'point': { const p = wfPair(v); return p ? `new System.Drawing.Point(${p.a}, ${p.b})` : null; }
            case 'size': { const p = wfPair(v); return p ? `new System.Drawing.Size(${p.a}, ${p.b})` : null; }
            case 'padding': {
                const nums = v.split(',').map(s => parseInt(s.trim(), 10));
                if (nums.some(n => !Number.isFinite(n))) { return null; }
                if (nums.length === 1) { return `new System.Windows.Forms.Padding(${nums[0]})`; }
                if (nums.length === 4) { return `new System.Windows.Forms.Padding(${nums.join(', ')})`; }
                return null;
            }
            case 'color': return wfColorCode(v);
            case 'font': return wfFontCode(v);
            default: return v;
        }
    }

    // ----------------------------------------------------- wf surgical edits

    /** Line ending used by the document (keeps diffs clean on CRLF files). */
    function wfEol() {
        return xamlText.includes('\r\n') ? '\r\n' : '\n';
    }

    /** Push edited text to the document and re-render from it. */
    function wfApply(newText) {
        if (newText === xamlText) { return; }
        const baseText = xamlText;
        xamlText = newText;
        vscode.postMessage({ type: 'edit', text: newText, baseText });
        wfParseAndRender();
    }

    /**
     * Select a record that is about to be inserted into Designer.cs. The next
     * parse swaps this placeholder for the parsed record with the same name;
     * keeping it in both selection stores prevents an older multi-selection
     * from being carried across the insertion.
     */
    function wfSelectInserted(name, type) {
        const pending = {
            __wf: true, name, type, props: {}, events: {}, children: [],
            columns: [], items: [], parent: null
        };
        selected = pending;
        multiSel.clear();
        multiSel.add(pending);
        selectedPath = '';
    }

    /** "this.name" / "Me.name" or plain "name", matching the file's dialect. */
    function wfRef(name) {
        if (!wfStyle.thisPrefix) { return name; }
        return wfLang === 'vb' ? `Me.${name}` : `this.${name}`;
    }

    /** Statement terminator for generated lines ("" in VB). */
    function wfSemi() {
        return wfLang === 'vb' ? '' : ';';
    }

    /**
     * Adapt a canonical generated-C# snippet to the document. Two passes:
     *   1. VB translation — keywords, receivers, arrays, casts, and literal
     *      suffixes are rewritten OUTSIDE string literals only (a Text value
     *      like "brand new" must never become "brand New").
     *   2. Namespace stripping on modern-style unqualified files.
     */
    function wfCode(code) {
        let result = code;
        if (wfLang === 'vb') {
            result = result.split(/("(?:[^"]|"")*")/).map((part, i) => {
                if (i % 2 === 1) { return part; } // string literal — verbatim
                return part
                    .replace(/\(\(([\w\.]+)\)\((.+?)\)\)/g, 'CType($2, $1)')
                    .replace(/\bnew\s+int\[\]\s*\{/g, 'New Integer() {')
                    .replace(/\bnew\s+object\[\]\s*\{/g, 'New Object() {')
                    .replace(/\bnew\s+([\w\.]+)\[\]\s*\{/g, 'New $1() {')
                    .replace(/\bnew\s+decimal\(/g, 'New Decimal(')
                    .replace(/\bnew\b/g, 'New')
                    .replace(/\btrue\b/g, 'True')
                    .replace(/\bfalse\b/g, 'False')
                    .replace(/\bthis\./g, 'Me.')
                    .replace(/(\d(?:\.\d+)?)F\b/g, '$1!')
                    .replace(/ \| /g, ' Or ');
            }).join('');
        }
        return wfStyle.qualified ? result : result.replace(/\bSystem\.(?:Windows\.Forms\.|Drawing\.(?!Printing\.))/g, '');
    }

    /**
     * Replace "[this.]<name>.<prop> = ...;" or insert it into the control's
     * statement block. Returns the new text (does not apply it).
     */
    /** Statement-end fragment for match patterns: C# lines must close with
     *  ';' so a wrapped multi-line statement is never half-replaced. */
    function wfTermRe() {
        return wfLang === 'vb' ? '' : ';';
    }

    function wfSetLine(name, prop, code, text = xamlText) {
        const line = `${wfRef(name)}.${prop} = ${wfCode(code)}${wfSemi()}`;
        const re = new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${name}\\.${prop}\\s*=[^\\r\\n]*${wfTermRe()}[ \\t]*$`, 'm');
        if (re.test(text)) {
            return text.replace(re, `$1${line}`);
        }
        // Insert after the first existing statement of this control's block,
        // or — for controls without property lines yet (fresh tray
        // components) — right after the instantiation.
        const anchor = new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${name}\\.[\\w\\.]+[^\\r\\n]*$`, 'm').exec(text)
            ?? new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${name}\\s*=\\s*[Nn]ew\\s[^\\r\\n]*$`, 'm').exec(text);
        if (!anchor) { return text; }
        const end = anchor.index + anchor[0].length;
        return `${text.slice(0, end)}${wfEol()}${anchor[1]}${line}${text.slice(end)}`;
    }

    /** Same as wfSetLine but for the form's own "[this.]<prop> = ...;" lines. */
    function wfSetFormLine(prop, code, text = xamlText) {
        const line = `${wfRef(prop)} = ${wfCode(code)}${wfSemi()}`;
        const re = new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${prop}\\s*=[^\\r\\n]*${wfTermRe()}[ \\t]*$`, 'm');
        if (re.test(text)) {
            return text.replace(re, `$1${line}`);
        }
        const m = /^([ \t]*)(?:this\.|Me\.)?ClientSize\s*=/m.exec(text);
        if (!m) { return text; }
        const end = text.indexOf('\n', m.index);
        return `${text.slice(0, end)}${wfEol()}${m[1]}${line}${text.slice(end)}`;
    }

    /** Remove the "[this.]<name>.<prop> = ...;" line entirely (if present). */
    function wfRemoveLine(name, prop, text = xamlText) {
        const re = new RegExp(`^[ \\t]*(?:this\\.|Me\\.)?${name}\\.${prop}\\s*=[^\\r\\n]*${wfTermRe()}[ \\t]*\\r?\\n`, 'm');
        return text.replace(re, '');
    }

    /** Remove a form-level "[this.]<prop> = ...;" line (if present). */
    function wfRemoveFormLine(prop, text = xamlText) {
        const re = new RegExp(`^[ \\t]*(?:this\\.|Me\\.)?${prop}\\s*=[^\\r\\n]*${wfTermRe()}[ \\t]*\\r?\\n`, 'm');
        return text.replace(re, '');
    }

    /** Wire (or rewire) an event and ask the host for the handler stub. */
    function wfWireEvent(el, eventName, handler, openStub = true) {
        const isForm = el === wfForm;
        const finalName = handler || `${isForm ? wfForm.name : el.name}_${eventName}`;
        if (!validateCSharpIdentifier(finalName, 'handler name')) {
            renderPanel();
            return;
        }
        const et = WF_EVENT_TYPE_OVERRIDES[el.type]?.[eventName]
            ?? WF_EVENT_TYPES[eventName]
            ?? WF_DEFAULT_EVENT_TYPE;

        // VB wires events with a Handles clause on the handler Sub in the
        // code-behind — the designer file itself does not change. The host
        // moves the Handles target and (re)creates the stub; the refreshed
        // wiring comes back with the next update message.
        if (wfLang === 'vb') {
            el.events[eventName] = finalName;
            vscode.postMessage({
                type: 'addHandler',
                handler: finalName,
                event: eventName,
                argsType: et.args,
                handles: `${isForm ? 'MyBase' : el.name}.${eventName}`,
                reveal: openStub
            });
            renderPanel();
            return;
        }

        const lhs = isForm ? wfRef(eventName) : `${wfRef(el.name)}.${eventName}`;
        // Classic files wrap the handler in a delegate; modern ones don't.
        const line = wfStyle.thisPrefix
            ? `${lhs} += new ${et.handler}(this.${finalName});`
            : `${lhs} += ${finalName};`;
        const lhsPattern = isForm
            ? `(?:this\\.)?${eventName}`
            : `(?:this\\.)?${el.name}\\.${eventName}`;

        let text = xamlText;
        const re = new RegExp(`^([ \\t]*)${lhsPattern}\\s*\\+=[^\\r\\n]*$`, 'm');
        if (re.test(text)) {
            text = text.replace(re, `$1${line}`);
        } else if (isForm) {
            // Form events sit at the end of the form's block, before ResumeLayout.
            const m = /^([ \t]*)(?:[\w\.]+\.)?ResumeLayout\(/m.exec(text)
                ?? /^([ \t]*)this\.ResumeLayout\(/m.exec(text);
            if (!m) { return; }
            text = `${text.slice(0, m.index)}${m[1]}${line}${wfEol()}${text.slice(m.index)}`;
        } else {
            // Append after the last statement of the control's block.
            const blockRe = new RegExp(`^([ \\t]*)(?:this\\.)?${el.name}\\.[\\w\\.]+[^\\r\\n]*$`, 'gm');
            let last = null;
            for (const m of text.matchAll(blockRe)) { last = m; }
            if (!last) { return; }
            const end = last.index + last[0].length;
            text = `${text.slice(0, end)}${wfEol()}${last[1]}${line}${text.slice(end)}`;
        }
        wfApply(text);
        if (openStub) {
            vscode.postMessage({ type: 'addHandler', handler: finalName, event: eventName, argsType: et.args });
        }
    }

    /** Remove an event wiring ("x.Click += ..." line, or a VB Handles target). */
    function wfUnwireEvent(el, eventName) {
        if (wfLang === 'vb') {
            delete el.events[eventName];
            // Hand-written AddHandler lines in the designer file are removed
            // here; Handles clauses live in the code-behind — the host edits those.
            const addHandler = new RegExp(
                `^[ \\t]*AddHandler\\s+(?:Me\\.)?${el === wfForm ? 'MyBase' : el.name}\\.${eventName}\\b[^\\r\\n]*\\r?\\n`, 'im');
            if (addHandler.test(xamlText)) { wfApply(xamlText.replace(addHandler, '')); }
            vscode.postMessage({
                type: 'removeHandler',
                handles: `${el === wfForm ? 'MyBase' : el.name}.${eventName}`
            });
            renderPanel();
            return;
        }
        const lhs = el === wfForm
            ? `(?:this\\.)?${eventName}`
            : `(?:this\\.)?${el.name}\\.${eventName}`;
        const re = new RegExp(`^[ \\t]*${lhs}\\s*\\+=[^\\r\\n]*\\r?\\n`, 'm');
        wfApply(xamlText.replace(re, ''));
    }

    // -------------------------------------------------------- wf add / delete

    function wfUniqueName(type) {
        // VB names collide case-insensitively; VS also capitalizes them there.
        const base = wfLang === 'vb' ? type : type.charAt(0).toLowerCase() + type.slice(1);
        const flags = wfLang === 'vb' ? 'i' : '';
        for (let i = 1; ; i++) {
            if (!wfControls.has(`${base}${i}`) && !new RegExp(`\\b${base}${i}\\b`, flags).test(xamlText)) {
                return `${base}${i}`;
            }
        }
    }

    function wfDrop(e, type) {
        if (!wfForm) { return; }
        // Non-visual components land in the tray; strips dock themselves.
        if (WF_TRAY[type]) { wfAddComponent(type); return; }
        if (type === 'MenuStrip' || type === 'ToolStrip' || type === 'StatusStrip') { wfAddStrip(type); return; }
        if (type === 'TabControl') {
            const r = surfaceEl.getBoundingClientRect();
            wfInsertTabControl(
                snap(Math.max(0, (e.clientX - r.left) / zoom - 150)),
                snap(Math.max(0, (e.clientY - r.top) / zoom - 100)));
            return;
        }
        const def = WF_CONTROLS[type];
        if (!def) { return; }

        // Deepest WinForms container under the pointer, else the form itself.
        let parent = null;
        let parentDiv = surfaceEl;
        let node = document.elementFromPoint(e.clientX, e.clientY);
        while (node && node !== surfaceEl) {
            const hit = visuals.find(v => v.div === node);
            if (hit && hit.el.__wf && WF_CONTAINERS.includes(hit.el.type)) {
                parent = hit.el;
                parentDiv = hit.div;
                break;
            }
            node = node.parentElement;
        }

        const r = parentDiv.getBoundingClientRect();
        let x = snap(Math.max(0, (e.clientX - r.left) / zoom - def.w / 2));
        let y = snap(Math.max(0, (e.clientY - r.top) / zoom - def.h / 2));
        let parentName = parent ? parent.name : null;

        // SplitContainer children belong to Panel1/Panel2, never the container
        // itself (its Controls collection rejects direct adds). Pick the panel
        // under the pointer; coordinates are relative to that panel.
        if (parent?.type === 'SplitContainer') {
            const horiz = /Orientation\.Horizontal/.test(parent.props.Orientation ?? '');
            const dist = Math.max(0, int(/\d+/.exec(parent.props.SplitterDistance ?? '')?.[0], 50));
            const sw = Math.max(1, int(/\d+/.exec(parent.props.SplitterWidth ?? '')?.[0], 4));
            const along = horiz ? y : x;
            const second = along > dist;
            parentName = `${parent.name}.${second ? 'Panel2' : 'Panel1'}`;
            if (second) {
                if (horiz) { y = Math.max(0, y - dist - sw); }
                else { x = Math.max(0, x - dist - sw); }
            }
        }
        wfAddControl(type, x, y, parentName);
    }

    /** Insert a brand-new control: field, instantiation, block, Controls.Add. */
    function wfAddControl(type, x, y, parentName) {
        const def = WF_CONTROLS[type];
        if (!def) { return; }
        const name = wfUniqueName(type);
        const props = [
            ['Location', `new System.Drawing.Point(${x}, ${y})`],
            ['Name', `"${name}"`],
            ['TabIndex', String(wfControls.size)]
        ];
        // Auto-sizing controls (MonthCalendar) get no Size line, like VS.
        if (!def.noSize) { props.splice(2, 0, ['Size', `new System.Drawing.Size(${def.w}, ${def.h})`]); }
        if (def.text) { props.push(['Text', `"${name}"`]); }
        // Fixed extras VS also writes on drop (e.g. TableLayoutPanel counts).
        for (const [p, code] of def.extra ?? []) { props.push([p, code]); }
        return wfInsertControl(type, name, props, parentName);
    }

    /** Copy of an existing control, offset one grid step, in the same parent. */
    function wfDuplicateControl(src) {
        if (!WF_CONTROLS[src.type]) {
            setStatus(`UI Maker: duplicate is not supported for ${src.type} controls.`);
            return;
        }
        const blocked = wfShallowCloneBlock(src);
        if (blocked) {
            setStatus(`UI Maker: duplicating ${blocked} is disabled until deep cloning can preserve their structure.`);
            return;
        }
        const name = wfUniqueName(src.type);
        const loc = wfPoint(src.props.Location) ?? { x: 0, y: 0 };
        const props = [
            ['Location', `new System.Drawing.Point(${loc.x + config.gridSize}, ${loc.y + config.gridSize})`],
            ['Name', `"${name}"`],
            ['TabIndex', String(wfControls.size)]
        ];
        // Carry over everything else the source sets (Size, Text, colors, ...).
        for (const [prop, code] of Object.entries(src.props)) {
            if (prop === 'Location' || prop === 'Name' || prop === 'TabIndex') { continue; }
            props.push([prop, code]);
        }
        let parentName = src.parent && src.parent !== wfForm ? src.parent.name : null;
        if (src.parent?.type === 'SplitContainer' && src.panelSlot) {
            parentName = `${src.parent.name}.${src.panelSlot}`;
        }
        let cell = null;
        if (src.parent?.type === 'TableLayoutPanel') {
            const cols = Math.max(1, int(/\d+/.exec(src.parent.props.ColumnCount ?? '')?.[0], 2));
            const rows = Math.max(1, int(/\d+/.exec(src.parent.props.RowCount ?? '')?.[0], 2));
            const occupied = new Set(src.parent.children
                .filter(c => c.cell)
                .map(c => `${c.cell.col},${c.cell.row}`));
            const start = src.cell ? src.cell.row * cols + src.cell.col + 1 : 0;
            for (let offset = 0; offset < rows * cols; offset++) {
                const index = (start + offset) % (rows * cols);
                const candidate = { col: index % cols, row: Math.floor(index / cols) };
                if (!occupied.has(`${candidate.col},${candidate.row}`)) { cell = candidate; break; }
            }
            if (!cell) {
                setStatus(`UI Maker: ${src.parent.name} has no empty cell for the duplicate.`);
                return;
            }
        }
        if (!wfInsertControl(src.type, name, props, parentName, cell)) { return; }
        setStatus(`UI Maker: duplicated ${src.name} as ${name}.`);
    }

    /**
     * Shared insertion plumbing: instantiation before SuspendLayout, property
     * block before the form's own section, Controls.Add, field declaration.
     * `props` is an ordered [prop, code] list; code uses qualified names and
     * is rewritten to match the file's dialect.
     */
    function wfInsertControl(type, name, props, parentName, cell = null) {
        const eol = wfEol();
        let text = xamlText;
        const ind = wfIndent(text);

        // 1) Instantiation — before the first Suspend/BeginInit line.
        const withNew = wfInsertBeforeSuspend(text,
            `${ind}${wfRef(name)} = ${wfCode(`new System.Windows.Forms.${type}()`)}${wfSemi()}`);
        if (!withNew) {
            setStatus('UI Maker: could not find a place to insert the control.');
            return false;
        }
        text = withNew;

        // 2) Property block — before the form's own section (AutoScaleDimensions).
        const withBlock = wfInsertBlockBeforeForm(text, [
            ...wfCommentTrio(ind, name),
            ...props.map(([prop, code]) => `${ind}${wfRef(name)}.${prop} = ${wfCode(code)}${wfSemi()}`)
        ]);
        if (!withBlock) {
            setStatus('UI Maker: could not find the form section in InitializeComponent.');
            return false;
        }
        text = withBlock;

        // 3) Controls.Add — into the parent container or the form. The parent
        // may be a dotted path like "splitContainer1.Panel1".
        const parentRe = parentName ? reEsc(parentName) : '';
        const parentBase = parentName ? parentName.split('.')[0] : '';
        const addArgument = cell
            ? `${wfRef(name)}, ${cell.col}, ${cell.row}`
            : wfRef(name);
        const addLine = parentName
            ? `${ind}${wfRef(parentName)}.Controls.Add(${addArgument})${wfSemi()}`
            : `${ind}${wfStyle.thisPrefix ? (wfLang === 'vb' ? 'Me.' : 'this.') : ''}Controls.Add(${wfRef(name)})${wfSemi()}`;
        const firstAdd = parentName
            ? new RegExp(`^[ \\t]*(?:this\\.|Me\\.)?${parentRe}\\.Controls\\.Add\\(`, 'm').exec(text)
            : /^[ \t]*(?:this\.|Me\.)?Controls\.Add\(/m.exec(text);
        let added = false;
        if (firstAdd) {
            text = `${text.slice(0, firstAdd.index)}${addLine}${eol}${text.slice(firstAdd.index)}`;
            added = true;
        } else if (parentName) {
            // Parent has no Controls.Add lines yet — append after its first
            // statement (fall back to the base control's block for panels).
            const anchor = new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${parentRe}\\.[\\w\\.]+[^\\r\\n]*$`, 'm').exec(text)
                ?? new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${reEsc(parentBase)}\\.[\\w\\.]+[^\\r\\n]*$`, 'm').exec(text);
            if (anchor) {
                const end = anchor.index + anchor[0].length;
                text = `${text.slice(0, end)}${eol}${addLine}${text.slice(end)}`;
                added = true;
            }
        } else {
            const cs = /^([ \t]*)(?:this\.|Me\.)?ClientSize\s*=[^\r\n]*$/m.exec(text);
            if (cs) {
                const end = cs.index + cs[0].length;
                text = `${text.slice(0, end)}${eol}${addLine}${text.slice(end)}`;
                added = true;
            }
        }
        if (!added) {
            setStatus('UI Maker: insertion was cancelled because the parent Controls collection could not be updated safely.');
            return false;
        }

        // 4) Field declaration — after the last existing designer field.
        const withField = wfInsertField(text, `System.Windows.Forms.${type}`, name);
        if (!withField) {
            setStatus('UI Maker: insertion was cancelled because a safe designer-field anchor was not found.');
            return false;
        }
        text = withField;

        wfSelectInserted(name, type);
        wfApply(text);
        return true;
    }

    // ------------------------------------------- wf shared insertion helpers

    /** Indentation used by generated statements (from SuspendLayout). */
    function wfIndent(text) {
        return /^([ \t]*)(?:this\.|Me\.)?SuspendLayout\(\);?/m.exec(text)?.[1]
            ?? (wfLang === 'vb' ? '        ' : '            ');
    }

    /** The "// name //" (C#) or "' 'name '" (VB) block header trio. */
    function wfCommentTrio(ind, name) {
        return wfLang === 'vb'
            ? [`${ind}'`, `${ind}'${name}`, `${ind}'`]
            : [`${ind}// `, `${ind}// ${name}`, `${ind}// `];
    }

    /** Insert a statement line before the first Suspend/BeginInit line. */
    function wfInsertBeforeSuspend(text, line) {
        const m = /^[ \t]*(?:(?:[\w\.]+\.)?SuspendLayout\(\);?|\(\((?:System\.ComponentModel\.)?ISupportInitialize\)|CType\([^\r\n]*?,\s*(?:System\.ComponentModel\.)?ISupportInitialize\))/m.exec(text);
        if (!m) { return null; }
        return `${text.slice(0, m.index)}${line}${wfEol()}${text.slice(m.index)}`;
    }

    /** Insert block lines before the form's own section (its comment trio). */
    function wfInsertBlockBeforeForm(text, blockLines) {
        const anchor = /^[ \t]*(?:this\.|Me\.)?AutoScaleDimensions\s*=/m.exec(text);
        if (!anchor) { return null; }
        let at = anchor.index;
        const trio = wfLang === 'vb'
            ? /(^[ \t]*'[ \t]*\r?\n[ \t]*'[^\r\n]*\r?\n[ \t]*'[ \t]*\r?\n)$/m.exec(text.slice(0, at))
            : /(^[ \t]*\/\/[ \t]*\r?\n[ \t]*\/\/[^\r\n]*\r?\n[ \t]*\/\/[ \t]*\r?\n)$/m.exec(text.slice(0, at));
        if (trio) { at -= trio[1].length; }
        return `${text.slice(0, at)}${blockLines.join(wfEol())}${wfEol()}${text.slice(at)}`;
    }

    /**
     * Append a field declaration after the last designer field. Returns null
     * when no safe anchor exists (the caller aborts its insertion).
     * C#: after the last `private Type name;` field or `#endregion`.
     * VB:  after the last `Friend WithEvents name As Type` field, else after
     *      InitializeComponent's End Sub, else before the final End Class.
     */
    function wfInsertField(text, qualifiedType, name) {
        const eol = wfEol();
        if (wfLang === 'vb') {
            const fieldRe = /^([ \t]*)(?:Friend|Private|Public|Protected)(?:\s+\w+)*\s+WithEvents\s+\w+\s+As\s+[\w\.]+[ \t]*$/gm;
            let last = null;
            for (const m of text.matchAll(fieldRe)) { last = m; }
            if (last) {
                const end = last.index + last[0].length;
                const line = `${last[1]}Friend WithEvents ${name} As ${wfCode(qualifiedType)}`;
                return `${text.slice(0, end)}${eol}${line}${text.slice(end)}`;
            }
            const body = wfInitializeComponentBody(text);
            if (body) {
                const endSub = /^([ \t]*)End\s+Sub[ \t]*$/m.exec(text.slice(body.end));
                if (endSub) {
                    const end = body.end + endSub.index + endSub[0].length;
                    const line = `${endSub[1]}Friend WithEvents ${name} As ${wfCode(qualifiedType)}`;
                    return `${text.slice(0, end)}${eol}${line}${text.slice(end)}`;
                }
            }
            const endClass = /^([ \t]*)End\s+Class[ \t]*\r?\n?(?![\s\S]*^\s*End\s+Class)/m.exec(text);
            if (!endClass) { return null; }
            const line = `${endClass[1]}    Friend WithEvents ${name} As ${wfCode(qualifiedType)}`;
            return `${text.slice(0, endClass.index)}${line}${eol}${text.slice(endClass.index)}`;
        }
        const fieldLine = `        private ${wfCode(qualifiedType)} ${name};`;
        let last = null;
        for (const m of text.matchAll(/^[ \t]*private\s+[\w\.<>\[\]]+\s+\w+;[ \t]*$/gm)) { last = m; }
        if (last) {
            const end = last.index + last[0].length;
            return `${text.slice(0, end)}${wfEol()}${fieldLine}${text.slice(end)}`;
        }
        const endRegion = /^[ \t]*#endregion[^\r\n]*$/m.exec(text);
        if (!endRegion) { return null; }
        const end = endRegion.index + endRegion[0].length;
        return `${text.slice(0, end)}${wfEol()}${wfEol()}${fieldLine}${text.slice(end)}`;
    }

    // --------------------------------------------------- wf tray & strips

    /** Add a non-visual component (Timer, ToolTip, dialogs, ...) to the tray. */
    function wfAddComponent(type) {
        const def = WF_TRAY[type];
        if (!def || !wfForm) { return; }
        const eol = wfEol();
        const name = wfUniqueName(type);
        let text = xamlText;
        const ind = wfIndent(text);

        // IContainer-based components need the components container.
        if (def.ctor === 'components') {
            if (!/\bcomponents\s*=\s*[Nn]ew\s+System\.ComponentModel\.Container\(\)/.test(text)) {
                const t = wfInsertBeforeSuspend(text,
                    `${ind}${wfRef('components')} = ${wfCode('new System.ComponentModel.Container()')}${wfSemi()}`);
                if (t) { text = t; }
            }
            const hasField = wfLang === 'vb'
                ? /\bcomponents\s+As\s+System\.ComponentModel\.IContainer/.test(text)
                : /private\s+System\.ComponentModel\.IContainer\s+components/.test(text);
            if (!hasField) {
                if (wfLang === 'vb') {
                    const endClass = /^([ \t]*)End\s+Class[ \t]*\r?\n?(?![\s\S]*^\s*End\s+Class)/m.exec(text);
                    if (endClass) {
                        text = `${text.slice(0, endClass.index)}${endClass[1]}    Private components As System.ComponentModel.IContainer${eol}${text.slice(endClass.index)}`;
                    }
                } else {
                    const last = /^[ \t]*#endregion[^\r\n]*$/m.exec(text);
                    if (last) {
                        text = `${text.slice(0, last.index + last[0].length)}${eol}${eol}        private System.ComponentModel.IContainer components;${text.slice(last.index + last[0].length)}`;
                    }
                }
            }
        }

        const qualified = `${def.ns ?? 'System.Windows.Forms'}.${type}`;
        const arg = def.ctor === 'components' ? `(${wfRef('components')})` : '()';
        const t2 = wfInsertBeforeSuspend(text,
            `${ind}${wfRef(name)} = ${wfCode(`new ${qualified}`)}${arg}${wfSemi()}`);
        if (!t2) {
            setStatus('UI Maker: could not find a place to insert the component.');
            return;
        }
        const withField = wfInsertField(t2, qualified, name);
        if (!withField) {
            setStatus('UI Maker: insertion was cancelled because a safe designer-field anchor was not found.');
            return;
        }

        wfSelectInserted(name, type);
        wfApply(withField);
        setStatus(`UI Maker: added ${name} to the component tray.`);
    }

    /** Add a MenuStrip / ToolStrip / StatusStrip docked strip to the form. */
    function wfAddStrip(type) {
        const cs = wfSizeVal(wfForm.props.ClientSize) ?? { w: 600, h: 400 };
        const def = WF_CONTROLS[type];
        const name = wfUniqueName(type);
        const y = type === 'StatusStrip' ? cs.h - def.h : 0;
        const inserted = wfInsertControl(type, name, [
            ['Location', `new System.Drawing.Point(0, ${y})`],
            ['Name', `"${name}"`],
            ['Size', `new System.Drawing.Size(${cs.w}, ${def.h})`],
            ['TabIndex', String(wfControls.size)],
            ['Text', `"${name}"`]
        ], null);
        if (!inserted) { return; }
        if (type === 'MenuStrip') {
            wfApply(wfSetFormLine('MainMenuStrip', wfRef(name)));
        }
    }

    /** Unique generated name for a strip item ("File" -> fileToolStripMenuItem). */
    function wfStripItemName(itemText, itemType, text) {
        let stem = itemText.replace(/[^A-Za-z0-9]/g, '');
        stem = stem ? stem.charAt(0).toLowerCase() + stem.slice(1) : 'item';
        if (/^[0-9]/.test(stem)) { stem = `_${stem}`; }
        const base = `${stem}${itemType}`;
        const flags = wfLang === 'vb' ? 'i' : '';
        if (!wfControls.has(base) && !new RegExp(`\\b${base}\\b`, flags).test(text)) { return base; }
        for (let i = 1; ; i++) {
            if (!wfControls.has(`${base}${i}`) && !new RegExp(`\\b${base}${i}\\b`, flags).test(text)) {
                return `${base}${i}`;
            }
        }
    }

    /**
     * Make the strip's items match `texts` (one entry per line in the panel):
     * reuses existing items in order, retitles changed ones, creates missing
     * ones, deletes extras, and rewrites the Items.AddRange call.
     */
    function wfSetStripItems(strip, texts) {
        const eol = wfEol();
        const itemType = WF_STRIP_ITEM_TYPES[strip.type];
        if (!itemType) { return; }
        let text = xamlText;
        const ind = wfIndent(text);

        const existing = (strip.items ?? []).map(n => wfControls.get(n)).filter(Boolean);
        const finalNames = [];

        // Reuse + retitle in order.
        for (let i = 0; i < Math.min(existing.length, texts.length); i++) {
            finalNames.push(existing[i].name);
            if ((wfString(existing[i].props.Text) ?? '') !== texts[i]) {
                text = wfSetLine(existing[i].name, 'Text', wfQuote(texts[i]), text);
            }
        }
        // Delete extras.
        for (const gone of existing.slice(texts.length)) {
            text = wfRemoveControlLines(gone.name, text);
        }
        // Create new items: instantiation, Name+Text block, field.
        for (let i = existing.length; i < texts.length; i++) {
            const name = wfStripItemName(texts[i], itemType, text);
            finalNames.push(name);
            const t = wfInsertBeforeSuspend(text,
                `${ind}${wfRef(name)} = ${wfCode(`new System.Windows.Forms.${itemType}()`)}${wfSemi()}`);
            if (!t) { return; }
            text = wfInsertBlockBeforeForm(t, [
                ...wfCommentTrio(ind, name),
                `${ind}${wfRef(name)}.Name = "${name}"${wfSemi()}`,
                `${ind}${wfRef(name)}.Text = ${wfCode(wfQuote(texts[i]))}${wfSemi()}`
            ]) ?? t;
            text = wfInsertField(text, `System.Windows.Forms.${itemType}`, name) ?? text;
        }

        // Rewrite the AddRange call (may span multiple lines).
        const addRe = new RegExp(`^[ \\t]*(?:this\\.|Me\\.)?${strip.name}\\.Items\\.AddRange\\([\\s\\S]*?\\);?[ \\t]*\\r?\\n`, 'm');
        text = text.replace(addRe, '');
        if (finalNames.length) {
            const arr = finalNames.map(n => wfRef(n)).join(', ');
            const line = `${ind}${wfRef(strip.name)}.Items.AddRange(${wfCode(`new System.Windows.Forms.ToolStripItem[] { ${arr} }`)})${wfSemi()}`;
            // After the strip's first property line, else after its instantiation.
            const anchor = new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${strip.name}\\.[\\w\\.]+[^\\r\\n]*$`, 'm').exec(text)
                ?? new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${strip.name}\\s*=\\s*[Nn]ew\\s[^\\r\\n]*$`, 'm').exec(text);
            if (anchor) {
                const end = anchor.index + anchor[0].length;
                text = `${text.slice(0, end)}${eol}${line}${text.slice(end)}`;
            }
        }
        wfApply(text);
    }

    /**
     * Rewrite a list control's Items.AddRange(new object[] { ... }) call so
     * it matches `texts` (one string per entry). Empty list removes the call.
     */
    function wfSetObjItems(ctrl, texts) {
        const eol = wfEol();
        let text = xamlText;
        const ind = wfIndent(text);
        const re = new RegExp(`^[ \\t]*(?:this\\.|Me\\.)?${ctrl.name}\\.Items\\.AddRange\\([\\s\\S]*?\\);?[ \\t]*\\r?\\n`, 'm');
        text = text.replace(re, '');
        if (texts.length) {
            const arr = texts.map(t => wfQuote(t)).join(', ');
            const line = `${ind}${wfRef(ctrl.name)}.Items.AddRange(${wfCode(`new object[] { ${arr} }`)})${wfSemi()}`;
            const anchor = new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${ctrl.name}\\.[\\w\\.]+[^\\r\\n]*$`, 'm').exec(text)
                ?? new RegExp(`^([ \\t]*)(?:this\\.|Me\\.)?${ctrl.name}\\s*=\\s*[Nn]ew\\s[^\\r\\n]*$`, 'm').exec(text);
            if (!anchor) {
                setStatus('UI Maker: could not find the control block to write the items.');
                return;
            }
            const end = anchor.index + anchor[0].length;
            text = `${text.slice(0, end)}${eol}${line}${text.slice(end)}`;
        }
        wfApply(text);
    }

    /** Insert a TabControl with two pages, the way Visual Studio drops one. */
    function wfInsertTabControl(x, y) {
        const eol = wfEol();
        let text = xamlText;
        const ind = wfIndent(text);
        const tc = wfUniqueName('TabControl');
        // Two page names — wfUniqueName can't reserve, so pick sequentially.
        const freePage = taken => {
            const stem = wfLang === 'vb' ? 'TabPage' : 'tabPage';
            const flags = wfLang === 'vb' ? 'i' : '';
            for (let i = 1; ; i++) {
                const cand = `${stem}${i}`;
                if (cand !== taken && !wfControls.has(cand) && !new RegExp(`\\b${cand}\\b`, flags).test(text)) { return cand; }
            }
        };
        const p1 = freePage('');
        const p2 = freePage(p1);

        for (const [n, t] of [[tc, 'TabControl'], [p1, 'TabPage'], [p2, 'TabPage']]) {
            const ins = wfInsertBeforeSuspend(text, `${ind}${wfRef(n)} = ${wfCode(`new System.Windows.Forms.${t}()`)}${wfSemi()}`);
            if (!ins) { return; }
            text = ins;
        }

        const semi = wfSemi();
        const pageBlock = (n, i) => [
            ...wfCommentTrio(ind, n),
            `${ind}${wfRef(n)}.Location = ${wfCode('new System.Drawing.Point(4, 24)')}${semi}`,
            `${ind}${wfRef(n)}.Name = "${n}"${semi}`,
            `${ind}${wfRef(n)}.Padding = ${wfCode('new System.Windows.Forms.Padding(3)')}${semi}`,
            `${ind}${wfRef(n)}.Size = ${wfCode('new System.Drawing.Size(292, 172)')}${semi}`,
            `${ind}${wfRef(n)}.TabIndex = ${i}${semi}`,
            `${ind}${wfRef(n)}.Text = "${n}"${semi}`,
            `${ind}${wfRef(n)}.UseVisualStyleBackColor = ${wfCode('true')}${semi}`
        ];
        const block = [
            ...wfCommentTrio(ind, tc),
            `${ind}${wfRef(tc)}.Controls.Add(${wfRef(p1)})${semi}`,
            `${ind}${wfRef(tc)}.Controls.Add(${wfRef(p2)})${semi}`,
            `${ind}${wfRef(tc)}.Location = ${wfCode(`new System.Drawing.Point(${x}, ${y})`)}${semi}`,
            `${ind}${wfRef(tc)}.Name = "${tc}"${semi}`,
            `${ind}${wfRef(tc)}.SelectedIndex = 0${semi}`,
            `${ind}${wfRef(tc)}.Size = ${wfCode('new System.Drawing.Size(300, 200)')}${semi}`,
            `${ind}${wfRef(tc)}.TabIndex = ${wfControls.size}${semi}`,
            ...pageBlock(p1, 0),
            ...pageBlock(p2, 1)
        ];
        const withBlock = wfInsertBlockBeforeForm(text, block);
        if (!withBlock) { return; }
        text = withBlock;

        // Controls.Add on the form.
        const addLine = `${ind}${wfStyle.thisPrefix ? (wfLang === 'vb' ? 'Me.' : 'this.') : ''}Controls.Add(${wfRef(tc)})${semi}`;
        const firstAdd = /^[ \t]*(?:this\.|Me\.)?Controls\.Add\(/m.exec(text);
        if (firstAdd) {
            text = `${text.slice(0, firstAdd.index)}${addLine}${eol}${text.slice(firstAdd.index)}`;
        } else {
            const cs = /^([ \t]*)(?:this\.|Me\.)?ClientSize\s*=[^\r\n]*$/m.exec(text);
            if (cs) {
                const end = cs.index + cs[0].length;
                text = `${text.slice(0, end)}${eol}${addLine}${text.slice(end)}`;
            }
        }

        text = wfInsertField(text, 'System.Windows.Forms.TabControl', tc) ?? text;
        text = wfInsertField(text, 'System.Windows.Forms.TabPage', p1) ?? text;
        text = wfInsertField(text, 'System.Windows.Forms.TabPage', p2) ?? text;

        wfSelectInserted(tc, 'TabControl');
        wfApply(text);
    }

    /** `line` with the contents of its string literals blanked out, so
     *  identifier matching can never hit text inside quotes. */
    function wfMaskStrings(line) {
        return wfLang === 'vb'
            ? line.replace(/"(?:[^"]|"")*"/g, s => `"${'_'.repeat(s.length - 2)}"`)
            : line.replace(/"(?:[^"\\]|\\.)*"/g, s => `"${'_'.repeat(s.length - 2)}"`);
    }

    /** Return the first index after a C# comment/string/character token, or
     *  `at` when ordinary code begins there. This is deliberately lexical:
     *  it only exists to keep braces in literals from confusing method bounds. */
    function wfSkipCSharpToken(source, at) {
        const n = source.length;
        if (source.startsWith('//', at)) {
            const end = source.indexOf('\n', at + 2);
            return end < 0 ? n : end;
        }
        if (source.startsWith('/*', at)) {
            const end = source.indexOf('*/', at + 2);
            return end < 0 ? n : end + 2;
        }

        // C# 11 raw strings, including interpolated raw strings.
        let quoteAt = at;
        while (source[quoteAt] === '$') { quoteAt++; }
        let quoteEnd = quoteAt;
        while (source[quoteEnd] === '"') { quoteEnd++; }
        const quoteCount = quoteEnd - quoteAt;
        if (quoteCount >= 3) {
            const close = source.indexOf('"'.repeat(quoteCount), quoteEnd);
            return close < 0 ? n : close + quoteCount;
        }

        let verbatimPrefix = 0;
        if (source.startsWith('@"', at)) { verbatimPrefix = 2; }
        else if (source.startsWith('$@"', at) || source.startsWith('@$"', at)) { verbatimPrefix = 3; }
        if (verbatimPrefix) {
            let i = at + verbatimPrefix;
            while (i < n) {
                if (source[i] === '"' && source[i + 1] === '"') { i += 2; continue; }
                if (source[i] === '"') { return i + 1; }
                i++;
            }
            return n;
        }

        if (source[at] === '"' || (source[at] === '$' && source[at + 1] === '"')) {
            let i = at + (source[at] === '$' ? 2 : 1);
            while (i < n && source[i] !== '"' && source[i] !== '\n') {
                if (source[i] === '\\') { i++; }
                i++;
            }
            return i < n && source[i] === '"' ? i + 1 : i;
        }
        if (source[at] === '\'') {
            let i = at + 1;
            while (i < n && source[i] !== '\'' && source[i] !== '\n') {
                if (source[i] === '\\') { i++; }
                i++;
            }
            return i < n && source[i] === '\'' ? i + 1 : i;
        }
        return at;
    }

    /** Bounds of the generated InitializeComponent body, excluding the
     *  delimiters (C# braces; VB signature line and End Sub). */
    function wfInitializeComponentBody(source) {
        if (wfLang === 'vb') {
            const sub = /\b(?:Private|Friend|Protected|Public)\s+Sub\s+InitializeComponent\s*\(\s*\)[ \t]*\r?\n/i.exec(source);
            if (!sub) { return null; }
            const start = sub.index + sub[0].length;
            // InitializeComponent never nests Subs, so the first End Sub at a
            // line start closes it (VB strings/comments cannot span lines).
            const endSub = /^[ \t]*End\s+Sub[ \t]*$/m.exec(source.slice(start));
            if (!endSub) { return null; }
            return { start, end: start + endSub.index };
        }
        const signature = /\b(?:private|protected|internal|public)\s+(?:static\s+)?void\s+InitializeComponent\s*\(\s*\)/g.exec(source);
        if (!signature) { return null; }
        let open = -1;
        for (let i = signature.index + signature[0].length; i < source.length;) {
            const skipped = wfSkipCSharpToken(source, i);
            if (skipped !== i) { i = skipped; continue; }
            if (source[i] === '{') { open = i; break; }
            if (source[i] === ';') { return null; }
            i++;
        }
        if (open < 0) { return null; }
        let depth = 1;
        for (let i = open + 1; i < source.length;) {
            const skipped = wfSkipCSharpToken(source, i);
            if (skipped !== i) { i = skipped; continue; }
            if (source[i] === '{') { depth++; }
            else if (source[i] === '}' && --depth === 0) {
                return { start: open + 1, end: i };
            }
            i++;
        }
        return null;
    }

    /**
     * Remove generated statements referencing `name` from InitializeComponent
     * plus its field declaration. User-authored helper methods are deliberately
     * left alone, matching Visual Studio's designer-delete behavior. Only real
     * identifier references count — a "name"
     * inside a string literal (e.g. another control's Text or Items) never
     * matches. Shared AddRange lists are PRUNED, not deleted: the doomed
     * control is dropped from the array and its siblings stay registered.
     * Handler names like name_Click do not match because "_" is a word
     * character (no \b boundary).
     */
    function wfRemoveControlLines(name, text) {
        const range = wfInitializeComponentBody(text);
        if (!range) {
            setStatus('UI Maker: delete was cancelled because InitializeComponent could not be bounded safely.');
            return text;
        }
        const isRef = it => it === name || it === `this.${name}` || it === `Me.${name}`;
        let body = text.slice(range.start, range.end);

        // AddRange statements first (they can span lines and list several
        // controls). Owned by the doomed control -> remove whole statement;
        // merely listing it -> prune the one item. VB array creation writes
        // "New Type() {...}" instead of "new Type[] {...}".
        body = body.replace(
            /^([ \t]*)((?:this\.|Me\.)?[\w\.]+)\.AddRange\(\s*([Nn]ew\s+[\w\.\[\]]+(?:\(\))?)\s*\{([\s\S]*?)\}\s*\)\s*;?[ \t]*(\r?\n)?/gm,
            (all, ind, recv, arrType, arrBody, nl) => {
                if (isRef(recv) || recv.startsWith(`${name}.`) || recv.startsWith(`this.${name}.`) || recv.startsWith(`Me.${name}.`)) { return ''; }
                if (arrBody.includes('"')) { return all; } // string arrays: no control refs
                const items = arrBody.split(',').map(s => s.trim()).filter(Boolean);
                if (!items.some(isRef)) { return all; }
                const kept = items.filter(it => !isRef(it));
                if (!kept.length) { return ''; }
                return `${ind}${recv}.AddRange(${arrType} { ${kept.join(', ')} })${wfSemi()}${nl ?? ''}`;
            });

        const lines = body.split('\n');
        const keep = [];
        const safeName = reEsc(name);
        const ref = new RegExp(`\\b(?:this\\.|Me\\.)?${safeName}\\b`);
        const isTrioMiddle = wfLang === 'vb'
            ? t => t === `'${name}` || t === `' ${name}`
            : t => t === `// ${name}`;
        const isTrioEdge = wfLang === 'vb'
            ? t => t === `'`
            : t => t === '//';
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trim();
            // The "name" comment trio above the control's block.
            if (isTrioMiddle(t)
                && isTrioEdge(lines[i - 1]?.trim() ?? '')
                && isTrioEdge(lines[i + 1]?.trim() ?? '')) {
                keep.pop();
                i += 1;
                continue;
            }
            if (ref.test(wfMaskStrings(lines[i]))) { continue; }
            keep.push(lines[i]);
        }
        const updatedBody = keep.join('\n');
        text = `${text.slice(0, range.start)}${updatedBody}${text.slice(range.end)}`;

        // Generated fields live outside InitializeComponent. Remove only the
        // exact simple declaration; never erase user code that merely refers
        // to the control identifier.
        const field = wfLang === 'vb'
            ? new RegExp(
                `^[ \\t]*(?:Friend|Private|Public|Protected)(?:\\s+\\w+)*\\s+(?:WithEvents\\s+)?${safeName}\\s+As\\s+[\\w\\.]+[ \\t]*(?:\\r?\\n|$)`, 'gm')
            : new RegExp(
                `^[ \\t]*private\\s+[\\w\\.:<>?,\\[\\]]+\\s+${safeName}\\s*;[ \\t]*(?:\\r?\\n|$)`, 'gm');
        return text.replace(field, '');
    }

    /** Delete one control (and, for strips, their generated items). */
    function wfDeleteControl(ctrl) {
        wfDeleteControls([ctrl]);
    }

    function wfDeleteControls(ctrls) {
        const names = [];
        for (const c of ctrls) {
            names.push(c.name);
            // Deleting a strip also deletes its generated ToolStrip items.
            for (const itemName of (c.items ?? [])) { names.push(itemName); }
            // DataGridView columns are generated fields with their own blocks.
            for (const columnName of (c.columns ?? [])) { names.push(columnName); }
            // Deleting a container deletes everything inside it.
            const walk = kids => {
                for (const k of kids ?? []) { names.push(k.name); walk(k.children); }
            };
            walk(c.children);
        }
        let text = xamlText;
        for (const n of [...new Set(names)]) { text = wfRemoveControlLines(n, text); }
        selected = null;
        multiSel.clear();
        selectedPath = '';
        wfApply(text);
    }

    // ----------------------------------------------------------- wf rename

    /**
     * Rename an identifier in generated code while copying comments and
     * literals verbatim. This keeps notes and user-visible text untouched.
     * VB identifiers are case-insensitive; VB comments are apostrophes and
     * VB strings double their quotes (no backslash escapes).
     */
    function wfRenameIdentifier(source, oldName, newName) {
        if (wfLang === 'vb') { return wfRenameVbIdentifier(source, oldName, newName); }
        const idRe = new RegExp(`\\b${oldName}\\b`, 'g');
        const n = source.length;
        let out = '';
        let codeStart = 0;
        let i = 0;

        const flushCode = end => { out += source.slice(codeStart, end).replace(idRe, newName); };
        const skipVerbatim = (from, to) => {
            flushCode(from);
            out += source.slice(from, to);
            codeStart = i = to;
        };

        while (i < n) {
            const ch = source[i];
            const two = source.slice(i, i + 2);

            if (two === '//') {
                let end = source.indexOf('\n', i);
                if (end < 0) { end = n; }
                skipVerbatim(i, end);
                continue;
            }
            if (two === '/*') {
                let end = source.indexOf('*/', i + 2);
                end = end < 0 ? n : end + 2;
                skipVerbatim(i, end);
                continue;
            }

            // C# 11 raw strings: interpolation '$' characters may precede a
            // delimiter made from at least three quote characters.
            if (ch === '$' || ch === '"') {
                let quoteAt = i;
                while (source[quoteAt] === '$') { quoteAt++; }
                let quoteEnd = quoteAt;
                while (source[quoteEnd] === '"') { quoteEnd++; }
                const quoteCount = quoteEnd - quoteAt;
                if (quoteCount >= 3) {
                    const delimiter = '"'.repeat(quoteCount);
                    const close = source.indexOf(delimiter, quoteEnd);
                    skipVerbatim(i, close < 0 ? n : close + quoteCount);
                    continue;
                }
            }

            let verbatimPrefix = 0;
            if (source.startsWith('@"', i)) { verbatimPrefix = 2; }
            else if (source.startsWith('$@"', i) || source.startsWith('@$"', i)) { verbatimPrefix = 3; }
            if (verbatimPrefix) {
                let j = i + verbatimPrefix;
                while (j < n) {
                    if (source[j] === '"' && source[j + 1] === '"') { j += 2; continue; }
                    if (source[j] === '"') { j++; break; }
                    j++;
                }
                skipVerbatim(i, j);
                continue;
            }

            if (ch === '"' || (ch === '$' && source[i + 1] === '"')) {
                let j = i + (ch === '$' ? 2 : 1);
                while (j < n && source[j] !== '"' && source[j] !== '\n') {
                    if (source[j] === '\\') { j++; }
                    j++;
                }
                if (j < n && source[j] === '"') { j++; }
                skipVerbatim(i, j);
                continue;
            }

            if (ch === '\'') {
                let j = i + 1;
                while (j < n && source[j] !== '\'' && source[j] !== '\n') {
                    if (source[j] === '\\') { j++; }
                    j++;
                }
                if (j < n && source[j] === '\'') { j++; }
                skipVerbatim(i, j);
                continue;
            }
            i++;
        }
        flushCode(n);
        return out;
    }

    /** VB flavor of the rename scanner: ' comments, ""-doubled strings, and
     *  case-insensitive identifier matching. */
    function wfRenameVbIdentifier(source, oldName, newName) {
        const idRe = new RegExp(`\\b${oldName}\\b`, 'gi');
        const n = source.length;
        let out = '';
        let codeStart = 0;
        let i = 0;

        const flushCode = end => { out += source.slice(codeStart, end).replace(idRe, newName); };
        const skipVerbatim = (from, to) => {
            flushCode(from);
            out += source.slice(from, to);
            codeStart = i = to;
        };

        while (i < n) {
            const ch = source[i];
            if (ch === '\'') {
                let end = source.indexOf('\n', i);
                if (end < 0) { end = n; }
                skipVerbatim(i, end);
                continue;
            }
            if (ch === '"') {
                let j = i + 1;
                while (j < n) {
                    if (source[j] === '"' && source[j + 1] === '"') { j += 2; continue; }
                    if (source[j] === '"' || source[j] === '\n') { j++; break; }
                    j++;
                }
                skipVerbatim(i, j);
                continue;
            }
            i++;
        }
        flushCode(n);
        return out;
    }

    /**
     * Rename a control's generated-code references and its own Name string,
     * then ask the host to mirror the identifier change into code-behind.
     * Handler names like oldName_Click are left alone — same as Visual Studio.
     */
    function wfRenameControl(ctrl, newName) {
        const oldName = ctrl.name;
        newName = newName.trim();
        if (!newName || newName === oldName) { renderPanel(); return; }
        if (!validateCSharpIdentifier(newName, 'control name')) {
            renderPanel();
            return;
        }
        // VB identifiers collide case-insensitively.
        const usedFlags = wfLang === 'vb' ? 'i' : '';
        if (wfControls.has(newName) || newName === wfForm.name
            || new RegExp(`\\b${newName}\\b`, usedFlags).test(xamlText)) {
            setStatus(`UI Maker: "${newName}" is already used in this file — pick another name.`);
            renderPanel();
            return;
        }
        let text = wfRenameIdentifier(xamlText, oldName, newName);
        // Literals stay untouched except this control's generated Name
        // assignment, whose receiver was just renamed above.
        const ownName = new RegExp(`((?:this\\.|Me\\.)?${newName}\\.Name\\s*=\\s*)"${oldName}"`, usedFlags);
        text = text.replace(ownName, `$1"${newName}"`);
        // Comments survive renames too — except the generated block-header
        // trio, whose middle line IS the control name (VS regenerates it).
        const trioLine = wfLang === 'vb'
            ? new RegExp(`^([ \\t]*)'[ ]?${oldName}[ \\t]*$`, 'm')
            : new RegExp(`^([ \\t]*)// ${oldName}[ \\t]*$`, 'm');
        text = text.replace(trioLine, wfLang === 'vb' ? `$1'${newName}` : `$1// ${newName}`);
        ctrl.name = newName; // re-parse re-selects by name
        vscode.postMessage({ type: 'renameControl', oldName, newName });
        wfApply(text);
        setStatus(`UI Maker: renamed ${oldName} to ${newName} (code-behind updated too).`);
    }

    // ------------------------------------------------------- wf property panel

    function wfRenderPanel() {
        const el = selected && selected.__wf && selected !== wfForm ? selected : null;
        const isForm = !el;
        propsTarget.textContent = isForm
            ? `${wfForm?.name ?? 'Form'} (${config.docName})`
            : `${el.name} : ${el.type}`;
        if (!wfForm) { return; }

        if (activeTab === 'props') { wfPropsTab(el, isForm); }
        else { wfEventsTab(el, isForm); }
    }

    function wfPropsTab(el, isForm) {
        const target = isForm ? wfForm : el;
        const type = isForm ? 'Form' : el.type;
        // Tray components have no layout/color surface — show just their own
        // properties; regular controls get the full common set too.
        const names = isForm
            ? ['Name', ...WF_FORM_PROPS]
            : WF_TRAY[el.type]
                ? ['Name', ...WF_TRAY[el.type].props, 'Tag']
                : [...new Set(['Name', ...(WF_CONTROLS[el.type]?.props ?? ['Text']), ...WF_COMMON_PROPS])];
        renderGrid(names.map(prop => wfGridRow(target, prop, isForm, type)));
    }

    /** One VS-style grid row for a WinForms property. */
    function wfGridRow(target, prop, isForm, type) {
        const def = wfPropDef(type, prop);
        const raw = target.props[prop];
        const isSet = raw !== undefined && prop !== 'Name';

        const row = document.createElement('div');
        row.className = 'ff-prop-row' + (isSet ? ' ff-set' : '');
        const lab = document.createElement('label');
        lab.textContent = prop === 'Name' ? '(Name)' : prop;
        row.appendChild(lab);
        attachDesc(row, prop === 'Name' ? '(Name)' : prop, def.desc ?? '');

        const write = code => wfApply(isForm ? wfSetFormLine(prop, code) : wfSetLine(target.name, prop, code));
        const remove = () => {
            if (!isSet || prop === 'ClientSize') { renderPanel(); return; }
            wfApply(isForm ? wfRemoveFormLine(prop) : wfRemoveLine(target.name, prop));
        };
        const display = wfDisplay(def, raw);

        // (Name): renames the control everywhere — Designer.cs + code-behind.
        // The form's own name stays read-only (that is the class name).
        if (def.kind === 'name') {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = target.name;
            if (isForm) {
                input.disabled = true;
                input.title = 'The form name is its class name — rename the class in code (F2).';
            } else {
                input.spellcheck = false;
                input.title = 'Renames the control in the Designer.cs and the code-behind (event handler names are kept, like VS).';
                input.addEventListener('change', () => wfRenameControl(target, input.value));
                input.addEventListener('keydown', e => {
                    if (e.key === 'Enter') { input.blur(); }
                    e.stopPropagation();
                });
            }
            row.appendChild(input);
            return { label: '(Name)', cat: def.cat, node: row };
        }

        if (def.kind === 'items') {
            const ta = document.createElement('textarea');
            ta.className = 'ff-items-edit';
            ta.rows = Math.max(3, (target.items?.length ?? 0) + 1);
            ta.value = (target.items ?? [])
                .map(n => wfString(wfControls.get(n)?.props.Text) ?? n)
                .join('\n');
            ta.placeholder = 'One item per line…';
            ta.spellcheck = false;
            ta.title = 'Each line becomes an item of this strip. Reorder/rename lines to update; remove a line to delete the item.';
            ta.addEventListener('change', () => {
                wfSetStripItems(target, ta.value.split('\n').map(s => s.trim()).filter(Boolean));
            });
            ta.addEventListener('keydown', e => e.stopPropagation());
            row.classList.add('ff-row-tall');
            row.appendChild(ta);
            return { label: prop, cat: def.cat, node: row };
        }

        // Plain-value Items (ListBox, ComboBox, CheckedListBox, DomainUpDown):
        // one string per line, serialized as Items.AddRange(new object[] {...}).
        if (def.kind === 'items-obj') {
            const ta = document.createElement('textarea');
            ta.className = 'ff-items-edit';
            ta.rows = Math.max(3, (target.strItems?.length ?? 0) + 1);
            ta.value = (target.strItems ?? []).join('\n');
            ta.placeholder = 'One item per line…';
            ta.spellcheck = false;
            ta.title = 'Each line becomes one item in the list. Remove a line to delete the item.';
            ta.addEventListener('change', () => {
                wfSetObjItems(target, ta.value.split('\n').map(s => s.trim()).filter(Boolean));
            });
            ta.addEventListener('keydown', e => e.stopPropagation());
            row.classList.add('ff-row-tall');
            row.appendChild(ta);
            return { label: prop, cat: def.cat, node: row };
        }

        if (def.kind === 'bool' || def.kind === 'enum' || def.kind === 'ref') {
            const values = def.kind === 'bool' ? ['True', 'False']
                : def.kind === 'ref' ? [...wfControls.values()].filter(c => c.type === (def.refType ?? 'Button')).map(c => c.name)
                : (WF_ENUM_VALUES[def.enum] ?? []);
            const sel = document.createElement('select');
            const reset = document.createElement('option');
            reset.value = '';
            reset.textContent = isSet ? '(reset)' : (def.def !== undefined ? `(default: ${def.def})` : '(default)');
            sel.appendChild(reset);
            for (const v of values) {
                const opt = document.createElement('option');
                opt.value = opt.textContent = v;
                sel.appendChild(opt);
            }
            sel.value = isSet && values.includes(display) ? display : '';
            sel.addEventListener('change', () => {
                if (sel.value === '') { remove(); return; }
                const code = def.kind === 'bool' ? sel.value.toLowerCase() : wfSerialize(def, sel.value);
                if (code !== null) { write(code); }
            });
            sel.addEventListener('keydown', e => e.stopPropagation());
            row.appendChild(sel);
            return { label: prop, cat: def.cat, node: row };
        }

        if (def.kind === 'anchor') {
            const flags = new Set(isSet ? wfAnchorFlags(String(raw)) : ['Top', 'Left']);
            const box = document.createElement('div');
            box.className = 'ff-anchor-box';
            for (const f of ['Top', 'Bottom', 'Left', 'Right']) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = f;
                btn.title = `Anchor to the ${f.toLowerCase()} edge`;
                if (flags.has(f)) { btn.classList.add('active'); }
                btn.addEventListener('click', () => {
                    if (flags.has(f)) { flags.delete(f); } else { flags.add(f); }
                    write(wfAnchorCode(['Top', 'Bottom', 'Left', 'Right'].filter(x => flags.has(x))));
                });
                box.appendChild(btn);
            }
            row.appendChild(box);
            return { label: prop, cat: def.cat, node: row };
        }

        if (def.kind === 'image' || def.kind === 'icon') {
            const ref = wfImageRef(raw);
            const val = document.createElement('input');
            val.type = 'text';
            val.readOnly = true;
            val.value = ref ? ref.key : '';
            val.placeholder = '(none)';
            val.title = ref ? String(raw) : 'No image set';
            row.appendChild(val);

            const pick = document.createElement('button');
            pick.type = 'button';
            pick.className = 'ff-img-btn';
            pick.textContent = '…';
            pick.title = def.kind === 'icon'
                ? 'Import a .ico file into the project Resources'
                : 'Import an image (.png, .jpg, .gif, .bmp, .ico) into the project Resources';
            pick.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'pickImage',
                    ctrl: isForm ? null : target.name,
                    prop,
                    isForm,
                    iconOnly: def.kind === 'icon'
                });
            });
            row.appendChild(pick);

            if (isSet) {
                const clear = document.createElement('button');
                clear.type = 'button';
                clear.className = 'ff-img-btn';
                clear.textContent = '✕';
                clear.title = 'Remove the image from this property';
                clear.addEventListener('click', remove);
                row.appendChild(clear);
            }
            return { label: prop, cat: def.cat, node: row };
        }

        if (def.kind === 'color') {
            const swatch = document.createElement('input');
            swatch.type = 'color';
            swatch.className = 'ff-color-swatch';
            swatch.value = cssColorToHex(isSet ? wfColor(String(raw)) : '');
            swatch.title = 'Pick a color';
            swatch.addEventListener('change', () => {
                const code = wfColorCode(swatch.value);
                if (code) { write(code); }
            });
            row.appendChild(swatch);

            const input = document.createElement('input');
            input.type = 'text';
            input.value = display ?? '';
            input.placeholder = def.def ?? '';
            input.spellcheck = false;
            input.setAttribute('list', ensureDatalist('ff-dl-colors', [...WF_SYSTEM_COLOR_NAMES, ...WF_NAMED_COLORS]));
            input.addEventListener('change', () => {
                const v = input.value.trim();
                if (v === '') { remove(); return; }
                const code = wfColorCode(v);
                if (code) { write(code); } else { renderPanel(); }
            });
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') { input.blur(); }
                e.stopPropagation();
            });
            row.appendChild(input);
            return { label: prop, cat: def.cat, node: row };
        }

        // Everything else: plain text editor with kind-aware parsing.
        const input = document.createElement('input');
        input.type = 'text';
        input.value = display ?? '';
        input.placeholder = def.def ?? '';
        input.spellcheck = false;
        input.addEventListener('change', () => {
            const v = input.value.trim();
            if (v === '') { remove(); return; }
            const code = wfSerialize(def, v);
            if (code !== null) { write(code); } else { renderPanel(); }
        });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { input.blur(); }
            e.stopPropagation();
        });
        row.appendChild(input);
        return { label: prop, cat: def.cat, node: row };
    }

    function wfEventsTab(el, isForm) {
        const target = isForm ? wfForm : el;
        const events = isForm
            ? WF_FORM_EVENTS
            : ((WF_CONTROLS[el.type] ?? WF_TRAY[el.type])?.events ?? ['Click']);

        const hint = document.createElement('div');
        hint.className = 'ff-events-hint';
        hint.textContent = wfLang === 'vb'
            ? 'Type a handler name (or click ⚡ for the default) to create the Sub with its Handles clause in the code-behind.'
            : 'Type a handler name (or click ⚡ for the default) to wire the event and create the C# stub.';
        propsBody.appendChild(hint);

        for (const ev of events) {
            const row = document.createElement('div');
            row.className = 'ff-prop-row';
            const lab = document.createElement('label');
            lab.textContent = ev;
            row.appendChild(lab);

            const input = document.createElement('input');
            input.type = 'text';
            input.value = target.events[ev] ?? '';
            input.placeholder = `${isForm ? wfForm.name : el.name}_${ev}`;
            input.spellcheck = false;
            input.addEventListener('change', () => {
                if (input.value.trim() === '') { wfUnwireEvent(target, ev); }
                else { wfWireEvent(target, ev, input.value.trim(), false); }
            });
            input.addEventListener('keydown', e => e.stopPropagation());
            row.appendChild(input);

            const btn = document.createElement('button');
            btn.className = 'ff-wire';
            btn.title = 'Wire event and open the handler';
            btn.textContent = '⚡';
            btn.addEventListener('click', () => wfWireEvent(target, ev, input.value.trim()));
            row.appendChild(btn);

            propsBody.appendChild(row);
        }
    }

    function wfQuote(s) {
        if (wfLang === 'vb') {
            // VB strings double their quotes; backslashes are literal.
            return `"${s.replace(/"/g, '""')}"`;
        }
        return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }

    /** Parse "12, 34" (or "12 34") into two integers. */
    function wfPair(v) {
        const m = /^\s*(-?\d+)\s*[,x ]\s*(-?\d+)\s*$/.exec(v);
        return m ? { a: +m[1], b: +m[2] } : null;
    }

    // ================================================================ helpers

    function num(v, fallback) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function int(v, fallback = 0) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : fallback;
    }

    /** Collapse XML text runs ("  How to\n   Repair " -> "How to Repair"). */
    function collapse(s) {
        return (s || '').replace(/\s+/g, ' ').trim();
    }

    /** Escape a literal string for use inside a RegExp. */
    function reEsc(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** Translate a XAML brush value to CSS ("#AARRGGBB" -> rgba, names pass through). */
    function toCssColor(v) {
        if (!v) { return ''; }
        const m = /^#([0-9a-fA-F]{8})$/.exec(v.trim());
        if (m) {
            const a = parseInt(m[1].slice(0, 2), 16) / 255;
            const r = parseInt(m[1].slice(2, 4), 16);
            const g = parseInt(m[1].slice(4, 6), 16);
            const b = parseInt(m[1].slice(6, 8), 16);
            return `rgba(${r},${g},${b},${a.toFixed(3)})`;
        }
        // #RRGGBB and named colors are valid CSS already; anything exotic
        // (gradients, resources) is ignored in the preview.
        return /^[#a-zA-Z]/.test(v.trim()) && !v.includes('{') ? v.trim() : '';
    }

    function escapeXml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function setStatus(text) {
        statusEl.textContent = text;
    }

    // ==================================================================== boot

    buildToolbox();
    initFormGrips();
    vscode.postMessage({ type: 'ready' });

    // Test hook: the node test suite loads this file with a stub DOM and
    // exercises the pure text-transform internals. Webviews never set the
    // flag, so this block is inert in production.
    if (typeof globalThis !== 'undefined' && globalThis.__UIMAKER_TEST__) {
        globalThis.__uimakerTest = {
            setDoc(name, text) { config.docName = name; xamlText = text; parseAndRender(); },
            setVbHandles(entries) { wfVbHandles = entries; },
            setAppResources(texts) {
                appResourceTexts = texts;
                if (docMode === 'xaml' && xamlText) { parseAndRender(); }
            },
            /** Resolved CSS brush for an element path ('' = window) + property. */
            probeStyle(pathStr, prop) {
                const el = pathStr === '' ? windowEl : elAtPath(pathStr);
                return el ? resolveBrush(styleProp(el, prop)) : null;
            },
            /** Raw effective style value (post-Style-chain, pre-brush-resolve). */
            probeProp(pathStr, prop) {
                const el = pathStr === '' ? windowEl : elAtPath(pathStr);
                return el ? styleProp(el, prop) : null;
            },
            get lang() { return wfLang; },
            get text() { return xamlText; },
            get controls() { return wfControls; },
            get form() { return wfForm; },
            wfSetLine, wfSetFormLine, wfRemoveControlLines, wfRenameControl,
            wfAddControl, wfDeleteControls, wfWireEvent, wfUnwireEvent,
            wfInitializeComponentBody, wfInsertField, wfAddComponent,
            wfCode, wfQuote, wfSerialize, wfDisplay, wfString, wfFont,
            wfApply
        };
    }
})();
