// コミュニティの画面の部品（見出し・概要・詰めた行・返信の木）と、その置き場の決まり。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { aboutFacts, createCommunityAbout, createCommunityHead, gateView, joinView, memberCountText, moderatorsOf } from './community-head.mjs';
import { compactCount, createCommunityRow, messageThreads, rowFromMessage, rowFromPost } from './community-row.mjs';
import { REPLY_DEPTH_CAP, buildReplyTree, renderReplyTree } from './reply-tree.mjs';
import { renderUnifiedPostDetail } from './unified-detail.mjs';
import { joinedCommunities, renderNavCommunities } from './nav-communities.mjs';

const icon = (name) => `<svg data-i="${name}"></svg>`;
const read = (file) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('header state comes only from what the server said: join label, lock and member count', () => {
  assert.deepEqual(joinView({ membership: { joined: true } }), { state: 'joined', label: '参加中' });
  assert.deepEqual(joinView({ viewerStatus: 'muted' }), { state: 'joined', label: '参加中' });
  assert.deepEqual(joinView({ membership: { pending: true } }), { state: 'pending', label: '承認待ち' });
  assert.deepEqual(joinView({ visibility: 'approval' }), { state: 'none', label: '参加を申請' });
  assert.deepEqual(joinView({}), { state: 'none', label: '参加する' });
  assert.equal(gateView({ visibility: 'public' }), null);
  assert.equal(gateView({ visibility: 'approval' }), null);
  assert.deepEqual(gateView({ visibility: 'private' }), { kind: 'private', label: '招待制' });
  assert.deepEqual(gateView({ gate: { description: ' 100 以上 ' } }), { kind: 'gate', label: '条件つき：100 以上' });
  assert.deepEqual(gateView({ gated: true }), { kind: 'gate', label: '条件つき' });
  assert.equal(memberCountText(1284), '1,284');
  assert.equal(memberCountText(-1), '0');
  assert.equal(memberCountText('12'), '0');
});

test('the header draws face, name, lock, members and description on the left and three controls on the right; other sections get the compact form', () => {
  const { document } = new JSDOM('').window;
  const calls = [];
  const head = createCommunityHead(document, { community: { name: '港', description: '説明', memberCount: 3, gate: { description: '条件' } }, join: joinView({}), icon, onJoin: () => calls.push('join'), onAbout: () => calls.push('about') });
  assert.deepEqual([...head.root.children].map((n) => n.className), ['community-head-face', 'community-head-main', 'community-head-actions']);
  assert.equal(head.root.querySelector('.community-head-face').textContent, '港');
  assert.equal(head.root.querySelector('.community-head-gate svg').dataset.i, 'lock');
  assert.deepEqual([...head.root.querySelectorAll('.community-head-actions > *')].map((n) => n.className), ['community-head-join', 'community-head-about']);
  assert.equal(head.joinButton.hasAttribute('data-keep-text'), true);
  head.joinButton.click(); head.aboutButton.click();
  assert.deepEqual(calls, ['join', 'about']);
  head.setAboutOpen(true);
  assert.equal(head.aboutButton.getAttribute('aria-expanded'), 'true');
  const compact = createCommunityHead(document, { community: { name: '港', description: '説明', memberCount: 3 }, section: 'メンバー', icon });
  assert.ok(compact.root.classList.contains('is-compact'));
  assert.equal(compact.root.querySelector('.community-head-desc'), null);
  assert.equal(compact.root.querySelector('.community-head-section').textContent, 'メンバー');
});

