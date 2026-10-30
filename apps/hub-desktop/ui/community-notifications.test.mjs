import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCommunityNotifications } from './community-notifications.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const stamp = '2026-10-06T12:00:00.000Z', communityId = 'community1';
const prefs = () => ({ mentions: true, replies: true, guideUpdates: false, governance: true, membership: false });
const page = () => ({ viewerId: 'viewer1', communityId, preferences: prefs(), channels: [{ channelId: 'channel1', name: '雑談', mode: 'mentions', mutedUntil: null }, { channelId: 'channel2', name: 'お知らせ', mode: 'none', mutedUntil: stamp }] });
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture(t, options = {}) {
  const { invoke: providedInvoke, ...controllerOptions } = options;
  const dom = new JSDOM('<body></body>'), f = { dom, data: page(), key: 'generation1', current: true, calls: [], callbacks: [], hook: null };
  f.backend = async (command, args) => {
    if (command === 'hub_detail') return structuredClone(f.data);
    if (args.action === 'read_all_community_channels') return { viewerId: f.data.viewerId, communityId, read: true, updatedAt: stamp };
    f.data.preferences = Object.fromEntries(Object.keys(prefs()).map(key => [key, args.options[key]]));
    for (const channel of f.data.channels) { const input = args.options.channels.find(item => item.channelId === channel.channelId); if (input) { channel.mode = input.mode; channel.mutedUntil = null; } }
    return { viewerId: f.data.viewerId, communityId, preferences: { ...f.data.preferences } };
  };
  f.widget = createCommunityNotifications({ document: dom.window.document, communityId, getAccount: () => f.key, isCurrent: () => f.current, canReadAll: true, onReadAll: receipt => f.callbacks.push(receipt), invoke: async (...args) => { f.calls.push(structuredClone(args)); return providedInvoke ? providedInvoke(...args) : f.hook ? f.hook(...args) : f.backend(...args); }, ...controllerOptions });
  f.root = f.widget.element; if (options.mounted !== false) dom.window.document.body.append(f.root);
  f.text = () => f.root.textContent; f.button = action => f.root.querySelector(`button[data-action="${action}"]`); f.writes = () => f.calls.filter(([command]) => command === 'hub_client_action');
  f.flag = (name, value) => { const input = f.root.querySelector(`input[name="${name}"]`); input.checked = value; input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  f.mode = (channelId, value) => { const select = f.root.querySelector(`select[data-channel-id="${channelId}"]`); select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  f.wait = async () => { await tick(); const end = Date.now() + 1500; while (f.root.getAttribute('aria-busy') === 'true') { if (Date.now() > end) throw Error('pending controller'); await tick(); } };
  f.click = async action => { f.button(action).click(); await f.wait(); };
  t.after(() => { f.widget.destroy(); dom.window.close(); }); return f;
}

test('first GET is closed and lazy details contains five bools, channel names and temporary-mute effect', async t => {
  const f = fixture(t); await f.widget.ready; assert.deepEqual(f.calls, [['hub_detail', { name: 'community_notifications', ids: [communityId] }]]);
  assert.equal(f.root.querySelector('details').open, false); assert.equal(f.root.querySelectorAll('input[type="checkbox"]').length, 5); assert.equal(f.root.querySelectorAll('select').length, 2); assert.match(f.text(), /雑談.*お知らせ.*一時ミュート期限/); assert.match(f.text(), /一時ミュートも解除/); assert.doesNotMatch(f.text(), /channel1|channel2/); assert.equal(f.writes().length, 0); assert.ok([...f.root.querySelectorAll('button')].every(button => button.type === 'button'));
});

test('save sends only canonical five bools and IDs/modes, then same-viewer GET confirms desired modes and cleared mute', async t => {
  const f = fixture(t); await f.widget.ready; f.flag('replies', false); f.flag('guideUpdates', true); f.mode('channel1', 'all'); await f.click('save');
  assert.deepEqual(f.writes()[0], ['hub_client_action', { action: 'update_community_notifications', target: communityId, options: { mentions: true, replies: false, guideUpdates: true, governance: true, membership: false, channels: [{ channelId: 'channel1', mode: 'all' }, { channelId: 'channel2', mode: 'none' }] } }]);
  assert.equal(f.calls.at(-1)[0], 'hub_detail'); assert.match(f.text(), /通知設定の保存を確認しました/); assert.equal(f.root.querySelector('input[name="replies"]').checked, false); assert.doesNotMatch(f.text(), /一時ミュート期限/);
});

test('successful read-all uses empty options, callback only confirmed ack and never asserts unread zero', async t => {
  const f = fixture(t); await f.widget.ready; f.flag('replies', false); await f.click('read-all');
  assert.deepEqual(f.writes(), [['hub_client_action', { action: 'read_all_community_channels', target: communityId, options: {} }]]); assert.deepEqual(f.callbacks, [{ viewerId: 'viewer1', communityId, read: true, updatedAt: stamp }]);
  assert.match(f.text(), /閲覧できるチャンネルを既読にしました。新しく届く投稿は対象外です。/); assert.doesNotMatch(f.text(), /未読ゼロ|未読0|未読件数|すべて既読になりました/); assert.doesNotMatch(f.root.lastElementChild.textContent, /2026-10-06/); assert.equal(f.root.querySelector('input[name="replies"]').checked, false);
});

test('GET403 is independent of read-all eligibility, ack pins viewer and later contradictory GET invalidates', async t => {
  const f = fixture(t); f.hook = (command, args) => { if (command === 'hub_detail') throw 'notification_get_denied:403'; return f.backend(command, args); }; await f.widget.ready;
  assert.equal(f.button('save').disabled, true); assert.equal(f.button('read-all').disabled, false); await f.click('read-all'); assert.equal(f.callbacks.length, 1);
  f.hook = () => ({ ...page(), viewerId: 'other' }); await f.click('recheck'); assert.match(f.text(), /本人の一致を確認できません/); assert.equal(f.root.querySelectorAll('input,select').length, 0); assert.equal(f.button('read-all').disabled, true);
});

test('read-all defaults denied and requires explicit boolean eligibility, connection and mounted current root', async t => {
  for (const options of [{ canReadAll: false }, { canReadAll: 'true' }, { getAccount: () => null }, { communityId: 'community1\n' }, { mounted: false }, { isCurrent: () => false }]) {
    const f = fixture(t, options); await f.widget.ready; f.button('read-all').dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(f.writes().length, 0);
    if (options.getAccount || options.communityId || options.mounted === false || options.isCurrent) assert.equal(f.calls.length, 0);
  }
});

test('strict GET metadata rejects malformed flags, channels, duplicate IDs, unknown fields and terminal-newline IDs', async t => {
  const base = page();
  for (const value of [null, { ...base, viewerId: 'viewer1\n' }, { ...base, communityId: 'other' }, { ...base, extra: true }, { ...base, preferences: { ...prefs(), mentions: 1 } }, { ...base, preferences: { mentions: true } }, { ...base, preferences: { ...prefs(), actor: 'other' } }, { ...base, channels: Array(1) }, { ...base, channels: [base.channels[0], base.channels[0]] }, ...[{ channelId: '../id' }, { channelId: 'id\n' }, { mode: ['all'] }, { mode: 'constructor' }, { mutedUntil: '' }, { mutedUntil: '\u0000' }, { mutedUntil: 'invalid' }, { name: '' }, { name: '  \t\n ' }, { name: 'x'.repeat(1001) }, { name: 'x\u0000' }, { name: '\ud800' }, { actor: 'other' }].map(patch => ({ ...base, channels: [{ ...base.channels[0], ...patch }] }))]) {
    const f = fixture(t, { invoke: () => value }); await f.widget.ready; assert.match(f.text(), /取得・確認できません/); assert.equal(f.button('save').disabled, true); assert.equal(f.root.querySelectorAll('input,select').length, 0);
  }
});

test('legacy long names/newlines/tabs and intact emoji remain safe text; 100 channels and ID128 accepted', async t => {
  const value = page(); value.channels = Array.from({ length: 100 }, (_, i) => ({ channelId: `${'c'.repeat(125)}${String(i).padStart(3, '0')}`, name: `${'あ'.repeat(992)}😀\n\t名前`, mode: 'mentions', mutedUntil: null }));
  const f = fixture(t, { invoke: () => value }); await f.widget.ready; assert.equal(f.root.querySelectorAll('select').length, 100); assert.ok(f.text().includes('最大100チャンネル')); assert.equal(f.button('save').disabled, false);
  const malicious = page(); malicious.channels[0].name = '<img src=x onerror=evil()><script>evil()</script>'; const safe = fixture(t, { invoke: () => malicious }); await safe.widget.ready; assert.equal(safe.root.querySelectorAll('img,script').length, 0); assert.match(safe.text(), /<script>/);
});

test('empty channel set still allows five community flags to save', async t => {
  const f = fixture(t); f.data.channels = []; await f.widget.ready; assert.match(f.text(), /設定できるチャンネルはありません/); f.flag('mentions', false); await f.click('save'); assert.deepEqual(f.writes()[0][1].options.channels, []); assert.match(f.text(), /保存を確認しました/);
});

test('unknown save retains drafts, locks writes and rechecks readonly before explicit editing resumes', async t => {
  const f = fixture(t); await f.widget.ready; f.flag('mentions', false); f.mode('channel1', 'all'); f.hook = (command, args) => { if (command === 'hub_client_action') throw Error('private transport failure'); return f.backend(command, args); };
  await f.click('save'); assert.match(f.text(), /保存結果が不明/); assert.doesNotMatch(f.text(), /private transport/); assert.equal(f.root.querySelector('input[name="mentions"]').checked, false); assert.equal(f.root.querySelector('select').value, 'all'); assert.equal(f.button('save').disabled, true); assert.equal(f.button('read-all').disabled, true);
  await f.click('recheck'); assert.equal(f.writes().length, 1); assert.match(f.text(), /希望した保存結果とは一致していません/); assert.equal(f.button('save').disabled, true); await f.click('resume'); assert.equal(f.button('save').disabled, false); assert.equal(f.root.querySelector('input[name="mentions"]').checked, false);
});

test('unknown save can reconcile to desired GET without repeat write or discarding the confirmed settings', async t => {
  const f = fixture(t); await f.widget.ready; f.flag('mentions', false); f.mode('channel1', 'all'); f.hook = async (command, args) => { const value = await f.backend(command, args); if (command === 'hub_client_action') throw Error('timeout after applying'); return value; };
  await f.click('save'); await f.click('recheck'); assert.equal(f.writes().length, 1); assert.match(f.text(), /希望した内容と一致しています/); assert.equal(f.button('save').disabled, false);
});

test('known save denial permits correction; malformed rejection/newline/5xx remains unknown', async t => {
  for (const message of ['community_preferences_rejected:403:通知設定を保存できませんでした。', 'community_preferences_rejected:400:通知設定を保存できませんでした。']) {
    const f = fixture(t); await f.widget.ready; f.flag('replies', false); f.hook = () => { throw message; }; await f.click('save'); assert.match(f.text(), /保存が拒否/); assert.equal(f.button('save').disabled, false); assert.equal(f.root.querySelector('input[name="replies"]').checked, false);
  }
  for (const message of ['community_preferences_rejected:500:通知設定を保存できませんでした。', 'community_preferences_rejected:403\n:通知設定を保存できませんでした。', 'community_preferences_rejected:403:通知設定を保存できませんでした。\n', 'desktop_not_connected']) {
    const f = fixture(t); await f.widget.ready; f.hook = () => { throw message; }; await f.click('save'); assert.match(f.text(), /保存結果が不明/); assert.equal(f.button('save').disabled, true);
  }
});

test('ACK alone cannot confirm channel modes or mute clearing; mismatched receipt/community/viewer never claims saved', async t => {
  for (const patch of [{ communityId: 'other' }, { viewerId: 'other' }, { preferences: { ...prefs(), mentions: 'true' } }, { preferences: { ...prefs(), mentions: false } }, { extra: true }, {}]) {
    const f = fixture(t); await f.widget.ready; f.mode('channel1', 'all'); f.hook = command => command === 'hub_client_action' ? { viewerId: 'viewer1', communityId, preferences: prefs(), ...patch } : f.data;
    await f.click('save'); assert.doesNotMatch(f.text(), /保存を確認しました/); assert.equal(f.button('save').disabled, true);
  }
});

test('read-all invalid receipts cannot callback; unknown outcome requires recheck and explicit new-operation unlock', async t => {
  for (const patch of [{ communityId: 'other' }, { viewerId: 'viewer1\n' }, { viewerId: 'other' }, { read: false }, { read: 'true' }, { updatedAt: 'never' }, { updatedAt: `${stamp}\n` }, { extra: true }]) {
    const f = fixture(t); await f.widget.ready; f.hook = () => ({ viewerId: 'viewer1', communityId, read: true, updatedAt: stamp, ...patch }); await f.click('read-all'); assert.equal(f.callbacks.length, 0); assert.equal(f.button('read-all').disabled, true);
  }
  const f = fixture(t); f.hook = command => { if (command === 'hub_detail') throw '403'; throw Error('read timeout'); }; await f.widget.ready; await f.click('read-all'); assert.match(f.text(), /一括既読の結果が不明/); assert.equal(f.button('new-read').hidden, true); await f.click('recheck'); assert.equal(f.callbacks.length, 0); assert.match(f.text(), /成否は確認できません.*新しい一括既読操作/); await f.click('new-read'); assert.equal(f.button('read-all').disabled, false); assert.equal(f.writes().length, 1);
});

test('confirmed read-all callback failure preserves ACK and drafts; known denied read-all is retryable', async t => {
  const f = fixture(t, { onReadAll: () => { throw Error('refresh private error'); } }); await f.widget.ready; f.flag('membership', true); await f.click('read-all'); assert.match(f.text(), /既読操作は完了しましたが、チャンネル一覧を更新できませんでした。コミュニティを開き直してください。/); assert.equal(f.root.querySelector('input[name="membership"]').checked, true); assert.equal(f.button('read-all').disabled, false);
  const denied = fixture(t); await denied.widget.ready; denied.hook = () => { throw 'community_read_all_rejected:403:既読状態を更新できませんでした。'; }; await denied.click('read-all'); assert.equal(denied.callbacks.length, 0); assert.match(denied.text(), /更新が拒否/); assert.equal(denied.button('read-all').disabled, false);
});

test('double clicks across save/read/recheck are suppressed while pending, read-only retry failure retains draft', async t => {
  const f = fixture(t), gate = deferred(); await f.widget.ready; f.flag('replies', false); f.hook = () => gate.promise;
  f.button('save').click(); for (const action of ['save', 'read-all', 'recheck']) f.button(action).dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(f.calls.length, 2); gate.reject(Error('timeout')); await f.wait();
  f.hook = () => { throw Error('read failed'); }; await f.click('recheck'); assert.equal(f.root.querySelector('input[name="replies"]').checked, false); assert.equal(f.button('save').disabled, true); assert.equal(f.button('resume').hidden, true);
});

test('reload preserves draft and removes channel IDs that are no longer visible before a new write', async t => {
  const f = fixture(t); await f.widget.ready; f.flag('replies', false); f.mode('channel1', 'all'); f.data.channels = [{ channelId: 'channel3', name: '新しいチャンネル', mode: 'mentions', mutedUntil: null }]; await f.click('recheck');
  assert.equal(f.root.querySelector('input[name="replies"]').checked, false); assert.equal(f.root.querySelectorAll('select').length, 1); await f.click('save'); assert.deepEqual(f.writes()[0][1].options.channels, [{ channelId: 'channel3', mode: 'mentions' }]);
});

test('account change immediately clears private inputs and old ACK cannot issue GET or callback', async t => {
  for (const action of ['save', 'read-all']) {
    const f = fixture(t), gate = deferred(); await f.widget.ready; f.flag('mentions', false); f.hook = () => gate.promise; f.button(action).click(); f.key = 'generation2'; f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));
    assert.equal(f.root.querySelectorAll('input,select').length, 0); gate.resolve(action === 'save' ? { viewerId: 'viewer1', communityId, preferences: { ...prefs(), mentions: false } } : { viewerId: 'viewer1', communityId, read: true, updatedAt: stamp }); await tick(); await tick(); assert.equal(f.calls.length, 2); assert.equal(f.callbacks.length, 0); assert.doesNotMatch(f.text(), /保存を確認しました|チャンネルを既読にしました/);
  }
});

