import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  DISCLOSURE_TEXT, acknowledgeDisclosure, createMarketController, evaluateQuote, ensureDisclosure, marketAllowsContent,
  needsDisclosure, normalizeListing, normalizeListings, parseMarketRef, pickerRows, prepareMarketPayment, selectListings, splitAmount,
} from './ai-market.mjs';
import { isMarketAiCommand, isPaidAiCommand, PAID_AI_COMMANDS } from './ai-paid-execution.mjs';
import { guardWalletChain } from './wallet-network.mjs';
import { createPiModelPicker } from './pi-model-picker.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

const SELLER = '0x1234567890abcdef1234567890abcdef12345678';
const SPLITTER = '0xabcdef0123456789abcdef0123456789abcdef01';
const ASSET = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const raw = (n, over = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, type: 'ai.endpoint', providerName: `Prov ${n}`, baseUrl: `https://p${n}.example.com/v1`,
  modelIds: [`m${n}`], network: 'eip155:84532', currency: 'USDC', maxPriceAtomic: 10_000 * n, declaredLatencyMs: Math.round(1000 / n),
  dataHandling: { retention: n % 2 === 0, training: false, processingRegion: '日本' }, attested: false, sellerAddress: SELLER, payeeAddress: SPLITTER, ...over,
});
const listings = [1, 2, 3].map((n) => normalizeListing(raw(n)));
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const quote = (over = {}) => ({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: '10000', asset: ASSET, payTo: SPLITTER, ...over }] });

test('listings are normalized and unsafe ones dropped; a listing cannot claim attestation', () => {
  assert.equal(listings.length, 3);
  assert.equal(normalizeListing(raw(1, { baseUrl: 'http://x.example.com' })), null);
  assert.equal(normalizeListing(raw(1, { baseUrl: 'https://localhost/v1' })), null);
  assert.equal(normalizeListing(raw(1, { network: 'eip155:1' })), null);
  assert.equal(normalizeListing(raw(1, { sellerAddress: '0x1' })), null);
  assert.equal(normalizeListing(raw(1, { payeeAddress: undefined })), null);
  assert.equal(normalizeListing(raw(1, { payeeAddress: SELLER })), null);
  assert.equal(normalizeListing(raw(1, { maxPriceAtomic: 0 })), null);
  assert.equal(normalizeListing(raw(1, { attested: true })).attested, false);
  assert.equal(normalizeListings({ listings: [raw(1), { junk: 1 }] }).length, 1);
  assert.ok(!('apiKey' in normalizeListing(raw(1, { apiKey: 'sk-x' }))));
});

test('picker rows list every model of every listing with a market ref', () => {
  const rows = pickerRows(listings);
  assert.equal(rows.length, 3);
  assert.deepEqual(parseMarketRef(rows[0].ref), { id: listings[0].id, model: 'm1' });
  assert.match(rows[0].detail, /提供者の申告/);
});

test('filters: cheapest, fastest (declared), no retention, attested', () => {
  assert.deepEqual(selectListings(listings, { sort: 'cheapest' }).map((l) => l.id), [listings[0].id, listings[1].id, listings[2].id]);
  assert.deepEqual(selectListings(listings, { sort: 'fastest' }).map((l) => l.id), [listings[2].id, listings[1].id, listings[0].id]);
  assert.deepEqual(selectListings(listings, { filters: ['no_retention'] }).map((l) => l.id), [listings[0].id, listings[2].id]);
  assert.deepEqual(selectListings(listings, { filters: ['attested'] }), []);
  assert.deepEqual(selectListings(listings, { filters: ['fastest', 'no_retention'] }).map((l) => l.id), [listings[2].id, listings[0].id]);
});

test('the disclosure appears before first use of each endpoint, once', async () => {
  const storage = memory(); let asked = 0;
  const ask = async (info) => { asked++; assert.equal(info.message, DISCLOSURE_TEXT); return true; };
  assert.equal(needsDisclosure(storage, listings[0].id), true);
  assert.equal(await ensureDisclosure(storage, listings[0], ask), true);
  assert.equal(await ensureDisclosure(storage, listings[0], ask), true);
  assert.equal(asked, 1);
  assert.equal(await ensureDisclosure(storage, listings[1], async () => false), false);
  assert.equal(needsDisclosure(storage, listings[1].id), true, 'declined means still needed');
  acknowledgeDisclosure(storage, listings[1].id);
  assert.equal(needsDisclosure(storage, listings[1].id), false);
  assert.equal(DISCLOSURE_TEXT, 'プロンプトはこの提供者に届きます');
});

