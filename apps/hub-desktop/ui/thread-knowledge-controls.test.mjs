import {createThreadPostControls} from './thread-post-controls.mjs';
import {createThreadReplyTarget} from './thread-reply-target.mjs';
import {createThreadStateControls} from './thread-state-controls.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { threadKnowledgeControls } from './thread-knowledge-controls.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const initial = { summaries: [{ id: 'published', revision_no: 1, body: '<script>hidden()</script>', status: 'published' }, { id: 'proposal', revision_no: 2, body: 'A proposed summary for approval.', status: 'proposed' }], topics: [{ kind: 'tag', value: 'research', following: false }], continuation: [], authenticated: true, canPropose: true, canManage: true, archived: false, canContinue: true };
async function fixture(overrides = {}) {
  const dom = new JSDOM(''), calls = [], state = {}, opened = [];
  const root = threadKnowledgeControls(dom.window.document, { thread: { id: 't1', title: 'Initial discussion thread' }, state, confirm: () => true, onOpen: (...args) => opened.push(args),
    invoke: async (command, payload) => { calls.push({ command, ...payload }); return command === 'hub_detail' ? structuredClone(initial) : { saved: true, summaryId: payload.requestId }; }, ...overrides });
  dom.window.document.body.append(root); root.open = true; await tick(); await tick();
  return { dom, root, calls, state, opened, button: text => [...root.querySelectorAll('button')].find(node => node.textContent === text), submit: form => form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })) };
}
test('knowledge is lazily loaded and renders content as text with owner approval, topic and continuation controls', async () => {
  const f = await fixture(); assert.equal(f.calls.length, 1); assert.equal(f.root.querySelector('script'), null); assert.match(f.root.textContent, /<script>/); assert.ok(f.button('この提案を公開')); assert.ok(f.button('タグ research フォロー')); assert.ok(f.button('次スレッドを作成')); f.dom.window.close();
});
test('proposal rejects too few Unicode characters, keeps draft and request ID after failure, and suppresses concurrent submits', async () => {
  const writes = []; let release;
  const f = await fixture({ invoke: async (command, payload) => command === 'hub_detail' ? initial : (writes.push(payload), await new Promise(resolve => release = resolve)) });
  const form = f.root.querySelector('form'), box = form.querySelector('textarea'); box.value = '😀'.repeat(19); f.submit(form); assert.equal(writes.length, 0);
  box.value = 'A useful new summary for all readers.'; box.dispatchEvent(new f.dom.window.Event('input')); f.submit(form); f.submit(form); assert.equal(writes.length, 1);
  release({}); await tick(); assert.equal(box.value, f.state.text); assert.match(f.root.textContent, /入力は保持/);
  f.submit(form); assert.equal(writes[1].requestId, writes[0].requestId); release({ saved: true, summaryId: writes[1].requestId }); await tick(); await tick(); assert.equal(f.state.text, ''); f.dom.window.close();
});
test('publish needs confirmation, follow can be undone, archive can be removed, and only matching acknowledgements refresh', async () => {
  const data = structuredClone(initial), writes = [];
  const f = await fixture({ confirm: () => false, invoke: async (command, payload) => { if (command === 'hub_detail') return structuredClone(data); writes.push(payload); if (payload.action === 'thread_topic_subscribe') { data.topics[0].following = true; return { subscribed: true }; } if (payload.action === 'thread_topic_unsubscribe') { data.topics[0].following = false; return { subscribed: false }; } if (payload.action === 'thread_archive') { data.archived = true; return { archived: true }; } data.archived = false; return { archived: false }; } });
  f.button('この提案を公開').click(); assert.equal(writes.length, 0);
  f.button('タグ research フォロー').click(); await tick(); await tick(); f.button('タグ research フォロー解除').click(); await tick(); await tick();
  f.button('あとで読むに保存').click(); await tick(); await tick(); f.button('あとで読むから外す').click(); await tick(); await tick();
  assert.deepEqual(writes.map(item => item.action), ['thread_topic_subscribe', 'thread_topic_unsubscribe', 'thread_archive', 'thread_unarchive']); f.dom.window.close();
});
test('anonymous and closed readers retain published content without proposal or owner write controls', async () => {
  const f = await fixture({ invoke: async () => ({ ...initial, authenticated: false, canPropose: false, canManage: false }) });
  assert.equal(f.root.querySelector('textarea'), null); assert.equal(f.button('この提案を公開'), undefined); assert.match(f.root.textContent, /Desktop接続が必要/); f.dom.window.close();
});
test('continuation keeps its own draft and stable operation ID on failure; success opens exactly the confirmed thread', async () => {
  const writes = []; let good = false;
  const f = await fixture({ invoke: async (command, payload) => command === 'hub_detail' ? initial : (writes.push(payload), good ? { thread: { id: payload.requestId, title: payload.options.title } } : {}) });
  const form = f.button('次スレッドを作成').closest('form'); form.querySelector('textarea').value = 'The context and handover to the next discussion.'; form.querySelector('[type=checkbox]').checked = true;
  f.submit(form); await tick(); assert.equal(f.opened.length, 0); assert.equal(writes[0].options.identityMode, 'anonymous'); assert.match(form.querySelector('textarea').value, /handover/);
  good = true; f.submit(form); await tick(); await tick(); assert.equal(writes[0].requestId, writes[1].requestId); assert.equal(f.opened[0][0], writes[1].requestId); f.dom.window.close();
});
test('quoting a post edits the reply draft, never the summary draft; closed threads retain knowledge controls', async () => {
  const dom=new JSDOM(''), document=dom.window.document, target=document.createElement('section');document.body.append(target);
  const source=readFileSync(new URL('app.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function renderThreadDetail('),source.indexOf('function renderArticleDetail('));
  const entry={ids:['t1'],knowledge:{open:true}};
  const ctx=vm.createContext({document,window:dom.window,createThreadReplyTarget,createThreadStateControls,createThreadPostControls,articleEditorScope:()=>null,detailRenderRevision:0,researchAccountGeneration:0,currentView:'detail',detailTrail:[entry],Event:dom.window.Event,LANGUAGE_LABELS:{},REGION_LABELS:{},relTime:()=>'',threadKnowledgeControls,
    invoke:async()=>initial,researchEditorOptions:()=>({invoke:async()=>initial}),createThreadReader:(_,options)=>{const reader=document.createElement('div');reader.append(options.renderPost({id:'post1',no:1,body:'Original post'}));return reader;},
    threadPostCard:(post,context)=>{const button=document.createElement('button');button.textContent='quote';button.onclick=()=>context.quote(post);const card=document.createElement('article');card.append(button);return card;}});
  vm.runInContext(code,ctx);ctx.renderThreadDetail(target,{thread:{id:'t1',title:'Thread',status:'open',postCount:1},posts:[]},entry);await tick();await tick();
  const proposal=target.querySelector('[aria-label="まとめの提案"]');proposal.value='An unsent summary draft';
  [...target.querySelectorAll('button')].find(button=>button.textContent==='quote').click();
  assert.equal(proposal.value,'An unsent summary draft');assert.match(target.querySelector('[data-thread-reply]').value,/Original post/);
  ctx.renderThreadDetail(target,{thread:{id:'t1',title:'Thread',status:'closed'},posts:[]},{ids:['t1']});
  assert.ok(target.querySelector('.thread-knowledge'));assert.equal(target.querySelector('[data-thread-reply]'),null);dom.window.close();
});

