'use strict';

// The expanded Modern (Styled) toolbox: entries insert valid markup, shared
// styles are injected exactly once, and attrs-only variants recolor without
// needing their own style.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');

const DOC = `<Window x:Class="App.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Shell" Height="450" Width="800">
    <Grid/>
</Window>`;

function fresh() {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    return api;
}

test('button variants share one injected UimModernButton style', () => {
    const api = fresh();
    api.addControlDefault('ModernButton');
    api.addControlDefault('SuccessButton');
    api.addControlDefault('DangerButton');
    const text = api.text;
    assert.equal(text.match(/x:Key="UimModernButton"/g).length, 1, 'style injected once');
    assert.match(text, /x:Name="SuccessButton1"[^>]*Background="#FF34C759"/);
    assert.match(text, /x:Name="DangerButton1"[^>]*Background="#FFFF3B30"/);
});

test('outline, link, and round icon buttons inject their styles', () => {
    const api = fresh();
    api.addControlDefault('OutlineButton');
    api.addControlDefault('LinkButton');
    api.addControlDefault('RoundIconButton');
    const text = api.text;
    assert.match(text, /x:Key="UimOutlineButton"/);
    assert.match(text, /x:Key="UimLinkButton"/);
    assert.match(text, /x:Key="UimRoundIconButton"/);
    assert.match(text, /<Button[^>]*Style="\{StaticResource UimRoundIconButton\}"/);
});

test('inputs: ModernTextBox and SearchBox use real TextBox templates', () => {
    const api = fresh();
    api.addControlDefault('ModernTextBox');
    api.addControlDefault('SearchBox');
    const text = api.text;
    assert.match(text, /x:Key="UimModernTextBox"/);
    assert.match(text, /x:Key="UimSearchBox"/);
    // PART_ContentHost is what makes a TextBox template actually editable.
    assert.equal(text.match(/PART_ContentHost/g).length >= 2, true);
});

test('progress bars share one style; the iOS variant recolors via attrs', () => {
    const api = fresh();
    api.addControlDefault('ModernProgressBar');
    api.addControlDefault('iOSProgressBar');
    const text = api.text;
    assert.equal(text.match(/x:Key="UimModernProgressBar"/g).length, 1);
    assert.match(text, /x:Name="iOSProgressBar1"[^>]*Foreground="#FF007AFF"/);
    assert.match(text, /PART_Indicator/);
});

test('iOSToggle reuses the ToggleSwitch style with green colors', () => {
    const api = fresh();
    api.addControlDefault('iOSToggle');
    const text = api.text;
    assert.equal(text.match(/x:Key="UimToggleSwitch"/g).length, 1);
    assert.match(text, /x:Name="iOSToggle1"[^>]*Background="#FF34C759"/);
    // And it previews as a switch.
    assert.ok(api.toggleInfoAt('1/0'));
});

test('Spinner inserts an animated ring ContentControl', () => {
    const api = fresh();
    api.addControlDefault('Spinner');
    const text = api.text;
    assert.match(text, /x:Key="UimSpinner"/);
    assert.match(text, /<Storyboard RepeatBehavior="Forever">/);
    assert.match(text, /RotateTransform\.Angle/);
    assert.match(text, /<ContentControl[^>]*Style="\{StaticResource UimSpinner\}"/);
});

test('shapes and decor: StatusDot, Ellipse, Rectangle, Chip, GradientPanel, GlassCard', () => {
    const api = fresh();
    for (const type of ['StatusDot', 'Ellipse', 'Rectangle', 'Chip', 'GradientPanel', 'GlassCard', 'SectionDivider', 'TitleText', 'SubtitleText', 'Badge']) {
        api.addControlDefault(type);
    }
    const text = api.text;
    assert.match(text, /<Ellipse[^>]*x:Name="StatusDot1"[^>]*Fill="#FF34C759"/);
    assert.match(text, /<Ellipse[^>]*x:Name="Ellipse1"/);
    assert.match(text, /<Rectangle[^>]*x:Name="Rectangle1"/);
    // Chip carries a TextBlock child; GradientPanel a gradient background.
    assert.match(text, /<Border[^>]*x:Name="Chip1"[\s\S]*?<TextBlock[^>]*Text="Chip"/);
    assert.match(text, /<Border\.Background>[\s\S]*?<LinearGradientBrush[\s\S]*?<GradientStop[^>]*Color="#FF7C4DFF"/);
    assert.match(text, /x:Name="GlassCard1"[^>]*Background="#66FFFFFF"/);
    assert.match(text, /x:Name="TitleText1"[^>]*FontSize="24"/);
    assert.match(text, /x:Name="Badge1"[^>]*Background="#FFFF3B30"/);
});

test('every Modern style parses cleanly and injects (no silent drops)', () => {
    const api = fresh();
    for (const type of ['ToggleSwitch', 'ModernButton', 'OutlineButton', 'LinkButton',
        'RoundIconButton', 'ModernTextBox', 'SearchBox', 'ModernProgressBar',
        'ModernSlider', 'Spinner', 'PillBadge']) {
        api.addControlDefault(type);
    }
    const text = api.text;
    for (const key of ['UimToggleSwitch', 'UimModernButton', 'UimOutlineButton', 'UimLinkButton',
        'UimRoundIconButton', 'UimModernTextBox', 'UimSearchBox', 'UimModernProgressBar',
        'UimModernSlider', 'UimSpinner', 'UimPillBadge']) {
        assert.equal((text.match(new RegExp(`x:Key="${key}"`, 'g')) ?? []).length, 1, `${key} injected once`);
    }
});
