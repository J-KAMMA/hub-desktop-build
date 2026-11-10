import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {conventions, FAM, expertStep, searchItems, practice, meanPractice, blended, totals, applyProposals} from './ui-familiarity.mjs';

const results = JSON.parse(readFileSync(new URL('../../../docs/hub-desktop-ui-cost/results.json', import.meta.url), 'utf8'));
const size = {rail: 13, sidebar: 9, card: 8, toolbar: 3};
const rail = (o = {}) => ({region: 'rail', rank: 1, n: 13, iconMatch: true, labelVisible: false, ...o});

test('expert numbers stay reproducible: the same formula gives every recorded step in results.json', () => {
  assert.deepEqual(results.coefficients, {base: 0.1, fitts: 0.15, hick: 0.15});
  let checked = 0;
  for (const t of results.tasks) for (const s of t.steps) {
    if (s.skipped) continue;
    assert.ok(Math.abs(expertStep(s) - s.seconds) < 0.002, t.name + ' / ' + s.label);
    checked++;
  }
  assert.ok(checked >= 12);
});

test('zero familiarity cost at the conventional place with the conventional icon', () => {
  assert.deepEqual(searchItems(rail(), ['rail'], size), {items: 0, seconds: 0});
  assert.equal(searchItems(rail({rank: 9}), ['rail', 'toolbar'], size).seconds, 0);
});

test('unfamiliar icon in the right place: random scan of the region, hover time when no text', () => {
  const s = searchItems(rail({iconMatch: false}), ['rail'], size);
  assert.equal(s.items, 7);
  assert.equal(s.seconds, 7 * FAM.tHover);
  assert.equal(searchItems(rail({iconMatch: false, labelVisible: true}), ['rail'], size).seconds, +(7 * FAM.tScan).toFixed(3));
});

test('wrong place: exhausts the expected region, then finds it by rank; an empty expected place costs one glance', () => {
  const el = {region: 'sidebar', rank: 9, n: 9, iconMatch: true, labelVisible: true};
  assert.equal(searchItems(el, ['rail'], size).seconds, +((13 + 9) * FAM.tScan).toFixed(3));
  assert.equal(searchItems(el, ['feedTop'], size).items, 10);
  // Farther from convention never costs less.
  assert.ok(searchItems({...el, iconMatch: false, labelVisible: false}, ['rail'], size).seconds > searchItems(el, ['rail'], size).seconds);
});

test('power law of practice falls with use; mean over the horizon is between the last and first use', () => {
  assert.equal(practice(1), 1);
  assert.ok(practice(2) < 1 && practice(10) < practice(2));
  const m = meanPractice(20, 0.4);
  assert.ok(m > practice(20, 0.4) && m < 1);
  assert.equal(meanPractice(1, 0.4), 1);
});

test('total = expert + share * familiarity; share 0 is the expert model', () => {
  assert.equal(blended(1.3, 7, 0), 1.3);
  assert.ok(Math.abs(blended(1.3, 7, 0.3) - (1.3 + 0.3 * 7 * meanPractice())) < 1e-9);
  const t = totals([{weight: 2, expert: 1, firstUse: 1}], [0, 0.6]);
  assert.equal(t.expert, 2);
  assert.equal(t.p0, 2);
  assert.ok(t['p0.6'] > t.p0);
});

test('a proposal that grows the rail charges every rail click one more Hick choice', () => {
  const rows = [
    {id: 'home', weight: 16, conv: ['rail'], el: rail({iconMatch: false}), fittsId: 4, hickBits: Math.log2(14)},
    {id: 'communities', weight: 4, conv: ['rail'], el: {region: 'sidebar', rank: 9, n: 9, iconMatch: true, labelVisible: true}, fittsId: 3, hickBits: Math.log2(10)},
  ];
  const before = applyProposals(rows, size);
  const after = applyProposals(rows, size, [{id: 'x', target: 'communities', change: {region: 'rail', rank: 4, labelVisible: false}, railGrows: 1}], {x: {fittsId: 4}});
  assert.equal(after.regionSize.rail, 14);
  assert.ok(after.rows[0].expert > before.rows[0].expert);
  assert.ok(after.rows[0].firstUse > before.rows[0].firstUse);
  assert.equal(after.rows[1].firstUse, 0);
});

test('the convention table marks every row and every constant with its evidence status', () => {
  for (const a of conventions.actions) {
    assert.match(a.status, /^(確認済み|未確認)/, a.id);
    if (a.status.startsWith('確認済み')) assert.ok(a.source, a.id);
    assert.ok(a.conv.length && a.weight > 0 && typeof a.iconMatch === 'boolean', a.id);
  }
  for (const [k, v] of Object.entries(conventions.constants)) assert.ok(v.status && v.source, k);
  const ids = new Set(conventions.actions.map(a => a.id));
  for (const p of conventions.proposals) assert.ok(p.target === '*rail' || ids.has(p.target), p.id);
});
