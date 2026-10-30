import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchProposalDiscussions} from './research-proposal-discussions.mjs';
const projectId='rp',proposalId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',linkId='bbbbbbbb-cccc-dddd-eeee-ffffffffffff',otherId='cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa',reference={projectId,proposalId};
const row=(overrides={})=>({linkId,threadId:'thread',linked:true,available:true,title:'<img>公開の議論😀',href:'/v2/threads/thread',...overrides});
const data=(links=[],canManage=true)=>({proposalId,canManage,links});
const ack=args=>({proposalId,threadId:args.options.threadId,linkId:args.options.requestId??args.options.linkId,linked:args.action==='research_proposal_link'});
const button=(root,label)=>[...root.querySelectorAll('button')].find(n=>n.textContent===label);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function fixture(options={},state={}){
  const dom=new JSDOM('<main></main>'),calls=[],invoke=options.invoke??(async(name,args)=>{calls.push({name,args});return name==='hub_detail'?data():ack(args);}),view=researchProposalDiscussions(dom.window.document.querySelector('main'),reference,{state,...options,invoke:async(name,args)=>name==='hub_origin'?(options.originError?Promise.reject(Error('origin unavailable')):options.origin??'https://hub.jkamma.com'):invoke(name,args)});await view.ready;return{...view,dom,state,calls};
}
function preview(root,value='https://hub.jkamma.com/v2/threads/thread'){
  const form=root.querySelector('form');form.elements.thread.value=value;form.elements.thread.dispatchEvent(new form.ownerDocument.defaultView.Event('input'));form.onsubmit({preventDefault(){}});
}
test('self-hosted thread URL must match captured Hub origin including port and canonical route',async()=>{
  for(const origin of ['https://community.example:8443','http://localhost:3020','http://127.0.0.1:3020','http://[::1]:3020']){
    for(const value of [`${origin}/v2/threads/thread`,`/v2/threads/thread`,`thread`]){const view=await fixture({origin});preview(view.root,value);assert.ok(button(view.root,'確認して関連付けを保存'));assert.equal(view.calls.length,1);view.dispose();view.dom.window.close();}
  }
  const origin='https://community.example:8443';
  for(const value of ['https://hub.jkamma.com/v2/threads/thread','https://community.example/v2/threads/thread','https://community.example:8444/v2/threads/thread','http://community.example:8443/v2/threads/thread','//community.example:8443/v2/threads/thread','https://user:pass@community.example:8443/v2/threads/thread','/v2/videos/thread','/v2/threads/a/../thread','/v2/threads/%74hread','/v2/threads/thread\\','thread\u0085','\ud800',' '+'x'.repeat(2048)]){const view=await fixture({origin});preview(view.root,value);assert.equal(button(view.root,'確認して関連付けを保存'),undefined,value);assert.equal(view.calls.length,1);view.dispose();view.dom.window.close();}
});
test('origin lookup failure or malformed origin rejects URLs while retaining bare ID confirmation',async()=>{
  for(const options of [{originError:true},{origin:'https://user:pass@community.example'},{origin:'http://remote.example'},{origin:'https://community.example/other'}]){
    for(const value of ['https://hub.jkamma.com/v2/threads/thread','/v2/threads/thread']){const view=await fixture(options);preview(view.root,value);assert.equal(button(view.root,'確認して関連付けを保存'),undefined);view.dispose();view.dom.window.close();}
    const view=await fixture(options);preview(view.root,'thread');assert.ok(button(view.root,'確認して関連付けを保存'));view.dispose();view.dom.window.close();
  }
});
test('hub origin is requested without caller metadata and late lookup cannot revive account-invalidated view',async()=>{
  const dom=new JSDOM('<main></main>'),pending=deferred(),calls=[],view=researchProposalDiscussions(dom.window.document.querySelector('main'),reference,{invoke:async(name,args)=>{calls.push({name,args});return name==='hub_origin'?pending.promise:data();}});await tick();assert.deepEqual(calls.find(call=>call.name==='hub_origin'),{name:'hub_origin',args:undefined});dom.window.dispatchEvent(new dom.window.Event('hub-account-changed'));pending.resolve('https://community.example:8443');await view.ready;assert.equal(view.root.querySelector('form,a'),null);assert.match(view.root.textContent,/接続が変わりました/);view.dispose();dom.window.close();
});

