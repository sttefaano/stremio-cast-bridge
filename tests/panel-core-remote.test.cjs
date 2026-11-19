const {test} = require('node:test');
const assert = require('node:assert/strict');
const {panel, destination, playing, fixture, idle, choose, offline, names, offers, paused, seekTo, subsOk, withTracks, stopped, key} = require('./helpers/panel-harness.cjs');

// ───────── remote: seek, volume, captions, stop

test('seek commits on release: dragging previews and sends nothing, the elapsed time stays real', () => {
  const p = panel(playing);
  p.tap('dragSeek', 300);
  assert.equal(p.posts().length, 0);
  assert.deepEqual([p.view.mando.track.preview, p.view.mando.track.elapsed, p.view.mando.track.previewAt], ['→ 5:00', '0:50', 300]);
  p.tap('dropSeek', 300);
  assert.deepEqual(p.posted('seek').body, {device_id: 'tv-a', device_revision: 1, position: 300});
  assert.equal(p.posts().length, 1, 'one seek per release');
  assert.equal(p.view.mando.track.preview, null);
  assert.equal(p.view.mando.track.target, '→ 5:00');
});

test('a release outside the movie sends nothing; a seek while busy or foreign is refused', () => {
  const p = panel(playing);
  p.tap('dropSeek', 501);
  p.tap('dropSeek', -1);
  assert.equal(p.posts().length, 0);
  for (const status of [{...playing, command_pending: true}, {...playing, phase: 'loading', pending: true}, {...playing, phase: 'receiver_changed'}]) {
    const q = panel(status);
    q.tap('dragSeek', 100);
    q.tap('dropSeek', 100);
    q.tap('skip', 30);
    assert.equal(q.posts().length + q.effects('timer').filter(t => t.name === 'skip').length, 0, status.phase);
    assert.equal(q.view.mando.track.enabled, false);
  }
});

test('Escape or pointer cancel while dragging goes back to idle and sends nothing', () => {
  const p = panel(playing);
  p.tap('dragSeek', 200);
  p.tap('seekAbandon');
  assert.equal(p.view.mando.track.preview, null);
  assert.equal(p.posts().length, 0);
  p.tap('dropSeek', 200);
  p.tap('seekAbandon');
  assert.ok(p.view.mando.track.target, 'abandon after a release does not forget the sent seek');
});

test('the target stays until the TV is usable and either was seen busy or is within 2 s', () => {
  const p = panel(playing);
  seekTo(p, 300);
  p.settle('seek', {...playing, absolute_time: 50});
  assert.equal(p.view.mando.track.target, '→ 5:00', 'still at the old place: keep the target');
  p.fire('poll');
  p.status({...playing, absolute_time: 50, pending: true});
  p.fire('poll');
  p.status({...playing, absolute_time: 52});
  assert.equal(p.view.mando.track.target, null, 'it was busy and is usable again');
  const q = panel(playing);
  seekTo(q, 300);
  q.settle('seek', {...playing, absolute_time: 299});
  assert.equal(q.view.mando.track.target, null, 'within 2 s of the target');
});

test('a rejected seek clears only its own target; a worker failure arrives only as action_error', () => {
  const p = panel(playing);
  seekTo(p, 300);
  p.settle('seek', {...playing, command_pending: true}, {ok: false, code: 'busy', message: 'La TV está ocupada.'});
  assert.equal(p.view.mando.track.target, null, 'a 409 clears the fictional target');
  const q = panel(playing);
  seekTo(q, 300);
  q.settle('seek', {...playing, absolute_time: 50}, {ok: true, body: {accepted: true}});
  assert.ok(q.view.mando.track.target);
  q.fire('poll');
  q.status({...playing, absolute_time: 50, action_error: 'La TV no pudo saltar.', action_error_revision: 4});
  assert.equal(q.view.mando.track.target, null, 'the worker failure reached the page as action_error and ended the wait');
});

test('±30 taps accumulate into one seek delta after a quiet 600 ms and show their sum', () => {
  const p = panel(playing);
  p.tap('skip', 30); p.tap('skip', 30); p.tap('skip', 30);
  assert.equal(p.view.mando.badge, '+90 s');
  assert.equal(p.posts().length, 0);
  const timers = p.effects('timer').filter(t => t.name === 'skip');
  assert.equal(timers.length, 3);
  assert.ok(timers.every(t => t.ms === 600));
  p.send({t: 'timer', name: 'skip', ticket: timers[0].ticket});
  assert.equal(p.posts().length, 0, 'an older timer is stale');
  p.send({t: 'timer', name: 'skip', ticket: timers[2].ticket});
  assert.deepEqual(p.posted('seek').body, {device_id: 'tv-a', device_revision: 1, delta: 90});
  assert.equal(p.view.mando.badge, null);
});

