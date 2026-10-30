import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  profileJoinedLabel, profileShareUrl, profileLinks, profilePeople, profileContent, profileTabs,
  createProfileBody, renderProfileStats, renderProfileFacts, renderProfileActions, profileWorkPage, PROFILE_WORK_KINDS,
} from './profile-view.mjs';

const doc = () => new JSDOM('<!doctype html><body></body>').window.document;
const css = readFileSync(new URL('./profile-view.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function deps(d, calls = []) {
  return {
    postCard: (post) => { const n = d.createElement('article'); n.className = 'post'; n.textContent = post.body ?? post.id; return n; },
    emptyState: (_icon, title, body) => { const n = d.createElement('div'); n.className = 'empty-state'; n.textContent = [title, body].filter(Boolean).join(' / '); return n; },
    personCard: (p) => { const n = d.createElement('article'); n.className = 'person'; n.textContent = `${p.displayName} @${p.handle}`; return n; },
    openProfile: (h) => calls.push(['profile', h]),
    openThread: (t) => calls.push(['thread', t.id]),
    openCommunity: (c) => calls.push(['community', c.id]),
    openUrl: (u) => calls.push(['url', u]),
  };
}

const full = {
  profile: { id: 'p1', handle: 'ada', displayName: 'Ada', bio: 'hi', joinedAt: '2026-03-04T00:00:00Z' },
  isCurrentUser: false,
  posts: [{ id: 'a', body: 'one' }, { id: 'b', body: 'two', images: [{ url: '/i' }] }, { id: 'c', body: 'three' }],
  pinnedPostId: 'c',
  threads: [{ id: 't1', title: 'スレ', postCount: 4 }],
  communities: [],
  followers: [{ id: 'f1', handle: 'bob', displayName: 'Bob', avatarUrl: '/a', email: 'x@example.com', walletAddress: '0xabc' }],
  followingProfiles: [],
  followerCount: 3, followingCount: 0,
  externalLinks: [{ label: 'site', url: 'https://www.example.org/x' }, { label: 'bad', url: 'javascript:alert(1)' }, { label: '', url: 'https://u:p@evil.example/' }],
  wallets: [{ address: '0x1234567890abcdef1234567890abcdef12345678', network: 'avalanche', published: true }],
};

test('joined label, share url and link filtering', () => {
  assert.equal(profileJoinedLabel('2026-03-04T00:00:00Z'), '2026年3月から利用');
  assert.equal(profileJoinedLabel('nope'), '');
  assert.equal(profileShareUrl('https://hub.example/anything', 'ada'), 'https://hub.example/v2/profile/ada');
  assert.equal(profileShareUrl('https://hub.example', '../x'), null);
  assert.equal(profileShareUrl(null, 'ada'), null);
  assert.equal(profileShareUrl('file:///c:/', 'ada'), null);
  assert.deepEqual(profileLinks(full.externalLinks), [{ url: 'https://www.example.org/x', host: 'example.org', label: 'site' }]);
});

test('people keep only public fields', () => {
  const [p] = profilePeople(full.followers);
  assert.deepEqual(Object.keys(p).sort(), ['avatarUrl', 'displayName', 'handle', 'id']);
  assert.equal(profilePeople([{ handle: 'bad handle' }]).length, 0);
});

test('tabs exist only for kinds with content; posts always present', () => {
  assert.deepEqual(profileTabs(full).map((t) => t.key), ['posts', 'media', 'threads']);
  assert.deepEqual(profileTabs({ posts: [] }).map((t) => t.key), ['posts']);
  const c = profileContent(full);
  assert.equal(c.pinned.id, 'c');
  assert.deepEqual(c.posts.map((p) => p.id), ['a', 'b']);
});

test('body renders pinned first, switches tabs, opens threads, shows empty state', () => {
  const d = doc(); const calls = [];
  const body = createProfileBody(d, full, deps(d, calls));
  const panel = body.root.querySelector('[role=tabpanel]');
  assert.equal(panel.querySelector('.profile-pinned-label').textContent, '固定された投稿');
  assert.deepEqual([...panel.querySelectorAll('.post')].map((n) => n.textContent), ['three', 'one', 'two']);
  const tabs = [...body.root.querySelectorAll('[role=tab]')];
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['true', 'false', 'false']);
  tabs[1].click();
  assert.deepEqual([...panel.querySelectorAll('.post')].map((n) => n.textContent), ['two']);
  tabs[2].click();
  panel.querySelector('.profile-row').click();
  assert.deepEqual(calls, [['thread', 't1']]);
  tabs[2].dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(panel.dataset.tab, 'posts');
  const empty = createProfileBody(d, { isCurrentUser: true, posts: [] }, deps(d));
  assert.match(empty.root.querySelector('.empty-state').textContent, /まだ投稿がありません/);
});

