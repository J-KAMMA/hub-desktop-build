import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createMusicHome, createMusicHistory, greetingFor } from './music-home.mjs';
import { buildShelves, createShelfStore, SHELVES } from './music-shelves.mjs';
import { createMusicYoutubeSession } from './music-youtube.mjs';

const yt = id => ({ provider: 'youtube', url: `https://music.youtube.com/watch?v=${id}`, embedUrl: `https://www.youtube-nocookie.com/embed/${id}` });
const UUID = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const works = [
  { id: 'sample-mw-1', title: 'Alpha', artist: 'A', services: [yt('dQw4w9WgXcQ')] },
  { id: 'sample-mw-2', title: 'Beta', artist: 'B', services: [{ provider: 'spotify', url: 'https://open.spotify.com/track/x' }] },
];
const hubWork = n => ({ id: `music:${UUID(n)}`, title: `Hub${n}`, artist: 'H', services: [] });
const track = n => ({ id: UUID(n), title: `Hub${n}`, artist: 'H' });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function homeFixture(t, loaders = {}) {
  const dom = new JSDOM('<main id="host"></main>', { url: 'http://localhost' });
  const { document } = dom.window;
  const calls = [];
  const counts = { recommended: 0, favorites: 0, peers: 0 };
  const history = createMusicHistory();
  const home = createMusicHome({
    document, host: document.getElementById('host'), hubAsset: (img, url) => { img.dataset.src = url; }, history,
    loaders: {
      recommended: async () => { counts.recommended++; return works; }, favorites: async () => { counts.favorites++; return []; }, tracks: () => [], peers: async () => { counts.peers++; return []; }, ...loaders,
    },
    actions: {
      openWork: work => calls.push(['open', work.id]), playWork: work => calls.push(['play', work.id]),
      playTrack: item => calls.push(['track', item.id]), search: query => calls.push(['search', query]),
    },
    now: () => new Date(2026, 9, 12, 9, 0),
  });
  t.after(() => { home.destroy(); dom.window.close(); });
  return { document, home, calls, history, counts };
}
const shelfTitles = document => [...document.querySelectorAll('.mh-shelf')].map(node => node.querySelector('.mh-shelf-title').textContent);
const shelfKeys = (document, id) => [...document.querySelectorAll(`.mh-shelf[data-shelf="${id}"] .mh-card`)].map(node => node.dataset.key);

test('greeting follows the hour', () => {
  assert.equal(greetingFor(new Date(2026, 0, 1, 7)), 'おはようございます');
  assert.equal(greetingFor(new Date(2026, 0, 1, 13)), 'こんにちは');
  assert.equal(greetingFor(new Date(2026, 0, 1, 22)), 'こんばんは');
});

test('history keeps the newest first, de-duplicates and caps', () => {
  const history = createMusicHistory(3);
  for (const id of ['a', 'b', 'c', 'a', 'd']) history.add({ kind: 'work', work: { id } });
  history.add({ kind: 'bogus' });
  history.add({ kind: 'work', work: {} });
  assert.deepEqual(history.list().map(entry => entry.work.id), ['d', 'a', 'c']);
});

test('home is a search bar and four shelves in a fixed order, even while empty', async t => {
  const f = homeFixture(t);
  assert.deepEqual(shelfTitles(f.document), ['最近再生', 'おすすめ', '新着', 'YouTube Music']);
  assert.deepEqual(SHELVES.map(shelf => shelf.name), shelfTitles(f.document));
  await f.home.refresh();
  assert.deepEqual(shelfTitles(f.document), ['最近再生', 'おすすめ', '新着', 'YouTube Music']);
  assert.ok(f.document.querySelector('.mh-head .mh-search input[type="search"]'));
  assert.equal(f.document.querySelector('.mh-hero'), null, 'no hero block');
  assert.equal(f.document.querySelector('.mh-shelf[data-shelf="recent"] .mh-quiet-line').textContent, 'まだ再生した曲はありません。');
  assert.equal(f.document.querySelector('.mh-shelf[data-shelf="new"] .mh-quiet-line').tagName, 'P');
});

