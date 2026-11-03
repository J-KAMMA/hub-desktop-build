import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { WEB_SEARCH_KEY, WEB_SEARCH_ENGINES, getWebSearchEngine, setWebSearchEngine, webSearchUrl, webSearchLabel, createWebSearchSetting } from './web-search.mjs';
import { createOmnibox, omniboxRows, hubResultRows } from './omnibox.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const store = (initial = {}) => { const data = { ...initial }; return { getItem: k => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); }, data }; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('engine setting: four choices, DuckDuckGo default, hub.desktop. key, bad values ignored, throwing storage safe', () => {
  assert.deepEqual(Object.keys(WEB_SEARCH_ENGINES), ['duckduckgo', 'brave', 'google', 'bing']);
  for (const engine of Object.values(WEB_SEARCH_ENGINES)) assert.equal(engine.template.split('{q}').length, 2);
  assert.ok(WEB_SEARCH_KEY.startsWith('hub.desktop.'));
  assert.equal(getWebSearchEngine(store()), 'duckduckgo');
  assert.equal(getWebSearchEngine(store({ [WEB_SEARCH_KEY]: 'nope' })), 'duckduckgo');
  assert.equal(getWebSearchEngine(store({ [WEB_SEARCH_KEY]: '__proto__' })), 'duckduckgo');
  const s = store();
  assert.equal(setWebSearchEngine(s, 'brave'), true);
  assert.equal(s.data[WEB_SEARCH_KEY], 'brave');
  assert.equal(getWebSearchEngine(s), 'brave');
  assert.equal(setWebSearchEngine(s, 'evil'), false);
  const broken = { getItem() { throw Error('x'); }, setItem() { throw Error('x'); } };
  assert.equal(getWebSearchEngine(broken), 'duckduckgo');
  assert.equal(setWebSearchEngine(broken, 'bing'), false);
  assert.equal(getWebSearchEngine(null), 'duckduckgo');
});

test('URL templates encode the query', () => {
  assert.equal(webSearchUrl('duckduckgo', '猫 & 犬?'), 'https://duckduckgo.com/?q=' + encodeURIComponent('猫 & 犬?'));
  assert.equal(webSearchUrl('brave', 'a b'), 'https://search.brave.com/search?q=a%20b');
  assert.equal(webSearchUrl('google', 'x'), 'https://www.google.com/search?q=x');
  assert.equal(webSearchUrl('bing', '$&'), 'https://www.bing.com/search?q=%24%26');
  assert.equal(webSearchUrl('bing', '   '), null);
  assert.equal(webSearchUrl('nope', 'x'), null);
  assert.equal(webSearchLabel('brave'), 'Brave');
});

test('settings row: chips choose the engine and notify', () => {
  const dom = new JSDOM('<body></body>'); const s = store(); const seen = [];
  const row = createWebSearchSetting({ document: dom.window.document, storage: s, onChange: id => seen.push(id) });
  dom.window.document.body.append(row.element);
  const chips = [...row.element.querySelectorAll('[role=radio]')];
  assert.deepEqual(chips.map(c => c.textContent), ['DuckDuckGo', 'Brave', 'Google', 'Bing']);
  assert.equal(chips[0].getAttribute('aria-checked'), 'true');
  chips[1].click();
  assert.deepEqual(seen, ['brave']); assert.equal(s.data[WEB_SEARCH_KEY], 'brave');
  assert.equal(chips[1].getAttribute('aria-checked'), 'true'); assert.equal(chips[0].getAttribute('aria-checked'), 'false');
  assert.equal(row.element.querySelector('[role=radiogroup]').getAttribute('aria-label'), 'Web検索');
  dom.window.close();
});

const body = {
  posts: [{ id: 'p1', body: '猫の投稿' }, { id: 'p2', body: '二つ目の投稿' }],
  articles: [{ id: 'a1', title: '猫の記事' }],
  coreEntities: [{ sourceGroup: 'videos', ref: { id: 'v1' }, title: '猫の動画' }, { sourceGroup: 'communities', ref: { id: 'c1' }, name: '猫部' }, { sourceGroup: 'weird', title: '無視' }],
  hubpedia: [{ title: '猫' }], listings: [{ title: '猫缶' }], tags: [{ name: '猫タグ' }], tracks: [{ title: '猫の曲' }],
};

test('Hub results: at most 5, mixed kinds with type labels', () => {
  const rows = hubResultRows(body, 5);
  assert.equal(rows.length, 5);
  assert.ok(new Set(rows.map(r => r.detail)).size >= 4);
  assert.ok(rows.every(r => r.kind === 'result'));
  const all = hubResultRows(body, 20).map(r => r.detail);
  for (const label of ['投稿', '記事', '動画', '音楽', 'コミュニティ', 'マーケット', 'Hubpedia', 'タグ']) assert.ok(all.includes(label), label);
  assert.ok(!hubResultRows(body, 20).some(r => r.title === '無視'));
  assert.deepEqual(hubResultRows(null), []);
});

test('rows: Hub row, Web row for the chosen engine, results; addresses skip the Web row', () => {
  const hubResults = hubResultRows(body, 5);
  const rows = omniboxRows('猫', { engine: 'brave', hubResults });
  assert.deepEqual(rows.slice(0, 2).map(r => r.kind), ['hub', 'web']);
  assert.equal(rows[0].title, '「猫」をHubで探す');
  assert.equal(rows[1].title, '「猫」をBraveで探す');
  assert.equal(rows[1].url, 'https://search.brave.com/search?q=' + encodeURIComponent('猫'));
  assert.equal(rows.length, 7);
  const address = omniboxRows('example.com', { hubResults });
  assert.deepEqual(address.map(r => r.kind), ['open', 'hub']);
});

