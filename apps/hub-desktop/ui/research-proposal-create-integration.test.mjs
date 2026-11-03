import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {renderResearchDocument} from './research.mjs';
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const fn=name=>{const start=source.indexOf(name),end=source.indexOf('\n}',start)+2;assert.ok(start>=0&&end>start);return source.slice(start,end);};
const renderer=source.slice(source.indexOf('  research_revision: (target,'),source.indexOf('  post: renderPostDetail,'));
assert.ok(renderer.includes('research_document:'));
const account=source.split('\n').filter(line=>line.startsWith("function invalidateDetailContext(reload=true) {")||line.startsWith("window.addEventListener('hub-account-changed',()=>invalidateDetailContext());")).join('\n');
assert.ok(account.includes('function invalidateDetailContext(reload=true) {'));
assert.ok(account.includes("window.addEventListener('hub-account-changed',()=>invalidateDetailContext());"));
const projectId='rp_'+'a'.repeat(32),documentId='doc_1';
const data=()=>({document:{projectId,id:documentId,title:'Document',head:1,visibility:'public'},revision:{version:1,body:'Base content',summary:'Initial'},history:[{version:1,summary:'Initial'}],signedIn:true,canEdit:false,canDiscuss:false});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(check){for(let i=0;i<100&&!check();i++)await tick();assert.ok(check());}
const button=(root,label)=>[...root.querySelectorAll('button')].find(item=>item.textContent===label);
const receipt=payload=>({proposalId:payload.requestId,documentId:payload.documentId,baseVersion:payload.baseVersion,contentHash:'sha256:'+createHash('sha256').update(payload.body).digest('hex'),status:'open'});
function context(dom,entry,invoke){
 const target=dom.window.document.querySelector('main'),status=dom.window.document.querySelector('#status'),opened=[];
 const ctx=vm.createContext({sidebarContext:dom.window.document.createElement('nav'),offerPublicContentShare:()=>false,attachDetailAiHandoff(){},videoCommentsController:null,researchAccountGeneration:1,researchDetailController:null,communityDetailController:null,communityInviteController:null,detailRenderRevision:0,currentView:'detail',detailTrail:[entry],detailForwardTrail:[],toolbarTrail:[],window:dom.window,invoke,friendlyError:String,openDetail:(...args)=>opened.push(args),connectDesktopAccount(){},paintDetailHead(){},detailState:()=>status,detailContent:()=>target,skeletonResult:()=>dom.window.document.createElement('div'),communityAppealReviewRequest:()=>null,communityReportReviewRequest:()=>null,communityMembershipReviewRequest:()=>null,communityGuideRequest:value=>({name:value.name,ids:value.ids}),readingDirectory:new Set(),DETAIL_PARENT_VIEW:{research_document:'research',research_revision:'research'},renderSidebarContext(){},DETAIL_RENDERERS:{}});
 vm.runInContext(fn('function syncCommunityInvite(reset=false){'),ctx);
 vm.runInContext(fn('function researchEditorOptions(entry) {'),ctx);
 Object.assign(ctx.DETAIL_RENDERERS,new Function('renderResearchDocument','researchEditorOptions',`return ({${renderer}});`)(renderResearchDocument,ctx.researchEditorOptions));
 vm.runInContext(fn('function releaseResearchDetail(invalidate=false) {'),ctx);vm.runInContext(fn('function releaseCommunityDetail(invalidate=false){'),ctx);vm.runInContext(fn('async function renderDetailEntry(entry) {'),ctx);
 return {ctx,target,opened};
}
async function preview(target){const body=target.querySelector('textarea[name="body"]'),summary=target.querySelector('input[name="summary"]');body.value='Private <script>literal</script>';body.dispatchEvent(new target.ownerDocument.defaultView.Event('input'));summary.value='Private reason';summary.dispatchEvent(new target.ownerDocument.defaultView.Event('input'));body.form.dispatchEvent(new target.ownerDocument.defaultView.Event('submit',{bubbles:true,cancelable:true}));await until(()=>button(target,'確認して変更提案を保存')?.hidden===false);}

test('actual document and revision renderers return controllers, disable detached writes and retain the draft on back',async()=>{
 for(const name of ['research_document','research_revision']){
  const dom=new JSDOM('<main></main><p id="status"></p>'),entry={name,ids:[projectId,documentId],editorState:{}},calls=[];
  const {ctx,target}=context(dom,entry,async(name,args)=>{calls.push(name);assert.equal(name,'hub_detail');return data();});
  await ctx.renderDetailEntry(entry);assert.ok(ctx.researchDetailController?.dispose);await preview(target);const old=button(target,'確認して変更提案を保存');ctx.releaseResearchDetail();assert.equal(old.disabled,true);old.click();assert.deepEqual(calls,['hub_detail']);
  await ctx.renderDetailEntry(entry);assert.ok(ctx.researchDetailController?.invalidate);assert.match(target.textContent,/Private reason/);assert.ok(button(target,'確認して変更提案を保存'));assert.equal(target.querySelector('script'),null);ctx.releaseResearchDetail();dom.window.close();
 }
});
test('actual back and remount joins the pending request and saved navigation uses only the fixed proposal identity',async()=>{
 const dom=new JSDOM('<main></main><p id="status"></p>'),entry={name:'research_document',ids:[projectId,documentId],editorState:{}};let finish;const writes=[];
 const {ctx,target,opened}=context(dom,entry,async(name,args)=>{if(name==='hub_detail')return data();writes.push(args);return new Promise(resolve=>{finish=resolve;});});
 await ctx.renderDetailEntry(entry);await preview(target);button(target,'確認して変更提案を保存').click();await until(()=>writes.length===1);ctx.releaseResearchDetail();await ctx.renderDetailEntry(entry);assert.equal(button(target,'同じ提案の保存結果を確認する').disabled,true);
 finish(receipt(writes[0].options));await until(()=>button(target,'保存した変更提案を開く'));button(target,'保存した変更提案を開く').click();await tick();assert.equal(writes.length,1);assert.equal(opened[0][0],'research_proposal');assert.deepEqual(JSON.parse(JSON.stringify(opened[0][1])),[projectId,writes[0].options.requestId]);assert.equal(opened[0][2].title,'変更提案の比較');assert.doesNotMatch(opened[0][2].title,/Private/);ctx.releaseResearchDetail();dom.window.close();
});
test('actual account hook invalidates the old proposal memory and rejects a late save acknowledgement',async()=>{
 const dom=new JSDOM('<main></main><p id="status"></p>'),oldState={},entry={name:'research_document',ids:[projectId,documentId],editorState:oldState};let finish;const writes=[];
 const {ctx,target}=context(dom,entry,async(name,args)=>{if(name==='hub_detail')return data();writes.push(args);return new Promise(resolve=>{finish=resolve;});});
 await ctx.renderDetailEntry(entry);await preview(target);button(target,'確認して変更提案を保存').click();await until(()=>writes.length===1);const entries=oldState.proposalSubmissions;vm.runInContext(account,ctx);dom.window.dispatchEvent(new dom.window.Event('hub-account-changed'));await until(()=>entry.editorState!==oldState&&target.querySelector('textarea'));
 finish(receipt(writes[0].options));await tick();assert.deepEqual(entries,{});assert.equal(oldState.edit,undefined);assert.doesNotMatch(target.textContent,/Private reason|保存済みです/);assert.equal(target.querySelector('textarea').value,'Base content');ctx.releaseResearchDetail();dom.window.close();
});