test('概要 lists only what the header does not: rules, moderators (owner first) and facts; unreadable parts stay hidden', async () => {
  const community = { name: 'ひみつの名前', description: 'ひみつの説明', memberCount: 987, visibility: 'approval', category: '趣味', createdAt: '2026-03-14T09:00:00.000Z' };
  assert.deepEqual(aboutFacts(community, () => '2026年3月14日').map((fact) => [fact.key, fact.text]), [['created', '2026年3月14日'], ['visibility', '承認制'], ['category', '趣味']]);
  assert.deepEqual(aboutFacts({ visibility: 'private', createdAt: 'x' }).map((fact) => fact.key), [], 'the header lock already says 招待制');
  assert.deepEqual(moderatorsOf([{ id: 'a', displayName: 'A', role: 'member' }, { id: 'b', displayName: 'B', role: 'moderator' }, { id: 'c', displayName: 'C', role: 'owner' }, { id: 'd', displayName: 'D', role: 'moderator', status: 'banned' }, { id: 'e', displayName: '運営', role: '運営' }]).map((m) => m.name), ['C', 'B']);
  const { document } = new JSDOM('').window;
  const opened = [];
  const about = createCommunityAbout(document, { community, icon, formatDate: () => '2026年3月14日', onProfile: (handle) => opened.push(handle),
    loadRules: async () => [{ title: 'ルール一', body: '本文' }, { title: '' }, null], loadModerators: async () => [{ id: 'c', displayName: 'C', handle: 'c', role: 'owner' }] });
  assert.equal(about.root.querySelector('.community-about-rules').hidden, true);
  await about.ready;
  assert.deepEqual([...about.root.querySelectorAll('.community-about-rule')].map((n) => n.textContent), ['ルール一本文']);
  about.root.querySelector('.community-about-mod').click();
  assert.deepEqual(opened, ['c']);
  assert.doesNotMatch(about.root.textContent, /ひみつの名前|ひみつの説明|987/);
  const failing = createCommunityAbout(document, { community: {}, icon, loadRules: async () => { throw new Error('x'); }, loadModerators: null });
  await failing.ready;
  assert.deepEqual([...failing.root.children].map((n) => n.hidden), [true, true, true]);
  const late = createCommunityAbout(document, { community: {}, icon, isCurrent: () => false, loadRules: async () => [{ title: '遅い' }] });
  await late.ready;
  assert.equal(late.root.querySelector('.community-about-rule'), null, 'a result that arrives after leaving is dropped');
});

const post = (extra = {}) => ({ id: 'p1', kind: 'post', title: '題', body: '一行目\n二行目', author: { displayName: '書いた人', handle: 'kaita', communityRole: 'moderator' }, createdAt: '2026-11-07T00:00:00.000Z',
  counts: { replies: 12, likes: 3, saves: 0 }, attachments: [], places: ['channel:c1:question'], viewer: { liked: false }, communityKind: 'question', ...extra });

test('row models: a post and an old message reduce to the same shape; gated posts keep their body and picture out', () => {
  const view = rowFromPost(post({ attachments: [{ type: 'image', refId: 'img-1' }, { type: 'image', refId: 'img-2' }], pinnedAt: 'x' }));
  assert.deepEqual([view.title, view.text, view.kind, view.replies, view.likes, view.thumb, view.more, view.pinned], ['題', '一行目', 'question', 12, 3, '/api/media/images/img-1?variant=thumbnail', 1, true]);
  const locked = rowFromPost(post({ locked: true, body: 'ひみつ', gate: { description: '条件' }, attachments: [{ type: 'image', refId: 'img-1' }] }));
  assert.deepEqual([locked.text, locked.thumb, locked.gate, locked.locked], ['', null, '条件', true]);
  assert.equal(rowFromPost(post({ attachments: [{ type: 'image', refId: '../x' }] })).thumb, null);
  const message = rowFromMessage({ id: 'm1', body: '\n  こんにちは  \n次', kind: 'chat', authorProfileId: 'u', reactions: [{ count: 2 }, { count: 5 }] }, { u: { displayName: 'U', communityRole: 'owner' } }, { replies: 4 });
  assert.deepEqual([message.title, message.text, message.author.name, message.author.role, message.replies, message.likes], ['', 'こんにちは', 'U', 'owner', 4, 7]);
  const threads = messageThreads([{ id: 'a' }, { id: 'b', replyToMessageId: 'a' }, { id: 'c', replyToMessageId: 'b' }, { id: 'd', replyToMessageId: 'gone' }, { id: 'x', replyToMessageId: 'y' }, { id: 'y', replyToMessageId: 'x' }]);
  assert.deepEqual(threads.roots.map((m) => m.id).slice(0, 2), ['a', 'd']);
  assert.equal(threads.replies.get('a'), 2);
  assert.equal(threads.rootOf('c'), 'a');
  assert.deepEqual([0, 999, 1000, 1284, 12000].map(compactCount), ['0', '999', '1k', '1.2k', '12k']);
});

