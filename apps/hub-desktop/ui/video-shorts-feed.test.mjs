import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { nextShortIndex, isEditableTarget, pickVisible, createShortsFeed, VISIBLE_RATIO } from './video-shorts-feed.mjs';

const yt = (n, extra = {}) => ({ id: `v${n}`, title: `ショート${n}`, channel: 'チャンネル', provider: 'youtube', sourceUrl: `https://www.youtube.com/watch?v=${String(n).padStart(11, 'a')}`, duration: '0:30', ...extra });

function fakeDock() {
  const calls = { play: [], stop: 0 };
  let key = null;
  return { calls, play(args) { calls.play.push(args); key = args.key; return true; }, stop() { calls.stop++; key = null; return true; }, isPlaying: (k) => key === k };
}
function fakeObservers() {
  const made = [];
  const factory = (callback, options) => {
    const observer = { callback, options, targets: [], disconnected: false, observe(t) { this.targets.push(t); }, disconnect() { this.disconnected = true; } };
    made.push(observer);
    return observer;
  };
  return { made, factory };
}
function setup(items, { signedIn = false, invoke = async () => ({}) } = {}) {
  const dom = new JSDOM('<main></main>');
  const { document } = dom.window;
  dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  const dock = fakeDock();
  const obs = fakeObservers();
  const claims = [];
  const owner = { claim: (id) => claims.push(id) };
  const opened = [];
  const feed = createShortsFeed({ document, items, dock, owner, hubAsset: () => {}, signedIn, invoke, observerFactory: obs.factory, onOpenChannel: (h) => opened.push(h), onOpenVideo: (v) => opened.push(v.id) });
  document.querySelector('main').append(feed.element);
  const scrolled = [];
  Object.defineProperty(feed.element, 'clientHeight', { value: 100 });
  feed.element.scrollTo = ({ top }) => scrolled.push(top / 100);
  const show = (index, ratio) => { const target = feed.element.querySelectorAll('.vid-short')[index]; obs.made[0].callback([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]); };
  return { document, dock, obs, claims, opened, feed, scrolled, show, window: dom.window };
}

test('nextShortIndex moves one item and stops at both ends', () => {
  assert.equal(nextShortIndex(0, 'ArrowDown', 3), 1);
  assert.equal(nextShortIndex(2, 'ArrowDown', 3), 2);
  assert.equal(nextShortIndex(1, 'ArrowUp', 3), 0);
  assert.equal(nextShortIndex(0, 'ArrowUp', 3), 0);
  assert.equal(nextShortIndex(null, 'ArrowDown', 3), 1);
  assert.equal(nextShortIndex(0, 'Enter', 3), null);
  assert.equal(nextShortIndex(0, 'ArrowDown', 0), null);
});

test('pickVisible needs at least 60 percent and takes the largest', () => {
  assert.equal(VISIBLE_RATIO, 0.6);
  assert.equal(pickVisible(new Map([[0, 0.59], [1, 0.4]])), null);
  assert.equal(pickVisible(new Map([[0, 0.6], [1, 0.4]])), 0);
  assert.equal(pickVisible(new Map([[0, 0.62], [1, 0.9]])), 1);
  assert.equal(pickVisible(new Map()), null);
});

test('isEditableTarget recognises fields and editable regions only', () => {
  const { document } = new JSDOM('<input id=i><textarea id=t></textarea><select id=s></select><div id=d></div><div id=c contenteditable="true"></div>').window;
  for (const id of ['i', 't', 's', 'c']) assert.equal(isEditableTarget(document.getElementById(id)), true, id);
  assert.equal(isEditableTarget(document.getElementById('d')), false);
  assert.equal(isEditableTarget(null), false);
});

