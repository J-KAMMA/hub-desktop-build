import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createOmnibox, omniboxAddress, omniboxRows } from './omnibox.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

test('addresses open, phrases search', () => {
  assert.equal(omniboxAddress('example.com'), 'https://example.com/');
  assert.equal(omniboxAddress('https://example.org/a?b=1'), 'https://example.org/a?b=1');
  assert.equal(omniboxAddress('猫 写真'), null);
  assert.equal(omniboxAddress('   '), null);
  assert.equal(omniboxAddress('javascript:alert(1)'), null);
});

test('rows: Hub first for phrases (or Web first when asked), open first for addresses, local pages after', () => {
  const pages = [{ url: 'https://neko.example/', title: '猫の図鑑' }, { url: 'https://dog.example/', title: '犬' }, { url: 'javascript:alert(1)', title: '猫' }];
  const phrase = omniboxRows('猫', { pages });
  assert.deepEqual(phrase.map(row => row.kind), ['hub', 'web', 'page']);
  assert.equal(phrase[0].query, '猫');
  assert.match(phrase[1].url, /^https:\/\/duckduckgo\.com\/\?q=/);
  assert.equal(phrase[2].url, 'https://neko.example/');
  assert.deepEqual(omniboxRows('猫', { hubFirst: false }).map(row => row.kind), ['web', 'hub']);
  assert.deepEqual(omniboxRows('example.com').map(row => row.kind), ['open', 'hub']);
  assert.deepEqual(omniboxRows(''), []);
});

function rig(t) {
  const dom = new JSDOM('<form id="f"><input id="q"></form>', { url: 'http://fixture.invalid/' }), { document } = dom.window;
  const calls = [];
  const omnibox = createOmnibox({ document, window: dom.window, form: document.querySelector('#f'), input: document.querySelector('#q'),
    loadPages: async () => [{ url: 'https://neko.example/', title: '猫の図鑑' }], onHubSearch: q => calls.push(['hub', q]), onOpen: url => calls.push(['open', url]) });
  t.after(() => dom.window.close());
  const input = document.querySelector('#q');
  const type = value => { input.value = value; input.dispatchEvent(new dom.window.Event('input')); };
  const key = name => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  return { dom, document, input, omnibox, calls, type, key };
}

test('typing shows rows; Enter runs the selected row; arrows move; Escape hides; nothing is sent while typing', async t => {
  const r = rig(t); r.type('猫');
  const list = r.document.querySelector('#toolbar-suggestions');
  assert.equal(list.hidden, false); assert.deepEqual(r.calls, []);
  assert.equal(r.input.getAttribute('aria-activedescendant'), 'toolbar-suggestion-0');
  r.key('ArrowDown'); assert.equal(r.input.getAttribute('aria-activedescendant'), 'toolbar-suggestion-1');
  r.key('Enter'); assert.equal(r.calls.length, 1); assert.equal(r.calls[0][0], 'open'); assert.match(r.calls[0][1], /duckduckgo\.com/);
  r.type('猫'); r.key('Enter'); assert.deepEqual(r.calls.at(-1), ['hub', '猫']);
  r.type('猫'); r.key('Escape'); assert.equal(list.hidden, true);
  await new Promise(resolve => setImmediate(resolve)); r.type('猫');
  assert.ok([...list.querySelectorAll('.omnibox-row')].some(row => row.dataset.kind === 'page'));
});

test('a Hub result opens the item itself (click and Enter); unknown kinds fall back to a title search', async t => {
  const dom = new JSDOM('<form id="f"><input id="q"></form>', { url: 'http://fixture.invalid/' }), { document } = dom.window;
  const calls = [];
  const body = { communities: [{ id: 'c1', name: '猫の会' }], tags: [{ title: '猫タグ' }] };
  createOmnibox({ document, window: dom.window, form: document.querySelector('#f'), input: document.querySelector('#q'), debounceMs: 0,
    searchHub: async () => body,
    onHubSearch: q => calls.push(['hub', q]), onOpen: url => calls.push(['open', url]),
    onOpenResult: (group, record) => { if (group !== 'communities') return false; calls.push(['item', group, record.id]); return true; } });
  t.after(() => dom.window.close());
  const input = document.querySelector('#q');
  input.value = '猫'; input.dispatchEvent(new dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 30));
  const rows = [...document.querySelectorAll('.omnibox-row')];
  const community = rows.find(row => row.dataset.kind === 'result' && row.textContent.includes('猫の会'));
  const tag = rows.find(row => row.dataset.kind === 'result' && row.textContent.includes('猫タグ'));
  assert.ok(community && tag);
  community.click();
  assert.deepEqual(calls.at(-1), ['item', 'communities', 'c1']);
  input.value = '猫'; input.dispatchEvent(new dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 30));
  [...document.querySelectorAll('.omnibox-row')].find(row => row.textContent.includes('猫タグ')).click();
  assert.deepEqual(calls.at(-1), ['hub', '猫タグ']);
  input.value = '猫'; input.dispatchEvent(new dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 30));
  const idx = [...document.querySelectorAll('.omnibox-row')].findIndex(row => row.textContent.includes('猫の会'));
  for (let i = 0; i < idx; i++) input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(calls.at(-1), ['item', 'communities', 'c1']);
});

test('game results from Hub search appear as ゲーム rows', async () => {
  const { hubResultRows } = await import('./omnibox.mjs');
  const rows = hubResultRows({ games: [{ slug: 'g1', title: '星のゲーム' }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, 'games');
  assert.equal(rows[0].detail, 'ゲーム');
});
