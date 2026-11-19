// ───────── core: the model and its rules. Pure data in, plain data out.
// Depends on: none.

// ───────── wire types (server contract)
/** @typedef {'idle'|'preparing'|'buffering'|'loading'|'playing'|'paused'|'disconnected'|'receiver_changed'|'ended'|'stopped'|'error'} Phase */
/** @typedef {{id:string,name:string,host?:string,model?:string,available?:boolean}} Device */
/** @typedef {{id:string,kind:'embedded'|'upload'|'addon',label:string,language:string|null,supported:boolean,reason:string|null}} Entry */
/** @typedef {{id:string,source_id:string,duration:number,entries:Entry[],addon:{state:string,revision:number,match:{label:string,confidence:string}|null,message:string|null,count:number}}} Catalogue */
/** @typedef {{catalogue_id:string,subtitle_id:string|null,enabled:boolean,delay_ms:number,label?:string,language?:string}} SubtitleChoice */

// ───────── model: four sub-states, one writer section each (link*, plan*, remote*, ui*)
/** @typedef {number} Ticket  Unique per effect. A reply is honoured only by the slot that still holds its ticket. */
/** @typedef {{afterSeq:number,deadline:Ticket}} Gate  waits for a status issued after it opened, for at most PENDING_MS */
/**
 * @typedef {object} Link
 * @property {object} status    last APPLIED status, NO_STATUS before the first; kept while offline
 * @property {boolean} online
 * @property {number} statusAt       msg.at of the last applied status (display clock only)
 * @property {number} generation     bumped by every command; status replies of an older generation are dropped
 * @property {number} seq            seq of the last ISSUED poll
 * @property {number} statusSeq
 * @property {boolean} polling       one poll in flight
 * @property {boolean} repoll        a poll issued after now is needed as soon as the one in flight returns
 * @property {Ticket|null} pollTimer
 * @property {Command[]} inflight  at most one command, plus a stop that may join it; each reply routes to its own entry
 */
/**
 * @typedef {{text:string,code:string|null}} CommandError
 * @typedef {{ticket:Ticket,action:string,joins:string|null}&({stage:'posting'}|{stage:'confirming',error:CommandError|null,afterSeq:number})} Command  joins: the action in flight when this stop went out
 */
/**
 * @typedef {{branch:'none'}|{branch:'file'|'stremio'|'upload',entryId:string|null}} Choice  entry kind always matches the branch
 * @typedef {{s:'idle'}|{s:'loading',ticket:Ticket|null,analysisId:string|null,previousId:string|null}|{s:'error',message:string}} Load
 * @typedef {{s:'idle',filename:string,message:string}|{s:'busy',stage:'reading'|'posting',ticket:Ticket,filename:string,format:string}} Upload
 * @typedef {{sourceId:string,catalogueId:string,subtitleId:string|null,deviceId:string,deviceRevision:number}} StartSnap  captured at click
 * @typedef {{stage:'verifying',snap:StartSnap,consent:string|null,gate:Gate}|{stage:'posting',snap:StartSnap,ticket:Ticket}} Start
 */
/**
 * @typedef {object} Addon  Stremio state for one catalogue; holds no reference to its owner.
 * @property {object|null} listing
 * @property {string} listingKey
 * @property {{s:'idle'}|{s:'pulling',key:string,ticket:Ticket}|{s:'failed',key:string}} pull
 * @property {string} language
 * @property {string} offerId
 * @property {boolean} correcting
 * @property {null|{kind:'lookup'|'fetch',ticket:Ticket,offerId?:string}} op
 * @property {{text:string,key:string}|null} message
 * @property {string|null} lastHint
 * @property {string[]} unreadable
 */
/**
 * @typedef {object} Plan  What the user is assembling. Shared by Preparar and the "Cambiar película" sheet.
 * @property {string|null} sourceId
 * @property {Catalogue|null} catalogue  monotonic per id
 * @property {Load} load
 * @property {Choice} choice
 * @property {Upload} upload
 * @property {Addon} addon
 * @property {Start|null} start
 * @property {Record<'discover'|'discover_devices',{ticket:Ticket|null,error:string}>} refresh
 */
/**
 * @typedef {{from:string,n:number}} Origin
 * @typedef {{s:'idle'}|{s:'dragging',preview:number}|{s:'skipping',delta:number,ticket:Ticket,origin:Origin|null}|{s:'sent',target:number,ticket:Ticket,sawBusy:boolean}} Seek
 * @typedef {{subtitleId:string|null,enabled:boolean,delayMs:number}} CaptionWant
 * @typedef {{kind:'plan'|'visibility',stage:'verifying'|'posting'|'reading',want:CaptionWant,gate:Gate,ticket:Ticket|null,prevVisible:boolean|null,errorAtStart:string|null,reads:number,origin:Origin|null}} CaptionApply
 */
/**
 * @typedef {object} Remote  Drafts bound to ONE playback identity; reconcile replaces it when the identity changes.
 * @property {string} key
 * @property {Seek} seek
 * @property {{draft:{subtitleId:string|null,delayMs:number}|null,apply:CaptionApply|null}} captions
 * @property {number|null} volumePreview
 * @property {Catalogue|null} overlay  newer active catalogue learned from a lookup or download
 * @property {Addon} addon
 * @property {Gate|null} stop  a confirmed Detener waiting for a fresh status. Once posted it lives in link.inflight, because
 *           the status that confirms it changes the playback key and remoteSync would wipe it here.
 */
/**
 * @typedef {object} Ui
 * @property {null|'subs'|'more'|'change'} sheet
 * @property {null|{kind:'replace',snap:StartSnap,consent:string,title:string}|{kind:'stop',key:string}} confirm  a stop confirm holds the playbackKey it was asked for
 * @property {{local:{text:string,lost:boolean}|null,observed:string|null,dismissed:string|null,absorbed:string|null}} errors
 *           identities are `${rev}:${text}`; a lost local error is a flow the outage dropped, so the offline block says it
 * @property {{ref:string,n:number,ticket:Ticket}|null} focus  control to refocus once command `ticket` settles
 * @property {boolean} stoppedNotice  'Película detenida en <TV>' not yet dismissed
 * @property {boolean} stopIssued  our Stop was sent; the next return to Preparar shows the notice
 * @property {{text:string,error:string}} exact
 * @property {'preparar'|'mando'|null} mode
 * @property {boolean} reseed
 * @property {Ticket|null} clock
 * @property {string|null} lastSourceId
 * @property {string} lastDeviceLabel
 */