test('only the visible item plays; scrolling moves the single player to the next slot', () => {
  const t = setup([yt(1), yt(2), yt(3)]);
  assert.equal(t.dock.calls.play.length, 0, 'nothing plays before an item is visible');
  assert.equal(t.document.querySelectorAll('iframe').length, 0, 'the feed itself never creates a frame');
  t.show(0, 0.5);
  assert.equal(t.dock.calls.play.length, 0, 'below 60 percent does not play');
  t.show(0, 0.8);
  assert.equal(t.dock.calls.play.length, 1);
  assert.equal(t.dock.calls.play[0].key, 'video:v1');
  assert.equal(t.dock.calls.play[0].slot, t.feed.element.querySelectorAll('.vid-short')[0]._slot);
  assert.equal(t.dock.calls.play[0].id, 'aaaaaaaaaa1');
  t.show(0, 0.7);
  assert.equal(t.dock.calls.play.length, 1, 'the same item is not restarted');
  t.show(0, 0.3); t.show(1, 0.9);
  assert.equal(t.dock.calls.play.length, 2);
  assert.equal(t.dock.calls.play[1].key, 'video:v2');
  assert.equal(t.feed.active(), 1);
});

test('starting a short claims playback for the dock so Hub audio and the rail browser pause', () => {
  const t = setup([yt(1), yt(2)]);
  t.show(0, 1);
  assert.deepEqual(t.claims, ['yt-dock']);
});

test('an item that cannot play in the app stops the previous player and shows an open button', () => {
  const t = setup([yt(1), { id: 'h2', title: '外部動画', provider: 'other', channel: 'Other', duration: '0:20' }]);
  t.show(0, 1);
  assert.equal(t.dock.isPlaying('video:v1'), true);
  t.show(0, 0); t.show(1, 1);
  assert.equal(t.dock.calls.stop, 1);
  assert.equal(t.dock.calls.play.length, 1);
  const open = t.feed.element.querySelectorAll('.vid-short')[1].querySelector('.vid-short-open');
  assert.ok(open);
  open.click();
  assert.deepEqual(t.opened, ['h2']);
  assert.equal(t.feed.element.querySelectorAll('.vid-short')[0].querySelector('.vid-short-open'), null);
});

test('leaving the feed (outer observer) stops playback and a later return restarts it', () => {
  const t = setup([yt(1)]);
  t.show(0, 1);
  t.obs.made[1].callback([{ target: t.feed.element, isIntersecting: false, intersectionRatio: 0 }]);
  assert.equal(t.dock.calls.stop, 1);
  assert.equal(t.feed.active(), null);
  t.show(0, 1);
  assert.equal(t.dock.calls.play.length, 2);
});

test('ArrowDown and ArrowUp scroll one item when the feed has focus', () => {
  const t = setup([yt(1), yt(2), yt(3)]);
  t.show(1, 1);
  const key = (name, target = t.feed.element) => { const e = new t.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e; };
  const down = key('ArrowDown');
  assert.equal(down.defaultPrevented, true);
  assert.deepEqual(t.scrolled, [2]);
  key('ArrowUp');
  assert.deepEqual(t.scrolled, [2, 0]);
  key('Enter');
  assert.equal(t.scrolled.length, 2);
});

test('keys typed into an input anywhere are left alone', () => {
  const t = setup([yt(1), yt(2)]);
  t.show(0, 1);
  const input = t.document.createElement('input');
  t.document.body.append(input);
  input.focus();
  const e = new t.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  input.dispatchEvent(e);
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(t.scrolled, []);
  // 入力欄がフィードの中にあっても同じ。
  const inner = t.document.createElement('textarea');
  t.feed.element.append(inner);
  const e2 = new t.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  inner.dispatchEvent(e2);
  assert.equal(e2.defaultPrevented, false);
});

test('a document-level arrow key works only when nothing else has focus', () => {
  const t = setup([yt(1), yt(2)]);
  t.feed.element.checkVisibility = () => true;
  t.show(0, 1);
  const other = t.document.createElement('button');
  t.document.body.append(other);
  other.focus();
  const blocked = new t.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  other.dispatchEvent(blocked);
  assert.equal(blocked.defaultPrevented, false);
  other.blur();
  const ok = new t.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  t.document.body.dispatchEvent(ok);
  assert.equal(ok.defaultPrevented, true);
  assert.deepEqual(t.scrolled, [1]);
});

test('Hub shorts link to the channel; external ones show the name only', () => {
  const t = setup([yt(1), { ...yt(2), provider: 'hub', channelHandle: 'hubber', sourceUrl: undefined }]);
  const sections = t.feed.element.querySelectorAll('.vid-short');
  assert.equal(sections[0].querySelector('button.vid-short-channel'), null);
  const link = sections[1].querySelector('button.vid-short-channel');
  link.click();
  assert.deepEqual(t.opened, ['hubber']);
});

