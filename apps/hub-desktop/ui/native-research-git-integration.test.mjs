
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {renderResearchProject} from './research.mjs';
import {researchGitBrowser} from './research-git-browser.mjs';
import {documentWorkspace} from './research-workspace.mjs';
import {isReadAccessDenied} from './hub-read-recovery.mjs';

const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const fn=name=>{const start=source.indexOf(name),end=source.indexOf('\n}',start)+2;assert.ok(start>=0&&end>start);return source.slice(start,end);};
const p='rp_'+'a'.repeat(32),oid='b'.repeat(40),url=`/v2/research/${p}?commit=${oid}#git`;
const detail=new Function(`return (${fn('function detailForHubPath(path) {')});`)();

test('fixed Git paths open native history or exact commit and reject ambiguous or external paths',async()=>{
  assert.deepEqual(detail(`/v2/research/${p}#git`),{name:'research_git_history',ids:[p],title:'Gitの変更履歴'});
  assert.deepEqual(detail(url),{name:'research_git_commit',ids:[p,oid],title:'コードの変更'});
  assert.equal(detail(url.replace(oid,'c'.repeat(64))).ids[1],'c'.repeat(64));
  for(const invalid of [url+'\n',url+'\r',url+'&other=x',url.replace('#git','#other'),url.replace(oid,oid.toUpperCase()),url.replace(p,'..'),url.replace(p,'%72'+p.slice(1)),url.replace('?commit=','?document=d&commit='),url.replace('#git','&commit='+oid+'#git'),url.replace('#git','&other=x#git'),url.replace(oid,'abc'),'https://evil.test'+url])assert.equal(detail(invalid),null,invalid);
  const calls=[];
  const open=new Function('invoke','openDetail','detailForHubPath','navigateFrom','showNotice','friendlyError',`return (${fn('async function openHubPath(')});`)(async()=>assert.fail('No native-to-browser IPC'),(...args)=>calls.push(args),detail,()=>{},()=>{},String);
  await open(url);assert.deepEqual(calls.map(([name,ids,options])=>[name,ids,options.title]),[['research_git_commit',[p,oid],'コードの変更']]);assert.equal(calls[0][2].isCurrent(),true);
});

test('project Git entry opens native history and keeps separate Web repository settings',()=>{
  const dom=new JSDOM('<main></main>'),calls=[];
  renderResearchProject(dom.window.document.querySelector('main'),{project:{id:p},workspace:{documents:[],links:[]} },null,null,path=>calls.push(['web',path]),{openGit:id=>calls.push(['native',id]),state:{}});
  const buttons=[...dom.window.document.querySelectorAll('button')];
  buttons.find(n=>n.textContent==='変更履歴と差分を見る').click();
  buttons.find(n=>n.textContent==='Gitの設定をWebで開く').click();
  assert.deepEqual(calls,[['native',p],['web',`/v2/research/${p}#git`]]);
  dom.window.close();
});

test('Git, parent commit, and discussion navigation share drafts and account-bound invoke rejects stale results',async()=>{
  const calls=[],entry={ids:[p],editorState:{document:{title:'Keep'},gitDiscussions:{pending:'Keep'}}};
  let finish;
  const detailSurface={firstElementChild:{isConnected:true}};
  const ctx=vm.createContext({offerPublicContentShare:()=>false,detailRenderRevision:1,detailContent:()=>detailSurface,researchAccountGeneration:1,currentView:'detail',detailTrail:[entry],friendlyError:String,window:{confirm:()=>true},invoke:()=>new Promise(resolve=>{finish=resolve;}),openDetail:(...args)=>calls.push(args),renderDetailEntry:()=>{}});
  vm.runInContext(fn('function researchEditorOptions(entry) {'),ctx);
  const options=ctx.researchEditorOptions(entry);
  options.openGit(p);options.openCommit(p,oid);options.openGitDiscussion(p,oid);
  assert.deepEqual(calls.map(([name])=>name),['research_git_history','research_git_commit','research_git_discussion']);
  assert.ok(calls.every(call=>call[2].editorState===entry.editorState));
  assert.equal(calls[2][2].local,true);
  const pending=options.invoke('hub_detail',{name:'research_git_history',ids:[p]});
  ctx.researchAccountGeneration=2;finish({projectId:p});
  await assert.rejects(pending,/接続が変わりました/);
  await assert.rejects(options.invoke('hub_detail',{}),/接続が変わりました/);
});

