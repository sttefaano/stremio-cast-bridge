const {test} = require('node:test');
const assert = require('node:assert/strict');
const {load, panel, playing, fixture, offline, paused} = require('./helpers/panel-harness.cjs');

test('timestamps parse and format like player conventions', () => {
  const {Panel} = load();
  assert.equal(Panel.formatTime(3665), '1:01:05');
  assert.equal(Panel.formatTime(NaN), '—');
  assert.equal(Panel.parseTime('1:02:03'), 3723);
  assert.equal(Panel.parseTime('02:30'), 150);
  for (const value of ['90', '-1:00', '1:60:00', 'a:b', '1:2:3:4']) assert.equal(Panel.parseTime(value), null);
});

test('one poll in flight; the timer re-arms after each reply and ignores a superseded timer', () => {
  const p = panel(null);
  assert.equal(p.polls(), 1);
  p.status(playing);
  assert.equal(p.polls(), 0);
  assert.equal(p.effects('timer').filter(t => t.name === 'poll').length, 1);
  p.fire('poll');
  assert.equal(p.polls(), 1);
  p.status(playing, false);
  assert.equal(p.polls(), 0);
  assert.equal(p.effects('timer').filter(t => t.name === 'poll').length, 1, 'offline polling continues');
});

test('stale polls are fenced after a command and no phase is invented', () => {
  const p = panel(playing);
  p.fire('poll');
  const stale = p.effects('poll')[0];
  p.tap('toggle');
  const pause = p.posted('pause');
  assert.ok(pause);
  assert.equal(p.view.mando.board.state, 'REPRODUCIENDO', 'a command never commits its phase optimistically');
  p.send({t: 'status', gen: stale.gen, seq: stale.seq, ok: true, raw: fixture({...playing, phase: 'preparing', pending: true})});
  p.pending.splice(p.pending.indexOf(stale), 1);
  assert.equal(p.view.mando.board.state, 'REPRODUCIENDO', 'the poll issued before the command is dropped');
  p.settle('pause', {...playing, phase: 'paused'});
  assert.equal(p.view.mando.board.state, 'EN PAUSA');
});

test('a second command is ignored while one is in flight', () => {
  const p = panel(playing);
  p.tap('toggle');
  p.tap('toggle');
  assert.equal(p.posts().length, 1);
  p.reply(p.posted('pause'));
  p.tap('toggle');
  assert.equal(p.posts().length, 0, 'still busy until the confirming poll is applied');
  p.status({...playing, phase: 'paused'});
  p.tap('toggle');
  assert.equal(p.posts('resume').length, 1);
});

test('every playback post carries the device identity, including a zero revision', () => {
  const p = panel({...playing, device_revision: 0});
  p.tap('toggle');
  assert.deepEqual(p.posted('pause').body, {device_id: 'tv-a', device_revision: 0});
});
