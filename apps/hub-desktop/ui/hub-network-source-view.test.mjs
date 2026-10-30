import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createHubNetwork} from './hub-network.mjs';
import {createContentShare} from './content-share.mjs';
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function actual(signature){const start=app.indexOf(signature),end=app.indexOf('\n}',start);assert.ok(start>=0&&end>start,signature);return app.slice(start,end+2);}
const bindingStart=app.indexOf('const hubNetwork = createHubNetwork('),bindingEnd=app.indexOf('\nconst hubPeers',bindingStart);assert.ok(bindingStart>=0&&bindingEnd>bindingStart);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};},tick=()=>new Promise(setImmediate);
const sourceA='https://a.example',sourceB='https://b.example';
async function fixture(t,{view='feed',held=false}={}){
 const dom=new JSDOM('<section id="view-node"></section><section class="view" id="view-feed"><div class="view-head"></div></section><section class="view" id="view-market"><div class="view-head"></div></section><section class="view" id="view-research"><div class="view-head"></div></section><form><textarea></textarea></form>',{url:'https://fixture.invalid'}),document=dom.window.document,pending=held?deferred():null;
 const f={dom,document,sources:[sourceA,sourceB],calls:[],navigations:[],first:true,failA:false,pending,scope:{origin:'https://main.example',key:'synthetic-device',epoch:{}}};
 const ctx=vm.createContext({document,localStorage:dom.window.localStorage,createHubNetwork,currentView:view,desktopAccountLoaded:true,desktopAccount:{state:'registered',deviceId:'viewer-device'},networkViewsReady:false,startupTool:false,
  showNotice(){},friendlyError:String,showView(){},loadNode(){},loadFeed(){},loadShop(){},researchWorkspace:{load(){}},socialMode:'mixed',socialFilter:'all',socialScope:'latest',socialWantedScene:null,feedLoadRevision:0,socialStreamController:{invalidate(){}},feedRecovery:{reset(){}},captureSocialScene(){},renderSidebarContext(){},
  navigateFrom:async item=>{f.navigations.push(item.dataset.view);ctx.currentView=item.dataset.view;},
  invoke:async(name,args)=>{f.calls.push({name,args:args?structuredClone(args):args});if(name==='hub_origin')return 'https://main.example';if(name==='hub_network_sources')return{sources:[...f.sources]};if(name==='hub_network_read'){if(f.failA&&args.origin===sourceA)throw Error('ハブが 403 を返しています');return{items:[]};}if(name==='open_external')return;assert.fail('Unexpected call '+name);},
 });f.ctx=ctx;
 vm.runInContext([actual('async function offerPublicContentShare(input){'),actual('async function selectSocial(mode,filter,scope){')].join('\n'),ctx);
 ctx.contentSharePreview=createContentShare({document,host:document.querySelector('form'),textarea:document.querySelector('textarea'),getContext:()=>f.first&&pending?(f.first=false,pending.promise):Promise.resolve(f.scope),isCurrent:()=>ctx.currentView==='feed'&&ctx.socialFilter==='post',onNavigate:()=>ctx.selectSocial('mixed','post','latest')});
 document.querySelector('textarea').value='Keep the existing draft';
 vm.runInContext(app.slice(bindingStart,bindingEnd)+';globalThis.network=hubNetwork;',ctx);await ctx.network.ready;await tick();
 f.card=(kind='post',origin=sourceA)=>{const path=kind==='research'?'/v2/research/same':'/v2/posts/same';const card=ctx.network.card({origin,id:'same',path,title:'Exact '+kind+' source',summary:'Public metadata only'});document.querySelector('#view-'+({post:'feed',research:'research'}[kind])).append(card);return card;};
 f.share=card=>[...card.querySelectorAll('button')].find(button=>button.textContent==='投稿で紹介');
 f.external=()=>f.calls.filter(call=>call.name==='open_external').map(call=>call.args.url);
 t.after(()=>{dom.window.dispatchEvent(new dom.window.Event('pagehide'));ctx.contentSharePreview.destroy();dom.window.close();});return f;
}

test('actual remote feed share cannot replace a newer market view while account context is pending',async t=>{
 const f=await fixture(t,{held:true}),card=f.card(),sharing=f.share(card).onclick();await Promise.resolve();f.ctx.currentView='market';f.pending.resolve(f.scope);await sharing;
 assert.equal(f.ctx.currentView,'market');assert.deepEqual(f.navigations,[]);assert.equal(f.ctx.contentSharePreview.element.hidden,true);assert.equal(f.document.querySelector('textarea').value,'Keep the existing draft');
});

test('legitimate research sharing checks its source before moving to feed and preserves the exact remote URL',async t=>{
 for(const [kind,view,path]of [['research','research','/v2/research/same']]){
  const f=await fixture(t,{view}),card=f.card(kind);await f.share(card).onclick();assert.equal(f.ctx.currentView,'feed');assert.deepEqual(f.navigations,['feed']);assert.equal(f.ctx.contentSharePreview.element.hidden,false);assert.match(f.ctx.contentSharePreview.element.textContent,new RegExp(sourceA.replaceAll('.','\\.')+path.replaceAll('/','\\/')));assert.equal(f.document.querySelector('textarea').value,'Keep the existing draft');
 }
});

test('kind-specific source views reject hidden connected cards and detached cards without changing the current view',async t=>{
 for(const kind of ['post','research']){
  const f=await fixture(t,{view:kind==='research'?'research':'feed'}),card=f.card(kind);f.ctx.currentView=kind==='post'?'market':'research'===kind?'market':'research';
  card.querySelector('button').click();await f.share(card).onclick();assert.deepEqual(f.external(),[]);assert.deepEqual(f.navigations,[]);assert.equal(f.ctx.contentSharePreview.element.hidden,true);
 }
 const f=await fixture(t),card=f.card();card.remove();card.querySelector('button').click();await f.share(card).onclick();assert.deepEqual(f.external(),[]);assert.deepEqual(f.navigations,[]);
});

test('removed or authorization-denied sources cannot complete a pending share and another same-ID Hub stays exact',async t=>{
 for(const reason of ['removed','denied']){
  const f=await fixture(t,{held:true}),card=f.card(),sharing=f.share(card).onclick();await Promise.resolve();
  if(reason==='removed'){f.sources=[sourceB];f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));await tick();}else{f.failA=true;await f.ctx.network.load('post');}
  f.pending.resolve(f.scope);await sharing;assert.deepEqual(f.navigations,[]);assert.equal(f.ctx.contentSharePreview.element.hidden,true);card.querySelector('button').click();assert.deepEqual(f.external(),[]);
  const other=f.card('post',sourceB);other.querySelector('button').click();assert.deepEqual(f.external(),[sourceB+'/v2/posts/same']);
 }
});
