import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { communityReports, communityReportReview, communityReportReviewRequest } from './community-report-review.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (root, label) => [...root.querySelectorAll('button')].find(item => item.textContent === label);
const data = { communityId: 'c1', viewerId: 'manager', role: 'owner', report: { id: 'r1', reporterName: '<img src=x>Reporter', reason: 'harassment', createdAt: '2026-10-02T00:00:00.000Z', messageId: 'm1', channelId: 'ch1', messageEditedAt: null, status: 'open', messageBody: '<script>body</script>', messageAuthorName: '<img src=x>Author', messageAuthorId: 'author', resolvedAt: null, canResolve: true } };
const page = offset => ({ communityId: 'c1', viewerId: 'manager', role: 'owner', reports: [{ id: 'r' + offset, reporterName: 'Person ' + offset, reason: 'spam', createdAt: 'now', messageId: 'm1', channelId: 'ch1', messageBody: 'LIST MUST NOT SHOW THIS BODY' }], page: { offset, hasMore: offset === 0, nextOffset: offset === 0 ? 20 : null } });
const receipt = payload => ({ ok: true, report: { id: 'r1', status: payload.options.decision === 'dismissed' ? 'dismissed' : 'resolved' }, receipt: { auditId: payload.requestId, targetId: 'r1', action: 'resolve_report', confirmedAt: '2026-10-02T00:00:01.000Z', replayed: false } });
const draft = (dom, root, value = '内容を確認しました') => { const field = root.querySelector('textarea'); field.value = value; field.dispatchEvent(new dom.window.Event('input')); return field; };
const options = { communityId: 'c1', reportId: 'r1', data, onReload: async () => {} };

test('report queue retains its page on failures and mismatches, prevents duplicate reads, and opens a report without list bodies', async () => {
  const dom = new JSDOM(''), state = {}, calls = [], opened = []; let failure = 'offline', release;
  const root = communityReports(dom.window.document, { communityId: 'c1', data: page(0), state, onOpen: (...args) => opened.push(args), invoke: async (_, payload) => { calls.push(payload); if (failure === 'offline') { await new Promise(resolve => release = resolve); throw Error('offline'); } const next = page(20); if (failure === 'community') next.communityId = 'wrong'; if (failure === 'offset') next.page.offset = 40; if (failure === 'array') next.reports = null; if (failure === 'item') next.reports = [null]; if (failure === 'length') next.reports = Array(21).fill(page(0).reports[0]); if (failure === 'next') { next.page.hasMore = true; next.page.nextOffset = 20; } return next; } });
  assert.doesNotMatch(root.textContent, /LIST MUST/); button(root, '次の20件').click(); button(root, '次の20件').click(); assert.equal(calls.length, 1); release(); await tick(); assert.equal(state.offset, 0); assert.match(root.textContent, /offline/);
  for (failure of ['community', 'offset', 'array', 'item', 'length', 'next']) { button(root, '次の20件').click(); await tick(); assert.equal(state.offset, 0); assert.match(root.textContent, /Person 0/); assert.match(root.textContent, /確認できません/); }
  failure = ''; button(root, '次の20件').click(); await tick(); assert.equal(state.offset, 20); assert.deepEqual(calls.at(-1), { name: 'community_reports_page', ids: ['c1', '20'] }); button(root, 'Person 20の通報').click(); assert.deepEqual(opened, [['community_report', ['c1', 'r20'], 'Person 20の通報']]);
  assert.deepEqual(communityReportReviewRequest({ name: 'community_reports', ids: ['c1'], reportPage: state }), { name: 'community_reports_page', ids: ['c1', '20'] }); assert.equal(communityReportReviewRequest({ name: 'community_reports', ids: ['c1'], reportPage: { offset: 0 } }), null); assert.equal(communityReportReviewRequest({ name: 'community_report', ids: ['c1', 'r1'], reportPage: state }), null);
  const stale = communityReports(dom.window.document, { communityId: 'c1', data: page(0), state, invoke: async () => {}, onOpen: () => {} }); assert.equal(state.offset, 20); assert.match(stale.textContent, /確認できません/); dom.window.close();
});

