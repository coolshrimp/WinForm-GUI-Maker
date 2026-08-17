// UI Maker — XAML language intelligence (pure data + logic, no vscode imports).
//
// Everything the XAML IntelliSense providers need to think with lives here so
// it can be unit-tested with plain Node:
//   * WPF element catalog (controls, panels, shapes) with per-type properties.
//   * Property metadata: type (enum/bool/color/…), allowed values, docs.
//   * Named XAML colors (the System.Windows.Media.Colors table).
//   * Ready-made snippet blocks (Grid with rows, Button with Click, …).
//   * A cursor-context analyzer: given the text before the caret, decide
//     whether the user is typing an element name, an attribute name, an
//     attribute value, or a closing tag.
//
// The vscode-facing wiring (completion/hover/color providers) is in
// xamlIntellisense.ts.

/** What the caret position in a .xaml document means for completion. */
export interface XamlContext {
    kind: 'element' | 'attribute' | 'attributeValue' | 'closingTag' | 'text';
    /** Element whose tag the caret is inside (for attribute/value contexts). */
    elementName?: string;
    /** Attribute being assigned (for attributeValue contexts). */
    attributeName?: string;
    /** The partial word already typed (element/attribute/value prefix). */
    prefix: string;
}

export interface XamlPropertyInfo {
    /** Drives value completion + the color provider. */
    type: 'enum' | 'bool' | 'color' | 'brush' | 'string' | 'number' | 'thickness' | 'event' | 'resource';
    values?: string[];
    doc?: string;
}

export interface XamlElementInfo {
    doc: string;
    /** Properties specific to this element (merged with COMMON_PROPERTIES). */
    properties?: Record<string, XamlPropertyInfo>;
    /** Events specific to this element (merged with COMMON_EVENTS). */
    events?: Record<string, string>;
    /** True for panels/containers that usually hold children (affects insert text). */
    container?: boolean;
}

export interface XamlSnippet {
    prefix: string;
    label: string;
    doc: string;
    /** VS Code snippet syntax ($1, ${2:default}, $0). */
    body: string;
}

// ---------------------------------------------------------------------------
// Enum values (mirror the WPF enums the designer already understands)
// ---------------------------------------------------------------------------

