import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { communityAppeals, communityAppealReview, communityAppealReviewRequest } from './community-appeal-review.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (root, label) => [...root.querySelectorAll('button')].find(item => item.textContent === label);
const data = { communityId: 'c1', viewerId: 'manager', role: 'owner', appeal: { id: 'a1', profileId: 'p1', displayName: '<img src=x>Applicant', reason: '<script>Appeal reason</script>', status: 'pending', createdAt: '2026-10-02T00:00:00.000Z', resolvedAt: null, resolutionNote: null, memberActionId: 'audit1', canResolve: true, canUnmute: true, sanctionKey: 'a'.repeat(64), membershipStatus: 'muted', restrictionReason: null } };
const options = { communityId: 'c1', appealId: 'a1', data, onReload: async () => {} };
const page = offset => ({ communityId: 'c1', viewerId: 'manager', role: 'owner', appeals: [{ id: 'a' + offset, displayName: 'Person ' + offset, createdAt: 'now', reason: 'LIST MUST NOT SHOW THIS BODY' }], page: { offset, hasMore: offset === 0, nextOffset: offset === 0 ? 20 : null } });
const receipt = (payload, canUnmute = true) => ({ ok: true, appeal: { id: 'a1', status: payload.options.decision }, receipt: { auditId: payload.requestId, action: 'resolve_appeal', targetId: 'a1', confirmedAt: '2026-10-02T00:00:01.000Z', replayed: false, membershipEffect: payload.options.decision === 'accepted' && canUnmute ? 'unmuted' : 'unchanged' } });
const draft = (dom, root, value = '申立ての内容を確認しました') => { const field = root.querySelector('textarea'); field.value = value; field.dispatchEvent(new dom.window.Event('input')); return field; };

test('appeal queue retains its page on failure and mismatches, suppresses duplicate reads, and opens only the chosen detail', async () => {
  const dom = new JSDOM(''), state = {}, calls = [], opened = []; let mode = 'offline', release;
  const root = communityAppeals(dom.window.document, { communityId: 'c1', data: page(0), state, onOpen: (...args) => opened.push(args), invoke: async (_, payload) => {
    calls.push(payload); if (mode === 'offline') { await new Promise(resolve => release = resolve); throw Error('offline'); } const result = page(20);
    if (mode === 'community') result.communityId = 'wrong'; if (mode === 'offset') result.page.offset = 40; if (mode === 'array') result.appeals = null; if (mode === 'item') result.appeals = [null]; if (mode === 'length') result.appeals = Array(21).fill(page(0).appeals[0]); if (mode === 'next') { result.page.hasMore = true; result.page.nextOffset = 20; } return result;
  } });
  assert.doesNotMatch(root.textContent, /LIST MUST/); button(root, '次の20件').click(); button(root, '次の20件').click(); assert.equal(calls.length, 1); release(); await tick(); assert.equal(state.offset, 0); assert.match(root.textContent, /offline/);
  const recreated = communityAppeals(dom.window.document, { communityId: 'c1', data: page(0), state, invoke: async () => {}, onOpen: () => {} }); assert.match(recreated.textContent, /offline/); assert.equal(state.offset, 0);
  for (mode of ['community', 'offset', 'array', 'item', 'length', 'next']) { button(root, '次の20件').click(); await tick(); assert.equal(state.offset, 0); assert.match(root.textContent, /Person 0/); assert.match(root.textContent, /確認できません/); }
  mode = ''; button(root, '次の20件').click(); await tick(); assert.equal(state.offset, 20); assert.deepEqual(calls.at(-1), { name: 'community_appeals_page', ids: ['c1', '20'] }); button(root, 'Person 20の異議申立て').click(); assert.deepEqual(opened, [['community_appeal', ['c1', 'a20'], 'Person 20の異議申立て']]);
  assert.deepEqual(communityAppealReviewRequest({ name: 'community_appeals', ids: ['c1'], appealPage: state }), { name: 'community_appeals_page', ids: ['c1', '20'] }); assert.equal(communityAppealReviewRequest({ name: 'community_appeals', ids: ['c1'], appealPage: { offset: 0 } }), null); assert.equal(communityAppealReviewRequest({ name: 'community_appeal', ids: ['c1', 'a1'], appealPage: state }), null);
  const stale = communityAppeals(dom.window.document, { communityId: 'c1', data: page(0), state, invoke: async () => {}, onOpen: () => {} }); assert.equal(state.offset, 20); assert.match(stale.textContent, /確認できません/);
  const empty = communityAppeals(dom.window.document, { communityId: 'c1', data: { ...page(0), appeals: [] }, invoke: async () => {}, onOpen: () => {} }); assert.match(empty.textContent, /審査待ちの異議申立てはありません/); dom.window.close();
});

