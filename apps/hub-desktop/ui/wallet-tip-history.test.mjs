import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createWalletHistory } from './wallet-tip-history.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const item = (id = 'history-1', overrides = {}) => ({ id, chainId: 1, type: 'transfer', amount: '1.25', symbol: 'ETH', network: 'Ethereum', txHash: '0x' + 'a'.repeat(64), explorerUrl: 'https://etherscan.io/tx/0x' + 'a'.repeat(64), confirmedAt: '2026-10-06T00:00:00.000Z', ...overrides });
const tip = (id = 'tip-1', overrides = {}) => { const result = item(id, { direction: 'received' }); delete result.type; delete result.chainId; return Object.assign(result, overrides); };
function fixture(t, options = {}) {
  const dom = new JSDOM('<body></body>'), f = { dom, calls: [], copied: [], opened: [], current: true, result: { tips: [tip()] }, fail: false };
  f.widget = createWalletHistory(dom.window.document, { activity: [item()], isCurrent: () => f.current, invoke: async (...args) => { f.calls.push(args); if (f.fail) throw Error('private-service-error'); return f.result; }, copy: value => f.copied.push(value), open: url => f.opened.push(url), ...options });
  dom.window.document.body.append(f.widget.element); t.after(() => { f.widget.destroy(); dom.window.close(); });
  f.button = text => [...f.widget.element.querySelectorAll('button')].find(button => button.textContent === text);
  f.ids = () => [...f.widget.element.querySelectorAll('[data-history-id]')].map(row => row.dataset.historyId);
  f.text = () => f.widget.element.textContent;
  return f;
}
test('combines validated activity and tips by time with stable equal-time source/input order and no sensitive fields', async t => {
  const f = fixture(t, { activity: [item('activity-old', { confirmedAt: '2026-10-05T00:00:00Z' }), item('activity-tie')] });
  f.result = { tips: [tip('tip-tie'), tip('tip-new', { direction: 'sent', confirmedAt: '2026-10-06T01:00:00Z', privateNote: 'omit' })], settings: 'omit' };
  await f.widget.ready; assert.deepEqual(f.calls, [['hub_client', { name: 'tips' }]]);
  assert.deepEqual(f.ids(), ['tip-new', 'activity-tie', 'tip-tie', 'activity-old']); assert.match(f.text(), /送信チップ/); assert.match(f.text(), /受取チップ/); assert.doesNotMatch(f.text(), /omit/);
});
test('preserves activity on tip read failure and retries successfully without showing an empty history', async t => {
  const f = fixture(t); f.fail = true; await f.widget.ready;
  assert.deepEqual(f.ids(), ['history-1']); assert.match(f.text(), /チップ履歴を取得できません/); assert.doesNotMatch(f.text(), /取引はまだありません|private-service-error/);
  f.fail = false; f.button('チップ履歴を再試行').click(); await tick(); assert.deepEqual(f.ids(), ['history-1', 'tip-1']); assert.doesNotMatch(f.text(), /取得できません/);
});
test('keeps previous validated tips during a failed refresh with a visible stale-result message', async t => {
  const f = fixture(t); await f.widget.ready; f.fail = true; await f.widget.reload();
  assert.deepEqual(f.ids(), ['history-1', 'tip-1']); assert.match(f.text(), /前回取得した履歴/);
});
test('distinguishes an empty successful history from partial or complete unavailability', async t => {
  const empty = fixture(t, { activity: [] }); empty.result = { tips: [] }; await empty.widget.ready;
  assert.match(empty.text(), /確認済みの取引はまだありません/);
  const partial = fixture(t, { activity: [], activityUnavailable: true }); await partial.widget.ready;
  assert.match(partial.text(), /送受信・コントラクト履歴を取得できません/); assert.deepEqual(partial.ids(), ['tip-1']); assert.doesNotMatch(partial.text(), /取引はまだありません/);
  const unavailable = fixture(t, { activity: [], activityUnavailable: true }); unavailable.fail = true; await unavailable.widget.ready;
  assert.match(unavailable.text(), /履歴を取得できませんでした/); assert.doesNotMatch(unavailable.text(), /チップ履歴を取得できません/); assert.doesNotMatch(unavailable.text(), /取引はまだありません/);
});
test('deduplicates concurrent reads and disables refresh until the pending request settles', async t => {
  const response = deferred(), f = fixture(t, { invoke: async () => { f.calls.push('read'); return response.promise; } });
  assert.equal(f.widget.reload(), f.widget.ready); assert.equal(f.button('履歴を更新').disabled, true);
  await tick(); assert.equal(f.calls.length, 1); response.resolve({ tips: [] }); await f.widget.ready;
  assert.equal(f.button('履歴を更新').disabled, false); assert.equal(f.widget.element.getAttribute('aria-busy'), 'false');
});
test('discards and clears results when the account/view guard becomes stale', async t => {
  const response = deferred(), f = fixture(t, { invoke: () => response.promise }); await tick(); f.current = false;
  response.resolve({ tips: [tip()] }); await f.widget.ready;
  assert.deepEqual(f.ids(), []); assert.match(f.text(), /再読み込みしてください/); f.current = true; await f.widget.reload(); assert.deepEqual(f.ids(), []);
});
test('account change clears both sources and invalidates a pending response', async t => {
  const response = deferred(), f = fixture(t, { invoke: () => response.promise }); await tick();
  f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed')); assert.deepEqual(f.ids(), []);
  response.resolve({ tips: [tip()] }); await f.widget.ready; assert.deepEqual(f.ids(), []); assert.equal(f.button('履歴を更新').disabled, true);
});
test('destroy removes the element and ignores late reads and old action callbacks', async t => {
  const response = deferred(), f = fixture(t, { invoke: () => response.promise }); await tick(); const copy = f.button('取引IDをコピー');
  f.widget.destroy(); f.widget.destroy(); copy.click(); response.resolve({ tips: [tip()] }); await f.widget.ready;
  assert.equal(f.widget.element.isConnected, false); assert.deepEqual(f.copied, []); assert.deepEqual(f.ids(), []);
  await f.widget.reload(); assert.deepEqual(f.ids(), []);
});
test('validates response shape, limits, identifiers, uint256 amounts, date, network and directions before displaying any tips', async t => {
  const f = fixture(t); await f.widget.ready;
  const maxWei = (1n << 256n) - 1n, overflow = ((maxWei + 1n) / 10n ** 18n).toString() + '.' + ((maxWei + 1n) % 10n ** 18n).toString().padStart(18, '0');
  for (const result of [null, {}, { tips: null }, { tips: Array.from({ length: 101 }, (_, i) => tip('tip-' + i)) }, { tips: [tip(), tip()] },
    ...[{ direction: 'other' }, { amount: '-1' }, { amount: '0' }, { amount: '01' }, { amount: '1e8' }, { amount: '0.' + '1'.repeat(19) }, { amount: overflow }, { confirmedAt: '2026-02-30T00:00:00Z' }, { confirmedAt: 'invalid' }, { network: 'other' }, { network: 'Ethereum\n' }, { chainId: 137 }, { symbol: '<script>' }, { id: '../other' }, { txHash: '0x1234' }, { txHash: '0x' + 'g'.repeat(64) }, { explorerUrl: {} }].map(overrides => ({ tips: [tip('bad', overrides)] }))]) {
    f.result = result; await f.widget.reload(); assert.match(f.text(), /チップ履歴を更新できません/); assert.deepEqual(f.ids(), ['history-1', 'tip-1']);
  }
});
test('rejects malformed activity while allowing the independent valid tip source', async t => {
  for (const activity of [[item('bad', { chainId: 137 })], [item('bad', { type: 'unknown' })], [item('bad', { amount: '-1' })], Array.from({ length: 51 }, (_, i) => item('item-' + i))]) {
    const f = fixture(t, { activity }); await f.widget.ready; assert.deepEqual(f.ids(), ['tip-1']); assert.match(f.text(), /送受信・コントラクト履歴を取得できません/);
  }
});
test('preserves the existing wallet-activity API payload that omits chainId', async t => {
  const activity = { id: 'wallet-activity-fixture', type: 'transfer', amount: '0.5', symbol: 'ETH', network: 'Base', txHash: '0x' + 'b'.repeat(64), explorerUrl: 'https://basescan.org/tx/0x' + 'b'.repeat(64), confirmedAt: '2026-10-06T00:01:00.000Z' };
  const f = fixture(t, { activity: [activity] }); await f.widget.ready;
  assert.deepEqual(f.ids(), ['wallet-activity-fixture', 'tip-1']); assert.doesNotMatch(f.text(), /送受信・コントラクト履歴を取得できません/);
  f.button('取引の詳細').click(); await tick(); assert.deepEqual(f.opened, [activity.explorerUrl]);
});
test('accepts all supported network names, tiny positive tips and the exact uint256 upper bound', async t => {
  const f = fixture(t, { activity: [] }), max = (1n << 256n) - 1n;
  const amount = (max / 10n ** 18n).toString() + '.' + (max % 10n ** 18n).toString().padStart(18, '0');
  f.result = { tips: ['Ethereum', 'Polygon', 'Polygon Amoy', 'Base', 'Arbitrum One', 'OP Mainnet'].map((network, index) => tip('network-' + index, { network, amount: index ? '0.000000000000000001' : amount, explorerUrl: null })) };
  await f.widget.ready; assert.equal(f.ids().length, 6); assert.doesNotMatch(f.text(), /取得できません/); assert.match(f.text(), /0\.000000000000000001/);
});
test('uses the existing safe explorer/copy controls and derives tip chain IDs without accepting unsafe URLs', async t => {
  const f = fixture(t, { activity: [] }); f.result = { tips: [tip('base', { network: 'Base', explorerUrl: 'https://basescan.org/tx/0x' + 'a'.repeat(64) })] }; await f.widget.ready;
  f.button('取引IDをコピー').click(); f.button('取引の詳細').click(); await tick(); assert.deepEqual(f.copied, ['0x' + 'a'.repeat(64)]); assert.deepEqual(f.opened, ['https://basescan.org/tx/0x' + 'a'.repeat(64)]);
  for (const explorerUrl of ['https://evil.example/tx/0x' + 'a'.repeat(64), 'javascript:alert(1)', 'https://basescan.org/tx/0x' + 'a'.repeat(64) + '?secret=x', null]) {
    f.result = { tips: [tip('unsafe', { network: 'Base', explorerUrl })] }; await f.widget.reload(); assert.equal(f.button('取引の詳細'), undefined); assert.ok(f.button('取引IDをコピー'));
  }
});
test('stale copy/open actions never execute after account invalidation', async t => {
  const f = fixture(t); await f.widget.ready; const copy = f.button('取引IDをコピー'), open = f.button('取引の詳細');
  f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed')); copy.click(); open.click(); await tick(); assert.deepEqual(f.copied, []); assert.deepEqual(f.opened, []);
});
