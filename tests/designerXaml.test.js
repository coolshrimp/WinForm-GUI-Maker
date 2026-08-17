'use strict';

// XAML renderer regressions: real-world markup (UniformGrid, nested cards,
// ImageBrush backgrounds, Image sources) must parse and render without
// throwing, and image paths must be requested from the host with scope 'x'.
// The harness DOM is a stub, so tests assert on behavior/messages, not pixels.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');

const tick = () => new Promise(r => setTimeout(r, 5));

/** A trimmed BiosModTool-style window: the shapes that used to overlap. */
const APP_SHELL = `<Window x:Class="App.MainWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Shell" Height="700" Width="1200" Background="{StaticResource AppBackground}">
    <Grid>
        <Grid.ColumnDefinitions><ColumnDefinition Width="230"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
        <TabControl Grid.Column="1">
            <TabItem>
                <ScrollViewer VerticalScrollBarVisibility="Auto"><StackPanel Margin="28">
                    <TextBlock Text="Image operations" FontSize="18" FontWeight="SemiBold"/>
                    <UniformGrid Columns="2">
                        <Border Padding="10"><StackPanel><TextBlock Text="Split image"/><Button Content="Choose"/></StackPanel></Border>
                        <Border Padding="10"><StackPanel><TextBlock Text="Combine images"/><Button Content="Choose"/></StackPanel></Border>
                        <Border Padding="10"><StackPanel><TextBlock Text="RC unlock"/><Button Content="Unlock"/></StackPanel></Border>
                        <Border Padding="10"><StackPanel><TextBlock Text="Guided workflow"/><Button Content="Run"/></StackPanel></Border>
                    </UniformGrid>
                    <UniformGrid Rows="1">
                        <TextBlock Text="READS"/><TextBlock Text="BACKUP"/><TextBlock Text="WRITE GATE"/>
                    </UniformGrid>
                    <UniformGrid>
                        <TextBlock Text="a"/><TextBlock Text="b"/><TextBlock Text="c"/>
                    </UniformGrid>
                    <Viewbox><TextBlock Text="scaled"/></Viewbox>
                    <Menu><MenuItem Header="_File"/></Menu>
                    <StatusBar><StatusBarItem Content="Ready"/></StatusBar>
                    <ItemsControl>
                        <TextBlock Text="one"/><TextBlock Text="two"/>
                    </ItemsControl>
                </StackPanel></ScrollViewer>
            </TabItem>
        </TabControl>
    </Grid>
</Window>`;

test('UniformGrid / Viewbox / Menu / unknown containers render without throwing', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', APP_SHELL);
    assert.equal(api.text, APP_SHELL); // parse succeeded, nothing rewrote the doc
});

test('Image sources are requested from the host with scope x', async () => {
    const { api, messages } = loadDesigner();
    api.setDoc('MainWindow.xaml', `<Window
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="T">
    <StackPanel>
        <Image Source="Resources/logo.png" Stretch="Uniform"/>
        <Border>
            <Border.Background><ImageBrush ImageSource="Resources/bg.jpg" Stretch="UniformToFill"/></Border.Background>
            <TextBlock Text="over image"/>
        </Border>
        <Image Source="{Binding Photo}"/>
    </StackPanel>
</Window>`);
    await tick();
    const req = messages.find(m => m.type === 'resolveImages');
    assert.ok(req, 'expected a resolveImages request');
    const keys = req.keys.map(k => `${k.scope}:${k.key}`).sort();
    assert.equal(JSON.stringify(keys), JSON.stringify(['x:Resources/bg.jpg', 'x:Resources/logo.png']));
});

test('binding and pack-URI image sources are handled safely', async () => {
    const { api, messages } = loadDesigner();
    api.setDoc('W.xaml', `<Window
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="T">
    <StackPanel>
        <Image Source="pack://application:,,,/Resources/icon.png"/>
    </StackPanel>
</Window>`);
    await tick();
    const req = messages.find(m => m.type === 'resolveImages');
    assert.ok(req);
    assert.equal(JSON.stringify(req.keys), JSON.stringify([{ scope: 'x', key: 'Resources/icon.png' }]));
});