test('the like button loads once per item and is disabled when signed out', async () => {
  const calls = [];
  const invoke = async (name, args) => { calls.push([name, args.name ?? args.action]); return { likeCount: 4, likedByViewer: true }; };
  const signedOut = setup([yt(1)], { signedIn: false, invoke });
  signedOut.show(0, 1);
  const off = signedOut.feed.element.querySelector('.vid-like-button');
  assert.equal(off.disabled, true);
  assert.equal(calls.length, 0, 'signed out does not call Hub');
  const on = setup([yt(1)], { signedIn: true, invoke });
  on.show(0, 1); on.show(0, 0.8);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const button = on.feed.element.querySelector('.vid-like-button');
  assert.equal(button.disabled, false);
  assert.equal(button.querySelector('.vid-like-count').textContent, '4');
  assert.equal(button.querySelector('.vid-like-label').textContent, 'いいね');
  assert.equal(calls.filter(([, name]) => name === 'video_engagement').length, 1);
});

test('destroy disconnects observers, stops playback and removes the key handler', () => {
  const t = setup([yt(1), yt(2)]);
  t.show(0, 1);
  t.feed.destroy();
  assert.equal(t.obs.made.every((o) => o.disconnected), true);
  assert.equal(t.dock.calls.stop, 1);
  const e = new t.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  t.document.body.dispatchEvent(e);
  assert.equal(e.defaultPrevented, false);
  t.show(1, 1);
  assert.equal(t.dock.calls.play.length, 1, 'no playback after destroy');
});

test('an unplayable short is skipped silently to the next playable one, and remembered ones are not listed', async () => {
  const { createUnplayableStore, setUnplayableStore } = await import('./yt-unplayable.mjs');
  const store = createUnplayableStore({ storage: null });
  setUnplayableStore(store);
  store.add(String(9).padStart(11, 'a'));
  const s = setup([yt(1), yt(9), yt(2)]);
  assert.equal(s.feed.element.querySelectorAll('.vid-short').length, 2, 'remembered id is not shown');
  s.show(0, 1);
  const args = s.dock.calls.play[0];
  assert.equal(args.quiet, true);
  args.onUnplayable(args.id);
  assert.deepEqual(s.scrolled, [0], 'moved to the next playable short (the failed row no longer counts)');
  assert.equal(s.feed.element.querySelectorAll('.vid-short')[0].hidden, true, 'failed one is hidden');
  setUnplayableStore(null);
});

// ---- リールの仕組み（2026-11-02） ----
import { shortAspect, WHEEL_LOCK_MS, SOUND_FALLBACK_MS } from './video-shorts-feed.mjs';
import { youtubeEmbedUrl } from './youtube-embed.mjs';

const hubItem = (n, extra = {}) => ({ id: `h${n}`, title: `Hub${n}`, channel: 'Hub', provider: 'hub', channelHandle: 'hubber', duration: '0:20', ...extra });
const longYt = (n, extra = {}) => yt(n, { duration: '12:00', ...extra });
function memoryStorage() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }

function reel(items, { storage = memoryStorage(), invoke = async () => ({}), ...extra } = {}) {
  const dom = new JSDOM('<main></main>');
  const { document } = dom.window;
  dom.window.HTMLMediaElement.prototype.play = function () { this._plays = (this._plays ?? 0) + 1; return Promise.resolve(); };
  dom.window.HTMLMediaElement.prototype.pause = function () { this._paused = true; };
  const dock = fakeDock();
  dock.muteCalls = [];
  dock.setMuted = (on) => dock.muteCalls.push(on);
  dock.resume = () => { dock.resumed = (dock.resumed ?? 0) + 1; };
  dock.state = () => ({ playingNow: dock.playingNow === true });
  const obs = fakeObservers();
  const attached = [], destroyed = [];
  const attachHls = async (video, deps) => { attached.push({ video, deps }); return { destroy() { destroyed.push(video); } }; };
  const timers = [];
  const clock = { t: 10000 };
  const feed = createShortsFeed({ document, items, dock, owner: { claim() {} }, hubAsset: () => {}, signedIn: false, invoke, observerFactory: obs.factory, attachHls, storage, now: () => clock.t, setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: (id) => { timers[id - 1] = null; }, ...extra });
  document.querySelector('main').append(feed.element);
  Object.defineProperty(feed.element, 'clientHeight', { value: 100 });
  const scrolled = [];
  feed.element.scrollTo = ({ top }) => scrolled.push(top / 100);
  const cards = () => [...feed.element.querySelectorAll('.vid-short')];
  const show = (index, ratio = 1) => { obs.made[0].callback([{ target: cards()[index], isIntersecting: ratio > 0, intersectionRatio: ratio }]); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { dom, document, dock, obs, feed, attached, destroyed, timers, clock, scrolled, cards, show, settle, storage, window: dom.window };
}
const keyDown = (t, name) => { const e = new t.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }); t.feed.element.dispatchEvent(e); return e; };

