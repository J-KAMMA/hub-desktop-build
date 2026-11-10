
import {attachContentShare} from './content-share.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createVideoPosts} from './video-posts.mjs';
import {stopVideoPlayer,createWatchStage,createWatchHeader,createRelatedList,rememberWatched} from './video-home.mjs';
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
function slice(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
test('wallet account-change hook invalidates the old response, clears history and reloads only the visible wallet',()=>{
 const {window}=new JSDOM('<div id="wallet-results"><article>old</article></div>'),{document}=window,target=document.querySelector('div'),old=Symbol('request'),loaded=[];target.catalogRequest=old;
 const initialize=new Function('window','document','loadCatalog',`let currentView='wallet',walletHistoryController={destroy(){document.querySelector('article').remove();}};${slice("window.addEventListener('hub-account-changed',()=>{\n  walletHistoryController", 'function walletBalanceSummary(')};return view=>{currentView=view;};`);
 const select=initialize(window,document,view=>loaded.push(view));window.dispatchEvent(new window.Event('hub-account-changed'));assert.notEqual(target.catalogRequest,old);assert.equal(target.textContent,'');assert.deepEqual(loaded,['wallet']);select('feed');window.dispatchEvent(new window.Event('hub-account-changed'));assert.equal(loaded.length,1);
});
test('listing search results keep their own route and product results are no longer a group',()=>{
 const {window}=new JSDOM('<main/>'),{document}=window,opened=[];
 const render=new Function('document','resultCard','textValue','openDetail','GROUP_LABELS','searchPost','openHubPath','playMusicTrack','playMusicWork','openStoreGame',slice('function searchResultOpener(', 'function renderPublicResults(')+';return searchResultCard;')(document,()=>document.createElement('article'),r=>r.title,(...args)=>opened.push(args),{},()=>{},()=>{},()=>{},()=>{},()=>{});
 render('listings',{id:'listing_1',title:'出品'}).click();render('products',{id:'product_1',title:'商品'}).click();
 assert.deepEqual(opened.map(([name,ids])=>[name,ids]),[['listing',['listing_1']]]);
});
test('video notification paths open native detail and reject newline, extra segments and encoded injection',()=>{
 const route=new Function(slice('function detailForHubPath(', '// Hubpedia・記事の本文はMarkdown')+';return detailForHubPath;')();
 for(const path of ['/videos/video_1','/v2/videos/video_1?comment=c1#comments'])assert.deepEqual(route(path),{name:'video',ids:['video_1'],title:'動画'});
 for(const path of ['/videos/video_1\n','/videos/video_1/comments','/videos/%2e%2e','/videos/'+ 'a'.repeat(129)])assert.equal(route(path),null);
});
test('real video detail unwraps API data and mounts comments beside provider playback',async()=>{
 const {document}=new JSDOM('<main/>').window,target=document.querySelector('main'),calls=[],opened=[];
 const globals={document,createCommunityTalk:()=>({root:document.createElement("div")}),openCommunityThread(){},friendlyError:String,mountVideoPosts:o=>createVideoPosts(document,o),relTime:()=>'',hubAsset:()=>{},enterBrowser:url=>opened.push(url),researchEditorOptions:()=>({isCurrent:()=>true,invoke:async(name,args)=>{calls.push([name,args]);return {posts:[],nextCursor:null};}}),detailRenderRevision:1,videoCommentsController:null,createVideoPosts,postCard:()=>document.createElement('article'),openDetail:()=>{}};
 const render=new Function(...Object.keys(globals),slice('function renderVideoDetail(', '// --- プロフィール詳細')+';return {render:renderVideoDetail,controller:()=>videoCommentsController};')(...Object.values(globals));
 const entry={ids:['video_1']};render.render(target,{video:{title:'API動画',sourceUrl:'https://example.org/watch'}},entry);await render.controller().ready;
 assert.equal(target.querySelector('h3').textContent,'API動画');assert.ok(target.textContent.includes('ポスト'));assert.deepEqual(calls,[['hub_detail',{name:'video_posts',ids:['video_1']}]]);
 [...target.querySelectorAll('button')].find(b=>b.textContent==='提供元で再生').click();assert.deepEqual(opened,['https://example.org/watch']);assert.ok(entry.videoCommentDraft);render.controller().destroy();
});
test('real watch screen preserves per-video draft, destroys old controls and retains saved-video action',async()=>{
 const {document}=new JSDOM('<div class="workspace-main"><div id="video-discover"></div><div id="video-watch" hidden><button id="video-watch-back"></button><main id="video-watch-main"></main><aside id="video-watch-related"></aside></div></div>').window,calls=[],saved=[];
 const globals={document,ytDock:null,attachVideoEngagement(){},hideVideoChannel(){},hideVideoStudio(){},mountVideoPosts:o=>createVideoPosts(document,o),attachContentShare,offerPublicContentShare(){},disposeExternalMediaRegistration(){},homeAccountEpoch:{},attachAiHandoff(){},aiHandoffContext:()=>null,askAiAboutPublicContent(){},appendPlaylistEntry(){},viewScroller:()=>document.querySelector(".workspace-main"),rememberVideoScroll(){},hubAsset(){},stopVideoPlayer,createWatchStage,createWatchHeader,createRelatedList,rememberWatched,renderVideoHomeRows(){},enterBrowser:()=>{},relTime:()=>'',researchAccountGeneration:1,currentView:'videos',attachContentSave:options=>saved.push(options),invoke:async(name,args)=>{calls.push([name,args]);return {posts:[],nextCursor:null};},createVideoPosts,postCard:()=>document.createElement('article'),openDetail:()=>{},appendResearchBacklinks:()=>{},videoCollection:[],renderSidebarContext:()=>{},updateToolbarNavigation:()=>{}};
 const render=new Function(...Object.keys(globals),'let videoWatchHistory=[],videoWatchIndex=-1,videoWatchComments=null,videoWatchRevision=0,videoListScroll=0,videoWatchScrolls=[],videoSearchState=null;const videoCommentDrafts=new Map();'+slice('function showVideoList() {','// 視聴画面のいいね・チャンネル')+';return {open:openVideoWatch,list:showVideoList,controller:()=>videoWatchComments};')(...Object.values(globals));
 const first={id:'video_1',title:'第一動画'},second={id:'video_2',title:'第二動画'};render.open(first);await render.controller().ready;
 const input=document.querySelector('textarea');input.value='下書き';input.dispatchEvent(new document.defaultView.Event('input'));const old=render.controller();render.open(second);await render.controller().ready;assert.equal(old.element.isConnected,false);
 render.open(first);await render.controller().ready;assert.equal(document.querySelector('textarea').value,'下書き');assert.equal(saved.length,3);assert.equal(saved[2].kind,'video');assert.equal(saved[2].id,'video_1');assert.equal(calls.length,3);render.list();assert.equal(document.querySelector('textarea'),null);assert.equal(document.querySelector('#video-watch').hidden,true);
});
