import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { addressGroups, createRailWallet, railBalanceSummary, shortAddress } from './rail-wallet.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

const ADDRESS = '0x1111111111111111111111111111111111111111';
const status = {
  address: ADDRESS, chainId: 137, chainName: 'Polygon', symbol: 'POL', mainnet: true, developer: false,
  chains: [{ chainId: 137, name: 'Polygon', symbol: 'POL', mainnet: true }, { chainId: 1, name: 'Ethereum', symbol: 'ETH', mainnet: true }],
  tokens: [{ symbol: 'JPYC', address: '0x2222222222222222222222222222222222222222', decimals: 18 }],
};
const activity = (count) => Array.from({ length: count }, (_, index) => ({
  id: `a${index}`, network: 'Polygon', symbol: 'POL', txHash: `0x${String(index).padStart(64, '0')}`, amount: '1.5',
  confirmedAt: `2026-10-0${(index % 9) + 1}T00:00:00.000Z`, explorerUrl: null, type: 'transfer',
}));

function fixture({ balanceWei = '2500000000000000000', hubFails = false, rows = 8, statusValue = status, storage = undefined } = {}) {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const calls = [], opened = [], copied = [];
  const invoke = async (name, args) => {
    calls.push([name, args]);
    if (name === 'wallet_status') return statusValue;
    if (name === 'wallet_balance') return { chainId: 137, balanceWei };
    if (name === 'wallet_token_balances') return { chainId: 137, tokens: [{ address: status.tokens[0].address, balanceRaw: '12000000000000000000' }] };
    if (name === 'hub_client' && args.name === 'wallet') { if (hubFails) throw new Error('hub_down'); return { activity: activity(rows) }; }
    if (name === 'hub_client' && args.name === 'tips') return { tips: [] };
    if (name === 'wallet_send_native') return `0x${'ab'.repeat(32)}`;
    throw new Error(`unexpected:${name}`);
  };
  const wallet = createRailWallet({ document, invoke, openWallet: (options) => opened.push(options), copy: async (value) => { copied.push(value); }, ...(storage ? { storage } : {}), describeError: (error) => `err:${error.message}` });
  document.body.append(wallet.element);
  return { dom, document, wallet, calls, opened, copied };
}
const settle = async (wallet) => { await wallet.ready; await new Promise((resolve) => setTimeout(resolve, 20)); };

test('compact wallet shows network, native balance, JPYC, address and recent activity', async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  const root = f.wallet.element;
  assert.equal(root.querySelector('.wallet-network-select').value, '137');
  assert.match(root.querySelector('.wallet-network-pill').textContent, /Polygon/);
  assert.equal(root.querySelector('.wallet-network-chooser').hidden, true, 'the chooser opens from the pill');
  assert.equal(root.querySelector('.rail-wallet-account').textContent, '0x1111…1111');
  assert.equal(root.querySelector('.wallet-balance').textContent, '2.5');
  assert.equal(root.querySelector('.wallet-balance-row .wallet-unit').textContent, 'POL');
  assert.match(root.querySelector('.wallet-token-list').textContent, /JPYC/);
  assert.match(root.querySelector('.wallet-token-list').textContent, /12/);
  assert.equal(root.querySelector('.wallet-address').dataset.address, ADDRESS);
  assert.equal(root.querySelector('.wallet-address').textContent.replace(/ /g, ''), ADDRESS);
  assert.equal(root.querySelector('.rail-wallet-sheet').hidden, true, 'receive sheet starts closed');
  assert.ok(root.querySelector('.wallet-token-avatar'), 'token rows have an avatar');
  assert.equal(root.querySelector('.wallet-mainnet-warning'), null, 'the mainnet warning waits for the send flow');
  assert.doesNotMatch(root.textContent, /本物のお金が動きます/);
  assert.equal(root.querySelector('.rail-wallet-open'), null, 'the rail is complete on its own; no hand-off to the central wallet');
  assert.ok(root.querySelector(".wallet-section[aria-label]"), "recent history section");
  assert.ok(f.calls.some(([name, args]) => name === 'hub_client' && args.name === 'wallet'));
});

