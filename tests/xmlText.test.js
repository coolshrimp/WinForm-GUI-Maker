'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeXmlEntities } = require('../out/xmlText');

test('project XML text entities decode before source generation', () => {
    assert.equal(decodeXmlEntities('R&amp;D&#46;Tools'), 'R&D.Tools');
    assert.equal(decodeXmlEntities('A&#x2e;B &quot;x&quot;'), 'A.B "x"');
    assert.equal(decodeXmlEntities('&unknown;'), '&unknown;');
});
