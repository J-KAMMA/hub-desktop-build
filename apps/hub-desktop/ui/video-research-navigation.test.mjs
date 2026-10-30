import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createVideoPosts} from './video-posts.mjs';
import {articleReadingMinutes,articleReadingLabel} from './article-reading.mjs';
import {appendResearchBacklinks as realResearchBacklinks} from './research-discovery.mjs';
import {openLicenseLabel} from './content-license.mjs';

const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function actual(signature){const start=source.indexOf(signature),end=source.indexOf('\n}',start);assert.ok(start>=0&&end>start,signature);return source.slice(start,end+2);}
const signatures=[
 'async function renderDetailEntry(entry) {','function renderVideoDetail(target, data, entry) {',
 'function renderArticleDetail(target, data) {','async function appendResearchBacklinks(target,kind,id,current=()=>true) {',
 'function saveDetailTrail() {','async function openDetail(name, ids, opts = {}) {','async function detailBack() {',
];
const tick=()=>new Promise(setImmediate),deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fixture(t){
 const dom=new JSDOM('<main></main><p id="status"></p>'),document=dom.window.document,calls=[],controllers=[];
 const f={dom,document,calls,controllers,pending:null,viewer:'viewer-a'};
 const ctx=vm.createContext({document,createVideoPosts,mountVideoPosts:o=>createVideoPosts(document,o),postCard:()=>document.createElement('article'),videoCommentsController:null,researchDetailController:null,communityChannelPolicyController:null,
  detailRenderRevision:0,researchAccountGeneration:0,homeAccountEpoch:{},currentView:'detail',detailTrail:[],detailForwardTrail:[],detailReturn:{view:'feed',title:'Feed'},desktopAccount:{state:'registered',deviceId:'device-a'},
  toolbarTrail:[{view:'feed',title:'Feed'},{view:'detail',title:'Video'}],toolbarTrailIndex:1,
  releaseResearchDetail(){},releaseCommunityChannelPolicy(){},paintDetailHead(){},detailState:()=>document.querySelector('#status'),detailContent:()=>document.querySelector('main'),skeletonResult:()=>document.createElement('div'),
  communityGovernanceRequest:()=>null,communityAppealReviewRequest:()=>null,communityReportReviewRequest:()=>null,communityMembershipReviewRequest:()=>null,communityGuideRequest:entry=>({name:entry.name,ids:entry.ids}),
  attachContentSave(){},attachContentShare(){},attachDetailAiHandoff(){},offerPublicContentShare(){},appendPlaylistEntry(){},readingDirectory:new Set(),DETAIL_PARENT_VIEW:{research_project:'research'},renderSidebarContext(){},relTime:()=> 'now',
  articleBodyNodes:body=>{const p=document.createElement('p');p.textContent=body;return[p];},articleReadingMinutes,articleReadingLabel,openLicenseLabel,openHubPath(){},
  markdownBlocks:body=>{const p=document.createElement('p');p.textContent=body;return[p];},friendlyError:String,
  exitBrowser:async()=>{},captureVideoScene(){},captureSocialScene(){},viewScroller:()=>document.querySelector('main'),updateToolbarNavigation(){},
  showView:view=>{ctx.currentView=view;},
  invoke:async(name,args)=>{calls.push({name,args:structuredClone(args)});
   if(name!=='hub_detail')assert.fail('Read-only detail invocation required');
   if(args.name==='video')return{video:{id:args.ids[0],title:'Video '+args.ids[0]}};
   if(args.name==='video_posts')return{posts:[],nextCursor:null};
   if(args.name==='article')return{article:{title:'Article',body:'Text'}};
   if(args.name==='research_project')return{project:{id:args.ids[0]}};
   if(args.name.startsWith('research_backlinks_'))return f.pending?await f.pending.promise:{projects:[{id:'rp_'+args.ids[0].replaceAll('-','_'),title:'Research for '+args.ids[0]}]};
   assert.fail('Unexpected detail '+args.name);
  },
  renderResearchBacklinks:(target,options)=>{const controller=realResearchBacklinks(target,options);controllers.push(controller);return controller;},
 });
 ctx.researchEditorOptions=entry=>({invoke:ctx.invoke,isCurrent:()=>ctx.currentView==='detail'&&ctx.detailTrail.at(-1)===entry});
 vm.runInContext(signatures.map(actual).join('\n'),ctx);f.ctx=ctx;
 ctx.DETAIL_RENDERERS={video:ctx.renderVideoDetail,article:ctx.renderArticleDetail,research_project:(target,data)=>{target.textContent='Project '+data.project.id;}};
 f.entry=(name='video',id='video-a')=>({name,ids:[id],title:id,videoCommentDraft:{body:'Unsent comment for '+id,viewerId:f.viewer}});
 f.show=async entry=>{ctx.currentView='detail';ctx.detailTrail=[entry];await ctx.renderDetailEntry(entry);await tick();return document.querySelector('main');};
 f.change=boundary=>{if(boundary==='account'){ctx.desktopAccount={state:'registered',deviceId:'device-b'};ctx.researchAccountGeneration++;ctx.homeAccountEpoch={};}else if(boundary==='origin'){ctx.detailRenderRevision++;ctx.researchAccountGeneration++;ctx.homeAccountEpoch={};}else ctx.currentView='feed';};
 t.after(()=>{ctx.videoCommentsController?.destroy();controllers.forEach(controller=>controller.dispose());dom.window.close();});return f;
}

