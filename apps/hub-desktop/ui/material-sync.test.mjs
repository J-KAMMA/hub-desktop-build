import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMaterialSync } from './material-sync.mjs';
import { applyAppearance } from './appearance.mjs';

function fixture(attrs, answer = true) {
  const dom = new JSDOM('<html></html>');
  const root = dom.window.document.documentElement;
  for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
  const events = [];
  const invoke = async (name, args) => { events.push(['invoke', name, { ...args }]); return typeof answer === 'function' ? answer() : answer; };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const sync = createMaterialSync({ root, invoke, MutationObserverImpl: dom.window.MutationObserver });
  return { root, events, settle, sync };
}

test('material is requested once at startup with the resolved theme and the setting', async () => {
  for (const [attrs, want] of [
    [{ 'data-theme': 'dark', 'data-theme-mode': 'dark' }, { dark: true, mode: 'dark' }],
    [{ 'data-theme': 'light', 'data-theme-mode': 'light' }, { dark: false, mode: 'light' }],
    [{ 'data-theme': 'dark', 'data-theme-mode': 'system' }, { dark: true, mode: 'system' }],
    [{ 'data-theme': 'light' }, { dark: false, mode: 'light' }],
  ]) {
    const f = fixture(attrs); await f.settle();
    assert.deepEqual(f.events, [['invoke', 'window_material', want]]);
    assert.equal(f.root.dataset.material, 'mica');
  }
});

test('re-sync runs after every theme or mode change, in order, and not for unrelated attributes', async () => {
  const f = fixture({ 'data-theme': 'dark', 'data-theme-mode': 'dark' }); await f.settle();
  f.root.setAttribute('data-density', 'roomy'); await f.settle();
  assert.equal(f.events.length, 1);
  applyAppearance(f.root, { template: 'light' }, true); await f.settle();
  applyAppearance(f.root, { template: 'device' }, true); await f.settle();   // OS dark
  applyAppearance(f.root, { template: 'device' }, false); await f.settle();  // OS flips to light
  applyAppearance(f.root, { template: 'dark' }, false); await f.settle();
  assert.deepEqual(f.events.map((e) => `${e[2].mode}:${e[2].dark}`), ['dark:true', 'light:false', 'system:true', 'system:false', 'dark:true']);
});

test('a failed or declined material removes data-material; a stale answer cannot restore it', async () => {
  const off = fixture({ 'data-theme': 'dark' }, false); await off.settle();
  assert.equal(off.root.dataset.material, undefined);
  const bad = fixture({ 'data-theme': 'dark' }, () => { throw Error('x'); }); await bad.settle();
  assert.equal(bad.root.dataset.material, undefined);
});
