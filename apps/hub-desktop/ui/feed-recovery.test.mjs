// Execute the production feed coordinator with synthetic read IPC and minimal view objects.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createReadRecovery,isTransientReadError,isReadAccessDenied,readWaitText} from './hub-read-recovery.mjs';
import {appendResearchUpdates} from './research-discovery.mjs';
const source=await readFile(new URL('./app.js',import.meta.url),'utf8');
const updatesBlock=source.slice(source.indexOf('function renderFeedResearchUpdates('),source.indexOf('async function openDetail('));
const block=source.slice(source.indexOf('const feedAccountKey='),source.indexOf('async function loadMoreFeed()'));
const element=()=>({classList:{remove(){},add(){}},replaceChildren(...children){this.children=children;},append(){},hidden:false});
function fixture(error){
  const calls=[],button=element(),feed={state:element(),list:element()};
  const f={error,calls,feed};
  const context=vm.createContext({socialBar:element(),socialMode:"legacy",mixedPublicationUpdates:null,appendResearchUpdates,createReadRecovery,isTransientReadError,isReadAccessDenied,readWaitText,desktopAccount:{state:'registered',deviceId:'one'},currentView:'feed',feedLoadFailed:false,feedLoadRevision:0,feedScope:'recommended',feed,feedMore:element(),feedFresh:element(),feedFreshItems:[],feedSeenId:null,feedPage:{},
    document:{querySelector:()=>button},window:{addEventListener(){}},localStorage:{getItem:()=>null},feedSeenKey:()=>'',skeletonPost:element,
    hubNetwork:{failedOrigins:()=>[],context:()=>'',errors:()=>[],ready:Promise.resolve(),includePrimary:()=>true,load:async()=>[]},settleWithin:p=>p,
    invoke:async(name,args)=>{calls.push([name,args]);if(name==='hub_feed'){if(f.error)throw f.error;return {posts:[],hasMore:false,signedIn:true};}if(name==='hub_client')return {items:[]};if(name==='hub_resource')return {resources:[]};throw Error('unexpected mutation');},
    renderFeedPosts(){},updateSourceSummary(){},accountNeeded:e=>e==='desktop_not_connected',activityPubUrl:()=>null,
    emptyState:(icon,title)=>({...element(),title}),statePanel:(icon,title)=>({...element(),title,classList:{add(){},remove(){}}}),renderFeedTabs(){},feedListId:null,friendlyError:e=>e,connectState:()=>({...element(),title:'connect'}),retryButton:element});
  vm.runInContext(updatesBlock+block,context);f.context=context;f.load=()=>vm.runInContext('loadFeed()',context);f.dispose=()=>vm.runInContext('feedRecovery.reset()',context);return f;
}
test('the feed waits after a startup read failure and renders after automatic recovery',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture('network_unavailable');t.after(f.dispose);await f.load();
  assert.equal(f.feed.list.children[0].title,'接続待ち');f.error=null;
  t.mock.timers.tick(1000);await new Promise(setImmediate);
  assert.equal(f.calls.filter(c=>c[0]==='hub_feed').length,2);assert.equal(f.feed.list.children[0].title,'まだ投稿がありません');
  assert.ok(f.calls.every(c=>['hub_feed','hub_client','hub_resource','hub_detail'].includes(c[0])));
});
test('the feed does not repeat auth failures or retry after leaving the view or switching accounts',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const boundary of ['auth','view','account']){
    const f=fixture(boundary==='auth'?'desktop_not_connected':'network_unavailable');t.after(f.dispose);await f.load();
    if(boundary==='view')f.context.currentView='messages';if(boundary==='account')f.context.desktopAccount={state:'registered',deviceId:'two'};
    t.mock.timers.tick(60000);await new Promise(setImmediate);assert.equal(f.calls.filter(c=>c[0]==='hub_feed').length,1);
    if(boundary==='auth')assert.equal(f.feed.list.children[0].title,'connect');f.dispose();
  }
});
