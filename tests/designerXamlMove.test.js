'use strict';

// XAML design-surface features: movability of Grid/flow-panel children,
// keyboard/drag reordering, Modern (Styled) toolbox inserts with their
// injected Window.Resources styles, and custom-control xmlns handling.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');

const DOC = `<Window x:Class="App.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Shell" Height="450" Width="800">
    <Grid>
        <Button x:Name="PinnedBtn" Content="Pinned" HorizontalAlignment="Left" VerticalAlignment="Top" Margin="10,10,0,0" Width="80" Height="30"/>
        <Button x:Name="CenteredBtn" Content="Centered" Width="80" Height="30"/>
        <WrapPanel x:Name="TogglePanel">
            <CheckBox x:Name="A" Content="A"/>
            <CheckBox x:Name="B" Content="B"/>
            <CheckBox x:Name="C" Content="C"/>
        </WrapPanel>
        <Canvas x:Name="Cv">
            <Label x:Name="Free" Canvas.Left="5" Canvas.Top="6" Content="free"/>
        </Canvas>
    </Grid>
</Window>`;

test('movability covers Grid children (exact + promoted) and flow panels', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    assert.equal(api.movabilityAt('0/0'), 'margin');   // PinnedBtn: Left/Top
    assert.equal(api.movabilityAt('0/1'), 'promote');  // CenteredBtn: no alignment yet
    assert.equal(api.movabilityAt('0/2/0'), 'reorder'); // CheckBox in WrapPanel
    assert.equal(api.movabilityAt('0/3/0'), 'canvas'); // Label in Canvas
    assert.equal(api.movabilityAt('0/2'), 'promote');  // the WrapPanel itself sits in the Grid
    assert.equal(api.movabilityAt(''), null);          // the Window does not move
});

test('reorderSibling moves flow-panel children in both directions', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    api.reorderSibling(api.elAtPath('0/2/2'), true); // C one slot earlier
    let text = api.text;
    assert.ok(text.indexOf('x:Name="C"') < text.indexOf('x:Name="B"'), 'C now precedes B');
    assert.ok(text.indexOf('x:Name="A"') < text.indexOf('x:Name="C"'), 'A still first');

    api.reorderSibling(api.elAtPath('0/2/0'), false); // A one slot later
    text = api.text;
    assert.ok(text.indexOf('x:Name="C"') < text.indexOf('x:Name="A"'), 'A moved behind C');

    // Edges are no-ops, not errors.
    const before = api.text;
    api.reorderSibling(api.elAtPath('0/2/0'), true);
    assert.equal(api.text, before);
});

test('ToggleSwitch drop injects its style once and inserts a styled CheckBox', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    api.addControlDefault('ToggleSwitch');
    let text = api.text;
    assert.match(text, /<Window\.Resources>/);
    assert.match(text, /x:Key="UimToggleSwitch"/);
    assert.match(text, /<CheckBox[^>]*x:Name="ToggleSwitch1"[^>]*Style="\{StaticResource UimToggleSwitch\}"/);
    // Template-sized: the insert must not force Width/Height.
    assert.doesNotMatch(text, /x:Name="ToggleSwitch1"[^>]*Width=/);

    api.addControlDefault('ToggleSwitch');
    text = api.text;
    assert.equal(text.match(/x:Key="UimToggleSwitch"/g).length, 1, 'style injected only once');
    assert.match(text, /x:Name="ToggleSwitch2"/);
});

test('Card inserts a Border with rounded corners and a drop shadow', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    api.addControlDefault('Card');
    const text = api.text;
    assert.match(text, /<Border[^>]*x:Name="Card1"[^>]*CornerRadius="8"/);
    assert.match(text, /<Border\.Effect>/);
    assert.match(text, /<DropShadowEffect[^>]*BlurRadius="12"/);
});

test('ModernButton and PillBadge insert with their injected styles', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    api.addControlDefault('ModernButton');
    api.addControlDefault('PillBadge');
    const text = api.text;
    assert.match(text, /x:Key="UimModernButton"/);
    assert.match(text, /<Button[^>]*Style="\{StaticResource UimModernButton\}"/);
    assert.match(text, /x:Key="UimPillBadge"/);
    assert.match(text, /<Label[^>]*Style="\{StaticResource UimPillBadge\}"/);
});

test('host controls (ContentControl, Viewbox, UniformGrid, Frame) insert', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    for (const type of ['ContentControl', 'Viewbox', 'UniformGrid', 'Frame']) {
        api.addControlDefault(type);
    }
    const text = api.text;
    assert.match(text, /<ContentControl[^>]*x:Name="ContentControl1"/);
    assert.match(text, /<Viewbox[^>]*x:Name="Viewbox1"/);
    assert.match(text, /<UniformGrid[^>]*x:Name="UniformGrid1"/);
    assert.match(text, /<Frame[^>]*x:Name="Frame1"/);
});

test('custom WPF UserControls insert with an auto-declared xmlns', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    api.setCustomControls({
        winforms: [],
        wpf: [{ name: 'ChartView', ns: 'App.Views', xmlns: 'clr-namespace:App.Views', base: 'UserControl', source: 'project' }]
    });
    api.addControlDefault('ChartView');
    const text = api.text;
    assert.match(text, /xmlns:local="clr-namespace:App\.Views"/);
    assert.match(text, /<local:ChartView[^>]*x:Name="ChartView1"/);
});
