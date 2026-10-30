import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createLocalDataPanel, createAiRecordsPanel, LOCAL_DATA_KINDS, WALLET_CONFIRMATION } from './local-data-settings.mjs';
import { renderPiWorkHistory } from './pi-work-history.mjs';
const { JSDOM } = createRequire(process.env.HUB_TEST_PACKAGE ?? new URL('../../../package.json', import.meta.url))('jsdom');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('./local-data-settings.mjs', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function make(reply = () => undefined) {
  const dom = new JSDOM('<body></body>');
  const document = dom.window.document;
  const calls = [];
  let opened = 0;
  const invoke = async (name, args) => { calls.push([name, args]); return reply(name, args); };
  const panel = createLocalDataPanel({ document, invoke, openWallet: () => { opened += 1; } });
  document.body.append(panel.element);
  const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent === text);
  const box = (key) => document.querySelector(`[data-local-data="${key}"] input[type=checkbox]`);
  const status = () => [...document.querySelectorAll('[role=status]')].map((node) => node.textContent).join(' ');
  return { dom, document, calls, button, box, status, opened: () => opened };
}

test('lists the six kinds as separate checkboxes and does nothing until confirmed', async () => {
  const f = make();
  assert.deepEqual(LOCAL_DATA_KINDS.map((kind) => kind.label), ['閲覧履歴', 'Cookie とサイトデータ', 'キャッシュ', 'AIの作業記録', 'AIの接続（キー）', 'Personal Node のデータ']);
  for (const kind of LOCAL_DATA_KINDS) assert.equal(f.box(kind.key).checked, false);
  assert.equal(f.button('選んだデータを消す').disabled, true);
  f.box('cookies').checked = true; f.box('cookies').dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(f.button('選んだデータを消す').disabled, false);
  f.button('選んだデータを消す').click();
  assert.equal(f.calls.length, 0);
  assert.match(f.document.querySelector('[role=alertdialog]').textContent, /Cookie とサイトデータ/);
  f.button('消す').click(); await tick(); await tick();
  assert.deepEqual(f.calls, [['browser_clear_browsing_data', { kinds: ['cookies', 'site_storage'] }]]);
  assert.match(f.status(), /消しました：Cookie とサイトデータ/);
  f.dom.window.close();
});

test('runs each chosen kind once, reports failures, and offers a restart for Node data', async () => {
  const f = make((name, args) => {
    if (name === 'byok_list') return { connections: [{ id: 'one' }, { id: 'two' }], cli: [] };
    if (name === 'pi_work_delete_all') throw new Error('busy');
    return undefined;
  });
  for (const key of ['history', 'cache', 'ai', 'keys', 'node']) { f.box(key).checked = true; f.box(key).dispatchEvent(new f.dom.window.Event('change')); }
  f.button('選んだデータを消す').click(); f.button('消す').click();
  for (let i = 0; i < 10; i += 1) await tick();
  assert.deepEqual(f.calls.map(([name, args]) => [name, args]), [
    ['browser_clear_browsing_data', { kinds: ['history', 'downloads_history'] }],
    ['browser_clear_browsing_data', { kinds: ['cache'] }],
    ['pi_work_delete_all', undefined],
    ['byok_list', undefined], ['byok_remove', { id: 'one' }], ['byok_remove', { id: 'two' }],
    ['local_data_schedule_wipe', { kinds: ['node'] }],
  ]);
  assert.match(f.status(), /消せなかったもの：AIの作業記録/);
  assert.match(f.status(), /次に起動したときに消えます/);
  assert.equal(f.box('ai').checked, true, 'a failed kind stays chosen');
  assert.equal(f.box('history').checked, false);
  f.button('今すぐ再起動').click(); await tick();
  assert.equal(f.calls.at(-1)[0], 'local_data_restart');
  assert.ok(!f.calls.some(([name]) => name === 'wallet_delete_key'), 'the wallet is never part of the bulk delete');
  f.dom.window.close();
});

test('the wallet key needs the backup step, the checkbox and the exact word', async () => {
  const f = make();
  const remove = f.button('ウォレットの鍵を消す');
  assert.equal(remove.closest('div[hidden]') !== null, true, 'the delete step is hidden until the backup note is read');
  assert.match(f.document.body.textContent, /書き出す機能がありません/);
  f.button('ウォレットを開く').click();
  assert.equal(f.opened(), 1);
  f.button('確かめたので次へ').click();
  assert.equal(remove.closest('div[hidden]'), null);
  const word = [...f.document.querySelectorAll('input[type=text]')].at(-1);
  const checked = remove.closest('.card').querySelector('input[type=checkbox]');
  word.value = WALLET_CONFIRMATION; word.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(remove.disabled, true, 'the word alone is not enough');
  checked.checked = true; checked.dispatchEvent(new f.dom.window.Event('change'));
  word.value = 'ウォレット'; word.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(remove.disabled, true);
  word.value = WALLET_CONFIRMATION; word.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(remove.disabled, false);
  remove.click(); await tick();
  assert.deepEqual(f.calls, [['wallet_delete_key', { confirmation: WALLET_CONFIRMATION, backedUp: true }]]);
  assert.match(f.status(), /ウォレットの鍵を消しました/);
  f.dom.window.close();
});

