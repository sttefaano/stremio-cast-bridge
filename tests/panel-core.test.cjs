const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const load = () => {
  const context = {module: {exports: {}}, TextDecoder};
  vm.runInNewContext(fs.readFileSync('player.js', 'utf8'), context);
  return context.module.exports;
};

// The core runs in its own realm: cloning keeps deepEqual honest about plain data.
const plain = x => JSON.parse(JSON.stringify(x));

// A race is the order of two lines: the harness only records effects and answers them when told to.
function panel(initial, boot = {lastDeviceId: null}) {
  const {Panel} = load();
  const {model, fx} = Panel.init(boot);
  const pending = plain(fx);
  let at = 0;
  const send = msg => { pending.push(...plain(Panel.step(model, {at: at += 10, n: 0, ...msg}).fx)); };
  const take = pred => {
    const i = pending.findIndex(pred);
    assert.notEqual(i, -1, 'expected effect');
    return pending.splice(i, 1)[0];
  };
  const p = {
    Panel, model, pending, send,
    get view() { return plain(Panel.view(model)); },
    tap: (t, arg, from, n = 0) => send({t, arg, from, n}),
    status: (raw, ok = true) => { const f = take(e => e.fx === 'poll'); send({t: 'status', gen: f.gen, seq: f.seq, ok, raw: raw && fixture(raw)}); },
    polls: () => pending.filter(e => e.fx === 'poll').length,
    posted: action => pending.find(e => e.fx === 'post' && e.action === action),
    posts: action => pending.filter(e => e.fx === 'post' && (!action || e.action === action)),
    reply: (f, r = {ok: true, body: {accepted: true}}) => { pending.splice(pending.indexOf(f), 1); send({t: 'reply', ticket: f.ticket, ...r}); },
    fire: name => { const f = take(e => e.fx === 'timer' && e.name === name); send({t: 'timer', name, ticket: f.ticket}); },
    file: bytes => { const f = take(e => e.fx === 'read'); send({t: 'file', ticket: f.ticket, bytes}); },
    effects: kind => pending.filter(e => e.fx === kind),
    // command round trip: HTTP reply, then the confirming poll carries the resulting status
    settle: (action, next, r) => { p.reply(p.posted(action), r); p.status(next); },
  };
  if (initial) p.status(initial);
  return p;
}

const addonOff = {state: 'off', revision: 0, match: null, message: null, count: 0};
const catalogue = (id, addon = addonOff, extra = []) => ({id: 'cat-' + id, source_id: id, duration: 500, entries: [
  {id: 'text-' + id, kind: 'embedded', label: '日本語', language: 'jpn', supported: true, reason: null},
  {id: 'image-' + id, kind: 'embedded', label: 'Image', language: 'eng', supported: false, reason: 'Subtítulos de imagen no compatibles'}, ...extra], addon});
const destination = {
  selected_device: {id: 'tv-a', name: 'Sala', host: '192.0.2.2', model: 'Chromecast', available: true}, device_revision: 1,
  devices: [{id: 'tv-a', name: 'Sala', host: '192.0.2.2', model: 'Chromecast'}, {id: 'tv-b', name: 'Sala', host: '192.0.2.3', model: 'Google TV'}],
  device_discovery: 'ready', can_change_device: false};
const playing = {...destination, phase: 'playing', title: 'Alpha', source_id: 'a', sources: [{id: 'a', title: 'Alpha'}, {id: 'b', title: 'Beta'}],
  duration: 500, absolute_time: 50, volume: .3, muted: false, subtitle_delay_ms: 0, subtitles_enabled: true};
function fixture(s) {
  const catalogues = Object.fromEntries((s.sources || []).map(source => [source.id, {state: 'ready', catalogue: catalogue(source.id, s.addons?.[source.id], s.extra?.[source.id])}]));
  const active = ['playing', 'paused', 'preparing', 'buffering', 'loading'].includes(s.phase);
  const own = s.source_id || 'a';
  return {...destination, source_discovery: 'ready', catalogues, ...(active ? {
    playback_id: 'play-a', active_catalogue: catalogue(own, s.addons?.[own], s.extra?.[own]),
    subtitle_choice: {catalogue_id: 'cat-' + own, subtitle_id: 'text-' + own, enabled: true, delay_ms: s.subtitle_delay_ms ?? 0, label: '日本語', language: 'jpn'}} : {}), ...s};
}
const idle = {...playing, phase: 'idle', source_id: null, title: null, can_change_device: true};

test('timestamps parse and format like player conventions', () => {
  const {Panel} = load();
  assert.equal(Panel.formatTime(3665), '1:01:05');
  assert.equal(Panel.formatTime(NaN), '—');
  assert.equal(Panel.parseTime('1:02:03'), 3723);
  assert.equal(Panel.parseTime('02:30'), 150);
  for (const value of ['90', '-1:00', '1:60:00', 'a:b', '1:2:3:4']) assert.equal(Panel.parseTime(value), null);
});

