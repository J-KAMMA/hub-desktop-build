import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
  const run = new Function('invoke', 'window', 'desktopAccount', 'loadFeed', 'refreshDesktopAccount',
    `${cut('async function desktopLinkMissing() {')}\n${cut('async function connectDesktopAccount() {')}\nreturn connectDesktopAccount;`)(
    invoke, window, { state }, async () => { calls.push('loadFeed'); }, async () => { calls.push('refresh'); });
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
  assert.equal(f.calls.filter((name) => name.startsWith('confirm')).length, 2, 'one confirm to redo, one showing the code');
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
