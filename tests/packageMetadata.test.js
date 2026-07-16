'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

test('package, lockfile, engine types, and trust declaration stay aligned', () => {
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(pkg.devDependencies['@types/vscode'], pkg.engines.vscode.replace(/^\^/, ''));
    assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
    assert.equal(pkg.capabilities.virtualWorkspaces.supported, false);
});

test('Marketplace icon is declared and packaged as a real PNG asset', () => {
    assert.equal(pkg.icon, 'media/icon.png');
    const icon = fs.readFileSync(path.join(root, pkg.icon));
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