test('one poll in flight; the timer re-arms after each reply and ignores a superseded timer', () => {
  const p = panel(null);
  assert.equal(p.polls(), 1);
  p.status(playing);
  assert.equal(p.polls(), 0);
  assert.equal(p.effects('timer').filter(t => t.name === 'poll').length, 1);
  p.fire('poll');
  assert.equal(p.polls(), 1);
  p.status(playing, false);
  assert.equal(p.polls(), 0);
  assert.equal(p.effects('timer').filter(t => t.name === 'poll').length, 1, 'offline polling continues');
});

test('stale polls are fenced after a command and no phase is invented', () => {
  const p = panel(playing);
  p.fire('poll');
  const stale = p.effects('poll')[0];
  p.tap('toggle');
  const pause = p.posted('pause');
  assert.ok(pause);
  assert.equal(p.view.mando.board.state, 'REPRODUCIENDO', 'a command never commits its phase optimistically');
  p.send({t: 'status', gen: stale.gen, seq: stale.seq, ok: true, raw: fixture({...playing, phase: 'preparing', pending: true})});
  p.pending.splice(p.pending.indexOf(stale), 1);
  assert.equal(p.view.mando.board.state, 'REPRODUCIENDO', 'the poll issued before the command is dropped');
  p.settle('pause', {...playing, phase: 'paused'});
  assert.equal(p.view.mando.board.state, 'EN PAUSA');
});

test('a second command is ignored while one is in flight', () => {
  const p = panel(playing);
  p.tap('toggle');
  p.tap('toggle');
  assert.equal(p.posts().length, 1);
  p.reply(p.posted('pause'));
  p.tap('toggle');
  assert.equal(p.posts().length, 0, 'still busy until the confirming poll is applied');
  p.status({...playing, phase: 'paused'});
  p.tap('toggle');
  assert.equal(p.posts('resume').length, 1);
});

test('every playback post carries the device identity, including a zero revision', () => {
  const p = panel({...playing, device_revision: 0});
  p.tap('toggle');
  assert.deepEqual(p.posted('pause').body, {device_id: 'tv-a', device_revision: 0});
});

// ───────── plan: movie, TV, subtitles, Start

const choose = (p, id = 'a', cat = catalogue(id)) => { p.tap('pickSource', id); p.reply(p.posted('catalogue'), {ok: true, body: {catalogue: cat}}); };
const startNow = (p, next) => { p.tap('start'); p.status(next); return p.posted('start'); };
const withCatalogue = (status, cat) => ({...status, catalogues: {[cat.source_id]: {state: 'ready', catalogue: cat}}});
const offline = p => { p.fire('poll'); p.status(null, false); };
const names = rows => rows.map(r => r.label);

test('Preparar takes three taps: movie, the remembered TV, Iniciar; nothing casts before the last one', () => {
  const p = panel({...idle, selected_device: null, device_revision: 0}, {lastDeviceId: 'tv-b'});
  const select = p.posted('select_device');
  assert.deepEqual(select.body, {device_id: 'tv-b', device_revision: 0}, 'the remembered TV is selected, not started');
  p.settle('select_device', {...idle, selected_device: {id: 'tv-b', name: 'Sala', host: '192.0.2.3', model: 'Google TV', available: true}});
  assert.equal(p.view.plan.primary.enabled, false);
  assert.equal(p.view.plan.stub.label, 'Falta');
  assert.deepEqual(p.view.plan.stub.missing, ['PELÍCULA']);
  choose(p);
  assert.equal(p.view.plan.primary.label, 'Iniciar en Sala (Google TV)');
  assert.equal(p.view.plan.primary.enabled, true);
  assert.equal(p.posts('start').length, 0);
  const start = startNow(p, {...idle, selected_device: {id: 'tv-b', name: 'Sala', host: '192.0.2.3', model: 'Google TV', available: true}});
  assert.deepEqual(start.body, {source_id: 'a', catalogue_id: 'cat-a', subtitle_id: null, delay_ms: 0, device_id: 'tv-b', device_revision: 1});
});

