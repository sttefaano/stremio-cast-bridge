// Panel core: pure data in, plain data out. It never touches document, fetch, timers, storage or `token`;
// a DOM shell performs the effects it returns and paints Panel.view().
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
   * @property {Start|null} start  written ONLY by planTouch (clears), planReset (fresh plan), planStart, startAdvance, planOnCommandDone, uiConfirmAccept
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
   * @property {boolean} stoppedNotice  'Película detenida en <TV>' not yet dismissed
   * @property {boolean} stopIssued  our Stop was sent; the next return to Preparar shows the notice  @property {{text:string,error:string}} exact
   * @property {'preparar'|'mando'|null} mode @property {boolean} reseed @property {Ticket|null} clock
   * @property {string|null} lastSourceId @property {string} lastDeviceLabel
   */
  /** @typedef {{link:Link,plan:Plan,remote:Remote,ui:Ui,prefs:{lastDeviceId:string|null,autoSelectTried:boolean},nextTicket:number,now:number,n:number}} Model */

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
  /** What the TV says about captions right now, from the server's own fields. */
  function capServer(s) {
    const c = s?.subtitle_choice;
    return {
      subtitleId: c?.subtitle_id ?? null,
      enabled: typeof c?.enabled === 'boolean' ? c.enabled : s?.subtitles_enabled === true,
      delayMs: finite(c?.delay_ms) ? c.delay_ms : finite(s?.subtitle_delay_ms) ? s.subtitle_delay_ms : 0,
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
    remoteSync(m);
    uiObserveError(m);
    planAdoptSnapshot(m);
    if (l.command?.stage === 'confirming' && l.appliedSeq > l.command.afterSeq) {
      const done = l.command;
      l.command = null;
      onCommandDone(m, done);
      uiSettleFocus(m, fx);
    }
    startAdvance(m, fx);
    capAdvance(m, fx);
    stopAdvance(m, fx);
    seekOnStatus(m);
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
  function onCommandDone(m, c) {
    if (c.owner === 'start') planOnCommandDone(m, c);
    else if (c.owner === 'seek') seekOnCommandDone(m, c);
    else if (c.owner === 'captions') capOnCommandDone(m, c);
    else if (c.owner === 'volume') m.remote.volumePreview = null;
    else if (c.owner === 'stop' && !c.ok) m.ui.stopIssued = false;
  }

  // ───────── plan: movie, catalogue, subtitle decision, Start
  /** THE cancellation point (policy 7): a pending Start and an open replacement consent die here. */
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

  /** Plan half of policy 5, with the names of what is still missing for the stub. */
  function planCanStart(m) {
    const s = m.link.status || NO_STATUS, p = m.plan, missing = [];
    if (!p.sourceId || !s.sources.some(x => x.id === p.sourceId)) missing.push('PELÍCULA');
    if (!s.selected_device) missing.push('TV'); else if (s.selected_device.available !== true) missing.push('TV DISPONIBLE');
    const resolved = p.choice.branch === 'none' || entryOf(p.catalogue, p.choice.entryId)?.supported === true;
    if (p.sourceId && p.catalogue && p.load.s === 'idle' && !resolved) missing.push('SUBTÍTULO');
    const waiting = !p.catalogue || p.load.s !== 'idle' || p.upload.s === 'busy' || p.addon.op?.kind === 'fetch';
    return missing.length || waiting ? {ok: false, missing} : {ok: true, missing};
  }
  /** What is on the TV already is exactly this plan: starting it again would only restart it. */
  function samePlan(m) {
    const s = m.link.status || NO_STATUS, p = m.plan, c = s.subtitle_choice, id = planSubtitleId(p);
    return LIVE.includes(s.phase) && !!p.catalogue && p.sourceId === s.source_id && c?.catalogue_id === p.catalogue.id
      && (c?.subtitle_id ?? null) === id && (c?.delay_ms ?? 0) === 0 && c?.enabled === (id !== null);
  }

  function planPickSource(m, fx, id) {
    const s = m.link.status;
    if (!m.link.online || !s?.sources.some(x => x.id === id) || m.plan.sourceId === id) return;
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
  /**
   * Monotonic merge (policy 11): never fewer entries or a lower addon revision for the same id; a new id starts the
   * plan over. Returns whether the plan took it.
   */
  function planAcceptCatalogue(m, cat) {
    const p = m.plan, cur = p.catalogue;
    if (!cat || cat.source_id !== p.sourceId) return false;
    if (cur?.id === cat.id) {
      if (cat.entries.length < cur.entries.length || addonRevision(cat) < addonRevision(cur)) return false;
      p.catalogue = cat;
      return richer(cat, cur);
    }
    if (cur) {
      p.choice = {branch: 'none', entryId: null};
      p.upload = {s: 'idle', filename: '', message: ''};
      p.addon = freshAddon();
      planTouch(m);
    }
    p.catalogue = cat;
    return true;
  }
  /** Consume status.catalogues[plan.sourceId]; a source that left the list ends the plan. */
  function planAdoptSnapshot(m) {
    const s = m.link.status, p = m.plan;
    if (!s || !p.sourceId) return;
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

  /** pickDevice never casts: it only selects (policy 4). */
  function planPickDevice(m, fx, id, msg) {
    const s = m.link.status;
    if (!caps(m).changeDevice || !s.devices?.some(d => d.id === id) || s.selected_device?.id === id) return;
    linkCommand(m, fx, 'select_device', {device_id: id, device_revision: s.device_revision}, {from: msg?.from, n: msg?.n});
  }
  /** discover / discover_devices: independent of commands, one in flight per kind. */
  function planRefresh(m, fx, kind) {
    const r = m.plan.refresh[kind], s = m.link.status || NO_STATUS;
    if (!m.link.online || r.ticket || (kind === 'discover' ? s.source_discovery : s.device_discovery) === 'loading') return;
    r.ticket = ticketOf(m);
    r.error = '';
    fx.push({fx: 'post', ticket: r.ticket, action: kind, body: {}});
  }

  /** start intent (policies 3, 5, 6): nothing is sent from the click itself. */
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
    if (st?.stage !== 'verifying' || l.appliedSeq <= st.afterSeq) return;
    const k = st.snap;
    p.start = null;
    if (s?.selected_device?.id !== k.deviceId || s.device_revision !== k.deviceRevision) { m.ui.errors.local = 'El destino cambió. Revisá la TV y volvé a intentar.'; return; }
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

  // ───────── addon (Stremio): one state machine for the plan and for the live subtitle sheet
  const ADDON_LOADING = 'Buscando subtítulos de Stremio…';
  const ADDON_ERROR = 'No se pudieron buscar subtítulos de Stremio. Las pistas y los archivos locales siguen disponibles.';
  const addonKey = cat => cat?.addon ? `${cat.id}:${cat.addon.revision}` : '';
  const addonSay = (a, cat, text) => { a.message = text ? {text, key: addonKey(cat)} : null; };
  const addonFailure = msg => msg.timeout ? 'La consulta tardó demasiado. Reintentá.' : commandError(msg);
  const stremioScope = m => m.ui.sheet === 'subs' ? 'remote' : 'plan';
  /** The newer of the server's active catalogue and what a lookup or download returned since. */
  function remoteCatalogue(m) {
    const a = m.link.status?.active_catalogue ?? null, o = m.remote.overlay;
    return a && o && o.id === a.id && o.entries.length >= a.entries.length && addonRevision(o) >= addonRevision(a) ? o : a;
  }
  function addonCtx(m, scope) {
    const c = caps(m), s = m.link.status || NO_STATUS;
    if (scope === 'plan') {
      const p = m.plan;
      return {
        addon: p.addon, catalogue: p.catalogue, shown: p.choice.branch === 'stremio', when: 'Se usará solo al iniciar.',
        canAct: c.online && !!p.catalogue && p.load.s === 'idle' && p.upload.s === 'idle',
        accept(cat, entry) {
          planAcceptCatalogue(m, cat);
          if (!entry) return true;
          if (!entryOf(m.plan.catalogue, entry.id)?.supported) return false;
          planTouch(m);
          m.plan.choice = {branch: 'stremio', entryId: entry.id};
          return true;
        },
      };
    }
    const r = m.remote;
    return {
      addon: r.addon, catalogue: remoteCatalogue(m), shown: m.ui.sheet === 'subs', when: 'Se usará solo al aplicar.',
      canAct: c.online && !c.foreign && !!s.playback_id && !r.captions.apply,
      accept(cat, entry) {
        const cur = remoteCatalogue(m);
        if (!cur || cat?.id !== cur.id || cat.entries.length < cur.entries.length || addonRevision(cat) < addonRevision(cur)) return false;
        r.overlay = cat;
        if (!entry) return true;
        if (!entryOf(cat, entry.id)?.supported) return false;
        r.captions.draft = {subtitleId: entry.id, delayMs: capDraft(m).delayMs};
        return true;
      },
    };
  }
  /** Languages, versions and the effective selection, derived (never written) so view and handlers agree. */
  function addonOffers(a, cat) {
    const info = cat?.addon, key = addonKey(cat);
    const listing = info && a.listingKey === key && a.listing?.revision === info.revision ? a.listing : null;
    const offers = listing?.offers || [], languages = [];
    for (const o of offers) {
      const found = languages.find(l => l.code === o.language);
      if (found) found.count++; else languages.push({code: o.language, name: o.language_name, count: 1});
    }
    const language = languages.some(l => l.code === a.language) ? a.language : languages[0]?.code || '';
    const versions = offers.filter(o => o.language === language);
    const offerId = versions.some(o => o.id === a.offerId) ? a.offerId : versions[0]?.id || '';
    return {listing, offers, languages, versions, language, offerId};
  }
  function addonReady(m, scope) {
    const x = addonCtx(m, scope);
    return x.canAct && !x.addon.op && x.catalogue?.addon ? x : null;
  }
  function addonLanguage(m, scope, code) {
    const x = addonReady(m, scope);
    if (x) { x.addon.language = String(code); x.addon.offerId = ''; }
  }
  function addonVersion(m, scope, id) {
    const x = addonReady(m, scope);
    if (x) x.addon.offerId = String(id);
  }
  function addonWrong(m, scope) {
    const x = addonReady(m, scope);
    if (x) x.addon.correcting = !x.addon.correcting;
  }
  function addonUse(m, fx, scope) {
    const x = addonReady(m, scope);
    if (!x || x.catalogue.addon.state !== 'ready') return;
    const eff = addonOffers(x.addon, x.catalogue), offer = eff.offers.find(o => o.id === eff.offerId);
    if (!offer) return;
    const ticket = ticketOf(m);
    x.addon.message = null;
    x.addon.op = {kind: 'fetch', ticket, offerId: offer.id};
    fx.push({fx: 'post', ticket, action: 'subtitle_fetch', body: {source_id: x.catalogue.source_id, catalogue_id: x.catalogue.id, offer_id: offer.id}});
  }
  function addonLookup(m, fx, scope, hint) {
    const x = addonReady(m, scope);
    if (!x) return;
    const ticket = ticketOf(m);
    x.addon.lastHint = hint;
    x.addon.message = null;
    x.addon.op = {kind: 'lookup', ticket};
    fx.push({fx: 'post', ticket, action: 'subtitle_lookup', body: {source_id: x.catalogue.source_id, catalogue_id: x.catalogue.id, hint}});
  }
  function addonAlternative(m, fx, scope, index) {
    const x = addonReady(m, scope), alt = x && addonOffers(x.addon, x.catalogue).listing?.alternatives?.slice(0, 4)[index];
    if (alt) addonLookup(m, fx, scope, `${alt.id} ${alt.title} ${alt.year ?? ''}`.trim().slice(0, 200));
  }
  function addonSearch(m, fx, scope, text) {
    const x = addonReady(m, scope), hint = String(text ?? '').trim();
    if (!x || !hint) return;
    if (hint.length > 200) { addonSay(x.addon, x.catalogue, 'Escribí un título de hasta 200 caracteres.'); return; }
    addonLookup(m, fx, scope, hint);
  }
  function addonOnReply(m, scope, msg) {
    const x = addonCtx(m, scope), a = x.addon, op = a.op;
    a.op = null;
    if (op.kind === 'lookup') {
      if (!msg.ok) return addonSay(a, x.catalogue, addonFailure(msg));
      x.accept(msg.body?.catalogue, null);
      a.correcting = false;
    } else if (!msg.ok) {
      if (msg.code === 'invalid_subtitle' && !a.unreadable.includes(op.offerId)) a.unreadable.push(op.offerId);
      addonSay(a, x.catalogue, addonFailure(msg));
    } else {
      const entry = verifiedEntry(msg.body, x.catalogue);
      if (entry && x.accept(msg.body.catalogue, entry)) addonSay(a, addonCtx(m, scope).catalogue, `Subtítulo listo: ${entry.label}. ${x.when}`);
      else addonSay(a, x.catalogue, 'La lista de pistas cambió. Actualizala y probá otra vez.');
    }
  }
  function addonOnPull(m, scope, msg) {
    const a = addonCtx(m, scope).addon, key = a.pull.key;
    if (msg.ok) { a.listing = msg.body; a.listingKey = key; a.pull = {s: 'idle'}; } else a.pull = {s: 'failed', key};
  }
  /** Offers are pulled when someone is looking at the block and the listing for this catalogue revision is missing. */
  function addonReconcile(m, fx, scope) {
    const x = addonCtx(m, scope), a = x.addon, cat = x.catalogue, info = cat?.addon;
    if (!x.shown || !m.link.online || !info || !(info.state === 'ready' || info.state === 'unidentified')) return;
    const key = addonKey(cat);
    if (a.listingKey === key || (a.pull.s !== 'idle' && a.pull.key === key)) return;
    const ticket = ticketOf(m);
    a.pull = {s: 'pulling', key, ticket};
    fx.push({fx: 'post', ticket, action: 'subtitle_offers', body: {source_id: cat.source_id, catalogue_id: cat.id}});
  }

  /** Reply for any ticket that is not the command slot. An unknown ticket is dropped: that is the fence. */
  function planOnReply(m, fx, msg) {
    const p = m.plan, t = msg.ticket;
    if (p.load.s === 'loading' && p.load.ticket === t) return planOnCatalogueReply(m, msg);
    if (p.upload.s === 'busy' && p.upload.ticket === t && p.upload.stage === 'posting') return planOnUploadReply(m, msg);
    for (const kind of ['discover', 'discover_devices']) {
      const r = p.refresh[kind];
      if (r.ticket !== t) continue;
      r.ticket = null;
      if (msg.ok) linkRequestPoll(m, fx); else r.error = commandError(msg);
      return;
    }
    for (const [scope, a] of [['plan', p.addon], ['remote', m.remote.addon]]) {
      if (a.pull.s === 'pulling' && a.pull.ticket === t) return addonOnPull(m, scope, msg);
      if (a.op?.ticket === t) return addonOnReply(m, scope, msg);
    }
  }

  // ───────── remote: seek, volume, captions, stop
  /** Drafts and flows belong to one playback identity. Runs before any flow advances, so none acts on a playback it was not made for. */
  function remoteSync(m) {
    const key = playbackKey(m.link.status);
    if (key === m.remote.key) return;
    if (m.remote.stop) m.ui.errors.local = 'La TV cambió o hay otra sesión. Revisá antes de detener.';
    m.remote = freshRemote(key);
    if (m.ui.sheet === 'subs') m.ui.sheet = null;
  }
  const durationOf = s => finite(s?.duration) && s.duration > 0 ? s.duration : null;

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
    else if (m.link.command) {
      const ticket = ticketOf(m);
      m.remote.seek = {...k, ticket};
      fx.push({fx: 'timer', name: 'skip', ms: SKIP_MS, ticket});
    } else m.remote.seek = {s: 'idle'};
  }
  /** A sent seek stays on screen until the TV is usable and either was seen busy or reached the target (policy 14). */
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
    if (ok) linkCommand(m, fx, 'volume', {level: clamp(value, 0, 100) / 100}, {owner: 'volume', from: msg.from, n: msg.n});
    if (!ok || !m.link.command) m.remote.volumePreview = null;
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
    const partial = !!a && typeof a.prevVisible === 'boolean' && s?.subtitles_enabled !== a.prevVisible && s?.subtitles_enabled === a.want.enabled && s?.subtitle_delay_ms !== a.want.delayMs;
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
  /** Runs on every applied status (policy 13). A playback identity change dropped the apply already, in reconcile. */
  function capAdvance(m, fx) {
    const a = m.remote.captions.apply, l = m.link, s = l.status, c = caps(m);
    if (!a) return;
    if (!c.online || c.foreign || s.phase === 'error') return capFail(m, 'Se interrumpió el cambio. Revisá el estado de la TV.');
    if (a.stage === 'verifying') {
      if (l.appliedSeq <= a.afterSeq) return;
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

  /** stop intent (policy 8). Confirm only while playing or paused; anything else stops at once and interrupts. */
  function remoteStop(m, fx, msg) {
    const c = caps(m), s = m.link.status;
    if (!c.stop) return;
    if (c.stopNeedsConfirm) m.ui.confirm = {kind: 'stop', snap: {deviceId: s.selected_device?.id, deviceRevision: s.device_revision, playbackId: s.playback_id ?? null}};
    else remoteStopNow(m, fx, s.playback_id ? {playback_id: s.playback_id} : {}, msg);
  }
  function remoteStopNow(m, fx, body, msg) {
    const u = m.ui;
    planTouch(m);
    m.remote.captions.apply = null;
    m.remote.seek = {s: 'idle'};
    m.remote.stop = null;
    u.confirm = null;
    u.sheet = null;
    if (linkCommand(m, fx, 'stop', body, {owner: 'stop', from: msg?.from, n: msg?.n})) u.stopIssued = true;
  }
  /**
   * After a poll issued since the click: no command since and, because remoteSync would have dropped the consent
   * (with a message) if the TV, its revision or the playback had changed, the consent still holds.
   */
  function stopAdvance(m, fx) {
    const st = m.remote.stop, l = m.link;
    if (!st || l.appliedSeq <= st.afterSeq) return;
    m.remote.stop = null;
    if (st.generation === l.generation && caps(m).stop) remoteStopNow(m, fx, st.snap.playbackId ? {playback_id: st.snap.playbackId} : {});
  }

  // ───────── ui: layers, errors
  /** openSubs / openMore / openChange. 'change' starts from an empty plan. */
  function uiOpen(m, sheet) {
    const s = m.link.status || NO_STATUS, c = caps(m);
    if (m.ui.confirm) return;
    if (sheet === 'subs' && !(s.playback_id && remoteCatalogue(m) && c.online && !c.foreign)) return;
    if (sheet === 'more' && !c.owned) return;
    if (sheet === 'change') {
      if (!c.owned || c.foreign || !c.online) return;
      planReset(m, null);
    }
    if (sheet === 'more') m.ui.exact = {text: '', error: ''};
    m.ui.sheet = sheet;
  }
  /** dismiss (Escape, backdrop), confirmCancel, closeSheet: close the TOP layer only; any dismissal cancels a pending start. */
  function uiDismiss(m) {
    const u = m.ui;
    if (u.confirm) { if (u.confirm.kind === 'replace') planTouch(m); u.confirm = null; return; }
    const was = u.sheet;
    u.sheet = null;
    planTouch(m);
    if (was === 'change') planReset(m, null);
  }
  function uiConfirmAccept(m, fx) {
    const c = m.ui.confirm, p = m.plan;
    if (!c) return;
    m.ui.confirm = null;
    if (c.kind === 'replace') {
      const k = c.snap;
      if (p.sourceId !== k.sourceId || p.catalogue?.id !== k.catalogueId || planSubtitleId(p) !== k.subtitleId) return;
      p.start = {stage: 'verifying', snap: k, consent: c.consent, afterSeq: linkRequestPoll(m, fx)};
    } else {
      planTouch(m);
      m.remote.captions.apply = null;
      m.remote.seek = {s: 'idle'};
      m.remote.stop = {snap: c.snap, afterSeq: linkRequestPoll(m, fx), generation: m.link.generation};
    }
  }
  /** A new backend error identity is the latest word: it replaces a local message and ends a seek wait (policy 14, 15). */
  function uiObserveError(m) {
    const e = m.ui.errors, id = errorIdentity(m.link.status);
    if (!id || id === e.observed) return;
    e.observed = id;
    e.local = null;
    if (m.remote.seek.s === 'sent') m.remote.seek = {s: 'idle'};
  }
  /** Layers can't outlive the permission that opened them. */
  function uiValidLayers(m) {
    const u = m.ui, s = m.link.status || NO_STATUS, c = caps(m);
    if (u.sheet === 'subs' && !(s.playback_id && remoteCatalogue(m)) || u.sheet === 'subs' && c.foreign) u.sheet = null;
    if ((u.sheet === 'more' || u.sheet === 'change') && !c.owned) u.sheet = null;
    if (u.sheet === 'change' && c.foreign) { u.sheet = null; planReset(m, null); }
    if (u.confirm?.kind === 'replace' && c.foreign) u.confirm = null;
    if (u.confirm?.kind === 'stop') {
      const k = u.confirm.snap;
      if (!c.stop) u.confirm = null;
      else if (k.deviceId !== s.selected_device?.id || k.deviceRevision !== s.device_revision || k.playbackId !== (s.playback_id ?? null)) {
        u.confirm = null;
        u.errors.local = 'La TV cambió o hay otra sesión. Revisá antes de detener.';
      }
    }
  }
  /** The focus ticket is honoured once the command settles, and only if the user has not touched anything since. */
  function uiSettleFocus(m, fx) {
    const f = m.ui.focus;
    m.ui.focus = null;
    if (f && f.n === m.n) fx.push({fx: 'focus', ref: f.ref, n: f.n});
  }
  /** What the one problem block says, or null. The same function decides what dismissNotice dismisses. */
  function problemOf(m) {
    const s = m.link.status || NO_STATUS, c = caps(m), u = m.ui;
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
  /** Demo scenarios exist only when the server says it is the demo (policy 17). */
  function uiScenario(m, fx, value, msg) {
    if (m.link.status?.demo === true) linkCommand(m, fx, 'scenario', {state: String(value)}, {from: msg?.from, n: msg?.n});
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
    stoppedNotice: false, stopIssued: false, exact: {text: '', error: ''}, mode: null, reseed: false, clock: null, lastSourceId: null, lastDeviceLabel: '',
  });

  /** @param {{lastDeviceId?:string|null}} [boot] @returns {{model:Model,fx:object[]}} the first poll is in fx */
  function init(boot = {}) {
    const m = {
      nextTicket: 0, now: 0, n: 0, prefs: {lastDeviceId: boot.lastDeviceId ?? null, autoSelectTried: false},
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
    if (m.link.command?.ticket === msg.ticket) linkOnCommandReply(m, fx, msg);
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
    remoteSync(m);
    // 2. remember what we owned, to label the stopped notice and re-seed Preparar
    if (s && c.owned && !c.foreign && s.selected_device) { u.lastSourceId = s.source_id ?? u.lastSourceId; u.lastDeviceLabel = deviceLabel(s.selected_device); }
    uiValidLayers(m);
    // 3. back in Preparar after an owned playback: movie and TV stay chosen, the subtitle decision starts over
    if (s) {
      const mode = modeOf(m);
      if (u.mode === 'mando' && mode === 'preparar') { planReset(m, null); u.reseed = true; u.stoppedNotice = u.stopIssued; u.stopIssued = false; }
      if (mode === 'mando') u.stoppedNotice = false;
      u.mode = mode;
    }
    if (u.reseed && l.online && s && !m.plan.sourceId) {
      u.reseed = false;
      const id = [s.source_id, u.lastSourceId].find(x => x && s.sources.some(y => y.id === x));
      if (id) planPickSource(m, fx, id);
    }
    // the flap clock ticks only while a movie plays
    if (u.mode === 'mando' && s?.phase === 'playing' && l.online && u.clock === null) {
      u.clock = ticketOf(m);
      fx.push({fx: 'timer', name: 'clock', ms: CLOCK_MS, ticket: u.clock});
    }
    // 4/5. remember the TV the server confirmed; pre-select it when nothing is selected (never casts)
    if (s?.selected_device && s.selected_device.id !== m.prefs.lastDeviceId) {
      m.prefs.lastDeviceId = s.selected_device.id;
      fx.push({fx: 'store', key: 'cast.lastDevice', value: s.selected_device.id});
    }
    if (s && !s.selected_device && !m.prefs.autoSelectTried && m.prefs.lastDeviceId && caps(m).changeDevice
        && s.devices?.some(d => d.id === m.prefs.lastDeviceId && d.available !== false)) {
      m.prefs.autoSelectTried = true;
      planPickDevice(m, fx, m.prefs.lastDeviceId);
    }
    // 6/7. Stremio offers follow the block that shows them; the branch vanishes when the addon is off
    const info = m.plan.catalogue?.addon;
    if (m.plan.choice.branch === 'stremio' && (!info || info.state === 'off')) m.plan.choice = {branch: 'none', entryId: null};
    addonReconcile(m, fx, 'plan');
    addonReconcile(m, fx, 'remote');
  }

  // ───────── view: plain data for the shell to paint. All es-AR copy lives here; view reads the model and writes nothing.
  /**
   * @typedef {{enabled:boolean}} Ctl
   * @typedef {{id:string,label:string,note?:string,selected:boolean,enabled:boolean,reason?:string,tag?:string}} Row
   * @typedef {object} PlanView  Rendered in Preparar (segments 01 and 03 and the stub) and inside the "Cambiar película" sheet.
   * @property {Row[]} sources @property {string} sourceStatus @property {Ctl} refreshSources
   * @property {{id:'none'|'file'|'stremio'|'upload',label:string,selected:boolean,hidden:boolean,enabled:boolean}[]} branches
   * @property {string} subsStatus  the one status line of the chosen branch
   * @property {Row[]} fileEntries  embedded tracks; unsupported ones visible, disabled, with a reason
   * @property {{filename:string,busy:boolean,enabled:boolean,message:string,chosen:string}} upload
   * @property {StremioView|null} stremio  null when the addon is off or there is no catalogue yet
   * @property {Ctl} refreshCatalogue
   * @property {{label:string,note:string,enabled:boolean}} primary  'Iniciar en Sala (Google TV)' | 'Cambiar película en la TV' | 'Ya está en la TV' | 'Iniciando…'
   * @property {{label:'Falta'|'Embarque',value:string,missing:string[]}} stub
   * @typedef {object} StremioView
   * @property {string} match @property {Row[]} languages @property {Row[]} versions @property {Ctl&{shown:boolean,label:string}} use
   * @property {Ctl&{shown:boolean}} retry @property {Ctl&{shown:boolean,open:boolean}} wrong
   * @property {boolean} correctionOpen @property {Row[]} alternatives @property {Ctl} search @property {string} status
   */
  const SUBS_BRANCHES = [['none', 'Sin'], ['file', 'Del archivo'], ['stremio', 'Stremio'], ['upload', 'Subir']];

  function viewStremio(m, scope) {
    const x = addonCtx(m, scope), a = x.addon, cat = x.catalogue, info = cat?.addon;
    if (!info || info.state === 'off') return null;
    const eff = addonOffers(a, cat), key = addonKey(cat), listable = info.state === 'ready' || info.state === 'unidentified';
    const enabled = x.canAct && !a.op, pullFailed = listable && a.pull.s === 'failed' && a.pull.key === key;
    const picking = info.state === 'ready' && eff.versions.length > 0, unidentified = info.state === 'unidentified';
    const open = unidentified || (info.state === 'ready' && a.correcting);
    const status = a.message?.key === key ? a.message.text : pullFailed ? ADDON_ERROR
      : info.state === 'ready' ? (info.count === 0 ? `Stremio no tiene subtítulos para ${info.match?.label || 'esta película'}.` : eff.listing ? '' : ADDON_LOADING)
      : info.message || '';
    return {
      match: info.match ? (info.match.confidence === 'doubtful' ? `¿Es «${info.match.label}»?` : `Coincidencia: ${info.match.label}`) : '',
      languages: listable ? eff.languages.map(l => ({id: l.code, label: `${l.name} · ${l.count}`, selected: l.code === eff.language, enabled})) : [],
      versions: eff.versions.map(o => ({id: o.id, label: [o.label, o.note].filter(Boolean).join(' · ') + (a.unreadable.includes(o.id) ? ' · no se pudo leer' : ''), selected: o.id === eff.offerId, enabled})),
      use: {shown: picking, enabled: enabled && !!eff.offerId, label: a.op?.kind === 'fetch' ? 'Descargando…' : 'Usar este subtítulo'},
      retry: {shown: info.state === 'error' || pullFailed, enabled},
      wrong: {shown: info.state === 'ready', enabled, open},
      correctionOpen: open,
      alternatives: (eff.listing?.alternatives || []).slice(0, 4).map((alt, i) => ({id: String(i), label: alt.year ? `${alt.title} (${alt.year})` : alt.title, selected: false, enabled})),
      search: {enabled},
      status,
    };
  }

  function subsStatusLine(m) {
    const p = m.plan, cat = p.catalogue;
    if (!p.sourceId) return 'Elegí una película primero.';
    if (p.load.s === 'error') return p.load.message;
    if (!cat || p.load.s === 'loading') return 'Leyendo la película…';
    const b = p.choice.branch, chosen = entryOf(cat, p.choice.entryId);
    if (b === 'none') return 'Va a verse sin subtítulos.';
    if (b === 'file') {
      const own = cat.entries.filter(e => e.kind === 'embedded');
      return !own.length ? 'Esta película no trae subtítulos en el archivo.' : !own.some(e => e.supported) ? 'Ninguno de los subtítulos del archivo es compatible.'
        : chosen ? `Subtítulo elegido: ${chosen.label}.` : 'Elegí uno.';
    }
    if (b === 'upload') return p.upload.s === 'busy' ? 'Validando y subiendo el archivo…' : p.upload.message || (chosen ? `Archivo listo: ${chosen.label}.` : 'Elegí un archivo .srt o .vtt (UTF-8, hasta 1 MiB).');
    const st = viewStremio(m, 'plan');
    return st?.status || (chosen ? `Subtítulo listo: ${chosen.label}.` : st?.use.shown ? 'Elegí un idioma y una versión.' : '');
  }

  function viewPlan(m) {
    const s = m.link.status || NO_STATUS, p = m.plan, c = caps(m), cat = p.catalogue, sel = s.selected_device;
    const can = planCanStart(m), same = samePlan(m), online = c.online, idleLoad = p.load.s === 'idle';
    const sourceError = p.refresh.discover.error || (s.source_discovery === 'error' ? s.source_error || 'Reintentá la búsqueda.' : '');
    const info = cat?.addon, stremioOff = !!cat && (!info || info.state === 'off');
    const branchOk = online && !!p.sourceId && !!cat && idleLoad;
    const uploadFree = branchOk && p.upload.s === 'idle' && p.addon.op?.kind !== 'fetch';
    const picked = entryOf(cat, p.choice.entryId);
    let note = '';
    if (!online) note = 'Sin conexión con el puente.';
    else if (!can.ok && !can.missing.length) note = 'Leyendo la película…';
    else if (!c.start) note = c.foreign ? 'La TV está con otro contenido.' : c.busy ? 'La TV está ocupada.' : sel?.available === true ? 'Hay listas sin confirmar. Actualizá.' : '';
    return {
      sources: s.sources.map(x => ({id: x.id, label: x.title || 'Película sin nombre', note: x.filename || '', selected: p.sourceId === x.id, enabled: online})),
      sourceStatus: sourceError ? `No se pudo actualizar la lista de películas. Usá Actualizar para reintentar. ${sourceError}`
        : s.source_discovery === 'loading' || p.refresh.discover.ticket ? 'Buscando películas…'
        : s.sources.length ? '' : 'No hay películas todavía. Abrí una en Stremio y volvé a actualizar.',
      refreshSources: {enabled: online && !p.refresh.discover.ticket && s.source_discovery !== 'loading'},
      branches: SUBS_BRANCHES.map(([id, label]) => ({id, label, selected: p.choice.branch === id, hidden: id === 'stremio' && stremioOff, enabled: branchOk})),
      subsStatus: subsStatusLine(m),
      fileEntries: (cat?.entries || []).filter(e => e.kind === 'embedded').map(e => ({
        id: e.id, label: [e.label || 'Pista sin nombre', e.language].filter(Boolean).join(' · '), selected: p.choice.entryId === e.id,
        enabled: e.supported === true && branchOk, ...(e.supported === true ? {} : {reason: e.reason || 'Formato no compatible'})})),
      upload: {filename: p.upload.filename, busy: p.upload.s === 'busy', enabled: uploadFree, message: p.upload.message || '', chosen: p.choice.branch === 'upload' && picked ? picked.label : ''},
      stremio: viewStremio(m, 'plan'),
      refreshCatalogue: {enabled: online && !!p.sourceId && p.load.s !== 'loading'},
      primary: {
        label: p.start ? 'Iniciando…' : same ? 'Ya está en la TV' : modeOf(m) === 'mando' ? 'Cambiar película en la TV' : sel ? `Iniciar en ${deviceLabel(sel, true)}` : 'Iniciar',
        note, enabled: c.start && can.ok && !same && !p.start && !m.ui.confirm,
      },
      stub: {label: can.missing.length ? 'Falta' : 'Embarque', value: can.missing.length ? can.missing.join(' · ') : deviceLabel(sel), missing: can.missing},
    };
  }

  /**
   * @typedef {object} DestinationView  02 DESTINO · TV
   * @property {string} label 'Sala · Google TV' | 'Sin TV elegida'
   * @property {string} note '' | 'Lista sin confirmar' | 'No disponible'  (a failed discovery is not a disconnected TV)
   * @property {string} status @property {Row[]} rows @property {Ctl} refresh @property {string} rule
   * @property {Ctl&{shown:boolean}} stop @property {string} details  host of the chosen TV, for the disclosure
   */
  function viewDestination(m) {
    const s = m.link.status || NO_STATUS, p = m.plan, c = caps(m), sel = s.selected_device, last = m.prefs.lastDeviceId;
    const error = p.refresh.discover_devices.error || (s.device_discovery === 'error' ? s.device_error || 'Reintentá la búsqueda.' : '');
    const devices = s.devices || [], busyList = s.device_discovery === 'loading' || !!p.refresh.discover_devices.ticket;
    return {
      label: sel ? deviceLabel(sel) : 'Sin TV elegida',
      note: !sel ? '' : s.phase === 'disconnected' ? 'No disponible' : error ? 'Lista sin confirmar' : sel.available || LIVE.includes(s.phase) ? '' : 'No disponible',
      status: error ? `No se pudo actualizar la lista de TVs. Usá Actualizar para reintentar. ${error}`
        : busyList ? 'Buscando TVs…' : devices.length ? '' : s.device_discovery === 'ready' ? 'No encontramos ninguna TV. Revisá que esté encendida y en la misma red, y actualizá.' : 'Buscando TVs…',
      rows: devices.map(d => ({id: d.id, label: deviceLabel(d), note: d.host || '', selected: d.id === sel?.id, enabled: c.changeDevice, ...(d.id === last ? {tag: 'Última usada'} : {})})),
      refresh: {enabled: c.online && !busyList},
      rule: s.can_change_device === false ? 'Primero detené la película para cambiar de TV.' : '',
      stop: {shown: s.can_change_device === false, enabled: c.stop},
      details: sel?.host || '',
    };
  }

  /** @typedef {{kind:'replace'|'stop',title:string,body:string,accept:string,cancel:string}} ConfirmView */
  function viewConfirm(m) {
    const k = m.ui.confirm, s = m.link.status || NO_STATUS;
    if (!k) return null;
    if (k.kind === 'replace') return {kind: 'replace', title: '¿Cambiar la película en la TV?', body: `Vas a ver ${k.title}. Empieza desde el principio.`, accept: 'Cambiar película', cancel: 'Volver'};
    return {kind: 'stop', title: '¿Detener la película en la TV?', body: `Se corta en ${deviceLabel(s.selected_device) || 'la TV'} y volvés a elegir.`, accept: 'Detener', cancel: 'Seguir viendo'};
  }

  const BOARD_STATE = {playing: 'REPRODUCIENDO', paused: 'EN PAUSA', preparing: 'PREPARANDO', buffering: 'CARGANDO', loading: 'CARGANDO',
    disconnected: 'SIN SEÑAL', receiver_changed: 'OTRO CONTENIDO', error: 'CON ERROR'};
  const WAITING_COPY = {preparing: 'Preparando la película para la TV…', buffering: 'Preparando más contenido para la TV…', loading: 'Cargando la película en la TV…'};

  /** Where the flap clock reads: the last status plus the time since, capped so a stalled poll never invents a position. */
  function shownPosition(m) {
    const s = m.link.status || NO_STATUS;
    if (!finite(s.absolute_time)) return null;
    const run = s.phase === 'playing' && m.link.online ? clamp((m.now - m.link.statusAt) / 1000, 0, CLOCK_CAP_S) : 0;
    return Math.min(s.absolute_time + run, durationOf(s) ?? Infinity);
  }
  /** The prepared range the TV can play without waiting, clamped to the movie. */
  function bufferedRange(s) {
    const d = durationOf(s);
    if (!d || !(LIVE.includes(s.phase) || WAITING.includes(s.phase)) || !finite(s.buffered_start) || !finite(s.buffered_end)) return null;
    const start = clamp(s.buffered_start, 0, d);
    return {start, end: clamp(s.buffered_end, start, d)};
  }
  const signedSkip = delta => `${delta < 0 ? '−' : '+'}${Math.abs(Math.round(delta))} s`;

  /**
   * @typedef {object} MandoView  The departures board and the remote. Null in Preparar.
   * @property {{title:string,clock:string,state:string,room:string}} board  clock is display-only (interpolated while playing)
   * @property {{enabled:boolean,max:number,value:number,elapsed:string,total:string,preview:string|null,previewAt:number|null,target:string|null,buffered:{start:number,end:number}|null}} track
   *           value and elapsed are the real position; preview ('→ h:mm:ss') exists only while dragging, target while a sent seek has not settled
   * @property {Ctl} back @property {Ctl} forward @property {string|null} badge  accumulated skip, '+60 s'
   * @property {Ctl&{icon:'play'|'pause'|'spinner',label:string}} toggle
   * @property {null|{text:string,detail:string,cancel:Ctl}} waiting  'Esperando a Sala · Google TV' with Cancelar (= stop)
   * @property {Ctl&{percent:number|null,text:string}} volume @property {Ctl&{pressed:boolean,label:string}} mute
   * @property {Ctl&{label:string,unapplied:boolean}} chip  subtitle chip; unapplied while a caption draft differs from the TV
   * @property {Ctl} more @property {Ctl} change @property {Ctl} stop
   */
  function viewMando(m) {
    const s = m.link.status || NO_STATUS, c = caps(m), k = m.remote.seek, sel = s.selected_device, d = durationOf(s);
    const pos = shownPosition(m), waiting = WAITING.includes(s.phase), srv = capServer(s);
    const chosen = s.subtitle_choice, hasCaptions = !!s.playback_id && !!remoteCatalogue(m);
    const volume = m.remote.volumePreview ?? (finite(s.volume) ? Math.round(s.volume * 100) : null);
    const spinner = waiting || !!m.link.command || !!s.command_pending;
    return {
      board: {
        title: s.title || 'Tu película en la TV', clock: formatTime(pos), room: deviceLabel(sel) || 'Sin TV',
        state: !c.online ? 'SIN CONFIRMAR' : BOARD_STATE[s.phase] ?? 'SIN CONFIRMAR',
      },
      track: {
        enabled: c.transport && !!d, max: d ?? 0, value: pos ?? 0, elapsed: formatTime(pos), total: formatTime(d),
        preview: k.s === 'dragging' ? `→ ${formatTime(k.preview)}` : null, previewAt: k.s === 'dragging' ? k.preview : null,
        target: k.s === 'sent' ? `→ ${formatTime(k.target)}` : null, buffered: bufferedRange(s),
      },
      back: {enabled: c.transport && !!d}, forward: {enabled: c.transport && !!d},
      badge: k.s === 'skipping' && k.delta !== 0 ? signedSkip(k.delta) : null,
      toggle: {enabled: c.transport, icon: spinner ? 'spinner' : s.phase === 'playing' ? 'pause' : 'play',
        label: spinner ? 'Esperando' : s.phase === 'playing' ? 'Pausar' : 'Continuar'},
      waiting: waiting ? {text: `Esperando a ${deviceLabel(sel) || 'la TV'}`, detail: s.message || WAITING_COPY[s.phase], cancel: {enabled: c.stop}} : null,
      volume: {enabled: c.transport && finite(s.volume), percent: volume, text: volume === null ? '—' : `${volume}%`},
      mute: {enabled: c.transport && typeof s.muted === 'boolean', pressed: s.muted === true, label: s.muted ? 'Activar sonido' : 'Silenciar'},
      chip: {
        enabled: c.online && !c.foreign && hasCaptions, unapplied: capDirty(m),
        label: !srv.subtitleId ? 'Sin subtítulos' : `${chosen?.label || 'Subtítulos'} · ${srv.enabled ? signedSeconds(srv.delayMs) : 'ocultos'}`,
      },
      more: {enabled: c.owned}, change: {enabled: c.owned && !c.foreign && c.online}, stop: {enabled: c.stop},
    };
  }

  /**
   * @typedef {object} SubsSheetView  "Enmienda al pase"
   * @property {'subs'} kind @property {Row[]} tracks  'Sin subtítulos' (id '') then the supported tracks
   * @property {Ctl&{checked:boolean}} visible  applies at once, through the same pipeline as Aplicar
   * @property {{text:string,meaning:string}} delay @property {Ctl} steps
   * @property {Ctl&{label:string,pending:boolean}} apply @property {Ctl} discard @property {boolean} unapplied
   * @property {string} onTv @property {string} note @property {StremioView|null} stremio
   */
  function viewSubsSheet(m) {
    const s = m.link.status || NO_STATUS, c = caps(m), srv = capServer(s), d = capDraft(m), a = m.remote.captions.apply, cat = remoteCatalogue(m);
    const row = (id, label) => ({id, label, selected: d.subtitleId === (id || null), enabled: c.captions});
    const dirty = capDirty(m);
    return {
      kind: 'subs',
      tracks: [row('', 'Sin subtítulos'), ...(cat?.entries || []).filter(e => e.supported === true).map(e => row(e.id, [e.label || 'Pista sin nombre', e.language].filter(Boolean).join(' · ')))],
      visible: {enabled: c.captions && !!srv.subtitleId, checked: a?.kind === 'visibility' ? a.want.enabled : srv.enabled},
      delay: {text: signedSeconds(d.delayMs), meaning: d.subtitleId ? delayMeaning(d.delayMs) : 'Sin subtítulos no hay nada que sincronizar'},
      steps: {enabled: c.captions && !!d.subtitleId},
      apply: {enabled: c.captions && dirty, pending: a?.kind === 'plan', label: a?.kind === 'plan' ? 'Aplicando…' : 'Aplicar'},
      discard: {enabled: dirty}, unapplied: dirty,
      onTv: !srv.subtitleId ? 'En la TV: sin subtítulos.' : `En la TV: ${srv.enabled ? 'visibles' : 'ocultos'} · ${signedSeconds(srv.delayMs)}.`,
      note: 'Cambiar la pista o la sincronía recarga la película en la TV unos segundos y conserva la posición y la pausa. Mostrar u ocultar no recarga.',
      stremio: viewStremio(m, 'remote'),
    };
  }
  /** @typedef {{kind:'more',exact:Ctl&{text:string,error:string},details:{tv:string,host:string,file:string,prepared:string},stop:Ctl}} MoreSheetView */
  function viewMoreSheet(m) {
    const s = m.link.status || NO_STATUS, c = caps(m), sel = s.selected_device, b = bufferedRange(s);
    return {
      kind: 'more',
      exact: {enabled: c.transport && !!durationOf(s), text: m.ui.exact.text, error: m.ui.exact.error},
      details: {
        tv: deviceLabel(sel), host: sel?.host || '', file: s.sources.find(x => x.id === s.source_id)?.filename || 'Nombre no disponible',
        prepared: b ? `De ${formatTime(b.start)} a ${formatTime(b.end)}` : 'Sin datos todavía',
      },
      stop: {enabled: c.stop},
    };
  }
  function viewSheet(m) {
    const k = m.ui.sheet;
    return k === 'subs' ? viewSubsSheet(m) : k === 'more' ? viewMoreSheet(m) : k === 'change' ? {kind: 'change'} : null;
  }

  /**
   * @typedef {object} ProblemView  The ONE problem block. kind priority: offline > unknown > foreign > disconnected > failed > notice > stopped.
   * @property {'offline'|'unknown'|'foreign'|'disconnected'|'failed'|'notice'|'stopped'} kind
   * @property {string} title @property {string} body  '' when the title says it all
   * @property {'page'|'sheet'} host  'sheet' while a sheet is open: the block renders there, once, never also on the page
   * @property {null|{act:'stop'|'dismissNotice',label:string,enabled:boolean}} action
   */
  /**
   * @typedef {object} View  Everything the page shows, as plain data (JSON-safe, no wire types). The contract the markup and shell consume.
   * @property {'preparar'|'mando'} mode  Preparar shows plan + destination + stub; Mando shows the board and the remote
   * @property {ProblemView|null} problem
   * @property {{scenario:string}|null} demo  non-null only when the server says status.demo === true
   * @property {PlanView} plan  also rendered inside the "Cambiar película" sheet
   * @property {DestinationView} destination
   * @property {MandoView|null} mando
   * @property {SubsSheetView|MoreSheetView|{kind:'change'}|null} sheet  at most one sheet is open
   * @property {ConfirmView|null} confirm  stacks above a sheet
   * @property {boolean} wake  the shell holds a Wake Lock iff true (Mando)
   * @property {{ref:string,n:number}|null} restoring  a command is in flight and focus will return to control `ref`; keyMsg swallows keys meanwhile
   */
  function viewProblem(m) {
    const p = problemOf(m);
    return p && {...p, host: m.ui.sheet ? 'sheet' : 'page'};
  }
  function view(m) {
    const mode = modeOf(m);
    return {
      mode,
      plan: viewPlan(m), destination: viewDestination(m), confirm: viewConfirm(m),
      mando: mode === 'mando' ? viewMando(m) : null, sheet: viewSheet(m),
      problem: viewProblem(m), demo: m.link.status?.demo === true ? {scenario: m.link.status.scenario || ''} : null,
      wake: mode === 'mando', restoring: m.ui.focus,
    };
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
    stremioRetry: (m, fx) => addonLookup(m, fx, stremioScope(m), (stremioScope(m) === 'plan' ? m.plan.addon : m.remote.addon).lastHint),
    stremioWrong: m => addonWrong(m, stremioScope(m)),
    stremioAlt: (m, fx, g) => addonAlternative(m, fx, stremioScope(m), Number(g.arg)),
    stremioSearch: (m, fx, g) => addonSearch(m, fx, stremioScope(m), g.arg),
    start: (m, fx) => planStart(m, fx),
    toggle, stop: remoteStop,
    skip: (m, fx, g) => seekSkip(m, fx, Number(g.arg), g),
    dragSeek: (m, fx, g) => seekDrag(m, Number(g.arg)),
    dropSeek: (m, fx, g) => seekDrop(m, fx, Number(g.arg), g),
    seekAbandon: m => seekAbandon(m),
    volumePreview: (m, fx, g) => volumePreview(m, Number(g.arg)),
    volume: (m, fx, g) => volumeSet(m, fx, Number(g.arg), g),
    mute: (m, fx, g) => muteToggle(m, fx, g),
    capTrack: (m, fx, g) => capEdit(m, 'track', g.arg),
    capNudge: (m, fx, g) => { if (!m.ui.sheet) uiOpen(m, 'subs'); capEdit(m, 'nudge', Number(g.arg)); },
    capReset: m => capEdit(m, 'reset'),
    capVisible: (m, fx, g) => capVisible(m, fx, g.arg === true || g.arg === 'true', g),
    capApply: (m, fx, g) => capApply(m, fx, g),
    capDiscard: m => capDiscard(m),
    exactInput: (m, fx, g) => { m.ui.exact = {text: String(g.arg ?? ''), error: ''}; },
    gotoTime: (m, fx, g) => seekGoto(m, fx, g.arg, g),
    dismissNotice: m => uiDismissNotice(m),
    scenario: (m, fx, g) => uiScenario(m, fx, g.arg, g),
    openSubs: m => uiOpen(m, 'subs'),
    openMore: m => uiOpen(m, 'more'),
    openChange: m => uiOpen(m, 'change'),
    closeSheet: m => uiDismiss(m),
    dismiss: m => uiDismiss(m),
    confirmCancel: m => uiDismiss(m),
    confirmAccept: (m, fx) => uiConfirmAccept(m, fx),
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

  return {init, step, view, keyMsg, ACTS, formatTime, parseTime};
})();

// ───────── DOM shell: performs the core's effects and paints Panel.view(). It knows ids and effect kinds, never a rule.
const byId = (doc, id) => {
  const node = doc.getElementById(id);
  if (!node) throw new Error(`Falta #${id} en el markup`);
  return node;
};
/** Write a property only when it differs, so a repaint of an unchanged view touches nothing. */
const put = (node, prop, value) => { if (node[prop] !== value) node[prop] = value; };
/** null removes the attribute; anything else is written as text, so a boolean becomes "true" or "false" for aria-* and data-*. */
const attr = (node, name, value) => {
  if (value === null) { if (node.hasAttribute(name)) node.removeAttribute(name); return; }
  const text = String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
};
const ctl = (node, c) => put(node, 'disabled', !c.enabled);
const pct = (x, max) => `${max > 0 ? Math.round(Math.min(max, Math.max(0, x)) / max * 1000) / 10 : 0}%`;

/** One row: label, note and tag/reason into the [data-f] slots, selected into aria-pressed, enabled into disabled. */
function paintRow(el, row) {
  put(el, 'disabled', !row.enabled);
  if (el.hasAttribute('aria-pressed')) attr(el, 'aria-pressed', !!row.selected);
  for (const slot of el.querySelectorAll('[data-f]')) {
    const kind = slot.getAttribute('data-f'), text = (kind === 'label' ? row.label : kind === 'note' ? row.note : row.reason || row.tag) || '';
    put(slot, 'textContent', text);
    put(slot, 'hidden', !text);
  }
}
/** Keyed list patch: a row keeps its node (focus, scroll) across polls; new rows clone the host's <template>. */
function paintList(host, rows) {
  const template = host.querySelector('template'), live = new Map();
  for (const child of host.children) if (child !== template && child.hasAttribute('data-key')) live.set(child.getAttribute('data-key'), child);
  let prev = template;
  for (const row of rows) {
    const key = String(row.id);
    let el = live.get(key);
    if (el) live.delete(key);
    else {
      el = template.content.firstElementChild.cloneNode(true);
      el.setAttribute('data-key', key);
      el.setAttribute('data-arg', key);
    }
    paintRow(el, row);
    if (prev.nextElementSibling !== el) host.insertBefore(el, prev.nextElementSibling);
    prev = el;
  }
  for (const el of live.values()) el.remove();
}
/** The split-flap clock: one cell per character, built once and rewritten in place. */
function paintFlaps(doc, host, text) {
  const chars = [...text];
  while (host.children.length > chars.length) host.children[host.children.length - 1].remove();
  chars.forEach((ch, i) => {
    let cell = host.children[i];
    if (!cell) { cell = doc.createElement('span'); host.appendChild(cell); }
    put(cell, 'className', ch === ':' ? 'flap sep' : 'flap');
    put(cell, 'textContent', ch);
  });
}

const GLYPH = {'REPRODUCIENDO': 'play', 'EN PAUSA': 'pause', 'PREPARANDO': 'spin', 'CARGANDO': 'spin'};
const SHEETS = [['subs', 'sheet-subs'], ['more', 'sheet-more'], ['change', 'sheet-change']];

function paintProblem(doc, v) {
  const node = byId(doc, 'problem'), p = v.problem;
  const slot = byId(doc, p?.host === 'sheet' ? 'sheet-problem-slot' : v.mode === 'mando' ? 'mando-problem-slot' : 'prep-problem-slot');
  if (node.parentNode !== slot) slot.appendChild(node);
  put(node, 'hidden', !p);
  if (!p) return;
  const quiet = p.kind === 'stopped' || p.kind === 'notice';
  attr(node, 'role', quiet ? 'status' : 'alert');
  put(node, 'className', p.kind === 'stopped' ? 'info' : '');
  put(byId(doc, 'problem-kind'), 'textContent', p.kind === 'stopped' ? 'Detenido' : 'Aviso');
  put(byId(doc, 'problem-title'), 'textContent', p.title);
  put(byId(doc, 'problem-body'), 'textContent', p.body);
  const action = byId(doc, 'problem-action');
  put(action, 'hidden', !p.action);
  if (p.action) { attr(action, 'data-act', p.action.act); put(action, 'textContent', p.action.label); put(action, 'disabled', !p.action.enabled); }
}

function paintStremio(doc, v) {
  const inSheet = v.sheet?.kind === 'subs', st = inSheet ? v.sheet.stremio : v.plan.stremio;
  const node = byId(doc, 'stremio'), home = byId(doc, inSheet && st ? 'sheet-subs-stremio-slot' : 'branch-stremio-body');
  if (node.parentNode !== home) home.appendChild(node);
  if (!st) return;
  put(byId(doc, 'stremio-match'), 'textContent', st.match);
  paintList(byId(doc, 'stremio-languages'), st.languages);
  paintList(byId(doc, 'stremio-versions'), st.versions);
  const use = byId(doc, 'stremio-use');
  put(use, 'hidden', !st.use.shown); ctl(use, st.use); put(use, 'textContent', st.use.label);
  const retry = byId(doc, 'stremio-retry');
  put(retry, 'hidden', !st.retry.shown); ctl(retry, st.retry);
  const wrong = byId(doc, 'stremio-wrong');
  put(wrong, 'hidden', !st.wrong.shown); ctl(wrong, st.wrong); attr(wrong, 'aria-expanded', st.wrong.open);
  put(byId(doc, 'stremio-correction'), 'hidden', !st.correctionOpen);
  paintList(byId(doc, 'stremio-alternatives'), st.alternatives);
  ctl(byId(doc, 'stremio-search'), st.search);
  put(byId(doc, 'stremio-hint'), 'disabled', !st.search.enabled);
  put(byId(doc, 'stremio-status'), 'textContent', inSheet ? st.status : '');
}

function paintPlan(doc, v) {
  const p = v.plan, plan = byId(doc, 'plan'), sheetPlan = v.sheet?.kind === 'change';
  const home = byId(doc, sheetPlan ? 'sheet-change-slot' : 'prep-plan-slot');
  if (plan.parentNode !== home) home.appendChild(plan);
  paintList(byId(doc, 'source-list'), p.sources);
  put(byId(doc, 'source-status'), 'textContent', p.sourceStatus);
  ctl(byId(doc, 'refresh-sources'), p.refreshSources);
  let chosen = 'none';
  for (const b of p.branches) {
    const node = byId(doc, `branch-${b.id}`);
    put(node, 'hidden', b.hidden); put(node, 'disabled', !b.enabled); attr(node, 'aria-pressed', b.selected);
    if (b.selected) chosen = b.id;
  }
  for (const id of ['file', 'stremio', 'upload']) put(byId(doc, `branch-${id}-body`), 'hidden', chosen !== id);
  paintList(byId(doc, 'file-entries'), p.fileEntries);
  put(byId(doc, 'upload-input'), 'disabled', !p.upload.enabled);
  put(byId(doc, 'upload-filename'), 'textContent', p.upload.chosen || p.upload.filename);
  put(byId(doc, 'subs-status'), 'textContent', p.subsStatus);
  ctl(byId(doc, 'refresh-catalogue'), p.refreshCatalogue);
  paintStremio(doc, v);
  put(byId(doc, 'stub-label'), 'textContent', p.stub.label);
  const value = byId(doc, 'stub-value');
  put(value, 'textContent', p.stub.value); put(value, 'className', p.stub.missing.length ? 'miss' : '');
  put(byId(doc, 'barcode'), 'className', p.primary.enabled ? 'barcode' : 'barcode off');
  put(byId(doc, 'start-note'), 'textContent', p.primary.note);
  put(byId(doc, 'start-label'), 'textContent', p.primary.label);
  ctl(byId(doc, 'start'), p.primary);
  put(byId(doc, 'change-note'), 'textContent', p.primary.note);
  put(byId(doc, 'change-start'), 'textContent', p.primary.label);
  ctl(byId(doc, 'change-start'), p.primary);
}

function paintDestination(doc, v) {
  const d = v.destination, name = byId(doc, 'device-name');
  put(name, 'textContent', d.label);
  put(name, 'hidden', d.rows.some(r => r.selected));
  paintList(byId(doc, 'device-list'), d.rows.map(r => ({...r, note: ''})));
  put(byId(doc, 'device-note'), 'textContent', d.note);
  put(byId(doc, 'device-status'), 'textContent', d.status);
  put(byId(doc, 'device-rule'), 'textContent', d.rule); put(byId(doc, 'device-rule'), 'hidden', !d.rule);
  const stop = byId(doc, 'device-stop');
  put(stop, 'hidden', !d.stop.shown); ctl(stop, d.stop);
  ctl(byId(doc, 'refresh-devices'), d.refresh);
  put(byId(doc, 'device-host'), 'textContent', d.details);
  put(byId(doc, 'device-details'), 'hidden', !d.details);
}

function paintTrack(doc, t) {
  const track = byId(doc, 'track'), box = byId(doc, 'timeline'), max = t.max;
  attr(box, 'data-off', !t.enabled);
  put(track, 'max', String(max)); ctl(track, t);
  if (t.previewAt === null) put(track, 'value', String(t.value));
  attr(track, 'aria-valuetext', `${t.elapsed} de ${t.total}`);
  put(byId(doc, 'track-prog').style, 'width', pct(t.value, max));
  put(byId(doc, 'track-head').style, 'left', pct(t.value, max));
  const buffer = byId(doc, 'track-buffer');
  put(buffer, 'hidden', !t.buffered);
  if (t.buffered) { put(buffer.style, 'left', pct(t.buffered.start, max)); put(buffer.style, 'width', pct(t.buffered.end - t.buffered.start, max)); }
  const dragging = t.previewAt !== null, ghost = [byId(doc, 'track-ghost'), byId(doc, 'track-span'), byId(doc, 'track-preview')];
  ghost.forEach(n => put(n, 'hidden', !dragging));
  if (dragging) {
    const from = Math.min(t.value, t.previewAt), to = Math.max(t.value, t.previewAt);
    put(ghost[0].style, 'left', pct(t.previewAt, max));
    put(ghost[1].style, 'left', pct(from, max)); put(ghost[1].style, 'width', pct(to - from, max));
    put(ghost[2].style, 'left', `clamp(42px, ${pct(t.previewAt, max)}, calc(100% - 42px))`);
    put(ghost[2], 'textContent', t.preview);
  }
  put(byId(doc, 'elapsed'), 'textContent', t.elapsed);
  put(byId(doc, 'total'), 'textContent', t.total);
  const hint = byId(doc, 'track-hint');
  put(hint, 'textContent', dragging ? `Soltá para saltar. La TV sigue en ${t.elapsed}.` : t.target ? `Saltando a ${t.target.replace(/^→ /, '')}. La TV sigue en ${t.elapsed}.` : '');
  attr(hint, 'data-pending', dragging || !!t.target);
}

function paintMando(doc, v) {
  const m = v.mando;
  put(byId(doc, 'board-title'), 'textContent', m.board.title);
  paintFlaps(doc, byId(doc, 'board-clock'), m.board.clock);
  put(byId(doc, 'board-clock-sr'), 'textContent', m.board.clock);
  put(byId(doc, 'board-state-text'), 'textContent', m.board.state);
  attr(byId(doc, 'board-state'), 'data-glyph', GLYPH[m.board.state] ?? '');
  put(byId(doc, 'board-room'), 'textContent', m.board.room);
  paintTrack(doc, m.track);
  ctl(byId(doc, 'back'), m.back); ctl(byId(doc, 'forward'), m.forward);
  const badge = byId(doc, 'skip-badge'), side = byId(doc, m.badge?.startsWith('−') ? 'back' : 'forward').parentNode;
  put(badge, 'hidden', !m.badge); put(badge, 'textContent', m.badge ?? '');
  if (badge.parentNode !== side) side.appendChild(badge);
  const toggle = byId(doc, 'toggle'), spinning = m.toggle.icon === 'spinner';
  ctl(toggle, m.toggle); attr(toggle, 'aria-label', m.toggle.label);
  attr(byId(doc, 'toggle-glyph'), 'hidden', spinning ? '' : null);
  put(byId(doc, 'toggle-spinner'), 'hidden', !spinning);
  attr(byId(doc, 'toggle-icon'), 'href', m.toggle.icon === 'play' ? '#i-play' : '#i-pause');
  const waiting = byId(doc, 'waiting');
  put(waiting, 'hidden', !m.waiting);
  if (m.waiting) { put(byId(doc, 'waiting-text'), 'textContent', m.waiting.text); put(byId(doc, 'waiting-detail'), 'textContent', m.waiting.detail || ''); ctl(byId(doc, 'waiting-cancel'), m.waiting.cancel); }
  const volume = byId(doc, 'volume');
  ctl(volume, m.volume); put(volume, 'value', String(m.volume.percent ?? 0));
  volume.style.setProperty('--p', `${m.volume.percent ?? 0}%`);
  put(byId(doc, 'volume-text'), 'textContent', m.volume.text);
  const mute = byId(doc, 'mute');
  ctl(mute, m.mute); attr(mute, 'aria-pressed', m.mute.pressed); attr(mute, 'aria-label', m.mute.label);
  attr(byId(doc, 'mute-icon'), 'href', m.mute.pressed ? '#i-muted' : '#i-volume');
  const chip = byId(doc, 'open-subs');
  ctl(chip, m.chip); attr(chip, 'data-unapplied', m.chip.unapplied);
  put(byId(doc, 'chip-kind'), 'textContent', m.chip.unapplied ? 'Sin aplicar' : 'Subtítulos');
  put(byId(doc, 'chip-value'), 'textContent', m.chip.label);
  ctl(byId(doc, 'open-more'), m.more); ctl(byId(doc, 'open-change'), m.change); ctl(byId(doc, 'stop'), m.stop);
}

function paintSubsSheet(doc, s) {
  paintList(byId(doc, 'cap-tracks'), s.tracks);
  const visible = byId(doc, 'cap-visible');
  put(visible, 'checked', s.visible.checked); ctl(visible, s.visible);
  put(byId(doc, 'cap-delay'), 'textContent', s.delay.text);
  put(byId(doc, 'cap-meaning'), 'textContent', s.delay.meaning);
  for (const id of ['cap-m1000', 'cap-m100', 'cap-p100', 'cap-p1000', 'cap-reset']) ctl(byId(doc, id), s.steps);
  attr(byId(doc, 'cap-sync'), 'data-unapplied', s.unapplied);
  put(byId(doc, 'cap-on-tv'), 'textContent', s.onTv);
  put(byId(doc, 'cap-note'), 'textContent', s.note);
  const apply = byId(doc, 'cap-apply');
  put(apply, 'textContent', s.apply.label); ctl(apply, s.apply); attr(apply, 'aria-busy', s.apply.pending);
  ctl(byId(doc, 'cap-discard'), s.discard);
}

function paintMoreSheet(doc, s) {
  const exact = byId(doc, 'exact');
  if (doc.activeElement !== exact) put(exact, 'value', s.exact.text);
  put(exact, 'disabled', !s.exact.enabled); attr(exact, 'aria-invalid', s.exact.error ? 'true' : null);
  put(byId(doc, 'exact-error'), 'textContent', s.exact.error);
  put(byId(doc, 'exact-go'), 'disabled', !s.exact.enabled);
  put(byId(doc, 'detail-tv'), 'textContent', s.details.tv);
  put(byId(doc, 'detail-host'), 'textContent', s.details.host);
  put(byId(doc, 'detail-file'), 'textContent', s.details.file);
  put(byId(doc, 'detail-prepared'), 'textContent', s.details.prepared);
  ctl(byId(doc, 'more-stop'), s.stop);
}

/** Open or close a native dialog to match the view. Returns true when it closed. */
function reconcileDialog(dialog, want) {
  if (want === dialog.open) return false;
  if (want) dialog.showModal(); else dialog.close();
  return !want;
}

/** View -> DOM. Persistent nodes only; throws on a missing id, which is how the shell test proves the markup covers the view. */
function paint(doc, v) {
  const demo = byId(doc, 'demo-banner');
  put(demo, 'hidden', !v.demo);
  const scenario = byId(doc, 'scenario');
  if (v.demo && doc.activeElement !== scenario) put(scenario, 'value', v.demo.scenario);
  put(byId(doc, 'prep'), 'hidden', v.mode !== 'preparar');
  put(byId(doc, 'mando'), 'hidden', v.mode !== 'mando');
  paintProblem(doc, v);
  paintPlan(doc, v);
  paintDestination(doc, v);
  if (v.mando) paintMando(doc, v);
  const kind = v.sheet?.kind ?? null;
  for (const [id, panel] of SHEETS) {
    const node = byId(doc, panel);
    put(node, 'hidden', id !== kind);
    if (id === kind) put(byId(doc, 'sheet-title'), 'textContent', node.getAttribute('data-title'));
  }
  if (v.sheet?.kind === 'subs') paintSubsSheet(doc, v.sheet);
  if (v.sheet?.kind === 'more') paintMoreSheet(doc, v.sheet);
  if (v.confirm) {
    put(byId(doc, 'confirm-title'), 'textContent', v.confirm.title);
    put(byId(doc, 'confirm-body'), 'textContent', v.confirm.body);
    put(byId(doc, 'confirm-accept'), 'textContent', v.confirm.accept);
    put(byId(doc, 'confirm-cancel'), 'textContent', v.confirm.cancel);
  }
  const sheet = byId(doc, 'sheet'), confirm = byId(doc, 'confirm');
  const closedSheet = reconcileDialog(sheet, !!v.sheet), closedConfirm = reconcileDialog(confirm, !!v.confirm);
  const a = doc.activeElement;
  if ((closedSheet || closedConfirm) && !sheet.open && !confirm.open && (!a || a === doc.body)) byId(doc, v.mode === 'mando' ? 'mando' : 'prep').focus();
}

const FETCH_MS = 6000;
const isTyping = el => !!el && el.id !== 'track' && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable === true);

/** The whole runtime. env = {fetch, setTimeout, clearTimeout, storage, token, now, wakeLock}. */
function boot(doc, env) {
  let interaction = 0, view = null, lock = null, locking = false;
  const read = key => { try { return env.storage?.getItem(key) ?? null; } catch (_) { return null; } };
  const {model, fx} = Panel.init({lastDeviceId: read('cast.lastDevice')});

  const dispatch = msg => {
    const out = Panel.step(model, {at: env.now(), n: interaction, ...msg});
    view = Panel.view(model);
    paint(doc, view);
    syncWake();
    out.fx.forEach(run);
  };

  const request = (path, options, done) => {
    const controller = new AbortController();
    let aborted = false;
    const timer = env.setTimeout(() => { aborted = true; controller.abort(); }, FETCH_MS);
    env.fetch(path, {...options, signal: controller.signal}).then(async res => {
      let body = null;
      try { body = await res.json(); } catch (_) { /* not JSON: the status alone decides */ }
      return {ok: res.ok, body};
    }).catch(() => ({ok: false, body: null, timeout: aborted})).then(r => { env.clearTimeout(timer); done(r); });
  };

  const RUN = {
    poll: f => request('/api/status', {cache: 'no-store'}, r => dispatch({t: 'status', gen: f.gen, seq: f.seq, ok: r.ok, raw: r.ok ? r.body : null})),
    post: f => request(`/api/${f.action}`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Bridge-Token': env.token}, body: JSON.stringify(f.body)},
      r => dispatch({t: 'reply', ticket: f.ticket, ok: r.ok, body: r.body, code: r.body?.code, message: r.body?.message, timeout: !!r.timeout})),
    timer: f => { env.setTimeout(() => dispatch({t: 'timer', name: f.name, ticket: f.ticket}), f.ms); },
    read: async f => {
      const input = byId(doc, 'upload-input'), file = input.files?.[0];
      let bytes = null;
      try { bytes = file ? await file.arrayBuffer() : null; } catch (_) { /* reported by the core as unreadable */ }
      input.value = '';
      dispatch({t: 'file', ticket: f.ticket, bytes});
    },
    store: f => { try { env.storage?.setItem(f.key, f.value); } catch (_) { /* private mode */ } },
    focus: f => {
      const el = doc.getElementById(f.ref), a = doc.activeElement, dialog = el?.closest('dialog');
      if (!el || interaction !== f.n || (a && a !== doc.body && a !== el) || el.disabled || el.closest('[hidden]') || (dialog && !dialog.open)) return;
      el.focus();
    },
  };
  const run = f => RUN[f.fx](f);

  const acquire = async () => {
    if (!env.wakeLock || locking || doc.visibilityState === 'hidden') return;
    locking = true;
    try {
      const l = await env.wakeLock.request('screen');
      if (view?.wake) { lock = l; l.addEventListener?.('release', () => { if (lock === l) lock = null; }); } else l.release().catch(() => {});
    } catch (_) { /* denied or unsupported */ } finally { locking = false; }
  };
  function syncWake() {
    if (view?.wake) { if (!lock) acquire(); } else if (lock) { lock.release().catch(() => {}); lock = null; }
  }

  doc.addEventListener('click', e => {
    const t = e.target;
    if (t.tagName === 'DIALOG') {
      const r = t.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dispatch({t: 'dismiss'});
      return;
    }
    const el = t.closest('[data-act]');
    if (el && !el.disabled) dispatch({t: el.getAttribute('data-act'), arg: el.getAttribute('data-arg') ?? undefined, from: el.id});
  });
  doc.addEventListener('change', e => {
    const el = e.target.closest('[data-change]');
    if (!el || (seekIgnored && el.id === 'track')) return;
    const arg = el.getAttribute('type') === 'file' ? (el.files?.[0] ? {name: el.files[0].name, size: el.files[0].size} : null)
      : el.getAttribute('type') === 'checkbox' ? el.checked : el.value;
    dispatch({t: el.getAttribute('data-change'), arg, from: el.id});
  });
  doc.addEventListener('input', e => {
    const el = e.target.closest('[data-input]');
    if (el && !(seekIgnored && el.id === 'track')) dispatch({t: el.getAttribute('data-input'), arg: el.value, from: el.id});
  });
  doc.addEventListener('submit', e => {
    const form = e.target.closest('[data-submit]');
    if (!form) return;
    e.preventDefault();
    dispatch({t: form.getAttribute('data-submit'), arg: form.querySelector('input')?.value ?? '', from: e.submitter?.id || form.id});
  });
  for (const id of ['sheet', 'confirm']) byId(doc, id).addEventListener('cancel', e => { e.preventDefault(); dispatch({t: 'dismiss'}); });
  byId(doc, 'track').addEventListener('pointercancel', () => abandonSeek());
  /** After Escape the pointer is still down: the rest of that drag is no gesture. Its final change arrives after pointerup, so the guard lifts one tick later or at the next pointerdown. */
  let seekIgnored = false;
  byId(doc, 'track').addEventListener('pointerdown', () => { seekIgnored = false; });
  doc.addEventListener('pointerup', () => {
    if (!seekIgnored) return;
    env.setTimeout(() => {
      if (!seekIgnored) return;
      seekIgnored = false;
      if (view?.mando) byId(doc, 'track').value = String(view.mando.track.value);
    }, 0);
  });
  function abandonSeek() {
    if (view?.mando?.track.previewAt == null) return;
    byId(doc, 'track').value = String(view.mando.track.value);
    dispatch({t: 'seekAbandon'});
  }
  doc.addEventListener('keydown', e => {
    const target = e.target, facts = {key: e.key, mods: e.ctrlKey || e.metaKey || e.altKey, repeat: !!e.repeat, typing: isTyping(target),
      onButton: target?.tagName === 'BUTTON', idle: !doc.activeElement || doc.activeElement === doc.body, n: interaction};
    const key = view ? Panel.keyMsg(view, facts) : null;
    if (key === 'swallow') { e.preventDefault(); return; }
    interaction++;
    if (e.key === 'Escape' && view?.mando?.track.previewAt != null) { seekIgnored = true; abandonSeek(); return; }
    if (key) { e.preventDefault(); dispatch({...key, from: target?.id}); }
    else if (target?.id === 'track' && e.key.startsWith('Arrow')) e.preventDefault();
  });
  for (const type of ['pointerdown', 'focusin']) doc.addEventListener(type, () => { interaction++; });
  doc.addEventListener('visibilitychange', syncWake);

  view = Panel.view(model);
  paint(doc, view);
  fx.forEach(run);
  return {dispatch, view: () => view};
}

if (typeof module !== 'undefined') module.exports = {Panel, boot, paint, paintList};
if (typeof document !== 'undefined') boot(document, {
  fetch: (...args) => fetch(...args), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
  storage: (() => { try { return localStorage; } catch (_) { return null; } })(),
  token, now: () => Date.now(), wakeLock: navigator.wakeLock || null,
});