test('report review is HTML safe, sends only after preview, and keeps input and ID on a lost response', async () => {
  const dom = new JSDOM(''), state = {}, calls = []; let release, fail = true;
  const reviewOptions = { ...options, state, invoke: async (_, payload) => { calls.push(payload); if (fail) { await new Promise(resolve => release = resolve); throw Error('lost response'); } return receipt(payload); } };
  let root = communityReportReview(dom.window.document, reviewOptions); assert.equal(root.querySelector('img'), null); assert.equal(root.querySelector('script'), null); assert.match(root.textContent, /投稿の削除やメンバーへの制限は別/);
  draft(dom, root); button(root, '問題なし').click(); assert.equal(calls.length, 0); assert.match(root.querySelector('[aria-label="通報判断の確認"]').textContent, /内容を確認しました/); button(root, '確認して実行').click(); button(root, '確認して実行').click(); assert.equal(calls.length, 1); release(); await tick(); assert.match(root.textContent, /lost response/); assert.equal(state.note, '内容を確認しました');
  root = communityReportReview(dom.window.document, reviewOptions); assert.equal(root.querySelector('textarea').value, '内容を確認しました'); fail = false; button(root, '問題なし').click(); button(root, '確認して実行').click(); await tick(); assert.equal(calls[0].requestId, calls[1].requestId); assert.deepEqual(calls[1].options, { reportId: 'r1', decision: 'dismissed', note: '内容を確認しました', expectedCreatedAt: data.report.createdAt, expectedMessageEditedAt: null }); assert.equal(state.saved.status, 'dismissed'); assert.equal(root.querySelector('textarea').value, ''); assert.equal(button(root, '問題なし').disabled, true); dom.window.close();
});

test('wrong report acknowledgements retain input and retry ID; changed notes and decisions require confirmation and a new ID', async () => {
  const dom = new JSDOM('');
  for (const field of ['auditId', 'targetId', 'action', 'reportId', 'status', 'ok']) {
    const state = {}, calls = [], root = communityReportReview(dom.window.document, { ...options, state, invoke: async (_, payload) => { calls.push(payload); const result = receipt(payload); if (field === 'reportId') result.report.id = 'wrong'; else if (field === 'status') result.report.status = 'open'; else if (field === 'ok') result.ok = false; else result.receipt[field] = 'wrong'; return result; } });
    const fieldNode = draft(dom, root); button(root, '対応済み').click(); button(root, '確認して実行').click(); await tick(); assert.match(root.textContent, /保存結果を確認できません/); assert.equal(fieldNode.value, '内容を確認しました'); button(root, '確認して実行').click(); await tick(); assert.equal(calls[0].requestId, calls[1].requestId);
    draft(dom, root, '別の理由を確認しました'); button(root, '確認して実行').click(); await tick(); assert.equal(calls.length, 2); button(root, '対応済み').click(); button(root, '確認して実行').click(); await tick(); assert.notEqual(calls[1].requestId, calls[2].requestId);
    button(root, '問題なし').click(); button(root, '確認して実行').click(); await tick(); assert.notEqual(calls[2].requestId, calls[3].requestId);
  }
  dom.window.close();
});

test('normalized UTF-16 limits enforce both bounds and submit the confirmed normalized note', async () => {
  const dom = new JSDOM(''), calls = [], root = communityReportReview(dom.window.document, { ...options, invoke: async (_, payload) => { calls.push(payload); throw Error('unknown result'); } });
  for (const note of ['😀😀', '😀'.repeat(501), '㍿'.repeat(251)]) { draft(dom, root, note); button(root, '問題なし').click(); assert.match(root.textContent, /5〜1000/); assert.equal(root.querySelector('[aria-label="通報判断の確認"]').hidden, true); }
  assert.equal(calls.length, 0); draft(dom, root, '😀'.repeat(500)); button(root, '対応済み').click(); button(root, '確認して実行').click(); await tick(); assert.equal(calls[0].options.note.length, 1000);
  draft(dom, root, '  ＡＢＣＤＥ  '); button(root, '問題なし').click(); button(root, '確認して実行').click(); await tick(); assert.equal(calls[1].options.note, 'ABCDE'); assert.notEqual(calls[0].requestId, calls[1].requestId);
  const field = root.querySelector('textarea'); field.value = '別の未確認理由'; button(root, '確認して実行').click(); await tick(); assert.equal(calls.length, 2); assert.match(root.textContent, /もう一度確認/); dom.window.close();
});

