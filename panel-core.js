// Panel core: pure data in, plain data out. It never touches document, fetch, timers, storage or `token`;
// a DOM shell performs the effects it returns and paints Panel.view(). bridge.py inlines panel-core.js,
// panel-addon.js, panel-view.js and panel-shell.js, in that order, as one script.

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
/** @typedef {{ticket:Ticket,action:string,stage:'posting'|'confirming',afterSeq:number,ok:boolean|null,owner:string|null}} Command */
/**
 * @typedef {{branch:'none'}|{branch:'file'|'stremio'|'upload',entryId:string|null}} Choice  entry kind always matches the branch
 * @typedef {{s:'idle'}|{s:'loading',ticket:Ticket|null,analysisId:string|null,previousId:string|null}|{s:'error',message:string}} Load
 * @typedef {{s:'idle',filename:string,message:string}|{s:'busy',stage:'reading'|'posting',ticket:Ticket,filename:string,format:string}} Upload
 * @typedef {{sourceId:string,catalogueId:string,subtitleId:string|null,deviceId:string,deviceRevision:number}} StartSnap  captured at click
 * @typedef {{stage:'verifying',snap:StartSnap,consent:string|null,afterSeq:number}|{stage:'posting',snap:StartSnap,ticket:Ticket}} Start
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
 * @property {Start|null} start  written ONLY by planTouch (clears), planReset (fresh plan), planStart, startAdvance, planOnCommandDone, uiConfirmAccept
 * @property {Record<'discover'|'discover_devices',{ticket:Ticket|null,error:string}>} refresh
 */
/**
 * @typedef {{s:'idle'}|{s:'dragging',preview:number}|{s:'skipping',delta:number,ticket:Ticket,from?:string,n?:number}|{s:'sent',target:number,ticket:Ticket,sawBusy:boolean}} Seek
 * @typedef {{subtitleId:string|null,enabled:boolean,delayMs:number}} CaptionWant
 * @typedef {{kind:'plan'|'visibility',stage:'verifying'|'posting'|'reading',want:CaptionWant,catalogueId:string,afterSeq:number,ticket:Ticket|null,prevVisible:boolean|null,errorAtStart:string|null,reads:number,from?:string,n?:number}} CaptionApply
 */
/**
 * @typedef {object} Remote  Drafts bound to ONE playback identity; reconcile replaces it when the identity changes.
 * @property {string} key
 * @property {Seek} seek
 * @property {{draft:{subtitleId:string|null,delayMs:number}|null,apply:CaptionApply|null}} captions
 * @property {number|null} volumePreview
 * @property {Catalogue|null} overlay  newer active catalogue learned from a lookup or download
 * @property {Addon} addon
 * @property {{afterSeq:number}|null} stop  a confirmed Detener waiting for a status issued after the confirm
 */