test('only the five most recent activity rows are handed to the history list', async (t) => {
  const f = fixture({ rows: 9 });
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  assert.equal(f.wallet.element.querySelectorAll('[data-history-id]').length, 5);
});

test('copy writes the address; receive and send sheets are exclusive', async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  const root = f.wallet.element;
  root.querySelector('.rail-wallet-receive').click();
  assert.equal(root.querySelector('.rail-wallet-sheet').hidden, false);
  assert.equal(root.querySelector('.rail-wallet-receive').getAttribute('aria-expanded'), 'true');
  assert.match(root.querySelector('.rail-wallet-sheet').textContent, /Polygon/);
  const copyButton = root.querySelector('.rail-wallet-copy');
  copyButton.click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(f.copied, [ADDRESS]);
  assert.equal(copyButton.textContent, 'コピーしました');
  const send = root.querySelector('.rail-wallet-send');
  assert.equal(send.disabled, false, 'enabled once a positive balance is read');
  send.click();
  assert.equal(root.querySelector('.rail-wallet-sheet').hidden, true, 'opening send closes receive');
  assert.equal(root.querySelector('.rail-wallet-send-sheet').hidden, false);
  assert.equal(send.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(f.opened, [], 'nothing is handed to the central wallet');
});

test('send validates in the rail and goes through wallet_send_native (the device confirmation)', async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  const root = f.wallet.element;
  assert.equal(root.querySelector('.wallet-mainnet-warning'), null);
  root.querySelector('.rail-wallet-send').click();
  const sheet = root.querySelector('.rail-wallet-send-sheet');
  assert.ok(sheet.querySelector('.wallet-mainnet-warning'), 'the mainnet warning shows with the send form');
  const [to, amount] = sheet.querySelectorAll('input');
  const submit = sheet.querySelector('.rail-wallet-submit');
  const note = sheet.querySelector('.rail-wallet-send-note');
  const sends = () => f.calls.filter(([name]) => name === 'wallet_send_native');
  to.value = '0x123'; amount.value = '1'; submit.click();
  assert.match(note.textContent, /アドレスが正しくありません/);
  to.value = ADDRESS; submit.click();
  assert.match(note.textContent, /自分のアドレス/);
  to.value = '0x3333333333333333333333333333333333333333'; amount.value = 'abc'; submit.click();
  assert.match(note.textContent, /数量が正しくありません/);
  amount.value = '3'; submit.click();
  assert.match(note.textContent, /残高を超えています/);
  assert.equal(sends().length, 0);
  amount.value = '1.25'; submit.click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sends(), [['wallet_send_native', { chainId: 137, to: '0x3333333333333333333333333333333333333333', amountWei: '1250000000000000000' }]]);
  assert.match(note.textContent, /届けました/);
  assert.equal(amount.value, '');
});

test('amountToWei keeps 18 decimals and rejects malformed input', async () => {
  const { amountToWei } = await import('./rail-wallet.mjs');
  assert.equal(amountToWei('1.5'), 1500000000000000000n);
  assert.equal(amountToWei('0.000000000000000001'), 1n);
  for (const bad of ['', '1.', '.5', '-1', '1e3', '0.0000000000000000001']) assert.equal(amountToWei(bad), null);
});

test('send stays disabled without a balance or when the balance cannot be read', async (t) => {
  const empty = fixture({ balanceWei: '0' });
  t.after(() => empty.dom.window.close());
  await settle(empty.wallet);
  assert.equal(empty.wallet.element.querySelector('.rail-wallet-send').disabled, true);
  assert.match(empty.wallet.element.querySelector('.wallet-balance-state').textContent, /まだ残高がありません/);
  assert.match(empty.wallet.element.querySelector('.rail-wallet-send').title, /残高がないため送れません/);
  assert.equal(empty.wallet.element.querySelector('.wallet-balance').textContent, '0');
  assert.match(empty.wallet.element.querySelector('.wallet-token-list').textContent, /JPYC/);
  const bad = fixture({ balanceWei: 'not-a-number' });
  t.after(() => bad.dom.window.close());
  await settle(bad.wallet);
  assert.equal(bad.wallet.element.querySelector('.rail-wallet-send').disabled, true);
  assert.equal(bad.wallet.element.querySelector('.wallet-balance').textContent, '残高を確認できません');
});

