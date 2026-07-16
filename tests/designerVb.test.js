'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDesigner } = require('./designerHarness');

const VB_DOC = [
    '<Global.Microsoft.VisualBasic.CompilerServices.DesignerGenerated()> _',
    'Partial Class MoneyStats',
    '    Inherits System.Windows.Forms.Form',
    '',
    "    'Form overrides dispose to clean up the component list.",
    '    <System.Diagnostics.DebuggerNonUserCode()> _',
    '    Protected Overrides Sub Dispose(ByVal disposing As Boolean)',
    '        Try',
    '            If disposing AndAlso components IsNot Nothing Then',
    '                components.Dispose()',
    '            End If',
    '        Finally',
    '            MyBase.Dispose(disposing)',
    '        End Try',
    '    End Sub',
    '',
    "    'Required by the Windows Form Designer",
    '    Private components As System.ComponentModel.IContainer',
    '',
    '    <System.Diagnostics.DebuggerStepThrough()> _',
    '    Private Sub InitializeComponent()',
    '        Me.TotalTXT = New System.Windows.Forms.Label()',
    '        Me.GroupBox3 = New System.Windows.Forms.GroupBox()',
    '        Me.PictureBox1 = New System.Windows.Forms.PictureBox()',
    '        Me.GroupBox3.SuspendLayout()',
    '        CType(Me.PictureBox1, System.ComponentModel.ISupportInitialize).BeginInit()',
    '        Me.SuspendLayout()',
    "        '",
    "        'TotalTXT",
    "        '",
    '        Me.TotalTXT.AutoSize = True',
    '        Me.TotalTXT.Font = New System.Drawing.Font("Microsoft Sans Serif", 15.75!, System.Drawing.FontStyle.Bold, System.Drawing.GraphicsUnit.Point, CType(0, Byte))',
    '        Me.TotalTXT.Location = New System.Drawing.Point(9, 25)',
    '        Me.TotalTXT.Name = "TotalTXT"',
    '        Me.TotalTXT.Size = New System.Drawing.Size(71, 25)',
    '        Me.TotalTXT.TabIndex = 2',
    '        Me.TotalTXT.Text = "$0.00"',
    "        '",
    "        'GroupBox3",
    "        '",
    '        Me.GroupBox3.Controls.Add(Me.TotalTXT)',
    '        Me.GroupBox3.Location = New System.Drawing.Point(96, 83)',
    '        Me.GroupBox3.Name = "GroupBox3"',
    '        Me.GroupBox3.Size = New System.Drawing.Size(164, 65)',
    '        Me.GroupBox3.TabIndex = 3',
    '        Me.GroupBox3.TabStop = False',
    '        Me.GroupBox3.Text = "Total"',
    "        '",
    "        'MoneyStats",
    "        '",
    '        Me.AutoScaleDimensions = New System.Drawing.SizeF(7.0!, 15.0!)',
    '        Me.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font',
    '        Me.ClientSize = New System.Drawing.Size(800, 450)',
    '        Me.Controls.Add(Me.GroupBox3)',
    '        Me.Name = "MoneyStats"',
    '        Me.Text = "Money Stats"',
    '        Me.GroupBox3.ResumeLayout(False)',
    '        CType(Me.PictureBox1, System.ComponentModel.ISupportInitialize).EndInit()',
    '        Me.ResumeLayout(False)',
    '    End Sub',
    '',
    '    Friend WithEvents TotalTXT As System.Windows.Forms.Label',
    '    Friend WithEvents GroupBox3 As System.Windows.Forms.GroupBox',
    '    Friend WithEvents PictureBox1 As System.Windows.Forms.PictureBox',
    'End Class',
    ''
].join('\r\n');

function loadVb() {
    const { api, messages } = loadDesigner();
    api.setDoc('MoneyStats.Designer.vb', VB_DOC);
    return { api, messages };
}

