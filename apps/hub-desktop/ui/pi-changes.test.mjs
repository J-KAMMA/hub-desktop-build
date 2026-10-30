import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createPiChanges } from './pi-changes.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const runId = '11111111-1111-4111-8111-111111111111';
const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const digest = text => createHash('sha256').update(text).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function entry({ before = 'old\n', after = 'new\n', path = 'src/main.js', id = ids[0], kind = 'modified', status = 'available' } = {}) {
  const item = { id, path, kind, beforeSha256: kind === 'created' ? null : digest(before), afterSha256: digest(after), status };
  const response = { runId, changeId: id, path, before, after, beforeSha256: item.beforeSha256, afterSha256: item.afterSha256, status, currentState: 'matches', coverage: 'hub_file_tools', baseline: 'before_first_write' };
  return { item, response };
}
function fixture(t, { changes, records = [entry()], invoke, run, ...options } = {}) {
  const dom = new JSDOM('<body></body>'), calls = [], completions = [], listeners = new WeakMap();
  const buttons = dom.window.HTMLButtonElement.prototype, add = buttons.addEventListener, remove = buttons.removeEventListener;
  // The real async click listener finishes only after IPC, digest validation and rendering.
  buttons.addEventListener = function(type, listener, options) {
    if(type !== 'click')return add.call(this, type, listener, options);
    const wrapped = event => {
      const count = calls.length, completion = listener.call(this, event);
      if(calls.length > count)completions.push(completion);
      return completion;
    };
    let registered = listeners.get(this);if(!registered)listeners.set(this, registered = new Map());registered.set(listener, wrapped);
    return add.call(this, type, wrapped, options);
  };
  buttons.removeEventListener = function(type, listener, options) {
    return remove.call(this, type, type === 'click' ? listeners.get(this)?.get(listener) ?? listener : listener, options);
  };
  const current = { value: true };
  const source = run ?? { id: runId, changes: changes ?? { coverage: 'hub_file_tools', baseline: 'before_first_write', status: 'tracked', reason: null, untrackedCommands: false, items: records.map(record => record.item) } };
  const widget = createPiChanges({ document: dom.window.document, run: source, isCurrent: () => current.value, invoke: async (...args) => { calls.push(args); return invoke ? invoke(...args) : records.find(record => record.item.id === args[1].changeId).response; }, ...options });
  dom.window.document.body.append(widget.element);
  t.after(() => { widget.destroy(); dom.window.close(); });
  return { dom, source, widget, calls, current, complete: (index = completions.length - 1) => { assert.ok(completions[index] instanceof Promise, 'a real diff request must have started'); return completions[index]; }, text: () => widget.element.textContent, buttons: () => [...widget.element.querySelectorAll('button')], diff: () => widget.element.querySelector('.piw-change-diff') };
}

test('explicit button reads only closed IPC IDs, explains first-write baseline and renders numbered text safely', async t => {
  const record = entry({ before: '<img src=x onerror=alert(1)>', after: '<script>evil()</script>', path: 'src/<img>.js' });
  const f = fixture(t, { records: [record] }); assert.equal(f.calls.length, 0);
  assert.match(f.text(), /成功したHubファイルツール.*最初の書込み直前.*コマンドによる変更は追跡しません/);
  assert.equal(f.buttons()[0].type, 'button'); f.buttons()[0].click(); await f.complete();
  assert.deepEqual(f.calls, [['pi_work_diff', { runId, changeId: ids[0] }]]);
  assert.equal(f.widget.element.querySelectorAll('img,script').length, 0);
  assert.match(f.diff().textContent, /1 \| <img.*1 \| <script>/);
  assert.equal(f.diff().getAttribute('aria-busy'), 'false');
});

test('legacy absence/null and explicit unavailable render no RPC controls', t => {
  for (const run of [{ id: runId }, { id: runId, changes: null }, { id: runId, changes: { coverage: 'hub_file_tools', baseline: 'before_first_write', status: 'unavailable', reason: null, untrackedCommands: false, items: [] } }]) {
    const f = fixture(t, { run }); assert.match(f.text(), /旧記録/); assert.equal(f.buttons().length, 0); assert.equal(f.calls.length, 0);
  }
});

