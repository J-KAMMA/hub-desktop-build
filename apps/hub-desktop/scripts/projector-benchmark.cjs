// A portable coding task, not a competitor runner. Checking executes candidate
// JavaScript: the VM time limit is a test guard, NOT an OS security boundary.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const profile = 'event-projector-v1';
const instruction = `Repair this project's three CommonJS modules without adding dependencies.
src/parse.cjs exports parseEvents(text): accept a JavaScript string containing JSON
records separated by LF, CRLF or standalone CR. Trim JavaScript whitespace around
each line, ignore blank lines, parse every remaining line with JSON.parse, and
return the records in order. Malformed JSON and non-string input must throw.
src/project.cjs exports projectEvents(events): accept an array of records. Each
record must be a non-null object, not an array, with nonempty string id and key.
op must be "put" or "remove"; put requires a nonnegative safe-integer value.
Validate every record, including repeated ids; invalid input must throw. Extra
fields are allowed. Process each id only once: later valid records with the same
id are ignored, even if their content differs. put inserts or replaces a key;
remove deletes it if present. Return an array of {key, value} for live keys in
insertion order. Updating an existing key keeps its position; removing and later
reinserting it places it last. Preserve keys exactly, including case, whitespace,
Unicode and names such as __proto__. Do not mutate input records or retain state
between calls. Negative zero may be represented as zero.
src/index.cjs exports summarize(text), composing parseEvents and projectEvents.
Preserve all three interfaces. Edit only these three source files. Read the
existing files, run node verify.cjs where command execution is available, and
correct failures. Do not edit verify.cjs or these instructions. If command
execution is unavailable, report that honestly; an external verifier will run.
Do not delegate, access the network, change settings, commit or publish.
`;
const files = {
  'src/parse.cjs': "exports.parseEvents = text => text.split('\\n').map(JSON.parse);\n",
  'src/project.cjs': "exports.projectEvents = events => { const state = {}; for (const event of events) state[event.key] = event.value; return Object.keys(state).sort().map(key => ({key, value: state[key]})); };\n",
  'src/index.cjs': "const {parseEvents} = require('./parse.cjs');\nexports.summarize = text => parseEvents(text);\n",
  'verify.cjs': `const a = require('node:assert/strict');
const {summarize} = require('./src/index.cjs');
a.deepEqual(summarize(''), []);
a.deepEqual(summarize(' {"id":"1","op":"put","key":"z","value":3}\\r\\n{"id":"2","op":"put","key":"a","value":1}\\n{"id":"1","op":"remove","key":"z"} '), [{key:'z',value:3},{key:'a',value:1}]);
a.deepEqual(summarize('{"id":"1","op":"put","key":"x","value":2}\\r{"id":"2","op":"remove","key":"x"}'), []);
a.throws(() => summarize('{"id":"1","op":"put","key":"x","value":-1}'));
`,
};
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => ({ profile, inputHash: hash(JSON.stringify([instruction, files])),
  verifierHash: hash(fs.readFileSync(__filename)) });

// An array-based reference intentionally differs from a Map/object reducer.
function expected(events) {
  const ids = [], rows = [];
  for (const event of events) {
    if (ids.includes(event.id)) continue;
    ids.push(event.id);
    const index = rows.findIndex(row => row.key === event.key);
    if (event.op === 'remove') { if (index !== -1) rows.splice(index, 1); }
    else if (index === -1) rows.push({key: event.key, value: event.value});
    else rows[index] = {key: event.key, value: event.value};
  }
  return rows;
}

