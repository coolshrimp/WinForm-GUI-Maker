'use strict';

// Resource chains: SolidColorBrush resources that reference separate <Color>
// resources (the HashcatGUI App.xaml pattern) must resolve on the canvas.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');

const APP = `<Application xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Application.Resources>
        <Color x:Key="BgColor">#FF111118</Color>
        <Color x:Key="CardColor">#FF20202A</Color>
        <SolidColorBrush x:Key="BgBrush" Color="{StaticResource BgColor}"/>
        <SolidColorBrush x:Key="CardBrush" Color="{StaticResource CardColor}"/>
        <SolidColorBrush x:Key="PlainBrush" Color="#FF4CC38A"/>
        <Style TargetType="Window">
            <Setter Property="Background" Value="{StaticResource BgBrush}"/>
        </Style>
    </Application.Resources>
</Application>`;

test('SolidColorBrush → Color resource chains resolve for the canvas', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', `<Window x:Class="App.W"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Grid>
        <Border x:Name="Card" Background="{StaticResource CardBrush}" Width="100" Height="50"/>
    </Grid>
</Window>`);
    api.setAppResources([APP]);
    // Implicit Window style -> BgBrush -> BgColor chain.
    assert.equal(api.probeStyle('', 'Background'), 'rgba(17,17,24,1.000)');
    // Direct element reference through the chain.
    assert.equal(api.probeStyle('0/0', 'Background'), 'rgba(32,32,42,1.000)');
    // Literal brushes keep working.
    api.elAtPath('0/0').setAttribute('Background', '{StaticResource PlainBrush}');
    assert.equal(api.probeStyle('0/0', 'Background'), 'rgba(76,195,138,1.000)');
});