test('the TV is remembered once the server confirms it, and the pre-selection happens once', () => {
  const p = panel({...idle, selected_device: null}, {lastDeviceId: null});
  assert.equal(p.posts('select_device').length, 0, 'nothing remembered, nothing selected for the user');
  p.tap('pickDevice', 'tv-b');
  p.settle('select_device', {...idle, selected_device: {id: 'tv-b', name: 'Sala', host: '192.0.2.3', model: 'Google TV', available: true}});
  assert.deepEqual(p.effects('store').map(e => [e.key, e.value]), [['cast.lastDevice', 'tv-b']]);
  const q = panel({...idle, selected_device: null}, {lastDeviceId: 'tv-gone'});
  assert.equal(q.posts('select_device').length, 0, 'a remembered TV that is not listed is ignored');
  const r = panel({...idle, selected_device: null}, {lastDeviceId: 'tv-a'});
  r.reply(r.posted('select_device'), {ok: false, code: 'stale_destination', message: 'La TV cambió.'});
  r.status({...idle, selected_device: null});
  assert.equal(r.posts('select_device').length, 0, 'a failed pre-selection is not retried behind the user');
});

test('two TVs named Sala always read as name and model, in the list and in the primary', () => {
  const p = panel(idle);
  assert.deepEqual(names(p.view.destination.rows), ['Sala · Chromecast', 'Sala · Google TV']);
  assert.equal(p.view.destination.label, 'Sala · Chromecast');
  choose(p);
  assert.equal(p.view.plan.primary.label, 'Iniciar en Sala (Chromecast)');
  p.tap('pickDevice', 'tv-b');
  p.settle('select_device', {...idle, selected_device: {id: 'tv-b', name: 'Sala', host: '192.0.2.3', model: 'Google TV', available: true}, device_revision: 2});
  assert.equal(p.view.plan.primary.label, 'Iniciar en Sala (Google TV)');
  assert.equal(p.view.destination.rows.find(r => r.selected).label, 'Sala · Google TV');
  assert.equal(p.view.destination.details, '192.0.2.3', 'the address only lives in the details disclosure');
});

test('select_device binds the current revision, including zero, and never casts', () => {
  const p = panel({...idle, device_revision: 0});
  p.tap('pickDevice', 'tv-b');
  assert.deepEqual(p.posted('select_device').body, {device_id: 'tv-b', device_revision: 0});
  assert.equal(p.posts('start').length, 0);
});

test('TV rows are disabled while owned, offline or busy and a forced pickDevice posts nothing', () => {
  const cases = {
    owned: [{...playing}, true], busy: [{...idle, command_pending: true}, true], offline: [idle, false],
    locked: [{...idle, can_change_device: false}, true],
  };
  for (const [name, [status, ok]] of Object.entries(cases)) {
    const p = panel(status);
    if (!ok) offline(p);
    assert.ok(p.view.destination.rows.every(r => !r.enabled), `${name}: rows are disabled`);
    p.tap('pickDevice', 'tv-b');
    assert.equal(p.posts().length, 0, `${name}: forced pick posts nothing`);
  }
  const free = panel(idle);
  assert.ok(free.view.destination.rows.find(r => r.id === 'tv-b').enabled);
});

test('Start is disabled, with a reason, for each missing precondition', () => {
  const ready = (extra = {}) => { const p = panel({...idle, ...extra}); choose(p); return p; };
  assert.equal(ready().view.plan.primary.enabled, true);
  const bad = {
    'no movie': () => panel(idle),
    'no TV': () => ready({selected_device: null}),
    'TV unavailable': () => ready({selected_device: {...destination.selected_device, available: false}}),
    'device discovery failed': () => ready({device_discovery: 'error', device_error: 'sin red'}),
    'busy': () => ready({command_pending: true}),
    'foreign': () => ready({phase: 'receiver_changed'}),
    'loading catalogue': () => { const p = panel(idle); p.tap('pickSource', 'a'); return p; },
  };
  for (const [name, build] of Object.entries(bad)) {
    const p = build();
    assert.equal(p.view.plan.primary.enabled, false, name);
    p.tap('start');
    assert.equal(p.polls() + p.posts('start').length, 0, `${name}: a forced start does nothing`);
  }
  const gone = ready();
  offline(gone);
  assert.equal(gone.view.plan.primary.enabled, false, 'offline');
  assert.equal(gone.view.plan.primary.note, 'Sin conexión con el puente.');
});

test('planCanStart names what is missing and the stub says Falta until nothing is', () => {
  const p = panel({...idle, selected_device: null});
  assert.deepEqual(p.view.plan.stub, {label: 'Falta', value: 'PELÍCULA · TV', missing: ['PELÍCULA', 'TV']});
  p.tap('pickDevice', 'tv-a');
  p.settle('select_device', idle);
  choose(p);
  p.tap('subsBranch', 'file');
  assert.deepEqual(p.view.plan.stub.missing, ['SUBTÍTULO'], 'a branch without a track is not a decision yet');
  p.tap('pickEntry', 'text-a');
  assert.deepEqual(p.view.plan.stub, {label: 'Embarque', value: 'Sala · Chromecast', missing: []});
});