test('self, nonopen, unprivileged, and disallowed reports remain read-only with an explanation', () => {
  const dom = new JSDOM('');
  for (const change of [{ viewerId: 'author' }, { role: 'member' }, { role: 'invalid' }, { report: { ...data.report, status: 'resolved' } }, { report: { ...data.report, status: 'dismissed' } }, { report: { ...data.report, canResolve: false } }]) {
    const root = communityReportReview(dom.window.document, { ...options, data: { ...data, ...change }, invoke: async () => assert.fail('no write') }); assert.equal(button(root, '問題なし'), undefined); assert.equal(button(root, '対応済み'), undefined); assert.equal(root.querySelector('textarea'), null); assert.match(root.textContent, /判断できません|権限|判断済み/);
  }
  for (const change of [{ communityId: 'wrong' }, { report: { ...data.report, id: 'wrong' } }]) { const root = communityReportReview(dom.window.document, { ...options, data: { ...data, ...change }, invoke: async () => assert.fail('no write') }); assert.match(root.textContent, /確認できません/); assert.equal(root.querySelector('textarea'), null); }
  const empty = communityReportReview(dom.window.document, { ...options, data: { ...data, report: { ...data.report, messageBody: null, messageAuthorName: null } }, invoke: async () => {} }); assert.equal(empty.querySelector('script'), null); dom.window.close();
});

test('saved review persists across stale rerender and reload failure; retries read without another operation', async () => {
  const dom = new JSDOM(''), state = {}, calls = []; let failRead = true, reloads = 0, current;
  const reviewOptions = { ...options, state, invoke: async (_, payload) => { calls.push(payload); return { ...receipt(payload), notificationPending: true }; }, onReload: async () => { reloads++; if (failRead) throw Error('offline'); current = communityReportReview(dom.window.document, reviewOptions); } };
  let root = communityReportReview(dom.window.document, reviewOptions); draft(dom, root); button(root, '対応済み').click(); const submit = button(root, '確認して実行'); submit.click(); await tick(); assert.equal(reloads, 1); assert.match(root.textContent, /判断は保存済み/); assert.match(root.textContent, /offline/); assert.match(root.textContent, /通知は未完了/); assert.equal(button(root, '状態を再読込').disabled, false); await submit.onclick(); assert.equal(calls.length, 1);
  root = communityReportReview(dom.window.document, reviewOptions); assert.match(root.textContent, /対応済み/); assert.match(root.textContent, /判断は保存済み/); assert.equal(button(root, '対応済み'), undefined); assert.equal(button(root, '状態を再読込').disabled, false);
  failRead = false; button(root, '状態を再読込').click(); await tick(); assert.equal(reloads, 2); assert.equal(calls.length, 1); assert.equal(button(current, '状態を再読込').disabled, false); assert.equal(button(current, '問題なし'), undefined); assert.match(current.textContent, /通知は未完了/); dom.window.close();
});

test('rerender during an in-flight review remains locked and recovers the current view on a lost response', async () => {
  const dom = new JSDOM(''), state = {}; let release, calls = 0;
  const reviewOptions = { ...options, state, invoke: async () => { calls++; await new Promise(resolve => release = resolve); throw Error('lost response'); } };
  const old = communityReportReview(dom.window.document, reviewOptions); draft(dom, old); button(old, '問題なし').click(); button(old, '確認して実行').click(); const current = communityReportReview(dom.window.document, reviewOptions); assert.equal(button(current, '問題なし').disabled, true); button(current, '問題なし').click(); assert.equal(calls, 1); release(); await tick(); assert.equal(button(current, '問題なし').disabled, false); assert.match(current.textContent, /lost response/); dom.window.close();
});


