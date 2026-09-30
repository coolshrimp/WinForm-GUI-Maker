'use strict';

// Loads media/designer.js in Node with a stub DOM so the pure text-transform
// internals (parsing, surgical edits, rename, delete) can be tested without a
// webview. The stub only needs to be good enough for module load + rendering
// side effects to run without throwing. It also records rendered children and
// event handlers for preview tests; geometry still needs a real browser.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function stubElement(tag = 'div') {
    const style = {};
    const listeners = new Map();
    style.setProperty = (k, v) => { style[k] = v; };
    style.removeProperty = k => { delete style[k]; };
    const el = {
        tagName: String(tag).toUpperCase(),
        children: [],
        style,
        dataset: {},
        classList: {
            add(...names) { el.className = [...new Set([...el.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
            remove(...names) { el.className = el.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
            toggle(name, force) {
                const add = force ?? !this.contains(name);
                if (add) { this.add(name); } else { this.remove(name); }
                return add;
            },
            contains(name) { return el.className.split(/\s+/).includes(name); }
        },
        setAttribute() { },
        removeAttribute() { },
        getAttribute() { return null; },
        appendChild(c) { el.children.push(c); c.parentElement = el; c.parentNode = el; return c; },
        append(...nodes) { for (const c of nodes) { el.appendChild(typeof c === 'string' ? { textContent: c } : c); } },
        prepend() { },
        insertBefore(c) { el.children.push(c); return c; },
        remove() { },
        replaceChildren() { el.children = []; },
        addEventListener(type, fn) { if (!listeners.has(type)) { listeners.set(type, new Set()); } listeners.get(type).add(fn); },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
        dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) { fn(event); } return true; },
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

// --------------------------------------------------------------- XML mini-DOM
// Enough of an XML DOM for designer.js's XAML paths (parse, attribute access,
// property elements, styles, image brushes). Not validating; mismatched tags
// yield a document whose root is <parsererror>, matching how the designer
// detects broken markup.

function makeXmlElement(qname, ns) {
    const colon = qname.indexOf(':');
    const el = {
        nodeType: 1,
        nodeName: qname,
        prefix: colon >= 0 ? qname.slice(0, colon) : null,
        localName: colon >= 0 ? qname.slice(colon + 1) : qname,
        namespaceURI: ns ?? null,
        attrs: new Map(),
        childNodes: [],
        parentNode: null,
        get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; },
        get ownerDocument() { let n = this; while (n.parentNode) { n = n.parentNode; } return n.nodeType === 9 ? n : this._doc; },
        get children() { return this.childNodes.filter(c => c.nodeType === 1); },
        get firstChild() { return this.childNodes[0] ?? null; },
        get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); },
        get textContent() {
            return this.childNodes.map(c => c.nodeType === 3 ? c.data : c.textContent).join('');
        },
        set textContent(value) { this.childNodes = [{ nodeType: 3, data: String(value) }]; },
        getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; },
        setAttribute(n, v) { this.attrs.set(n, String(v)); },
        removeAttribute(n) { this.attrs.delete(n); },
        // The designer only uses the XAML "x" prefix namespace.
        getAttributeNS(_ns, n) { return this.attrs.get(`x:${n}`) ?? null; },
        setAttributeNS(_ns, qn, v) { this.attrs.set(qn, String(v)); },
        removeAttributeNS(_ns, n) { this.attrs.delete(`x:${n}`); this.attrs.delete(n); },
        appendChild(c) { if (c.parentNode) { c.remove(); } c.parentNode = el; el.childNodes.push(c); return c; },
        insertBefore(c, ref) {
            if (c.parentNode) { c.remove(); }
            c.parentNode = el;
            const i = ref ? el.childNodes.indexOf(ref) : -1;
            if (i < 0) { el.childNodes.push(c); } else { el.childNodes.splice(i, 0, c); }
            return c;
        },
        replaceChild(c, old) { this.insertBefore(c, old); old.remove(); return old; },
        remove() {
            if (!el.parentNode) { return; }
            const list = el.parentNode.childNodes;
            const i = list.indexOf(el);
            if (i >= 0) { list.splice(i, 1); }
            el.parentNode = null;
        },
        getElementsByTagName(t) {
            const out = [];
            const walk = n => { for (const c of n.children) { if (t === '*' || c.nodeName === t) { out.push(c); } walk(c); } };
            walk(el);
            return out;
        }
    };
    return el;
}

