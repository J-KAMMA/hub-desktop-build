import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const origin='http://127.0.0.1:9877',mainHub='https://paper.synthetic.invalid';
const projectId='rp_'+'a'.repeat(32),documentId='paper-fixed',body='Fixed paper v2. This text stays pinned while checking project code.';
const contentHash='sha256:'+createHash('sha256').update(body).digest('hex');

test('actual Desktop startup traverses pinned paper to project code and real Back with its draft, then rejects stale source and actor controls',{timeout:60000},async t=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1240,height:900}}),pageErrors=[],blocked=[],modules=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==origin){blocked.push(url.origin);await route.abort();return;}
  const path=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!/^[A-Za-z0-9_./-]+$/.test(path)||path.split('/').includes('..')){await route.abort();return;}
  try{const bytes=await readFile(new URL(path,import.meta.url));if(/\.(mjs|js)$/.test(path))modules.push(path);await route.fulfill({body:bytes,contentType:/\.(mjs|js)$/.test(path)?'text/javascript':path.endsWith('.css')?'text/css':'text/html'});}catch{await route.fulfill({status:404,body:''});}
 });
 await page.addInitScript(({mainHub,projectId,documentId,body,contentHash})=>{
  const stamp='2026-10-08T00:00:00.000Z';
  const project={id:projectId,title:'Synthetic paper project',description:'Project code navigation fixture',visibility:'public',status:'active',objectCount:1};
  const paper={id:documentId,projectId,title:'Pinned Paper',head:7,visibility:'public',kind:'paper'};
  const pageFor=version=>({signedIn:true,canEdit:false,canDiscuss:true,document:paper,revision:{version,body:version===2?body:'Latest paper v7, not the fixed reference',contentHash:version===2?contentHash:'sha256:'+'7'.repeat(64),summary:version===2?'Fixed source':'Latest'},history:[{version:2,summary:'Fixed source'},{version:7,summary:'Latest'}]});
  window.paperFixture={calls:[],origin:mainHub,actor:{state:'registered',deviceId:'synthetic-alice',keyThumbprint:'a'.repeat(43)},viewer:'alice'};
  window.__TAURI__={event:{listen:async()=>()=>{}},core:{invoke:async(name,args={})=>{
   const f=window.paperFixture;const call={name,args:structuredClone(args),origin:f.origin,actor:f.actor.deviceId};f.calls.push(call);
      if(name==='browser_tab_overlay'){if(args.left!==0)throw Error('unexpected fixture overlay');return null;}
   if(name==='hub_origin')return f.origin;
   if(['desktop_account_status','poll_desktop_account'].includes(name))return {...f.actor};
   if(name==='desktop_build_mode')return 'development';
   if(name==='hub_network_sources'){if(args.action!=='list')throw Error('unexpected mutation');return {sources:[]};}
   if(name==='hub_resource')return args.resource==='research'?{projects:[project],hasMore:false}:{resources:[]};
   if(name==='hub_detail'){
    if(args.name==='research_project')return {project,objects:[],relations:[],canEdit:false,signedIn:true,workspace:{documents:[paper],links:[],proposals:[]}};
    if(args.name==='research_document'||args.name==='research_revision'){const result=pageFor(args.name==='research_revision'?Number(args.ids[2]):7);call.document={projectId:result.document.projectId,documentId:result.document.id,version:result.revision.version,contentHash:result.revision.contentHash};return result;}
    if(args.name==='research_git_history')return {projectId,commits:[{oid:'b'.repeat(40),parentOids:[],subject:'Independent code commit',committedAt:stamp}]};
    if(args.name==='research_pdfs')return {projectId,pdfs:[],canEdit:false,signedIn:true};
    throw Error('synthetic_unavailable');
   }
   if(name==='hub_client'){if((args.name==='me'||args.name==='me_summary'))return {profile:{id:f.viewer,handle:'fixture',displayName:'Synthetic reader'}};if(args.name==='federated_feed')return {items:[]};throw Error('synthetic_unavailable');}
   if(name==='hub_social_stream')return {version:1,filter:args.filter,scope:args.scope,viewerId:f.viewer,signedIn:true,items:[{kind:'thread',id:'startup-thread',createdAt:stamp,origin:f.origin,payload:{id:'startup-thread',title:'Startup fixture',boardKey:'board',postCount:3,threadType:'discussion',status:'open',updatedAt:stamp}}],hasMore:false,nextCursor:null,failures:[]};
   if(name==='hub_feed')return {posts:[],signedIn:true,hasMore:false};
   if(name==='music_tracks')return {tracks:[],works:[]};
   if(name==='commerce_catalog')return {products:[],paymentAssets:[],paymentsEnabled:false,nextCursor:null};
   if(['dev_history','dev_agents','pi_work_list'].includes(name))return [];
   if(['workspace','dev_workspace'].includes(name))return '';
   if(name==='dev_active_run')return null;
   throw Error('synthetic_unavailable');
  }}};
 },{mainHub,projectId,documentId,body,contentHash});
 await page.goto(origin);await page.waitForFunction(()=>{const s=document.querySelector('#feed-state');return s&&s.textContent!=='読み込み中…';});
 await page.locator('#desktop-apps').click();await page.locator('#sidebar-context .sidebar-context-item',{hasText:'プロジェクトと研究'}).first().click();await page.locator('#research-results .research-project-card').filter({hasText:'Synthetic paper project'}).waitFor();await page.evaluate(()=>{window.paperFixture.oldList=document.querySelector('#research-results .research-project-card');if(!window.paperFixture.oldList?.isConnected)throw Error('expected connected old list project');});await page.locator('#research-results .research-project-card').filter({hasText:'Synthetic paper project'}).click();
 await page.locator('#detail-content').getByRole('button',{name:'Pinned Paper · v7',exact:true}).click();
 await page.locator('#detail-content select[aria-label="版を表示"]').selectOption('2');
 await page.waitForFunction(body=>document.querySelector('#detail-content > section > pre')?.textContent===body,body);
 const draft='Unsent explanation survives the real paper and code navigation.',summary='Keep this exact draft reason';
 await page.locator('#detail-content .research-proposal-create summary').click();
 await page.locator('#detail-content .research-proposal-create textarea[name="body"]').fill(draft);await page.locator('#detail-content .research-proposal-create input[name="summary"]').fill(summary);
 await page.evaluate(()=>{window.paperFixture.initialCode=[...document.querySelectorAll('#detail-content button')].find(n=>n.textContent==='このプロジェクトのコード');});
 await page.locator('#detail-content').getByRole('button',{name:'このプロジェクトのコード',exact:true}).click();
 await page.locator('#detail-content .research-git-browser').waitFor();
 assert.equal(await page.locator('#detail-content .research-git-selection').textContent(),'選択したコミット履歴からコミットを選択してください。');
 const gitCall=await page.evaluate(()=>window.paperFixture.calls.filter(c=>c.name==='hub_detail'&&c.args.name==='research_git_history').at(-1));assert.deepEqual(gitCall.args.ids,[projectId]);assert.equal(gitCall.origin,mainHub);assert.equal(gitCall.actor,'synthetic-alice');
 await page.locator('#toolbar-back').click();
 await page.waitForFunction(body=>document.querySelector('#detail-content > section > pre')?.textContent===body,body);
 assert.equal(await page.locator('#detail-content select[aria-label="版を表示"]').inputValue(),'2');
 assert.equal(await page.locator('#detail-content .research-proposal-create textarea[name="body"]').inputValue(),draft);assert.equal(await page.locator('#detail-content .research-proposal-create input[name="summary"]').inputValue(),summary);
 const pinned=await page.evaluate(()=>window.paperFixture.calls.filter(c=>c.name==='hub_detail'&&c.args.name==='research_revision').at(-1));assert.deepEqual(pinned.args.ids,[projectId,documentId,'2']);assert.deepEqual(pinned.document,{projectId,documentId,version:2,contentHash});assert.equal(pinned.origin,mainHub);assert.equal(pinned.actor,'synthetic-alice');
 assert.ok(modules.includes('app.js')&&modules.includes('research-workspace.mjs'));
 const oldResult=await page.evaluate(async()=>{const f=window.paperFixture,start=f.calls.length;f.initialCode?.onclick();await new Promise(resolve=>setTimeout(resolve,0));return f.calls.slice(start).filter(c=>c.name==='hub_detail');});assert.deepEqual(oldResult,[]);

 await t.test('source change clears old paper, draft and navigation without reading old IDs at the new Hub',async()=>{
  await page.evaluate(()=>{const f=window.paperFixture;f.oldCode=[...document.querySelectorAll('#detail-content button')].find(n=>n.textContent==='このプロジェクトのコード');if(!f.oldCode||!f.oldCode.isConnected)throw Error('expected connected paper code control');f.oldHeader=document.querySelector('#detail-open-right').onclick;f.oldSidebar=[...document.querySelectorAll('#sidebar-context button')].find(n=>n.textContent==='Synthetic paper project');if(!f.oldSidebar?.isConnected||!f.oldList?.isConnected)throw Error('expected connected old sidebar and index project buttons');f.boundaryStart=f.calls.length;f.origin='https://other.synthetic.invalid';window.dispatchEvent(new Event('hub-origin-changed'));});
  const stale=await page.evaluate(async()=>{const f=window.paperFixture;f.oldCode.onclick();f.oldHeader?.();f.oldSidebar.onclick();f.oldList.onclick();await new Promise(resolve=>setTimeout(resolve,0));return f.calls.slice(f.boundaryStart).filter(c=>c.name==='hub_detail'&&c.args.ids?.includes('rp_'+'a'.repeat(32)));});assert.deepEqual(stale,[]);
  assert.match(await page.locator('#detail-content').textContent(),/一覧から対象を選び直してください。/);assert.equal(await page.locator('#detail-content pre,#detail-content textarea').count(),0);assert.equal(await page.locator('#research-results .research-project-card').count(),0);assert.equal(await page.locator('#sidebar-context button').filter({hasText:'Synthetic paper project'}).count(),0);assert.equal(await page.locator('#toolbar-back').isDisabled(),true);assert.equal(await page.locator('#toolbar-forward').isDisabled(),true);assert.equal(await page.locator('#detail-open-right').isHidden(),true);assert.equal(await page.evaluate(()=>document.querySelector('#detail-open-right').onclick),null);
 });
 // New source requires an explicit selection from its list, using real app controls.
 await page.locator('#detail-content').getByRole('button',{name:'一覧を開く',exact:true}).click();
 await page.locator('#research-results .research-project-card').filter({hasText:'Synthetic paper project'}).click();
 await page.locator('#detail-content').getByRole('button',{name:'Pinned Paper · v7',exact:true}).click();
 await page.locator('#detail-content select[aria-label="版を表示"]').selectOption('2');
 await page.waitForFunction(body=>document.querySelector('#detail-content > section > pre')?.textContent===body,body);
 assert.equal(await page.locator('#detail-content .research-proposal-create textarea[name="body"]').inputValue(),body);assert.equal(await page.locator('#detail-content .research-proposal-create input[name="summary"]').inputValue(),'');
 const fresh=await page.evaluate(()=>window.paperFixture.calls.filter(c=>c.name==='hub_detail'&&c.args.name==='research_revision').at(-1));assert.equal(fresh.origin,'https://other.synthetic.invalid');assert.deepEqual(fresh.args.ids,[projectId,documentId,'2']);
 await t.test('actor change rejects the captured connected paper code control',async()=>{
  await page.evaluate(()=>{const f=window.paperFixture;f.oldCode=[...document.querySelectorAll('#detail-content button')].find(n=>n.textContent==='このプロジェクトのコード');if(!f.oldCode||!f.oldCode.isConnected)throw Error('expected connected paper code control');f.actor={state:'registered',deviceId:'synthetic-bob',keyThumbprint:'b'.repeat(43)};f.viewer='bob';window.dispatchEvent(new Event('hub-account-changed'));});
  const stale=await page.evaluate(async()=>{const f=window.paperFixture,start=f.calls.length;f.oldCode.onclick();await new Promise(resolve=>setTimeout(resolve,0));return f.calls.slice(start).filter(c=>c.name==='hub_detail'&&c.args.name==='research_git_history');});assert.deepEqual(stale,[]);
 });
 assert.deepEqual(pageErrors,[]);assert.deepEqual(blocked,[]);
 const writes=await page.evaluate(()=>window.paperFixture.calls.filter(c=>/^(hub_client_action|commerce_order|wallet_sign|wallet_send|begin_desktop|logout_desktop|research_pdf_upload|research_change_save|research_bundle_import)/.test(c.name)));assert.deepEqual(writes,[]);
});