test('connections list opens from stats, opens profiles, never shows private fields', () => {
  const d = doc(); const calls = [];
  const body = createProfileBody(d, full, deps(d, calls));
  const stats = renderProfileStats(d, { ...full, postCount: 3 }, { onConnections: body.showConnections });
  assert.deepEqual([...stats.querySelectorAll('button')].map((b) => b.dataset.connections), ['followers', 'following']);
  stats.querySelector('[data-connections=followers]').click();
  const panel = body.root.querySelector('[role=tabpanel]');
  assert.equal(panel.querySelector('h3').textContent, 'フォロワー');
  panel.querySelector('.person').click();
  assert.deepEqual(calls, [['profile', 'bob']]);
  assert.match(panel.textContent, /新しい順に1人まで表示しています/);
  body.showConnections('following');
  assert.match(panel.textContent, /まだ誰もフォローしていません/);
  panel.querySelector('.head-action').click();
  assert.equal(panel.dataset.tab, 'posts');
  const all = body.root.outerHTML + stats.outerHTML + renderProfileFacts(d, full, deps(d)).outerHTML;
  assert.doesNotMatch(all, /0x[0-9a-f]{6}|@example\.com|walletAddress|javascript:/i);
  const plain = renderProfileStats(d, { postCount: 1, followerCount: 2, followingCount: 3 });
  assert.equal(plain.querySelectorAll('button').length, 0);
});

test('facts show links and joined date; actions differ for own and other profiles', async () => {
  const d = doc(); const calls = [];
  const facts = renderProfileFacts(d, full, deps(d, calls));
  assert.match(facts.textContent, /site/);
  assert.match(facts.textContent, /2026年3月から利用/);
  facts.querySelector('button').click();
  assert.deepEqual(calls, [['url', 'https://www.example.org/x']]);
  const copied = [];
  const own = renderProfileActions(d, { ...full, isCurrentUser: true }, { origin: 'https://hub.example', copyText: async (t) => copied.push(t), onEdit: (h) => calls.push(['edit', h]) });
  assert.deepEqual([...own.querySelectorAll('button')].map((b) => b.textContent), ['プロフィールを編集', 'リンクをコピー']);
  own.querySelector('.profile-edit').click();
  await own.querySelector('.profile-share').onclick();
  assert.deepEqual(copied, ['https://hub.example/v2/profile/ada']);
  const mine = renderProfileActions(d, { ...full, isCurrentUser: true }, { onBookmarks: () => calls.push(['bm']), onLists: () => calls.push(['ls']), onManageChannel: () => calls.push(['studio']) });
  assert.deepEqual([...mine.querySelectorAll('button')].map((b) => b.textContent), ['ブックマーク', 'リスト', 'チャンネルを管理']);
  for (const b of mine.querySelectorAll('button')) b.click();
  assert.deepEqual(calls.slice(-3), [['bm'], ['ls'], ['studio']]);
  assert.equal(renderProfileActions(d, full, { onBookmarks: () => {}, onLists: () => {}, onManageChannel: () => {} }).children.length, 0, 'other profiles get no own-only entries');
  const other = renderProfileActions(d, full, { origin: 'https://hub.example', copyText: async () => {} });
  assert.deepEqual([...other.querySelectorAll('button')].map((b) => b.textContent), ['リンクをコピー']);
  assert.equal(renderProfileActions(d, full, {}).children.length, 0);
});

