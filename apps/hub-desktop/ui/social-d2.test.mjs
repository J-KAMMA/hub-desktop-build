// レーン D2（人と会話）の振る舞いの検査。app.js の実物の関数を取り出して、最小の部品で動かす。
import test from 'node:test';
import { addBaitRow, confirmLeave } from './outbound-link.mjs';
import { detectBait } from './bait-warning.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const app = read('app.js');
const html = read('index.html');
const css = read('desktop-social.css');

function actual(signature) {
  const start = app.indexOf(signature);
  const end = app.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, signature);
  return app.slice(start, end + 2);
}

function sandbox(extra = {}) {
  const dom = new JSDOM('<main></main>', { url: 'https://fixture.invalid/' });
  const ctx = vm.createContext({
    document: dom.window.document, URL, URLSearchParams, Event: dom.window.Event, setTimeout, clearTimeout,
    addBaitRow, confirmLeave, detectBait, icon: (name) => `<svg data-icon="${name}"></svg>`, relTime: () => 'now', attachTranslateAction() {}, localTranslator: {}, ...extra,
  });
  return { dom, ctx };
}

test('threadNodes: groups same-sender runs, adds date dividers, marks the last of a run', () => {
  const { dom, ctx } = sandbox({ messageBubble: (message) => { const row = dom.window.document.createElement('div'); row.className = 'bubble-row'; row.dataset.id = message.id; return row; } });
  vm.runInContext(actual('function threadNodes('), ctx);
  const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
  const nodes = Array.from(ctx.threadNodes([
    { id: 'a', senderProfileId: 'x', createdAt: at(14, 9) },
    { id: 'b', senderProfileId: 'x', createdAt: at(14, 10) },
    { id: 'c', senderProfileId: 'y', createdAt: at(14, 11) },
    { id: 'd', senderProfileId: 'y', createdAt: at(15, 9) },
  ], new Map(), 'y'));
  const kinds = nodes.map((node) => node.classList.contains('msg-date') ? 'date' : node.dataset.id + ':' + [...node.classList].filter((name) => name.startsWith('grp-')).join('+'));
  assert.deepEqual(kinds, ['date', 'a:grp-first', 'b:grp-mid+grp-last', 'c:grp-first+grp-last', 'date', 'd:grp-first+grp-last']);
});

test('threadNodes: shows 既読 under the last message only when it is ours and the peer has read everything', () => {
  const { dom, ctx } = sandbox({ messageBubble: (message) => { const row = dom.window.document.createElement('div'); row.className = 'bubble-row'; row.dataset.id = message.id; return row; } });
  vm.runInContext(actual('function threadNodes('), ctx);
  const at = (hour) => new Date(2026, 9, 18, hour).toISOString();
  const mine = [{ id: 'a', senderProfileId: 'x', createdAt: at(9) }, { id: 'b', senderProfileId: 'me', createdAt: at(10) }];
  const seen = (messages, read) => Array.from(ctx.threadNodes(messages, new Map(), 'me', read)).filter((node) => node.classList.contains('msg-read')).map((node) => node.textContent);
  assert.deepEqual(seen(mine, true), ['既読']);
  assert.deepEqual(seen(mine, false), []);
  assert.deepEqual(seen([...mine, { id: 'c', senderProfileId: 'x', createdAt: at(11) }], true), [], 'the peer spoke last');
});

test('post images: count class, intrinsic size and an enlarge control (2026-10-18)', () => {
  assert.ok(app.includes('images.className = `post-images post-images--${shown.length}`'));
  assert.ok(app.includes('openMediaLightbox(shown, index, img)'));
  assert.ok(css.includes('.post-images--3 img:first-child { grid-row: 1 / 3; }'));
  assert.ok(css.includes('dialog.media-lightbox::backdrop'));
});

// 件数の描画は profile-view.mjs の renderProfileStats へ移した。
test('renderProfileStats: number in <b>, word beside it', async () => {
  const { renderProfileStats } = await import('./profile-view.mjs');
  const { dom } = sandbox();
  const nodes = [...renderProfileStats(dom.window.document, { postCount: 3, followerCount: null }).children];
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].querySelector('b').textContent, '3');
  assert.equal(nodes[0].textContent, '3投稿');
  assert.equal(nodes[1].querySelector('b').textContent, '—');
});

