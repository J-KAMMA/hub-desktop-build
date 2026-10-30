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
  const t = setup([yt(1), { id: 'h2', title: 'Hub動画', provider: 'hub', channel: 'Hub', channelHandle: 'hubber', duration: '0:20' }]);
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