test('a dense row is two lines without an avatar: title, then type chip, author with the role mark, time; the reply count is the strong number; いいね is the only vote', async () => {
  const { document } = new JSDOM('').window;
  const opened = [], liked = [];
  const deps = { icon, relTime: () => '3時間前', hubAsset: (img, url) => { img.src = url; }, onOpen: (view) => opened.push(view.id), onLike: async (view, on) => { liked.push(on); return { likes: 9, liked: on }; }, menu: [['削除', () => opened.push('menu')]] };
  const row = createCommunityRow(document, rowFromPost(post({ attachments: [{ type: 'image', refId: 'img-1' }] })), deps);
  assert.deepEqual([...row.children].map((n) => n.className), ['community-row-main', 'community-row-thumb', 'community-row-stats']);
  assert.equal(row.querySelector('.post-avatar, .community-row-avatar'), null);
  assert.deepEqual([...row.querySelector('.community-row-main').children].map((n) => n.className), ['community-row-title', 'community-row-meta']);
  assert.deepEqual([...row.querySelector('.community-row-meta').children].map((n) => n.className), ['community-row-kind', 'community-row-author', 'community-row-time']);
  assert.equal(row.querySelector('.community-row-kind').textContent, '質問');
  assert.equal(row.querySelector('.community-row-author .role-mark').getAttribute('aria-label'), 'モデレーター');
  assert.equal(row.querySelector('.community-row-replies b').textContent, '12');
  assert.deepEqual([...row.querySelectorAll('.community-row-stats button')].map((b) => b.getAttribute('aria-label')), ['いいね 3件', '投稿のその他の操作', null], 'no downvote, no score');
  assert.doesNotMatch(row.textContent, /カルマ|低評価|スコア/);
  row.querySelector('.community-row-like').click();
  assert.equal(row.querySelector('.community-row-like').getAttribute('aria-pressed'), 'true', 'optimistic');
  await tick();
  assert.deepEqual([liked, opened], [[true], []]);
  assert.equal(row.querySelector('.community-row-like b').textContent, '9');
  row.querySelector('.post-more').click(); row.querySelector('[role=menuitem]').click();
  assert.deepEqual(opened, ['menu'], 'the menu does not open the post');
  row.click();
  assert.deepEqual(opened, ['menu', 'p1']);
  const failing = createCommunityRow(document, rowFromPost(post()), { ...deps, onLike: async () => { throw new Error('x'); } });
  failing.querySelector('.community-row-like').click(); await tick();
  assert.equal(failing.querySelector('.community-row-like').getAttribute('aria-pressed'), 'false', 'rolls back');
  const locked = createCommunityRow(document, rowFromPost(post({ locked: true, title: '', body: 'ひみつ', gate: { description: 'GOHO を 100 以上' }, attachments: [{ type: 'image', refId: 'img-1' }] })), deps);
  assert.equal(locked.querySelector('.community-row-lock svg').dataset.i, 'lock');
  assert.equal(locked.querySelector('.community-row-thumb'), null);
  assert.doesNotMatch(locked.textContent, /ひみつ/);
  assert.equal(locked.querySelector('.community-row-like').disabled, true);
  const pinned = createCommunityRow(document, rowFromPost(post({ pinnedAt: 'x', title: '' })), deps);
  assert.equal(pinned.querySelector('.community-row-meta').firstElementChild.className, 'community-row-pin');
  assert.ok(pinned.querySelector('.community-row-title').classList.contains('is-plain'));
});

const reply = (id, parent, extra = {}) => ({ id, replyToPostId: parent, ...extra });
test('reply tree: nests by parent, keeps the given order, keeps orphans at the top and survives cycles', () => {
  const tree = buildReplyTree([reply('a', 'root'), reply('b', 'a'), reply('c', 'b'), reply('d', 'root'), reply('e', 'missing'), reply('x', 'y'), reply('y', 'x'), reply('root', null), reply('a', 'root')], 'root');
  // 循環（x ⇄ y）は切って、どちらも1段目に残す（捨てない・無限に潜らない）。
  assert.deepEqual(tree.map((n) => n.item.id), ['a', 'd', 'e', 'x', 'y']);
  assert.deepEqual([tree[0].children[0].item.id, tree[0].children[0].children[0].item.id, tree[0].total], ['b', 'c', 2]);
  assert.deepEqual([tree[3].children.length, tree[4].children.length], [0, 0]);
  assert.deepEqual(buildReplyTree(null, 'root'), []);
});