test('VB designer files parse controls, hierarchy, and values', () => {
    const { api } = loadVb();
    assert.equal(api.lang, 'vb');
    assert.equal(api.form.name, 'MoneyStats');
    assert.deepEqual([...api.controls.keys()].sort(), ['GroupBox3', 'PictureBox1', 'TotalTXT']);

    const total = api.controls.get('TotalTXT');
    assert.equal(total.type, 'Label');
    assert.equal(total.parent.name, 'GroupBox3');
    assert.equal(api.wfString(total.props.Text), '$0.00');
    assert.equal(api.wfFont(total.props.Font).bold, true);
    assert.equal(api.form.children.some(c => c.name === 'GroupBox3'), true);
});

test('VB property edits rewrite the exact line in VB syntax', () => {
    const { api } = loadVb();
    const moved = api.wfSetLine('TotalTXT', 'Location', 'new System.Drawing.Point(20, 30)');
    assert.match(moved, /^ {8}Me\.TotalTXT\.Location = New System\.Drawing\.Point\(20, 30\)\r$/m);
    assert.doesNotMatch(moved, /Point\(9, 25\)/);
    // A brand-new property line lands inside the control's block, VB-style.
    const titled = api.wfSetFormLine('Text', api.wfQuote('Say ""hi"" now'.replace(/""/g, '"')));
    assert.match(titled, /^ {8}Me\.Text = "Say ""hi"" now"\r$/m);
});

test('VB serialization writes VB literals', () => {
    const { api } = loadVb();
    assert.equal(api.wfSerialize({ kind: 'bool' }, 'True'), 'True');
    assert.equal(api.wfSerialize({ kind: 'string' }, 'say "hi"'), '"say ""hi"""');
    assert.equal(api.wfSerialize({ kind: 'char' }, '*'), '"*"c');
    assert.equal(api.wfSerialize({ kind: 'decimal' }, '1.5'), 'New Decimal(New Integer() { 15, 0, 0, 65536 })');
    assert.equal(api.wfCode('new System.Drawing.Size(10, 20)'), 'New System.Drawing.Size(10, 20)');
    assert.equal(api.wfCode('true'), 'True');
    // String contents are never keyword-translated.
    assert.equal(api.wfCode('"brand new this. is true"'), '"brand new this. is true"');
});

