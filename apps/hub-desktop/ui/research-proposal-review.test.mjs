import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchProposalReview} from './research-proposal-review.mjs';
const projectId = 'rp_project', proposalId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', documentId = 'doc_1';
const bodyHash = 'sha256:' + 'a'.repeat(64), baseHash = 'sha256:' + 'b'.repeat(64), proposalHash = 'sha256:' + 'c'.repeat(64);
const reference = {projectId, proposalId};
const prepared = (overrides = {}) => ({proposal: {id: proposalId, documentId, baseVersion: 2, body: '<script>PROPOSAL_BODY</script>', summary: '<img>PRIVATE_REASON', status: 'open', createdAt: '2026-10-03T00:00:00Z', contentHash: bodyHash}, document: {id: documentId, projectId, title: '比較する文書', visibility: 'public', head: 2}, baseRevision: {version: 2, body: '<svg>BASE_BODY', contentHash: baseHash}, snapshot: {proposalId, baseVersion: 2, proposalHash, baseHash, currentHead: 2}, canDecide: true, canDiscuss: true, adoptedRevision: null, ...overrides});
const adoptedRevision = {version: 3, contentHash: bodyHash, href: `/v2/research/${projectId}?document=${documentId}&version=3`};
const success = action => ({proposalId, status: action === 'research_accept' ? 'accepted' : 'rejected', adoptedRevision: action === 'research_accept' ? adoptedRevision : null});
const closed = action => prepared({proposal: {...prepared().proposal, status: action === 'research_accept' ? 'accepted' : 'rejected'}, document: {...prepared().document, head: action === 'research_accept' ? 3 : 2}, snapshot: {...prepared().snapshot, currentHead: action === 'research_accept' ? 3 : 2}, canDecide: false, adoptedRevision: action === 'research_accept' ? adoptedRevision : null});
const setup = () => new JSDOM('<main></main>');
const button = (root, label) => [...root.querySelectorAll('button')].find(item => item.textContent === label);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
async function fixture(options = {}, state = {}) {
  const dom = setup(), calls = [], childCalls = [], {discussionsInvoke, ...props} = options;
  const invoke = props.invoke ?? (async (name, args) => {calls.push({name, args}); return name === 'hub_detail' ? closed('research_accept') : success(args.action);});
  const view = researchProposalReview(dom.window.document.querySelector('main'), reference, {state, prepared: prepared(), ...props, invoke: (name, args) => {
    if (args.name === 'research_proposal_discussions' || /^research_proposal_(?:link|unlink)$/.test(args.action ?? '')) {childCalls.push({name, args}); return discussionsInvoke ? discussionsInvoke(name, args) : Promise.resolve({proposalId, canManage: true, links: []});}
    return invoke(name, args);
  }});
  await view.ready; return {...view, dom, state, calls, childCalls};
}

test('prepared comparison is reused, HTML stays literal and reading/base discussion performs no write', async () => {
  const opened = [], discussions = [], view = await fixture({openRevision: (...args) => opened.push(args), openDiscussion: (...args) => discussions.push(args)});
  assert.equal(view.calls.length, 0); assert.equal(view.root.querySelectorAll('script,img,svg').length, 0); assert.match(view.root.textContent, /<script>PROPOSAL_BODY/); assert.match(view.root.textContent, /PRIVATE_REASON/); assert.match(view.root.textContent, /BASE_BODY/);
  assert.match(view.root.textContent, /基準 v2.*最新版 v2.*公開文書/); button(view.root, '基準のv2を開く').click(); button(view.root, '基準のv2について議論する').click();
  assert.deepEqual(opened, [[projectId, documentId, 2, '比較する文書']]); assert.deepEqual(discussions, [[projectId, documentId, 2, '基準版について議論']]); assert.equal(view.calls.length, 0); assert.doesNotMatch(JSON.stringify(discussions), /PROPOSAL_BODY|PRIVATE_REASON/); view.dispose();
});

