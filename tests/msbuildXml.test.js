'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getMsbuildProperty, setMsbuildProperty } = require('../out/msbuildXml');

test('MSBuild property replacement escapes XML and keeps dollar tokens literal', () => {
    const xml = '<Project>\n  <PropertyGroup>\n    <Description>old</Description>\n  </PropertyGroup>\n</Project>\n';
    const result = setMsbuildProperty(xml, 'Description', 'cost $& $1 $$ <safe>');
    assert.match(result, /<Description>cost \$&amp; \$1 \$\$ &lt;safe&gt;<\/Description>/);
});

test('required plural target framework is preserved and arbitrary tag names are rejected', () => {
    const xml = '<Project><PropertyGroup><TargetFrameworks>net48;net8.0</TargetFrameworks></PropertyGroup></Project>';
    assert.equal(setMsbuildProperty(xml, 'TargetFrameworks', ''), xml);
    assert.equal(setMsbuildProperty(xml, 'Bad-Name', 'value'), xml);
});

test('property editing does not rewrite configuration-conditional groups', () => {
    const xml = [
        '<Project>',
        '  <PropertyGroup Condition="\'$(Configuration)\' == \'Debug\'">',
        '    <OutputType>Library</OutputType>',
        '  </PropertyGroup>',
        '  <PropertyGroup>',
        '    <OutputType>WinExe</OutputType>',
        '  </PropertyGroup>',
        '</Project>'
    ].join('\n');
    const result = setMsbuildProperty(xml, 'OutputType', 'Exe');
    assert.match(result, /Condition=.*?<OutputType>Library<\/OutputType>/s);
    assert.match(result, /<PropertyGroup>\s*<OutputType>Exe<\/OutputType>/);
});

test('property reads prefer unconditional groups and decode XML entities', () => {
    const xml = [
        '<Project>',
        '  <PropertyGroup Condition="\'$(Configuration)\' == \'Debug\'">',
        '    <AssemblyName>Debug.Name</AssemblyName>',
        '  </PropertyGroup>',
        '  <PropertyGroup>',
        '    <AssemblyName>My&amp;App</AssemblyName>',
        '  </PropertyGroup>',
        '</Project>'
    ].join('\n');
    assert.equal(getMsbuildProperty(xml, 'AssemblyName'), 'My&App');
    assert.equal(getMsbuildProperty(xml, 'Bad-Name'), '');
});