test('the accumulated skip is clamped so neither the badge nor the delta passes the movie', () => {
  const p = panel({...playing, absolute_time: 20});
  p.tap('skip', -30);
  assert.equal(p.view.mando.badge, '−20 s');
  const q = panel({...playing, absolute_time: 490});
  q.tap('skip', 30); q.tap('skip', 30);
  assert.equal(q.view.mando.badge, '+10 s');
  q.send({t: 'timer', name: 'skip', ticket: q.effects('timer').filter(t => t.name === 'skip').pop().ticket});
  assert.equal(q.posted('seek').body.delta, 10);
  const r = panel({...playing, absolute_time: 0});
  r.tap('skip', -30);
  assert.equal(r.view.mando.badge, null);
  r.send({t: 'timer', name: 'skip', ticket: r.effects('timer').pop().ticket});
  assert.equal(r.posts().length, 0, 'nothing to skip');
});

test('a skip timer that finds our own short command re-arms; a busy TV drops the skip silently', () => {
  const p = panel(playing);
  p.tap('skip', 30);
  p.tap('mute');
  const first = p.effects('timer').filter(t => t.name === 'skip')[0];
  p.send({t: 'timer', name: 'skip', ticket: first.ticket});
  assert.equal(p.posts('seek').length, 0);
  const again = p.effects('timer').filter(t => t.name === 'skip').pop();
  assert.notEqual(again.ticket, first.ticket);
  p.reply(p.posted('mute'));
  p.status({...playing, muted: true});
  p.send({t: 'timer', name: 'skip', ticket: again.ticket});
  assert.equal(p.posts('seek').length, 1);
  const q = panel(playing);
  q.tap('skip', 30);
  q.fire('poll');
  q.status({...playing, phase: 'buffering', pending: true});
  q.send({t: 'timer', name: 'skip', ticket: q.effects('timer').filter(t => t.name === 'skip').pop().ticket});
  assert.equal(q.posts().length, 0);
  assert.equal(q.view.mando.badge, null);
});

test('exact time validates inline, sends nothing when invalid, and applies directly when valid', () => {
  const p = panel(playing);
  p.tap('openMore');
  p.tap('gotoTime', '9:99');
  assert.match(p.view.sheet.exact.error, /m:ss o h:mm:ss, hasta 8:20/);
  p.tap('gotoTime', '10:00');
  assert.equal(p.posts().length, 0, 'beyond the duration');
  p.tap('exactInput', '1:05');
  assert.equal(p.view.sheet.exact.error, '', 'typing clears the message');
  p.tap('gotoTime', '1:05');
  assert.equal(p.posted('seek').body.position, 65);
  assert.equal(p.view.sheet, null, 'the sheet closes: there is no review step');
});

test('times read as m:ss or h:mm:ss and the exact field takes only those forms', () => {
  const p = panel({...paused, duration: 7200, absolute_time: 3665});
  assert.deepEqual([p.view.mando.track.elapsed, p.view.mando.track.total], ['1:01:05', '2:00:00']);
  assert.equal(panel({...paused, absolute_time: null}).view.mando.track.elapsed, '—');
  p.tap('openMore');
  for (const text of ['90', '-1:00', '1:60:00', 'a:b', '1:2:3:4']) {
    p.tap('gotoTime', text);
    assert.match(p.view.sheet.exact.error, /m:ss o h:mm:ss/, text);
  }
  assert.equal(p.posts().length, 0);
  p.tap('gotoTime', '1:02:03');
  assert.equal(p.posted('seek').body.position, 3723);
  const q = panel(paused);
  q.tap('openMore');
  q.tap('gotoTime', '02:30');
  assert.equal(q.posted('seek').body.position, 150);
});