test('accept requires preview and explicit confirmation, sends exact snapshot once and opens adopted revision', async () => {
  const opened = [], view = await fixture({openRevision: (...args) => opened.push(args)});
  assert.equal(button(view.root, '採用を確定'), undefined); button(view.root, '採用を確認').click(); assert.equal(view.calls.length, 0); assert.match(view.root.querySelector('[data-research-proposal-preview]').textContent, /公開の新しい版/);
  const execute = button(view.root, '採用を確定'); execute.click(); execute.click(); await tick();
  const writes = view.calls.filter(call => call.name === 'hub_client_action'); assert.equal(writes.length, 1); assert.deepEqual(writes[0].args, {action: 'research_accept', target: projectId, options: {proposalId, snapshot: prepared().snapshot}}); assert.doesNotMatch(JSON.stringify(writes), /PROPOSAL_BODY|PRIVATE_REASON|BASE_BODY/);
  assert.match(view.root.textContent, /採用は保存済み/); assert.equal(button(view.root, '採用を確認'), undefined); button(view.root, '採用したv3を開く').click(); assert.deepEqual(opened, [[projectId, documentId, 3, '採用した版']]); view.dispose();
});

test('head conflict blocks acceptance but permits separately confirmed rejection; closed and nonowner are readonly', async () => {
  const data = prepared({document: {...prepared().document, head: 4}, snapshot: {...prepared().snapshot, currentHead: 4}});
  const view = await fixture({prepared: data, invoke: async (name, args) => name === 'hub_detail' ? closed('research_reject') : success(args.action)});
  assert.equal(button(view.root, '採用を確認').disabled, true); assert.match(view.root.textContent, /最新版が変わっている/); button(view.root, '見送りを確認').click(); assert.match(view.root.querySelector('[data-research-proposal-preview]').textContent, /最新版は変更しません/);
  button(view.root, '見送りを確定').click(); await tick(); assert.match(view.root.textContent, /見送りは保存済み/); view.dispose();
  for (const data of [prepared({canDecide: false}), closed('research_accept'), closed('research_reject')]) { const readonly = await fixture({prepared: data}); assert.equal(button(readonly.root, '採用を確認'), undefined); assert.equal(button(readonly.root, '見送りを確認'), undefined); readonly.dispose(); }
});

test('unknown result pins action and snapshot across edits, subsequent conflict and successful same-operation recovery', async () => {
  let attempts = 0; const writes = [], view = await fixture({invoke: async (name, args) => {
    if (name === 'hub_detail') return closed('research_accept'); writes.push(args); attempts++; if (attempts === 1) throw Error('network'); if (attempts === 2) throw Error('research_accept_rejected:409:changed'); return success(args.action);
  }}); button(view.root, '採用を確認').click(); button(view.root, '採用を確定').click(); await tick();
  assert.match(view.root.textContent, /判断結果が不明/); assert.equal(button(view.root, '比較に戻る'), undefined); assert.equal(button(view.root, '見送りを確認'), undefined);
  button(view.root, '同じ判断の結果を確認する').click(); await tick(); assert.match(view.root.textContent, /判断結果が不明/); assert.equal(button(view.root, '見送りを確認'), undefined);
  button(view.root, '同じ判断の結果を確認する').click(); await tick(); assert.equal(writes.length, 3); assert.deepEqual(writes[0], writes[1]); assert.deepEqual(writes[0], writes[2]); assert.match(view.root.textContent, /採用は保存済み/); view.dispose();
});

