// 作品の頁を廃止した（2026-11-02）。曲は押すとその場で再生し、操作は ⋯ メニューに集める。
// 曲への深いリンクは、その曲を再生して右列の「再生中」を開く。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installContextMenu } from './context-menu.mjs';
import { externalOpenLinks, musicMenuItems, musicMenuButton, registerMusicMenu } from './music-track-menu.mjs';
import { youtubeSource } from './music-youtube.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const root = new URL('./', import.meta.url);
const app = readFileSync(new URL('app.js', root), 'utf8').replaceAll('\r\n', '\n');
const HUB = 'music:11111111-1111-4111-8111-111111111111';
const ytWork = { id: 'yt-1', title: 'Outside', artist: 'A', source: 'community', services: [
  { provider: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, { provider: 'spotify', url: 'https://open.spotify.com/track/x' }] };
const labels = (items) => items.filter((item) => item !== '-').map((item) => item.label);

function deps(calls) {
  const record = (name) => (...args) => calls.push([name, ...args.map((arg) => arg?.id ?? arg)]);
  return { enqueue: record('enqueue'), favorite: record('favorite'), addToPlaylist: record('playlist'), share: record('share'), report: record('report'),
    canReport: (work) => work.source === 'community', openExternal: record('external') };
}

test('the ⋯ menu holds exactly the five actions, plus 次に再生 for Hub tracks and the external opens that exist', () => {
  const calls = [];
  const yt = musicMenuItems(ytWork, deps(calls));
  assert.deepEqual(labels(yt), ['お気に入り', 'プレイリストに追加', '投稿で紹介', '作品を報告', 'Spotifyで開く', 'YouTubeで開く']);
  assert.deepEqual(labels(musicMenuItems({ id: HUB, title: 'T' }, deps(calls))), ['次に再生', 'お気に入り', 'プレイリストに追加', '投稿で紹介', '作品を報告']);
  assert.deepEqual(labels(musicMenuItems({ id: 'o', title: 'No links', services: [{ provider: 'apple', url: 'https://music.apple.com/x' }] }, deps(calls))), ['お気に入り', 'プレイリストに追加', '投稿で紹介', '作品を報告']);
  for (const item of yt.filter((entry) => entry !== '-')) item.run();
  assert.deepEqual(calls.map((call) => call[0]), ['favorite', 'playlist', 'share', 'report', 'external', 'external']);
  assert.deepEqual(calls.slice(-2).map((call) => call[1]), ['https://open.spotify.com/track/x', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
  assert.equal(yt.find((item) => item.label === '作品を報告').disabled, false);
  assert.equal(musicMenuItems({ id: HUB, title: 'T' }, deps(calls)).find((item) => item.label === '作品を報告').disabled, true, 'only community external works can be reported');
  assert.deepEqual(musicMenuItems(null, deps(calls)), []);
});

test('YouTubeで開く is built from the embed id when only an embed URL is registered; non-http links are dropped', () => {
  const work = { id: 'e', services: [{ provider: 'youtube', embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ' }, { provider: 'spotify', url: 'javascript:alert(1)' }] };
  assert.equal(youtubeSource(work).id, 'dQw4w9WgXcQ');
  assert.deepEqual(externalOpenLinks(work), [{ label: 'YouTubeで開く', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }]);
});

test('pressing ⋯ opens the shared context menu with those items and running one calls the dependency', async () => {
  const dom = new JSDOM('<body><div id="row"></div></body>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const calls = [];
  const menu = installContextMenu({ document, window, isHubUrl: () => false });
  registerMusicMenu(menu, deps(calls));
  const more = musicMenuButton(document, ytWork);
  document.querySelector('#row').append(more);
  more.click();
  const shown = [...document.querySelectorAll('.context-menu .ds-menu-item')];
  assert.deepEqual(shown.map((button) => button.textContent), ['お気に入り', 'プレイリストに追加', '投稿で紹介', '作品を報告', 'Spotifyで開く', 'YouTubeで開く']);
  shown.find((button) => button.textContent === '投稿で紹介').click();
  assert.deepEqual(calls, [['share', 'yt-1']]);
  // 再生中バーの ⋯ は押した時の曲を返す。曲が無ければメニューは出ない。
  let current = null;
  const bar = musicMenuButton(document, () => current, { label: '再生中の曲のその他の操作' });
  document.body.append(bar);
  bar.click();
  assert.equal(document.querySelector('.context-menu'), null);
  current = { id: HUB, title: 'Now' };
  bar.click();
  assert.deepEqual([...document.querySelectorAll('.context-menu .ds-menu-item')].map((button) => button.textContent).slice(0, 2), ['次に再生', 'お気に入り']);
  menu.dispose();
  dom.window.close();
});

// app.js の再生まわりを実コードのまま取り出し、画面の切り替えが起きないことを確かめる。
function playback(extra = {}) {
  const start = app.indexOf('const HUB_MUSIC_WORK_ID = ');
  const end = app.indexOf('function currentMusicBarWork()');
  const log = [];
  const stubs = {
    playMusicTrack: (...args) => { log.push(['track', args[0].id, args[1].map((track) => track.id)]); return Promise.resolve(true); },
    selectRailView: (name) => log.push(['rail', name]),
    railNav: { visit: (name, key, data) => log.push(['visit', name, data.route.type]) },
    railNavSeq: 0,
    railMusic: { show: (route) => log.push(['show', route.type, route.work.id, route.autoplay, route.report]) },
    youtubeSource,
    researchAccountGeneration: 1,
    invoke: async (name, args) => { log.push(['invoke', name, args.name]); return { work: ytWork }; },
    showNotice: (text) => log.push(['notice', text]),
    friendlyError: (error) => String(error),
    openDetail: () => log.push(['OPEN_DETAIL']),
    ...extra,
  };
  const names = Object.keys(stubs);
  const body = `let railNavSeq = 0;${app.slice(start, end)};return { playMusicWork, openMusicWorkById, openMusicWorkInRail };`;
  return { api: new Function(...names.filter((name) => name !== 'railNavSeq'), body)(...names.filter((name) => name !== 'railNavSeq').map((name) => stubs[name])), log };
}

test('clicking a Hub track plays it in place; a YouTube track opens the rail on 再生中 and autoplays there; nothing navigates', () => {
  const { api, log } = playback();
  api.playMusicWork({ id: HUB, title: 'T' });
  assert.deepEqual(log, [['track', HUB.slice(6), [HUB.slice(6)]]]);
  log.length = 0;
  api.playMusicWork(ytWork);
  assert.deepEqual(log, [['rail', 'music'], ['visit', 'music', 'work'], ['show', 'work', 'yt-1', true, false]]);
  log.length = 0;
  api.playMusicWork({ id: 'sp', title: 'Spotify only', services: [{ provider: 'spotify', url: 'https://open.spotify.com/track/1' }] });
  assert.deepEqual(log.at(-1), ['show', 'work', 'sp', false, false], 'unplayable works still show in the rail, with the ⋯ menu to open the provider');
  assert.ok(!log.some((entry) => entry[0] === 'OPEN_DETAIL'));
});

test('a deep link to a work plays it and opens the rail; Hub tracks also open the rail; unknown ids read the work first', async () => {
  const { api, log } = playback();
  await api.openMusicWorkById(HUB, { id: HUB, title: 'T' });
  assert.deepEqual(log, [['track', HUB.slice(6), [HUB.slice(6)]], ['rail', 'music'], ['visit', 'music', 'work'], ['show', 'work', HUB, false, false]]);
  log.length = 0;
  await api.openMusicWorkById('yt-1');
  assert.deepEqual(log[0], ['invoke', 'hub_detail', 'music_work']);
  assert.deepEqual(log.at(-1), ['show', 'work', 'yt-1', true, false]);
  log.length = 0;
  await api.openMusicWorkById('bad id/with slash');
  assert.deepEqual(log, [], 'an invalid id never reaches the network');
});

test('openDetail turns a music_work request into a play; no work-page renderer, route entry or call site is left', () => {
  const open = app.slice(app.indexOf('async function openDetail('), app.indexOf('async function detailBack()'));
  assert.match(open, /if \(name === "music_work"\)[^\n]*openMusicWorkById[^\n]*return; \}\n  await exitBrowser\(\)/);
  assert.doesNotMatch(app, /renderMusicDetail|returnToMusicWork|music-return-work|requestAutoplay\(work/);
  const calls = [...app.matchAll(/openDetail\(\s*['"]music_work['"]/g)];
  assert.equal(calls.length, 0, 'no code opens a work page');
  assert.doesNotMatch(app, /music_work:\s*render/);
  assert.ok(!/music-work-detail/.test(app));
  for (const name of ['music-pages.mjs', 'music-artist-album.mjs', 'music-home.mjs', 'rail-music.mjs']) {
    const source = readFileSync(new URL(name, root), 'utf8');
    assert.doesNotMatch(source, /openWork|作品を開く|詳細を右列で開く/, name);
  }
});

test('the right rail work page shows the frame at 16:9 and at least 200px, with the posts and the report under it', () => {
  const css = readFileSync(new URL('rail-music.css', root), 'utf8') + readFileSync(new URL('yt-dock.css', root), 'utf8');
  assert.match(css, /\.yt-player-slot \{[^}]*aspect-ratio: 16 \/ 9/);
  assert.match(css, /\.rail-music-yt \.yt-player-slot \{[^}]*min-width: 200px; min-height: 200px/);
  const rail = readFileSync(new URL('rail-music.mjs', root), 'utf8');
  assert.ok(rail.indexOf("deps.posts?.(") > rail.indexOf('ytHost'), 'posts are drawn after the frame is set up');
  const html = readFileSync(new URL('index.html', root), 'utf8');
  assert.ok(html.indexOf('id="rail-music-yt"') < html.indexOf('id="rail-music"'), 'the frame sits above the work page');
  assert.match(html, /id="music-more-slot"/);
});

test('the posts under the frame use the existing music_posts read and the ⋯ share uses the existing composer path', () => {
  assert.match(app, /posts: \(\{ host, work, isCurrent \}\) => \{[\s\S]*?createContentPosts\(document, \{ kind: "music"/);
  assert.match(readFileSync(new URL('video-posts.mjs', root), 'utf8'), /list: 'music_posts'/);
  assert.match(app, /share: \(work\) => void shareMusicWork\([\s\S]*?onShare: offerPublicContentShare/);
  assert.match(app, /openExternal: \(url\) => void invoke\("open_external", \{ url \}\)/);
});

test('right-click on ⋯ without a prior hover waits for the attribution state, then shows 「プロフィールに表示」; a slow or failed read still opens the menu', async () => {
  const dom = new JSDOM('<body><div id="row"></div></body>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const state = { eligible: new Set(), loaded: false };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const attribution = {
    ready: () => (state.loaded ? null : gate.then(() => { state.loaded = true; state.eligible.add('11111111-1111-4111-8111-111111111111'); })),
    label: (work) => (state.eligible.has(String(work.id).slice(6)) ? 'プロフィールに表示' : null),
    run: () => {},
  };
  const menu = installContextMenu({ document, window, isHubUrl: () => false });
  registerMusicMenu(menu, { ...deps([]), profileAttribution: attribution }, { document, readyTimeoutMs: 40 });
  const more = musicMenuButton(document, { id: HUB, title: 'Mine' });
  document.querySelector('#row').append(more);
  const right = () => more.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  const texts = () => [...document.querySelectorAll('.context-menu .ds-menu-item')].map((button) => button.textContent);

  right();
  assert.equal(document.querySelector('.context-menu'), null, 'nothing is drawn until the state is read');
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(texts().includes('プロフィールに表示'));
  menu.close();

  // Cached now: opens immediately, synchronously.
  right();
  assert.ok(texts().includes('プロフィールに表示'));
  menu.close();

  // A read that never finishes: the menu still opens after the timeout, without the item.
  state.loaded = false; state.eligible.clear();
  attribution.ready = () => new Promise(() => {});
  right();
  assert.equal(document.querySelector('.context-menu'), null);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(texts().includes('お気に入り'));
  assert.ok(!texts().includes('プロフィールに表示'));
  menu.dispose();
  dom.window.close();
});