function rig(t, { engine = 'duckduckgo', searchHub } = {}) {
  const dom = new JSDOM('<form id="f"><input id="q"></form>', { url: 'http://fixture.invalid/' }), { document } = dom.window;
  const calls = [], queries = [];
  const omnibox = createOmnibox({ document, window: dom.window, form: document.querySelector('#f'), input: document.querySelector('#q'), getEngine: () => engine, debounceMs: 20,
    searchHub: searchHub ?? (async q => { queries.push(q); return body; }), onHubSearch: q => calls.push(['hub', q]), onOpen: url => calls.push(['open', url]) });
  t.after(() => dom.window.close());
  const input = document.querySelector('#q');
  const type = value => { input.value = value; input.dispatchEvent(new dom.window.Event('input')); };
  const key = (name, extra = {}) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra }));
  const options = () => [...document.querySelectorAll('#toolbar-suggestions [role=option]')];
  return { document, input, omnibox, calls, queries, type, key, options };
}

test('dropdown: roles, debounce, Hub results with labels, two action rows', async t => {
  const r = rig(t);
  r.type('猫');
  assert.equal(r.input.getAttribute('role'), 'combobox');
  assert.equal(r.document.querySelector('#toolbar-suggestions').getAttribute('role'), 'listbox');
  assert.deepEqual(r.options().map(o => o.dataset.kind), ['hub', 'web']);
  assert.deepEqual(r.queries, []);
  r.type('猫'); await wait(5); r.type('猫'); await wait(60);
  assert.deepEqual(r.queries, ['猫']);
  const rows = r.options();
  assert.equal(rows[0].textContent.includes('「猫」をHubで探す'), true);
  assert.equal(rows[1].textContent.includes('「猫」をDuckDuckGoで探す'), true);
  assert.equal(rows.filter(o => o.dataset.kind === 'result').length, 5);
  assert.ok(rows.filter(o => o.dataset.kind === 'result').every(o => o.querySelector('.omnibox-kind').textContent.length > 0));
  assert.equal(r.input.getAttribute('aria-expanded'), 'true');
});

test('dropdown: stale Hub answers are dropped', async t => {
  const resolvers = {};
  const r = rig(t, { searchHub: q => new Promise(resolve => { resolvers[q] = resolve; }) });
  r.type('a'); await wait(40);
  r.type('ab'); await wait(40);
  resolvers.ab({ posts: [{ id: '1', body: 'ab-result' }] }); await wait(5);
  resolvers.a({ posts: [{ id: '2', body: 'a-result' }] }); await wait(5);
  const text = r.options().map(o => o.textContent).join('|');
  assert.ok(text.includes('ab-result')); assert.ok(!text.includes('a-result'));
});

test('keyboard: arrows move, Enter = Hub search, Alt+Enter = Web search, Esc closes', async t => {
  const r = rig(t);
  r.type('猫'); await wait(60);
  assert.equal(r.input.getAttribute('aria-activedescendant'), 'toolbar-suggestion-0');
  r.key('ArrowDown'); assert.equal(r.input.getAttribute('aria-activedescendant'), 'toolbar-suggestion-1');
  r.key('ArrowUp'); r.key('ArrowUp'); assert.equal(r.options().at(-1).getAttribute('aria-selected'), 'true');
  r.key('Escape'); assert.equal(r.document.querySelector('#toolbar-suggestions').hidden, true);
  r.type('猫'); r.key('Enter'); assert.deepEqual(r.calls.at(-1), ['hub', '猫']);
  r.type('猫'); r.key('ArrowDown'); r.key('Enter'); assert.deepEqual(r.calls.at(-1), ['open', 'https://duckduckgo.com/?q=' + encodeURIComponent('猫')]);
  r.type('犬'); r.key('Enter', { altKey: true }); assert.deepEqual(r.calls.at(-1), ['open', 'https://duckduckgo.com/?q=' + encodeURIComponent('犬')]);
  r.type('猫'); await wait(60); r.options().find(o => o.dataset.kind === 'result').click(); assert.equal(r.calls.at(-1)[0], 'hub');
});

test('URLs and domains navigate directly and never query Hub', async t => {
  const r = rig(t);
  r.type('example.com'); await wait(60);
  assert.deepEqual(r.queries, []);
  assert.deepEqual(r.options().map(o => o.dataset.kind), ['open', 'hub']);
  r.key('Enter'); assert.deepEqual(r.calls.at(-1), ['open', 'https://example.com/']);
  r.type('https://example.org/a'); r.key('Enter', { altKey: true }); assert.deepEqual(r.calls.at(-1), ['open', 'https://example.org/a']);
});

test('app wiring: search view web row above the results, engine from the setting, no hard-coded Google search', () => {
  const html = read('index.html'), app = read('app.js'), settings = read('settings-view.mjs');
  assert.ok(html.indexOf('id="search-web"') > 0 && html.indexOf('id="search-web"') < html.indexOf('id="search-results"'));
  assert.match(html, /Webでも探す（DuckDuckGo）/);
  assert.match(app, /Webでも探す（\$\{webSearchLabel\(browserSearchEngine\(\)\)}）/);
  assert.match(app, /searchHub: omniboxHubSearch/);
  assert.doesNotMatch(app.replace(/tbm=vid[^\n]*/g, ''), /google\.com\/search\?q=/);
  assert.match(settings, /createWebSearchSetting/);
});