test('public linked threads are literal, removed rows hidden, unavailable records removable by owner, and reading opens no write',async()=>{
  const opened=[],view=await fixture({invoke:async()=>data([row(),row({linkId:otherId,threadId:'removed',linked:false,available:false,title:null,href:null}),row({linkId:proposalId,threadId:'unavailable',available:false,title:null,href:null})]),openThread:thread=>opened.push(thread)});
  assert.equal(view.root.querySelector('img'),null);assert.match(view.root.textContent,/<img>公開/);assert.doesNotMatch(view.root.textContent,/removed/);assert.equal(view.root.querySelectorAll('li').length,2);assert.equal(view.root.querySelectorAll('li button').length,2);
  view.root.querySelector('li a').click();assert.deepEqual(opened,[{id:'thread',title:'<img>公開の議論😀'}]);assert.match(view.root.textContent,/転記しません/);view.dispose();view.dom.window.close();
  const author=await fixture({invoke:async()=>data([row()],false)});assert.equal(author.root.querySelector('form'),null);assert.equal(author.root.querySelector('li button'),null);assert.ok(author.root.querySelector('li a'));author.dispose();author.dom.window.close();
});

test('link confirmation writes nothing and sends only exact IDs, request UUID and removed-row identity on explicit save',async()=>{
  const calls=[],view=await fixture({origin:'http://localhost:3020',invoke:async(name,args)=>{calls.push({name,args});return name==='hub_detail'?data([row({linked:false,available:false,title:null,href:null})]):ack(args);}});
  preview(view.root,'http://localhost:3020/threads/thread?from=read');assert.equal(calls.length,1);assert.equal(view.root.querySelector('li'),null);assert.ok(view.root.querySelector('[data-research-proposal-discussion-preview]'));assert.match(view.root.textContent,/本文や提案の理由は変更しません/);
  const save=button(view.root,'確認して関連付けを保存');await save.onclick();await save.onclick();assert.equal(calls.length,2);const args=calls[1].args;
  assert.equal(calls[1].name,'hub_client_action');assert.equal(args.action,'research_proposal_link');assert.equal(args.target,projectId);assert.deepEqual(Object.keys(args.options),['proposalId','requestId','threadId','expectedLinkId']);assert.equal(args.options.proposalId,proposalId);assert.equal(args.options.threadId,'thread');assert.equal(args.options.expectedLinkId,linkId);assert.match(args.options.requestId,/^[a-f0-9-]{36}$/);assert.match(view.root.textContent,/保存済み/);view.dispose();view.dom.window.close();
});

test('unknown link result survives remount and later conflict, keeps exact payload and blocks all other operations until replay',async()=>{
  const state={},writes=[];let attempt=0;
  const invoke=async(name,args)=>{if(name==='hub_detail')return data([row({threadId:'other',href:'/v2/threads/other'})]);writes.push(args);attempt++;if(attempt===1)throw Error('network');if(attempt===2)throw Error('research_proposal_link_rejected:409:old identity');return{...ack(args),linked:false};};
  const first=await fixture({invoke},state);preview(first.root,'thread');await button(first.root,'確認して関連付けを保存').onclick();assert.equal(first.root.querySelector('form'),null);assert.equal(button(first.root,'入力に戻る'),undefined);assert.equal(button(first.root,'関連付けを解除').disabled,true);first.dispose();
  const returned=await fixture({invoke},state);assert.ok(button(returned.root,'同じ関連操作の結果を確認する'));await button(returned.root,'同じ関連操作の結果を確認する').onclick();assert.equal(button(returned.root,'同じ関連操作の結果を確認する').disabled,true);await button(returned.root,'関連スレッドを再確認').onclick();await button(returned.root,'同じ関連操作の結果を確認する').onclick();
  assert.equal(writes.length,3);assert.deepEqual(writes[0],writes[1]);assert.deepEqual(writes[0],writes[2]);assert.match(returned.root.textContent,/すでに解除されています/);assert.equal(returned.root.querySelector('li code'),null);assert.equal(button(returned.root,'同じ関連操作の結果を確認する'),undefined);returned.dispose();first.dom.window.close();returned.dom.window.close();
});

