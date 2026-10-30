import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {appendResearchBacklinks as renderResearchBacklinks,appendResearchUpdates} from './research-discovery.mjs';

const source=readFileSync(new URL('./app.js',import.meta.url),'utf8'),tick=()=>new Promise(setImmediate);
function actual(signature){const start=source.indexOf(signature),end=source.indexOf('\n}',start);assert.ok(start>=0&&end>start,signature);return source.slice(start,end+2);}
const functions=['async function appendResearchBacklinks(','function renderFeedResearchUpdates(','async function openDetail(','async function openHubPath(','function detailForHubPath(path) {'].map(actual).join('\n');
function fixture(t){
 const dom=new JSDOM('<main></main><div id="view-feed"><div class="view-head"><h2>交流</h2></div></div>'),opened=[];let resolve;
 const paused=new Promise(done=>resolve=done),state={current:true,paused:false,resolve,opened,dom};
 const ctx=vm.createContext({document:dom.window.document,URL,URLSearchParams,renderResearchBacklinks,appendResearchUpdates,
  desktopAccount:{state:'registered',deviceId:'synthetic-a'},homeAccountEpoch:{},currentView:'detail',detailTrail:[{name:'video',ids:['same']}],detailForwardTrail:[],detailReturn:{},toolbarTrail:[{view:'detail'}],toolbarTrailIndex:0,readingDirectory:new Set(),
  exitBrowser:async()=>{if(state.paused)await paused;},viewScroller:()=>null,captureVideoScene(){},captureSocialScene(){},saveDetailTrail(){},
  showView:view=>{ctx.currentView=view;},renderDetailEntry:async entry=>opened.push({name:entry.name,ids:Array.from(entry.ids),title:entry.title}),
  invoke:async(name,args)=>{assert.equal(name,'hub_detail');return{projects:[{id:'rp_same',title:'Related project'}]};},
 });vm.runInContext(functions,ctx);state.ctx=ctx;state.target=dom.window.document.querySelector('main');t.after(()=>dom.window.close());return state;
}
const update={kind:'research',id:'paper',projectId:'rp_same',projectTitle:'Related project',title:'Fixed paper',version:7,href:'/v2/research/rp_same?document=paper&version=7',updatedAt:'2026-10-09T00:00:00Z'};
async function render(f,mode){if(mode==='backlinks'){const controller=await f.ctx.appendResearchBacklinks(f.target,'video','same',()=>f.current);await controller.ready;return{root:controller.root,button:controller.root.querySelector('button'),controller};}const root=f.ctx.renderFeedResearchUpdates(f.target,[update],()=>f.current);return{root,button:root.querySelector('button')};}
test('actual related-project and feed-update parent callbacks retain target and exact paper revision',async t=>{
 for(const mode of ['backlinks','updates']){const f=fixture(t),view=await render(f,mode);await view.button.onclick();assert.deepEqual(f.opened,[mode==='backlinks'?{name:'research_project',ids:['rp_same'],title:'Related project'}:{name:'research_revision',ids:['rp_same','paper','7'],title:'文書 · v7'}]);}
});
test('actual parent waits cannot navigate after source context, account, origin epoch or DOM changes',async t=>{
 for(const mode of ['backlinks','updates'])for(const change of ['context','account','origin','button','root','target']){
  const f=fixture(t),view=await render(f,mode);f.paused=true;const pending=view.button.onclick();await tick();
  if(change==='context'){f.current=false;f.ctx.currentView='feed';}else if(change==='account')f.ctx.desktopAccount={state:'registered',deviceId:'synthetic-b'};else if(change==='origin')f.ctx.homeAccountEpoch={};else if(change==='button')view.button.remove();else if(change==='root')view.root.remove();else f.target.remove();
  f.resolve();await pending;assert.deepEqual(f.opened,[],mode+': '+change);assert.equal(f.ctx.detailTrail.length,1,mode+': no stale history entry');
 }
});
