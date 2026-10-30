import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {researchPublicExport} from './research-public-export.mjs';import {researchForkDigest,parseResearchForkPackage} from './research-public-package.mjs';
const{JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom'),projectId=`rp_${'a'.repeat(32)}`,origin='https://source.example',tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function packet({title='Synthetic project',license=null,body='Synthetic public document.',suffix=''}={}){
 const project={id:projectId,title,description:'Public metadata only.',license,status:'active',updatedAt:'2026-10-07T12:00:00.000Z'},documents=[{id:'doc-a',title:'Public document',kind:'paper',head:1,body:body+suffix,contentHash:await researchForkDigest(body+suffix)}],href=`${origin}/v2/research/${projectId}`;
 return{protocol:'hub.research-fork.v1',project,href,documents,snapshotHash:await researchForkDigest(JSON.stringify([href,project.title,project.description,project.license,project.status,project.updatedAt,documents]))};
}
async function fixture(t,{remote=false,payload}={}){
 payload??=await packet();
 const dom=new JSDOM('<section data-view-panel="detail" class="view on"><div id="root"></div></section>',{url:'http://fixture.invalid/'}),root=dom.window.document.querySelector('#root'),source={projectId,...(remote?{origin}:{})},f={dom,root,source,calls:[],active:true,payload,read:null,save:null};
 f.invoke=async(name,args)=>{f.calls.push({name,args});if(name==='hub_origin')return origin;if(name==='research_public_export_read')return f.read?f.read(args):f.payload;if(name==='research_public_export_save')return f.save?f.save(args):{saved:true,snapshotHash:args.snapshotHash};throw Error('synthetic_unavailable');};
 f.controller=researchPublicExport(root,source,{invoke:f.invoke,isCurrent:()=>f.active});t.after(()=>{f.controller.dispose();dom.window.close();});return f;
}
test('guest constructor is inert; explicit read shows literal rights/source/hash and exact immutable OS-save packet',async t=>{
 const f=await fixture(t,{payload:await packet({title:'<img src=x onerror=synthetic()> public'})});await f.controller.ready;assert.equal(f.calls.length,0);assert.match(f.root.textContent,/公開版を持ち出す/);assert.equal(await f.controller.save(),false);
 assert.equal(await f.controller.read(),true);assert.deepEqual(f.calls.map(call=>call.name),['hub_origin','research_public_export_read']);assert.match(f.root.textContent,/再利用には権利者の許可/);assert.match(f.root.textContent,/Git履歴・PDF・課題・変更提案は含みません/);assert.match(f.root.textContent,/著者の署名ではありません/);assert.equal(f.root.querySelector('img'),null);
 assert.equal(await f.controller.save(),true);const save=f.calls.at(-1);assert.deepEqual(Object.keys(save.args).sort(),['origin','projectId','snapshotHash','packet'].sort());assert.equal(save.args.origin,origin);assert.equal(save.args.projectId,projectId);assert.equal(save.args.snapshotHash,f.payload.snapshotHash);assert.ok(Object.isFrozen(save.args.packet));assert.ok(Object.isFrozen(save.args.packet.documents[0]));assert.deepEqual(await parseResearchForkPackage(save.args.packet,origin,projectId),f.payload);
});
test('selected HTTPS remote is pinned; no local origin fetch or automatic fork/save',async t=>{
 const f=await fixture(t,{remote:true});assert.equal(f.calls.length,0);await f.controller.read();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],{name:'research_public_export_read',args:{origin,projectId}});assert.equal(f.calls.some(call=>call.name==='hub_client_action'),false);
});
test('read reserves busy synchronously and duplicate save/read clicks make one operation each',async t=>{
 const f=await fixture(t),readGate=deferred();f.read=()=>readGate.promise;const pending=f.controller.read();assert.equal(await f.controller.read(),false);await tick();assert.equal(f.calls.filter(call=>call.name==='research_public_export_read').length,1);readGate.resolve(f.payload);await pending;
 const saveGate=deferred();f.save=()=>saveGate.promise;const saving=f.controller.save();assert.equal(await f.controller.save(),false);assert.equal(await f.controller.read(),false);const call=f.calls.at(-1);saveGate.resolve({saved:true,snapshotHash:call.args.snapshotHash});assert.equal(await saving,true);assert.equal(f.calls.filter(call=>call.name==='research_public_export_save').length,1);
});
test('cancel and known/unknown saving errors retain identical confirmed packet, without read/refetch',async t=>{
 for(const response of ['cancel','error','wrongHash','unknownKey']){
  const f=await fixture(t);await f.controller.read();f.save=args=>response==='cancel'?{cancelled:true}:response==='wrongHash'?{saved:true,snapshotHash:`sha256:${'f'.repeat(64)}`}:response==='unknownKey'?{saved:true,snapshotHash:args.snapshotHash,path:'forbidden'}:Promise.reject(Error('research_public_export_save_unknown'));
  assert.equal(await f.controller.save(),false);const first=f.calls.at(-1).args;assert.match(f.root.textContent,/確認した公開版は保持しています/);f.save=args=>({saved:true,snapshotHash:args.snapshotHash});assert.equal(await f.controller.save(),true);assert.equal(f.calls.at(-1).args.packet,first.packet);assert.equal(f.calls.filter(call=>call.name==='research_public_export_read').length,1);
 }
});
test('snapshot mismatch/body tampering never enables save; saved preview survives a later explicit read failure',async t=>{
 for(const change of [value=>({...value,snapshotHash:`sha256:${'f'.repeat(64)}`}),value=>({...value,documents:[{...value.documents[0],body:'changed'}]}),value=>({...value,href:`https://other.example/v2/research/${projectId}`})]){
  const f=await fixture(t);f.payload=change(f.payload);assert.equal(await f.controller.read(),false);assert.equal(await f.controller.save(),false);assert.equal(f.calls.some(call=>call.name==='research_public_export_save'),false);
 }
 const f=await fixture(t);await f.controller.read();f.read=()=>Promise.reject(Error('offline'));assert.equal(await f.controller.read(),false);assert.equal(await f.controller.save(),true);assert.equal(f.calls.at(-1).args.snapshotHash,f.payload.snapshotHash);
});
test('delayed read cannot restore UI after source/view/account/origin/disposal invalidation',async t=>{
 for(const change of ['source','view','account','origin','dispose','away-return']){
  const f=await fixture(t,{remote:true}),gate=deferred();f.read=()=>gate.promise;const pending=f.controller.read();
  if(change==='source')f.source.origin='https://other.example';else if(change==='view')f.active=false;else if(change==='dispose')f.controller.dispose();else if(change==='away-return'){const panel=f.root.parentElement;panel.classList.remove('on');panel.classList.add('on');}else f.dom.window.dispatchEvent(new f.dom.window.Event(change==='account'?'hub-account-changed':'hub-origin-changed'));
  gate.resolve(f.payload);assert.equal(await pending,false);assert.equal(await f.controller.save(),false);assert.equal(f.calls.some(call=>call.name==='research_public_export_save'),false);assert.equal(f.root.textContent.includes(f.payload.project.title),false);
 }
});
test('late save ACK after invalidation does not show success or re-enable stale controls',async t=>{
 const f=await fixture(t),gate=deferred();await f.controller.read();f.save=()=>gate.promise;const saving=f.controller.save();f.dom.window.dispatchEvent(new f.dom.window.Event('hub-origin-changed'));gate.resolve({saved:true,snapshotHash:f.payload.snapshotHash});assert.equal(await saving,false);assert.equal(f.root.textContent.includes('保存しました'),false);assert.equal(await f.controller.save(),false);
});
test('integration local public active only; private/withdrawn absent and public export has no implicit read',async t=>{
 const{renderResearchProject}=await import('./research.mjs');
 for(const [visibility,status,visible]of [['public','active',true],['confidential','active',false],['public','withdrawn',false]]){
  const f=await fixture(t);f.controller.dispose();const controller=renderResearchProject(f.root,{project:{id:projectId,title:'Synthetic project',description:'',defaultLicense:null,visibility,status},objects:[],relations:[],signedIn:false,canEdit:false},null,null,null,{invoke:async(name,args)=>{f.calls.push({name,args});if(name==='hub_detail')return args.name==='research_fork'?{source:null,preview:null}:{pdfs:[],canEdit:false,viewerId:null};throw Error('synthetic_unavailable');},isCurrent:()=>true});
  assert.equal([...f.root.querySelectorAll('summary')].some(node=>node.textContent==='公開版を持ち出す'),visible);assert.equal(f.calls.some(call=>call.name.startsWith('research_public_export')),false);controller?.dispose();
 }
});
test('integration remote fork retains existing preview/rights workflow beside independent export',async t=>{
 const{researchFork}=await import('./research-fork.mjs'),f=await fixture(t,{remote:true});f.controller.dispose();
 const c=researchFork(f.root,{project:{id:projectId},signedIn:false},{sourceOrigin:origin,invoke:async(name,args)=>{f.calls.push({name,args});if(name==='hub_detail')return{source:null,preview:{projectId,title:'Synthetic project',href:`${origin}/v2/research/${projectId}`,license:'MIT',documentCount:1,snapshotHash:f.payload.snapshotHash}};return f.invoke(name,args);},isCurrent:()=>true});
 await c.ready;assert.match(f.root.textContent,/公開版を持ち出す/);assert.match(f.root.textContent,/自分のHubへfork/);assert.match(f.root.textContent,/forkを作成するにはHubへ接続/);assert.equal(f.calls.some(call=>call.name.startsWith('research_public_export')),false);c.dispose();assert.equal(f.root.textContent.includes('公開版を持ち出す'),false);
});
test('unsupported legacy project IDs and malformed origins omit export without disturbing owner editor',async t=>{
 const f=await fixture(t);f.controller.dispose();const before=f.root.innerHTML;
 for(const source of [{projectId:'project'},{projectId:'../project'},{projectId:undefined},{projectId,origin:'https://source.example/path'},{projectId,origin:'javascript:invalid'}]){
  assert.equal(researchPublicExport(f.root,source,{invoke:f.invoke}),null);assert.equal(f.root.innerHTML,before);assert.equal(f.calls.length,0);
 }
 const{renderResearchProject}=await import('./research.mjs');
 const controller=renderResearchProject(f.root,{project:{id:'project',title:'Legacy project',description:'',defaultLicense:'MIT',visibility:'public',status:'active'},objects:[],relations:[],signedIn:true,canEdit:true},()=>{},()=>{},()=>{},{state:{},invoke:async(name,args)=>{f.calls.push({name,args});if(name==='hub_detail'&&args.name==='research_pdfs')return{projectId:'project',pdfs:[],signedIn:true,canEdit:true};throw Error('synthetic_unavailable');}});
 assert.equal(f.root.querySelectorAll('[data-research-registration]').length,2);assert.equal([...f.root.querySelectorAll('summary')].some(node=>node.textContent==='公開版を持ち出す'),false);assert.equal(f.calls.some(call=>call.name.startsWith('research_public_export')),false);assert.equal(typeof controller.dispose,'function');controller.dispose();
});
test('local root trailing slash canonicalizes; credentials/path/query/hash/control/overlong origin cannot read or save',async t=>{
 const good=await fixture(t),base=good.invoke;good.controller.dispose();good.controller=researchPublicExport(good.root,{projectId},{invoke:(name,args)=>name==='hub_origin'?Promise.resolve(origin+'/'):base(name,args)});assert.equal(await good.controller.read(),true);assert.deepEqual(good.calls[0],{name:'research_public_export_read',args:{origin,projectId}});assert.equal(await good.controller.save(),true);assert.equal(good.calls.at(-1).args.origin,origin);
 for(const raw of ['https://user:pass@source.example/','https://source.example/path','https://source.example/?x=1','https://source.example/#x','https://source.example/\n','https://'+ 'a'.repeat(513)+'.example/']){
  const f=await fixture(t),invoke=f.invoke;f.controller.dispose();f.controller=researchPublicExport(f.root,{projectId},{invoke:(name,args)=>name==='hub_origin'?Promise.resolve(raw):invoke(name,args)});assert.equal(await f.controller.read(),false);assert.equal(await f.controller.save(),false);assert.equal(f.calls.some(call=>call.name==='research_public_export_read'||call.name==='research_public_export_save'),false);
 }
 const remote=await fixture(t);remote.controller.dispose();assert.equal(researchPublicExport(remote.root,{projectId,origin:origin+'/'},{invoke:remote.invoke}),null);assert.equal(remote.calls.length,0);
});