test('re-render does not re-request already-resolved images', async () => {
    const { api, messages } = loadDesigner();
    const doc = `<Window
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="T">
    <StackPanel><Image Source="Resources/logo.png"/></StackPanel>
</Window>`;
    api.setDoc('W.xaml', doc);
    await tick();
    api.setDoc('W.xaml', doc + ' ');
    await tick();
    const reqs = messages.filter(m => m.type === 'resolveImages');
    assert.equal(reqs.length, 1, 'image resolution should be requested exactly once');
});

// --- App.xaml resource resolution -------------------------------------------

const APP_XAML = `<Application x:Class="App.App"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
    <Application.Resources>
        <SolidColorBrush x:Key="AppBackground" Color="#0B1020"/>
        <SolidColorBrush x:Key="PanelBrush" Color="#121A2E"/>
        <SolidColorBrush x:Key="PanelRaisedBrush" Color="#18233B"/>
        <SolidColorBrush x:Key="BorderBrush" Color="#273555"/>
        <LinearGradientBrush x:Key="HeaderFade" StartPoint="0,0" EndPoint="1,0">
            <GradientStop Color="#102040" Offset="0"/>
            <GradientStop Color="#304060" Offset="1"/>
        </LinearGradientBrush>
        <Style TargetType="Window">
            <Setter Property="Background" Value="{StaticResource AppBackground}"/>
        </Style>
        <Style TargetType="Button">
            <Setter Property="Foreground" Value="White"/>
            <Setter Property="Background" Value="#6D7CFF"/>
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="Button">
                        <Border Background="{TemplateBinding Background}" CornerRadius="7"/>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
        <Style x:Key="SecondaryButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
            <Setter Property="Background" Value="{StaticResource PanelRaisedBrush}"/>
        </Style>
        <Style x:Key="Card" TargetType="Border">
            <Setter Property="Background" Value="{StaticResource PanelBrush}"/>
            <Setter Property="BorderBrush" Value="{StaticResource BorderBrush}"/>
        </Style>
    </Application.Resources>
</Application>`;

const THEMED_WINDOW = `<Window x:Class="App.MainWindow"
    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
    Title="T" Background="{StaticResource AppBackground}">
    <Grid>
        <Border Style="{StaticResource Card}">
            <Button Style="{StaticResource SecondaryButton}" Content="Nav"/>
        </Border>
    </Grid>
</Window>`;

test('StaticResource brushes resolve through App.xaml resources', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', THEMED_WINDOW);
    api.setAppResources([APP_XAML]);
    assert.equal(api.probeStyle('', 'Background'), '#0B1020');           // window attr via resource
    assert.equal(api.probeStyle('0/0', 'Background'), '#121A2E');        // Card style setter
    assert.equal(api.probeStyle('0/0', 'BorderBrush'), '#273555');
    assert.equal(api.probeStyle('0/0/0', 'Background'), '#18233B');      // SecondaryButton override
    assert.equal(api.probeStyle('0/0/0', 'Foreground'), 'White');        // BasedOn {x:Type Button} chain
    assert.equal(api.probeStyle('', 'Missing'), '');
});

test('template CornerRadius and gradients are approximated', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', THEMED_WINDOW);
    api.setAppResources([APP_XAML]);
    assert.equal(api.probeProp('0/0/0', 'CornerRadius'), '7');           // from the ControlTemplate Border
    api.setDoc('W2.xaml', `<Window
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="T">
        <Grid><Border Background="{StaticResource HeaderFade}"/></Grid>
    </Window>`);
    assert.equal(api.probeStyle('0/0', 'Background'), 'linear-gradient(90deg, #102040 0%, #304060 100%)');
});

test('window-level resources override application-level ones', () => {
    const { api } = loadDesigner();
    api.setDoc('MainWindow.xaml', `<Window
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="T">
        <Window.Resources><SolidColorBrush x:Key="AppBackground" Color="#FF0000"/></Window.Resources>
        <Grid Background="{StaticResource AppBackground}"/>
    </Window>`);
    api.setAppResources([APP_XAML]);
    assert.equal(api.probeStyle('1', 'Background'), '#FF0000');
});
