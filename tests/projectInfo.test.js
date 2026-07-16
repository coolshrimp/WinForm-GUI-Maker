'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isNetFrameworkTfm, readProjectInfo } = require('../out/projectInfo');

test('multi-target project inspection keeps each TFM available for selection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uimaker-project-info-'));
    try {
        const project = path.join(root, 'Mixed.csproj');
        fs.writeFileSync(project, [
            '<Project Sdk="Microsoft.NET.Sdk">',
            '  <PropertyGroup>',
            '    <TargetFrameworks>net48;net8.0-windows</TargetFrameworks>',
            '    <UseWindowsForms>true</UseWindowsForms>',
            '    <OutputType>WinExe</OutputType>',
            '  </PropertyGroup>',
            '</Project>'
        ].join('\n'));
        const info = readProjectInfo(project);
        assert.deepEqual(info.targetFrameworks, ['net48', 'net8.0-windows']);
        assert.equal(info.netFramework, true);
        assert.equal(info.useWinForms, true);
        assert.equal(isNetFrameworkTfm(info.targetFrameworks[0]), true);
        assert.equal(isNetFrameworkTfm(info.targetFrameworks[1]), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