test('view/destroy/root-detach suppress late result and detached controls cannot invoke', async t => {
  for (const mode of ['view', 'destroy', 'detach']) {
    const gate = deferred(), f = fixture(t, { invoke: () => gate.promise }); await tick(); const read = f.button('read-all'); if (mode === 'view') f.current = false; else if (mode === 'destroy') f.widget.destroy(); else f.root.remove();
    gate.resolve(page()); await f.widget.ready; assert.equal(f.root.querySelectorAll('input,select').length, 0); read.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(f.writes().length, 0); if (mode === 'destroy') { assert.equal(f.text(), ''); f.widget.destroy(); }
  }
});

test('malformed mode draft never sends and caller-owned GET object mutation cannot alter saved IDs/flags', async t => {
  const raw = page(), f = fixture(t, { invoke: () => raw }); await f.widget.ready; f.mode('channel1', 'unknown'); await f.click('save'); assert.equal(f.writes().length, 0); assert.match(f.text(), /入力を確認/);
  f.mode('channel1', 'all'); raw.channels[0].channelId = 'injected'; raw.preferences.membership = true; await f.click('save'); assert.deepEqual(f.writes()[0][1].options.channels.map(item => item.channelId), ['channel1', 'channel2']); assert.equal(f.writes()[0][1].options.membership, false);
});

