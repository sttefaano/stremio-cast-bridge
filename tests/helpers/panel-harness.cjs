const assert = require('node:assert/strict');
const {loadPanel} = require('./panel-source.cjs');

const load = () => loadPanel({TextDecoder});

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

const choose = (p, id = 'a', cat = catalogue(id)) => { p.tap('pickSource', id); p.reply(p.posted('catalogue'), {ok: true, body: {catalogue: cat}}); };
const startNow = (p, next) => { p.tap('start'); p.status(next); return p.posted('start'); };
const withCatalogue = (status, cat) => ({...status, catalogues: {[cat.source_id]: {state: 'ready', catalogue: cat}}});
const offline = p => { p.fire('poll'); p.status(null, false); };
const names = rows => rows.map(r => r.label);
const srt = text => new TextEncoder().encode(text).buffer;
const uploaded = (id = 'a') => ({entry: {id: 'up-' + id, kind: 'upload', label: 'mio.srt', language: null, supported: true, reason: null},
  catalogue: catalogue(id, addonOff, [{id: 'up-' + id, kind: 'upload', label: 'mio.srt', language: null, supported: true, reason: null}])});
const addonReady = (count = 2, extra = {}) => ({state: 'ready', revision: 1, match: {label: 'Alpha (2020)', confidence: 'high'}, message: null, count, ...extra});
const offers = {state: 'ready', revision: 1, match: {label: 'Alpha (2020)'}, message: null, count: 3, alternatives: [{id: 'tt1', title: 'Alpha Two', year: 2021}, {id: 'tt2', title: 'Alpha Three', year: null}],
  offers: [{id: 'o-es-1', language: 'spa', language_name: 'Español', label: 'Alpha.es.srt', note: '98%'}, {id: 'o-es-2', language: 'spa', language_name: 'Español', label: 'Alpha.es.2.srt', note: ''}, {id: 'o-en', language: 'eng', language_name: 'English', label: 'Alpha.en.srt', note: ''}]};
function stremioPlan(addon = addonReady()) {
  const p = panel({...idle, addons: {a: addon}});
  choose(p, 'a', catalogue('a', addon));
  p.tap('subsBranch', 'stremio');
  return p;
}
const paused = {...playing, phase: 'paused'};
const seekTo = (p, pos) => { p.tap('dragSeek', pos); p.tap('dropSeek', pos); };
const subsOk = (id, delay, enabled = true, extra = {}) => ({...playing, subtitle_delay_ms: delay, subtitles_enabled: enabled, ...extra, subtitle_choice: {catalogue_id: 'cat-a', subtitle_id: id, enabled, delay_ms: delay, label: 'x', language: 'jpn'}});
const extraTrack = [{id: 'text2-a', kind: 'embedded', label: 'English', language: 'eng', supported: true, reason: null}];
const withTracks = {extra: {a: extraTrack}};
const liveAddon = addonReady(2);
const liveStatus = (extra = {}) => ({...subsOk('text-a', 0), addons: {a: liveAddon}, ...extra});
const liveEntry = {id: 'ad-9', kind: 'addon', label: 'Español · Alpha.es.srt', language: 'spa', supported: true, reason: null};
const stopped = {...idle, phase: 'stopped', title: 'Alpha', source_id: 'a'};
const stopFromPlaying = p => { p.tap('stop'); p.tap('confirmAccept'); p.status(playing); p.settle('stop', stopped); };
const key = (p, k, extra = {}) => p.Panel.keyMsg(p.view, {key: k, mods: false, repeat: false, typing: false, onButton: false, idle: true, n: 0, ...extra});

module.exports = {load, plain, panel, addonOff, catalogue, destination, playing, fixture, idle, choose, startNow, withCatalogue, offline, names, srt, uploaded, addonReady, offers, stremioPlan, paused, seekTo, subsOk, extraTrack, withTracks, liveAddon, liveStatus, liveEntry, stopped, stopFromPlaying, key};
