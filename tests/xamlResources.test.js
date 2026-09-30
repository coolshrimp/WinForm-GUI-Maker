'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { xamlResourcesFor } = require('../out/xamlResources');
const { loadDesigner } = require('./designerHarness');

test('window Source dictionaries supply caption fonts and brushes without App resources', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uimaker-xaml-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'App.xaml'), '<Application><Application.Resources/></Application>');
    fs.mkdirSync(path.join(root, 'theme'));
    fs.writeFileSync(path.join(root, 'theme', 'Colors.xaml'), '<ResourceDictionary xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><SolidColorBrush x:Key="CaptionBrush" Color="#96A6B9"/></ResourceDictionary>');
    fs.writeFileSync(path.join(root, 'theme', 'Theme.xaml'), `<ResourceDictionary xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
      <ResourceDictionary.MergedDictionaries><ResourceDictionary Source='Colors.xaml'/><ResourceDictionary Source='Missing.xaml'/></ResourceDictionary.MergedDictionaries>
      <Style x:Key="Caption" TargetType="TextBlock"><Setter Property="FontSize" Value="10"/><Setter Property="Foreground" Value="{StaticResource CaptionBrush}"/></Style>
    </ResourceDictionary>`);
    const doc = `<Window xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" FontFamily="Consolas" Foreground="#EEF3F8"><Window.Resources><ResourceDictionary Source='theme/Theme.xaml'/></Window.Resources><TextBlock Text="TEMPERATURE" Style="{StaticResource Caption}"/></Window>`;
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', doc);
    api.setAppResources(xamlResourcesFor(path.join(root, 'MainWindow.xaml'), root, doc));
    assert.equal(api.probeProp('1', 'FontSize'), '10');
    assert.equal(api.probeStyle('1', 'Foreground'), '#96A6B9');
    fs.writeFileSync(path.join(root, 'theme', 'Colors.xaml'), '<ResourceDictionary Source="Theme.xaml"/>');
    assert.equal(xamlResourcesFor(path.join(root, 'MainWindow.xaml'), root, doc).length, 3);
});

test('inline merged dictionaries and window-local overrides take precedence', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', `<Window xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Window.Resources><ResourceDictionary><ResourceDictionary.MergedDictionaries><ResourceDictionary><Style x:Key="Caption" TargetType="TextBlock"><Setter Property="FontSize" Value="10"/></Style></ResourceDictionary></ResourceDictionary.MergedDictionaries></ResourceDictionary></Window.Resources><TextBlock Style="{StaticResource Caption}"/></Window>`);
    api.setAppResources(['<ResourceDictionary xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Style x:Key="Caption" TargetType="TextBlock"><Setter Property="FontSize" Value="20"/></Style></ResourceDictionary>']);
    assert.equal(api.probeProp('1', 'FontSize'), '10');
});
