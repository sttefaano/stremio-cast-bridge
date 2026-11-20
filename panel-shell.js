// ───────── DOM shell: performs the core's effects and paints Panel.view(). It knows ids and effect kinds, never a rule.
// Depends on: panel.js.
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
const paintStop = (node, c) => { ctl(node, c); put(node, 'hidden', !c.shown); put(node, 'textContent', c.label); };
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
  put(byId(doc, 'problem-kind'), 'textContent', p.label);
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
  put(byId(doc, 'stremio-status'), 'textContent', st.status);
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
  paintList(byId(doc, 'device-list'), d.rows);
  put(byId(doc, 'device-note'), 'textContent', d.note);
  put(byId(doc, 'device-status'), 'textContent', d.status);
  put(byId(doc, 'device-rule'), 'textContent', d.rule); put(byId(doc, 'device-rule'), 'hidden', !d.rule);
  paintStop(byId(doc, 'device-stop'), d.stop);
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
  put(hint, 'textContent', t.hint);
  attr(hint, 'data-pending', !!t.hint);
}

function paintMando(doc, v) {
  const m = v.mando;
  put(byId(doc, 'board-title'), 'textContent', m.board.title);
  paintFlaps(doc, byId(doc, 'board-clock'), m.board.clock);
  put(byId(doc, 'board-clock-sr'), 'textContent', m.board.clock);
  put(byId(doc, 'board-state-text'), 'textContent', m.board.state);
  attr(byId(doc, 'board-state'), 'data-glyph', m.board.glyph ?? '');
  put(byId(doc, 'board-room'), 'textContent', m.board.room);
  paintTrack(doc, m.track);
  ctl(byId(doc, 'back'), m.back); ctl(byId(doc, 'forward'), m.forward);
  const badge = byId(doc, 'skip-badge'), side = byId(doc, m.badge?.side ?? 'forward').parentNode;
  put(badge, 'hidden', !m.badge); put(badge, 'textContent', m.badge?.text ?? '');
  if (badge.parentNode !== side) side.appendChild(badge);
  const play = byId(doc, 'toggle'), spinning = m.toggle.icon === 'spinner';
  ctl(play, m.toggle); attr(play, 'aria-label', m.toggle.label);
  attr(byId(doc, 'toggle-glyph'), 'hidden', spinning ? '' : null);
  put(byId(doc, 'toggle-spinner'), 'hidden', !spinning);
  attr(byId(doc, 'toggle-icon'), 'href', m.toggle.icon === 'play' ? '#i-play' : '#i-pause');
  const waiting = byId(doc, 'waiting');
  put(waiting, 'hidden', !m.waiting);
  if (m.waiting) { put(byId(doc, 'waiting-text'), 'textContent', m.waiting.text); put(byId(doc, 'waiting-detail'), 'textContent', m.waiting.detail || ''); const cancel = byId(doc, 'waiting-cancel'); ctl(cancel, m.waiting.cancel); put(cancel, 'textContent', m.waiting.cancel.label); }
  const volume = byId(doc, 'volume');
  ctl(volume, m.volume); put(volume, 'value', String(m.volume.percent ?? 0));
  volume.style.setProperty('--p', `${m.volume.percent ?? 0}%`);
  put(byId(doc, 'volume-text'), 'textContent', m.volume.text);
  const mute = byId(doc, 'mute');
  ctl(mute, m.mute); attr(mute, 'aria-pressed', m.mute.pressed); attr(mute, 'aria-label', m.mute.label);
  attr(byId(doc, 'mute-icon'), 'href', m.mute.pressed ? '#i-muted' : '#i-volume');
  const chip = byId(doc, 'open-subs');
  ctl(chip, m.chip); attr(chip, 'data-unapplied', m.chip.unapplied);
  put(byId(doc, 'chip-kind'), 'textContent', m.chip.kind);
  put(byId(doc, 'chip-value'), 'textContent', m.chip.label);
  ctl(byId(doc, 'open-more'), m.more); ctl(byId(doc, 'open-change'), m.change); paintStop(byId(doc, 'stop'), m.stop);
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
  paintStop(byId(doc, 'more-stop'), s.stop);
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
  let interaction = 0, current = null, lock = null, locking = false;
  /** A file input fires no change for the same file twice, so it is emptied at once and the pick kept here. */
  let picked = null;
  /** After Escape the pointer is still down: the rest of that drag is no gesture. Its final change arrives after pointerup, so the guard lifts one tick later or at the next pointerdown. */
  let seekIgnored = false;
  const read = key => { try { return env.storage?.getItem(key) ?? null; } catch (_) { return null; } };
  const {model, fx} = Panel.init({lastDeviceId: read('cast.lastDevice')});

  const dispatch = msg => {
    const out = Panel.step(model, {at: env.now(), n: interaction, ...msg});
    current = Panel.view(model);
    paint(doc, current);
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
      const file = picked;
      picked = null;
      let bytes = null;
      try { bytes = file ? await file.arrayBuffer() : null; } catch (_) { /* reported by the core as unreadable */ }
      dispatch({t: 'file', ticket: f.ticket, bytes});
    },
    clearSearch: () => { byId(doc, 'stremio-hint').value = ''; },
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
      if (current?.wake) { lock = l; l.addEventListener?.('release', () => { if (lock === l) lock = null; }); } else l.release().catch(() => {});
    } catch (_) { /* denied or unsupported */ } finally { locking = false; }
  };
  function syncWake() {
    if (current?.wake) { if (!lock) acquire(); } else if (lock) { lock.release().catch(() => {}); lock = null; }
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
    const type = el.getAttribute('type');
    if (type === 'file') { picked = el.files?.[0] ?? null; el.value = ''; }
    const arg = type === 'file' ? (picked ? {name: picked.name, size: picked.size} : null) : type === 'checkbox' ? el.checked : el.value;
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
  byId(doc, 'track').addEventListener('pointerdown', () => { seekIgnored = false; });
  doc.addEventListener('pointerup', () => {
    if (!seekIgnored) return;
    env.setTimeout(() => {
      if (!seekIgnored) return;
      seekIgnored = false;
      if (current?.mando) byId(doc, 'track').value = String(current.mando.track.value);
    }, 0);
  });
  function abandonSeek() {
    if (current?.mando?.track.previewAt == null) return;
    byId(doc, 'track').value = String(current.mando.track.value);
    dispatch({t: 'seekAbandon'});
  }
  doc.addEventListener('keydown', e => {
    const target = e.target, facts = {key: e.key, mods: e.ctrlKey || e.metaKey || e.altKey, repeat: !!e.repeat, typing: isTyping(target),
      onButton: target?.tagName === 'BUTTON', idle: !doc.activeElement || doc.activeElement === doc.body, n: interaction};
    const key = current ? Panel.keyMsg(current, facts) : null;
    if (key === 'swallow') { e.preventDefault(); return; }
    interaction++;
    if (e.key === 'Escape' && current?.mando?.track.previewAt != null) { seekIgnored = true; abandonSeek(); return; }
    if (key) { e.preventDefault(); dispatch({...key, from: target?.id}); }
    else if (target?.id === 'track' && e.key.startsWith('Arrow')) e.preventDefault();
  });
  for (const type of ['pointerdown', 'focusin']) doc.addEventListener(type, () => { interaction++; });
  doc.addEventListener('visibilitychange', syncWake);

  current = Panel.view(model);
  paint(doc, current);
  fx.forEach(run);
  return {dispatch, view: () => current};
}

if (typeof module !== 'undefined') module.exports = {Panel, boot};
if (typeof document !== 'undefined') boot(document, {
  fetch: (...args) => fetch(...args), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
  storage: (() => { try { return localStorage; } catch (_) { return null; } })(),
  token, now: () => Date.now(), wakeLock: navigator.wakeLock || null,
});
