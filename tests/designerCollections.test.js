'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');
const wrap = body => `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><StackPanel>${body}<Button x:Name="Outside" Content="Preserve me"/></StackPanel></Window>`;

for (const [type, prop, itemType, field, value] of [
    ['ComboBox', 'Items', 'ComboBoxItem', 'Content', 'Second choice'],
    ['ListBox', 'Items', 'ListBoxItem', 'Content', 'List entry'],
    ['ListView', 'Items', 'ListViewItem', 'Content', 'View entry'],
    ['TabControl', 'Items', 'TabItem', 'Header', 'Settings'],
    ['TreeView', 'Items', 'TreeViewItem', 'Header', 'Branch'],
    ['ItemsControl', 'Items', 'ContentControl', 'Content', 'Content'],
    ['ToolBar', 'Items', 'Button', 'Content', 'Run'],
    ['StatusBar', 'Items', 'StatusBarItem', 'Content', 'Ready'],
    ['ToolBarTray', 'ToolBars', 'ToolBar', 'Name', 'MainToolbar'],
    ['Grid', 'RowDefinitions', 'RowDefinition', 'Height', '2*'],
    ['Grid', 'ColumnDefinitions', 'ColumnDefinition', 'Width', 'Auto'],
    ['DataGrid', 'Columns', 'DataGridTextColumn', 'Binding', '{Binding Title}'],
    ['ListView', 'Columns', 'GridViewColumn', 'DisplayMemberBinding', '{Binding Name}'],
    ['Button', 'ContextMenu', 'MenuItem', 'Header', 'Copy']
]) {
    test(`${type}.${prop} exposes the shared editor and saves the correct collection structure`, () => {
        const { api, messages } = loadDesigner();
        const text = wrap(`<${type}/>`);
        api.setDoc('Collections.xaml', text);
        const owner = api.elAtPath('0/0');
        assert.ok(api.xamlCollectionProperties(owner).includes(prop));
        assert.ok(api.xamlControlMenu(owner).some(m => m.label === `Edit ${prop}…`));
        const draft = api.createXamlCollectionSession(owner, prop);
        assert.equal(api.applyXamlCollection(draft), true);
        assert.equal(messages.filter(m => m.type === 'edit').length, 0); // opening creates no empty wrappers
        const first = api.xamlCollectionAdd(draft, draft.owner, itemType);
        assert.ok(first);
        assert.equal(api.xamlCollectionSet(draft, first, field, value), true);
        const second = api.xamlCollectionAdd(draft, draft.owner, itemType);
        assert.equal(api.moveCollectionItem(second, -1), true);
        assert.equal(api.xamlCollectionRemove(draft, first), true);
        api.xamlCollectionSet(draft, second, field, value);
        assert.equal(api.text, text);
        assert.equal(api.applyXamlCollection(draft), true);
        assert.equal(messages.filter(m => m.type === 'edit').length, 1);
        const live = api.elAtPath('0/0');
        assert.equal(api.xamlCollectionChildren(live, prop).length, 1);
        assert.equal(api.xamlCollectionChildren(live, prop)[0].getAttribute(field === 'Name' ? 'x:Name' : field), value);
        assert.match(api.text, /Content="Preserve me"/);
        if (type === 'ListView' && prop === 'Columns') {
            assert.match(api.text, /<ListView.View>\s*<GridView>\s*<GridView.Columns>/);
            assert.doesNotMatch(api.text, /ListView.Columns/);
        } else if (prop === 'ContextMenu') {
            assert.match(api.text, /<Button.ContextMenu>\s*<ContextMenu>/);
        } else if (prop === 'RowDefinitions' || prop === 'ColumnDefinitions' || prop === 'Columns') {
            assert.ok(api.text.includes(`<${type}.${prop}>`));
        }
        if (itemType === 'TabItem') { assert.match(api.text, /<Grid\s*\/>/); }
    });
}

