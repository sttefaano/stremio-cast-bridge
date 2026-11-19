const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {PANEL_FILES} = require('./helpers/panel-source.cjs');
const {plain, panel, catalogue, destination, playing, idle, choose, offline, names, paused, subsOk, withTracks, stopped, stopFromPlaying, key} = require('./helpers/panel-harness.cjs');

// ───────── ui: layers, errors, notices, focus; and reconcile

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

test('the offline block says only what the outage cost; an earlier notice waits for the link and is dismissible there', () => {
  const p = panel(playing);
  p.tap('dropSeek', 9999);
  offline(p);
  assert.deepEqual([p.view.problem.kind, p.view.problem.body], ['offline', 'No podemos confirmar qué pasa en la TV. Seguimos intentando.']);
  p.fire('poll');
  p.status(playing);
  assert.deepEqual([p.view.problem.kind, p.view.problem.body], ['notice', 'El tiempo está fuera de la duración de la película.']);
  p.tap('dismissNotice');
  assert.equal(p.view.problem, null);
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

test('a sent Start that fails is reported even when the TV left Mando while it was in flight', () => {
  for (const next of [stopped, {...playing, phase: 'receiver_changed'}]) {
    const p = panel(playing);
    p.tap('openChange');
    choose(p, 'b');
    p.tap('start');
    p.tap('confirmAccept');
    p.status(playing);
    const start = p.posted('start');
    p.fire('poll');
    p.status(next);
    p.reply(start, {ok: false, code: 'busy', message: 'La TV está ocupada.'});
    p.status(next);
    assert.equal(p.view.problem?.body, next === stopped ? 'La TV está ocupada.' : 'Este mando no lo controla. Detené para volver a elegir.', next.phase);
    if (next !== stopped) {
      p.fire('poll');
      p.status(playing);
      assert.equal(p.view.problem?.body, 'La TV está ocupada.', 'shown once the foreign state clears');
    }
  }
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

test('offline keeps an open subtitle or change sheet, but neither opens', () => {
  for (const [act, kind] of [['openSubs', 'subs'], ['openChange', 'change']]) {
    const open = panel(playing);
    open.tap(act);
    offline(open);
    assert.equal(open.view.sheet?.kind, kind, `${kind} stays open offline`);
    const closed = panel(playing);
    offline(closed);
    closed.tap(act);
    assert.equal(closed.view.sheet, null, `${kind} does not open offline`);
    assert.equal(closed.view.mando[kind === 'subs' ? 'chip' : 'change'].enabled, false);
  }
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
  p.tick(1000);
  assert.equal(p.effects('timer').filter(t => t.name === 'clock').length, 1, 'not armed twice');
  p.fire('clock');
  assert.equal(p.effects('timer').filter(t => t.name === 'clock').length, 1, 're-armed after the tick');
  const q = panel(paused);
  assert.equal(q.effects('timer').filter(t => t.name === 'clock').length, 0);
});

// ───────── keyboard and the View contract

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
  p.tap('dismiss');
  p.tap('openMore');
  for (const k of [' ', 'ArrowLeft', 'm', 'z', 'x']) assert.equal(key(p, k), null, 'Más open');
  p.tap('dismiss');
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
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v, `${name}: nothing is lost in JSON, so nothing is a function or undefined`);
    assert.equal(v.wake, v.mode === 'mando', name);
    assert.equal(v.mando === null, v.mode === 'preparar', name);
    if (v.problem?.action) assert.ok(Object.hasOwn(states.mando.Panel.ACTS, v.problem.action.act), name);
  }
  assert.equal(states.subs.view.sheet.kind, 'subs');
  assert.equal(states.more.view.sheet.kind, 'more');
  assert.equal(states.change.view.sheet.kind, 'change');
  assert.equal(states.confirm.view.confirm.kind, 'stop');
});

test('an unknown or inherited message name does nothing', () => {
  const p = panel(playing);
  for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nothing']) p.send({t});
  assert.deepEqual(p.pending.filter(e => e.fx === 'post'), []);
});

test('only the shell reads document, fetch, timers, storage or the browser', () => {
  for (const name of PANEL_FILES.filter(f => f !== 'panel-shell.js')) {
    const src = fs.readFileSync(name, 'utf8');
    for (const banned of ['document.', 'fetch(', 'setTimeout', 'setInterval', 'localStorage', 'navigator.', 'window.']) assert.equal(src.includes(banned), false, `${name}: ${banned}`);
  }
});
