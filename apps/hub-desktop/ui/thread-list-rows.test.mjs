import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('./desktop-social.css', import.meta.url), 'utf8');

test('thread rows show the title, quiet type, reply count, solved mark and relative time', () => {
  const card = app.slice(app.indexOf('function threadListCard'), app.indexOf('// 左の列の並び'));
  assert.match(card, /threadRowMeta\(document, t, \{ relTime, icon \}\)/);
  assert.match(card, /thread-row-title/);
  assert.match(card, /tabIndex = 0/);
  assert.match(card, /event\.key === "Enter"/);
});

test('thread meta: type, reply count, 解決済み and N分前 / N時間前 / N日前 / N週間前', async () => {
  const { threadRowMeta } = await import('./thread-list-meta.mjs');
  const { JSDOM } = (await import('node:module')).createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
  const document = new JSDOM('<p/>').window.document;
  const rel = (iso) => ({ a: '3分前', b: '2時間前', c: '5日前', d: '2週間前' })[iso];
  const text = (t) => threadRowMeta(document, t, { relTime: rel, icon: () => '' }).textContent;
  assert.equal(text({ threadType: 'question', postCount: 5, solvedAt: 'x', updatedAt: 'b' }), '質問4解決済み2時間前');
  assert.equal(text({ threadType: 'chat', postCount: 1, updatedAt: 'a' }), '雑談03分前');
  assert.equal(text({ threadType: 'recruitment', postCount: 12, updatedAt: 'd' }), '募集112週間前');
  assert.doesNotMatch(text({ threadType: 'chat', postCount: 2, updatedAt: 'c' }), /解決済み|板|board/);
});

test('the thread list has no count line, no body chips and no big title', () => {
  assert.match(app, /view === "threads" \? "" : page\.loading/);
  assert.ok(app.includes('if (view === "threads" || view === "community") { document.querySelector(`#${view}-chips`)?.remove(); return; }'));
  assert.match(css, /#view-threads > \.view-head > h2/);
});

test('sort and category rows live in the left column', () => {
  assert.match(app, /THREAD_SORTS = \[\["recommended", "おすすめ"\], \["mine", "参加中・追跡中"\], \["popular", "人気"\]\]/);
  assert.match(app, /thread_rankings_\$\{sort\}/);
  assert.match(app, /threadFilterRows\(\)/);
});

test('row styling uses semantic tokens only', () => {
  const block = css.slice(css.indexOf('thread-row {'));
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  assert.match(block, /var\(--content-surface-hover\)/);
  assert.match(block, /-webkit-line-clamp: 2/);
});

test('community list: rankings, card grid, no title or count line', () => {
  assert.match(app, /COMMUNITY_SORTS = \[\["recommended", "おすすめ"\], \["popular", "人気"\], \["joined", "参加中"\]\]/);
  assert.match(app, /community_rankings_\$\{sort\}/);
  assert.ok(app.includes(`readingFilterRows("community", placeJoined, view !== "community")`));
  assert.match(css, /#view-community > \.view-head > h2/);
  const block = css.slice(css.indexOf('#community-results .community-card {'));
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  assert.match(css, /repeat\(auto-fill, minmax\(280px, 1fr\)\)/);
});

test('threads and community lists always use the three-root tree; the community list sits before the sort rows', () => {
  assert.match(app, /view === "threads" \|\| view === "community"\n\s+\|\| \(view === "detail" && \(detailName === "thread" \|\| detailName === "community"\)\)\n\s+\|\| \(sidebarContextOwner === "feed"/);
  // 詳細の画面でも同じ木のまま（戻る行は置かない：戻るのは上の戻るボタン）。
  assert.ok(!app.includes("に戻る` : label") && !app.includes("destination({ articles: \"記事一覧\""));
  assert.match(app, /if \(afterJoined\) afterJoined\(\);/);
  assert.match(css, /#view-threads, #view-community\):not\(#_\):not\(#_\) \{ padding-inline: 0; \}/);
  assert.doesNotMatch(css, /\.sidebar-tree \.nav-communities \.nav-community-all \{ display: none; \}/);
});

test('relTime is relative for old items and absolute only on request', async () => {
  const { railRelativeTime } = await import('./rail-panels.mjs');
  const now = Date.parse('2026-11-07T12:00:00Z');
  const at = (iso, options) => railRelativeTime(iso, now, options);
  assert.equal(at('2026-11-01T12:00:00Z'), '6日前');
  assert.equal(at('2026-10-17T12:00:00Z'), '3週間前');
  assert.equal(at('2026-09-07T12:00:00Z'), '2か月前');
  assert.equal(at('2025-09-07T12:00:00Z'), '1年前');
  assert.match(at('2026-10-30T12:00:00Z', { absolute: true }), /2026年10月30日|2026年/);
  assert.match(app, /relTime\(article\.createdAt, \{ absolute: true \}\)/);
});
