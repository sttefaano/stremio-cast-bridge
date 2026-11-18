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
  doc.body = all.find(n => n.tagName === 'BODY');
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

// ───────── shell against the real markup: fake fetch, timers, storage and wake lock
const flush = () => new Promise(resolve => setImmediate(resolve));
const catalogue = (id, addon = {state: 'off', revision: 0, match: null, message: null, count: 0}) => ({
  id: 'cat-' + id, source_id: id, duration: 500, addon,
  entries: [{id: 'text-' + id, kind: 'embedded', label: 'Español', language: 'spa', supported: true, reason: null}]});
const base = {
  source_discovery: 'ready', device_discovery: 'ready', device_revision: 1, can_change_device: true,
  sources: [{id: 'a', title: 'Alpha', filename: 'alpha.mkv'}, {id: 'b', title: 'Beta', filename: 'beta.mkv'}],
  devices: [{id: 'tv-a', name: 'Sala', host: '192.0.2.2', model: 'Chromecast'}, {id: 'tv-b', name: 'Sala', host: '192.0.2.3', model: 'Google TV'}],
  selected_device: {id: 'tv-a', name: 'Sala', host: '192.0.2.2', model: 'Chromecast', available: true},
  catalogues: {a: {state: 'ready', catalogue: catalogue('a')}, b: {state: 'ready', catalogue: catalogue('b')}},
};
const idle = {...base, phase: 'idle'};
const playing = {...base, phase: 'playing', can_change_device: false, source_id: 'a', title: 'Alpha', playback_id: 'p1', duration: 500, absolute_time: 50,
  volume: .3, muted: false, active_catalogue: catalogue('a'), subtitle_choice: {catalogue_id: 'cat-a', subtitle_id: 'text-a', enabled: true, delay_ms: 0, label: 'Español'}};

function shell(initial, {lastDevice = null, wakeLock = null} = {}) {
  const {boot, Panel} = load(), doc = parse(HTML), requests = [], timers = [], store = new Map(lastDevice ? [['cast.lastDevice', lastDevice]] : []);
  const env = {
    fetch: (path, options) => new Promise((resolve, reject) => requests.push({
      path, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body ? JSON.parse(options.body) : undefined, done: false,
      answer: (status, body) => resolve({ok: status < 400, json: async () => body}), fail: reject})),
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, clearTimeout() {},
    storage: {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)}, token: 'test', now: () => 0, wakeLock,
  };
  const api = boot(doc, env);
  const s = {
    doc, api, requests, timers, store, Panel,
    $: id => doc.getElementById(id),
    pending: path => requests.filter(r => !r.done && r.path === '/api/' + path),
    async answer(path, status, body) {
      const r = requests.find(x => !x.done && x.path === path);
      assert.ok(r, `no pending request for ${path}`);
      r.done = true; r.answer(status, body); await flush();
      return r;
    },
    status: (raw, ok = true) => s.answer('/api/status', ok ? 200 : 503, raw),
    // one full poll cycle: the poll timer fires (unless a poll is already out), then the answer arrives
    async poll(raw, ok = true) {
      if (!requests.some(r => !r.done && r.path === '/api/status')) { const [t] = timers.splice(timers.findLastIndex(x => x.ms === 1500), 1); t.fn(); }
      await s.status(raw, ok);
    },
    click(id, extra = {}) { const n = s.$(id); if (!n.disabled) { doc.dispatchEvent({type: 'pointerdown', target: n}); n.focus(); doc.dispatchEvent({type: 'click', target: n, ...extra}); } },
    key(key, target = doc.activeElement ?? doc.body, extra = {}) { const e = {type: 'keydown', target, key, ...extra}; doc.dispatchEvent(e); return e; },
  };
  if (initial) return s.status(initial).then(() => s);
  return s;
}
const visible = n => !n.closest('[hidden]');