test('shortAspect uses the source hint, then size, then short=9:16 and regular=16:9', () => {
  assert.equal(shortAspect({ aspectRatio: '16:9' }), 16 / 9);
  assert.equal(shortAspect({ aspectRatio: 0.5 }), 0.5);
  assert.equal(shortAspect({ width: 1920, height: 1080 }), 1920 / 1080);
  assert.equal(shortAspect({ width: 720, height: 1280, duration: '0:30' }), 720 / 1280);
  assert.equal(shortAspect({ duration: '0:30' }), 9 / 16);
  assert.equal(shortAspect({ duration: '12:00' }), 16 / 9);
  assert.equal(shortAspect({}), 16 / 9);
  assert.equal(shortAspect({ aspectRatio: 99 }), 3, 'extreme values are clamped');
});

test('a mixed vertical and landscape feed: each card takes its aspect, one player is active, stepping is one card', () => {
  const items = [yt(1), longYt(2), hubItem(3, { width: 1920, height: 1080 }), hubItem(4, { aspectRatio: '9:16' })];
  const t = reel(items);
  const ar = t.cards().map((c) => Math.round(Number(c.style.getPropertyValue('--ar')) * 10000) / 10000);
  assert.deepEqual(ar, [0.5625, 1.7778, 1.7778, 0.5625]);
  assert.deepEqual(t.cards().map((c) => c.classList.contains('is-landscape')), [false, true, true, false]);
  assert.equal(t.cards()[1].querySelector('.vid-short-poster').style.getPropertyValue('--ratio'), '16 / 9');
  assert.equal(t.cards()[0].querySelector('.vid-short-poster').style.getPropertyValue('--ratio'), '9 / 16');
  t.show(0);
  keyDown(t, 'ArrowDown'); keyDown(t, 'j');
  assert.deepEqual(t.scrolled, [1, 1], 'each press steps one card from the active one');
  t.show(0, 0); t.show(1);
  assert.equal(t.dock.calls.play.length, 2);
  assert.equal(t.dock.calls.play[1].key, 'video:v2');
  assert.equal(t.feed.active(), 1);
  assert.ok(t.document.querySelectorAll('iframe, video.vid-short-native').length <= 2);
  keyDown(t, 'k');
  assert.deepEqual(t.scrolled, [1, 1, 0]);
});

test('wheel steps by one card and ignores the rest of a single flick', () => {
  const t = reel([yt(1), yt(2), yt(3)]);
  t.show(0);
  const wheel = (deltaY) => { const e = new t.window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }); t.feed.element.dispatchEvent(e); return e; };
  assert.equal(wheel(120).defaultPrevented, true);
  assert.deepEqual(t.scrolled, [1]);
  t.clock.t += 50; wheel(120); wheel(120);
  assert.deepEqual(t.scrolled, [1], 'inertia events inside the lock do nothing');
  t.show(0, 0); t.show(1);
  t.clock.t += WHEEL_LOCK_MS + 1;
  wheel(-120);
  assert.deepEqual(t.scrolled, [1, 0]);
  t.clock.t += WHEEL_LOCK_MS + 1;
  wheel(2);
  assert.equal(t.scrolled.length, 2, 'tiny deltas are ignored');
});

test('keys j and k work like the arrows and respect input fields', () => {
  const t = reel([yt(1), yt(2)]);
  t.show(0);
  const input = t.document.createElement('input');
  t.feed.element.append(input);
  const typed = new t.window.KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true });
  input.dispatchEvent(typed);
  assert.equal(typed.defaultPrevented, false);
  assert.equal(keyDown(t, 'j').defaultPrevented, true);
  assert.deepEqual(t.scrolled, [1]);
});