test('volume previews while dragging and sends one level on release; mute sends the opposite', () => {
  const p = panel(playing);
  p.tap('volumePreview', 80);
  assert.equal(p.view.mando.volume.text, '80%');
  assert.equal(p.posts().length, 0);
  p.tap('volume', 80);
  assert.deepEqual(p.posted('volume').body, {device_id: 'tv-a', device_revision: 1, level: 0.8});
  assert.equal(p.view.mando.volume.percent, 80, 'the slider does not jump back before the confirming poll');
  p.settle('volume', {...playing, volume: .8});
  assert.equal(p.view.mando.volume.percent, 80);
  p.tap('mute');
  assert.deepEqual(p.posted('mute').body, {device_id: 'tv-a', device_revision: 1, muted: true});
  assert.equal(panel({...playing, volume: null, muted: null}).view.mando.volume.enabled, false, 'volume is null until the TV reports it');
});

test('the clock interpolates while playing, capped 2 s past the last status; the guards use the raw status', () => {
  const p = panel({...playing, absolute_time: 100});
  p.send({t: 'timer', name: 'clock', ticket: 0, at: 1500});
  assert.equal(p.view.mando.board.clock, '1:41', 'a second and a half after the status');
  p.send({t: 'timer', name: 'clock', ticket: 0, at: 60000});
  assert.equal(p.view.mando.board.clock, '1:42', 'a stalled poll never invents more than 2 s');
  const q = panel({...paused, absolute_time: 100});
  q.send({t: 'timer', name: 'clock', ticket: 0, at: 1000});
  assert.equal(q.view.mando.board.clock, '1:40', 'paused does not tick');
});

// captions

test('the caption draft rounds to 0,1 s, clamps at ±30 s, resets and is dirty only while it differs', () => {
  const p = panel({...playing, ...withTracks});
  p.tap('openSubs');
  assert.equal(p.view.sheet.unapplied, false);
  p.tap('capNudge', 100); p.tap('capNudge', 100);
  assert.deepEqual([p.view.sheet.delay.text, p.view.sheet.delay.meaning, p.view.sheet.unapplied, p.view.mando.chip.unapplied], ['+0,2 s', 'Aparecen 0,2 s después que la voz', true, true]);
  p.tap('capNudge', -330);
  assert.equal(p.view.sheet.delay.text, '−0,1 s', 'every value is a multiple of 0,1 s');
  p.tap('capReset');
  assert.equal(p.view.sheet.unapplied, false, 'back to the TV\'s value is no draft');
  for (let i = 0; i < 40; i++) p.tap('capNudge', 1000);
  assert.equal(p.view.sheet.delay.text, '+30,0 s');
  p.tap('capNudge', -1000);
  p.tap('capNudge', -60000);
  assert.equal(p.view.sheet.delay.text, '−30,0 s');
  p.tap('capNudge', NaN);
  assert.equal(p.view.sheet.delay.text, '−30,0 s');
});

test('choosing no track zeroes the delay and a track the TV cannot play is refused', () => {
  const p = panel({...playing, subtitle_delay_ms: 500, ...withTracks});
  p.tap('openSubs');
  p.tap('capTrack', 'image-a');
  assert.equal(p.view.sheet.unapplied, false);
  assert.deepEqual(p.view.sheet.tracks.map(t => [t.id, t.selected]), [['', false], ['text-a', true], ['text2-a', false]], 'image tracks are not offered');
  p.tap('capTrack', '');
  assert.deepEqual([p.view.sheet.delay.text, p.view.sheet.steps.enabled, p.view.sheet.unapplied], ['+0,0 s', false, true]);
  p.tap('capTrack', 'text2-a');
  assert.deepEqual([p.view.sheet.delay.text, p.view.sheet.steps.enabled], ['+0,0 s', true]);
});

