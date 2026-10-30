import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchFork} from './research-fork.mjs';
const project=`rp_${'a'.repeat(32)}`,origin='https://remote.example',requestId='00000000-0000-4000-8000-000000000001',snapshotHash=`sha256:${'b'.repeat(64)}`;
const click=async(root,text)=>{[...root.querySelectorAll('button')].find(b=>b.textContent===text).click();await new Promise(resolve=>setImmediate(resolve));};
test('forks through the local closed IPC using the selected foreign origin and never edits the remote Hub',async()=>{
  const dom=new JSDOM('<section></section>'),root=dom.window.document.querySelector('section'),calls=[];
  const c=researchFork(root,{project:{id:project},signedIn:true},{sourceOrigin:origin,randomUUID:()=>requestId,invoke:async(name,args)=>{calls.push({name,args});return name==='hub_detail'?{preview:{projectId:project,href:`${origin}/v2/research/${project}`,title:'Remote',license:'MIT',documentCount:1,snapshotHash}}:{project:{id:`rp_${requestId.replaceAll('-','')}`}};}});
  try{await c.ready;assert.deepEqual(calls[0],{name:'hub_detail',args:{name:'research_network_fork',ids:[origin,project]}});const check=root.querySelector('input');check.checked=true;check.dispatchEvent(new dom.window.Event('change'));await click(root,'非公開のforkを作成');assert.deepEqual(calls[1],{name:'hub_client_action',args:{action:'research_network_fork',target:project,options:{requestId,snapshotHash,rightsConfirmed:true,origin}}});assert.match(root.textContent,/作成したforkを開く/);}finally{c.dispose();dom.window.close();}
});
test('opens a foreign source on its actual Hub and rejects a mismatched preview origin',async()=>{
  const dom=new JSDOM('<section></section>'),root=dom.window.document.querySelector('section'),external=[],local=[];
  const value={projectId:project,href:`${origin}/v2/research/${project}`,title:'Remote',snapshotHash,documents:[]};
  let c=researchFork(root,{project:{id:project},signedIn:true},{invoke:async(name)=>name==='hub_origin'?'https://local.example':{source:value,preview:null},openSource:href=>external.push(href),openProject:p=>local.push(p)});
  try{await c.ready;await click(root,'派生元を開く');assert.deepEqual(external,[value.href]);assert.deepEqual(local,[]);c.dispose();c=researchFork(root,{project:{id:project},signedIn:true},{sourceOrigin:'https://different.example',invoke:async()=>({preview:{...value,documentCount:1,license:'MIT'}})});await c.ready;assert.equal(root.querySelector('input'),null);assert.match(root.textContent,/fork情報が不正/);}finally{c.dispose();dom.window.close();}
});
