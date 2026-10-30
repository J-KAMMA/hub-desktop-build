import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHubSearchFilters } from './hub-search-filter-panel.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const empty = () => ({ filters: { from: '', to: '', maxPrice: '', currency: 'JPY' }, order: 'recommended' });
function fixture(t) {
  const dom = new JSDOM('<body><form></form></body>'), f = { dom, changes: 0, applied: [] };
  f.panel = createHubSearchFilters(dom.window.document, { onChange: () => f.changes++, onApply: value => f.applied.push(value) });
  dom.window.document.querySelector('form').append(f.panel.element);
  f.field = name => f.panel.element.querySelector(`[name="${name}"]`);
  f.input = (name, value) => { const field = f.field(name); field.value = value; field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  f.button = label => [...f.panel.element.querySelectorAll('button')].find(node => node.textContent === label);
  t.after(() => { f.panel.destroy(); dom.window.close(); }); return f;
}
test('starts compact and empty with accessible labels and all supported choices', t => {
  const f = fixture(t); assert.equal(f.panel.element.tagName, 'DETAILS'); assert.equal(f.panel.element.open, false); assert.deepEqual(f.panel.value(), empty());
  assert.equal(f.field('language').options.length, 12); assert.equal(f.field('type').options.length, 13);
  assert.deepEqual([...f.field('currency').options].map(option => option.value), ['JPY', 'USD', 'EUR']);
  for (const name of ['from', 'to', 'maxPrice', 'currency', 'language', 'region', 'category', 'type', 'order']) assert.ok(f.field(name).getAttribute('aria-label'));
  assert.equal(f.field('from').maxLength, 10); assert.equal(f.field('to').maxLength, 10); assert.equal(f.field('region').maxLength, 80); assert.equal(f.field('category').maxLength, 80);
  assert.equal(f.applied.length, 0); assert.equal(f.changes, 0); assert.ok([...f.panel.element.querySelectorAll('button')].every(button => button.type === 'button'));
});
test('draft edits notify without submitting and Apply sends every field as one canonical snapshot', t => {
  const f = fixture(t);
  for (const [name, value] of Object.entries({ from: '2026-10-01', to: '2026-10-06', maxPrice: '0001.20', currency: 'USD', language: 'en', region: ' Ｔｏｋｙｏ ', category: ' ＢＯＯＫＳ ', type: 'listings', order: 'kind' })) f.input(name, value);
  assert.equal(f.changes, 9); assert.deepEqual(f.applied, []);
  f.button('条件を適用').click(); assert.equal(f.applied.length, 1);
  assert.deepEqual(f.applied[0], { filters: { from: '2026-10-01', to: '2026-10-06', maxPrice: '1.2', currency: 'USD', language: 'en', region: 'tokyo', category: 'books', type: 'listings' }, order: 'kind' });
  assert.equal(f.field('maxPrice').value, '1.2'); assert.equal(f.field('region').value, 'tokyo'); assert.equal(f.changes, 9);
  f.applied[0].filters.region = 'changed-by-caller'; assert.equal(f.panel.value().filters.region, 'tokyo');
});
test('invalid price precision, dates, range and metadata block Apply while preserving editable drafts', t => {
  for (const draft of [{ currency: 'JPY', maxPrice: '1.2' }, { currency: 'USD', maxPrice: '1.234' }, { from: '2026-02-30' }, { from: '2026-10-06', to: '2026-10-01' }, { region: 'x'.repeat(81) }]) {
    const f = fixture(t); for (const [name, value] of Object.entries(draft)) f.input(name, value);
    f.button('条件を適用').click(); assert.deepEqual(f.applied, []); assert.equal(f.panel.element.open, true);
    assert.equal(f.panel.element.querySelector('[role="alert"]').hidden, false);
    for (const [name, value] of Object.entries(draft)) assert.equal(f.field(name).value, value);
  }
});
test('correcting a rejected draft clears the error and permits zero-price searches', t => {
  const f = fixture(t); f.input('maxPrice', '1.2'); f.button('条件を適用').click(); assert.equal(f.applied.length, 0);
  f.input('maxPrice', '0'); assert.equal(f.panel.element.querySelector('[role="alert"]').hidden, true);
  f.button('条件を適用').click(); assert.equal(f.applied.length, 1); assert.equal(f.applied[0].filters.maxPrice, '0'); assert.match(f.panel.element.querySelector('summary').textContent, /設定あり/);
});
test('Clear resets every condition and ordering before one change and one empty apply', t => {
  const f = fixture(t); f.panel.setValue({ filters: { from: '2026-10-01', to: '2026-10-06', maxPrice: '0', currency: 'EUR', language: 'ja', region: 'tokyo', category: 'books', type: 'threads' }, order: 'kind' });
  f.button('条件を解除').click(); assert.deepEqual(f.panel.value(), empty()); assert.deepEqual(f.applied, [empty()]); assert.equal(f.changes, 1); assert.equal(f.panel.element.querySelector('summary').textContent, '検索条件');
});
test('programmatic reset notifies only change; history replay defaults to silent and can explicitly notify', t => {
  const f = fixture(t); f.panel.setValue({ filters: { language: 'ja' }, order: 'kind' }); assert.equal(f.changes, 0); assert.equal(f.applied.length, 0);
  f.panel.setValue({ filters: { type: 'posts' }, order: 'recommended' }, { notify: true }); assert.equal(f.changes, 1); assert.equal(f.applied.length, 0);
  f.panel.reset(); assert.deepEqual(f.panel.value(), empty()); assert.equal(f.changes, 2); assert.equal(f.applied.length, 0);
});
test('invalid history snapshots are validated before any control changes', t => {
  const f = fixture(t); f.panel.setValue({ filters: { from: '2026-10-01', language: 'ja' }, order: 'kind' }); const previous = f.panel.value();
  for (const next of [{ filters: { from: '2026-02-30' }, order: 'recommended' }, { filters: { maxPrice: '1.1', currency: 'JPY' }, order: 'recommended' }, { filters: {}, order: 'unknown' }, { filters: {}, order: null }, { filters: null, order: 'recommended' }]) {
    assert.throws(() => f.panel.setValue(next)); assert.deepEqual(f.panel.value(), previous); assert.equal(f.changes, 0); assert.equal(f.applied.length, 0);
  }
});
test('input/change pairs do not double-notify and independent panels do not share controls', t => {
  const f = fixture(t), other = fixture(t); f.input('region', 'Tokyo'); f.field('region').dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); assert.equal(f.changes, 1);
  f.input('language', 'en'); f.field('language').dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); assert.equal(f.changes, 2); assert.deepEqual(other.panel.value(), empty());
});
test('destroy removes the panel and disables captured button/input callbacks and programmatic notifications', t => {
  const f = fixture(t), apply = f.button('条件を適用'), clear = f.button('条件を解除'), input = f.field('region');
  f.panel.destroy(); f.panel.destroy(); apply.click(); clear.click(); input.value = 'Tokyo'; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true })); f.panel.reset(); f.panel.setValue(empty(), { notify: true });
  assert.equal(f.panel.element.isConnected, false); assert.equal(f.applied.length, 0); assert.equal(f.changes, 0);
});