test('definite first rejection clears confirmation and requires a fresh read before a new decision', async () => {
  let attempts = 0, reads = 0;
  const view = await fixture({invoke: async (name, args) => { if (name === 'hub_detail') {reads++; return prepared();} attempts++; throw Error('research_accept_rejected:409:head changed'); }});
  button(view.root, '採用を確認').click(); button(view.root, '採用を確定').click(); await tick(); assert.equal(attempts, 1); assert.equal(button(view.root, '採用を確認'), undefined); assert.equal(button(view.root, '同じ判断の結果を確認する'), undefined); assert.equal(reads, 0);
  button(view.root, '比較内容を再確認').click(); await tick(); assert.equal(reads, 1); assert.ok(button(view.root, '採用を確認')); assert.equal(button(view.root, '採用を確定'), undefined); view.dispose();
});

test('wrong acknowledgement cannot mark saved and retry retains the original snapshot', async () => {
  for (const reply of [{...success('research_accept'), proposalId: 'other'}, success('research_reject'), {...success('research_accept'), adoptedRevision: {...adoptedRevision, contentHash: baseHash}}, {...success('research_accept'), adoptedRevision: {...adoptedRevision, href: 'javascript:alert(1)'}}]) {
    const writes = [], view = await fixture({invoke: async (_name, args) => {writes.push(args); return reply;}}); button(view.root, '採用を確認').click(); button(view.root, '採用を確定').click(); await tick();
    assert.doesNotMatch(view.root.textContent, /採用は保存済み/); assert.match(view.root.textContent, /判断結果が不明/); button(view.root, '同じ判断の結果を確認する').click(); await tick(); assert.deepEqual(writes[0], writes[1]); view.dispose();
  }
});

test('saved acknowledgement survives failed reread and stale open rerender without enabling another judgment', async () => {
  const state = {}; let writes = 0, reads = 0;
  const view = await fixture({invoke: async (name, args) => { if (name === 'hub_detail') {reads++; throw Error('network read');} writes++; return success(args.action);}}, state);
  button(view.root, '採用を確認').click(); button(view.root, '採用を確定').click(); await tick(); assert.equal(writes, 1); assert.equal(reads, 1); assert.match(view.root.textContent, /採用は保存済み/); assert.match(view.root.textContent, /最新の比較内容を確認できませんでした/); view.dispose();
  const rerender = await fixture({invoke: async () => {reads++; throw Error('still offline');}}, state); assert.match(rerender.root.textContent, /採用は保存済み/); assert.equal(button(rerender.root, '採用を確認'), undefined); assert.equal(button(rerender.root, '見送りを確認'), undefined); assert.equal(writes, 1); assert.ok(button(rerender.root, '比較内容を再確認')); rerender.dispose();
});

test('unexecuted preview and pending acknowledgement survive dispose and return, while old controls stay inert', async () => {
  const state = {}, old = await fixture({}, state); button(old.root, '見送りを確認').click(); const oldExecute = button(old.root, '見送りを確定'); old.dispose();
  const pending = deferred(), current = await fixture({invoke: async () => pending.promise}, state); assert.ok(button(current.root, '見送りを確定')); oldExecute.click(); assert.equal(old.calls.length, 0);
  button(current.root, '見送りを確定').click(); await tick(); current.dispose(); const returned = await fixture({}, state); assert.equal(button(returned.root, '同じ判断の結果を確認する').disabled, true);
  pending.resolve(success('research_reject')); await tick(); assert.match(returned.root.textContent, /見送りは保存済み/); assert.equal(button(returned.root, '同じ判断の結果を確認する'), undefined); assert.equal(returned.calls.length, 0); returned.dispose();
});

