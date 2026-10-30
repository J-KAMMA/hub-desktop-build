import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseChannelPage, createChannelState, renderChannelPage, isChannelHandle } from './video-channel-view.mjs';

const channel = (extra = {}) => ({ profileId: 'prof_1', handle: 'hubber', displayName: 'ハブ太郎', avatarUrl: null, bio: '紹介文', followerCount: 1000, followerCountCapped: true, viewerFollows: false, isViewer: false, ...extra });
const vid = (n, extra = {}) => ({ id: `v${n}`, title: `動画${n}`, duration: '3:00', publishedAt: '2026-10-01T00:00:00Z', href: `/v2/videos/v${n}`, locked: false, ...extra });
const doc = () => new JSDOM('<main></main>').window.document;
const deps = (extra = {}) => ({ hubAsset: () => {}, relTime: () => '1日前', signedIn: true, onOpenVideo: () => {}, onLocked: () => {}, onFollow: async (v) => v, onMore: () => {}, onRetry: () => {}, ...extra });

test('handle check matches the Rust allowlist', () => {
  for (const ok of ['a', 'A_b.c-1', 'x'.repeat(64)]) assert.equal(isChannelHandle(ok), true, ok);
  for (const bad of ['', 'a/b', 'a b', '日本', 'x'.repeat(65), '@a']) assert.equal(isChannelHandle(bad), false, bad);
});

test('parseChannelPage keeps the contract fields and drops malformed rows and cursors', () => {
  const page = parseChannelPage({ channel: channel(), videos: [vid(1), { id: 5 }, null, vid(2, { locked: true })], nextCursor: 'abc_-=' });
  assert.equal(page.channel.followerCountCapped, true);
  assert.deepEqual(page.videos.map((v) => [v.id, v.locked]), [['v1', false], ['v2', true]]);
  assert.equal(page.nextCursor, 'abc_-=');
  assert.equal(parseChannelPage({ channel: channel(), videos: [], nextCursor: 'a b/c' }).nextCursor, null);
  assert.equal(parseChannelPage({ error: 'not_found' }).channel, null);
});

test('keyset paging appends, dedupes and ends when the cursor ends', async () => {
  const calls = [];
  const pages = { video_channel: { channel: channel(), videos: [vid(1), vid(2)], nextCursor: 'c1' }, c1: { channel: channel(), videos: [vid(2), vid(3)], nextCursor: 'c2' }, c2: { channel: channel(), videos: [vid(4)], nextCursor: null } };
  const invoke = async (name, args) => { calls.push([args.name, args.ids]); return args.name === 'video_channel' ? pages.video_channel : pages[args.ids[1]]; };
  const state = createChannelState({ invoke, handle: 'hubber' });
  await state.load();
  assert.equal(state.snapshot().status, 'ready');
  await state.more();
  assert.deepEqual(state.snapshot().videos.map((v) => v.id), ['v1', 'v2', 'v3']);
  await state.more();
  assert.deepEqual(state.snapshot().videos.map((v) => v.id), ['v1', 'v2', 'v3', 'v4']);
  assert.equal(state.snapshot().nextCursor, null);
  await state.more();
  assert.deepEqual(calls, [['video_channel', ['hubber']], ['video_channel_page', ['hubber', 'c1']], ['video_channel_page', ['hubber', 'c2']]]);
});

test('more() never runs twice at once and a repeated cursor stops paging', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let pageCalls = 0;
  const invoke = async (name, args) => {
    if (args.name === 'video_channel') return { channel: channel(), videos: [vid(1)], nextCursor: 'c1' };
    pageCalls++; await gate; return { channel: channel(), videos: [vid(2)], nextCursor: 'c1' };
  };
  const state = createChannelState({ invoke, handle: 'hubber' });
  await state.load();
  const a = state.more(), b = state.more();
  release();
  await Promise.all([a, b]);
  assert.equal(pageCalls, 1);
  assert.equal(state.snapshot().nextCursor, null, 'same cursor again ends paging');
});

