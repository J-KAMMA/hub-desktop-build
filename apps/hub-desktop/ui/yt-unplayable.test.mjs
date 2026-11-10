import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createYouTubeDock, UNPLAYABLE_NOTE, TRANSIENT_NOTE } from './yt-dock.mjs';
import { createUnplayableStore, filterVideos, filterWorks, filterResource, filterInvoke, isUnplayableCode, isTransientCode, UNPLAYABLE_KEY, MAX_UNPLAYABLE, UNPLAYABLE_TTL_MS, setUnplayableStore } from './yt-unplayable.mjs';
import { buildShelves } from './music-shelves.mjs';
import { normalizeEntries } from './music-artist-album.mjs';
import { createRelatedList } from './video-home.mjs';

const BAD = 'CevxZvSJLk8', OK = 'jNQXAC9IVRw';
const memory = () => { const m = new Map(); return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const yt = id => ({ sourceUrl: `https://www.youtube.com/watch?v=${id}` });
const work = (id, vid) => ({ id, title: id, services: vid ? [{ provider: 'youtube', url: `https://music.youtube.com/watch?v=${vid}` }] : [] });
const hubVideo = { id: 'h1', provider: 'hub', title: 'own' };
const hubWork = { id: 'music:11111111-1111-4111-8111-111111111111', title: 'own', services: [] };

// 2026-11-05：152/153 は埋め込み側の設定の失敗で、覚えると再生できる曲まで一覧から消えた。
test('only 100/101/150 are remembered as unplayable; 152/153 are transient', () => {
  for (const c of [100, 101, 150, '101']) assert.equal(isUnplayableCode(c), true);
  for (const c of [2, 5, 0, 1, 152, 153, 154, null, undefined]) assert.equal(isUnplayableCode(c), false);
  for (const c of [152, 153, '153']) assert.equal(isTransientCode(c), true);
  for (const c of [100, 101, 150, 2]) assert.equal(isTransientCode(c), false);
  assert.equal(UNPLAYABLE_KEY, 'hub.desktop.ytUnplayable.v2');
});

test('store persists, survives reload, expires after 30 days, caps at 2000 oldest-first', () => {
  const s = memory(); let t = 1_000_000;
  const a = createUnplayableStore({ storage: s, now: () => t });
  assert.equal(a.add(BAD), true); assert.equal(a.add('bad id'), false);
  assert.equal(createUnplayableStore({ storage: s, now: () => t }).has(BAD), true, 'reloaded');
  assert.ok(s.m.has(UNPLAYABLE_KEY) && UNPLAYABLE_KEY.startsWith('hub.desktop.'));
  t += UNPLAYABLE_TTL_MS + 1;
  assert.equal(a.has(BAD), false, 'expired');
  assert.equal(createUnplayableStore({ storage: s, now: () => t }).has(BAD), false);
  const b = createUnplayableStore({ storage: memory(), now: () => ++t });
  const id = n => `a${String(n).padStart(10, '0')}`;
  for (let n = 0; n < MAX_UNPLAYABLE + 5; n++) b.add(id(n));
  assert.equal(b.size(), MAX_UNPLAYABLE); assert.equal(b.has(id(0)), false); assert.equal(b.has(id(4)), false); assert.equal(b.has(id(5)), true);
});

test('a throwing storage never breaks the store', () => {
  const s = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  const a = createUnplayableStore({ storage: s });
  assert.equal(a.has(BAD), false); a.add(BAD); assert.equal(a.has(BAD), true);
});

test('one filter hides remembered YouTube items in every list and leaves Hub items and others alone', () => {
  const store = createUnplayableStore({ storage: memory() }); store.add(BAD); setUnplayableStore(store);
  const videos = [yt(BAD), yt(OK), hubVideo];
  assert.deepEqual(filterVideos(videos, store), [videos[1], hubVideo]);
  const works = [work('w1', BAD), work('w2', OK), hubWork];
  assert.deepEqual(filterWorks(works, store), [works[1], hubWork]);
  assert.deepEqual(filterResource({ videos, works, cursor: 'x' }, store), { videos: [videos[1], hubVideo], works: [works[1], hubWork], cursor: 'x' });
  const shelves = buildShelves({ recommended: works, recent: [{ kind: 'work', work: works[0] }] });
  assert.ok(shelves.every(sh => sh.entries.every(e => e.kind !== 'work' || e.work.id !== 'w1')));
  assert.ok(shelves.some(sh => sh.entries.some(e => e.work && e.work.id === 'w2')));
  assert.deepEqual(normalizeEntries(works).map(e => e.key), ['w2', hubWork.id]);
  const doc = new JSDOM('').window.document;
  const list = [yt(BAD), yt(OK), hubVideo].map((v, i) => ({ ...v, id: `v${i}`, title: 't' }));
  const related = createRelatedList(doc, { id: 'cur' }, list, { hubAsset() {}, relTime: () => '', onOpen() {} });
  assert.equal(related.length, 1 + 2, 'heading + the 2 remaining cards');
});

test('invoke wrapper filters hub_resource answers only', async () => {
  const store = createUnplayableStore({ storage: memory() }); store.add(BAD); setUnplayableStore(store);
  const raw = async () => ({ works: [work('w1', BAD), work('w2', OK)] });
  const inv = filterInvoke(raw);
  assert.equal((await inv('hub_resource', {})).works.length, 1);
  assert.equal((await inv('other', {})).works.length, 2);
});

function fixture() {
  const dom = new JSDOM('<main class="workspace-main"><div id="slot"></div></main>', { url: 'http://localhost', pretendToBeVisual: true });
  const store = createUnplayableStore({ storage: memory() });
  const dock = createYouTubeDock({ document: dom.window.document, store });
  return { dom, dock, store, slot: dom.window.document.querySelector('#slot') };
}
function error(f, code) {
  const iframe = f.dock.element.querySelector('iframe');
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: { postMessage() {} } });
  f.dom.window.dispatchEvent(new f.dom.window.MessageEvent('message', { data: JSON.stringify({ event: 'onError', info: code }), origin: 'https://www.youtube-nocookie.com', source: iframe.contentWindow }));
}