function verifySources(sources) {
  const context = vm.createContext({ sources });
  // Only the task's three modules can be resolved. This supports ordinary
  // CommonJS, but is not a sandbox for hostile code (see the file header).
  vm.runInContext(`
    const cache = Object.create(null);
    function load(name) {
      if (!Object.hasOwn(sources, name)) throw Error('module not in task: ' + name);
      if (cache[name]) return cache[name].exports;
      const module = cache[name] = {exports:{}};
      const require = id => { if (!/^\\.\\/[a-z]+\\.cjs$/.test(id)) throw Error('dependency not allowed'); return load('src/' + id.slice(2)); };
      new Function('module', 'exports', 'require', sources[name])(module, module.exports, require);
      return module.exports;
    }
    const parse = load('src/parse.cjs').parseEvents;
    const project = load('src/project.cjs').projectEvents;
    const summarize = load('src/index.cjs').summarize;
  `, context, { timeout: 1000 });
  const digest = createHash('sha256');
  let cases = 0;
  function check(expression, input, want, throws = false) {
    context.input = structuredClone(input);
    const original = structuredClone(input);
    const run = () => vm.runInContext(`JSON.stringify(${expression}(input))`, context, { timeout: 1000 });
    // A VM timeout is a broken candidate, never a successful validation error.
    if (throws) {
      let rejected = false;
      try { run(); } catch (error) { rejected = error?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT'; }
      assert.ok(rejected, `case ${cases}: expected rejection`);
    } else assert.deepEqual(JSON.parse(run()), want, `case ${cases}`);
    assert.deepEqual(context.input, original, `case ${cases}: input mutated`);
    digest.update(JSON.stringify([expression, input, throws ? 'rejected' : want]) + '\n');
    cases++;
  }
  const put = (id, key, value) => ({ id, op: 'put', key, value });
  const remove = (id, key) => ({ id, op: 'remove', key });
  const seeds = [put('1', 'z', 1), put('2', 'a', 0), put('3', 'z', 4),
    remove('4', 'z'), put('1', 'a', 7), put('5', '__proto__', 2), remove('6', 'absent')];
  const sequences = [[], [put('1', 'z', 1)],
    [put('1', 'z', 1), put('2', 'a', 2), remove('3', 'z'), put('4', 'z', 3)],
    ['constructor', 'toString', '0', '00', 'A', 'a', ' x ', '日', '😀', 'é', 'e\u0301', '\0', '\ud800']
      .map((key, i) => put(String(i), key, i)),
    [put('0', 'x'.repeat(65537), Number.MAX_SAFE_INTEGER)],
    [{...put(' ', ' ', 0), extra: {keep: true}}, {id:'2',op:'remove',key:' ',value:-1}],
    Array.from({length: 1025}, (_, i) => put(String(i), `key${i % 257}`, i)),
  ];
  for (const a of seeds) for (const b of seeds) for (const c of seeds) sequences.push([a, b, c]);
  for (const [index, events] of sequences.entries()) {
    const separator = ['\n', '\r\n', '\r'][index % 3];
    const text = '\t' + separator + events.map(JSON.stringify).join(separator) + separator + ' ';
    check('parse', text, events);
    check('project', events, expected(events));
    check('summarize', text, expected(events));
  }
  for (const input of [null, 0, {}, [], true, '{', '{}\n{']) check('parse', input, null, true);
  for (const input of [null, {}, '', 0]) check('project', input, null, true);
  for (const value of [NaN, Infinity, -Infinity]) check('project', [put('1', 'x', value)], null, true);
  check('summarize', '{"id":"1","op":"put","key":"x","value":1e400}', null, true);
  const invalid = [null, [], 1, 'x', {}, put('', 'x', 0), put('1', '', 0),
    put(1, 'x', 0), put('1', 0, 0), {...put('1', 'x', 0), op: 'clear'},
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null].map(value => put('1', 'x', value)),
    {id:'1', op:'put', key:'x'}];
  for (const event of invalid) {
    // An invalid duplicate must not be hidden by idempotency handling.
    const events = [put('1', 'first', 0), event];
    check('project', events, null, true);
    check('summarize', events.map(JSON.stringify).join('\n'), null, true);
  }
  check('project', [put('1', 'last', 0)], [{key:'last',value:0}]);
  return { profile, cases, behaviorHash: digest.digest('hex') };
}

function prepare(directory) {
  // Refuse existing paths instead of overwriting a project or another trial.
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, 'src'));
  for (const [name, source] of Object.entries({...files, 'TASK.md': instruction})) {
    fs.writeFileSync(path.join(directory, name), source, { flag: 'wx' });
  }
  return fingerprint();
}

function verifyWorkspace(directory) {
  const root = fs.realpathSync(directory);
  const read = name => {
    const file = path.join(root, name);
    assert.equal(fs.realpathSync(file), file, 'task files must not resolve through links');
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && stat.size <= 128 * 1024, 'task file must be a regular file at most 128 KiB');
    return fs.readFileSync(file, 'utf8');
  };
  assert.equal(read('verify.cjs'), files['verify.cjs'], 'visible check changed');
  assert.equal(read('TASK.md'), instruction, 'instructions changed');
  const sources = Object.fromEntries(Object.keys(files).filter(name => name.startsWith('src/')).map(name => [name, read(name)]));
  return verifySources(sources);
}

module.exports = { profile, instruction, files, prepare, verifySources, verifyWorkspace };
if (require.main === module) {
  const [command, directory, ...extra] = process.argv.slice(2);
  if (!['prepare', 'check'].includes(command) || !directory || extra.length) {
    console.error('Usage: node projector-benchmark.cjs prepare|check <workspace>');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(command === 'prepare' ? prepare(directory) : {...fingerprint(), ...verifyWorkspace(directory)})); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