test('private content never goes to a market endpoint in this slice, even with an attested flag', () => {
  assert.equal(marketAllowsContent(listings[0], { private: false }).ok, true);
  assert.equal(marketAllowsContent(listings[0], { private: true }).code, 'market_private_blocked');
  assert.equal(marketAllowsContent(listings[0], { source: 'dm' }).code, 'market_private_blocked');
  assert.equal(marketAllowsContent({ ...listings[0], attested: true }, { private: true }).ok, false);
});

test('402 flow: over the listed max, mainnet, wrong payee and malformed quotes are refused', () => {
  assert.equal(evaluateQuote(quote(), listings[0]).ok, true);
  assert.equal(evaluateQuote(quote({ amount: '10001' }), listings[0]).code, 'market_over_listed_max');
  assert.equal(evaluateQuote(quote({ network: 'eip155:8453' }), listings[0]).code, 'market_network_not_testnet');
  assert.equal(evaluateQuote(quote({ network: 'eip155:1' }), listings[0]).code, 'market_network_not_testnet');
  assert.equal(evaluateQuote(quote({ payTo: '0x' + '9'.repeat(40) }), listings[0]).code, 'market_payee_mismatch');
  assert.equal(evaluateQuote(quote({ payTo: SELLER }), listings[0]).code, 'market_payee_mismatch', 'paying the seller directly would skip the fee split');
  assert.equal(evaluateQuote(quote({ amount: '1e3' }), listings[0]).code, 'market_quote_invalid');
  assert.equal(evaluateQuote(quote({ amount: '0' }), listings[0]).code, 'market_quote_invalid');
  assert.equal(evaluateQuote({ accepts: [] }, listings[0]).code, 'market_quote_unsupported');
  assert.equal(evaluateQuote(null, listings[0]).code, 'market_quote_unsupported');
  assert.equal(evaluateQuote(quote({ scheme: 'upto' }), listings[0]).code, 'market_quote_unsupported');
});

test('402 flow: confirmation is required and shows the max charge, the payee and the 1% / 99% split', async () => {
  let shown = null;
  const plan = await prepareMarketPayment(quote({ amount: '10000' }), listings[0], async (c) => { shown = c; return true; });
  assert.equal(plan.ok, true);
  assert.deepEqual([shown.maxChargeAtomic, shown.payee, shown.feeAtomic, shown.sellerAtomic], [10000, SPLITTER, 100, 9900]);
  for (const answer of [false, undefined, 'yes', 1]) {
    assert.equal((await prepareMarketPayment(quote(), listings[0], async () => answer)).code, 'market_user_rejected');
  }
  let confirmed = false;
  await prepareMarketPayment(quote({ amount: '99999999' }), listings[0], async () => { confirmed = true; return true; });
  assert.equal(confirmed, false, 'a refused quote never reaches the confirmation');
});

test('split amounts: 1% fee, rest to the seller, always summing to the total', () => {
  assert.deepEqual(splitAmount(10000), { feeAtomic: 100, sellerAtomic: 9900 });
  assert.deepEqual(splitAmount(99), { feeAtomic: 0, sellerAtomic: 99 });
  for (const n of [1, 100, 101, 12345, 10_000_000]) { const s = splitAmount(n); assert.equal(s.feeAtomic + s.sellerAtomic, n); }
  assert.throws(() => splitAmount(-1));
});

test('paid execution stays refused for non-market commands; only the market command is separate', async () => {
  const seen = [];
  const invoke = guardWalletChain(async (name) => { seen.push(name); return 'ok'; }, async () => false);
  for (const name of PAID_AI_COMMANDS) await assert.rejects(invoke(name, {}), { message: 'ai_paid_execution_disabled' }, name);
  assert.equal(isMarketAiCommand('ai_market_call'), true);
  assert.equal(isPaidAiCommand('ai_market_call'), false);
  assert.equal(isMarketAiCommand('ai_call'), false);
  assert.equal(isMarketAiCommand('ai_pay_and_call'), false);
  assert.equal(await invoke('ai_market_call', {}), 'ok');
  assert.deepEqual(seen, ['ai_market_call']);
});

