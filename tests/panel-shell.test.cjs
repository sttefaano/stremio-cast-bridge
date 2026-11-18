const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const HTML = fs.readFileSync('player.html', 'utf8');
const load = () => {
  const context = {module: {exports: {}}, TextDecoder, AbortController};
  vm.runInNewContext(fs.readFileSync('player.js', 'utf8'), context);
  return context.module.exports;
};

// ───────── a small DOM parsed from the real player.html: just enough surface for the shell
const VOID = new Set(['meta', 'input', 'br', 'hr', 'img', 'link', 'source']);
const kebab = k => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const camel = k => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class Node {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this.style = {setProperty(k, v) { this[k] = v; }};
    this.open = false;
    this.value = attrs.value ?? '';
    this.checked = false;
    this.files = [];
    this.text = '';
    this.document = null;
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => self.attrs.get('data-' + kebab(String(k))),
      set: (_, k, v) => { self.attrs.set('data-' + kebab(String(k)), String(v)); return true; },
      has: (_, k) => self.attrs.has('data-' + kebab(String(k))),
      ownKeys: () => [...self.attrs.keys()].filter(k => k.startsWith('data-')).map(camel_data),
      getOwnPropertyDescriptor: () => ({enumerable: true, configurable: true}),
    });
  }
  get id() { return this.attrs.get('id') ?? ''; }
  get hidden() { return this.attrs.has('hidden'); }
  set hidden(v) { v ? this.attrs.set('hidden', '') : this.attrs.delete('hidden'); }
  get disabled() { return this.attrs.has('disabled'); }
  set disabled(v) { v ? this.attrs.set('disabled', '') : this.attrs.delete('disabled'); }
  get className() { return this.attrs.get('class') ?? ''; }
  set className(v) { this.attrs.set('class', v); }
  get children() { return this.childNodes.filter(c => c instanceof Node); }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { const s = this.parentNode?.children ?? []; return s[s.indexOf(this) + 1] ?? null; }
  get textContent() { return this.childNodes.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach(c => { if (c instanceof Node) c.parentNode = null; }); this.childNodes = v === '' ? [] : [String(v)]; }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    n.parentNode?.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, n);
    n.parentNode = this;
    return n;
  }
  remove() { this.parentNode?.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
  contains(n) { for (let c = n; c; c = c.parentNode) if (c === this) return true; return false; }
  cloneNode() {
    const n = new Node(this.tagName.toLowerCase(), Object.fromEntries(this.attrs));
    n.document = this.document;
    for (const c of this.childNodes) n.appendChild(typeof c === 'string' ? c : c.cloneNode());
    if (this.content) n.content = this.content.cloneNode();
    return n;
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const m = part.trim().match(/^([a-z]+)?(?:#([\w-]+))?((?:\[[^\]]+\])*)$/i);
      if (!m) throw new Error('fake DOM does not support selector ' + part);
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
      if (m[2] && this.id !== m[2]) return false;
      return [...(m[3] || '').matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]/g)].every(([, k, q, u]) => {
        const want = q ?? u;
        return want === undefined ? this.attrs.has(k) : this.attrs.get(k) === want;
      });
    });
  }
  closest(selector) { for (let n = this; n instanceof Node; n = n.parentNode) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) {
    const out = [];
    const walk = n => { for (const c of n.children) { if (c.matches(selector)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() { if (!this.disabled) this.document.activeElement = this; }
  getBoundingClientRect() { return {left: 0, top: 0, right: 100, bottom: 100}; }
  showModal() { if (this.open) throw new Error('InvalidStateError: already open'); this.open = true; this.document.modals.push(this); }
  close() { this.open = false; const i = this.document.modals.indexOf(this); if (i >= 0) this.document.modals.splice(i, 1); }
}
const camel_data = k => camel(k.slice(5));

function parse(html) {
  const doc = new Node('#document');
  doc.document = doc;
  doc.modals = [];
  doc.activeElement = null;
  doc.visibilityState = 'visible';
  const stack = [doc];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, close, name, rest, selfClose, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) { if (text.trim()) top.childNodes.push(text); continue; }
    if (!name) continue;
    const tag = name.toLowerCase();
    if (close) {
      if (tag === 'template') { const t = stack.pop(); t.content = new Node('#fragment'); t.content.document = doc; for (const c of [...t.childNodes]) t.content.appendChild(c); t.childNodes = []; }
      else stack.pop();
      continue;
    }
    const attrs = {};
    for (const x of rest.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[x[1]] = x[2] ?? x[3] ?? x[4] ?? '';
    const node = new Node(tag, attrs);
    node.document = doc;
    top.appendChild(node);
    if (tag === 'script' || tag === 'style') { re.lastIndex = html.indexOf('>', html.indexOf('</' + tag, re.lastIndex)) + 1; continue; }
    if (!VOID.has(tag) && !selfClose) stack.push(node);
  }
  const all = [];
  (function walk(n) { for (const c of n.children) { all.push(c); walk(c); if (c.content) walk(c.content); } })(doc);
  doc.all = all;
  doc.byId = new Map();
  for (const n of all) if (n.id && !doc.byId.has(n.id)) doc.byId.set(n.id, n);
  return doc;
}

// ───────── markup integrity: reads player.html only
test('ids are unique and none lives inside a template', () => {
  const doc = parse(HTML);
  const ids = doc.all.filter(n => n.id).map(n => n.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids: ' + ids.filter((id, i) => ids.indexOf(id) !== i));
  for (const t of doc.all.filter(n => n.tagName === 'TEMPLATE')) {
    assert.deepEqual(t.content.querySelectorAll('[id]').map(n => n.id), [], 'template content must not carry ids');
  }
});

test('every reference in the markup resolves', () => {
  const doc = parse(HTML), ids = new Set(doc.all.map(n => n.id).filter(Boolean));
  for (const n of doc.all) {
    for (const k of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const id of (n.getAttribute(k) ?? '').split(/\s+/).filter(Boolean)) assert.ok(ids.has(id), `${n.tagName}#${n.id} ${k}="${id}" has no target`);
    }
    const href = n.getAttribute('href');
    if (href?.startsWith('#')) assert.ok(ids.has(href.slice(1)), `href="${href}" has no target`);
  }
});

test('every data-act, data-change, data-input and data-submit names a message the core handles', () => {
  const {Panel} = load(), doc = parse(HTML), acts = Object.keys(Panel.ACTS);
  const seen = [];
  for (const n of [...doc.all, ...doc.all.filter(x => x.content).flatMap(x => x.content.querySelectorAll('[data-act]'))]) {
    for (const k of ['data-act', 'data-change', 'data-input', 'data-submit']) {
      const v = n.getAttribute(k);
      if (v !== null) { seen.push(v); assert.ok(acts.includes(v), `${k}="${v}" is not a key of Panel.ACTS`); }
    }
  }
  assert.ok(seen.length > 30);
});

test('the token placeholder appears once, as the global the server fills in', () => {
  assert.equal(HTML.split('__TOKEN__').length - 1, 1);
  assert.ok(HTML.includes("const token='__TOKEN__';"));
  assert.equal(HTML.split('__SCRIPT__').length - 1, 1);
  assert.ok(!fs.readFileSync('player.js', 'utf8').includes('__TOKEN__'));
  assert.ok(!fs.readFileSync('player.js', 'utf8').includes('__SCRIPT__'));
});

test('the page loads nothing from outside and keeps native dialogs outside the pages', () => {
  assert.ok(!/<(img|video|canvas|iframe|link|object|embed)\b/i.test(HTML));
  assert.ok(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(HTML.replace(/xmlns="[^"]*"/g, '')));
  const doc = parse(HTML), inside = id => !!doc.byId.get(id).closest('dialog');
  assert.deepEqual(doc.all.filter(n => n.tagName === 'DIALOG').map(n => n.id), ['sheet', 'confirm']);
  for (const id of ['sheet-subs', 'sheet-more', 'sheet-change']) assert.ok(inside(id), id);
  for (const id of ['prep', 'mando', 'problem', 'track']) assert.ok(!inside(id), id);
  assert.ok(!doc.byId.has('seek-apply'));
});
