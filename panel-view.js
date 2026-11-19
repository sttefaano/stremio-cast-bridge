// ───────── view: plain data for the shell to paint. All es-AR copy lives here; view reads the model and writes nothing.
// Depends on: panel-core.js, panel-addon.js.
/**
 * @typedef {{enabled:boolean}} Ctl
 * @typedef {{id:string,label:string,note?:string,selected:boolean,enabled:boolean,reason?:string,tag?:string}} Row
 * @typedef {object} PlanView  Rendered in Preparar (segments 01 and 03 and the stub) and inside the "Cambiar película" sheet.
 * @property {Row[]} sources
 * @property {string} sourceStatus
 * @property {Ctl} refreshSources
 * @property {{id:'none'|'file'|'stremio'|'upload',label:string,selected:boolean,hidden:boolean,enabled:boolean}[]} branches
 * @property {string} subsStatus  the one status line of the chosen branch
 * @property {Row[]} fileEntries  embedded tracks; unsupported ones visible, disabled, with a reason
 * @property {{filename:string,busy:boolean,enabled:boolean,message:string,chosen:string}} upload
 * @property {StremioView|null} stremio  null when the addon is off or there is no catalogue yet
 * @property {Ctl} refreshCatalogue
 * @property {{label:string,note:string,enabled:boolean}} primary  'Iniciar en Sala (Google TV)' | 'Cambiar película en la TV' | 'Ya está en la TV' | 'Iniciando…'
 * @property {{label:'Falta'|'Embarque',value:string,missing:string[]}} stub
 * @typedef {object} StremioView
 * @property {string} match
 * @property {Row[]} languages
 * @property {Row[]} versions
 * @property {Ctl&{shown:boolean,label:string}} use
 * @property {Ctl&{shown:boolean}} retry
 * @property {Ctl&{shown:boolean,open:boolean}} wrong
 * @property {boolean} correctionOpen
 * @property {Row[]} alternatives
 * @property {Ctl} search
 * @property {string} status
 */
const trackLabel = e => [e.label || 'Pista sin nombre', e.language].filter(Boolean).join(' · ');
const stopLabel = (c, label) => c.stopping ? STOPPING : label;
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
  const s = m.link.status, p = m.plan, c = caps(m), cat = p.catalogue, sel = s.selected_device;
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
      id: e.id, label: trackLabel(e), selected: p.choice.entryId === e.id,
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
 * @property {string} status
 * @property {Row[]} rows
 * @property {Ctl} refresh
 * @property {string} rule
 * @property {Ctl&{shown:boolean,label:string}} stop
 * @property {string} details  host of the chosen TV, for the disclosure
 */
function viewDestination(m) {
  const s = m.link.status, p = m.plan, c = caps(m), sel = s.selected_device, last = m.prefs.lastDeviceId;
  const error = p.refresh.discover_devices.error || (s.device_discovery === 'error' ? s.device_error || 'Reintentá la búsqueda.' : '');
  const devices = s.devices || [], busyList = s.device_discovery === 'loading' || !!p.refresh.discover_devices.ticket;
  return {
    label: sel ? deviceLabel(sel) : 'Sin TV elegida',
    note: !sel ? '' : s.phase === 'disconnected' ? 'No disponible' : error ? 'Lista sin confirmar' : sel.available || LIVE.includes(s.phase) ? '' : 'No disponible',
    status: error ? `No se pudo actualizar la lista de TVs. Usá Actualizar para reintentar. ${error}`
      : busyList ? 'Buscando TVs…' : devices.length ? '' : s.device_discovery === 'ready' ? 'No encontramos ninguna TV. Revisá que esté encendida y en la misma red, y actualizá.' : 'Buscando TVs…',
    rows: devices.map(d => ({id: d.id, label: deviceLabel(d), selected: d.id === sel?.id, enabled: c.changeDevice, ...(d.id === last ? {tag: 'Última usada'} : {})})),
    refresh: {enabled: c.online && !busyList},
    rule: s.can_change_device === false ? 'Primero detené la película para cambiar de TV.' : '',
    stop: {shown: s.can_change_device === false, enabled: c.stop, label: stopLabel(c, 'Detener')},
    details: sel?.host || '',
  };
}

