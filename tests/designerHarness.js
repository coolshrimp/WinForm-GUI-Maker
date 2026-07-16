'use strict';

// Loads media/designer.js in Node with a stub DOM so the pure text-transform
// internals (parsing, surgical edits, rename, delete) can be tested without a
// webview. The stub only needs to be good enough for module load + rendering
// side effects to run without throwing; tests assert on TEXT, never on DOM.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function stubElement(tag = 'div') {
    const el = {
        tagName: String(tag).toUpperCase(),
        children: [],
        style: {},
        dataset: {},
        classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
        setAttribute() { },
        removeAttribute() { },
        getAttribute() { return null; },
        appendChild(c) { el.children.push(c); return c; },
        append() { },
        prepend() { },
        insertBefore(c) { el.children.push(c); return c; },
        remove() { },
        replaceChildren() { el.children = []; },
        addEventListener() { },
        removeEventListener() { },
        dispatchEvent() { return true; },
        querySelector() { return stubElement(); },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
        closest() { return null; },
        focus() { },
        blur() { },
        click() { },
        select() { },
        scrollIntoView() { },
        value: '',
        checked: false,
        textContent: '',
        innerHTML: '',
        hidden: false,
        disabled: false,
        title: '',
        id: '',
        className: '',
        draggable: false,
        parentElement: null,
        parentNode: null,
        offsetWidth: 100,
        offsetHeight: 30
    };
    return el;
}

function createSandbox() {
    const messages = [];
    const byId = new Map();
    const documentStub = {
        getElementById(id) {
            if (!byId.has(id)) { byId.set(id, stubElement()); }
            return byId.get(id);
        },
        createElement(tag) { return stubElement(tag); },
        createElementNS(_ns, tag) { return stubElement(tag); },
        createTextNode(text) { return { textContent: text }; },
        createDocumentFragment() { return stubElement('fragment'); },
        addEventListener() { },
        removeEventListener() { },
        elementFromPoint() { return null; },
        querySelector() { return stubElement(); },
        querySelectorAll() { return []; },
        body: stubElement('body'),
        documentElement: stubElement('html')
    };

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        acquireVsCodeApi: () => ({ postMessage: m => messages.push(m), getState: () => undefined, setState: () => undefined }),
        document: documentStub,
        getComputedStyle: () => ({ color: 'rgb(0, 0, 0)' }),
        requestAnimationFrame: fn => setTimeout(fn, 0),
        cancelAnimationFrame: clearTimeout,
        navigator: { clipboard: {} },
        __UIMAKER_TEST__: true
    };
    sandbox.window = sandbox;
    sandbox.window.addEventListener = () => { };
    sandbox.window.removeEventListener = () => { };
    sandbox.globalThis = sandbox;
    return { sandbox, messages };
}

/** Load designer.js fresh; returns { api, messages }. */
function loadDesigner() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'designer.js'), 'utf8');
    const { sandbox, messages } = createSandbox();
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'designer.js' });
    if (!sandbox.__uimakerTest) {
        throw new Error('designer.js did not expose its test hook');
    }
    return { api: sandbox.__uimakerTest, messages };
}

module.exports = { loadDesigner };
