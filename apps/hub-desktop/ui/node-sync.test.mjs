import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createNodeSync} from './node-sync.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const context='a'.repeat(64),fingerprint='A'.repeat(43);
const target=(number=1,status='waiting')=>({peerId:'peer-'+String(number).padStart(64,'0'),nodeUrl:`https://node${number}.example/`,keyThumbprint:fingerprint,status});
const item=(sequence=1,targets=[target()])=>({sequence,contentId:'urn:hub:content:'+String(sequence).padStart(32,'0'),portableEventId:'event:'+String(sequence).padStart(32,'0'),bodyPreview:'公開原本\n本文',truncated:false,targets});
const preview=(extra={})=>({context,items:[item()],page:{cursor:0,nextCursor:null,truncated:false,scanned:1},queued:1,excluded:0,...extra});
const state=(extra={})=>({nodeId:'b'.repeat(32),deviceName:'PC',enabled:true,launchAtLogin:false,storagePath:'C:/synthetic',hubUrl:'https://hub.example',syncState:'ready',publicKeyJwk:null,keyThumbprint:null,lastSyncAt:123,queuedItems:0,...extra});
const receipt=(input,extra={})=>({context:input.context,sequence:input.sequence,portableEventId:input.portableEventId,peerId:input.peerId,status:'accepted',complete:true,state:state({lastSyncConfirmed:true}),...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,handler){
  const dom=new JSDOM('<body></body>'),calls=[],states=[],inspected=[];let current=true,main=true;
  const invoke=async(command,args)=>{calls.push({command,args:structuredClone(args)});assert.equal(command,'node_sync_control');return handler?handler(args):args.action==='preview'?preview():receipt(args.input);};
  const api=createNodeSync({document:dom.window.document,invoke,isMain:()=>main,isCurrent:()=>current,onState:value=>states.push(value),onInspectOriginal:sequence=>inspected.push(sequence)});dom.window.document.body.append(api.element);
  const button=label=>[...api.element.querySelectorAll('button')].find(node=>node.textContent===label),status=()=>api.element.querySelector('[role="status"]').textContent;
  t.after(()=>{api.destroy();dom.window.close();});return{api,dom,calls,states,inspected,button,status,current:value=>current=value,main:value=>main=value};
}
test('initial preview is readonly, shows every approved URL/fingerprint/status and original preview safely',async t=>{
  const data=preview({items:[{...item(1,[target(1),target(2,'unconfirmed'),target(3,'unavailable'),target(4,'accepted')]),bodyPreview:'<img src=x onerror=alert(1)>',truncated:true}]});
  const f=fixture(t,args=>args.action==='preview'?data:receipt(args.input));await f.api.ready;assert.deepEqual(f.calls,[{command:'node_sync_control',args:{action:'preview',cursor:0}}]);assert.equal(f.states.length,0);
  for(const value of ['https://node1.example/','https://node4.example/',fingerprint,'未送信','受領未確認','利用できない宛先','受領確認済み','先頭300文字'])assert.ok(f.api.element.textContent.includes(value));
  assert.equal(f.api.element.querySelector('img'),null);f.button('原本を確認').click();assert.deepEqual(f.inspected,[1]);assert.ok([...f.api.element.querySelectorAll('button')].every(node=>node.type==='button'));
  data.items[0].targets[0].nodeUrl='https://changed.example/';f.button('確認した宛先へ送る').click();await tick();assert.equal(f.calls[1].args.input.nodeUrl,'https://node1.example/');
});
test('explicit page delivery is serial, double click suppressed, only eligible targets sent and actual matching state passed',async t=>{
  let active=0,maximum=0,writes=0;const data=preview({items:[item(1,[target(1),target(2,'unconfirmed'),target(3,'unavailable'),target(4,'accepted')])]});
  const f=fixture(t,async args=>{if(args.action==='preview')return data;active++;maximum=Math.max(maximum,active);await tick();active--;writes++;return receipt(args.input,{complete:false,state:state()});});await f.api.ready;
  f.button('確認した宛先へ送る').click();f.button('確認した宛先へ送る').click();await tick();await tick();await tick();assert.equal(writes,2);assert.equal(maximum,1);assert.equal(f.states.length,2);assert.equal(f.states[0].lastSyncConfirmed,undefined);
  assert.deepEqual(f.calls.filter(call=>call.args.action==='deliver').map(call=>call.args.input.peerId),[target(1).peerId,target(2).peerId]);
  assert.deepEqual(Object.keys(f.calls[1].args.input),['context','sequence','portableEventId','peerId','nodeUrl','keyThumbprint','confirmed']);assert.equal(f.calls[1].args.input.confirmed,true);assert.match(f.status(),/対象外.*他ページ/);assert.doesNotMatch(f.status(),/全同期完了/);
});
test('unknown or partial failure stops later jobs and pages; only a fresh same-target receipt unlocks manual continuation',async t=>{
  let reads=0,writes=0,proofs=0;const makePage=status=>preview({items:[item(1,[target(1,status),target(2)])],page:{cursor:0,nextCursor:2,truncated:true,scanned:1}});
  const f=fixture(t,args=>{if(args.action==='preview')return makePage(++reads===1?'unconfirmed':'accepted');if(args.action==='receipt')return receipt(args.input,{status:++proofs===1?'unknown':'already_accepted',complete:false});if(++writes===1)return receipt(args.input,{status:'unknown',complete:false});return receipt(args.input);});await f.api.ready;
  f.button('確認した宛先へ送る').click();await tick();assert.equal(writes,1);assert.equal(f.states.length,0);assert.match(f.status(),/結果は不明/);assert.equal(f.button('次のページを確認').disabled,true);assert.equal(f.button('確認した宛先へ送る').disabled,true);
  f.button('受領状態を再確認').click();await tick();assert.equal(writes,1);assert.match(f.status(),/まだ確認できません/);assert.equal(f.button('確認した宛先へ送る').disabled,true);
  f.button('受領状態を再確認').click();await tick();assert.match(f.status(),/先ほどの宛先の受領を確認/);assert.equal(f.states.length,1);assert.equal(writes,1);assert.equal(proofs,2);
  f.button('確認した宛先へ送る').click();await tick();assert.equal(writes,2);assert.equal(f.calls.at(-1).args.input.peerId,target(2).peerId);
});
test('a known accepted target followed by transport loss keeps partial evidence and stops all remaining jobs',async t=>{
  let writes=0;const f=fixture(t,args=>{if(args.action==='preview')return preview({items:[item(1,[target(1),target(2),target(3)])]});if(++writes===2)throw Error('offline');return receipt(args.input,{complete:false});});await f.api.ready;f.button('確認した宛先へ送る').click();await tick();assert.equal(writes,2);assert.equal(f.states.length,1);assert.match(f.status(),/1件の受領.*結果は不明/);assert.equal(f.button('確認した宛先へ送る').disabled,true);
});
test('queued already-received originals reconcile one cached target explicitly without claiming new delivery; complete prevents repeat',async t=>{
  const f=fixture(t,args=>args.action==='preview'?preview({items:[item(1,[target(1,'accepted'),target(2,'accepted')])]}):receipt(args.input,{status:'already_accepted'}));await f.api.ready;
  assert.equal(f.states.length,0);assert.equal(f.button('受領記録を反映').disabled,false);f.button('受領記録を反映').click();await tick();assert.equal(f.calls.filter(call=>call.args.action==='deliver').length,1);assert.equal(f.states.length,1);assert.equal(f.button('確認した宛先へ送る').disabled,true);
});
test('mixed page labels cached reconciliation separately and complete skips remaining targets for that original',async t=>{
  const f=fixture(t,args=>args.action==='preview'?preview({items:[item(1,[target(1,'accepted')]),item(2,[target(2),target(3)])],page:{cursor:0,nextCursor:null,truncated:false,scanned:2},queued:2}):receipt(args.input,{status:args.input.sequence===1?'already_accepted':'accepted'}));await f.api.ready;
  f.button('確認した配信先と受領記録を処理').click();await tick();assert.equal(f.calls.filter(call=>call.args.action==='deliver').length,2);assert.deepEqual(f.states.map(value=>value.queuedItems),[0,0]);assert.equal(f.calls.at(-1).args.input.peerId,target(2).peerId);
});
test('empty, no-plan and unavailable rows never perform delivery or claim global completion',async t=>{
  for(const data of [preview({items:[],queued:0,page:{cursor:0,nextCursor:null,truncated:false,scanned:0}}),preview({items:[item(1,[])]}),preview({items:[item(1,[target(1,'unavailable')])]})]){
    const f=fixture(t,()=>data);await f.api.ready;assert.equal(f.button('確認した宛先へ送る').disabled,true);f.button('確認した宛先へ送る').click();assert.equal(f.calls.length,1);assert.equal(f.states.length,0);assert.doesNotMatch(f.status(),/全体の同期が完了/);}
});
test('pages are explicit inclusive cursor reads and cannot advance during a pending send',async t=>{
  let finish;const gate=new Promise(resolve=>finish=resolve),f=fixture(t,args=>args.action==='preview'?preview({items:[item(args.cursor||1)],page:{cursor:args.cursor,nextCursor:args.cursor===0?2:null,truncated:args.cursor===0,scanned:1}}):gate);await f.api.ready;
  f.button('次のページを確認').click();await tick();assert.equal(f.calls[1].args.cursor,2);assert.ok(f.api.element.textContent.includes('原本 2'));f.button('確認した宛先へ送る').click();assert.equal(f.button('次のページを確認').disabled,true);finish(receipt(f.calls.at(-1).args.input));await tick();assert.equal(f.states.length,1);
});
test('preview limits, Unicode scalar widths, IDs/private metadata and URL credentials fail closed before rendering',async t=>{
  const bad=[preview({context:'A'.repeat(64)}),preview({queued:-1}),preview({excluded:Number.MAX_SAFE_INTEGER+1}),preview({items:Array.from({length:17},(_,i)=>item(i+1)),page:{cursor:0,nextCursor:null,truncated:false,scanned:17}}),
    preview({items:[item(1,Array.from({length:9},(_,i)=>target(i+1)))]}),preview({items:[{...item(),sequence:0}]}),preview({items:[{...item(),bodyPreview:'😀'.repeat(301)}]}),preview({items:[{...item(),bodyPreview:'\ud800'}]}),preview({items:[{...item(),bodyPreview:'\udfff'}]}),preview({items:[{...item(),bodyPreview:'\0'}]}),preview({items:[{...item(),portableEventId:'event:x'}]}),preview({items:[{...item(),contentId:item().contentId+'\n'}]}),preview({items:[item(1,[{...target(),keyThumbprint:'B'.repeat(43)}])]}),preview({items:[item(1,[{...target(),nodeUrl:'https://user:secret@node.example/'}])]}),preview({items:[item(1,[{...target(),nodeUrl:'http://node.example/'}])]}),preview({privateKey:'secret'}),preview({items:[{...item(),privateBody:'secret'}]}),preview({page:{cursor:0,nextCursor:0,truncated:true,scanned:1}}),preview({page:{cursor:0,nextCursor:null,truncated:false,scanned:513}})];
  for(const data of bad){const f=fixture(t,()=>data);await f.api.ready;assert.match(f.status(),/取得できません/);assert.equal(f.api.element.querySelector('article'),null);assert.equal(f.button('確認した宛先へ送る').disabled,true);assert.equal(f.states.length,0);}
  const f=fixture(t,()=>preview({items:[{...item(),bodyPreview:'😀'.repeat(300),truncated:true}]}));await f.api.ready;assert.equal(f.api.element.querySelectorAll('article').length,1);
});
test('max page 16 originals/8 targets/scanned512 and safe integer fields are accepted without eager writes',async t=>{
  const data=preview({items:Array.from({length:16},(_,i)=>item(i+1,Array.from({length:8},(_,j)=>target(j+1)))),page:{cursor:0,nextCursor:Number.MAX_SAFE_INTEGER,truncated:true,scanned:512},queued:Number.MAX_SAFE_INTEGER,excluded:Number.MAX_SAFE_INTEGER});
  const f=fixture(t,()=>data);await f.api.ready;assert.equal(f.api.element.querySelectorAll('article').length,16);assert.equal(f.calls.length,1);assert.equal(f.states.length,0);assert.equal(f.button('次のページを確認').disabled,false);
});
test('reply context/original/peer mismatch and secret state never callback or continue sending',async t=>{
  for(const corruption of [r=>r.context='c'.repeat(64),r=>r.sequence=2,r=>r.portableEventId='event:'+'f'.repeat(32),r=>r.peerId=target(2).peerId,r=>r.status='ready',r=>r.complete='true',r=>r.state.privateKey='secret',r=>r.state.publicKeyJwk={kty:'EC',crv:'P-256',x:fingerprint,y:fingerprint,d:'secret'},r=>r.state.lastSyncConfirmed='true']){
    const f=fixture(t,args=>{if(args.action==='preview')return preview({items:[item(1,[target(1),target(2)])]});const value=receipt(args.input);corruption(value);return value;});await f.api.ready;f.button('確認した宛先へ送る').click();await tick();assert.equal(f.states.length,0);assert.equal(f.calls.filter(call=>call.args.action==='deliver').length,1);assert.match(f.status(),/結果は不明/);}
});
test('old legacy timestamp state is only passed after matching receipt and never itself treated as confirmation',async t=>{
  const f=fixture(t,args=>args.action==='preview'?preview():receipt(args.input,{state:state({lastSyncAt:9999})}));await f.api.ready;assert.equal(f.states.length,0);f.button('確認した宛先へ送る').click();await tick();assert.equal(f.states.length,1);assert.equal(f.states[0].lastSyncConfirmed,undefined);assert.equal(f.states[0].lastSyncAt,9999);
});
test('failed fresh read disables old displayed plan, and changed unknown context never clears the delivery lock',async t=>{
  let reads=0;const f=fixture(t,args=>{if(args.action==='preview'){if(++reads===2)throw Error('offline');return preview();}return receipt(args.input);});await f.api.ready;f.button('受領状態を再確認').click();await tick();assert.equal(f.button('確認した宛先へ送る').disabled,true);assert.equal(f.api.element.querySelectorAll('article').length,1);
  const g=fixture(t,args=>args.action==='preview'?preview():args.action==='receipt'?receipt(args.input,{context:'d'.repeat(64),status:'already_accepted'}):receipt(args.input,{status:'unknown',complete:false}));await g.api.ready;g.button('確認した宛先へ送る').click();await tick();g.button('受領状態を再確認').click();await tick();assert.match(g.status(),/受領証拠を確認できません/);assert.equal(g.button('確認した宛先へ送る').disabled,true);assert.equal(g.states.length,0);
});
test('destroy or view/main generation loss discards late reads and deliveries and never starts another job',async t=>{
  for(const phase of ['preview','deliver']){let finish;const gate=new Promise(resolve=>finish=resolve),f=fixture(t,args=>args.action===phase?gate:preview({items:[item(1,[target(1),target(2)])]}));
    if(phase==='deliver'){await f.api.ready;f.button('確認した宛先へ送る').click();await tick();}
    else await tick();const button=f.button('確認した宛先へ送る');f.api.destroy();finish(phase==='preview'?preview():receipt(f.calls.at(-1).args.input));await tick();button.click();assert.equal(f.states.length,0);assert.equal(f.api.element.isConnected,false);assert.equal(f.calls.filter(call=>call.args.action==='deliver').length,phase==='deliver'?1:0);}
  const f=fixture(t);f.main(false);await f.api.ready;assert.equal(f.calls.length,0);
  let finish;const gate=new Promise(resolve=>finish=resolve),g=fixture(t,args=>args.action==='preview'?preview():gate);await g.api.ready;g.button('確認した宛先へ送る').click();g.current(false);finish(receipt(g.calls.at(-1).args.input));await tick();assert.equal(g.states.length,0);assert.equal(g.calls.length,2);
});
test('lost delivery reply reconciles a disappeared delivered original using readonly exact receipt proof only',async t=>{
  let delivered=false;const f=fixture(t,args=>{
    if(args.action==='preview')return delivered?preview({items:[],page:{cursor:0,nextCursor:null,truncated:false,scanned:1},queued:0}):preview();
    if(args.action==='deliver'){delivered=true;throw Error('lost native reply');}
    assert.equal(args.action,'receipt');assert.equal(args.input.confirmed,false);return receipt(args.input,{status:'already_accepted',state:state({lastSyncConfirmed:true})});
  });await f.api.ready;f.button('確認した宛先へ送る').click();await tick();assert.equal(f.states.length,0);assert.match(f.status(),/結果は不明/);
  f.button('受領状態を再確認').click();await tick();assert.deepEqual(f.calls.map(call=>call.args.action),['preview','deliver','receipt','preview']);
  assert.deepEqual(f.calls[2].args.input,{...f.calls[1].args.input,confirmed:false});assert.equal(f.states.length,1);assert.equal(f.states[0].lastSyncConfirmed,true);assert.equal(f.api.element.querySelectorAll('article').length,0);
  assert.match(f.status(),/受領を確認しました/);assert.equal(f.button('確認した宛先へ送る').disabled,true);assert.equal(f.calls.filter(call=>call.args.action==='deliver').length,1);
});
test('readonly receipt without proof never resends or treats missing preview rows as accepted',async t=>{
  const f=fixture(t,args=>args.action==='preview'?preview():receipt(args.input,{status:'unknown',complete:false}));await f.api.ready;f.button('確認した宛先へ送る').click();await tick();
  f.button('受領状態を再確認').click();await tick();assert.deepEqual(f.calls.map(call=>call.args.action),['preview','deliver','receipt']);assert.equal(f.calls[2].args.input.confirmed,false);assert.equal(f.states.length,0);assert.match(f.status(),/まだ確認できません/);
  assert.equal(f.button('確認した宛先へ送る').disabled,true);assert.equal(f.button('次のページを確認').disabled,true);
});
test('forged readonly receipt IDs, fresh-delivery status and private metadata cannot release unknown state',async t=>{
  for(const corruption of [r=>r.context='b'.repeat(64),r=>r.sequence=2,r=>r.portableEventId='event:'+'f'.repeat(32),r=>r.peerId=target(2).peerId,r=>r.status='accepted',r=>r.state.privateKey='secret']){
    const f=fixture(t,args=>{if(args.action==='preview')return preview();if(args.action==='deliver')return receipt(args.input,{status:'unknown',complete:false});const value=receipt(args.input,{status:'already_accepted'});corruption(value);return value;});await f.api.ready;
    f.button('確認した宛先へ送る').click();await tick();f.button('受領状態を再確認').click();await tick();assert.equal(f.states.length,0);assert.match(f.status(),/受領証拠を確認できません/);assert.equal(f.button('確認した宛先へ送る').disabled,true);assert.equal(f.calls.length,3);
  }
});
test('pending readonly proof suppresses double clicks and disposal prevents callbacks or follow-up preview',async t=>{
  let finish;const gate=new Promise(resolve=>finish=resolve),f=fixture(t,args=>args.action==='preview'?preview():args.action==='deliver'?receipt(args.input,{status:'unknown',complete:false}):gate);await f.api.ready;
  f.button('確認した宛先へ送る').click();await tick();f.button('受領状態を再確認').click();f.button('受領状態を再確認').click();assert.equal(f.calls.filter(call=>call.args.action==='receipt').length,1);
  f.api.destroy();finish(receipt(f.calls.at(-1).args.input,{status:'already_accepted'}));await tick();assert.equal(f.states.length,0);assert.equal(f.calls.length,3);assert.equal(f.api.element.isConnected,false);
});

test('all-accepted recovery remains explicitly actionable after chain reaches zero pending',async t=>{
  const f=fixture(t,args=>args.action==='preview'?preview({items:[item(1,[target(1,'accepted')])],queued:0}):receipt(args.input,{status:'already_accepted'}));
  await f.api.ready;assert.equal(f.calls.length,1);assert.equal(f.button('受領記録を反映').disabled,false);
  f.button('受領記録を反映').click();await tick();assert.equal(f.calls.filter(call=>call.args.action==='deliver').length,1);
  assert.equal(f.calls.at(-1).args.input.confirmed,true);assert.equal(f.states.length,1);
  assert.equal(f.button('確認した宛先へ送る').disabled,true);assert.match(f.status(),/全体|このページ/);
});
