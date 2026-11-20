const fs = require('node:fs');
const vm = require('node:vm');

/** The panel scripts in the order bridge.py inlines them, read from bridge.py so the two lists cannot drift. */
const PANEL_FILES = [...fs.readFileSync('bridge.py', 'utf8').match(/^PANEL_SCRIPTS = \(([^)]*)\)/m)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
const PANEL_SOURCE = PANEL_FILES.map(name => fs.readFileSync(name, 'utf8')).join('\n');

const loadPanel = globals => {
  const context = {module: {exports: {}}, ...globals};
  vm.runInNewContext(PANEL_SOURCE, context);
  return context.module.exports;
};

module.exports = {PANEL_FILES, PANEL_SOURCE, loadPanel};