test('each shelf is loaded once: repeated refresh and repaint never call the loaders again; only reload() does', async t => {
  const f = homeFixture(t);
  await f.home.refresh();
  await f.home.refresh();
  f.home.repaint(); f.home.repaint();
  await f.home.refresh();
  assert.deepEqual(f.counts, { recommended: 1, favorites: 1, peers: 1 });
  await f.home.reload();
  assert.deepEqual(f.counts, { recommended: 2, favorites: 2, peers: 2 });
});

test('concurrent refreshes share one load, and a failed load can be retried', async t => {
  let fail = true;
  const f = homeFixture(t, { recommended: async () => { if (fail) throw new Error('down'); return works; } });
  await Promise.all([f.home.refresh(), f.home.refresh(), f.home.refresh()]);
  assert.match(f.document.querySelector('.mh-shelf[data-shelf="youtube"]').textContent, /読み込めません/);
  fail = false;
  [...f.document.querySelectorAll('button')].find(button => button.textContent === '再試行').click();
  await flush(); await flush();
  assert.equal(f.document.querySelectorAll('.mh-shelf[data-shelf="youtube"] .mh-card').length, 2);
});

test('the order is stable: a later search that replaces the track list does not reshuffle the shelf', async t => {
  let list = [track(1), track(2), track(3)];
  const f = homeFixture(t, { tracks: () => list });
  await f.home.refresh();
  const before = shelfKeys(f.document, 'new');
  assert.deepEqual(before, [1, 2, 3].map(n => `hub:${UUID(n)}`).map(key => `track:${key.slice(4)}`));
  list = [track(3), track(9), track(1)];
  f.home.repaint(); f.home.repaint();
  assert.deepEqual(shelfKeys(f.document, 'new'), before);
});

test('a Hub work already on 新着 is not repeated on おすすめ, and external works never enter the Hub shelves', async t => {
  const f = homeFixture(t, { tracks: () => [track(1)], recommended: async () => [hubWork(1), hubWork(2), ...works] });
  await f.home.refresh();
  assert.deepEqual(shelfKeys(f.document, 'new'), [`track:${UUID(1)}`]);
  assert.deepEqual(shelfKeys(f.document, 'recommended'), [`work:music:${UUID(2)}`]);
  assert.deepEqual(shelfKeys(f.document, 'youtube'), ['work:sample-mw-1', 'work:sample-mw-2']);
  assert.equal(f.document.querySelectorAll('.mh-shelf[data-shelf="recommended"] [data-key="work:sample-mw-1"]').length, 0);
});

test('tiles are square artwork, title and artist; play shows only for playable items; YouTube plays through the work path', async t => {
  const f = homeFixture(t);
  await f.home.refresh();
  const tiles = [...f.document.querySelectorAll('.mh-shelf[data-shelf="youtube"] .mh-card')];
  assert.equal(tiles.length, 2);
  assert.ok(tiles[0].querySelector('.mw-art-card'));
  assert.equal(tiles[0].querySelector('.mh-card-title').textContent, 'Alpha');
  assert.equal(tiles[0].querySelector('.mh-card-artist').textContent, 'A');
  assert.ok(tiles[0].querySelector('.mh-card-play'));
  assert.equal(tiles[1].querySelector('.mh-card-play'), null, 'Spotify only: no in-app play');
  tiles[0].querySelector('.mh-card-play').click();
  tiles[1].querySelector('.mh-card-open').click();
  assert.deepEqual(f.calls, [['play', 'sample-mw-1'], ['play', 'sample-mw-2']]);
  assert.equal(f.document.querySelector('iframe'), null, 'the home never embeds anything itself');
});

