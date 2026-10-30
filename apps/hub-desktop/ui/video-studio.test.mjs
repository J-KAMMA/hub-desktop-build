import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createNativeVideoApi, declaredMinutes, formatClock, planUpload, renderVideoStudio, sortMine, studioError, uploadKind } from './video-studio.mjs';
import { isShortVideo, isVerticalVideo } from './sidebar-media.mjs';
import { ownFirst, renderVideoHome, resetVideoHome } from './video-home.mjs';

const quota = { minutesCap: 100, minutesUsed: 10, minutesRemaining: 90, maxMinutesPerVideo: 60, maxHeight: 1080 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('planUpload: desktop source, no local conversion yet, limits enforced', () => {
  const ok = planUpload({ name: 'a.mp4', size: 10, durationSeconds: 61 }, quota);
  assert.deepEqual([ok.source, ok.convert, ok.minutes, ok.blocked], ['desktop', false, 2, null]);
  assert.ok(planUpload({ name: 'a', size: 10, durationSeconds: 61 * 60 }, quota).blocked);
  assert.ok(planUpload({ name: 'a', size: 10, durationSeconds: 60 * 80 }, { ...quota, maxMinutesPerVideo: 120, minutesRemaining: 5 }).blocked);
  assert.ok(planUpload({ name: 'a', size: 10 }, quota).blocked);
  assert.ok(planUpload(null, quota).blocked);
  assert.equal(declaredMinutes(60), 1);
  assert.equal(formatClock(3725), '1:02:05');
});

test('uploadKind and shorts need a vertical frame when the size is known', () => {
  assert.equal(uploadKind(30, 1080, 1920), 'short');
  assert.equal(uploadKind(30, 1920, 1080), 'normal');
  assert.equal(uploadKind(90, 1080, 1920), 'normal');
  assert.equal(isShortVideo({ duration: '0:30', width: 1920, height: 1080 }), false);
  assert.equal(isShortVideo({ duration: '0:30', width: 1080, height: 1920 }), true);
  assert.equal(isShortVideo({ duration: '0:30' }), true);
  assert.equal(isVerticalVideo({ width: 0, height: 5 }), null);
});

test('sortMine puts waiting videos first; ownFirst is stable', () => {
  const sorted = sortMine([{ id: 'a', state: 'published', updatedAt: '2' }, { id: 'b', state: 'processing', updatedAt: '1' }, { id: 'c', state: 'ready', updatedAt: '1' }]);
  assert.deepEqual(sorted.map((v) => v.id), ['b', 'c', 'a']);
  assert.deepEqual(ownFirst([{ id: 'y1' }, { id: 'h1', provider: 'hub' }, { id: 'y2' }, { id: 'h2', provider: 'hub' }]).map((v) => v.id), ['h1', 'h2', 'y1', 'y2']);
});

test('video home puts own videos in the first row and not again in topic rows', () => {
  resetVideoHome();
  const { document } = new JSDOM('<div id="h"></div>').window;
  const host = document.querySelector('#h');
  const items = [{ id: 'y', title: 'Y', provider: 'youtube', topic: 'T' }, { id: 'h', title: 'H', provider: 'hub', topic: 'T' }];
  renderVideoHome(host, { items, deps: { document, hubAsset() {}, relTime: () => '', onOpen() {} } });
  const rows = [...host.querySelectorAll('.vh-row')];
  assert.equal(rows[0].getAttribute('aria-label'), '自作の動画');
  assert.equal(rows[0].querySelectorAll('.vh-card').length, 1);
  assert.equal(rows.slice(1).some((row) => row.textContent.includes('H')), false);
});

test('api maps to fixed verbs and an unsupported command reads as unavailable', async () => {
  const calls = [];
  const api = createNativeVideoApi(async (name, args) => { calls.push([name, args]); if (args.op === 'list') return { videos: [{ id: 'v' }], quota }; return null; });
  assert.equal((await api.list()).videos.length, 1);
  await api.publish('v');
  assert.deepEqual(calls[1], ['native_video_request', { op: 'publish', id: 'v', patch: undefined }]);
  assert.match(studioError(new Error('unknown command native_video_upload'), 'x'), /まだ使えません/u);
  assert.match(studioError('native_video:file_too_large', 'x'), /大きすぎ/u);
});

test('studio lists, publishes and uploads through the api', async () => {
  const { document } = new JSDOM('<div id="h"></div>').window;
  const host = document.querySelector('#h');
  let videos = [{ id: 'v1', title: '動画', state: 'ready', visibility: 'public' }];
  const log = [];
  const api = {
    list: async () => ({ videos, quota }),
    get: async (id) => videos.find((v) => v.id === id),
    publish: async (id) => { log.push(['publish', id]); videos = videos.map((v) => ({ ...v, state: 'published' })); },
    unpublish: async () => {}, remove: async () => {}, update: async () => {},
    pickFile: async () => ({ fileId: 'f1', name: 'a.mp4', size: 1000, durationSeconds: 30, width: 1080, height: 1920 }),
    upload: async (input) => { log.push(['upload', input]); },
  };
  const studio = renderVideoStudio(host, { document, api, setTimer: () => 1, clearTimer() {} });
  await tick(); await tick();
  assert.ok(host.textContent.includes('90 分 / 100 分'));
  [...host.querySelectorAll('button')].find((b) => b.textContent === '公開する').click();
  await tick(); await tick();
  assert.deepEqual(log[0], ['publish', 'v1']);
  assert.ok(host.textContent.includes('公開中'));
  host.querySelector('.nv-drop').click();
  await tick();
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'アップロードする').click();
  await tick(); await tick();
  const sent = log.find((entry) => entry[0] === 'upload')[1];
  assert.equal(sent.source, 'desktop');
  assert.equal(sent.kind, 'short');
  assert.equal(sent.title, 'a');
  studio.destroy();
});

test('a 401 shows the sign-in message', async () => {
  const { document } = new JSDOM('<div id="h"></div>').window;
  const host = document.querySelector('#h');
  const studio = renderVideoStudio(host, { document, api: { list: async () => { throw Object.assign(new Error('x'), { status: 401 }); } }, setTimer: () => 1, clearTimer() {} });
  await tick(); await tick();
  assert.ok(host.textContent.includes('ログインが必要です'));
  studio.destroy();
});
