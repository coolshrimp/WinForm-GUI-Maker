// FormForge designer webview.
//
// Renders a XAML Window as an interactive canvas. The XAML text document is
// the single source of truth: this script parses it into an XML DOM, renders
// HTML approximations of each control, and serializes the DOM back to text
// whenever the user changes something on the canvas.
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
        Border:      { icon: '▢', w: 200, h: 120, attrs: { BorderBrush: '#FF808080', BorderThickness: '1' }, props: ['BorderBrush', 'BorderThickness', 'CornerRadius'], events: ['MouseDown'], defaultEvent: 'MouseDown' },
        GroupBox:    { icon: '⬒', w: 220, h: 140, attrs: { Header: 'GroupBox' },  props: ['Header'], events: ['MouseDown'], defaultEvent: 'MouseDown' },
        DatePicker:  { icon: '📅', w: 140, h: 28,  attrs: {},                      props: ['SelectedDate'], events: ['SelectedDateChanged'], defaultEvent: 'SelectedDateChanged' }
    };

    /** Properties shown for every control, in panel order. */
    const COMMON_PROPS = ['Width', 'Height', 'Margin', 'Background', 'Foreground',
        'FontSize', 'FontWeight', 'IsEnabled', 'Visibility', 'ToolTip'];

    /** Window-level properties/events shown when nothing is selected. */
    const WINDOW_PROPS = ['Title', 'Width', 'Height', 'Background', 'ResizeMode', 'WindowStartupLocation'];
    const WINDOW_EVENTS = ['Loaded', 'Closing', 'KeyDown', 'KeyUp'];

    /** Suggested values for enum-like attributes (rendered as datalists). */
    const ENUM_VALUES = {
        Visibility: ['Visible', 'Hidden', 'Collapsed'],
        FontWeight: ['Thin', 'Light', 'Normal', 'Medium', 'SemiBold', 'Bold', 'Black'],
        IsEnabled: ['True', 'False'],
        IsChecked: ['True', 'False'],
        IsReadOnly: ['True', 'False'],
        IsEditable: ['True', 'False'],
        IsIndeterminate: ['True', 'False'],
        AcceptsReturn: ['True', 'False'],
        AutoGenerateColumns: ['True', 'False'],
        TextWrapping: ['NoWrap', 'Wrap', 'WrapWithOverflow'],
        Stretch: ['None', 'Fill', 'Uniform', 'UniformToFill'],
        ResizeMode: ['NoResize', 'CanMinimize', 'CanResize', 'CanResizeWithGrip'],
        WindowStartupLocation: ['Manual', 'CenterScreen', 'CenterOwner']
    };

    // ------------------------------------------------------------------ state

    let xamlText = '';          // last text we parsed or produced
    let xamlDoc = null;         // XMLDocument of the current XAML
    let windowEl = null;        // root element (Window / UserControl / Page)
    let layoutRoot = null;      // panel whose children we design (Grid/Canvas)
    let layoutMode = 'Grid';    // 'Grid' (margins) or 'Canvas' (attached props)
    let selected = null;        // currently selected XML element or null
    let visuals = [];           // [{ el, div }] rendered this pass
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
            xamlDoc = windowEl = layoutRoot = selected = null;
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
        selected = restoreSelection();

        if (windowEl.localName === 'Application') {
            layoutRoot = null;
            showBanner('App.xaml holds application resources, not a visual layout. Open a Window instead.',
                '</> View Code', () => vscode.postMessage({ type: 'openCode' }));
            renderEmpty();
            return;
        }

        // The design surface is the first panel child of the root element.
        layoutRoot = firstElementChild(windowEl, ['Grid', 'Canvas', 'StackPanel', 'DockPanel', 'WrapPanel']);
        layoutMode = layoutRoot && layoutRoot.localName === 'Canvas' ? 'Canvas' : 'Grid';

        if (layoutRoot && !['Grid', 'Canvas'].includes(layoutRoot.localName)) {
            showBanner(`Root panel is a ${layoutRoot.localName} — drag positioning writes margins, which ` +
                'that panel may ignore. A Grid or Canvas root gives full designer support.');
        }

        render();
    }

    /** First direct child element whose local name is in `names` (or any panel). */
    function firstElementChild(parent, names) {
        for (const child of parent.children) {
            if (names.includes(child.localName)) { return child; }
        }
        // Fall back to the first element child at all (e.g. a Border wrapper).
        return parent.firstElementChild ?? null;
    }

    /** After a re-parse, re-select the element with the previous x:Name. */
    function restoreSelection() {
        if (!selected || !xamlDoc) { return null; }
        const name = getName(selected);
        if (!name) { return null; }
        for (const el of xamlDoc.getElementsByTagName('*')) {
            if (getName(el) === name) { return el; }
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

        const bg = windowEl.getAttribute('Background') || layoutRoot?.getAttribute('Background');
        surfaceEl.style.background = toCssColor(bg) || '#ffffff';

        // Grid dots follow the snap size.
        surfaceEl.style.backgroundImage = config.snap
            ? 'radial-gradient(circle, rgba(0,0,0,0.18) 1px, transparent 1px)' : 'none';
        surfaceEl.style.backgroundSize = `${config.gridSize}px ${config.gridSize}px`;

        // Controls.
        surfaceEl.innerHTML = '';
        visuals = [];
        if (layoutRoot) {
            for (const el of layoutRoot.children) {
                // Property elements like <Grid.RowDefinitions> are not controls.
                if (el.localName.includes('.')) { continue; }
                const div = buildControlVisual(el);
                surfaceEl.appendChild(div);
                visuals.push({ el, div });
            }
        }

        drawSelection();
        renderPanel();
    }

    /** Create the HTML approximation of one control. */
    function buildControlVisual(el) {
        const type = el.localName;
        const box = getLayout(el);

        const div = document.createElement('div');
        div.className = `ff-control ff-c-${type.toLowerCase()}`;
        div.style.left = `${box.x}px`;
        div.style.top = `${box.y}px`;
        div.style.width = `${box.w}px`;
        div.style.height = `${box.h}px`;

        // Shared visual attributes.
        const bg = toCssColor(el.getAttribute('Background'));
        const fg = toCssColor(el.getAttribute('Foreground'));
        if (bg) { div.style.background = bg; }
        if (fg) { div.style.color = fg; }
        const fs = el.getAttribute('FontSize');
        if (fs) { div.style.fontSize = `${fs}px`; }
        const fw = el.getAttribute('FontWeight');
        if (fw) { div.style.fontWeight = fw.toLowerCase() === 'bold' ? 'bold' : fw; }
        const vis = el.getAttribute('Visibility');
        if (vis && vis !== 'Visible') { div.classList.add('ff-hidden-control'); }
        if (el.getAttribute('IsEnabled') === 'False') { div.classList.add('ff-disabled-control'); }

        div.appendChild(buildInner(type, el));

        // Selection + drag behaviour.
        div.addEventListener('mousedown', e => {
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

        return div;
    }

    /** Inner markup that mimics the WPF control's default look. */
    function buildInner(type, el) {
        const inner = document.createElement('div');
        inner.className = 'ff-inner';
        const content = el.getAttribute('Content') ?? '';
        const text = el.getAttribute('Text') ?? '';

        switch (type) {
            case 'Button':
                inner.classList.add('ff-look-button');
                inner.textContent = content || 'Button';
                break;
            case 'Label':
                inner.classList.add('ff-look-label');
                inner.textContent = content || '';
                break;
            case 'TextBlock':
                inner.classList.add('ff-look-label');
                inner.textContent = text || '';
                break;
            case 'TextBox':
                inner.classList.add('ff-look-input');
                inner.textContent = text;
                break;
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
            case 'Border':
                inner.classList.add('ff-look-border');
                applyBorder(inner, el);
                break;
            case 'GroupBox':
                inner.classList.add('ff-look-groupbox');
                inner.innerHTML = `<span class="ff-group-header">${escapeHtml(el.getAttribute('Header') || 'GroupBox')}</span>`;
                break;
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

    function applyBorder(inner, el) {
        const brush = toCssColor(el.getAttribute('BorderBrush')) || '#808080';
        const thick = (el.getAttribute('BorderThickness') || '1').split(',')[0];
        const radius = (el.getAttribute('CornerRadius') || '0').split(',')[0];
        inner.style.border = `${thick}px solid ${brush}`;
        inner.style.borderRadius = `${radius}px`;
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
        drawSelection();
        renderPanel();
    }

    function drawSelection() {
        // Remove previous overlay.
        surfaceEl.querySelectorAll('.ff-selection').forEach(n => n.remove());
        const hit = visuals.find(v => v.el === selected);
        if (!hit) {
            setStatus(windowEl ? `${windowEl.localName} — click a control to select it` : 'Ready');
            return;
        }

        const box = getLayout(selected);
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

        setStatus(`${getName(selected) || selected.localName} — ${Math.round(box.w)}×${Math.round(box.h)} at (${Math.round(box.x)}, ${Math.round(box.y)})`);
    }

    // Clicking empty canvas selects the window itself.
    surfaceEl.addEventListener('mousedown', () => {
        selected = null;
        drawSelection();
        renderPanel();
    });

    // ------------------------------------------------------------ move/resize

    function startMove(e, el, div) {
        const start = getLayout(el);
        const sx = e.clientX, sy = e.clientY;
        let moved = false;

        const onMove = ev => {
            const dx = (ev.clientX - sx) / zoom;
            const dy = (ev.clientY - sy) / zoom;
            if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) { return; }
            moved = true;
            const nx = snap(Math.max(0, start.x + dx));
            const ny = snap(Math.max(0, start.y + dy));
            div.style.left = `${nx}px`;
            div.style.top = `${ny}px`;
            positionSelectionOverlay(nx, ny, start.w, start.h);
            setStatus(`${getName(el) || el.localName} — (${nx}, ${ny})`);
        };
        const onUp = ev => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            if (!moved) { return; }
            const dx = (ev.clientX - sx) / zoom;
            const dy = (ev.clientY - sy) / zoom;
            setLayout(el, snap(Math.max(0, start.x + dx)), snap(Math.max(0, start.y + dy)), start.w, start.h);
            commit();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    function startResize(e, el, dir) {
        const start = getLayout(el);
        const sx = e.clientX, sy = e.clientY;

        const compute = ev => {
            const dx = (ev.clientX - sx) / zoom;
            const dy = (ev.clientY - sy) / zoom;
            let { x, y, w, h } = start;
            if (dir.includes('e')) { w = Math.max(10, start.w + dx); }
            if (dir.includes('s')) { h = Math.max(10, start.h + dy); }
            if (dir.includes('w')) { w = Math.max(10, start.w - dx); x = start.x + start.w - w; }
            if (dir.includes('n')) { h = Math.max(10, start.h - dy); y = start.y + start.h - h; }
            return { x: snap(Math.max(0, x)), y: snap(Math.max(0, y)), w: snap(w), h: snap(h) };
        };

        const onMove = ev => {
            const b = compute(ev);
            const hit = visuals.find(v => v.el === el);
            if (hit) {
                hit.div.style.left = `${b.x}px`;
                hit.div.style.top = `${b.y}px`;
                hit.div.style.width = `${b.w}px`;
                hit.div.style.height = `${b.h}px`;
            }
            positionSelectionOverlay(b.x, b.y, b.w, b.h);
            setStatus(`${getName(el) || el.localName} — ${b.w}×${b.h}`);
        };
        const onUp = ev => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const b = compute(ev);
            setLayout(el, b.x, b.y, b.w, b.h);
            commit();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    /** Live-update the overlay during a drag without a full re-render. */
    function positionSelectionOverlay(x, y, w, h) {
        const sel = surfaceEl.querySelector('.ff-selection');
        if (sel) {
            sel.style.left = `${x - 1}px`;
            sel.style.top = `${y - 1}px`;
            sel.style.width = `${w}px`;
            sel.style.height = `${h}px`;
        }
    }

    // ----------------------------------------------------------------- layout

    /** Effective x/y/w/h of a control on the design surface. */
    function getLayout(el) {
        const def = CONTROLS[el.localName] ?? { w: 100, h: 30 };
        let x, y;
        if (layoutMode === 'Canvas') {
            x = num(el.getAttribute('Canvas.Left'), 0);
            y = num(el.getAttribute('Canvas.Top'), 0);
        } else {
            const m = parseMargin(el.getAttribute('Margin'));
            x = m.l;
            y = m.t;
        }
        return {
            x, y,
            w: num(el.getAttribute('Width'), def.w),
            h: num(el.getAttribute('Height'), def.h)
        };
    }

    /**
     * Write position/size back to the element, using the same convention the
     * Visual Studio designer uses for a Grid root (top-left alignment plus
     * margin), or Canvas attached properties for a Canvas root.
     */
    function setLayout(el, x, y, w, h) {
        if (layoutMode === 'Canvas') {
            el.setAttribute('Canvas.Left', String(x));
            el.setAttribute('Canvas.Top', String(y));
        } else {
            el.setAttribute('HorizontalAlignment', 'Left');
            el.setAttribute('VerticalAlignment', 'Top');
            el.setAttribute('Margin', `${x},${y},0,0`);
        }
        el.setAttribute('Width', String(w));
        el.setAttribute('Height', String(h));
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

        if (!ensureLayoutRoot()) { return; }

        const rect = surfaceEl.getBoundingClientRect();
        const def = CONTROLS[type];
        const x = snap(Math.max(0, (e.clientX - rect.left) / zoom - def.w / 2));
        const y = snap(Math.max(0, (e.clientY - rect.top) / zoom - def.h / 2));

        // Build the new control element with defaults + a fresh unique name.
        const el = xamlDoc.createElementNS(PRES_NS, type);
        setName(el, uniqueName(type));
        for (const [k, v] of Object.entries(def.attrs)) {
            el.setAttribute(k, v);
        }
        setLayout(el, x, y, def.w, def.h);
        layoutRoot.appendChild(el);

        selected = el;
        commit();
    });

    /** Create a root Grid on demand so dropping onto an empty Window works. */
    function ensureLayoutRoot() {
        if (layoutRoot) { return true; }
        if (!windowEl || windowEl.localName === 'Application') { return false; }
        layoutRoot = xamlDoc.createElementNS(PRES_NS, 'Grid');
        windowEl.appendChild(layoutRoot);
        layoutMode = 'Grid';
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
            : [...(CONTROLS[el.localName]?.props ?? []), ...COMMON_PROPS];

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
            selected = null;
            drawSelection();
            renderPanel();
        } else if (e.key.startsWith('Arrow')) {
            const step = e.shiftKey ? config.gridSize : 1;
            const b = getLayout(selected);
            const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
            const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
            setLayout(selected, Math.max(0, b.x + dx), Math.max(0, b.y + dy), b.w, b.h);
            commit();
            e.preventDefault();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
            // Duplicate: clone, offset, rename.
            const clone = selected.cloneNode(true);
            setName(clone, uniqueName(selected.localName));
            const b = getLayout(selected);
            layoutRoot.appendChild(clone);
            selected = clone;
            setLayout(clone, b.x + config.gridSize, b.y + config.gridSize, b.w, b.h);
            commit();
            e.preventDefault();
        }
    });

    function deleteSelected() {
        if (!selected) { return; }
        selected.remove();
        selected = null;
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
