import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createYouTubeDock } from './yt-dock.mjs';

function fixture(stored = null) {
  const dom = new JSDOM('<main class="workspace-main"><div id="slot"></div></main><div id="browser-stage"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const { document } = dom.window, calls = [], store = new Map(stored ? [['hub.miniPlayer.position.v2', JSON.stringify(stored)]] : []);
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const dock = createYouTubeDock({ document, invoke: async (name, args) => { calls.push([name, args]); }, stage: () => document.querySelector('#browser-stage'), storage });
  return { dom, document, dock, calls, store, slot: document.querySelector('#slot') };
}

test('plays over the slot, then becomes a mini player without reloading the iframe', () => {
  const f = fixture();
  assert.equal(f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', title: '動物園', subtitle: 'jawed', slot: f.slot }), true);
  const iframe = f.dock.element.querySelector('iframe');
  assert.equal(f.dock.element.hidden, false); assert.equal(f.dock.element.classList.contains('is-mini'), false);
  f.dock.release(f.slot);
  assert.equal(f.dock.element.classList.contains('is-mini'), true);
  assert.equal(f.dock.element.querySelector('iframe'), iframe, 'same iframe element: no reload');
  assert.equal(f.dock.element.querySelector('.yt-dock-text strong').textContent, '動物園');
  // 同じものをもう一度開いたら、iframe はそのままで大きな枠へ戻る。
  f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', title: '動物園', slot: f.slot });
  assert.equal(f.dock.element.querySelector('iframe'), iframe);
  assert.equal(f.dock.element.classList.contains('is-mini'), false);
  f.dom.window.close();
});

test('a slot that is put on the page just after play still gets the big player, not the mini one', async () => {
  const f = fixture();
  const late = f.document.createElement('div');
  f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', slot: late });
  assert.equal(f.dock.element.hidden, true);
  f.document.querySelector('main').append(late);
  await new Promise(resolve => f.dom.window.requestAnimationFrame(() => f.dom.window.requestAnimationFrame(resolve)));
  assert.equal(f.dock.element.hidden, false);
  assert.equal(f.dock.element.classList.contains('is-mini'), false);
  f.dom.window.close();
});

test('a different video replaces the iframe; × stops and tells subscribers', () => {
  const f = fixture(), seen = [];
  f.dock.subscribe(s => seen.push(s.playing));
  f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', slot: f.slot });
  const first = f.dock.element.querySelector('iframe');
  f.dock.play({ key: 'music:b', id: 'dQw4w9WgXcQ', slot: f.slot });
  assert.notEqual(f.dock.element.querySelector('iframe'), first);
  assert.equal(first.getAttribute('src'), 'about:blank');
  f.dock.element.querySelector('.yt-dock-close').click();
  assert.equal(f.dock.element.querySelector('iframe'), null);
  assert.equal(f.dock.element.hidden, true);
  assert.equal(seen.at(-1), false);
  assert.equal(f.dock.isPlaying('music:b'), false);
  f.dom.window.close();
});

test('back button reopens the source screen; invalid IDs do not play', () => {
  const f = fixture(); let opened = 0;
  assert.equal(f.dock.play({ key: 'x', id: 'bad', slot: f.slot }), false);
  f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', slot: f.slot, onOpen: () => opened++ });
  f.dock.release(f.slot);
  f.dock.element.querySelector('.yt-dock-back').click();
  assert.equal(opened, 1);
  f.dom.window.close();
});

test('mini position is restored from storage and clamped into the window', () => {
  const f = fixture({ right: 99999, bottom: 40 });
  f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', slot: f.slot });
  f.dock.release(f.slot);
  const right = parseFloat(f.dock.element.style.right);
  assert.ok(right <= f.dom.window.innerWidth, `right ${right} is inside the window`);
  assert.equal(f.dock.element.style.bottom, '40px');
  f.dom.window.close();
});

test('only the mini player cuts a hole in browser pages, and the hole is cleared on stop', async () => {
  const f = fixture();
  f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', slot: f.slot });
  f.dock.release(f.slot);
  f.dock.stop();
  await Promise.resolve();
  const holes = f.calls.filter(([name]) => name === 'browser_mini_overlay').map(([, a]) => a);
  assert.ok(holes.length >= 1);
  assert.deepEqual(holes.at(-1), { x: 0, y: 0, width: 0, height: 0 });
  f.dom.window.close();
});

test('without a stored position the mini player sits at the bottom right of the main column, 16px in, and reserves room', () => {
  const f = fixture();
  const main = f.document.querySelector('main');
  main.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
  Object.defineProperty(f.dom.window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(f.dom.window, 'innerHeight', { value: 700, configurable: true });
  f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', slot: f.slot });
  f.dock.release(f.slot);
  assert.equal(f.dock.element.style.width, '356px');
  assert.equal(f.dock.element.style.right, `${1000 - 800 + 16 + 8}px`);
  assert.equal(f.dock.element.style.bottom, `${700 - 600 + 16}px`);
  assert.equal(f.document.body.classList.contains('has-mini-dock'), true);
  f.dock.stop();
  assert.equal(f.document.body.classList.contains('has-mini-dock'), false);
  f.dom.window.close();
});

test('the mini player stays above the Hub music bar when it is showing', () => {
  const f = fixture();
  const main = f.document.querySelector('main');
  main.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 700, width: 800, height: 700 });
  const bar = f.document.createElement('div'); bar.id = 'music-player';
  bar.getBoundingClientRect = () => ({ left: 0, top: 620, right: 800, bottom: 700, width: 800, height: 80 });
  f.document.body.append(bar);
  Object.defineProperty(f.dom.window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(f.dom.window, 'innerHeight', { value: 700, configurable: true });
  f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', slot: f.slot });
  f.dock.release(f.slot);
  assert.equal(f.dock.element.style.bottom, `${700 - 620 + 16}px`);
  f.dom.window.close();
});

// YouTube の埋め込みからの通知を、dock の iframe の窓・YouTube の送り元の組だけ受け付ける。
function fromFrame(f, data, { origin = 'https://www.youtube-nocookie.com', source } = {}) {
  const iframe = f.dock.element.querySelector('iframe');
  const sent = [];
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: { postMessage: (m, o) => sent.push([m, o]) } });
  const event = new f.dom.window.MessageEvent('message', { data, origin, source: source ?? iframe.contentWindow });
  return { sent, fire: () => f.dom.window.dispatchEvent(event), iframe };
}

