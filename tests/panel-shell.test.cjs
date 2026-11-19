const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {PANEL_SOURCE, loadPanel} = require('./helpers/panel-source.cjs');
const {parse} = require('./helpers/fake-dom.cjs');
const H = require('./helpers/panel-harness.cjs');

const HTML = fs.readFileSync('player.html', 'utf8');
const load = () => loadPanel({TextDecoder, AbortController});

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

test('the page and ACTS agree: every message the page can send has a handler, and every handler can be sent', () => {
  const {Panel} = load(), doc = parse(HTML), sent = new Set();
  for (const n of [...doc.all, ...doc.all.filter(x => x.content).flatMap(x => x.content.querySelectorAll('[data-act]'))]) {
    for (const k of ['data-act', 'data-change', 'data-input', 'data-submit']) if (n.hasAttribute(k)) sent.add(n.getAttribute(k));
  }
  const source = name => fs.readFileSync(name, 'utf8');
  for (const [, t] of source('panel-shell.js').matchAll(/dispatch\(\{t: '(\w+)'/g)) sent.add(t);
  for (const [, t] of source('panel.js').slice(source('panel.js').indexOf('function keyMsg')).matchAll(/\{t: '(\w+)'/g)) sent.add(t);
  for (const [, act] of source('panel-core.js').matchAll(/\{act: '(\w+)'/g)) sent.add(act);
  for (const step of ['status', 'reply', 'timer', 'file']) sent.delete(step);
  assert.deepEqual([...sent].sort(), Object.keys(Panel.ACTS).sort());
});

test('the token placeholder appears once, as the global the server fills in', () => {
  assert.equal(HTML.split('__TOKEN__').length - 1, 1);
  assert.ok(HTML.includes("const token='__TOKEN__';"));
  assert.equal(HTML.split('__SCRIPT__').length - 1, 1);
  assert.ok(!PANEL_SOURCE.includes('__TOKEN__'));
  assert.ok(!PANEL_SOURCE.includes('__SCRIPT__'));
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
const {catalogue, destination} = H;
const idle = H.fixture(H.idle), playing = H.fixture(H.playing);

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
  const bare = {...idle, selected_device: undefined, phase: 'preparing', pending: true, can_change_device: false};
  const s = await shell(bare);
  s.click('stop');
  assert.deepEqual(s.pending('stop')[0].body, {});
  const t = await shell({...bare, selected_device: destination.selected_device});
  t.click('stop');
  assert.deepEqual(t.pending('stop')[0].body, {device_id: 'tv-a', device_revision: 1});
  assert.deepEqual([t.$('stop').textContent, t.$('stop').disabled, t.$('waiting-cancel').textContent], ['Deteniendo…', true, 'Deteniendo…'], 'the stop in flight is on screen');
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

test('the error scenario shows Detener once: the header hides while the problem block offers it', async () => {
  const s = await shell({...playing, phase: 'error', can_change_device: false, message: 'Falló'});
  const stops = () => ['stop', 'problem-action', 'more-stop'].filter(id => visible(s.$(id)) && s.$(id).getAttribute('data-act') === 'stop');
  assert.deepEqual(stops(), ['problem-action']);
  await s.poll(playing);
  assert.deepEqual(stops(), ['stop']);
});

test('the plan, the problem block and the Stremio block move to where the view puts them', async () => {
  const s = await shell({...playing, catalogues: {...playing.catalogues, a: {state: 'ready', catalogue: catalogue('a', {state: 'ready', revision: 1, match: {label: 'Alpha', confidence: 'sure'}, message: null, count: 1})}},
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

const chooseAlpha = async (s, cat = catalogue('a')) => {
  s.doc.dispatchEvent({type: 'click', target: s.$('source-list').children.find(n => n.tagName === 'BUTTON')});
  await s.answer('/api/catalogue', 200, {catalogue: cat});
};
// Like a browser: clearing a file input's value also empties its file list.
function pickFile(input, file) {
  let value = '';
  Object.defineProperty(input, 'value', {configurable: true, get: () => value, set: v => { value = v; if (v === '') input.files = []; }});
  input.files = [file];
  value = 'C:\\fakepath\\' + file.name;
  input.document.dispatchEvent({type: 'change', target: input});
}

test('a subtitle file is read with arrayBuffer, never file.text', async () => {
  const s = await shell(idle);
  await chooseAlpha(s);
  s.click('branch-upload');
  const input = s.$('upload-input');
  let textCalled = false;
  pickFile(input, {name: 'sub.srt', size: 12, text() { textCalled = true; throw new Error('file.text must not be used'); }, arrayBuffer: async () => new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nHola\n').buffer});
  await flush();
  const upload = s.pending('subtitle_upload')[0];
  assert.ok(upload, 'the decoded bytes are posted');
  assert.equal(textCalled, false);
  assert.match(upload.body.text, /Hola/);
  assert.equal(upload.body.format, 'srt');
  assert.equal(input.value, '', 'the input is cleared so the same file can be picked again');
});

test('a refused pick clears the file input too, so picking the same file again is a new change', async () => {
  const s = await shell(idle);
  await chooseAlpha(s);
  s.click('branch-upload');
  const input = s.$('upload-input');
  pickFile(input, {name: 'sub.txt', size: 3});
  assert.equal(s.$('subs-status').textContent, 'Elegí un archivo .srt o .vtt en UTF-8.');
  assert.equal(input.value, '');
});

test('a successful Stremio search clears the title the user typed', async () => {
  const addon = {state: 'ready', revision: 1, match: {label: 'Alpha (2020)', confidence: 'high'}, message: null, count: 1};
  const s = await shell({...idle, catalogues: {a: {state: 'ready', catalogue: catalogue('a', addon)}}});
  await chooseAlpha(s, catalogue('a', addon));
  s.click('branch-stremio');
  await s.answer('/api/subtitle_offers', 200, {revision: 1, offers: [{id: 'o1', language: 'spa', language_name: 'Español', label: 'Alpha.es.srt'}], alternatives: []});
  s.click('stremio-wrong');
  s.$('stremio-hint').value = 'Alpha 2020';
  s.doc.dispatchEvent({type: 'submit', target: s.$('stremio-form')});
  await s.answer('/api/subtitle_lookup', 200, {catalogue: catalogue('a', {...addon, revision: 2})});
  assert.equal(s.$('stremio-hint').value, '');
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
