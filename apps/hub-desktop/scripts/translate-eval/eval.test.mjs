import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chrf, plamoPrompt, madladPrompt, gemmaPrompt, renderHtml, PROMPTS} from './lib.mjs';

const load = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

test('the evaluation set has 50 unique items over the six requested pairs', () => {
  const {items} = load('./eval-set.json');
  assert.equal(items.length, 50);
  assert.equal(new Set(items.map((i) => i.id)).size, 50);
  const count = {};
  for (const i of items) count[i.pair] = (count[i.pair] ?? 0) + 1;
  assert.deepEqual(count, {'ja-en': 10, 'en-ja': 10, 'ja-zh': 8, 'ja-ko': 8, 'en-es': 7, 'zh-ja': 7});
  for (const i of items) { assert.ok(i.src.trim() && i.ref.trim(), i.id); assert.ok(i.id.startsWith(i.pair.replace('-', ''))); }
  const tags = new Set(items.flatMap((i) => i.tags));
  for (const t of ['slang', 'emoji', 'name', 'url', 'technical', 'article']) assert.ok(tags.has(t), t);
});

test('chrF: identical is 100, disjoint is 0, partial is between', () => {
  assert.equal(chrf('hello world', 'hello world'), 100);
  assert.equal(chrf('abc', 'xyz'), 0);
  const mid = chrf('hello wurld', 'hello world');
  assert.ok(mid > 50 && mid < 100, String(mid));
  assert.equal(chrf('', ''), 0);
  assert.ok(chrf('今日は晴れです', '今日は晴れだ') > 40);
});

test('prompts follow each model card; unsupported pairs return null', () => {
  assert.equal(plamoPrompt('こんにちは', 'ja', 'en'),
    '<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>こんにちは<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>');
  assert.equal(plamoPrompt('こんにちは', 'ja', 'ko'), null);
  assert.equal(madladPrompt(' hola ', 'es', 'ja'), '<2ja> hola');
  const g = gemmaPrompt('hello', 'en', 'ja');
  assert.ok(g.startsWith('<start_of_turn>user\nYou are a professional English (en) to Japanese (ja) translator.'));
  assert.ok(g.includes('Please translate the following English text into Japanese:\n\n\nhello<end_of_turn>\n<start_of_turn>model\n'));
  assert.ok(!plamoPrompt('x<|plamo:tag|>y', 'ja', 'en').includes('x<|plamo:tag|>y'));
  assert.deepEqual(Object.keys(PROMPTS), ['plamo', 'madlad', 'gemma']);
});

test('report html escapes text and lists every model column', () => {
  const items = [{id: 'a', pair: 'ja-en', src: '<b>', ref: 'r'}];
  const html = renderHtml(items, {m1: {a: {out: '<script>', ms: 5, chrf: 12.3}}, m2: {}}, {m1: {'ja-en': 12.3}});
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<th>m1</th>') && html.includes('<th>m2</th>'));
});