test('mini size keeps the playing embed at least 200x200', () => {
  const f = fixture();
  f.dock.play({ key: 'music:a', id: 'jNQXAC9IVRw', slot: f.slot });
  f.dock.release(f.slot);
  assert.equal(f.dock.element.style.width, '356px');
  assert.equal(f.dock.element.querySelector('.yt-dock-body').style.height, '200px');
  f.dom.window.close();
});

test('PLAYING from the dock iframe claims playback; other sources and origins are ignored', () => {
  const claims = [], paused = [];
  const owner = { claim: id => claims.push(id), register: (id, pause) => { paused.push(id); return () => {}; } };
  const dom = new JSDOM('<main class="workspace-main"><div id="slot"></div></main>', { url: 'http://localhost', pretendToBeVisual: true });
  const dock = createYouTubeDock({ document: dom.window.document, owner });
  const f = { dom, dock, slot: dom.window.document.querySelector('#slot') };
  dock.play({ key: 'music:a', id: 'jNQXAC9IVRw', slot: f.slot });
  const bad = fromFrame(f, JSON.stringify({ event: 'onStateChange', info: 1 }), { origin: 'https://evil.example' });
  bad.fire(); assert.equal(dock.state().playingNow, false);
  const other = fromFrame(f, JSON.stringify({ event: 'onStateChange', info: 1 }), { source: {} });
  other.fire(); assert.equal(dock.state().playingNow, false);
  const ok = fromFrame(f, JSON.stringify({ event: 'infoDelivery', info: { playerState: 1 } }));
  ok.fire();
  assert.equal(dock.state().playingNow, true); assert.deepEqual(claims, ['yt-dock']); assert.deepEqual(paused, ['yt-dock']);
  dock.pause();
  assert.equal(dock.state().playingNow, false);
  assert.equal(JSON.parse(ok.sent.at(-1)[0]).func, 'pauseVideo'); assert.equal(ok.sent.at(-1)[1], 'https://www.youtube-nocookie.com');
  dom.window.close();
});

test('leaving a video page pauses it but keeps the mini; a music key keeps playing', () => {
  const f = fixture();
  f.dock.play({ key: 'video:a', id: 'jNQXAC9IVRw', slot: f.slot });
  const v = fromFrame(f, JSON.stringify({ event: 'onStateChange', info: 1 })); v.fire();
  assert.equal(f.dock.state().playingNow, true);
  f.dock.release(f.slot);
  assert.equal(JSON.parse(v.sent.at(-1)[0]).func, 'pauseVideo');
  assert.equal(f.dock.state().playingNow, false);
  assert.equal(f.dock.element.hidden, false); assert.equal(f.dock.element.classList.contains('is-mini'), true);
  f.dock.play({ key: 'music:b', id: 'dQw4w9WgXcQ', slot: f.slot });
  const m = fromFrame(f, JSON.stringify({ event: 'onStateChange', info: 1 })); m.fire();
  f.dock.release(f.slot);
  assert.equal(m.sent.length, 0); assert.equal(f.dock.state().playingNow, true);
  f.dom.window.close();
});

test('a hidden window pauses a playing embed', () => {
  const f = fixture();
  f.dock.play({ key: 'music:a', id: 'jNQXAC9IVRw', slot: f.slot });
  const m = fromFrame(f, JSON.stringify({ event: 'onStateChange', info: 1 })); m.fire();
  Object.defineProperty(f.document, 'hidden', { configurable: true, value: true });
  f.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));
  assert.equal(JSON.parse(m.sent.at(-1)[0]).func, 'pauseVideo');
  f.dom.window.close();
});