test('tab Items property syntax, nested content and selection are retained when reordering', () => {
    const { api } = loadDesigner();
    api.setDoc('Tabs.xaml', wrap('<TabControl SelectedIndex="1"><TabControl.Items><TabItem Header="First"><TabItem.Content><Grid><Button Content="Inside"/></Grid></TabItem.Content></TabItem><TabItem Header="Second"/></TabControl.Items></TabControl>'));
    const s = api.createXamlCollectionSession(api.elAtPath('0/0'));
    const items = api.xamlCollectionChildren(s.owner);
    api.moveCollectionItem(items[1], -1);
    api.xamlCollectionSet(s, items[1], 'Header', 'Moved');
    assert.equal(api.applyXamlCollection(s), true);
    assert.match(api.text, /SelectedIndex="1"/);
    assert.match(api.text, /TabControl.Items/);
    assert.match(api.text, /TabItem.Content/);
    assert.match(api.text, /Content="Inside"/);
    assert.deepEqual(Array.from(api.xamlCollectionChildren(api.elAtPath('0/0')), n => n.getAttribute('Header')), ['Moved', 'First']);
});

test('tree child editing, string choices, templates and namespace collisions round trip', () => {
    const { api } = loadDesigner();
    const original = wrap('<TreeView><TreeViewItem Header="Root"><TreeViewItem.Items><TreeViewItem Header="Old"/></TreeViewItem.Items></TreeViewItem></TreeView><ComboBox xmlns:sys="clr-namespace:Custom"><ComboBoxItem><ComboBoxItem.Content><TextBlock Text="Rich choice"/></ComboBoxItem.Content></ComboBoxItem></ComboBox>');
    api.setDoc('Tree.xaml', original);
    let s = api.createXamlCollectionSession(api.elAtPath('0/0'));
    const root = api.xamlCollectionChildren(s.owner)[0];
    const child = api.xamlCollectionAdd(s, root, 'TreeViewItem');
    api.xamlCollectionSet(s, child, 'Header', 'New child');
    api.moveCollectionItem(child, -1);
    assert.equal(api.applyXamlCollection(s), true);
    assert.match(api.text, /Header="New child"/);
    s = api.createXamlCollectionSession(api.elAtPath('0/1'));
    const string = api.xamlCollectionAdd(s, s.owner, 'String');
    api.xamlCollectionSet(s, string, 'Value', 'A < B & "quoted"');
    assert.equal(api.applyXamlCollection(s), true);
    assert.match(api.text, /xmlns:sys="clr-namespace:Custom"/);
    assert.match(api.text, /xmlns:sys1="clr-namespace:System;assembly=mscorlib"/);
    assert.match(api.text, /<sys1:String>A &lt; B &amp; "quoted"<\/sys1:String>/);
    assert.match(api.text, /Text="Rich choice"/);
});

test('bindings guard Items only; bound grids and lists can still configure their columns', () => {
    const { api } = loadDesigner();
    api.setDoc('Bound.xaml', wrap('<ComboBox><ComboBox.ItemsSource><Binding Path="Choices"/></ComboBox.ItemsSource></ComboBox><DataGrid ItemsSource="{Binding Rows}"/><ListView ItemsSource="{Binding Rows}"/><ListView View="{StaticResource SharedView}"/><Button ContextMenu="{StaticResource SharedMenu}"/><UniformGrid Columns="3"/>'));
    const combo = api.createXamlCollectionSession(api.elAtPath('0/0'));
    assert.equal(api.xamlCollectionAdd(combo, combo.owner, 'ComboBoxItem'), null);
    assert.match(combo.error, /ItemsSource/);
    for (const index of [1, 2]) {
        const owner = api.elAtPath(`0/${index}`);
        assert.equal(api.xamlCollectionWritable(owner, 'Items'), false);
        assert.equal(api.xamlCollectionWritable(owner, 'Columns'), true);
    }
    for (const [index, prop, itemType] of [[3, 'Columns', 'GridViewColumn'], [4, 'ContextMenu', 'MenuItem']]) {
        const owner = api.elAtPath(`0/${index}`);
        const s = api.createXamlCollectionSession(owner, prop);
        assert.equal(api.xamlCollectionAdd(s, s.owner, itemType), null);
    }
    assert.equal(api.xamlCollectionTypes(api.elAtPath('0/5'), 'Columns'), null);
    const tabs = wrap('<TabControl/>');
    api.setDoc('Tabs.xaml', tabs);
    const s = api.createXamlCollectionSession(api.elAtPath('0/0'));
    assert.equal(api.xamlCollectionAdd(s, s.owner, 'MenuItem'), null);
    assert.equal(api.text, tabs);
});