test('pending mutation return syncs acknowledgement without a second save or old detached DOM changes',async()=>{
  const state={},pending=deferred(),writes=[],invoke=async(name,args)=>{if(name==='hub_detail')return data();writes.push(args);return pending.promise;};
  const first=await fixture({invoke},state);preview(first.root,'thread');button(first.root,'確認して関連付けを保存').click();await tick();first.dispose();const oldText=first.root.textContent;
  const returned=await fixture({invoke},state);assert.equal(button(returned.root,'確認して関連付けを保存').disabled,true);pending.resolve(ack(writes[0]));await tick();assert.equal(writes.length,1);assert.match(returned.root.textContent,/保存済み/);assert.equal(first.root.textContent,oldText);returned.dispose();first.dom.window.close();returned.dom.window.close();
});

test('permission loss clears cached title, inputs and unsent confirmation; readonly fresh response cannot manage',async()=>{
  let reads=0;const state={},view=await fixture({invoke:async()=>{reads++;if(reads===1)return data([row()]);if(reads===2)throw Error('ハブが 403 を返しています');return data([row({title:'NEW_TITLE'})],false);}},state);
  preview(view.root,'other');await button(view.root,'関連スレッドを再確認').onclick();assert.doesNotMatch(view.root.textContent,/<img>公開|other/);assert.doesNotMatch(JSON.stringify(state),/<img>公開|"input"|"operation"/);await button(view.root,'関連スレッドを再確認').onclick();assert.match(view.root.textContent,/NEW_TITLE/);assert.equal(view.root.querySelector('form'),null);assert.equal(button(view.root,'関連付けを解除'),undefined);view.dispose();view.dom.window.close();
});

test('malformed list identity, URL, title, booleans, duplicate rows and both payload bounds cannot render or manage',async()=>{
  const invalid=[{...data(),proposalId:otherId},{...data(),canManage:'yes'},data([row({linkId:linkId.toUpperCase()})]),data([row({threadId:'thread\n'})]),data([row({href:'javascript:alert(1)'})]),data([row({href:'/v2/threads/other'})]),data([row({title:'x'.repeat(241)})]),data([row({title:'\ud800'})]),data([row({title:'bad\u0000title'})]),data([row({available:false})]),data([row(),row()]),data(Array.from({length:101},()=>row())),{...data(),extra:'x'.repeat(512*1024)}];
  for(const value of invalid){const view=await fixture({invoke:async()=>value});assert.equal(view.root.querySelector('li,a,form'),null);assert.match(view.root.textContent,/内容を確認できません/);view.dispose();view.dom.window.close();}
  const maximum=await fixture({invoke:async()=>data(Array.from({length:100},(_,i)=>row({linkId:`${i.toString(16).padStart(8,'0')}-bbbb-cccc-dddd-eeeeeeeeeeee`,threadId:`t${i}`,href:`/v2/threads/t${i}`})))});assert.equal(maximum.root.querySelectorAll('li').length,100);maximum.dispose();maximum.dom.window.close();
});

test('thread input permits the captured Hub URL and bare IDs, and rejects foreign origin, credentials, schemes and oversized IDs',async()=>{
  for(const value of ['https://evil.test/v2/threads/t','https://user:pass@hub.jkamma.com/v2/threads/t','javascript:alert(1)','file:///v2/threads/t','https://hub.jkamma.com/v2/threads/a%2Fb','https://hub.jkamma.com/v2/threads/a%0Ab','x'.repeat(129),'https://hub.jkamma.com/v2/threads/thread?'+ 'x'.repeat(2048)]){const view=await fixture();preview(view.root,value);assert.equal(button(view.root,'確認して関連付けを保存'),undefined);assert.equal(view.calls.length,1);view.dispose();view.dom.window.close();}
  for(const [value,origin] of [['thread','https://hub.jkamma.com'],['https://hub.jkamma.com/v2/threads/thread/','https://hub.jkamma.com'],['http://127.0.0.1:3020/threads/thread','http://127.0.0.1:3020'],['/v2/threads/thread','https://community.example:8443']]){const view=await fixture({origin});preview(view.root,value);assert.ok(button(view.root,'確認して関連付けを保存'));assert.equal(view.calls.length,1);view.dispose();view.dom.window.close();}
});

