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
