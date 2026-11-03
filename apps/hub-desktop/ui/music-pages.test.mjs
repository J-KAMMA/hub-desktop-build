import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMusicPlaylist, renderMusicArtists, artistTiles, shuffled, timeLabel } from './music-pages.mjs';
import { renderMusicCollection, albumTiles } from './music-artist-album.mjs';

const UUID = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const hub = (n, extra = {}) => ({ id: `music:${UUID(n)}`, title: `曲${n}`, artist: n % 2 ? 'A' : 'B', durationSeconds: 60 * n + 5, services: [], ...extra });
const ytWork = { id: 'yt1', title: 'Tube', artist: 'A', services: [{ provider: 'youtube', url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' }] };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function playlistFixture(t, items, catalog) {
  const dom = new JSDOM('<main id="host"></main>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const calls = [];
  const page = renderMusicPlaylist({
    document, host: document.getElementById('host'), playlist: { id: 'pl', title: '作業用', description: '説明', items },
    resolve: async id => catalog[id] ?? null, hubAsset: () => {}, random: () => 0,
    actions: {
      playTracks: (tracks, start) => calls.push(['playTracks', tracks.map(item => item.id), start.id]),
      playWork: work => calls.push(['playWork', work.id]), openWork: work => calls.push(['openWork', work.id]),
      enqueue: item => calls.push(['enqueue', item.id]), openArtist: name => calls.push(['artist', name]), edit: () => calls.push(['edit']),
    },
  });
  t.after(() => page.destroy());
  return { document, page, calls };
}

test('playlist: header with play and shuffle, then numbered rows # / title+artist / time / ⋯', async t => {
  const works = [hub(1), hub(2), hub(3)];
  const f = playlistFixture(t, works.map(work => work.id), Object.fromEntries(works.map(work => [work.id, work])));
  assert.equal(f.document.querySelectorAll('.mp-row').length, 3, 'rows exist (pending) before the items resolve');
  await f.page.ready;
  assert.equal(f.document.querySelector('.mw-title').textContent, '作業用');
  assert.ok(f.document.querySelector('.mw-play'));
  assert.equal(f.document.querySelector('.mp-shuffle').textContent, 'シャッフル');
  assert.equal(f.document.querySelector('.mw-credits').textContent, '3曲 · 6:15');
  const rows = [...f.document.querySelectorAll('.mp-row')];
  assert.deepEqual(rows.map(row => row.querySelector('.mc-no').textContent), ['1', '2', '3']);
  assert.deepEqual(rows.map(row => row.querySelector('.mc-title').textContent), ['曲1', '曲2', '曲3']);
  assert.deepEqual(rows.map(row => row.querySelector('.mc-link').textContent), ['A', 'B', 'A']);
  assert.deepEqual(rows.map(row => row.querySelector('.mp-time').textContent), ['1:05', '2:05', '3:05']);
  assert.equal(rows[0].querySelector('.mp-more').textContent, '⋯');
  assert.equal(f.document.querySelector('.mp-head').getAttribute('aria-hidden'), 'true');
});

test('playlist: play starts at the first Hub track; shuffle reorders the queue; a row plays from itself; ⋯ offers 次に再生', async t => {
  const works = [hub(1), hub(2), hub(3)];
  const f = playlistFixture(t, works.map(work => work.id), Object.fromEntries(works.map(work => [work.id, work])));
  await f.page.ready;
  f.document.querySelector('.mw-play').click();
  assert.deepEqual(f.calls.at(-1), ['playTracks', [UUID(1), UUID(2), UUID(3)], UUID(1)], 'ids reach the player without the music: prefix');
  f.document.querySelector('.mp-shuffle').click();
  const [, queue, start] = f.calls.at(-1);
  assert.deepEqual([...queue].sort(), [UUID(1), UUID(2), UUID(3)].sort());
  assert.equal(start, queue[0]);
  assert.notDeepEqual(queue, [UUID(1), UUID(2), UUID(3)], 'the injected random reorders');
  f.document.querySelectorAll('.mp-row .mc-title')[1].click();
  assert.deepEqual(f.calls.at(-1), ['playTracks', [UUID(1), UUID(2), UUID(3)], UUID(2)]);
  const row = f.document.querySelectorAll('.mp-row')[2];
  const more = row.querySelector('.mp-more');
  assert.ok('musicMenu' in more.dataset, 'the shared ⋯ menu button');
  assert.equal(more.hubMusicWork.id, 'music:' + UUID(3));
});

test('playlist: a YouTube item opens its work (embed path only), has no 次に再生, and an unavailable one is a quiet line', async t => {
  const f = playlistFixture(t, ['yt1', 'gone'], { yt1: ytWork });
  await f.page.ready;
  const rows = [...f.document.querySelectorAll('.mp-row')];
  rows[0].querySelector('.mc-title').click();
  assert.deepEqual(f.calls.at(-1), ['playWork', 'yt1']);
  assert.equal(rows[0].querySelector('.mp-more').hubMusicWork.id, 'yt1');
  assert.match(rows[1].textContent, /公開情報を取得できない/);
  assert.equal(f.document.querySelector('.mw-play').disabled, false, 'play falls back to the first YouTube work');
  f.document.querySelector('.mw-play').click();
  assert.deepEqual(f.calls.at(-1), ['playWork', 'yt1']);
  assert.equal(f.document.querySelector('.mp-shuffle').disabled, true, 'nothing to shuffle without Hub tracks');
  assert.equal(f.document.querySelector('iframe'), null);
});

test('playlist: an empty playlist says so in one quiet line and disables play', async t => {
  const f = playlistFixture(t, [], {});
  await f.page.ready;
  assert.equal(f.document.querySelectorAll('.mp-row').length, 0);
  assert.match(f.document.querySelector('.mc-empty').textContent, /曲の入っていない/);
  assert.equal(f.document.querySelector('.mw-play').disabled, true);
});

test('artist list: tiles sorted by song count, one per artist ignoring case and width; clicking opens the artist', async t => {
  assert.deepEqual(artistTiles([{ artist: 'Ａoi' }, { artist: 'aoi' }, { artist: 'Kamma' }, { artist: ' ' }, {}]).map(tile => [tile.name, tile.count]), [['Aoi', 2], ['Kamma', 1]]);
  const dom = new JSDOM('<main id="host"></main>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const opened = [];
  const page = renderMusicArtists({ document, host: document.getElementById('host'), load: async () => [hub(1), hub(3), hub(2)], hubAsset: () => {}, actions: { openArtist: name => opened.push(name) } });
  await page.ready;
  const cards = [...document.querySelectorAll('.mp-artist')];
  assert.deepEqual(cards.map(card => card.querySelector('.mh-card-title').textContent), ['A', 'B']);
  assert.equal(cards[0].querySelector('.mh-card-artist').textContent, '2曲');
  cards[1].querySelector('.mh-card-open').click();
  assert.deepEqual(opened, ['B']);
  const none = renderMusicArtists({ document, host: document.getElementById('host'), load: async () => { throw Error('x'); }, hubAsset: () => {}, actions: { openArtist() {} } });
  await none.ready;
  assert.match(document.querySelectorAll('.mp-artists')[1].textContent, /読み込めませんでした/);
});

test('artist page: header, track rows with a time, then albums as tiles that open the album', async t => {
  const dom = new JSDOM('<main id="host"></main>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const seed = [hub(1, { artist: 'Aoi', album: 'First' }), hub(3, { artist: 'Aoi', album: 'First' }), hub(5, { artist: 'Aoi', album: 'Second' }), hub(2, { artist: 'Other', album: 'Third' })];
  const opened = [];
  const view = renderMusicCollection({ document, host: document.getElementById('host'), kind: 'artist', name: 'Aoi', seed, hubAsset: () => {}, actions: { openAlbum: (name, artist) => opened.push([name, artist]) } });
  await view.ready;
  assert.equal(document.querySelector('.mw-title').textContent, 'Aoi');
  assert.deepEqual([...document.querySelectorAll('.mc-track .mc-time')].map(node => node.textContent), ['1:05', '3:05', '5:05']);
  const albums = [...document.querySelectorAll('.mc-albums .mc-album')];
  assert.deepEqual(albums.map(card => card.querySelector('.mh-card-title').textContent), ['First', 'Second']);
  assert.equal(albums[0].querySelector('.mh-card-artist').textContent, '2曲');
  albums[1].querySelector('.mh-card-open').click();
  assert.deepEqual(opened, [['Second', 'Aoi']]);
  const section = document.querySelector('.mc-albums');
  assert.ok(document.querySelector('.mc-tracks').compareDocumentPosition(section) & 4, 'albums come after the tracks');
  assert.equal(albumTiles([{ work: { title: 'Single' } }]).length, 0, 'a song without an album name makes no tile');
});

test('helpers: shuffled is a pure permutation; timeLabel formats m:ss and hides unknowns', () => {
  const list = [1, 2, 3, 4];
  assert.deepEqual(shuffled(list, () => 0.99), list);
  assert.deepEqual([...shuffled(list, () => 0)].sort(), list);
  assert.deepEqual(list, [1, 2, 3, 4]);
  assert.equal(timeLabel(125), '2:05');
  assert.equal(timeLabel(0), '');
  assert.equal(timeLabel(undefined), '');
  void flush;
});