test('reply tree: the guide line collapses its branch into one 返信 N row, the choice is remembered, and depth stops at the cap with a 続き row', () => {
  const { document } = new JSDOM('').window;
  const chain = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i, all) => reply(id, i ? all[i - 1] : 'root'));
  const collapsed = new Set(), continued = [];
  const render = () => renderReplyTree(document, buildReplyTree([...chain, reply('z', 'root')], 'root'), { collapsed, onContinue: (item) => continued.push(item.id),
    renderItem: (item, depth) => Object.assign(document.createElement('article'), { textContent: `${item.id}@${depth}` }) });
  let root = render();
  assert.equal(REPLY_DEPTH_CAP, 4);
  assert.deepEqual([...root.querySelectorAll('.reply-node')].map((n) => `${n.dataset.replyId}:${n.dataset.depth}`), ['a:1', 'b:2', 'c:3', 'd:4', 'z:1'], 'nothing is nested below the cap');
  const more = root.querySelector('.reply-node[data-reply-id="d"] > .reply-continue');
  assert.equal(more.textContent, '続き 2'); more.click();
  assert.deepEqual(continued, ['d']);
  assert.equal(root.querySelector('.reply-node[data-reply-id="z"] .reply-guide'), null, 'a reply without replies has no line');
  const node = root.querySelector('.reply-node[data-reply-id="a"]'), guide = node.querySelector(':scope > .reply-branch > .reply-guide'), unfold = node.querySelector(':scope > .reply-unfold');
  assert.equal(guide.getAttribute('aria-label'), '返信 5件を畳む');
  assert.equal(unfold.hidden, true);
  guide.click();
  assert.equal(node.querySelector(':scope > .reply-branch').hidden, true);
  assert.equal(unfold.hidden, false); assert.equal(unfold.textContent, '返信 5'); assert.equal(node.getAttribute('aria-expanded'), 'false');
  assert.ok(node.querySelector(':scope > .reply-item'), 'the reply itself stays readable');
  assert.deepEqual([...collapsed], ['a']);
  root = render();
  assert.equal(root.querySelector('.reply-node[data-reply-id="a"]').dataset.collapsed, 'true', 'a repaint keeps it folded');
  root.querySelector('.reply-node[data-reply-id="a"] > .reply-unfold').click();
  assert.equal(collapsed.size, 0);
  assert.equal(root.querySelector('.reply-node[data-reply-id="a"] > .reply-branch').hidden, false);
});

test('reply tree: replies whose children were not sent load them on demand', async () => {
  const { document } = new JSDOM('').window;
  const asked = [];
  const root = renderReplyTree(document, buildReplyTree([reply('a', 'root', { counts: { replies: 2 } })], 'root'), { pendingCount: (item) => item.counts?.replies ?? 0,
    loadChildren: async (item) => { asked.push(item.id); return [reply('b', 'a'), reply('c', 'b')]; }, renderItem: (item) => Object.assign(document.createElement('article'), { textContent: item.id }) });
  const unfold = root.querySelector('.reply-unfold');
  assert.equal(unfold.textContent, '返信 2');
  unfold.click(); await tick();
  assert.deepEqual(asked, ['a']);
  assert.deepEqual([...root.querySelectorAll('.reply-node')].map((n) => `${n.dataset.replyId}:${n.dataset.depth}`), ['a:1', 'b:2', 'c:3']);
  assert.ok(root.querySelector('.reply-node[data-reply-id="a"] > .reply-branch > .reply-guide'));
});

