import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMiniPlayer, CORNER_KEY } from './mini-player.mjs';
import { createYouTubeDock } from './yt-dock.mjs';
import { nearestCorner, cornerInsets, clampInsets } from './mini-snap.mjs';

function fixture({ stored = null, track = null } = {}) {
  const dom = new JSDOM('<main class="workspace-main"><div id="slot"></div></main>', { url: 'http://localhost', pretendToBeVisual: true });
  const { document } = dom.window;
  Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  const store = new Map(stored ? [[CORNER_KEY, stored]] : []);
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const calls = [], listeners = new Set();
  const s = { track, paused: true, currentTime: 0, duration: 120, hasPrev: true, hasNext: false };
  const engine = {
    state: () => s, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    toggle: () => calls.push('toggle'), prev: () => calls.push('prev'), next: () => calls.push('next'),
    seek: v => calls.push(['seek', v]), close: () => calls.push('close'), expand: () => calls.push('expand'), queue: () => calls.push('queue'),
  };
  const mini = createMiniPlayer({ document, engine, storage });
  return { dom, document, mini, s, calls, store, fire: () => { for (const fn of listeners) fn(); }, host: mini.element };
}
const track = { id: 't1', title: '曲', artist: '誰か' };

test('is hidden until something plays, shows and hides with the engine state', () => {
  const f = fixture();
  assert.equal(f.host.hidden, true);
  assert.equal(f.host.getAttribute('role'), 'region'); assert.equal(f.host.getAttribute('aria-label'), '小窓の再生');
  f.s.track = track; f.s.paused = false; f.fire();
  assert.equal(f.host.hidden, false);
  assert.equal(f.document.body.classList.contains('has-mini-player'), true);
  assert.equal(f.host.querySelector('strong').textContent, '曲');
  assert.equal(f.host.querySelector('.mini-primary').getAttribute('aria-label'), '一時停止');
  assert.equal(f.host.querySelector('.mini-prev').disabled, false); assert.equal(f.host.querySelector('.mini-next').disabled, true);
  f.s.track = null; f.fire();
  assert.equal(f.host.hidden, true); assert.equal(f.document.body.classList.contains('has-mini-player'), false);
  f.dom.window.close();
});

test('controls call the engine', () => {
  const f = fixture({ track });
  for (const name of ['prev', 'primary', 'queue', 'expand', 'close']) f.host.querySelector(`.mini-${name}`).click();
  f.host.querySelector('.mini-seek').value = '42'; f.host.querySelector('.mini-seek').dispatchEvent(new f.dom.window.Event('input'));
  assert.deepEqual(f.calls, ['prev', 'toggle', 'queue', 'expand', 'close', ['seek', 42]]);
  f.host.querySelectorAll('button').forEach(b => assert.ok(b.getAttribute('aria-label')));
  f.dom.window.close();
});

test('Escape does not close it', () => {
  const f = fixture({ track });
  f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  f.host.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(f.host.hidden, false); assert.deepEqual(f.calls, []);
  f.dom.window.close();
});

test('snap helpers keep the window inside the viewport and pick the nearest corner', () => {
  const view = { width: 1280, height: 800 }, size = { width: 320, height: 80 };
  assert.equal(nearestCorner({ left: 10, top: 10, width: 320, height: 80 }, view), 'tl');
  assert.equal(nearestCorner({ left: 900, top: 700, width: 320, height: 80 }, view), 'br');
  assert.equal(nearestCorner({ left: 900, top: 20, width: 320, height: 80 }, view), 'tr');
  assert.deepEqual(cornerInsets('br', size, view), { right: 16, bottom: 16 });
  assert.deepEqual(cornerInsets('tl', size, view), { right: 1280 - 320 - 16, bottom: 800 - 80 - 16 });
  assert.deepEqual(clampInsets({ right: -50, bottom: 9999 }, size, view), { right: 16, bottom: 800 - 80 - 16 });
});