test('100/101/332 and 1001 valid channels are received without truncation; DOM stays at 100 per page', async t => {
  for (const count of [100, 101, 332, 1001]) {
    const f = fixture(t); f.data.channels = Array.from({ length: count }, (_, i) => ({ channelId: `channel${i}`, name: `チャンネル${i}`, mode: 'mentions', mutedUntil: null })); await f.widget.ready;
    assert.equal(f.root.querySelectorAll('select').length, 100); assert.equal(f.button('next').disabled, count === 100); assert.ok(f.text().includes(` / ${count}チャンネル`));
    if (count > 100) { await f.click('next'); assert.equal(f.root.querySelector('select').dataset.channelId, 'channel100'); assert.equal(f.root.querySelectorAll('select').length, Math.min(100, count - 100)); assert.equal(f.calls.length, 1); }
    if (count === 332) { await f.click('next'); await f.click('next'); assert.equal(f.root.querySelectorAll('select').length, 32); assert.equal(f.button('next').disabled, true); assert.equal(f.root.querySelector('select').dataset.channelId, 'channel300'); }
  }
});

test('paging requires save/cancel of draft; PATCH contains only current page and leaves other modes/mutes unchanged', async t => {
  const f = fixture(t); f.data.channels = Array.from({ length: 101 }, (_, i) => ({ channelId: `channel${i}`, name: `チャンネル${i}`, mode: 'mentions', mutedUntil: stamp })); await f.widget.ready;
  f.mode('channel0', 'all'); assert.equal(f.button('next').disabled, true); assert.equal(f.button('cancel').disabled, false); await f.click('cancel'); assert.equal(f.button('next').disabled, false); assert.equal(f.root.querySelector('select').value, 'mentions');
  await f.click('next'); f.mode('channel100', 'none'); f.flag('membership', true); assert.equal(f.button('previous').disabled, true); await f.click('save');
  assert.deepEqual(f.writes()[0][1].options.channels, [{ channelId: 'channel100', mode: 'none' }]); assert.equal(f.writes()[0][1].options.membership, true); assert.equal(f.data.channels[0].mutedUntil, stamp); assert.equal(f.data.channels[100].mutedUntil, null);
  await f.click('previous'); assert.equal(f.root.querySelector('input[name="membership"]').checked, true); assert.equal(f.root.querySelector('select').value, 'mentions');
  f.mode('channel0', 'all'); await f.click('save'); assert.equal(f.writes()[1][1].options.channels.length, 100); assert.equal(f.writes()[1][1].options.channels[99].channelId, 'channel99'); await f.click('next'); assert.equal(f.root.querySelector('select').value, 'none');
});

test('UTF8 response above 1 MiB is invalid even when character count and all individual fields are legal', async t => {
  const raw = page(); raw.channels = Array.from({ length: 400 }, (_, i) => ({ channelId: `channel${i}`, name: 'あ'.repeat(1000), mode: 'mentions', mutedUntil: null }));
  assert.ok(JSON.stringify(raw).length < 1048576); assert.ok(new TextEncoder().encode(JSON.stringify(raw)).length > 1048576);
  const f = fixture(t, { invoke: () => raw }); await f.widget.ready; assert.match(f.text(), /取得・確認できません/); assert.equal(f.root.querySelectorAll('select').length, 0); assert.equal(f.button('save').disabled, true);
});
