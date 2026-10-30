import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {attachResearchContentShare} from './research-content-share.mjs';
const page=(changes={})=>({canDiscuss:true,document:{id:'doc',projectId:'project',title:'Paper',visibility:'public'},revision:{version:1,contentHash:'sha256:'+'a'.repeat(64)},...changes});
function fixture(t,data=page()){
 const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main'),f={dom,root,active:true,reply:data,calls:[],shares:[]};
 f.controller=attachResearchContentShare(root,data,{isCurrent:()=>f.active,invoke:async(name,args)=>{f.calls.push({name,args});return f.reply;},onShare:async value=>{f.shares.push(value);return true;}});
 t.after(()=>{f.controller?.dispose();dom.window.close();});return f;
}
test('selected public old version is reread and shared as a pinned page reference only',async t=>{
 const f=fixture(t);assert.equal(f.calls.length,0);await f.root.querySelector('button').onclick();
 assert.deepEqual(f.calls,[{name:'hub_detail',args:{name:'research_revision',ids:['project','doc','1']}}]);
 assert.equal(f.shares[0].href,'/v2/research/project?document=doc&version=1');assert.equal(f.shares[0].title,'Paper · v1');assert.equal(Object.hasOwn(f.shares[0],'body'),false);
});
test('private, withdrawn, missing authority and malformed fields never expose the entry',t=>{
 for(const data of [page({canDiscuss:false}),page({canDiscuss:'true'}),page({document:{id:'doc',projectId:'p',title:'Private',visibility:'confidential'}}),page({revision:{version:0,contentHash:'sha256:'+'a'.repeat(64)}}),page({revision:{version:1,contentHash:'unknown'}}),page({document:{id:'doc',title:'Missing project',visibility:'public'}})])assert.equal(fixture(t,data).controller,null);
});
test('public revocation, wrong target/version/hash and read failure stop before sharing',async t=>{
 for(const next of [page({canDiscuss:false}),page({document:{id:'other',projectId:'project',title:'Other',visibility:'public'}}),page({revision:{version:2,contentHash:'sha256:'+'a'.repeat(64)}}),page({revision:{version:1,contentHash:'sha256:'+'b'.repeat(64)}})]){
  const f=fixture(t);f.reply=next;assert.equal(await f.root.querySelector('button').onclick(),false);assert.equal(f.shares.length,0);
 }
});
test('duplicate clicks coalesce and detached, changed-view or disposed late reads do not navigate',async t=>{
 for(const mode of ['view','detach','dispose']){const f=fixture(t);let finish;f.reply=new Promise(resolve=>{finish=resolve;});const button=f.root.querySelector('button'),pending=button.onclick();assert.equal(await button.onclick(),false);assert.equal(f.calls.length,1);
  if(mode==='view')f.active=false;else if(mode==='detach')f.root.remove();else f.controller.dispose();finish(page());assert.equal(await pending,false);assert.equal(f.shares.length,0);
 }
});