test('a Hub track tile plays through playTrack; recent shows what the session played, newest first', async t => {
  const f = homeFixture(t, { tracks: () => [track(1), track(2)] });
  f.history.add({ kind: 'work', work: works[0] });
  f.history.add({ kind: 'track', track: track(2) });
  await f.home.refresh();
  assert.deepEqual(shelfKeys(f.document, 'recent'), [`track:${UUID(2)}`, 'work:sample-mw-1']);
  f.document.querySelector(`.mh-shelf[data-shelf="new"] [data-key="track:${UUID(1)}"] .mh-card-play`).click();
  assert.deepEqual(f.calls.at(-1), ['track', UUID(1)]);
});

test('there is no paging: a shelf is capped at one screenful and no "more" control exists', async t => {
  const many = Array.from({ length: 40 }, (_, index) => ({ id: UUID(index + 1), title: `T${index}`, artist: 'a' }));
  const f = homeFixture(t, { tracks: () => many });
  await f.home.refresh();
  assert.equal(f.document.querySelectorAll('.mh-shelf[data-shelf="new"] .mh-card').length, 12);
  assert.equal([...f.document.querySelectorAll('button')].filter(button => /続き|もっと|さらに/.test(button.textContent)).length, 0);
});

test('buildShelves is pure and treats a Hub track and its work as one song', () => {
  const shelves = buildShelves({ tracks: [track(1)], recommended: [hubWork(1), hubWork(2)], favorites: [hubWork(2)] });
  assert.deepEqual(shelves.map(shelf => shelf.id), ['recent', 'recommended', 'new', 'youtube']);
  assert.equal(shelves.find(shelf => shelf.id === 'recommended').entries.length, 1);
});

test('the store hands out the frozen track order until the user reloads', async () => {
  let list = [track(1), track(2)];
  const store = createShelfStore({ loaders: { tracks: () => list, recommended: async () => [], favorites: async () => [] } });
  const history = createMusicHistory();
  const ids = () => store.shelves(history).find(shelf => shelf.id === 'new').entries.map(entry => entry.track.id);
  assert.deepEqual(ids(), [UUID(1), UUID(2)]);
  list = [track(5)];
  assert.deepEqual(ids(), [UUID(1), UUID(2)]);
  await store.reload();
  assert.deepEqual(ids(), [UUID(5)]);
});

test('search goes to the action and a YouTube thumbnail in a square is the mqdefault', async t => {
  const hq = { id: 'sample-mw-9', title: 'HQ', artist: 'x', artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', services: [yt('dQw4w9WgXcQ')] };
  const f = homeFixture(t, { recommended: async () => [hq] });
  await f.home.refresh();
  assert.equal(f.document.querySelector('.mh-shelf[data-shelf="youtube"] img').dataset.src, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  const input = f.document.querySelector('.mh-search input');
  input.value = ' queen ';
  f.document.querySelector('.mh-search').dispatchEvent(new f.document.defaultView.Event('submit', { cancelable: true }));
  assert.deepEqual(f.calls.at(-1), ['search', 'queen']);
});

test('the shell has exactly one now-playing bar and one audio element; the new modules embed no frame and add no purchase control', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/id="music-player"/g) ?? []).length, 1);
  assert.equal((html.match(/id="music-player-audio"/g) ?? []).length, 1);
  for (const id of ['music-prev', 'music-toggle', 'music-next', 'music-seek', 'music-volume', 'music-queue-toggle']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, id);
  const source = ['music-home.mjs', 'music-shelves.mjs', 'music-tree.mjs', 'music-pages.mjs'].map(name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n')).join('\n');
  assert.doesNotMatch(source, /createElement\(['"]iframe|カート|購入|checkout/i);
});

test('every Hub and external tile has a ⋯ menu button for its work; Hub tracks are menu works with the music: id; peers have none', async t => {
  const f = homeFixture(t);
  await f.home.refresh();
  const tiles = [...f.document.querySelectorAll('.mh-card')];
  assert.ok(tiles.length > 0);
  for (const tile of tiles) {
    const more = tile.querySelector('.music-more');
    assert.ok(more, 'a ⋯ button');
    assert.ok(more.hubMusicWork.id, 'carries the work');
    assert.ok(!more.hubMusicWork.id.startsWith('music:music:'));
  }
});