test('a Hub outage still shows the device wallet; a missing wallet explains and offers the full view', async (t) => {
  const down = fixture({ hubFails: true });
  t.after(() => down.dom.window.close());
  await settle(down.wallet);
  assert.equal(down.wallet.element.querySelector('.wallet-balance').textContent, '2.5');
  assert.match(down.wallet.element.textContent, /履歴を取得できません|取得できません/);
  const none = fixture({ statusValue: {} });
  t.after(() => none.dom.window.close());
  await settle(none.wallet);
  assert.match(none.wallet.element.textContent, /ウォレットを開けません/);
  none.wallet.element.querySelector('.rail-wallet-open').click();
  assert.deepEqual(none.opened, [{}]);
});

test('the pill opens the existing chooser and the history error uses a compact state panel with a retry', async (t) => {
  const f = fixture({ hubFails: true });
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  const root = f.wallet.element;
  root.querySelector('.wallet-network-pill').click();
  assert.equal(root.querySelector('.wallet-network-chooser').hidden, false);
  assert.equal(root.querySelector('.wallet-network-select').value, '137');
  const panel = root.querySelector('.wallet-history .state-panel.is-compact');
  assert.equal(panel.hidden, false);
  assert.ok(panel.querySelector('.btn.btn-secondary'), 'retry is a secondary button');
});

test('a wallet without tokens shows the empty line', async (t) => {
  const f = fixture({ statusValue: { ...status, tokens: [] } });
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  assert.match(f.wallet.element.querySelector('.wallet-token-list').textContent, /トークンはまだありません/);
});

test('address helpers group in fours and shorten', () => {
  assert.deepEqual(addressGroups(ADDRESS), Array(10).fill('1111'));
  assert.equal(shortAddress(ADDRESS), '0x1111…1111');
});

test('the rail wallet offers no exchange, swap, bridge or price comparison', async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  assert.doesNotMatch(f.wallet.element.textContent, /スワップ|交換|ブリッジ|swap|bridge|両替|購入/i);
});

test('railBalanceSummary rejects malformed and oversized values', () => {
  assert.deepEqual(railBalanceSummary('1000000000000000000'), { label: '1', canSend: true });
  assert.deepEqual(railBalanceSummary('0'), { label: '0', canSend: false });
  assert.equal(railBalanceSummary('-1'), null);
  assert.equal(railBalanceSummary('1.5'), null);
  assert.equal(railBalanceSummary(5), null);
  assert.equal(railBalanceSummary((1n << 129n).toString()), null);
});

const memoryStorage = (initial = {}) => { const map = new Map(Object.entries(initial)); return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); } }; };

test('hero card holds pill, short address and balance; round actions carry icon and label', async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  const hero = f.wallet.element.querySelector('.rail-wallet-hero');
  assert.ok(hero.querySelector('.wallet-network-pill') && hero.querySelector('.rail-wallet-account') && hero.querySelector('.wallet-balance'));
  const labels = [...hero.querySelectorAll('.rail-wallet-action')].map((node) => node.querySelector('.rail-wallet-action-label').textContent);
  assert.deepEqual(labels, ['受け取る', '送る', 'コピー']);
  for (const node of hero.querySelectorAll('.rail-wallet-action')) assert.ok(node.querySelector('.rail-wallet-action-icon svg'), 'inline svg icon');
});

test('the round copy action copies the address and swaps its label briefly', async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  const action = f.wallet.element.querySelector('.rail-wallet-action-copy');
  action.click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(f.copied, [ADDRESS]);
  assert.equal(action.querySelector('.rail-wallet-action-label').textContent, 'コピーしました');
  assert.ok(action.classList.contains('is-done'));
});

