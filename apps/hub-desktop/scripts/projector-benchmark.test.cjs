const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { Script } = require('node:vm');
const { pathToFileURL } = require('node:url');
const { files, instruction, prepare, verifySources, verifyWorkspace } = require('./projector-benchmark.cjs');

const corrected = {
  'src/parse.cjs': `exports.parseEvents = text => {
    if (typeof text !== 'string') throw Error('string required');
    return text.split(/\\r\\n|[\\r\\n]/).map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
  };`,
  'src/project.cjs': `exports.projectEvents = events => {
    if (!Array.isArray(events)) throw Error('array required');
    const seen = new Set(), rows = new Map();
    for (const e of events) {
      if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.id !== 'string' || !e.id ||
          typeof e.key !== 'string' || !e.key || !['put', 'remove'].includes(e.op) ||
          (e.op === 'put' && (!Number.isSafeInteger(e.value) || e.value < 0))) throw Error('invalid record');
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.op === 'remove') rows.delete(e.key); else rows.set(e.key, e.value);
    }
    return [...rows].map(([key, value]) => ({key, value}));
  };`,
  'src/index.cjs': "const {parseEvents} = require('./parse.cjs'); const {projectEvents} = require('./project.cjs'); exports.summarize = text => projectEvents(parseEvents(text));",
};

function workspace(fn) {
  const parent = fs.mkdtempSync(path.join(tmpdir(), 'hub-projector-test-'));
  const root = path.join(parent, 'workspace');
  try { return fn(root); }
  finally {
    assert.equal(path.dirname(fs.realpathSync(parent)), fs.realpathSync(tmpdir()));
    fs.rmSync(parent, {recursive:true});
  }
}

test('independent multi-file oracle accepts correct behavior and repeated calls', () => {
  const result = verifySources(corrected);
  assert.equal(result.profile, 'event-projector-v1');
  assert.equal(result.cases, 1098);
  assert.match(result.behaviorHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifySources({...corrected, 'src/parse.cjs': corrected['src/parse.cjs'].replace('/\\r\\n|[\\r\\n]/', '/[\\r\\n]/')}), result);
});

const mutate = (file, before, after) => {
  assert.ok(corrected[file].includes(before), 'mutation must apply');
  const source = corrected[file].replace(before, after);
  new Script(source);
  return {...corrected, [file]:source};
};
for (const [name, file, before, after] of [
  ['standalone CR', 'src/parse.cjs', '/\\r\\n|[\\r\\n]/', '/\\r?\\n/'],
  ['malformed JSON ignored', 'src/parse.cjs', 'JSON.parse(s)', "(() => { try { return JSON.parse(s); } catch { return {}; } })()"],
  ['duplicate applied', 'src/project.cjs', 'if (seen.has(e.id)) continue;', ''],
  ['missing deletion', 'src/project.cjs', 'rows.delete(e.key)', 'rows.has(e.key)'],
  ['updates reorder keys', 'src/project.cjs', 'else rows.set(e.key, e.value)', 'else { rows.delete(e.key); rows.set(e.key, e.value); }'],
  ['sorted output', 'src/project.cjs', '[...rows]', '[...rows].sort()'],
  ['key normalization', 'src/project.cjs', 'rows.set(e.key, e.value)', 'rows.set(e.key.trim().toLowerCase().normalize(), e.value)'],
  ['unsafe integers', 'src/project.cjs', 'Number.isSafeInteger', 'Number.isInteger'],
  ['negative values', 'src/project.cjs', ' || e.value < 0', ''],
  ['input mutation', 'src/project.cjs', 'seen.add(e.id);', "seen.add(e.id); e.extra = 'changed';"],
  ['invalid duplicates skipped', 'src/project.cjs', 'for (const e of events) {', 'for (const e of events) { if (e && seen.has(e.id)) continue;'],
  ['pipeline bypassed', 'src/index.cjs', 'projectEvents(parseEvents(text))', 'parseEvents(text)'],
]) test(`oracle rejects ${name}`, () => {
  assert.throws(() => verifySources(mutate(file, before, after)));
});

test('oracle rejects state surviving calls', () => {
  const sources = mutate('src/project.cjs', 'const seen = new Set(), rows = new Map();', 'const seen = new Set();');
  sources['src/project.cjs'] = 'const rows = new Map();\n' + sources['src/project.cjs'];
  assert.throws(() => verifySources(sources));
});

test('oracle rejects a non-array result', () => {
  assert.throws(() => verifySources({...corrected, 'src/project.cjs':"exports.projectEvents = () => '{}';"}));
});

test('a timeout on an invalid input is not accepted as validation', () => {
  const sources = mutate('src/parse.cjs', "throw Error('string required')", '(() => { while (true) {} })()');
  assert.throws(() => verifySources(sources), /expected rejection/);
});

test('task preparation is repeatable and refuses to overwrite an existing project', () => workspace(root => {
  const prepared = prepare(root);
  assert.match(prepared.inputHash, /^[a-f0-9]{64}$/);
  assert.match(prepared.verifierHash, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(path.join(root, 'TASK.md'), 'utf8'), instruction);
  assert.throws(() => prepare(root), {code:'EEXIST'});
  assert.throws(() => verifyWorkspace(root));
  for (const [file, code] of Object.entries(corrected)) fs.writeFileSync(path.join(root, file), code);
  assert.deepEqual(verifyWorkspace(root), verifySources(corrected));
  fs.writeFileSync(path.join(root, 'verify.cjs'), 'process.exit(0)');
  assert.throws(() => verifyWorkspace(root), /visible check changed/);
}));

test('oversized candidate source is rejected before execution', () => workspace(root => {
  prepare(root);
  fs.writeFileSync(path.join(root, 'src/parse.cjs'), ' '.repeat(128 * 1024 + 1));
  assert.throws(() => verifyWorkspace(root), /128 KiB/);
}));

test('a linked source directory cannot make the verifier read outside the task', () => workspace(root => {
  prepare(root);
  const outside = path.join(path.dirname(root), 'outside');
  fs.renameSync(path.join(root, 'src'), outside);
  fs.symlinkSync(outside, path.join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyWorkspace(root), /through links/);
}));

test('required verification feeds a real multi-file failure into a bounded repair', async () => {
  const {verifyWork} = await import(pathToFileURL(path.join(__dirname, '../vendor/pi-sidecar/verification.mjs')));
  let sources = {...corrected, 'src/project.cjs':files['src/project.cjs']};
  let checks = 0, repairs = 0;
  const ok = await verifyWork({prompt:instruction, complete:() => true,
    check:async () => {
      checks++;
      try { verifySources(sources); } catch (error) { throw Error(`command_failed: ${error.message}`); }
      return {details:{exitCode:0, timedOut:false}};
    },
    repair:async prompt => {
      repairs++;
      assert.ok(prompt.includes(instruction));
      assert.match(prompt, /Untrusted verification output:/);
      sources = corrected;
    },
  });
  assert.equal(ok, true);
  assert.equal(checks, 2);
  assert.equal(repairs, 1);
});