test('the picker shows market listings next to other models, filters work, and the disclosure gates the pick', async () => {
  const dom = new JSDOM('<body><input id=i><datalist id=l></datalist><button id=r></button><p id=s></p><button id=chip><span id=cl></span></button><div id=pop hidden><input id=q><div id=o></div></div></body>');
  const { document } = dom.window; const g = (id) => document.getElementById(id);
  const storage = memory(); let prompts = 0;
  const market = createMarketController({ storage, getListings: () => listings, ask: async () => { prompts++; return true; } });
  const picker = createPiModelPicker(document, {
    input: g('i'), list: g('l'), refreshButton: g('r'), status: g('s'),
    invoke: async () => ({ models: ['openai/gpt-x'] }), market,
    ui: { chip: g('chip'), chipLabel: g('cl'), popover: g('pop'), search: g('q'), options: g('o') },
  });
  await picker.refresh(true);
  g('chip').click();
  const marketOptions = () => [...g('o').querySelectorAll('[data-model^="market:"]')];
  assert.equal(marketOptions().length, 3);
  assert.ok(g('o').querySelector('[data-model="openai/gpt-x"]'), 'BYOK/local model still listed');
  g('o').querySelector('[data-filter="no_retention"]').click();
  assert.equal(marketOptions().length, 2);
  g('o').querySelector('[data-filter="attested"]').click();
  assert.equal(marketOptions().length, 0);
  g('o').querySelector('[data-filter="attested"]').click();
  assert.equal(g('i').value, '');
  marketOptions()[0].click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(prompts, 1);
  assert.match(g('i').value, /^market:/);
  picker.destroy();
});

import { createConnectionChat } from './byok-chat.mjs';

test('a market ref is sent through ai_market_call with the listing, never a key, and private is false', async () => {
  const dom = new JSDOM('<body><div id=host></div><div id=tl></div></body>');
  const { document } = dom.window;
  const calls = [];
  const invoke = async (name, args) => { calls.push([name, args]); if (name === 'ai_market_call') return { status: 'ok', text: 'answer' }; throw new Error('unexpected ' + name); };
  const chat = createConnectionChat({ document, invoke, listen: null, host: document.getElementById('host'), timeline: document.getElementById('tl'), market: { listing: (id) => listings.find((l) => l.id === id) ?? null } });
  const ref = `market:${listings[0].id}/m1`;
  assert.equal(chat.handles(ref), true);
  assert.equal(await chat.send('hello', ref, 'm1'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'ai_market_call');
  assert.equal(calls[0][1].private, false);
  assert.equal(calls[0][1].listing.payeeAddress, SPLITTER);
  assert.equal(JSON.stringify(calls[0][1]).match(/key|secret|token/i), null);
  assert.match(document.body.textContent, /answer/);
  assert.match(document.body.textContent, /プロンプトはこの提供者に届きます/);
});

test('a failing market call shows a plain reason and keeps the chat usable', async () => {
  const dom = new JSDOM('<body><div id=host></div><div id=tl></div></body>');
  const { document } = dom.window;
  const invoke = async () => { throw new Error('market_over_listed_max'); };
  const chat = createConnectionChat({ document, invoke, listen: null, host: document.getElementById('host'), timeline: document.getElementById('tl'), market: { listing: (id) => listings.find((l) => l.id === id) ?? null } });
  await chat.send('hello', `market:${listings[0].id}/m1`, 'm1');
  assert.match(document.body.textContent, /上限を超えている/);
  assert.equal(chat.isBusy(), false);
});

// API market (2026-11-04): AI endpoints are one kind of listing.
const apiRaw = (n, kind, over = {}) => raw(n, { type: 'api.endpoint', kind, modelIds: [], ...over });

test('old ai.endpoint rows without a kind are kind ai; api.endpoint needs a non-ai kind and no models', () => {
  assert.equal(listings[0].kind, 'ai');
  const maps = normalizeListing(apiRaw(4, 'maps'));
  assert.equal(maps.kind, 'maps');
  assert.deepEqual([...maps.modelIds], []);
  assert.equal(normalizeListing(apiRaw(4, 'ai')), null);
  assert.equal(normalizeListing(apiRaw(4, 'casino')), null);
  assert.equal(normalizeListing(apiRaw(4, 'maps', { modelIds: ['m'] })), null);
  assert.equal(normalizeListing(raw(1, { kind: 'maps' })), null);
  assert.equal(normalizeListing(raw(1, { modelIds: [] })), null);
});

test('the AI picker shows kind ai only; the market list filters by kind and shows the kind label', () => {
  const all = [...listings, normalizeListing(apiRaw(4, 'maps')), normalizeListing(apiRaw(5, 'weather'))];
  assert.ok(pickerRows(all).every((r) => r.listing.kind === 'ai'));
  assert.equal(pickerRows(all).length, 3);
  assert.deepEqual(selectListings(all, { kind: 'weather' }).map((l) => l.kind), ['weather']);
  const controller = createMarketController({ storage: memory(), getListings: () => all, ask: async () => true });
  assert.equal(controller.listings().length, 5);
  controller.setKind('maps');
  assert.deepEqual(controller.listings().map((e) => e.kindLabel), ['地図']);
  assert.equal(controller.rows().length, 3);
  controller.setKind('nonsense');
  assert.equal(controller.kind(), 'maps');
  controller.setKind(null);
  assert.equal(controller.listings().length, 5);
});
