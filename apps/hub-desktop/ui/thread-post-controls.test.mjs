import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createThreadPostControls} from './thread-post-controls.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(setImmediate),settled=async()=>{await tick();await tick();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const viewerId='viewer-one',postId='post-one',origin='https://hub.example',deviceId='device-one',baseScope={key:JSON.stringify([origin,deviceId]),generation:1};
const post=extra=>({id:postId,viewerIsAuthor:false,canControlAuthor:true,viewerMuted:false,viewerBlocked:false,editedAt:null,...extra});
const receipt=control=>({viewerId,postId,control:{muted:false,blocked:false,...control}});
const revision=(index,extra={})=>({id:'revision-'+String(index).padStart(3,'0'),postId,body:'Synthetic body '+index,createdAt:'2026-10-07 00:00:'+String(index).padStart(2,'0'),editReason:'Synthetic reason',...extra});
const cursor=row=>Buffer.from(JSON.stringify({postId:row.postId,createdAt:row.createdAt,id:row.id})).toString('base64url');
function fixture(t,{input=post(),viewer=viewerId}={}){
 const dom=new JSDOM('<main></main>'),document=dom.window.document,f={dom,document,input,calls:[],changed:[],scope:{...baseScope},current:true,control:{muted:false,blocked:false},history:{viewerId,postId,revisions:[],nextCursor:null}};
 f.invoke=async(command,args)=>{f.calls.push({command,args:structuredClone(args)});if(f.handler)return f.handler(command,args);
  if(command==='hub_client_action'){f.control[args.options.kind==='mute'?'muted':'blocked']=args.options.enabled;return receipt(f.control);}
  return args.name==='thread_post_history'?structuredClone(f.history):receipt(f.control);};
 f.controller=createThreadPostControls({document,post:input,viewerId:viewer,invoke:(...args)=>f.invoke(...args),getScope:async()=>f.scope,isCurrent:()=>f.current,onChanged:value=>f.changed.push(value)});
 f.root=f.controller.element;document.querySelector('main').append(f.root);f.find=label=>[...f.root.querySelectorAll('button')].find(node=>node.textContent===label);f.click=async label=>{assert.ok(f.find(label),label);f.find(label).click();await settled();};
 f.open=async()=>{f.root.open=true;f.root.dispatchEvent(new dom.window.Event('toggle'));await settled();};t.after(()=>{f.controller.destroy();dom.window.close();});return f;
}
test('opening details only reads the closed relationship contract and never guesses owned incoming-block state',async t=>{
 const f=fixture(t,{input:post({viewerBlocked:true,viewerMuted:true})});assert.equal(f.calls.length,0);assert.equal(f.find('ミュート').disabled,true);await f.open();
 assert.deepEqual(f.calls,[{command:'hub_detail',args:{name:'thread_post_relationship',ids:[postId,deviceId,origin,viewerId]}}]);assert.equal(f.find('ブロック').disabled,false);assert.equal(f.find('ミュート').disabled,false);assert.equal(f.changed.length,0);
});
test('PUT uses explicit desired bool/scope then fresh GET; only verified state changes labels and notifies',async t=>{
 const f=fixture(t);await f.open();const gate=deferred();let mutated=false;
 f.handler=async(command,args)=>{if(command==='hub_client_action'){mutated=true;return receipt({muted:true});}await gate.promise;return receipt({muted:true});};
 f.find('ミュート').click();await tick();assert.equal(mutated,true);assert.equal(f.find('ミュート').disabled,true);assert.equal(f.changed.length,0);assert.equal(f.find('ミュートを解除'),undefined);
 gate.resolve();await settled();assert.equal(f.changed.length,1);assert.equal(f.find('ミュートを解除').disabled,false);
 assert.deepEqual(f.calls.find(call=>call.command==='hub_client_action').args,{action:'thread_post_relationship',target:postId,options:{kind:'mute',enabled:true,expectedDeviceId:deviceId,expectedOrigin:origin,expectedViewerId:viewerId}});
 assert.equal(f.calls.filter(call=>call.command==='hub_detail').length,2);
});
test('unknown mutation does not GET/replay automatically and explicit retry keeps the identical desired bool',async t=>{
 const f=fixture(t);await f.open();let writes=0;f.handler=async(command,args)=>{if(command==='hub_client_action'){writes++;if(writes===1)throw Error('lost');return receipt({blocked:true});}return receipt({blocked:true});};
 await f.click('ブロック');assert.equal(writes,1);assert.equal(f.calls.filter(call=>call.command==='hub_detail').length,1);assert.equal(f.changed.length,0);assert.equal(f.find('ミュート').disabled,true);
 await f.click('ブロックする操作を再試行');assert.equal(writes,2);assert.equal(f.changed.length,1);assert.deepEqual(f.calls.filter(call=>call.command==='hub_client_action').map(call=>call.args.options.enabled),[true,true]);
 assert.equal(f.find('ブロックを解除').disabled,false);
});
test('unknown write can be explicitly rechecked without a second mutation and no optimistic body access is inferred',async t=>{
 const f=fixture(t,{input:post({viewerBlocked:true})});await f.open();f.handler=async command=>{if(command==='hub_client_action')throw Error('lost');return receipt({blocked:true});};
 await f.click('ブロック');await f.click('状態を確認');assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);assert.equal(f.changed.length,1);assert.equal(f.input.viewerBlocked,true);assert.equal(f.find('ブロックを解除').disabled,false);
});
test('duplicate click/pending read and detached old buttons cannot send another mutation',async t=>{
 const f=fixture(t);await f.open();const old=f.find('ミュート'),gate=deferred();f.handler=async command=>{if(command==='hub_client_action')await gate.promise;return receipt({muted:true});};
 old.click();old.click();old.onclick();await tick();assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);gate.resolve();await settled();old.onclick();await settled();assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);
});
test('wrong viewer/post/extra field or nonboolean relationship prevents action and state adoption',async t=>{
 for(const value of [{...receipt(),viewerId:'other'},{...receipt(),postId:'other'},{...receipt(),authorId:'hidden'},receipt({muted:'true'}),{viewerId,postId,control:{muted:false,blocked:false,authorId:'hidden'}}]){
  const f=fixture(t);f.handler=async()=>value;await f.open();assert.equal(f.find('ミュート').disabled,true);assert.equal(f.changed.length,0);assert.equal(f.calls.some(call=>call.command==='hub_client_action'),false);
 }
});
test('PUT failure/GET mismatch retains desired intent without falsely claiming success',async t=>{
 for(const mode of ['put-mismatch','get-mismatch','get-failure']){const f=fixture(t);await f.open();f.handler=async command=>{if(command==='hub_client_action')return receipt({muted:mode!=='put-mismatch'});if(mode==='get-failure')throw Error('unavailable');return receipt();};
  await f.click('ミュート');assert.equal(f.changed.length,0);assert.ok(f.find('ミュートする操作を再試行'));assert.equal(f.find('ミュートを解除'),undefined);
 }
});
test('scope generation/device/origin changes during PUT refuse follow-up GET and old callback adoption',async t=>{
 for(const change of ['generation','device','origin']){const f=fixture(t);await f.open();const gate=deferred();f.handler=async()=>{await gate.promise;return receipt({muted:true});};
  f.find('ミュート').click();await tick();f.scope=change==='generation'?{...baseScope,generation:2}:{...baseScope,key:JSON.stringify([change==='origin'?'https://other.example':origin,change==='device'?'device-two':deviceId])};gate.resolve();await settled();assert.equal(f.changed.length,0);assert.equal(f.calls.filter(call=>call.command==='hub_detail').length,1);assert.equal(f.find('状態を確認').disabled,true);
 }
});
test('view/profile/post/dispose during pending read discard returned state and perform zero writes',async t=>{
 for(const change of ['view','post','destroy','disconnect']){const f=fixture(t),gate=deferred();f.handler=()=>gate.promise;f.root.open=true;f.root.dispatchEvent(new f.dom.window.Event('toggle'));await tick();
  if(change==='view')f.current=false;if(change==='post')f.input.id='other-post';if(change==='destroy')f.controller.destroy();if(change==='disconnect')f.root.remove();gate.resolve(receipt({muted:true}));await settled();assert.equal(f.changed.length,0);assert.equal(f.calls.some(call=>call.command==='hub_client_action'),false);
 }
});
test('anonymous/legacy/no-author capability never probes author ID or URL and hidden viewer can still unmute',async t=>{
 for(const input of [post({canControlAuthor:false}),post({viewerIsAuthor:undefined}),post({moderatedAt:'2026-10-07T00:00:00Z'}),post({deletedAt:'2026-10-07T00:00:00Z'})]){
  Object.defineProperty(input,'authorProfileId',{get(){throw Error('must not infer author');}});const f=fixture(t,{input});assert.equal(f.root.hidden,true);await f.open();assert.equal(f.calls.length,0);assert.equal(f.root.querySelector('a'),null);
 }
 const f=fixture(t,{input:post({viewerMuted:true,viewerBlocked:true})});f.control={muted:true,blocked:true};await f.open();await f.click('ミュートを解除');assert.equal(f.changed[0].control.muted,false);
});
test('actual deletedAt changes during a mutation drop its receipt without follow-up GET or new state',async t=>{
 const f=fixture(t);await f.open();const gate=deferred();f.handler=()=>gate.promise;f.find('ミュート').click();await tick();
 f.input.deletedAt='2026-10-07T00:00:00Z';gate.resolve(receipt({muted:true}));await settled();
 assert.equal(f.changed.length,0);assert.equal(f.calls.filter(call=>call.command==='hub_detail').length,1);assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);
});
test('self edited softdeleted history is available and literal body/reason cannot create HTML or IDs/URLs',async t=>{
 const f=fixture(t,{input:post({viewerIsAuthor:true,canControlAuthor:false,editedAt:'2026-10-07T00:00:00Z',deletedAt:'2026-10-07T00:00:00Z'})}),row=revision(5,{body:'<img src=x onerror=alert(1)> https://anonymous.invalid',editReason:'<script>bad()</script>'});f.history={viewerId,postId,revisions:[row],nextCursor:null};
 await f.open();assert.equal(f.calls.length,0);await f.click('編集履歴');assert.ok(f.root.textContent.includes(row.body));assert.ok(f.root.textContent.includes(row.editReason));assert.equal(f.root.querySelectorAll('img,a,script').length,0);assert.equal(f.root.textContent.includes(row.id),false);assert.equal(f.root.textContent.includes(viewerId),false);
 assert.deepEqual(f.calls[0].args,{name:'thread_post_history',ids:[postId,deviceId,origin,viewerId]});
});
test('five-row pages replace previous body, preserve raw timestamps/order, and use exact bounded cursor',async t=>{
 const f=fixture(t,{input:post({viewerIsAuthor:true,editedAt:'2026-10-07T00:00:00Z'})}),first=[10,9,8,7,6].map(index=>revision(index)),second=[5,4,3,2,1].map(index=>revision(index));
 f.history={viewerId,postId,revisions:first,nextCursor:cursor(first.at(-1))};await f.click('編集履歴');f.history={viewerId,postId,revisions:second,nextCursor:null};await f.click('古い履歴を表示');
 assert.equal(f.root.querySelectorAll('.detail-p').length,5);assert.equal(f.root.textContent.includes('Synthetic body 10'),false);assert.ok(f.root.textContent.includes('Synthetic body 1'));assert.equal(f.calls.at(-1).args.ids[4],cursor(first.at(-1)));assert.ok(f.find('最初の履歴へ'));
 f.history={viewerId,postId,revisions:first,nextCursor:cursor(first.at(-1))};await f.click('最初の履歴へ');assert.equal(f.calls.at(-1).args.ids.length,4);assert.ok(f.root.textContent.includes('Synthetic body 10'));
});
test('history pagination failure, duplicated IDs, samecursor and non-older tuple preserve the current page',async t=>{
 for(const mode of ['failure','duplicate','samecursor','not-older','empty-next']){const f=fixture(t,{input:post({viewerIsAuthor:true,editedAt:'2026-10-07T00:00:00Z'})}),row=revision(10);f.history={viewerId,postId,revisions:[row],nextCursor:cursor(row)};await f.click('編集履歴');
  if(mode==='failure')f.handler=async()=>{throw Error('unavailable');};else f.history={viewerId,postId,revisions:mode==='duplicate'?[row]:mode==='not-older'?[revision(11)]:mode==='empty-next'?[]:[revision(9)],nextCursor:mode==='samecursor'||mode==='empty-next'?cursor(row):null};
  await f.click('古い履歴を表示');assert.ok(f.root.textContent.includes(row.body));assert.equal(f.root.querySelectorAll('.detail-p').length,1);assert.ok(f.find('古い履歴を表示'));
 }
});
test('legacy history wider body/reason boundaries and five/six rows fail closed without truncation',async t=>{
 const f=fixture(t,{input:post({viewerIsAuthor:true,editedAt:'2026-10-07T00:00:00Z'})}),good=revision(5,{body:'😀'.repeat(20000),editReason:'😀'.repeat(300)});f.history={viewerId,postId,revisions:[good],nextCursor:null};await f.click('編集履歴');assert.equal(f.root.querySelector('.detail-p').textContent.length,40000);
 for(const rows of [[revision(5,{body:'😀'.repeat(20001)})],[revision(5,{editReason:'😀'.repeat(301)})],[revision(5,{body:'\ud800'})],[revision(5,{editReason:'\0'})],[revision(5,{createdAt:'invalid'})],[revision(5,{source:'private'})],[6,5,4,3,2,1].map(index=>revision(index))]){f.history={viewerId,postId,revisions:rows,nextCursor:null};await f.click('履歴を再取得');assert.equal(f.root.querySelector('.detail-p').textContent.length,40000);}
});
test('history cursor binds post/timestamp/id, rejects padding/oversize/badUTF8/unknown keys and empty continuation',async t=>{
 const row=revision(5),bad=[cursor({...row,postId:'other'}),cursor({...row,id:'different'}),cursor({...row,createdAt:'2026-10-07 00:00:06'}),cursor(row)+'=', 'a'.repeat(513),Buffer.from([255]).toString('base64url'),Buffer.from(JSON.stringify({postId,createdAt:row.createdAt,id:row.id,body:'private'})).toString('base64url')];
 for(const nextCursor of bad){const f=fixture(t,{input:post({viewerIsAuthor:true,editedAt:'2026-10-07T00:00:00Z'})});f.history={viewerId,postId,revisions:[row],nextCursor};await f.click('編集履歴');assert.equal(f.root.querySelector('.detail-p'),null);}
});
test('history scope switch erases previously loaded private bodies; late pagination never paints another card',async t=>{
 const f=fixture(t,{input:post({viewerIsAuthor:true,editedAt:'2026-10-07T00:00:00Z'})}),row=revision(5);f.history={viewerId,postId,revisions:[row],nextCursor:cursor(row)};await f.click('編集履歴');const gate=deferred();f.handler=()=>gate.promise;f.find('古い履歴を表示').click();await tick();f.scope={...baseScope,generation:2};gate.resolve({viewerId,postId,revisions:[revision(4)],nextCursor:null});await settled();assert.equal(f.root.querySelector('.detail-p'),null);assert.equal(f.changed.length,0);
});
test('no scope, malformed scope and wrong viewer inputs never mutate or bypass the fixed expected identity',async t=>{
 for(const scope of [null,{key:'bad',generation:1},{...baseScope,generation:-1},{key:JSON.stringify(['https://user:pass@hub.example',deviceId]),generation:1},{key:JSON.stringify([origin,deviceId+'\n']),generation:1}]){const f=fixture(t);f.scope=scope;await f.open();assert.equal(f.calls.length,0);}
 const f=fixture(t,{viewer:null});assert.equal(f.root.hidden,true);await f.open();assert.equal(f.calls.length,0);
});
test('history tie IDs follow raw ASCII SQL order and cross-page repeated IDs are rejected',async t=>{
 const f=fixture(t,{input:post({viewerIsAuthor:true,editedAt:'2026-10-07T00:00:00Z'})}),date='2026-10-07 00:00:05',first=revision(9,{createdAt:date}),second=revision(8,{createdAt:date});
 f.history={viewerId,postId,revisions:[first,second],nextCursor:cursor(second)};await f.click('編集履歴');assert.equal(f.root.querySelectorAll('.detail-p').length,2);
 f.history={viewerId,postId,revisions:[revision(9,{createdAt:'2026-10-07 00:00:04'})],nextCursor:null};await f.click('古い履歴を表示');assert.equal(f.root.querySelectorAll('.detail-p').length,2);
 f.history={viewerId,postId,revisions:[second,first],nextCursor:null};await f.click('履歴を再取得');assert.equal(f.root.querySelectorAll('.detail-p').length,2);
});
test('legacy history can proceed beyond 100 revisions with exactly five bodies retained at every page',async t=>{
 const f=fixture(t,{input:post({viewerIsAuthor:true,editedAt:'2026-10-07T00:00:00Z'})});
 const rows=Array.from({length:105},(_,index)=>revision(index+1,{id:'history-'+String(105-index).padStart(3,'0'),createdAt:'2026-10-07 00:00:00'}));
 f.handler=async(_command,args)=>{const start=args.ids.length===4?0:rows.findIndex(row=>cursor(row)===args.ids[4])+1,end=Math.min(rows.length,start+5);return {viewerId,postId,revisions:rows.slice(start,end),nextCursor:end<rows.length?cursor(rows[end-1]):null};};
 await f.click('編集履歴');for(let index=1;index<21;index++){await f.click('古い履歴を表示');assert.equal(f.root.querySelectorAll('.detail-p').length,5);}
 assert.equal(f.find('古い履歴を表示'),undefined);assert.ok(f.root.textContent.includes('21ページ'));assert.equal(f.calls.length,21);
});
test('Native origin 512 and ID128 boundaries are retained while origin513/ID129/control tails reject',async t=>{
 const limitOrigin='https://'+'a'.repeat(504),f=fixture(t);f.scope={key:JSON.stringify([limitOrigin,'d'.repeat(128)]),generation:1};await f.open();assert.equal(f.calls[0].args.ids[2],limitOrigin);
 for(const pair of [['https://'+'a'.repeat(505),deviceId],[origin,'d'.repeat(129)],[origin,deviceId+'\n']]){const f=fixture(t);f.scope={key:JSON.stringify(pair),generation:1};await f.open();assert.equal(f.calls.length,0);}
});
test('history body is collapsed by default, keeps the complete text, and uses standard summary disclosure',async t=>{
 const f=fixture(t,{input:post({viewerIsAuthor:true,editedAt:'2026-10-07T00:00:00Z'})}),body='😀'.repeat(20000);f.history={viewerId,postId,revisions:[revision(5,{body})],nextCursor:null};await f.click('編集履歴');
 const row=f.root.querySelector('section.card'),details=row.querySelector('details'),summary=details.querySelector('summary'),paragraph=details.querySelector('.detail-p');
 assert.equal(row.firstElementChild.className,'meta');assert.equal(details.open,false);assert.equal(summary.textContent,'編集前の本文を表示（20000文字）');assert.equal(paragraph.textContent,body);assert.ok(row.textContent.includes('編集理由: Synthetic reason'));
 summary.click();assert.equal(details.open,true);assert.equal(paragraph.textContent.length,40000);summary.click();assert.equal(details.open,false);assert.equal(paragraph.textContent,body);
});
