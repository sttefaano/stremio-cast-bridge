const {test} = require('node:test');
const assert = require('node:assert/strict');
const {panel, catalogue, idle, choose, startNow, withCatalogue, names, srt, addonReady, offers, stremioPlan, liveAddon, liveStatus, liveEntry} = require('./helpers/panel-harness.cjs');

// Stremio in the plan

test('Stremio: the offers are pulled once the branch shows, languages and versions come from the listing', () => {
  const p = stremioPlan();
  const pull = p.posted('subtitle_offers');
  assert.deepEqual(pull.body, {source_id: 'a', catalogue_id: 'cat-a'});
  assert.equal(p.view.plan.subsStatus, 'Buscando subtítulos de Stremio…');
  p.reply(pull, {ok: true, body: offers});
  const v = p.view.plan.stremio;
  assert.equal(v.match, 'Coincidencia: Alpha (2020)');
  assert.deepEqual(v.languages.map(l => [l.id, l.label, l.selected]), [['spa', 'Español · 2', true], ['eng', 'English · 1', false]]);
  assert.deepEqual(names(v.versions), ['Alpha.es.srt · 98%', 'Alpha.es.2.srt']);
  p.tap('stremioLanguage', 'eng');
  assert.deepEqual(names(p.view.plan.stremio.versions), ['Alpha.en.srt']);
});

test('Stremio: Usar este subtítulo downloads once, selects the entry and Start never touches the network for it', () => {
  const p = stremioPlan();
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  p.tap('stremioVersion', 'o-es-2');
  p.tap('stremioUse');
  p.tap('stremioUse');
  const fetch = p.posted('subtitle_fetch');
  assert.equal(p.posts('subtitle_fetch').length, 1);
  assert.deepEqual(fetch.body, {source_id: 'a', catalogue_id: 'cat-a', offer_id: 'o-es-2'});
  assert.equal(p.view.plan.stremio.use.label, 'Descargando…');
  const entry = {id: 'ad-1', kind: 'addon', label: 'Español · Alpha.es.2.srt', language: 'spa', supported: true, reason: null};
  p.reply(fetch, {ok: true, body: {entry, catalogue: catalogue('a', addonReady(), [entry])}});
  assert.match(p.view.plan.subsStatus, /Subtítulo listo: Español/);
  assert.equal(p.view.plan.stub.missing.length, 0);
  assert.equal(startNow(p, withCatalogue(idle, catalogue('a', addonReady(), [entry]))).body.subtitle_id, 'ad-1');
});

test('Stremio: a doubtful match is a question, an unreadable subtitle stays listed and Start is untouched', () => {
  const p = stremioPlan(addonReady(2, {match: {label: 'Alpha (1999)', confidence: 'doubtful'}}));
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  assert.equal(p.view.plan.stremio.match, '¿Es «Alpha (1999)»?');
  p.tap('stremioUse');
  p.reply(p.posted('subtitle_fetch'), {ok: false, code: 'invalid_subtitle', message: 'No se pudo leer ese subtítulo.'});
  assert.match(p.view.plan.stremio.versions[0].label, /no se pudo leer/);
  assert.equal(p.view.plan.subsStatus, 'No se pudo leer ese subtítulo.');
});

test('Stremio: No es esta reveals at most four alternatives and a free search, both feeding one lookup', () => {
  const p = stremioPlan();
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  assert.equal(p.view.plan.stremio.correctionOpen, false);
  p.tap('stremioWrong');
  assert.equal(p.view.plan.stremio.correctionOpen, true);
  assert.deepEqual(names(p.view.plan.stremio.alternatives), ['Alpha Two (2021)', 'Alpha Three']);
  p.tap('stremioAlt', 0);
  assert.deepEqual(p.posted('subtitle_lookup').body, {source_id: 'a', catalogue_id: 'cat-a', hint: 'tt1 Alpha Two 2021'});
  p.reply(p.posted('subtitle_lookup'), {ok: true, body: {catalogue: catalogue('a', addonReady(2, {revision: 2}))}});
  p.tap('stremioSearch', 'x'.repeat(201));
  assert.equal(p.posts('subtitle_lookup').length, 0);
  assert.match(p.view.plan.subsStatus, /hasta 200 caracteres/);
  p.tap('stremioSearch', '  Otra peli 2019 ');
  assert.equal(p.posted('subtitle_lookup').body.hint, 'Otra peli 2019');
});

test('Stremio: an unidentified film opens the correction on its own; error and empty states keep one status line', () => {
  const p = stremioPlan({state: 'unidentified', revision: 1, match: null, message: 'No pudimos identificar la película.', count: 0});
  assert.equal(p.view.plan.stremio.correctionOpen, true);
  assert.equal(p.view.plan.stremio.wrong.shown, false);
  assert.equal(p.view.plan.subsStatus, 'No pudimos identificar la película.');
  const q = stremioPlan({state: 'error', revision: 1, match: null, message: 'Stremio no responde.', count: 0});
  assert.equal(q.view.plan.stremio.retry.shown, true);
  assert.equal(q.view.plan.subsStatus, 'Stremio no responde.');
  assert.equal(q.posts('subtitle_offers').length, 0, 'nothing to list in an error state');
  q.tap('stremioRetry');
  assert.equal(q.posts('subtitle_lookup').length, 1);
  const r = stremioPlan(addonReady(0));
  r.reply(r.posted('subtitle_offers'), {ok: true, body: {...offers, offers: [], count: 0}});
  assert.equal(r.view.plan.subsStatus, 'Stremio no tiene subtítulos para Alpha (2020).');
});