test('onError after an explicit play stops the embed, remembers the id, shows a muted notice that goes away', async () => {
  const f = fixture(); const seen = [];
  f.store.subscribe(id => seen.push(id));
  assert.equal(f.dock.play({ key: 'music:a', id: BAD, slot: f.slot }), true);
  const iframe = f.dock.element.querySelector('iframe');
  error(f, 150);
  assert.equal(iframe.getAttribute('src'), 'about:blank');
  assert.equal(f.store.has(BAD), true); assert.deepEqual(seen, [BAD]);
  assert.equal(f.dock.element.querySelector('.yt-dock-note').textContent, UNPLAYABLE_NOTE);
  assert.equal(f.dock.element.querySelector('iframe'), null);
  await new Promise(r => setTimeout(r, 4100));
  assert.equal(f.dock.state().playing, false);
  f.dom.window.close();
});

test('non-error codes are ignored; the three unplayable codes are remembered', () => {
  for (const code of [2, 5]) { const f = fixture(); f.dock.play({ key: 'music:a', id: BAD, slot: f.slot }); error(f, code); assert.equal(f.store.has(BAD), false); f.dom.window.close(); }
  for (const code of [100, 101, 150]) { const f = fixture(); f.dock.play({ key: 'music:a', id: BAD, slot: f.slot }); error(f, code); assert.equal(f.store.has(BAD), true, String(code)); f.dom.window.close(); }
});

test('152/153 stop this play with a short note but never remove the track; a queue skips on', () => {
  for (const code of [152, 153]) {
    const f = fixture(); const removed = [];
    f.store.subscribe(id => removed.push(id));
    f.dock.play({ key: 'music:a', id: BAD, slot: f.slot }); error(f, code);
    assert.equal(f.store.has(BAD), false, String(code)); assert.deepEqual(removed, []);
    assert.equal(f.dock.element.querySelector('.yt-dock-note').textContent, TRANSIENT_NOTE);
    f.dom.window.close();
  }
  const f = fixture(); const skipped = [];
  f.dock.play({ key: 'video:a', id: BAD, slot: f.slot, quiet: true, onUnplayable: id => skipped.push(id) });
  error(f, 153);
  assert.deepEqual(skipped, [BAD]); assert.equal(f.store.has(BAD), false);
  f.dom.window.close();
});

test('a queue or shelf play is silent: no notice, embed stopped, skip callback runs', () => {
  const f = fixture(); const skipped = [];
  f.dock.play({ key: 'video:a', id: BAD, slot: f.slot, quiet: true, onUnplayable: id => skipped.push(id) });
  error(f, 101);
  assert.deepEqual(skipped, [BAD]);
  assert.equal(f.dock.element.querySelector('.yt-dock-note'), null);
  assert.equal(f.dock.state().playing, false);
  f.dom.window.close();
});

test('an already remembered id never gets a frame; the caller is told so it can skip', () => {
  const f = fixture(); f.store.add(BAD); const skipped = [];
  assert.equal(f.dock.play({ key: 'video:a', id: BAD, slot: f.slot, quiet: true, onUnplayable: id => skipped.push(id) }), false);
  assert.deepEqual(skipped, [BAD]); assert.equal(f.dock.element.querySelector('iframe'), null);
  f.dom.window.close();
});