test('wrong acknowledgement proposal/thread/link identity or unlink status keeps operation uncertain and pinned',async()=>{
  for(const change of [value=>({...value,proposalId:otherId}),value=>({...value,threadId:'other'}),value=>({...value,linkId:otherId}),value=>({...value,linked:'yes'})]){const writes=[],view=await fixture({invoke:async(name,args)=>{if(name==='hub_detail')return data();writes.push(args);return change(ack(args));}});preview(view.root,'thread');await button(view.root,'確認して関連付けを保存').onclick();assert.doesNotMatch(view.root.textContent,/保存済み/);await button(view.root,'同じ関連操作の結果を確認する').onclick();assert.deepEqual(writes[0],writes[1]);view.dispose();view.dom.window.close();}
  const view=await fixture({invoke:async(name,args)=>name==='hub_detail'?data([row()]):{...ack(args),linked:true}});button(view.root,'関連付けを解除').click();await button(view.root,'確認して関連付けを解除').onclick();assert.match(view.root.textContent,/操作結果が不明/);view.dispose();view.dom.window.close();
});

test('unavailable unlink confirms exact tombstone identity; stale unlink409 requires a fresh read and never removes replacement',async()=>{
  const writes=[];let reads=0;const view=await fixture({invoke:async(name,args)=>{if(name==='hub_detail'){reads++;return data([reads===1?row({available:false,title:null,href:null}):row({linkId:otherId,title:'RELINKED'})]);}writes.push(args);throw Error('research_proposal_unlink_rejected:409:関連付けは変わりました');}});
  button(view.root,'関連付けを解除').click();assert.equal(writes.length,0);await button(view.root,'確認して関連付けを解除').onclick();assert.deepEqual(writes[0],{action:'research_proposal_unlink',target:projectId,options:{proposalId,linkId,threadId:'thread'}});assert.equal(view.root.querySelector('li'),null);assert.equal(button(view.root,'同じ関連操作の結果を確認する'),undefined);
  await button(view.root,'関連スレッドを再確認').onclick();assert.match(view.root.textContent,/RELINKED/);button(view.root,'関連付けを解除').click();const operation=view.state.proposalDiscussions[JSON.stringify([projectId,proposalId])].operation;assert.equal(operation.options.linkId,otherId);assert.equal(writes.length,1);view.dispose();view.dom.window.close();
});

test('out-of-order reads ignore old responses and invalidate after disposal prevents late account mutation recovery',async()=>{
  const pending=deferred();let reads=0;const view=await fixture({invoke:async()=>data()});view.dispose();view.dom.window.close();
  const dom=new JSDOM('<main></main>'),state={documentDraft:'KEEP',proposalReviews:{pin:'KEEP'}},controller=researchProposalDiscussions(dom.window.document.querySelector('main'),reference,{state,invoke:async()=>{reads++;return reads===1?pending.promise:data([row({title:'CURRENT'})]);}});
  const second=button(controller.root,'関連スレッドを再確認').onclick();await second;pending.resolve(data([row({title:'OLD'})]));await controller.ready;assert.match(controller.root.textContent,/CURRENT/);assert.doesNotMatch(controller.root.textContent,/OLD/);controller.dispose();dom.window.close();
  const write=deferred(),writes=[],first=await fixture({invoke:async(name,args)=>{if(name==='hub_detail')return data();writes.push(args);return write.promise;}},state);preview(first.root,'thread');button(first.root,'確認して関連付けを保存').click();await tick();first.dispose();const old=first.root.textContent;first.dom.window.dispatchEvent(new first.dom.window.Event('hub-account-changed'));write.resolve(ack(writes[0]));await tick();assert.deepEqual(state.proposalDiscussions,{});assert.equal(state.documentDraft,'KEEP');assert.deepEqual(state.proposalReviews,{pin:'KEEP'});assert.equal(first.root.textContent,old);first.dom.window.close();
});