test('Aplicar waits for a fresh poll, posts the draft, and settles only on readback', () => {
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capTrack', 'text2-a');
  p.tap('capNudge', 400);
  p.tap('capApply');
  assert.equal(p.posts('subtitles').length, 0, 'nothing is sent from the click');
  assert.equal(p.view.sheet.apply.pending, true);
  p.status(subsOk('text-a', 0));
  const post = p.posted('subtitles');
  assert.deepEqual(post.body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a', catalogue_id: 'cat-a', subtitle_id: 'text2-a', enabled: true, delay_ms: 400});
  p.reply(post);
  p.status({...subsOk('text-a', 0), phase: 'loading', pending: true});
  assert.equal(p.view.sheet.apply.pending, true, 'the TV is still reloading');
  p.fire('poll');
  p.status(subsOk('text-a', 0));
  assert.equal(p.view.sheet.apply.pending, true, 'the old values are not the readback');
  p.fire('poll');
  p.status(subsOk('text2-a', 400));
  assert.equal(p.view.sheet, null, 'settled: the sheet closes');
  assert.equal(p.view.mando.chip.unapplied, false);
  assert.match(p.view.mando.chip.label, /\+0,4 s/);
});

test('a delay-only apply keeps the visibility the TV has, a new track shows itself', () => {
  const hidden = {...subsOk('text-a', 0, false), ...withTracks};
  const p = panel(hidden);
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.status(hidden);
  assert.deepEqual([p.posted('subtitles').body.enabled, p.posted('subtitles').body.delay_ms], [false, 300]);
  const q = panel(hidden);
  q.tap('openSubs');
  q.tap('capTrack', 'text2-a');
  q.tap('capApply');
  q.status(hidden);
  assert.equal(q.posted('subtitles').body.enabled, true);
  const r = panel(hidden);
  r.tap('openSubs');
  r.tap('capTrack', '');
  r.tap('capApply');
  r.status(hidden);
  assert.deepEqual([r.posted('subtitles').body.subtitle_id, r.posted('subtitles').body.enabled, r.posted('subtitles').body.delay_ms], [null, false, 0]);
});

test('the visibility toggle applies at once and sends the server track and delay, never the draft', () => {
  const p = panel({...subsOk('text-a', 200), ...withTracks});
  p.tap('openSubs');
  p.tap('capTrack', 'text2-a');
  p.tap('capNudge', 700);
  p.tap('capVisible', false);
  assert.equal(p.view.sheet.visible.checked, false, 'the switch shows what was asked while it settles');
  p.status(subsOk('text-a', 200));
  assert.deepEqual(p.posted('subtitles').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a', catalogue_id: 'cat-a', subtitle_id: 'text-a', enabled: false, delay_ms: 200});
  p.reply(p.posted('subtitles'));
  p.status(subsOk('text-a', 200, false));
  assert.equal(p.view.sheet.visible.checked, false);
  assert.equal(p.view.sheet.unapplied, true, 'the draft survived the toggle');
  assert.equal(p.view.sheet.delay.text, '+0,9 s');
  assert.notEqual(p.view.sheet, null, 'a visibility change does not close the sheet');
});

test('the visibility toggle does nothing when the TV already shows that, or when there is no track', () => {
  const p = panel(subsOk('text-a', 0));
  p.tap('openSubs');
  p.tap('capVisible', true);
  assert.equal(p.polls(), 0);
  const q = panel({...playing, subtitle_choice: undefined});
  q.tap('capVisible', true);
  assert.equal(q.polls(), 0, 'no track, nothing to show');
  assert.equal(q.view.mando.chip.label, 'Sin subtítulos');
});

test('captions are refused while busy, foreign or offline and while an apply is in flight', () => {
  const edits = [{...playing, command_pending: true}, {...playing, phase: 'loading', pending: true}, {...playing, phase: 'disconnected'}];
  for (const status of edits) {
    const p = panel(status);
    p.tap('openSubs');
    p.tap('capNudge', 100);
    assert.equal(p.view.sheet?.unapplied ?? false, false, status.phase);
  }
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 100);
  p.tap('capApply');
  p.tap('capNudge', 100);
  p.tap('capVisible', false);
  p.tap('capApply');
  assert.equal(p.view.sheet.delay.text, '+0,1 s', 'the draft is frozen while it is being applied');
  assert.equal(p.view.sheet.apply.enabled, false);
  assert.equal(p.view.sheet.visible.enabled, false);
  assert.equal(p.polls(), 1);
});

test('an Aplicar or a visibility toggle that finds the TV busy says so, sends nothing and keeps the draft', () => {
  const busy = {...subsOk('text-a', 0), ...withTracks, command_pending: true};
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.status(busy);
  assert.equal(p.posts('subtitles').length, 0);
  assert.match(p.view.problem.body, /ocupada/);
  assert.equal(p.view.sheet.unapplied, true, 'the draft survives');
  p.fire('poll');
  p.status({...subsOk('text-a', 0), ...withTracks});
  assert.equal(p.view.sheet.unapplied, true);
  assert.equal(p.view.sheet.apply.enabled, true, 'and can be applied again once the TV is free');
  const q = panel({...subsOk('text-a', 0), ...withTracks});
  q.tap('openSubs');
  q.tap('capVisible', false);
  q.status(busy);
  assert.equal(q.posts('subtitles').length, 0);
  assert.match(q.view.problem.body, /ocupada/);
  assert.equal(q.view.sheet.visible.checked, true, 'the switch goes back to what the TV shows');
});

test('a partial failure names the visibility change and keeps the draft', () => {
  const p = panel({...subsOk('text-a', 0, false), ...withTracks});
  p.tap('openSubs');
  p.tap('capTrack', 'text2-a');
  p.tap('capApply');
  p.status(subsOk('text-a', 0, false));
  p.reply(p.posted('subtitles'), {ok: false, message: 'La TV rechazó el cambio.'});
  p.status(subsOk('text-a', 0, true));
  assert.equal(p.view.sheet.apply.pending, false);
  assert.equal(p.view.sheet.unapplied, true, 'the draft is kept for a retry');
  assert.equal(p.view.sheet.apply.enabled, true);
});

test('a playback change drops the apply and the draft silently', () => {
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.status({...subsOk('text-a', 0), playback_id: 'play-b'});
  assert.equal(p.posts('subtitles').length, 0, 'nothing is sent for the old playback');
  assert.equal(p.view.sheet, null, 'the subtitle sheet cannot outlive the playback it edits');
  assert.equal(p.view.mando.chip.unapplied, false);
});

test('an apply interrupted by another sender or a lost TV fails loudly and keeps the draft', () => {
  for (const phase of ['receiver_changed', 'disconnected']) {
    const p = panel({...subsOk('text-a', 0), ...withTracks});
    p.tap('openSubs');
    p.tap('capNudge', 300);
    p.tap('capApply');
    p.status({...subsOk('text-a', 0), phase});
    assert.equal(p.view.mando.chip.unapplied, true, phase);
    assert.equal(p.posts('subtitles').length, 0, phase);
  }
});

test('an apply that the TV never confirms ends instead of hanging the sheet', () => {
  const p = panel(subsOk('text-a', 0));
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.status(subsOk('text-a', 0));
  p.reply(p.posted('subtitles'));
  p.status(subsOk('text-a', 0));
  for (let i = 0; i < 8 && p.view.sheet.apply.pending; i++) { p.fire('poll'); p.status(subsOk('text-a', 0)); }
  assert.equal(p.view.sheet.apply.pending, false);
  assert.equal(p.view.sheet.unapplied, true);
});

test('a later command voids an apply that was waiting for its verification poll', () => {
  const p = panel(subsOk('text-a', 0));
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.tap('mute');
  p.status({...subsOk('text-a', 0)});
  assert.equal(p.posts('subtitles').length, 0);
});

// stop

test('confirmed stop re-polls, re-checks the TV and the playback, and sends the captured playback_id', () => {
  const p = panel(playing);
  p.tap('stop');
  assert.equal(p.posts().length + p.polls(), 0, 'playing asks first');
  assert.equal(p.view.confirm.kind, 'stop');
  p.tap('confirmAccept');
  assert.equal(p.posts().length, 0, 'accepting waits for fresh status');
  p.status(playing);
  assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'});
});

test('stop consent is void for a different playback, TV or revision', () => {
  const swaps = {playback: {playback_id: 'play-b'}, device: {selected_device: {...destination.selected_device, id: 'tv-b'}}, revision: {device_revision: 2}};
  for (const [name, change] of Object.entries(swaps)) {
    const p = panel(playing);
    p.tap('stop');
    p.tap('confirmAccept');
    p.status({...playing, ...change});
    assert.equal(p.posts('stop').length, 0, name);
  }
});

test('a confirmed Detener survives a failed poll and stops once the link returns', () => {
  const p = panel(playing);
  p.tap('stop');
  p.tap('confirmAccept');
  p.status(null, false);
  assert.equal(p.posts('stop').length, 0, 'nothing can be sent offline');
  p.fire('poll');
  p.status(playing);
  assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'});
});

test('a confirmed Detener holds the remote: nothing else goes out before or beside it', () => {
  const p = panel(playing);
  p.tap('stop');
  p.tap('confirmAccept');
  const m = p.view.mando;
  assert.deepEqual([m.toggle.enabled, m.back.enabled, m.track.enabled, m.volume.enabled, m.mute.enabled, m.change.enabled], new Array(6).fill(false));
  for (const [act, arg] of [['toggle'], ['skip', 30], ['dropSeek', 200], ['volume', 80], ['mute'], ['openChange']]) p.tap(act, arg);
  assert.equal(p.view.sheet, null, 'Cambiar película does not open while the stop waits');
  p.status(playing);
  assert.deepEqual(p.posts().map(f => f.action), ['stop']);
});

test('a confirmed Detener and a Start are never both sent: the Start is refused while the stop waits', () => {
  const p = panel(playing);
  p.tap('openChange');
  choose(p, 'b');
  p.tap('stop');
  p.tap('confirmAccept');
  assert.equal(p.view.plan.primary.enabled, false);
  p.tap('start');
  p.tap('confirmAccept');
  p.status(playing);
  assert.deepEqual(p.posts().map(f => f.action), ['stop']);
  assert.equal(p.view.sheet, null, 'the stop closes the sheet when it goes out');
});

test('Detener reads Deteniendo… and stays disabled from the confirm until the stop settles', () => {
  const stopping = v => [v.mando.stop.enabled, v.mando.stop.label];
  const p = panel(playing);
  assert.deepEqual(stopping(p.view), [true, 'Detener']);
  p.tap('stop');
  p.tap('confirmAccept');
  assert.deepEqual(stopping(p.view), [false, 'Deteniendo…']);
  p.tap('stop');
  assert.equal(p.view.confirm, null, 'pressing again does not ask again or replace the confirmed stop');
  p.status(playing);
  assert.equal(p.posts('stop').length, 1);
  assert.deepEqual(stopping(p.view), [false, 'Deteniendo…'], 'still stopping while the stop is in flight');
  p.tap('stop');
  assert.equal(p.posts('stop').length, 1);
  p.settle('stop', paused, {ok: false, code: 'busy', message: 'Ocupado.'});
  assert.deepEqual(stopping(p.view), [true, 'Detener'], 'a failed stop gives Detener back');
});

test('every Detener says Deteniendo… while a stop is in flight', () => {
  const waiting = panel({...playing, phase: 'loading', pending: true});
  waiting.tap('stop');
  const w = waiting.view;
  assert.deepEqual([w.mando.waiting.cancel.enabled, w.mando.waiting.cancel.label], [false, 'Deteniendo…']);
  assert.deepEqual([w.destination.stop.enabled, w.destination.stop.label], [false, 'Deteniendo…']);
  const foreign = panel({...playing, phase: 'receiver_changed'});
  foreign.tap('stop');
  assert.deepEqual([foreign.view.problem.action.enabled, foreign.view.problem.action.label], [false, 'Deteniendo…']);
  const more = panel({...playing, phase: 'loading', pending: true});
  more.tap('openMore');
  more.tap('stop');
  assert.equal(more.view.sheet, null, 'the stop closes the sheet');
  const busy = panel(playing);
  busy.tap('toggle');
  busy.tap('openMore');
  busy.tap('stop');
  busy.tap('openMore');
  assert.deepEqual([busy.view.sheet.stop.enabled, busy.view.sheet.stop.label], [false, 'Deteniendo…']);
});

test('a Start waiting for its fresh poll survives a failed poll and starts once the link returns', () => {
  const p = panel(idle);
  choose(p);
  p.tap('start');
  p.status(null, false);
  assert.equal(p.posts('start').length, 0);
  assert.equal(p.view.plan.primary.label, 'Iniciando…');
  p.fire('poll');
  p.status(idle);
  assert.equal(p.posted('start').body.source_id, 'a');
});

test('the stop confirm survives a failed poll, like the replace confirm, and still stops once the link returns', () => {
  const p = panel(playing);
  p.tap('stop');
  offline(p);
  assert.equal(p.view.confirm?.kind, 'stop', 'a blip does not take the question away');
  p.fire('poll');
  p.status(playing);
  assert.equal(p.view.confirm?.kind, 'stop');
  p.tap('confirmAccept');
  p.status(playing);
  assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'});
});

test('stop with Seguir viendo or Escape sends nothing', () => {
  const p = panel(playing);
  p.tap('stop');
  p.tap('dismiss');
  assert.equal(p.view.confirm, null);
  assert.equal(p.posts().length + p.polls(), 0);
});

test('preparation, a foreign receiver and an error stop at once with device and playback identity', () => {
  for (const status of [{...playing, phase: 'loading', pending: true}, {...playing, phase: 'receiver_changed'}, {...playing, phase: 'disconnected'}, {...playing, phase: 'buffering', pending: true}]) {
    const p = panel(status);
    p.tap('stop');
    assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'}, status.phase);
  }
});

test('with no selected TV the stop body carries no device fields at all', () => {
  const p = panel({...playing, phase: 'disconnected', selected_device: null});
  p.tap('stop');
  assert.deepEqual(p.posted('stop').body, {playback_id: 'play-a'});
  const q = panel({...idle, phase: 'error', can_change_device: false, selected_device: null});
  q.tap('stop');
  assert.deepEqual(q.posted('stop').body, {});
});

test('stop interrupts an in-flight command and its late reply cannot overwrite cleanup', () => {
  const p = panel(playing);
  p.fire('poll');
  const stale = p.effects('poll')[0];
  p.tap('toggle');
  const pause = p.posted('pause');
  p.send({t: 'status', gen: stale.gen, seq: stale.seq, ok: true, raw: fixture({...playing, phase: 'loading', pending: true})});
  p.pending.splice(p.pending.indexOf(stale), 1);
  assert.equal(p.view.mando.board.state, 'REPRODUCIENDO');
  p.tap('stop');
  assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'}, 'busy: immediate, no confirm, and the bridge still sees which playback to stop');
  p.reply(pause);
  assert.equal(p.posts('pause').length + p.posts('resume').length, 0);
  p.reply(p.posted('stop'));
  p.status({...idle, phase: 'stopped', title: 'Alpha', source_id: 'a'});
  assert.equal(p.view.mode, 'preparar');
});

test('a stop that joins an in-flight command still reports that command and settles it', () => {
  for (const [act, arg, action] of [['volume', 80, 'volume'], ['toggle', undefined, 'pause'], ['mute', undefined, 'mute'], ['dropSeek', 200, 'seek']]) {
    const p = panel(playing);
    p.tap(act, arg);
    p.tap('stop');
    assert.equal(p.posts('stop').length, 1, `${action}: our own command in flight, so the stop goes at once`);
    p.reply(p.posted(action), {ok: false, message: 'La TV rechazó el cambio.'});
    assert.equal(p.view.problem?.body, 'La TV rechazó el cambio.', action);
  }
  const q = panel(playing);
  q.tap('volumePreview', 80);
  q.tap('volume', 80);
  q.tap('stop');
  q.reply(q.posted('volume'));
  q.reply(q.posted('stop'));
  q.status(playing);
  assert.equal(q.view.mando.volume.percent, 30, 'the preview gives way to what the TV reports');
});

test('focus goes back only when the command that asked for it settles', () => {
  const p = panel(playing);
  p.tap('toggle', undefined, 'toggle', 1);
  p.tap('stop', undefined, 'stop', 1);
  p.reply(p.posted('pause'));
  p.status(playing);
  assert.equal(p.effects('focus').length, 0, 'the pause settled, the stop that took the focus has not');
  p.settle('stop', paused);
  assert.deepEqual(p.effects('focus').map(f => f.ref), ['stop']);
});

test('stopping drops a pending apply, seek and Start along with the open sheet', () => {
  const p = panel({...subsOk('text-a', 0), ...withTracks});
  p.tap('openSubs');
  p.tap('capNudge', 300);
  p.tap('capApply');
  p.tap('stop');
  p.tap('confirmAccept');
  p.status(subsOk('text-a', 0));
  p.status(subsOk('text-a', 0));
  assert.equal(p.posts('subtitles').length, 0, 'stop wins over the apply waiting for the same poll');
  assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'});
  assert.equal(p.view.sheet, null);
  assert.equal(p.view.mando.chip.unapplied, true, 'the draft is not the stop\'s business');
});

test('receiver_changed and disconnected leave only Detener', () => {
  for (const phase of ['receiver_changed', 'disconnected']) {
    const p = panel({...playing, phase});
    const m = p.view.mando;
    assert.deepEqual([m.toggle.enabled, m.back.enabled, m.forward.enabled, m.track.enabled, m.volume.enabled, m.mute.enabled, m.chip.enabled, m.change.enabled], new Array(8).fill(false), phase);
    assert.equal(m.stop.enabled, true, phase);
    p.tap('openChange');
    p.tap('openSubs');
    assert.equal(p.view.sheet, null, phase);
    assert.equal(p.view.plan.primary.enabled, false, phase);
  }
});

test('an unknown phase fails closed: nothing is startable and only Detener works', () => {
  const p = panel({...playing, phase: 'warp-drive'});
  assert.equal(p.view.mode, 'mando');
  assert.equal(p.view.mando.toggle.enabled, false);
  assert.equal(p.view.mando.stop.enabled, true);
  assert.equal(p.view.plan.primary.enabled, false);
  p.tap('stop');
  assert.ok(p.posted('stop'));
});

test('offline keeps the board, marks it unconfirmed and disables every unsafe action', () => {
  const p = panel(playing);
  offline(p);
  const m = p.view.mando;
  assert.equal(m.board.title, 'Alpha');
  assert.equal(m.board.state, 'SIN CONFIRMAR');
  assert.deepEqual([m.toggle.enabled, m.track.enabled, m.volume.enabled, m.chip.enabled, m.stop.enabled], [false, false, false, false, false]);
  p.tap('toggle');
  p.tap('stop');
  assert.equal(p.posts().length, 0);
  p.fire('poll');
  p.status(playing);
  assert.equal(p.view.mando.toggle.enabled, true, 'back online, back in control');
});

test('the board glyph follows the phase, not the copy: play, pause, spinner while waiting, none otherwise or when unconfirmed', () => {
  const glyph = status => panel(status).view.mando.board.glyph;
  assert.equal(glyph(playing), 'play');
  assert.equal(glyph({...playing, phase: 'paused'}), 'pause');
  for (const phase of ['preparing', 'buffering', 'loading']) assert.equal(glyph({...playing, phase, pending: true}), 'spinner', phase);
  for (const phase of ['receiver_changed', 'disconnected']) assert.equal(glyph({...playing, phase}), null, phase);
  assert.equal(glyph({...playing, phase: 'error', can_change_device: false}), null);
  const p = panel(playing);
  offline(p);
  assert.equal(p.view.mando.board.glyph, null, 'a state we cannot confirm shows no glyph');
});

test('one Detener at a time: a problem block that offers it takes the header\'s place, in Mando and in the Más sheet', () => {
  const header = status => panel(status).view.mando.stop;
  assert.deepEqual(header(playing), {enabled: true, shown: true, label: 'Detener'});
  const error = {...playing, phase: 'error', can_change_device: false, message: 'Falló'};
  for (const status of [error, {...playing, phase: 'receiver_changed'}, {...playing, phase: 'disconnected'}, {...playing, phase: 'wat'}]) {
    const v = panel(status).view;
    assert.equal(v.problem.action.act, 'stop', status.phase);
    assert.equal(v.mando.stop.shown, false, `${status.phase}: the problem block already offers Detener`);
    assert.equal(v.mando.stop.enabled, v.problem.action.enabled);
  }
  const notice = panel({...playing, action_error: 'Algo.', action_error_revision: 1}).view;
  assert.equal(notice.problem.action.act, 'dismissNotice');
  assert.equal(notice.mando.stop.shown, true, 'a notice has no Detener, so the header keeps its own');
  const p = panel(error);
  p.tap('openMore');
  assert.equal(p.view.sheet.stop.shown, false, 'the sheet shows the problem block with Detener, not a second one');
  const q = panel(playing);
  q.tap('openMore');
  assert.equal(q.view.sheet.stop.shown, true);
});

test('waiting has shape: a spinner in the key, the TV by name and Cancelar, which is stop', () => {
  for (const phase of ['preparing', 'buffering', 'loading']) {
    const p = panel({...playing, phase, pending: true, message: null});
    const m = p.view.mando;
    assert.deepEqual([m.toggle.icon, m.toggle.enabled, m.waiting.text, m.waiting.cancel.enabled], ['spinner', false, 'Esperando a Sala · Chromecast', true], phase);
    p.tap('toggle');
    assert.equal(p.posts('resume').length + p.posts('pause').length, 0);
    p.tap('stop');
    assert.deepEqual(p.posted('stop').body, {device_id: 'tv-a', device_revision: 1, playback_id: 'play-a'}, phase);
  }
  assert.equal(panel(playing).view.mando.waiting, null);
});

test('a command racing the TV\'s own busy state is refused locally, as the real bridge would with a 409', () => {
  const p = panel({...playing, command_pending: true});
  p.tap('toggle');
  p.tap('skip', 30);
  p.tap('mute');
  assert.equal(p.posts().length + p.effects('timer').filter(t => t.name === 'skip').length, 0);
  assert.equal(p.view.mando.toggle.icon, 'spinner');
});

test('the remote stays keyed to one playback: a new playback starts with idle seek and no draft', () => {
  const p = panel(playing);
  p.tap('dragSeek', 200);
  p.tap('skip', 30);
  p.fire('poll');
  p.status({...playing, playback_id: 'play-b'});
  assert.equal(p.view.mando.badge, null);
  assert.equal(p.view.mando.track.preview, null);
});
