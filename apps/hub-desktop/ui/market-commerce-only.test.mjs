import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const app = await read('./app.js');
const html = await read('./index.html');
const hubClient = await read('../src-tauri/src/hub_client.rs');
const hubNetwork = await read('../src-tauri/src/hub_network.rs');
const lib = await read('../src-tauri/src/lib.rs');

test('the market view no longer reaches the removed affiliate and external-product endpoints', () => {
  for (const removed of ['shopping_products', 'shopping_product', 'distributed_products', 'hub_shopping_', 'market/discovery', 'client/shopping', 'kind=product']) {
    assert.equal(app.includes(removed), false, `app.js: ${removed}`);
  }
  assert.equal(/"shopping_products" =>|"distributed_products" =>|"shopping_product" =>|\/api\/market\/discovery|\/api\/market\/products|\/api\/client\/shopping/.test(hubClient), false);
  assert.equal(/hub_shopping_/.test(lib), false);
  assert.equal(/"product"\s*=>|kind=="product"/.test(hubNetwork), false);
  assert.equal(html.includes('shop-sources'), false);
});

test('the market keeps the Commerce catalog and the Web-only market surfaces', () => {
  assert.match(app, /invoke\("commerce_catalog"/);
  assert.match(hubClient, /"market_tickets" => Some\("\/api\/market\/tickets"\)/);
  for (const path of ['/v2/market/digital', '/v2/market/digital?view=articles', '/v2/market/tickets', '/v2/work']) assert.ok(html.includes(`data-market-web="${path}"`), path);
  const rail = [...html.matchAll(/<button class="nav-item icon-nav-item[^"]*" data-view="([a-z]+)"/g)].map((match) => match[1]);
  assert.ok(rail.indexOf('market') > rail.indexOf('articles') && rail.indexOf('market') < rail.indexOf('browser') && rail.indexOf('browser') < rail.indexOf('ai'));
});

test('ticket cards show the venue, the date and the lowest yen price, and open the Web market', async () => {
  const start = app.indexOf('let marketTicketsBusy = false;');
  const end = app.indexOf('for (const button of document.querySelectorAll("[data-market-web]"))', start);
  assert.ok(start >= 0 && end > start);
  const {window} = new JSDOM('<p id="market-tickets-state"></p><div id="market-tickets"></div>');
  const opened = [], calls = [];
  const context = vm.createContext({
    document: window.document,
    catalogCard: ({title, body, meta, onOpen}) => { const card = window.document.createElement('article'); card.textContent = [title, body, ...meta].filter(Boolean).join('|'); card.onclick = onOpen; return card; },
    openHubWebPath: async (path) => { opened.push(path); },
    settleWithin: (promise) => promise,
    friendlyError: String,
    invoke: async (name, args) => { calls.push([name, args]); return {events: [{title: '夜の部', summary: '概要', venueName: '会場', startsAt: '2026-11-03T10:00:00Z', ticketTypes: [{currency: 'JPY', priceMinor: 5000}, {currency: 'JPY', priceMinor: 3000}, {currency: 'USD', priceMinor: 1}]}, {summary: 'no title'}]}; },
  });
  vm.runInContext(app.slice(start, end), context);
  await vm.runInContext('loadMarketTickets()', context);
  assert.equal(JSON.stringify(calls), JSON.stringify([['hub_resource', {resource: 'market_tickets', query: ''}]]));
  const cards = [...window.document.querySelectorAll('#market-tickets article')];
  assert.equal(cards.length, 1);
  assert.match(cards[0].textContent, /夜の部\|概要\|会場\|.*\|¥3,000〜/u);
  cards[0].onclick();
  assert.equal(JSON.stringify(opened), JSON.stringify(['/v2/market/tickets']));
  assert.equal(window.document.querySelector('#market-tickets-state').textContent, '');
});

test('Commerce digital and pickup products are listed read-only and open the Web market', () => {
  assert.match(app, /filter\(\(p\) => \["digital", "pickup"\]\.includes\(p\.fulfillmentType\)\)/);
  assert.match(app, /openHubWebPath\(p\.fulfillmentType === "digital" \? "\/v2\/market\/digital" : "\/v2\/market\/products"\)/);
});
