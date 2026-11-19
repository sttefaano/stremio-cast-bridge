// ───────── Panel: init, step, the standing rules, ACTS and keyMsg.
// Depends on: panel-core.js, panel-addon.js, panel-view.js.

/** @param {{lastDeviceId?:string|null}} [saved] @returns {{model:Model,fx:object[]}} the first poll is in fx */
function init(saved = {}) {
  const model = freshModel(saved.lastDeviceId ?? null), fx = [];
  linkRequestPoll(model, fx);
  return {model, fx};
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
  else if (msg.t === 'reply') routeReply(m, fx, msg);
  else if (msg.t === 'timer') onTimer(m, fx, msg);
  else if (msg.t === 'file') planFileRead(m, fx, msg);
  else if (Object.hasOwn(ACTS, msg.t)) ACTS[msg.t](m, fx, msg);
  reconcile(m, fx);
  return {model: m, fx};
}
/** Each owner claims its own tickets. A ticket nobody holds is dropped: that is the fence. */
function routeReply(m, fx, msg) {
  if (!linkOnReply(m, fx, msg) && !planOnReply(m, fx, msg)) addonRouteReply(m, fx, msg);
}
function onTimer(m, fx, msg) {
  const l = m.link;
  if (msg.name === 'poll' && msg.ticket === l.pollTimer) {
    l.pollTimer = null;
    if (!l.polling) linkIssuePoll(m, fx);
  } else if (msg.name === 'skip') seekOnTimer(m, fx, msg);
  else if (msg.name === 'clock' && msg.ticket === m.ui.clock) m.ui.clock = null;
  else if (msg.name === 'stop') stopOnDeadline(m, msg);
  else if (msg.name === 'start') planOnDeadline(m, msg);
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
  capTrack: (m, fx, g) => capTrack(m, g.arg),
  capNudge, capReset,
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
const Panel = Object.freeze({init, step, view, keyMsg, ACTS});
