import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pickHero, groupVideos, rememberWatched, watchedVideos, resetVideoHome, loadSavedVideos, savedVideos, renderVideoHome,
  createVideoCard, createWatchStage, createWatchHeader, createRelatedList, stopVideoPlayer, videoImageUrl, createVideoThumbnail, createVideoSkeletons } from './video-home.mjs';

const yt = (id, extra = {}) => ({ id: `v-${id}`, title: `動画${id}`, channel: 'チャンネル', provider: 'youtube', sourceUrl: `https://www.youtube.com/watch?v=${id}`, publishedAt: '2026-10-01T00:00:00Z', viewCount: 1200, ...extra });
const A = 'aaaaaaaaaaa', B = 'bbbbbbbbbbb', C = 'ccccccccccc';
const setup = () => {
  const { document } = new JSDOM('<main></main>').window;
  const assets = [];
  const opened = [];
  return { document, assets, opened, deps: { document, hubAsset: (img, url) => assets.push(url), relTime: () => '1日前', onOpen: (video) => opened.push(video.id) } };
};

test('pickHero takes the newest YouTube video that can play in the app', () => {
  const items = [yt(A, { publishedAt: '2026-09-01T00:00:00Z' }), { id: 'x', provider: 'vimeo', sourceUrl: 'https://vimeo.com/1', publishedAt: '2026-12-01T00:00:00Z' },
    yt(B, { publishedAt: '2026-10-05T00:00:00Z', availabilityStatus: 'unavailable' }), yt(C, { publishedAt: '2026-10-03T00:00:00Z' })];
  assert.equal(pickHero(items).id, `v-${C}`);
  assert.equal(pickHero([items[1]]), null);
});

test('groupVideos groups by topic then category, biggest first, at most four rows', () => {
  const items = [yt('a1', { topic: '音楽' }), yt('a2', { topic: '音楽' }), yt('b1', { topic: '', category: '学び' }), yt('c1', { topic: 'T3' }), yt('d1', { topic: 'T4' }), yt('e1', { topic: 'T5' }), yt('f1', { topic: '' , category: '' })];
  const groups = groupVideos(items);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups[0], { name: '音楽', videos: [items[0], items[1]] });
  assert.ok(!groups.some((group) => group.videos.includes(items[6])));
});

test('thumbnail falls back to the YouTube image when the video has none', () => {
  assert.equal(videoImageUrl(yt(A)), `https://i.ytimg.com/vi/${A}/hqdefault.jpg`);
  assert.equal(videoImageUrl(yt(A, { thumbnailUrl: '/t.jpg' })), '/t.jpg');
  assert.equal(videoImageUrl({ sourceUrl: 'https://vimeo.com/1' }), null);
});

test('home renders watched row, saved row and topic rows; empty catalog hides it', async () => {
  const { document, deps, opened, assets } = setup();
  resetVideoHome();
  rememberWatched(yt(B));
  rememberWatched(yt(B));
  assert.equal(watchedVideos().length, 1);
  await loadSavedVideos(async (name, args) => { assert.deepEqual([name, args], ['hub_client', { name: 'video_library' }]); return { savedVideos: [{ id: 'v-s', title: '保存' }, { id: 1 }] }; });
  assert.equal(savedVideos().length, 1);
  const host = document.createElement('div');
  const items = [yt(A, { topic: '音楽' }), yt(C, { topic: '音楽', publishedAt: '2026-10-09T00:00:00Z' })];
  renderVideoHome(host, { items, deps });
  assert.equal(host.hidden, false);
  assert.equal(host.querySelector('.vh-hero'), null, 'no hero: the first screen is not spent on one video');
  assert.deepEqual([...host.querySelectorAll('.vh-row-title')].map((node) => node.textContent), ['続きを見る', 'あとで見る', '音楽']);
  assert.ok(assets.length > 0);
  host.querySelector('.vh-row .vh-card').click();
  assert.deepEqual(opened, [`v-${B}`]);
  resetVideoHome();
  renderVideoHome(host, { items: [], deps });
  assert.equal(host.hidden, true);
});

