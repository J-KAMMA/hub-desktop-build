import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {communityMembershipControls} from './community-controls.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const guide=()=>({community:{id:'c1',name:'コミュニティ',description:'案内',visibility:'public'},viewerId:'me',joined:false,pending:false,rules:[{id:'r1',title:'ルール',body:'他の参加者を尊重する',required:1}],questions:[{id:'q1',prompt:'目的',required:1}],snapshot:'a'.repeat(64)});
const receipt=args=>({communityId:'c1',joined:true,pending:false,alreadyJoined:false,alreadyPending:false,receipt:{auditId:args.options.operationId,action:'member_joined',targetId:'c1',confirmedAt:'2026-10-03T00:00:00Z',replayed:false}});
function fixture(overrides={}){
 const dom=new JSDOM(''),calls=[];let refreshed=0;
 const controller=communityMembershipControls(dom.window.document,{community:{id:'c1',visibility:'public'},membership:{joined:false,pending:false},viewerId:'me',invoke:async(command,args)=>{calls.push({command,...args});return command==='hub_detail'?guide():receipt(args);},refresh:()=>refreshed++,...overrides}),root=controller.root;dom.window.document.body.append(root);
 return{dom,root,calls,controller,get refreshed(){return refreshed;},button:text=>[...root.querySelectorAll('button')].find(n=>n.textContent===text),submit:()=>root.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true})),input:(value)=>{const n=root.querySelector('textarea');n.value=value;n.dispatchEvent(new dom.window.Event('input'));},consent:()=>root.querySelector('[type=checkbox]').click(),close:()=>{controller.dispose();dom.window.close();}};
}
test('join requires rules and answers, previews all answers before write, and supports keyboard submission',async()=>{
 const f=fixture();f.button('参加する').click();await tick();assert.match(f.root.textContent,/他の参加者を尊重する/);f.submit();assert.equal(f.calls.length,1);f.consent();f.input('　 ');f.submit();assert.equal(f.calls.length,1);f.input(' Ｈｕｂ ');f.submit();assert.match(f.root.querySelector('[aria-label="参加内容の確認"]').textContent,/Hub/);assert.equal(f.calls.length,1);f.button('確認して参加内容を保存').click();await tick();const post=f.calls[1];assert.equal(post.command,'hub_client_action');assert.equal(post.action,'community_join_complete');assert.equal(post.target,'c1');assert.deepEqual({...post.options,operationId:'UUID'},{operationId:'UUID',snapshot:'a'.repeat(64),acceptedRules:true,answers:[{questionId:'q1',answer:'Hub'}]});assert.equal(f.refreshed,1);f.close();
});
test('unknown join freezes answers and UUID and suppresses concurrent submission',async()=>{
 let release,writes=0;const f=fixture({invoke:async(command,args)=>command==='hub_detail'?guide():(writes++,await new Promise(resolve=>release=resolve))});f.button('参加する').click();await tick();f.consent();f.input('研究');f.submit();const save=f.button('確認して参加内容を保存');save.click();save.click();assert.equal(writes,1);release({});await tick();assert.match(f.root.textContent,/保存結果が不明/);assert.equal(f.root.querySelector('textarea').value,'研究');assert.equal(f.root.querySelector('textarea').disabled,true);f.button('同じ参加操作の保存結果を確認').click();assert.equal(writes,2);release({communityId:'c1',joined:true,pending:false,alreadyJoined:true,alreadyPending:false,receipt:null});await tick();assert.equal(f.refreshed,1);f.close();
});
test('pending cancellation preserves preview, matching actor receipt and retry UUID',async()=>{
 const writes=[];let good=false;const f=fixture({membership:{joined:false,pending:true},invoke:async(_,args)=>{writes.push(args);return{pending:false,currentMembership:{pending:false},receipt:{auditId:args.requestId,targetId:good?'me':'other'}};}});f.button('申請を取り下げる').click();assert.equal(writes.length,0);assert.match(f.root.textContent,/取り下げますか/);f.button('取り下げを確定').click();await tick();assert.equal(f.refreshed,0);good=true;f.button('取り下げを確定').click();await tick();assert.equal(writes[0].requestId,writes[1].requestId);assert.equal(writes[1].action,'community_cancel_request');assert.equal(f.refreshed,1);f.close();
});
test('owner, restricted and invite-only controls stay unavailable; guide failure never joins',async()=>{
 for(const overrides of [{membership:{joined:true,pending:false},viewerRole:'owner'},{viewerStatus:'banned'},{viewerStatus:'muted'},{community:{id:'c1',visibility:'private'}}]){const f=fixture(overrides);assert.equal(f.root.querySelector('button').disabled,true);f.close();}const f=fixture({invoke:async()=>{throw Error('通信に失敗しました');}});f.button('参加する').click();await tick();assert.match(f.root.textContent,/通信に失敗/);assert.equal(f.root.querySelector('form'),null);assert.equal(f.refreshed,0);f.close();
});
