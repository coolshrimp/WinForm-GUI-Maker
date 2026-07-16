'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    addVbHandlesTarget,
    findVbClassBounds,
    findVbSub,
    isVbIdentifier,
    isVbHandlesTarget,
    parseVbHandles,
    removeVbHandlesTarget,
    renameVbIdentifier
} = require('../out/vbText');

test('VB identifiers reject keywords case-insensitively', () => {
    assert.equal(isVbIdentifier('Button1'), true);
    assert.equal(isVbIdentifier('_saveButton'), true);
    assert.equal(isVbIdentifier('Class'), false);
    assert.equal(isVbIdentifier('handles'), false);
    assert.equal(isVbIdentifier('MyBase'), false);
    assert.equal(isVbIdentifier('1button'), false);
    assert.equal(isVbHandlesTarget('Button1.Click'), true);
    assert.equal(isVbHandlesTarget('MyBase.Load'), true);
    assert.equal(isVbHandlesTarget('Button1.Click; Drop Table'), false);
});

test('VB rename is case-insensitive but skips comments and strings', () => {
    const source = [
        'Me.TotalTXT.Text = "$0.00"',
        "Me.totaltxt.AutoSize = True ' TotalTXT keeps its note",
        'Dim caption As String = "TotalTXT display"',
        'REM TotalTXT stays in this remark',
        'AddHandler TotalTXT.Click, AddressOf OnTotal'
    ].join('\r\n');

    const result = renameVbIdentifier(source, 'TotalTXT', 'TotalLabel');
    assert.match(result, /Me\.TotalLabel\.Text/);
    assert.match(result, /Me\.TotalLabel\.AutoSize/);
    assert.match(result, /' TotalTXT keeps its note/);
    assert.match(result, /"TotalTXT display"/);
    assert.match(result, /REM TotalTXT stays/);
    assert.match(result, /AddHandler TotalLabel\.Click/);
});

test('VB rename handles doubled-quote strings', () => {
    const source = 'Label1.Text = "say ""Label1"" loudly" \' Label1 trailing note';
    const result = renameVbIdentifier(source, 'Label1', 'title');
    assert.equal(result, 'title.Text = "say ""Label1"" loudly" \' Label1 trailing note');
});

test('VB class bounds and Sub lookup target the right class', () => {
    const source = [
        "' Class Fake inside a comment",
        'Public Class Helper',
        '    Sub Save_Click()',
        '    End Sub',
        'End Class',
        'Partial Class MainWindow',
        '    Inherits System.Windows.Forms.Form',
        '    Private Sub Save_Click(sender As Object, e As EventArgs) Handles SaveButton.Click',
        '    End Sub',
        'End Class'
    ].join('\n');

    const bounds = findVbClassBounds(source, 'MainWindow');
    assert.ok(bounds);
    assert.equal(source.slice(bounds.end).startsWith('End Class'), true);
    assert.ok(bounds.end > source.indexOf('Partial Class MainWindow'));

    const at = findVbSub(source, 'Save_Click', 'MainWindow');
    assert.equal(source.slice(at).startsWith('Sub Save_Click(sender'), true);
    assert.equal(findVbSub(source, 'Missing_Click', 'MainWindow'), -1);
});

test('Handles clauses parse, extend, and shrink without touching other subs', () => {
    const source = [
        'Public Class Main',
        '    Private Sub SaveAll(sender As Object, e As EventArgs) Handles Save.Click, SaveAs.Click',
        '    End Sub',
        '    Private Sub OnLoad(sender As Object, e As EventArgs) Handles MyBase.Load',
        '    End Sub',
        'End Class'
    ].join('\r\n');

    const parsed = parseVbHandles(source);
    assert.deepEqual(parsed, [
        { handler: 'SaveAll', target: 'Save.Click' },
        { handler: 'SaveAll', target: 'SaveAs.Click' },
        { handler: 'OnLoad', target: 'MyBase.Load' }
    ]);

    const extended = addVbHandlesTarget(source, 'OnLoad', 'MyBase.Shown');
    assert.match(extended, /Handles MyBase\.Load, MyBase\.Shown/);
    assert.equal(addVbHandlesTarget(source, 'OnLoad', 'mybase.LOAD'), source);
    assert.equal(addVbHandlesTarget(source, 'Nope', 'A.B'), null);

    const shrunk = removeVbHandlesTarget(source, 'saveas.click');
    assert.match(shrunk, /Handles Save\.Click\r?\n/);
    assert.match(shrunk, /Handles MyBase\.Load/);

    // Removing the only target drops the Handles keyword entirely.
    const bare = removeVbHandlesTarget(shrunk, 'Save.Click');
    assert.match(bare, /Private Sub SaveAll\(sender As Object, e As EventArgs\)\r?\n/);
    assert.doesNotMatch(bare, /SaveAll[^\r\n]*Handles/);

    // The except argument protects the named sub's clause.
    const kept = removeVbHandlesTarget(source, 'Save.Click', 'SaveAll');
    assert.equal(kept, source);
});

test('a Sub without Handles gains a clause after its parameter list', () => {
    const source = [
        'Public Class Main',
        '    Private Sub Ping(sender As Object, e As EventArgs)',
        '    End Sub',
        'End Class'
    ].join('\n');
    const wired = addVbHandlesTarget(source, 'Ping', 'Timer1.Tick');
    assert.match(wired, /Private Sub Ping\(sender As Object, e As EventArgs\) Handles Timer1\.Tick/);
});