test('read and mutation access loss erase private text and reader permissions but retain an uncertain decision snapshot', async () => {
  const state = {}, writes = [], view = await fixture({invoke: async (name, args) => {if (name === 'hub_detail') throw Error('見つかりませんでした'); writes.push(args); throw Error(writes.length === 1 ? 'network' : 'research_accept_rejected:403:権限がありません');}}, state);
  button(view.root, '採用を確認').click(); button(view.root, '採用を確定').click(); await tick(); button(view.root, '比較内容を再確認').click(); await tick();
  assert.doesNotMatch(view.root.textContent, /PROPOSAL_BODY|PRIVATE_REASON|BASE_BODY|公開文書/); assert.doesNotMatch(JSON.stringify(state), /PROPOSAL_BODY|PRIVATE_REASON|BASE_BODY|canDiscuss|canDecide|visibility/);
  button(view.root, '同じ判断の結果を確認する').click(); await tick(); assert.deepEqual(writes[0], writes[1]); assert.doesNotMatch(JSON.stringify(state), /PRIVATE_REASON|PROPOSAL_BODY/); assert.ok(button(view.root, '同じ判断の結果を確認する')); view.dispose();
  for (const message of ['ハブが 401 を返しています', 'このアカウントは停止されているか、権限がありません', 'desktop_not_connected']) { const readonly = await fixture({invoke: async () => {throw message;}}); button(readonly.root, '比較内容を再確認').click(); await tick(); assert.equal(readonly.root.querySelector('pre'), null); assert.equal(button(readonly.root, '基準のv2について議論する'), undefined); readonly.dispose(); }
});

test('account invalidation clears only proposal states and ignores a late pending result', async () => {
  const pending = deferred(), state = {documentDraft: 'KEEP', gitDiscussions: {pin: {requestId: 'KEEP'}}}, view = await fixture({invoke: async () => pending.promise}, state);
  button(view.root, '採用を確認').click(); button(view.root, '採用を確定').click(); await tick(); view.invalidate(); pending.resolve(success('research_accept')); await tick();
  assert.deepEqual(state.proposalReviews, {}); assert.equal(state.documentDraft, 'KEEP'); assert.equal(state.gitDiscussions.pin.requestId, 'KEEP'); assert.equal(view.root.querySelector('pre'), null); assert.doesNotMatch(view.root.textContent, /保存済み/); view.dispose();
});

test('malformed target, snapshot, bounds and adopted URL cannot reach confirmation or execute HTML', async () => {
  const invalid = [prepared({proposal: {...prepared().proposal, id: 'other'}}), prepared({document: {...prepared().document, projectId: 'other'}}), prepared({snapshot: {...prepared().snapshot, baseHash: bodyHash}}), prepared({snapshot: {...prepared().snapshot, baseVersion: 3}}), prepared({snapshot: {...prepared().snapshot, currentHead: 3}}), prepared({baseRevision: {...prepared().baseRevision, body: 'x'.repeat(100001)}}), prepared({proposal: {...prepared().proposal, summary: 'x'.repeat(501)}}), prepared({document: {...prepared().document, visibility: 'confidential'}}), prepared({adoptedRevision}), {...closed('research_accept'), adoptedRevision: {...adoptedRevision, href: 'javascript:run()'}}];
  for (const data of invalid) { const view = await fixture({prepared: data}); assert.equal(view.root.querySelector('pre'), null); assert.equal(button(view.root, '採用を確認'), undefined); assert.equal(view.calls.length, 0); assert.match(view.root.textContent, /比較内容を確認できません/); view.dispose(); }
  const maximum = Number.MAX_SAFE_INTEGER, data = prepared({proposal: {...prepared().proposal, baseVersion: maximum}, document: {...prepared().document, head: maximum}, baseRevision: {...prepared().baseRevision, version: maximum}, snapshot: {...prepared().snapshot, baseVersion: maximum, currentHead: maximum}});
  const view = await fixture({prepared: data}); assert.equal(button(view.root, '採用を確認').disabled, true); assert.equal(button(view.root, '見送りを確認').disabled, false); assert.match(view.root.textContent, /版番号の表示上限/); view.dispose();
});

test('publication or permission changes expire an unexecuted preview on a fresh read', async () => {
  const view = await fixture({invoke: async () => prepared({document: {...prepared().document, visibility: 'confidential'}, canDiscuss: false})}); button(view.root, '採用を確認').click(); assert.ok(button(view.root, '採用を確定'));
  button(view.root, '比較内容を再確認').click(); await tick(); assert.equal(button(view.root, '採用を確定'), undefined); assert.match(view.root.textContent, /非公開文書/); assert.ok(button(view.root, '採用を確認')); view.dispose();
});


