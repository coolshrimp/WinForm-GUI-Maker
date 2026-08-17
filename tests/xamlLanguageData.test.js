'use strict';

// Tests for the pure XAML IntelliSense logic (out/xamlLanguageData.js).
// Covers the cursor-context analyzer, the open-tag stack used for </ closing,
// color parsing/formatting, and metadata sanity.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    analyzeContext, openTagStack, parseXamlColor, formatXamlColor,
    attributesForElement, valuesForAttribute,
    ELEMENTS, SNIPPETS, NAMED_COLORS, COLOR_ATTRIBUTES
} = require('../out/xamlLanguageData');

// --- context analyzer -------------------------------------------------------

test('element context after "<" with a partial name', () => {
    const ctx = analyzeContext('<Window>\n    <Butt');
    assert.equal(ctx.kind, 'element');
    assert.equal(ctx.prefix, 'Butt');
});

test('bare "<" is an element context with empty prefix', () => {
    assert.equal(analyzeContext('<Grid>\n    <').kind, 'element');
});

test('closing-tag context after "</"', () => {
    const ctx = analyzeContext('<Grid><Button></Bu');
    assert.equal(ctx.kind, 'closingTag');
    assert.equal(ctx.prefix, 'Bu');
});

test('attribute context inside an open tag', () => {
    const ctx = analyzeContext('<Button Content="OK" Wi');
    assert.equal(ctx.kind, 'attribute');
    assert.equal(ctx.elementName, 'Button');
    assert.equal(ctx.prefix, 'Wi');
});

test('attribute-value context inside quotes names the attribute', () => {
    const ctx = analyzeContext('<Button HorizontalAlignment="Cen');
    assert.equal(ctx.kind, 'attributeValue');
    assert.equal(ctx.elementName, 'Button');
    assert.equal(ctx.attributeName, 'HorizontalAlignment');
    assert.equal(ctx.prefix, 'Cen');
});

test('quotes closed again returns to attribute context', () => {
    const ctx = analyzeContext('<Button Content="OK" ');
    assert.equal(ctx.kind, 'attribute');
});

test('text context between tags', () => {
    assert.equal(analyzeContext('<Grid>\n    ').kind, 'text');
});

test('comments and processing instructions are quiet', () => {
    assert.equal(analyzeContext('<!-- a comment ').kind, 'text');
    assert.equal(analyzeContext('<?xml version="1.0" ').kind, 'text');
});

test('multiline tags still resolve the element name', () => {
    const ctx = analyzeContext('<Button\n    Width="100"\n    ');
    assert.equal(ctx.kind, 'attribute');
    assert.equal(ctx.elementName, 'Button');
});

// --- open tag stack ---------------------------------------------------------

test('open tag stack tracks nesting and pops closed tags', () => {
    const stack = openTagStack('<Window><Grid><StackPanel><Button/></StackPanel><Border>');
    assert.deepEqual(stack, ['Window', 'Grid', 'Border']);
});

test('self-closed and commented tags never enter the stack', () => {
    const stack = openTagStack('<Grid><!-- <StackPanel> --><Image Source="a.png"/>');
    assert.deepEqual(stack, ['Grid']);
});

test('attributes containing ">" inside quotes do not break the scan', () => {
    const stack = openTagStack('<Grid><Button ToolTip="a > b">');
    assert.deepEqual(stack, ['Grid', 'Button']);
});

// --- colors -----------------------------------------------------------------

test('parses #RRGGBB, #AARRGGBB, and named colors', () => {
    assert.deepEqual(parseXamlColor('#FF0000'), { r: 1, g: 0, b: 0, a: 1 });
    const half = parseXamlColor('#80000000');
    assert.ok(Math.abs(half.a - 128 / 255) < 1e-9);
    assert.deepEqual(parseXamlColor('Red'), { r: 1, g: 0, b: 0, a: 1 });
    assert.deepEqual(parseXamlColor('red'), { r: 1, g: 0, b: 0, a: 1 });
});

test('rejects bindings, resources, and junk', () => {
    assert.equal(parseXamlColor('{Binding Brush}'), undefined);
    assert.equal(parseXamlColor('{StaticResource X}'), undefined);
    assert.equal(parseXamlColor('#GGHHII'), undefined);
    assert.equal(parseXamlColor(''), undefined);
});

test('formats back to hex, alpha only when translucent', () => {
    assert.equal(formatXamlColor(1, 0, 0, 1), '#FF0000');
    assert.equal(formatXamlColor(0, 0, 0, 128 / 255), '#80000000');
});

test('every named color parses and round-trips', () => {
    for (const [name, hex] of Object.entries(NAMED_COLORS)) {
        const c = parseXamlColor(name);
        assert.ok(c, name + ' should parse');
        if (name !== 'Transparent') {
            assert.equal(formatXamlColor(c.r, c.g, c.b, c.a), hex.toUpperCase(), name);
        }
    }
});

// --- metadata sanity --------------------------------------------------------

test('Button offers Click, Content, and common layout attributes', () => {
    const names = attributesForElement('Button').map(a => a.name);
    for (const expected of ['Click', 'Content', 'Width', 'Margin', 'x:Name', 'Grid.Row', 'Loaded']) {
        assert.ok(names.includes(expected), expected);
    }
});

test('unknown elements still get the common attribute set', () => {
    const names = attributesForElement('local:MyControl').map(a => a.name);
    assert.ok(names.includes('Margin'));
    assert.ok(names.includes('Background'));
});

test('enum, bool, and brush values resolve for completion', () => {
    assert.deepEqual(
        valuesForAttribute('Button', 'HorizontalAlignment').values,
        ['Left', 'Center', 'Right', 'Stretch']
    );
    assert.deepEqual(valuesForAttribute('CheckBox', 'IsChecked').values, ['True', 'False']);
    const bg = valuesForAttribute('Button', 'Background');
    assert.ok(bg.isColor);
    assert.ok(bg.values.includes('CornflowerBlue'));
});

test('color-scanned attributes include the designer basics', () => {
    for (const name of ['Background', 'Foreground', 'BorderBrush', 'Fill', 'Stroke']) {
        assert.ok(COLOR_ATTRIBUTES.has(name), name);
    }
});

test('snippets have unique prefixes and balanced quotes/tags', () => {
    const prefixes = new Set();
    for (const s of SNIPPETS) {
        assert.ok(!prefixes.has(s.prefix), 'duplicate prefix ' + s.prefix);
        prefixes.add(s.prefix);
        assert.equal((s.body.match(/"/g) ?? []).length % 2, 0, s.prefix + ' quotes balanced');
        // After resolving placeholders nothing should be left unclosed.
        const resolved = s.body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
        const opens = (resolved.match(/<[A-Za-z]/g) ?? []).length;
        const closes = (resolved.match(/<\/[A-Za-z]/g) ?? []).length
            + (resolved.match(/\/>/g) ?? []).length;
        assert.equal(opens, closes, s.prefix + ' tags balanced');
    }
});

test('element catalog covers the toolbox staples', () => {
    for (const name of ['Window', 'Grid', 'StackPanel', 'Button', 'TextBox', 'DataGrid', 'MenuItem', 'TabControl']) {
        assert.ok(ELEMENTS[name], name);
        assert.ok(ELEMENTS[name].doc.length > 0, name + ' documented');
    }
});
