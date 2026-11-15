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