/**
 * @typedef {object} Ui
 * @property {null|'subs'|'more'|'change'} sheet
 * @property {null|{kind:'replace',snap:StartSnap,consent:string,title:string}|{kind:'stop',key:string}} confirm  a stop confirm holds the playbackKey it was asked for
 * @property {{local:string|null,observed:string|null,dismissed:string|null,absorbed:string|null}} errors  identities are `${rev}:${text}`
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
const POLL_MS = 1500, SKIP_MS = 600, CLOCK_MS = 250, SETTLE_S = 2, CLOCK_CAP_S = 2, SKIP_S = 30, MAX_UPLOAD = 1024 * 1024;
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
const decimalSeconds = ms => (Math.abs(ms) / 1000).toFixed(1).replace('.', ',');
/** '+0,4 s' with U+2212 for negatives; '—' when unknown. */
function signedSeconds(ms) {
  return finite(ms) ? `${ms < 0 ? '−' : '+'}${decimalSeconds(ms)} s` : '—';
}
function delayMeaning(ms) {
  if (!ms) return 'Sincronizados con la voz';
  return `Aparecen ${decimalSeconds(ms)} s ${ms > 0 ? 'después que' : 'antes que'} la voz`;
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
 * @property {boolean} busy  own command in flight, command_pending, pending or a waiting phase
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
  const l = m.link, s = l.status, online = l.online;
  const unknown = !KNOWN.has(s.phase), foreign = FOREIGN.includes(s.phase) || unknown;
  const busy = l.inflight.length > 0 || !!s.command_pending || !!s.pending || WAITING.includes(s.phase);
  const live = LIVE.includes(s.phase), owned = modeOf(m) === 'mando';
  const transport = online && live && !busy;
  const subs = !!s.playback_id && !!remoteCatalogue(m) && !foreign, change = owned && !foreign;
  return {
    online, busy, foreign, owned, transport,
    sheets: {subs: {open: online && subs, keep: subs}, more: {open: owned, keep: owned}, change: {open: online && change, keep: change}},
    captions: transport && !!s.playback_id && !!s.active_catalogue && !m.remote.captions.apply,
    stop: online && (s.can_change_device === false || busy || live || WAITING.includes(s.phase) || foreign || s.phase === 'error'),
    stopNeedsConfirm: live && !busy,
    changeDevice: online && s.can_change_device === true && !busy,
    start: online && !busy && !foreign && s.selected_device?.available === true && s.device_discovery !== 'error' && s.source_discovery !== 'error',
  };
}
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
 * @returns {Ticket|null}
 */
