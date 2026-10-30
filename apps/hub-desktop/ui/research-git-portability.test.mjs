import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchGitManagement} from './research-git-management.mjs';

const p='rp_'+'a'.repeat(32);
const info={projectId:p,viewerId:null,canManage:false,projectPublic:true,snapshot:'a'.repeat(64),repository:{visibility:'public',url:`https://independent-hub.example/git/${p}.git`},tokens:[]};
test('public Git portability uses its own server without credentials or write permissions',async()=>{
  const dom=new JSDOM('<main></main>'),calls=[];
  const target=dom.window.document.querySelector('main');
  const view=researchGitManagement(target,{projectId:p},{invoke:async(command,args)=>{calls.push([command,args]);return info;}});
  await view.ready;
  const button=target.querySelector('[data-git-action="bundle"]');assert.ok(button);
  await button.onclick();assert.deepEqual(calls.at(-1),['open_external',{url:`https://independent-hub.example/v1/repositories/${p}/bundle`}]);
  assert.equal(calls.some(([command])=>command==='hub_client_action'),false);
  view.dispose();assert.equal(target.querySelector('[data-git-action="bundle"]'),null);dom.window.close();
});
test('private, withdrawn and unavailable repositories have no portable download control',async()=>{
  for(const change of [{projectPublic:false},{repository:{...info.repository,visibility:'confidential'}},{repository:null},{repository:{...info.repository,url:null}}]){
    const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main');
    const view=researchGitManagement(target,{projectId:p},{invoke:async()=>({...info,...change})});await view.ready;
    assert.equal(target.querySelector('[data-git-action="bundle"]'),null);view.dispose();dom.window.close();
  }
});
