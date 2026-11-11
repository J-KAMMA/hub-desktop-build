import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isReadAccessDenied } from './hub-read-recovery.mjs';

// 「Desktopを接続」：Account には登録済みでも Hub がこの端末を知らないとき、つなぎ直す道があること。
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const cut = (name) => { const start = source.indexOf(name), end = source.indexOf('\n}\n', start) + 3; assert.ok(start >= 0 && end > start, name); return source.slice(start, end); };
function harness({ state = 'registered', timeline = 'ok', confirm = true } = {}) {
  const calls = [], opened = [];
  const invoke = async (name, args) => {
    calls.push(name);
    if (name === 'hub_detail') { if (timeline === 'ok') return { items: [] }; throw new Error(timeline); }
    if (name === 'logout_desktop_account') return {};
    if (name === 'begin_desktop_account') return { state: 'pending', approvalUrl: 'http://localhost:3020/v2/account/desktop?request=r1', userCode: '1234' };
    if (name === 'open_external') { opened.push(args.url); return {}; }
    return {};
  };
  const window = { confirm: (text) => { calls.push('confirm:' + text.slice(0, 12)); return confirm; } };
  const accountNeeded = (error) => isReadAccessDenied(error) || String(error?.message ?? error).includes('ハブが 401 を返しています');
  const run = new Function('accountNeeded', 'invoke', 'window', 'desktopAccount', 'loadFeed', 'refreshDesktopAccount',
    `${cut('async function desktopLinkMissing() {')}\n${cut('async function connectDesktopAccount() {')}\nreturn connectDesktopAccount;`)(
    accountNeeded, invoke, window, { state }, async () => { calls.push('loadFeed'); }, async () => { calls.push('refresh'); });
  return { run, calls, opened };
}

test('registered and the Hub knows the device: nothing to redo, the feed just reloads', async () => {
  const f = harness();
  await f.run();
  assert.deepEqual(f.calls, ['hub_detail', 'loadFeed']);
});

test('registered but the Hub rejects the device: confirm, drop the key, start a new approval and open it', async () => {
  const f = harness({ timeline: 'desktop_not_connected' });
  await f.run();
  assert.deepEqual(f.calls.filter((name) => !name.startsWith('confirm')), ['hub_detail', 'logout_desktop_account', 'begin_desktop_account', 'refresh', 'open_external']);
  assert.equal(f.calls.filter((name) => name.startsWith('confirm')).length, 1, 'only the confirm to redo; no window asking to copy a code');
  assert.deepEqual(f.opened, ['http://localhost:3020/v2/account/desktop?request=r1']);
});

test('declining the redo keeps the key', async () => {
  const f = harness({ timeline: 'desktop_not_connected', confirm: false });
  await f.run();
  assert.ok(!f.calls.includes('logout_desktop_account'));
  assert.deepEqual(f.opened, []);
});

test('another failure (the Hub is down) is not treated as a missing link', async () => {
  const f = harness({ timeline: 'hub_unreachable' });
  await f.run();
  assert.deepEqual(f.calls, ['hub_detail', 'loadFeed']);
});

test('the message the Hub client actually returns for a rejected device (ハブが 401 を返しています) starts the redo', async () => {
  // 入れてある版を実物で測ったら、読み出しはこの文で返っていた（2026-11-11）。
  const f = harness({ timeline: 'ハブが 401 を返しています' });
  await f.run();
  assert.ok(f.calls.includes('logout_desktop_account'));
  assert.ok(source.includes('const accountNeeded = (error) => isReadAccessDenied(error) || String(error?.message ?? error).includes("ハブが 401 を返しています");'));
  assert.equal(isReadAccessDenied(new Error('ハブが 401 を返しています')), false, 'other Hubs keep their own 401 handling');
});

test('an approval that is already pending just opens the approval page again: no window to copy a code from', async () => {
  // 2026-11-12 所有者「デスクトップ側にコードでない、そもそもこんなことしなくて済むようにしてほしい」。
  const f = harness({ state: 'pending' });
  const pending = { state: 'pending', approvalUrl: 'http://localhost:3020/v2/account/desktop?request=r1#port=50123', userCode: '1234' };
  const run = new Function('invoke', 'window', 'desktopAccount', `${cut('async function connectDesktopAccount() {')}\nreturn connectDesktopAccount;`)(
    async (name, args) => { f.calls.push(name); if (name === 'open_external') f.opened.push(args.url); return {}; },
    { confirm: () => { f.calls.push('confirm'); return true; } }, pending);
  await run();
  assert.deepEqual(f.calls, ['open_external']);
  assert.deepEqual(f.opened, [pending.approvalUrl], 'the # part carrying the local port is passed through untouched');
});
