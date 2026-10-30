import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {projectWorkspace} from './research-workspace.mjs';
import {researchProposalReview} from './research-proposal-review.mjs';
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const fn = name => { const start = source.indexOf(name), end = source.indexOf('\n}', start) + 2; assert.ok(start >= 0 && end > start, name); return source.slice(start, end); };
const rendererLine = source.split('\n').find(line => line.trimStart().startsWith('research_proposal:(target,data,entry)=>'));
assert.ok(rendererLine);
const accountLine = source.split('\n').filter(line => line.startsWith("function invalidateDetailContext(reload=true) {")||line.startsWith("window.addEventListener('hub-account-changed',()=>invalidateDetailContext());")).join('\n');
assert.ok(accountLine.includes('function invalidateDetailContext(reload=true) {'));
assert.ok(accountLine.includes("window.addEventListener('hub-account-changed',()=>invalidateDetailContext());"));
const projectId = 'rp_' + 'a'.repeat(32), documentId = 'doc_1', proposalId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const bodyHash = 'sha256:' + 'b'.repeat(64), baseHash = 'sha256:' + 'c'.repeat(64), proposalHash = 'sha256:' + 'd'.repeat(64);
const data = () => ({proposal: {id: proposalId, documentId, baseVersion: 2, body: 'PRIVATE_PROPOSAL_BODY', summary: '変更の理由', status: 'open', createdAt: '2026-10-03T00:00:00Z', contentHash: bodyHash}, document: {id: documentId, projectId, title: '比較対象の文書', visibility: 'public', head: 2}, baseRevision: {version: 2, body: 'PUBLIC_BASE_BODY', contentHash: baseHash}, snapshot: {proposalId, baseVersion: 2, proposalHash, baseHash, currentHead: 2}, canDecide: true, canDiscuss: true, adoptedRevision: null});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = (root, label) => [...root.querySelectorAll('button')].find(item => item.textContent === label);
const plain = value => JSON.parse(JSON.stringify(value));
function context(dom, entry, invoke) {
  const opened = [], discussionReads = [], target = dom.window.document.querySelector('main'), status = dom.window.document.querySelector('#status');
  const ctx = vm.createContext({sidebarContext:dom.window.document.createElement('nav'),offerPublicContentShare:()=>false,attachDetailAiHandoff(){},videoCommentsController: null, researchAccountGeneration: 1, researchDetailController: null, communityChannelPolicyController: null, communityInviteController: null, detailRenderRevision: 0, currentView: 'detail', detailTrail: [entry], detailForwardTrail: [], toolbarTrail: [], window: dom.window,
    invoke: (name, args) => {if (name === 'hub_detail' && args.name === 'research_proposal_discussions') {discussionReads.push(plain(args));return Promise.resolve({proposalId, canManage: true, links: [{linkId: proposalId, threadId: 'public_thread', linked: true, available: true, title: '公開の議論', href: '/v2/threads/public_thread'}]});} return invoke(name, args);}, friendlyError: String, openDetail: (...args) => {opened.push(args);}, connectDesktopAccount: () => {}, paintDetailHead() {}, detailState: () => status, detailContent: () => target, skeletonResult: () => dom.window.document.createElement('div'),
    communityAppealReviewRequest: () => null, communityReportReviewRequest: () => null, communityMembershipReviewRequest: () => null, communityGuideRequest: value => ({name: value.name, ids: value.ids}), readingDirectory: new Set(), DETAIL_PARENT_VIEW: {research_proposal: 'research'}, renderSidebarContext() {}, DETAIL_RENDERERS: {}});
  vm.runInContext(fn('function syncCommunityInvite(reset=false){'), ctx);
  vm.runInContext(fn('function researchEditorOptions(entry) {'), ctx);
  const render = new Function('researchProposalReview', 'researchEditorOptions', `return (${rendererLine.trim().replace(/^research_proposal:/, '').replace(/,$/, '')});`)(researchProposalReview, ctx.researchEditorOptions);
  ctx.DETAIL_RENDERERS.research_proposal = render;
  vm.runInContext(fn('function releaseResearchDetail(invalidate=false) {'), ctx);
  vm.runInContext(fn('function releaseCommunityChannelPolicy(invalidate=false){'), ctx);
  vm.runInContext(fn('async function renderDetailEntry(entry) {'), ctx);
  return {ctx, opened, target, render, discussionReads};
}