test('appeal review is HTML safe and requires impact preview, preserving exact options and ID after a lost response', async () => {
  const dom = new JSDOM(''), state = {}, calls = []; let fail = true, release;
  const reviewOptions = { ...options, state, invoke: async (_, payload) => { calls.push(structuredClone(payload)); if (fail) { await new Promise(resolve => release = resolve); throw Error('lost response'); } return receipt(payload); } };
  let root = communityAppealReview(dom.window.document, reviewOptions); assert.equal(root.querySelector('img'), null); assert.equal(root.querySelector('script'), null); assert.match(root.textContent, /受理は異議申立ての審査結果/);
  draft(dom, root, '  ＡＢＣＤＥを確認しました  '); button(root, '受理').click(); assert.equal(calls.length, 0); const preview = root.querySelector('[aria-label="異議申立て判断の確認"]'); assert.match(preview.textContent, /Applicant/); assert.match(preview.textContent, /Appeal reason/); assert.match(preview.textContent, /ABCDEを確認しました/); assert.match(preview.textContent, /現在の投稿ミュートを解除/);
  button(root, '確認して実行').click(); button(root, '確認して実行').click(); assert.equal(calls.length, 1); release(); await tick(); assert.match(root.textContent, /lost response/); assert.equal(state.note, '  ＡＢＣＤＥを確認しました  ');
  root = communityAppealReview(dom.window.document, reviewOptions); assert.equal(root.querySelector('textarea').value, state.note); fail = false; button(root, '受理').click(); button(root, '確認して実行').click(); await tick(); assert.deepEqual(calls[0], calls[1]); assert.deepEqual(calls[1].options, { appealId: 'a1', decision: 'accepted', note: 'ABCDEを確認しました', expectedCreatedAt: data.appeal.createdAt, expectedSanctionKey: data.appeal.sanctionKey }); assert.equal(state.saved.status, 'accepted'); assert.match(root.textContent, /投稿ミュートを解除しました/); assert.equal(button(root, '受理').disabled, true); dom.window.close();
});

test('appeal acknowledgement must match request, target, action, status, and expected membership effect', async () => {
  const dom = new JSDOM('');
  for (const field of ['auditId', 'targetId', 'action', 'appealId', 'status', 'ok', 'membershipEffect']) {
    const state = {}, calls = [], root = communityAppealReview(dom.window.document, { ...options, state, invoke: async (_, payload) => {
      calls.push(payload); const result = receipt(payload); if (field === 'appealId') result.appeal.id = 'wrong'; else if (field === 'status') result.appeal.status = 'rejected'; else if (field === 'ok') result.ok = false; else if (field === 'membershipEffect') result.receipt.membershipEffect = 'unchanged'; else result.receipt[field] = 'wrong'; return result;
    } });
    const reason = draft(dom, root); button(root, '受理').click(); button(root, '確認して実行').click(); await tick(); assert.match(root.textContent, /保存結果を確認できません/); assert.equal(reason.value, '申立ての内容を確認しました'); assert.doesNotMatch(root.textContent, /投稿ミュートを解除しました/); button(root, '確認して実行').click(); await tick(); assert.equal(calls[0].requestId, calls[1].requestId); assert.equal(state.saved, undefined);
    draft(dom, root, '新しい判断理由を確認しました'); button(root, '確認して実行').click(); await tick(); assert.equal(calls.length, 2); button(root, '受理').click(); button(root, '確認して実行').click(); await tick(); assert.notEqual(calls[1].requestId, calls[2].requestId);
    button(root, '却下').click(); button(root, '確認して実行').click(); await tick(); assert.notEqual(calls[2].requestId, calls[3].requestId); assert.equal(calls[3].options.decision, 'rejected');
  }
  dom.window.close();
});