test('subtitles are one decision: Sin, Del archivo, Stremio or Subir, and only the chosen branch carries a track', () => {
  const p = panel({...idle, addons: {a: {state: 'ready', revision: 1, match: {label: 'Alpha (2020)', confidence: 'high'}, message: null, count: 0}}});
  choose(p, 'a', catalogue('a', {state: 'ready', revision: 1, match: {label: 'Alpha (2020)', confidence: 'high'}, message: null, count: 0}));
  assert.deepEqual(p.view.plan.branches.map(b => [b.id, b.selected, b.hidden]), [['none', true, false], ['file', false, false], ['stremio', false, false], ['upload', false, false]]);
  p.tap('subsBranch', 'file');
  const rows = p.view.plan.fileEntries;
  assert.deepEqual(rows.map(r => [r.id, r.enabled, r.reason ?? null]), [['text-a', true, null], ['image-a', false, 'Subtítulos de imagen no compatibles']]);
  p.tap('pickEntry', 'image-a');
  assert.deepEqual(p.view.plan.stub.missing, ['SUBTÍTULO'], 'an unsupported track cannot be chosen');
  p.tap('pickEntry', 'text-a');
  assert.equal(p.view.plan.subsStatus, 'Subtítulo elegido: 日本語 · jpn.'.replace(' · jpn', ''));
  p.tap('subsBranch', 'upload');
  assert.deepEqual(p.view.plan.stub.missing, ['SUBTÍTULO'], 'switching branch drops the other branch\'s track');
  p.tap('subsBranch', 'none');
  assert.equal(p.view.plan.stub.missing.length, 0);
  assert.equal(p.view.plan.subsStatus, 'Va a verse sin subtítulos.');
});

test('Del archivo sends the chosen track and the Stremio branch is hidden when the addon is off', () => {
  const p = panel(idle);
  choose(p);
  assert.ok(p.view.plan.branches.find(b => b.id === 'stremio').hidden);
  p.tap('subsBranch', 'stremio');
  assert.equal(p.view.plan.branches.find(b => b.id === 'none').selected, true, 'a hidden branch cannot be chosen');
  p.tap('subsBranch', 'file');
  p.tap('pickEntry', 'text-a');
  assert.equal(startNow(p, idle).body.subtitle_id, 'text-a');
});

test('a movie with no text tracks says so and still starts without subtitles', () => {
  const bare = {...catalogue('a'), entries: []};
  const p = panel(withCatalogue(idle, bare));
  choose(p, 'a', bare);
  p.tap('subsBranch', 'file');
  assert.equal(p.view.plan.subsStatus, 'Esta película no trae subtítulos en el archivo.');
  p.tap('subsBranch', 'none');
  assert.equal(p.view.plan.primary.enabled, true);
});

test('a destination change during the deferred start refuses with El destino cambió', () => {
  const p = panel(idle);
  choose(p);
  p.tap('start');
  p.status({...idle, selected_device: {...destination.selected_device, id: 'tv-b'}});
  assert.equal(p.posts('start').length, 0);
  const q = panel(idle);
  choose(q);
  q.tap('start');
  q.status({...idle, device_revision: 2});
  assert.equal(q.posts('start').length, 0, 'a new revision of the same TV is a different destination too');
});

test('Start posts the device captured at click, not the one at the later poll', () => {
  const p = panel(idle);
  choose(p);
  p.tap('start');
  p.status(idle);
  assert.deepEqual(p.posted('start').body.device_id, 'tv-a');
  assert.equal(p.view.plan.primary.label, 'Iniciando…');
  assert.equal(p.view.plan.primary.enabled, false);
});

test('what is already on the TV reads Ya está en la TV; another subtitle is a new plan', () => {
  const p = panel(playing);
  p.tap('openChange');
  choose(p, 'a');
  assert.equal(p.view.plan.primary.label, 'Cambiar película en la TV', 'the movie on the TV has a track, this plan has none');
  assert.equal(p.view.plan.primary.enabled, true);
  p.tap('subsBranch', 'file');
  p.tap('pickEntry', 'text-a');
  assert.equal(p.view.plan.primary.label, 'Ya está en la TV');
  assert.equal(p.view.plan.primary.enabled, false);
  const q = panel({...playing, subtitle_delay_ms: 400});
  q.tap('openChange');
  choose(q, 'a');
  q.tap('subsBranch', 'file');
  q.tap('pickEntry', 'text-a');
  assert.equal(q.view.plan.primary.label, 'Cambiar película en la TV', 'a different delay is a different plan');
  assert.equal(q.view.plan.primary.enabled, true);
});