test('decoratePostLinks: Hub works become icon + readable title + kind; external shows host; blank lines around the card are trimmed', () => {
  const { dom, ctx } = sandbox();
  vm.runInContext(actual('function decoratePostLinks('), ctx);
  const body = dom.window.document.createElement('p');
  // 本文は行ごとに別の文字ノードになる（renderContentReferenceLinks と同じ形）
  const doc = dom.window.document;
  const anchor = (cls, href, text) => { const node = doc.createElement('a'); node.className = cls; node.href = href; node.textContent = text; return node; };
  body.append(doc.createTextNode('いい曲'), doc.createTextNode('\n'), doc.createTextNode(''), doc.createTextNode('\n'),
    anchor('content-reference-link', '/v2/music/works/never-gonna-give-you-up', '音楽: never-gonna-give-you-up'),
    doc.createTextNode('\n'), doc.createTextNode(''), doc.createTextNode('\n'),
    anchor('content-reference-link external', 'https://example.org/a', 'example.org/a'));
  ctx.decoratePostLinks(body);
  const [hub, external] = body.querySelectorAll('a.ref-card');
  assert.equal(hub.querySelector('.ref-title').textContent, 'never gonna give you up');
  assert.equal(hub.querySelector('.ref-meta').textContent, '音楽');
  assert.match(hub.querySelector('.ref-tile').innerHTML, /data-icon="music"/);
  assert.equal(external.querySelector('.ref-title').textContent, 'example.org/a');
  assert.equal(external.querySelector('.ref-meta').textContent, '外部サイト');
  assert.equal(body.firstChild.textContent, 'いい曲');
  // 本文の文字は変えない。札の前後の空白だけの文字ノードは、隠す枠に包まれる。
  assert.equal(body.textContent.split('\n').length, 5); // 改行はそのまま残る（見えなくするだけ）
  assert.ok(body.textContent.startsWith('いい曲\n'));
  assert.equal(body.querySelectorAll('.ref-gap').length, 6);
  // 二度かけても札が入れ子にならない
  ctx.decoratePostLinks(body);
  assert.equal(body.querySelectorAll('.ref-tile').length, 2);
});

test('post card: initials are not painted, edit/delete/report live in the more menu, no raw button row', () => {
  assert.match(actual('function paintAvatar('), /removeProperty\("background"\)/);
  assert.doesNotMatch(actual('function paintAvatar('), /hsl|#fff|style\.background\s*=/);
  const card = actual('function postCard(');
  assert.doesNotMatch(card, /className = "card post"/);
  assert.doesNotMatch(card, /post-own-tools/);
  assert.match(card, /className = "post-more"/);
  assert.match(card, /moreEntries/);
  // 既存の外押し・Esc の処理に乗る形（メニューの直前の兄弟が押し手）
  assert.match(card, /post-repost-menu post-more-menu/);
});

test('like and save are never disabled while sending; rapid clicks send only the last state', async () => {
  const calls = [];
  const gates = [];
  const { dom, ctx } = sandbox({
    selfProfileId: null, hubOrigin: 'https://hub.invalid', homeAccountSnapshot: () => ({}), homeAccountCurrent: () => true,
    paintAvatar() {}, friendlyError: String, hubAsset() {}, confirm: () => true, reportForm: () => null,
    renderContentReferenceLinks() {}, decoratePostLinks() {}, openSharedContentReference() {}, openDetail() {},
    detailForHubPath: () => null, showNotice() {}, enterBrowser() {}, invoke: (name, args) => {
      calls.push(`${name}:${args?.action ?? ''}`);
      return new Promise((resolve) => gates.push(() => resolve({ summary: { viewerReaction: args.action === 'like' ? 'like' : null, likeCount: args.action === 'like' ? 1 : 0, bookmarked: false } })));
    },
  });
  vm.runInContext(actual('function postCard('), ctx);
  const card = ctx.postCard({ id: 'p1', body: 'x', authorName: 'A', authorHandle: 'a', createdAt: '2026-10-14T00:00:00Z', likeCount: 0 });
  dom.window.document.querySelector('main').append(card);
  const like = card.querySelector('[aria-label="いいね"]');
  like.click(); like.click(); like.click(); // 押す・戻す・押す
  assert.equal(like.disabled, false);
  assert.equal(calls.length, 1); // 送信は 1 本ずつ
  gates.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['hub_client_action:like']); // 最後の状態（like）と同じなので追加の送信は無い
  assert.equal(like.classList.contains('is-liked'), true);
});

test('messages: Enter sends, Shift+Enter and IME composition do not; the input is a textarea', () => {
  assert.match(html, /<textarea id="thread-input"/);
  assert.match(app, /event\.key!=='Enter'\|\|event\.shiftKey\|\|event\.isComposing\|\|event\.keyCode===229/);
  assert.match(app, /dmForm\.requestSubmit\(\)/);
});

test('notifications: read-all lives in the more menu and only shows when there is something unread', () => {
  assert.match(html, /id="notifications-more-wrap" hidden/);
  assert.match(html, /<div class="post-repost-menu head-more-menu"[^>]*hidden><button id="notifications-read-all"/);
  assert.match(app, /moreWrap\.hidden = !notificationsData\.unreadCount/);
});

function notificationStateCallback() {
  const marker = 'onState: value => {';
  const start = app.indexOf(marker);
  const end = app.indexOf('\n  onChanged:', start);
  assert.ok(start >= 0 && end > start, 'actual notifications onState callback');
  const body = app.slice(start + 'onState: '.length, end).replace(/,\s*$/, '');
  return `(() => { const onState = ${body}; return onState; })()`;
}

