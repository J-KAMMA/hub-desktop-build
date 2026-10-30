import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderBrowserPrivacy } from './browser-privacy.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const find = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text);
function fixture(t) {
  const dom = new JSDOM('<main></main>'); t.after(() => dom.window.close());
  const document = dom.window.document, host = document.querySelector('main');
  const f = { dom, document, host, calls: [], errors: [], refreshed: 0, rows: [{ id: 1, active: true, private: false, url: 'https://example.test/path?q=private' }], command: async () => {} };
  const button = (text, run) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.onclick = run; return node; };
  f.panel = renderBrowserPrivacy({ document, host, button, tabs: () => f.rows, invoke: async (name, args) => { f.calls.push({ name, args }); return f.command(name, args); }, refresh: async () => f.refreshed++, report: error => f.errors.push(error) });
  f.click = text => { const node = find(host, text); assert.ok(node, text); return node.onclick(); };
  return f;
}
test('opening and previewing privacy tools performs no deletion; private tab is an explicit action', async t => {
  const f = fixture(t); assert.deepEqual(f.calls, []);
  assert.match(f.host.textContent, /復元情報は保存しません/); assert.match(f.host.textContent, /ブックマークとダウンロードは残ります/); assert.match(f.host.textContent, /匿名性は保証しません/);
  await f.click('プライベートタブを開く'); assert.deepEqual(f.calls, [{ name: 'browser_new_private_tab', args: { url: null } }]); assert.equal(f.refreshed, 1);
  f.calls.length = 0; f.click('閲覧履歴の削除を確認'); assert.deepEqual(f.calls, []); assert.match(f.host.textContent, /過去1時間のブラウザー閲覧履歴/);
  f.click('キャンセル'); assert.equal(find(f.host, '確認した内容を削除'), undefined); assert.deepEqual(f.calls, []);
});
test('hour day and all history require the second button with an exact preview timestamp', async t => {
  const f = fixture(t);
  for (const [range, duration] of [['hour', 3600000], ['day', 86400000], ['all', null]]) {
    const select = f.host.querySelector('select'); select.value = range; select.onchange();
    const before = Date.now(); f.click('閲覧履歴の削除を確認'); const after = Date.now();
    assert.equal(f.calls.length, 0); await f.click('確認した内容を削除');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].name, 'browser_clear_history');
    const since = f.calls[0].args.since;
    if (duration === null) assert.equal(since, null); else assert.ok(since >= before - duration && since <= after - duration);
    assert.match(f.host.textContent, /閲覧履歴を削除しました/); f.calls.length = 0;
  }
});
test('changing the range cancels old confirmation and old callbacks cannot mutate', async t => {
  const f = fixture(t); f.click('閲覧履歴の削除を確認'); const old = find(f.host, '確認した内容を削除');
  const select = f.host.querySelector('select'); select.value = 'day'; select.onchange(); await old.onclick(); assert.deepEqual(f.calls, []);
  f.click('閲覧履歴の削除を確認'); const cancelled = find(f.host, '確認した内容を削除'); f.click('キャンセル'); await cancelled.onclick(); assert.deepEqual(f.calls, []);
  select.value = 'unrecognized'; select.onchange(); f.click('閲覧履歴の削除を確認'); assert.equal(find(f.host, '確認した内容を削除'), undefined); assert.deepEqual(f.calls, []);
});
test('site deletion previews only the canonical active normal origin and excludes private page details', async t => {
  const f = fixture(t); assert.match(f.host.textContent, /https:\/\/example.test/); assert.doesNotMatch(f.host.textContent, /q=private|\/path/);
  f.click('このサイトのデータの削除を確認'); assert.equal(f.calls.length, 0); assert.match(f.host.textContent, /ログアウト/); assert.match(f.host.textContent, /共有するCookie/);
  await f.click('確認した内容を削除'); assert.deepEqual(f.calls, [{ name: 'browser_clear_site_data', args: { origin: 'https://example.test' } }]); assert.match(f.host.textContent, /サイトのデータを削除しました/);
});
test('changed active tab or committed origin invalidates captured deletion confirmation', async t => {
  const f = fixture(t);
  for (const replacement of [{ id: 2, active: true, private: false, url: 'https://example.test/' }, { id: 1, active: true, private: false, url: 'https://other.test/' }, { id: 1, active: true, private: true, url: 'https://example.test/' }]) {
    f.rows = [{ id: 1, active: true, private: false, url: 'https://example.test/' }]; f.panel.update(); f.click('このサイトのデータの削除を確認');
    f.rows = [replacement]; await f.click('確認した内容を削除'); assert.deepEqual(f.calls, []); assert.match(f.host.textContent, /サイトが変わりました/);
  }
});
test('private unknown invalid and internal tabs cannot request site deletion even via captured callback', t => {
  const f = fixture(t); const preview = find(f.host, 'このサイトのデータの削除を確認');
  for (const tab of [null, { private: true }, { private: undefined }, { id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { active: false }, { url: 'tauri://localhost/newtab.html' }, { url: 'http://tauri.localhost/newtab.html' }, { url: 'https://hub.jkamma.com/' }, { url: 'https://jkamma.com/' }, { url: 'https://account.jkamma.com/' }, { url: 'https://vault.hub.jkamma.com/' }, { url: 'https://user:password@example.test/' }, { url: 'file:///C:/private' }, { url: 'javascript:alert(1)' }, { url: 'not a URL' }]) {
    f.rows = tab ? [{ id: 1, active: true, private: false, url: 'https://example.test/', ...tab }] : []; f.panel.update();
    assert.equal(find(f.host, 'このサイトのデータの削除を確認').disabled, true); preview.onclick(); assert.equal(find(f.host, '確認した内容を削除'), undefined); assert.deepEqual(f.calls, []);
  }
});
test('the bundled main origin cannot request site data clearing in development', t => {
  const f = fixture(t); f.dom.reconfigure({ url: 'http://127.0.0.1:1420/' }); f.rows[0].url = 'http://127.0.0.1:1420/newtab.html'; f.panel.update();
  assert.equal(find(f.host, 'このサイトのデータの削除を確認').disabled, true); f.click('このサイトのデータの削除を確認'); assert.deepEqual(f.calls, []); assert.equal(find(f.host, '確認した内容を削除'), undefined);
});
test('one confirmed operation cannot be replayed during or after its pending promise', async t => {
  const f = fixture(t); let resolve; f.command = () => new Promise(done => { resolve = done; });
  f.click('このサイトのデータの削除を確認'); const confirm = find(f.host, '確認した内容を削除'), privateButton = find(f.host, 'プライベートタブを開く');
  const pending = confirm.onclick(); assert.equal(f.calls.length, 1); assert.equal(f.host.querySelector('[aria-busy="true"]') !== null, true);
  assert.ok([...f.host.querySelectorAll('button,select')].every(node => node.disabled)); await confirm.onclick(); await privateButton.onclick(); assert.equal(f.calls.length, 1);
  resolve(); await pending; await confirm.onclick(); assert.equal(f.calls.length, 1); assert.equal(f.refreshed, 1);
});
test('failure consumes confirmation without claiming deletion leaking details or retrying', async t => {
  const f = fixture(t); f.command = async () => { throw Error('C:/secret token=SECRET https://private.test'); };
  f.click('閲覧履歴の削除を確認'); const old = find(f.host, '確認した内容を削除'); await old.onclick(); await old.onclick();
  assert.equal(f.calls.length, 1); assert.equal(f.refreshed, 0); assert.equal(f.errors.length, 1); assert.match(f.host.textContent, /操作を完了できませんでした/);
  assert.doesNotMatch(f.host.textContent, /SECRET|private.test|C:\/secret|削除しました/); assert.doesNotMatch(f.errors[0].message, /SECRET/); assert.equal(find(f.host, '確認した内容を削除'), undefined);
});
test('UI never injects markup from a tab and explicit update invalidates confirmation', async t => {
  const f = fixture(t); f.rows[0].url = 'https://example.test/<img src=x onerror=alert(1)>'; f.panel.update(); assert.equal(f.host.querySelector('img'), null);
  f.click('このサイトのデータの削除を確認'); const old = find(f.host, '確認した内容を削除'); f.panel.update(); await old.onclick(); assert.deepEqual(f.calls, []);
});