export const ENUMS: Record<string, string[]> = {
    HorizontalAlignment: ['Left', 'Center', 'Right', 'Stretch'],
    VerticalAlignment: ['Top', 'Center', 'Bottom', 'Stretch'],
    Visibility: ['Visible', 'Hidden', 'Collapsed'],
    Orientation: ['Horizontal', 'Vertical'],
    Stretch: ['None', 'Fill', 'Uniform', 'UniformToFill'],
    Dock: ['Left', 'Top', 'Right', 'Bottom'],
    TextWrapping: ['NoWrap', 'Wrap', 'WrapWithOverflow'],
    TextAlignment: ['Left', 'Right', 'Center', 'Justify'],
    TextTrimming: ['None', 'CharacterEllipsis', 'WordEllipsis'],
    FontWeight: ['Thin', 'ExtraLight', 'Light', 'Normal', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'],
    FontStyle: ['Normal', 'Italic', 'Oblique'],
    ScrollBarVisibility: ['Disabled', 'Auto', 'Hidden', 'Visible'],
    WindowStartupLocation: ['Manual', 'CenterScreen', 'CenterOwner'],
    WindowStyle: ['None', 'SingleBorderWindow', 'ThreeDBorderWindow', 'ToolWindow'],
    ResizeMode: ['NoResize', 'CanMinimize', 'CanResize', 'CanResizeWithGrip'],
    SizeToContent: ['Manual', 'Width', 'Height', 'WidthAndHeight'],
    WindowState: ['Normal', 'Minimized', 'Maximized'],
    FlowDirection: ['LeftToRight', 'RightToLeft'],
    SelectionMode: ['Single', 'Multiple', 'Extended'],
    ClickMode: ['Release', 'Press', 'Hover'],
    CharacterCasing: ['Normal', 'Upper', 'Lower'],
    StretchDirection: ['UpOnly', 'DownOnly', 'Both'],
    TickPlacement: ['None', 'TopLeft', 'BottomRight', 'Both'],
    GridResizeDirection: ['Auto', 'Columns', 'Rows'],
    ExpandDirection: ['Down', 'Up', 'Left', 'Right'],
    DataGridHeadersVisibility: ['All', 'Column', 'Row', 'None'],
    DataGridGridLinesVisibility: ['All', 'Horizontal', 'None', 'Vertical'],
    Cursor: ['Arrow', 'Hand', 'Wait', 'Cross', 'IBeam', 'No', 'SizeAll', 'SizeNS', 'SizeWE', 'Help', 'AppStarting']
};

// ---------------------------------------------------------------------------
// Named colors — the full System.Windows.Media.Colors table (X11/W3C names).
// Values are #RRGGBB (Transparent carries alpha).
// ---------------------------------------------------------------------------

export const NAMED_COLORS: Record<string, string> = {
    AliceBlue: '#F0F8FF', AntiqueWhite: '#FAEBD7', Aqua: '#00FFFF', Aquamarine: '#7FFFD4',
    Azure: '#F0FFFF', Beige: '#F5F5DC', Bisque: '#FFE4C4', Black: '#000000',
    BlanchedAlmond: '#FFEBCD', Blue: '#0000FF', BlueViolet: '#8A2BE2', Brown: '#A52A2A',
    BurlyWood: '#DEB887', CadetBlue: '#5F9EA0', Chartreuse: '#7FFF00', Chocolate: '#D2691E',
    Coral: '#FF7F50', CornflowerBlue: '#6495ED', Cornsilk: '#FFF8DC', Crimson: '#DC143C',
    Cyan: '#00FFFF', DarkBlue: '#00008B', DarkCyan: '#008B8B', DarkGoldenrod: '#B8860B',
    DarkGray: '#A9A9A9', DarkGreen: '#006400', DarkKhaki: '#BDB76B', DarkMagenta: '#8B008B',
    DarkOliveGreen: '#556B2F', DarkOrange: '#FF8C00', DarkOrchid: '#9932CC', DarkRed: '#8B0000',
    DarkSalmon: '#E9967A', DarkSeaGreen: '#8FBC8F', DarkSlateBlue: '#483D8B', DarkSlateGray: '#2F4F4F',
    DarkTurquoise: '#00CED1', DarkViolet: '#9400D3', DeepPink: '#FF1493', DeepSkyBlue: '#00BFFF',
    DimGray: '#696969', DodgerBlue: '#1E90FF', Firebrick: '#B22222', FloralWhite: '#FFFAF0',
    ForestGreen: '#228B22', Fuchsia: '#FF00FF', Gainsboro: '#DCDCDC', GhostWhite: '#F8F8FF',
    Gold: '#FFD700', Goldenrod: '#DAA520', Gray: '#808080', Green: '#008000',
    GreenYellow: '#ADFF2F', Honeydew: '#F0FFF0', HotPink: '#FF69B4', IndianRed: '#CD5C5C',
    Indigo: '#4B0082', Ivory: '#FFFFF0', Khaki: '#F0E68C', Lavender: '#E6E6FA',
    LavenderBlush: '#FFF0F5', LawnGreen: '#7CFC00', LemonChiffon: '#FFFACD', LightBlue: '#ADD8E6',
    LightCoral: '#F08080', LightCyan: '#E0FFFF', LightGoldenrodYellow: '#FAFAD2', LightGray: '#D3D3D3',
    LightGreen: '#90EE90', LightPink: '#FFB6C1', LightSalmon: '#FFA07A', LightSeaGreen: '#20B2AA',
    LightSkyBlue: '#87CEFA', LightSlateGray: '#778899', LightSteelBlue: '#B0C4DE', LightYellow: '#FFFFE0',
    Lime: '#00FF00', LimeGreen: '#32CD32', Linen: '#FAF0E6', Magenta: '#FF00FF',
    Maroon: '#800000', MediumAquamarine: '#66CDAA', MediumBlue: '#0000CD', MediumOrchid: '#BA55D3',
    MediumPurple: '#9370DB', MediumSeaGreen: '#3CB371', MediumSlateBlue: '#7B68EE', MediumSpringGreen: '#00FA9A',
    MediumTurquoise: '#48D1CC', MediumVioletRed: '#C71585', MidnightBlue: '#191970', MintCream: '#F5FFFA',
    MistyRose: '#FFE4E1', Moccasin: '#FFE4B5', NavajoWhite: '#FFDEAD', Navy: '#000080',
    OldLace: '#FDF5E6', Olive: '#808000', OliveDrab: '#6B8E23', Orange: '#FFA500',
    OrangeRed: '#FF4500', Orchid: '#DA70D6', PaleGoldenrod: '#EEE8AA', PaleGreen: '#98FB98',
    PaleTurquoise: '#AFEEEE', PaleVioletRed: '#DB7093', PapayaWhip: '#FFEFD5', PeachPuff: '#FFDAB9',
    Peru: '#CD853F', Pink: '#FFC0CB', Plum: '#DDA0DD', PowderBlue: '#B0E0E6',
    Purple: '#800080', Red: '#FF0000', RosyBrown: '#BC8F8F', RoyalBlue: '#4169E1',
    SaddleBrown: '#8B4513', Salmon: '#FA8072', SandyBrown: '#F4A460', SeaGreen: '#2E8B57',
    SeaShell: '#FFF5EE', Sienna: '#A0522D', Silver: '#C0C0C0', SkyBlue: '#87CEEB',
    SlateBlue: '#6A5ACD', SlateGray: '#708090', Snow: '#FFFAFA', SpringGreen: '#00FF7F',
    SteelBlue: '#4682B4', Tan: '#D2B48C', Teal: '#008080', Thistle: '#D8BFD8',
    Tomato: '#FF6347', Transparent: '#00FFFFFF', Turquoise: '#40E0D0', Violet: '#EE82EE',
    Wheat: '#F5DEB3', White: '#FFFFFF', WhiteSmoke: '#F5F5F5', Yellow: '#FFFF00',
    YellowGreen: '#9ACD32'
};

/**
 * Parse a XAML color string into RGBA components (0–1 range, for
 * vscode.Color). Accepts #RGB, #ARGB, #RRGGBB, #AARRGGBB and named colors.
 * Returns undefined for anything else (bindings, resources, gradients).
 */
export function parseXamlColor(raw: string): { r: number; g: number; b: number; a: number } | undefined {
    let value = raw.trim();
    if (!value) { return undefined; }
    if (!value.startsWith('#')) {
        const named = NAMED_COLORS[
            Object.keys(NAMED_COLORS).find(k => k.toLowerCase() === value.toLowerCase()) ?? ''
        ];
        if (!named) { return undefined; }
        value = named;
    }
    const hex = value.slice(1);
    if (!/^[0-9a-f]+$/i.test(hex)) { return undefined; }
    let a = 255, r = 0, g = 0, b = 0;
    if (hex.length === 3 || hex.length === 4) {
        const digits = hex.length === 4 ? hex : 'f' + hex;
        a = parseInt(digits[0] + digits[0], 16);
        r = parseInt(digits[1] + digits[1], 16);
        g = parseInt(digits[2] + digits[2], 16);
        b = parseInt(digits[3] + digits[3], 16);
    } else if (hex.length === 6 || hex.length === 8) {
        const digits = hex.length === 8 ? hex : 'ff' + hex;
        a = parseInt(digits.slice(0, 2), 16);
        r = parseInt(digits.slice(2, 4), 16);
        g = parseInt(digits.slice(4, 6), 16);
        b = parseInt(digits.slice(6, 8), 16);
    } else {
        return undefined;
    }
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
}

/** Format RGBA (0–1) back to a XAML hex string; alpha only when not opaque. */
export function formatXamlColor(r: number, g: number, b: number, a: number): string {
    const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0').toUpperCase();
    return a >= 1 ? `#${h(r)}${h(g)}${h(b)}` : `#${h(a)}${h(r)}${h(g)}${h(b)}`;
}

// ---------------------------------------------------------------------------
// Property metadata
// ---------------------------------------------------------------------------

const en = (name: string, doc?: string): XamlPropertyInfo => ({ type: 'enum', values: ENUMS[name], doc });
const bool = (doc?: string): XamlPropertyInfo => ({ type: 'bool', values: ['True', 'False'], doc });
const brush = (doc?: string): XamlPropertyInfo => ({ type: 'brush', doc });
const num = (doc?: string): XamlPropertyInfo => ({ type: 'number', doc });
const str = (doc?: string): XamlPropertyInfo => ({ type: 'string', doc });
const thick = (doc?: string): XamlPropertyInfo => ({ type: 'thickness', doc });

/** Properties every FrameworkElement understands (offered on all elements). */
export const COMMON_PROPERTIES: Record<string, XamlPropertyInfo> = {
    'x:Name': str('Identifier used from code-behind (this.MyName).'),
    Width: num('Fixed width in device-independent pixels.'),
    Height: num('Fixed height in device-independent pixels.'),
    MinWidth: num(), MinHeight: num(), MaxWidth: num(), MaxHeight: num(),
    Margin: thick('Outer spacing: "all", "lr,tb", or "left,top,right,bottom".'),
    HorizontalAlignment: en('HorizontalAlignment', 'How the element aligns inside the space its parent gives it.'),
    VerticalAlignment: en('VerticalAlignment', 'How the element aligns vertically inside its parent slot.'),
    Visibility: en('Visibility', 'Collapsed frees the layout space; Hidden keeps it.'),
    IsEnabled: bool('Disabled elements are grayed out and ignore input.'),
    Opacity: num('0.0 (transparent) to 1.0 (opaque).'),
    ToolTip: str('Text shown when hovering the element.'),
    Cursor: en('Cursor', 'Mouse cursor shown over the element.'),
    FlowDirection: en('FlowDirection'),
    Tag: str('Arbitrary data slot — not used by WPF itself.'),
    DataContext: str('Object bindings resolve against (usually set via {Binding}).'),
    Style: { type: 'resource', doc: 'Style resource, e.g. {StaticResource MyButtonStyle}.' },
    'Grid.Row': num('Row index when the element sits in a Grid with RowDefinitions.'),
    'Grid.Column': num('Column index when the element sits in a Grid with ColumnDefinitions.'),
    'Grid.RowSpan': num(), 'Grid.ColumnSpan': num(),
    'Canvas.Left': num('X position when the parent panel is a Canvas.'),
    'Canvas.Top': num('Y position when the parent panel is a Canvas.'),
    'DockPanel.Dock': en('Dock', 'Which edge to dock to inside a DockPanel.'),
    'Panel.ZIndex': num('Stacking order — higher renders on top.')
};

/** Properties shared by Control subclasses (text/border/brush stack). */
const CONTROL_PROPERTIES: Record<string, XamlPropertyInfo> = {
    Background: brush('Fill behind the content — a color name, #hex, or brush resource.'),
    Foreground: brush('Text/content color.'),
    BorderBrush: brush('Border color (used with BorderThickness).'),
    BorderThickness: thick(),
    Padding: thick('Inner spacing between the border and the content.'),
    FontFamily: str('e.g. "Segoe UI", "Consolas".'),
    FontSize: num('Font size in device-independent pixels.'),
    FontWeight: en('FontWeight'),
    FontStyle: en('FontStyle'),
    IsTabStop: bool(),
    TabIndex: num('Tab order (lower gets focus first).'),
    HorizontalContentAlignment: en('HorizontalAlignment', 'How the content aligns inside the control.'),
    VerticalContentAlignment: en('VerticalAlignment')
};

/** Events every UIElement raises. */
export const COMMON_EVENTS: Record<string, string> = {
    Loaded: 'Fires once the element is laid out, rendered, and ready.',
    MouseEnter: 'Mouse pointer entered the element bounds.',
    MouseLeave: 'Mouse pointer left the element bounds.',
    MouseDown: 'Any mouse button pressed over the element.',
    MouseUp: 'Any mouse button released over the element.',
    KeyDown: 'Key pressed while the element has focus.',
    KeyUp: 'Key released while the element has focus.',
    GotFocus: 'Element received keyboard focus.',
    LostFocus: 'Element lost keyboard focus.',
    SizeChanged: 'ActualWidth or ActualHeight changed.'
};

// ---------------------------------------------------------------------------
// Element catalog
// ---------------------------------------------------------------------------

const contentProps = (doc = 'Text shown on the control.'): Record<string, XamlPropertyInfo> =>
    ({ Content: str(doc), ...CONTROL_PROPERTIES });

export const ELEMENTS: Record<string, XamlElementInfo> = {
    // --- Root / structure ---------------------------------------------------
    Window: {
        doc: 'A top-level application window.',
        container: true,
        properties: {
            Title: str('Window caption text.'),
            WindowStartupLocation: en('WindowStartupLocation'),
            WindowStyle: en('WindowStyle'),
            WindowState: en('WindowState'),
            ResizeMode: en('ResizeMode'),
            SizeToContent: en('SizeToContent'),
            Topmost: bool('Keep the window above all others.'),
            ShowInTaskbar: bool(),
            Icon: str('Path to the window icon (.ico/.png).'),
            ...CONTROL_PROPERTIES
        },
        events: {
            Loaded: 'Window laid out and rendered.',
            Closing: 'Window is about to close (cancelable).',
            Closed: 'Window has closed.',
            StateChanged: 'Minimized/Maximized/Restored.'
        }
    },
    UserControl: { doc: 'A reusable composite control with its own markup + code-behind.', container: true, properties: CONTROL_PROPERTIES },
    Page: { doc: 'Navigable content page (used with Frame/NavigationWindow).', container: true, properties: { Title: str(), ...CONTROL_PROPERTIES } },

    // --- Panels -------------------------------------------------------------
    Grid: {
        doc: 'The most flexible panel: rows and columns, star-sizing, spanning children.',
        container: true,
        properties: { Background: brush(), ShowGridLines: bool('Draw dashed guide lines (debugging aid).') }
    },
    StackPanel: {
        doc: 'Stacks children in one direction — vertical by default.',
        container: true,
        properties: { Orientation: en('Orientation', 'Vertical (default) or Horizontal stacking.'), Background: brush() }
    },
    WrapPanel: {
        doc: 'Lays children left-to-right, wrapping to a new line when out of space.',
        container: true,
        properties: { Orientation: en('Orientation'), ItemWidth: num(), ItemHeight: num(), Background: brush() }
    },
    DockPanel: {
        doc: 'Docks children to edges (DockPanel.Dock); the last child fills the rest.',
        container: true,
        properties: { LastChildFill: bool('Give the final child all remaining space (default True).'), Background: brush() }
    },
    Canvas: {
        doc: 'Absolute positioning via Canvas.Left / Canvas.Top — what the designer uses for free placement.',
        container: true,
        properties: { Background: brush() }
    },
    UniformGrid: { doc: 'Equal-sized cells; children fill in order.', container: true, properties: { Rows: num(), Columns: num(), Background: brush() } },
    ScrollViewer: {
        doc: 'Wraps one child in a scrollable viewport.',
        container: true,
        properties: {
            VerticalScrollBarVisibility: en('ScrollBarVisibility'),
            HorizontalScrollBarVisibility: en('ScrollBarVisibility'),
            Background: brush()
        }
    },
    Border: {
        doc: 'Draws a border and/or background around a single child.',
        container: true,
        properties: {
            Background: brush(), BorderBrush: brush(), BorderThickness: thick(),
            CornerRadius: str('Round the corners: one value or "tl,tr,br,bl".'),
            Padding: thick()
        }
    },
    GroupBox: { doc: 'Titled box that groups related controls.', container: true, properties: { Header: str('Group title text.'), ...CONTROL_PROPERTIES } },
    Expander: {
        doc: 'Collapsible header + content region.',
        container: true,
        properties: { Header: str(), IsExpanded: bool(), ExpandDirection: en('ExpandDirection'), ...CONTROL_PROPERTIES },
        events: { Expanded: 'Content shown.', Collapsed: 'Content hidden.' }
    },
    Viewbox: { doc: 'Scales its single child to fit the available space.', container: true, properties: { Stretch: en('Stretch'), StretchDirection: en('StretchDirection') } },

    // --- Common controls ----------------------------------------------------
    Button: {
        doc: 'A clickable push button.',
        properties: { ...contentProps(), IsDefault: bool('Activated by Enter.'), IsCancel: bool('Activated by Esc.'), ClickMode: en('ClickMode') },
        events: { Click: 'Button was clicked (the default event).' }
    },
    Label: { doc: 'A caption for another control; supports access keys (_Name).', properties: { ...contentProps('Caption text; use _x for an Alt access key.'), Target: str('Element focused when the access key fires, e.g. {Binding ElementName=NameBox}.') } },
    TextBlock: {
        doc: 'Lightweight text display (the go-to for read-only text).',
        properties: {
            Text: str('The text to show.'),
            TextWrapping: en('TextWrapping'), TextAlignment: en('TextAlignment'), TextTrimming: en('TextTrimming'),
            Foreground: brush(), Background: brush(),
            FontFamily: str(), FontSize: num(), FontWeight: en('FontWeight'), FontStyle: en('FontStyle'),
            Padding: thick(), LineHeight: num()
        }
    },
    TextBox: {
        doc: 'Editable single- or multi-line text input.',
        properties: {
            Text: str('The editable text.'),
            IsReadOnly: bool(), MaxLength: num('0 = unlimited.'),
            TextWrapping: en('TextWrapping'), TextAlignment: en('TextAlignment'),
            AcceptsReturn: bool('Allow multi-line input with Enter.'), AcceptsTab: bool(),
            CharacterCasing: en('CharacterCasing'),
            VerticalScrollBarVisibility: en('ScrollBarVisibility'),
            ...CONTROL_PROPERTIES
        },
        events: { TextChanged: 'Text content changed (the default event).' }
    },
    PasswordBox: { doc: 'Masked text entry for passwords.', properties: { PasswordChar: str('Mask character (default ●).'), MaxLength: num(), ...CONTROL_PROPERTIES }, events: { PasswordChanged: 'Password content changed.' } },
    CheckBox: {
        doc: 'True/false (or three-state) toggle with a label.',
        properties: { ...contentProps('Label text beside the box.'), IsChecked: bool(), IsThreeState: bool('Allow the indeterminate state.') },
        events: { Checked: 'Went checked.', Unchecked: 'Went unchecked.', Click: 'Clicked (any state).' }
    },
    RadioButton: {
        doc: 'One-of-many choice; buttons sharing GroupName are exclusive.',
        properties: { ...contentProps('Label text beside the dot.'), IsChecked: bool(), GroupName: str('Buttons with the same GroupName form one exclusive set.') },
        events: { Checked: 'Selected.', Unchecked: 'Deselected.' }
    },
    ComboBox: {
        doc: 'Drop-down list, optionally editable.',
        container: true,
        properties: {
            IsEditable: bool('Allow typing free text.'), IsReadOnly: bool(),
            SelectedIndex: num('Index of the selected item (-1 = none).'),
            SelectedItem: str(), Text: str(), MaxDropDownHeight: num(),
            ...CONTROL_PROPERTIES
        },
        events: { SelectionChanged: 'Selected item changed (the default event).' }
    },
    ComboBoxItem: { doc: 'One entry inside a ComboBox.', properties: { ...contentProps('Item text.'), IsSelected: bool() } },
    ListBox: {
        doc: 'Scrollable list of selectable items.',
        container: true,
        properties: { SelectionMode: en('SelectionMode'), SelectedIndex: num(), ...CONTROL_PROPERTIES },
        events: { SelectionChanged: 'Selection changed (the default event).' }
    },
    ListBoxItem: { doc: 'One entry inside a ListBox.', properties: { ...contentProps('Item content.'), IsSelected: bool() } },
    ListView: { doc: 'ListBox with pluggable views — pair with GridView for columns.', container: true, properties: { SelectionMode: en('SelectionMode'), SelectedIndex: num(), ...CONTROL_PROPERTIES }, events: { SelectionChanged: 'Selection changed.' } },
    TreeView: { doc: 'Hierarchical items with expand/collapse.', container: true, properties: CONTROL_PROPERTIES, events: { SelectedItemChanged: 'Selected node changed.' } },
    TreeViewItem: { doc: 'One node of a TreeView.', container: true, properties: { Header: str('Node text.'), IsExpanded: bool(), IsSelected: bool() } },
    DataGrid: {
        doc: 'Editable table with sorting, auto-generated or explicit columns.',
        container: true,
        properties: {
            AutoGenerateColumns: bool('Create a column per property of the bound items.'),
            CanUserAddRows: bool(), CanUserDeleteRows: bool(), CanUserSortColumns: bool(),
            IsReadOnly: bool(),
            HeadersVisibility: { type: 'enum', values: ENUMS.DataGridHeadersVisibility },
            GridLinesVisibility: { type: 'enum', values: ENUMS.DataGridGridLinesVisibility },
            ItemsSource: str('Collection to show, usually {Binding Items}.'),
            SelectionMode: { type: 'enum', values: ['Single', 'Extended'] },
            ...CONTROL_PROPERTIES
        },
        events: { SelectionChanged: 'Selected row(s) changed.', CellEditEnding: 'A cell edit is committing.' }
    },
    Image: {
        doc: 'Displays a bitmap (png/jpg/ico/bmp).',
        properties: {
            Source: str('Image path or pack URI, e.g. "Resources/logo.png".'),
            Stretch: en('Stretch', 'How the bitmap fills the element bounds.'),
            StretchDirection: en('StretchDirection')
        }
    },
    ProgressBar: {
        doc: 'Progress indicator — determinate or indeterminate (marquee).',
        properties: { Minimum: num(), Maximum: num(), Value: num(), IsIndeterminate: bool('Marquee mode: animates without a value.'), Orientation: en('Orientation'), ...CONTROL_PROPERTIES },
        events: { ValueChanged: 'Value property changed.' }
    },
    Slider: {
        doc: 'Draggable thumb for choosing a numeric value.',
        properties: {
            Minimum: num(), Maximum: num(), Value: num(),
            TickFrequency: num(), TickPlacement: en('TickPlacement'),
            IsSnapToTickEnabled: bool(), Orientation: en('Orientation'),
            SmallChange: num('Arrow-key step.'), LargeChange: num('Page-key/track click step.'),
            ...CONTROL_PROPERTIES
        },
        events: { ValueChanged: 'Value changed (the default event).' }
    },
    DatePicker: { doc: 'Text field + calendar drop-down for picking a date.', properties: { SelectedDate: str('e.g. 2026-08-17.'), DisplayDateStart: str(), DisplayDateEnd: str(), IsTodayHighlighted: bool(), ...CONTROL_PROPERTIES }, events: { SelectedDateChanged: 'Chosen date changed.' } },
    Calendar: { doc: 'Full month-view calendar.', properties: { SelectedDate: str(), DisplayDate: str(), IsTodayHighlighted: bool(), ...CONTROL_PROPERTIES }, events: { SelectedDatesChanged: 'Selection changed.' } },
    RichTextBox: { doc: 'Editable formatted-text region (FlowDocument content).', container: true, properties: { IsReadOnly: bool(), AcceptsTab: bool(), VerticalScrollBarVisibility: en('ScrollBarVisibility'), ...CONTROL_PROPERTIES }, events: { TextChanged: 'Document content changed.' } },
    WebBrowser: { doc: 'Embedded browser view (legacy — consider WebView2 for new apps).', properties: { Source: str('URL to display.') } },
    MediaElement: { doc: 'Plays audio/video files.', properties: { Source: str('Media file path or URI.'), Volume: num('0.0–1.0.'), Stretch: en('Stretch') }, events: { MediaEnded: 'Playback reached the end.', MediaOpened: 'Media loaded and ready.' } },
    Separator: { doc: 'Thin dividing line for menus, toolbars, and stacks.' },

    // --- Menus & bars -------------------------------------------------------
    Menu: { doc: 'Horizontal menu bar (dock it to the top of a DockPanel).', container: true, properties: CONTROL_PROPERTIES },
    MenuItem: {
        doc: 'One menu entry; nest more MenuItems for sub-menus.',
        container: true,
        properties: { Header: str('Menu text; _x sets the Alt access key.'), InputGestureText: str('Shortcut hint shown right-aligned, e.g. Ctrl+S.'), IsCheckable: bool(), IsChecked: bool(), Icon: str() },
        events: { Click: 'Menu item activated (the default event).' }
    },
    ContextMenu: { doc: 'Right-click menu — assign to a control\'s ContextMenu property.', container: true, properties: CONTROL_PROPERTIES },
    ToolBar: { doc: 'Container for tool buttons (usually inside a ToolBarTray).', container: true, properties: CONTROL_PROPERTIES },
    ToolBarTray: { doc: 'Hosts one or more ToolBars in draggable bands.', container: true, properties: { Orientation: en('Orientation'), Background: brush() } },
    StatusBar: { doc: 'Status strip for the bottom edge of a window.', container: true, properties: CONTROL_PROPERTIES },
    StatusBarItem: { doc: 'One cell of a StatusBar.', properties: contentProps('Cell content.') },
    TabControl: { doc: 'Tabbed pages — children are TabItems.', container: true, properties: { SelectedIndex: num(), TabStripPlacement: { type: 'enum', values: ENUMS.Dock }, ...CONTROL_PROPERTIES }, events: { SelectionChanged: 'Active tab changed.' } },
    TabItem: { doc: 'One page of a TabControl.', container: true, properties: { Header: str('Tab caption.'), IsSelected: bool(), ...CONTROL_PROPERTIES } },

    // --- Shapes -------------------------------------------------------------
    Rectangle: { doc: 'Filled/stroked rectangle shape.', properties: { Fill: brush('Interior color.'), Stroke: brush('Outline color.'), StrokeThickness: num(), RadiusX: num('Corner rounding.'), RadiusY: num() } },
    Ellipse: { doc: 'Filled/stroked ellipse or circle.', properties: { Fill: brush(), Stroke: brush(), StrokeThickness: num() } },
    Line: { doc: 'Straight line between two points.', properties: { X1: num(), Y1: num(), X2: num(), Y2: num(), Stroke: brush(), StrokeThickness: num() } },
    Polygon: { doc: 'Closed shape through a list of points.', properties: { Points: str('e.g. "0,0 50,0 25,40".'), Fill: brush(), Stroke: brush(), StrokeThickness: num() } },
    Path: { doc: 'Arbitrary geometry drawn from path mini-language Data.', properties: { Data: str('Path markup, e.g. "M 0,0 L 10,10".'), Fill: brush(), Stroke: brush(), StrokeThickness: num() } },

    // --- Grid plumbing ------------------------------------------------------
    'Grid.RowDefinitions': { doc: 'Container for the RowDefinition list.', container: true },
    'Grid.ColumnDefinitions': { doc: 'Container for the ColumnDefinition list.', container: true },
    RowDefinition: { doc: 'One Grid row.', properties: { Height: str('"Auto", "*", "2*", or a pixel value.'), MinHeight: num(), MaxHeight: num() } },
    ColumnDefinition: { doc: 'One Grid column.', properties: { Width: str('"Auto", "*", "2*", or a pixel value.'), MinWidth: num(), MaxWidth: num() } },
    GridSplitter: { doc: 'Draggable divider that resizes Grid rows/columns.', properties: { ResizeDirection: en('GridResizeDirection'), Background: brush(), ShowsPreview: bool() } }
};

/** Attribute names offered for an element (element-specific + common + events). */
export function attributesForElement(elementName: string): Array<{ name: string; info: XamlPropertyInfo }> {
    const info = ELEMENTS[elementName];
    const out = new Map<string, XamlPropertyInfo>();
    for (const [name, p] of Object.entries(info?.properties ?? CONTROL_PROPERTIES)) { out.set(name, p); }
    for (const [name, p] of Object.entries(COMMON_PROPERTIES)) { if (!out.has(name)) { out.set(name, p); } }
    for (const [name, doc] of Object.entries({ ...COMMON_EVENTS, ...(info?.events ?? {}) })) {
        out.set(name, { type: 'event', doc });
    }
    return [...out.entries()].map(([name, i]) => ({ name, info: i }));
}

/** Value suggestions for element.attribute (enum members, True/False, colors). */
export function valuesForAttribute(elementName: string, attributeName: string): { values: string[]; isColor: boolean } {
    const attr = attributesForElement(elementName).find(a => a.name === attributeName)?.info
        ?? COMMON_PROPERTIES[attributeName];
    if (!attr) { return { values: [], isColor: false }; }
    if (attr.type === 'enum' && attr.values) { return { values: attr.values, isColor: false }; }
    if (attr.type === 'bool') { return { values: ['True', 'False'], isColor: false }; }
    if (attr.type === 'color' || attr.type === 'brush') {
        return { values: Object.keys(NAMED_COLORS), isColor: true };
    }
    return { values: [], isColor: false };
}

/** Attribute names whose values the color provider scans (brush/color-typed). */
export const COLOR_ATTRIBUTES = new Set([
    'Background', 'Foreground', 'BorderBrush', 'Fill', 'Stroke', 'Color',
    'OpacityMask', 'CaretBrush', 'SelectionBrush'
]);

// ---------------------------------------------------------------------------
// Cursor-context analysis
// ---------------------------------------------------------------------------

/**
 * Classify the caret position from the document text before it.
 * Pure string logic → easy to unit-test.
 */
export function analyzeContext(before: string): XamlContext {
    const lastOpen = before.lastIndexOf('<');
    const lastClose = before.lastIndexOf('>');

    // Not inside a tag → plain text/child position.
    if (lastOpen === -1 || lastClose > lastOpen) {
        return { kind: 'text', prefix: wordPrefix(before) };
    }

    const tag = before.slice(lastOpen + 1);

    // Comments / processing instructions — stay quiet.
    if (tag.startsWith('!--') || tag.startsWith('?')) {
        return { kind: 'text', prefix: '' };
    }

    // Closing tag: "</Butt"
    if (tag.startsWith('/')) {
        return { kind: 'closingTag', prefix: tag.slice(1) };
    }

    // Element name still being typed: "<Butt" (no whitespace yet).
    const nameMatch = /^([A-Za-z_][\w.:]*)?$/.exec(tag);
    if (nameMatch) {
        return { kind: 'element', prefix: tag };
    }

    const elementName = /^([A-Za-z_][\w.:]*)/.exec(tag)?.[1] ?? '';

    // Inside quotes? Count unescaped double quotes after the element name.
    const quotes = (tag.match(/"/g) ?? []).length;
    if (quotes % 2 === 1) {
        // We're inside an attribute value. Find the attribute being assigned.
        const attrMatch = /([\w.:-]+)\s*=\s*"[^"]*$/.exec(tag);
        const valueText = /"([^"]*)$/.exec(tag)?.[1] ?? '';
        return {
            kind: 'attributeValue',
            elementName,
            attributeName: attrMatch?.[1],
            prefix: valueText
        };
    }

    // Otherwise we're between attributes (or typing one).
    return { kind: 'attribute', elementName, prefix: wordPrefix(tag) };
}

