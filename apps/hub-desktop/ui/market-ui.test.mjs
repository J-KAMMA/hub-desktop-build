import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { CATEGORIES, SORTS, cartEstimate, normalizeProduct, normalizeTicket, priceView } from './market-model.mjs';
import { marketTreeModel, renderMarketTree, marketRouteKey } from './market-tree.mjs';
import { createMarketBrowse, renderTile } from './market-browse.mjs';
import { createMarketProductPage, buyableInApp, webPathFor } from './market-product.mjs';
import { createOrdersList, renderCart, renderPurchased, renderWebRows, WEB_ROWS } from './market-me.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const dom = html => { const d = new JSDOM(html, { url: 'http://localhost' }); return d.window.document; };

const seller = { id: 's1', publicName: 'Atelier Kamo', handle: 'kamo', legalDisplayUrl: 'https://example.com/law' };
const goods = (id, extra = {}) => ({ id, title: `グッズ${id}`, priceJpyc: 1200, shippingJpyc: 300, stockQuantity: 8, fulfillmentType: 'seller_shipping', seller, imageUrl: `/img/${id}.png`, description: '説明です', ...extra });
const digital = (id, extra = {}) => ({ id, title: `デジタル${id}`, priceJpyc: 500, fulfillmentType: 'digital', seller, ...extra });
const raws = [goods('g1'), goods('g2', { taxIncluded: { status: 'determined', priceJpyc: 1320, shippingJpyc: 330, rateBps: 1000, totalForOneJpyc: 1650 } }), digital('d1'), goods('p1', { fulfillmentType: 'pickup' })];

function mountBrowse(t, overrides = {}) {
  const document = dom('<div id="host"></div>');
  const calls = { load: [], tickets: 0, games: 0, gamesQuery: [], opened: [] };
  const gamesHost = document.createElement('div');
  gamesHost.id = 'games';
  const deps = {
    gamesHost,
    loadProducts: async args => { calls.load.push(args); return overrides.page ? overrides.page(args) : { items: raws, nextCursor: null }; },
    loadTickets: async () => { calls.tickets++; return [{ id: 'e1', title: '夜の部', summary: '概要', venueName: '会場', startsAt: '2026-11-03T10:00:00Z', ticketTypes: [{ currency: 'JPY', priceMinor: 5000 }, { currency: 'JPY', priceMinor: 3000 }] }]; },
    openGames: () => { calls.games++; },
    setGamesQuery: q => calls.gamesQuery.push(q),
    openItem: item => calls.opened.push(item.id),
    asset: (img, url) => { img.src = url; },
    friendlyError: String,
  };
  const browse = createMarketBrowse({ document, host: document.getElementById('host'), deps, debounceMs: 0 });
  return { document, calls, browse, deps };
}
const titles = document => [...document.querySelectorAll('.mk-tile .mk-tile-title')].map(n => n.textContent);

// ---------- 木 ----------
test('tree: two roots, the market categories (from CATEGORIES) and the personal pages', () => {
  const document = dom('<aside id="col"></aside>');
  const host = document.getElementById('col');
  const gone = [];
  const tree = renderMarketTree({ document, host, model: marketTreeModel({ cartCount: 3 }), route: { page: 'browse', category: 'all' }, onGo: r => gone.push(marketRouteKey(r)) });
  assert.deepEqual(tree.roots().map(n => n.textContent), ['マーケット', '自分']);
  assert.deepEqual([...host.querySelectorAll('.sidebar-tree')[0].querySelectorAll('.sidebar-tree-children .sidebar-item-label')].map(n => n.textContent), ['すべて', 'デジタル', 'グッズ', 'チケット', 'ゲーム']);
  assert.deepEqual(CATEGORIES.map(c => c.label), ['すべて', 'デジタル', 'グッズ', 'チケット', 'ゲーム']);
  assert.deepEqual([...host.querySelectorAll('.sidebar-tree')[1].querySelectorAll('.sidebar-tree-children .sidebar-item-label')].map(n => n.textContent), ['カート', '購入済み', '注文']);
  assert.equal(host.querySelector('.sidebar-tree-count').textContent, '3');
  // 曲がり線の印
  for (const kids of host.querySelectorAll('.sidebar-tree-children')) {
    const items = [...kids.children];
    assert.ok(items[0].classList.contains('is-tree-first') && items.at(-1).classList.contains('is-tree-last'));
  }
  assert.equal(tree.rows().length, 8);
});

