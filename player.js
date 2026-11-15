// Panel core: pure data in, plain data out. It never touches document, fetch, timers, storage or `token`;
// the shell below performs effects and paints Panel.view().
const Panel = (() => {
  // ───────── wire types (server contract)
  /** @typedef {'idle'|'preparing'|'buffering'|'loading'|'playing'|'paused'|'disconnected'|'receiver_changed'|'ended'|'stopped'|'error'} Phase */
  /** @typedef {{id:string,name:string,host?:string,model?:string,available?:boolean}} Device */
  /** @typedef {{id:string,kind:'embedded'|'upload'|'addon',label:string,language:string|null,supported:boolean,reason:string|null}} Entry */
  /** @typedef {{id:string,source_id:string,duration:number,entries:Entry[],addon:{state:string,revision:number,match:{label:string,confidence:string}|null,message:string|null,count:number}}} Catalogue */
  /** @typedef {{catalogue_id:string,subtitle_id:string|null,enabled:boolean,delay_ms:number,label?:string,language?:string}} SubtitleChoice */

  // ───────── model: four sub-states, one writer section each (link*, plan*, remote*, ui*)
  /** @typedef {number} Ticket  Unique per effect. A reply is honoured only by the slot that still holds its ticket. */
  /**
   * @typedef {object} Link
   * @property {object|null} status    last APPLIED status; kept while offline
   * @property {boolean} online
   * @property {number} statusAt       msg.at of the last applied status (display clock only)
   * @property {number} generation     bumped by every command; status replies of an older generation are dropped
   * @property {number} seq            seq of the last ISSUED poll
   * @property {number} appliedSeq     seq of the last applied poll
   * @property {boolean} polling       one poll in flight
   * @property {boolean} repoll        a poll issued after now is needed as soon as the one in flight returns
   * @property {Ticket|null} pollTimer
   * @property {{ticket:Ticket,action:string,stage:'posting'|'confirming',afterSeq:number,ok:boolean|null,owner:string|null}|null} command
   */
  /**
   * @typedef {{branch:'none'}|{branch:'file'|'stremio'|'upload',entryId:string|null}} Choice  entry kind always matches the branch
   * @typedef {{s:'idle'}|{s:'loading',ticket:Ticket|null,analysisId:string|null,previousId:string|null}|{s:'error',message:string}} Load
   * @typedef {{s:'idle',filename:string,message:string}|{s:'busy',stage:'reading'|'posting',ticket:Ticket,filename:string,format:string}} Upload
   * @typedef {{sourceId:string,catalogueId:string,subtitleId:string|null,deviceId:string,deviceRevision:number}} StartSnap  captured at click
   * @typedef {{stage:'verifying',snap:StartSnap,consent:string|null,afterSeq:number}|{stage:'posting',snap:StartSnap,ticket:Ticket}} Start
   */
  /**
   * @typedef {object} Addon  Stremio state for one catalogue; holds no reference to its owner.
   * @property {object|null} listing @property {string} listingKey
   * @property {{s:'idle'}|{s:'pulling',key:string,ticket:Ticket}|{s:'failed',key:string}} pull
   * @property {string} language @property {string} offerId @property {boolean} correcting
   * @property {null|{kind:'lookup'|'fetch',ticket:Ticket,offerId?:string}} op
   * @property {{text:string,key:string}|null} message @property {string|null} lastHint @property {string[]} unreadable
   */
  /**
   * @typedef {object} Plan  What the user is assembling. Shared by Preparar and the "Cambiar película" sheet.
   * @property {string|null} sourceId @property {Catalogue|null} catalogue  monotonic per id
   * @property {Load} load @property {Choice} choice @property {Upload} upload @property {Addon} addon
   * @property {Start|null} start  written ONLY by planTouch, startAdvance, planOnCommandDone, uiConfirmAccept
   * @property {Record<'discover'|'discover_devices',{ticket:Ticket|null,error:string}>} refresh
   */
  /**
   * @typedef {{s:'idle'}|{s:'dragging',preview:number}|{s:'skipping',delta:number,ticket:Ticket,from?:string,n?:number}|{s:'sent',target:number,ticket:Ticket,sawBusy:boolean}} Seek
   * @typedef {{subtitleId:string|null,enabled:boolean,delayMs:number}} CaptionWant
   * @typedef {{kind:'plan'|'visibility',stage:'verifying'|'posting'|'reading',want:CaptionWant,catalogueId:string,afterSeq:number,ticket:Ticket|null,prevVisible:boolean|null,errorAtStart:string|null,reads:number,from?:string,n?:number}} CaptionApply
   * @typedef {{deviceId:string|undefined,deviceRevision:number|undefined,playbackId:string|null}} StopSnap
   */
  /**
   * @typedef {object} Remote  Drafts bound to ONE playback identity; reconcile replaces it when the identity changes.
   * @property {string} key @property {Seek} seek
   * @property {{draft:{subtitleId:string|null,delayMs:number}|null,apply:CaptionApply|null}} captions
   * @property {number|null} volumePreview
   * @property {null|{snap:StopSnap,afterSeq:number,generation:number}} stop  confirmed stop awaiting fresh status
   * @property {Catalogue|null} overlay  newer active catalogue learned from a lookup or download
   * @property {Addon} addon
   */
  /**
   * @typedef {object} Ui
   * @property {null|'subs'|'more'|'change'} sheet
   * @property {null|{kind:'replace',snap:StartSnap,consent:string,title:string}|{kind:'stop',snap:StopSnap}} confirm
   * @property {{local:string|null,observed:string|null,dismissed:string|null,absorbed:string|null}} errors  identities are `${rev}:${text}`
   * @property {{ref:string,n:number}|null} focus  control to refocus once the command settles
   * @property {boolean} stoppedNotice @property {{text:string,error:string}} exact
   * @property {'preparar'|'mando'|null} mode @property {boolean} reseed @property {Ticket|null} clock
   * @property {string|null} lastSourceId @property {string} lastDeviceLabel
   */
  /** @typedef {{link:Link,plan:Plan,remote:Remote,ui:Ui,prefs:{lastDeviceId:string|null,autoSelectTried:boolean},nextTicket:number,now:number}} Model */

  // ───────── constants and pure helpers
  const POLL_MS = 1500, SKIP_MS = 600, CLOCK_MS = 250, SETTLE_S = 2, CLOCK_CAP_S = 2, SKIP_S = 30, MAX_UPLOAD = 1024 * 1024;
  const PLAYBACK_ACTIONS = ['start', 'pause', 'resume', 'seek', 'stop', 'volume', 'mute', 'subtitles'];
  const WAITING = ['preparing', 'buffering', 'loading'], LIVE = ['playing', 'paused'], FOREIGN = ['receiver_changed', 'disconnected'];
  const KNOWN = new Set(['idle', 'stopped', 'ended', 'error', ...WAITING, ...LIVE, ...FOREIGN]);
  const NO_STATUS = Object.freeze({phase: 'idle', sources: []});
  const KIND_OF_BRANCH = {file: 'embedded', stremio: 'addon', upload: 'upload'};
  const finite = Number.isFinite;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function formatTime(value) {
    if (!finite(value)) return '—';
    const n = Math.max(0, Math.floor(value)), h = Math.floor(n / 3600);
    return `${h ? h + ':' + String(Math.floor(n / 60) % 60).padStart(2, '0') : Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  }
  function parseTime(value) {
    if (typeof value !== 'string' || !/^\d{1,3}:\d{2}(:\d{2})?$/.test(value.trim())) return null;
    const parts = value.trim().split(':').map(Number);
    if (parts.slice(1).some(n => n >= 60)) return null;
    return parts.reduce((a, n) => a * 60 + n, 0);
  }
  /** '+0,4 s' with U+2212 for negatives; '—' when unknown. */
  function signedSeconds(ms) {
    return finite(ms) ? `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(1).replace('.', ',')} s` : '—';
  }
  function delayMeaning(ms) {
    if (!ms) return 'Sincronizados con la voz';
    return `Aparecen ${(Math.abs(ms) / 1000).toFixed(1).replace('.', ',')} s ${ms > 0 ? 'después que' : 'antes que'} la voz`;
  }
  /** Always name + model so two "Sala" TVs differ. `paren` gives the button form 'Sala (Google TV)'. */
  function deviceLabel(d, paren = false) {
    if (!d) return '';
    return d.model ? (paren ? `${d.name} (${d.model})` : `${d.name} · ${d.model}`) : d.name;
  }
  const errorIdentity = s => s?.action_error ? `${s.action_error_revision || 0}:${s.action_error}` : null;
  const playbackKey = s => JSON.stringify([s?.selected_device?.id ?? null, s?.device_revision ?? null, s?.source_id ?? null, s?.playback_id ?? null, s?.active_catalogue?.id ?? null]);
  /** null unless a movie is on the TV; else what a replacement consent was given for. */
  const replacementIdentity = s => LIVE.includes(s.phase)
    ? JSON.stringify([s.selected_device?.id ?? null, s.device_revision ?? null, s.source_id ?? null, s.playback_id ?? null, s.session ?? null, s.subtitle_choice ?? null]) : null;
  const parseStatus = raw => raw && typeof raw === 'object' && typeof raw.phase === 'string' && Array.isArray(raw.sources) ? raw : null;
  const addonRevision = c => c?.addon?.revision ?? 0;
  /** True when `a` carries strictly more than `b` for the same catalogue id. */
  const richer = (a, b) => a.entries.length >= b.entries.length && addonRevision(a) >= addonRevision(b)
    && (a.entries.length > b.entries.length || addonRevision(a) > addonRevision(b));
  /** {ok:true,text} | {ok:false,message}. Decodes bytes, never file.text (policy 12). */
  function decodeSubtitle(bytes) {
    if (!bytes || bytes.byteLength > MAX_UPLOAD) return {ok: false, message: 'El archivo supera 1 MiB.'};
    try { return {ok: true, text: new TextDecoder('utf-8', {fatal: true}).decode(bytes)}; }
    catch (_) { return {ok: false, message: 'El archivo no es UTF-8 válido. Guardalo como UTF-8 y reintentá.'}; }
  }
  /** Upload/download response check: same catalogue and source, entry supported and listed. */
  function verifiedEntry(body, catalogue) {
    const c = body?.catalogue, e = body?.entry;
    return catalogue && c?.id === catalogue.id && c.source_id === catalogue.source_id && e?.supported === true
      && c.entries?.some(x => x.id === e.id && x.supported === true) ? e : null;
  }
  const commandError = msg => msg.timeout ? 'La acción tardó demasiado. Revisá el estado antes de reintentar.'
    : typeof msg.message === 'string' && msg.message ? msg.message : 'No se pudo completar la acción. Revisá el estado y reintentá.';
  const ticketOf = m => ++m.nextTicket;

  // ───────── capabilities: THE guard. view turns it into `enabled`; every handler asks it again.
  /**
   * @typedef {object} Caps
   * @property {boolean} online @property {boolean} busy  own command in flight, command_pending, pending or a waiting phase
   * @property {boolean} foreign  receiver_changed, disconnected or a phase we do not know: only Stop is allowed
   * @property {boolean} owned    the page shows Mando
   * @property {boolean} transport  pause/resume/seek/skip/volume/mute
   * @property {boolean} captions   transport + something to edit + no apply in flight
   * @property {boolean} stop @property {boolean} stopNeedsConfirm @property {boolean} changeDevice
   * @property {boolean} start  destination half of policy 5
   */
  /** @param {Model} m @returns {Caps} */
  function caps(m) {
    const l = m.link, s = l.status || NO_STATUS, online = l.online && !!l.status;
    const unknown = !KNOWN.has(s.phase), foreign = FOREIGN.includes(s.phase) || unknown;
    const busy = !!l.command || !!s.command_pending || !!s.pending || WAITING.includes(s.phase);
    const live = LIVE.includes(s.phase);
    const transport = online && live && !busy;
    return {
      online, busy, foreign, owned: modeOf(m) === 'mando', transport,
      captions: transport && !!s.playback_id && !!s.active_catalogue && !m.remote.captions.apply,
      stop: online && (s.can_change_device === false || busy || live || WAITING.includes(s.phase) || foreign || s.phase === 'error'),
      stopNeedsConfirm: live && !busy,
      changeDevice: online && s.can_change_device === true && !busy,
      start: online && !busy && !foreign && s.selected_device?.available === true && s.device_discovery !== 'error' && s.source_discovery !== 'error',
    };
  }
  /** 'mando' while a playback is ours or foreign-but-present; Preparar otherwise. Offline keeps the last status. */
  function modeOf(m) {
    const s = m.link.status || NO_STATUS;
    if (LIVE.includes(s.phase) || WAITING.includes(s.phase) || FOREIGN.includes(s.phase) || !KNOWN.has(s.phase)) return 'mando';
    return s.phase === 'error' && s.can_change_device === false ? 'mando' : 'preparar';
  }

  // ───────── link: polling, fencing, the one command
  /** Ask for a status ISSUED after now. Returns the seq to wait past. */
  function linkRequestPoll(m, fx) {
    const l = m.link, after = l.seq;
    if (l.polling) l.repoll = true; else linkIssuePoll(m, fx);
    return after;
  }
  function linkIssuePoll(m, fx) {
    const l = m.link;
    l.polling = true; l.repoll = false; l.pollTimer = null;
    fx.push({fx: 'poll', gen: l.generation, seq: ++l.seq});
  }
  /**
   * Send a command (policies 1-3). Refused when offline or when one is in flight, except Stop, which preempts.
   * Playback commands carry the device identity; explicit fields in `body` win (start sends its click-time snapshot).
   * @returns {Ticket|null}
   */
  function linkCommand(m, fx, action, body, opts = {}) {
    const l = m.link, s = l.status;
    if (!l.online || !s || (l.command && action !== 'stop')) return null;
    const ticket = ticketOf(m);
    const identity = PLAYBACK_ACTIONS.includes(action) && s.selected_device ? {device_id: s.selected_device.id, device_revision: s.device_revision} : {};
    l.generation++;
    l.command = {ticket, action, stage: 'posting', afterSeq: 0, ok: null, owner: opts.owner ?? null};
    m.ui.errors.local = null;
    if (opts.from) m.ui.focus = {ref: opts.from, n: opts.n};
    fx.push({fx: 'post', ticket, action, body: {...identity, ...body}});
    return ticket;
  }
  function linkOnStatus(m, fx, msg) {
    const l = m.link;
    l.polling = false;
    if (msg.gen === l.generation) {
      const s = msg.ok ? parseStatus(msg.raw) : null;
      if (s) { l.status = s; l.online = true; l.statusAt = msg.at; } else l.online = false;
      l.appliedSeq = msg.seq;
      advanceOnStatus(m, fx);
    }
    if (l.repoll) linkIssuePoll(m, fx);
    else { l.pollTimer = ticketOf(m); fx.push({fx: 'timer', name: 'poll', ms: POLL_MS, ticket: l.pollTimer}); }
  }
  /** Everything that waits for fresh server truth, in dependency order. */
  function advanceOnStatus(m, fx) {
    const l = m.link;
    // uiObserveError / planAdoptSnapshot / seekOnStatus join here as their sections land
    if (l.command?.stage === 'confirming' && l.appliedSeq > l.command.afterSeq) {
      const done = l.command;
      l.command = null;
      onCommandDone(m, fx, done);
    }
  }
  function linkOnCommandReply(m, fx, msg) {
    const c = m.link.command;
    if (c.stage !== 'posting') return;
    c.ok = msg.ok;
    if (!msg.ok && ownerLive(m, c)) m.ui.errors.local = commandError(msg);
    c.stage = 'confirming';
    c.afterSeq = linkRequestPoll(m, fx);
  }
  /** A cancelled owner flow reports no failure: its draft is gone and a message would be about nothing. */
  function ownerLive(m, c) {
    if (c.owner === 'start') return m.plan.start?.ticket === c.ticket;
    if (c.owner === 'captions') return m.remote.captions.apply?.ticket === c.ticket;
    return true;
  }
  function onCommandDone(m, fx, c) {
    void fx; void c;
  }

  // ───────── public: init / step
  const freshAddon = () => ({listing: null, listingKey: '', pull: {s: 'idle'}, language: '', offerId: '', correcting: false, op: null, message: null, lastHint: null, unreadable: []});
  const freshPlan = sourceId => ({
    sourceId, catalogue: null, load: {s: 'idle'}, choice: {branch: 'none', entryId: null},
    upload: {s: 'idle', filename: '', message: ''}, addon: freshAddon(), start: null,
    refresh: {discover: {ticket: null, error: ''}, discover_devices: {ticket: null, error: ''}},
  });
  const freshRemote = key => ({key, seek: {s: 'idle'}, captions: {draft: null, apply: null}, volumePreview: null, stop: null, overlay: null, addon: freshAddon()});
  const freshUi = () => ({
    sheet: null, confirm: null, errors: {local: null, observed: null, dismissed: null, absorbed: null}, focus: null,
    stoppedNotice: false, exact: {text: '', error: ''}, mode: null, reseed: false, clock: null, lastSourceId: null, lastDeviceLabel: '',
  });

  /** @param {{lastDeviceId?:string|null}} [boot] @returns {{model:Model,fx:object[]}} the first poll is in fx */
  function init(boot = {}) {
    const m = {
      nextTicket: 0, now: 0, prefs: {lastDeviceId: boot.lastDeviceId ?? null, autoSelectTried: false},
      link: {status: null, online: false, statusAt: 0, generation: 0, seq: 0, appliedSeq: 0, polling: false, repoll: false, pollTimer: null, command: null},
      plan: freshPlan(null), remote: freshRemote(playbackKey(null)), ui: freshUi(),
    };
    const fx = [];
    linkRequestPoll(m, fx);
    return {model: m, fx};
  }

  /**
   * The only way state changes: one message in, effects out. Deterministic, mutates `model`, performs no I/O.
   * Every message carries `at` (ms) and `n` (the shell's interaction counter).
   */
  function step(m, msg) {
    const fx = [];
    m.now = msg.at ?? m.now;
    if (msg.t === 'status') linkOnStatus(m, fx, msg);
    else if (msg.t === 'reply') linkRouteReply(m, fx, msg);
    else if (msg.t === 'timer') onTimer(m, fx, msg);
    else if (Object.hasOwn(ACTS, msg.t)) ACTS[msg.t](m, fx, msg);
    reconcile(m, fx);
    return {model: m, fx};
  }
  function linkRouteReply(m, fx, msg) {
    if (m.link.command?.ticket === msg.ticket) linkOnCommandReply(m, fx, msg);
  }
  function onTimer(m, fx, msg) {
    const l = m.link;
    if (msg.name === 'poll' && msg.ticket === l.pollTimer) {
      l.pollTimer = null;
      if (!l.polling) linkIssuePoll(m, fx);
    }
  }
  function reconcile(m, fx) {
    void m; void fx;
  }

  // ───────── view (grown section by section)
  function view(m) {
    const s = m.link.status || NO_STATUS;
    return {
      mode: modeOf(m),
      mando: {board: {state: s.phase === 'playing' ? 'REPRODUCIENDO' : s.phase === 'paused' ? 'EN PAUSA' : ''}, toggle: {enabled: caps(m).transport}},
    };
  }

  function toggle(m, fx, msg) {
    if (!caps(m).transport) return;
    linkCommand(m, fx, m.link.status.phase === 'playing' ? 'pause' : 'resume', {}, {from: msg.from, n: msg.n});
  }
  function stop(m, fx, msg) {
    if (!caps(m).stop) return;
    linkCommand(m, fx, 'stop', {}, {from: msg.from, n: msg.n});
  }
  const ACTS = Object.freeze({toggle, stop});

  return {init, step, view, ACTS, caps, formatTime, parseTime, decodeSubtitle};
})();

if (typeof module !== 'undefined') module.exports = {Panel};
