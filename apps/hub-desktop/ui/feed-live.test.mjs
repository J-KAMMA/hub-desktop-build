import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createFeedLive, FEED_LIVE_INTERVAL_MS } from './feed-live.mjs';

const root = new URL('./', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const app = readFileSync(new URL('app.js', root), 'utf8').replaceAll('\r\n', '\n');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const T0 = Date.parse('2026-11-02T00:00:00Z');
const post = (id, minutes) => ({ id, createdAt: new Date(T0 + minutes * 60_000).toISOString() });

function setup(t, { visibility = 'visible' } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dom = new JSDOM(html, { url: 'https://synthetic-shell.invalid/' });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  let hidden = visibility;
  Object.defineProperty(document, 'visibilityState', { get: () => hidden, configurable: true });
  const pill = document.querySelector('#feed-fresh'), pillButton = document.querySelector('#feed-fresh-show'), list = document.querySelector('#feed-list');
  const s = {
    document, pill, pillButton, list, calls: [], server: [post('p3', 3), post('p2', 2), post('p1', 1)], fail: false,
    active: true, scope: 'following', rev: 0, items: [], scrolled: 0, reloaded: 0, rendered: [],
    setVisibility(v) { hidden = v; document.dispatchEvent(new dom.window.Event('visibilitychange')); },
  };
  list.replaceChildren(...['p2', 'p1'].map((id) => Object.assign(document.createElement('article'), { className: 'post', textContent: id })));
  for (const node of list.children) node.dataset.postId = node.textContent;
  s.live = createFeedLive({
    document,
    invoke: async (name, args) => { s.calls.push([name, args]); if (s.fail) throw 'network_unavailable'; return { posts: s.server }; },
    active: () => s.active, scope: () => s.scope, token: () => s.rev,
    shown: () => ({ ids: new Set([...list.querySelectorAll('.post')].map((n) => n.dataset.postId)), newest: T0 + 2 * 60_000 }),
    getItems: () => s.items, setItems: (v) => { s.items = v; },
    pill, pillButton,
    render: (posts) => { s.rendered.push(posts.map((p) => p.id)); list.prepend(...posts.map((p) => Object.assign(document.createElement('article'), { className: 'post' }))); },
    scrollTop: () => { s.scrolled++; }, reload: async () => { s.reloaded++; },
  });
  t.after(() => s.live.dispose());
  return s;
}

test('the refresh icon and the 更新しています strip are gone', () => {
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector('#feed-refresh'), null);
  dom.window.close();
  assert.ok(!app.includes('#feed-refresh'));
  assert.ok(!app.includes('投稿を更新しています'));
  assert.ok(!app.includes('setInterval(async'));
});

test('polls only while visible, every 60s, with an immediate check on resume', async (t) => {
  const s = setup(t, { visibility: 'hidden' });
  s.live.sync();
  assert.equal(s.live.running(), false);
  t.mock.timers.tick(FEED_LIVE_INTERVAL_MS * 3); await flush();
  assert.equal(s.calls.length, 0);
  s.setVisibility('visible'); await flush();
  assert.equal(s.live.running(), true);
  assert.equal(s.calls.length, 1, 'immediate check on resume');
  t.mock.timers.tick(FEED_LIVE_INTERVAL_MS); await flush();
  assert.equal(s.calls.length, 2);
  s.setVisibility('hidden');
  t.mock.timers.tick(FEED_LIVE_INTERVAL_MS * 5); await flush();
  assert.equal(s.calls.length, 2);
  assert.equal(s.live.running(), false);
});

test('the pill shows 新しいポスト（N） and nothing moves until it is clicked', async (t) => {
  const s = setup(t);
  s.live.sync(); await flush();
  assert.equal(s.pill.hidden, false);
  assert.equal(s.pillButton.textContent, '新しいポスト（1）');
  assert.equal(s.list.children.length, 2, 'no insertion on its own');
  assert.equal(s.scrolled, 0);
  s.server = [post('p5', 5), post('p4', 4), ...s.server];
  t.mock.timers.tick(FEED_LIVE_INTERVAL_MS); await flush();
  assert.equal(s.pillButton.textContent, '新しいポスト（3）');
  assert.deepEqual(s.calls[0], ['hub_feed', { scope: 'following', limit: 20 }]);
});

test('clicking the pill prepends the new posts, scrolls to the top and hides it', async (t) => {
  const s = setup(t);
  s.live.sync(); await flush();
  s.pillButton.click();
  assert.deepEqual(s.rendered, [['p3']]);
  assert.equal(s.list.children.length, 3);
  assert.equal(s.scrolled, 1);
  assert.equal(s.pill.hidden, true);
  assert.deepEqual(s.items, []);
});

test('refreshNow (active tab or フィード root) reloads, scrolls to top and hides the pill', async (t) => {
  const s = setup(t);
  s.live.sync(); await flush();
  await s.live.refreshNow();
  assert.equal(s.reloaded, 1);
  assert.equal(s.scrolled, 1);
  assert.equal(s.pill.hidden, true);
  assert.ok(app.includes('key === feedTabKey() && typeof feedLive !== "undefined" && feedLive) { void feedLive?.refreshNow(); return; }'));
});

test('repeated view switches and scope changes keep a single timer', async (t) => {
  const s = setup(t);
  for (let i = 0; i < 4; i++) { s.live.sync(); s.active = false; s.live.sync(); s.active = true; s.live.sync(); }
  await flush();
  const before = s.calls.length;
  t.mock.timers.tick(FEED_LIVE_INTERVAL_MS); await flush();
  assert.equal(s.calls.length - before, 1);
  s.active = false; s.live.sync();
  t.mock.timers.tick(FEED_LIVE_INTERVAL_MS * 3); await flush();
  assert.equal(s.calls.length - before, 1);
  assert.equal(s.live.running(), false);
});

test('a failed read is silent and keeps what is shown and the pill', async (t) => {
  const s = setup(t);
  s.live.sync(); await flush();
  s.fail = true;
  t.mock.timers.tick(FEED_LIVE_INTERVAL_MS); await flush();
  assert.equal(s.list.children.length, 2);
  assert.equal(s.pillButton.textContent, '新しいポスト（1）');
  s.fail = false; s.server = [post('p9', 9), ...s.server];
  t.mock.timers.tick(FEED_LIVE_INTERVAL_MS); await flush();
  assert.equal(s.pillButton.textContent, '新しいポスト（2）');
});

test('a stale read after a reload or an unpolled scope is dropped', async (t) => {
  const s = setup(t);
  s.scope = 'list'; s.live.sync(); await flush();
  assert.equal(s.calls.length, 0);
  s.scope = 'following'; s.rev = 0;
  const slow = s.live.check(); s.rev = 1; await slow; await flush();
  assert.equal(s.pill.hidden, true);
  assert.deepEqual(s.items, []);
});