test('successful unavailable-thread unlink hides its record and a later link confirmation uses the exact removed ID',async()=>{
  const writes=[],view=await fixture({invoke:async(name,args)=>{if(name==='hub_detail')return data([row({available:false,title:null,href:null})]);writes.push(args);return ack(args);}});
  button(view.root,'関連付けを解除').click();const execute=button(view.root,'確認して関連付けを解除');await execute.onclick();await execute.onclick();assert.equal(writes.length,1);assert.equal(view.root.querySelector('li'),null);assert.match(view.root.textContent,/解除は保存済み/);
  preview(view.root,'thread');assert.equal(view.state.proposalDiscussions[JSON.stringify([projectId,proposalId])].operation.options.expectedLinkId,linkId);assert.equal(writes.length,1);view.dispose();view.dom.window.close();
});

test('uncertain mutation authority loss keeps only operation IDs, requires fresh owner authority, and readonly author cannot retry',async()=>{
  let attempts=0,reads=0;const writes=[],state={},view=await fixture({invoke:async(name,args)=>{if(name==='hub_detail'){reads++;return data([row({title:reads===1?'OLD_PUBLIC_TITLE':'CURRENT_TITLE'})],reads===1);}writes.push(args);attempts++;throw Error(attempts===1?'network':'research_proposal_link_rejected:403:権限がありません');}},state);
  preview(view.root,'other');await button(view.root,'確認して関連付けを保存').onclick();await button(view.root,'同じ関連操作の結果を確認する').onclick();assert.deepEqual(writes[0],writes[1]);assert.doesNotMatch(view.root.textContent,/OLD_PUBLIC_TITLE/);assert.doesNotMatch(JSON.stringify(state),/OLD_PUBLIC_TITLE|"input"/);assert.equal(button(view.root,'同じ関連操作の結果を確認する').disabled,true);
  await button(view.root,'関連スレッドを再確認').onclick();assert.match(view.root.textContent,/CURRENT_TITLE/);assert.equal(button(view.root,'同じ関連操作の結果を確認する').disabled,true);assert.equal(view.root.querySelector('form'),null);assert.equal(writes.length,2);view.dispose();view.dom.window.close();
});

test('unknown link or unlink followed by409 closes only after fresh replacement proof and explicit confirmation, with no extra POST',async()=>{
  for(const action of ['link','unlink']){const state={},writes=[];let reads=0;
    const view=await fixture({invoke:async(name,args)=>{if(name==='hub_detail'){reads++;return data(reads===1?(action==='link'?[]:[row()]):[row({linkId:otherId,title:'CURRENT_REPLACEMENT'})]);}writes.push(args);throw Error(writes.length===1?'network':`research_proposal_${action}_rejected:409:別の操作で更新されています`);}},state);
    if(action==='link')preview(view.root,'thread');else button(view.root,'関連付けを解除').click();
    await button(view.root,action==='link'?'確認して関連付けを保存':'確認して関連付けを解除').onclick();
    await button(view.root,'同じ関連操作の結果を確認する').onclick();assert.equal(button(view.root,'現在の関連を確認して操作を閉じる'),undefined);assert.deepEqual(writes[0],writes[1]);
    await button(view.root,'関連スレッドを再確認').onclick();assert.match(view.root.textContent,/CURRENT_REPLACEMENT/);const close=button(view.root,'現在の関連を確認して操作を閉じる');assert.ok(close);assert.match(view.root.textContent,/現在の状態を確認して、以前の操作を閉じます。再送しません/);assert.equal(writes.length,2);
    close.click();assert.equal(writes.length,2);assert.equal(button(view.root,'同じ関連操作の結果を確認する'),undefined);assert.match(view.root.textContent,/現在の関連付けは変更していません/);assert.match(view.root.textContent,/CURRENT_REPLACEMENT/);button(view.root,'関連付けを解除').click();const current=state.proposalDiscussions[JSON.stringify([projectId,proposalId])].operation;assert.equal(current.options.linkId,otherId);assert.equal(writes.length,2);view.dispose();view.dom.window.close();
  }
});