test('an idle start that discovers playback asks first and sends nothing until accepted', () => {
  const p = panel(idle);
  choose(p, 'b');
  p.tap('start');
  p.status({...playing, source_id: 'a', title: 'Alpha'});
  assert.equal(p.posts('start').length, 0);
  assert.deepEqual([p.view.confirm.title, p.view.confirm.accept], ['¿Cambiar la película en la TV?', 'Cambiar película']);
  assert.match(p.view.confirm.body, /Beta/);
  p.tap('confirmAccept');
  p.status({...playing});
  assert.equal(p.posted('start').body.source_id, 'b');
});

test('replacement consent cannot be reused for a different source or session', () => {
  const p = panel(playing);
  p.tap('openChange');
  choose(p, 'b');
  p.tap('start');
  assert.equal(p.view.confirm.kind, 'replace');
  p.tap('confirmAccept');
  p.status({...playing, session: 'other'});
  assert.equal(p.posts('start').length, 0, 'another session is on the TV now');
  assert.equal(p.view.confirm.kind, 'replace', 'so the question is asked again');
  p.tap('confirmAccept');
  p.status({...playing, session: 'other'});
  assert.equal(p.posted('start').body.source_id, 'b');
});

test('a pending Start dies on any plan edit, Cancelar, Escape, sheet close or new catalogue id', () => {
  const edits = {
    'subtitle branch': p => p.tap('subsBranch', 'file'),
    'other movie': p => p.tap('pickSource', 'b'),
    'Escape': p => p.tap('dismiss'),
    'closeSheet': p => p.tap('closeSheet'),
    'refreshCatalogue': p => p.tap('refreshCatalogue'),
    'new catalogue id': p => p.send({t: 'status', ...(() => { const f = p.pending.find(e => e.fx === 'poll'); return {gen: f.gen, seq: f.seq}; })(), ok: true, raw: fixture({...idle, catalogues: undefined})}),
  };
  for (const [name, edit] of Object.entries(edits)) {
    const p = panel(idle);
    choose(p);
    p.tap('start');
    assert.ok(p.polls() === 1, `${name}: verifying`);
    edit(p);
    if (p.polls()) p.status(idle);
    assert.equal(p.posts('start').length, 0, `${name}: nothing was sent`);
  }
});

test('a Start waiting in a replacement confirm dies with Volver', () => {
  const p = panel(playing);
  p.tap('openChange');
  choose(p, 'b');
  p.tap('start');
  p.tap('confirmCancel');
  assert.equal(p.view.confirm, null);
  p.fire('poll');
  p.status(playing);
  assert.equal(p.posts('start').length, 0);
});

test('late catalogue replies cannot touch another movie', () => {
  const p = panel(idle);
  p.tap('pickSource', 'a');
  const late = p.posted('catalogue');
  p.tap('pickSource', 'b');
  p.reply(late, {ok: true, body: {catalogue: catalogue('a')}});
  assert.equal(p.view.plan.sources.find(r => r.id === 'b').selected, true);
  assert.equal(p.view.plan.primary.enabled, false, 'b is still loading; a\'s catalogue was dropped');
  p.reply(p.posted('catalogue'), {ok: true, body: {catalogue: catalogue('b')}});
  assert.equal(p.view.plan.primary.enabled, true);
  p.tap('subsBranch', 'file');
  assert.equal(p.view.plan.fileEntries[0].id, 'text-b');
});

test('the same catalogue id never loses entries or addon revision; a new id resets the subtitle and the start', () => {
  const rich = catalogue('a', {...addonOff, state: 'ready', revision: 2, count: 1}, [{id: 'up-a', kind: 'upload', label: 'mio.srt', language: null, supported: true, reason: null}]);
  const p = panel(idle);
  choose(p, 'a', rich);
  p.tap('subsBranch', 'upload');
  p.tap('pickEntry', 'up-a');
  assert.equal(p.view.plan.stub.missing.length, 0);
  p.tap('refreshCatalogue');
  p.reply(p.posted('catalogue'), {ok: true, body: {catalogue: catalogue('a')}});
  assert.equal(p.view.plan.stub.missing.length, 0, 'an older, poorer copy of the same catalogue is ignored');
  p.tap('refreshCatalogue');
  p.tap('start');
  assert.equal(p.polls(), 0, 'refreshing is busy: start refused');
  p.reply(p.posted('catalogue'), {ok: true, body: {catalogue: {...catalogue('a'), id: 'cat-a2'}}});
  assert.equal(p.view.plan.branches.find(b => b.selected).id, 'none', 'a new id resets the subtitle');
});

