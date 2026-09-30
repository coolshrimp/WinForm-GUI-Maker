'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');

const DOC = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" xmlns:local="clr-namespace:Demo">
    <DockPanel>
        <Menu>
            <MenuItem Header="_File" x:Name="FileMenu">
                <MenuItem.Items>
                    <MenuItem Header="_Open" Command="{x:Static local:Commands.Open}" Click="Open_Click" Tag="Keep me">
                        <MenuItem.Icon><Image Source="Resources/open.png"/></MenuItem.Icon>
                        <MenuItem.Resources><SolidColorBrush x:Key="LocalBrush" Color="Red"/></MenuItem.Resources>
                    </MenuItem>
                    <Separator/>
                    <MenuItem x:Name="RecentMenu">
                        <MenuItem.Header><TextBlock Text="Recent files"/></MenuItem.Header>
                        <MenuItem Header="Song"/>
                    </MenuItem>
                </MenuItem.Items>
            </MenuItem>
        </Menu>
        <Button x:Name="OtherControl" Content="Outside collection"/>
    </DockPanel>
</Window>`;

test('collection edits are staged and save once while preserving property syntax and opaque content', () => {
    const { api, messages } = loadDesigner();
    api.setDoc('Menus.xaml', DOC);
    const session = api.createXamlCollectionSession(api.elAtPath('0/0/0'));
    const items = api.menuChildren(session.owner);
    assert.equal(api.xamlCollectionSet(session, items[0], 'InputGestureText', 'Ctrl+O'), true);
    const added = api.xamlCollectionAdd(session, session.owner, 'MenuItem');
    api.xamlCollectionSet(session, added, 'Header', '_Export');
    api.xamlCollectionSet(session, added, 'Icon', 'Resources/export.png');
    const nested = api.xamlCollectionAdd(session, added, 'MenuItem');
    api.xamlCollectionSet(session, nested, 'Header', 'ZIP');
    api.moveCollectionItem(added, -1);
    assert.equal(api.text, DOC);
    assert.equal(messages.filter(m => m.type === 'edit').length, 0);
    assert.equal(api.applyXamlCollection(session), true);
    assert.equal(messages.filter(m => m.type === 'edit').length, 1);
    assert.match(api.text, /<MenuItem.Items>/);
    assert.match(api.text, /Command="\{x:Static local:Commands.Open\}" Click="Open_Click" Tag="Keep me"/);
    assert.match(api.text, /<MenuItem.Resources>/);
    assert.match(api.text, /x:Key="LocalBrush" Color="Red"/);
    assert.match(api.text, /<TextBlock Text="Recent files"/);
    assert.match(api.text, /Source="Resources\/open.png"/);
    assert.match(api.text, /Source="Resources\/export.png" Width="16" Height="16"/);
    assert.match(api.text, /Content="Outside collection"/);
    assert.deepEqual(Array.from(api.menuChildren(api.elAtPath('0/0/0')), n => n.getAttribute('Header')), ['_Open', null, '_Export', null]);
});

test('discarding a draft or accepting an unchanged collection never writes the document', () => {
    const { api, messages } = loadDesigner();
    api.setDoc('Menus.xaml', DOC);
    const cancelled = api.createXamlCollectionSession(api.elAtPath('0/0/0'));
    api.xamlCollectionAdd(cancelled, cancelled.owner, 'Separator');
    api.xamlCollectionRemove(cancelled, api.menuChildren(cancelled.owner)[0]);
    assert.equal(api.text, DOC);
    const untouched = api.createXamlCollectionSession(api.elAtPath('0/0/0'));
    assert.equal(api.applyXamlCollection(untouched), true);
    assert.equal(messages.filter(m => m.type === 'edit').length, 0);
});

test('remove and reorder respect collection boundaries, including Items property wrappers', () => {
    const { api } = loadDesigner();
    api.setDoc('Menus.xaml', DOC);
    const session = api.createXamlCollectionSession(api.elAtPath('0/0/0'));
    const items = api.menuChildren(session.owner);
    assert.equal(api.moveCollectionItem(items[0], -1), false);
    assert.equal(api.moveCollectionItem(items[2], 1), false);
    assert.equal(api.moveCollectionItem(items[0], 1), true);
    assert.equal(api.xamlCollectionRemove(session, session.owner), false);
    assert.equal(api.xamlCollectionRemove(session, items[1]), true);
    assert.equal(api.applyXamlCollection(session), true);
    assert.equal(api.menuChildren(api.elAtPath('0/0/0')).length, 2);
    assert.match(api.text, /<MenuItem.Items>/);
});

test('collection editor rejects newer or invalid source instead of overwriting it', () => {
    const { api, messages } = loadDesigner();
    api.setDoc('Menus.xaml', DOC);
    const session = api.createXamlCollectionSession(api.elAtPath('0/0/0'));
    api.xamlCollectionAdd(session, session.owner, 'MenuItem');
    const newer = DOC.replace('_Open', '_Open updated');
    api.setDoc('Menus.xaml', newer);
    assert.equal(api.applyXamlCollection(session), false);
    assert.match(session.error, /document changed/);
    assert.equal(api.text, newer);
    assert.equal(messages.filter(m => m.type === 'edit').length, 0);
});

test('draft item names must be unique across the whole document, and handler names must be valid', () => {
    const { api } = loadDesigner();
    api.setDoc('Menus.xaml', DOC);
    const session = api.createXamlCollectionSession(api.elAtPath('0/0/0'));
    const item = api.menuChildren(session.owner)[0];
    assert.equal(api.xamlCollectionSet(session, item, 'Name', 'OtherControl'), false);
    assert.equal(api.applyXamlCollection(session), false);
    assert.equal(api.xamlCollectionSet(session, item, 'Name', 'OpenMenu'), true);
    assert.equal(api.xamlCollectionSet(session, item, 'Click', 'bad-name'), false);
    assert.equal(item.getAttribute('Click'), 'Open_Click');
    assert.equal(api.xamlCollectionSet(session, item, 'Click', 'OpenMenu_Click'), true);
    assert.equal(api.applyXamlCollection(session), true);
    assert.match(api.text, /x:Name="OpenMenu"/);
});

test('bound ItemsSource collections remain bound and do not receive manual items', () => {
    const { api } = loadDesigner();
    const source = DOC.replace('Header="_File"', 'Header="_File" ItemsSource="{Binding FileItems}"');
    api.setDoc('Menus.xaml', source);
    const session = api.createXamlCollectionSession(api.elAtPath('0/0/0'));
    assert.equal(api.xamlCollectionAdd(session, session.owner, 'MenuItem'), null);
    assert.match(session.error, /ItemsSource/);
    assert.equal(api.menuChildren(session.owner).length, 3);
    assert.equal(api.text, source);
});

test('context menu actions add real menu nodes, and a root Menu preview refreshes after collection save', () => {
    const { api } = loadDesigner();
    api.setDoc('Menus.xaml', DOC);
    const file = api.elAtPath('0/0/0');
    const actions = api.xamlControlMenu(file).filter(a => typeof a === 'object').map(a => a.label);
    for (const name of ['Edit Items…', 'Add MenuItem', 'Add Separator', 'Move Up', 'Move Down', '⚡ Handle Click']) {
        assert.ok(actions.includes(name), name);
    }
    api.xamlAddMenuChild(file, 'Separator');
    assert.equal(api.menuChildren(api.elAtPath('0/0/0')).length, 4);
    const rootMenu = '<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"><Menu/></Window>';
    api.setDoc('RootMenu.xaml', rootMenu);
    api.xamlAddMenuChild(api.elAtPath('0'), 'MenuItem');
    assert.ok(api.visualAt('0/0'));
    const session = api.createXamlCollectionSession(api.elAtPath('0'));
    api.xamlCollectionSet(session, api.menuChildren(session.owner)[0], 'Name', 'NewMenuItem');
    assert.equal(api.applyXamlCollection(session), true);
    assert.match(api.text, /xmlns:x="http:\/\/schemas.microsoft.com\/winfx\/2006\/xaml"/);
});

test('handler creation happens only on OK, including unchanged existing event attributes', () => {
    const { api, messages } = loadDesigner();
    api.setDoc('Menus.xaml', DOC);
    const session = api.createXamlCollectionSession(api.elAtPath('0/0/0'));
    const item = api.menuChildren(session.owner)[0];
    session.handlers.set(item, new Map([['Click', { event: 'Click', handler: 'Open_Click' }]]));
    assert.equal(messages.filter(m => m.type === 'addHandler').length, 0);
    assert.equal(api.applyXamlCollection(session), true);
    assert.equal(messages.filter(m => m.type === 'edit').length, 0);
    assert.equal(messages.filter(m => m.type === 'addHandler').length, 1);
});