test('incomplete, command-untracked and empty archive states are separate and incomplete keeps available files', async t => {
  const record = entry(), changes = { coverage: 'hub_file_tools', baseline: 'before_first_write', status: 'incomplete', reason: 'save_failed', untrackedCommands: true, items: [record.item] };
  const f = fixture(t, { changes }); assert.match(f.text(), /不完全.*保存できません.*コマンドの実行.*未追跡/); f.buttons()[0].click(); await f.complete(); assert.match(f.diff().textContent, /変更前/);
  const empty = fixture(t, { changes: { ...changes, status: 'tracked', reason: null, untrackedCommands: false, items: [] } });
  assert.match(empty.text(), /記録された変更ファイルはありません/); assert.doesNotMatch(empty.text(), /不完全/);
});

test('invalid summary widths, identifiers, duplicates, enums, unknown keys and sparse items cannot invoke', t => {
  const base = fixture(t).source.changes, item = base.items[0];
  for (const changes of [false, { ...base, coverage: 'all' }, { ...base, baseline: 'run_start' }, { ...base, status: 'new' }, { ...base, reason: 'save_failed' }, { ...base, status: 'incomplete' }, { ...base, status: 'incomplete', reason: 'unknown' }, { ...base, untrackedCommands: 1 }, { ...base, extra: true }, { ...base, items: Array(1) }, { ...base, items: Array(17).fill(item) }, { ...base, items: [item, { ...item }] }, { ...base, items: [item, { ...item, id: ids[1], path: item.path.toUpperCase() }] }, { ...base, items: [{ ...item, id: 'other-run' }] }, { ...base, items: [{ ...item, beforeSha256: null }] }, { ...base, items: [{ ...item, afterSha256: 'A'.repeat(64) }] }, { ...base, items: [{ ...item, kind: 'removed' }] }, { ...base, items: [{ ...item, status: 'unknown' }] }, { ...base, items: [{ ...item, extra: 1 }] }, { ...base, status: 'unavailable' }]) {
    const f = fixture(t, { changes }); assert.match(f.text(), /形式を確認できません/); assert.equal(f.buttons().length, 0); assert.equal(f.calls.length, 0);
  }
  const badId = fixture(t, { run: { id: 'bad', changes: base } }); assert.match(badId.text(), /形式を確認できません/);
});

test('unsafe path components and UTF8 overrun are rejected before RPC, valid UTF8 edge accepted', t => {
  for (const path of ['/etc/passwd', 'C:/secret.txt', '\\server\\file', 'a\\b', 'a//b', 'a/../b', 'a/.hidden', 'a/file.', 'a/file ', 'a/secret.key', 'a/state.DB', 'node_modules/a.js', 'a/CREDENTIALS/b', 'a/CON.txt', 'a/LPT9', 'a/\u0000b', 'a/\u0085b', 'あ'.repeat(81), '\ud800']) {
    const f = fixture(t, { records: [entry({ path })] }); assert.match(f.text(), /形式を確認できません/); assert.equal(f.buttons().length, 0);
  }
  const f = fixture(t, { records: [entry({ path: 'あ'.repeat(80) })] }); assert.equal(f.buttons().length, 1);
});

test('summary is an owned snapshot: caller mutation cannot change request IDs, paths or hashes', async t => {
  const record = entry(), f = fixture(t, { records: [record], invoke: () => record.response });
  f.source.id = ids[1]; f.source.changes.items[0].id = ids[1]; f.source.changes.items[0].path = 'other.js'; f.source.changes.items[0].afterSha256 = '0'.repeat(64);
  f.buttons()[0].click(); await f.complete(); assert.deepEqual(f.calls[0], ['pi_work_diff', { runId, changeId: ids[0] }]); assert.match(f.diff().textContent, /src\/main.js.*変更前/);
});

test('network failure is retryable, duplicates suppressed and exception text stays private', async t => {
  const record = entry(), gate = deferred(); let failing = true;
  const f = fixture(t, { invoke: () => failing ? gate.promise : record.response }); const button = f.buttons()[0];
  button.click(); button.dispatchEvent(new f.dom.window.MouseEvent('click')); assert.equal(f.calls.length, 1); assert.equal(button.disabled, true);
  gate.reject(Error('secret native path/error')); await f.complete(); assert.match(f.diff().textContent, /再試行/); assert.doesNotMatch(f.text(), /secret/); assert.equal(button.disabled, false);
  failing = false; button.click(); await f.complete(); assert.equal(f.calls.length, 2); assert.match(f.diff().textContent, /変更前/);
});

