import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { gameInitial, renderGameDetail } from './games-tiles.mjs';
import { normalizeStoreGames } from './games-view.mjs';

const fresh = () => { const { document } = new JSDOM('<main id="t"></main>').window; return { document, target: document.querySelector('#t') }; };
const store = normalizeStoreGames({ games: [
  { slug: 'a', title: 'Store A', summary: 'Sword and sorcery', platforms: ['PC', 'Nintendo Switch'], releaseDate: '2026-10-18', priceLabel: '無料', imageUrl: '/img/a.png' },
  { slug: 'b', title: 'Store B' },
] });

test('store detail: hero image via asset, meta, summary, only the Web open action', () => {
  const { document, target } = fresh();
  const opened = [];
  renderGameDetail(document, target, store[0], { kind: 'store', asset: (img, url) => { img.dataset.src = url; }, back() {}, openWeb: g => opened.push(g.slug) });
  assert.equal(target.querySelector('.games-art-hero img').dataset.src, '/img/a.png');
  assert.match(target.querySelector('.games-detail-meta').textContent, /PC.*Switch.*2026年10月18日.*無料/);
  assert.equal(target.querySelector('.games-description').textContent, 'Sword and sorcery');
  assert.deepEqual([...target.querySelectorAll('.games-actions .btn')].map(b => b.textContent), ['マーケットで開く']);
  target.querySelector('.btn-primary').click();
  assert.deepEqual(opened, ['a']);
  assert.equal(target.querySelectorAll('.games-info-row').length, 3);
});

test('css and modules use tokens only', () => {
  const css = readFileSync(new URL('./games-view.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|:\s*(white|black)\b/);
  assert.doesNotMatch(css, /(?:font-size|border-radius)\s*:\s*\d+px/);
  for (const f of ['games-tiles.mjs']) assert.doesNotMatch(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});

test('a game title without a first character falls back to a question mark', () => {
  assert.equal(gameInitial(''), '?');
  assert.equal(gameInitial('日本語ゲーム'), '日');
});