test('adding a control emits VB statements, trio comments, and a WithEvents field', () => {
    const { api } = loadVb();
    api.wfAddControl('Button', 40, 56, null);
    const text = api.text;
    assert.match(text, /^ {8}Me\.Button1 = New System\.Windows\.Forms\.Button\(\)\r$/m);
    assert.match(text, /^ {8}'\r\n {8}'Button1\r\n {8}'\r$/m);
    assert.match(text, /^ {8}Me\.Button1\.Location = New System\.Drawing\.Point\(40, 56\)\r$/m);
    assert.match(text, /^ {8}Me\.Button1\.Text = "Button1"\r$/m);
    assert.match(text, /^ {8}Me\.Controls\.Add\(Me\.Button1\)\r$/m);
    assert.match(text, /^ {4}Friend WithEvents Button1 As System\.Windows\.Forms\.Button\r$/m);
    assert.doesNotMatch(text, /;/);
    // The re-parse sees the inserted control.
    assert.equal(api.controls.has('Button1'), true);
});

test('deleting a VB control removes its statements, trio, field, and parent Add', () => {
    const { api } = loadVb();
    const total = api.controls.get('TotalTXT');
    api.wfDeleteControls([total]);
    const text = api.text;
    assert.doesNotMatch(text, /TotalTXT/);
    // Sibling controls and the form section survive.
    assert.match(text, /^ {8}Me\.GroupBox3\.Text = "Total"\r$/m);
    assert.match(text, /^ {8}Me\.ClientSize = New System\.Drawing\.Size\(800, 450\)\r$/m);
    assert.equal(api.controls.has('GroupBox3'), true);
});

test('VB rename is case-insensitive, keeps literals, and notifies the host', () => {
    const { api, messages } = loadVb();
    const total = api.controls.get('TotalTXT');
    api.wfRenameControl(total, 'TotalLabel');
    const text = api.text;
    assert.doesNotMatch(text, /\bTotalTXT\b/i);
    assert.match(text, /^ {8}Me\.TotalLabel\.Name = "TotalLabel"\r$/m);
    // The visible text stays.
    assert.match(text, /"\$0\.00"/);
    const rename = messages.find(m => m.type === 'renameControl');
    assert.deepEqual({ oldName: rename.oldName, newName: rename.newName }, { oldName: 'TotalTXT', newName: 'TotalLabel' });
});

test('VB event wiring goes through the host Handles machinery, not the designer file', () => {
    const { api, messages } = loadVb();
    const before = api.text;
    api.wfWireEvent(api.controls.get('TotalTXT'), 'Click', '', true);
    assert.equal(api.text, before); // designer file untouched
    const add = messages.find(m => m.type === 'addHandler');
    assert.equal(add.handler, 'TotalTXT_Click');
    assert.equal(add.handles, 'TotalTXT.Click');
    assert.equal(add.reveal, true);

    api.wfUnwireEvent(api.form, 'Load');
    const remove = messages.find(m => m.type === 'removeHandler');
    assert.equal(remove.handles, 'MyBase.Load');
});

test('Handles wiring parsed by the host shows up on the controls', () => {
    const { api } = loadDesigner();
    api.setVbHandles([
        { handler: 'TotalTXT_Click', target: 'totaltxt.click' },
        { handler: 'MoneyStats_Load', target: 'MyBase.Load' }
    ]);
    api.setDoc('MoneyStats.Designer.vb', VB_DOC);
    assert.equal(api.controls.get('TotalTXT').events.Click, 'TotalTXT_Click');
    assert.equal(api.form.events.Load, 'MoneyStats_Load');
});

test('adding a tray component declares the VB components container pieces', () => {
    const { api } = loadVb();
    api.wfAddComponent('Timer');
    const text = api.text;
    assert.match(text, /^ {8}Me\.Timer1 = New System\.Windows\.Forms\.Timer\(Me\.components\)\r$/m);
    assert.match(text, /^ {8}Me\.components = New System\.ComponentModel\.Container\(\)\r$/m);
    assert.match(text, /^ {4}Friend WithEvents Timer1 As System\.Windows\.Forms\.Timer\r$/m);
});

// --------------------------------------------------------------- C# guard

const CS_DOC = [
    'namespace Demo',
    '{',
    '    partial class MainForm',
    '    {',
    '        private System.ComponentModel.IContainer components = null;',
    '',
    '        protected override void Dispose(bool disposing)',
    '        {',
    '            if (disposing && (components != null)) { components.Dispose(); }',
    '            base.Dispose(disposing);',
    '        }',
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
    '            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;',
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

test('C# designer behavior is unchanged by the VB dialect support', () => {
    const { api } = loadDesigner();
    api.setDoc('MainForm.Designer.cs', CS_DOC);
    assert.equal(api.lang, 'cs');
    assert.equal(api.controls.get('saveButton').type, 'Button');

    const moved = api.wfSetLine('saveButton', 'Location', 'new System.Drawing.Point(30, 40)');
    assert.match(moved, /^ {12}this\.saveButton\.Location = new System\.Drawing\.Point\(30, 40\);\r$/m);

    api.wfAddControl('Label', 5, 6, null);
    const text = api.text;
    assert.match(text, /^ {12}this\.label1 = new System\.Windows\.Forms\.Label\(\);\r$/m);
    assert.match(text, /^ {8}private System\.Windows\.Forms\.Label label1;\r$/m);
    assert.equal(api.wfSerialize({ kind: 'bool' }, 'True'), 'true');
    assert.equal(api.wfQuote('say "hi"'), '"say \\"hi\\""');
});
