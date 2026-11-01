import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {templateFor} from './desktop-template.mjs';
const root=new URL('./',import.meta.url);
const {JSDOM}=createRequire(new URL('../../hub/package.json',import.meta.url))('jsdom');
const source=readFileSync(new URL('app.js',root),'utf8');
function block(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function fixture(t){
 const dom=new JSDOM(readFileSync(new URL('index.html',root),'utf8'),{url:'http://localhost'});
 dom.window.HTMLElement.prototype.scrollIntoView=function(){};
 t.after(()=>dom.window.close());
 const ctx=vm.createContext({templateFor,navCommunities:{setCurrent(){},refresh:async()=>{}},applyColumnWidths(){},contentSharePreview:null,document:dom.window.document,Node:dom.window.Node,matchMedia:()=>({matches:false}),requestAnimationFrame:f=>f(),
  captureSocialScene(){},socialStreamController:null,loadFeed:async()=>{},disposeExternalMediaRegistration(){},syncSavedSearchView(){},articleEditor:null,syncOwnedEventListings(){},queueMicrotask,notificationsController:{invalidate(){}},releaseWalletTipSettings(){},releaseOwnedEventListings(){},hubPeers:{closeTransfer(){}},communityInviteController:null,researchAccountGeneration:0,currentView:'feed',toolbarTrail:[{view:'feed',title:'フィード'}],toolbarTrailIndex:0,toolbarReplaying:false,detailHistoryReplaying:false,
  detailTrail:[],detailForwardTrail:[],detailReturn:{view:'feed'},DETAIL_PARENT_VIEW:{thread:'threads'},viewScroll:new Map(),appsOpen:false,accountSidebarAutoCollapsed:false,
  threadBoardKey:'',threadBoardTitle:'',rightRailAvailable:()=>false,railChoiceFor:()=>false,syncSidebarForRail(){},renderSidebarContext(){},railActivityReady:false,
  updateToolbarNavigation(){},viewScroller:()=>dom.window.document.querySelector('.workspace-main'),exitBrowser:async()=>{},
  CATALOGS:{threads:{},articles:{}},loadCatalog:async()=>{},renderDetailEntry:async()=>{},videoWatchIndex:-1,videoWatchHistory:[],videoSceneRevision:0,captureVideoScene(){},videoSearch:{invalidate(){}}});
 for(const code of [block('function syncCommunityInvite(reset=false){','\nfunction releaseCommunityChannelPolicy('),block('function showView(view, title','\nfunction textValue('),
  block('function saveDetailTrail() {','\nfunction updateToolbarNavigation('),
  block('async function openDetail(name, ids, opts = {}) {','\nasync function detailBack()'),
  block('async function detailBack() {','\nasync function detailForward()')]) vm.runInContext(code,ctx);
 vm.runInContext(block('async function navigateFrom(item','\nfor (const item of document.querySelectorAll(".nav-item, .mobile-nav-item"))'),ctx);
 vm.runInContext(block('async function travelToolbar(direction) {','\ndocument.querySelector("#toolbar-back").onclick'),ctx);
 ctx.socialMode='mixed';ctx.socialFilter='all';ctx.socialScope='latest';ctx.socialWantedScene=null;ctx.feedScope='recommended';ctx.feedListId=null;ctx.homeAccountEpoch={};ctx.navigationSnapshot=Object.freeze({context:Object.freeze({}),pages:2});ctx.socialStreamController={navigation:()=>ctx.navigationSnapshot,invalidate(){}};
 vm.runInContext(block('function captureSocialScene(){','\nasync function selectSocial('),ctx);
 return {ctx,document:dom.window.document,nav:dataset=>ctx.navigateFrom({dataset,childNodes:[],getAttribute:()=>null})};
}
test('back and forward retain the selected board and current query',async t=>{
 const f=fixture(t);await f.nav({view:'threads',boardKey:'board-a',boardTitle:'科学'});
 f.document.querySelector('#threads-query').value='引用研究';await f.nav({view:'articles',title:'記事'});
 await f.ctx.travelToolbar(-1);
 assert.equal(f.ctx.threadBoardKey,'board-a');assert.equal(f.ctx.threadBoardTitle,'科学');assert.equal(f.document.querySelector('#threads-query').value,'引用研究');
 await f.ctx.travelToolbar(1);assert.equal(f.ctx.currentView,'articles');await f.ctx.travelToolbar(-1);assert.equal(f.ctx.threadBoardKey,'board-a');
});
test('returning from a thread detail preserves the query, changing boards clears it',async t=>{
 const f=fixture(t);await f.nav({view:'threads',boardKey:'board-a',boardTitle:'科学'});
 f.document.querySelector('#threads-query').value='引用研究';await f.ctx.openDetail('thread',['id-1'],{title:'議論'});await f.ctx.detailBack();
 assert.equal(f.ctx.threadBoardKey,'board-a');assert.equal(f.document.querySelector('#threads-query').value,'引用研究');
 await f.nav({view:'threads',boardKey:'board-b',boardTitle:'技術'});assert.equal(f.document.querySelector('#threads-query').value,'');
 f.document.querySelector('#threads-query').value='別の検索';await f.nav({view:'threads',title:'スレッド'});
 assert.equal(f.ctx.threadBoardKey,'');assert.equal(f.document.querySelector('#threads-query').value,'');
});
test('opening the browser keeps the latest board query in app history',async t=>{
 const f=fixture(t);f.ctx.enterBrowser=async(_url,history)=>f.ctx.showView('browser','ブラウザ',history);
 await f.nav({view:'threads',boardKey:'board-a',boardTitle:'科学'});
 f.document.querySelector('#threads-query').value='ブラウザで調べる';await f.nav({view:'browser'});await f.ctx.travelToolbar(-1);
 assert.equal(f.ctx.threadBoardKey,'board-a');assert.equal(f.document.querySelector('#threads-query').value,'ブラウザで調べる');
});
test('a pending history read cannot suppress a newer destination or reset its history',async t=>{
 const f=fixture(t);f.ctx.enterBrowser=async(_url,history)=>f.ctx.showView('browser','ブラウザ',history);
 await f.nav({view:'threads',boardKey:'board-a',boardTitle:'科学'});await f.nav({view:'articles',title:'記事'});
 let finish;f.ctx.loadCatalog=()=>new Promise(resolve=>{finish=resolve;});const pending=f.ctx.travelToolbar(-1);
 await new Promise(setImmediate);assert.equal(f.ctx.currentView,'threads');
 f.document.querySelector('#threads-query').value='通信待ちでも移動';await f.nav({view:'browser'});
 assert.equal(f.ctx.toolbarTrail.at(-1).view,'browser');
 f.ctx.loadCatalog=async()=>{};finish();await pending;
 await f.ctx.travelToolbar(-1);assert.equal(f.ctx.currentView,'threads');assert.equal(f.ctx.threadBoardKey,'board-a');assert.equal(f.document.querySelector('#threads-query').value,'通信待ちでも移動');
});


test('mixed detail return retains classification, ordering, scroll and opaque page snapshot',async t=>{
 const f=fixture(t);f.ctx.socialFilter='thread';f.ctx.socialScope='following';f.document.querySelector('.workspace-main').scrollTop=240;
 await f.ctx.openDetail('thread',['synthetic'],{title:'議論'});
 f.ctx.socialFilter='post';f.ctx.socialScope='latest';
 f.ctx.loadFeed=async()=>{assert.equal(f.ctx.socialWantedScene.scroll,240);assert.equal(f.ctx.socialWantedScene.snapshot,f.ctx.navigationSnapshot);assert.equal(f.ctx.socialWantedScene.snapshot.pages,2);};
 await f.ctx.detailBack();assert.equal(f.ctx.currentView,'feed');assert.equal(f.ctx.socialFilter,'thread');assert.equal(f.ctx.socialScope,'following');
});
test('mixed toolbar history retains each scene separately across destinations',async t=>{
 const f=fixture(t);f.ctx.socialFilter='community';f.ctx.socialScope='following';await f.nav({view:'articles',title:'記事'});
 f.ctx.socialFilter='all';f.ctx.socialScope='latest';f.ctx.loadFeed=async()=>{};await f.ctx.travelToolbar(-1);
 assert.equal(f.ctx.socialFilter,'community');assert.equal(f.ctx.socialScope,'following');assert.equal(f.ctx.currentView,'feed');
});