/** @typedef {{link:Link,plan:Plan,remote:Remote,ui:Ui,prefs:{lastDeviceId:string|null,autoSelectTried:boolean},nextTicket:number,now:number,n:number}} Model */

// ───────── constants and pure helpers
// One poll that hangs until the shell's 6 s fetch timeout, then one more try. Later than that, a confirmed Detener,
// Iniciar or caption change could land on a TV the user has since resumed with its own remote.
const PENDING_MS = 10000;
const POLL_MS = 1500, SKIP_MS = 600, CLOCK_MS = 250, SETTLE_S = 2, CLOCK_CAP_S = 2, SKIP_S = 30, MAX_UPLOAD = 1024 * 1024, MAX_READS = 6;
const PLAYBACK_ACTIONS = ['start', 'pause', 'resume', 'seek', 'stop', 'volume', 'mute', 'subtitles'];
const WAITING = ['preparing', 'buffering', 'loading'], LIVE = ['playing', 'paused'], FOREIGN = ['receiver_changed', 'disconnected'];
const KNOWN = new Set(['idle', 'stopped', 'ended', 'error', ...WAITING, ...LIVE, ...FOREIGN]);
const NO_STATUS = Object.freeze({phase: 'idle', sources: []});
const KIND_OF_BRANCH = {file: 'embedded', stremio: 'addon', upload: 'upload'};
const STOP_MOVED = 'La TV cambió o hay otra sesión. Revisá antes de detener.';
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
/** Always name + model so two "Sala" TVs differ. `paren` gives the button form 'Sala (Google TV)'. */
function deviceLabel(d, paren = false) {
  if (!d) return '';
  return d.model ? (paren ? `${d.name} (${d.model})` : `${d.name} · ${d.model}`) : d.name;
}
const errorIdentity = s => s.action_error ? `${s.action_error_revision || 0}:${s.action_error}` : null;
const playbackTuple = s => [s.selected_device?.id ?? null, s.device_revision ?? null, s.source_id ?? null, s.playback_id ?? null];
const playbackKey = s => JSON.stringify([...playbackTuple(s), s.active_catalogue?.id ?? null]);
/** null unless a movie is on the TV; else what a replacement consent was given for. */
const replacementIdentity = s => LIVE.includes(s.phase) ? JSON.stringify([...playbackTuple(s), s.session ?? null, s.subtitle_choice ?? null]) : null;
const parseStatus = raw => raw && typeof raw === 'object' && typeof raw.phase === 'string' && Array.isArray(raw.sources) ? raw : null;
const addonRevision = c => c?.addon?.revision ?? 0;
const addonOff = cat => !cat?.addon || cat.addon.state === 'off';
const notOlder = (a, b) => !!a && !!b && a.id === b.id && a.entries.length >= b.entries.length && addonRevision(a) >= addonRevision(b);
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
const originOf = msg => msg?.from ? {from: msg.from, n: msg.n} : null;
/** What the TV says about captions right now, from the server's own fields. */
function capServer(s) {
  const c = s.subtitle_choice;
  return {
    subtitleId: c?.subtitle_id ?? null,
    enabled: typeof c?.enabled === 'boolean' ? c.enabled : s.subtitles_enabled === true,
    delayMs: finite(c?.delay_ms) ? c.delay_ms : finite(s.subtitle_delay_ms) ? s.subtitle_delay_ms : 0,
  };
}
/** The draft the sheet edits: the unapplied one, or the server's when there is none. */
function capDraft(m) {
  const d = m.remote.captions.draft ?? capServer(m.link.status);
  return {subtitleId: d.subtitleId, delayMs: d.delayMs};
}

// ───────── capabilities: THE guard. view turns it into `enabled`; every handler asks it again.
/**
 * @typedef {object} Caps
 * @property {boolean} online
 * @property {boolean} busy  own command or stop pending, command_pending, pending or a waiting phase
 * @property {boolean} stopping  our Detener is confirmed or in flight: no other flow may start until it settles
 * @property {boolean} foreign  receiver_changed, disconnected or a phase we do not know: only Stop is allowed
 * @property {boolean} owned    the page shows Mando
 * @property {boolean} transport  pause/resume/seek/skip/volume/mute
 * @property {boolean} captions   transport + something to edit + no apply in flight
 * @property {boolean} stop
 * @property {boolean} stopNeedsConfirm
 * @property {boolean} changeDevice
 * @property {boolean} start
 * @property {Record<'subs'|'more'|'change',{open:boolean,keep:boolean}>} sheets
 */