test('disabled send keeps its reason in the title', async (t) => {
  const f = fixture({ balanceWei: '0' });
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  const send = f.wallet.element.querySelector('.rail-wallet-send');
  assert.equal(send.disabled, true);
  assert.match(send.title, /残高がないため/);
});

test('tabs switch between tokens and history, expose roles and remember the choice under a hub. key', async (t) => {
  const storage = memoryStorage();
  const f = fixture({ storage });
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  const root = f.wallet.element;
  const [tokenTab, historyTab] = root.querySelectorAll('[role="tab"]');
  assert.equal(root.querySelectorAll('[role="tab"]').length, 2);
  assert.equal(tokenTab.getAttribute('aria-selected'), 'true');
  assert.equal(root.querySelector('.wallet-token-list').hidden, false);
  assert.equal(root.querySelector('.wallet-history').hidden, true);
  historyTab.click();
  assert.equal(historyTab.getAttribute('aria-selected'), 'true');
  assert.equal(root.querySelector('.wallet-token-list').hidden, true);
  assert.equal(root.querySelector('.wallet-history').hidden, false);
  const key = [...storage.map.keys()][0];
  assert.ok(key.startsWith('hub.'));
  assert.equal(storage.map.get(key), 'history');
  historyTab.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(tokenTab.getAttribute('aria-selected'), 'true');
});

test('a remembered history tab is restored, and broken storage falls back to tokens', async (t) => {
  const remembered = fixture({ storage: memoryStorage({ 'hub.rail.wallet.tab': 'history' }) });
  t.after(() => remembered.dom.window.close());
  await settle(remembered.wallet);
  assert.equal(remembered.wallet.element.querySelector('.wallet-history').hidden, false);
  const broken = fixture({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  t.after(() => broken.dom.window.close());
  await settle(broken.wallet);
  assert.equal(broken.wallet.element.querySelector('.wallet-token-list').hidden, false);
  broken.wallet.element.querySelectorAll('[role="tab"]')[1].click();
});

test('token rows are skeletons until balances arrive, then show the amount', async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  const { createWalletTokens } = await import('./wallet-network.mjs');
  const held = createWalletTokens({ document: f.document, invoke: () => new Promise(() => {}), status });
  assert.ok(held.element.querySelector('.wallet-token-balance.is-loading'), 'skeleton while waiting');
  await settle(f.wallet);
  assert.equal(f.wallet.element.querySelector('.wallet-token-balance.is-loading'), null);
  assert.ok(f.wallet.element.querySelector('.wallet-token-avatar[data-tint]'));
});

test('the wallet styles honour reduced motion and use no raw type or radius px', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./desktop-shell.css', import.meta.url), 'utf8');
  const reduced = css.slice(css.indexOf('prefers-reduced-motion: reduce', css.indexOf('rail-wallet-rise')));
  assert.ok(reduced.includes('rail-wallet-panel.is-entering'));
  assert.ok(css.includes('width: 48px; height: 48px'));
});

test('pressing the network pill opens the list itself, and still switches nothing until a network is chosen', async (t) => {
  // 2026-11-12 所有者「直す」: 札 → 欄 → 選ぶ の3手を、札 → 選ぶ の2手に。
  const f = fixture();
  t.after(() => f.dom.window.close());
  await settle(f.wallet);
  const root = f.wallet.element, select = root.querySelector('.wallet-network-select');
  let opened = 0;
  select.showPicker = () => { opened += 1; };
  const before = select.value;
  root.querySelector('.wallet-network-pill').click();
  assert.equal(root.querySelector('.wallet-network-chooser').hidden, false);
  assert.equal(opened, 1, 'the list opens with the same press');
  assert.equal(select.value, before, 'opening the list selects nothing');
  root.querySelector('.wallet-network-pill').click();
  assert.equal(root.querySelector('.wallet-network-chooser').hidden, true);
  assert.equal(opened, 1, 'closing does not reopen the list');
  // 一覧を開けない環境でも、札は欄を出して止まらない。
  select.showPicker = () => { throw new Error('NotAllowedError'); };
  root.querySelector('.wallet-network-pill').click();
  assert.equal(root.querySelector('.wallet-network-chooser').hidden, false);
});
