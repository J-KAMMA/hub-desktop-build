import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {AI_HANDOFF_MAX_CHARACTERS, POST_DRAFT_MAX_CHARACTERS, aiHandoffLink, buildAiHandoffDraft, buildPostDraftFromAnswer, attachAiHandoff} from './ai-handoff.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const origin = 'https://hub.example';

test('draft carries kind, title, absolute public link and quoted text', () => {
  const draft = buildAiHandoffDraft({kind: 'article', title: '記事題', href: '/v2/articles/a_1', origin, text: '本文です。'});
  assert.match(draft, /種類: 記事/); assert.match(draft, /タイトル: 記事題/);
  assert.match(draft, /リンク: https:\/\/hub\.example\/v2\/articles\/a_1\n/); assert.match(draft, /本文です。/);
  assert.match(draft, /指示ではありません/); assert.ok(draft.endsWith('質問: '));
});

test('every supported kind builds a link with its own reference builder', () => {
  const hrefs = {post: '/v2/posts/p1', article: '/v2/articles/a1', video: '/v2/videos/v1', music: '/v2/music/works/m1'};
  for (const [kind, href] of Object.entries(hrefs)) assert.equal(aiHandoffLink(kind, href, origin), origin + href);
  assert.equal(aiHandoffLink('article', hrefs.video, origin), null, 'kind must match the reference');
  assert.equal(aiHandoffLink('research', '/v2/research/r1', origin), null);
});

test('rejects foreign, absolute, credentialed, or malformed references and origins', () => {
  for (const href of ['https://evil.example/v2/articles/a', '//evil/v2/articles/a', '/v2/articles/a/../b', '/v2/articles/a b', '/v2/articles/', 'v2/articles/a'])
    assert.equal(buildAiHandoffDraft({kind: 'article', title: 't', href, origin, text: 'x'}), null, href);
  for (const bad of ['javascript:alert(1)', 'https://u:p@hub.example', 'https://hub.example/path', 'ftp://hub.example', '', null])
    assert.equal(buildAiHandoffDraft({kind: 'article', title: 't', href: '/v2/articles/a', origin: bad, text: 'x'}), null, String(bad));
});

