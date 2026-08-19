'use strict';

// User-defined toggle-switch CheckBox templates must be recognized and
// previewed as switches — not only the injected UimToggleSwitch style.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');

const DOC = `<Window x:Class="App.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Shell" Height="450" Width="800">
    <Window.Resources>
        <Style x:Key="AppToggle" TargetType="CheckBox">
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="CheckBox">
                        <StackPanel Orientation="Horizontal">
                            <Border x:Name="Track" Width="44" Height="22" CornerRadius="11" Background="#FF3A3A46">
                                <Ellipse x:Name="Thumb" Width="16" Height="16" Fill="#FFFFFFFF" HorizontalAlignment="Left"/>
                            </Border>
                            <ContentPresenter Margin="8,0,0,0"/>
                        </StackPanel>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsChecked" Value="True">
                                <Setter TargetName="Track" Property="Background" Value="#FF9C6BFF"/>
                                <Setter TargetName="Thumb" Property="HorizontalAlignment" Value="Right"/>
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style x:Key="SlideToggle" TargetType="CheckBox">
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="CheckBox">
                        <Border x:Name="Track" CornerRadius="10" Background="#FF555555">
                            <Border x:Name="Knob" Width="12" Height="12" Background="White" HorizontalAlignment="Left"/>
                        </Border>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsChecked" Value="True">
                                <Setter TargetName="Knob" Property="HorizontalAlignment" Value="Right"/>
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style x:Key="FlatCheck" TargetType="CheckBox">
            <Setter Property="Foreground" Value="#FFCCCCCC"/>
        </Style>
    </Window.Resources>
    <Grid>
        <WrapPanel>
            <CheckBox x:Name="ShiftToggle" Content="Shift menu" Style="{StaticResource AppToggle}"/>
            <CheckBox x:Name="Slider" Content="Slide" Style="{StaticResource SlideToggle}"/>
            <CheckBox x:Name="Plain" Content="Plain" Style="{StaticResource FlatCheck}"/>
            <CheckBox x:Name="Bare" Content="Bare"/>
        </WrapPanel>
    </Grid>
</Window>`;

test('custom toggle templates are detected with their own brushes', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    const info = api.toggleInfoAt('1/0/0'); // ShiftToggle (Resources is child 0)
    assert.ok(info, 'AppToggle recognized as a switch');
    assert.equal(info.track, '#FF3A3A46');
    assert.equal(info.on, '#FF9C6BFF');
    assert.equal(info.thumb, '#FFFFFFFF');
});

test('slide-trigger templates without an Ellipse still count as toggles', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    assert.ok(api.toggleInfoAt('1/0/1'), 'SlideToggle recognized');
});

test('plain restyled CheckBoxes stay checkboxes', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', DOC);
    assert.equal(api.toggleInfoAt('1/0/2'), null, 'FlatCheck is not a toggle');
    assert.equal(api.toggleInfoAt('1/0/3'), null, 'unstyled CheckBox is not a toggle');
});

test('implicit app-level CheckBox toggle styles apply too', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', `<Window x:Class="App.W"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Grid><CheckBox x:Name="Any" Content="On"/></Grid>
</Window>`);
    api.setAppResources([`<Application xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Application.Resources>
        <Style TargetType="CheckBox">
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="CheckBox">
                        <Border CornerRadius="9" Background="#FF202020"><Ellipse Width="12" Height="12" Fill="White"/></Border>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
    </Application.Resources>
</Application>`]);
    assert.ok(api.toggleInfoAt('0/0'), 'implicit toggle style recognized');
});

test('each ToggleSwitch carries its own colors via Background/BorderBrush', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', `<Window x:Class="App.W"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Grid/>
</Window>`);
    api.addControlDefault('ToggleSwitch');
    api.addControlDefault('ToggleSwitch');
    // Second toggle gets its own colors (checked = Background, off = BorderBrush).
    api.elAtPath('1/1').setAttribute('Background', '#FF00C853');
    api.elAtPath('1/1').setAttribute('BorderBrush', '#FF37474F');

    // The injected template defers its brushes to the instance.
    const info = api.toggleInfoAt('1/1');
    assert.match(info.track, /TemplateBinding BorderBrush/);
    assert.match(info.on, /Binding Background.*TemplatedParent/);

    // Default toggle uses the style's colors; the customized one its own.
    const def = api.probeStyle('1/0', 'Background');
    const custom = api.probeStyle('1/1', 'Background');
    assert.ok(def, 'style default checked color resolves');
    assert.ok(custom, 'per-instance checked color resolves');
    assert.notEqual(def, custom);
});

test('an app-level toggle style with StaticResource colors resolves for the swatches', () => {
    // Mirrors csContextMenuEditor's App.xaml: colors baked into the template
    // (off = literal, on = {StaticResource Accent}), hover via Opacity.
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', `<Window x:Class="App.W"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Grid><CheckBox x:Name="ShiftToggle" Content="Shift menu" Style="{StaticResource ToggleSwitch}"/></Grid>
</Window>`);
    api.setAppResources([`<Application xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Application.Resources>
        <SolidColorBrush x:Key="Accent">#FF7B4DC8</SolidColorBrush>
        <Style x:Key="ToggleSwitch" TargetType="CheckBox">
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="CheckBox">
                        <StackPanel Orientation="Horizontal">
                            <Border x:Name="track" Width="38" Height="20" CornerRadius="10" Background="#FFCFC7DA">
                                <Ellipse x:Name="thumb" Width="14" Height="14" Fill="White" HorizontalAlignment="Left"/>
                            </Border>
                            <ContentPresenter/>
                        </StackPanel>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsChecked" Value="True">
                                <Setter TargetName="track" Property="Background" Value="{StaticResource Accent}"/>
                                <Setter TargetName="thumb" Property="HorizontalAlignment" Value="Right"/>
                            </Trigger>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="track" Property="Opacity" Value="0.85"/>
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
    </Application.Resources>
</Application>`]);
    const info = api.toggleInfoAt('0/0');
    assert.ok(info, 'app toggle style detected');
    assert.equal(info.on, '{StaticResource Accent}');
    assert.equal(info.track, '#FFCFC7DA');
    // The swatch fallback resolves the resource to the actual purple.
    assert.equal(api.templateBrushAt('0/0', info.on), 'rgba(123,77,200,1.000)');
    // TemplateBinding forms resolve per instance once the style defers to it.
    api.elAtPath('0/0').setAttribute('Background', '#FF00C853');
    assert.equal(api.templateBrushAt('0/0', '{TemplateBinding Background}'), 'rgba(0,200,83,1.000)');
});

test('the injected UimToggleSwitch is recognized by the generic detector', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', `<Window x:Class="App.W"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Grid/>
</Window>`);
    api.addControlDefault('ToggleSwitch');
    // Path: Window has [Resources, Grid]; the new CheckBox is the Grid's child.
    assert.ok(api.toggleInfoAt('1/0'), 'inserted ToggleSwitch previews as a switch');
});