test('refreshing the movie list or the TV list never disables each other or an owned transport', () => {
  const p = panel(playing);
  p.tap('refreshSources');
  p.tap('refreshDevices');
  assert.deepEqual(p.posts().map(e => e.action).sort(), ['discover', 'discover_devices']);
  assert.equal(p.view.mando.toggle.enabled, true);
  assert.equal(p.view.plan.refreshSources.enabled, false);
  p.tap('refreshSources');
  assert.equal(p.posts('discover').length, 1, 'one request per kind');
  p.reply(p.posted('discover'));
  assert.equal(p.polls(), 1, 'a refresh asks for a fresh status');
  p.reply(p.posted('discover_devices'), {ok: false, message: 'Sin red.'});
  assert.match(p.view.destination.status, /No se pudo actualizar la lista de TVs/);
});

test('failed device discovery says the list is unconfirmed, not that the TV is gone', () => {
  const p = panel({...idle, device_discovery: 'error', device_error: 'sin red'});
  assert.equal(p.view.destination.note, 'Lista sin confirmar');
  assert.match(p.view.destination.status, /No se pudo actualizar la lista de TVs.*sin red/);
  assert.equal(p.view.destination.label, 'Sala · Chromecast');
  const q = panel({...playing, device_discovery: 'error', device_error: 'sin red'});
  assert.equal(q.view.mando.toggle.enabled, true, 'a failed discovery does not take the remote away');
  const r = panel({...idle, selected_device: {...destination.selected_device, available: false}});
  assert.equal(r.view.destination.note, 'No disponible');
});

test('an empty TV list explains itself and an empty movie list too', () => {
  const p = panel({...idle, devices: [], selected_device: null, sources: []});
  assert.match(p.view.destination.status, /No encontramos ninguna TV/);
  assert.equal(p.view.destination.label, 'Sin TV elegida');
  assert.match(p.view.plan.sourceStatus, /No hay películas todavía/);
});

// upload

const srt = text => new TextEncoder().encode(text).buffer;
const uploaded = (id = 'a') => ({entry: {id: 'up-' + id, kind: 'upload', label: 'mio.srt', language: null, supported: true, reason: null},
  catalogue: catalogue(id, addonOff, [{id: 'up-' + id, kind: 'upload', label: 'mio.srt', language: null, supported: true, reason: null}])});

test('upload rejects a wrong extension, an oversize file and invalid UTF-8 without selecting anything', () => {
  const p = panel(idle);
  choose(p);
  p.tap('subsBranch', 'upload');
  p.send({t: 'filePicked', arg: {name: 'peli.txt', size: 10}});
  assert.match(p.view.plan.upload.message, /\.srt o \.vtt/);
  assert.equal(p.effects('read').length, 0);
  p.send({t: 'filePicked', arg: {name: 'peli.srt', size: 1024 * 1024 + 1}});
  assert.match(p.view.plan.upload.message, /supera 1 MiB/);
  p.send({t: 'filePicked', arg: {name: 'peli.srt', size: 10}});
  p.file(new Uint8Array([0xff, 0xfe, 0x41]).buffer);
  assert.match(p.view.plan.upload.message, /UTF-8 válido/);
  assert.equal(p.posts('subtitle_upload').length, 0);
  assert.deepEqual(p.view.plan.stub.missing, ['SUBTÍTULO']);
});

test('upload decodes the bytes, posts the text, verifies the answer and selects the entry', () => {
  const p = panel(idle);
  choose(p);
  p.tap('subsBranch', 'upload');
  p.send({t: 'filePicked', arg: {name: 'C:\\subs\\mio.SRT', size: 12}});
  assert.equal(p.view.plan.upload.busy, true);
  p.file(srt('1\n00:00:01,000 --> 00:00:02,000\nHola\n'));
  const post = p.posted('subtitle_upload');
  assert.deepEqual([post.body.source_id, post.body.catalogue_id, post.body.filename, post.body.format], ['a', 'cat-a', 'mio.SRT', 'srt']);
  assert.match(post.body.text, /Hola/);
  p.reply(post, {ok: true, body: uploaded()});
  assert.equal(p.view.plan.upload.chosen, 'mio.srt');
  assert.equal(p.view.plan.stub.missing.length, 0);
  assert.equal(startNow(p, withCatalogue(idle, uploaded().catalogue)).body.subtitle_id, 'up-a');
});

test('an upload answer for another catalogue or an unsupported entry is refused', () => {
  const p = panel(idle);
  choose(p);
  p.tap('subsBranch', 'upload');
  p.send({t: 'filePicked', arg: {name: 'a.srt', size: 3}});
  p.file(srt('x'));
  p.reply(p.posted('subtitle_upload'), {ok: true, body: {...uploaded('b')}});
  assert.match(p.view.plan.upload.message, /La lista de pistas cambió/);
  assert.deepEqual(p.view.plan.stub.missing, ['SUBTÍTULO']);
});