function notificationFixture(extra = {}) {
  const { dom, ctx } = sandbox({
    friendlyError: (error) => error.message,
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    renderSidebarContext: () => {}, // 通知を描いたあと、列の件数を更新する呼び出し
    ...extra,
  });
  const document = dom.window.document;
  document.body.insertAdjacentHTML('beforeend',
    '<p id="notifications-state"></p><div id="notifications-list"></div><button id="notifications-read-all"></button><span id="notifications-unread"></span><div id="notifications-more-wrap" hidden></div>');
  for (const signature of ['function emptyState(', 'function retryButton(', 'function stateRetryButton(', 'function pageState(', 'function pageErrorState(']) {
    vm.runInContext(actual(signature), ctx);
  }
  return { dom, ctx, document };
}

test('notifications: a failed load replaces the list with a state panel and a retry', () => {
  let loads = 0;
  const { ctx, document } = notificationFixture({
    notificationTicket: 'ticket',
    notificationsController: { isTicketCurrent: () => true },
    loadNotifications: () => { loads++; return Promise.resolve(true); },
  });
  const onState = vm.runInContext(notificationStateCallback(), ctx);
  onState({ phase: 'error', error: new Error('offline'), pending: false });
  const panel = document.querySelector('#notifications-list .state-panel');
  assert.ok(panel, 'the error uses .state-panel in the list');
  assert.ok(panel.classList.contains('load-error'));
  assert.equal(panel.querySelector('.state-title').textContent, '読み込めませんでした');
  assert.equal(panel.querySelector('.state-body').textContent, 'offline');
  assert.equal(document.querySelector('#notifications-state').textContent, '');
  const retry = panel.querySelector('.state-action');
  assert.ok(retry, 'the state panel has a retry');
  assert.ok(retry.classList.contains('btn-primary'));
  retry.onclick();
  assert.equal(loads, 1);
});

test('notifications: an empty list uses the shared state panel and offers no retry', () => {
  let loads = 0;
  const { ctx, document } = notificationFixture({
    notificationsData: { notifications: [], unreadCount: 0 },
    notifTab: 'all',
    currentView: 'notifications',
    notificationTicket: 'ticket',
    notificationsController: { isTicketCurrent: () => true },
    matchesNotifTab: () => true,
    groupNotifications: () => [],
    loadNotifications: () => { loads++; return Promise.resolve(true); },
  });
  vm.runInContext(actual('function renderNotifications('), ctx);
  ctx.renderNotifications();
  const panel = document.querySelector('#notifications-list .state-panel');
  assert.ok(panel, 'the empty state uses .state-panel');
  assert.equal(panel.querySelector('.state-title').textContent, '通知はありません');
  // 空は失敗ではない：「再試行」は置かない（2026-11-12 所有者「外す」）。読み直しは見出しの更新の印が持つ。
  assert.equal(panel.querySelector('.state-action'), null, 'an empty list is not an error, so it offers no retry');
  assert.equal(loads, 0);
});

test('notifications and sidebar conversations get the specified avatar and type sizes', () => {
  const sidebar = read('sidebar-context.css');
  assert.match(css, /#hub-shell #view-notifications #notifications-list \{/);
  assert.match(css, /& \.notif-avatars \.post-avatar \{[^}]*width: 32px;[^}]*height: 32px;/);
  assert.match(sidebar, /#messages-list \.conversation \{[^}]*grid-template-columns: 36px minmax\(0, 1fr\) auto;/);
  assert.match(sidebar, /#messages-list \.conversation \.post-avatar \{ width: 36px; height: 36px;/);
  assert.match(sidebar, /#messages-list \.conversation-head strong \{[^}]*font-size: var\(--type-body\);[^}]*font-weight: var\(--weight-bold\);/);
  assert.match(sidebar, /#messages-list \.conversation-preview \{[^}]*font-size: var\(--type-subhead\);/);
});

test('feed: sources and connections are behind the "…" toggle; the feed body fills the column, whose width the template decides (2026-11-01)', () => {
  assert.match(app, /label: "表示元と接続先", icon: "more"/);
  assert.match(css, /#view-feed \.hub-network-bar,[\s\S]*?\{ display: none; \}/);
  assert.match(css, /:is\(#view-feed, #view-notifications, #view-profile\) \{\s*padding-inline: 0;/);
  assert.match(app, /rootMargin: "0px 0px 600px 0px"/);
});

test('geometry rules from DESKTOP_SPEC are in the lane css', () => {
  assert.match(css, /max-width: 420px/); // 操作行
  assert.match(css, /grid-template-columns: 320px minmax\(0, 1fr\)/); // メッセージ 2 列
  assert.match(css, /width: 96px;\s*height: 96px/); // プロフィールの顔
  assert.match(css, /aspect-ratio: 3 \/ 1/); // 表紙
  assert.match(css, /height: 72px/); // 会話の行
  assert.match(css, /max-width: 70%/); // 吹き出し
});