test('definite rejection delivered after returning clears old preparation before any second decision', async () => {
  const state = {}, pending = deferred(), first = await fixture({invoke: async () => pending.promise}, state);
  button(first.root, '採用を確認').click(); button(first.root, '採用を確定').click(); await tick(); first.dispose();
  let reads = 0; const returned = await fixture({invoke: async name => {assert.equal(name, 'hub_detail'); reads++; return prepared();}}, state);
  pending.reject(Error('research_accept_rejected:400:参照を確認してください')); await tick();
  assert.equal(button(returned.root, '採用を確認'), undefined); assert.equal(button(returned.root, '同じ判断の結果を確認する'), undefined); assert.equal(reads, 0);
  button(returned.root, '比較内容を再確認').click(); await tick(); assert.equal(reads, 1); assert.ok(button(returned.root, '採用を確認')); assert.equal(button(returned.root, '採用を確定'), undefined); returned.dispose();
});

test('discussion host persists across decision previews without repeated reads, and a child outage does not block comparison', async () => {
  const view = await fixture({discussionsInvoke: async () => {throw Error('ハブが 503 を返しています');}});
  assert.equal(view.childCalls.length, 1); assert.match(view.root.querySelector('.research-proposal-discussions').textContent, /503/); assert.ok(view.root.querySelector('.research-proposal-comparison'));
  const host = view.root.querySelector('.research-proposal-discussions'); button(view.root, '採用を確認').click(); button(view.root, '比較に戻る').click(); button(view.root, '見送りを確認').click();
  assert.equal(view.root.querySelector('.research-proposal-discussions'), host); assert.equal(view.childCalls.length, 1); assert.ok(button(view.root, '見送りを確定')); view.dispose();
});

test('comparison authority loss clears and disposes child thread data and cascaded invalidate rejects a late child response', async () => {
  const linkId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', pending = deferred(); let childReads = 0;
  const state = {}, view = await fixture({invoke: async () => {throw Error('見つかりませんでした');}, discussionsInvoke: async () => {childReads++; return {proposalId, canManage: true, links: [{linkId, threadId: 'thread', linked: true, available: true, title: 'OLD_THREAD_TITLE', href: '/v2/threads/thread'}]};}}, state);
  const oldOpen = view.root.querySelector('.research-proposal-discussions a'); button(view.root, '比較内容を再確認').click(); await tick(); assert.doesNotMatch(view.root.textContent, /OLD_THREAD_TITLE/); assert.doesNotMatch(JSON.stringify(state), /OLD_THREAD_TITLE/); oldOpen.click(); assert.equal(childReads, 1); view.dispose();
  const current = await fixture({discussionsInvoke: async () => ({proposalId, canManage: true, links: []})}, state);
  current.dom.window.dispatchEvent(new current.dom.window.Event('hub-account-changed')); assert.deepEqual(state.proposalDiscussions, {}); assert.deepEqual(state.proposalReviews, {}); assert.equal(current.root.querySelector('.research-proposal-discussions'), null); current.dispose();
  const dom = setup(), delayed = researchProposalReview(dom.window.document.querySelector('main'), reference, {state, prepared: prepared(), invoke: async (_name, args) => args.name === 'research_proposal_discussions' ? pending.promise : prepared()}); await tick(); delayed.invalidate(); pending.resolve({proposalId, canManage: true, links: [{linkId, threadId: 'thread', linked: true, available: true, title: 'LATE_TITLE', href: '/v2/threads/thread'}]}); await delayed.ready;
  assert.doesNotMatch(delayed.root.textContent, /LATE_TITLE/); assert.deepEqual(state.proposalDiscussions, {}); delayed.dispose(); dom.window.close();
});