test('late upload reads and replies cannot select a track for another movie or an abandoned draft', () => {
  const p = panel(idle);
  choose(p);
  p.tap('subsBranch', 'upload');
  p.send({t: 'filePicked', arg: {name: 'a.srt', size: 3}});
  const read = p.pending.splice(p.pending.findIndex(e => e.fx === 'read'), 1)[0];
  p.tap('pickSource', 'b');
  p.send({t: 'file', ticket: read.ticket, bytes: srt('x')});
  assert.equal(p.posts('subtitle_upload').length, 0, 'the read for the old movie is dropped');
  choose(p, 'b');
  p.tap('subsBranch', 'upload');
  p.send({t: 'filePicked', arg: {name: 'b.srt', size: 3}});
  p.file(srt('x'));
  const post = p.posted('subtitle_upload');
  p.tap('subsBranch', 'none');
  p.reply(post, {ok: true, body: uploaded('b')});
  assert.equal(p.view.plan.branches.find(b => b.selected).id, 'none', 'an abandoned draft does not get the track');
});

test('upload needs a movie and is refused while another is in flight', () => {
  const p = panel(idle);
  p.send({t: 'filePicked', arg: {name: 'a.srt', size: 3}});
  assert.equal(p.effects('read').length, 0);
  choose(p);
  p.send({t: 'filePicked', arg: {name: 'a.srt', size: 3}});
  p.send({t: 'filePicked', arg: {name: 'b.srt', size: 3}});
  assert.equal(p.effects('read').length, 1);
});

// Stremio in the plan

const addonReady = (count = 2, extra = {}) => ({state: 'ready', revision: 1, match: {label: 'Alpha (2020)', confidence: 'high'}, message: null, count, ...extra});
const offers = {state: 'ready', revision: 1, match: {label: 'Alpha (2020)'}, message: null, count: 3, alternatives: [{id: 'tt1', title: 'Alpha Two', year: 2021}, {id: 'tt2', title: 'Alpha Three', year: null}],
  offers: [{id: 'o-es-1', language: 'spa', language_name: 'Español', label: 'Alpha.es.srt', note: '98%'}, {id: 'o-es-2', language: 'spa', language_name: 'Español', label: 'Alpha.es.2.srt', note: ''}, {id: 'o-en', language: 'eng', language_name: 'English', label: 'Alpha.en.srt', note: ''}]};
function stremioPlan(addon = addonReady()) {
  const p = panel({...idle, addons: {a: addon}});
  choose(p, 'a', catalogue('a', addon));
  p.tap('subsBranch', 'stremio');
  return p;
}

test('Stremio: the offers are pulled once the branch shows, languages and versions come from the listing', () => {
  const p = stremioPlan();
  const pull = p.posted('subtitle_offers');
  assert.deepEqual(pull.body, {source_id: 'a', catalogue_id: 'cat-a'});
  assert.equal(p.view.plan.stremio.status, 'Buscando subtítulos de Stremio…');
  p.reply(pull, {ok: true, body: offers});
  const v = p.view.plan.stremio;
  assert.equal(v.match, 'Coincidencia: Alpha (2020)');
  assert.deepEqual(v.languages.map(l => [l.id, l.label, l.selected]), [['spa', 'Español · 2', true], ['eng', 'English · 1', false]]);
  assert.deepEqual(names(v.versions), ['Alpha.es.srt · 98%', 'Alpha.es.2.srt']);
  p.tap('stremioLanguage', 'eng');
  assert.deepEqual(names(p.view.plan.stremio.versions), ['Alpha.en.srt']);
});

test('Stremio: Usar este subtítulo downloads once, selects the entry and Start never touches the network for it', () => {
  const p = stremioPlan();
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  p.tap('stremioVersion', 'o-es-2');
  p.tap('stremioUse');
  p.tap('stremioUse');
  const fetch = p.posted('subtitle_fetch');
  assert.equal(p.posts('subtitle_fetch').length, 1);
  assert.deepEqual(fetch.body, {source_id: 'a', catalogue_id: 'cat-a', offer_id: 'o-es-2'});
  assert.equal(p.view.plan.stremio.use.label, 'Descargando…');
  const entry = {id: 'ad-1', kind: 'addon', label: 'Español · Alpha.es.2.srt', language: 'spa', supported: true, reason: null};
  p.reply(fetch, {ok: true, body: {entry, catalogue: catalogue('a', addonReady(), [entry])}});
  assert.match(p.view.plan.subsStatus, /Subtítulo listo: Español/);
  assert.equal(p.view.plan.stub.missing.length, 0);
  assert.equal(startNow(p, withCatalogue(idle, catalogue('a', addonReady(), [entry]))).body.subtitle_id, 'ad-1');
});

