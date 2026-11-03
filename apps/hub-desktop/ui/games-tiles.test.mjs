import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { gameInitial, renderLibraryGrid, renderLibraryEmpty, renderLibrarySkeleton, renderGamesEmpty, renderGameDetail } from './games-tiles.mjs';
import { createGamesPage } from './games-page.mjs';
import { normalizeStoreGames } from './games-view.mjs';

const fresh = () => { const { document } = new JSDOM('<main id="t"></main>').window; return { document, target: document.querySelector('#t') }; };
const entries = [{ id: 1, title: 'Alpha', executablePath: 'C:/g/a.exe' }, { id: 2, title: '日本語ゲーム', executablePath: 'C:/g/b.exe' }];
const store = normalizeStoreGames({ games: [
  { slug: 'a', title: 'Store A', summary: 'Sword and sorcery', platforms: ['PC', 'Nintendo Switch'], releaseDate: '2026-10-18', priceLabel: '無料', imageUrl: '/img/a.png' },
  { slug: 'b', title: 'Store B' },
] });

test('library tiles: art with initial, title, meta; click opens the entry; no card chrome', () => {
  const { document, target } = fresh();
  const opened = [];
  renderLibraryGrid(document, target, entries, { open: e => opened.push(e.id) });
  const tiles = target.querySelectorAll('.games-library > .games-tile');
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].querySelector('.games-art-letter').textContent, 'A');
  assert.equal(tiles[1].querySelector('.games-art-letter').textContent, '日');
  assert.equal(tiles[0].querySelector('.games-tile-title').textContent, 'Alpha');
  assert.ok(tiles[0].querySelector('.games-tile-meta').textContent);
  tiles[1].click();
  assert.deepEqual(opened, [2]);
  assert.equal(gameInitial(''), '?');
});

test('empty states are quiet: title, body, at most one secondary button, no icon', () => {
  const { document, target } = fresh();
  let added = 0;
  renderLibraryEmpty(document, target, { add: () => { added += 1; } });
  assert.match(target.querySelector('.state-title').textContent, /登録したゲームはありません/);
  assert.equal(target.querySelectorAll('button').length, 1);
  assert.ok(target.querySelector('button').classList.contains('btn-secondary'));
  assert.equal(target.querySelectorAll('svg, .state-icon, .empty-icon').length, 0);
  target.querySelector('button').click();
  assert.equal(added, 1);
  renderGamesEmpty(document, target, { title: 't', body: 'b' });
  assert.equal(target.querySelectorAll('button').length, 0);
});

test('skeleton has the final tile shape and no loading text', () => {
  const { document, target } = fresh();
  renderLibrarySkeleton(document, target, 4);
  assert.equal(target.querySelectorAll('.games-tile-skeleton').length, 4);
  assert.equal(target.querySelector('.games-skeleton-library').getAttribute('aria-busy'), 'true');
  assert.equal(target.textContent.trim(), '');
});

test('local detail: hero, title, existing actions only (launch / remove), path row', () => {
  const { document, target } = fresh();
  const calls = [];
  renderGameDetail(document, target, entries[0], { kind: 'local', back: () => calls.push('back'), launch: e => calls.push(['launch', e.id]), remove: e => calls.push(['remove', e.id]) });
  assert.ok(target.querySelector('.games-art-hero'));
  assert.equal(target.querySelector('.games-detail-title').textContent, 'Alpha');
  assert.deepEqual([...target.querySelectorAll('.games-actions .btn')].map(b => b.textContent), ['このPCで起動', '削除']);
  assert.match(target.querySelector('.games-info').textContent, /C:\/g\/a\.exe/);
  target.querySelector('.btn-primary').click();
  target.querySelector('.btn-ghost').click();
  target.querySelector('.games-back').click();
  assert.deepEqual(calls, [['launch', 1], ['remove', 1], 'back']);
});

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

test('page: routes switch only the main column and report them to the tree', () => {
  const { document, target } = fresh();
  const routes = [];
  const page = createGamesPage({ document, host: target, deps: { asset() {}, launch() {}, remove() {}, add() {}, onRoute: r => routes.push(r.page) } });
  page.setLocal(null);
  assert.equal(target.querySelectorAll('.games-tile-skeleton').length > 0, true);
  page.setLocal([]);
  assert.match(target.textContent, /登録したゲームはありません/);
  page.setLocal(entries);
  assert.equal(target.querySelectorAll('.games-tile').length, 2);
  page.setQuery('alp');
  assert.equal(target.querySelectorAll('.games-tile').length, 1);
  page.setQuery('zzz');
  assert.match(target.textContent, /見つかりません/);
  page.setQuery('');
  target.querySelector('.games-tile').click();
  assert.deepEqual(page.route(), { page: 'game', id: '1' });
  assert.ok(target.querySelector('.games-detail'));
  target.querySelector('.games-back').click();
  assert.equal(page.route().page, 'library');
  page.go({ page: 'game', id: '99' });
  assert.match(target.querySelector('.state-title').textContent, /見つかりません/);
  assert.ok(routes.length >= 3);
});

test('css and modules use tokens only', () => {
  const css = readFileSync(new URL('./games-view.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|:\s*(white|black)\b/);
  assert.doesNotMatch(css, /(?:font-size|border-radius)\s*:\s*\d+px/);
  for (const f of ['games-tiles.mjs', 'games-page.mjs']) assert.doesNotMatch(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});
