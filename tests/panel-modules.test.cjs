const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {PANEL_FILES} = require('./helpers/panel-source.cjs');
const {dependsOn, codeOnly, crossings, read} = require('./helpers/panel-modules.cjs');
const {fixture, playing} = require('./helpers/panel-harness.cjs');

const GLOBALS = {TextDecoder, AbortController};
const files = read(PANEL_FILES);
const source = name => files.find(f => f.name === name).src;

test('each panel file names only what its declared dependencies declare, and those load before it', () => {
  assert.deepEqual(crossings(files, GLOBALS).out, []);
});

test('the check catches a core that reaches into the addon', () => {
  const planted = files.map(f => f.name === 'panel-core.js' ? {...f, src: `${f.src}\nfunction leak(cat) { return addonKey(cat); }\n`} : f);
  assert.deepEqual(crossings(planted, GLOBALS).out, ['panel-core.js names addonKey from panel-addon.js']);
});

test('the lexer rejects an unterminated literal instead of scanning forever', () => {
  const lex = src => vm.runInNewContext('codeOnly(src)', {codeOnly, src}, {timeout: 1000});
  for (const [src, at] of [["const r = /'/; const x = 1;", 11], ['/* open', 0], ["x = 'open", 4], ['x = `a ${b', 4]]) {
    assert.throws(() => lex(src), {message: `unterminated literal at ${at}`}, src);
  }
  assert.equal(lex("a('b', `c${d}e`) /* f */ // g"), 'a( ,    d   )   ');
});

function withDependencies(name) {
  const need = new Set([name]);
  for (let grew = true; grew;) {
    grew = false;
    for (const n of [...need]) for (const d of dependsOn(source(n))) if (!need.has(d)) { need.add(d); grew = true; }
  }
  return PANEL_FILES.filter(f => need.has(f));
}

const OVER_A_STATUS = 'const m = freshModel(null), fx = []; linkRequestPoll(m, fx); linkOnStatus(m, fx, {gen: fx[0].gen, seq: fx[0].seq, ok: true, raw, at: 0});';
const PROBES = {
  'panel-core.js': `${OVER_A_STATUS} caps(m).transport`,
  'panel-addon.js': `${OVER_A_STATUS} addonReconcile(m, fx, 'remote'); addonCtx(m, 'remote').catalogue.id === 'cat-a'`,
  'panel-view.js': `${OVER_A_STATUS} view(m).mando.board.state === 'REPRODUCIENDO'`,
  'panel.js': `{ const {model, fx} = Panel.init(); Panel.step(model, {t: 'status', gen: fx[0].gen, seq: fx[0].seq, ok: true, raw}); Panel.view(model).mode === 'mando'; }`,
  'panel-shell.js': `typeof module.exports.boot === 'function' && module.exports.Panel === Panel`,
};

test('each panel file loads with only what it depends on and runs over a playing status', () => {
  for (const name of PANEL_FILES) {
    assert.ok(PROBES[name], `${name} needs a probe here`);
    const context = vm.createContext({module: {exports: {}}, raw: fixture(playing), ...GLOBALS});
    for (const f of withDependencies(name)) vm.runInContext(source(f), context, {filename: f});
    assert.equal(vm.runInContext(PROBES[name], context), true, name);
  }
});
