import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchDiscussion,formatResearchDiscussionBody} from './research-discussion.mjs';
const reference={projectId:'rp',documentId:'doc',version:2};
const source={projectId:'rp',projectTitle:'Project',documentId:'doc',title:'Public document',version:2,contentHash:'sha256:'+'a'.repeat(64),href:'/v2/research/rp?document=doc&version=2'};
const prepared={source,boards:[{key:'general',title:'General'},{key:'code',title:'Code'}],canLink:true};
const title='A meaningful question',body='Please explain how this published version can be reproduced.';
const fixture=async(extra={})=>{
  const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),calls=[],state={};
  const options={state,prepared,invoke:async(name,args)=>{calls.push([name,args]);return {thread:{id:'thread1',title}};},...extra};
  const ui=researchDiscussion(target,reference,options);await ui.ready;return {dom,target,calls,state,options,ui};
};
const fill=(root,name,value)=>{const field=root.querySelector('form').elements[name];field.value=value;field.dispatchEvent(new field.ownerDocument.defaultView.Event('input'));};
const preview=root=>root.querySelector('form').onsubmit({preventDefault(){}});
const create=root=>root.querySelector('[data-research-discussion-create]').onclick();

test('a prepared public version previews its exact citation without writes or private auto-copy',async()=>{
  const f=await fixture({prepared:{...prepared,source:{...source,body:'PRIVATE DOCUMENT',summary:'PRIVATE PROPOSAL'}}});
  assert.equal(f.calls.length,0);assert.equal(f.target.querySelector('textarea').value,'');assert.equal(f.target.querySelector('input').value,'');
  fill(f.target,'title',title);fill(f.target,'body','<script>run()</script> '+body);fill(f.target,'boardKey','code');fill(f.target,'threadType','issue');preview(f.target);
  assert.equal(f.calls.length,0);assert.equal(f.target.querySelector('script'),null);
  assert.equal(f.target.querySelector('pre').textContent,formatResearchDiscussionBody(source,'<script>run()</script> '+body));
  assert.equal(f.ui.state.preview.payload.body,'<script>run()</script> '+body);
  assert.match(f.target.textContent,/アカウント名で投稿 · 日本語 · 全地域 · 公開/);
  assert.deepEqual(f.ui.state.preview.payload.source,source);assert.ok(!f.target.textContent.includes('PRIVATE'));
  assert.equal(f.ui.state.preview.payload.boardKey,'code');assert.equal(f.ui.state.preview.payload.threadType,'issue');f.dom.window.close();
});
test('creation and linking are separate explicit actions, and saved IDs survive rerender and link retry',async()=>{
  let creates=0,links=0,reloads=0,opened,revision;
  const f=await fixture({invoke:async(_,args)=>{if(args.action==='research_discuss'){creates++;return {thread:{id:'saved',title}};}links++;if(links===1)throw new Error('offline link');return{};},reload:async()=>{reloads++;},openThread:t=>{opened=t;},openRevision:(...args)=>{revision=args;}});
  fill(f.target,'title',title);fill(f.target,'body',body);preview(f.target);await create(f.target);assert.equal(creates,1);assert.equal(links,0);
  const oldState=f.ui.state;f.target.replaceChildren();const second=researchDiscussion(f.target,reference,f.options);await second.ready;assert.equal(second.state,oldState);
  assert.equal(f.target.querySelector('[data-research-discussion-create]'),null);[...f.target.querySelectorAll('button')].find(n=>n.textContent==='作成したスレッドを開く').click();assert.deepEqual(opened,{id:'saved',title});
  [...f.target.querySelectorAll('button')].find(n=>n.textContent==='参照したv2へ戻る').click();assert.deepEqual(revision,['rp','doc',2,'Public document']);
  await f.target.querySelector('[data-research-discussion-link]').onclick();assert.match(f.target.textContent,/offline link/);assert.equal(creates,1);
  await f.target.querySelector('[data-research-discussion-link]').onclick();assert.equal(links,2);assert.equal(creates,1);assert.equal(reloads,1);assert.equal(f.target.querySelector('[data-research-discussion-link]').disabled,true);f.dom.window.close();
});
test('unknown creation outcomes freeze the reviewed payload and UUID across retries and later rejections',async()=>{
  const sent=[];let attempts=0;
  const f=await fixture({invoke:async(_,args)=>{sent.push(args.options);attempts++;if(attempts===1)throw new Error('timeout');if(attempts===2)throw new Error('research_discuss_rejected:409:資料を再確認してください');return {thread:{id:'saved',title}};}});
  fill(f.target,'title',title);fill(f.target,'body',body);preview(f.target);const id=f.ui.state.preview.payload.requestId;
  await create(f.target);assert.equal(f.target.querySelector('textarea').disabled,true);assert.match(f.target.textContent,/作成結果が不明/);
  fill(f.target,'body','Changed by program');await create(f.target);assert.equal(f.target.querySelector('textarea').disabled,true);assert.ok(!f.target.textContent.includes('research_discuss_rejected'));
  await create(f.target);assert.equal(f.ui.state.created.id,'saved');assert.equal(sent.length,3);
  for(const payload of sent){assert.equal(payload.requestId,id);assert.equal(payload.body,body);}f.dom.window.close();
});
test('a definitive first rejection requires fresh preparation before editing and creates a fresh review UUID',async()=>{
  let creates=0,reads=0;
  const f=await fixture({invoke:async(name)=>{if(name==='hub_detail'){reads++;return prepared;}creates++;throw new Error('research_discuss_rejected:400:本文を確認してください');}});
  fill(f.target,'title',title);fill(f.target,'body',body);preview(f.target);const old=f.ui.state.preview.payload.requestId;await create(f.target);
  assert.equal(f.target.querySelector('form'),null);assert.equal(creates,1);
  await [...f.target.querySelectorAll('button')].find(n=>n.textContent==='参照を読み直す').onclick();assert.equal(reads,1);
  fill(f.target,'body',body+' Changed');preview(f.target);assert.notEqual(f.ui.state.preview.payload.requestId,old);assert.equal(creates,1);f.dom.window.close();
});
test('nonowners cannot link and post-create reload failure does not permit a duplicate link or creation',async()=>{
  const f=await fixture({prepared:{...prepared,canLink:false}});fill(f.target,'title',title);fill(f.target,'body',body);preview(f.target);await create(f.target);assert.equal(f.target.querySelector('[data-research-discussion-link]'),null);f.dom.window.close();
  let links=0;const g=await fixture({invoke:async(_,args)=>args.action==='research_discuss'?{thread:{id:'thread1',title}}:(links++,{}),reload:async()=>{throw new Error('refresh failed');}});
  fill(g.target,'title',title);fill(g.target,'body',body);preview(g.target);await create(g.target);await g.target.querySelector('[data-research-discussion-link]').onclick();
  assert.match(g.target.textContent,/関連付け済み.*更新に失敗/);assert.equal(g.target.querySelector('[data-research-discussion-link]').disabled,true);assert.equal(links,1);assert.equal(g.target.querySelector('[data-research-discussion-create]'),null);g.dom.window.close();
});
test('UTF16 title/body and final citation widths are checked without writes',async()=>{
  const f=await fixture();
  for(const [inputTitle,inputBody] of [['short',body],['😀'.repeat(51),body],[title,'😀'.repeat(14)],[title,'x'.repeat(4000)]]) {
    fill(f.target,'title',inputTitle);fill(f.target,'body',inputBody);preview(f.target);assert.equal(f.ui.state.preview,undefined);assert.equal(f.calls.length,0);
  }
  const suffix=formatResearchDiscussionBody(source,'').length;
  fill(f.target,'title','😀'.repeat(50));fill(f.target,'body','x'.repeat(4000-suffix));preview(f.target);assert.equal(f.ui.state.preview.finalBody.length,4000);assert.equal(f.calls.length,0);f.dom.window.close();
});
test('mismatched source, encoded IDs and unsafe versions fail closed before any mutation',async()=>{
  for(const changed of [{href:'https://other.invalid/doc'},{href:'/v2/research/rp?document=doc%26admin&version=2'},{version:3},{contentHash:'sha256:short'}]) {
    const f=await fixture({prepared:{...prepared,source:{...source,...changed}}});assert.equal(f.target.querySelector('form'),null);assert.equal(f.calls.length,0);f.dom.window.close();
  }
  for(const ref of [{...reference,projectId:'rp%2fadmin'},{...reference,documentId:'doc&version=3'},{...reference,version:0},{...reference,version:'2'},{...reference,version:1.5},{...reference,version:Number.MAX_SAFE_INTEGER+1}]) {
    const dom=new JSDOM('<main></main>'),calls=[];const ui=researchDiscussion(dom.window.document.querySelector('main'),ref,{invoke:async(...args)=>{calls.push(args);return prepared;}});await ui.ready;assert.equal(calls.length,0);assert.equal(ui.root.querySelector('form'),null);dom.window.close();
  }
});
test('late prepare and creation results cannot restore a UI invalidated by an account change',async()=>{
  let complete;const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main');
  const ui=researchDiscussion(target,reference,{invoke:async()=>new Promise(r=>{complete=r;})});
  dom.window.dispatchEvent(new dom.window.Event('hub-account-changed'));complete(prepared);await ui.ready;assert.equal(target.querySelector('form'),null);assert.match(target.textContent,/接続が変わりました/);dom.window.close();
  const f=await fixture({invoke:async()=>new Promise(r=>{complete=r;})});fill(f.target,'title',title);fill(f.target,'body',body);preview(f.target);const pending=create(f.target);
  f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));complete({thread:{id:'late',title}});await pending;assert.equal(f.ui.state.created,undefined);assert.equal(f.target.querySelector('button'),null);f.dom.window.close();
});