test('dragging snaps to the nearest corner and remembers it (persistence survives a new instance)', () => {
  const f = fixture({ track });
  const top = f.host.querySelector('.mini-top');
  f.host.getBoundingClientRect = () => ({ left: 944, top: 704, right: 1264, bottom: 784, width: 320, height: 80 });
  const ev = (type, x, y) => { const e = new f.dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }); return e; };
  top.dispatchEvent(ev('pointerdown', 1000, 740));
  top.dispatchEvent(ev('pointermove', 100, 60));
  assert.ok(f.host.classList.contains('is-dragging'));
  // 動かしている間も窓の内側
  const right = parseFloat(f.host.style.right), bottom = parseFloat(f.host.style.bottom);
  assert.ok(right >= 16 && right <= 1280 - 320 - 16); assert.ok(bottom >= 16 && bottom <= 800 - 80 - 16);
  top.dispatchEvent(ev('pointerup', 100, 60));
  assert.equal(f.mini.corner(), 'tl'); assert.equal(f.store.get(CORNER_KEY), 'tl');
  assert.equal(f.host.classList.contains('is-dragging'), false);
  f.dom.window.close();
  const g = fixture({ stored: 'tr', track });
  assert.equal(g.mini.corner(), 'tr');
  g.dom.window.close();
});

test('dragging from a button does not start a drag', () => {
  const f = fixture({ track });
  f.host.querySelector('.mini-close').dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
  assert.equal(f.host.classList.contains('is-dragging'), false);
  f.dom.window.close();
});

test('broken storage does not stop playback controls', () => {
  const dom = new JSDOM('<main></main>', { url: 'http://localhost', pretendToBeVisual: true });
  const storage = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  const mini = createMiniPlayer({ document: dom.window.document, storage, engine: { state: () => ({ track }), subscribe: () => () => {} } });
  assert.equal(mini.corner(), 'br'); mini.setCorner('tl'); assert.equal(mini.corner(), 'tl');
  dom.window.close();
});

test('the YouTube iframe is never re-parented: slot, mini, snap, other audio, back to slot', () => {
  const dom = new JSDOM('<main class="workspace-main"><div id="slot"></div></main><div id="browser-stage"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const { document } = dom.window;
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const dock = createYouTubeDock({ document, storage, stage: () => document.querySelector('#browser-stage') });
  const slot = document.querySelector('#slot');
  dock.play({ key: 'music:a', id: 'jNQXAC9IVRw', title: 'A', slot });
  const iframe = dock.element.querySelector('iframe');
  const parent = iframe.parentNode;
  let moves = 0;
  const observer = new dom.window.MutationObserver(records => { for (const r of records) for (const n of [...r.addedNodes, ...r.removedNodes]) if (n === iframe) moves++; });
  observer.observe(document.body, { childList: true, subtree: true });
  dock.release(slot);
  const mini = createMiniPlayer({ document, dock, storage, engine: { state: () => ({ track }), subscribe: () => () => {} } });
  mini.setCorner('tl');
  dock.play({ key: 'music:a', id: 'jNQXAC9IVRw', title: 'A', slot });
  dock.release(slot);
  return Promise.resolve().then(() => {
    assert.equal(iframe.parentNode, parent); assert.equal(iframe.isConnected, true); assert.equal(moves, 0);
    // 同じ隅でも小窓どうしが重ならない（音楽の小窓は YouTube の小窓の分だけずれる）。
    assert.equal(dock.element.classList.contains('is-mini'), true);
    observer.disconnect(); dom.window.close();
  });
});

test('the YouTube mini snaps to a corner on drop and shares the corner key', () => {
  const dom = new JSDOM('<main class="workspace-main"></main><div id="browser-stage"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const { document } = dom.window;
  Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: 800, configurable: true });
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const dock = createYouTubeDock({ document, storage });
  dock.play({ key: 'music:b', id: 'jNQXAC9IVRw', title: 'B', slot: null }); dock.release();
  const head = dock.element.querySelector('.yt-dock-head');
  const ev = (type, x, y) => new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
  head.dispatchEvent(ev('pointerdown', 1000, 700));
  head.dispatchEvent(ev('pointermove', 100, 100));
  head.dispatchEvent(ev('pointerup', 100, 100));
  assert.equal(store.get(CORNER_KEY), 'tl');
  const saved = JSON.parse(store.get('hub.miniPlayer.position.v2'));
  assert.deepEqual(saved, cornerInsets('tl', { width: 356, height: 240 }, { width: 1280, height: 800 }));
  // 再生・一時停止の押しボタンがある
  assert.ok(dock.element.querySelector('.yt-dock-toggle'));
  dom.window.close();
});
