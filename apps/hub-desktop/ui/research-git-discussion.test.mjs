import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchGitDiscussion,formatResearchGitDiscussionBody} from './research-git-discussion.mjs';
const p='rp_'+'a'.repeat(32),hash='b'.repeat(40),ref={projectId:p,oid:hash};
const source={projectId:p,projectTitle:'Project',oid:hash,subject:'Public changes',href:'/v2/research/'+p+'?commit='+hash+'#git'};
const data={source,boards:[{key:'general',title:'General'},{key:'code',title:'Code'}],canLink:true};
const title='A meaningful Git question',body='How can this exact public implementation be reproduced?';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function fixture(extra={}) {
  const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),calls=[],state={};
  const custom=extra.invoke,options={state,prepared:data,...extra,invoke:async(name,args)=>{
    calls.push([name,args]);
    if(custom)return custom(name,args);
    if(name==='hub_detail')return data;
    return args.action==='research_git_discuss'?{thread:{id:args.options.requestId,title}}:{};
  }};
  const ui=researchGitDiscussion(target,ref,options);await ui.ready;return {dom,target,calls,state:options.state,options,ui};
}
const fill=(root,name,value)=>{const field=root.querySelector('form').elements[name];field.value=value;field.dispatchEvent(new field.ownerDocument.defaultView.Event('input'));};
const preview=root=>root.querySelector('form').onsubmit({preventDefault(){}});
const create=root=>root.querySelector('[data-research-git-discussion-create]').onclick();
const link=root=>root.querySelector('[data-research-git-discussion-link]').onclick();
const writeDraft=f=>{fill(f.target,'title',title);fill(f.target,'body',body);preview(f.target);};
async function remount(f,extra={}) {
  f.ui.dispose();f.target.replaceChildren();f.options={...f.options,...extra};f.ui=researchGitDiscussion(f.target,ref,f.options);await f.ui.ready;return f.ui;
}
const close=f=>{f.ui.dispose();f.dom.window.close();};
test('preparation uses a fixed readonly detail and never copies code, message or private metadata',async()=>{
  const prepared={...data,source:{...source,body:'PRIVATE CODE',message:'PRIVATE MESSAGE',diff:'PRIVATE DIFF'}};
  const f=await fixture({prepared:undefined,invoke:async(name,args)=>{assert.equal(name,'hub_detail');assert.deepEqual(args,{name:'research_git_discussion',ids:[p,hash]});return prepared;}});
  assert.equal(f.calls.length,1);assert.equal(f.target.querySelector('textarea').value,'');assert.equal(f.target.querySelector('input').value,'');assert.deepEqual(f.ui.state.prepared.source,source);assert.ok(!f.target.textContent.includes('PRIVATE'));close(f);
});
test('all user and source HTML remains literal in the full public preview, with zero writes',async()=>{
  const literal={...source,projectTitle:'<script>Project</script>',subject:'<img src=x>'},f=await fixture({prepared:{...data,source:literal}});
  fill(f.target,'title',title+' <script>');fill(f.target,'body','<script>run()</script> '+body);fill(f.target,'boardKey','code');fill(f.target,'threadType','issue');preview(f.target);
  assert.equal(f.calls.length,0);assert.equal(f.target.querySelector('script'),null);assert.equal(f.target.querySelector('img'),null);
  assert.equal(f.target.querySelector('pre').textContent,formatResearchGitDiscussionBody(literal,'<script>run()</script> '+body));assert.match(f.target.textContent,/Code · 不具合報告 · アカウント名 · 日本語 · 全地域 · 公開/);close(f);
});
test('creation sends only reviewed closed fields, and linking is a separate retryable owner action',async()=>{
  let writes=0,links=0,opened,returned,reloads=0;
  const f=await fixture({invoke:async(_,args)=>{if(args.action==='research_git_discuss'){writes++;return {thread:{id:args.options.requestId}};}assert.deepEqual(args,{action:'research_link',target:p,options:{kind:'thread',targetId:f.ui.state.created.id}});links++;if(links===1)throw Error('link offline');return{};},openThread:thread=>{opened=thread;},openCommit:(...args)=>{returned=args;},reload:async()=>{reloads++;throw Error('reload offline');}});
  writeDraft(f);const snapshot=f.ui.state.preview.payload;assert.deepEqual(Object.keys(snapshot).sort(),['oid','source','title','body','boardKey','threadType','requestId'].sort());assert.deepEqual(snapshot.source,source);assert.equal(snapshot.body,body);assert.match(snapshot.requestId,/^[a-f0-9-]{36}$/);
  await create(f.target);assert.equal(writes,1);assert.equal(links,0);assert.equal(f.ui.state.created.id,snapshot.requestId);
  await remount(f);assert.equal(f.target.querySelector('[data-research-git-discussion-create]'),null);
  [...f.target.querySelectorAll('button')].find(n=>n.textContent==='作成したスレッドを開く').click();assert.deepEqual(opened,{id:snapshot.requestId,title});
  [...f.target.querySelectorAll('button')].find(n=>n.textContent==='元のコミットへ戻る').click();assert.deepEqual(returned,[p,hash]);
  await link(f.target);assert.match(f.target.textContent,/link offline/);await link(f.target);assert.equal(writes,1);assert.equal(links,2);assert.equal(reloads,1);assert.match(f.target.textContent,/関連付け済み.*更新に失敗/);assert.equal(f.target.querySelector('[data-research-git-discussion-link]').disabled,true);close(f);
});
test('a nonowner cannot link, and result retention does not infer permission after private preparation fails',async()=>{
  const f=await fixture({prepared:{...data,canLink:false}});writeDraft(f);await create(f.target);assert.equal(f.target.querySelector('[data-research-git-discussion-link]'),null);close(f);
  const g=await fixture();writeDraft(g);await create(g.target);const saved=g.ui.state.created.id;
  await remount(g,{prepared:undefined,invoke:async()=>{throw Error('404: no public repository');}});
  assert.equal(g.ui.state.created.id,saved);assert.equal(g.target.querySelector('[data-research-git-discussion-link]'),null);assert.equal(g.target.querySelector('[data-research-git-discussion-create]'),null);assert.match(g.target.textContent,/スレッドを作成/);close(g);
});
test('a repeated review preserves its UUID while any draft change requires a new review',async()=>{
  const f=await fixture();writeDraft(f);const first=f.ui.state.preview.payload.requestId;preview(f.target);assert.equal(f.ui.state.preview.payload.requestId,first);
  fill(f.target,'body',body+' Revised');assert.equal(f.ui.state.preview,undefined);preview(f.target);assert.notEqual(f.ui.state.preview.payload.requestId,first);assert.equal(f.calls.length,0);close(f);
});
test('UTF16 input and total body bounds preserve valid pairs and reject unpaired surrogates',async()=>{
  const f=await fixture();
  for(const [heading,text] of [['short',body],['😀'.repeat(51),body],[title,'😀'.repeat(14)],[title,'x'.repeat(4000)],[title,body+'\ud800'],[title+'\udc00',body]]) {
    fill(f.target,'title',heading);fill(f.target,'body',text);preview(f.target);assert.equal(f.ui.state.preview,undefined);assert.equal(f.calls.length,0);
  }
  const suffix=formatResearchGitDiscussionBody(source,'').length;
  fill(f.target,'title','😀'.repeat(50));fill(f.target,'body','x'.repeat(4000-suffix));preview(f.target);assert.equal(f.ui.state.preview.finalBody.length,4000);
  fill(f.target,'body','x'.repeat(4001-suffix));preview(f.target);assert.equal(f.ui.state.preview,undefined);
  fill(f.target,'title','😀'.repeat(4));fill(f.target,'body','😀'.repeat(15));preview(f.target);assert.ok(f.ui.state.preview);assert.equal(f.calls.length,0);close(f);
});
test('project and complete lowercase hash boundaries fail before any IPC',async()=>{
  for(const reference of [{...ref,projectId:p.toUpperCase()},{...ref,projectId:p.slice(0,-1)},{...ref,projectId:p+'x'},{...ref,projectId:p+'%2F'},{...ref,projectId:null},{...ref,oid:hash.toUpperCase()},{...ref,oid:hash.slice(0,-1)},{...ref,oid:'b'.repeat(41)},{...ref,oid:'b'.repeat(65)},{...ref,oid:hash+'?x'},{...ref,oid:42}]) {
    const dom=new JSDOM('<main></main>'),calls=[];const ui=researchGitDiscussion(dom.window.document.querySelector('main'),reference,{invoke:async(...args)=>{calls.push(args);return data;}});await ui.ready;assert.equal(calls.length,0);assert.equal(ui.root.querySelector('form'),null);ui.dispose();dom.window.close();
  }
  const long='c'.repeat(64),f=await fixture({prepared:{...data,source:{...source,oid:long,href:'/v2/research/'+p+'?commit='+long+'#git'}}});
  assert.equal(f.target.querySelector('form'),null);close(f);
  const dom=new JSDOM('<main></main>'),ui=researchGitDiscussion(dom.window.document.querySelector('main'),{projectId:p,oid:long},{prepared:{...data,source:{...source,oid:long,href:'/v2/research/'+p+'?commit='+long+'#git'}}});await ui.ready;assert.ok(ui.root.querySelector('form'));ui.dispose();dom.window.close();
});
test('prepared source is exact, single line, well formed and bounded while unknown fields are discarded',async()=>{
  for(const changed of [{projectId:'rp_'+'c'.repeat(32)},{oid:'c'.repeat(40)},{href:'https://evil.invalid'},{href:source.href+'&extra=1'},{projectTitle:''},{projectTitle:'x'.repeat(241)},{projectTitle:'line\nbreak'},{subject:'tab\tbreak'},{subject:'\u007f'},{subject:'x'.repeat(241)},{projectTitle:'\ud800x'},{subject:'x\udc00'},{subject:null}]) {
    const f=await fixture({prepared:{...data,source:{...source,...changed}}});assert.equal(f.target.querySelector('form'),null);assert.equal(f.calls.length,0);close(f);
  }
  const f=await fixture({prepared:{...data,source:{...source,projectTitle:'😀'.repeat(120),subject:'😀'.repeat(120),privateBody:'PRIVATE'}}});assert.ok(f.target.querySelector('form'));assert.ok(!Object.hasOwn(f.ui.state.prepared.source,'privateBody'));close(f);
});
test('malformed preparation capability or board values are rejected, and empty boards can be reread',async()=>{
  for(const changed of [{canLink:'true'},{boards:null},{boards:[null]},{boards:[{key:'--flag?',title:'Unsafe'}]},{boards:[{key:'general',title:42}]},{boards:[data.boards[0],data.boards[0]]}]) {
    const f=await fixture({prepared:{...data,...changed}});assert.equal(f.target.querySelector('form'),null);assert.equal(f.calls.length,0);close(f);
  }
  const f=await fixture({prepared:{...data,boards:[]}});assert.match(f.target.textContent,/投稿できる掲示板がありません/);
  await [...f.target.querySelectorAll('button')].find(n=>n.textContent==='投稿先を再確認').onclick();assert.equal(f.calls.length,1);assert.ok(f.target.querySelector('form'));close(f);
});
for(const code of [400,404,409])test('an initial definitive '+code+' rejection requires reprepare, then a fresh UUID',async()=>{
  let attempts=0,reads=0;const f=await fixture({invoke:async(name,args)=>{if(name==='hub_detail'){reads++;return data;}attempts++;if(attempts===1)throw Error('research_git_discuss_rejected:'+code+':再確認してください');return {thread:{id:args.options.requestId}};}});
  writeDraft(f);const original=f.ui.state.preview.payload.requestId;await create(f.target);assert.equal(f.target.querySelector('form'),null);assert.equal(f.ui.state.locked,false);
  await remount(f);assert.equal(reads,1);assert.equal(f.target.querySelector('textarea').value,body);preview(f.target);assert.notEqual(f.ui.state.preview.payload.requestId,original);await create(f.target);assert.equal(attempts,2);close(f);
});
test('unknown outcomes retain one immutable UUID and user body across private reads and later definitive errors',async()=>{
  let attempts=0;const sent=[];
  const f=await fixture({invoke:async(name,args)=>{if(name==='hub_detail')throw Error('404: private');sent.push(args.options);attempts++;if(attempts===1)throw Error('network timeout');if(attempts===2)throw Error('research_git_discuss_rejected:409:再確認');return {thread:{id:args.options.requestId}};}});
  writeDraft(f);const payload=f.ui.state.preview.payload;await create(f.target);assert.equal(f.target.querySelector('textarea').disabled,true);
  await remount(f,{prepared:undefined});assert.ok(f.target.querySelector('[data-research-git-discussion-create]'));assert.equal(f.ui.state.preview.payload,payload);assert.equal(f.ui.state.prepared,undefined);
  fill(f.target,'body','This programmatic change must never be sent');await create(f.target);assert.equal(f.ui.state.locked,true);assert.ok(!f.target.textContent.includes('research_git_discuss_rejected'));
  await create(f.target);assert.equal(f.ui.state.created.id,payload.requestId);assert.equal(sent.length,3);for(const item of sent)assert.equal(item,payload);assert.equal(sent[2].body,body);assert.equal(f.target.querySelector('[data-research-git-discussion-link]'),null);close(f);
});
test('a mismatched operation receipt stays unknown instead of linking or starting a new operation',async()=>{
  let attempt=0;const f=await fixture({invoke:async(_,args)=>({thread:{id:++attempt===1?'unexpected':args.options.requestId}})});writeDraft(f);const id=f.ui.state.preview.payload.requestId;await create(f.target);assert.equal(f.ui.state.created,undefined);assert.equal(f.ui.state.locked,true);assert.match(f.target.textContent,/作成結果が不明/);await create(f.target);assert.equal(f.ui.state.created.id,id);close(f);
});
test('dispose retains an in-flight creation and a newer renderer receives its result without a duplicate click',async()=>{
  const result=deferred();let writes=0;const f=await fixture({invoke:async(_,args)=>{writes++;return result.promise;}});
  writeDraft(f);const id=f.ui.state.preview.payload.requestId,pending=create(f.target),staleCreate=f.target.querySelector('[data-research-git-discussion-create]');await create(f.target);assert.equal(writes,1);
  await remount(f);assert.equal(f.target.querySelector('[data-research-git-discussion-create]').disabled,true);await staleCreate.onclick();assert.equal(writes,1);
  result.resolve({thread:{id}});await pending;assert.equal(f.ui.state.created.id,id);assert.equal(f.target.querySelector('[data-research-git-discussion-create]'),null);assert.equal(writes,1);close(f);
});
test('a creation completed while browsing away is kept for the pinned target on return',async()=>{
  const result=deferred(),f=await fixture({invoke:async()=>result.promise});writeDraft(f);const id=f.ui.state.preview.payload.requestId,pending=create(f.target);f.ui.dispose();f.target.replaceChildren();result.resolve({thread:{id}});await pending;assert.equal(f.ui.state.created.id,id);assert.equal(f.target.childElementCount,0);await remount(f);assert.match(f.target.textContent,/スレッドを作成/);assert.equal(f.target.querySelector('[data-research-git-discussion-create]'),null);close(f);
});
test('draft and reviewed payload survive commit browsing, while fresh metadata changes invalidate only unsent review',async()=>{
  const f=await fixture();fill(f.target,'title',title);fill(f.target,'body',body);await remount(f);assert.equal(f.target.querySelector('input').value,title);assert.equal(f.target.querySelector('textarea').value,body);preview(f.target);const id=f.ui.state.preview.payload.requestId;await remount(f);assert.equal(f.ui.state.preview.payload.requestId,id);
  for(const prepared of [{...data,source:{...source,projectTitle:'Renamed'}},{...data,canLink:false},{...data,boards:[{key:'general',title:'Renamed board'}]}]){await remount(f,{prepared:data});writeDraft(f);await remount(f,{prepared});assert.equal(f.ui.state.preview,undefined);assert.equal(f.target.querySelector('textarea').value,body);}
  close(f);
});
test('a definitive rejection after dispose still demands fresh preparation on the current renderer',async()=>{
  const result=deferred();let reads=0;const f=await fixture({invoke:async(name)=>name==='hub_detail'?(reads++,data):result.promise});writeDraft(f);const pending=create(f.target);await remount(f);result.reject(Error('research_git_discuss_rejected:400:再確認'));await pending;assert.equal(f.target.querySelector('form'),null);await remount(f);assert.equal(reads,1);assert.ok(f.target.querySelector('form'));close(f);
});
test('link completion after dispose is retained and link failure never recreates the thread',async()=>{
  const result=deferred();let links=0,reloads=0;const f=await fixture({invoke:async(_,args)=>args.action==='research_git_discuss'?{thread:{id:args.options.requestId}}:(links++,result.promise),reload:async()=>{reloads++;}});
  writeDraft(f);await create(f.target);const pending=link(f.target);f.ui.dispose();f.target.replaceChildren();result.resolve({});await pending;assert.equal(f.ui.state.linked,true);assert.equal(reloads,0);await remount(f);assert.equal(f.target.querySelector('[data-research-git-discussion-link]').disabled,true);assert.equal(links,1);close(f);
});
test('account invalidation clears Git-only state and ignores late read or write results',async()=>{
  const read=deferred(),dom=new JSDOM('<main></main>'),storage={gitBrowser:{query:'kept'},document:{body:'kept'}},ui=researchGitDiscussion(dom.window.document.querySelector('main'),ref,{state:storage,invoke:async()=>read.promise});dom.window.dispatchEvent(new dom.window.Event('hub-account-changed'));read.resolve(data);await ui.ready;assert.equal(ui.root.querySelector('form'),null);assert.deepEqual(storage.gitDiscussions,{});assert.deepEqual(storage.gitBrowser,{query:'kept'});ui.dispose();dom.window.close();
  const result=deferred(),f=await fixture({state:storage,invoke:async()=>result.promise});writeDraft(f);const pending=create(f.target);f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));result.resolve({thread:{id:f.ui.state.preview?.payload.requestId}});await pending;assert.equal(f.ui.state.created,undefined);assert.deepEqual(storage.gitDiscussions,{});assert.match(f.target.textContent,/接続が変わりました/);close(f);
});
test('explicit invalidate remains effective after dispose and clears other dormant pinned targets',async()=>{
  const result=deferred(),f=await fixture({invoke:async()=>result.promise});writeDraft(f);const id=f.ui.state.preview.payload.requestId,pending=create(f.target);f.ui.dispose();
  const long='c'.repeat(64),other=researchGitDiscussion(f.target,{projectId:p,oid:long},{state:f.state,prepared:{...data,source:{...source,oid:long,href:'/v2/research/'+p+'?commit='+long+'#git'}}});await other.ready;other.dispose();
  f.ui.invalidate();result.resolve({thread:{id}});await pending;assert.deepEqual(f.state.gitDiscussions,{});assert.equal(f.ui.state.created,undefined);close(f);
});
test('older readonly preparation cannot replace a new renderer source or permission',async()=>{
  const older=deferred(),dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),state={},first=researchGitDiscussion(target,ref,{state,invoke:async()=>older.promise});first.dispose();target.replaceChildren();
  const latest=researchGitDiscussion(target,ref,{state,prepared:{...data,source:{...source,projectTitle:'Latest'},canLink:false}});await latest.ready;older.resolve(data);await first.ready;assert.equal(latest.state.prepared.source.projectTitle,'Latest');assert.equal(latest.state.prepared.canLink,false);latest.dispose();dom.window.close();
});

test('preparation connection CTA is explicit, excludes suspended accounts, and preserves unknown retry',async()=>{
  for(const error of ['desktop_not_connected','ハブが 401 を返しています','ハブが 403 を返しています']){
    let connected=0;const f=await fixture({prepared:undefined,connectAccount:()=>{connected++;},invoke:async()=>{throw Error(error);}});
    assert.equal(connected,0);const connect=f.target.querySelector('[data-research-git-discussion-connect]');
    if(error.includes('403'))assert.equal(connect,null);else{assert.ok(connect);connect.click();assert.equal(connected,1);}
    close(f);
  }
  let connected=0;const f=await fixture({connectAccount:()=>{connected++;},invoke:async(name)=>{throw Error(name==='hub_detail'?'desktop_not_connected':'network timeout');}});
  writeDraft(f);const payload=f.ui.state.preview.payload;await create(f.target);await remount(f,{prepared:undefined});
  assert.equal(connected,0);assert.equal(f.ui.state.preview.payload,payload);assert.ok(f.target.querySelector('[data-research-git-discussion-create]'));
  f.target.querySelector('[data-research-git-discussion-connect]').click();assert.equal(connected,1);assert.equal(f.ui.state.preview.payload,payload);close(f);
});