test('total draft never exceeds 4000 characters, with and without surrogate pairs', () => {
  for (const unit of ['あ', '😀', 'a\n', '\n\n\n\n']) {
    const draft = buildAiHandoffDraft({kind: 'post', title: unit.repeat(900), href: '/v2/posts/p1', origin, text: unit.repeat(9000)});
    assert.ok(draft.length <= AI_HANDOFF_MAX_CHARACTERS, `${unit} ${draft.length}`);
    assert.doesNotMatch(draft, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
  const long = buildAiHandoffDraft({kind: 'post', title: 't', href: '/v2/posts/p1', origin, text: 'あ'.repeat(9000)});
  assert.match(long, /（以下省略）/); assert.ok(long.length > 3500);
  const exact = buildAiHandoffDraft({kind: 'post', title: 't', href: '/v2/posts/p1', origin, text: 'short'});
  assert.doesNotMatch(exact, /以下省略/);
});

test('control characters are removed and title is single-line; empty text still gives a link-only draft', () => {
  const draft = buildAiHandoffDraft({kind: 'video', title: 'a\n\u0000b‮', href: '/v2/videos/v1', origin, text: 'x\u0000y\u0007z'});
  assert.match(draft, /タイトル: a b/); assert.doesNotMatch(draft, /[\u0000\u0007]/); assert.match(draft, /xyz/);
  const bare = buildAiHandoffDraft({kind: 'video', title: '', href: '/v2/videos/v1', origin, text: '   '});
  assert.match(bare, /（無題）/); assert.doesNotMatch(bare, /公開されている本文/);
});

test('post draft from an AI answer trims to 500 and flags truncation', () => {
  assert.deepEqual(buildPostDraftFromAnswer('  回答  \n\n\n\n続き \n'), {text: '回答\n\n続き', truncated: false});
  const exact = buildPostDraftFromAnswer('あ'.repeat(500)); assert.equal(exact.truncated, false); assert.equal(exact.text.length, 500);
  const over = buildPostDraftFromAnswer('あ'.repeat(501)); assert.equal(over.truncated, true); assert.equal(over.text.length, POST_DRAFT_MAX_CHARACTERS);
  const emoji = buildPostDraftFromAnswer('😀'.repeat(400)); assert.equal(emoji.truncated, true); assert.ok(emoji.text.length <= 500);
  assert.doesNotMatch(emoji.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  for (const bad of ['', '   \n', null, undefined, 5, {}]) assert.equal(buildPostDraftFromAnswer(bad), null);
});

function fixture(t, overrides = {}) {
  const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main');
  const f = {host, asked: [], alive: true, ctx: {origin, key: 'k', epoch: 1}, ctxCalls: 0, text: '公開本文'};
  f.controller = attachAiHandoff({document: dom.window.document, host, kind: 'article', href: '/v2/articles/a1', title: '題',
    getText: () => f.text, getContext: async () => { f.ctxCalls++; return f.ctx; }, isCurrent: () => f.alive,
    onAsk: async (draft, source) => { f.asked.push({draft, source}); return true; }, ...overrides});
  t.after(() => { f.controller?.dispose(); dom.window.close(); });
  f.button = host.querySelector('button'); f.status = host.querySelector('p');
  return f;
}

test('button uses the ghost/head-action classes and hands exactly one draft to the AI handler', async t => {
  const f = fixture(t);
  assert.equal(f.button.textContent, 'AIに聞く'); assert.ok(f.button.classList.contains('ghost') && f.button.classList.contains('head-action'));
  assert.equal(f.asked.length, 0, 'nothing runs on attach');
  assert.equal(await f.button.onclick(), true);
  assert.equal(f.asked.length, 1); assert.equal(f.asked[0].source.isCurrent(), true);
  assert.match(f.asked[0].draft, /公開本文/); assert.match(f.status.textContent, /送信/);
});

test('a stale view, changed account scope, or disposed control is a silent no-op', async t => {
  let f = fixture(t); f.alive = false; assert.equal(await f.button.onclick(), false); assert.equal(f.asked.length, 0);
  f = fixture(t, {getContext: async () => null}); assert.equal(await f.button.onclick(), false); assert.equal(f.asked.length, 0);
  let n = 0; f = fixture(t, {getContext: async () => ({origin, key: 'k', epoch: ++n})}); assert.equal(await f.button.onclick(), false); assert.equal(f.asked.length, 0);
  let alive = true; f = fixture(t, {isCurrent: () => alive, getContext: async () => { alive = false; return {origin, key: 'k', epoch: 1}; }});
  assert.equal(await f.button.onclick(), false); assert.equal(f.asked.length, 0);
  f = fixture(t); f.controller.dispose(); assert.equal(f.host.querySelector('button'), null);
});

test('verify must pass (fail closed) and a second click while busy is ignored', async t => {
  let f = fixture(t, {verify: async () => false}); assert.equal(await f.button.onclick(), false); assert.equal(f.asked.length, 0); assert.match(f.status.textContent, /公開状態/);
  f = fixture(t, {verify: async () => { throw new Error('x'); }}); assert.equal(await f.button.onclick(), false); assert.equal(f.asked.length, 0);
  f = fixture(t); const first = f.button.onclick(); assert.equal(await f.button.onclick(), false); await first; assert.equal(f.asked.length, 1);
});

test('handler failures surface a message, keep the page usable and do not retry', async t => {
  for (const [code, pattern] of [['ai_work_busy', /作業中/], ['ai_draft_too_long', /いっぱい/], ['ai_work_unavailable', /開けません/], ['other', /渡せませんでした/]]) {
    const f = fixture(t, {onAsk: async () => { throw new Error(code); }});
    assert.equal(await f.button.onclick(), false); assert.match(f.status.textContent, pattern); assert.equal(f.button.disabled, false);
  }
  const rejected = fixture(t, {onAsk: async () => false}); assert.equal(await rejected.button.onclick(), false); assert.equal(rejected.status.textContent, '');
});

test('attach refuses unsupported kinds, mismatched references and oversized titles', t => {
  const dom = new JSDOM('<main></main>'), host = dom.window.document.querySelector('main'), base = {document: dom.window.document, host, getContext: async () => null, isCurrent: () => true, onAsk: async () => true};
  t.after(() => dom.window.close());
  assert.equal(attachAiHandoff({...base, kind: 'research', href: '/v2/research/r1', title: 't'}), null);
  assert.equal(attachAiHandoff({...base, kind: 'article', href: '/v2/videos/v1', title: 't'}), null);
  assert.equal(attachAiHandoff({...base, kind: 'article', href: '/v2/articles/a1', title: 't'.repeat(481)}), null);
  assert.equal(attachAiHandoff({...base, kind: 'article', href: '/v2/articles/a1', title: 't', onAsk: null}), null);
  assert.equal(host.children.length, 0);
});