test('card shows an initial avatar, channel and meta; compact card has no avatar', () => {
  const { document, deps } = setup();
  const card = createVideoCard(document, yt(A, { duration: '3:21' }), { ...deps });
  assert.equal(card.querySelector('.vh-avatar').textContent, 'チ');
  assert.equal(card.querySelector('.video-duration').textContent, '3:21');
  assert.match(card.textContent, /1,200 回視聴/);
  assert.equal(createVideoCard(document, yt(A), { ...deps, compact: true }).querySelector('.vh-avatar'), null);
});

test('watch stage embeds YouTube, stops by removing the iframe, and resumes on demand', () => {
  const { document, deps } = setup();
  const external = [];
  const stage = createWatchStage(document, yt(A), { hubAsset: deps.hubAsset, onOpenExternal: (url) => external.push(url) });
  document.body.append(stage.element);
  const frame = stage.element.querySelector('iframe');
  assert.match(frame.src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/aaaaaaaaaaa\?.*autoplay=1/);
  stopVideoPlayer();
  assert.equal(stage.element.querySelector('iframe'), null);
  assert.equal(frame.isConnected, false);
  stage.element.querySelector('.video-play').click();
  assert.ok(stage.element.querySelector('iframe'));
  assert.deepEqual(external, []);
});

test('non-YouTube and unavailable videos keep the open-at-source button', () => {
  const { document, deps } = setup();
  const external = [];
  const vimeo = createWatchStage(document, { id: 'v', provider: 'vimeo', sourceUrl: 'https://vimeo.com/1' }, { hubAsset: deps.hubAsset, onOpenExternal: (url) => external.push(url) });
  assert.equal(vimeo.element.querySelector('iframe'), null);
  const button = vimeo.element.querySelector('.video-play');
  assert.equal(button.textContent, '提供元で開く');
  button.click();
  assert.deepEqual(external, ['https://vimeo.com/1']);
  const gone = createWatchStage(document, yt(B, { availabilityStatus: 'unavailable' }), { hubAsset: deps.hubAsset, onOpenExternal() {} });
  assert.equal(gone.element.querySelector('iframe'), null);
  assert.equal(gone.element.querySelector('.video-play').disabled, true);
});

test('watch header lays out title, channel, actions row and description box', () => {
  const { document } = setup();
  const head = createWatchHeader(document, yt(A, { topic: '音楽', category: '音楽' }), { relTime: () => '1日前' });
  assert.equal(head.title.textContent, '動画' + A);
  assert.equal(head.bar.querySelector('.vh-watch-channel strong').textContent, 'チャンネル');
  assert.ok(head.bar.contains(head.actions));
  assert.equal(head.desc.textContent, '1,200 回視聴 · 1日前 · 音楽 · youtube');
});

test('related list excludes the current video and prefers the same category', () => {
  const { document, deps } = setup();
  const current = yt(A, { category: 'X' });
  const nodes = createRelatedList(document, current, [current, yt(B, { category: 'Y', channel: 'z' }), yt(C, { category: 'X' })], deps);
  assert.equal(nodes[0].textContent, '次の動画');
  const cards = nodes.slice(1);
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, new RegExp(`動画${C}`));
  const none = createRelatedList(document, current, [current], deps);
  assert.equal(none.length, 2);
});

test('thumbnails are 16:9 media frames; a disallowed or broken image becomes a text cover, never a broken <img>', () => {
  const { document, deps } = setup();
  const external = createVideoThumbnail(document, yt(A, { thumbnailUrl: 'https://picsum.photos/200/100', title: '外の絵' }), deps);
  assert.ok(external.classList.contains('ds-media'));
  assert.equal(external.style.getPropertyValue('--ratio'), '16 / 9');
  assert.equal(external.querySelector('img'), null);
  assert.equal(external.querySelector('.ds-cover').textContent, '外の絵');
  const allowed = createVideoThumbnail(document, yt(A, { thumbnailUrl: '/t.jpg' }), deps);
  const img = allowed.querySelector('img');
  assert.ok(img);
  img.onerror();
  assert.equal(allowed.querySelector('img'), null);
  assert.ok(allowed.querySelector('.ds-cover'));
});

test('skeletons are as many as asked and use the shared skeleton component', () => {
  const { document } = setup();
  const cards = createVideoSkeletons(document, 6);
  assert.equal(cards.length, 6);
  assert.ok(cards.every(card => card.querySelector('.ds-skeleton') && card.getAttribute('aria-hidden') === 'true'));
});
