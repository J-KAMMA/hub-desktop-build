import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { peerMusicEntries, peerYoutubeWork, createPeerAudio } from './peer-music.mjs';
import { createMusicHome, createMusicHistory } from './music-home.mjs';

const TRACK = '0f8fad5b-d9cb-469f-a165-70867728950c';
const item = (over = {}) => ({ id: 'w1', title: 'Song', summary: 's', path: '/v2/music/works/w1', updatedAt: '2026-10-01', origin: 'https://peer.example',
  media: { youtubeId: 'dQw4w9WgXcQ', artist: 'Artist' }, ...over });
const track = (over = {}) => item({ id: TRACK, path: `/v2/music/works/music:${TRACK}`, media: { audioPath: `/music/api/tracks/${TRACK}/audio`, artist: 'B' }, ...over });

test('entries keep valid peer media, label the host, and drop own-Hub, invalid and duplicate items', () => {
  const entries = peerMusicEntries([
    item(), item(), track(),
    item({ id: 'own', origin: 'https://me.example' }),
    item({ id: 'bad1', media: { youtubeId: 'short' } }),
    item({ id: 'bad2', media: { audioPath: '/api/client/me' } }),
    item({ id: 'bad3', media: { audioPath: '/music/api/tracks/x/audio?y=1' } }),
    item({ id: 'bad4', media: undefined }),
    item({ id: 'bad5', origin: 'not a url' }),
    null,
  ], { ownOrigin: 'https://me.example' });
  assert.deepEqual(entries.map(e => [e.id, e.host, e.youtubeId, e.audioPath]), [
    ['w1', 'peer.example', 'dQw4w9WgXcQ', null],
    [TRACK, 'peer.example', null, `/music/api/tracks/${TRACK}/audio`],
  ]);
  assert.deepEqual(peerMusicEntries('nope'), []);
  assert.equal(peerMusicEntries(Array.from({ length: 150 }, (_, i) => item({ id: `w${i}` }))).length, 100);
});

test('a YouTube peer work uses the shared player shape with a peer: id', () => {
  const [entry] = peerMusicEntries([item()]);
  const work = peerYoutubeWork(entry);
  assert.equal(work.id, 'peer:https://peer.example:w1');
  assert.deepEqual(work.services, [{ provider: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]);
  assert.equal(work.title, 'Song');
});

function audioFixture(invoke) {
  const calls = [];
  const audio = { pause: () => calls.push('pause'), load: () => calls.push('load'), play: async () => { calls.push('play'); }, src: '' };
  const URLApi = { createObjectURL: () => `blob:${calls.length}`, revokeObjectURL: url => calls.push(`revoke ${url}`) };
  const tracks = [];
  const errors = [];
  const peer = createPeerAudio({ invoke, audio, URLApi, onTrack: entry => tracks.push(entry.id), onError: error => errors.push(error.message) });
  return { peer, audio, calls, tracks, errors };
}

test('peer audio asks Rust for the exact origin and path, plays a blob, and revokes the previous one', async () => {
  const asked = [];
  const f = audioFixture(async (name, args) => { asked.push([name, args]); return new Uint8Array([1, 2, 3]).buffer; });
  const [entry] = peerMusicEntries([track()]);
  assert.equal(await f.peer.play(entry), true);
  assert.deepEqual(asked, [['hub_network_audio', { origin: 'https://peer.example', path: `/music/api/tracks/${TRACK}/audio` }]]);
  assert.match(f.audio.src, /^blob:/);
  assert.deepEqual(f.tracks, [TRACK]);
  const first = f.audio.src;
  await f.peer.play(entry);
  assert.ok(f.calls.includes(`revoke ${first}`));
  f.peer.destroy();
  assert.ok(f.calls.at(-1).startsWith('revoke'));
  assert.equal(await f.peer.play({ origin: 'https://peer.example', id: 'x', youtubeId: 'dQw4w9WgXcQ', audioPath: null }), false);
});

test('peer audio failures are reported, and a newer request wins over a slower older one', async () => {
  const failing = audioFixture(async () => { throw Error('このHubの音楽一覧に無い音声です'); });
  const [entry] = peerMusicEntries([track()]);
  assert.equal(await failing.peer.play(entry), false);
  assert.deepEqual(failing.errors, ['このHubの音楽一覧に無い音声です']);
  assert.equal(failing.audio.src, '');

  let release;
  const slow = audioFixture(async () => { await new Promise(resolve => { release = resolve; }); return new ArrayBuffer(1); });
  const older = slow.peer.play(entry);
  slow.peer.cancel();
  release();
  assert.equal(await older, false);
  assert.equal(slow.audio.src, '');
});

test('the home shelf names the origin host, plays on click, and a failing peer loader leaves other shelves alone', async t => {
  const dom = new JSDOM('<main id="host"></main>', { url: 'http://localhost' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const played = [];
  const entries = peerMusicEntries([item(), track()]);
  const make = loaders => createMusicHome({
    document, host: document.getElementById('host').appendChild(document.createElement('div')), hubAsset: () => {}, history: createMusicHistory(),
    loaders: { recommended: async () => [{ id: 'sample-1', title: 'Own', artist: 'O', services: [] }], favorites: async () => [], tracks: () => [], ...loaders },
    actions: { openWork() {}, playWork() {}, playTrack() {}, search() {}, playPeer: entry => played.push(entry.id) },
  });
  const home = make({ peers: async () => entries });
  await home.refresh();
  // 他Hubの音声つきの曲は おすすめ の棚、YouTube だけの曲は YouTube Music の棚。どちらも提供元のホスト名を添える。
  const shelf = home.element.querySelector('.mh-peer-card').closest('.mh-shelf');
  assert.equal(shelf.dataset.shelf, 'recommended');
  const cards = [...shelf.querySelectorAll('.mh-peer-card')];
  assert.equal(cards.length, 1);
  assert.match(cards[0].querySelector('.mh-song-meta').textContent, /peer.example/);
  cards[0].querySelector('.mh-song-open').click();
  const external = [...home.element.querySelectorAll('.mh-shelf[data-shelf="youtube"] .mh-peer-card')].find(card => /peer.example/.test(card.textContent));
  assert.ok(external, 'a YouTube-only peer work is on the YouTube Music shelf, tagged with its host');
  assert.match(external.querySelector('.mh-song-meta').textContent, /peer.example$/);
  external.querySelector('.mh-song-open').click();
  assert.deepEqual(played, [TRACK, 'w1']);
  home.destroy();

  const broken = make({ peers: async () => { throw Error('down'); } });
  await broken.refresh();
  assert.equal(broken.element.querySelector('.mh-peer-card'), null);
  assert.equal(broken.element.querySelectorAll('.mh-shelf[data-shelf="youtube"] .mh-song').length, 1); // the own work is unaffected
  broken.destroy();

  const none = make({});
  await none.refresh();
  assert.equal(none.element.querySelector('.mh-peer-card'), null);
  none.destroy();
});
