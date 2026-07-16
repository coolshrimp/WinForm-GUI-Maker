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
//   { type: 'edit', text }                       replace the document text
//   { type: 'openCode' }                         open XAML source split view
//   { type: 'addHandler', handler, event }       create/reveal C# handler stub
//
// Messages from the extension host:
//   { type: 'update', text }                     document text changed
//   { type: 'config', gridSize, snap, docName }  settings

(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // ------------------------------------------------------------- namespaces

    const PRES_NS = 'http://schemas.microsoft.com/winfx/2006/xaml/presentation';
    const X_NS = 'http://schemas.microsoft.com/winfx/2006/xaml';

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

    /** Properties shown for every control, in panel order. */
    const COMMON_PROPS = ['Width', 'Height', 'Margin', 'HorizontalAlignment', 'VerticalAlignment',
        'Grid.Row', 'Grid.Column', 'Background', 'Foreground',
        'FontSize', 'FontWeight', 'IsEnabled', 'Visibility', 'ToolTip'];

    /** Window-level properties/events shown when nothing is selected. */
    const WINDOW_PROPS = ['Title', 'Width', 'Height', 'Background', 'ResizeMode', 'WindowStartupLocation'];
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
        WindowStartupLocation: ['Manual', 'CenterScreen', 'CenterOwner']
    };

    /** Panels that accept toolbox drops. */
    const DROP_PANELS = ['Grid', 'Canvas', 'StackPanel', 'WrapPanel', 'DockPanel'];

    /** Property-grid categories for XAML attributes (default: Common). */
    const XAML_CATS = {
        Width: 'Layout', Height: 'Layout', Margin: 'Layout', Padding: 'Layout',
        HorizontalAlignment: 'Layout', VerticalAlignment: 'Layout',
        'Grid.Row': 'Layout', 'Grid.Column': 'Layout',
        Background: 'Appearance', Foreground: 'Appearance', FontSize: 'Appearance',
        FontWeight: 'Appearance', BorderBrush: 'Appearance', BorderThickness: 'Appearance',
        CornerRadius: 'Appearance', Title: 'Appearance',
        IsEnabled: 'Behavior', Visibility: 'Behavior', ToolTip: 'Behavior',
        ResizeMode: 'Window Style', WindowStartupLocation: 'Layout'
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
        WindowStartupLocation: 'Where the window first appears on screen.'
    };

    // ------------------------------------------------------------------ state

    let docMode = 'xaml';       // 'xaml' (WPF markup) | 'winforms' (*.Designer.cs)
    let xamlText = '';          // last text we parsed or produced
    let xamlDoc = null;         // XMLDocument of the current XAML
    let windowEl = null;        // root element (Window / UserControl / Page)
    let contentRoot = null;     // the window's single content element
    let layoutRoot = null;      // top-level panel used for fallback drops
    let selected = null;        // selected XML element / WinForms record / null
    let selectedPath = '';      // index path of the selection (survives re-parse)
    let visuals = [];           // [{ el, div }] rendered this pass
    let styles = { byKey: new Map(), byType: new Map() }; // resolved <Style> resources
    let wfControls = new Map(); // WinForms mode: name -> control record
    let wfForm = null;          // WinForms mode: the form itself
    let wfStyle = { thisPrefix: true, qualified: true }; // code dialect of the file
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
        if (msg.type === 'update') {
            if (msg.text === xamlText) { return; } // echo of our own edit
            xamlText = msg.text;
            parseAndRender();
        } else if (msg.type === 'config') {
            config.gridSize = msg.gridSize ?? config.gridSize;
            config.snap = msg.snap ?? config.snap;
            config.docName = msg.docName ?? config.docName;
            $('ff-grid').value = String(config.gridSize);
            $('ff-snap').checked = config.snap;
            render();
        } else if (msg.type === 'imageSet') {
            // Host imported an image for a property — write the assignment.
            imageCache.set(`p:${msg.key}`, msg.uri);
            if (docMode === 'winforms') {
                wfApply(msg.isForm
                    ? wfSetFormLine(msg.prop, msg.code)
                    : wfSetLine(msg.ctrl, msg.prop, msg.code));
            }
        } else if (msg.type === 'images') {
            // Host resolved referenced images — cache and redraw.
            for (const [k, v] of Object.entries(msg.images ?? {})) { imageCache.set(k, v); }
            if (docMode === 'winforms') { wfRender(); }
        }
    });

    // ================================================================= parsing

    function parseAndRender() {
        bannerEl.hidden = true;

        // WinForms designer files are C#, not XAML — hand them to the
        // dedicated parser/renderer.
        const wantWinForms = /\.designer\.cs$/i.test(config.docName)
            || (/InitializeComponent\s*\(\s*\)/.test(xamlText) && /System\.Windows\.Forms/.test(xamlText));
        if (wantWinForms) {
            if (docMode !== 'winforms') { docMode = 'winforms'; buildToolbox(); }
            wfParseAndRender();
            return;
        }
        if (docMode !== 'xaml') { docMode = 'xaml'; buildToolbox(); }

        if (!xamlText.trim()) {
            xamlDoc = windowEl = contentRoot = layoutRoot = selected = null;
            showBanner('This file is empty.', 'Insert starter window', insertStarterXaml);
            renderEmpty();
            return;
        }

        const parsed = new DOMParser().parseFromString(xamlText, 'text/xml');
        if (parsed.getElementsByTagName('parsererror').length) {
            // Keep the last good render; just warn.
            showBanner('The XAML has syntax errors — fix them in the code view.', '</> View Code',
                () => vscode.postMessage({ type: 'openCode' }));
            return;
        }

        xamlDoc = parsed;
        windowEl = xamlDoc.documentElement;
        collectStyles();
        selected = restoreSelection();

        if (windowEl.localName === 'Application') {
            contentRoot = layoutRoot = null;
            showBanner('App.xaml holds application resources, not a visual layout. Open a Window instead.',
                '</> View Code', () => vscode.postMessage({ type: 'openCode' }));
            renderEmpty();
            return;
        }

        // The window's content is its first non-property element child
        // (skipping <Window.Resources> and friends).
        contentRoot = elementChildren(windowEl)[0] ?? null;
        layoutRoot = contentRoot && DROP_PANELS.includes(contentRoot.localName) ? contentRoot : null;

        render();
    }

    /** Direct element children, excluding property elements like <Grid.RowDefinitions>. */
    function elementChildren(parent) {
        return [...parent.children].filter(c => !c.localName.includes('.'));
    }

    /** The property element <Type.Name> of `el`, or null. */
    function propertyElement(el, name) {
        return [...el.children].find(c => c.localName === `${el.localName}.${name}`) ?? null;
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
        styles = { byKey: new Map(), byType: new Map() };
        if (!windowEl) { return; }
        for (const child of windowEl.children) {
            if (!child.localName.endsWith('.Resources')) { continue; }
            collectStylesFrom(child);
        }
    }

    function collectStylesFrom(container) {
        for (const node of container.children) {
            if (node.localName === 'ResourceDictionary') { collectStylesFrom(node); continue; }
            if (node.localName !== 'Style') { continue; }
            const setters = {};
            for (const s of node.children) {
                if (s.localName !== 'Setter') { continue; }
                const p = (s.getAttribute('Property') || '').split('.').pop();
                const v = s.getAttribute('Value');
                if (p && v !== null && !v.includes('{')) { setters[p] = v; }
            }
            const basedOn = resourceKey(node.getAttribute('BasedOn'));
            const entry = { setters, basedOn };
            const key = node.getAttributeNS(X_NS, 'Key') || node.getAttribute('x:Key');
            const target = (node.getAttribute('TargetType') || '').split(':').pop();
            if (key) { styles.byKey.set(key, entry); }
            else if (target) { styles.byType.set(target, entry); }
        }
    }

    /** Extract KEY from "{StaticResource KEY}" / "{DynamicResource KEY}". */
    function resourceKey(v) {
        const m = /\{\s*(?:StaticResource|DynamicResource)\s+([^}]+?)\s*\}/.exec(v || '');
        return m ? m[1] : null;
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
            entry = styles.byKey.get(entry.basedOn) ?? null;
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

        const bg = toCssColor(windowEl.getAttribute('Background')) || '#ffffff';
        surfaceEl.style.background = bg;
        surfaceEl.style.setProperty('--ff-surface-bg', bg);

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
        const bg = toCssColor(styleProp(el, 'Background'));
        const fg = toCssColor(styleProp(el, 'Foreground'));
        if (bg) { div.style.background = bg; }
        if (fg) { div.style.color = fg; }
        const fs = num(styleProp(el, 'FontSize'), NaN);
        if (Number.isFinite(fs)) { div.style.fontSize = `${fs}px`; }
        const fw = styleProp(el, 'FontWeight');
        if (fw) { div.style.fontWeight = fw.toLowerCase() === 'bold' ? 'bold' : fw; }
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
                if (kids.length) {
                    inner.textContent = '';
                    singleCell(inner);
                    for (const c of kids) { inner.appendChild(renderElement(c, 'cell')); }
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
            case 'Image':
                inner.classList.add('ff-look-image');
                inner.textContent = '🖼';
                break;
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
        return inner;
    }

    function applyBorder(target, el) {
        const brush = toCssColor(styleProp(el, 'BorderBrush')) || '#808080';
        const t = parseMargin(styleProp(el, 'BorderThickness') || '1');
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

    function select(el) {
        selected = el;
        selectedPath = (el && !el.__wf) ? pathOf(el) : '';
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
        // Remove previous overlay.
        surfaceEl.querySelectorAll('.ff-selection').forEach(n => n.remove());
        const hit = visuals.find(v => v.el === selected);
        if (!hit) {
            setStatus(windowEl ? `${windowEl.localName} — click a control to select it` : 'Ready');
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
        setStatus(`${getName(selected) || wfType(selected)} — ${Math.round(box.w)}×${Math.round(box.h)} ${place}`);
    }

    // Clicking empty canvas selects the window itself.
    surfaceEl.addEventListener('mousedown', () => {
        select(null);
    });

    // Keep the overlay glued to the control when an inner ScrollViewer scrolls.
    surfaceEl.addEventListener('scroll', () => drawSelection(), true);

    // ------------------------------------------------------------ move/resize

    function startMove(e, el, div) {
        const mode = movability(el);
        if (!mode) { return; } // selection only — parent panel owns the position

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
            const nx = snap(Math.max(0, start.x + dx));
            const ny = snap(Math.max(0, start.y + dy));
            apply(nx, ny);
            drawSelectionAround(div);
            setStatus(`${getName(el) || wfType(el)} — (${nx}, ${ny})`);
        };
        const onUp = ev => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (!moved) { return; }
            const nx = snap(Math.max(0, start.x + (ev.clientX - sx) / zoom));
            const ny = snap(Math.max(0, start.y + (ev.clientY - sy) / zoom));
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
        host.innerHTML = '';
        const catalog = docMode === 'winforms' ? WF_CONTROLS : CONTROLS;
        for (const [type, def] of Object.entries(catalog)) {
            const item = document.createElement('div');
            item.className = 'ff-tool';
            item.draggable = true;
            item.innerHTML = `<span class="ff-tool-icon">${def.icon}</span>${type}`;
            item.addEventListener('dragstart', e => {
                e.dataTransfer.setData('text/uimaker-control', type);
                e.dataTransfer.effectAllowed = 'copy';
            });
            host.appendChild(item);
        }
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
                setName(el, v.trim());
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
            const node = propRow(prop, el.getAttribute(prop) ?? '', v => {
                if (v === '') { el.removeAttribute(prop); } else { el.setAttribute(prop, v); }
                commit();
            }, ENUM_VALUES[prop]);
            if (el.getAttribute(prop) !== null) { node.classList.add('ff-set'); }
            attachDesc(node, prop, XAML_DESCS[prop] ?? '');
            rows.push({ label: prop, cat: XAML_CATS[prop] ?? 'Common', node });
        }
        renderGrid(rows);
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
            if (input.value.trim() === '') { el.removeAttribute(eventName); }
            else { el.setAttribute(eventName, input.value.trim()); }
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
        el.setAttribute(eventName, finalName);
        commit();
        vscode.postMessage({ type: 'addHandler', handler: finalName, event: eventName });
    }

    function wireDefaultEvent(el) {
        if (el.__wf) {
            const wdef = WF_CONTROLS[el.type];
            activeTab = 'events';
            $('ff-tab-props').classList.remove('active');
            $('ff-tab-events').classList.add('active');
            wfWireEvent(el, wdef?.defaultEvent ?? 'Click', el.events[wdef?.defaultEvent ?? 'Click'] || '');
            return;
        }
        const def = CONTROLS[el.localName];
        if (!def) { return; }
        // Switch to the events tab so the user sees what happened.
        activeTab = 'events';
        $('ff-tab-props').classList.remove('active');
        $('ff-tab-events').classList.add('active');
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
        xamlText = formatElement(xamlDoc.documentElement, 0).trimStart() + '\n';
        vscode.postMessage({ type: 'edit', text: xamlText });
        render();
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
        if (node.nodeType !== Node.ELEMENT_NODE) { return ''; }

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
            || e.target instanceof HTMLButtonElement) { return; }
        if (!selected) { return; }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            deleteSelected();
            e.preventDefault();
        } else if (e.key === 'Escape') {
            select(null);
        } else if (e.key.startsWith('Arrow')) {
            const mode = movability(selected);
            if (!mode) { return; }
            const step = e.shiftKey ? config.gridSize : 1;
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
            if (mode === 'wf') {
                const p = wfPoint(selected.props.Location) ?? { x: 0, y: 0 };
                wfApply(wfSetLine(selected.name, 'Location',
                    `new System.Drawing.Point(${Math.max(0, p.x + dx)}, ${Math.max(0, p.y + dy)})`));
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
            if (selected !== wfForm) { wfDeleteControl(selected); }
            return;
        }
        selected.remove();
        selected = null;
        selectedPath = '';
        commit();
    }

    // ================================================================ toolbar

    $('ff-btn-code').addEventListener('click', () => vscode.postMessage({ type: 'openCode' }));
    $('ff-btn-delete').addEventListener('click', deleteSelected);
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
        activeTab = 'props';
        $('ff-tab-props').classList.add('active');
        $('ff-tab-events').classList.remove('active');
        renderPanel();
    });
    $('ff-tab-events').addEventListener('click', () => {
        activeTab = 'events';
        $('ff-tab-events').classList.add('active');
        $('ff-tab-props').classList.remove('active');
        renderPanel();
    });

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
        xamlText = starter;
        vscode.postMessage({ type: 'edit', text: starter });
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
     *  gets WF_COMMON_PROPS (layout, colors, behavior, accessibility). */
    const WF_CONTROLS = {
        Button:         { icon: '▭', w: 75,  h: 23,  text: 'button',      props: ['Text', 'TextAlign', 'Image', 'ImageAlign', 'TextImageRelation', 'BackgroundImage', 'BackgroundImageLayout', 'FlatStyle', 'UseVisualStyleBackColor', 'UseMnemonic', 'AutoEllipsis', 'DialogResult'], events: ['Click', 'MouseDown', 'MouseUp', 'DoubleClick'], defaultEvent: 'Click' },
        Label:          { icon: 'A',  w: 60,  h: 15,  text: 'label',       props: ['Text', 'TextAlign', 'Image', 'ImageAlign', 'BorderStyle', 'UseMnemonic', 'AutoEllipsis'], events: ['Click', 'DoubleClick'], defaultEvent: 'Click' },
        LinkLabel:      { icon: '🔗', w: 80,  h: 15,  text: 'linkLabel',   props: ['Text', 'TextAlign', 'BorderStyle', 'UseMnemonic', 'AutoEllipsis', 'LinkColor'], events: ['LinkClicked', 'Click'], defaultEvent: 'LinkClicked' },
        TextBox:        { icon: '⌨', w: 100, h: 23,  text: '',            props: ['Text', 'PlaceholderText', 'ReadOnly', 'Multiline', 'WordWrap', 'MaxLength', 'PasswordChar', 'CharacterCasing', 'ScrollBars', 'TextAlign'], events: ['TextChanged', 'KeyDown', 'KeyPress', 'Leave'], defaultEvent: 'TextChanged' },
        CheckBox:       { icon: '☑', w: 90,  h: 19,  text: 'checkBox',    props: ['Text', 'Checked', 'ThreeState', 'TextAlign', 'CheckAlign', 'Image', 'ImageAlign', 'FlatStyle', 'UseVisualStyleBackColor', 'UseMnemonic'], events: ['CheckedChanged', 'Click'], defaultEvent: 'CheckedChanged' },
        RadioButton:    { icon: '◉', w: 95,  h: 19,  text: 'radioButton', props: ['Text', 'Checked', 'TextAlign', 'CheckAlign', 'Image', 'ImageAlign', 'FlatStyle', 'UseVisualStyleBackColor', 'UseMnemonic'], events: ['CheckedChanged', 'Click'], defaultEvent: 'CheckedChanged' },
        ComboBox:       { icon: '▾', w: 121, h: 23,  text: '',            props: ['Text', 'DropDownStyle', 'MaxDropDownItems', 'Sorted'], events: ['SelectedIndexChanged', 'TextChanged'], defaultEvent: 'SelectedIndexChanged' },
        ListBox:        { icon: '≡', w: 120, h: 94,  text: '',            props: ['SelectionMode', 'Sorted', 'MultiColumn'], events: ['SelectedIndexChanged', 'DoubleClick'], defaultEvent: 'SelectedIndexChanged' },
        ListView:       { icon: '☰', w: 160, h: 97,  text: '',            props: ['View', 'FullRowSelect', 'GridLines', 'MultiSelect', 'CheckBoxes'], events: ['SelectedIndexChanged', 'DoubleClick'], defaultEvent: 'SelectedIndexChanged' },
        TreeView:       { icon: '🌲', w: 160, h: 97,  text: '',            props: ['CheckBoxes', 'ShowLines', 'ShowRootLines'], events: ['AfterSelect', 'DoubleClick'], defaultEvent: 'AfterSelect' },
        DataGridView:   { icon: '▦', w: 240, h: 150, text: '',            props: ['ReadOnly', 'AllowUserToAddRows', 'AllowUserToDeleteRows', 'MultiSelect', 'RowHeadersVisible'], events: ['CellClick', 'CellValueChanged', 'SelectionChanged'], defaultEvent: 'CellClick' },
        PictureBox:     { icon: '🖼', w: 100, h: 50,  text: '',            props: ['Image', 'SizeMode', 'BorderStyle', 'BackgroundImage', 'BackgroundImageLayout'], events: ['Click', 'DoubleClick'], defaultEvent: 'Click' },
        ProgressBar:    { icon: '▱', w: 100, h: 23,  text: '',            props: ['Minimum', 'Maximum', 'Value', 'Style'], events: ['Click'], defaultEvent: 'Click' },
        TrackBar:       { icon: '⬌', w: 104, h: 45,  text: '',            props: ['Minimum', 'Maximum', 'Value', 'TickFrequency', 'SmallChange', 'LargeChange', 'Orientation'], events: ['Scroll', 'ValueChanged'], defaultEvent: 'Scroll' },
        NumericUpDown:  { icon: '↕', w: 120, h: 23,  text: '',            props: ['Minimum', 'Maximum', 'Value', 'Increment', 'DecimalPlaces', 'ThousandsSeparator', 'ReadOnly', 'TextAlign'], events: ['ValueChanged'], defaultEvent: 'ValueChanged' },
        DateTimePicker: { icon: '📅', w: 200, h: 23,  text: '',            props: ['Format', 'CustomFormat', 'ShowUpDown'], events: ['ValueChanged'], defaultEvent: 'ValueChanged' },
        MaskedTextBox:  { icon: '#',  w: 100, h: 23,  text: '',            props: ['Text', 'Mask', 'ReadOnly', 'TextAlign'], events: ['TextChanged'], defaultEvent: 'TextChanged' },
        RichTextBox:    { icon: '¶',  w: 150, h: 96,  text: '',            props: ['Text', 'ReadOnly', 'Multiline', 'WordWrap', 'MaxLength', 'ScrollBars'], events: ['TextChanged'], defaultEvent: 'TextChanged' },
        GroupBox:       { icon: '⬒', w: 200, h: 100, text: 'groupBox',    props: ['Text', 'FlatStyle', 'BackgroundImage', 'BackgroundImageLayout'], events: ['Enter'], defaultEvent: 'Enter' },
        Panel:          { icon: '▢', w: 200, h: 100, text: '',            props: ['BorderStyle', 'AutoScroll', 'BackgroundImage', 'BackgroundImageLayout'], events: ['Click', 'Paint'], defaultEvent: 'Click' }
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
        Paint:            { handler: 'System.Windows.Forms.PaintEventHandler', args: 'PaintEventArgs' }
    };
    const WF_DEFAULT_EVENT_TYPE = { handler: 'System.EventHandler', args: 'EventArgs' };

    const WF_FORM_EVENTS = ['Load', 'Shown', 'FormClosing', 'Resize', 'KeyDown'];
    const WF_CONTAINERS = ['GroupBox', 'Panel', 'TabPage'];

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
        AcceptButton:          { cat: 'Misc', kind: 'ref', def: '(none)', desc: 'The button clicked when the user presses Enter.' },
        CancelButton:          { cat: 'Misc', kind: 'ref', def: '(none)', desc: 'The button clicked when the user presses Esc.' },
        // Data / Focus / Accessibility
        Tag:                   { cat: 'Data', kind: 'string', desc: 'User-defined data associated with the object.' },
        CausesValidation:      { cat: 'Focus', kind: 'bool', def: 'True', desc: 'Whether the control triggers validation on controls losing focus to it.' },
        AccessibleName:        { cat: 'Accessibility', kind: 'string', desc: 'The name reported to accessibility client applications.' },
        AccessibleDescription: { cat: 'Accessibility', kind: 'string', desc: 'The description reported to accessibility client applications.' },
        AccessibleRole:        { cat: 'Accessibility', kind: 'enum', enum: 'AccessibleRole', def: 'Default', desc: 'The role reported to accessibility client applications.' }
    };

    /** Per-type descriptor overrides (same property name, different type). */
    const WF_PROP_OVERRIDES = {
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

        const cls = /partial\s+class\s+(\w+)/.exec(text);
        wfForm = { __wf: true, name: cls ? cls[1] : 'Form', type: 'Form', props: {}, events: {}, children: [] };

        if (!/InitializeComponent\s*\(\s*\)[\s\S]*?\{/.test(text)) {
            showBanner('No InitializeComponent method found — this Designer.cs file has no form layout to design.');
            renderEmpty();
            return;
        }

        // The generated code comes in two dialects. Classic (.NET Framework /
        // VS pre-2022): "this.button1 = new System.Windows.Forms.Button();".
        // Modern (.NET 6+ / VS 2022): "button1 = new Button();" — no "this."
        // and no namespace qualification. Parsing accepts both; edits are
        // written back in whichever dialect the file already uses.
        wfStyle = {
            thisPrefix: /^[ \t]*this\.\w+\s*=\s*new\s/m.test(text),
            qualified: /new\s+System\.(?:Windows\.Forms|Drawing)\./.test(text)
        };

        // Control instantiations: [this.]name = new [System.Windows.Forms.]Type(...);
        // In the modern dialect, form-level value assignments look identical
        // ("ClientSize = new Size(954, 1028);"), so known value types must be
        // excluded here or they shadow the real form properties.
        const valueTypes = new Set([
            'Container', 'ComponentResourceManager', 'Size', 'SizeF', 'Point', 'PointF',
            'Font', 'Padding', 'Rectangle', 'RectangleF', 'Color', 'Icon', 'Bitmap'
        ]);
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?(\w+)\s*=\s*new\s+(?:System\.Windows\.Forms\.)?(\w+)\s*\(/gm)) {
            if (m[1] === 'components' || valueTypes.has(m[2])) { continue; }
            wfControls.set(m[1], {
                __wf: true, name: m[1], type: m[2],
                props: {}, events: {}, children: [], columns: [], items: [], parent: null
            });
        }

        // Property assignments (single-line): [this.]name.Prop = value;
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?(\w+)\.([\w]+)\s*=\s*(.+);\s*$/gm)) {
            const ctrl = wfControls.get(m[1]);
            if (ctrl) { ctrl.props[m[2]] = m[3]; }
        }

        // Form-level assignments: [this.]Prop = value; (control names filtered out).
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?(\w+)\s*=\s*(.+);\s*$/gm)) {
            if (!wfControls.has(m[1])) { wfForm.props[m[1]] = m[2]; }
        }

        // Events, both "x.Click += new EventHandler(this.H);" and "x.Click += H;".
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?(\w+)\.(\w+)\s*\+=\s*(?:new\s+[\w\.]+\(\s*)?(?:this\.)?(\w+)\s*\)?\s*;/gm)) {
            const ctrl = wfControls.get(m[1]);
            if (ctrl) { ctrl.events[m[2]] = m[3]; }
        }
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?(\w+)\s*\+=\s*(?:new\s+[\w\.]+\(\s*)?(?:this\.)?(\w+)\s*\)?\s*;/gm)) {
            if (!wfControls.has(m[1])) { wfForm.events[m[1]] = m[2]; }
        }

        // Hierarchy: parent.Controls.Add(child) / Controls.Add(child).
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?(\w+)\.Controls\.Add\((?:this\.)?(\w+)\);/gm)) {
            const parent = wfControls.get(m[1]);
            const child = wfControls.get(m[2]);
            if (parent && child) { parent.children.push(child); child.parent = parent; }
        }
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?Controls\.Add\((?:this\.)?(\w+)\);/gm)) {
            const child = wfControls.get(m[1]);
            if (child) { wfForm.children.push(child); child.parent = wfForm; }
        }

        // Controls.AddRange(new Control[] { a, b, ... }) — parent and form level.
        for (const m of text.matchAll(/^[ \t]*(?:this\.)?(?:(\w+)\.)?Controls\.AddRange\([^{]*\{([\s\S]*?)\}\)/gm)) {
            const parent = m[1] ? wfControls.get(m[1]) : wfForm;
            if (!parent) { continue; }
            for (const n of m[2].matchAll(/(?:this\.)?(\w+)/g)) {
                const child = wfControls.get(n[1]);
                if (child && !child.parent) { parent.children.push(child); child.parent = parent; }
            }
        }

        // DataGridView columns / MenuStrip items (multi-line AddRange arrays).
        for (const m of text.matchAll(/(?:this\.)?(\w+)\.Columns\.AddRange\([^{]*\{([\s\S]*?)\}\)/g)) {
            const ctrl = wfControls.get(m[1]);
            if (ctrl) { ctrl.columns = [...m[2].matchAll(/(?:this\.)?(\w+)/g)].map(x => x[1]).filter(n => wfControls.has(n)); }
        }
        for (const m of text.matchAll(/(?:this\.)?(\w+)\.Items\.AddRange\([^{]*\{([\s\S]*?)\}\)/g)) {
            const ctrl = wfControls.get(m[1]);
            if (ctrl) { ctrl.items = [...m[2].matchAll(/(?:this\.)?(\w+)/g)].map(x => x[1]).filter(n => wfControls.has(n)); }
        }

        // Re-select the record with the same name after the re-parse.
        if (selected && selected.__wf) {
            selected = selected.type === 'Form' ? wfForm : (wfControls.get(selected.name) ?? null);
        } else if (selected) {
            selected = null; // switched over from a XAML document
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
        // Controls.Add order is reverse z-order: first added paints on top.
        for (const child of [...wfForm.children].reverse()) {
            surfaceEl.appendChild(wfVisual(child));
        }

        drawSelection();
        renderPanel();
    }

    /** Absolute-positioned visual for one WinForms control (recursive). */
    function wfVisual(ctrl) {
        const div = document.createElement('div');
        div.className = `ff-control ff-movable ff-c-wf-${ctrl.type.toLowerCase()}`;
        const loc = wfPoint(ctrl.props.Location) ?? { x: 0, y: 0 };
        const size = wfSizeVal(ctrl.props.Size) ?? { w: 100, h: 23 };
        div.style.position = 'absolute';
        div.style.left = `${loc.x}px`;
        div.style.top = `${loc.y}px`;
        div.style.width = `${size.w}px`;
        div.style.height = `${size.h}px`;

        // Dock overrides Location: stretch along the docked edge(s). This is an
        // approximation — multiple docked siblings do not push each other.
        const dock = /DockStyle\.(\w+)/.exec(ctrl.props.Dock ?? '')?.[1];
        if (dock && dock !== 'None') {
            div.style.left = '0';
            div.style.top = '0';
            if (dock === 'Fill') { div.style.width = '100%'; div.style.height = '100%'; }
            else if (dock === 'Top') { div.style.width = '100%'; }
            else if (dock === 'Bottom') { div.style.top = 'auto'; div.style.bottom = '0'; div.style.width = '100%'; }
            else if (dock === 'Left') { div.style.height = '100%'; }
            else if (dock === 'Right') { div.style.left = 'auto'; div.style.right = '0'; div.style.height = '100%'; }
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
            select(ctrl);
            // Docked controls are laid out by the framework — select only.
            if (!div.classList.contains('ff-docked')) {
                startMove(e, ctrl, div);
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

        switch (ctrl.type) {
            case 'GroupBox': {
                div.classList.add('ff-wf-group');
                const header = document.createElement('span');
                header.className = 'ff-wf-group-header';
                header.textContent = text || ctrl.name;
                div.appendChild(header);
                for (const c of [...ctrl.children].reverse()) { div.appendChild(wfVisual(c)); }
                return;
            }
            case 'Panel':
                div.classList.add('ff-wf-panel');
                for (const c of [...ctrl.children].reverse()) { div.appendChild(wfVisual(c)); }
                return;
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
                    for (const c of [...pg.children].reverse()) { page.appendChild(wfVisual(c)); }
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
                if (ctrl.props.Multiline?.trim() === 'true') { inner.classList.add('ff-look-textarea'); }
                inner.textContent = text;
                break;
            case 'RichTextBox':
                inner.classList.add('ff-look-input', 'ff-look-textarea');
                inner.textContent = text;
                break;
            case 'CheckBox':
                inner.classList.add('ff-look-label');
                inner.innerHTML = `<span class="ff-glyph">${ctrl.props.Checked?.trim() === 'true' ? '☑' : '☐'}</span>`;
                inner.append(text || ctrl.name);
                break;
            case 'RadioButton':
                inner.classList.add('ff-look-label');
                inner.innerHTML = `<span class="ff-glyph">${ctrl.props.Checked?.trim() === 'true' ? '◉' : '○'}</span>`;
                inner.append(text || ctrl.name);
                break;
            case 'ComboBox':
                inner.classList.add('ff-look-input');
                inner.innerHTML = `${escapeHtml(text)}<span class="ff-combo-arrow">▾</span>`;
                break;
            case 'ListBox':
            case 'ListView':
            case 'TreeView':
                inner.classList.add('ff-look-list');
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
        const m = /new\s+(?:System\.Drawing\.)?Font\("([^"]+)",\s*([\d.]+)F?/.exec(v ?? '');
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

    /** Parse a C# image expression into { scope: 'p'|'l', key } (or null). */
    function wfImageRef(raw) {
        if (!raw) { return null; }
        let m = /Properties\.Resources\.(\w+)/.exec(raw);
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
        const m = /new\s+(?:System\.Drawing\.)?Font\("([^"]+)",\s*([\d.]+)F?/.exec(v ?? '');
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
        const size = `${parseFloat(m[2])}F`;
        const base = `new System.Drawing.Font("${m[1].trim()}", ${size}`;
        if (!styles.length) { return `${base})`; }
        if (styles.length === 1) { return `${base}, System.Drawing.FontStyle.${styles[0]})`; }
        return `${base}, (${styles.map(s => `System.Drawing.FontStyle.${s}`).join(' | ')}))`;
    }

    /** Numeric value of "new decimal(new int[] { lo, mid, hi, flags })". */
    function wfDecimalVal(v) {
        const m = /new\s+decimal\(new\s+int\[\]\s*\{\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}\)/.exec(v ?? '');
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
        return `new decimal(new int[] { ${lo}, 0, 0, ${flags} })`;
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
            case 'char': { const m = /^'\\?(.)'$/.exec(v); return m ? m[1] : v; }
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

    /** User input -> C# code for the property, or null when invalid. */
    function wfSerialize(def, input) {
        const v = input.trim();
        switch (def.kind) {
            case 'string': return wfQuote(v);
            case 'bool': return /^t/i.test(v) ? 'true' : 'false';
            case 'int': { const n = parseInt(v, 10); return Number.isFinite(n) ? String(n) : null; }
            case 'float': { const n = parseFloat(v); return Number.isFinite(n) ? `${n}D` : null; }
            case 'decimal': return wfDecimalCode(v);
            case 'char': { if (!v) { return null; } const c = v[0]; return c === "'" ? "'\\''" : c === '\\' ? "'\\\\'" : `'${c}'`; }
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
        xamlText = newText;
        vscode.postMessage({ type: 'edit', text: newText });
        wfParseAndRender();
    }

    /** "this.name" or plain "name", matching the file's dialect. */
    function wfRef(name) {
        return wfStyle.thisPrefix ? `this.${name}` : name;
    }

    /** Strip namespace qualification from generated code on modern-style files. */
    function wfCode(code) {
        return wfStyle.qualified ? code : code.replace(/\bSystem\.(?:Windows\.Forms|Drawing)\./g, '');
    }

    /**
     * Replace "[this.]<name>.<prop> = ...;" or insert it into the control's
     * statement block. Returns the new text (does not apply it).
     */
    function wfSetLine(name, prop, code, text = xamlText) {
        const line = `${wfRef(name)}.${prop} = ${wfCode(code)};`;
        const re = new RegExp(`^([ \\t]*)(?:this\\.)?${name}\\.${prop}\\s*=[^\\n]*;[ \\t]*$`, 'm');
        if (re.test(text)) {
            return text.replace(re, `$1${line}`);
        }
        // Insert after the first existing statement of this control's block.
        const anchor = new RegExp(`^([ \\t]*)(?:this\\.)?${name}\\.[\\w\\.]+[^\\n]*$`, 'm');
        const m = anchor.exec(text);
        if (!m) { return text; }
        const end = m.index + m[0].length;
        return `${text.slice(0, end)}${wfEol()}${m[1]}${line}${text.slice(end)}`;
    }

    /** Same as wfSetLine but for the form's own "[this.]<prop> = ...;" lines. */
    function wfSetFormLine(prop, code, text = xamlText) {
        const line = `${wfRef(prop)} = ${wfCode(code)};`;
        const re = new RegExp(`^([ \\t]*)(?:this\\.)?${prop}\\s*=[^\\n]*;[ \\t]*$`, 'm');
        if (re.test(text)) {
            return text.replace(re, `$1${line}`);
        }
        const m = /^([ \t]*)(?:this\.)?ClientSize\s*=/m.exec(text);
        if (!m) { return text; }
        const end = text.indexOf('\n', m.index);
        return `${text.slice(0, end)}${wfEol()}${m[1]}${line}${text.slice(end)}`;
    }

    /** Remove the "[this.]<name>.<prop> = ...;" line entirely (if present). */
    function wfRemoveLine(name, prop, text = xamlText) {
        const re = new RegExp(`^[ \\t]*(?:this\\.)?${name}\\.${prop}\\s*=[^\\n]*;[ \\t]*\\r?\\n`, 'm');
        return text.replace(re, '');
    }

    /** Remove a form-level "[this.]<prop> = ...;" line (if present). */
    function wfRemoveFormLine(prop, text = xamlText) {
        const re = new RegExp(`^[ \\t]*(?:this\\.)?${prop}\\s*=[^\\n]*;[ \\t]*\\r?\\n`, 'm');
        return text.replace(re, '');
    }

    /** Wire (or rewire) an event line and ask the host for the C# stub. */
    function wfWireEvent(el, eventName, handler, openStub = true) {
        const isForm = el === wfForm;
        const finalName = handler || `${isForm ? wfForm.name : el.name}_${eventName}`;
        const et = WF_EVENT_TYPES[eventName] ?? WF_DEFAULT_EVENT_TYPE;
        const lhs = isForm ? wfRef(eventName) : `${wfRef(el.name)}.${eventName}`;
        // Classic files wrap the handler in a delegate; modern ones don't.
        const line = wfStyle.thisPrefix
            ? `${lhs} += new ${et.handler}(this.${finalName});`
            : `${lhs} += ${finalName};`;
        const lhsPattern = isForm
            ? `(?:this\\.)?${eventName}`
            : `(?:this\\.)?${el.name}\\.${eventName}`;

        let text = xamlText;
        const re = new RegExp(`^([ \\t]*)${lhsPattern}\\s*\\+=[^\\n]*$`, 'm');
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
            const blockRe = new RegExp(`^([ \\t]*)(?:this\\.)?${el.name}\\.[\\w\\.]+[^\\n]*$`, 'gm');
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

    /** Remove an event wiring line ("[this.]x.Click += ...."). */
    function wfUnwireEvent(el, eventName) {
        const lhs = el === wfForm
            ? `(?:this\\.)?${eventName}`
            : `(?:this\\.)?${el.name}\\.${eventName}`;
        const re = new RegExp(`^[ \\t]*${lhs}\\s*\\+=[^\\n]*\\r?\\n`, 'm');
        wfApply(xamlText.replace(re, ''));
    }

    // -------------------------------------------------------- wf add / delete

    function wfUniqueName(type) {
        const base = type.charAt(0).toLowerCase() + type.slice(1);
        for (let i = 1; ; i++) {
            if (!wfControls.has(`${base}${i}`) && !new RegExp(`\\b${base}${i}\\b`).test(xamlText)) {
                return `${base}${i}`;
            }
        }
    }

    function wfDrop(e, type) {
        const def = WF_CONTROLS[type];
        if (!def || !wfForm) { return; }

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
        const x = snap(Math.max(0, (e.clientX - r.left) / zoom - def.w / 2));
        const y = snap(Math.max(0, (e.clientY - r.top) / zoom - def.h / 2));
        wfAddControl(type, x, y, parent ? parent.name : null);
    }

    /** Insert a brand-new control: field, instantiation, block, Controls.Add. */
    function wfAddControl(type, x, y, parentName) {
        const def = WF_CONTROLS[type];
        const name = wfUniqueName(type);
        const props = [
            ['Location', `new System.Drawing.Point(${x}, ${y})`],
            ['Name', `"${name}"`],
            ['Size', `new System.Drawing.Size(${def.w}, ${def.h})`],
            ['TabIndex', String(wfControls.size)]
        ];
        if (def.text) { props.push(['Text', `"${name}"`]); }
        wfInsertControl(type, name, props, parentName);
    }

    /** Copy of an existing control, offset one grid step, in the same parent. */
    function wfDuplicateControl(src) {
        if (!WF_CONTROLS[src.type]) {
            setStatus(`UI Maker: duplicate is not supported for ${src.type} controls.`);
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
        const parentName = src.parent && src.parent !== wfForm ? src.parent.name : null;
        wfInsertControl(src.type, name, props, parentName);
        setStatus(`UI Maker: duplicated ${src.name} as ${name}.`);
    }

    /**
     * Shared insertion plumbing: instantiation before SuspendLayout, property
     * block before the form's own section, Controls.Add, field declaration.
     * `props` is an ordered [prop, code] list; code uses qualified names and
     * is rewritten to match the file's dialect.
     */
    function wfInsertControl(type, name, props, parentName) {
        const eol = wfEol();
        let text = xamlText;

        // Indentation of generated statements, taken from an existing line.
        const indentMatch = /^([ \t]*)(?:this\.)?SuspendLayout\(\);/m.exec(text);
        const ind = indentMatch ? indentMatch[1] : '            ';

        // 1) Instantiation — before the first Suspend/BeginInit line.
        const suspend = /^[ \t]*(?:(?:[\w\.]+\.)?SuspendLayout\(\);|\(\((?:System\.ComponentModel\.)?ISupportInitialize\))/m.exec(text);
        if (!suspend) {
            setStatus('UI Maker: could not find a place to insert the control.');
            return;
        }
        text = `${text.slice(0, suspend.index)}${ind}${wfRef(name)} = new ${wfCode(`System.Windows.Forms.${type}`)}();${eol}${text.slice(suspend.index)}`;

        // 2) Property block — before the form's own section (AutoScaleDimensions).
        const formAnchor = /^[ \t]*(?:this\.)?AutoScaleDimensions\s*=/m.exec(text);
        if (!formAnchor) {
            setStatus('UI Maker: could not find the form section in InitializeComponent.');
            return;
        }
        // Back up over the "// <formname> //" comment trio if it sits right above.
        let insertAt = formAnchor.index;
        const before = text.slice(0, insertAt);
        const trio = /(^[ \t]*\/\/[ \t]*\r?\n[ \t]*\/\/[^\r\n]*\r?\n[ \t]*\/\/[ \t]*\r?\n)$/m.exec(before);
        if (trio) { insertAt -= trio[1].length; }

        const blockLines = [
            `${ind}// `,
            `${ind}// ${name}`,
            `${ind}// `,
            ...props.map(([prop, code]) => `${ind}${wfRef(name)}.${prop} = ${wfCode(code)};`)
        ];
        text = `${text.slice(0, insertAt)}${blockLines.join(eol)}${eol}${text.slice(insertAt)}`;

        // 3) Controls.Add — into the parent container or the form.
        const addLine = parentName
            ? `${ind}${wfRef(parentName)}.Controls.Add(${wfRef(name)});`
            : `${ind}${wfStyle.thisPrefix ? 'this.' : ''}Controls.Add(${wfRef(name)});`;
        const firstAdd = parentName
            ? new RegExp(`^[ \\t]*(?:this\\.)?${parentName}\\.Controls\\.Add\\(`, 'm').exec(text)
            : /^[ \t]*(?:this\.)?Controls\.Add\(/m.exec(text);
        if (firstAdd) {
            text = `${text.slice(0, firstAdd.index)}${addLine}${eol}${text.slice(firstAdd.index)}`;
        } else if (parentName) {
            // Parent has no Controls.Add lines yet — append after its first statement.
            const anchor = new RegExp(`^([ \\t]*)(?:this\\.)?${parentName}\\.[\\w\\.]+[^\\n]*$`, 'm').exec(text);
            if (anchor) {
                const end = anchor.index + anchor[0].length;
                text = `${text.slice(0, end)}${eol}${addLine}${text.slice(end)}`;
            }
        } else {
            const cs = /^([ \t]*)(?:this\.)?ClientSize\s*=[^\n]*$/m.exec(text);
            if (cs) {
                const end = cs.index + cs[0].length;
                text = `${text.slice(0, end)}${eol}${addLine}${text.slice(end)}`;
            }
        }

        // 4) Field declaration — after the last existing designer field.
        const fieldLine = `        private ${wfCode(`System.Windows.Forms.${type}`)} ${name};`;
        let lastField = null;
        for (const m of text.matchAll(/^[ \t]*private\s+[\w\.<>]+\s+\w+;\s*$/gm)) { lastField = m; }
        if (lastField) {
            const end = lastField.index + lastField[0].length;
            text = `${text.slice(0, end)}${eol}${fieldLine}${text.slice(end)}`;
        } else {
            const endRegion = /^[ \t]*#endregion[^\n]*$/m.exec(text);
            if (endRegion) {
                const end = endRegion.index + endRegion[0].length;
                text = `${text.slice(0, end)}${eol}${eol}${fieldLine}${text.slice(end)}`;
            }
        }

        selected = { __wf: true, name, type, props: {}, events: {}, children: [] };
        wfApply(text);
    }

    /** Delete a control: every statement referencing it, its comment trio, its field. */
    function wfDeleteControl(ctrl) {
        const name = ctrl.name;
        const lines = xamlText.split('\n');
        const keep = [];
        // Any statement referencing the control (with or without "this.") —
        // property assignments, event wiring, Controls.Add, SuspendLayout,
        // ISupportInitialize casts, ... Handler names like name_Click do not
        // match because "_" is a word character (no \b boundary).
        const ref = new RegExp(`\\b(?:this\\.)?${name}\\b`);
        const field = new RegExp(`^\\s*private\\s+[\\w\\.<>]+\\s+${name};\\s*$`);
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trim();
            // "// name" comment trio above the control's block.
            if (t === `// ${name}`
                && lines[i - 1]?.trim() === '//'
                && lines[i + 1]?.trim() === '//') {
                keep.pop();
                i += 1;
                continue;
            }
            if (ref.test(lines[i]) || field.test(lines[i])) { continue; }
            keep.push(lines[i]);
        }
        selected = null;
        selectedPath = '';
        wfApply(keep.join('\n'));
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
        const names = isForm
            ? ['Name', ...WF_FORM_PROPS]
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

        // (Name): read-only — a designer rename cannot update the code-behind safely.
        if (def.kind === 'name') {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = target.name;
            input.disabled = true;
            input.title = 'Rename in code (F2 in the editor) — a designer rename cannot update the code-behind safely yet.';
            row.appendChild(input);
            return { label: '(Name)', cat: def.cat, node: row };
        }

        if (def.kind === 'bool' || def.kind === 'enum' || def.kind === 'ref') {
            const values = def.kind === 'bool' ? ['True', 'False']
                : def.kind === 'ref' ? [...wfControls.values()].filter(c => c.type === 'Button').map(c => c.name)
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
        const events = isForm ? WF_FORM_EVENTS : (WF_CONTROLS[el.type]?.events ?? ['Click']);

        const hint = document.createElement('div');
        hint.className = 'ff-events-hint';
        hint.textContent = 'Type a handler name (or click ⚡ for the default) to wire the event and create the C# stub.';
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
})();
