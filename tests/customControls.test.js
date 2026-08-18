'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanProjectControls } = require('../out/customControls');

function makeProject(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uimaker-custom-controls-'));
    for (const [rel, text] of Object.entries(files)) {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
    }
    return root;
}

test('C# classes deriving from WinForms bases are discovered with namespaces', () => {
    const root = makeProject({
        'Controls/RJButton.cs': [
            'using System.Windows.Forms;',
            'namespace CustomControls.RJControls',
            '{',
            '    public class RJButton : Button',
            '    {',
            '    }',
            '}'
        ].join('\n'),
        'Form1.cs': [
            'using System.Windows.Forms;',
            'namespace CustomControls { public partial class Form1 : Form { } }'
        ].join('\n')
    });
    try {
        const controls = scanProjectControls(root);
        assert.equal(controls.length, 1);
        assert.equal(controls[0].name, 'RJButton');
        assert.equal(controls[0].qualified, 'CustomControls.RJControls.RJButton');
        assert.equal(controls[0].base, 'Button');
        assert.equal(controls[0].designer, 'winforms');
        assert.equal(controls[0].source, 'project');
        assert.equal(controls[0].file, path.join('Controls', 'RJButton.cs'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('inheritance chains resolve to the real designer base', () => {
    const root = makeProject({
        'RJButton.cs': [
            'using System.Windows.Forms;',
            'namespace App.Controls { public class RJButton : Button { } }'
        ].join('\n'),
        'FancyButton.cs': [
            'using System.Windows.Forms;',
            'namespace App.Controls { public class FancyButton : RJButton { } }'
        ].join('\n'),
        'Unrelated.cs': [
            'namespace App { public class Helper : SomethingElse { } }'
        ].join('\n')
    });
    try {
        const controls = scanProjectControls(root);
        const names = controls.map(c => c.name).sort();
        assert.deepEqual(names, ['FancyButton', 'RJButton']);
        const fancy = controls.find(c => c.name === 'FancyButton');
        assert.equal(fancy.base, 'Button'); // RJButton -> Button
        assert.ok(!controls.some(c => c.name === 'Helper'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('VB Inherits, WPF UserControl XAML, and bin/obj exclusion', () => {
    const root = makeProject({
        'MyToggle.vb': [
            'Namespace My.Controls',
            '    Public Class MyToggle',
            '        Inherits System.Windows.Forms.CheckBox',
            '    End Class',
            'End Namespace'
        ].join('\n'),
        'Views/ChartView.xaml': [
            '<UserControl x:Class="App.Views.ChartView"',
            '    xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"',
            '    xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">',
            '    <Grid />',
            '</UserControl>'
        ].join('\n'),
        'bin/Debug/Generated.cs': [
            'using System.Windows.Forms;',
            'namespace App { public class ShouldNotAppear : Button { } }'
        ].join('\n')
    });
    try {
        const controls = scanProjectControls(root);
        const toggle = controls.find(c => c.name === 'MyToggle');
        assert.ok(toggle, 'VB control found');
        assert.equal(toggle.qualified, 'My.Controls.MyToggle');
        assert.equal(toggle.base, 'CheckBox');
        assert.equal(toggle.designer, 'winforms');

        const chart = controls.find(c => c.name === 'ChartView');
        assert.ok(chart, 'WPF UserControl found');
        assert.equal(chart.designer, 'wpf');
        assert.equal(chart.xmlns, 'clr-namespace:App.Views');

        assert.ok(!controls.some(c => c.name === 'ShouldNotAppear'), 'bin/ is excluded');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('rescans pick up newly added control classes (cache invalidation)', () => {
    const root = makeProject({
        'A.cs': 'using System.Windows.Forms;\nnamespace App { public class A : Panel { } }'
    });
    try {
        assert.equal(scanProjectControls(root).length, 1);
        const later = path.join(root, 'B.cs');
        fs.writeFileSync(later, 'using System.Windows.Forms;\nnamespace App { public class B : UserControl { } }');
        // Force a different mtime even on coarse-grained filesystems.
        fs.utimesSync(later, new Date(), new Date(Date.now() + 5000));
        const controls = scanProjectControls(root);
        assert.deepEqual(controls.map(c => c.name).sort(), ['A', 'B']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
