import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { attachNativeHls, nextRefreshDelay } from './native-video-player.mjs';
import { createWatchStage } from './video-home.mjs';

const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
const directives = Object.fromEntries(conf.app.security.csp.split(';').map((d) => d.trim().split(/\s+/u)).map(([name, ...v]) => [name, v]));

test('CSP: exact sources for native video, nothing broader', () => {
  const hub = ['https://hub.jkamma.com', 'http://localhost:3020', 'http://127.0.0.1:3020'];
  assert.deepEqual(directives['connect-src'], ['ipc:', 'http://ipc.localhost', 'blob:', ...hub.map((o) => `${o}/video/api/v1/`)]);
  assert.deepEqual([...directives['media-src']].sort(), ["'self'", 'blob:', ...hub].sort());
  assert.deepEqual(directives['frame-src'], ['https://www.youtube-nocookie.com']);
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.equal(directives['worker-src'], undefined);
  assert.equal(directives['script-src'], undefined);
  assert.ok(!conf.app.security.csp.includes('*'));
});

test('refresh is scheduled one minute before expiry, with a floor and a default', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  assert.equal(nextRefreshDelay('2026-10-29T00:15:00Z', now), 14 * 60_000);
  assert.equal(nextRefreshDelay('2026-10-29T00:00:30Z', now), 5_000);
  assert.equal(nextRefreshDelay(null, now), 10 * 60_000);
  assert.equal(nextRefreshDelay('nope', now), 10 * 60_000);
});

function fakeHls() {
  const log = { sources: [], destroyed: 0, options: null, handlers: {}, started: [] };
  class Hls {
    static isSupported() { return true; }
    static Events = { ERROR: 'error' };
    constructor(options) { log.options = options; }
    on(name, fn) { log.handlers[name] = fn; }
    loadSource(url) { log.sources.push(url); }
    attachMedia() {}
    startLoad(at) { log.started.push(at); }
    destroy() { log.destroyed++; }
  }
  return { Hls, log };
}
function harness(extra = {}) {
  const timers = [];
  const revoked = [];
  let n = 0;
  const video = { currentTime: 12, removeAttribute() {}, load() {} };
  const { Hls, log } = fakeHls();
  let plays = 0;
  const deps = {
    play: async () => { plays++; return { playlist: `#EXTM3U\nhttps://hub.jkamma.com/video/api/v1/s${plays}.ts`, expiresAt: '2026-10-29T00:15:00Z' }; },
    loadHls: async () => Hls,
    createObjectURL: () => `blob:x/${++n}`,
    revokeObjectURL: (u) => revoked.push(u),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer() {},
    now: () => Date.parse('2026-10-29T00:00:00Z'),
    ...extra,
  };
  return { video, deps, log, timers, revoked, plays: () => plays };
}

test('player feeds a blob: playlist to hls.js without a Worker and refreshes before expiry', async () => {
  const h = harness();
  const playback = await attachNativeHls(h.video, h.deps);
  assert.deepEqual(h.log.sources, ['blob:x/1']);
  assert.equal(h.log.options.enableWorker, false);
  assert.equal(h.timers[0].ms, 14 * 60_000);
  h.timers[0].fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.log.sources, ['blob:x/1', 'blob:x/2']);
  assert.deepEqual(h.log.started, [12]);
  assert.equal(h.plays(), 2);
  playback.destroy();
  assert.equal(h.log.destroyed, 1);
  assert.ok(h.revoked.includes('blob:x/2'));
});

test('a bad playlist or missing hls.js fails before playback starts', async () => {
  await assert.rejects(attachNativeHls(harness().video, { ...harness().deps, play: async () => ({ playlist: '<html>' }) }));
  const h = harness({ loadHls: async () => null });
  await assert.rejects(attachNativeHls(h.video, h.deps));
  assert.deepEqual(h.revoked, ['blob:x/1']);
});

function fakeDocument() {
  const make = (tag) => ({
    tagName: tag, className: '', textContent: '', children: [], hidden: false, dataset: {}, style: { setProperty() {} },
    classList: { add() {}, remove() {} },
    append(...i) { this.children.push(...i); }, prepend(...i) { this.children.unshift(...i); },
    replaceChildren(...i) { this.children = i; }, setAttribute() {}, querySelector() { return null; }, pause() {}, play() { return Promise.resolve(); },
  });
  return { createElement: make, createElementNS: (_n, t) => make(t) };
}
const tags = (node) => [node.tagName, ...node.children.flatMap(tags)];
const labels = (node) => [node.textContent, ...node.children.flatMap(labels)].filter(Boolean);
const settle = () => new Promise((r) => setTimeout(r, 0));
const hubVideo = { id: 'h1', provider: 'hub', title: '自作', sourceUrl: 'https://hub.jkamma.com/v2/videos/h1' };

test('watch stage plays own videos in a <video>; a failed play falls back to Hubで再生', async () => {
  const h = harness();
  const ok = createWatchStage(fakeDocument(), hubVideo, { hubAsset: null, onOpenExternal() {}, nativePlay: h.deps.play, nativeDeps: h.deps });
  await settle();
  assert.ok(tags(ok.element).includes('video'));
  ok.stop();
  assert.equal(h.log.destroyed, 1);

  const bad = createWatchStage(fakeDocument(), hubVideo, { hubAsset: null, onOpenExternal() {}, nativePlay: async () => { throw new Error('native_video_http_403'); } });
  await settle();
  assert.ok(!tags(bad.element).includes('video'));
  assert.ok(labels(bad.element).includes('Hubで再生'));
});

test('without a native player or for non-hub videos nothing changes', () => {
  const noPlayer = createWatchStage(fakeDocument(), hubVideo, { hubAsset: null, onOpenExternal() {} });
  assert.ok(labels(noPlayer.element).includes('Hubで再生'));
  const yt = createWatchStage(fakeDocument(), { id: 'y', provider: 'vimeo', title: 't', sourceUrl: 'https://v.example/1' }, { hubAsset: null, onOpenExternal() {}, nativePlay: async () => { throw new Error('x'); } });
  assert.ok(labels(yt.element).includes('提供元で開く'));
});