test('acceptance without unmute and all rejection preserve membership and show restrictions without claiming reinstatement', async () => {
  const dom = new JSDOM('');
  for (const [canUnmute, decision] of [[false, 'accepted'], [false, 'rejected'], [true, 'rejected']]) {
    const state = {}, altered = { ...data, appeal: { ...data.appeal, canUnmute, membershipStatus: canUnmute ? 'muted' : 'banned', restrictionReason: '現在の参加禁止は別の制限です。' } };
    const root = communityAppealReview(dom.window.document, { ...options, data: altered, state, invoke: async (_, payload) => receipt(payload, canUnmute) }); draft(dom, root); button(root, decision === 'accepted' ? '受理' : '却下').click(); const preview = root.querySelector('[aria-label="異議申立て判断の確認"]'); assert.match(preview.textContent, /参加状態は変更しません/); assert.match(preview.textContent, /別の制限/);
    button(root, '確認して実行').click(); await tick(); assert.equal(state.saved.membershipEffect, 'unchanged'); assert.doesNotMatch(root.textContent, /投稿ミュートを解除しました|参加禁止を解除/); if (!canUnmute) assert.match(root.textContent, /参加禁止中/);
  }
  dom.window.close();
});

test('normalized UTF-16 reason limits enforce both boundaries and edits invalidate the previous preview', async () => {
  const dom = new JSDOM(''), calls = [], root = communityAppealReview(dom.window.document, { ...options, invoke: async (_, payload) => { calls.push(payload); throw Error('unknown result'); } });
  for (const note of ['😀😀', '😀'.repeat(501), '㍿'.repeat(251)]) { draft(dom, root, note); button(root, '受理').click(); assert.match(root.textContent, /5〜1000/); assert.equal(root.querySelector('[aria-label="異議申立て判断の確認"]').hidden, true); }
  assert.equal(calls.length, 0); draft(dom, root, '😀'.repeat(500)); button(root, '受理').click(); button(root, '確認して実行').click(); await tick(); assert.equal(calls[0].options.note.length, 1000);
  const reason = root.querySelector('textarea'); reason.value = '変更した未確認の理由'; button(root, '確認して実行').click(); await tick(); assert.equal(calls.length, 1); assert.match(root.textContent, /もう一度確認/); dom.window.close();
});