test('actual video detail reads its own research backlinks and returns from the project with the same comment draft',async t=>{
 const f=fixture(t),entry=f.entry(),draft=entry.videoCommentDraft;await f.show(entry);
 assert.deepEqual(f.calls.map(call=>call.args.name),['video','video_posts','research_backlinks_video']);
 const backlink=f.document.querySelector('.research-related-projects button');assert.ok(backlink,'Video details must expose linked research');assert.equal(backlink.textContent,'Research for video-a');
 const field=f.document.querySelector('[aria-label="動画についてのポスト"]');field.value='Keep exact unsent video draft';field.dispatchEvent(new f.dom.window.Event('input'));
 backlink.click();await tick();assert.equal(f.ctx.detailTrail.at(-1).name,'research_project');assert.deepEqual(Array.from(f.ctx.detailTrail.at(-1).ids),['rp_video_a']);
 await f.ctx.detailBack();await tick();assert.equal(f.ctx.detailTrail.at(-1),entry);assert.equal(entry.videoCommentDraft,draft);assert.equal(f.document.querySelector('[aria-label="動画についてのポスト"]').value,'Keep exact unsent video draft');
 assert.equal(f.document.querySelector('.research-related-projects button').textContent,'Research for video-a');assert.equal(f.calls.some(call=>call.name==='hub_client_action'),false);
});

test('article and distinct video details bind backlinks to their exact content kind and ID',async t=>{
 const f=fixture(t);
 for(const [name,id,expected]of [['article','article-a','research_backlinks_article'],['video','video-a','research_backlinks_video'],['video','video-b','research_backlinks_video']]){
  f.calls.length=0;await f.show(f.entry(name,id));const read=f.calls.find(call=>call.args.name===expected);assert.ok(read,expected);assert.deepEqual(read.args.ids,[id]);
  const buttons=[...f.document.querySelectorAll('.research-related-projects button')];assert.equal(buttons.length,1);assert.equal(buttons[0].textContent,'Research for '+id);
 }
});

test('account, origin and view changes suppress late research reads and captured project controls',async t=>{
 for(const boundary of ['account','origin','view']){
  const f=fixture(t);f.pending=deferred();await f.show(f.entry());assert.ok(f.calls.some(call=>call.args.name==='research_backlinks_video'));
  f.change(boundary);f.pending.resolve({projects:[{id:'rp_stale',title:'Stale Research'}]});await tick();assert.equal(f.document.querySelector('.research-related-projects button'),null);
 }
 for(const boundary of ['account','origin','view']){
  const f=fixture(t);await f.show(f.entry());const old=f.document.querySelector('.research-related-projects button');assert.ok(old);f.change(boundary);const reads=f.calls.length;old.click();await tick();assert.equal(f.calls.length,reads);assert.equal(f.ctx.detailTrail.length,1);
 }
});

test('changing to another video rejects the earlier captured research target',async t=>{
 const f=fixture(t);await f.show(f.entry('video','video-a'));const old=f.document.querySelector('.research-related-projects button');assert.ok(old);
 const next=f.entry('video','video-b');await f.show(next);const reads=f.calls.length;old.click();await tick();assert.equal(f.calls.length,reads);assert.equal(f.ctx.detailTrail.at(-1),next);assert.equal(f.document.querySelector('.research-related-projects button').textContent,'Research for video-b');
});
