import test from 'node:test';
import assert from 'node:assert/strict';
import { articleReadingMinutes, articleReadingLabel } from './article-reading.mjs';

test('空や記号だけは0分、短い本文は1分', () => {
  assert.equal(articleReadingMinutes(''), 0);
  assert.equal(articleReadingMinutes(undefined), 0);
  assert.equal(articleReadingMinutes('## \n---'), 0);
  assert.equal(articleReadingMinutes('こんにちは'), 1);
});

test('日本語は550字ごとに1分、URLと画像は数えない', () => {
  assert.equal(articleReadingMinutes('あ'.repeat(550)), 1);
  assert.equal(articleReadingMinutes('あ'.repeat(551)), 2);
  assert.equal(articleReadingMinutes('あ'.repeat(550) + '\n![図](https://example.com/' + 'x'.repeat(2000) + '.png)'), 1);
});

test('英語は220語ごとに1分', () => {
  assert.equal(articleReadingMinutes('word '.repeat(220)), 1);
  assert.equal(articleReadingMinutes('word '.repeat(221)), 2);
});

test('ラベル', () => {
  assert.equal(articleReadingLabel(3), '約3分で読めます');
  assert.equal(articleReadingLabel(0), null);
});
