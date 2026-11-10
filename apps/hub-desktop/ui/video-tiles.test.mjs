import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { VIDEO_EMPTY, emptyFor, createVideoEmpty, createVideoShelf } from './video-tiles.mjs';
import { createVideoCard, createVideoSkeletons, renderVideoHome } from './video-home.mjs';

const { document } = new JSDOM('<body></body>').window;
const video = { id: 'v1', title: '二行に収まらないほど長い題の動画です'.repeat(3), channel: 'チャンネル', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', duration: '12:34', viewCount: 1200, publishedAt: '2026-11-01T00:00:00Z' };
const deps = { document, hubAsset: () => {}, relTime: () => '1日前', onOpen: () => {} };
const css = readFileSync(new URL('./video-tiles.css', import.meta.url), 'utf8');

test('a tile is the 16:9 thumbnail, a channel avatar, the title, the channel and the meta line, with no card', () => {
  const tile = createVideoCard(document, video, deps);
  assert.ok(tile.querySelector('.video-thumbnail'));
  assert.equal(tile.querySelector('.vh-avatar').textContent, 'チ');
  assert.equal(tile.querySelector('.video-card-copy strong').textContent, video.title);
  assert.deepEqual([...tile.querySelectorAll('.video-card-copy > span')].map(node => node.textContent), ['チャンネル', '1,200 回視聴 · 1日前']);
  assert.equal(tile.querySelector('.video-duration').textContent, '12:34');
  assert.ok(!tile.classList.contains('card'));
});

test('shelves hang under a heading in a tile grid; home shelves use the same classes', () => {
  const shelf = createVideoShelf(document, '新着', [createVideoCard(document, video, deps)]);
  assert.equal(shelf.querySelector('h3.vt-shelf-title').textContent, '新着');
  assert.equal(shelf.querySelectorAll('.vt-grid > .vh-card').length, 1);
  const host = document.createElement('div');
  renderVideoHome(host, { items: [{ ...video, topic: '音楽' }], deps });
  assert.ok(host.querySelector('section.vt-shelf > .vt-grid > .vh-card'));
  assert.ok(host.querySelector('.vh-row .vh-grid .vh-card'), 'old class names stay');
});

test('skeletons have the final tile shape: 16:9 frame, 36px avatar circle and two lines, no text', () => {
  const skeletons = createVideoSkeletons(document, 3);
  assert.equal(skeletons.length, 3);
  for (const node of skeletons) {
    assert.equal(node.getAttribute('aria-hidden'), 'true');
    assert.ok(node.querySelector('.vh-skeleton-frame.ds-skeleton'));
    assert.ok(node.querySelector('.vh-skeleton-body > .vh-skeleton-avatar.ds-skeleton'));
    assert.equal(node.querySelectorAll('.vh-skeleton-lines > .ds-skeleton').length, 2);
    assert.equal(node.textContent, '');
  }
  assert.match(css, /\.vh-skeleton-avatar \{[^}]*width: 36px; height: 36px/);
  assert.match(css, /\.vh-skeleton-frame \{[^}]*aspect-ratio: 16 \/ 9/);
});

test('empty states are quiet: a title, a body, at most one button, no icon', () => {
  for (const [name, spec] of Object.entries(VIDEO_EMPTY)) {
    const box = createVideoEmpty(document, spec, { onAction: () => {} });
    assert.equal(box.querySelector('.vt-empty-title').textContent, spec.title, name);
    assert.equal(box.querySelector('.vt-empty-body')?.textContent ?? box.title, spec.body, name);
    assert.ok(box.querySelectorAll('button').length <= 1, name);
    assert.equal(box.querySelector('svg, img, .empty-icon, .state-icon'), null, name);
    assert.equal(box.getAttribute('role'), 'status');
    assert.ok(!/読み込んでいます|読み込み中/.test(spec.title + spec.body), 'loading is a skeleton, not text');
  }
});

test('the button appears only when the spec asks for one and a handler exists, and it runs it', () => {
  let ran = 0;
  assert.equal(createVideoEmpty(document, VIDEO_EMPTY.history, { onAction: () => {} }).querySelector('button'), null);
  assert.equal(createVideoEmpty(document, VIDEO_EMPTY.error).querySelector('button'), null);
  const button = createVideoEmpty(document, VIDEO_EMPTY.error, { onAction: () => { ran++; } }).querySelector('button');
  assert.equal(button.textContent, 'もう一度');
  button.click();
  assert.equal(ran, 1);
});

test('emptyFor picks the wording by screen: filtered home, each mode, failure first', () => {
  assert.equal(emptyFor({ mode: 'home' }), VIDEO_EMPTY.home);
  assert.equal(emptyFor({ mode: 'home', filtered: true }), VIDEO_EMPTY.filtered);
  assert.equal(emptyFor({ mode: 'history' }), VIDEO_EMPTY.history);
  assert.equal(emptyFor({ mode: 'subscriptions' }), VIDEO_EMPTY.subscriptions);
  assert.equal(emptyFor({ mode: 'shorts', failed: true }), VIDEO_EMPTY.error);
  assert.equal(emptyFor({ mode: 'unknown' }), VIDEO_EMPTY.home);
});

test('the tile CSS pins the design numbers and uses no raw colours', () => {
  assert.match(css, /minmax\(280px, 1fr\)/);
  assert.match(css, /\.video-thumbnail \{ border-radius: var\(--ds-radius-tile-video\)/);
  assert.match(css, /\.vh-avatar \{[^}]*width: 36px; height: 36px/);
  assert.match(css, /-webkit-line-clamp: 2;[^}]*var\(--ds-weight-strong\)/);
  assert.match(css, /vt-empty-title \{[^}]*var\(--ds-weight-heavy\)/);
  assert.match(css, /vt-empty-action \{ height: 36px/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
});