test('post detail: replies render as that tree, and the folded set handed in by the caller is used', async () => {
  const { document } = new JSDOM('').window;
  const base = { id: 'p1', kind: 'post', status: 'published', author: { handle: 'mika', displayName: 'Mika', communityRole: 'owner' }, title: '題', body: '本文', bodyFormat: 'plain', places: ['channel:c1:chat'], attachments: [], locked: false,
    counts: { replies: 3, likes: 0, saves: 0 }, viewer: {}, createdAt: '2026-11-07T00:00:00.000Z' };
  const target = document.createElement('div'), opened = [];
  const collapsed = new Set(['r1']);
  renderUnifiedPostDetail(document, target, base, { icon, hubAsset() {}, relTime: () => '今', paintAvatar() {}, collapsedReplies: collapsed, replyDepth: 2, onOpen: (item) => opened.push(item.id),
    loadReplies: async () => ({ items: [{ ...base, id: 'r1', title: null, replyToPostId: 'p1' }, { ...base, id: 'r2', title: null, replyToPostId: 'r1' }, { ...base, id: 'r3', title: null, replyToPostId: 'r2' }] }) });
  await tick();
  assert.ok(target.querySelector('.ud-byline .role-mark-owner'));
  assert.deepEqual([...target.querySelectorAll('.ud-replies .reply-node')].map((n) => `${n.dataset.replyId}:${n.dataset.depth}`), ['r1:1', 'r2:2']);
  assert.equal(target.querySelector('.reply-node[data-reply-id="r1"]').dataset.collapsed, 'true');
  target.querySelector('.reply-continue').click();
  assert.deepEqual(opened, ['r2']);
});

test('the left column has exactly one current item: the community row on its stream, the sub row on 共有 / メンバー', () => {
  const dom = new JSDOM('<div id="host"></div>'), host = dom.window.document.querySelector('#host');
  const data = { communities: [0, 1, 2].map((i) => ({ id: `c${i}`, name: `名前${i}` })), memberships: [0, 1, 2].map((i) => ({ communityId: `c${i}`, status: 'active' })) };
  const subs = (selected) => [{ key: 'shared', label: '共有', selected: selected === 'shared' }, { key: 'members', label: 'メンバー', selected: selected === 'members' }];
  const current = () => [...host.querySelectorAll('[aria-current]')].map((n) => n.textContent);
  renderNavCommunities(dom.window.document, host, joinedCommunities(data), { current: 'c1', subs: subs('') });
  assert.deepEqual(current(), ['名名前1']);
  assert.deepEqual([...host.querySelectorAll('.nav-community-sub')].map((n) => n.textContent), ['共有', 'メンバー'], 'no 新着 / 人気 rows');
  for (const key of ['shared', 'members']) {
    renderNavCommunities(dom.window.document, host, joinedCommunities(data), { current: 'c1', subs: subs(key) });
    assert.deepEqual(current(), [key === 'shared' ? '共有' : 'メンバー']);
    assert.equal(host.querySelector('[data-community-id="c1"]').dataset.open, 'true', 'the open community stays marked as open, not as current');
  }
});

test('app wiring: the sort is offered in the stream only, a post opened from a community keeps that community current, and nothing new animates', () => {
  const app = read('app.js');
  const items = app.slice(app.indexOf('function communitySectionItems(entry) {'), app.indexOf('function openCommunityContent('));
  assert.doesNotMatch(items, /COMMUNITY_ORDERS|latest|popular/, 'the sidebar rows carry no sort');
  assert.equal(app.split('for (const [value, label] of COMMUNITY_ORDERS)').length - 1, 1, 'one sort control');
  assert.match(app, /openDetail\("post", \[item\.id\], \{ title: item\.title \|\| "投稿", communityId \}\)/);
  assert.match(app, /\|\| \(detailName === "post" && Boolean\(detailTrail\.at\(-1\)\?\.communityId\)\)\)/);
  assert.match(app, /postCommunity \? \{ \.\.\.item, selected: false \} : item/);
  const html = read('index.html');
  assert.ok(html.indexOf('./community-view.css') > 0 && html.indexOf('./community-view.css') < html.indexOf('./icon-buttons.css'));
  const css = read('community-view.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|:\s*(?:white|black)\b/.test(css.replace(/:not\(#_\)/g, '').replace(/#hub-shell|#sidebar-context/g, '')), false, 'semantic tokens only');
  assert.equal(/(?:font-size|border-radius)\s*:\s*\d+(?:\.\d+)?px/.test(css), false);
  assert.doesNotMatch(css, /animation|transition|@keyframes/, 'no motion');
  assert.doesNotMatch(css, /background(?:-color|-image)?\s*:\s*[^;{}]*var\(--emphasis\b/, 'gold is never a fill');
  assert.doesNotMatch(css, /gradient/);
});