test('css uses tokens only and markup/app wiring is small', () => {
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|(?<![-\w])(?:white|black)(?![-\w])/i);
  assert.match(html, /href="\.\/profile-view\.css"/);
  for (const id of ['profile-actions', 'profile-facts', 'profile-stats', 'profile-posts']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /from '\.\/profile-view\.mjs'/);
  assert.doesNotMatch(app, /wallets\b[^\n]*profile-view/);
});

test('work pages keep only drawable rows and path-safe cursors; no music kind', () => {
  assert.deepEqual(PROFILE_WORK_KINDS.map((k) => k.key), ['articles', 'videos', 'code']);
  const a = profileWorkPage('articles', { articles: [{ id: 'x', title: 'T', summary: 's' }, { id: 'g', title: 'G', locked: true, summary: '' }, { id: '', title: 'no' }, { id: 'y', title: ' ' }], nextCursor: 'abc_-1' });
  assert.deepEqual(a.items.map((i) => [i.id, i.meta]), [['x', 's'], ['g', '閲覧条件つき']]);
  assert.equal(a.nextCursor, 'abc_-1');
  assert.equal(profileWorkPage('videos', { videos: [], nextCursor: 'a=b' }).nextCursor, null);
  const c = profileWorkPage('code', { repositories: [{ id: 'r', owner: 'ada', name: 'lib.js', description: 'd' }, { owner: '../x', name: 'n' }, { owner: 'ada', name: 'a/b' }] });
  assert.deepEqual(c.items.map((i) => [i.owner, i.name]), [['ada', 'lib.js']]);
  assert.deepEqual(profileWorkPage('music', { music: [{ id: 'm', title: 'M' }] }).items, []);
});

test('work tabs appear only when the list has content, in fixed order, with paging and error states', async () => {
  const d = doc();
  const calls = [];
  const opened = [];
  let failNext = false;
  const pages = {
    profile_articles: { articles: [{ id: 'a1', title: 'Art' }], nextCursor: 'c1' },
    profile_articles_page: { articles: [{ id: 'a2', title: 'Art2' }], nextCursor: null },
    profile_videos: { videos: [] },
  };
  const body = createProfileBody(d, full, { ...deps(d), openWork: (item) => opened.push([item.kind, item.id]),
    loadWorks: async (name, ids) => {
      calls.push([name, ...ids]);
      if (name === 'profile_code') throw new Error('down');
      if (name === 'profile_articles_page' && failNext) { failNext = false; throw new Error('x'); }
      return pages[name];
    } });
  await body.ready;
  const keys = [...body.root.querySelectorAll('.profile-tab')].map((b) => b.dataset.tab);
  assert.deepEqual(keys, ['posts', 'media', 'threads', 'articles']);
  assert.deepEqual(calls.map((c) => c.join(':')).sort(), ['profile_articles:ada', 'profile_code:ada', 'profile_videos:ada']);
  body.root.querySelector('[data-tab="articles"]').click();
  const panel = body.root.querySelector('.profile-panel');
  assert.equal(panel.querySelectorAll('.profile-row').length, 1);
  panel.querySelector('.profile-row').click();
  assert.deepEqual(opened, [['articles', 'a1']]);
  failNext = true;
  panel.querySelector('.profile-works-more').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(panel.querySelector('.profile-works-error'));
  panel.querySelector('.profile-works-more').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(panel.querySelectorAll('.profile-row').length, 2);
  assert.equal(panel.querySelector('.profile-works-more'), null);
  assert.equal(panel.querySelector('.profile-works-error'), null);
  assert.deepEqual(calls.at(-1), ['profile_articles_page', 'ada', 'c1']);
});
