import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createOwnedEventListings} from './owned-event-listings.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(setImmediate),settled=async()=>{await tick();await tick();},deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const viewerId='viewer-one',origin='https://hub.example',device='device-one',scope={key:JSON.stringify([origin,device]),generation:1};
const row=(index=1,extra={})=>({id:'event-'+String(index).padStart(3,'0'),title:'Synthetic event '+index,kind:'events',status:'published',providerLabel:'Synthetic provider',providerUrl:'https://provider.example/events/'+index,startsAt:null,updatedAt:'2026-10-07T00:00:00.000Z',cancelledAt:null,cancellationReason:null,...extra});
const cursor=listing=>Buffer.from(JSON.stringify({updatedAt:listing.updatedAt,id:listing.id})).toString('base64url');
function fixture(t,{items=[row(),row(2)]}={}){const dom=new JSDOM('<main></main>'),document=dom.window.document,f={dom,document,calls:[],opens:[],items,scope:{...scope},current:true,next:null,handler:null};
 f.invoke=async(command,args)=>{f.calls.push({command,args:structuredClone(args)});if(f.handler)return f.handler(command,args);
  if(command==='hub_client_action'){f.items=f.items.map(item=>item.id===args.target?{...item,cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:args.text}:item);return {viewerId,listing:f.items.find(item=>item.id===args.target)};}
  return args.name==='owned_event_listings'?{viewerId,listings:structuredClone(f.items),nextCursor:f.next}:{viewerId,listing:structuredClone(f.items.find(item=>item.id===args.ids[0]))};};
 f.controller=createOwnedEventListings({document,invoke:(...args)=>f.invoke(...args),getScope:async()=>f.scope,isCurrent:()=>f.current,onOpen:async url=>{f.opens.push(url);return f.openResult;}});f.root=f.controller.element;document.querySelector('main').append(f.root);f.root.open=true;
 f.find=label=>[...f.root.querySelectorAll('button')].find(button=>button.textContent===label);f.click=async label=>{assert.ok(f.find(label),label);f.find(label).click();await settled();};
 f.choose=async(index=0)=>{f.root.querySelectorAll('.result-grid button')[index].click();await settled();};f.reason=value=>{const input=f.root.querySelector('textarea');input.value=value;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 t.after(()=>{f.controller.destroy();dom.window.close();});return f;
}
async function prepared(t,options){const f=fixture(t,options);await f.controller.ready;await f.choose();f.reason('  Synthetic\n  cancellation reason ');await f.click('掲載取消の内容を確認');return f;}
test('initial owned list is readonly, fixed scope-only wire, with explicit Hub-only copy',async t=>{
 const f=fixture(t);await f.controller.ready;assert.deepEqual(f.calls,[{command:'hub_detail',args:{name:'owned_event_listings',ids:[device,origin]}}]);assert.match(f.root.textContent,/開催そのもの/);assert.match(f.root.textContent,/注文・チケット/);assert.equal(f.calls.some(call=>call.command==='hub_client_action'),false);
});
test('selecting and previewing preserve raw draft and never cancel until explicit confirmation',async t=>{
 const f=await prepared(t);assert.equal(f.calls.some(call=>call.command==='hub_client_action'),false);assert.ok(f.root.textContent.includes('Synthetic cancellation reason'));assert.deepEqual(f.calls.at(-1).args,{name:'owned_event_listing',ids:['event-001',viewerId,device,origin]});await f.click('確認をやめる');assert.equal(f.root.querySelector('textarea').value,'  Synthetic\n  cancellation reason ');
});
test('cancel ACK plus detail must match exact timestamp/reason before observed success',async t=>{
 const f=await prepared(t),gate=deferred();let changed=false;f.handler=async(command,args)=>{if(command==='hub_client_action'){changed=true;return {viewerId,listing:row(1,{cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:args.text})};}await gate.promise;return {viewerId,listing:row(1,{cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:'Synthetic cancellation reason'})};};
 f.find('確認して掲載を取り消す').click();await tick();assert.equal(changed,true);assert.equal(f.root.textContent.includes('Hub上の掲載取消の日時と理由を確認しました'),false);assert.equal(f.find('確認して掲載を取り消す').disabled,true);
 gate.resolve();await settled();assert.ok(f.root.textContent.includes('掲載を取り消した日時:'));assert.equal(f.find('確認して掲載を取り消す'),undefined);
 assert.deepEqual(f.calls.find(call=>call.command==='hub_client_action').args,{action:'cancel_event_listing',target:'event-001',text:'Synthetic cancellation reason',options:{expectedViewerId:viewerId,expectedDeviceId:device,expectedOrigin:origin}});
});
test('lost result is reconciled by two stable readonly details without automatic second cancel',async t=>{
 const f=await prepared(t);f.handler=async command=>{if(command==='hub_client_action')throw Error('event_listing_unknown');return {viewerId,listing:row(1,{cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:'Synthetic cancellation reason'})};};await f.click('確認して掲載を取り消す');
 assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);assert.equal(f.calls.filter(call=>call.command==='hub_detail'&&call.args.name==='owned_event_listing').length,3);assert.ok(f.root.textContent.includes('掲載取消の日時と理由を確認しました'));
});
test('unknown uncancelled state keeps immutable selected ID/reason for explicit same-reason retry only',async t=>{
 const f=await prepared(t);let writes=0;f.handler=async(command,args)=>{if(command==='hub_client_action'){writes++;if(writes===1)throw Error('lost');return {viewerId,listing:row(1,{cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:args.text})};}return {viewerId,listing:writes>1?row(1,{cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:'Synthetic cancellation reason'}):row()};};
 await f.click('確認して掲載を取り消す');assert.equal(writes,1);assert.ok(f.find('取消状態を再確認'));assert.equal(f.root.querySelector('.result-grid button').disabled,true);await f.click('同じ理由で取消を再試行');assert.equal(writes,2);assert.deepEqual(f.calls.filter(call=>call.command==='hub_client_action').map(call=>call.args.text),['Synthetic cancellation reason','Synthetic cancellation reason']);
});
test('different cancellation reason and explicit Native409 disable replay and explain conflict',async t=>{
 for(const mode of ['state','409']){const f=await prepared(t);f.handler=async command=>{if(command==='hub_client_action')throw Error(mode==='409'?'event_listing_conflict':'lost');return {viewerId,listing:row(1,{cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:'Different reason'})};};
  await f.click('確認して掲載を取り消す');assert.match(f.root.textContent,/別の理由/);assert.equal(f.find('同じ理由で取消を再試行'),undefined);assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);
 }
});
test('timestamp disagreement stays unknown until an explicit readonly recheck agrees',async t=>{
 const f=await prepared(t);let reads=0;f.handler=async(command,args)=>command==='hub_client_action'?{viewerId,listing:row(1,{cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:args.text})}:{viewerId,listing:row(1,{cancelledAt:reads++===0?'2026-10-07T00:00:02.000Z':'2026-10-07T00:00:01.000Z',cancellationReason:'Synthetic cancellation reason'})};
 await f.click('確認して掲載を取り消す');assert.ok(f.find('取消状態を再確認'));await f.click('取消状態を再確認');assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);assert.ok(f.root.textContent.includes('掲載取消の日時と理由を確認しました'));
});
test('double confirm and detached old callbacks dispatch once',async t=>{
 const f=await prepared(t),gate=deferred(),old=f.find('確認して掲載を取り消す');f.handler=async(command,args)=>{if(command==='hub_client_action')await gate.promise;return {viewerId,listing:row(1,{cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:args.text??'Synthetic cancellation reason'})};};old.click();old.click();old.onclick();await tick();assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);gate.resolve();await settled();old.onclick();await settled();assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);
});
test('scope/device/view/disposal changes during cancel prevent follow-up or another-card adoption',async t=>{
 for(const kind of ['scope','device','view','destroy']){const f=await prepared(t),gate=deferred();f.handler=()=>gate.promise;f.find('確認して掲載を取り消す').click();await tick();
  if(kind==='scope')f.scope={...scope,generation:2};if(kind==='device')f.scope={key:JSON.stringify([origin,'other-device']),generation:1};if(kind==='view')f.current=false;if(kind==='destroy')f.controller.destroy();
  const before=f.calls.length;gate.resolve({viewerId,listing:row(1,{cancelledAt:'2026-10-07T00:00:01.000Z',cancellationReason:'Synthetic cancellation reason'})});await settled();assert.equal(f.calls.length,before);assert.equal(f.root.textContent.includes('掲載取消の日時と理由を確認しました'),false);
 }
});
test('reason min/max UTF16, whitespace, NUL and surrogate boundaries perform no implicit cancel',async t=>{
 const f=fixture(t);await f.controller.ready;await f.choose();for(const value of ['', '   ','x'.repeat(501),'😀'.repeat(251),'x\0','\ud800']){f.reason(value);await f.click('掲載取消の内容を確認');assert.equal(f.find('確認して掲載を取り消す'),undefined);}
 f.reason('😀'.repeat(250));await f.click('掲載取消の内容を確認');assert.ok(f.find('確認して掲載を取り消す'));assert.equal(f.calls.some(call=>call.command==='hub_client_action'),false);
});
test('own list DTO closed fields, wrong viewer/owner binding and unsafe URLs fail without exposing controls',async t=>{
 const bad=[{viewerId,listings:[row(1,{ownerProfileId:'other'})],nextCursor:null},{viewerId,listings:[row(1,{providerUrl:'http://provider.example'})],nextCursor:null},{viewerId,listings:[row(1,{providerUrl:'https://user:pass@provider.example'})],nextCursor:null},{viewerId,listings:[row(1,{providerUrl:'javascript:alert(1)'})],nextCursor:null},{viewerId,listings:[row(1,{cancelledAt:'2026-10-07T00:00:01Z'})],nextCursor:null},{viewerId,listings:Array.from({length:21},(_,index)=>row(index+1)),nextCursor:null}];
 for(const value of bad){const f=fixture(t);f.handler=async()=>value;await f.controller.ready;assert.equal(f.root.querySelectorAll('.result-grid button').length,0);assert.equal(f.calls.some(call=>call.command==='hub_client_action'),false);}
});
test('detail must bind original viewer and selected ID, title/reason HTML stays literal, opener HTTPS is scoped',async t=>{
 const f=fixture(t,{items:[row(1,{title:'<img src=x>',providerLabel:'<script>bad()</script>'})]});await f.controller.ready;await f.choose();await f.click('提供元のページを開く');assert.deepEqual(f.opens,['https://provider.example/events/1']);assert.equal(f.root.querySelectorAll('a,img,script').length,0);
 f.reason('Synthetic reason');f.handler=async()=>({viewerId:'other',listing:row()});await f.click('掲載取消の内容を確認');assert.equal(f.find('確認して掲載を取り消す'),undefined);
});
test('20-row pagination uses raw descending timestamps/ascending IDs and keeps drafts/filter after failed page',async t=>{
 const first=Array.from({length:20},(_,index)=>row(index+1)),f=fixture(t,{items:first});f.next=cursor(first.at(-1));await f.controller.ready;await f.choose();f.reason('Draft kept');f.handler=async()=>{throw Error('unavailable');};await f.click('次の掲載');assert.equal(f.root.querySelector('textarea').value,'Draft kept');assert.equal(f.root.querySelectorAll('.result-grid section').length,20);
 f.handler=async()=>({viewerId,listings:[row(21)],nextCursor:null});await f.click('次の掲載');assert.equal(f.calls.at(-1).args.ids[2],cursor(first.at(-1)));assert.equal(f.root.querySelectorAll('.result-grid section').length,1);assert.ok(f.find('最初の掲載へ'));
 f.handler=async()=>({viewerId,listings:first,nextCursor:cursor(first.at(-1))});await f.click('最初の掲載へ');await f.choose();assert.equal(f.root.querySelector('textarea').value,'Draft kept');
 const filter=f.root.querySelector('input[type=search]');filter.value='event 1';filter.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.ok(f.root.querySelectorAll('.result-grid section').length<20);
});
test('duplicate/no-progress/emptycontinuation/bad cursor/wrong next viewer preserves the original page',async t=>{
 for(const mode of ['duplicate','no-progress','empty','cursor','viewer']){const first=[row(2)],f=fixture(t,{items:first});f.next=cursor(first.at(-1));await f.controller.ready;
  f.handler=async()=>({viewerId:mode==='viewer'?'other':viewerId,listings:mode==='empty'?[]:[mode==='duplicate'?row(2):mode==='no-progress'?row(1):row(3)],nextCursor:mode==='empty'?cursor(row(2)):mode==='cursor'?'a'.repeat(513):null});await f.click('次の掲載');assert.equal(f.root.querySelector('strong').textContent,'Synthetic event 2');
 }
});
test('null/malformed scope and Native account-change are nonmutating and clear old private listing data',async t=>{
 for(const value of [null,{key:'bad',generation:1},{...scope,generation:-1},{key:JSON.stringify([origin,device+'\n']),generation:1}]){const f=fixture(t);f.scope=value;await f.controller.ready;assert.equal(f.calls.length,0);}
 const f=await prepared(t);f.handler=async()=>{throw Error('desktop_account_changed');};await f.click('確認して掲載を取り消す');assert.equal(f.root.querySelectorAll('.result-grid section').length,0);assert.equal(f.find('同じ理由で取消を再試行'),undefined);
});
test('all owned listings remain reachable past 100 while only the current twenty cards stay rendered',async t=>{
 const items=Array.from({length:105},(_,index)=>row(index+1)),f=fixture(t);f.handler=async(_command,args)=>{const start=args.ids.length===2?0:items.findIndex(item=>cursor(item)===args.ids[2])+1,end=Math.min(items.length,start+20);return {viewerId,listings:items.slice(start,end),nextCursor:end<items.length?cursor(items[end-1]):null};};
 await f.controller.ready;for(let page=1;page<6;page++){await f.click('次の掲載');assert.ok(f.root.querySelectorAll('.result-grid section').length<=20);}assert.equal(f.root.querySelectorAll('.result-grid section').length,5);assert.ok(f.root.textContent.includes('Synthetic event 105'));assert.equal(f.find('次の掲載'),undefined);
});
test('list cursor closed keys, canonical base64url, last tuple and 512 boundary are enforced',async t=>{
 const item=row(),invalid=[cursor(item)+'=', 'a'.repeat(513),Buffer.from([255]).toString('base64url'),cursor(row(2)),Buffer.from(JSON.stringify({updatedAt:item.updatedAt,id:item.id,ownerProfileId:'hidden'})).toString('base64url')];
 for(const nextCursor of invalid){const f=fixture(t);f.handler=async()=>({viewerId,listings:[item],nextCursor});await f.controller.ready;assert.equal(f.root.querySelectorAll('.result-grid section').length,0);assert.equal(f.calls.some(call=>call.command==='hub_client_action'),false);}
});
test('safe opener false result is not presented as opening success and does not mutate a listing',async t=>{
 const f=fixture(t);await f.controller.ready;await f.choose();f.openResult=false;await f.click('提供元のページを開く');assert.match(f.root.textContent,/提供元のページを開けませんでした/);assert.equal(f.calls.some(call=>call.command==='hub_client_action'),false);
});