/** @param {Model} m @returns {Caps} */
function caps(m) {
  const l = m.link, s = l.status, online = l.online, stopping = stopPending(m);
  const unknown = !KNOWN.has(s.phase), foreign = FOREIGN.includes(s.phase) || unknown;
  const busy = stopping || l.inflight.length > 0 || !!s.command_pending || !!s.pending || WAITING.includes(s.phase);
  const live = LIVE.includes(s.phase), owned = modeOf(m) === 'mando';
  const transport = online && live && !busy;
  const subs = !!s.playback_id && !!remoteCatalogue(m) && !foreign, change = owned && !foreign;
  return {
    online, busy, stopping, foreign, owned, transport,
    sheets: {subs: {open: online && subs, keep: subs}, more: {open: owned, keep: owned}, change: {open: online && change && !stopping, keep: change}},
    captions: transport && !!s.playback_id && !!s.active_catalogue && !m.remote.captions.apply,
    stop: online && !stopping && (s.can_change_device === false || busy || live || WAITING.includes(s.phase) || foreign || s.phase === 'error'),
    stopNeedsConfirm: live && !busy,
    changeDevice: online && s.can_change_device === true && !busy,
    start: online && !busy && !foreign && s.selected_device?.available === true && s.device_discovery !== 'error' && s.source_discovery !== 'error',
  };
}
const stopPending = m => !!m.remote.stop || m.link.inflight.some(c => c.action === 'stop');
/** 'mando' while a playback is ours or foreign-but-present; Preparar otherwise. Offline keeps the last status. */
function modeOf(m) {
  const s = m.link.status;
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
 * Playback commands carry the device identity; explicit fields in `body` win (start sends its click-time snapshot).
 * @param {{from?:string,n?:number}|null} [origin] @returns {Ticket|null}
 */
function linkCommand(m, fx, action, body, origin = null) {
  const l = m.link, s = l.status;
  if (!l.online || l.inflight.some(c => action !== 'stop' || c.action === 'stop')) return null;
  const ticket = ticketOf(m);
  const identity = PLAYBACK_ACTIONS.includes(action) && s.selected_device ? {device_id: s.selected_device.id, device_revision: s.device_revision} : {};
  l.generation++;
  l.inflight.push({ticket, action, joins: l.inflight[0]?.action ?? null, stage: 'posting'});
  m.ui.errors.local = null;
  if (origin?.from) m.ui.focus = {ref: origin.from, n: origin.n, ticket};
  fx.push({fx: 'post', ticket, action, body: {...identity, ...body}});
  return ticket;
}
function linkGate(m, fx) {
  const afterSeq = linkRequestPoll(m, fx), deadline = ticketOf(m);
  fx.push({fx: 'timer', name: 'pending', ms: PENDING_MS, ticket: deadline});
  return {afterSeq, deadline};
}
const gatePassed = (m, g) => m.link.statusSeq > g.afterSeq;
function linkOnStatus(m, fx, msg) {
  const l = m.link;
  l.polling = false;
  if (msg.gen === l.generation) {
    const s = msg.ok ? parseStatus(msg.raw) : null;
    if (s) { l.status = s; l.online = true; l.statusAt = msg.at; l.statusSeq = msg.seq; } else l.online = false;
    advanceOnStatus(m, fx);
  }
  if (l.repoll) linkIssuePoll(m, fx);
  else { l.pollTimer = ticketOf(m); fx.push({fx: 'timer', name: 'poll', ms: POLL_MS, ticket: l.pollTimer}); }
}
/** Everything that waits for fresh server truth, in dependency order. */
function advanceOnStatus(m, fx) {
  const l = m.link;
  remoteSync(m);
  uiObserveError(m);
  planAdoptSnapshot(m);
  const settled = l.inflight.filter(c => c.stage === 'confirming' && l.statusSeq > c.afterSeq);
  l.inflight = l.inflight.filter(c => !settled.includes(c));
  for (const c of settled) {
    OWNERS[c.action]?.done(m, c, fx);
    uiSettleFocus(m, fx, c);
  }
  startAdvance(m, fx);
  capAdvance(m, fx);
  stopAdvance(m, fx);
  seekOnStatus(m);
}
function linkOnDeadline(m, msg) {
  const st = m.plan.start, a = m.remote.captions.apply, held = g => g?.deadline === msg.ticket;
  if (st?.stage === 'verifying' && held(st.gate)) { m.plan.start = null; uiSay(m, 'No se pudo iniciar: sin conexión. Probá de nuevo.', true); }
  else if (held(m.remote.stop)) { m.remote.stop = null; uiSay(m, 'No se pudo detener: sin conexión. Probá de nuevo.', true); }
  else if (a?.stage === 'verifying' && held(a.gate)) capFail(m, 'No se pudo aplicar el cambio: sin conexión. Probá de nuevo.', true);
}
function linkOnReply(m, fx, msg) {
  const c = m.link.inflight.find(x => x.ticket === msg.ticket);
  if (!c) return false;
  if (c.stage !== 'posting') return true;
  const error = msg.ok ? null : {text: commandError(msg), code: msg.code ?? null};
  Object.assign(c, {stage: 'confirming', error, afterSeq: linkRequestPoll(m, fx)});
  if (error && !OWNERS[c.action]?.quiet?.(m, c)) uiSay(m, error.text);
  return true;
}

// ───────── plan: movie, catalogue, subtitle decision, Start
function planTouch(m) {
  m.plan.start = null;
  if (m.ui.confirm?.kind === 'replace') m.ui.confirm = null;
}
/** A change to what would be sent: touch, and abandon an upload or download that would land in the old draft. */
function planEdit(m) {
  const p = m.plan;
  planTouch(m);
  if (p.upload.s === 'busy') p.upload = {s: 'idle', filename: '', message: ''};
  if (p.addon.op?.kind === 'fetch') p.addon.op = null;
}
/** Fresh plan: every ticket slot is cleared, so late replies for the old one die. Refresh slots belong to the page. */
function planReset(m, sourceId) {
  m.plan = {...freshPlan(sourceId), refresh: m.plan.refresh};
  planTouch(m);
}
const planSubtitleId = p => p.choice.branch === 'none' ? null : p.choice.entryId;
const entryOf = (cat, id) => cat?.entries.find(e => e.id === id) || null;
const sourceTitle = (s, id) => s.sources.find(x => x.id === id)?.title || 'la película elegida';

function planCanStart(m) {
  const s = m.link.status, p = m.plan, missing = [];
  if (!p.sourceId || !s.sources.some(x => x.id === p.sourceId)) missing.push('PELÍCULA');
  if (!s.selected_device) missing.push('TV'); else if (s.selected_device.available !== true) missing.push('TV DISPONIBLE');
  const resolved = p.choice.branch === 'none' || entryOf(p.catalogue, p.choice.entryId)?.supported === true;
  if (p.sourceId && p.catalogue && p.load.s === 'idle' && !resolved) missing.push('SUBTÍTULO');
  const waiting = !p.catalogue || p.load.s !== 'idle' || p.upload.s === 'busy' || p.addon.op?.kind === 'fetch';
  return missing.length || waiting ? {ok: false, missing} : {ok: true, missing};
}
/** What is on the TV already is exactly this plan: starting it again would only restart it. */
function samePlan(m) {
  const s = m.link.status, p = m.plan, c = s.subtitle_choice, id = planSubtitleId(p);
  return LIVE.includes(s.phase) && !!p.catalogue && p.sourceId === s.source_id && c?.catalogue_id === p.catalogue.id
    && (c?.subtitle_id ?? null) === id && (c?.delay_ms ?? 0) === 0 && c?.enabled === (id !== null);
}

function planPickSource(m, fx, id) {
  const s = m.link.status;
  if (!m.link.online || !s.sources.some(x => x.id === id) || m.plan.sourceId === id) return;
  planReset(m, id);
  const cached = s.catalogues?.[id];
  if (cached?.state === 'ready' && cached.catalogue?.source_id === id) m.plan.catalogue = cached.catalogue;
  planRequestCatalogue(m, fx, false);
}
function planRequestCatalogue(m, fx, refresh) {
  const p = m.plan;
  if (!m.link.online || !p.sourceId || p.load.s === 'loading') return;
  planEdit(m);
  p.addon.op = null;
  const ticket = ticketOf(m);
  p.load = {s: 'loading', ticket, analysisId: null, previousId: p.catalogue?.id ?? null};
  fx.push({fx: 'post', ticket, action: 'catalogue', body: {source_id: p.sourceId, refresh}});
}
/** Returns whether the plan took a new or richer catalogue. */
function planAcceptCatalogue(m, cat) {
  const p = m.plan, cur = p.catalogue;
  if (!cat || cat.source_id !== p.sourceId) return false;
  if (cur?.id === cat.id) {
    if (!notOlder(cat, cur)) return false;
    p.catalogue = cat;
    return !notOlder(cur, cat);
  }
  if (cur) {
    const {choice, upload, addon} = freshPlan(p.sourceId);
    Object.assign(p, {choice, upload, addon});
    planTouch(m);
  }
  p.catalogue = cat;
  return true;
}
/** Consume status.catalogues[plan.sourceId]; a source that left the list ends the plan. */
function planAdoptSnapshot(m) {
  const s = m.link.status, p = m.plan;
  if (!p.sourceId) return;
  if (!s.sources.some(x => x.id === p.sourceId)) { planReset(m, null); return; }
  const snap = s.catalogues?.[p.sourceId], loading = p.load;
  if (!snap) return;
  if (snap.state === 'ready' && snap.catalogue) {
    if (loading.s === 'loading' && !(loading.analysisId && (loading.analysisId === snap.analysis_id || snap.catalogue.id !== loading.previousId))) return;
    const changed = planAcceptCatalogue(m, snap.catalogue);
    if (loading.s === 'loading' || (loading.s === 'error' && changed)) p.load = {s: 'idle'};
  } else if (snap.state === 'error' && loading.s === 'loading' && loading.analysisId && loading.analysisId === snap.analysis_id) {
    p.load = {s: 'error', message: snap.message || 'No se pudo analizar la película. Actualizá las pistas.'};
  }
}
function planOnReply(m, fx, msg) {
  const p = m.plan, t = msg.ticket;
  if (p.load.s === 'loading' && p.load.ticket === t) planOnCatalogueReply(m, msg);
  else if (p.upload.s === 'busy' && p.upload.ticket === t && p.upload.stage === 'posting') planOnUploadReply(m, msg);
  else {
    const r = Object.values(p.refresh).find(x => x.ticket === t);
    if (!r) return false;
    r.ticket = null;
    if (msg.ok) linkRequestPoll(m, fx); else r.error = commandError(msg);
  }
  return true;
}
function planOnCatalogueReply(m, msg) {
  const p = m.plan;
  if (!msg.ok) { p.load = {s: 'error', message: commandError(msg)}; return; }
  if (msg.body?.catalogue) { planAcceptCatalogue(m, msg.body.catalogue); p.load = {s: 'idle'}; }
  else if (msg.body?.analysis_id) p.load = {...p.load, ticket: null, analysisId: msg.body.analysis_id};
  else p.load = {s: 'error', message: 'Respuesta inválida del puente. Actualizá las pistas.'};
}

function planSubsBranch(m, branch) {
  const p = m.plan;
  if (!p.catalogue || p.load.s !== 'idle' || !(branch === 'none' || branch in KIND_OF_BRANCH)) return;
  if (branch === 'stremio' && addonOff(p.catalogue)) return;
  planEdit(m);
  const keep = branch !== 'none' && entryOf(p.catalogue, p.choice.entryId)?.kind === KIND_OF_BRANCH[branch];
  p.choice = branch === 'none' ? {branch} : {branch, entryId: keep ? p.choice.entryId : null};
}
function planValidChoice(m) {
  if (m.plan.choice.branch === 'stremio' && addonOff(m.plan.catalogue)) m.plan.choice = {branch: 'none', entryId: null};
}
function planPickEntry(m, id) {
  const p = m.plan, e = entryOf(p.catalogue, id);
  if (!m.link.online || !e?.supported || p.load.s !== 'idle' || p.choice.branch === 'none' || e.kind !== KIND_OF_BRANCH[p.choice.branch]) return;
  planEdit(m);
  p.choice = {branch: p.choice.branch, entryId: id};
}

function planFilePicked(m, fx, file) {
  const p = m.plan;
  if (!m.link.online || !p.catalogue || p.load.s !== 'idle' || p.upload.s === 'busy' || p.addon.op?.kind === 'fetch' || !file) return;
  planEdit(m);
  const name = String(file.name || ''), filename = name.split(/[\\/]/).pop();
  const format = /\.(srt|vtt)$/i.exec(name)?.[1].toLowerCase();
  if (!format) { p.upload = {s: 'idle', filename, message: 'Elegí un archivo .srt o .vtt en UTF-8.'}; return; }
  if (!(file.size <= MAX_UPLOAD)) { p.upload = {s: 'idle', filename, message: 'El archivo supera 1 MiB. Elegí uno más pequeño.'}; return; }
  const ticket = ticketOf(m);
  p.upload = {s: 'busy', stage: 'reading', ticket, filename, format};
  fx.push({fx: 'read', ticket});
}
function planFileRead(m, fx, msg) {
  const p = m.plan, u = p.upload;
  if (u.s !== 'busy' || u.stage !== 'reading' || u.ticket !== msg.ticket) return;
  const decoded = msg.bytes ? decodeSubtitle(msg.bytes) : {ok: false, message: 'No se pudo leer el archivo. Reintentá.'};
  if (!decoded.ok) { p.upload = {s: 'idle', filename: u.filename, message: decoded.message}; return; }
  const ticket = ticketOf(m);
  p.upload = {...u, stage: 'posting', ticket};
  fx.push({fx: 'post', ticket, action: 'subtitle_upload', body: {source_id: p.sourceId, catalogue_id: p.catalogue.id, filename: u.filename, format: u.format, text: decoded.text}});
}
function planOnUploadReply(m, msg) {
  const p = m.plan, u = p.upload, entry = msg.ok ? verifiedEntry(msg.body, p.catalogue) : null;
  const fail = text => { p.upload = {s: 'idle', filename: u.filename, message: text}; };
  if (!msg.ok) return fail(commandError(msg));
  planAcceptCatalogue(m, msg.body?.catalogue);
  if (!entry || !entryOf(p.catalogue, entry.id)?.supported) return fail('La lista de pistas cambió. Actualizala antes de subir el archivo otra vez.');
  p.choice = {branch: 'upload', entryId: entry.id};
  p.upload = {s: 'idle', filename: u.filename, message: `Archivo listo: ${u.filename}. Se usará solo al iniciar.`};
}

function planPickDevice(m, fx, id, msg) {
  const s = m.link.status;
  if (!caps(m).changeDevice || !s.devices?.some(d => d.id === id) || s.selected_device?.id === id) return;
  linkCommand(m, fx, 'select_device', {device_id: id, device_revision: s.device_revision}, msg);
}
/** discover / discover_devices: independent of commands, one in flight per kind. */
function planRefresh(m, fx, kind) {
  const r = m.plan.refresh[kind], s = m.link.status;
  if (!m.link.online || r.ticket || (kind === 'discover' ? s.source_discovery : s.device_discovery) === 'loading') return;
  r.ticket = ticketOf(m);
  r.error = '';
  fx.push({fx: 'post', ticket: r.ticket, action: kind, body: {}});
}

function planStart(m, fx) {
  const p = m.plan, s = m.link.status;
  if (!caps(m).start || !planCanStart(m).ok || samePlan(m) || p.start || m.ui.confirm) return;
  const snap = {sourceId: p.sourceId, catalogueId: p.catalogue.id, subtitleId: planSubtitleId(p), deviceId: s.selected_device.id, deviceRevision: s.device_revision};
  const consent = replacementIdentity(s);
  if (consent) m.ui.confirm = {kind: 'replace', snap, consent, title: sourceTitle(s, p.sourceId)};
  else planVerify(m, fx, snap, null);
}
function planVerify(m, fx, snap, consent) {
  m.plan.start = {stage: 'verifying', snap, consent, gate: linkGate(m, fx)};
}
/** After a poll issued since the click: the destination, the list and the replacement must still be what was agreed. */
function startAdvance(m, fx) {
  const p = m.plan, st = p.start, s = m.link.status;
  if (st?.stage !== 'verifying' || !gatePassed(m, st.gate)) return;
  const k = st.snap;
  p.start = null;
  if (s.selected_device?.id !== k.deviceId || s.device_revision !== k.deviceRevision) { uiSay(m, 'El destino cambió. Revisá la TV y volvé a intentar.'); return; }
  if (!caps(m).start || !s.sources.some(x => x.id === k.sourceId) || samePlan(m)) return;
  const snap = s.catalogues?.[k.sourceId];
  if (snap?.state !== 'ready' || snap.catalogue.id !== k.catalogueId || (k.subtitleId && !snap.catalogue.entries.some(e => e.id === k.subtitleId && e.supported === true))) {
    uiSay(m, 'La lista de subtítulos cambió. Revisá la película y volvé a iniciar.');
    return;
  }
  const now = replacementIdentity(s);
  if (now && now !== st.consent) { m.ui.confirm = {kind: 'replace', snap: k, consent: now, title: sourceTitle(s, k.sourceId)}; return; }
  const ticket = linkCommand(m, fx, 'start', {source_id: k.sourceId, catalogue_id: k.catalogueId, subtitle_id: k.subtitleId, delay_ms: 0, device_id: k.deviceId, device_revision: k.deviceRevision});
  if (ticket) p.start = {stage: 'posting', snap: k, ticket};
}
/** The Start command settled. A start cancelled meanwhile leaves the draft and the sheet alone. */
function planOnCommandDone(m, c) {
  if (m.plan.start?.ticket !== c.ticket) return;
  m.plan.start = null;
  if (!c.error && m.ui.sheet === 'change') m.ui.sheet = null;
}

// ───────── remote: seek, volume, captions, stop
/** The newer of the server's active catalogue and what a lookup or download returned since. */
function remoteCatalogue(m) {
  const a = m.link.status.active_catalogue ?? null, o = m.remote.overlay;
  return notOlder(o, a) ? o : a;
}
/** Drafts and flows belong to one playback identity. Runs before any flow advances, so none acts on a playback it was not made for. */
function remoteSync(m) {
  const key = playbackKey(m.link.status);
  if (key === m.remote.key) return;
  const stopping = m.remote.stop;
  m.remote = freshRemote(key);
  if (stopping && caps(m).stop) uiSay(m, STOP_MOVED);
  if (m.ui.sheet === 'subs') m.ui.sheet = null;
}
const durationOf = s => finite(s.duration) && s.duration > 0 ? s.duration : null;

/** Position on the line while dragging; the real elapsed time stays frozen until release. */
function seekDrag(m, pos) {
  const d = durationOf(m.link.status);
  if (caps(m).transport && d && finite(pos)) m.remote.seek = {s: 'dragging', preview: clamp(pos, 0, d)};
}
/** Pointer cancel or Escape while dragging: back to idle, nothing sent. */
function seekAbandon(m) {
  if (m.remote.seek.s === 'dragging') m.remote.seek = {s: 'idle'};
}
function seekSend(m, fx, body, target, origin) {
  const ticket = linkCommand(m, fx, 'seek', body, origin);
  m.remote.seek = ticket ? {s: 'sent', target, ticket, sawBusy: false} : {s: 'idle'};
}
/** Release commits: one seek {position}. */
function seekDrop(m, fx, pos, msg) {
  const d = durationOf(m.link.status);
  if (!caps(m).transport || !d) return;
  if (!finite(pos) || pos < 0 || pos > d) {
    m.remote.seek = {s: 'idle'};
    uiSay(m, 'El tiempo está fuera de la duración de la película.');
    return;
  }
  seekSend(m, fx, {position: pos}, pos, msg);
}
/** ±30 taps accumulate, clamped so the badge and the sent delta never pass [0, duration]; one seek {delta} after SKIP_MS. */
function seekSkip(m, fx, delta, msg) {
  const s = m.link.status, d = durationOf(s), k = m.remote.seek;
  if (!caps(m).transport || !d || !finite(s.absolute_time) || !finite(delta)) return;
  const sum = (k.s === 'skipping' ? k.delta : 0) + delta, ticket = ticketOf(m);
  m.remote.seek = {s: 'skipping', delta: clamp(sum, -s.absolute_time, d - s.absolute_time), ticket, origin: originOf(msg) ?? k.origin ?? null};
  fx.push({fx: 'timer', name: 'skip', ms: SKIP_MS, ticket});
}
function seekOnTimer(m, fx, msg) {
  const k = m.remote.seek, s = m.link.status;
  if (k.s !== 'skipping' || k.ticket !== msg.ticket) return;
  if (k.delta === 0) m.remote.seek = {s: 'idle'};
  else if (caps(m).transport) seekSend(m, fx, {delta: k.delta}, clamp(s.absolute_time + k.delta, 0, durationOf(s) ?? Infinity), k.origin);
  else if (m.link.inflight.length) {
    const ticket = ticketOf(m);
    m.remote.seek = {...k, ticket};
    fx.push({fx: 'timer', name: 'skip', ms: SKIP_MS, ticket});
  } else m.remote.seek = {s: 'idle'};
}
function seekOnStatus(m) {
  const k = m.remote.seek, s = m.link.status, c = caps(m);
  if (k.s === 'dragging' && !c.transport) m.remote.seek = {s: 'idle'};
  if (k.s !== 'sent') return;
  if (s.pending || s.command_pending) k.sawBusy = true;
  if (c.transport && (k.sawBusy || finite(s.absolute_time) && Math.abs(s.absolute_time - k.target) < SETTLE_S)) m.remote.seek = {s: 'idle'};
}
/** A rejected seek clears only its own target. */
function seekOnCommandDone(m, c) {
  const k = m.remote.seek;
  if (c.error && k.s === 'sent' && k.ticket === c.ticket) m.remote.seek = {s: 'idle'};
}
/** Exact time applies directly; invalid input stays in the field with a reason. */
function seekGoto(m, fx, text, msg) {
  const d = durationOf(m.link.status), pos = parseTime(String(text ?? ''));
  if (!caps(m).transport || !d) return;
  if (pos === null || pos > d) { m.ui.exact = {text: String(text ?? ''), error: `Usá m:ss o h:mm:ss, hasta ${formatTime(d)}.`}; return; }
  m.ui.sheet = null;
  m.ui.exact = {text: '', error: ''};
  seekSend(m, fx, {position: pos}, pos, msg);
}

function volumePreview(m, value) {
  if (caps(m).transport && finite(m.link.status.volume) && finite(value)) m.remote.volumePreview = clamp(Math.round(value), 0, 100);
}
function volumeSet(m, fx, value, msg) {
  const ok = caps(m).transport && finite(m.link.status.volume) && finite(value);
  if (!ok || !linkCommand(m, fx, 'volume', {level: clamp(value, 0, 100) / 100}, msg)) m.remote.volumePreview = null;
}
function muteToggle(m, fx, msg) {
  const s = m.link.status;
  if (caps(m).transport && typeof s.muted === 'boolean') linkCommand(m, fx, 'mute', {muted: !s.muted}, msg);
}
function toggle(m, fx, msg) {
  if (!caps(m).transport) return;
  linkCommand(m, fx, m.link.status.phase === 'playing' ? 'pause' : 'resume', {}, msg);
}

// captions: the draft is edited locally; Aplicar and the visibility toggle share one pipeline that waits for readback
const capSame = (a, b) => a.subtitleId === b.subtitleId && a.delayMs === b.delayMs;
/** Derived, never stored: the draft differs from what the TV has. */
const capDirty = m => !!m.remote.captions.draft && !capSame(m.remote.captions.draft, capServer(m.link.status));
function capSetDraft(m, next) {
  m.remote.captions.draft = capSame(next, capServer(m.link.status)) ? null : next;
}
function capTrack(m, arg) {
  const id = arg === '' || arg == null ? null : String(arg);
  if (!caps(m).captions || (id !== null && !entryOf(remoteCatalogue(m), id)?.supported)) return;
  capSetDraft(m, {subtitleId: id, delayMs: id === null ? 0 : capDraft(m).delayMs});
}
function capShift(m, delayOf) {
  const cur = capDraft(m);
  if (caps(m).captions && cur.subtitleId) capSetDraft(m, {subtitleId: cur.subtitleId, delayMs: delayOf(cur.delayMs)});
}
function capNudge(m, fx, msg) {
  const delta = Number(msg.arg);
  if (!finite(delta)) return;
  if (!m.ui.sheet) uiOpen(m, 'subs');
  capShift(m, ms => clamp(Math.round((ms + delta) / 100) * 100, -30000, 30000));
}
const capReset = m => capShift(m, () => 0);
function capBegin(m, fx, kind, want, msg) {
  const s = m.link.status;
  m.remote.captions.apply = {
    kind, stage: 'verifying', want, gate: linkGate(m, fx), ticket: null,
    prevVisible: typeof s.subtitles_enabled === 'boolean' ? s.subtitles_enabled : null, errorAtStart: errorIdentity(s), reads: 0, origin: originOf(msg),
  };
}
/** Aplicar sends the draft. A new track shows itself; the same track keeps the visibility the TV has. */
function capApply(m, fx, msg) {
  if (!caps(m).captions || !capDirty(m)) return;
  const d = m.remote.captions.draft, srv = capServer(m.link.status);
  capBegin(m, fx, 'plan', {subtitleId: d.subtitleId, delayMs: d.subtitleId ? d.delayMs : 0,
    enabled: d.subtitleId === null ? false : d.subtitleId !== srv.subtitleId ? true : srv.enabled}, msg);
}
/** The toggle sends the SERVER's track and delay with the new visibility, so an unapplied draft never rides along. */
function capVisible(m, fx, on, msg) {
  const srv = capServer(m.link.status);
  if (!caps(m).captions || !srv.subtitleId || srv.enabled === !!on) return;
  capBegin(m, fx, 'visibility', {...srv, enabled: !!on}, msg);
}
function capDiscard(m) {
  m.remote.captions.draft = null;
  if (m.ui.sheet === 'subs') uiDismiss(m);
}
function capFail(m, message, lost = false) {
  const a = m.remote.captions.apply, s = m.link.status;
  const partial = !!a && typeof a.prevVisible === 'boolean' && s.subtitles_enabled !== a.prevVisible && s.subtitles_enabled === a.want.enabled && s.subtitle_delay_ms !== a.want.delayMs;
  m.remote.captions.apply = null;
  uiSay(m, `${partial ? 'La visibilidad ya cambió; la sincronía sigue sin confirmar. ' : ''}${message}${a?.kind === 'plan' ? ' Tu ajuste sigue en borrador.' : ''}`, lost);
}
/** The server holds exactly what was asked for, by every field it reports. */
function capSettled(s, a) {
  const srv = capServer(s), w = a.want, choice = s.subtitle_choice;
  return srv.subtitleId === w.subtitleId && srv.enabled === w.enabled && srv.delayMs === w.delayMs
    && (w.subtitleId === null || choice?.catalogue_id === s.active_catalogue?.id)
    && (!finite(s.subtitle_delay_ms) || s.subtitle_delay_ms === w.delayMs)
    && (typeof s.subtitles_enabled !== 'boolean' || s.subtitles_enabled === w.enabled);
}
function capAdvance(m, fx) {
  const a = m.remote.captions.apply, l = m.link, s = l.status, c = caps(m);
  if (!a || !c.online) return;
  if (c.foreign || s.phase === 'error') return capFail(m, 'Se interrumpió el cambio. Revisá el estado de la TV.');
  if (a.stage === 'verifying') {
    if (!gatePassed(m, a.gate)) return;
    if (!c.transport) return capFail(m, 'La TV estaba ocupada y no se aplicó el cambio. Reintentá en un momento.');
    const ticket = linkCommand(m, fx, 'subtitles', {playback_id: s.playback_id, catalogue_id: s.active_catalogue.id, subtitle_id: a.want.subtitleId, enabled: a.want.enabled, delay_ms: a.want.delayMs}, a.origin);
    if (ticket) { a.stage = 'posting'; a.ticket = ticket; } else m.remote.captions.apply = null;
  } else if (a.stage === 'reading') {
    if (c.busy) return;
    const id = errorIdentity(s);
    if (id && id !== a.errorAtStart) { m.ui.errors.absorbed = id; return capFail(m, s.action_error); }
    if (capSettled(s, a)) {
      m.remote.captions.apply = null;
      if (a.kind === 'plan' && m.remote.captions.draft && capSame(m.remote.captions.draft, a.want)) m.remote.captions.draft = null;
      if (a.kind === 'plan' && m.ui.sheet === 'subs') m.ui.sheet = null;
    } else if (++a.reads >= MAX_READS) capFail(m, 'No se pudo confirmar el cambio en la TV. Revisá el estado y reintentá.');
  }
}
function capOnCommandDone(m, c) {
  const a = m.remote.captions.apply;
  if (a?.ticket !== c.ticket) return;
  if (c.error) capFail(m, c.error.text); else a.stage = 'reading';
}

function remoteStop(m, fx, msg) {
  const c = caps(m);
  if (!c.stop || m.ui.confirm) return;
  if (c.stopNeedsConfirm) m.ui.confirm = {kind: 'stop', key: m.remote.key};
  else remoteStopNow(m, fx, msg);
}
function remoteCancelFlows(m) {
  planTouch(m);
  m.remote.captions.apply = null;
  m.remote.seek = {s: 'idle'};
}
function remoteStopNow(m, fx, origin = null) {
  const u = m.ui, id = m.link.status.playback_id;
  remoteCancelFlows(m);
  u.confirm = null;
  u.sheet = null;
  if (linkCommand(m, fx, 'stop', id ? {playback_id: id} : {}, origin)) u.stopIssued = true;
}
const stopOutranStart = c => c.joins === 'start' && c.error?.code === 'stale_playback';
function stopOnCommandDone(m, c, fx) {
  if (!c.error) return;
  m.ui.stopIssued = false;
  if (stopOutranStart(c) && caps(m).stop) remoteStopNow(m, fx);
}
function stopAdvance(m, fx) {
  const st = m.remote.stop;
  if (!st || !gatePassed(m, st)) return;
  m.remote.stop = null;
  if (caps(m).stop) remoteStopNow(m, fx);
}

// ───────── ui: layers, errors
function uiSay(m, text, lost = false) {
  m.ui.errors.local = {text, lost};
}
/** openSubs / openMore / openChange. 'change' starts from an empty plan. */
function uiOpen(m, sheet) {
  if (m.ui.confirm || !caps(m).sheets[sheet].open) return;
  if (sheet === 'change') planReset(m, null);
  if (sheet === 'more') m.ui.exact = {text: '', error: ''};
  m.ui.sheet = sheet;
}
/** Closes the TOP layer only. */
function uiDismiss(m) {
  const u = m.ui;
  if (u.confirm) { u.confirm = null; return; }
  const was = u.sheet;
  u.sheet = null;
  planTouch(m);
  if (was === 'change') planReset(m, null);
}
function uiConfirmAccept(m, fx) {
  const c = m.ui.confirm, p = m.plan;
  m.ui.confirm = null;
  if (c?.kind === 'stop') {
    remoteCancelFlows(m);
    m.remote.stop = linkGate(m, fx);
  } else if (c?.kind === 'replace') {
    const k = c.snap;
    if (p.sourceId !== k.sourceId || p.catalogue?.id !== k.catalogueId || planSubtitleId(p) !== k.subtitleId) return;
    planVerify(m, fx, k, c.consent);
  }
}
function uiObserveError(m) {
  const e = m.ui.errors, id = errorIdentity(m.link.status);
  if (!id || id === e.observed) return;
  e.observed = id;
  e.local = null;
  if (m.remote.seek.s === 'sent') m.remote.seek = {s: 'idle'};
}
/** Layers can't outlive the permission that opened them. */
function uiValidLayers(m) {
  const u = m.ui, c = caps(m);
  if (u.sheet && !c.sheets[u.sheet].keep) {
    if (u.sheet === 'change') planReset(m, null);
    u.sheet = null;
  }
  const k = u.confirm;
  if (k?.kind === 'replace' && c.foreign) u.confirm = null;
  if (k?.kind === 'stop' && (k.key !== m.remote.key || (c.online && !c.stop))) {
    u.confirm = null;
    if (c.stop) uiSay(m, STOP_MOVED);
  }
}
/** The focus ticket is honoured once the command settles, and only if the user has not touched anything since. */
function uiSettleFocus(m, fx, c) {
  const f = m.ui.focus;
  if (f?.ticket !== c.ticket) return;
  m.ui.focus = null;
  if (f.n === m.n) fx.push({fx: 'focus', ref: f.ref, n: f.n});
}
/**
 * @returns {'offline'|'unknown'|'foreign'|'disconnected'|'failed'|'notice'|'stopped'|null}
 */
function problemKind(m) {
  const s = m.link.status, u = m.ui;
  if (!m.link.online) return 'offline';
  if (!KNOWN.has(s.phase)) return 'unknown';
  if (s.phase === 'receiver_changed') return 'foreign';
  if (s.phase === 'disconnected') return 'disconnected';
  if (s.phase === 'error') return 'failed';
  if (u.errors.local || backendError(m)) return 'notice';
  return u.stoppedNotice ? 'stopped' : null;
}
/** The server's action_error, unless dismissed, absorbed by a caption apply that reported it, or an apply is still pending. */
function backendError(m) {
  const s = m.link.status, id = errorIdentity(s), e = m.ui.errors;
  return id && id !== e.dismissed && id !== e.absorbed && !m.remote.captions.apply ? s.action_error : null;
}
function uiDismissNotice(m) {
  const kind = problemKind(m), e = m.ui.errors;
  if (kind !== 'notice' && kind !== 'stopped') return;
  if (kind === 'stopped') m.ui.stoppedNotice = false;
  else if (e.local !== null) e.local = null;
  else e.dismissed = errorIdentity(m.link.status);
}
function uiScenario(m, fx, value, msg) {
  if (m.link.status.demo === true) linkCommand(m, fx, 'scenario', {state: String(value)}, msg);
}

const OWNERS = {
  start: {done: planOnCommandDone},
  seek: {done: seekOnCommandDone},
  subtitles: {quiet: (m, c) => m.remote.captions.apply?.ticket !== c.ticket, done: capOnCommandDone},
  volume: {done: m => { m.remote.volumePreview = null; }},
  stop: {quiet: (m, c) => stopOutranStart(c), done: stopOnCommandDone},
};

// ───────── fresh sub-states
const freshAddon = () => ({listing: null, listingKey: '', pull: {s: 'idle'}, language: '', offerId: '', correcting: false, op: null, message: null, lastHint: null, unreadable: []});
const freshPlan = sourceId => ({
  sourceId, catalogue: null, load: {s: 'idle'}, choice: {branch: 'none', entryId: null},
  upload: {s: 'idle', filename: '', message: ''}, addon: freshAddon(), start: null,
  refresh: {discover: {ticket: null, error: ''}, discover_devices: {ticket: null, error: ''}},
});
const freshRemote = key => ({key, seek: {s: 'idle'}, captions: {draft: null, apply: null}, volumePreview: null, stop: null, overlay: null, addon: freshAddon()});
const freshUi = () => ({
  sheet: null, confirm: null, errors: {local: null, observed: null, dismissed: null, absorbed: null}, focus: null,
  stoppedNotice: false, stopIssued: false, exact: {text: '', error: ''}, mode: null, reseed: false, clock: null, lastSourceId: null, lastDeviceLabel: '',
});
/** @param {string|null} lastDeviceId @returns {Model} */
const freshModel = lastDeviceId => ({
  nextTicket: 0, now: 0, n: 0, prefs: {lastDeviceId, autoSelectTried: false},
  link: {status: NO_STATUS, online: false, statusAt: 0, generation: 0, seq: 0, statusSeq: 0, polling: false, repoll: false, pollTimer: null, inflight: []},
  plan: freshPlan(null), remote: freshRemote(playbackKey(NO_STATUS)), ui: freshUi(),
});