test('actual workspace compare entry shares editor state and references the proposal base without exposing its text to discussion', async () => {
  const dom = new JSDOM('<main></main><p id="status"></p>'), editor = {document: {body: 'KEEP_DRAFT'}, gitDiscussions: {pin: {requestId: 'KEEP_UUID'}}}, entry = {name: 'research_project', ids: [projectId], editorState: editor};
  const {ctx, opened, target, render, discussionReads} = context(dom, entry, async () => assert.fail('No proposal read or write is needed before navigation'));
  projectWorkspace(target, {project: {id: projectId, visibility: 'public'}, workspace: {documents: [data().document], proposals: [data().proposal]}}, ctx.researchEditorOptions(entry));
  button(target, '比較して確認').click();
  const [name, ids, options] = opened[0]; assert.equal(name, 'research_proposal'); assert.deepEqual(plain(ids), [projectId, proposalId]); assert.equal(options.local, true); assert.equal(options.editorState, editor); assert.equal(options.title, '変更提案の比較'); assert.doesNotMatch(JSON.stringify([name, ids, options.title]), /変更の理由|PRIVATE_PROPOSAL_BODY/);
  ctx.researchEditorOptions(entry).openProposal(projectId, proposalId, '以前の呼出しからの非公開理由'); assert.equal(opened.at(-1)[2].title, '変更提案の比較'); opened.pop();
  const proposalEntry = {name, ids, title: options.title, local: options.local, editorState: options.editorState};
  const controller = render(target, data(), proposalEntry); await controller.ready;
  button(target, '基準のv2を開く').click(); button(target, '基準のv2について議論する').click();
  assert.deepEqual(opened.slice(1).map(call => [call[0], plain(call[1])]), [['research_revision', [projectId, documentId, '2']], ['research_discussion', [projectId, documentId, '2']]]);
  assert.ok(opened.every(call => call[2].editorState === editor)); assert.doesNotMatch(JSON.stringify([opened.at(-1)[0], opened.at(-1)[1], opened.at(-1)[2].title]), /PRIVATE_PROPOSAL_BODY|変更の理由/);
  assert.deepEqual(discussionReads, [{name: 'research_proposal_discussions', ids: [projectId, proposalId]}]);target.querySelector('.research-proposal-discussions li a').click();assert.equal(opened.at(-1)[0], 'thread');assert.deepEqual(plain(opened.at(-1)[1]), ['public_thread']);assert.equal(opened.at(-1)[2].title, '公開の議論');assert.doesNotMatch(JSON.stringify([opened.at(-1)[0], opened.at(-1)[1], opened.at(-1)[2].title]), /PRIVATE_PROPOSAL_BODY|変更の理由/);
  assert.equal(editor.document.body, 'KEEP_DRAFT'); assert.equal(editor.gitDiscussions.pin.requestId, 'KEEP_UUID'); controller.dispose(); dom.window.close();
});

