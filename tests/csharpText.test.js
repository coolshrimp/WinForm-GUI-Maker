'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    escapeRegExp,
    findCSharpClassEnd,
    findCSharpVoidMethod,
    isCSharpIdentifier,
    renameCSharpIdentifier,
    sanitizeCSharpIdentifier,
    sanitizeCSharpNamespace
} = require('../out/csharpText');

test('generated C# identifiers reject keywords and malformed names', () => {
    assert.equal(isCSharpIdentifier('button1'), true);
    assert.equal(isCSharpIdentifier('_saveButton'), true);
    assert.equal(isCSharpIdentifier('class'), false);
    assert.equal(isCSharpIdentifier('event'), false);
    assert.equal(isCSharpIdentifier('1button'), false);
    assert.equal(isCSharpIdentifier('button-name'), false);
});

test('project and file names sanitize into compilable identifiers', () => {
    assert.equal(sanitizeCSharpIdentifier('class'), '_class');
    assert.equal(sanitizeCSharpIdentifier('9 lives'), '_9_lives');
    assert.equal(sanitizeCSharpNamespace('R&D.class.9Lives'), 'R_D._class._9Lives');
});

test('control rename changes code and interpolation expressions, not visible text', () => {
    const source = [
        'button1.Enabled = true;',
        'var plain = "button1"; // button1 is documented here',
        'var value = $"Text button1: {button1.Text}";',
        'var verbatim = $@"Text button1: {button1.Text}";',
        'var raw = $"""Text button1: {button1.Text}""";',
        '/* button1 must stay in this comment */',
        "var initial = 'b';"
    ].join('\n');

    const result = renameCSharpIdentifier(source, 'button1', 'saveButton');
    assert.match(result, /^saveButton\.Enabled/m);
    assert.match(result, /"button1"/);
    assert.match(result, /\/\/ button1 is documented here/);
    assert.match(result, /\$"Text button1: \{saveButton\.Text\}"/);
    assert.match(result, /\$@"Text button1: \{saveButton\.Text\}"/);
    assert.match(result, /\$"""Text button1: \{saveButton\.Text\}"""/);
    assert.match(result, /\/\* button1 must stay in this comment \*\//);
});

test('class matching ignores fake declarations and braces in literals/comments', () => {
    const source = [
        '// class Fake { }',
        'var raw = """class AlsoFake { }""";',
        'namespace Demo;',
        'public partial class MainWindow',
        '{',
        '    private string Text => "} class Nope {";',
        '    private void Work() { /* } */ }',
        '}'
    ].join('\n');

    const end = findCSharpClassEnd(source);
    assert.equal(end, source.lastIndexOf('}'));
});

test('handler lookup ignores comments and string literals', () => {
    const source = [
        '// void Save_Click(object sender) { }',
        'var note = "void Save_Click(";',
        'private void Save_Click(object sender, System.EventArgs e) { }'
    ].join('\n');
    assert.equal(findCSharpVoidMethod(source, 'Save_Click'), source.lastIndexOf('void Save_Click'));
    assert.equal(findCSharpVoidMethod(source, 'class'), -1);
});

test('handler/class lookup can target the designer partial among helper classes', () => {
    const source = [
        'class Helper { private void Save_Click() { } }',
        'partial class MainWindow',
        '{',
        '    private void Save_Click(object sender, System.EventArgs e) { }',
        '}'
    ].join('\n');
    const targetHandler = source.lastIndexOf('void Save_Click');
    assert.equal(findCSharpVoidMethod(source, 'Save_Click', 'MainWindow'), targetHandler);
    assert.equal(findCSharpClassEnd(source, 'MainWindow'), source.lastIndexOf('}'));
});

test('regular-expression escaping is literal', () => {
    const value = 'name.with+[parts]';
    assert.equal(new RegExp(escapeRegExp(value)).test(value), true);
});