test('a failed page keeps the list and allows a retry; not_found is its own state', async () => {
  let fail = true;
  const invoke = async (name, args) => {
    if (args.name === 'video_channel') return { channel: channel(), videos: [vid(1)], nextCursor: 'c1' };
    if (fail) throw new Error('boom');
    return { channel: channel(), videos: [vid(2)], nextCursor: null };
  };
  const state = createChannelState({ invoke, handle: 'hubber' });
  await state.load();
  await state.more();
  assert.equal(state.snapshot().moreError, true);
  assert.equal(state.snapshot().videos.length, 1);
  fail = false;
  await state.more();
  assert.equal(state.snapshot().videos.length, 2);
  const missing = createChannelState({ invoke: async () => { throw new Error('not_found'); }, handle: 'nobody' });
  await missing.load();
  assert.equal(missing.snapshot().status, 'not_found');
  const bad = createChannelState({ invoke: async () => { throw new Error('x'); }, handle: '../x' });
  await bad.load();
  assert.equal(bad.snapshot().status, 'not_found');
});

test('a stale load is discarded after dispose', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = createChannelState({ invoke: async () => { await gate; return { channel: channel(), videos: [vid(1)], nextCursor: null }; }, handle: 'hubber' });
  const loading = state.load();
  state.dispose();
  release();
  await loading;
  assert.equal(state.snapshot().channel, null);
});

test('renders the header with the capped follower count, handle, bio and follow button', () => {
  const document = doc();
  const root = renderChannelPage(document, { status: 'ready', channel: channel(), videos: [vid(1)], nextCursor: null }, deps());
  assert.equal(root.querySelector('.vid-channel-name').textContent, 'ハブ太郎');
  assert.equal(root.querySelector('.vid-channel-handle').textContent, '@hubber');
  assert.match(root.querySelector('.vid-channel-followers').textContent, /1,000\+/);
  assert.equal(root.querySelector('.vid-channel-bio').textContent, '紹介文');
  assert.equal(root.querySelector('.vid-follow-button').textContent, 'フォローする');
  assert.equal(root.querySelectorAll('.vh-card').length, 1);
  assert.equal(root.querySelector('.vid-channel-more'), null);
});

test('own channel has no follow button; signed out disables it', () => {
  const document = doc();
  const own = renderChannelPage(document, { status: 'ready', channel: channel({ isViewer: true }), videos: [], nextCursor: null }, deps());
  assert.equal(own.querySelector('.vid-follow'), null);
  const out = renderChannelPage(document, { status: 'ready', channel: channel(), videos: [], nextCursor: null }, deps({ signedIn: false }));
  assert.equal(out.querySelector('.vid-follow-button').disabled, true);
});

test('locked videos show a lock and never open; open ones do', () => {
  const document = doc();
  const opened = [], locked = [];
  const root = renderChannelPage(document, { status: 'ready', channel: channel(), videos: [vid(1), vid(2, { locked: true, thumbnailUrl: '/x.png' })], nextCursor: null },
    deps({ onOpenVideo: (item) => opened.push(item.id), onLocked: (item) => locked.push(item.id) }));
  const cards = root.querySelectorAll('.vh-card');
  assert.equal(cards[1].classList.contains('is-locked'), true);
  assert.ok(cards[1].querySelector('.vid-lock'));
  assert.equal(cards[1].querySelector('img'), null, 'a locked thumbnail is not fetched');
  assert.equal(cards[0].querySelector('.vid-lock'), null);
  cards[1].click();
  cards[0].click();
  assert.deepEqual(locked, ['v2']);
  assert.deepEqual(opened, ['v1']);
});

test('もっと見る appears only with a cursor and disables while loading', () => {
  const document = doc();
  let more = 0;
  const base = { status: 'ready', channel: channel(), videos: [vid(1)], nextCursor: 'c1' };
  const root = renderChannelPage(document, base, deps({ onMore: () => more++ }));
  const button = root.querySelector('.vid-channel-more');
  assert.equal(button.textContent, 'もっと見る');
  button.click();
  assert.equal(more, 1);
  const busy = renderChannelPage(document, { ...base, loadingMore: true }, deps());
  assert.equal(busy.querySelector('.vid-channel-more').disabled, true);
});

test('loading, not found and error states render without a header', () => {
  const document = doc();
  assert.match(renderChannelPage(document, { status: 'loading' }, deps()).textContent, /読み込んでいます/);
  assert.match(renderChannelPage(document, { status: 'not_found' }, deps()).textContent, /見つかりませんでした/);
  let retried = 0;
  const err = renderChannelPage(document, { status: 'error' }, deps({ onRetry: () => retried++ }));
  err.querySelector('button').click();
  assert.equal(retried, 1);
});
