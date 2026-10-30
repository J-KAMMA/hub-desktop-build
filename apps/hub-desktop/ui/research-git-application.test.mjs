import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {researchGitApplication,nativeGitBranchName,parseNativeGitApplicationIdentity,parseNativeGitApplicationPlan,parseNativeGitApplicationResult} from './research-git-application.mjs';
const projectId='rp_'+'a'.repeat(32),proposalId='00000000-0000-4000-8000-000000000001',baseOid='a'.repeat(40),headOid='b'.repeat(40),snapshot='c'.repeat(64),comparisonHash='d'.repeat(64);
const identity={projectId,proposalId,snapshot,baseOid,headOid,comparisonHash},plan={...identity,branches:[{branch:'main',oid:baseOid},{branch:'other',oid:headOid}]};
const review={proposal:{id:proposalId,projectId,baseOid,headOid,status:'approved'},canManage:true,canReview:false,snapshot,comparisonHash,comparison:{}};
const result=(outcome='updated',changes={})=>({...identity,branch:'main',currentOid:headOid,outcome,...changes});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const button=(root,label)=>[...root.querySelectorAll('button')].find(value=>value.textContent===label);
function fixture(t,{memory=new Map(),review:given=structuredClone(review),invoke,isCurrent,...rest}={}){
 const dom=new JSDOM('<main></main>'),calls=[],target=dom.window.document.querySelector('main');
 const view=researchGitApplication(target,{projectId,review:given},{memory,isCurrent,invoke:async(name,args)=>{calls.push({name,args});return invoke?invoke(name,args):args.action==='research_git_application_preview'?plan:result(args.action.endsWith('check')?'already_included':'updated');},...rest});
 t.after(()=>{view.dispose();dom.window.close();});return {...view,dom,memory,calls,review:given};
}
function select(v,branch='main'){const field=v.root.querySelector('select');field.value=branch;field.dispatchEvent(new v.dom.window.Event('change'));}
async function preview(v){button(v.root,'反映先を確認').click();await tick();}
async function prepare(v){await preview(v);select(v);button(v.root,'このブランチへ反映する').click();}
async function apply(v){await prepare(v);button(v.root,'確認してGitへ反映').click();await tick();}

