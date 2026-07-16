'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFilesAtomically, replaceFileAtomically } = require('../out/atomicFile');

test('atomic replacement installs complete text without temporary debris', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uimaker-atomic-'));
    try {
        const target = path.join(root, 'Project.csproj');
        fs.writeFileSync(target, '<Project>old</Project>', 'utf8');
        replaceFileAtomically(target, '<Project>new</Project>');
        assert.equal(fs.readFileSync(target, 'utf8'), '<Project>new</Project>');
        assert.deepEqual(fs.readdirSync(root), ['Project.csproj']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('new file-set creation rolls back when any target already exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uimaker-create-set-'));
    try {
        const first = path.join(root, 'Window.xaml');
        const second = path.join(root, 'Window.xaml.cs');
        fs.writeFileSync(second, 'user file', 'utf8');
        assert.throws(() => createFilesAtomically([
            { target: first, contents: '<Window />' },
            { target: second, contents: 'generated' }
        ]));
        assert.equal(fs.existsSync(first), false);
        assert.equal(fs.readFileSync(second, 'utf8'), 'user file');
        assert.deepEqual(fs.readdirSync(root), ['Window.xaml.cs']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