function linkCommand(m, fx, action, body, opts = {}) {
  const l = m.link, s = l.status;
  if (!l.online || l.inflight.some(c => action !== 'stop' || c.action === 'stop')) return null;
  const ticket = ticketOf(m);
  const identity = PLAYBACK_ACTIONS.includes(action) && s.selected_device ? {device_id: s.selected_device.id, device_revision: s.device_revision} : {};
  l.generation++;
  l.inflight.push({ticket, action, stage: 'posting', afterSeq: 0, ok: null, owner: opts.owner ?? null});
  m.ui.errors.local = null;
  if (opts.from) m.ui.focus = {ref: opts.from, n: opts.n, ticket};
  fx.push({fx: 'post', ticket, action, body: {...identity, ...body}});
  return ticket;
}
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
    OWNERS[c.owner]?.done(m, c);
    uiSettleFocus(m, fx, c);
  }
  startAdvance(m, fx);
  capAdvance(m, fx);
  stopAdvance(m, fx);
  seekOnStatus(m);
}
function linkOnCommandReply(m, fx, c, msg) {
  if (c.stage !== 'posting') return;
  c.ok = msg.ok;
  if (!msg.ok && (OWNERS[c.owner]?.live?.(m, c) ?? true)) m.ui.errors.local = commandError(msg);
  c.stage = 'confirming';
  c.afterSeq = linkRequestPoll(m, fx);
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
function planOnCatalogueReply(m, msg) {
  const p = m.plan;
  if (!msg.ok) { p.load = {s: 'error', message: commandError(msg)}; return; }
  if (msg.body?.catalogue) { planAcceptCatalogue(m, msg.body.catalogue); p.load = {s: 'idle'}; }
  else if (msg.body?.analysis_id) p.load = {...p.load, ticket: null, analysisId: msg.body.analysis_id};
  else p.load = {s: 'error', message: 'Respuesta inválida del puente. Actualizá las pistas.'};
}

function planSubsBranch(m, branch) {
  const p = m.plan, info = p.catalogue?.addon;
  if (!p.catalogue || p.load.s !== 'idle' || !(branch === 'none' || branch in KIND_OF_BRANCH)) return;
  if (branch === 'stremio' && (!info || info.state === 'off')) return;
  planEdit(m);
  const keep = branch !== 'none' && entryOf(p.catalogue, p.choice.entryId)?.kind === KIND_OF_BRANCH[branch];
  p.choice = branch === 'none' ? {branch} : {branch, entryId: keep ? p.choice.entryId : null};
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
  linkCommand(m, fx, 'select_device', {device_id: id, device_revision: s.device_revision}, {from: msg?.from, n: msg?.n});
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
  else p.start = {stage: 'verifying', snap, consent: null, afterSeq: linkRequestPoll(m, fx)};
}
/** After a poll issued since the click: the destination, the list and the replacement must still be what was agreed. */
function startAdvance(m, fx) {
  const p = m.plan, st = p.start, s = m.link.status, l = m.link;
  if (st?.stage !== 'verifying' || l.statusSeq <= st.afterSeq) return;
  const k = st.snap;
  p.start = null;
  if (s.selected_device?.id !== k.deviceId || s.device_revision !== k.deviceRevision) { m.ui.errors.local = 'El destino cambió. Revisá la TV y volvé a intentar.'; return; }
  if (!caps(m).start || !s.sources.some(x => x.id === k.sourceId) || samePlan(m)) return;
  const snap = s.catalogues?.[k.sourceId];
  if (snap?.state !== 'ready' || snap.catalogue.id !== k.catalogueId || (k.subtitleId && !snap.catalogue.entries.some(e => e.id === k.subtitleId && e.supported === true))) {
    m.ui.errors.local = 'La lista de subtítulos cambió. Revisá la película y volvé a iniciar.';
    return;
  }
  const now = replacementIdentity(s);
  if (now && now !== st.consent) { m.ui.confirm = {kind: 'replace', snap: k, consent: now, title: sourceTitle(s, k.sourceId)}; return; }
  const ticket = linkCommand(m, fx, 'start', {source_id: k.sourceId, catalogue_id: k.catalogueId, subtitle_id: k.subtitleId, delay_ms: 0, device_id: k.deviceId, device_revision: k.deviceRevision}, {owner: 'start'});
  if (ticket) p.start = {stage: 'posting', snap: k, ticket};
}
/** The Start command settled. A start cancelled meanwhile leaves the draft and the sheet alone. */
function planOnCommandDone(m, c) {
  if (m.plan.start?.ticket !== c.ticket) return;
  m.plan.start = null;
  if (c.ok && m.ui.sheet === 'change') m.ui.sheet = null;
}

// ───────── remote: seek, volume, captions, stop
/** Drafts and flows belong to one playback identity. Runs before any flow advances, so none acts on a playback it was not made for. */
function remoteSync(m) {
  const key = playbackKey(m.link.status);
  if (key === m.remote.key) return;
  const stopping = m.remote.stop;
  m.remote = freshRemote(key);
  if (stopping && caps(m).stop) m.ui.errors.local = STOP_MOVED;
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
function seekSend(m, fx, body, target, msg) {
  const ticket = linkCommand(m, fx, 'seek', body, {owner: 'seek', from: msg?.from, n: msg?.n});
  m.remote.seek = ticket ? {s: 'sent', target, ticket, sawBusy: false} : {s: 'idle'};
}
/** Release commits: one seek {position}. */
function seekDrop(m, fx, pos, msg) {
  const d = durationOf(m.link.status);
  if (!caps(m).transport || !d) return;
  if (!finite(pos) || pos < 0 || pos > d) {
    m.remote.seek = {s: 'idle'};
    m.ui.errors.local = 'El tiempo está fuera de la duración de la película.';
    return;
  }
  seekSend(m, fx, {position: pos}, pos, msg);
}
/** ±30 taps accumulate, clamped so the badge and the sent delta never pass [0, duration]; one seek {delta} after SKIP_MS. */
function seekSkip(m, fx, delta, msg) {
  const s = m.link.status, d = durationOf(s), k = m.remote.seek;
  if (!caps(m).transport || !d || !finite(s.absolute_time) || !finite(delta)) return;
  const sum = (k.s === 'skipping' ? k.delta : 0) + delta, ticket = ticketOf(m);
  m.remote.seek = {s: 'skipping', delta: clamp(sum, -s.absolute_time, d - s.absolute_time), ticket, from: msg?.from ?? k.from, n: msg?.n ?? k.n};
  fx.push({fx: 'timer', name: 'skip', ms: SKIP_MS, ticket});
}
function seekOnTimer(m, fx, msg) {
  const k = m.remote.seek, s = m.link.status;
  if (k.s !== 'skipping' || k.ticket !== msg.ticket) return;
  if (k.delta === 0) m.remote.seek = {s: 'idle'};
  else if (caps(m).transport) seekSend(m, fx, {delta: k.delta}, clamp(s.absolute_time + k.delta, 0, durationOf(s) ?? Infinity), k);
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
  if (!c.ok && k.s === 'sent' && k.ticket === c.ticket) m.remote.seek = {s: 'idle'};
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
  if (!ok || !linkCommand(m, fx, 'volume', {level: clamp(value, 0, 100) / 100}, {owner: 'volume', from: msg.from, n: msg.n})) m.remote.volumePreview = null;
}
function muteToggle(m, fx, msg) {
  const s = m.link.status;
  if (caps(m).transport && typeof s.muted === 'boolean') linkCommand(m, fx, 'mute', {muted: !s.muted}, {from: msg.from, n: msg.n});
}
function toggle(m, fx, msg) {
  if (!caps(m).transport) return;
  linkCommand(m, fx, m.link.status.phase === 'playing' ? 'pause' : 'resume', {}, {from: msg.from, n: msg.n});
}

// captions: the draft is edited locally; Aplicar and the visibility toggle share one pipeline that waits for readback
const MAX_READS = 6;
const capSame = (a, b) => a.subtitleId === b.subtitleId && a.delayMs === b.delayMs;
/** Derived, never stored: the draft differs from what the TV has. */
const capDirty = m => !!m.remote.captions.draft && !capSame(m.remote.captions.draft, capServer(m.link.status));
/** capTrack / capNudge / capReset. A draft equal to the server's is no draft. */
function capEdit(m, kind, arg) {
  if (!caps(m).captions) return;
  const cur = capDraft(m);
  let next;
  if (kind === 'track') {
    const id = arg === '' || arg == null ? null : String(arg);
    if (id !== null && !entryOf(remoteCatalogue(m), id)?.supported) return;
    next = {subtitleId: id, delayMs: id === null ? 0 : cur.delayMs};
  } else if (!cur.subtitleId || (kind === 'nudge' && !finite(arg))) return;
  else next = {subtitleId: cur.subtitleId, delayMs: kind === 'reset' ? 0 : clamp(Math.round((cur.delayMs + arg) / 100) * 100, -30000, 30000)};
  m.remote.captions.draft = capSame(next, capServer(m.link.status)) ? null : next;
}
function capBegin(m, fx, kind, want, msg) {
  const s = m.link.status;
  m.remote.captions.apply = {
    kind, stage: 'verifying', want, catalogueId: s.active_catalogue.id, afterSeq: linkRequestPoll(m, fx), ticket: null,
    prevVisible: typeof s.subtitles_enabled === 'boolean' ? s.subtitles_enabled : null, errorAtStart: errorIdentity(s), reads: 0, from: msg?.from, n: msg?.n,
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
function capFail(m, message) {
  const a = m.remote.captions.apply, s = m.link.status;
  const partial = !!a && typeof a.prevVisible === 'boolean' && s.subtitles_enabled !== a.prevVisible && s.subtitles_enabled === a.want.enabled && s.subtitle_delay_ms !== a.want.delayMs;
  m.remote.captions.apply = null;
  m.ui.errors.local = `${partial ? 'La visibilidad ya cambió; la sincronía sigue sin confirmar. ' : ''}${message}${a?.kind === 'plan' ? ' Tu ajuste sigue en borrador.' : ''}`;
}
/** The server holds exactly what was asked for, by every field it reports. */
function capSettled(s, a) {
  const srv = capServer(s), w = a.want, choice = s.subtitle_choice;
  return srv.subtitleId === w.subtitleId && srv.enabled === w.enabled && srv.delayMs === w.delayMs
    && (w.subtitleId === null || choice?.catalogue_id === a.catalogueId)
    && (!finite(s.subtitle_delay_ms) || s.subtitle_delay_ms === w.delayMs)
    && (typeof s.subtitles_enabled !== 'boolean' || s.subtitles_enabled === w.enabled);
}
function capAdvance(m, fx) {
  const a = m.remote.captions.apply, l = m.link, s = l.status, c = caps(m);
  if (!a) return;
  if (!c.online || c.foreign || s.phase === 'error') return capFail(m, 'Se interrumpió el cambio. Revisá el estado de la TV.');
  if (a.stage === 'verifying') {
    if (l.statusSeq <= a.afterSeq) return;
    if (!c.transport) return capFail(m, 'La TV estaba ocupada y no se aplicó el cambio. Reintentá en un momento.');
    if (s.active_catalogue?.id !== a.catalogueId) { m.remote.captions.apply = null; return; }
    const ticket = linkCommand(m, fx, 'subtitles', {playback_id: s.playback_id, catalogue_id: a.catalogueId, subtitle_id: a.want.subtitleId, enabled: a.want.enabled, delay_ms: a.want.delayMs}, {owner: 'captions', from: a.from, n: a.n});
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
  if (c.ok) a.stage = 'reading'; else capFail(m, m.ui.errors.local || 'No se pudo aplicar el cambio.');
}

function remoteStop(m, fx, msg) {
  const c = caps(m), s = m.link.status;
  if (!c.stop || m.ui.confirm) return;
  if (c.stopNeedsConfirm) m.ui.confirm = {kind: 'stop', key: m.remote.key};
  else remoteStopNow(m, fx, s.playback_id ? {playback_id: s.playback_id} : {}, msg);
}
function remoteCancelFlows(m) {
  planTouch(m);
  m.remote.captions.apply = null;
  m.remote.seek = {s: 'idle'};
}
function remoteStopNow(m, fx, body, msg) {
  const u = m.ui;
  remoteCancelFlows(m);
  u.confirm = null;
  u.sheet = null;
  if (linkCommand(m, fx, 'stop', body, {owner: 'stop', from: msg?.from, n: msg?.n})) u.stopIssued = true;
}
function stopAdvance(m, fx) {
  const st = m.remote.stop, s = m.link.status;
  if (!st || m.link.statusSeq <= st.afterSeq) return;
  m.remote.stop = null;
  if (caps(m).stop) remoteStopNow(m, fx, s.playback_id ? {playback_id: s.playback_id} : {});
}

// ───────── ui: layers, errors
/** openSubs / openMore / openChange. 'change' starts from an empty plan. */
function uiOpen(m, sheet) {
  if (m.ui.confirm || !caps(m).sheets[sheet].open) return;
  if (sheet === 'change') planReset(m, null);
  if (sheet === 'more') m.ui.exact = {text: '', error: ''};
  m.ui.sheet = sheet;
}
/** Escape, the backdrop, the sheet close button and the confirm cancel: close the TOP layer only; any dismissal cancels a pending start. */
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
    m.remote.stop = {afterSeq: linkRequestPoll(m, fx)};
  } else if (c?.kind === 'replace') {
    const k = c.snap;
    if (p.sourceId !== k.sourceId || p.catalogue?.id !== k.catalogueId || planSubtitleId(p) !== k.subtitleId) return;
    p.start = {stage: 'verifying', snap: k, consent: c.consent, afterSeq: linkRequestPoll(m, fx)};
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
    if (c.stop) u.errors.local = STOP_MOVED;
  }
}
/** The focus ticket is honoured once the command settles, and only if the user has not touched anything since. */
function uiSettleFocus(m, fx, c) {
  const f = m.ui.focus;
  if (f?.ticket !== c.ticket) return;
  m.ui.focus = null;
  if (f.n === m.n) fx.push({fx: 'focus', ref: f.ref, n: f.n});
}
/** What the one problem block says, or null. The same function decides what dismissNotice dismisses. */
function problemOf(m) {
  const s = m.link.status, c = caps(m), u = m.ui;
  const stopAction = label => ({act: 'stop', label, enabled: c.stop});
  if (!c.online) return {kind: 'offline', title: 'Sin conexión con el puente', body: 'No podemos confirmar qué pasa en la TV. Seguimos intentando.', action: null};
  if (!KNOWN.has(s.phase)) return {kind: 'unknown', title: 'Estado desconocido de la TV', body: 'Este mando no entiende lo que pasa en la TV. Detené para volver a elegir.', action: stopAction('Detener')};
  if (s.phase === 'receiver_changed') return {kind: 'foreign', title: 'Hay otro contenido en la TV', body: 'Este mando no lo controla. Detené para volver a elegir.', action: stopAction('Detener y volver a elegir')};
  if (s.phase === 'disconnected') return {kind: 'disconnected', title: 'TV no disponible', body: 'Se perdió la conexión con la TV. Detené para volver a elegir.', action: stopAction('Detener')};
  if (s.phase === 'error') return {kind: 'failed', title: 'No se pudo completar la acción', body: s.message || 'Revisá la película y volvé a intentar.', action: s.can_change_device === false ? stopAction('Detener') : null};
  const say = u.errors.local ?? backendError(m);
  if (say) return {kind: 'notice', title: 'No se pudo completar la acción', body: say, action: {act: 'dismissNotice', label: 'Entendido', enabled: true}};
  if (u.stoppedNotice) return {kind: 'stopped', title: `Película detenida en ${u.lastDeviceLabel || 'la TV'}`, body: '', action: {act: 'dismissNotice', label: 'Cerrar', enabled: true}};
  return null;
}
const problemOffersStop = m => problemOf(m)?.action?.act === 'stop';
/** The server's action_error, unless dismissed, absorbed by a caption apply that reported it, or an apply is still pending. */
function backendError(m) {
  const s = m.link.status, id = errorIdentity(s), e = m.ui.errors;
  return id && id !== e.dismissed && id !== e.absorbed && !m.remote.captions.apply ? s.action_error : null;
}
function uiDismissNotice(m) {
  const kind = problemOf(m)?.kind, e = m.ui.errors;
  if (kind !== 'notice' && kind !== 'stopped') return;
  if (kind === 'stopped') m.ui.stoppedNotice = false;
  else if (e.local !== null) e.local = null;
  else e.dismissed = errorIdentity(m.link.status);
}
function uiScenario(m, fx, value, msg) {
  if (m.link.status.demo === true) linkCommand(m, fx, 'scenario', {state: String(value)}, {from: msg?.from, n: msg?.n});
}

/** What settles each command when its confirming poll lands. `live` says whether a failed reply is still worth reporting; absent means always. */
const OWNERS = {
  start: {done: planOnCommandDone},
  seek: {done: seekOnCommandDone},
  captions: {live: (m, c) => m.remote.captions.apply?.ticket === c.ticket, done: capOnCommandDone},
  volume: {done: m => { m.remote.volumePreview = null; }},
  stop: {done: (m, c) => { if (!c.ok) m.ui.stopIssued = false; }},
};

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
  stoppedNotice: false, stopIssued: false, exact: {text: '', error: ''}, mode: null, reseed: false, clock: null, lastSourceId: null, lastDeviceLabel: '',
});

/** @param {{lastDeviceId?:string|null}} [boot] @returns {{model:Model,fx:object[]}} the first poll is in fx */
function init(boot = {}) {
  const m = {
    nextTicket: 0, now: 0, n: 0, prefs: {lastDeviceId: boot.lastDeviceId ?? null, autoSelectTried: false},
    link: {status: NO_STATUS, online: false, statusAt: 0, generation: 0, seq: 0, statusSeq: 0, polling: false, repoll: false, pollTimer: null, inflight: []},
    plan: freshPlan(null), remote: freshRemote(playbackKey(NO_STATUS)), ui: freshUi(),
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
  m.n = msg.n ?? m.n;
  if (msg.t === 'status') linkOnStatus(m, fx, msg);
  else if (msg.t === 'reply') linkRouteReply(m, fx, msg);
  else if (msg.t === 'timer') onTimer(m, fx, msg);
  else if (msg.t === 'file') planFileRead(m, fx, msg);
  else if (Object.hasOwn(ACTS, msg.t)) ACTS[msg.t](m, fx, msg);
  reconcile(m, fx);
  return {model: m, fx};
}
function linkRouteReply(m, fx, msg) {
  const c = m.link.inflight.find(x => x.ticket === msg.ticket);
  if (c) linkOnCommandReply(m, fx, c, msg);
  else planOnReply(m, fx, msg);
}
function onTimer(m, fx, msg) {
  const l = m.link;
  if (msg.name === 'poll' && msg.ticket === l.pollTimer) {
    l.pollTimer = null;
    if (!l.polling) linkIssuePoll(m, fx);
  } else if (msg.name === 'skip') seekOnTimer(m, fx, msg);
  else if (msg.name === 'clock' && msg.ticket === m.ui.clock) m.ui.clock = null;
}
/** Idempotent standing rules, run after every message: "whenever X holds, make Y so". */
function reconcile(m, fx) {
  const l = m.link, s = l.status, u = m.ui, c = caps(m);
  if (c.owned && !c.foreign && s.selected_device) { u.lastSourceId = s.source_id ?? u.lastSourceId; u.lastDeviceLabel = deviceLabel(s.selected_device); }
  uiValidLayers(m);
  const mode = modeOf(m);
  if (u.mode === 'mando' && mode === 'preparar') { planReset(m, null); u.reseed = true; u.stoppedNotice = u.stopIssued; u.stopIssued = false; }
  if (mode === 'mando') u.stoppedNotice = false;
  u.mode = mode;
  if (u.reseed && l.online && !m.plan.sourceId) {
    u.reseed = false;
    const id = [s.source_id, u.lastSourceId].find(x => x && s.sources.some(y => y.id === x));
    if (id) planPickSource(m, fx, id);
  }
  // the flap clock ticks only while a movie plays
  if (u.mode === 'mando' && s.phase === 'playing' && l.online && u.clock === null) {
    u.clock = ticketOf(m);
    fx.push({fx: 'timer', name: 'clock', ms: CLOCK_MS, ticket: u.clock});
  }
  if (s.selected_device && s.selected_device.id !== m.prefs.lastDeviceId) {
    m.prefs.lastDeviceId = s.selected_device.id;
    fx.push({fx: 'store', key: 'cast.lastDevice', value: s.selected_device.id});
  }
  if (!s.selected_device && !m.prefs.autoSelectTried && m.prefs.lastDeviceId && caps(m).changeDevice
      && s.devices?.some(d => d.id === m.prefs.lastDeviceId && d.available !== false)) {
    m.prefs.autoSelectTried = true;
    planPickDevice(m, fx, m.prefs.lastDeviceId);
  }
  const info = m.plan.catalogue?.addon;
  if (m.plan.choice.branch === 'stremio' && (!info || info.state === 'off')) m.plan.choice = {branch: 'none', entryId: null};
  addonReconcile(m, fx, 'plan');
  addonReconcile(m, fx, 'remote');
}

/**
 * THE list of user messages and their handlers: (model, fx, msg) -> void. `arg` arrives as the shell read it (string or
 * number); every handler re-checks caps() before it does anything, so a stale click, a key and a test hit one guard.
 */
const ACTS = Object.freeze({
  pickSource: (m, fx, g) => planPickSource(m, fx, String(g.arg)),
  refreshSources: (m, fx) => planRefresh(m, fx, 'discover'),
  pickDevice: (m, fx, g) => planPickDevice(m, fx, String(g.arg), g),
  refreshDevices: (m, fx) => planRefresh(m, fx, 'discover_devices'),
  refreshCatalogue: (m, fx) => planRequestCatalogue(m, fx, true),
  subsBranch: (m, fx, g) => planSubsBranch(m, String(g.arg)),
  pickEntry: (m, fx, g) => planPickEntry(m, String(g.arg)),
  filePicked: (m, fx, g) => planFilePicked(m, fx, g.arg),
  stremioLanguage: (m, fx, g) => addonLanguage(m, stremioScope(m), g.arg),
  stremioVersion: (m, fx, g) => addonVersion(m, stremioScope(m), g.arg),
  stremioUse: (m, fx) => addonUse(m, fx, stremioScope(m)),
  stremioRetry: (m, fx) => addonRetry(m, fx, stremioScope(m)),
  stremioWrong: m => addonWrong(m, stremioScope(m)),
  stremioAlt: (m, fx, g) => addonAlternative(m, fx, stremioScope(m), Number(g.arg)),
  stremioSearch: (m, fx, g) => addonSearch(m, fx, stremioScope(m), g.arg),
  start: planStart,
  toggle, stop: remoteStop,
  skip: (m, fx, g) => seekSkip(m, fx, Number(g.arg), g),
  dragSeek: (m, fx, g) => seekDrag(m, Number(g.arg)),
  dropSeek: (m, fx, g) => seekDrop(m, fx, Number(g.arg), g),
  seekAbandon,
  volumePreview: (m, fx, g) => volumePreview(m, Number(g.arg)),
  volume: (m, fx, g) => volumeSet(m, fx, Number(g.arg), g),
  mute: muteToggle,
  capTrack: (m, fx, g) => capEdit(m, 'track', g.arg),
  capNudge: (m, fx, g) => { if (!m.ui.sheet) uiOpen(m, 'subs'); capEdit(m, 'nudge', Number(g.arg)); },
  capReset: m => capEdit(m, 'reset'),
  capVisible: (m, fx, g) => capVisible(m, fx, g.arg === true || g.arg === 'true', g),
  capApply,
  capDiscard,
  exactInput: (m, fx, g) => { m.ui.exact = {text: String(g.arg ?? ''), error: ''}; },
  gotoTime: (m, fx, g) => seekGoto(m, fx, g.arg, g),
  dismissNotice: uiDismissNotice,
  scenario: (m, fx, g) => uiScenario(m, fx, g.arg, g),
  openSubs: m => uiOpen(m, 'subs'),
  openMore: m => uiOpen(m, 'more'),
  openChange: m => uiOpen(m, 'change'),
  dismiss: uiDismiss,
  confirmAccept: uiConfirmAccept,
});

const SWALLOWED = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' ']);
/**
 * Keyboard policy, pure. `k` = {key, mods, repeat, typing, onButton, idle, n}: typing is an input/select/textarea target (the
 * timeline range is not), onButton means Space belongs to the focused button, idle means nothing has focus.
 * Returns a message for step, 'swallow' (cancel the key, send nothing) or null (leave it to the browser).
 * @param {View} v @returns {{t:string,arg?:any}|'swallow'|null}
 */
function keyMsg(v, k) {
  if (v.restoring && v.restoring.n === k.n && k.idle && SWALLOWED.has(k.key)) return 'swallow';
  if (k.mods || k.repeat || k.typing || v.confirm || v.mode !== 'mando' || !v.mando) return null;
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  if ((key === 'z' || key === 'x') && (v.sheet ? v.sheet.kind === 'subs' : v.mando.chip.enabled)) return {t: 'capNudge', arg: key === 'z' ? -100 : 100};
  if (v.sheet) return null;
  if (key === ' ') return k.onButton ? null : {t: 'toggle'};
  if (key === 'ArrowLeft') return {t: 'skip', arg: -SKIP_S};
  if (key === 'ArrowRight') return {t: 'skip', arg: SKIP_S};
  if (key === 'm') return {t: 'mute'};
  return null;
}
