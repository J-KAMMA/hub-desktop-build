import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { holdingBadge, holdingView, sortByHolding, communityHoldingSettings, HOLDING_ASSETS } from './community-holding.mjs';

const el = (tag) => {
  const node = { tag, children: [], attrs: {}, className: '', textContent: '', hidden: false, innerHTML: '', append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, setAttribute(k, v) { this.attrs[k] = v; } };
  return node;
};
const doc = { createElement: el };
const icon = () => '<svg/>';
const flat = (node) => [node.textContent, ...node.children.map(child => typeof child === 'string' ? child : flat(child))].join('');

test('holdingView accepts only the rounded shape the server sends', () => {
  assert.deepEqual(holdingView({ text: '0.012', symbol: 'BTC', rank: 2 }), { text: '0.012', symbol: 'BTC', rank: 2 });
  assert.deepEqual(holdingView({ text: '<0.001', symbol: 'BTC' }), { text: '<0.001', symbol: 'BTC', rank: null });
  for (const bad of [null, {}, { text: '0.0123456789012345678901', symbol: 'BTC' }, { text: 'bc1qxyz', symbol: 'BTC' }, { text: '1', symbol: 'btc' }, { text: '$5', symbol: 'BTC' }, { text: '1', symbol: 'BTC<script>' }]) assert.equal(holdingView(bad), null);
});

test('the mark shows icon and rounded text only; nothing for members who did not opt in', () => {
  const node = holdingBadge(doc, { text: '0.012', symbol: 'BTC', rank: 1 }, icon);
  assert.equal(node.attrs['aria-label'], '保有 0.012 BTC');
  assert.match(node.innerHTML, /svg/);
  assert.equal(flat(node), '0.012 BTC');
  assert.equal(holdingBadge(doc, null, icon), null);
  assert.equal(holdingBadge(doc, undefined, icon), null);
});

test('the opted-in list sorts by rank and keeps the original order for everyone else', () => {
  const members = [{ id: 'a' }, { id: 'b', holding: { text: '0.012', symbol: 'BTC', rank: 2 } }, { id: 'c' }, { id: 'd', holding: { text: '1.8', symbol: 'BTC', rank: 1 } }];
  assert.deepEqual(sortByHolding(members).map(m => m.id), ['d', 'b', 'a', 'c']);
});

test('only the BTC mainnet asset is offered and it is a native id', () => {
  assert.deepEqual(HOLDING_ASSETS.map(a => a.symbol), ['BTC']);
  assert.ok(HOLDING_ASSETS.every(a => a.id.endsWith('/native')));
});

test('settings: opt-in is off by default and the switch writes only {optIn}', async () => {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push([name, args]);
    if (name === 'hub_detail') return { requirement: { assetId: HOLDING_ASSETS[0].id, symbol: 'BTC' }, optIn: false, holding: null };
    return { requirement: { assetId: HOLDING_ASSETS[0].id, symbol: 'BTC' }, optIn: true, holding: { text: '0.012', symbol: 'BTC', rank: 1 } };
  };
  const view = communityHoldingSettings(doc, { communityId: 'c1', canManage: false, joined: true, invoke, icon });
  await view.ready;
  const label = view.root.children[1].children.find(child => child.tag === 'label');
  const input = label.children[0];
  assert.equal(input.checked, false);
  input.checked = true;
  await input.onchange();
  const write = calls.find(([name]) => name === 'hub_client_action');
  assert.deepEqual(write[1], { action: 'community_holding_set', target: 'c1', options: { optIn: true } });
});

test('settings stay hidden for a member when the community shows no asset', async () => {
  const invoke = async () => ({ requirement: null, optIn: false, holding: null });
  const view = communityHoldingSettings(doc, { communityId: 'c1', canManage: false, joined: true, invoke, icon });
  await view.ready;
  assert.equal(view.root.hidden, true);
});

test('the desktop wiring uses the fixed holding action and names no address or balance field', () => {
  const source = readFileSync(new URL('./community-holding.mjs', import.meta.url), 'utf8');
  assert.match(source, /community_holding_set/);
  assert.doesNotMatch(source, /address|balance|satoshi|usd|fiat/i);
  assert.doesNotMatch(readFileSync(new URL('./unified-post.css', import.meta.url), 'utf8').split('Holder communities')[1], /#[0-9a-f]{3,8}\b|rgb\(|hsl\(|\bwhite\b(?!-)|\bblack\b/i);
});
