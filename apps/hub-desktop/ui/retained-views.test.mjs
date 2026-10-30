import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createReadRecovery,isTransientReadError,isReadAccessDenied,readWaitText} from './hub-read-recovery.mjs';
import {appendResearchUpdates} from './research-discovery.mjs';
const source=await readFile(new URL('./app.js',import.meta.url),'utf8');
const updatesBlock=source.slice(source.indexOf('function renderFeedResearchUpdates('),source.indexOf('async function openDetail('));
const feedBlock=source.slice(source.indexOf('const feedAccountKey='),source.indexOf('async function loadMoreFeed()'));
const shopBlock=source.slice(source.indexOf('let shopLoadVersion ='),source.indexOf('// 検索・絞り込みはサーバー側。'));
function fixture(kind){
 const dom=new JSDOM('<details id="feed-post-order"></details><form id="composer"></form><section id="view-market" class="on"><div id="shop-state"></div><div id="shop-results"></div></section><div id="feed-list"></div><div id="feed-state"></div><button id="feed-refresh"></button>',{url:'http://localhost'}),document=dom.window.document;
 const f={dom,kind,error:'',networkError:'',selection:'one',items:[{id:'old',title:'old',updatedAt:'2026-10-01'}],pending:null,calls:[]};
 const node=text=>Object.assign(document.createElement('div'),{textContent:text||''});
 const feed={list:document.querySelector('#feed-list'),state:document.querySelector('#feed-state')};
 const shop={query:'',sellerFilter:null,visible:[],products:[],otherProducts:[],cart:{},cartProducts:{}};
 const read=async()=>{f.calls.push('read');if(f.pending)return f.pending;if(f.error)throw f.error;return f.items;};
 const ctx=vm.createContext({socialBar:node(),socialMode:"legacy",mixedPublicationUpdates:null,appendResearchUpdates,createReadRecovery,isTransientReadError,isReadAccessDenied,readWaitText,document,window:dom.window,desktopAccount:{state:'registered',deviceId:'alice'},currentView:kind==='feed'?'feed':'market',
  feed,feedListId:null,feedTabLists:{epoch:null,items:[]},renderFeedTabs(){},statePanel:(_icon,title)=>Object.assign(document.createElement('div'),{textContent:title}),feedScope:'recommended',feedLoadFailed:false,feedLoadRevision:0,feedMore:node(),feedFresh:node(),feedFreshItems:[],feedSeenId:null,feedPage:{},feedSeenKey:()=>'',localStorage:dom.window.localStorage,
  hubNetwork:{failedOrigins:(_kind,transientOnly=false)=>!transientOnly||isTransientReadError(f.networkError)?f.failedOrigins||[]:[],ready:Promise.resolve(),context:()=>f.selection,includePrimary:()=>true,errors:()=>f.networkError?[f.networkError]:[],load:async()=>f.networkItems||[]},
  invoke:async(name,args)=>{if(name==='hub_feed')return {posts:await read(),hasMore:false,signedIn:true};if(name==='hub_client')return {items:[]};if(name==='hub_resource')return {resources:[]};throw Error('unexpected operation');},
  shop,fetchShopCatalog:async()=>({listed:await read(),others:[],data:{products:f.items,paymentsEnabled:true,paymentAssets:[]},nextCursor:null}),settleWithin:p=>p,
  renderFeedPosts:posts=>feed.list.replaceChildren(...posts.map(p=>node(p.title))),
  renderShopResults:()=>document.querySelector('#shop-results').replaceChildren(...shop.visible.map(p=>node(p.title))),
  updateSourceSummary(){},updateCartBadge(){},skeletonPost:()=>node('loading'),skeletonResult:()=>node('loading'),
  accountNeeded:e=>e==='desktop_not_connected',activityPubUrl:()=>null,emptyState:(icon,title)=>node(title),friendlyError:e=>String(e),connectState:()=>node('connect'),retryButton:()=>node('retry')});
 vm.runInContext(kind==='feed'?updatesBlock+feedBlock:shopBlock,ctx);
 return Object.assign(f,{ctx,shop,feed,target:kind==='feed'?feed.list:document.querySelector('#shop-results'),status:kind==='feed'?feed.state:document.querySelector('#shop-state'),load:()=>vm.runInContext(kind==='feed'?'loadFeed()':'loadShop()',ctx),dispose:()=>{dom.window.dispatchEvent(new dom.window.Event('pagehide'));dom.window.close();}});
}
for(const kind of ['feed','shop']){
 test(`${kind}: keeps displayed items while waiting and after a timeout, then automatically replaces them`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(kind);t.after(f.dispose);await f.load();assert.equal(f.target.textContent,'old');
  let reject;f.pending=new Promise((_,r)=>reject=r);const loading=f.load();await new Promise(setImmediate);assert.equal(f.target.textContent,'old');assert.match(f.status.textContent,/前回の表示/);
  if(kind==='shop'){assert.equal(f.shop.catalogStale,true);assert.equal(f.shop.paymentsEnabled,false);}
  reject('network_timeout');await loading;assert.equal(f.target.textContent,'old');assert.match(f.status.textContent,/応答を待っています/);
  f.pending=null;f.items=[{id:'new',title:'new'}];t.mock.timers.tick(1000);await new Promise(setImmediate);
  assert.equal(f.target.textContent,'new');if(kind==='shop'){assert.equal(f.shop.catalogStale,false);assert.equal(f.shop.paymentsEnabled,true);}
 });
 if(kind==='feed')test(`${kind}: source changes and successful empty responses remove obsolete content`,async t=>{
  const f=fixture(kind);t.after(f.dispose);await f.load();f.selection='two';f.error='invalid_response';await f.load();assert.ok(!f.target.textContent.includes('old'));
  f.error='';f.items=[];await f.load();assert.ok(!f.target.textContent.includes('old'));
 });
 test(`${kind}: account changes clear the view and late reads cannot restore it`,async t=>{
  const f=fixture(kind);t.after(f.dispose);await f.load();let done;f.pending=new Promise(r=>done=r);const old=f.load();await new Promise(setImmediate);
  f.ctx.desktopAccount={state:'signed_out'};f.error='desktop_not_connected';f.pending=null;f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));await new Promise(setImmediate);
  done([{id:'secret',title:'old-account-content'}]);await old;assert.ok(!f.target.textContent.includes('old-account-content'));assert.ok(!f.target.textContent.includes('old'));
 });
 if(kind==='feed')test(`${kind}: additional Hub timeouts recover automatically and leave the previous view visible`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(kind);t.after(f.dispose);await f.load();f.networkError='network_timeout';await f.load();assert.equal(f.target.textContent,'old');
  f.networkError='';f.items=[{id:'new',title:'new'}];t.mock.timers.tick(1000);await new Promise(setImmediate);assert.equal(f.target.textContent,'new');
 });
}
test('shop: a successful empty response removes obsolete content',async t=>{
 const f=fixture('shop');t.after(f.dispose);await f.load();assert.ok(f.target.textContent.includes('old'));f.items=[];await f.load();assert.ok(!f.target.textContent.includes('old'));
});
test('shop: search changes do not retain another query and stale catalogs cannot add to cart',async t=>{
 const f=fixture('shop');t.after(f.dispose);await f.load();f.shop.query='different';f.error='invalid_response';await f.load();assert.ok(!f.target.textContent.includes('old'));
 f.shop.catalogStale=true;vm.runInContext(source.slice(source.indexOf('async function addShopProduct('),source.indexOf('function renderShopResults()')),f.ctx);
 await vm.runInContext('addShopProduct({id:"old"})',f.ctx);assert.deepEqual(f.shop.cart,{});
});
test('response waits are distinguished from unreachable connections',()=>{
 assert.match(readWaitText('network_timeout'),/応答を待っています/);assert.match(readWaitText('network_unavailable'),/接続できません/);
 for(const error of ['desktop_not_connected','invalid_response','account_required'])assert.equal(isTransientReadError(error),false);
});

