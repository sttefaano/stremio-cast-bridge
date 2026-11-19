const VOID = new Set(['meta', 'input', 'br', 'hr', 'img', 'link', 'source']);

class Node {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    const props = new Map(), direct = new Set(['width', 'left']);
    this.styleProps = props;
    this.style = new Proxy({setProperty: (k, v) => props.set(k, String(v))}, {
      set(target, k, v) {
        if (!direct.has(k)) throw new Error(`style.${String(k)} is an expando; use setProperty`);
        target[k] = v;
        return true;
      },
    });
    this.open = false;
    this.value = attrs.value ?? '';
    this.checked = false;
    this.files = [];
    this.text = '';
    this.document = null;
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
  getElementById(id) { return this.document.byId.get(id) ?? null; }
  createElement(tag) { const n = new Node(tag); n.document = this.document; return n; }
  dispatchEvent(event) {
    event.target ??= this;
    event.preventDefault = () => { event.defaultPrevented = true; };
    const path = [];
    for (let n = event.target; n; n = n.parentNode) path.push(n);
    for (const n of event.bubbles === false ? [event.target] : path) for (const fn of n.listeners[event.type] ?? []) fn(event);
    return !event.defaultPrevented;
  }
  getBoundingClientRect() { return {left: 0, top: 0, right: 100, bottom: 100}; }
  showModal() { if (this.open) throw new Error('InvalidStateError: already open'); this.open = true; this.document.modals.push(this); }
  close() { this.open = false; const i = this.document.modals.indexOf(this); if (i >= 0) this.document.modals.splice(i, 1); }
}

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
  doc.body = all.find(n => n.tagName === 'BODY');
  doc.byId = new Map();
  for (const n of all) if (n.id && !doc.byId.has(n.id)) doc.byId.set(n.id, n);
  return doc;
}

module.exports = {Node, parse};