test('Stremio: a doubtful match is a question, an unreadable subtitle stays listed and Start is untouched', () => {
  const p = stremioPlan(addonReady(2, {match: {label: 'Alpha (1999)', confidence: 'doubtful'}}));
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  assert.equal(p.view.plan.stremio.match, '¿Es «Alpha (1999)»?');
  p.tap('stremioUse');
  p.reply(p.posted('subtitle_fetch'), {ok: false, code: 'invalid_subtitle', message: 'No se pudo leer ese subtítulo.'});
  assert.match(p.view.plan.stremio.versions[0].label, /no se pudo leer/);
  assert.equal(p.view.plan.stremio.status, 'No se pudo leer ese subtítulo.');
});

test('Stremio: No es esta reveals at most four alternatives and a free search, both feeding one lookup', () => {
  const p = stremioPlan();
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  assert.equal(p.view.plan.stremio.correctionOpen, false);
  p.tap('stremioWrong');
  assert.equal(p.view.plan.stremio.correctionOpen, true);
  assert.deepEqual(names(p.view.plan.stremio.alternatives), ['Alpha Two (2021)', 'Alpha Three']);
  p.tap('stremioAlt', 0);
  assert.deepEqual(p.posted('subtitle_lookup').body, {source_id: 'a', catalogue_id: 'cat-a', hint: 'tt1 Alpha Two 2021'});
  p.reply(p.posted('subtitle_lookup'), {ok: true, body: {catalogue: catalogue('a', addonReady(2, {revision: 2}))}});
  p.tap('stremioSearch', 'x'.repeat(201));
  assert.equal(p.posts('subtitle_lookup').length, 0);
  assert.match(p.view.plan.stremio.status, /hasta 200 caracteres/);
  p.tap('stremioSearch', '  Otra peli 2019 ');
  assert.equal(p.posted('subtitle_lookup').body.hint, 'Otra peli 2019');
});

test('Stremio: an unidentified film opens the correction on its own; error and empty states keep one status line', () => {
  const p = stremioPlan({state: 'unidentified', revision: 1, match: null, message: 'No pudimos identificar la película.', count: 0});
  assert.equal(p.view.plan.stremio.correctionOpen, true);
  assert.equal(p.view.plan.stremio.wrong.shown, false);
  assert.equal(p.view.plan.stremio.status, 'No pudimos identificar la película.');
  const q = stremioPlan({state: 'error', revision: 1, match: null, message: 'Stremio no responde.', count: 0});
  assert.equal(q.view.plan.stremio.retry.shown, true);
  assert.equal(q.view.plan.stremio.status, 'Stremio no responde.');
  assert.equal(q.posts('subtitle_offers').length, 0, 'nothing to list in an error state');
  q.tap('stremioRetry');
  assert.equal(q.posts('subtitle_lookup').length, 1);
  const r = stremioPlan(addonReady(0));
  r.reply(r.posted('subtitle_offers'), {ok: true, body: {...offers, offers: [], count: 0}});
  assert.equal(r.view.plan.stremio.status, 'Stremio no tiene subtítulos para Alpha (2020).');
});

test('Stremio: late downloads cannot select a subtitle for another movie or an abandoned draft', () => {
  const p = stremioPlan();
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  p.tap('stremioUse');
  const fetch = p.posted('subtitle_fetch');
  p.tap('pickSource', 'b');
  const entry = {id: 'ad-1', kind: 'addon', label: 'x', language: 'spa', supported: true, reason: null};
  p.reply(fetch, {ok: true, body: {entry, catalogue: catalogue('a', addonReady(), [entry])}});
  assert.equal(p.view.plan.branches.find(b => b.selected).id, 'none');
  assert.equal(p.posts('start').length, 0);
});

test('Stremio: an older addon revision of the same catalogue never replaces a newer one', () => {
  const p = stremioPlan(addonReady(2, {revision: 3}));
  p.reply(p.posted('subtitle_offers'), {ok: true, body: {...offers, revision: 3}});
  p.tap('stremioWrong');
  p.tap('stremioAlt', 0);
  p.reply(p.posted('subtitle_lookup'), {ok: true, body: {catalogue: catalogue('a', addonReady(2, {revision: 1}))}});
  assert.equal(p.view.plan.stremio.match, 'Coincidencia: Alpha (2020)');
  p.tap('stremioWrong');
  assert.equal(p.view.plan.stremio.languages.length, 2, 'the listing for revision 3 is still the one shown');
});

test('a movie that leaves the list ends the plan and the page falls back to choosing', () => {
  const p = panel(idle);
  choose(p);
  p.tap('subsBranch', 'file');
  p.fire('poll');
  p.status({...idle, sources: [{id: 'b', title: 'Beta'}]});
  assert.equal(p.view.plan.sources.some(r => r.selected), false);
  assert.deepEqual(p.view.plan.stub.missing, ['PELÍCULA']);
});
