import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { renderSocialItem } from './social-stream.mjs';

const root = new URL('./', import.meta.url);
const app = readFileSync(new URL('app.js', root), 'utf8').replaceAll('\r\n', '\n');
const html = readFileSync(new URL('index.html', root), 'utf8');
const between = (from, to) => { const a = app.indexOf(from), b = app.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return app.slice(a, b); };
const tabsBlock = between('const FEED_TAB_KEY =', '// フィードのコンポーザー。');
const listBlock = between('function listFeedItemCards(items) {', 'window.addEventListener("focus", () => {\n  if (feedLoadFailed');
const stateBlock = between('function statePanel(iconName', 'function webDiscoveryAction(');

function fixture(t, { lists = [], saved = null, registered = true, detail = { items: [] }, detailError = null } = {}) {
  const dom = new JSDOM(html, { url: 'https://synthetic-shell.invalid/' });
  t.after(() => dom.window.close());
  const document = dom.window.document, calls = [], store = new Map(saved ? [['hub.desktop.feedTab.v1', saved]] : []);
  const ctx = vm.createContext({
    document, calls, feedScope: 'recommended', socialMode: 'legacy', socialFilter: 'post', socialWantedScene: null, socialStreamController: null,
    socialBar: { hidden: true }, desktopAccount: { state: registered ? 'registered' : 'none' }, homeAccountEpoch: {}, currentView: 'feed',
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    renderSidebarContext(v) { calls.push('sidebar:' + v); }, sidebarContext: document.querySelector('#sidebar-context') ?? document.createElement('div'), sidebarFeedTreeOwned: false, loadFeed: async () => { calls.push('loadFeed'); }, icon: () => '',
    invoke: async (name, args) => {
      calls.push([name, args]);
      if (name === 'hub_client') return { lists };
      if (name === 'hub_detail') { if (detailError) throw detailError; return detail; }
      throw Error('unexpected ' + name);
    },
    postCard: (post) => Object.assign(document.createElement('article'), { className: 'post', textContent: post.body }),
    skeletonPost: () => document.createElement('div'), connectState: () => Object.assign(document.createElement('div'), { className: 'connect' }),
    isReadAccessDenied: (e) => e === 'desktop_not_connected', friendlyError: String,
    feed: { state: { textContent: '' }, list: document.querySelector('#feed-list') },
    feedMore: { hidden: false }, feedFresh: { hidden: false }, feedLoadRevision: 0, feedLoadFailed: false, feedViewKey: () => 'k',
  });
  vm.runInContext(stateBlock + tabsBlock + listBlock, ctx);
  return { document, ctx, calls, store };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const entries = (f) => plain(f.ctx.feedTabEntries());
const labels = (f) => entries(f).map((entry) => entry.label);

test('the timeline header has a title and actions but no tab strip (tabs moved to the left column, 2026-11-06)', () => {
  const dom = new JSDOM(html);
  const view = dom.window.document.querySelector('#view-feed');
  assert.ok(view.querySelector(':scope > header.page-header > h2.page-title'));
  assert.equal(view.querySelector('#feed-refresh'), null);
  assert.equal(view.querySelector('#feed-sources-toggle'), null); // 切り替えは左の列の「…」へ移った
  assert.ok(view.querySelector(':scope > header.page-header[hidden]')); // 孤立したボタンの帯は無い
  assert.equal(view.querySelector('#feed-tabs'), null);
  assert.equal(view.querySelector('.page-header > .page-tabs'), null);
  assert.equal(view.querySelector('[data-scope]'), null);
  assert.ok(view.querySelector('.layout-list #feed-list'));
  dom.window.close();
});

test('entry order is おすすめ, フォロー中, 人気, then one entry per list from the lists API', async (t) => {
  const f = fixture(t, { lists: [{ id: 'l1', name: '友人' }, { id: 'l2', name: '仕事' }, { id: 'bad id', name: 'x' }, { id: 'l3', name: '' }] });
  f.ctx.renderFeedTabs();
  assert.deepEqual(labels(f), ['おすすめ', 'フォロー中', '人気']);
  await tick(); await tick();
  assert.deepEqual(plain(f.calls.filter((c) => c[0] === 'hub_client')), [['hub_client', { name: 'lists' }]]);
  assert.deepEqual(labels(f), ['おすすめ', 'フォロー中', '人気', '友人', '仕事']);
  assert.deepEqual(entries(f).map((entry) => entry.key), ['recommended', 'following', 'popular', 'list:l1', 'list:l2']);
});

test('without a Desktop connection only the three fixed entries appear and the lists API is not called', async (t) => {
  const f = fixture(t, { registered: false });
  f.ctx.renderFeedTabs(); await tick();
  assert.deepEqual(labels(f), ['おすすめ', 'フォロー中', '人気']);
  assert.equal(f.calls.some((c) => c[0] === 'hub_client'), false);
});

test('selecting an entry persists it, marks it selected, redraws the sidebar and reloads the feed', (t) => {
  const f = fixture(t);
  f.ctx.selectFeedTab('following');
  assert.equal(f.store.get('hub.desktop.feedTab.v1'), 'following');
  assert.equal(vm.runInContext('feedScope', f.ctx), 'following');
  assert.deepEqual(entries(f).map((entry) => entry.selected), [false, true, false]);
  assert.ok(f.calls.includes('loadFeed'));
  assert.ok(f.calls.includes('sidebar:feed'));
  f.ctx.selectFeedTab('list:l9');
  assert.equal(vm.runInContext('feedScope', f.ctx), 'list');
  assert.equal(f.store.get('hub.desktop.feedTab.v1'), 'list:l9');
});

test('the stored entry is restored, including a list, and an unknown stored value is ignored', (t) => {
  assert.equal(vm.runInContext('feedScope', fixture(t, { saved: 'popular' }).ctx), 'popular');
  const list = fixture(t, { saved: 'list:abc_1' }).ctx;
  assert.equal(vm.runInContext('feedScope', list), 'list');
  assert.equal(vm.runInContext('feedListId', list), 'abc_1');
  assert.equal(vm.runInContext('feedScope', fixture(t, { saved: 'list:../x' }).ctx), 'recommended');
  assert.equal(vm.runInContext('feedScope', fixture(t, { saved: 'evil' }).ctx), 'recommended');
});

test('a stored list that no longer exists falls back to おすすめ and the sidebar is redrawn', async (t) => {
  const f = fixture(t, { saved: 'list:gone', lists: [{ id: 'l1', name: '友人' }] });
  f.ctx.renderFeedTabs(); await tick(); await tick();
  assert.equal(vm.runInContext('feedScope', f.ctx), 'recommended');
  assert.equal(f.store.get('hub.desktop.feedTab.v1'), 'recommended');
  assert.ok(f.calls.includes('sidebar:feed'));
});

test('thread and community pages rename the page and do not load the lists', async (t) => {
  const f = fixture(t);
  vm.runInContext("socialMode='mixed';socialFilter='thread'", f.ctx);
  f.ctx.renderFeedTabs(); await tick();
  assert.equal(f.document.querySelector('#view-feed .page-title').textContent, 'スレッド');
  assert.equal(f.calls.some((c) => c[0] === 'hub_client'), false);
  vm.runInContext("socialFilter='community'", f.ctx);
  f.ctx.renderFeedTabs();
  assert.equal(f.document.querySelector('#view-feed .page-title').textContent, 'コミュニティ');
});

test('a list tab reads list_feed and draws post cards; empty and failed lists use a state-panel', async (t) => {
  const post = { id: 'p1', body: '本文', displayName: 'A', createdAt: '2026-10-24T00:00:00.000Z' };
  const response = { id: 'r1', threadId: 't1', threadTitle: 'スレ', body: '返信', displayName: 'B', createdAt: '2026-10-24T00:00:00.000Z' };
  const f = fixture(t, { saved: 'list:l1', detail: { items: [{ kind: 'social', post }, { kind: 'thread-response', response }] } });
  await f.ctx.loadListFeed();
  assert.deepEqual(plain(f.calls.find((c) => c[0] === 'hub_detail')), ['hub_detail', { name: 'list_feed', ids: ['l1'] }]);
  assert.deepEqual([...f.document.querySelectorAll('#feed-list > .post')].map((n) => n.textContent), ['本文', '返信']);

  const empty = fixture(t, { saved: 'list:l1' });
  await empty.ctx.loadListFeed();
  assert.match(empty.document.querySelector('#feed-list .state-panel .state-title').textContent, /投稿はありません/);

  const failed = fixture(t, { saved: 'list:l1', detailError: 'ハブが503を返しています' });
  await failed.ctx.loadListFeed();
  const panel = failed.document.querySelector('#feed-list .state-panel');
  assert.match(panel.title, /503/);
  assert.ok(panel.querySelector('button.btn.btn-secondary.state-action'));
});

test('thread and community stream items render as the same post card as timeline posts', () => {
  const dom = new JSDOM('<body></body>');
  const document = dom.window.document;
  const base = { origin: 'https://hub.example', createdAt: '2026-10-24T00:00:00.000Z' };
  const opened = [];
  const options = { renderPost: () => document.createElement('article'), onOpenThread: (p) => opened.push(['thread', p.id]), onOpenCommunityPost: (p) => opened.push(['community', p.id]), isCurrent: () => true, primaryOrigin: 'https://hub.example', formatTime: () => '3分前' };
  const thread = renderSocialItem(document, { ...base, kind: 'thread', id: 't1', payload: { id: 't1', title: '話し合い', boardKey: 'b', postCount: 4, threadType: 'discussion', status: 'open', updatedAt: base.createdAt } }, options);
  const community = renderSocialItem(document, { ...base, kind: 'community_post', id: 'c1', payload: { id: 'c1', communityId: 'k', communityName: '集まり', body: '今日は晴れ', createdAt: base.createdAt, authorName: '花', authorHandle: 'hana', replyCount: 1, likeCount: 2, kind: 'chat' } }, options);
  for (const card of [thread, community]) {
    assert.equal(card.tagName, 'ARTICLE');
    assert.ok(card.classList.contains('post'));
    assert.equal(card.classList.contains('card'), false);
    assert.ok(card.querySelector(':scope > .post-avatar'));
    assert.ok(card.querySelector(':scope > .post-content > .post-head .when'));
    assert.ok(card.querySelector(':scope > .post-content > .post-body'));
    assert.ok(card.querySelector(':scope > .post-content > .post-foot'));
    assert.equal(card.tabIndex, 0);
  }
  assert.equal(thread.querySelector('.post-body').textContent, '話し合い');
  assert.equal(community.querySelector('.post-body').textContent, '今日は晴れ');
  assert.equal(community.querySelector('.when').textContent, '3分前');
  community.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  thread.querySelector('button').click();
  assert.deepEqual(opened, [['community', 'c1'], ['thread', 't1']]);
  dom.window.close();
});