test('successful proposal clears the visible draft even if the subsequent reload fails', async () => {
  let reads = 0, writes = 0;
  const f = await fixture({invoke:async(command,payload)=>{ if(command==='hub_detail'){ if(reads++)throw new Error('offline'); return initial; } writes++; return {saved:true,summaryId:payload.requestId}; }});
  const form=f.root.querySelector('form');form.querySelector('textarea').value='A successful proposal with enough detail.';f.submit(form);await tick();await tick();
  assert.equal(form.querySelector('textarea').value,'');assert.match(f.root.textContent,/offline/);f.submit(form);assert.equal(writes,1);f.dom.window.close();
});

test('proposal paging preserves the draft, uses fixed cursors, retries a failed page without moving history, and navigates back', async () => {
  let fail=true;const reads=[];
  const f=await fixture({invoke:async(command,payload)=>{
    if(command!=='hub_detail')return {archived:true};reads.push(payload);
    if(payload.name==='thread_knowledge_before'&&fail)throw new Error('page offline');
    const older=payload.name==='thread_knowledge_before';
    return {...initial,summaries:[initial.summaries[0],{id:older?'old':'new',revision_no:older?2:22,body:older?'Older proposal':'New proposal',status:'proposed'}],summaryPage:{before:older?3:null,hasMore:!older,nextBefore:older?null:3}};
  }});
  const box=f.root.querySelector('[aria-label="まとめの提案"]');box.value='My unsubmitted proposal stays here';box.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(f.button('新しい20件').disabled,true);f.button('古い20件').click();await tick();assert.match(f.root.textContent,/page offline/);assert.equal(f.state.before,null);assert.equal(box.value,f.state.text);
  fail=false;f.button('古い20件').click();await tick();await tick();assert.match(f.root.textContent,/Older proposal/);assert.equal(f.button('古い20件').disabled,true);assert.equal(f.root.querySelector('[aria-label="まとめの提案"]').value,f.state.text);
  assert.deepEqual(reads.at(-1),{name:'thread_knowledge_before',ids:['t1','3']});f.button('新しい20件').click();await tick();await tick();assert.match(f.root.textContent,/New proposal/);assert.equal(f.button('新しい20件').disabled,true);
  f.button('あとで読むに保存').click();await tick();await tick();assert.equal(f.button('新しい20件').disabled,true);f.dom.window.close();
});
