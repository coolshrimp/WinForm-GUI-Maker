'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');

const DOC = `<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="Menu preview">
    <DockPanel>
        <Menu DockPanel.Dock="Top" Background="#192231" Foreground="#DEE6EF">
            <MenuItem Header="_File">
                <MenuItem Header="_Open" InputGestureText="Ctrl+O"/>
                <Separator/>
                <MenuItem Header="_Recent">
                    <MenuItem Header="Song__1"/>
                </MenuItem>
            </MenuItem>
            <MenuItem>
                <MenuItem.Header><AccessText Text="_View"/></MenuItem.Header>
                <MenuItem.Items>
                    <MenuItem Header="_Notes" IsCheckable="True" IsChecked="True"/>
                </MenuItem.Items>
            </MenuItem>
        </Menu>
        <TextBlock Text="Workspace"/>
    </DockPanel>
</Window>`;

function child(div, cls) {
    return div.children.find(c => c.classList?.contains(cls));
}

function press(div, modifiers = {}) {
    div.dispatchEvent({ type: 'mousedown', button: 0, preventDefault() {}, stopPropagation() {}, ...modifiers });
}

test('WPF menus render headers, shortcuts, separators and checkmarks instead of placeholders', () => {
    const { api, messages } = loadDesigner();
    api.setDoc('Menu.xaml', DOC);
    const file = api.visualAt('0/0/0');
    const open = api.visualAt('0/0/0/0');
    const view = api.visualAt('0/0/1');
    const notes = api.visualAt('0/0/1/1/0');

    assert.ok(file.classList.contains('ff-menu-top'));
    assert.equal(child(child(file, 'ff-menu-header'), 'ff-menu-caption').textContent, 'File');
    assert.equal(child(child(open, 'ff-menu-header'), 'ff-menu-gesture').textContent, 'Ctrl+O');
    assert.ok(api.visualAt('0/0/0/1').classList.contains('ff-menu-separator'));
    assert.equal(child(child(view, 'ff-menu-header'), 'ff-menu-caption').children[0].textContent, 'View');
    assert.equal(child(child(notes, 'ff-menu-header'), 'ff-menu-icon').textContent, '✓');
    assert.equal(child(child(api.visualAt('0/0/0/2/0'), 'ff-menu-header'), 'ff-menu-caption').textContent, 'Song_1');
    assert.equal(child(file, 'ff-menu-popup').hidden, true);
    assert.equal(child(view, 'ff-menu-popup').hidden, true);
    assert.equal(api.visualAt('0/0').style.background, '#192231');
    assert.equal(api.text, DOC);
    assert.equal(messages.filter(m => m.type === 'edit').length, 0);
});

test('menu preview opens one branch, retains parent popups for leaf selection and closes on canvas selection', () => {
    const { api, messages } = loadDesigner();
    api.setDoc('Menu.xaml', DOC);
    const file = api.visualAt('0/0/0');
    const recent = api.visualAt('0/0/0/2');
    const view = api.visualAt('0/0/1');
    press(file);
    assert.equal(child(file, 'ff-menu-popup').hidden, false);
    press(recent);
    assert.equal(child(file, 'ff-menu-popup').hidden, false);
    assert.equal(child(recent, 'ff-menu-popup').hidden, false);
    press(api.visualAt('0/0/0/2/0'));
    assert.equal(child(recent, 'ff-menu-popup').hidden, false);
    press(view);
    assert.equal(child(file, 'ff-menu-popup').hidden, true);
    assert.equal(child(recent, 'ff-menu-popup').hidden, true);
    assert.equal(child(view, 'ff-menu-popup').hidden, false);
    press(view);
    assert.equal(child(view, 'ff-menu-popup').hidden, true);
    press(file);
    press(api.visualAt('0/1'));
    assert.equal(child(file, 'ff-menu-popup').hidden, true);
    assert.equal(api.text, DOC);
    assert.equal(messages.filter(m => m.type === 'edit').length, 0);
});
