'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions } = require('../out/semver');

test('NuGet versions follow SemVer core and release precedence', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.ok(compareVersions('2.0.0', '1.999.999') > 0);
    assert.ok(compareVersions('1.0.0', '1.0.0-rc.99') > 0);
    assert.equal(compareVersions('1.2.3+build.7', '1.2.3+build.9'), 0);
});

test('prerelease identifiers compare numerically and without overflow', () => {
    assert.ok(compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0);
    assert.ok(compareVersions('1.0.0-10', '1.0.0-alpha') < 0);
    assert.ok(compareVersions(
        '1.0.999999999999999999999999999999',
        '1.0.1000000000000000000000000000000'
    ) < 0);
});
