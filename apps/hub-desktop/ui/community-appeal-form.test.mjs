import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { communityAppealForm } from './community-appeal-form.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (root, label) => [...root.querySelectorAll('button')].find(item => item.textContent === label);
const data = { communityId: 'c1', appeals: [{ id: 'old1', reason: '<script>My past reason</script>', status: 'rejected', createdAt: '2026-09-30T00:00:00.000Z', resolvedAt: '2026-10-01T00:00:00.000Z', resolutionNote: '<img src=x>My resolution', profileId: 'DO NOT DISPLAY PROFILE ID' }], submission: { sanction: { kind: 'audit', id: 'opaque1', createdAt: '2026-10-02T00:00:00.000Z' }, sanctionKey: 'a'.repeat(64) } };
const options = { communityId: 'c1', data, onReload: async () => {} };
const receipt = payload => ({ appeal: { id: 'a1', status: 'pending', createdAt: '2026-10-02T00:00:01.000Z' }, receipt: { auditId: payload.requestId, action: 'appeal_submitted', targetId: 'a1', confirmedAt: '2026-10-02T00:00:01.000Z', replayed: false } });
const draft = (dom, root, value = '今回の処分に関する事実をもう一度確認してください。') => { const field = root.querySelector('textarea'); field.value = value; field.dispatchEvent(new dom.window.Event('input')); return field; };

test('own appeal history is HTML safe and submission requires a timestamp and reason preview before sending', async () => {
  const dom = new JSDOM(''), calls = [], root = communityAppealForm(dom.window.document, { ...options, invoke: async (_, payload) => { calls.push(payload); return receipt(payload); } });
  assert.equal(root.querySelector('script'), null); assert.equal(root.querySelector('img'), null); assert.match(root.textContent, /My past reason/); assert.match(root.textContent, /My resolution/); assert.doesNotMatch(root.textContent, /DO NOT DISPLAY PROFILE ID|opaque1|audit/);
  draft(dom, root, '  ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴ  '); button(root, '申立てを確認').click(); assert.equal(calls.length, 0); const preview = root.querySelector('[aria-label="異議申立ての確認"]'); assert.match(preview.textContent, /2026-10-02T00:00:00/); assert.match(preview.textContent, /ABCDEFGHIJKLMNOPQRST/); assert.match(preview.textContent, /運営が対象の一致/);
  button(root, '確認して送信').click(); await tick(); assert.deepEqual(calls[0].options, { reason: 'ABCDEFGHIJKLMNOPQRST', expectedSanctionKey: data.submission.sanctionKey }); assert.equal(calls[0].action, 'community_appeal_submit'); assert.equal(calls[0].target, 'c1'); assert.match(root.textContent, /申立ては保存済み/); assert.match(root.querySelector('[aria-label="自分の異議申立て履歴"]').textContent, /審査待ち/); assert.equal(button(root, '申立てを確認').disabled, true); dom.window.close();
});

test('pending appeals, absent targets, and malformed sanctions disable additions with an explanation', () => {
  const dom = new JSDOM('');
  for (const changed of [{ ...data, appeals: [{ ...data.appeals[0], status: 'pending' }] }, { ...data, submission: { ...data.submission, sanction: null } }, { ...data, submission: { ...data.submission, sanction: { ...data.submission.sanction, kind: 'warning' } } }, { ...data, submission: { ...data.submission, sanction: { ...data.submission.sanction, createdAt: 'bad' } } }]) {
    const root = communityAppealForm(dom.window.document, { ...options, data: changed, invoke: async () => assert.fail('no write') }); assert.equal(button(root, '申立てを確認').disabled, true); assert.equal(root.querySelector('textarea').disabled, true); assert.match(root.textContent, /審査待ちの異議申立てがあります|対象がありません|処分を確認できません/);
  }
  for (const sanctionKey of [null, 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) { const root = communityAppealForm(dom.window.document, { ...options, data: { ...data, submission: { ...data.submission, sanctionKey } }, invoke: async () => assert.fail('no write') }); assert.equal(button(root, '申立てを確認').disabled, true); assert.match(root.textContent, /処分を確認できません/); }
  const legacy = communityAppealForm(dom.window.document, { ...options, data: { ...data, submission: { ...data.submission, sanction: { ...data.submission.sanction, kind: 'legacy' } } }, invoke: async () => {} }); assert.equal(button(legacy, '申立てを確認').disabled, false);
  for (const changed of [{ ...data, communityId: 'wrong' }, { ...data, appeals: [null] }, { ...data, submission: undefined }]) { const root = communityAppealForm(dom.window.document, { ...options, data: changed, invoke: async () => assert.fail('no write') }); assert.match(root.textContent, /異議申立てを確認できません/); assert.equal(root.querySelector('textarea'), null); } dom.window.close();
});

test('lost submission responses retain the draft and exact request ID across rerenders and unchanged retries', async () => {
  const dom = new JSDOM(''), state = {}, calls = []; let fail = true, release;
  const formOptions = { ...options, state, invoke: async (_, payload) => { calls.push(structuredClone(payload)); if (fail) { await new Promise(resolve => release = resolve); throw Error('lost response'); } return receipt(payload); } };
  let root = communityAppealForm(dom.window.document, formOptions); const reason = draft(dom, root); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); button(root, '確認して送信').click(); assert.equal(calls.length, 1); release(); await tick(); assert.match(root.textContent, /lost response/); assert.equal(state.note, reason.value);
  root = communityAppealForm(dom.window.document, formOptions); assert.equal(root.querySelector('textarea').value, state.note); fail = false; button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick(); assert.deepEqual(calls[0], calls[1]); assert.equal(state.saved.appeal.id, 'a1'); assert.equal(root.querySelector('textarea').value, ''); dom.window.close();
});