test('node key backup checks the password locally and names the risk', async () => {
  const f = make((name) => (name === 'node_key_backup_export' ? { saved: true } : name === 'node_key_backup_import' ? { imported: true, restartRequired: true } : undefined));
  assert.match(f.document.body.textContent, /ファイルとパスワードの両方を持つ人は、あなたの Node になりすませます/);
  const passwords = [...f.document.querySelectorAll('input[type=password]')];
  assert.equal(passwords.length, 3);
  passwords[0].value = 'short'; passwords[1].value = 'short';
  f.button('控えを書き出す').click(); await tick();
  assert.equal(f.calls.length, 0);
  assert.match(f.status(), /12文字以上/);
  passwords[0].value = 'a long enough password'; passwords[1].value = 'a long enough passwore';
  f.button('控えを書き出す').click(); await tick();
  assert.equal(f.calls.length, 0);
  passwords[1].value = 'a long enough password';
  f.button('控えを書き出す').click(); await tick(); await tick();
  assert.deepEqual(f.calls, [['node_key_backup_export', { password: 'a long enough password' }]]);
  assert.equal(passwords[0].value, '');
  passwords[2].value = 'a long enough password';
  f.button('控えを取り込む').click();
  assert.equal(f.calls.length, 1, 'import waits for confirmation');
  f.button('入れ替える').click(); await tick(); await tick();
  assert.deepEqual(f.calls.at(-1), ['node_key_backup_import', { password: 'a long enough password' }]);
  assert.match(f.status(), /再起動すると、取り込んだ鍵で動きます/);
  assert.ok(f.button('今すぐ再起動'));
  f.dom.window.close();
});

test('wrong backup password gets a plain message', async () => {
  const f = make((name) => { if (name === 'node_key_backup_import') throw 'backup_password_wrong'; });
  const passwords = [...f.document.querySelectorAll('input[type=password]')];
  passwords[2].value = 'whatever it is';
  f.button('控えを取り込む').click(); f.button('入れ替える').click(); await tick(); await tick();
  assert.match(f.status(), /パスワードが違うか、ファイルが壊れています/);
  f.dom.window.close();
});

test('AI settings can delete all work records after confirmation', async () => {
  const dom = new JSDOM('<body></body>'); const document = dom.window.document; const calls = []; let deleted = 0;
  const panel = createAiRecordsPanel({ document, invoke: async (name) => { calls.push(name); }, onDeleted: () => { deleted += 1; } });
  document.body.append(panel.element);
  assert.match(document.body.textContent, /90日/);
  assert.match(document.body.textContent, /20件/);
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'AIの作業記録をすべて消す').click();
  assert.deepEqual(calls, []);
  [...document.querySelectorAll('button')].find((b) => b.textContent === '消す').click(); await tick();
  assert.deepEqual(calls, ['pi_work_delete_all']);
  assert.equal(deleted, 1);
  dom.window.close();
});

test('history shows a two-step delete only under the selected finished session', () => {
  const dom = new JSDOM('<main></main>'); const document = dom.window.document; const deleted = [];
  const entry = (id, status) => ({ kind: 'hub', run: { id, workspace: '/w', prompt: id, model: 'm', status, startedAtMs: 1 } });
  const nodes = renderPiWorkHistory({ document, entries: [entry('a', 'done'), entry('b', 'running')], selectedId: 'a', onDelete: (value) => deleted.push(value.run.id) });
  document.querySelector('main').append(...nodes);
  const buttons = [...document.querySelectorAll('.piw-history-delete')];
  assert.equal(buttons.length, 1);
  buttons[0].click();
  assert.deepEqual(deleted, []);
  assert.equal(buttons[0].textContent, '本当に削除する');
  buttons[0].click();
  assert.deepEqual(deleted, ['a']);
  const running = renderPiWorkHistory({ document, entries: [entry('b', 'running')], selectedId: 'b', onDelete: () => {} });
  assert.equal(running.flatMap((node) => [...node.querySelectorAll('.piw-history-delete')]).length, 0);
  const none = renderPiWorkHistory({ document, entries: [entry('a', 'done')], selectedId: 'a' });
  assert.equal(none.flatMap((node) => [...node.querySelectorAll('.piw-history-delete')]).length, 0);
  dom.window.close();
});

test('the panel is mounted in この端末 before the cache block and uses no raw colors', () => {
  assert.match(html, /data-settings-panel="device"[\s\S]*id="settings-local-data"[\s\S]*id="settings-cache"/u);
  assert.match(app, /createLocalDataPanel\(/);
  assert.match(app, /createAiRecordsPanel\(/);
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|style\s*=/i);
});