test('boot polls, paints Preparar from the first status and names two Sala TVs by model', async () => {
  const s = await shell(null);
  assert.equal(s.requests[0].path, '/api/status');
  await s.status(idle);
  assert.equal(visible(s.$('prep')), true);
  assert.equal(visible(s.$('mando')), false);
  const rows = s.$('device-list').children.filter(n => n.tagName === 'BUTTON');
  assert.deepEqual(rows.map(r => r.querySelector('[data-f="label"]').textContent), ['Sala · Chromecast', 'Sala · Google TV']);
  assert.deepEqual(rows.map(r => r.getAttribute('aria-pressed')), ['true', 'false']);
  assert.equal(s.$('start-label').textContent, 'Iniciar en Sala (Chromecast)');
  assert.equal(s.$('device-host').textContent, '192.0.2.2', 'the address lives only in the details disclosure');
  assert.ok(!rows.some(r => r.textContent.includes('192.0.2')));
});

test('a click posts with the bridge token and the device identity', async () => {
  const s = await shell(playing);
  assert.equal(visible(s.$('mando')), true);
  s.click('toggle');
  const [post] = s.pending('pause');
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['X-Bridge-Token'], 'test');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.deepEqual(post.body, {device_id: 'tv-a', device_revision: 1});
  assert.equal(s.$('toggle').disabled, true, 'busy while the command is in flight');
});

test('stop sends device fields only when a TV is selected', async () => {
  const bare = {...base, selected_device: undefined, phase: 'preparing', pending: true, can_change_device: false};
  const s = await shell(bare);
  s.click('stop');
  assert.deepEqual(s.pending('stop')[0].body, {});
  const t = await shell({...bare, selected_device: base.selected_device});
  t.click('stop');
  assert.deepEqual(t.pending('stop')[0].body, {device_id: 'tv-a', device_revision: 1});
});

test('every canned view paints: a missing id would throw', async () => {
  const s = await shell(idle);
  const views = [];
  for (const status of [
    {...idle, source_discovery: 'error', source_error: 'x', device_discovery: 'error', device_error: 'y'},
    {...idle, selected_device: undefined, devices: []},
    {...playing, phase: 'preparing', pending: true, message: 'Preparando'},
    {...playing, phase: 'receiver_changed', pending: true},
    {...playing, phase: 'paused', buffered_start: 10, buffered_end: 90},
    {...playing, phase: 'error', can_change_device: false, message: 'Falló'},
    {...playing, action_error: 'No se pudo', action_error_revision: 3},
    {...playing, demo: true, scenario: 'ready'},
    {...idle, phase: 'stopped', source_id: 'a'},
    {...playing, phase: 'wat'},
  ]) { await s.poll(status); views.push(s.api.view()); }
  assert.equal(views.length, 10);
  assert.equal(views[2].mando.waiting.text, 'Esperando a Sala · Chromecast');
  await s.poll({...playing, phase: 'preparing', pending: true});
  assert.equal(visible(s.$('waiting')), true);
  assert.equal(visible(s.$('toggle-spinner')), true);
  for (const [open, panel] of [['open-subs', 'sheet-subs'], ['open-more', 'sheet-more'], ['open-change', 'sheet-change']]) {
    await s.poll(playing);
    s.click(open);
    assert.equal(s.$('sheet').open, true, open);
    assert.equal(visible(s.$(panel)), true, panel);
    s.click('sheet-close');
    assert.equal(s.$('sheet').open, false);
  }
});

test('the volume fill is a custom property on the range, so the stylesheet can read it', async () => {
  const s = await shell(playing);
  assert.equal(s.$('volume').styleProps.get('--p'), '30%');
  await s.poll({...playing, volume: .75});
  assert.equal(s.$('volume').styleProps.get('--p'), '75%');
});