test('ordinary navigation disposes reader without deleting draft; account invalidation uses the stronger boundary',()=>{
  const calls=[],controller={dispose:()=>calls.push('dispose'),invalidate:()=>calls.push('invalidate')};
  const ctx=vm.createContext({researchDetailController:controller});
  vm.runInContext(fn('function releaseResearchDetail(invalidate=false) {'),ctx);
  ctx.releaseResearchDetail();assert.equal(ctx.researchDetailController,null);
  ctx.researchDetailController=controller;ctx.releaseResearchDetail(true);
  assert.deepEqual(calls,['dispose','invalidate']);
});

test('actual Git renderer removes loading placeholders, reuses prepared data and offers connection without starting it',async()=>{
  const dom=new JSDOM('<main><div class="skeleton-post"></div></main>'),target=dom.window.document.querySelector('main'),calls=[];
  const options={state:{},invoke:async()=>assert.fail('Prepared history is sufficient'),connectAccount:()=>calls.push('connect')};
  const start=source.indexOf('const gitReader='),end=source.indexOf('\nconst DETAIL_RENDERERS =',start);
  const render=new Function('researchGitBrowser','researchEditorOptions','desktopAccount','actionButton','invoke','showNotice','friendlyError',source.slice(start,end)+';return gitReader;')(
    researchGitBrowser,()=>options,{state:'signed_out'},(label,_class,run)=>{const button=dom.window.document.createElement('button');button.textContent=label;button.onclick=run;return button;},async()=>assert.fail('No external browser'),()=>{},String);
  const controller=render(target,{projectId:p,commits:[]},{ids:[p]});await controller.ready;
  assert.equal(target.querySelector('.skeleton-post'),null);assert.equal(controller.root.dataset.researchSection,'コードの変更');
  assert.deepEqual(calls,[]);[...controller.root.querySelectorAll('button')].find(n=>n.textContent==='議論するためDesktopを接続').click();assert.deepEqual(calls,['connect']);
  controller.dispose();dom.window.close();
});

test('initial permission refusals discard code caches and retain owned draft and operation recovery',async()=>{
  for(const refusal of ['見つかりませんでした','このアカウントは停止されているか、権限がありません','ハブが 401 を返しています']){
    const dom=new JSDOM('<main></main><p></p>'),target=dom.window.document.querySelector('main'),status=dom.window.document.querySelector('p'),pin={requestId:'keep'},editor={gitBrowser:{history:{commits:[oid]},details:{[oid]:{diff:'Previously public'}}},gitDiscussions:{pin},document:{title:'Keep'}};
    const entry={name:'research_git_commit',ids:[p,oid],editorState:editor};
    const ctx=vm.createContext({videoCommentsController:null,researchDetailController:null,communityChannelPolicyController:null,detailRenderRevision:0,researchAccountGeneration:0,detailTrail:[entry],currentView:'detail',paintDetailHead(){},detailState:()=>status,detailContent:()=>target,skeletonResult:()=>dom.window.document.createElement('div'),invoke:async()=>{throw refusal;},communityAppealReviewRequest:()=>null,communityReportReviewRequest:()=>null,communityMembershipReviewRequest:()=>null,communityGuideRequest:()=>({name:entry.name,ids:entry.ids}),DETAIL_RENDERERS:{},isReadAccessDenied,retryButton:run=>{const n=dom.window.document.createElement('button');n.onclick=run;return n;},friendlyError:String});
    vm.runInContext(fn('function releaseResearchDetail(invalidate=false) {'),ctx);vm.runInContext(fn('function releaseCommunityChannelPolicy(invalidate=false){'),ctx);vm.runInContext(fn('async function renderDetailEntry(entry) {'),ctx);
    await ctx.renderDetailEntry(entry);
    assert.deepEqual(editor.gitBrowser,{});assert.equal(editor.gitDiscussions.pin,pin);assert.equal(editor.document.title,'Keep');assert.equal(target.textContent.includes('Previously public'),false);assert.equal(status.textContent,refusal);
    dom.window.close();
  }
});

