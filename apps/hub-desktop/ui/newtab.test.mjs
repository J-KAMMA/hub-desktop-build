import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { greeting } from './newtab-model.mjs';

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
test('greeting follows the hour', () => {
  const at = (hour) => greeting(new Date(2026, 9, 15, hour));
  assert.deepEqual([at(2), at(8), at(13), at(21)], ['こんばんは', 'おはようございます', 'こんにちは', 'こんばんは']);
});

test('the page is calm and local: no remote resources, gradients, upper-case labels or hero counters', () => {
  const html = read('newtab.html');
  const css = read('newtab-brave.css');
  const js = read('newtab.js');
  assert.doesNotMatch(html + css + js, /(?:src|href)=["']https?:|url\(\s*["']?https?:|@import|fetch\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(css, /gradient|text-transform:\s*uppercase|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  assert.match(html, /tokens\.css/);
  assert.ok(html.indexOf('tokens.css') < html.indexOf('newtab-brave.css'));
  assert.doesNotMatch(html + js, /newtab-sites|よく開くサイト|browser_history/, 'no frequently-opened sites (owner, 2026-10-15)');
  assert.match(js, /input\.focus\(\)/);
});
