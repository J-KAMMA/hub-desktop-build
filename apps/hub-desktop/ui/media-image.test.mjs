import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { isAllowedImageUrl, squareArtworkUrl, createTextCover, createCoverMedia } from './media-image.mjs';

test('only the window CSP image sources are allowed; picsum and other outside hosts are not', () => {
  assert.equal(isAllowedImageUrl('/api/files/a.jpg'), true);
  assert.equal(isAllowedImageUrl('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'), true);
  assert.equal(isAllowedImageUrl('https://hub.jkamma.com/x.png'), true);
  assert.equal(isAllowedImageUrl('http://localhost:3020/x.png'), true);
  assert.equal(isAllowedImageUrl('https://picsum.photos/680/380'), false);
  assert.equal(isAllowedImageUrl('//evil.example/a.png'), false);
  assert.equal(isAllowedImageUrl('https://user:pw@hub.jkamma.com/x.png'), false);
  assert.equal(isAllowedImageUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedImageUrl(''), false);
  assert.equal(isAllowedImageUrl(null), false);
  assert.equal(isAllowedImageUrl('https://mirror.example/a.png', { hubOrigin: 'https://mirror.example' }), true);
});

test('square art uses mqdefault: hqdefault and sddefault carry letterbox bars', () => {
  for (const size of ['hqdefault', 'sddefault', 'maxresdefault', 'default', 'mqdefault']) {
    assert.equal(squareArtworkUrl(`https://i.ytimg.com/vi/dQw4w9WgXcQ/${size}.jpg`), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  }
  assert.equal(squareArtworkUrl('https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/hqdefault.webp'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  assert.equal(squareArtworkUrl('/music/api/tracks/x/artwork'), '/music/api/tracks/x/artwork');
  assert.equal(squareArtworkUrl(undefined), undefined);
});

test('cover media: allowed image gets an <img> in a ratio frame; outside image gets a text cover and no <img>', () => {
  const { document } = new JSDOM('<main></main>').window;
  const seen = [];
  const hubAsset = (img, url) => { img.dataset.src = url; seen.push(url); };
  const ok = createCoverMedia(document, { url: '/a.jpg', title: '題', hubAsset, ratio: '16 / 9' });
  assert.ok(ok.classList.contains('ds-media'));
  assert.equal(ok.style.getPropertyValue('--ratio'), '16 / 9');
  assert.equal(ok.querySelectorAll('img').length, 1);
  const blocked = createCoverMedia(document, { url: 'https://picsum.photos/680/380', title: '静かな読書', hubAsset });
  assert.equal(blocked.querySelector('img'), null);
  assert.equal(blocked.querySelector('.ds-cover').textContent, '静かな読書');
  assert.deepEqual(seen, ['/a.jpg'], 'the blocked URL is never handed to the loader');
  const none = createCoverMedia(document, { url: undefined, title: '', hubAsset });
  assert.equal(none.querySelector('.ds-cover').textContent, 'Hub');
  const generated = createCoverMedia(document, { url: undefined, title: '題', fallbackLabel: '読書', hubAsset });
  assert.equal(generated.querySelector('.ds-cover-generated .ds-cover-label').textContent, '読書');
  assert.equal(generated.textContent, '読書');
});

test('a failed load swaps the image for the text cover', () => {
  const { document } = new JSDOM('<main></main>').window;
  const frame = createCoverMedia(document, { url: '/gone.jpg', title: '消えた', hubAsset: () => {} });
  frame.querySelector('img').onerror();
  assert.equal(frame.querySelector('img'), null);
  assert.equal(frame.querySelector('.ds-cover').textContent, '消えた');
  assert.equal(createTextCover(document, 'x', 'extra').className, 'ds-cover extra');
  const generated = createCoverMedia(document, { url: '/gone.jpg', title: '消えた', fallbackLabel: '記録', hubAsset: () => {} });
  generated.querySelector('img').onerror();
  assert.equal(generated.querySelector('.ds-cover-generated .ds-cover-label').textContent, '記録');
  assert.equal(generated.textContent, '記録');
});

test('square cover media crops YouTube thumbs to mqdefault', () => {
  const { document } = new JSDOM('<main></main>').window;
  const frame = createCoverMedia(document, { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', title: 't', hubAsset: (img, url) => { img.dataset.src = url; }, ratio: '1 / 1', square: true });
  assert.equal(frame.querySelector('img').dataset.src, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
});