test('root context menus and base-qualified custom-control collections keep their namespaces and content', () => {
    const { api } = loadDesigner();
    api.setDoc('Root.xaml', wrap('<Button Content="Keep"/>'));
    let s = api.createXamlCollectionSession(api.elAtPath(''), 'ContextMenu');
    const entry = api.xamlCollectionAdd(s, s.owner, 'MenuItem');
    api.xamlCollectionSet(s, entry, 'Header', 'Root menu');
    assert.equal(api.applyXamlCollection(s), true);
    assert.match(api.text, /<Window.ContextMenu>\s*<ContextMenu>\s*<MenuItem Header="Root menu"/);
    assert.match(api.text, /Content="Keep"/);

    api.setCustomControls({ wpf: [{ name: 'Choices', base: 'ComboBox', xmlns: 'clr-namespace:Demo' }] });
    const custom = wrap('<local:Choices xmlns:local="clr-namespace:Demo"><ComboBox.Items><ComboBoxItem Content="Existing"/></ComboBox.Items></local:Choices>');
    api.setDoc('Custom.xaml', custom);
    const owner = api.elAtPath('0/0');
    assert.ok(api.xamlCollectionProperties(owner).includes('Items'));
    s = api.createXamlCollectionSession(owner);
    const added = api.xamlCollectionAdd(s, s.owner, 'ComboBoxItem');
    assert.ok(added);
    api.xamlCollectionSet(s, added, 'Content', 'New');
    assert.equal(api.applyXamlCollection(s), true);
    assert.match(api.text, /<ComboBox.Items>/);
    assert.equal(api.xamlCollectionChildren(api.elAtPath('0/0')).length, 2);
    assert.match(api.text, /xmlns:local="clr-namespace:Demo"/);
});

test('column templates and inline context-menu resources remain opaque when editing their items', () => {
    const { api } = loadDesigner();
    api.setDoc('Opaque.xaml', wrap('<DataGrid ItemsSource="{Binding Rows}"><DataGrid.Columns><DataGridTemplateColumn Header="Art"><DataGridTemplateColumn.CellTemplate><DataTemplate><Image Source="{Binding Artwork}"/></DataTemplate></DataGridTemplateColumn.CellTemplate></DataGridTemplateColumn></DataGrid.Columns></DataGrid><Button><FrameworkElement.ContextMenu><ContextMenu><ContextMenu.Resources><SolidColorBrush x:Key="Accent" Color="Red"/></ContextMenu.Resources><MenuItem Header="Copy"/></ContextMenu></FrameworkElement.ContextMenu></Button>'));
    let s = api.createXamlCollectionSession(api.elAtPath('0/0'), 'Columns');
    api.xamlCollectionSet(s, api.xamlCollectionChildren(s.owner, 'Columns')[0], 'Header', 'Artwork');
    assert.equal(api.applyXamlCollection(s), true);
    assert.match(api.text, /Source="\{Binding Artwork\}"/);
    assert.match(api.text, /DataGridTemplateColumn.CellTemplate/);
    s = api.createXamlCollectionSession(api.elAtPath('0/1'), 'ContextMenu');
    assert.equal(api.xamlCollectionChildren(s.owner, 'ContextMenu').length, 1);
    api.xamlCollectionAdd(s, s.owner, 'Separator');
    assert.equal(api.applyXamlCollection(s), true);
    assert.match(api.text, /ContextMenu.Resources/);
    assert.match(api.text, /x:Key="Accent" Color="Red"/);
});
