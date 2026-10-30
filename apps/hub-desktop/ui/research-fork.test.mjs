import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchFork} from './research-fork.mjs';
const p=`rp_${'a'.repeat(32)}`,requestId='00000000-0000-4000-8000-000000000001';
const info={source:null,preview:{projectId:p,href:`https://node.example/v2/research/${p}`,title:'Source',license:'MIT',documentCount:1,snapshotHash:`sha256:${'b'.repeat(64)}`}};
const setup=(state={})=>{const dom=new JSDOM('<section><p class="meta">Public</p></section>'),root=dom.window.document.querySelector('section'),calls=[];let failure=null;
 const invoke=async(name,args)=>{calls.push({name,args});if(name==='hub_detail')return structuredClone(info);if(failure)throw Error(failure);return {project:{id:`rp_${requestId.replaceAll('-','')}`,title:'Fork'}};};
 const c=researchFork(root,{project:{id:p},signedIn:true},{state,invoke,randomUUID:()=>requestId});
 return {dom,root,c,calls,state,setFailure(value){failure=value;}};
};
const click=async(root,label)=>{const b=[...root.querySelectorAll('button')].find(n=>n.textContent===label);assert.ok(b,label);b.click();await new Promise(resolve=>setImmediate(resolve));};
const confirm=root=>{const checkbox=root.querySelector('input[type=checkbox]');checkbox.checked=true;checkbox.dispatchEvent(new root.ownerDocument.defaultView.Event('change'));};
test('confirms rights before a private fork and uses only the closed action with its source snapshot',async()=>{
 const v=setup();try{await v.c.ready;assert.equal(v.root.querySelector('input').checked,false);const button=[...v.root.querySelectorAll('button')].find(n=>n.textContent==='非公開のforkを作成');assert.equal(button.disabled,true);assert.equal(v.calls.length,1);
 confirm(v.root);await click(v.root,'非公開のforkを作成');assert.deepEqual(v.calls[1],{name:'hub_client_action',args:{action:'research_fork',target:p,options:{requestId,snapshotHash:info.preview.snapshotHash,rightsConfirmed:true}}});assert.match(v.root.textContent,/作成したforkを開く/);assert.equal(v.state.fork.saved.id,`rp_${requestId.replaceAll('-','')}`);
 }finally{v.c.dispose();v.dom.window.close();}
});
test('preserves an uncertain operation across rerenders and ignores stale controls after account changes',async()=>{
 const state={},v=setup(state);try{await v.c.ready;confirm(v.root);v.setFailure('lost');await click(v.root,'非公開のforkを作成');const first=v.calls.at(-1);v.c.dispose();
 const c=researchFork(v.root,{project:{id:p},signedIn:true},{state,invoke:async(name,args)=>{v.calls.push({name,args});throw Error('lost again');}});try{await c.ready;await click(v.root,'同じforkの保存結果を確認');assert.deepEqual(v.calls.at(-1),first);
 const stale=[...v.root.querySelectorAll('button')].find(n=>n.textContent==='同じforkの保存結果を確認'),count=v.calls.length;v.dom.window.dispatchEvent(new v.dom.window.Event('hub-account-changed'));stale.click();assert.equal(v.calls.length,count);assert.match(v.root.textContent,/接続が変わりました/);assert.equal(state.fork.operation,undefined);
 }finally{c.dispose();}
 }finally{v.dom.window.close();}
});
test('a known conflict requires a fresh preview and reconfirmation instead of automatic retries',async()=>{
 const v=setup();try{await v.c.ready;confirm(v.root);v.setFailure('research_fork_rejected:409:changed');await click(v.root,'非公開のforkを作成');assert.equal(v.state.fork.operation,undefined);assert.equal(v.root.querySelector('input'),null);assert.equal(v.calls.length,2);await click(v.root,'派生元を再確認');assert.equal(v.root.querySelector('input').checked,false);assert.equal(v.calls.length,3);
 }finally{v.c.dispose();v.dom.window.close();}
});