test('response identity, metadata shape, hashes and body mismatch render only retry error', async t => {
  const record = entry();
  for (const patch of [{ runId: ids[1] }, { changeId: ids[1] }, { path: 'other.js' }, { beforeSha256: null }, { afterSha256: '0'.repeat(64) }, { status: 'external_gap' }, { currentState: 'unknown' }, { coverage: 'exec' }, { baseline: 'run_start' }, { extra: 1 }, { before: null }, { after: 7 }, { before: 'wrong content' }, { after: 'wrong content' }, { after: '\ud800' }, { after: 'x'.repeat(32769) }, { after: 'あ'.repeat(10923) }]) {
    const f = fixture(t, { invoke: () => ({ ...record.response, ...patch }) }); f.buttons()[0].click(); await f.complete(); assert.match(f.diff().textContent, /再試行/); assert.equal(f.diff().querySelectorAll('pre').length, 0); assert.equal(f.buttons()[0].disabled, false);
  }
});

test('new file and preexisting empty file have different baseline descriptions', async t => {
  for (const [kind, expected] of [['created', /新規ファイル（変更前なし）/], ['modified', /空ファイル/]]) {
    const f = fixture(t, { records: [entry({ kind, before: '', after: 'first' })] }); f.buttons()[0].click(); await f.complete(); assert.match(f.diff().querySelector('.piw-change-before').textContent, expected);
  }
  const record = entry({ kind: 'created', before: 'invalid preimage' }); const f = fixture(t, { records: [record] }); f.buttons()[0].click(); await f.complete(); assert.match(f.diff().textContent, /再試行/);
});

test('archived external-gap bodies remain visible with changed/missing/unavailable current-state explanations', async t => {
  for (const [currentState, expected] of [['changed', /変わっています/], ['missing', /見つかりません/], ['unavailable', /確認できません/]]) {
    const record = entry({ status: 'external_gap' }); record.response.currentState = currentState;
    const f = fixture(t, { records: [record] }); f.buttons()[0].click(); await f.complete(); assert.match(f.diff().textContent, expected); assert.match(f.diff().textContent, /保存された変更前.*連続性を確認できません.*old.*new/s);
  }
});

test('linear prefix/suffix trim keeps three context lines and original before/after line numbers', async t => {
  const prefix = Array.from({ length: 8 }, (_, i) => `head${i}`), suffix = Array.from({ length: 8 }, (_, i) => `tail${i}`);
  const f = fixture(t, { records: [entry({ before: [...prefix, 'old', ...suffix].join('\n'), after: [...prefix, 'new1', 'new2', ...suffix].join('\n') })] }); f.buttons()[0].click(); await f.complete();
  assert.match(f.diff().textContent, /先頭 5 行 \/ 末尾 5 行/);
  assert.equal(f.diff().querySelector('.piw-change-before pre').textContent, '6 | head5\n7 | head6\n8 | head7\n9 | old\n10 | tail0\n11 | tail1\n12 | tail2');
  assert.equal(f.diff().querySelector('.piw-change-after pre').textContent, '6 | head5\n7 | head6\n8 | head7\n9 | new1\n10 | new2\n11 | tail0\n12 | tail1\n13 | tail2');
});

test('full UTF8 boundary and many identical/empty lines remain bounded, differing edge lines are retained', async t => {
  const large = '\n'.repeat(32767) + 'x', f = fixture(t, { records: [entry({ before: large, after: '\n'.repeat(32767) + 'y' })] });
  f.buttons()[0].click(); await f.complete(); assert.match(f.diff().textContent, /先頭 32764 行/); assert.match(f.diff().textContent, /32768 \| x.*32768 \| y/s); assert.ok(f.diff().textContent.length < 1000);
  for (const [before, after] of [['first\nsame\nsame\nsame\nsame', 'new\nsame\nsame\nsame\nsame'], ['', ''], ['same\nsame', 'same\nsame']]) {
    const sample = fixture(t, { records: [entry({ before, after })] }); sample.buttons()[0].click(); await sample.complete(); assert.equal(sample.diff().querySelectorAll('pre').length, 2); if (before === after) assert.match(sample.diff().textContent, /本文は同一/);
  }
});