test('report review binds confirmation to the message edit timestamp and refuses missing or invalid timestamps', async () => {
  const dom = new JSDOM(''), calls = [], report = { ...data.report, messageEditedAt: '2026-10-02T00:00:02.000Z' };
  const root = communityReportReview(dom.window.document, { ...options, data: { ...data, report }, invoke: async (_, payload) => { calls.push(payload); throw Error('lost response'); } });
  draft(dom, root); button(root, '問題なし').click(); button(root, '確認して実行').click(); await tick();
  assert.equal(calls[0].options.expectedMessageEditedAt, '2026-10-02T00:00:02.000Z');
  report.messageEditedAt = '2026-10-02T00:00:03.000Z'; button(root, '確認して実行').click(); await tick(); assert.equal(calls.length, 1); assert.match(root.textContent, /もう一度確認/);
  button(root, '問題なし').click(); button(root, '確認して実行').click(); await tick(); assert.equal(calls[1].options.expectedMessageEditedAt, report.messageEditedAt); assert.notEqual(calls[0].requestId, calls[1].requestId);
  for (const value of [undefined, '', 'not-a-date', 123]) {
    const invalid = communityReportReview(dom.window.document, { ...options, data: { ...data, report: { ...data.report, messageEditedAt: value } }, invoke: async () => assert.fail('no write') });
    assert.equal(invalid.querySelector('textarea'), null); assert.equal(button(invalid, '問題なし'), undefined); assert.match(invalid.textContent, /更新日時を確認できません/);
  }
  dom.window.close();
});


test('saved notification repair reuses the exact acknowledged payload and ID across failures and rerenders without reopening review', async () => {
  const dom = new JSDOM(''), state = {}, calls = []; let repairMode = 'offline', release;
  const reviewOptions = { ...options, state, invoke: async (_, payload) => {
    calls.push(structuredClone(payload));
    if (calls.length === 1) return { ...receipt(payload), notificationPending: true };
    if (repairMode === 'offline') { await new Promise(resolve => release = resolve); throw Error('offline'); }
    const result = { ...receipt(payload), notificationPending: false };
    if (repairMode === 'wrong') result.receipt.targetId = 'wrong';
    return result;
  } };
  let root = communityReportReview(dom.window.document, reviewOptions); assert.equal(button(root, '通知を再試行'), undefined); draft(dom, root, 'ＡＢＣＤＥを確認しました'); button(root, '対応済み').click(); button(root, '確認して実行').click(); await tick();
  assert.match(root.textContent, /判断は保存済み/); assert.match(root.textContent, /通知は未完了/); assert.equal(button(root, '対応済み').disabled, true); const retry = button(root, '通知を再試行'); retry.click(); retry.click(); assert.equal(calls.length, 2);
  root = communityReportReview(dom.window.document, reviewOptions); assert.equal(button(root, '通知を再試行').disabled, true); assert.equal(button(root, '対応済み'), undefined); release(); await tick(); assert.match(root.textContent, /判断は保存済み/); assert.match(root.textContent, /offline/); assert.equal(button(root, '通知を再試行').disabled, false); assert.deepEqual(calls[0], calls[1]);
  repairMode = 'wrong'; button(root, '通知を再試行').click(); await tick(); assert.match(root.textContent, /判断は保存済み/); assert.match(root.textContent, /再試行結果を確認できません/); assert.equal(state.notificationPending, true); assert.deepEqual(calls[0], calls[2]);
  repairMode = 'done'; root = communityReportReview(dom.window.document, reviewOptions); button(root, '通知を再試行').click(); await tick(); assert.deepEqual(calls[0], calls[3]); assert.equal(state.notificationPending, false); assert.equal(button(root, '通知を再試行'), undefined); assert.equal(button(root, '問題なし'), undefined); assert.match(root.textContent, /対応済み/); assert.doesNotMatch(root.textContent, /通知は未完了/);
  root = communityReportReview(dom.window.document, reviewOptions); assert.equal(button(root, '対応済み'), undefined); assert.equal(button(root, '通知を再試行'), undefined); assert.equal(calls.length, 4); dom.window.close();
});
