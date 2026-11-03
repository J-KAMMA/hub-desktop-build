import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { albumLabel, collectionKey, normalizeEntries, renderMusicCollection, selectCollection } from './music-artist-album.mjs';
import { createItemResolver } from './media-item-resolver.mjs';
import { attachMusicFavorite } from './music-library.mjs';
import { attachContentSave } from './content-library.mjs';
import { createMediaPlaylists } from './media-playlists.mjs';
import { dedupeHomeSections, videoDedupeKeys } from './video-home.mjs';

const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const uuid = (n) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`;
const track = (n, artist, album, extra = {}) => ({ id: uuid(n), title: `曲${n}`, artist, album, artworkUrl: `/music/api/tracks/${uuid(n)}/artwork`, ...extra });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const page = (t) => { const dom = new JSDOM('<div id="host"></div>', { url: 'http://localhost' }); t.after(() => dom.window.close()); return { document: dom.window.document, host: dom.window.document.querySelector('#host') }; };

test('keys follow the Web grouping: NFKC, trim, ja-JP lowercase; a missing album is the title (single)', () => {
  assert.equal(collectionKey('  ＡＢＣ '), 'abc');
  assert.equal(albumLabel({ title: 'Solo', album: '' }), 'Solo');
  assert.equal(albumLabel({ title: 'x', album: ' LP ' }), 'LP');
});

test('Hub tracks and their music: works collapse into one entry; Hub entries sort before external', () => {
  const entries = normalizeEntries([{ id: 'yt_1', title: 'YT', artist: 'A' }, track(1, 'A', 'L')], [{ id: `music:${uuid(1)}`, title: '曲1', artist: 'A', album: 'L', genre: 'Lo-fi' }]);
  assert.equal(entries.length, 2);
  const hub = entries.find((entry) => entry.hub);
  assert.equal(hub.key, `music:${uuid(1)}`);
  assert.equal(hub.track.id, uuid(1));
  assert.equal(hub.work.genre, 'Lo-fi');
  const rows = selectCollection(entries, { kind: 'artist', name: 'a' });
  assert.deepEqual(rows.map((row) => row.hub), [true, false]);
});

test('album selection matches the album label and optionally the artist', () => {
  const entries = normalizeEntries([track(1, 'A', 'L'), track(2, 'B', 'L'), track(3, 'A', undefined, { title: 'L' })]);
  assert.equal(selectCollection(entries, { kind: 'album', name: 'L' }).length, 3);
  assert.equal(selectCollection(entries, { kind: 'album', name: 'L', artist: 'A' }).length, 2);
  assert.equal(selectCollection(entries, { kind: 'album', name: '', artist: 'A' }).length, 0);
});

test('artist page: cover, count, play-all queues Hub tracks, rows open artist/album, late data merges and failures keep seed rows', async (t) => {
  const { document, host } = page(t);
  const calls = [];
  const actions = { playTracks: (tracks, start) => calls.push(['play', tracks.map((x) => x.id), start.id]), playWork: (w) => calls.push(['work', w.id]), openWork: (w) => calls.push(['open', w.id]), enqueue: (x) => calls.push(['next', x.id]), openArtist: (n) => calls.push(['artist', n]), openAlbum: (n, a) => calls.push(['album', n, a]) };
  const view = renderMusicCollection({ document, host, kind: 'artist', name: 'A', seed: [track(1, 'A', 'L'), track(9, 'Z', 'Q')], hubAsset: () => {}, actions,
    load: async () => [track(2, 'A', 'L'), { id: 'yt_1', title: 'YT', artist: 'A' }] });
  assert.match(host.textContent, /1曲/);
  await view.ready;
  assert.match(host.textContent, /3曲/);
  assert.equal(host.querySelectorAll('.mc-track').length, 3);
  assert.equal(host.querySelector('.mw-title').textContent, 'A');
  host.querySelector('.mw-play').click();
  assert.deepEqual(calls.shift(), ['play', [uuid(1), uuid(2)], uuid(1)]);
  host.querySelectorAll('.mc-title')[1].click();
  assert.deepEqual(calls.shift(), ['play', [uuid(1), uuid(2)], uuid(2)]);
  host.querySelectorAll('.mc-title')[2].click();
  assert.deepEqual(calls.shift(), ['work', 'yt_1']);
  host.querySelector('.mc-track .mc-next').click();
  assert.deepEqual(calls.shift(), ['next', uuid(1)]);
  const links = host.querySelectorAll('.mc-track')[0].querySelectorAll('.mc-link');
  links[0].click(); links[1].click();
  assert.deepEqual(calls, [['artist', 'A'], ['album', 'L', 'A']]);

  const failing = renderMusicCollection({ document, host: page(t).host, kind: 'artist', name: 'A', seed: [track(1, 'A', 'L')], hubAsset: () => {}, actions, load: async () => { throw Error('x'); } });
  await failing.ready;
  assert.equal(failing.root.querySelectorAll('.mc-track').length, 1);
  assert.match(failing.root.textContent, /取得できませんでした/);
});

test('album page lists artist links and an empty collection says so; destroyed views ignore late loads and clicks', async (t) => {
  const { document, host } = page(t);
  const calls = [];
  const view = renderMusicCollection({ document, host, kind: 'album', name: 'L', seed: [track(1, 'A', 'L')], hubAsset: () => {}, actions: { openArtist: (n) => calls.push(n), playTracks: () => calls.push('play') }, load: async () => [track(2, 'A', 'L')] });
  assert.match(host.querySelector('.mw-kind').textContent, /シングル/);
  await view.ready;
  assert.match(host.querySelector('.mw-kind').textContent, /アルバム/);
  host.querySelector('.mc-meta .mc-link').click();
  assert.deepEqual(calls, ['A']);
  const play = host.querySelector('.mw-play');
  view.destroy();
  play.click();
  assert.deepEqual(calls, ['A']);
  const { document: d2, host: h2 } = page(t);
  const empty = renderMusicCollection({ document: d2, host: h2, kind: 'artist', name: 'Nobody', seed: [], hubAsset: () => {}, actions: {} });
  assert.match(h2.textContent, /見つかりませんでした/);
  assert.equal(h2.querySelector('.mw-play').disabled, true);
  void empty;
});

test('resolver: concurrency is limited, results and misses are cached, bad payloads become null', async () => {
  let active = 0, peak = 0; const seen = [];
  const invoke = async (command, args) => {
    assert.equal(command, 'hub_detail');
    seen.push(args.ids[0]); active++; peak = Math.max(peak, active); await tick(); active--;
    if (args.ids[0] === 'bad') throw Error('nope');
    if (args.ids[0] === 'odd') return { work: { id: 'odd' } };
    return { work: { id: args.ids[0], title: `T-${args.ids[0]}` } };
  };
  const resolver = createItemResolver({ invoke, kind: 'music', concurrency: 2 });
  const ids = ['a', 'b', 'c', 'd', 'bad', 'odd', 'a'];
  const out = await Promise.all(ids.map((id) => resolver.resolve(id)));
  assert.equal(peak, 2);
  assert.deepEqual(out.map((x) => x?.title ?? null), ['T-a', 'T-b', 'T-c', 'T-d', null, null, 'T-a']);
  assert.equal(seen.filter((id) => id === 'a').length, 1);
  assert.equal(resolver.peek('b').title, 'T-b');
  await resolver.resolve('bad');
  assert.equal(seen.filter((id) => id === 'bad').length, 1);
  resolver.forgetMisses();
  await resolver.resolve('bad');
  assert.equal(seen.filter((id) => id === 'bad').length, 2);
  const video = createItemResolver({ invoke: async (_c, args) => ({ video: { id: args.ids[0], title: 'V' } }), kind: 'video' });
  assert.equal((await video.resolve('v1')).title, 'V');
});

test('playlist rows show resolved titles and covers instead of raw ids, and say so when an item cannot be resolved', async (t) => {
  const { document, host } = page(t);
  const wid = `music:${uuid(1)}`, miss = `music:${uuid(2)}`;
  const snapshot = { viewerId: 'prof1', playlists: [{ id: 'pl1', title: 'P', description: '', workIds: [wid, miss], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }] };
  const invoke = async (command, args) => {
    if (command === 'hub_client') return snapshot;
    if (command === 'hub_detail') { if (args.ids[0] === miss) throw Error('gone'); return { work: { id: wid, title: '朝焼けのバス停', artist: '月影ユウ', album: '夜明け' } }; }
    return {};
  };
  const resolver = createItemResolver({ invoke, kind: 'music' });
  const controller = createMediaPlaylists({ document, kind: 'music', invoke, isCurrent: () => true, getAccount: () => 'a1', resolveItem: (id) => resolver.resolve(id),
    renderCover: (entry) => { const node = document.createElement('span'); node.className = 'cover-stub'; node.textContent = entry.title; return node; } });
  host.append(controller.element);
  await tick(); await tick();
  for (let i = 0; i < 8; i++) await tick();
  const text = controller.element.textContent;
  assert.ok(controller.element.querySelector('ol[aria-label="プレイリストの項目"]'));
  {
    assert.match(text, /朝焼けのバス停/);
    assert.match(text, /月影ユウ/);
    assert.doesNotMatch(text, /music:a1b2c3d4/);
    assert.equal(controller.element.querySelectorAll('.cover-stub').length, 1);
    assert.match(text, /取得できません/);
  }
  controller.destroy();
});

test('favorite button starts loading, not as 再取得, even when its host is attached after construction', async (t) => {
  const { document, host } = page(t);
  let resolve; const calls = [];
  const invoke = (command, args) => { calls.push([command, args.name]); return new Promise((r) => { resolve = r; }); };
  const detached = document.createElement('div');
  const control = attachMusicFavorite({ document, host: detached, workId: 'music:' + uuid(1), invoke, isCurrent: () => true });
  const retry = () => [...detached.querySelectorAll('button')].find((b) => b.textContent === '保存状態を再取得');
  assert.equal(retry().hidden, true);
  host.append(detached);
  await tick();
  assert.deepEqual(calls, [['hub_client', 'music_favorites']]);
  assert.equal(retry().hidden, true);
  resolve({ favoriteIds: [] });
  await control.ready; await tick();
  assert.equal(retry().hidden, true);
  assert.equal(detached.querySelector('button').disabled, false);

  const failing = document.createElement('div'); host.append(failing);
  const bad = attachMusicFavorite({ document, host: failing, workId: 'w1', invoke: async () => { throw Error('x'); }, isCurrent: () => true });
  await bad.ready; await tick();
  assert.equal([...failing.querySelectorAll('button')].find((b) => b.textContent === '保存状態を再取得').hidden, false);

  const save = document.createElement('div'); host.append(save);
  const watch = attachContentSave({ document, host: save, kind: 'video', id: 'v1', invoke: () => new Promise(() => {}), isCurrent: () => true });
  assert.equal([...save.querySelectorAll('button')].find((b) => b.textContent === '保存状態を再取得').hidden, true);
  void watch;
});

test('video home dedupe: the same video never appears twice across shelf, rows and other-Hub rows', () => {
  const v = (id, yt) => ({ id, title: id, sourceUrl: yt ? `https://www.youtube.com/watch?v=${yt}` : '', category: 'c' });
  const peer = (host, yt) => ({ id: `peer:${host}:x`, title: 'p', sourceUrl: `https://www.youtube.com/watch?v=${yt}`, provider: 'youtube', peerHost: host });
  assert.deepEqual(videoDedupeKeys(v('a', 'dQw4w9WgXcQ')), ['id:a', 'yt:dQw4w9WgXcQ']);
  const taken = [v('short1', 'jNQXAC9IVRw')];
  const result = dedupeHomeSections({
    groups: [{ name: 'g1', videos: [v('short1'), v('a', 'dQw4w9WgXcQ'), v('a', 'dQw4w9WgXcQ')] }, { name: 'g2', videos: [v('short1')] }, { name: 'g3', videos: [v('b', '9bZkp7q19f0')] }],
    peerVideos: [peer('h1', 'dQw4w9WgXcQ'), peer('h1', 'kJQP7kiw5Fk'), peer('h2', 'jNQXAC9IVRw')], taken });
  assert.deepEqual(result.groups.map((g) => [g.name, g.videos.map((x) => x.id)]), [['g1', ['a']], ['g3', ['b']]]);
  assert.deepEqual(result.peerVideos.map((x) => x.sourceUrl.slice(-11)), ['kJQP7kiw5Fk']);
});
