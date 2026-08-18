'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');

const CUSTOMS = {
    winforms: [
        { name: 'RJButton', qualified: 'CustomControls.RJControls.RJButton', base: 'Button', source: 'project' },
        { name: 'SidePanel', qualified: 'App.SidePanel', base: 'Panel', source: 'library' }
    ],
    wpf: []
};

const CS_DOC = [
    'namespace Demo',
    '{',
    '    partial class MainForm',
    '    {',
    '        private System.ComponentModel.IContainer components = null;',
    '',
    '        #region Windows Form Designer generated code',
    '',
    '        private void InitializeComponent()',
    '        {',
    '            this.saveButton = new System.Windows.Forms.Button();',
    '            this.SuspendLayout();',
    '            // ',
    '            // saveButton',
    '            // ',
    '            this.saveButton.Location = new System.Drawing.Point(12, 12);',
    '            this.saveButton.Name = "saveButton";',
    '            this.saveButton.Size = new System.Drawing.Size(75, 23);',
    '            this.saveButton.TabIndex = 0;',
    '            this.saveButton.Text = "Save";',
    '            // ',
    '            // MainForm',
    '            // ',
    '            this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);',
    '            this.ClientSize = new System.Drawing.Size(800, 450);',
    '            this.Controls.Add(this.saveButton);',
    '            this.Name = "MainForm";',
    '            this.ResumeLayout(false);',
    '        }',
    '',
    '        #endregion',
    '',
    '        private System.Windows.Forms.Button saveButton;',
    '    }',
    '}',
    ''
].join('\r\n');

const VB_DOC = [
    'Partial Class MainForm',
    '    Inherits System.Windows.Forms.Form',
    '',
    '    Private Sub InitializeComponent()',
    '        Me.SaveButton = New System.Windows.Forms.Button()',
    '        Me.SuspendLayout()',
    "        '",
    "        'SaveButton",
    "        '",
    '        Me.SaveButton.Location = New System.Drawing.Point(12, 12)',
    '        Me.SaveButton.Name = "SaveButton"',
    '        Me.SaveButton.Size = New System.Drawing.Size(75, 23)',
    '        Me.SaveButton.TabIndex = 0',
    "        '",
    "        'MainForm",
    "        '",
    '        Me.AutoScaleDimensions = New System.Drawing.SizeF(7.0!, 15.0!)',
    '        Me.ClientSize = New System.Drawing.Size(800, 450)',
    '        Me.Controls.Add(Me.SaveButton)',
    '        Me.Name = "MainForm"',
    '        Me.ResumeLayout(False)',
    '    End Sub',
    '',
    '    Friend WithEvents SaveButton As System.Windows.Forms.Button',
    'End Class',
    ''
].join('\r\n');

test('inserting a custom control generates fully-qualified C# code', () => {
    const { api } = loadDesigner();
    api.setDoc('MainForm.Designer.cs', CS_DOC);
    api.setCustomControls(CUSTOMS);

    api.wfAddControl('RJButton', 16, 24, null);
    const text = api.text;
    assert.match(text, /^ {12}this\.rJButton1 = new CustomControls\.RJControls\.RJButton\(\);\r$/m);
    assert.match(text, /^ {12}this\.rJButton1\.Location = new System\.Drawing\.Point\(16, 24\);\r$/m);
    // Size and Text come from the Button base the control inherits.
    assert.match(text, /^ {12}this\.rJButton1\.Size = new System\.Drawing\.Size\(75, 23\);\r$/m);
    assert.match(text, /^ {12}this\.rJButton1\.Text = "rJButton1";\r$/m);
    assert.match(text, /^ {12}this\.Controls\.Add\(this\.rJButton1\);\r$/m);
    assert.match(text, /^ {8}private CustomControls\.RJControls\.RJButton rJButton1;\r$/m);
    // The re-parse tracks it like any other control.
    assert.equal(api.controls.get('rJButton1').type, 'RJButton');
});

test('library-registered custom controls insert too', () => {
    const { api } = loadDesigner();
    api.setDoc('MainForm.Designer.cs', CS_DOC);
    api.setCustomControls(CUSTOMS);

    api.wfAddControl('SidePanel', 0, 0, null);
    const text = api.text;
    assert.match(text, /^ {12}this\.sidePanel1 = new App\.SidePanel\(\);\r$/m);
    assert.match(text, /^ {8}private App\.SidePanel sidePanel1;\r$/m);
});

test('unknown custom types stay uninsertable (no toolbox entry, no code)', () => {
    const { api } = loadDesigner();
    api.setDoc('MainForm.Designer.cs', CS_DOC);
    api.setCustomControls({ winforms: [], wpf: [] });
    const before = api.text;
    api.wfAddControl('RJButton', 16, 24, null);
    assert.equal(api.text, before);
});

test('inserting a custom control generates fully-qualified VB code', () => {
    const { api } = loadDesigner();
    api.setDoc('MainForm.Designer.vb', VB_DOC);
    assert.equal(api.lang, 'vb');
    api.setCustomControls(CUSTOMS);

    api.wfAddControl('RJButton', 8, 8, null);
    const text = api.text;
    assert.match(text, /^ {8}Me\.RJButton1 = New CustomControls\.RJControls\.RJButton\(\)\r$/m);
    assert.match(text, /^ {8}Me\.Controls\.Add\(Me\.RJButton1\)\r$/m);
    assert.match(text, /^ {4}Friend WithEvents RJButton1 As CustomControls\.RJControls\.RJButton\r$/m);
    assert.doesNotMatch(text, /;/);
});

test('existing designer files using custom controls parse and re-edit cleanly', () => {
    const withCustom = CS_DOC
        .replace(
            'this.saveButton = new System.Windows.Forms.Button();',
            'this.saveButton = new System.Windows.Forms.Button();\r\n            this.rjToggle1 = new CustomControls.RJControls.RJToggleButton();')
        .replace(
            'this.Controls.Add(this.saveButton);',
            'this.Controls.Add(this.rjToggle1);\r\n            this.Controls.Add(this.saveButton);')
        .replace(
            'private System.Windows.Forms.Button saveButton;',
            'private System.Windows.Forms.Button saveButton;\r\n        private CustomControls.RJControls.RJToggleButton rjToggle1;');
    const { api } = loadDesigner();
    api.setDoc('MainForm.Designer.cs', withCustom);
    assert.equal(api.controls.get('rjToggle1').type, 'RJToggleButton');

    // Surgical edits work on the custom control like any built-in.
    const moved = api.wfSetLine('rjToggle1', 'Location', 'new System.Drawing.Point(30, 40)');
    assert.match(moved, /^ {12}this\.rjToggle1\.Location = new System\.Drawing\.Point\(30, 40\);\r$/m);
});
