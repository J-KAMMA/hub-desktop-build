import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchFork} from './research-fork.mjs';
test('opens the own fork Web editor for a transfer without putting private content or foreign credentials in the URL',async t=>{
 const dom=new JSDOM('<section></section>');t.after(()=>dom.window.close());const p=`rp_${'a'.repeat(32)}`,opened=[];
 const root=dom.window.document.querySelector('section'),controller=researchFork(root,{project:{id:p},signedIn:true},{openSource:url=>opened.push(url),invoke:async(name)=>name==='hub_origin'?'http://127.0.0.1:3020':{source:{projectId:`rp_${'b'.repeat(32)}`,href:`https://original.example/v2/research/rp_${'b'.repeat(32)}`,title:'Original',snapshotHash:`sha256:${'c'.repeat(64)}`,documents:[]},preview:null}});
 t.after(()=>controller.dispose());await controller.ready;
 const button=[...root.querySelectorAll('button')].find(b=>b.textContent==='変更を原本へ提案（Web）');await button.onclick();assert.deepEqual(opened,[`http://127.0.0.1:3020/v2/research/${p}`]);
});
