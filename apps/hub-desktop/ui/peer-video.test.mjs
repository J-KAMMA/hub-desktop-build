import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { peerVideoEntries, isPeerVideo } from './peer-video.mjs';
import { renderVideoHome, resetVideoHome, createWatchStage } from './video-home.mjs';

const item = (id, media, extra = {}) => ({ origin: 'https://peer.example', id, title: `T${id}`, summary: 'S', path: `/v2/videos/${id}`, updatedAt: '2026-10-01T00:00:00Z', media, ...extra });
const YT = 'dQw4w9WgXcQ';

test('peerVideoEntries keeps only YouTube references from other Hubs', () => {
  const list = peerVideoEntries([
    item('a', { youtubeId: YT, channel: 'C', duration: '3:32' }),
    item('b', { channel: 'no youtube' }), item('c'), item('d', { youtubeId: 'short' }),
    item('e', { youtubeId: YT }, { origin: 'https://own.example' }),
    item('a', { youtubeId: YT }), item('f', { youtubeId: YT }, { title: '' }),
  ], { ownOrigin: 'https://own.example' });
  assert.equal(list.length, 1);
  assert.deepEqual({ id: list[0].id, sourceUrl: list[0].sourceUrl, provider: list[0].provider, channel: list[0].channel, peerHost: list[0].peerHost },
    { id: 'peer:peer.example:a', sourceUrl: `https://www.youtube.com/watch?v=${YT}`, provider: 'youtube', channel: 'C', peerHost: 'peer.example' });
  assert.equal(isPeerVideo(list[0]), true);
  assert.equal(isPeerVideo({ id: 'v1' }), false);
  assert.deepEqual(peerVideoEntries(null), []);
});

test('home shows a labelled peer row with host names and YouTube thumbnails; click opens the video', () => {
  const { document } = new JSDOM('<main></main>').window;
  resetVideoHome();
  const assets = [], opened = [];
  const host = document.querySelector('main');
  const peers = peerVideoEntries([item('a', { youtubeId: YT })]);
  renderVideoHome(host, { items: [], peerVideos: peers, deps: { document, hubAsset: (_i, url) => assets.push(url), relTime: () => '1日前', onOpen: v => opened.push(v.id) } });
  const row = host.querySelector('section[aria-label="ほかのHubの動画"]');
  assert.ok(row);
  assert.match(row.textContent, /peer\.example/);
  assert.deepEqual(assets, [`https://i.ytimg.com/vi/${YT}/hqdefault.jpg`]);
  row.querySelector('button').click();
  assert.deepEqual(opened, ['peer:peer.example:a']);
  renderVideoHome(host, { items: [], deps: { document, hubAsset() {}, relTime: () => '', onOpen() {} } });
  assert.equal(host.hidden, true);
});

test('a peer video plays through the shared dock with the synthesized video', () => {
  const { document } = new JSDOM('<main></main>').window;
  const [video] = peerVideoEntries([item('a', { youtubeId: YT })]);
  const plays = [];
  const dock = { play: p => { plays.push(p); return true; }, subscribe: () => () => {}, isPlaying: () => true, release() {} };
  createWatchStage(document, video, { hubAsset() {}, onOpenExternal() {}, dock });
  assert.equal(plays.length, 1);
  assert.equal(plays[0].id, YT);
  assert.equal(plays[0].key, 'video:peer:peer.example:a');
});