test('same-generation or failed reread offers no close operation and retains exact unknown request',async()=>{
  for(const mode of ['same','503']){const state={},writes=[];let reads=0;
    const view=await fixture({invoke:async(name,args)=>{if(name==='hub_detail'){reads++;if(reads===1)return data();if(mode==='503')throw Error('ハブが 503 を返しています');return data([row({linkId:writes[0].options.requestId,threadId:'thread',linked:false,available:false,title:null,href:null})]);}writes.push(args);throw Error(writes.length===1?'network':'research_proposal_link_rejected:409:確認してください');}},state);
    preview(view.root,'thread');await button(view.root,'確認して関連付けを保存').onclick();await button(view.root,'同じ関連操作の結果を確認する').onclick();await button(view.root,'関連スレッドを再確認').onclick();assert.equal(button(view.root,'現在の関連を確認して操作を閉じる'),undefined);assert.equal(view.root.querySelector('form'),null);assert.deepEqual(state.proposalDiscussions[JSON.stringify([projectId,proposalId])].operation.options,writes[0].options);assert.equal(writes.length,2);view.dispose();view.dom.window.close();
  }
});

test('closure requires a current owner row and rejects captured controls during reread or after account invalidation',async()=>{
  const state={},writes=[],pending=deferred();let reads=0;
  const view=await fixture({invoke:async(name,args)=>{if(name==='hub_detail'){reads++;if(reads===1)return data([row()]);if(reads===3)return pending.promise;return data([row({linkId:otherId,title:'REPLACED'})]);}writes.push(args);throw Error(writes.length===1?'network':'research_proposal_unlink_rejected:409:changed');}},state);
  button(view.root,'関連付けを解除').click();await button(view.root,'確認して関連付けを解除').onclick();await button(view.root,'同じ関連操作の結果を確認する').onclick();await button(view.root,'関連スレッドを再確認').onclick();const close=button(view.root,'現在の関連を確認して操作を閉じる');const reading=button(view.root,'関連スレッドを再確認').onclick();close.click();assert.ok(state.proposalDiscussions[JSON.stringify([projectId,proposalId])].operation);pending.resolve(data([row({linkId:otherId})],false));await reading;assert.equal(button(view.root,'現在の関連を確認して操作を閉じる'),undefined);assert.equal(writes.length,2);
  await button(view.root,'関連スレッドを再確認').onclick();const activeClose=button(view.root,'現在の関連を確認して操作を閉じる');view.invalidate();activeClose.click();assert.deepEqual(state.proposalDiscussions,{});assert.equal(writes.length,2);view.dispose();view.dom.window.close();
});

test('unknown relink keeps removed expected generation pinned until a different fresh generation is confirmed',async()=>{
  const writes=[];let reads=0;
  const view=await fixture({invoke:async(name,args)=>{if(name==='hub_detail'){reads++;return data([row(reads<3?{linked:false,available:false,title:null,href:null}:{linkId:otherId,title:'FRESH_GENERATION'})]);}writes.push(args);throw Error(writes.length===1?'network':'research_proposal_link_rejected:409:確認してください');}});
  preview(view.root,'thread');await button(view.root,'確認して関連付けを保存').onclick();await button(view.root,'同じ関連操作の結果を確認する').onclick();assert.equal(writes[0].options.expectedLinkId,linkId);assert.notEqual(writes[0].options.requestId,linkId);assert.deepEqual(writes[0],writes[1]);
  await button(view.root,'関連スレッドを再確認').onclick();assert.equal(button(view.root,'現在の関連を確認して操作を閉じる'),undefined);assert.ok(button(view.root,'同じ関連操作の結果を確認する'));assert.equal(view.root.querySelector('form'),null);assert.equal(writes.length,2);
  await button(view.root,'関連スレッドを再確認').onclick();assert.match(view.root.textContent,/FRESH_GENERATION/);const close=button(view.root,'現在の関連を確認して操作を閉じる');assert.ok(close);assert.equal(writes.length,2);close.click();assert.equal(writes.length,2);assert.equal(button(view.root,'同じ関連操作の結果を確認する'),undefined);assert.match(view.root.textContent,/FRESH_GENERATION/);view.dispose();view.dom.window.close();
});