/** Trailing identifier characters — the partially-typed word at the caret. */
function wordPrefix(text: string): string {
    return /[\w.:]*$/.exec(text)?.[0] ?? '';
}

/**
 * Unclosed tags in document order (outermost first). Used for </ completion.
 * Self-closed tags and comments are skipped; not a validating parser, but
 * plenty for completion purposes.
 */
export function openTagStack(before: string): string[] {
    const stack: string[] = [];
    const re = /<!--[\s\S]*?-->|<\/([\w.:]+)\s*>|<([\w.:]+)((?:"[^"]*"|[^">])*?)(\/?)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(before)) !== null) {
        if (m[0].startsWith('<!--')) { continue; }
        if (m[1]) {
            // Closing tag: pop the nearest matching open tag.
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i] === m[1]) { stack.splice(i, 1); break; }
            }
        } else if (m[2] && m[4] !== '/') {
            stack.push(m[2]);
        }
    }
    return stack;
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

export const SNIPPETS: XamlSnippet[] = [
    {
        prefix: 'window', label: 'Window skeleton',
        doc: 'A complete Window with a root Grid — the shape of a new MainWindow.xaml.',
        body: '<Window x:Class="${1:MyApp.MainWindow}"\n'
            + '        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"\n'
            + '        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"\n'
            + '        Title="${2:My App}" Height="${3:450}" Width="${4:800}"\n'
            + '        WindowStartupLocation="CenterScreen">\n'
            + '    <Grid>\n        $0\n    </Grid>\n</Window>'
    },
    {
        prefix: 'grid2x2', label: 'Grid with 2×2 rows/columns',
        doc: 'Grid with two rows and two columns (star-sized) ready for children.',
        body: '<Grid>\n'
            + '    <Grid.RowDefinitions>\n'
            + '        <RowDefinition Height="${1:Auto}"/>\n'
            + '        <RowDefinition Height="${2:*}"/>\n'
            + '    </Grid.RowDefinitions>\n'
            + '    <Grid.ColumnDefinitions>\n'
            + '        <ColumnDefinition Width="${3:*}"/>\n'
            + '        <ColumnDefinition Width="${4:*}"/>\n'
            + '    </Grid.ColumnDefinitions>\n'
            + '    $0\n'
            + '</Grid>'
    },
    {
        prefix: 'gridrows', label: 'Grid.RowDefinitions block',
        doc: 'Row definitions to paste inside an existing Grid.',
        body: '<Grid.RowDefinitions>\n'
            + '    <RowDefinition Height="${1:Auto}"/>\n'
            + '    <RowDefinition Height="${2:*}"/>\n'
            + '</Grid.RowDefinitions>$0'
    },
    {
        prefix: 'gridcols', label: 'Grid.ColumnDefinitions block',
        doc: 'Column definitions to paste inside an existing Grid.',
        body: '<Grid.ColumnDefinitions>\n'
            + '    <ColumnDefinition Width="${1:Auto}"/>\n'
            + '    <ColumnDefinition Width="${2:*}"/>\n'
            + '</Grid.ColumnDefinitions>$0'
    },
    {
        prefix: 'stack', label: 'StackPanel (vertical)',
        doc: 'Vertical StackPanel with margin.',
        body: '<StackPanel Orientation="${1:Vertical}" Margin="${2:8}">\n    $0\n</StackPanel>'
    },
    {
        prefix: 'dock', label: 'DockPanel app shell',
        doc: 'DockPanel with a top menu, bottom status bar, and filling content Grid.',
        body: '<DockPanel LastChildFill="True">\n'
            + '    <Menu DockPanel.Dock="Top">\n'
            + '        <MenuItem Header="_File">\n'
            + '            <MenuItem Header="E_xit" Click="${1:Exit_Click}"/>\n'
            + '        </MenuItem>\n'
            + '    </Menu>\n'
            + '    <StatusBar DockPanel.Dock="Bottom">\n'
            + '        <StatusBarItem Content="${2:Ready}"/>\n'
            + '    </StatusBar>\n'
            + '    <Grid>\n        $0\n    </Grid>\n'
            + '</DockPanel>'
    },
    {
        prefix: 'button', label: 'Button with Click handler',
        doc: 'Button wired to a Click handler (create the method in code-behind).',
        body: '<Button x:Name="${1:OkButton}" Content="${2:OK}" Width="${3:100}" Height="${4:30}" Click="${1:OkButton}_Click"/>$0'
    },
    {
        prefix: 'labeltext', label: 'Label + TextBox row',
        doc: 'Horizontal label/input pair — the classic form row.',
        body: '<StackPanel Orientation="Horizontal" Margin="${1:0,4}">\n'
            + '    <Label Content="${2:Name}:" Width="${3:110}" VerticalAlignment="Center"/>\n'
            + '    <TextBox x:Name="${4:NameBox}" Width="${5:220}" VerticalAlignment="Center"/>\n'
            + '</StackPanel>$0'
    },
    {
        prefix: 'combo', label: 'ComboBox with items',
        doc: 'ComboBox with inline items and a default selection.',
        body: '<ComboBox x:Name="${1:ChoiceBox}" Width="${2:180}" SelectedIndex="0">\n'
            + '    <ComboBoxItem Content="${3:First}"/>\n'
            + '    <ComboBoxItem Content="${4:Second}"/>\n'
            + '</ComboBox>$0'
    },
    {
        prefix: 'listbox', label: 'ListBox with items',
        doc: 'ListBox with inline items.',
        body: '<ListBox x:Name="${1:ItemList}">\n'
            + '    <ListBoxItem Content="${2:First}"/>\n'
            + '    <ListBoxItem Content="${3:Second}"/>\n'
            + '</ListBox>$0'
    },
    {
        prefix: 'datagrid', label: 'DataGrid with explicit columns',
        doc: 'Read-only DataGrid bound to ItemsSource with two text columns.',
        body: '<DataGrid x:Name="${1:ResultsGrid}" AutoGenerateColumns="False" IsReadOnly="True"\n'
            + '          ItemsSource="{Binding ${2:Items}}">\n'
            + '    <DataGrid.Columns>\n'
            + '        <DataGridTextColumn Header="${3:Name}" Binding="{Binding ${4:Name}}" Width="*"/>\n'
            + '        <DataGridTextColumn Header="${5:Value}" Binding="{Binding ${6:Value}}" Width="Auto"/>\n'
            + '    </DataGrid.Columns>\n'
            + '</DataGrid>$0'
    },
    {
        prefix: 'tabs', label: 'TabControl with two tabs',
        doc: 'TabControl with two ready pages.',
        body: '<TabControl>\n'
            + '    <TabItem Header="${1:General}">\n        <Grid>\n            $0\n        </Grid>\n    </TabItem>\n'
            + '    <TabItem Header="${2:Advanced}">\n        <Grid/>\n    </TabItem>\n'
            + '</TabControl>'
    },
    {
        prefix: 'menu', label: 'Menu bar',
        doc: 'Menu with File/Help and shortcut hints.',
        body: '<Menu>\n'
            + '    <MenuItem Header="_File">\n'
            + '        <MenuItem Header="_Open…" InputGestureText="Ctrl+O" Click="${1:Open_Click}"/>\n'
            + '        <MenuItem Header="_Save" InputGestureText="Ctrl+S" Click="${2:Save_Click}"/>\n'
            + '        <Separator/>\n'
            + '        <MenuItem Header="E_xit" Click="${3:Exit_Click}"/>\n'
            + '    </MenuItem>\n'
            + '    <MenuItem Header="_Help">\n'
            + '        <MenuItem Header="_About" Click="${4:About_Click}"/>\n'
            + '    </MenuItem>\n'
            + '</Menu>$0'
    },
    {
        prefix: 'groupbox', label: 'GroupBox with content',
        doc: 'Titled group with a vertical StackPanel inside.',
        body: '<GroupBox Header="${1:Options}" Margin="${2:8}" Padding="8">\n'
            + '    <StackPanel>\n        $0\n    </StackPanel>\n'
            + '</GroupBox>'
    },
    {
        prefix: 'scroll', label: 'ScrollViewer wrapper',
        doc: 'Vertical scrolling around content.',
        body: '<ScrollViewer VerticalScrollBarVisibility="Auto">\n    $0\n</ScrollViewer>'
    },
    {
        prefix: 'image', label: 'Image from resources',
        doc: 'Image element pointing at a project file.',
        body: '<Image Source="${1:Resources/logo.png}" Width="${2:64}" Height="${3:64}" Stretch="Uniform"/>$0'
    },
    {
        prefix: 'style', label: 'Style resource',
        doc: 'A Style for Window.Resources / App.xaml with two setters.',
        body: '<Style x:Key="${1:PrimaryButton}" TargetType="${2:Button}">\n'
            + '    <Setter Property="${3:Background}" Value="${4:#0E639C}"/>\n'
            + '    <Setter Property="${5:Foreground}" Value="${6:White}"/>\n'
            + '</Style>$0'
    },
    {
        prefix: 'buttonrow', label: 'OK / Cancel button row',
        doc: 'Right-aligned dialog button row.',
        body: '<StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="${1:0,12,0,0}">\n'
            + '    <Button Content="OK" Width="90" Margin="0,0,8,0" IsDefault="True" Click="${2:Ok_Click}"/>\n'
            + '    <Button Content="Cancel" Width="90" IsCancel="True"/>\n'
            + '</StackPanel>$0'
    },
    {
        prefix: 'statusbar', label: 'StatusBar',
        doc: 'Bottom status strip with one text cell.',
        body: '<StatusBar VerticalAlignment="Bottom">\n'
            + '    <StatusBarItem>\n        <TextBlock x:Name="${1:StatusText}" Text="${2:Ready}"/>\n    </StatusBarItem>\n'
            + '</StatusBar>$0'
    },
    {
        prefix: 'contextmenu', label: 'ContextMenu attached to a control',
        doc: 'Element.ContextMenu block with two entries.',
        body: '<${1:Grid}.ContextMenu>\n'
            + '    <ContextMenu>\n'
            + '        <MenuItem Header="${2:Copy}" Click="${3:Copy_Click}"/>\n'
            + '        <MenuItem Header="${4:Delete}" Click="${5:Delete_Click}"/>\n'
            + '    </ContextMenu>\n'
            + '</${1:Grid}.ContextMenu>$0'
    }
];