test('only the active card and the next one are live; everything else is torn down', async () => {
  const t = reel([hubItem(1), hubItem(2), hubItem(3), hubItem(4)]);
  const live = () => t.cards().map((c) => c.querySelectorAll('video.vid-short-native').length);
  t.show(0); await t.settle();
  assert.deepEqual(live(), [1, 1, 0, 0], 'current and next only');
  assert.deepEqual(t.cards().map((c) => c.dataset.warm === '1'), [false, true, false, false], 'only the next card is preloaded');
  assert.equal(t.attached.length, 2);
  t.show(0, 0); t.show(1); await t.settle();
  assert.deepEqual(live(), [0, 1, 1, 0]);
  assert.equal(t.destroyed.length, 1, 'the card that left is destroyed, not just paused');
  t.show(1, 0); t.show(3); await t.settle();
  assert.deepEqual(live(), [0, 0, 0, 1], 'jumping far away leaves one live card');
  t.feed.destroy();
  assert.equal(t.document.querySelectorAll('video.vid-short-native').length, 0);
  assert.equal(t.destroyed.length, t.attached.length, 'every attached player is destroyed');
});

test('YouTube cards: one dock player, the next poster is warmed, the others stay lazy; the feed makes no iframe', () => {
  const t = reel([yt(1), yt(2), yt(3)]);
  t.show(1);
  assert.equal(t.document.querySelectorAll('iframe').length, 0);
  assert.equal(t.dock.calls.play.length, 1);
  assert.deepEqual(t.cards().map((c) => c.dataset.warm === '1'), [false, false, true]);
  t.show(1, 0); t.show(0);
  assert.deepEqual(t.cards().map((c) => c.dataset.warm === '1'), [false, true, false]);
  assert.equal(t.dock.calls.play.length, 2, 'the dock replaces its single player');
});

test('a Hub video plays through the HLS path, looped and muted, and falls back to the open button on failure', async () => {
  const t = reel([hubItem(1), yt(2)], { invoke: async () => ({ playlist: '#EXTM3U' }) });
  t.show(0); await t.settle();
  const video = t.cards()[0].querySelector('video.vid-short-native');
  assert.ok(video);
  assert.equal(video.loop, true);
  assert.equal(video.muted, true);
  assert.ok(video._plays >= 1, 'autoplay starts when it becomes the main card');
  assert.equal(t.cards()[0].querySelector('.vid-short-open'), null);
  t.attached[0].deps.onError(new Error('x'));
  assert.equal(t.cards()[0].querySelector('video.vid-short-native'), null);
  assert.ok(t.cards()[0].querySelector('.vid-short-open'));
});

test('the sound choice is remembered for the session and applied to the YouTube dock and Hub videos', async () => {
  const storage = memoryStorage();
  const t = reel([yt(1), hubItem(2)], { storage });
  assert.equal(t.feed.muted(), true, 'starts muted');
  assert.equal(t.cards()[0].querySelector('.vid-short-sound').getAttribute('aria-label'), '音を出す');
  t.show(0);
  assert.equal(t.dock.calls.play[0].muted, true);
  assert.equal(t.dock.calls.play[0].loop, true);
  t.cards()[0].querySelector('.vid-short-sound').click();
  assert.equal(t.feed.muted(), false);
  assert.deepEqual(t.dock.muteCalls, [false]);
  assert.equal(t.cards()[0].querySelector('.vid-short-sound').getAttribute('aria-label'), '音を消す');
  t.show(0, 0); t.show(1); await t.settle();
  assert.equal(t.cards()[1].querySelector('video.vid-short-native').muted, false, 'the choice carries to the next card');
  t.feed.destroy();
  const again = reel([yt(1)], { storage });
  assert.equal(again.feed.muted(), false, 'a new feed in the same session keeps it');
  again.show(0);
  assert.equal(again.dock.calls.play[0].muted, false);
});

test('tapping a Hub video toggles the sound', async () => {
  const t = reel([hubItem(1)]);
  t.show(0); await t.settle();
  const video = () => t.cards()[0].querySelector('video.vid-short-native');
  video().click();
  assert.equal(t.feed.muted(), false);
  video().click();
  assert.equal(t.feed.muted(), true);
});

