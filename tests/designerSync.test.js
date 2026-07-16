'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideDesignerEdit } = require('../out/designerSync');

test('designer edits apply only to the source revision they rendered', () => {
    assert.equal(
        decideDesignerEdit('<Grid/>', { baseText: '<Grid/>', text: '<Grid><Button/></Grid>' }),
        'apply'
    );
    assert.equal(
        decideDesignerEdit('<Grid><!-- code edit --></Grid>', {
            baseText: '<Grid/>',
            text: '<Grid><Button/></Grid>'
        }),
        'conflict'
    );
    assert.equal(
        decideDesignerEdit('<Grid><Button/></Grid>', {
            baseText: '<Grid/>',
            text: '<Grid><Button/></Grid>'
        }),
        'noop',
        'concurrent semantic and designer edits may safely converge'
    );
});

test('designer edit envelopes reject blind replacements and recognize no-ops', () => {
    assert.equal(decideDesignerEdit('same', { text: 'changed' }), 'invalid');
    assert.equal(decideDesignerEdit('same', { baseText: 'same', text: 42 }), 'invalid');
    assert.equal(decideDesignerEdit('same', { baseText: 'same', text: 'same' }), 'noop');
});
