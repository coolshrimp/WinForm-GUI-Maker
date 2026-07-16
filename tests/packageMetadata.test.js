'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('package, lockfile, engine types, and trust declaration stay aligned', () => {
    const root = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(pkg.devDependencies['@types/vscode'], pkg.engines.vscode.replace(/^\^/, ''));
    assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
    assert.equal(pkg.capabilities.virtualWorkspaces.supported, false);
});