test('a pending creation updates the current rerender without enabling another creation',async()=>{
  let complete,writes=0;const f=await fixture({invoke:async()=>{writes++;return new Promise(r=>{complete=r;});}});
  fill(f.target,'title',title);fill(f.target,'body',body);preview(f.target);const pending=create(f.target);
  f.target.replaceChildren();const current=researchDiscussion(f.target,reference,f.options);await current.ready;
  assert.equal(f.target.querySelector('[data-research-discussion-create]').disabled,true);
  complete({thread:{id:'saved',title}});await pending;assert.equal(f.target.querySelector('[data-research-discussion-create]'),null);assert.equal(current.state.created.id,'saved');assert.equal(writes,1);f.dom.window.close();
});

test('a rejection delivered after rerender still requires a fresh source read',async()=>{
  let reject,reads=0;const f=await fixture({invoke:async(name)=>{if(name==='hub_detail'){reads++;return prepared;}return new Promise((_,r)=>{reject=r;});}});
  fill(f.target,'title',title);fill(f.target,'body',body);preview(f.target);const pending=create(f.target);
  f.target.replaceChildren();const current=researchDiscussion(f.target,reference,f.options);await current.ready;
  reject(new Error('research_discuss_rejected:409:参照を読み直してください'));await pending;
  assert.equal(f.target.querySelector('form'),null);assert.equal(current.state.needsPreparation,true);
  f.target.replaceChildren();const latest=researchDiscussion(f.target,reference,f.options);await latest.ready;
  assert.equal(reads,1);assert.equal(latest.state.needsPreparation,false);assert.equal(f.target.querySelector('textarea').value,body);f.dom.window.close();
});
