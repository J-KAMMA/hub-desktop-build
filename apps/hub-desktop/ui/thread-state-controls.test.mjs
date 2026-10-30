import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createThreadStateControls } from './thread-state-controls.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);
function fixture(t, overrides = {}) {
  const dom = new JSDOM('<body></body>'), calls = [], f = { current: true, refreshed: 0, calls, dom };
  f.root = createThreadStateControls(dom.window.document, { thread: { id: 'thread-1', status: 'open', postCount: 100 }, viewer: { id: 'creator', lastReadPostNo: 3, canManageStatus: true }, readThrough: 50, isCurrent: () => f.current, onRefresh: () => { f.refreshed++; }, invoke: async (name, args) => { calls.push({ name, args }); return args.action === 'thread_read' ? { tracking: { threadId: args.target, lastReadPostNo: args.options.lastReadPostNo } } : { thread: { id: args.target, status: args.options.status } }; }, ...overrides });
  dom.window.document.body.append(f.root); f.button = label => [...f.root.querySelectorAll('button')].find(item => item.textContent === label); t.after(() => dom.window.close()); return f;
}

test('only an explicit read click saves the supplied visible boundary; confirmed reads do not repeat', async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0); f.button('ここまで既読にする').click(); await tick();
  assert.deepEqual(f.calls[0], { name: 'hub_client_action', args: { action: 'thread_read', target: 'thread-1', options: { lastReadPostNo: 50 } } }); assert.match(f.root.textContent, /既読 50 \/ 100/); assert.equal(f.refreshed, 1); assert.equal(f.button('ここまで既読にする').disabled, true);
  f.button('ここまで既読にする').click(); await tick(); assert.equal(f.calls.length, 1);
});
test('creator can close and reopen after exact native confirmation', async t => {
  const f = fixture(t); assert.equal(f.button('受付を再開').disabled, true); f.button('受付を終了').click(); await tick(); assert.match(f.root.textContent, /返信受付終了/); assert.equal(f.button('受付を終了').disabled, true);
  f.button('受付を再開').click(); await tick(); assert.match(f.root.textContent, /返信受付中/); assert.deepEqual(f.calls.map(c => c.args.options.status), ['closed', 'open']); assert.equal(f.refreshed, 2);
});
test('other viewers cannot change status and unauthenticated viewers have no writable controls', t => {
  const other = fixture(t, { viewer: { id: 'other', lastReadPostNo: 0, canManageStatus: false } }); assert.equal(other.button('受付を終了'), undefined); assert.ok(other.button('ここまで既読にする'));
  for (const viewer of [null, {}, { id: '', lastReadPostNo: 0 }, { id: 'creator', lastReadPostNo: -1 }]) assert.equal(fixture(t, { viewer }).root.querySelector('button'), null);
});
test('malformed boundaries and unchanged reads never send an IPC request', async t => {
  for (const readThrough of [-1, 1.5, Infinity, NaN, '50', 101, Number.MAX_SAFE_INTEGER + 1, 0, 3]) { const f = fixture(t, { readThrough }); assert.equal(f.button('ここまで既読にする').disabled, true); await f.button('ここまで既読にする').onclick(); assert.equal(f.calls.length, 0); }
  for (const thread of [{ id: 'bad/id', status: 'open', postCount: 100 }, { id: 'thread-1', status: 'bad', postCount: 100 }, { id: 'thread-1', status: 'open', postCount: 1.5 }]) assert.equal(fixture(t, { thread }).root.querySelector('button'), null);
});
test('failed and malformed acknowledgements preserve read and status and offer retry', async t => {
  for (const reply of [null, { tracking: { threadId: 'other', lastReadPostNo: 50 } }, { tracking: { threadId: 'thread-1', lastReadPostNo: 2 } }, { tracking: { threadId: 'thread-1', lastReadPostNo: 101 } }, { tracking: { threadId: 'thread-1', lastReadPostNo: 50.5 } }]) { const f = fixture(t, { invoke: async () => reply }); await f.button('ここまで既読にする').onclick(); assert.match(f.root.textContent, /既読 3 \/ 100/); assert.match(f.root.textContent, /再試行/); assert.equal(f.button('ここまで既読にする').disabled, false); assert.equal(f.refreshed, 0); }
  let succeeds = false; const f = fixture(t, { invoke: async () => { if (!succeeds) throw Error('unavailable'); return { thread: { id: 'thread-1', status: 'closed' } }; } }); await f.button('受付を終了').onclick(); assert.match(f.root.textContent, /返信受付中/); assert.equal(f.button('受付を終了').disabled, false); succeeds = true; await f.button('受付を終了').onclick(); assert.match(f.root.textContent, /返信受付終了/);
  for (const thread of [{ id: 'other', status: 'closed' }, { id: 'thread-1', status: 'open' }, null]) { const bad = fixture(t, { invoke: async () => ({ thread }) }); await bad.button('受付を終了').onclick(); assert.match(bad.root.textContent, /返信受付中/); assert.equal(bad.refreshed, 0); }
});
test('stale responses do not change detached controls or refresh another thread', async t => {
  for (const label of ['ここまで既読にする', '受付を終了']) { const wait = deferred(), f = fixture(t, { invoke: async () => wait.promise }); const pending = f.button(label).onclick(); const snapshot = f.root.textContent; f.current = false; wait.resolve(label === '受付を終了' ? { thread: { id: 'thread-1', status: 'closed' } } : { tracking: { threadId: 'thread-1', lastReadPostNo: 50 } }); await pending; assert.equal(f.root.textContent, snapshot); assert.equal(f.refreshed, 0); }
  const f = fixture(t); f.current = false; await f.button('受付を終了').onclick(); assert.equal(f.calls.length, 0);
});
test('pending controls lock duplicate writes and a failed refresh does not undo confirmed save', async t => {
  const wait = deferred(), f = fixture(t, { invoke: async () => wait.promise, onRefresh: async () => { throw Error('render failed'); } }); const pending = f.button('受付を終了').onclick(); assert.equal(f.button('ここまで既読にする').disabled, true); await f.button('受付を終了').onclick(); wait.resolve({ thread: { id: 'thread-1', status: 'closed' } }); await pending; assert.match(f.root.textContent, /返信受付終了/); assert.match(f.root.textContent, /保存しました。再表示/); assert.equal(f.button('受付を再開').disabled, false);
});
