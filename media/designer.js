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
        DatePicker:  { icon: '📅', w: 140, h: 28,  attrs: {},                      props: ['SelectedDate'], events: ['SelectedDateChanged'], defaultEvent: 'SelectedDateChanged' }
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

    // ------------------------------------------------------------------ state

    let xamlText = '';          // last text we parsed or produced
    let xamlDoc = null;         // XMLDocument of the current XAML
    let windowEl = null;        // root element (Window / UserControl / Page)
    let contentRoot = null;     // the window's single content element
    let layoutRoot = null;      // top-level panel used for fallback drops
    let selected = null;        // currently selected XML element or null
    let selectedPath = '';      // index path of the selection (survives re-parse)
    let visuals = [];           // [{ el, div }] rendered this pass
    let styles = { byKey: new Map(), byType: new Map() }; // resolved <Style> resources
    const uiTabs = new Map();   // TabControl path -> active tab index
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
        }
    });

    // ================================================================= parsing

    function parseAndRender() {
        bannerEl.hidden = true;

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
        renderPanel();
    }

    function render() {
        if (!windowEl || !xamlDoc) { renderEmpty(); return; }

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
        selectedPath = el ? pathOf(el) : '';
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
        tag.textContent = getName(selected) || selected.localName;
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
        const place = mode ? `at (${Math.round(box.x)}, ${Math.round(box.y)})`
            : `— layout managed by ${selected.parentNode?.localName ?? 'parent'}`;
        setStatus(`${getName(selected) || selected.localName} — ${Math.round(box.w)}×${Math.round(box.h)} ${place}`);
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

        const m0 = parseMargin(el.getAttribute('Margin'));
        const start = mode === 'canvas'
            ? { x: num(el.getAttribute('Canvas.Left'), 0), y: num(el.getAttribute('Canvas.Top'), 0) }
            : { x: m0.l, y: m0.t };
        const sx = e.clientX, sy = e.clientY;
        let moved = false;

        const apply = (nx, ny) => {
            if (mode === 'canvas') {
                div.style.left = `${nx}px`;
                div.style.top = `${ny}px`;
            } else {
                div.style.margin = `${ny}px ${m0.r}px ${m0.b}px ${nx}px`;
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
            setStatus(`${getName(el) || el.localName} — (${nx}, ${ny})`);
        };
        const onUp = ev => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (!moved) { return; }
            const nx = snap(Math.max(0, start.x + (ev.clientX - sx) / zoom));
            const ny = snap(Math.max(0, start.y + (ev.clientY - sy) / zoom));
            if (mode === 'canvas') {
                el.setAttribute('Canvas.Left', String(nx));
                el.setAttribute('Canvas.Top', String(ny));
            } else {
                el.setAttribute('Margin', `${nx},${ny},${m0.r},${m0.b}`);
            }
            commit();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    function startResize(e, el, dir) {
        const hit = visuals.find(v => v.el === el);
        if (!hit) { return; }
        const start = rectOf(hit.div);
        const mode = movability(el);
        const m0 = parseMargin(el.getAttribute('Margin'));
        const pos0 = mode === 'canvas'
            ? { x: num(el.getAttribute('Canvas.Left'), 0), y: num(el.getAttribute('Canvas.Top'), 0) }
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
            if (mode === 'canvas') {
                hit.div.style.left = `${b.px}px`;
                hit.div.style.top = `${b.py}px`;
            } else if (mode === 'margin') {
                hit.div.style.margin = `${b.py}px ${m0.r}px ${m0.b}px ${b.px}px`;
            }
            drawSelectionAround(hit.div);
            setStatus(`${getName(el) || el.localName} — ${b.w}×${b.h}`);
        };
        const onUp = ev => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const b = compute(ev);
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
        for (const [type, def] of Object.entries(CONTROLS)) {
            const item = document.createElement('div');
            item.className = 'ff-tool';
            item.draggable = true;
            item.innerHTML = `<span class="ff-tool-icon">${def.icon}</span>${type}`;
            item.addEventListener('dragstart', e => {
                e.dataTransfer.setData('text/formforge-control', type);
                e.dataTransfer.effectAllowed = 'copy';
            });
            host.appendChild(item);
        }
    }

    surfaceEl.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('text/formforge-control')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });

    surfaceEl.addEventListener('drop', e => {
        const type = e.dataTransfer.getData('text/formforge-control');
        if (!type || !xamlDoc || !windowEl) { return; }
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
        return el.getAttributeNS(X_NS, 'Name') || el.getAttribute('Name') || '';
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

    function renderPanel() {
        propsBody.innerHTML = '';

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
        if (!isWindow) {
            // Name is special: stored as x:Name.
            propsBody.appendChild(propRow('Name', getName(el), v => {
                setName(el, v.trim());
                commit();
            }));
        }
        const names = isWindow
            ? WINDOW_PROPS
            : [...(CONTROLS[el.localName]?.props ?? PANEL_PROPS[el.localName] ?? []), ...COMMON_PROPS];

        for (const prop of names) {
            propsBody.appendChild(propRow(prop, el.getAttribute(prop) ?? '', v => {
                if (v === '') { el.removeAttribute(prop); } else { el.setAttribute(prop, v); }
                commit();
            }, ENUM_VALUES[prop]));
        }
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
        // Ignore shortcuts while typing in a panel input.
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) { return; }
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
    vscode.postMessage({ type: 'ready' });
})();
