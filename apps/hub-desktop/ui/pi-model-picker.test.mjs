import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPiModelPicker } from './pi-model-picker.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture(t, overrides = {}) {
  const dom = new JSDOM('<body><input id="model" list="models" placeholder="既定のモデル"><datalist id="models"><option value="old/model">Previous</option></datalist><button>モデルを更新</button><p></p></body>');
  const f = { dom, input: dom.window.document.querySelector('input'), list: dom.window.document.querySelector('datalist'), refreshButton: dom.window.document.querySelector('button'), status: dom.window.document.querySelector('p'), current: true, context: { engine: 'pi', key: 'new' }, calls: [], fail: false, result: { models: ['cloud/model', 'ollama/local'], default: 'ollama/local', ready: ['ollama/local'], locations: { 'ollama/local': 'local', 'cloud/model': 'api' } } };
  f.input.value = overrides.value ?? 'user/new-model';
  f.controller = createPiModelPicker(dom.window.document, { input: f.input, list: f.list, refreshButton: f.refreshButton, status: f.status, getContext: () => f.context, isCurrent: () => f.current, invoke: async (...args) => { f.calls.push(args); if (f.fail) throw Error('private-provider-error'); return f.result; }, ...overrides });
  f.values = () => [...f.list.options].map(option => option.value);
  t.after(() => { f.controller.destroy(); dom.window.close(); }); return f;
}
test('initial detection is explicit refresh:false and keeps manual input while showing ready/location/default metadata', async t => {
  const f = fixture(t); await f.controller.ready; assert.deepEqual(f.calls, [['pi_work_models', { refresh: false }]]);
  assert.deepEqual(f.values(), ['ollama/local', 'cloud/model', 'user/new-model']); assert.equal(f.input.value, 'user/new-model');
  assert.match(f.list.options[0].label, /ローカル.*利用可能/); assert.match(f.list.options[1].label, /API.*要認証/); assert.match(f.list.options[2].label, /認証状態未確認/);
  assert.equal(f.input.placeholder, '既定: ollama/local'); assert.match(f.status.textContent, /2件.*利用可能 1件/); assert.equal(f.status.getAttribute('aria-live'), 'polite');
});
test('refresh button and public refresh force rediscovery and do not drop newly discovered or typed models', async t => {
  const f = fixture(t); await f.controller.ready; f.result = { models: ['provider/new-model'], ready: [], locations: null };
  f.refreshButton.click(); await tick(); assert.deepEqual(f.calls[1], ['pi_work_models', { refresh: true }]); assert.deepEqual(f.values(), ['provider/new-model', 'user/new-model']);
  f.input.value = 'typed/another'; await f.controller.refresh(); assert.equal(f.input.value, 'typed/another'); assert.ok(f.values().includes('typed/another')); assert.deepEqual(f.calls[2], ['pi_work_models', { refresh: true }]);
});
test('unknown auth state differs from a known empty ready set and missing location stays unknown', async t => {
  const f = fixture(t); f.result = { models: ['provider/model'] }; await f.controller.ready;
  assert.match(f.list.options[0].label, /場所未確認.*認証状態未確認/); assert.doesNotMatch(f.status.textContent, /利用可能 0件/);
  f.result = { models: ['provider/model'], ready: [] }; await f.controller.refresh(); assert.match(f.list.options[0].label, /要認証/); assert.match(f.status.textContent, /利用可能 0件/);
});
test('failure preserves previous list, placeholder and current input without exposing provider error details', async t => {
  const f = fixture(t); await f.controller.ready; const values = f.values(), placeholder = f.input.placeholder; f.input.value = 'typed/current'; f.fail = true;
  await f.controller.refresh(); assert.deepEqual(f.values(), values); assert.equal(f.input.value, 'typed/current'); assert.equal(f.input.placeholder, placeholder);
  assert.match(f.status.textContent, /一覧と入力を保持/); assert.doesNotMatch(f.status.textContent, /private-provider-error/); assert.equal(f.refreshButton.disabled, false);
});
test('parallel refresh calls return the same pending request and repeated clicks cannot duplicate discovery', async t => {
  const response = deferred(), f = fixture(t, { invoke: async (...args) => { f.calls.push(args); return response.promise; } });
  assert.equal(f.controller.refresh(), f.controller.ready); f.refreshButton.click(); await tick(); assert.equal(f.calls.length, 1); assert.equal(f.refreshButton.disabled, true);
  response.resolve(f.result); await f.controller.ready; assert.equal(f.refreshButton.disabled, false); assert.equal(f.list.getAttribute('aria-busy'), 'false');
});
test('typing during detection survives the response including a model absent from the catalog', async t => {
  const response = deferred(), f = fixture(t, { invoke: () => response.promise }); await tick(); f.input.value = 'my-provider/future-model';
  response.resolve(f.result); await f.controller.ready; assert.equal(f.input.value, 'my-provider/future-model'); assert.ok(f.values().includes('my-provider/future-model'));
});
test('DSH context retains free input and never uses Pi native discovery', async t => {
  const f = fixture(t, { getContext: () => ({ engine: 'dsh', key: 'resume-dsh' }) }); await f.controller.ready; await f.controller.refresh();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.values(), []); assert.equal(f.input.value, 'user/new-model'); assert.match(f.status.textContent, /自由入力/); assert.equal(f.refreshButton.disabled, true);
});
test('context or view changes discard stale catalogs and allow later explicit refresh', async t => {
  for (const change of [f => { f.current = false; }, f => { f.context.key = 'another-run'; }, f => { f.context.engine = 'dsh'; }]) {
    const response = deferred(), f = fixture(t, { invoke: () => response.promise }); await tick(); change(f); response.resolve(f.result); await f.controller.ready;
    assert.deepEqual(f.values(), []); assert.equal(f.input.value, 'user/new-model');
    if (f.context.engine === 'dsh') assert.match(f.status.textContent, /自由入力/);
    f.current = true; f.context = { engine: 'pi', key: 'again' }; await f.controller.refresh(); assert.ok(f.values().includes('ollama/local'));
  }
});
test('invalid IDs and malformed/bounded metadata preserve the previous catalog', async t => {
  const f = fixture(t); await f.controller.ready; const old = f.values();
  for (const result of [null, {}, { models: null }, { models: Array(4097).fill('provider/model') },
    ...['', '<img/src=x>', 'model\nnext', 'provider/model with space', 'x'.repeat(513), {}].map(id => ({ models: [id] })),
    { models: ['provider/model'], default: '<script>' }, { models: ['provider/model'], ready: null }, { models: ['provider/model'], ready: ['other/model'] }, { models: ['provider/model'], locations: [] }, { models: ['provider/model'], locations: { 'provider/model': '/private/path' } }]) {
    f.result = result; await f.controller.refresh(); assert.deepEqual(f.values(), old); assert.match(f.status.textContent, /再検出できません/); assert.equal(f.input.value, 'user/new-model');
  }
  assert.equal(f.list.querySelector('img,script'), null);
});
test('successful empty detection leaves manual values usable and deduplicates valid model IDs', async t => {
  const f = fixture(t); f.result = { models: [], ready: [], locations: null }; await f.controller.ready;
  assert.equal(f.input.value, 'user/new-model'); assert.match(f.status.textContent, /モデル名は自由入力/);
  f.result = { models: ['provider/model', 'provider/model'] }; await f.controller.refresh(); assert.deepEqual(f.values(), ['provider/model', 'user/new-model']);
});
test('destroy removes handlers and suppresses pending results or discovery not yet started', async t => {
  const response = deferred(), f = fixture(t, { invoke: () => response.promise }); await tick(); f.controller.destroy(); const old = f.values();
  response.resolve(f.result); await f.controller.ready; f.refreshButton.click(); await f.controller.refresh(); assert.deepEqual(f.values(), old);
  const immediate = fixture(t); immediate.controller.destroy(); await immediate.controller.ready; assert.deepEqual(immediate.calls, []);
});
test('malformed context appearing during a pending request fails closed without rejecting ready', async t => {
  const response = deferred(), f = fixture(t, { invoke: () => response.promise }); await tick(); f.context = { engine: 'other', key: 'bad' };
  response.resolve(f.result); await f.controller.ready; assert.deepEqual(f.values(), []); assert.match(f.status.textContent, /実行環境を確認できません/); assert.equal(f.input.value, 'user/new-model');
});
test('popover chip lists catalog models grouped by provider, filters by search, writes the picked value and closes on Escape', async t => {
  const dom = new JSDOM('<body><button id="chip"><span id="label"></span></button><div id="pop" hidden><input id="search" type="search"><div id="options"></div></div><input id="model"><datalist id="models"></datalist><button id="refresh"></button><p id="status"></p></body>');
  const d = dom.window.document, el = id => d.getElementById(id);
  const picker = createPiModelPicker(d, { input: el('model'), list: el('models'), refreshButton: el('refresh'), status: el('status'),
    ui: { chip: el('chip'), chipLabel: el('label'), popover: el('pop'), search: el('search'), options: el('options') },
    invoke: async () => ({ models: ['ollama/local', 'cloud/a', 'cloud/b'], ready: ['ollama/local'], default: 'ollama/local', locations: { 'ollama/local': 'local' } }) });
  t.after(() => { picker.destroy(); dom.window.close(); });
  await picker.ready;
  assert.equal(el('label').textContent, 'ollama/local'); assert.equal(el('pop').hidden, true);
  el('chip').click(); assert.equal(el('pop').hidden, false); assert.equal(el('chip').getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...el('options').querySelectorAll('.piw-model-group')].map(g => g.getAttribute('aria-label')).sort(), ['cloud', 'ollama']);
  el('search').value = 'cloud/b'; el('search').dispatchEvent(new dom.window.Event('input'));
  assert.deepEqual([...el('options').querySelectorAll('.piw-model-option')].map(o => o.dataset.model), ['cloud/b']);
  el('options').querySelector('.piw-model-option').click();
  assert.equal(el('model').value, 'cloud/b'); assert.equal(el('label').textContent, 'cloud/b'); assert.equal(el('pop').hidden, true);
  el('chip').click(); d.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(el('pop').hidden, true);
  el('chip').click(); el('options').querySelector('[data-model=""]').click(); assert.equal(el('model').value, ''); assert.equal(el('label').textContent, 'ollama/local');
});
