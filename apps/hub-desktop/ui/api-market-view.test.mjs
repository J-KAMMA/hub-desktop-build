import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { normalizeListing } from './ai-market.mjs';
import { createApiMarketView, filterApiListings } from './api-market-view.mjs';

const SELLER = '0x1111111111111111111111111111111111111111';
const SPLITTER = '0x2222222222222222222222222222222222222222';
const raw = (n, over = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, type: 'ai.endpoint', kind: 'ai', purpose: `用途${n}`, providerName: `Prov ${n}`, baseUrl: `https://p${n}.example.com/v1`,
  modelIds: [`m${n}`], network: 'eip155:84532', currency: 'USDC', priceAtomic: 1000 * n, maxPriceAtomic: 10_000 * n, declaredLatencyMs: n === 3 ? null : Math.round(1000 / n),
  dataHandling: { retention: n % 2 === 0, training: n === 1, processingRegion: '日本' }, attested: false, sellerAddress: SELLER, payeeAddress: SPLITTER,
  createdAt: `2026-11-0${n}T00:00:00.000Z`, ...over,
});
const weather = normalizeListing(raw(4, { type: 'api.endpoint', kind: 'weather', modelIds: [], purpose: '天気予報', providerName: 'Wx' }));
const listings = [1, 2, 3].map((n) => normalizeListing(raw(n))).concat(weather);
const ids = (rows) => rows.map((l) => l.id.slice(-1));

test('normalized listings keep the per-call price (never above the maximum), purpose and creation time', () => {
  assert.equal(listings[0].priceAtomic, 1000);
  assert.equal(normalizeListing(raw(1, { priceAtomic: 999_999 })).priceAtomic, 10_000);
  assert.equal(normalizeListing(raw(1, { priceAtomic: undefined })).priceAtomic, 10_000);
  assert.equal(normalizeListing(raw(1, { openapiUrl: 'javascript:alert(1)' })).openapiUrl, null);
  assert.equal(listings[0].purpose, '用途1');
  assert.equal(listings[0].createdAt, '2026-11-01T00:00:00.000Z');
});

test('filters and sorts: newest, price, declared speed (undeclared last), declared data handling, kind and words', () => {
  assert.deepEqual(ids(filterApiListings(listings)), ['4', '3', '2', '1']);
  assert.deepEqual(ids(filterApiListings(listings, { sort: 'price' })), ['1', '2', '3', '4']);
  assert.deepEqual(ids(filterApiListings(listings, { sort: 'speed' })), ['4', '2', '1', '3']);
  assert.deepEqual(ids(filterApiListings(listings, { noRetention: true, sort: 'price' })), ['1', '3']);
  assert.deepEqual(ids(filterApiListings(listings, { noTraining: true, sort: 'price' })), ['2', '3', '4']);
  assert.deepEqual(ids(filterApiListings(listings, { kind: 'weather' })), ['4']);
  assert.deepEqual(ids(filterApiListings(listings, { q: 'M2' })), ['2']);
  assert.deepEqual(filterApiListings(listings, { attested: true }), []);
});

function mount(overrides = {}) {
  const { window } = new JSDOM('<div id="host"></div>', { url: 'http://localhost' });
  const document = window.document;
  const host = document.querySelector('#host');
  const used = [];
  const asked = [];
  const view = createApiMarketView({
    document, host, getListings: () => listings,
    market: { confirmUse: async (l) => { asked.push(l.id); return overrides.agree ?? true; } },
    onUse: (l, model) => used.push([l.id, model]),
    ...overrides.deps,
  });
  view.render();
  return { document, host, view, used, asked };
}

test('the list has a filter column, sort buttons and one comparable row per listing; data handling is labelled as declared', () => {
  const { host } = mount();
  assert.ok(host.querySelector('.amv-filters[aria-label="絞り込み"]'));
  assert.equal(host.querySelectorAll('.amv-row').length, 4);
  assert.deepEqual([...host.querySelectorAll('.amv-sort')].map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.match(host.textContent, /データの扱い（提供者の申告）/);
  const first = host.querySelector('.amv-row');
  assert.match(first.textContent, /Wx/);
  assert.match(first.textContent, /天気/);
  assert.match(first.textContent, /証明 なし/);
});

test('sorting and filtering re-render in place; typing keeps the search field', () => {
  const { host } = mount();
  [...host.querySelectorAll('.amv-sort')][1].click();
  assert.match(host.querySelector('.amv-row').textContent, /Prov 1/);
  const option = [...host.querySelectorAll('.amv-option')].find((b) => b.textContent === '保存しない');
  option.click();
  assert.equal(host.querySelectorAll('.amv-row').length, 2);
  const search = host.querySelector('.amv-search');
  search.value = 'zzz';
  search.dispatchEvent(new host.ownerDocument.defaultView.Event('input'));
  assert.equal(host.querySelector('.amv-search'), search);
  assert.match(host.textContent, /条件に合う窓口はありません/);
});

test('the detail shows the maximum before use, marks the declaration, and uses only after the disclosure is agreed', async () => {
  const { host, used, asked } = mount();
  [...host.querySelectorAll('.amv-row')].find((r) => /Prov 2/.test(r.textContent)).click();
  assert.match(host.textContent, /1 回あたりの上限額/);
  assert.match(host.textContent, /0\.02 USDC（テスト用）/);
  assert.match(host.textContent, /これは提供者の申告で、jkamma は確認していません。/);
  host.querySelector('.amv-btn-primary').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(asked, [listings[1].id]);
  assert.deepEqual(used, [[listings[1].id, 'm2']]);
  host.querySelector('.amv-back').click();
  assert.equal(host.querySelectorAll('.amv-row').length, 4);
});

test('a refused disclosure does not use the endpoint; other kinds have no AI button', async () => {
  const { host, used } = mount({ agree: false });
  [...host.querySelectorAll('.amv-row')][1].click();
  host.querySelector('.amv-btn-primary').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(used, []);
  assert.match(host.textContent, /使うのをやめました/);
  host.querySelector('.amv-back').click();
  host.querySelector('.amv-row').click();
  assert.equal(host.querySelector('.amv-btn-primary'), null);
});

test('the css uses tokens only, keeps gold to lines and text, and draws no shadows or gradients', () => {
  const css = readFileSync(new URL('./api-market-view.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bwhite(?![-\w])|\bblack(?![-\w])/);
  assert.doesNotMatch(css, /box-shadow|gradient|transform/);
  assert.doesNotMatch(css, /background(?:-color)?\s*:\s*var\(--emphasis\)/);
  assert.doesNotMatch(css, /font-weight\s*:\s*(500|600|650)\b/);
});

test('the market tree shows the API market row only when app.js asks for it', async () => {
  const { marketTreeModel } = await import('./market-tree.mjs');
  const labels = (model) => model[0].children.map((c) => c.label);
  assert.ok(!labels(marketTreeModel()).includes('APIの窓口'));
  const row = marketTreeModel({ apiMarket: true })[0].children.at(-1);
  assert.deepEqual([row.label, row.route], ['APIの窓口', { page: 'api' }]);
});