function paperCodeFixture(t,{hold=false}={}){
 const dom=new JSDOM('<main><section><pre>Fixed paper v2</pre></section></main>'),document=dom.window.document,target=document.querySelector('main'),root=target.querySelector('section'),opened=[],calls=[];
 let release;const exit=hold?new Promise(resolve=>release=resolve):Promise.resolve();
 const data={signedIn:true,canEdit:false,canDiscuss:true,document:{id:'paper',projectId:p,title:'Fixed Paper',head:2,visibility:'public'},revision:{version:2,summary:'Fixed source',body:'Fixed paper v2',contentHash:'sha256:'+'c'.repeat(64)},history:[{version:2,summary:'Fixed source'}]};
 const entry={name:'research_revision',ids:[p,'paper','2'],data,editorState:{}};
 const ctx=vm.createContext({document,window:dom.window,researchAccountGeneration:1,detailRenderRevision:1,currentView:'detail',detailTrail:[entry],detailForwardTrail:[],detailReturn:{view:'research'},toolbarTrail:[{view:'detail',title:'Fixed Paper'}],toolbarTrailIndex:0,
  articleEditorScope:()=>null,friendlyError:String,offerPublicContentShare(){},browserTransition:0,browserActive:true,browserControls:null,
  invoke:async(name,args)=>{calls.push({name,args});assert.equal(name,'browser_exit');return exit;},detailContent:()=>target,viewScroller:()=>null,saveDetailTrail(){},showView(){},captureSocialScene(){},renderDetailEntry:value=>opened.push(value)});
 for(const signature of ['function researchEditorOptions(entry) {','async function exitBrowser() {','async function openDetail(name, ids, opts = {}) {'])vm.runInContext(fn(signature),ctx);
 const controller=documentWorkspace(root,data,ctx.researchEditorOptions(entry)),body=root.querySelector('textarea[name="body"]'),summary=root.querySelector('input[name="summary"]');
 body.value='Preserve the fixed paper draft';body.dispatchEvent(new dom.window.Event('input'));summary.value='Preserve this reason';summary.dispatchEvent(new dom.window.Event('input'));
 t.after(()=>{controller.dispose();dom.window.close();});return{dom,target,root,data,entry,ctx,controller,opened,calls,release,code:[...root.querySelectorAll('button')].find(button=>button.textContent==='このプロジェクトのコード')};
}

test('actual fixed-paper code navigation preserves its project, editor state, version and content hash',async t=>{
 const f=paperCodeFixture(t),state=f.entry.editorState;await f.code.onclick();assert.equal(f.opened.length,1);assert.equal(f.opened[0].name,'research_git_history');assert.deepEqual(Array.from(f.opened[0].ids),[p]);assert.equal(f.opened[0].editorState,state);
 assert.deepEqual(f.entry.ids,[p,'paper','2']);assert.equal(f.entry.data.revision.version,2);assert.equal(f.entry.data.revision.contentHash,'sha256:'+'c'.repeat(64));assert.equal(state.edit.body,'Preserve the fixed paper draft');assert.equal(state.edit.summary,'Preserve this reason');assert.deepEqual(f.calls.map(call=>call.name),['browser_exit']);
});

for(const boundary of ['actor','origin','view','detach','revision'])test('fixed-paper code navigation rejects '+boundary+' change while actual browser exit is pending',async t=>{
 const f=paperCodeFixture(t,{hold:true}),opening=f.code.onclick();await Promise.resolve();assert.equal(f.calls.length,1);
 if(boundary==='actor')f.ctx.researchAccountGeneration++;
 else if(boundary==='origin'){f.ctx.researchAccountGeneration++;f.ctx.detailTrail=[];f.controller.invalidate();f.root.remove();}
 else if(boundary==='view')f.ctx.currentView='feed';
 else if(boundary==='detach')f.root.remove();
 else f.ctx.detailRenderRevision++;
 const history=f.ctx.detailTrail.slice();f.release();await opening;assert.deepEqual(f.opened,[]);assert.equal(f.ctx.detailTrail.length,history.length);assert.equal(f.ctx.detailTrail.some(value=>value.name==='research_git_history'),false);assert.deepEqual(f.calls.map(call=>call.name),['browser_exit']);
});

