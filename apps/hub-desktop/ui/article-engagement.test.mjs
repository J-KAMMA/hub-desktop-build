import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { isOwnArticle, parseLikeState, parseCommentPage, renderLikeSummary, renderCommentList } from './article-engagement.mjs';

const doc = new JSDOM('').window.document;

test('いいね状態は壊れた応答でも0件に落ちる', () => {
  assert.deepEqual(parseLikeState({ likeCount: 3, liked: true }), { likeCount: 3, liked: true });
  assert.deepEqual(parseLikeState({ likeCount: -2 }), { likeCount: 0, liked: false });
  assert.deepEqual(parseLikeState(null), { likeCount: 0, liked: false });
});

test('コメントは形の合うものだけを通し、本文はタグとして解釈しない', () => {
  const page = parseCommentPage({
    commentsEnabled: true, total: 2,
    comments: [
      { id: 'c1', body: '<img src=x onerror=alert(1)>', createdAt: '2026-10-14T00:00:00Z', author: { displayName: '太郎', handle: 'taro' } },
      { id: 5, body: 'bad' },
    ],
  });
  assert.equal(page.comments.length, 1);
  const root = renderCommentList(doc, page, { relTime: () => '1分前' });
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('.article-comment-body').textContent, '<img src=x onerror=alert(1)>');
  assert.match(root.textContent, /太郎 @taro · 1分前/);
  assert.match(root.querySelector('h3').textContent, /コメント 2件/);
});

test('コメント停止中と0件の文言', () => {
  assert.match(renderCommentList(doc, parseCommentPage({ commentsEnabled: false, comments: [] })).textContent, /受け付けていません/);
  assert.match(renderCommentList(doc, parseCommentPage({ comments: [] })).textContent, /まだコメントはありません/);
});

test('いいね帯は数と済みの印を読み上げに含める', () => {
  const row = renderLikeSummary(doc, { likeCount: 12, liked: true });
  assert.equal(row.getAttribute('aria-label'), 'いいね 12件（いいね済み）');
  assert.equal(row.querySelector('.article-like-count').textContent, '12');
  assert.ok(row.querySelector('.is-liked'));
});

import { renderLikeButton, renderCommentForm } from './article-engagement.mjs';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('いいねボタンは希望の状態を送り、返ってきた状態を描く。失敗は文言を出して戻す', async () => {
  const calls = [];
  const row = renderLikeButton(doc, { likeCount: 2, liked: false }, {
    onSet: async (liked) => { calls.push(liked); if (calls.length === 2) throw new Error('通信に失敗しました。'); return { likeCount: 3, liked }; },
  });
  const button = row.querySelector('button');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  button.click(); await settle();
  assert.deepEqual(calls, [true]);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(row.querySelector('.article-like-count').textContent, '3');
  button.click(); await settle();
  assert.deepEqual(calls, [true, false]);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(row.querySelector('.article-like-note').textContent, '通信に失敗しました。');
  assert.equal(button.disabled, false);
});

test('コメント欄は空では送れず、成功で欄を空にし、本文を解釈しない', async () => {
  const sent = [], posted = [];
  const form = renderCommentForm(doc, { onSubmit: async (body) => { sent.push(body); return { id: 'c1', body }; }, onPosted: (c) => posted.push(c.id) });
  const field = form.querySelector('textarea'), send = form.querySelector('button');
  assert.equal(send.disabled, true);
  field.value = '  <b>こんにちは</b>  '; field.oninput();
  assert.equal(send.disabled, false);
  assert.equal(field.maxLength, 2000);
  form.onsubmit({ preventDefault() {} }); await settle();
  assert.deepEqual(sent, ['<b>こんにちは</b>']);
  assert.deepEqual(posted, ['c1']);
  assert.equal(field.value, '');
  assert.equal(form.querySelector('b'), null);
});

test('コメント送信の失敗は本文を残して文言を出す', async () => {
  const form = renderCommentForm(doc, { onSubmit: async () => { throw new Error('少し待ってからもう一度。'); } });
  const field = form.querySelector('textarea');
  field.value = '本文'; field.oninput();
  form.onsubmit({ preventDefault() {} }); await settle();
  assert.equal(field.value, '本文');
  assert.equal(form.querySelector('.article-comment-note').textContent, '少し待ってからもう一度。');
  assert.equal(form.querySelector('button').disabled, false);
});

test('コメント一覧にフォームを渡すと末尾に付き、Web案内の文は出さない', () => {
  const form = renderCommentForm(doc, { onSubmit: async () => ({}) });
  const root = renderCommentList(doc, parseCommentPage({ comments: [] }), { form });
  assert.equal(root.lastElementChild, form);
  assert.doesNotMatch(root.textContent, /Web版/);
  assert.match(renderCommentList(doc, parseCommentPage({ comments: [] }), { signedOutNote: '接続してください' }).textContent, /接続してください/);
});

test('自分の記事かどうかは両方のハンドルがそろって一致するときだけ', () => {
  assert.equal(isOwnArticle({ handle: 'Kamma' }, 'kamma'), true);
  assert.equal(isOwnArticle({ handle: 'kamma' }, 'other'), false);
  assert.equal(isOwnArticle({ handle: 'kamma' }, null), false);
  assert.equal(isOwnArticle(null, 'kamma'), false);
  assert.equal(isOwnArticle({ handle: '' }, ''), false);
});