test('mismatched submission receipts retain the input and ID, while edits require a new preview and ID', async () => {
  const dom = new JSDOM('');
  for (const field of ['auditId', 'action', 'targetId', 'id', 'status', 'createdAt']) {
    const state = {}, calls = [], root = communityAppealForm(dom.window.document, { ...options, state, invoke: async (_, payload) => { calls.push(payload); const result = receipt(payload); if (['id', 'status', 'createdAt'].includes(field)) result.appeal[field] = field === 'id' ? '' : 'wrong'; else result.receipt[field] = 'wrong'; return result; } });
    const reason = draft(dom, root); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick(); assert.match(root.textContent, /保存結果を確認できません/); assert.equal(state.saved, undefined); assert.equal(reason.value, state.note); button(root, '確認して送信').click(); await tick(); assert.equal(calls[0].requestId, calls[1].requestId);
    draft(dom, root, '申立て理由を変更したので改めて内容を確認してください。'); button(root, '確認して送信').click(); await tick(); assert.equal(calls.length, 2); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick(); assert.notEqual(calls[1].requestId, calls[2].requestId);
  }
  dom.window.close();
});

test('submission enforces a normalized codepoint minimum and UTF-16 maximum and refuses unconfirmed direct input changes', async () => {
  const dom = new JSDOM(''), calls = [], root = communityAppealForm(dom.window.document, { ...options, invoke: async (_, payload) => { calls.push(payload); throw Error('unknown result'); } });
  for (const note of ['A'.repeat(19), '😀'.repeat(9), '😀'.repeat(10), '😀'.repeat(501), '㍿'.repeat(251)]) { draft(dom, root, note); button(root, '申立てを確認').click(); assert.match(root.textContent, /20〜1000/); assert.equal(root.querySelector('[aria-label="異議申立ての確認"]').hidden, true); }
  assert.equal(calls.length, 0); draft(dom, root, '😀'.repeat(500)); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick(); assert.equal(calls[0].options.reason.length, 1000);
  draft(dom, root, 'Ａ'.repeat(20)); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick(); assert.equal(calls[1].options.reason, 'A'.repeat(20)); assert.notEqual(calls[0].requestId, calls[1].requestId);
  draft(dom, root, '😀'.repeat(20)); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick(); assert.equal(Array.from(calls[2].options.reason).length, 20); assert.equal(calls[2].options.reason.length, 40);
  root.querySelector('textarea').value = '直接変更した未確認の理由です。対象をもう一度確認してください。'; button(root, '確認して送信').click(); await tick(); assert.equal(calls.length, 3); assert.match(root.textContent, /もう一度確認/); dom.window.close();
});

test('changed target records and sanction keys require a new confirmation and UUID', async () => {
  const dom = new JSDOM(''), calls = [], submission = structuredClone(data.submission), root = communityAppealForm(dom.window.document, { ...options, data: { ...data, submission }, invoke: async (_, payload) => { calls.push(payload); throw Error('lost response'); } });
  draft(dom, root); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick();
  for (const change of [() => { submission.sanctionKey = 'b'.repeat(64); }, () => { submission.sanction.createdAt = '2026-10-02T00:00:03.000Z'; }, () => { submission.sanction.id = 'opaque2'; }]) {
    change(); const before = calls.length; button(root, '確認して送信').click(); await tick(); assert.equal(calls.length, before); assert.match(root.textContent, /もう一度確認/); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick(); assert.notEqual(calls[before - 1].requestId, calls[before].requestId); assert.equal(calls[before].options.expectedSanctionKey, submission.sanctionKey);
  }
  dom.window.close();
});