test('other file selection discards earlier response and suppresses duplicate requests for any pending file', async t => {
  const a = entry({ path: 'a.js' }), b = entry({ id: ids[1], path: 'b.js', after: 'second file' }); const first = deferred(), second = deferred();
  const f = fixture(t, { records: [a, b], invoke: (_, args) => args.changeId === ids[0] ? first.promise : second.promise });
  f.buttons()[0].click(); f.buttons()[1].click(); f.buttons()[0].dispatchEvent(new f.dom.window.MouseEvent('click')); assert.equal(f.calls.length, 2);
  second.resolve(b.response); await f.complete(1); assert.match(f.diff().textContent, /b.js.*second file/s);
  first.resolve(a.response); await f.complete(0); assert.match(f.diff().textContent, /b.js.*second file/s); assert.doesNotMatch(f.diff().textContent, /a.js/);
});

test('view staleness and disposal suppress late RPC body, detached controls cannot invoke', async t => {
  const record = entry();
  for (const destroy of [false, true]) {
    const gate = deferred(), f = fixture(t, { invoke: () => gate.promise }), button = f.buttons()[0]; button.click();
    if (destroy) f.widget.destroy(); else f.current.value = false;
    gate.resolve(record.response); await f.complete(); assert.equal(f.widget.element.querySelectorAll('pre').length, 0);
    button.dispatchEvent(new f.dom.window.MouseEvent('click')); assert.equal(f.calls.length, 1);
    if (destroy) { assert.equal(f.widget.element.isConnected, false); assert.equal(f.text(), ''); f.widget.destroy(); }
  }
  const stale = fixture(t); stale.current.value = false; stale.buttons()[0].click(); assert.equal(stale.calls.length, 0);
});

test('16 files are accepted, malformed primitive shapes cannot pass through coercion and response stays unrendered', async t => {
  const records = Array.from({ length: 16 }, (_, index) => entry({ id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`, path: `src/file${index}.js` }));
  const f = fixture(t, { records }); assert.equal(f.buttons().length, 16);
  const invalid = fixture(t, { changes: { ...f.source.changes, status: 'incomplete', reason: ['save_failed'] } }); assert.match(invalid.text(), /形式を確認できません/);
  for (const response of [null, [], { ...records[0].response, currentState: ['matches'] }]) {
    const sample = fixture(t, { invoke: () => response }); sample.buttons()[0].click(); await sample.complete(); assert.match(sample.diff().textContent, /再試行/); assert.equal(sample.diff().querySelectorAll('pre').length, 0);
  }
});

test('digest-stage staleness is ignored and response object mutation cannot alter validated snapshot', async t => {
  const record = entry(), gates = []; let started, expected;
  t.mock.method(globalThis.crypto.subtle, 'digest', () => { const gate = deferred(); gates.push(gate); if(gates.length === expected)started.resolve(); return gate.promise; });
  for (const stale of [false, true]) {
    const raw = { ...record.response }, f = fixture(t, { invoke: () => raw }); const offset = gates.length;
    started = deferred(); expected = offset + 2;
    f.buttons()[0].click(); await started.promise; assert.equal(gates.length, offset + 2);
    let completed = false; const completion = f.complete().then(() => { completed = true; });
    raw.after = 'MUTATED BODY'; raw.path = 'wrong.js'; if (stale) f.current.value = false;
    gates[offset].resolve(Uint8Array.from(Buffer.from(record.item.beforeSha256, 'hex')).buffer);
    await gates[offset].promise; assert.equal(completed, false); assert.equal(f.diff().querySelectorAll('pre').length, 0);
    gates[offset + 1].resolve(Uint8Array.from(Buffer.from(record.item.afterSha256, 'hex')).buffer);
    await completion; assert.equal(completed, true); assert.doesNotMatch(f.text(), /MUTATED BODY|wrong.js/);
    if (stale) assert.equal(f.diff().querySelectorAll('pre').length, 0); else assert.match(f.diff().textContent, /src\/main.js.*old.*new/s);
  }
});

test('crypto verification unavailable fails closed without displaying a body', async t => {
  t.mock.method(globalThis.crypto.subtle, 'digest', async () => { throw Error('crypto unavailable'); });
  const f = fixture(t); f.buttons()[0].click(); await f.complete(); assert.match(f.diff().textContent, /再試行/); assert.equal(f.diff().querySelectorAll('pre').length, 0);
});