test('actual local detail renderer owns one fixed proposal read and releases the controller while retaining unexecuted comparison', async () => {
  const dom = new JSDOM('<main></main><p id="status"></p>'), reads = [], editor = {document: {body: 'KEEP'}}, entry = {name: 'research_proposal', ids: [projectId, proposalId], local: true, editorState: editor};
  const {ctx, target, discussionReads} = context(dom, entry, async (name, args) => {assert.equal(name, 'hub_detail'); reads.push(plain(args)); return data();});
  await ctx.renderDetailEntry(entry); const first = ctx.researchDetailController; assert.ok(first); await first.ready;
  assert.deepEqual(reads, [{name: 'research_proposal', ids: [projectId, proposalId]}]); assert.equal(first.root.dataset.researchSection, '変更提案の比較');
  button(target, '採用を確認').click(); const oldExecute = button(target, '採用を確定'); ctx.releaseResearchDetail();
  assert.equal(discussionReads.length, 1);
  assert.equal(ctx.researchDetailController, null); assert.equal(oldExecute.disabled, true); assert.equal(editor.document.body, 'KEEP'); assert.ok(Object.values(editor.proposalReviews)[0].review);
  oldExecute.click(); assert.equal(reads.length, 1);
  await ctx.renderDetailEntry(entry); const returned = ctx.researchDetailController; await returned.ready;
  assert.ok(button(target, '採用を確定')); assert.equal(reads.length, 2); assert.ok(reads.every(read => read.name === 'research_proposal'));assert.equal(discussionReads.length, 2); ctx.releaseResearchDetail(); dom.window.close();
});

test('actual account-change hook invalidates proposal state and trail copies, rejects old in-flight invokes and permits the fresh generation', async () => {
  const dom = new JSDOM('<main></main><p id="status"></p>'), oldEditor = {document: {body: 'OLD_ACTOR_DRAFT'}, gitDiscussions: {pin: {requestId: 'OLD_UUID'}}}, entry = {name: 'research_proposal', ids: [projectId, proposalId], local: true, editorState: oldEditor};
  let deferNext = false, finish, actor = 'old'; const reads = [];
  const {ctx, target} = context(dom, entry, async (name, args) => {
    assert.equal(name, 'hub_detail'); reads.push({actor, args: plain(args)});
    if (deferNext) {deferNext = false; return await new Promise(resolve => {finish = resolve;});}
    const result = data(); if (actor === 'new') result.proposal.body = 'NEW_ACTOR_VISIBLE_BODY'; return result;
  });
  await ctx.renderDetailEntry(entry); await ctx.researchDetailController.ready;
  button(target, '採用を確認').click(); const oldOptions = ctx.researchEditorOptions(entry), oldStates = oldEditor.proposalReviews, oldDiscussionStates = oldEditor.proposalDiscussions;
  const forward = {name: 'research_revision', editorState: oldEditor, data: {body: 'OLD_FORWARD'}}, archived = {name: 'research_project', editorState: oldEditor, data: {body: 'OLD_TRAIL'}};
  ctx.detailForwardTrail.push(forward); ctx.toolbarTrail.push({detailTrail: [archived], detailForwardTrail: [forward]});
  vm.runInContext(accountLine, ctx);
  deferNext = true; const pending = oldOptions.invoke('hub_detail', {name: 'research_proposal', ids: [projectId, proposalId]});
  actor = 'new'; dom.window.dispatchEvent(new dom.window.Event('hub-account-changed'));
  const rejected = assert.rejects(pending, /接続が変わりました/); finish(data()); await rejected; await tick();
  assert.deepEqual(oldStates, {}); assert.equal(forward.editorState, undefined); assert.equal(forward.data, undefined); assert.equal(archived.editorState, undefined); assert.equal(archived.data, undefined);
  assert.deepEqual(oldDiscussionStates, {});
  assert.notEqual(entry.editorState, oldEditor); assert.equal(entry.editorState.document, undefined); await ctx.researchDetailController.ready;
  assert.doesNotMatch(target.textContent, /PRIVATE_PROPOSAL_BODY|OLD_ACTOR_DRAFT/); assert.match(target.textContent, /NEW_ACTOR_VISIBLE_BODY/);
  const count = reads.length; await assert.rejects(oldOptions.invoke('hub_detail', {name: 'research_proposal', ids: [projectId, proposalId]}), /接続が変わりました/); assert.equal(reads.length, count);
  const fresh = ctx.researchEditorOptions(entry); assert.equal((await fresh.invoke('hub_detail', {name: 'research_proposal', ids: [projectId, proposalId]})).proposal.body, 'NEW_ACTOR_VISIBLE_BODY'); assert.equal(reads.at(-1).actor, 'new');
  ctx.releaseResearchDetail(); dom.window.close();
});


