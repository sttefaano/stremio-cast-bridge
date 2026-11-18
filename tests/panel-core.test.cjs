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
  let at = 0, n = 0;
  const send = msg => { pending.push(...plain(Panel.step(model, {at: at += 10, n, ...msg}).fx)); };
  const take = pred => {
    const i = pending.findIndex(pred);
    assert.notEqual(i, -1, 'expected effect');
    return pending.splice(i, 1)[0];
  };
  const p = {
    Panel, model, pending, send,
    get view() { return plain(Panel.view(model)); },
    tap: (t, arg, from, count = n) => { n = count; send({t, arg, from}); },
    status: (raw, ok = true) => { const f = take(e => e.fx === 'poll'); send({t: 'status', gen: f.gen, seq: f.seq, ok, raw: raw && fixture(raw)}); },
    polls: () => pending.filter(e => e.fx === 'poll').length,
    posted: action => pending.find(e => e.fx === 'post' && e.action === action),
    posts: action => pending.filter(e => e.fx === 'post' && (!action || e.action === action)),
    reply: (f, r = {ok: true, body: {accepted: true}}) => { pending.splice(pending.indexOf(f), 1); send({t: 'reply', ticket: f.ticket, ...r}); },
    // the newest timer of a name: an older one was superseded and the core would ignore it anyway
    fire: name => { const i = pending.findLastIndex(e => e.fx === 'timer' && e.name === name); assert.notEqual(i, -1, 'expected timer'); const [f] = pending.splice(i, 1); send({t: 'timer', name, ticket: f.ticket}); },
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
  const active = ['playing', 'paused', 'preparing', 'buffering', 'loading', 'receiver_changed', 'disconnected'].includes(s.phase);
  const own = s.source_id || 'a';
  return {...destination, source_discovery: 'ready', catalogues, pending: ['preparing', 'buffering', 'loading', 'receiver_changed', 'disconnected'].includes(s.phase), ...(active ? {
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

// ───────── remote: seek, volume, captions, stop

const paused = {...playing, phase: 'paused'};
const seekTo = (p, pos) => { p.tap('dragSeek', pos); p.tap('dropSeek', pos); };

test('seek commits on release: dragging previews and sends nothing, the elapsed time stays real', () => {
  const p = panel(playing);
  p.tap('dragSeek', 300);
  assert.equal(p.posts().length, 0);
  assert.deepEqual([p.view.mando.track.preview, p.view.mando.track.elapsed, p.view.mando.track.previewAt], ['→ 5:00', '0:50', 300]);
  p.tap('dropSeek', 300);
  assert.deepEqual(p.posted('seek').body, {device_id: 'tv-a', device_revision: 1, position: 300});
  assert.equal(p.posts().length, 1, 'one seek per release');
  assert.equal(p.view.mando.track.preview, null);
  assert.equal(p.view.mando.track.target, '→ 5:00');
});

test('a release outside the movie sends nothing; a seek while busy or foreign is refused', () => {
  const p = panel(playing);
  p.tap('dropSeek', 501);
  p.tap('dropSeek', -1);
  assert.equal(p.posts().length, 0);
  for (const status of [{...playing, command_pending: true}, {...playing, phase: 'loading', pending: true}, {...playing, phase: 'receiver_changed'}]) {
    const q = panel(status);
    q.tap('dragSeek', 100);
    q.tap('dropSeek', 100);
    q.tap('skip', 30);
    assert.equal(q.posts().length + q.effects('timer').filter(t => t.name === 'skip').length, 0, status.phase);
    assert.equal(q.view.mando.track.enabled, false);
  }
});

test('Escape or pointer cancel while dragging goes back to idle and sends nothing', () => {
  const p = panel(playing);
  p.tap('dragSeek', 200);
  p.tap('seekAbandon');
  assert.equal(p.view.mando.track.preview, null);
  assert.equal(p.posts().length, 0);
  p.tap('dropSeek', 200);
  p.tap('seekAbandon');
  assert.ok(p.view.mando.track.target, 'abandon after a release does not forget the sent seek');
});

test('the target stays until the TV is usable and either was seen busy or is within 2 s', () => {
  const p = panel(playing);
  seekTo(p, 300);
  p.settle('seek', {...playing, absolute_time: 50});
  assert.equal(p.view.mando.track.target, '→ 5:00', 'still at the old place: keep the target');
  p.fire('poll');
  p.status({...playing, absolute_time: 50, pending: true});
  p.fire('poll');
  p.status({...playing, absolute_time: 52});
  assert.equal(p.view.mando.track.target, null, 'it was busy and is usable again');
  const q = panel(playing);
  seekTo(q, 300);
  q.settle('seek', {...playing, absolute_time: 299});
  assert.equal(q.view.mando.track.target, null, 'within 2 s of the target');
});

test('a rejected seek clears only its own target; a worker failure arrives only as action_error', () => {
  const p = panel(playing);
  seekTo(p, 300);
  p.settle('seek', {...playing, command_pending: true}, {ok: false, code: 'busy', message: 'La TV está ocupada.'});
  assert.equal(p.view.mando.track.target, null, 'a 409 clears the fictional target');
  const q = panel(playing);
  seekTo(q, 300);
  q.settle('seek', {...playing, absolute_time: 50}, {ok: true, body: {accepted: true}});
  assert.ok(q.view.mando.track.target);
  q.fire('poll');
  q.status({...playing, absolute_time: 50, action_error: 'La TV no pudo saltar.', action_error_revision: 4});
  assert.equal(q.view.mando.track.target, null, 'the worker failure reached the page as action_error and ended the wait');
});

test('±30 taps accumulate into one seek delta after a quiet 600 ms and show their sum', () => {
  const p = panel(playing);
  p.tap('skip', 30); p.tap('skip', 30); p.tap('skip', 30);
  assert.equal(p.view.mando.badge, '+90 s');
  assert.equal(p.posts().length, 0);
  const timers = p.effects('timer').filter(t => t.name === 'skip');
  assert.equal(timers.length, 3);
  assert.ok(timers.every(t => t.ms === 600));
  p.send({t: 'timer', name: 'skip', ticket: timers[0].ticket});
  assert.equal(p.posts().length, 0, 'an older timer is stale');
  p.send({t: 'timer', name: 'skip', ticket: timers[2].ticket});
  assert.deepEqual(p.posted('seek').body, {device_id: 'tv-a', device_revision: 1, delta: 90});
  assert.equal(p.view.mando.badge, null);
});

test('the accumulated skip is clamped so neither the badge nor the delta passes the movie', () => {
  const p = panel({...playing, absolute_time: 20});
  p.tap('skip', -30);
  assert.equal(p.view.mando.badge, '−20 s');
  const q = panel({...playing, absolute_time: 490});
  q.tap('skip', 30); q.tap('skip', 30);
  assert.equal(q.view.mando.badge, '+10 s');
  q.send({t: 'timer', name: 'skip', ticket: q.effects('timer').filter(t => t.name === 'skip').pop().ticket});
  assert.equal(q.posted('seek').body.delta, 10);
  const r = panel({...playing, absolute_time: 0});
  r.tap('skip', -30);
  assert.equal(r.view.mando.badge, null);
  r.send({t: 'timer', name: 'skip', ticket: r.effects('timer').pop().ticket});
  assert.equal(r.posts().length, 0, 'nothing to skip');
});

test('a skip timer that finds our own short command re-arms; a busy TV drops the skip silently', () => {
  const p = panel(playing);
  p.tap('skip', 30);
  p.tap('mute');
  const first = p.effects('timer').filter(t => t.name === 'skip')[0];
  p.send({t: 'timer', name: 'skip', ticket: first.ticket});
  assert.equal(p.posts('seek').length, 0);
  const again = p.effects('timer').filter(t => t.name === 'skip').pop();
  assert.notEqual(again.ticket, first.ticket);
  p.reply(p.posted('mute'));
  p.status({...playing, muted: true});
  p.send({t: 'timer', name: 'skip', ticket: again.ticket});
  assert.equal(p.posts('seek').length, 1);
  const q = panel(playing);
  q.tap('skip', 30);
  q.fire('poll');
  q.status({...playing, phase: 'buffering', pending: true});
  q.send({t: 'timer', name: 'skip', ticket: q.effects('timer').filter(t => t.name === 'skip').pop().ticket});
  assert.equal(q.posts().length, 0);
  assert.equal(q.view.mando.badge, null);
});

test('exact time validates inline, sends nothing when invalid, and applies directly when valid', () => {
  const p = panel(playing);
  p.tap('openMore');
  p.tap('gotoTime', '9:99');
  assert.match(p.view.sheet.exact.error, /m:ss o h:mm:ss, hasta 8:20/);
  p.tap('gotoTime', '10:00');
  assert.equal(p.posts().length, 0, 'beyond the duration');
  p.tap('exactInput', '1:05');
  assert.equal(p.view.sheet.exact.error, '', 'typing clears the message');
  p.tap('gotoTime', '1:05');
  assert.equal(p.posted('seek').body.position, 65);
  assert.equal(p.view.sheet, null, 'the sheet closes: there is no review step');
});

test('volume previews while dragging and sends one level on release; mute sends the opposite', () => {
  const p = panel(playing);
  p.tap('volumePreview', 80);
  assert.equal(p.view.mando.volume.text, '80%');
  assert.equal(p.posts().length, 0);
  p.tap('volume', 80);
  assert.deepEqual(p.posted('volume').body, {device_id: 'tv-a', device_revision: 1, level: 0.8});
  assert.equal(p.view.mando.volume.percent, 80, 'the slider does not jump back before the confirming poll');
  p.settle('volume', {...playing, volume: .8});
  assert.equal(p.view.mando.volume.percent, 80);
  p.tap('mute');
  assert.deepEqual(p.posted('mute').body, {device_id: 'tv-a', device_revision: 1, muted: true});
  assert.equal(panel({...playing, volume: null, muted: null}).view.mando.volume.enabled, false, 'volume is null until the TV reports it');
});

test('the clock interpolates while playing, capped 2 s past the last status; the guards use the raw status', () => {
  const p = panel({...playing, absolute_time: 100});
  p.send({t: 'timer', name: 'clock', ticket: 0, at: 1500});
  assert.equal(p.view.mando.board.clock, '1:41', 'a second and a half after the status');
  p.send({t: 'timer', name: 'clock', ticket: 0, at: 60000});
  assert.equal(p.view.mando.board.clock, '1:42', 'a stalled poll never invents more than 2 s');
  const q = panel({...paused, absolute_time: 100});
  q.send({t: 'timer', name: 'clock', ticket: 0, at: 1000});
  assert.equal(q.view.mando.board.clock, '1:40', 'paused does not tick');
});

// captions

const subsOk = (id, delay, enabled = true, extra = {}) => ({...playing, subtitle_delay_ms: delay, subtitles_enabled: enabled, ...extra, subtitle_choice: {catalogue_id: 'cat-a', subtitle_id: id, enabled, delay_ms: delay, label: 'x', language: 'jpn'}});
const extraTrack = [{id: 'text2-a', kind: 'embedded', label: 'English', language: 'eng', supported: true, reason: null}];
const withTracks = {extra: {a: extraTrack}};

test('the caption draft rounds to 0,1 s, clamps at ±30 s, resets and is dirty only while it differs', () => {
  const p = panel({...playing, ...withTracks});
  p.tap('openSubs');
  assert.equal(p.view.sheet.unapplied, false);
  p.tap('capNudge', 100); p.tap('capNudge', 100);
  assert.deepEqual([p.view.sheet.delay.text, p.view.sheet.delay.meaning, p.view.sheet.unapplied, p.view.mando.chip.unapplied], ['+0,2 s', 'Aparecen 0,2 s después que la voz', true, true]);
  p.tap('capNudge', -330);
  assert.equal(p.view.sheet.delay.text, '−0,1 s', 'every value is a multiple of 0,1 s');
  p.tap('capReset');
  assert.equal(p.view.sheet.unapplied, false, 'back to the TV\'s value is no draft');
  for (let i = 0; i < 40; i++) p.tap('capNudge', 1000);
  assert.equal(p.view.sheet.delay.text, '+30,0 s');
  p.tap('capNudge', -1000);
  p.tap('capNudge', -60000);
  assert.equal(p.view.sheet.delay.text, '−30,0 s');
  p.tap('capNudge', NaN);
  assert.equal(p.view.sheet.delay.text, '−30,0 s');
});

test('choosing no track zeroes the delay and a track the TV cannot play is refused', () => {
  const p = panel({...playing, subtitle_delay_ms: 500, ...withTracks});
  p.tap('openSubs');
  p.tap('capTrack', 'image-a');
  assert.equal(p.view.sheet.unapplied, false);
  assert.deepEqual(p.view.sheet.tracks.map(t => [t.id, t.selected]), [['', false], ['text-a', true], ['text2-a', false]], 'image tracks are not offered');
  p.tap('capTrack', '');
  assert.deepEqual([p.view.sheet.delay.text, p.view.sheet.steps.enabled, p.view.sheet.unapplied], ['+0,0 s', false, true]);
  p.tap('capTrack', 'text2-a');
  assert.deepEqual([p.view.sheet.delay.text, p.view.sheet.steps.enabled], ['+0,0 s', true]);
});

test('Aplicar waits for a fresh poll, posts the draft, and settles only on readback', () => {
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capTrack', 'text2-a');
  p.tap('capNudge', 400);
  p.tap('capApply');
  assert.equal(p.posts('subtitles').length, 0, 'nothing is sent from the click');
  assert.equal(p.view.sheet.apply.pending, true);
  p.status(subsOk('text-a', 0));
  const post = p.posted('subtitles');
  assert.deepEqual(post.body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a', catalogue_id: 'cat-a', subtitle_id: 'text2-a', enabled: true, delay_ms: 400});
  p.reply(post);
  p.status({...subsOk('text-a', 0), phase: 'loading', pending: true});
  assert.equal(p.view.sheet.apply.pending, true, 'the TV is still reloading');
  p.fire('poll');
  p.status(subsOk('text-a', 0));
  assert.equal(p.view.sheet.apply.pending, true, 'the old values are not the readback');
  p.fire('poll');
  p.status(subsOk('text2-a', 400));
  assert.equal(p.view.sheet, null, 'settled: the sheet closes');
  assert.equal(p.view.mando.chip.unapplied, false);
  assert.match(p.view.mando.chip.label, /\+0,4 s/);
});

test('a delay-only apply keeps the visibility the TV has, a new track shows itself', () => {
  const hidden = {...subsOk('text-a', 0, false), ...withTracks};
  const p = panel(hidden);
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.status(hidden);
  assert.deepEqual([p.posted('subtitles').body.enabled, p.posted('subtitles').body.delay_ms], [false, 300]);
  const q = panel(hidden);
  q.tap('openSubs');
  q.tap('capTrack', 'text2-a');
  q.tap('capApply');
  q.status(hidden);
  assert.equal(q.posted('subtitles').body.enabled, true);
  const r = panel(hidden);
  r.tap('openSubs');
  r.tap('capTrack', '');
  r.tap('capApply');
  r.status(hidden);
  assert.deepEqual([r.posted('subtitles').body.subtitle_id, r.posted('subtitles').body.enabled, r.posted('subtitles').body.delay_ms], [null, false, 0]);
});

test('the visibility toggle applies at once and sends the server track and delay, never the draft', () => {
  const p = panel({...subsOk('text-a', 200), ...withTracks});
  p.tap('openSubs');
  p.tap('capTrack', 'text2-a');
  p.tap('capNudge', 700);
  p.tap('capVisible', false);
  assert.equal(p.view.sheet.visible.checked, false, 'the switch shows what was asked while it settles');
  p.status(subsOk('text-a', 200));
  assert.deepEqual(p.posted('subtitles').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a', catalogue_id: 'cat-a', subtitle_id: 'text-a', enabled: false, delay_ms: 200});
  p.reply(p.posted('subtitles'));
  p.status(subsOk('text-a', 200, false));
  assert.equal(p.view.sheet.visible.checked, false);
  assert.equal(p.view.sheet.unapplied, true, 'the draft survived the toggle');
  assert.equal(p.view.sheet.delay.text, '+0,9 s');
  assert.notEqual(p.view.sheet, null, 'a visibility change does not close the sheet');
});

test('the visibility toggle does nothing when the TV already shows that, or when there is no track', () => {
  const p = panel(subsOk('text-a', 0));
  p.tap('openSubs');
  p.tap('capVisible', true);
  assert.equal(p.polls(), 0);
  const q = panel({...playing, subtitle_choice: undefined});
  q.tap('capVisible', true);
  assert.equal(q.polls(), 0, 'no track, nothing to show');
  assert.equal(q.view.mando.chip.label, 'Sin subtítulos');
});

test('captions are refused while busy, foreign or offline and while an apply is in flight', () => {
  const edits = [{...playing, command_pending: true}, {...playing, phase: 'loading', pending: true}, {...playing, phase: 'disconnected'}];
  for (const status of edits) {
    const p = panel(status);
    p.tap('openSubs');
    p.tap('capNudge', 100);
    assert.equal(p.view.sheet?.unapplied ?? false, false, status.phase);
  }
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 100);
  p.tap('capApply');
  p.tap('capNudge', 100);
  p.tap('capVisible', false);
  p.tap('capApply');
  assert.equal(p.view.sheet.delay.text, '+0,1 s', 'the draft is frozen while it is being applied');
  assert.equal(p.view.sheet.apply.enabled, false);
  assert.equal(p.view.sheet.visible.enabled, false);
  assert.equal(p.polls(), 1);
});

test('an Aplicar or a visibility toggle that finds the TV busy says so, sends nothing and keeps the draft', () => {
  const busy = {...subsOk('text-a', 0), ...withTracks, command_pending: true};
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.status(busy);
  assert.equal(p.posts('subtitles').length, 0);
  assert.match(p.view.problem.body, /ocupada/);
  assert.equal(p.view.sheet.unapplied, true, 'the draft survives');
  p.fire('poll');
  p.status({...subsOk('text-a', 0), ...withTracks});
  assert.equal(p.view.sheet.unapplied, true);
  assert.equal(p.view.sheet.apply.enabled, true, 'and can be applied again once the TV is free');
  const q = panel({...subsOk('text-a', 0), ...withTracks});
  q.tap('openSubs');
  q.tap('capVisible', false);
  q.status(busy);
  assert.equal(q.posts('subtitles').length, 0);
  assert.match(q.view.problem.body, /ocupada/);
  assert.equal(q.view.sheet.visible.checked, true, 'the switch goes back to what the TV shows');
});

test('a partial failure names the visibility change and keeps the draft', () => {
  const p = panel({...subsOk('text-a', 0, false), ...withTracks});
  p.tap('openSubs');
  p.tap('capTrack', 'text2-a');
  p.tap('capApply');
  p.status(subsOk('text-a', 0, false));
  p.reply(p.posted('subtitles'), {ok: false, message: 'La TV rechazó el cambio.'});
  p.status(subsOk('text-a', 0, true));
  assert.equal(p.view.sheet.apply.pending, false);
  assert.equal(p.view.sheet.unapplied, true, 'the draft is kept for a retry');
  assert.equal(p.view.sheet.apply.enabled, true);
});

test('a playback change drops the apply and the draft silently', () => {
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.status({...subsOk('text-a', 0), playback_id: 'play-b'});
  assert.equal(p.posts('subtitles').length, 0, 'nothing is sent for the old playback');
  assert.equal(p.view.sheet, null, 'the subtitle sheet cannot outlive the playback it edits');
  assert.equal(p.view.mando.chip.unapplied, false);
});

test('an apply interrupted by another sender or a lost TV fails loudly and keeps the draft', () => {
  for (const phase of ['receiver_changed', 'disconnected']) {
    const p = panel({...subsOk('text-a', 0), ...withTracks});
    p.tap('openSubs');
    p.tap('capNudge', 300);
    p.tap('capApply');
    p.status({...subsOk('text-a', 0), phase});
    assert.equal(p.view.mando.chip.unapplied, true, phase);
    assert.equal(p.posts('subtitles').length, 0, phase);
  }
});

test('an apply that the TV never confirms ends instead of hanging the sheet', () => {
  const p = panel(subsOk('text-a', 0));
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.status(subsOk('text-a', 0));
  p.reply(p.posted('subtitles'));
  p.status(subsOk('text-a', 0));
  for (let i = 0; i < 8 && p.view.sheet.apply.pending; i++) { p.fire('poll'); p.status(subsOk('text-a', 0)); }
  assert.equal(p.view.sheet.apply.pending, false);
  assert.equal(p.view.sheet.unapplied, true);
});

test('a later command voids an apply that was waiting for its verification poll', () => {
  const p = panel(subsOk('text-a', 0));
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.tap('mute');
  p.status({...subsOk('text-a', 0)});
  assert.equal(p.posts('subtitles').length, 0);
});

// the live Stremio picker in the subtitle sheet

const liveAddon = addonReady(2);
const liveStatus = (extra = {}) => ({...subsOk('text-a', 0), addons: {a: liveAddon}, ...extra});
const liveEntry = {id: 'ad-9', kind: 'addon', label: 'Español · Alpha.es.srt', language: 'spa', supported: true, reason: null};

test('the live sheet pulls offers for the active catalogue and a downloaded subtitle becomes the draft', () => {
  const p = panel(liveStatus());
  p.tap('openSubs');
  assert.deepEqual(p.posted('subtitle_offers').body, {source_id: 'a', catalogue_id: 'cat-a'});
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  assert.equal(p.view.sheet.stremio.match, 'Coincidencia: Alpha (2020)');
  p.tap('stremioUse');
  p.reply(p.posted('subtitle_fetch'), {ok: true, body: {entry: liveEntry, catalogue: catalogue('a', liveAddon, [liveEntry])}});
  assert.match(p.view.sheet.stremio.status, /Subtítulo listo: Español.*Se usará solo al aplicar/);
  assert.equal(p.view.sheet.unapplied, true);
  assert.ok(p.view.sheet.tracks.some(t => t.id === 'ad-9' && t.selected), 'the entry is in the list and chosen');
  p.tap('capApply');
  p.status(liveStatus());
  assert.equal(p.posted('subtitles').body.subtitle_id, 'ad-9', 'Aplicar sends the downloaded track');
});

test('the live block stays inert while an apply is pending', () => {
  const p = panel(liveStatus());
  p.tap('openSubs');
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  p.tap('capNudge', 300);
  p.tap('capApply');
  assert.equal(p.view.sheet.stremio.use.enabled, false);
  p.tap('stremioUse');
  assert.equal(p.posts('subtitle_fetch').length, 0);
});

test('a download finishing after the playback changed cannot become the draft', () => {
  const p = panel(liveStatus());
  p.tap('openSubs');
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  p.tap('stremioUse');
  const fetch = p.posted('subtitle_fetch');
  p.fire('poll');
  p.status({...liveStatus(), playback_id: 'play-b'});
  p.reply(fetch, {ok: true, body: {entry: liveEntry, catalogue: catalogue('a', liveAddon, [liveEntry])}});
  assert.equal(p.view.mando.chip.unapplied, false);
});

test('a late lookup receipt with an older addon revision cannot roll the live sheet back', () => {
  const p = panel(liveStatus({addons: {a: addonReady(2, {revision: 3})}}));
  p.tap('openSubs');
  p.reply(p.posted('subtitle_offers'), {ok: true, body: {...offers, revision: 3}});
  p.tap('stremioWrong');
  p.tap('stremioAlt', 0);
  p.reply(p.posted('subtitle_lookup'), {ok: true, body: {catalogue: catalogue('a', addonReady(2, {revision: 1}))}});
  assert.equal(p.view.sheet.stremio.languages.length, 2);
});

// stop

test('confirmed stop re-polls, re-checks the TV and the playback, and sends the captured playback_id', () => {
  const p = panel(playing);
  p.tap('stop');
  assert.equal(p.posts().length + p.polls(), 0, 'playing asks first');
  assert.equal(p.view.confirm.kind, 'stop');
  p.tap('confirmAccept');
  assert.equal(p.posts().length, 0, 'accepting waits for fresh status');
  p.status(playing);
  assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'});
});

test('stop consent is void for a different playback, TV or revision, or after any command in between', () => {
  const swaps = {playback: {playback_id: 'play-b'}, device: {selected_device: {...destination.selected_device, id: 'tv-b'}}, revision: {device_revision: 2}};
  for (const [name, change] of Object.entries(swaps)) {
    const p = panel(playing);
    p.tap('stop');
    p.tap('confirmAccept');
    p.status({...playing, ...change});
    assert.equal(p.posts('stop').length, 0, name);
  }
  const q = panel(playing);
  q.tap('stop');
  q.tap('confirmAccept');
  q.tap('toggle');
  q.status(playing);
  q.reply(q.posted('pause'));
  q.status({...playing, phase: 'paused'});
  assert.equal(q.posts('stop').length, 0, 'an intervening command voids the stop');
});

test('stop with Seguir viendo or Escape sends nothing', () => {
  for (const act of ['confirmCancel', 'dismiss']) {
    const p = panel(playing);
    p.tap('stop');
    p.tap(act);
    assert.equal(p.view.confirm, null);
    assert.equal(p.posts().length + p.polls(), 0, act);
  }
});

test('preparation, a foreign receiver and an error stop at once with device and playback identity', () => {
  for (const status of [{...playing, phase: 'loading', pending: true}, {...playing, phase: 'receiver_changed'}, {...playing, phase: 'disconnected'}, {...playing, phase: 'buffering', pending: true}]) {
    const p = panel(status);
    p.tap('stop');
    assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'}, status.phase);
  }
});

test('with no selected TV the stop body carries no device fields at all', () => {
  const p = panel({...playing, phase: 'disconnected', selected_device: null});
  p.tap('stop');
  assert.deepEqual(p.posted('stop').body, {playback_id: 'play-a'});
  const q = panel({...idle, phase: 'error', can_change_device: false, selected_device: null});
  q.tap('stop');
  assert.deepEqual(q.posted('stop').body, {});
});

test('stop interrupts an in-flight command and its late reply cannot overwrite cleanup', () => {
  const p = panel(playing);
  p.fire('poll');
  const stale = p.effects('poll')[0];
  p.tap('toggle');
  const pause = p.posted('pause');
  p.send({t: 'status', gen: stale.gen, seq: stale.seq, ok: true, raw: fixture({...playing, phase: 'loading', pending: true})});
  p.pending.splice(p.pending.indexOf(stale), 1);
  assert.equal(p.view.mando.board.state, 'REPRODUCIENDO');
  p.tap('stop');
  assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'}, 'busy: immediate, no confirm, and the bridge still sees which playback to stop');
  p.reply(pause);
  assert.equal(p.posts('pause').length + p.posts('resume').length, 0);
  p.reply(p.posted('stop'));
  p.status({...idle, phase: 'stopped', title: 'Alpha', source_id: 'a'});
  assert.equal(p.view.mode, 'preparar');
});

test('stopping drops a pending apply, seek and Start along with the open sheet', () => {
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.tap('stop');
  p.tap('confirmAccept');
  p.status(subsOk('text-a', 0));
  p.status(subsOk('text-a', 0));
  assert.equal(p.posts('subtitles').length, 0, 'stop wins over the apply waiting for the same poll');
  assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'});
  assert.equal(p.view.sheet, null);
  assert.equal(p.view.mando.chip.unapplied, true, 'the draft is not the stop\'s business');
});

test('receiver_changed and disconnected leave only Detener', () => {
  for (const phase of ['receiver_changed', 'disconnected']) {
    const p = panel({...playing, phase});
    const m = p.view.mando;
    assert.deepEqual([m.toggle.enabled, m.back.enabled, m.forward.enabled, m.track.enabled, m.volume.enabled, m.mute.enabled, m.chip.enabled, m.change.enabled], new Array(8).fill(false), phase);
    assert.equal(m.stop.enabled, true, phase);
    p.tap('openChange');
    p.tap('openSubs');
    assert.equal(p.view.sheet, null, phase);
    assert.equal(p.view.plan.primary.enabled, false, phase);
  }
});

test('an unknown phase fails closed: nothing is startable and only Detener works', () => {
  const p = panel({...playing, phase: 'warp-drive'});
  assert.equal(p.view.mode, 'mando');
  assert.equal(p.view.mando.toggle.enabled, false);
  assert.equal(p.view.mando.stop.enabled, true);
  assert.equal(p.view.plan.primary.enabled, false);
  p.tap('stop');
  assert.ok(p.posted('stop'));
});

test('offline keeps the board, marks it unconfirmed and disables every unsafe action', () => {
  const p = panel(playing);
  offline(p);
  const m = p.view.mando;
  assert.equal(m.board.title, 'Alpha');
  assert.equal(m.board.state, 'SIN CONFIRMAR');
  assert.deepEqual([m.toggle.enabled, m.track.enabled, m.volume.enabled, m.chip.enabled, m.stop.enabled], [false, false, false, false, false]);
  p.tap('toggle');
  p.tap('stop');
  assert.equal(p.posts().length, 0);
  p.fire('poll');
  p.status(playing);
  assert.equal(p.view.mando.toggle.enabled, true, 'back online, back in control');
});

test('the board glyph follows the phase, not the copy: play, pause, spinner while waiting, none otherwise or when unconfirmed', () => {
  const glyph = status => panel(status).view.mando.board.glyph;
  assert.equal(glyph(playing), 'play');
  assert.equal(glyph({...playing, phase: 'paused'}), 'pause');
  for (const phase of ['preparing', 'buffering', 'loading']) assert.equal(glyph({...playing, phase, pending: true}), 'spinner', phase);
  for (const phase of ['receiver_changed', 'disconnected']) assert.equal(glyph({...playing, phase}), null, phase);
  assert.equal(glyph({...playing, phase: 'error', can_change_device: false}), null);
  const p = panel(playing);
  offline(p);
  assert.equal(p.view.mando.board.glyph, null, 'a state we cannot confirm shows no glyph');
});

test('one Detener at a time: a problem block that offers it takes the header\'s place, in Mando and in the Más sheet', () => {
  const header = status => panel(status).view.mando.stop;
  assert.deepEqual(header(playing), {enabled: true, shown: true});
  const error = {...playing, phase: 'error', can_change_device: false, message: 'Falló'};
  for (const status of [error, {...playing, phase: 'receiver_changed'}, {...playing, phase: 'disconnected'}, {...playing, phase: 'wat'}]) {
    const v = panel(status).view;
    assert.equal(v.problem.action.act, 'stop', status.phase);
    assert.equal(v.mando.stop.shown, false, `${status.phase}: the problem block already offers Detener`);
    assert.equal(v.mando.stop.enabled, v.problem.action.enabled);
  }
  const notice = panel({...playing, action_error: 'Algo.', action_error_revision: 1}).view;
  assert.equal(notice.problem.action.act, 'dismissNotice');
  assert.equal(notice.mando.stop.shown, true, 'a notice has no Detener, so the header keeps its own');
  const p = panel(error);
  p.tap('openMore');
  assert.equal(p.view.sheet.stop.shown, false, 'the sheet shows the problem block with Detener, not a second one');
  const q = panel(playing);
  q.tap('openMore');
  assert.equal(q.view.sheet.stop.shown, true);
});

test('waiting has shape: a spinner in the key, the TV by name and Cancelar, which is stop', () => {
  for (const phase of ['preparing', 'buffering', 'loading']) {
    const p = panel({...playing, phase, pending: true, message: null});
    const m = p.view.mando;
    assert.deepEqual([m.toggle.icon, m.toggle.enabled, m.waiting.text, m.waiting.cancel.enabled], ['spinner', false, 'Esperando a Sala · Chromecast', true], phase);
    p.tap('toggle');
    assert.equal(p.posts('resume').length + p.posts('pause').length, 0);
    p.tap('stop');
    assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'}, phase);
  }
  assert.equal(panel(playing).view.mando.waiting, null);
});

test('a command racing the TV\'s own busy state is refused locally, as the real bridge would with a 409', () => {
  const p = panel({...playing, command_pending: true});
  p.tap('toggle');
  p.tap('skip', 30);
  p.tap('mute');
  assert.equal(p.posts().length + p.effects('timer').filter(t => t.name === 'skip').length, 0);
  assert.equal(p.view.mando.toggle.icon, 'spinner');
});

test('the remote stays keyed to one playback: a new playback starts with idle seek and no draft', () => {
  const p = panel(playing);
  p.tap('dragSeek', 200);
  p.tap('skip', 30);
  p.fire('poll');
  p.status({...playing, playback_id: 'play-b'});
  assert.equal(p.view.mando.badge, null);
  assert.equal(p.view.mando.track.preview, null);
});

// ───────── ui: layers, errors, notices, focus; and reconcile

const stopped = {...idle, phase: 'stopped', title: 'Alpha', source_id: 'a'};
const stopFromPlaying = p => { p.tap('stop'); p.tap('confirmAccept'); p.status(playing); p.settle('stop', stopped); };

test('Detener returns to Preparar with the movie and the TV still chosen and a dismissible notice', () => {
  const p = panel(subsOk('text-a', 0));
  stopFromPlaying(p);
  assert.equal(p.view.mode, 'preparar');
  assert.deepEqual([p.view.problem.kind, p.view.problem.title, p.view.problem.action.act], ['stopped', 'Película detenida en Sala · Chromecast', 'dismissNotice']);
  assert.equal(p.view.destination.label, 'Sala · Chromecast', 'the TV is still selected server-side');
  assert.equal(p.view.plan.sources.find(r => r.selected)?.id, 'a', 'the movie is seeded from what the bridge kept');
  assert.equal(p.view.plan.branches.find(b => b.selected).id, 'none', 'the subtitle decision starts over');
  p.reply(p.posted('catalogue'), {ok: true, body: {catalogue: catalogue('a')}});
  assert.equal(p.view.plan.primary.enabled, true, 'one tap to start again');
  p.tap('dismissNotice');
  assert.equal(p.view.problem, null);
});

test('the stopped notice needs our Stop: a movie that ended or a failed stop says nothing', () => {
  const ended = panel(playing);
  ended.fire('poll');
  ended.status({...idle, phase: 'ended', title: 'Alpha', source_id: 'a'});
  assert.equal(ended.view.mode, 'preparar');
  assert.equal(ended.view.problem, null);
  const failed = panel({...playing, phase: 'loading', pending: true});
  failed.tap('stop');
  failed.settle('stop', {...playing, phase: 'loading', pending: true}, {ok: false, code: 'busy', message: 'Ocupado.'});
  failed.fire('poll');
  failed.status({...stopped});
  assert.equal(failed.view.problem?.kind === 'stopped', false);
});

test('re-seeding falls back to the last movie we owned when the bridge did not keep the source id', () => {
  const p = panel(playing);
  p.tap('stop');
  p.tap('confirmAccept');
  p.status(playing);
  p.settle('stop', {...stopped, source_id: null});
  assert.equal(p.view.plan.sources.find(r => r.selected)?.id, 'a');
});

test('a local error shows once, is cleared by the next command, and dismiss clears it', () => {
  const p = panel(playing);
  p.tap('toggle');
  p.settle('pause', {...playing, command_pending: true}, {ok: false, code: 'busy', message: 'La TV está ocupada.'});
  assert.deepEqual([p.view.problem.kind, p.view.problem.body], ['notice', 'La TV está ocupada.']);
  p.tap('dismissNotice');
  assert.equal(p.view.problem, null);
  p.tap('toggle');
  p.fire('poll');
  p.status(playing);
  p.tap('toggle');
  p.settle('pause', {...playing, command_pending: true}, {ok: false, timeout: true});
  assert.equal(p.view.problem.body, 'La acción tardó demasiado. Revisá el estado antes de reintentar.');
  p.fire('poll');
  p.status(playing);
  p.tap('toggle');
  assert.equal(p.view.problem, null, 'a new command clears the old message');
});

test('the same backend error text with a new revision shows again; stable polls stay dismissed', () => {
  const failing = revision => ({...playing, action_error: 'La TV no respondió.', action_error_revision: revision});
  const p = panel(failing(1));
  assert.equal(p.view.problem.body, 'La TV no respondió.');
  p.tap('dismissNotice');
  assert.equal(p.view.problem, null);
  for (let i = 0; i < 3; i++) { p.fire('poll'); p.status(failing(1)); }
  assert.equal(p.view.problem, null, 'dismissal persists across polls');
  p.fire('poll');
  p.status(failing(2));
  assert.equal(p.view.problem.body, 'La TV no respondió.');
});

test('a new backend error is the latest word: it replaces a local message', () => {
  const p = panel(playing);
  p.tap('toggle');
  p.settle('pause', playing, {ok: false, message: 'Local.'});
  assert.equal(p.view.problem.body, 'Local.');
  p.fire('poll');
  p.status({...playing, action_error: 'Del servidor.', action_error_revision: 1});
  assert.equal(p.view.problem.body, 'Del servidor.');
});

test('there is exactly one problem block per state, in priority order, hosted in the open sheet', () => {
  const states = {
    offline: [null, 'offline'], unknown: [{...playing, phase: 'warp'}, 'unknown'], foreign: [{...playing, phase: 'receiver_changed'}, 'foreign'],
    disconnected: [{...playing, phase: 'disconnected'}, 'disconnected'], failed: [{...idle, phase: 'error', message: 'Falló la lectura.'}, 'failed'],
    notice: [{...playing, action_error: 'Algo.', action_error_revision: 1}, 'notice'],
  };
  for (const [name, [status, kind]] of Object.entries(states)) {
    const p = panel(status ?? playing);
    if (!status) offline(p);
    assert.equal(p.view.problem.kind, kind, name);
    assert.equal(p.view.problem.host, 'page', name);
  }
  const both = panel({...playing, phase: 'receiver_changed', action_error: 'Algo.', action_error_revision: 1});
  assert.equal(both.view.problem.kind, 'foreign', 'the stronger problem wins; the error is not shown beside it');
  const p = panel(playing);
  p.tap('openMore');
  p.fire('poll');
  p.status({...playing, action_error: 'Algo.', action_error_revision: 1});
  assert.equal(p.view.problem.host, 'sheet');
});

test('foreign, disconnected and unknown offer only Detener, with the wording each deserves', () => {
  const copy = {receiver_changed: ['Hay otro contenido en la TV', 'Detener y volver a elegir'], disconnected: ['TV no disponible', 'Detener'], warp: ['Estado desconocido de la TV', 'Detener']};
  for (const [phase, [title, label]] of Object.entries(copy)) {
    const p = panel({...playing, phase});
    assert.deepEqual([p.view.problem.title, p.view.problem.action.label, p.view.problem.action.act, p.view.problem.action.enabled], [title, label, 'stop', true], phase);
  }
  const off = panel(playing);
  offline(off);
  assert.equal(off.view.problem.title, 'Sin conexión con el puente');
  assert.equal(off.view.problem.action, null);
});

test('a phase of error with a locked TV stays in Mando with Detener; otherwise Preparar shows the problem', () => {
  const locked = panel({...playing, phase: 'error', can_change_device: false, message: 'La TV rechazó el archivo.'});
  assert.equal(locked.view.mode, 'mando');
  assert.deepEqual([locked.view.problem.kind, locked.view.problem.body, locked.view.problem.action.act], ['failed', 'La TV rechazó el archivo.', 'stop']);
  const free = panel({...idle, phase: 'error', message: 'No se pudo preparar.'});
  assert.equal(free.view.mode, 'preparar');
  assert.deepEqual([free.view.problem.kind, free.view.problem.action], ['failed', null]);
});

test('a worker failure after a 202 start arrives as the backend error and the plan stays', () => {
  const p = panel(idle);
  choose(p);
  p.tap('start');
  p.status(idle);
  p.settle('start', {...idle, action_error: 'La TV rechazó la película.', action_error_revision: 3});
  assert.equal(p.view.problem.kind, 'notice');
  assert.equal(p.view.problem.body, 'La TV rechazó la película.');
  assert.equal(p.view.plan.primary.enabled, true, 'the choice is intact: a retry is one tap');
});

test('a 409 busy answer to start is shown and does not leave the page waiting', () => {
  const p = panel(idle);
  choose(p);
  p.tap('start');
  p.status(idle);
  p.settle('start', {...idle, command_pending: true}, {ok: false, code: 'busy', message: 'La TV está ocupada.'});
  assert.equal(p.view.problem.body, 'La TV está ocupada.');
  p.fire('poll');
  p.status(idle);
  assert.equal(p.view.plan.primary.enabled, true);
  assert.equal(p.view.plan.primary.label, 'Iniciar en Sala (Chromecast)');
});

test('a destination change during Start says so', () => {
  const p = panel(idle);
  choose(p);
  p.tap('start');
  p.status({...idle, device_revision: 2});
  assert.equal(p.view.problem.body, 'El destino cambió. Revisá la TV y volvé a intentar.');
});

test('a stale or changed track list during Start says so and sends nothing', () => {
  const p = panel(idle);
  choose(p);
  p.tap('subsBranch', 'file');
  p.tap('pickEntry', 'text-a');
  p.tap('start');
  p.status({...idle, catalogues: {a: {state: 'loading', analysis_id: 'x'}}});
  assert.equal(p.posts('start').length, 0);
  assert.match(p.view.problem.body, /La lista de subtítulos cambió/);
});

test('a stop that finds another playback says so and sends nothing', () => {
  const p = panel(playing);
  p.tap('stop');
  p.tap('confirmAccept');
  p.status({...playing, playback_id: 'play-z'});
  assert.equal(p.view.problem.body, 'La TV cambió o hay otra sesión. Revisá antes de detener.');
  assert.equal(p.posts('stop').length, 0);
});

test('an open stop confirm closes with a message when the playback changes under it', () => {
  for (const change of [{playback_id: 'play-z'}, {device_revision: 2}]) {
    const p = panel(playing);
    p.tap('stop');
    assert.equal(p.view.confirm.kind, 'stop');
    p.fire('poll');
    p.status({...playing, ...change});
    assert.equal(p.view.confirm, null, JSON.stringify(change));
    assert.equal(p.view.problem.body, 'La TV cambió o hay otra sesión. Revisá antes de detener.');
    p.tap('confirmAccept');
    assert.equal(p.posts('stop').length, 0);
    assert.equal(p.polls(), 0, 'nothing waits to stop the new playback');
  }
});

test('a partial caption failure names the visibility change and keeps the draft', () => {
  const hidden = {...subsOk('text-a', 0, false), ...withTracks};
  const p = panel(hidden);
  p.tap('openSubs');
  p.tap('capTrack', 'text2-a');
  p.tap('capNudge', 400);
  p.tap('capApply');
  p.status(hidden);
  p.reply(p.posted('subtitles'), {ok: false, message: 'La TV rechazó el cambio.'});
  p.status({...subsOk('text-a', 0, true), ...withTracks});
  assert.equal(p.view.problem.host, 'sheet');
  assert.equal(p.view.problem.body, 'La visibilidad ya cambió; la sincronía sigue sin confirmar. La TV rechazó el cambio. Tu ajuste sigue en borrador.');
  assert.equal(p.view.sheet.unapplied, true);
});

test('a rejected delay change does not claim visibility changed when it was already hidden', () => {
  const hidden = {...subsOk('text-a', 0, false), ...withTracks};
  const p = panel(hidden);
  p.tap('openSubs');
  p.tap('capNudge', 400);
  p.tap('capApply');
  p.status(hidden);
  p.reply(p.posted('subtitles'), {ok: false, message: 'La TV rechazó el cambio.'});
  p.status(hidden);
  assert.equal(p.view.problem.body, 'La TV rechazó el cambio. Tu ajuste sigue en borrador.');
});

test('a backend error while an apply is pending is shown once, as the apply failure, and stays dismissed', () => {
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 400);
  p.tap('capApply');
  p.status(subsOk('text-a', 0));
  p.reply(p.posted('subtitles'));
  p.status({...subsOk('text-a', 0), action_error: 'No se pudo cambiar el subtítulo.', action_error_revision: 7});
  assert.equal(p.view.problem.body, 'No se pudo cambiar el subtítulo. Tu ajuste sigue en borrador.');
  p.tap('dismissNotice');
  assert.equal(p.view.problem, null, 'the same error is not shown again behind the failure');
  p.fire('poll');
  p.status({...subsOk('text-a', 0), action_error: 'No se pudo cambiar el subtítulo.', action_error_revision: 7});
  assert.equal(p.view.problem, null);
});

test('a backend error that arrives while an apply is waiting does not show behind it', () => {
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 400);
  p.tap('capApply');
  p.status({...subsOk('text-a', 0), action_error: 'Otra cosa.', action_error_revision: 9});
  assert.equal(p.view.sheet.apply.pending, true);
  assert.equal(p.view.problem, null, 'suppressed while the apply is pending');
});

// scenario, layers, focus

test('a demo scenario posts only when the server says it is the demo; production has no demo block', () => {
  const prod = panel(playing);
  prod.tap('scenario', 'error');
  assert.equal(prod.posts().length, 0);
  assert.equal(prod.view.demo, null);
  const demo = panel({...playing, demo: true, scenario: 'ready'});
  assert.deepEqual(demo.view.demo, {scenario: 'ready'});
  demo.tap('scenario', 'error');
  assert.deepEqual(demo.posted('scenario').body, {state: 'error'});
});

test('Escape closes only the top layer: a confirm over the Cambiar película sheet leaves the sheet', () => {
  const p = panel(playing);
  p.tap('openChange');
  choose(p, 'b');
  p.tap('start');
  assert.equal(p.view.confirm.kind, 'replace');
  assert.equal(p.view.sheet.kind, 'change');
  p.tap('dismiss');
  assert.deepEqual([p.view.confirm, p.view.sheet.kind], [null, 'change']);
  p.tap('dismiss');
  assert.equal(p.view.sheet, null);
  assert.equal(p.view.plan.sources.some(r => r.selected), false, 'closing the sheet drops the draft');
});

test('opening Cambiar película starts from an empty plan; a confirmed start closes it only on success', () => {
  const p = panel(playing);
  p.tap('openChange');
  assert.equal(p.view.plan.sources.some(r => r.selected), false);
  choose(p, 'b');
  p.tap('start');
  p.tap('confirmAccept');
  p.status(playing);
  p.settle('start', playing, {ok: false, code: 'unavailable_destination', message: 'La TV no está disponible.'});
  assert.equal(p.view.sheet.kind, 'change', 'a failed start leaves the sheet for another try');
  assert.equal(p.view.problem.host, 'sheet');
  p.tap('start');
  p.tap('confirmAccept');
  p.fire('poll');
  p.status(playing);
  p.settle('start', {...playing, source_id: 'b', title: 'Beta'});
  assert.equal(p.view.sheet, null);
});

test('layers cannot outlive the permission that opened them', () => {
  const change = panel(playing);
  change.tap('openChange');
  change.fire('poll');
  change.status({...playing, phase: 'receiver_changed'});
  assert.equal(change.view.sheet, null, 'a foreign receiver closes the change sheet');
  const more = panel(playing);
  more.tap('openMore');
  more.fire('poll');
  more.status(stopped);
  assert.equal(more.view.sheet, null, 'there is no Más without a playback');
  const replace = panel(playing);
  replace.tap('openChange');
  choose(replace, 'b');
  replace.tap('start');
  replace.fire('poll');
  replace.status({...playing, phase: 'disconnected'});
  assert.equal(replace.view.confirm, null, 'no replacement question for a TV we do not control');
  const stopAsk = panel(playing);
  stopAsk.tap('stop');
  stopAsk.fire('poll');
  stopAsk.status(stopped);
  assert.equal(stopAsk.view.confirm, null, 'nothing left to stop');
  const subs = panel(playing);
  subs.tap('openSubs');
  subs.fire('poll');
  subs.status({...playing, phase: 'receiver_changed'});
  assert.equal(subs.view.sheet, null);
  subs.tap('openSubs');
  assert.equal(subs.view.sheet, null, 'and it cannot be reopened');
});

test('a confirm blocks opening another layer', () => {
  const p = panel(playing);
  p.tap('stop');
  p.tap('openMore');
  p.tap('openSubs');
  p.tap('openChange');
  assert.equal(p.view.sheet, null);
});

test('focus returns to the control once the command settles, only if the user has not touched anything since', () => {
  const p = panel(playing);
  p.tap('toggle', undefined, 'toggle', 5);
  assert.deepEqual(p.view.restoring, {ref: 'toggle', n: 5});
  assert.equal(p.effects('focus').length, 0, 'not while the command is in flight');
  p.reply(p.posted('pause'));
  p.status({...playing, phase: 'paused'});
  assert.deepEqual(p.effects('focus').map(f => [f.ref, f.n]), [['toggle', 5]]);
  assert.equal(p.view.restoring, null);
  const q = panel(playing);
  q.tap('toggle', undefined, 'toggle', 5);
  q.tap('openMore', undefined, 'open-more', 6);
  q.reply(q.posted('pause'));
  q.status({...playing, phase: 'paused'});
  assert.equal(q.effects('focus').length, 0, 'the user moved on: no focus is stolen');
});

test('a skip restores focus to the control that started it, when its command settles', () => {
  const p = panel(playing);
  p.tap('skip', 30, 'forward', 3);
  p.send({t: 'timer', name: 'skip', ticket: p.effects('timer').filter(t => t.name === 'skip').pop().ticket});
  p.settle('seek', {...playing, absolute_time: 80});
  assert.deepEqual(p.effects('focus').map(f => f.ref), ['forward']);
});

test('standing rules are idempotent: a message that changes nothing produces no effects', () => {
  const p = panel(playing);
  p.tap('openSubs');
  p.pending.length = 0;
  const before = p.view;
  for (let i = 0; i < 3; i++) p.send({t: 'nothing', at: 20});
  assert.deepEqual(p.pending, []);
  assert.deepEqual(p.view, before);
});

test('the flap clock timer is armed once while playing and re-armed after each tick, never while paused', () => {
  const p = panel(playing);
  assert.equal(p.effects('timer').filter(t => t.name === 'clock').length, 1);
  p.send({t: 'timer', name: 'nothing', ticket: 0});
  assert.equal(p.effects('timer').filter(t => t.name === 'clock').length, 1, 'not armed twice');
  p.fire('clock');
  assert.equal(p.effects('timer').filter(t => t.name === 'clock').length, 1, 're-armed after the tick');
  const q = panel(paused);
  assert.equal(q.effects('timer').filter(t => t.name === 'clock').length, 0);
});

// ───────── keyboard and the View contract

const key = (p, k, extra = {}) => p.Panel.keyMsg(p.view, {key: k, mods: false, repeat: false, typing: false, onButton: false, idle: true, n: 0, ...extra});

test('keys: Space, arrows and M drive the remote; Z and X nudge the subtitle draft', () => {
  const p = panel(playing);
  assert.deepEqual(plain(key(p, ' ')), {t: 'toggle'});
  assert.deepEqual(plain(key(p, 'ArrowLeft')), {t: 'skip', arg: -30});
  assert.deepEqual(plain(key(p, 'ArrowRight')), {t: 'skip', arg: 30});
  assert.deepEqual(plain(key(p, 'M')), {t: 'mute'});
  assert.deepEqual(plain(key(p, 'z')), {t: 'capNudge', arg: -100});
  assert.deepEqual(plain(key(p, 'x')), {t: 'capNudge', arg: 100});
  assert.equal(key(p, 'q'), null);
});

test('keys stay off while typing, with a modifier, held down, or when Space belongs to a button', () => {
  const p = panel(playing);
  assert.equal(key(p, ' ', {typing: true}), null);
  assert.equal(key(p, 'ArrowLeft', {typing: true}), null);
  assert.equal(key(p, 'm', {mods: true}), null);
  assert.equal(key(p, 'ArrowRight', {repeat: true}), null);
  assert.equal(key(p, ' ', {onButton: true}), null, 'the button activates itself once');
});

test('keys stay off in Preparar and while a confirm or any sheet except the subtitle sheet is open', () => {
  const prep = panel(idle);
  for (const k of [' ', 'ArrowLeft', 'm', 'z']) assert.equal(key(prep, k), null);
  const p = panel(playing);
  p.tap('stop');
  for (const k of [' ', 'ArrowLeft', 'm', 'z']) assert.equal(key(p, k), null, 'confirm open');
  p.tap('confirmCancel');
  p.tap('openMore');
  for (const k of [' ', 'ArrowLeft', 'm', 'z', 'x']) assert.equal(key(p, k), null, 'Más open');
  p.tap('closeSheet');
  p.tap('openSubs');
  assert.equal(key(p, ' '), null);
  assert.equal(key(p, 'ArrowLeft'), null);
  assert.deepEqual(plain(key(p, 'x')), {t: 'capNudge', arg: 100}, 'sync keys keep working while the subtitle sheet is open');
});

test('Z and X open the subtitle sheet when captions are available and nudge the draft; without captions they do nothing', () => {
  const p = panel(subsOk('text-a', 0));
  p.send(key(p, 'x'));
  assert.equal(p.view.sheet.kind, 'subs');
  assert.equal(p.view.sheet.delay.text, '+0,1 s');
  p.send(key(p, 'x'));
  assert.equal(p.view.sheet.delay.text, '+0,2 s');
  const q = panel({...playing, phase: 'receiver_changed'});
  assert.equal(key(q, 'z'), null, 'a foreign receiver has no captions to nudge');
  const r = panel({...playing, phase: 'loading', pending: true});
  r.send({t: 'capNudge', arg: 100});
  assert.equal(r.view.sheet?.unapplied ?? false, false, 'busy: the key does not open or edit anything');
});

test('while focus is being restored, arrows and Space are swallowed and are not a seek', () => {
  const p = panel(playing);
  p.tap('toggle', undefined, 'toggle', 4);
  assert.equal(key(p, 'ArrowRight', {n: 4}), 'swallow');
  assert.equal(key(p, ' ', {n: 4}), 'swallow');
  assert.deepEqual(plain(key(p, 'ArrowRight', {n: 5})), {t: 'skip', arg: 30}, 'a later interaction ends the restore');
  assert.deepEqual(plain(key(p, 'ArrowRight', {n: 4, idle: false})), {t: 'skip', arg: 30}, 'focus is somewhere on purpose');
  p.send(key(p, 'ArrowRight', {n: 4}) === 'swallow' ? {t: 'nothing'} : {t: 'skip', arg: 30});
  assert.equal(p.posts('seek').length + p.effects('timer').filter(t => t.name === 'skip').length, 0);
});

test('the view is plain JSON data and every action it names is a known message', () => {
  const states = {
    offline: panel(null), preparar: panel(idle), mando: panel(playing), waiting: panel({...playing, phase: 'loading', pending: true}),
    foreign: panel({...playing, phase: 'receiver_changed'}), error: panel({...playing, action_error: 'Algo.', action_error_revision: 1}),
  };
  const subs = panel(playing); subs.tap('openSubs'); states.subs = subs;
  const more = panel(playing); more.tap('openMore'); states.more = more;
  const change = panel(playing); change.tap('openChange'); states.change = change;
  const confirm = panel(playing); confirm.tap('stop'); states.confirm = confirm;
  for (const [name, p] of Object.entries(states)) {
    const v = p.view;
    assert.deepEqual(Object.keys(v).sort(), ['confirm', 'demo', 'destination', 'mando', 'mode', 'plan', 'problem', 'restoring', 'sheet', 'wake'], name);
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v, `${name}: nothing is lost in JSON, so nothing is a function or undefined`);
    assert.equal(v.wake, v.mode === 'mando', name);
    assert.equal(v.mando === null, v.mode === 'preparar', name);
    if (v.mando) assert.deepEqual(Object.keys(v.mando.board).sort(), ['clock', 'glyph', 'room', 'state', 'title'], name);
    if (v.problem?.action) assert.ok(Object.hasOwn(states.mando.Panel.ACTS, v.problem.action.act), name);
  }
  assert.equal(states.subs.view.sheet.kind, 'subs');
  assert.equal(states.more.view.sheet.kind, 'more');
  assert.equal(states.change.view.sheet.kind, 'change');
  assert.equal(states.confirm.view.confirm.kind, 'stop');
});

test('every message the page can send is a handler in ACTS; an unknown or inherited name does nothing', () => {
  const {Panel} = load();
  const names = ['pickSource', 'refreshSources', 'pickDevice', 'refreshDevices', 'refreshCatalogue', 'subsBranch', 'pickEntry', 'filePicked',
    'stremioLanguage', 'stremioVersion', 'stremioUse', 'stremioRetry', 'stremioWrong', 'stremioAlt', 'stremioSearch', 'start',
    'toggle', 'skip', 'dragSeek', 'dropSeek', 'seekAbandon', 'volumePreview', 'volume', 'mute', 'stop', 'openSubs', 'openMore', 'openChange',
    'capTrack', 'capVisible', 'capNudge', 'capReset', 'capApply', 'capDiscard', 'exactInput', 'gotoTime',
    'closeSheet', 'dismiss', 'confirmAccept', 'confirmCancel', 'dismissNotice', 'scenario'];
  for (const name of names) assert.equal(typeof Panel.ACTS[name], 'function', name);
  assert.deepEqual(Object.keys(Panel.ACTS).sort(), [...names].sort(), 'no handler without a name in the contract');
  const p = panel(playing);
  for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nothing']) p.send({t});
  assert.deepEqual(p.pending.filter(e => e.fx === 'post'), []);
});

test('the core reads no document, fetch, timer, storage or token; the token placeholder lives only in the markup', () => {
  const src = fs.readFileSync('player.js', 'utf8');
  const core = src.slice(0, src.indexOf('return {init, step, view'));
  for (const banned of ['document.', 'fetch(', 'setTimeout', 'setInterval', 'localStorage', 'navigator.', 'window.', '__TOKEN__']) assert.equal(core.includes(banned), false, banned);
  assert.equal(src.includes('__TOKEN__'), false);
  assert.equal(fs.readFileSync('player.html', 'utf8').split('__TOKEN__').length - 1, 1);
  assert.match(fs.readFileSync('player.html', 'utf8'), /const token='__TOKEN__';/);
});