test('the board glyph is painted from the view, so rewording the state text cannot break it', async () => {
  const s = await shell(playing);
  assert.equal(s.$('board-state').getAttribute('data-glyph'), 'play');
  await s.poll({...playing, phase: 'paused'});
  assert.equal(s.$('board-state').getAttribute('data-glyph'), 'pause');
  await s.poll({...playing, phase: 'loading', pending: true});
  assert.equal(s.$('board-state').getAttribute('data-glyph'), 'spinner');
  assert.ok(HTML.includes('[data-glyph=spinner]'), 'the stylesheet names the glyph the view sends');
  await s.poll({...playing, phase: 'receiver_changed', pending: true});
  assert.equal(s.$('board-state').getAttribute('data-glyph'), '');
});

test('the plan, the problem block and the Stremio block move to where the view puts them', async () => {
  const s = await shell({...playing, catalogues: {...base.catalogues, a: {state: 'ready', catalogue: catalogue('a', {state: 'ready', revision: 1, match: {label: 'Alpha', confidence: 'sure'}, message: null, count: 1})}},
    active_catalogue: catalogue('a', {state: 'ready', revision: 1, match: {label: 'Alpha', confidence: 'sure'}, message: null, count: 1}), action_error: 'Falló algo', action_error_revision: 1});
  assert.equal(s.$('problem').parentNode.id, 'mando-problem-slot');
  assert.equal(s.$('plan').parentNode.id, 'prep-plan-slot');
  s.click('open-change');
  assert.equal(s.$('plan').parentNode.id, 'sheet-change-slot');
  assert.equal(s.$('problem').parentNode.id, 'sheet-problem-slot', 'one problem block, hosted by the open sheet');
  s.click('sheet-close');
  s.click('open-subs');
  assert.equal(s.$('stremio').parentNode.id, 'sheet-subs-stremio-slot');
  s.click('sheet-close');
  assert.equal(s.$('plan').parentNode.id, 'prep-plan-slot');
  assert.equal(s.$('problem').parentNode.id, 'mando-problem-slot');
});

test('dialogs follow the view; Escape and the backdrop dismiss; a confirm stacks over the sheet', async () => {
  const s = await shell(playing);
  s.click('open-change');
  assert.deepEqual(s.doc.modals.map(d => d.id), ['sheet']);
  const escape = {type: 'cancel', target: s.$('sheet'), bubbles: false};
  s.$('sheet').dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true, 'cancel is prevented; the model closes the sheet');
  assert.equal(s.$('sheet').open, false);
  s.click('open-more');
  s.doc.dispatchEvent({type: 'click', target: s.$('sheet'), clientX: 500, clientY: 50});
  assert.equal(s.$('sheet').open, false, 'a click outside the box is the backdrop');
  s.click('open-more');
  s.doc.dispatchEvent({type: 'click', target: s.$('sheet'), clientX: 50, clientY: 50});
  assert.equal(s.$('sheet').open, true, 'a click inside the dialog box is not');
  s.click('more-stop');
  assert.deepEqual(s.doc.modals.map(d => d.id), ['sheet', 'confirm']);
  assert.equal(s.$('confirm-title').textContent, '¿Detener la película en la TV?');
  s.$('confirm').dispatchEvent({type: 'cancel', target: s.$('confirm'), bubbles: false});
  assert.deepEqual(s.doc.modals.map(d => d.id), ['sheet'], 'Escape closes the top layer only');
  assert.equal(s.pending('stop').length, 0);
});

test('closing a sheet whose opener is gone puts focus on the page', async () => {
  const s = await shell(playing);
  s.click('open-more');
  s.doc.activeElement = null;
  s.doc.activeElement = null;
  s.$('sheet').dispatchEvent({type: 'cancel', target: s.$('sheet'), bubbles: false});
  assert.equal(s.doc.activeElement?.id, 'mando');
});