/** @typedef {{kind:'replace'|'stop',title:string,body:string,accept:string,cancel:string}} ConfirmView */
function viewConfirm(m) {
  const k = m.ui.confirm, s = m.link.status;
  if (!k) return null;
  if (k.kind === 'replace') return {kind: 'replace', title: '¿Cambiar la película en la TV?', body: `Vas a ver ${k.title}. Empieza desde el principio.`, accept: 'Cambiar película', cancel: 'Volver'};
  return {kind: 'stop', title: '¿Detener la película en la TV?', body: `Se corta en ${deviceLabel(s.selected_device) || 'la TV'} y volvés a elegir.`, accept: 'Detener', cancel: 'Seguir viendo'};
}

const BOARD_STATE = {playing: 'REPRODUCIENDO', paused: 'EN PAUSA', preparing: 'PREPARANDO', buffering: 'CARGANDO', loading: 'CARGANDO',
  disconnected: 'SIN SEÑAL', receiver_changed: 'OTRO CONTENIDO', error: 'CON ERROR'};
const BOARD_GLYPH = {playing: 'play', paused: 'pause', preparing: 'spinner', buffering: 'spinner', loading: 'spinner'};
const WAITING_COPY = {preparing: 'Preparando la película para la TV…', buffering: 'Preparando más contenido para la TV…', loading: 'Cargando la película en la TV…'};