test('Stremio: late downloads cannot select a subtitle for another movie or an abandoned draft', () => {
  const p = stremioPlan();
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  p.tap('stremioUse');
  const fetch = p.posted('subtitle_fetch');
  p.tap('pickSource', 'b');
  const entry = {id: 'ad-1', kind: 'addon', label: 'x', language: 'spa', supported: true, reason: null};
  p.reply(fetch, {ok: true, body: {entry, catalogue: catalogue('a', addonReady(), [entry])}});
  assert.equal(p.view.plan.branches.find(b => b.selected).id, 'none');
  assert.equal(p.posts('start').length, 0);
});

test('Stremio: an older addon revision of the same catalogue never replaces a newer one', () => {
  const p = stremioPlan(addonReady(2, {revision: 3}));
  p.reply(p.posted('subtitle_offers'), {ok: true, body: {...offers, revision: 3}});
  p.tap('stremioWrong');
  p.tap('stremioAlt', 0);
  p.reply(p.posted('subtitle_lookup'), {ok: true, body: {catalogue: catalogue('a', addonReady(2, {revision: 1}))}});
  assert.equal(p.view.plan.stremio.match, 'Coincidencia: Alpha (2020)');
  p.tap('stremioWrong');
  assert.equal(p.view.plan.stremio.languages.length, 2, 'the listing for revision 3 is still the one shown');
});

test('a movie that leaves the list ends the plan and the page falls back to choosing', () => {
  const p = panel(idle);
  choose(p);
  p.tap('subsBranch', 'file');
  p.fire('poll');
  p.status({...idle, sources: [{id: 'b', title: 'Beta'}]});
  assert.equal(p.view.plan.sources.some(r => r.selected), false);
  assert.deepEqual(p.view.plan.stub.missing, ['PELÍCULA']);
});

// the live Stremio picker in the subtitle sheet

test('the live sheet pulls offers for the active catalogue and a downloaded subtitle becomes the draft', () => {
  const p = panel(liveStatus());
  p.tap('openSubs');
  assert.deepEqual(p.posted('subtitle_offers').body, {source_id: 'a', catalogue_id: 'cat-a'});
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  assert.equal(p.view.sheet.stremio.match, 'Coincidencia: Alpha (2020)');
  p.tap('stremioUse');
  p.reply(p.posted('subtitle_fetch'), {ok: true, body: {entry: liveEntry, catalogue: catalogue('a', liveAddon, [liveEntry])}});
  assert.match(p.view.sheet.stremio.status, /Subtítulo listo: Español.*Se usará solo al aplicar/);
  assert.equal(p.view.sheet.unapplied, true);
  assert.ok(p.view.sheet.tracks.some(t => t.id === 'ad-9' && t.selected), 'the entry is in the list and chosen');
  p.tap('capApply');
  p.status(liveStatus());
  assert.equal(p.posted('subtitles').body.subtitle_id, 'ad-9', 'Aplicar sends the downloaded track');
});

test('the live block stays inert while an apply is pending', () => {
  const p = panel(liveStatus());
  p.tap('openSubs');
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  p.tap('capNudge', 300);
  p.tap('capApply');
  assert.equal(p.view.sheet.stremio.use.enabled, false);
  p.tap('stremioUse');
  assert.equal(p.posts('subtitle_fetch').length, 0);
});

test('a download finishing after the playback changed cannot become the draft', () => {
  const p = panel(liveStatus());
  p.tap('openSubs');
  p.reply(p.posted('subtitle_offers'), {ok: true, body: offers});
  p.tap('stremioUse');
  const fetch = p.posted('subtitle_fetch');
  p.fire('poll');
  p.status({...liveStatus(), playback_id: 'play-b'});
  p.reply(fetch, {ok: true, body: {entry: liveEntry, catalogue: catalogue('a', liveAddon, [liveEntry])}});
  assert.equal(p.view.mando.chip.unapplied, false);
});

test('a late lookup receipt with an older addon revision cannot roll the live sheet back', () => {
  const p = panel(liveStatus({addons: {a: addonReady(2, {revision: 3})}}));
  p.tap('openSubs');
  p.reply(p.posted('subtitle_offers'), {ok: true, body: {...offers, revision: 3}});
  p.tap('stremioWrong');
  p.tap('stremioAlt', 0);
  p.reply(p.posted('subtitle_lookup'), {ok: true, body: {catalogue: catalogue('a', addonReady(2, {revision: 1}))}});
  assert.equal(p.view.sheet.stremio.languages.length, 2);
});