test('a subtitle file is read with arrayBuffer, never file.text', async () => {
  const s = await shell(idle);
  const row = s.$('source-list').children.find(n => n.tagName === 'BUTTON');
  s.doc.dispatchEvent({type: 'click', target: row});
  await s.answer('/api/catalogue', 200, {catalogue: catalogue('a')});
  s.click('branch-upload');
  const input = s.$('upload-input');
  let textCalled = false;
  input.files = [{name: 'sub.srt', size: 12, text() { textCalled = true; throw new Error('file.text must not be used'); }, arrayBuffer: async () => new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nHola\n').buffer}];
  s.doc.dispatchEvent({type: 'change', target: input});
  await flush();
  const upload = s.pending('subtitle_upload')[0];
  assert.ok(upload, 'the decoded bytes are posted');
  assert.equal(textCalled, false);
  assert.match(upload.body.text, /Hola/);
  assert.equal(upload.body.format, 'srt');
  assert.equal(input.value, '', 'the input is cleared so the same file can be picked again');
});

test('focus returns to the control once its command settles, only if the user has not touched anything since', async () => {
  const s = await shell(playing);
  s.click('toggle');
  s.doc.activeElement = null;
  await s.answer('/api/pause', 202, {accepted: true});
  await s.status({...playing, phase: 'paused'});
  assert.equal(s.doc.activeElement?.id, 'toggle', 'restored');

  const t = await shell(playing);
  t.click('toggle');
  t.doc.activeElement = null;
  await t.answer('/api/pause', 202, {accepted: true});
  t.doc.dispatchEvent({type: 'pointerdown', target: t.$('board-title')});
  await t.status({...playing, phase: 'paused'});
  assert.equal(t.doc.activeElement, null, 'a later interaction cancels the restore');
});

test('while a restore is pending an arrow key is swallowed and is not a seek', async () => {
  const s = await shell(playing);
  s.click('toggle');
  s.doc.activeElement = null;
  const e = s.key('ArrowRight', s.doc.body);
  assert.equal(e.defaultPrevented, true);
  assert.equal(s.pending('seek').length + s.pending('pause').length, 1, 'only the toggle command exists');
  await s.answer('/api/pause', 202, {accepted: true});
  await s.status({...playing, phase: 'paused'});
  const later = s.key('ArrowRight', s.doc.body);
  assert.equal(later.defaultPrevented, true, 'once restored the key is a normal skip');
});

test('Space on the page toggles; keys do nothing while typing', async () => {
  const s = await shell(playing);
  s.doc.activeElement = null;
  s.key(' ', s.doc.body);
  assert.equal(s.pending('pause').length, 1);
  const t = await shell(playing);
  t.click('open-more');
  t.key(' ', t.$('exact'));
  assert.equal(t.pending('pause').length, 0);
});

test('timeline: dragging previews only, release sends one seek, pointercancel and Escape send nothing', async () => {
  const s = await shell(playing);
  const track = s.$('track');
  track.value = '200';
  s.doc.dispatchEvent({type: 'input', target: track});
  assert.equal(s.api.view().mando.track.preview, '→ 3:20');
  assert.equal(visible(s.$('track-preview')), true);
  assert.equal(track.value, '200', 'repaint never moves the thumb under the finger');
  assert.equal(s.$('elapsed').textContent, '0:50', 'elapsed stays the real position');
  track.dispatchEvent({type: 'pointercancel', target: track});
  assert.equal(s.api.view().mando.track.preview, null);
  assert.equal(track.value, '50');
  assert.equal(s.pending('seek').length, 0);
  track.value = '120';
  s.doc.dispatchEvent({type: 'input', target: track});
  s.key('Escape', track);
  assert.equal(s.api.view().mando.track.preview, null);
  track.dispatchEvent({type: 'pointerdown', target: track});
  track.value = '300';
  s.doc.dispatchEvent({type: 'input', target: track});
  s.doc.dispatchEvent({type: 'change', target: track});
  assert.deepEqual(s.pending('seek').map(r => r.body), [{position: 300, device_id: 'tv-a', device_revision: 1}]);
  assert.equal(s.key('ArrowLeft', track).defaultPrevented, true, 'arrow keys on the range are skips, never a native step');
});

test('after Escape, moving and releasing the same drag sends nothing; the next press is a new gesture', async () => {
  const s = await shell(playing);
  const track = s.$('track');
  track.dispatchEvent({type: 'pointerdown', target: track});
  track.value = '120';
  s.doc.dispatchEvent({type: 'input', target: track});
  s.key('Escape', track);
  track.value = '300';
  s.doc.dispatchEvent({type: 'input', target: track});
  assert.equal(s.api.view().mando.track.preview, null, 'moving after Escape previews nothing');
  s.doc.dispatchEvent({type: 'pointerup', target: track});
  s.doc.dispatchEvent({type: 'change', target: track});
  assert.equal(s.pending('seek').length, 0, 'the release that follows Escape sends nothing');
  const lift = s.timers.findLast(t => t.ms === 0);
  lift.fn();
  assert.equal(track.value, '50', 'the thumb returns to the real position once the drag ends');
  track.dispatchEvent({type: 'pointerdown', target: track});
  track.value = '200';
  s.doc.dispatchEvent({type: 'input', target: track});
  s.doc.dispatchEvent({type: 'pointerup', target: track});
  s.doc.dispatchEvent({type: 'change', target: track});
  assert.deepEqual(s.pending('seek').map(r => r.body), [{position: 200, device_id: 'tv-a', device_revision: 1}]);
});

test('the remembered TV is read at boot and written when the server confirms one', async () => {
  const s = await shell({...idle, selected_device: undefined}, {lastDevice: 'tv-b'});
  assert.equal(s.pending('select_device')[0].body.device_id, 'tv-b');
  const t = await shell(idle);
  assert.equal(t.store.get('cast.lastDevice'), 'tv-a');
});

test('a scenario selector exists only for the demo and posts the state', async () => {
  const s = await shell(idle);
  assert.equal(visible(s.$('demo-banner')), false);
  const d = await shell({...idle, demo: true, scenario: 'ready'});
  assert.equal(visible(d.$('demo-banner')), true);
  d.$('scenario').value = 'loading';
  d.doc.dispatchEvent({type: 'change', target: d.$('scenario')});
  assert.deepEqual(d.pending('scenario')[0].body, {state: 'loading'});
});

test('offline keeps the board and shows one alert; a failed reply is a notice, not an invented state', async () => {
  const s = await shell(playing);
  await s.poll(null, false);
  assert.equal(s.$('problem-title').textContent, 'Sin conexión con el puente');
  assert.equal(s.$('problem').getAttribute('role'), 'alert');
  assert.equal(s.$('toggle').disabled, true);
  assert.equal(s.$('board-title').textContent, 'Alpha');
});

test('the Wake Lock follows Mando', async () => {
  const calls = [];
  const wakeLock = {request: async type => { calls.push(['request', type]); return {release: async () => { calls.push(['release']); }, addEventListener() {}}; }};
  const s = await shell(idle, {wakeLock});
  assert.deepEqual(calls, []);
  await s.poll(playing);
  await flush();
  assert.deepEqual(calls, [['request', 'screen']]);
  await s.poll({...playing, phase: 'stopped', can_change_device: true, playback_id: undefined});
  await flush();
  assert.deepEqual(calls, [['request', 'screen'], ['release']]);
});

test('a list keeps its row nodes across polls so focus and scroll survive', async () => {
  const s = await shell(idle);
  const before = s.$('source-list').children.filter(n => n.tagName === 'BUTTON');
  await s.poll({...idle, sources: [...idle.sources].reverse()});
  const after = s.$('source-list').children.filter(n => n.tagName === 'BUTTON');
  assert.deepEqual(after.map(n => n.getAttribute('data-key')), ['b', 'a']);
  assert.ok(after.every(n => before.includes(n)));
  await s.poll({...idle, sources: [idle.sources[0]]});
  assert.equal(s.$('source-list').children.filter(n => n.tagName === 'BUTTON').length, 1);
});
