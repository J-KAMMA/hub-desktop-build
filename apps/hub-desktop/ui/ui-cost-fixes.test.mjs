import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// 操作の手間の測定（docs/hub-desktop-ui-cost）で選んだ直しを固定する。振る舞いは scripts/ui-cost.mjs の再測定でも確かめる。
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('./desktop-social.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = (start, length = 1200) => { const at = app.indexOf(start); assert.ok(at >= 0, start); return app.slice(at, at + length); };

test('DM: opening a conversation focuses its input once, without stealing focus on a redraw', () => {
  const render = block('function renderThread()', 4200);
  assert.match(render, /dmFocusedConversationId!==activeConversationId&&currentView==='messages'/);
  assert.match(render, /dmInput\.focus\(/);
  assert.match(app, /function closeDmView\(\)\{dmFocusedConversationId=null;/);
  // Enter で送る・Shift+Enter で改行は今までどおり。
  assert.match(block("dmInput.addEventListener('keydown'", 400), /event\.key!=='Enter'\|\|event\.shiftKey/);
});

test('community: the joined list is preselected once when the user has joined groups; a channel focuses its composer', () => {
  const load = block('async function loadCatalog(', 2500);
  assert.match(load, /view === "community" && !communitySortChosen/);
  assert.match(load, /fetchCommunityRanking\("joined"\)/);
  assert.match(load, /communitySort = "joined"/);
  assert.match(app, /communitySort = next; communitySortChosen = true;/);
  assert.match(app, /controller\.ready\)\.then\(\(\)=>\{if\(current\(\)&&!disposed&&textarea\.isConnected&&!textarea\.disabled&&!typing\(\)\)textarea\.focus/);
});

test('post actions: every action button is at least 44px tall and wide, with the icon size unchanged', () => {
  assert.match(css, /#hub-shell \.post \.post-action:not\(#_\)(?::not\(#_\)){3} \{ min-width: 44px; min-height: 44px; height: 44px; \}/);
  assert.doesNotMatch(css.slice(css.indexOf('操作の手間の測定')), /svg/);
});

test('reply box and new post: Ctrl+Enter / Cmd+Enter submits the form, plain Enter stays a newline', () => {
  const handler = block('// Ctrl/Cmd+Enter でフォームを送る', 500);
  assert.match(handler, /\(event\.ctrlKey \|\| event\.metaKey\) && event\.key === "Enter" && event\.target instanceof HTMLTextAreaElement/);
  assert.match(handler, /form\.requestSubmit\(\)/);
  const reply = block('replyBox.className = "post-reply"', 400);
  assert.match(reply, /<form|textarea/);
  assert.doesNotMatch(block('const replyText = replyBox.querySelector', 300), /key === "Enter"/);
  assert.match(app, /composer\.form\.onsubmit = event =>/);
  assert.doesNotMatch(block('composer.text.oninput', 200), /Enter/);
});

test('navigation (IA.md, 2026-11-07): すべて keeps only what no other place reaches in one step; the feed tree has ブックマーク next to リスト', () => {
  const groups = block('const APP_GROUPS = [', 900);
  const labels = [...groups.slice(0, groups.indexOf('];')).matchAll(/\["([^"]+)", "([a-z]+)"\]/g)].map((m) => m[2]);
  assert.deepEqual(labels, ['research', 'games', 'hubpedia', 'books', 'code', 'node', 'compute', 'home', 'ranking', 'services']);
  assert.match(app, /\[tool\("ブックマーク", "bookmark", "bookmarks"\), tool\("リスト", "list", "lists"\)/);
  assert.doesNotMatch(app, /menuAction\("右で読む"/);
  // 外した行き先は、クイック切替え（Ctrl+K）から今までどおり開ける。
  const quick = block('const quickDestinations = [', 900);
  for (const view of ['community', 'threads', 'mail', 'contacts', 'videos', 'music', 'articles', 'purchased', 'search', 'bookmarks', 'lists', 'settings']) assert.ok(quick.includes(`"${view}"]`), view);
});