test('if sound-on autoplay does not start, the YouTube card falls back to muted without overwriting the saved choice', () => {
  const storage = memoryStorage();
  storage.setItem('hub.desktop.shortsMuted', '0');
  const t = reel([yt(1)], { storage });
  t.show(0);
  assert.equal(t.dock.calls.play[0].muted, false);
  assert.equal(t.timers.length, 1);
  t.timers[0]();
  assert.equal(t.feed.muted(), true);
  assert.deepEqual(t.dock.muteCalls, [true]);
  assert.equal(t.dock.resumed, 1);
  assert.equal(storage.getItem('hub.desktop.shortsMuted'), '0');
  assert.ok(SOUND_FALLBACK_MS > 0);
});

test('no fallback runs when the embed is already playing', () => {
  const storage = memoryStorage();
  storage.setItem('hub.desktop.shortsMuted', '0');
  const t = reel([yt(1)], { storage });
  t.show(0);
  t.dock.playingNow = true;
  t.timers[0]();
  assert.equal(t.feed.muted(), false);
  assert.deepEqual(t.dock.muteCalls, []);
});

test('unplayable items are skipped silently: hidden, and not counted by stepping or scrolling', async () => {
  const { createUnplayableStore, setUnplayableStore } = await import('./yt-unplayable.mjs');
  setUnplayableStore(createUnplayableStore({ storage: null }));
  const t = reel([yt(1), yt(2), yt(3), yt(4)]);
  t.show(0);
  t.dock.calls.play[0].onUnplayable('aaaaaaaaaa1');
  assert.equal(t.cards()[0].hidden, true);
  assert.equal(t.scrolled.at(-1), 0, 'the next playable card is the first visible one');
  t.show(0, 0); t.show(1);
  t.dock.calls.play[1].onUnplayable('aaaaaaaaaa2');
  assert.equal(t.cards()[1].hidden, true);
  assert.equal(t.scrolled.at(-1), 0);
  t.show(1, 0); t.show(2);
  keyDown(t, 'ArrowDown');
  assert.equal(t.scrolled.at(-1), 1, 'one visible card ahead of the third');
  setUnplayableStore(null);
});

test('the rail holds flat icon buttons, and the more sheet opens, lists actions and closes', () => {
  const opened = [];
  const t = reel([hubItem(1)], { onOpenVideo: (v) => opened.push(['video', v.id]), onOpenChannel: (h) => opened.push(['channel', h]) });
  const card = t.cards()[0];
  const rail = card.querySelector('.vid-short-rail');
  for (const cls of ['.vid-short-comment', '.vid-short-more', '.vid-short-sound']) assert.ok(rail.querySelector(cls), cls);
  const sheet = card.querySelector('.vid-short-sheet'), more = card.querySelector('.vid-short-more');
  assert.equal(sheet.hidden, true);
  more.click();
  assert.equal(sheet.hidden, false);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...sheet.querySelectorAll('button')].map((b) => b.textContent), ['詳細を開く', 'チャンネルを開く']);
  sheet.querySelectorAll('button')[1].click();
  assert.equal(sheet.hidden, true);
  card.querySelector('.vid-short-comment').click();
  assert.deepEqual(opened, [['channel', 'hubber'], ['video', 'h1']]);
});

test('reduced motion scrolls without animation', () => {
  const t = reel([yt(1), yt(2)]);
  const calls = [];
  t.feed.element.scrollTo = (arg) => calls.push(arg);
  t.window.matchMedia = () => ({ matches: true });
  t.feed.goTo(1);
  t.window.matchMedia = () => ({ matches: false });
  t.feed.goTo(1);
  assert.deepEqual(calls.map((c) => c.behavior), ['auto', 'smooth']);
});

test('the embed URL can start muted and loop without adding any other source', () => {
  const url = new URL(youtubeEmbedUrl('aaaaaaaaaa1', { autoplay: true, mute: true, loop: true }));
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.searchParams.get('mute'), '1');
  assert.equal(url.searchParams.get('loop'), '1');
  assert.equal(url.searchParams.get('playlist'), 'aaaaaaaaaa1');
  assert.equal(new URL(youtubeEmbedUrl('aaaaaaaaaa1', { autoplay: true })).searchParams.has('mute'), false);
});