function decodeEntities(s) {
    return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (w, t) => {
        switch (t) {
            case 'amp': return '&'; case 'lt': return '<'; case 'gt': return '>';
            case 'quot': return '"'; case 'apos': return "'";
            default: return String.fromCodePoint(parseInt(t[1] === 'x' ? t.slice(2) : t.slice(1), t[1] === 'x' ? 16 : 10));
        }
    });
}

function parseXmlDocument(text) {
    const doc = {
        nodeType: 9,
        _root: null,
        get documentElement() { return this._root; },
        get childNodes() { return this._root ? [this._root] : []; },
        replaceChild(c, old) { old.parentNode = null; this._root = c; c.parentNode = this; return old; },
        createElement(name) { return makeXmlElement(name, null); },
        createElementNS(ns, name) { const el = makeXmlElement(name, ns); el._doc = doc; return el; },
        getElementsByTagName(t) {
            if (!this._root) { return []; }
            const out = (t === '*' || this._root.nodeName === t) ? [this._root] : [];
            return out.concat(this._root.getElementsByTagName(t));
        }
    };
    const fail = () => { doc._root = makeXmlElement('parsererror', null); return doc; };

    const tagRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/\s*([^>\s]+)\s*>|<([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
    const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const stack = [];
    let root = null;
    let m;
    let consumed = 0;
    while ((m = tagRe.exec(text)) !== null) {
        if (m.index !== consumed) { return fail(); } // gap → malformed markup
        consumed = tagRe.lastIndex;
        const [whole, cdata, closeName, openName, attrText, selfClose, textRun] = m;
        if (whole.startsWith('<!--') || whole.startsWith('<?')) { continue; }
        if (cdata !== undefined) {
            if (stack.length) { stack[stack.length - 1].childNodes.push({ nodeType: 3, data: cdata }); }
            continue;
        }
        if (textRun !== undefined) {
            if (textRun.includes('<')) { return fail(); }
            if (stack.length && textRun.trim()) {
                stack[stack.length - 1].childNodes.push({ nodeType: 3, data: decodeEntities(textRun) });
            }
            continue;
        }
        if (closeName) {
            const top = stack.pop();
            if (!top || top.nodeName !== closeName) { return fail(); }
            continue;
        }
        if (openName) {
            if (root && !stack.length) { return fail(); } // second root
            const ns = openName.includes(':') ? null : 'http://schemas.microsoft.com/winfx/2006/xaml/presentation';
            const el = makeXmlElement(openName, ns);
            let a;
            while ((a = attrRe.exec(attrText)) !== null) {
                el.attrs.set(a[1], decodeEntities(a[2] ?? a[3] ?? ''));
            }
            if (stack.length) { stack[stack.length - 1].appendChild(el); } else { root = el; }
            if (!selfClose) { stack.push(el); }
        }
    }
    if (consumed !== text.length || stack.length || !root) { return fail(); }
    doc._root = root;
    root.parentNode = doc;
    return doc;
}

// Serialize a mini-DOM subtree back to XML (enough for commit()/formatting).
function serializeXmlNode(node) {
    const escText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escAttr = s => escText(s).replace(/"/g, '&quot;');
    if (node.nodeType === 3) { return escText(node.data); }
    if (node.nodeType === 8) { return `<!--${node.data}-->`; }
    if (node.nodeType !== 1) { return ''; }
    const attrs = [...node.attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
    const kids = (node.childNodes ?? []).map(serializeXmlNode).join('');
    return kids
        ? `<${node.nodeName}${attrs}>${kids}</${node.nodeName}>`
        : `<${node.nodeName}${attrs}/>`;
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
        Node: {
            ELEMENT_NODE: 1, TEXT_NODE: 3, CDATA_SECTION_NODE: 4,
            PROCESSING_INSTRUCTION_NODE: 7, COMMENT_NODE: 8, DOCUMENT_TYPE_NODE: 10
        },
        DOMParser: class {
            parseFromString(text) { return parseXmlDocument(text); }
        },
        XMLSerializer: class {
            serializeToString(node) { return serializeXmlNode(node); }
        },
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
