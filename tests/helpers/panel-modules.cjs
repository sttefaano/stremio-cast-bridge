const fs = require('node:fs');
const vm = require('node:vm');

/** The files a panel file says it depends on, from its `// Depends on: a.js, b.js.` line. */
function dependsOn(src) {
  const line = src.match(/^\/\/ Depends on: (.+)\.$/m);
  if (!line) throw new Error('missing "// Depends on:" line');
  return line[1] === 'none' ? [] : line[1].split(/,\s*/);
}

/** The source with strings, templates and comments blanked. Throws on a literal it cannot close, such as a quote inside a regex. */
function codeOnly(src) {
  let out = '';
  const nest = [];
  const unterminated = at => new Error(`unterminated literal at ${at}`);
  for (let i = 0; i < src.length;) {
    const c = src[i], d = src[i + 1], top = nest[nest.length - 1]?.kind;
    if (top === 'text') {
      if (c === '\\') i += 2;
      else if (c === '`') { nest.pop(); i++; }
      else if (c === '$' && d === '{') { nest.push({kind: 'expr', at: i}); i += 2; }
      else { out += c === '\n' ? '\n' : ' '; i++; continue; }
      out += ' ';
    } else if (c === '/' && d === '/') i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
    else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw unterminated(i);
      i = end + 2;
      out += ' ';
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (; src[j] !== c; j += src[j] === '\\' ? 2 : 1) if (j >= src.length || src[j] === '\n') throw unterminated(i);
      i = j + 1;
      out += ' ';
    } else if (c === '`') { nest.push({kind: 'text', at: i}); i++; out += ' '; }
    else if (c === '}' && top === 'expr') { nest.pop(); i++; out += ' '; }
    else {
      if (c === '{' && nest.length) nest.push({kind: 'brace', at: i});
      if (c === '}' && top === 'brace') nest.pop();
      out += c;
      i++;
    }
  }
  if (nest.length) throw unterminated(nest[0].at);
  return out;
}

/** Every identifier the code uses as a name: property accesses and object keys are not names. */
function names(src) {
  const code = codeOnly(src), found = new Set();
  const prev = i => { while (i >= 0 && /\s/.test(code[i])) i--; return i; };
  for (const m of code.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) {
    const b = prev(m.index - 1), after = code.slice(m.index + m[0].length).match(/^\s*(.)/)?.[1];
    if (code[b] === '.' && code[b - 1] !== '.') continue;
    if (after === ':' && (code[b] === '{' || code[b] === ',')) continue;
    found.add(m[0]);
  }
  return found;
}

function crossings(files, globals = {}) {
  const context = vm.createContext({module: {exports: {}}, ...globals});
  const defined = name => { try { return vm.runInContext(`typeof ${name} !== 'undefined'`, context); } catch (_) { return false; } };
  const declares = new Map();
  for (const {name, src} of files) {
    const fresh = [...names(src)].filter(n => !defined(n));
    vm.runInContext(src, context, {filename: name});
    declares.set(name, new Set(fresh.filter(defined)));
  }
  const out = [];
  files.forEach(({name, src}, i) => {
    const allowed = new Set([name, ...dependsOn(src)]);
    for (const dep of allowed) if (files.findIndex(f => f.name === dep) > i) out.push(`${name} depends on ${dep}, which loads after it`);
    for (const used of names(src)) {
      for (const [other, set] of declares) if (!allowed.has(other) && set.has(used)) out.push(`${name} names ${used} from ${other}`);
    }
  });
  return {declares, out};
}

const read = files => files.map(name => ({name, src: fs.readFileSync(name, 'utf8')}));

module.exports = {dependsOn, codeOnly, names, crossings, read};