test('known-saved submissions retain local pending history after read failure and rerender; read retry never resubmits', async () => {
  const dom = new JSDOM(''), state = {}, calls = []; let failRead = true, reloads = 0, current;
  const formOptions = { ...options, state, invoke: async (_, payload) => { calls.push(payload); return receipt(payload); }, onReload: async () => { reloads++; if (failRead) throw Error('offline'); current = communityAppealForm(dom.window.document, formOptions); } };
  let root = communityAppealForm(dom.window.document, formOptions); draft(dom, root); button(root, '申立てを確認').click(); const submit = button(root, '確認して送信'); submit.click(); await tick(); assert.equal(reloads, 1); assert.match(root.textContent, /申立ては保存済み/); assert.match(root.textContent, /offline/); assert.match(root.querySelector('[aria-label="自分の異議申立て履歴"]').textContent, /審査待ち/); assert.equal(button(root, '申立てを確認').disabled, true); await submit.onclick(); assert.equal(calls.length, 1);
  root = communityAppealForm(dom.window.document, formOptions); assert.match(root.textContent, /申立ては保存済み/); assert.equal(button(root, '申立てを確認').disabled, true); assert.equal(button(root, '状態を再読込').disabled, false);
  failRead = false; button(root, '状態を再読込').click(); await tick(); assert.equal(reloads, 2); assert.equal(calls.length, 1); assert.equal(button(current, '状態を再読込').disabled, false); assert.equal(button(current, '申立てを確認').disabled, true); dom.window.close();
});

test('an in-flight submission remains locked through rerender and unlocks only after failure', async () => {
  const dom = new JSDOM(''), state = {}; let release, calls = 0;
  const formOptions = { ...options, state, invoke: async () => { calls++; await new Promise(resolve => release = resolve); throw Error('lost response'); } };
  const old = communityAppealForm(dom.window.document, formOptions); draft(dom, old); button(old, '申立てを確認').click(); button(old, '確認して送信').click(); const current = communityAppealForm(dom.window.document, formOptions); assert.equal(button(current, '申立てを確認').disabled, true); button(current, '申立てを確認').click(); assert.equal(calls, 1); release(); await tick(); assert.equal(button(current, '申立てを確認').disabled, false); assert.match(current.textContent, /lost response/); dom.window.close();
});


test('only a resolved saved appeal and a distinct current restriction unlock a new appeal; old snapshots cannot unlock its saved successor', async () => {
  const dom = new JSDOM(''), state = {}, calls = []; let current, latest = structuredClone(data);
  const formOptions = { ...options, state, invoke: async (_, payload) => {
    calls.push(structuredClone(payload)); const result = receipt(payload), id = 'a' + calls.length; result.appeal.id = id; result.receipt.targetId = id; return result;
  }, onReload: async () => { current = communityAppealForm(dom.window.document, { ...formOptions, data: latest }); } };
  let root = communityAppealForm(dom.window.document, formOptions); draft(dom, root); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick(); assert.equal(state.saved.appeal.id, 'a1'); assert.equal(button(current, '申立てを確認').disabled, true);
  const first = { id: 'a1', reason: calls[0].options.reason, status: 'pending', createdAt: '2026-10-02T00:00:01.000Z', resolvedAt: null, resolutionNote: null };
  const newSubmission = { sanction: { kind: 'audit', id: 'opaque2', createdAt: '2026-10-03T00:00:00.000Z' }, sanctionKey: 'b'.repeat(64) };
  for (const next of [{ ...data, appeals: [] }, { ...data, appeals: [first], submission: newSubmission }, { ...data, appeals: [{ ...first, status: 'accepted' }] }, { ...data, appeals: [{ ...first, status: 'accepted' }], submission: { ...data.submission, sanctionKey: 'b'.repeat(64) } }, { ...data, appeals: [{ ...first, status: 'accepted' }, { ...first, id: 'other-pending' }], submission: newSubmission }]) {
    root = communityAppealForm(dom.window.document, { ...formOptions, data: next }); assert.equal(button(root, '申立てを確認').disabled, true); assert.equal(state.saved.appeal.id, 'a1');
  }
  latest = { ...data, appeals: [{ ...first, status: 'accepted' }], submission: newSubmission }; root = communityAppealForm(dom.window.document, { ...formOptions, data: latest }); assert.equal(state.saved, null); assert.equal(state.request, null); assert.equal(state.confirmed, null); assert.equal(button(root, '申立てを確認').disabled, false);
  draft(dom, root, '新しい処分について別の事実を確認して審査してください。'); button(root, '申立てを確認').click(); button(root, '確認して送信').click(); await tick(); assert.equal(calls.length, 2); assert.notEqual(calls[0].requestId, calls[1].requestId); assert.equal(calls[1].options.expectedSanctionKey, newSubmission.sanctionKey); assert.equal(state.saved.appeal.id, 'a2'); assert.equal(button(current, '申立てを確認').disabled, true);
  const oldSnapshot = { ...data, appeals: [{ ...first, status: 'accepted' }] }; root = communityAppealForm(dom.window.document, { ...formOptions, data: oldSnapshot }); assert.equal(state.saved.appeal.id, 'a2'); assert.equal(button(root, '申立てを確認').disabled, true); button(root, '申立てを確認').click(); assert.equal(calls.length, 2); dom.window.close();
});