for(const kind of ['feed','shop'])test(`${kind}: explicit access denial removes retained content without retry`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(kind);t.after(f.dispose);await f.load();f.error='desktop_account_unauthorized';await f.load();assert.ok(!f.target.textContent.includes('old'));const before=f.calls.length;
 t.mock.timers.tick(60000);await new Promise(setImmediate);assert.equal(f.calls.length,before);
});

for(const kind of ['feed'])test(`${kind}: an unavailable additional Hub does not prevent fresh primary content`,async t=>{
 const f=fixture(kind);t.after(f.dispose);await f.load();f.networkError='network_timeout';f.items=[{id:'new',title:'new-primary'}];await f.load();
 assert.equal(f.target.textContent,'new-primary');assert.match(f.status.textContent,/前回の表示を含んでいます/);
});

for(const kind of ['feed'])test(`${kind}: retains only the failed origin while other added Hubs update`,async t=>{
 const f=fixture(kind);t.after(f.dispose);f.networkItems=[{origin:'https://a.example',id:'a',title:'old-a'},{origin:'https://b.example',id:'b',title:'old-b'}];await f.load();
 f.networkError='network_timeout';f.failedOrigins=['https://a.example'];f.networkItems=[{origin:'https://b.example',id:'b',title:'new-b'}];await f.load();
 const displayed=vm.runInContext('feedSnapshot.network',f.ctx);
 assert.deepEqual(Array.from(displayed,item=>item.title).sort(),['new-b','old-a']);
});