test('self, closed, unprivileged, malformed, and unavailable appeals remain read-only with an explanation', () => {
  const dom = new JSDOM('');
  for (const change of [{ viewerId: 'p1' }, { role: 'member' }, { role: 'invalid' }, { appeal: { ...data.appeal, status: 'accepted' } }, { appeal: { ...data.appeal, status: 'rejected' } }, { appeal: { ...data.appeal, status: 'withdrawn' } }, { appeal: { ...data.appeal, canResolve: false } }, { appeal: { ...data.appeal, profileId: undefined } }]) {
    const root = communityAppealReview(dom.window.document, { ...options, data: { ...data, ...change }, invoke: async () => assert.fail('no write') }); assert.equal(button(root, '受理'), undefined); assert.equal(button(root, '却下'), undefined); assert.equal(root.querySelector('textarea'), null); assert.match(root.textContent, /判断できません|権限|審査待ちではありません|確認できません/);
  }
  for (const sanctionKey of [undefined, null, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    const root = communityAppealReview(dom.window.document, { ...options, data: { ...data, appeal: { ...data.appeal, sanctionKey } }, invoke: async () => assert.fail('no write') }); assert.equal(root.querySelector('textarea'), null); assert.match(root.textContent, /制限の状態を確認できません/);
  }
  for (const changes of [{ communityId: 'wrong' }, { appeal: { ...data.appeal, id: 'wrong' } }]) { const root = communityAppealReview(dom.window.document, { ...options, data: { ...data, ...changes }, invoke: async () => assert.fail('no write') }); assert.match(root.textContent, /確認できません/); assert.equal(root.querySelector('textarea'), null); }
  for (const appeal of [{ ...data.appeal, canUnmute: undefined }, { ...data.appeal, createdAt: 'invalid' }]) { const root = communityAppealReview(dom.window.document, { ...options, data: { ...data, appeal }, invoke: async () => assert.fail('no write') }); assert.equal(root.querySelector('textarea'), null); assert.match(root.textContent, /確認できません/); }
  dom.window.close();
});

test('changed sanction, creation time, or unmute effect requires new confirmation and a fresh request ID', async () => {
  const dom = new JSDOM(''), calls = [], appeal = { ...data.appeal };
  const root = communityAppealReview(dom.window.document, { ...options, data: { ...data, appeal }, invoke: async (_, payload) => { calls.push(payload); throw Error('lost response'); } }); draft(dom, root); button(root, '受理').click(); button(root, '確認して実行').click(); await tick();
  for (const change of [{ sanctionKey: 'b'.repeat(64) }, { createdAt: '2026-10-02T00:00:02.000Z' }, { canUnmute: false }]) {
    Object.assign(appeal, change); const before = calls.length; button(root, '確認して実行').click(); await tick(); assert.equal(calls.length, before); assert.match(root.textContent, /もう一度確認/); button(root, '受理').click(); button(root, '確認して実行').click(); await tick(); assert.notEqual(calls[before - 1].requestId, calls[before].requestId); assert.equal(calls[before].options.expectedSanctionKey, appeal.sanctionKey); assert.equal(calls[before].options.expectedCreatedAt, appeal.createdAt);
  }
  dom.window.close();
});

test('saved appeal rerender remains locked after reload failure, and read retry does not repeat the judgment', async () => {
  const dom = new JSDOM(''), state = {}, calls = []; let failRead = true, reloads = 0, current;
  const reviewOptions = { ...options, state, invoke: async (_, payload) => { calls.push(payload); return receipt(payload); }, onReload: async () => { reloads++; if (failRead) throw Error('offline'); current = communityAppealReview(dom.window.document, reviewOptions); } };
  let root = communityAppealReview(dom.window.document, reviewOptions); draft(dom, root); button(root, '受理').click(); const submit = button(root, '確認して実行'); submit.click(); await tick(); assert.equal(reloads, 1); assert.match(root.textContent, /判断は保存済み/); assert.match(root.textContent, /offline/); assert.equal(button(root, '状態を再読込').disabled, false); await submit.onclick(); assert.equal(calls.length, 1);
  root = communityAppealReview(dom.window.document, reviewOptions); assert.match(root.textContent, /受理済み/); assert.match(root.textContent, /投稿ミュートを解除しました/); assert.equal(button(root, '受理'), undefined); assert.equal(button(root, '状態を再読込').disabled, false);
  failRead = false; button(root, '状態を再読込').click(); await tick(); assert.equal(reloads, 2); assert.equal(calls.length, 1); assert.equal(button(current, '状態を再読込').disabled, false); assert.equal(button(current, '受理'), undefined); dom.window.close();
});

test('rerender during pending appeal save blocks duplicates and recovers the visible view on failure', async () => {
  const dom = new JSDOM(''), state = {}; let release, calls = 0;
  const reviewOptions = { ...options, state, invoke: async () => { calls++; await new Promise(resolve => release = resolve); throw Error('lost response'); } };
  const old = communityAppealReview(dom.window.document, reviewOptions); draft(dom, old); button(old, '受理').click(); button(old, '確認して実行').click(); const current = communityAppealReview(dom.window.document, reviewOptions); assert.equal(button(current, '受理').disabled, true); button(current, '受理').click(); assert.equal(calls, 1); release(); await tick(); assert.equal(button(current, '受理').disabled, false); assert.match(current.textContent, /lost response/); dom.window.close();
});