/** Where the flap clock reads: the last status plus the time since, capped so a stalled poll never invents a position. */
function shownPosition(m) {
  const s = m.link.status;
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
 * @property {{title:string,clock:string,state:string,glyph:'play'|'pause'|'spinner'|null,room:string}} board  clock is display-only (interpolated while playing); glyph follows the phase, null when unconfirmed or not playing/waiting
 * @property {{enabled:boolean,max:number,value:number,elapsed:string,total:string,preview:string|null,previewAt:number|null,target:string|null,buffered:{start:number,end:number}|null}} track
 *           value and elapsed are the real position; preview ('→ h:mm:ss') exists only while dragging, target while a sent seek has not settled
 * @property {Ctl} back
 * @property {Ctl} forward
 * @property {string|null} badge  accumulated skip, '+60 s'
 * @property {Ctl&{icon:'play'|'pause'|'spinner',label:string}} toggle
 * @property {null|{text:string,detail:string,cancel:Ctl&{label:string}}} waiting  'Esperando a Sala · Google TV' with Cancelar (= stop)
 * @property {Ctl&{percent:number|null,text:string}} volume
 * @property {Ctl&{pressed:boolean,label:string}} mute
 * @property {Ctl&{label:string,unapplied:boolean}} chip  subtitle chip; unapplied while a caption draft differs from the TV
 * @property {Ctl} more
 * @property {Ctl} change
 * @property {Ctl&{shown:boolean,label:string}} stop  header Detener; hidden while the page's problem block offers its own (one Detener at a time)
 */
function viewMando(m) {
  const s = m.link.status, c = caps(m), k = m.remote.seek, sel = s.selected_device, d = durationOf(s);
  const pos = shownPosition(m), waiting = WAITING.includes(s.phase), srv = capServer(s);
  const chosen = s.subtitle_choice;
  const volume = m.remote.volumePreview ?? (finite(s.volume) ? Math.round(s.volume * 100) : null);
  const spinner = waiting || m.link.inflight.length > 0 || !!s.command_pending;
  return {
    board: {
      title: s.title || 'Tu película en la TV', clock: formatTime(pos), room: deviceLabel(sel) || 'Sin TV',
      state: !c.online ? 'SIN CONFIRMAR' : BOARD_STATE[s.phase] ?? 'SIN CONFIRMAR',
      glyph: c.online ? BOARD_GLYPH[s.phase] ?? null : null,
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
    waiting: waiting ? {text: `Esperando a ${deviceLabel(sel) || 'la TV'}`, detail: s.message || WAITING_COPY[s.phase], cancel: {enabled: c.stop, label: stopLabel(c, 'Cancelar')}} : null,
    volume: {enabled: c.transport && finite(s.volume), percent: volume, text: volume === null ? '—' : `${volume}%`},
    mute: {enabled: c.transport && typeof s.muted === 'boolean', pressed: s.muted === true, label: s.muted ? 'Activar sonido' : 'Silenciar'},
    chip: {
      enabled: c.sheets.subs.open, unapplied: capDirty(m),
      label: !srv.subtitleId ? 'Sin subtítulos' : `${chosen?.label || 'Subtítulos'} · ${srv.enabled ? signedSeconds(srv.delayMs) : 'ocultos'}`,
    },
    more: {enabled: c.sheets.more.open}, change: {enabled: c.sheets.change.open}, stop: {enabled: c.stop, shown: !problemOffersStop(m), label: stopLabel(c, 'Detener')},
  };
}

/**
 * @typedef {object} SubsSheetView  "Enmienda al pase"
 * @property {'subs'} kind
 * @property {Row[]} tracks  'Sin subtítulos' (id '') then the supported tracks
 * @property {Ctl&{checked:boolean}} visible  applies at once, through the same pipeline as Aplicar
 * @property {{text:string,meaning:string}} delay
 * @property {Ctl} steps
 * @property {Ctl&{label:string,pending:boolean}} apply
 * @property {Ctl} discard
 * @property {boolean} unapplied
 * @property {string} onTv
 * @property {string} note
 * @property {StremioView|null} stremio
 */
function viewSubsSheet(m) {
  const s = m.link.status, c = caps(m), srv = capServer(s), d = capDraft(m), a = m.remote.captions.apply, cat = remoteCatalogue(m);
  const row = (id, label) => ({id, label, selected: d.subtitleId === (id || null), enabled: c.captions});
  const dirty = capDirty(m);
  return {
    kind: 'subs',
    tracks: [row('', 'Sin subtítulos'), ...(cat?.entries || []).filter(e => e.supported === true).map(e => row(e.id, trackLabel(e)))],
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
/** @typedef {{kind:'more',exact:Ctl&{text:string,error:string},details:{tv:string,host:string,file:string,prepared:string},stop:Ctl&{shown:boolean,label:string}}} MoreSheetView */
function viewMoreSheet(m) {
  const s = m.link.status, c = caps(m), sel = s.selected_device, b = bufferedRange(s);
  return {
    kind: 'more',
    exact: {enabled: c.transport && !!durationOf(s), text: m.ui.exact.text, error: m.ui.exact.error},
    details: {
      tv: deviceLabel(sel), host: sel?.host || '', file: s.sources.find(x => x.id === s.source_id)?.filename || 'Nombre no disponible',
      prepared: b ? `De ${formatTime(b.start)} a ${formatTime(b.end)}` : 'Sin datos todavía',
    },
    stop: {enabled: c.stop, shown: !problemOffersStop(m), label: stopLabel(c, 'Detener')},
  };
}
function viewSheet(m) {
  const k = m.ui.sheet;
  return k === 'subs' ? viewSubsSheet(m) : k === 'more' ? viewMoreSheet(m) : k === 'change' ? {kind: 'change'} : null;
}

/**
 * @typedef {object} ProblemView  The ONE problem block. kind priority: offline > unknown > foreign > disconnected > failed > notice > stopped.
 * @property {'offline'|'unknown'|'foreign'|'disconnected'|'failed'|'notice'|'stopped'} kind
 * @property {string} title
 * @property {string} body  '' when the title says it all
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
    problem: viewProblem(m), demo: m.link.status.demo === true ? {scenario: m.link.status.scenario || ''} : null,
    wake: mode === 'mando', restoring: m.ui.focus && {ref: m.ui.focus.ref, n: m.ui.focus.n},
  };
}
