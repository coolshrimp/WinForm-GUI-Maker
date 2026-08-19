'use strict';

// Visual Studio interop: every project UI Maker creates or adopts gets a
// minimal .sln so VS's own designers have project context.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { solutionText, projectGuid, ensureSolutionFor } = require('../out/solutionFile');

test('solution text has the shape Visual Studio expects', () => {
    const text = solutionText('MyApp.csproj');
    assert.match(text, /Microsoft Visual Studio Solution File, Format Version 12\.00/);
    // C# project-type GUID, project name without extension, CRLF line endings.
    assert.match(text, /Project\("\{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC\}"\) = "MyApp", "MyApp\.csproj", "\{[0-9A-F-]{36}\}"/);
    assert.match(text, /Debug\|Any CPU\.Build\.0 = Debug\|Any CPU/);
    assert.match(text, /\r\n/);
    assert.ok(text.endsWith('EndGlobal\r\n'));

    // VB projects use the VB project-type GUID.
    assert.match(solutionText('Legacy.vbproj'), /\{F184B08F-C81C-45F6-A57F-5ABD9991F28F\}/);
});

test('project GUIDs are deterministic and well-formed', () => {
    assert.equal(projectGuid('MyApp.csproj'), projectGuid('myapp.csproj'));
    assert.notEqual(projectGuid('MyApp.csproj'), projectGuid('Other.csproj'));
    assert.match(projectGuid('MyApp.csproj'), /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
});

test('ensureSolutionFor creates once and respects existing solutions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uimaker-sln-'));
    try {
        const proj = path.join(root, 'App.csproj');
        fs.writeFileSync(proj, '<Project Sdk="Microsoft.NET.Sdk"/>');

        const created = ensureSolutionFor(proj);
        assert.equal(created, path.join(root, 'App.sln'));
        assert.ok(fs.existsSync(created));

        // Second call: solution already there — no-op.
        assert.equal(ensureSolutionFor(proj), null);

        // A solution one level UP counts only when it references the project.
        const sub = path.join(root, 'Nested');
        fs.mkdirSync(sub);
        const nestedProj = path.join(sub, 'Nested.csproj');
        fs.writeFileSync(nestedProj, '<Project Sdk="Microsoft.NET.Sdk"/>');
        fs.unlinkSync(created);
        fs.writeFileSync(path.join(root, 'Everything.sln'), 'unrelated solution');
        const nestedSln = ensureSolutionFor(nestedProj);
        assert.equal(nestedSln, path.join(sub, 'Nested.sln'), 'unrelated parent sln does not count');
        fs.unlinkSync(nestedSln);
        fs.writeFileSync(path.join(root, 'Everything.sln'),
            'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Nested", "Nested\\Nested.csproj", "{X}"');
        assert.equal(ensureSolutionFor(nestedProj), null, 'referencing parent sln counts');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