test('application parsers preserve only exact DTO identity and branch types',()=>{
 assert.deepEqual(parseNativeGitApplicationIdentity({...identity,private:'discard'},projectId,proposalId),identity);
 assert.deepEqual(parseNativeGitApplicationPlan(plan,projectId,proposalId),plan);
 assert.deepEqual(parseNativeGitApplicationResult(result(),identity,'main'),result());
 assert.deepEqual(parseNativeGitApplicationResult(result('not_included'),identity,'main',true),result('not_included'));
 for(const change of [{projectId:'foreign'},{proposalId:proposalId+'\n'},{snapshot:snapshot+'\n'},{comparisonHash:'e'.repeat(63)},{baseOid:baseOid+'\n'},{headOid:'b'.repeat(64)},{headOid:baseOid}])assert.throws(()=>parseNativeGitApplicationPlan({...plan,...change},projectId,proposalId));
 for(const branches of [null,new Array(1),[{branch:'main',oid:baseOid},{branch:'main',oid:headOid}],[{branch:'main',oid:'a'.repeat(64)}],[null],[{branch:'main\n',oid:baseOid}]])assert.throws(()=>parseNativeGitApplicationPlan({...plan,branches},projectId,proposalId));
 for(const change of [{branch:'other'},{branch:'main\n'},{snapshot:'e'.repeat(64)},{comparisonHash:'e'.repeat(64)},{baseOid:'e'.repeat(40)},{currentOid:'e'.repeat(64)},{outcome:'not_included'},{outcome:{toString:()=> 'updated'}}])assert.throws(()=>parseNativeGitApplicationResult(result('updated',change),identity,'main'));
 assert.throws(()=>parseNativeGitApplicationResult(result('updated'),identity,'main',true));
});
test('parser boundaries include 64 KiB, 100 unique branches, SHA-256 OIDs and 200 UTF-8 bytes',()=>{
 const branches=Array.from({length:100},(_,index)=>({branch:`branch-${index}`,oid:baseOid}));assert.equal(parseNativeGitApplicationPlan({...plan,branches},projectId,proposalId).branches.length,100);
 assert.throws(()=>parseNativeGitApplicationPlan({...plan,branches:[...branches,{branch:'extra',oid:baseOid}]},projectId,proposalId));
 const longIdentity={...identity,baseOid:'a'.repeat(64),headOid:'b'.repeat(64)},longPlan={...longIdentity,branches:[{branch:'日本語',oid:'a'.repeat(64)}]};assert.deepEqual(parseNativeGitApplicationPlan(longPlan,projectId,proposalId),longPlan);
 assert.deepEqual(parseNativeGitApplicationResult({...longIdentity,branch:'日本語',currentOid:'b'.repeat(64),outcome:'updated'},longIdentity,'日本語'),{...longIdentity,branch:'日本語',currentOid:'b'.repeat(64),outcome:'updated'});
 for(const name of ['x'.repeat(200),'あ'.repeat(66)+'xx','😀'.repeat(50),'a\u0080\u0085\u009fb'])assert.equal(nativeGitBranchName(name),true);
 for(const name of ['x'.repeat(201),'あ'.repeat(67),'😀'.repeat(51),'',' ','a b','a\\b','a\0b','a\u007fb','\ud800','\udc00'])assert.equal(nativeGitBranchName(name),false);
 const bounded={...plan,padding:''},bytes=new TextEncoder().encode(JSON.stringify(bounded)).length;bounded.padding='x'.repeat(65536-bytes);assert.equal(new TextEncoder().encode(JSON.stringify(bounded)).length,65536);assert.deepEqual(parseNativeGitApplicationPlan(bounded,projectId,proposalId),plan);bounded.padding+='x';assert.throws(()=>parseNativeGitApplicationPlan(bounded,projectId,proposalId));
 const oversizedResult={...result(),padding:'x'.repeat(65536)};assert.throws(()=>parseNativeGitApplicationResult(oversizedResult,identity,'main'));
});
test('mount has no requests; separate branch confirmation invokes one exact account-bound apply',async t=>{
 const v=fixture(t);await v.ready;assert.deepEqual(v.calls,[]);await preview(v);
 assert.deepEqual(v.calls,[{name:'hub_client_action',args:{action:'research_git_application_preview',target:projectId,options:{proposalId,snapshot}}}]);
 assert.equal(button(v.root,'このブランチへ反映する'),undefined);select(v);button(v.root,'このブランチへ反映する').click();assert.equal(v.calls.length,1);
 const confirm=button(v.root,'確認してGitへ反映');confirm.click();confirm.click();await tick();assert.equal(v.calls.length,2);
 assert.deepEqual(v.calls[1],{name:'hub_client_action',args:{action:'research_git_application_apply',target:projectId,options:{proposalId,snapshot,comparisonHash,branch:'main',confirmed:true}}});assert.match(v.root.textContent,/含まれています/);
});
test('only approved current owner can preview; wrong plan identity/hash never enables apply',async t=>{
 for(const changes of [{canManage:false},{proposal:{...review.proposal,status:'open'}},{comparison:undefined},{comparisonHash:undefined}]){const v=fixture(t,{review:{...review,...changes}});assert.equal(button(v.root,'反映先を確認').disabled,true);button(v.root,'反映先を確認').click();await tick();assert.deepEqual(v.calls,[]);}
 for(const changes of [{projectId:'foreign'},{proposalId:'00000000-0000-4000-8000-000000000002'},{snapshot:'e'.repeat(64)},{comparisonHash:'e'.repeat(64)},{baseOid:'e'.repeat(40)},{headOid:'e'.repeat(40)}]){const v=fixture(t,{invoke:async()=>({...plan,...changes})});await preview(v);assert.equal(v.root.querySelector('select'),null);assert.match(v.root.textContent,/確認できません/);}
});
test('branch mismatch and response width failures keep an apply unknown and its branch immutable',async t=>{
 for(const changes of [{branch:'other'},{currentOid:'e'.repeat(64)},{snapshot:'e'.repeat(64)},{comparisonHash:'e'.repeat(64)}]){
  const v=fixture(t,{invoke:async(_,args)=>args.action.endsWith('preview')?plan:result('updated',changes)});await apply(v);const entry=v.memory.get(proposalId);assert.equal(entry.sent,true);assert.equal(entry.branch,'main');assert.equal(v.root.querySelector('select').disabled,true);assert.equal(button(v.root,'反映先を確認'),undefined);
  select(v,'other');assert.equal(entry.branch,'main');assert.equal(button(v.root,'確認してGitへ反映'),undefined);
 }
});
test('unknown apply survives disposal and remount without automatic writes or branch changes',async t=>{
 const memory=new Map(),v=fixture(t,{memory,invoke:async(_,args)=>{if(args.action.endsWith('preview'))return plan;throw Error('offline');}});await apply(v);const saved=memory.get(proposalId),originalPlan=saved.plan;v.dispose();
 const next=fixture(t,{memory,invoke:async()=>result('already_included')});await next.ready;assert.deepEqual(next.calls,[]);assert.equal(next.root.querySelector('select').disabled,true);select(next,'other');assert.equal(saved.branch,'main');assert.equal(saved.plan,originalPlan);
 button(next.root,'このブランチの反映状態を確認').click();await tick();assert.equal(next.calls.length,1);assert.deepEqual(next.calls[0],{name:'hub_client_action',args:{action:'research_git_application_check',target:projectId,options:{proposalId,snapshot,comparisonHash,branch:'main'}}});assert.equal(saved.sent,false);assert.match(next.root.textContent,/含まれています/);
});
test('not_included requires a fresh preview even after branch changes',async t=>{
 const v=fixture(t,{invoke:async(_,args)=>args.action.endsWith('preview')?plan:args.action.endsWith('apply')?Promise.reject(Error('offline')):result('not_included',{currentOid:baseOid})});await apply(v);button(v.root,'このブランチの反映状態を確認').click();await tick();assert.equal(v.memory.get(proposalId).sent,false);assert.match(v.root.textContent,/含まれていません/);assert.equal(button(v.root,'このブランチへ反映する'),undefined);
 select(v,'other');select(v,'main');assert.equal(button(v.root,'このブランチへ反映する'),undefined);await preview(v);select(v);assert.ok(button(v.root,'このブランチへ反映する'));
 assert.equal(v.calls.filter(value=>value.args.action.endsWith('apply')).length,1);
});
test('unknown check recovers with current snapshot and no comparison, but changed pairs remain blocked',async t=>{
 const memory=new Map(),v=fixture(t,{memory,invoke:async(_,args)=>args.action.endsWith('preview')?plan:Promise.reject(Error('offline'))});await apply(v);v.dispose();
 const nextSnapshot='e'.repeat(64),next=fixture(t,{memory,review:{...review,snapshot:nextSnapshot,comparison:undefined,comparisonHash:undefined},invoke:async()=>result('already_included',{snapshot:nextSnapshot})});button(next.root,'このブランチの反映状態を確認').click();await tick();assert.equal(next.calls[0].args.options.snapshot,nextSnapshot);assert.equal(memory.get(proposalId).sent,false);assert.match(next.root.textContent,/含まれています/);next.dispose();
 memory.get(proposalId).sent=true;const changed=fixture(t,{memory,review:{...review,proposal:{...review.proposal,headOid:'e'.repeat(40)}}});assert.equal(button(changed.root,'このブランチの反映状態を確認').disabled,true);button(changed.root,'このブランチの反映状態を確認').click();await tick();assert.deepEqual(changed.calls,[]);assert.equal(memory.get(proposalId).sent,true);
});
test('disposal suppresses a late acknowledgement and a new request remains independently busy',async t=>{
 let finishApply,finishCheck;const memory=new Map(),v=fixture(t,{memory,invoke:async(_,args)=>args.action.endsWith('preview')?plan:new Promise(resolve=>{finishApply=resolve;})});await prepare(v);button(v.root,'確認してGitへ反映').click();await tick();v.dispose();await tick();assert.equal(memory.get(proposalId).sent,true);assert.equal(memory.get(proposalId).busy,false);
 const next=fixture(t,{memory,invoke:()=>new Promise(resolve=>{finishCheck=resolve;})});button(next.root,'このブランチの反映状態を確認').click();await tick();assert.equal(memory.get(proposalId).busy,true);finishApply(result());await tick();assert.equal(memory.get(proposalId).sent,true);assert.equal(memory.get(proposalId).busy,true);assert.equal(memory.get(proposalId).result,undefined);
 finishCheck(result('already_included'));await tick();assert.equal(memory.get(proposalId).sent,false);assert.equal(memory.get(proposalId).busy,false);
});
test('late account/role/snapshot changes never acknowledge results and account invalidation clears memory',async t=>{
 for(const change of ['current','owner','snapshot','invalidate']){
  let finish,current=true;const v=fixture(t,{isCurrent:()=>current,invoke:async(_,args)=>args.action.endsWith('preview')?plan:new Promise(resolve=>{finish=resolve;})});await prepare(v);button(v.root,'確認してGitへ反映').click();await tick();const saved=v.memory.get(proposalId);
  if(change==='current')current=false;else if(change==='owner')v.review.canManage=false;else if(change==='snapshot')v.review.snapshot='e'.repeat(64);else v.invalidate();
  finish(result());await tick();assert.equal(saved.sent,true);assert.equal(saved.result,undefined);assert.equal(saved.busy,false);
  if(change==='invalidate'){assert.equal(v.memory.size,0);assert.equal(v.root.querySelector('select'),null);}else{const before=v.calls.length;button(v.root,'このブランチの反映状態を確認')?.click();await tick();assert.equal(v.calls.length,before);}
 }
});
test('pending requests time out at 60 seconds and ignore later results',async t=>{
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout;let timeout,timeoutMs,finish;const fake=Symbol();
 globalThis.setTimeout=(callback,ms,...args)=>{if(ms===60000){timeout=callback;timeoutMs=ms;return fake;}return realSet(callback,ms,...args);};globalThis.clearTimeout=value=>{if(value!==fake)realClear(value);};
 try{const v=fixture(t,{invoke:async(_,args)=>args.action.endsWith('preview')?plan:new Promise(resolve=>{finish=resolve;})});await prepare(v);button(v.root,'確認してGitへ反映').click();await tick();assert.equal(timeoutMs,60000);timeout();await tick();assert.equal(v.memory.get(proposalId).busy,false);assert.equal(v.memory.get(proposalId).sent,true);finish(result());await tick();assert.equal(v.memory.get(proposalId).sent,true);assert.equal(v.memory.get(proposalId).result,undefined);}
 finally{globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;}
});
test('nonbaseline branches never allow apply and late preview scope changes discard private plans',async t=>{
 const v=fixture(t);await preview(v);select(v,'other');assert.equal(button(v.root,'このブランチへ反映する'),undefined);assert.equal(button(v.root,'確認してGitへ反映'),undefined);assert.ok(button(v.root,'このブランチの反映状態を確認'));
 let finish,current=true;const late=fixture(t,{isCurrent:()=>current,invoke:()=>new Promise(resolve=>{finish=resolve;})});button(late.root,'反映先を確認').click();await tick();current=false;finish(plan);await tick();assert.equal(late.memory.get(proposalId).plan,undefined);assert.equal(late.memory.get(proposalId).busy,false);assert.equal(late.root.querySelector('select'),null);
});
test('long branches render as literal compact content and implementation uses only caller invoke',async t=>{
 const name='<script>literal</script>'+'x'.repeat(176),longPlan={...plan,branches:[{branch:name,oid:baseOid}]},v=fixture(t,{invoke:async()=>longPlan});await preview(v);select(v,name);assert.equal(v.root.querySelector('script'),null);assert.equal(v.root.querySelector('select').style.maxWidth,'100%');assert.equal(v.root.style.minWidth,'0');assert.equal(v.root.style.overflowWrap,'anywhere');
 const source=readFileSync(new URL('./research-git-application.mjs',import.meta.url),'utf8');assert.equal(/\bfetch\s*\(/.test(source),false);assert.equal(/requestId/.test(source),false);assert.equal(/#[a-f\d]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i.test(source),false);
});