test('tree: 出品中/売上 appears only when the user sells', () => {
  const document = dom('<aside id="col"></aside>');
  const host = document.getElementById('col');
  renderMarketTree({ document, host, model: marketTreeModel({ sells: true }), route: { page: 'cart' }, onGo() {} });
  assert.ok([...host.querySelectorAll('.sidebar-item-label')].some(n => n.textContent === '出品中/売上'));
  const other = dom('<aside id="col"></aside>');
  renderMarketTree({ document: other, host: other.getElementById('col'), model: marketTreeModel(), route: { page: 'cart' }, onGo() {} });
  assert.equal([...other.querySelectorAll('.sidebar-item-label')].some(n => n.textContent === '出品中/売上'), false);
});

test('tree: clicking only reports the route and never rebuilds the column; select and setCount edit in place', () => {
  const document = dom('<aside id="col"></aside>');
  const host = document.getElementById('col');
  const gone = [];
  const tree = renderMarketTree({ document, host, model: marketTreeModel(), route: { page: 'browse', category: 'all' }, onGo: r => gone.push(marketRouteKey(r)) });
  const before = [...host.querySelectorAll('*')];
  for (const row of tree.rows()) row.click();
  tree.roots()[1].click();
  assert.deepEqual(gone, ['browse:all', 'browse:digital', 'browse:goods', 'browse:ticket', 'browse:game', 'cart', 'purchased', 'orders', 'cart']);
  assert.deepEqual([...host.querySelectorAll('*')], before);
  const on = () => [...host.querySelectorAll('.on')].map(n => n.textContent);
  assert.deepEqual(on(), ['すべて']);
  tree.select({ page: 'orders' });
  assert.deepEqual(on(), ['注文']);
  assert.equal(host.querySelectorAll('[aria-current="page"]').length, 1);
  tree.setCount(2);
  assert.equal(host.querySelector('.sidebar-tree-count').textContent, '2');
  tree.setCount(0);
  assert.equal(host.querySelector('.sidebar-tree-count').hidden, true);
  assert.deepEqual([...host.querySelectorAll('*')], before);
});

// ---------- 一覧 ----------
test('browse: chips, sort control without 人気, search field; first load shows skeletons in the tile shape', async t => {
  const f = mountBrowse(t);
  assert.deepEqual([...f.document.querySelectorAll('.mk-chips > .mk-chip')].map(n => n.textContent), ['すべて', 'デジタル', 'グッズ', 'チケット', 'ゲーム']);
  assert.deepEqual([...f.document.querySelectorAll('.mk-sort option')].map(n => n.textContent), ['新着', '価格の安い順', '価格の高い順']);
  assert.deepEqual(SORTS.map(s => s.key), ['new', 'price_asc', 'price_desc']);
  assert.ok(f.document.querySelector('.mk-search input[type="search"]'));
  f.browse.show('all');
  assert.equal(f.document.querySelectorAll('.mk-skeleton').length, 8);
  const skeleton = f.document.querySelector('.mk-skeleton');
  assert.ok(skeleton.querySelector('.mk-media') && skeleton.querySelectorAll('.mk-skel-line').length === 4);
  await f.browse.settled();
  assert.equal(f.document.querySelectorAll('.mk-skeleton').length, 0);
});

test('browse: tiles show a square image, a two-line title, tabular price and muted seller', async t => {
  const f = mountBrowse(t);
  f.browse.show('all');
  await f.browse.settled();
  assert.equal(f.document.querySelectorAll('.mk-tile').length, 4);
  const tile = f.document.querySelector('.mk-tile[data-id="g2"]');
  assert.ok(tile.querySelector('.mk-media img'));
  assert.equal(tile.querySelector('.mk-tile-title').textContent, 'グッズg2'.replace('グッズg2', 'グッズg2'));
  assert.equal(tile.querySelector('.mk-tile-price .mk-num').textContent, '1,320 JPYC');
  assert.equal(tile.querySelector('.mk-tile-tax').textContent, '税込');
  assert.equal(tile.querySelector('.mk-tile-seller').textContent, 'Atelier Kamo');
  const css = read('./market-ui.css');
  assert.match(css, /\.mk-media \{[^}]*aspect-ratio: 1 \/ 1/);
  assert.match(css, /-webkit-line-clamp: 2/);
  assert.match(css, /\.mk-num[^{]*\{[^}]*tabular-nums/);
  // 札の種別はすべてのときだけ販売者の行に添える
  assert.equal(f.document.querySelector('.mk-tile[data-id="d1"] .mk-tile-seller').textContent, 'デジタル · Atelier Kamo');
  tile.click();
  assert.deepEqual(f.calls.opened, ['g2']);
});

test('browse: category chips filter the loaded catalog without another read; ticket and game use their own sources', async t => {
  const f = mountBrowse(t);
  f.browse.show('all');
  await f.browse.settled();
  f.browse.setCategory('digital');
  assert.deepEqual(titles(f.document), ['デジタルd1']);
  f.browse.setCategory('goods');
  assert.deepEqual(titles(f.document), ['グッズg1', 'グッズg2', 'グッズp1']);
  assert.equal(f.calls.load.length, 1, 'switching categories does not re-read the catalog');
  f.browse.setCategory('ticket');
  await f.browse.settled();
  assert.equal(f.calls.tickets, 1);
  assert.deepEqual(titles(f.document), ['夜の部']);
  assert.equal(f.document.querySelector('.mk-tile .mk-tile-price').textContent, '¥3,000〜');
  assert.equal(f.document.querySelector('.mk-sort').hidden, true, 'ticket has no server sort');
  f.browse.setCategory('game');
  assert.equal(f.calls.games, 1);
  assert.ok(f.document.querySelector('.mk-body #games'));
  f.browse.setQuery('zelda');
  assert.deepEqual(f.calls.gamesQuery, ['zelda']);
  assert.equal(f.calls.load.length, 1, 'game search does not read the catalog');
});

test('browse: search and sort pass through to the existing catalog read (new / price_asc / price_desc only)', async t => {
  const f = mountBrowse(t);
  f.browse.show('all');
  await f.browse.settled();
  const input = f.document.querySelector('.mk-search input');
  input.value = ' 猫 ';
  input.dispatchEvent(new f.document.defaultView.Event('input'));
  await f.browse.settled();
  assert.deepEqual(f.calls.load.at(-1), { query: '猫', sort: 'new', before: null, inStock: false, freeShipping: false });
  const select = f.document.querySelector('.mk-sort select');
  select.value = 'price_asc';
  select.dispatchEvent(new f.document.defaultView.Event('change'));
  await f.browse.settled();
  assert.deepEqual(f.calls.load.at(-1), { query: '猫', sort: 'price_asc', before: null, inStock: false, freeShipping: false });
  f.browse.setSort('popular');
  assert.equal(f.browse.state().sort, 'price_asc', 'unsupported sorts are ignored');
});

test('browse: more loading is keyset, on demand only, and de-duplicates', async t => {
  const pages = { null: { items: [goods('a'), goods('b')], nextCursor: 'c1' }, c1: { items: [goods('b'), goods('c')], nextCursor: null } };
  const f = mountBrowse(t, { page: ({ before }) => pages[before] });
  f.browse.show('all');
  await f.browse.settled();
  assert.equal(f.calls.load.length, 1, 'no prefetch');
  assert.equal(f.document.querySelector('.mk-count').textContent, '2件以上');
  const more = f.document.querySelector('.mk-more .mk-btn');
  assert.equal(more.textContent, 'さらに表示');
  more.click();
  await f.browse.settled();
  assert.deepEqual(f.calls.load.at(-1), { query: '', sort: 'new', before: 'c1', inStock: false, freeShipping: false });
  assert.deepEqual(titles(f.document), ['グッズa', 'グッズb', 'グッズc']);
  assert.equal(f.document.querySelector('.mk-more'), null);
});

test('browse: quiet empty states, search miss, error with retry', async t => {
  const empty = mountBrowse(t, { page: () => ({ items: [], nextCursor: null }) });
  empty.browse.show('all');
  await empty.browse.settled();
  assert.equal(empty.document.querySelector('.mk-empty-title').textContent, '商品はまだありません');
  assert.equal(empty.document.querySelector('.mk-empty .mk-btn'), null);
  empty.browse.setQuery('ない');
  await empty.browse.settled();
  assert.equal(empty.document.querySelector('.mk-empty-title').textContent, '「ない」は見つかりません');
  let fail = true;
  const err = mountBrowse(t, { page: () => { if (fail) throw new Error('down'); return { items: raws, nextCursor: null }; } });
  err.browse.show('all');
  await err.browse.settled();
  assert.equal(err.document.querySelector('.mk-empty').getAttribute('role'), 'alert');
  fail = false;
  err.document.querySelector('.mk-empty .mk-btn').click();
  await err.browse.settled();
  assert.equal(err.document.querySelectorAll('.mk-tile').length, 4);
});

test('a stale answer never overwrites a newer search', async t => {
  let release;
  const slow = new Promise(r => { release = r; });
  const f = mountBrowse(t, { page: async ({ query }) => (query === 'old' ? slow : { items: [goods('new')], nextCursor: null }) });
  f.browse.show('all');
  await f.browse.settled();
  f.browse.setQuery('old');
  f.browse.setQuery('fresh');
  await f.browse.settled();
  release({ items: [goods('stale')], nextCursor: null });
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(titles(f.document), ['グッズnew']);
});

// ---------- 商品ページ ----------
function mountProduct(t, raw, ctx = {}, overrides = {}) {
  const document = dom('<div id="host"></div>');
  const calls = [];
  const deps = {
    asset: (img, url) => { img.src = url; },
    addToCart: async (item, quantity) => { calls.push(['addToCart', item.id, quantity]); return overrides.addOk ?? true; },
    goCheckout: item => calls.push(['goCheckout', item.id]),
    openWeb: path => calls.push(['openWeb', path]),
    openSeller: s => calls.push(['openSeller', s.id]),
    openProfile: h => calls.push(['openProfile', h]),
    openLegal: u => calls.push(['openLegal', u]),
    openItem: item => calls.push(['openItem', item.id]),
  };
  const page = createMarketProductPage({ document, host: document.getElementById('host'), deps });
  page.show(normalizeProduct(raw), ctx);
  return { document, calls, page };
}
const flush = () => new Promise(r => setTimeout(r, 0));

test('product page: gallery with thumbnails, title, price with tax wording, seller card and related items', t => {
  const raw = goods('g2', { images: ['/img/a.png', { url: '/img/b.png' }], taxIncluded: { status: 'determined', priceJpyc: 1320, shippingJpyc: 330, rateBps: 1000, totalForOneJpyc: 1650 } });
  const related = [goods('r1'), goods('g2'), goods('r2')].map(normalizeProduct);
  const f = mountProduct(t, raw, { related, paymentsEnabled: true });
  assert.equal(f.document.querySelector('.mk-title').textContent, 'グッズg2');
  assert.equal(f.document.querySelectorAll('.mk-thumb').length, 3, 'imageUrl + two gallery images');
  f.document.querySelectorAll('.mk-thumb')[1].click();
  assert.equal(f.document.querySelectorAll('.mk-thumb')[1].getAttribute('aria-pressed'), 'true');
  assert.equal(f.document.querySelector('.mk-gallery-main img').getAttribute('src'), '/img/a.png');
  assert.equal(f.document.querySelector('.mk-price-main').textContent, '1,320 JPYC');
  assert.match(f.document.querySelector('.mk-price-sub').textContent, /税込・本体 1,200 JPYC/);
  assert.match(f.document.querySelector('.mk-facts').textContent, /消費税10%（込み）/);
  assert.equal(f.document.querySelector('.mk-seller-name').textContent, 'Atelier Kamo');
  const names = [...f.document.querySelectorAll('.mk-seller-actions .mk-btn')].map(n => n.textContent);
  assert.deepEqual(names, ['販売者の商品', 'プロフィール', '販売条件・返品 ↗']);
  f.document.querySelectorAll('.mk-seller-actions .mk-btn').forEach(n => n.click());
  assert.deepEqual(f.calls, [['openSeller', 's1'], ['openProfile', 'kamo'], ['openLegal', 'https://example.com/law']]);
  assert.deepEqual([...f.document.querySelectorAll('.mk-related .mk-tile-title')].map(n => n.textContent), ['グッズr1', 'グッズr2'], 'the page item itself is not repeated');
});

test('product page: goods buy box wires to the existing cart and checkout path only', async t => {
  const f = mountProduct(t, goods('g1'), { inCart: false, paymentsEnabled: true });
  assert.deepEqual([...f.document.querySelectorAll('.mk-buy-actions .mk-btn')].map(n => n.textContent), ['カートに入れる', '購入手続きへ']);
  f.document.querySelectorAll('.mk-step')[1].click();
  f.document.querySelectorAll('.mk-step')[1].click();
  assert.equal(f.document.querySelector('.mk-buy-qty .mk-step-value').textContent, '3');
  f.document.querySelector('.mk-buy-actions .mk-btn').click();
  await flush();
  assert.deepEqual(f.calls, [['addToCart', 'g1', 3]]);
  f.page.refresh({ inCart: true });
  assert.equal(f.document.querySelector('.mk-buy-actions .mk-btn').textContent, 'カートに追加済み');
  assert.equal(f.document.querySelector('.mk-buy-actions .mk-btn').disabled, true);
  f.document.querySelectorAll('.mk-buy-actions .mk-btn')[1].click();
  await flush();
  assert.deepEqual(f.calls.slice(1), [['goCheckout', 'g1']], 'already in cart: goes straight to the existing checkout');
});

test('product page: 購入手続きへ adds first, and does not proceed when the cart refuses', async t => {
  const ok = mountProduct(t, goods('g1'), { inCart: false });
  ok.document.querySelectorAll('.mk-buy-actions .mk-btn')[1].click();
  await flush();
  assert.deepEqual(ok.calls, [['addToCart', 'g1', 1], ['goCheckout', 'g1']]);
  const refused = mountProduct(t, goods('g1'), { inCart: false }, { addOk: false });
  refused.document.querySelectorAll('.mk-buy-actions .mk-btn')[1].click();
  await flush();
  assert.deepEqual(refused.calls, [['addToCart', 'g1', 1]]);
});

test('product page: digital, ticket and pickup open the Web market and never reach the in-app cart', async t => {
  const dig = mountProduct(t, digital('d1'));
  assert.deepEqual([...dig.document.querySelectorAll('.mk-buy-actions .mk-btn')].map(n => n.textContent), ['Webで購入する ↗']);
  assert.match(dig.document.querySelector('.mk-facts').textContent, /ダウンロード/);
  dig.document.querySelector('.mk-buy-actions .mk-btn').click();
  const pickup = mountProduct(t, goods('p1', { fulfillmentType: 'pickup' }));
  pickup.document.querySelector('.mk-buy-actions .mk-btn').click();
  const document = dom('<div id="host"></div>');
  const calls = [];
  const page = createMarketProductPage({ document, host: document.getElementById('host'), deps: { openWeb: p => calls.push(p), addToCart: () => calls.push('cart'), goCheckout: () => calls.push('checkout') } });
  const ticket = normalizeTicket({ id: 'e1', title: '夜の部', venueName: '東京ホール', startsAt: '2026-11-03T10:00:00Z', ticketTypes: [{ currency: 'JPY', priceMinor: 3000 }] });
  page.show(ticket, {});
  assert.match(document.querySelector('.mk-facts').textContent, /日時・会場.*東京ホール/);
  assert.equal(document.querySelector('.mk-price-main').textContent, '¥3,000〜');
  document.querySelector('.mk-buy-actions .mk-btn').click();
  assert.deepEqual(dig.calls, [['openWeb', '/v2/market/digital']]);
  assert.deepEqual(pickup.calls, [['openWeb', '/v2/market/products']]);
  assert.deepEqual(calls, ['/v2/market/tickets']);
  assert.equal(buyableInApp(normalizeProduct(goods('x', { stockQuantity: 0 }))), false);
  assert.equal(webPathFor(normalizeProduct(digital('d'))), '/v2/market/digital');
});

test('product page: no new checkout is created — the module has no way to reach Rust or the network', () => {
  for (const file of ['./market-product.mjs', './market-me.mjs', './market-browse.mjs', './market-tree.mjs', './market-model.mjs', './market-dom.mjs']) {
    const source = read(file).replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [/\binvoke\s*\(/, /open_external/, /commerce_(?:catalog|order|product|checkout|prepare)/, /\bfetch\s*\(/, /XMLHttpRequest/, /localStorage|sessionStorage/, /window\.open\s*\(/, /signTypedData|eth_sendTransaction|personal_sign/]) {
      assert.equal(forbidden.test(source), false, `${file}: ${forbidden}`);
    }
  }
  const product = read('./market-product.mjs');
  assert.deepEqual([...new Set([...product.matchAll(/deps\.(\w+)/g)].map(m => m[1]))].sort(), ['addToCart', 'asset', 'goCheckout', 'openItem', 'openLegal', 'openProfile', 'openSeller', 'openWeb']);
});

// ---------- カート・購入済み・注文 ----------
const line = (id, extra = {}, quantity = 1) => ({ id, quantity, saved: false, product: goods(id, extra) });

test('cart: divider rows with thumbnail, title, price; totals are tabular; 購入手続きへ calls the existing checkout', () => {
  const document = dom('<div id="host"></div>');
  const calls = [];
  const lines = [line('a', {}, 2), line('b', { taxIncluded: { status: 'determined', priceJpyc: 1320, shippingJpyc: 330, rateBps: 1000 } })];
  renderCart({
    document, host: document.getElementById('host'), lines,
    deps: { setQuantity: (id, n) => calls.push(['qty', id, n]), remove: id => calls.push(['remove', id]), checkout: () => calls.push(['checkout']), openItem: id => calls.push(['open', id]), lineExtra: l => { const n = document.createElement('div'); n.textContent = `配送先 ${l.id}`; return n; } },
  });
  const rows = [...document.querySelectorAll('.mk-row')];
  assert.equal(rows.length, 2);
  assert.ok(rows[0].querySelector('.mk-row-thumb') && rows[0].querySelector('.mk-row-title') && rows[0].querySelector('.mk-row-price.mk-num'));
  assert.equal(rows[0].querySelector('.mk-row-price').textContent, '2,400 JPYC');
  assert.equal(rows[0].querySelector('.mk-row-extra').textContent, '配送先 a');
  rows[0].querySelectorAll('.mk-step')[1].click();
  rows[0].querySelector('.mk-link').click();
  rows[1].querySelector('.mk-row-title').click();
  const totals = [...document.querySelectorAll('.mk-total')].map(n => n.textContent);
  assert.match(totals[0], /小計（3点）.*3,720 JPYC/);
  assert.match(totals[1], /送料.*630 JPYC/);
  assert.match(totals[2], /合計の目安.*4,350 JPYC/);
  const checkout = document.querySelector('.mk-cart-cta .mk-btn');
  assert.equal(checkout.textContent, '購入手続きへ');
  assert.ok(checkout.classList.contains('mk-btn-primary'));
  checkout.click();
  assert.deepEqual(calls, [['qty', 'a', 3], ['remove', 'a'], ['open', 'b'], ['checkout']]);
  assert.match(read('./market-ui.css'), /\.mk-num, #hub-shell #cart-totals \{[^}]*tabular-nums/);
});

test('cart: locked cart disables edits and checkout; empty cart is a quiet state with one button', () => {
  const document = dom('<div id="host"></div>');
  renderCart({ document, host: document.getElementById('host'), lines: [line('a')], deps: { setQuantity() {}, remove() {}, checkout() {}, locked: () => true } });
  assert.equal(document.querySelector('.mk-cart-cta .mk-btn').disabled, true);
  assert.ok([...document.querySelectorAll('.mk-step')].every(n => n.disabled));
  const calls = [];
  renderCart({ document, host: document.getElementById('host'), lines: [], deps: { browse: () => calls.push('browse') } });
  assert.equal(document.querySelector('.mk-empty-title').textContent, 'カートは空です');
  document.querySelector('.mk-empty .mk-btn').click();
  assert.deepEqual(calls, ['browse']);
  assert.equal(cartEstimate([]).total, 0);
});

const receipts = [
  { id: 'o1', title: '猫のTシャツ', quantity: 2, amountJpyc: 2700, status: 'paid', fulfillmentStatus: 'shipped', trackingNumber: 'JP123', createdAt: '2026-11-01T00:00:00Z', fulfillmentType: 'seller_shipping' },
  { id: 'o2', title: '音源集', quantity: 1, amountJpyc: 500, status: 'paid', createdAt: '2026-10-30T00:00:00Z', fulfillmentType: 'digital' },
  { id: 'o3', title: 'ポスター', quantity: 1, amountJpyc: 900, status: 'awaiting_payment', createdAt: '2026-10-29T00:00:00Z' },
  { id: 'o4', title: 'ステッカー', quantity: 1, amountJpyc: 300, status: 'refunded', createdAt: '2026-10-20T00:00:00Z' },
];
const orderDeps = calls => ({
  statusText: s => ({ paid: '支払い済み', awaiting_payment: '支払い待ち', refunded: '返金済み' }[s] ?? s),
  fulfillmentText: s => ({ shipped: '発送済み' }[s] ?? s),
  bucketOf: r => (r.status === 'awaiting_payment' ? 'attention' : r.status === 'paid' ? 'open' : 'done'),
  openOrder: id => calls.push(['order', id]), openWeb: p => calls.push(['web', p]), refresh: r => calls.push(['refresh', r.id]), browse: () => calls.push(['browse']),
});

test('purchased: paid orders as divider rows; digital goods point to the Web download', () => {
  const document = dom('<div id="host"></div>');
  const calls = [];
  renderPurchased({ document, host: document.getElementById('host'), receipts, deps: orderDeps(calls) });
  const rows = [...document.querySelectorAll('.mk-row')];
  assert.deepEqual(rows.map(r => r.dataset.id), ['o1', 'o2']);
  assert.match(rows[0].textContent, /猫のTシャツ.*×2.*2,700 JPYC.*支払い済み.*発送済み.*JP123/);
  const dl = [...rows[1].querySelectorAll('.mk-btn')].find(n => n.textContent.startsWith('ダウンロード'));
  dl.click();
  rows[0].querySelector('.mk-btn').click();
  assert.deepEqual(calls, [['web', '/v2/market/digital'], ['order', 'o1']]);
  renderPurchased({ document, host: document.getElementById('host'), receipts: [], deps: orderDeps(calls) });
  assert.equal(document.querySelector('.mk-empty-title').textContent, '購入済みの商品はまだありません');
});

test('orders: filter chips, status badges, detail and refresh wired to the existing handlers, paged by 20', () => {
  const document = dom('<div id="host"></div>');
  const calls = [];
  const list = createOrdersList({ document, host: document.getElementById('host'), deps: orderDeps(calls) });
  list.set(receipts);
  assert.equal(document.querySelectorAll('.mk-row').length, 4);
  assert.deepEqual([...document.querySelectorAll('.mk-orders .mk-chip')].map(n => n.textContent), ['すべて', '対応が必要', '進行中', '完了']);
  document.querySelector('.mk-chip[data-filter="attention"]').click();
  assert.deepEqual([...document.querySelectorAll('.mk-row')].map(r => r.dataset.id), ['o3']);
  assert.ok(document.querySelector('.mk-row .mk-badge'));
  const row = document.querySelector('.mk-row');
  [...row.querySelectorAll('.mk-btn, .mk-link')].forEach(n => n.click());
  assert.deepEqual(calls, [['order', 'o3'], ['refresh', 'o3']]);
  document.querySelector('.mk-chip[data-filter="done"]').click();
  assert.deepEqual([...document.querySelectorAll('.mk-row')].map(r => r.dataset.id), ['o4']);
  const many = Array.from({ length: 25 }, (_, i) => ({ ...receipts[0], id: `m${i}` }));
  list.set(many);
  document.querySelector('.mk-chip[data-filter="all"]').click();
  assert.equal(document.querySelectorAll('.mk-row').length, 20);
  document.querySelector('.mk-more .mk-btn').click();
  assert.equal(document.querySelectorAll('.mk-row').length, 25);
  list.set([]);
  assert.equal(document.querySelector('.mk-empty-title').textContent, 'この端末からの注文はまだありません');
});

test('web-only flows (seller setup, KYC) stay as labelled 「Webで開く」 rows that reuse the existing paths', () => {
  const document = dom('<div id="host"></div>');
  const opened = [];
  renderWebRows({ document, host: document.getElementById('host'), rows: WEB_ROWS, openWeb: p => opened.push(p) });
  const buttons = [...document.querySelectorAll('.mk-web-row .mk-btn')];
  assert.equal(buttons.length, WEB_ROWS.length);
  assert.ok(buttons.every(b => b.textContent === 'Webで開く ↗'));
  buttons.forEach(b => b.click());
  assert.deepEqual(opened, ['/v2/market/products/sell', '/v2/market/products/sell', '/v2/market/digital']);
  assert.match(document.body.textContent, /本人確認（KYC\/KYB）/);
});

test('model: price wording follows the data (tax determined, base only, unknown)', () => {
  assert.equal(priceView(normalizeProduct(goods('x'))).sub, '税は注文時に確定');
  assert.equal(priceView(normalizeProduct(goods('x', { priceJpyc: undefined }))).main, '価格は詳細で確認');
  assert.equal(normalizeProduct({ id: 1 }), null);
  assert.equal(normalizeTicket({ title: '' }), null);
});

// ---------- 見た目の規則 ----------
test('css: no raw colours, gold only as lines, flat buttons, all selectors scoped under #hub-shell', () => {
  const css = read('./market-ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![-\w])(?:white|black)(?![-\w])/.test(css), false);
  assert.equal(/background(?:-color)?:\s*var\(--emphasis\)/.test(css), false, 'gold is never a fill');
  assert.equal(/box-shadow:\s*[^;]*\d+px\s+\d+px\s+\d+px/.test(css), false, 'no drop shadows');
  assert.equal(/linear-gradient/.test(css.replace(/\.mk-skel \{[^}]*\}/, '')), false);
  for (const selector of css.split('}').map(part => part.split('{')[0].trim()).filter(s => s && !s.startsWith('@') && !/^\d|^from|^to/.test(s))) {
    for (const part of selector.split(',')) assert.match(part.trim(), /^#hub-shell /, part);
  }
  assert.equal(/.mk-(?:btn|chip|thumb|step)[^{]*{[^}]*box-shadow/.test(css), false, 'buttons carry no shadow of their own (the shell flattens them)');
});

test('css is linked from index.html after the shared tile styles', () => {
  const html = read('./index.html');
  assert.ok(html.indexOf('market-ui.css') > html.indexOf('video-tiles.css'));
});

test('renderTile alone: a tile without image falls back to the seller initial', () => {
  const document = dom('<div></div>');
  const tile = renderTile(document, normalizeProduct({ id: 'z', title: '無画像', priceJpyc: 100, seller: { publicName: 'ねこ' } }), {});
  assert.equal(tile.querySelector('.mk-media-letter').textContent, 'ネ'.replace('ネ', 'ね').toUpperCase());
  assert.equal(tile.querySelector('img'), null);
});

test('browse: 在庫あり and 送料無料 are toggle chips in the same style, passed to the same catalog read, hidden for tickets and games', async t => {
  const f = mountBrowse(t);
  f.browse.show('all');
  await f.browse.settled();
  const toggles = [...f.document.querySelectorAll('.mk-toggle')];
  assert.deepEqual(toggles.map(n => n.textContent), ['在庫あり', '送料無料']);
  assert.ok(toggles.every(n => n.classList.contains('mk-chip') && n.getAttribute('aria-pressed') === 'false'));
  toggles[0].click();
  await f.browse.settled();
  assert.deepEqual(f.calls.load.at(-1), { query: '', sort: 'new', before: null, inStock: true, freeShipping: false });
  assert.equal(f.document.querySelector('.mk-toggle').getAttribute('aria-pressed'), 'true');
  f.document.querySelectorAll('.mk-toggle')[1].click();
  await f.browse.settled();
  assert.deepEqual(f.calls.load.at(-1), { query: '', sort: 'new', before: null, inStock: true, freeShipping: true });
  f.browse.setCategory('ticket');
  assert.equal(f.document.querySelector('.mk-toggles').hidden, true);
  f.browse.setCategory('game');
  assert.equal(f.document.querySelector('.mk-toggles').hidden, true);
});

test('tree: 出品する is offered to every signed-in user, after 注文 and before 出品中/売上', () => {
  const document = dom('<aside id="col"></aside>');
  const host = document.getElementById('col');
  const gone = [];
  const tree = renderMarketTree({ document, host, model: marketTreeModel({ canList: true, sells: true }), route: { page: 'cart' }, onGo: r => gone.push(marketRouteKey(r)) });
  assert.deepEqual([...host.querySelectorAll('.sidebar-tree')[1].querySelectorAll('.sidebar-item-label')].map(n => n.textContent), ['自分', 'カート', '購入済み', '注文', '出品する', '出品中/売上', '出品・チケット']);
  tree.rows().find(r => r.textContent === '出品する').click();
  assert.deepEqual(gone, ['sell']);
  tree.rows().find(r => r.textContent === '出品・チケット').click();
  assert.deepEqual(gone, ['sell', 'listings']);
  const anon = dom('<aside id="col"></aside>');
  renderMarketTree({ document: anon, host: anon.getElementById('col'), model: marketTreeModel(), route: { page: 'cart' }, onGo() {} });
  assert.equal([...anon.querySelectorAll('.sidebar-item-label')].some(n => n.textContent === '出品する'), false);
});

test('cart rows keep the per-line shipping wording as a muted line', () => {
  const document = dom('<div id="host"></div>');
  const lines = [line('a', { shippingJpyc: 0 }), line('b', { shippingJpyc: 300 }), line('c', { shippingJpyc: null })];
  renderCart({ document, host: document.getElementById('host'), lines, deps: { setQuantity() {}, remove() {}, checkout() {} } });
  assert.deepEqual([...document.querySelectorAll('.mk-row-shipping')].map(n => n.textContent), ['送料無料', '送料 300 JPYC', '送料は注文時に確認']);
});
