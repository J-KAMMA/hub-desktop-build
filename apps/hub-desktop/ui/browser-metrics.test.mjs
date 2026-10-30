import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createDesktopControlMetrics} from './desktop-control-metrics.mjs';
const canonical=fileURLToPath(new URL('./',import.meta.url));
const {initBrowserWorkspace}=await import(pathToFileURL(process.env.HUB_CONTROL_WORKSPACE_TEST_SOURCE??canonical+'browser-workspace.mjs'));
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
async function fixture(t,{enabled=true}={}){
 const dom=new JSDOM(readFileSync(canonical+'index.html','utf8'),{url:'http://fixture.invalid/'}),document=dom.window.document,events={};
 const f={clock:0,fetchCost:0,renderCost:0,waitRead:null,fail:false,waitFocus:null,tabs:[{id:1,url:'https://one.example/',title:'first',active:true}]};
 dom.window.matchMedia=()=>({matches:false,addEventListener(){}});dom.window.HTMLElement.prototype.scrollIntoView=function(){};dom.window.__TAURI__={event:{listen:(name,callback)=>{events[name]=callback;return Promise.resolve(()=>{});}}};
 const metrics=createDesktopControlMetrics({now:()=>f.clock});f.metrics=metrics;
 const invoke=async name=>{if(name==='browser_tabs'){const wait=f.waitRead;f.waitRead=null;if(wait)await wait.promise;f.clock+=f.fetchCost;if(f.fail)throw Error('read failure');return f.tabs;}if(['browser_favorites','browser_history','browser_downloads','browser_site_requests'].includes(name))return [];if(name==='browser_session_status')return 0;if(name==='browser_focus_controls'&&f.waitFocus)await f.waitFocus.promise;};
 const list=document.getElementById('sidebar-tabs-list');f.list=list;const replace=list.replaceChildren.bind(list);list.replaceChildren=(...args)=>{f.clock+=f.renderCost;return replace(...args);};
 f.workspace=initBrowserWorkspace({document,window:dom.window,invoke,icon:()=>'',enterBrowser:async()=>{},isActive:()=>true,getView:()=> 'browser',onAiDraft:async()=>{},metrics:enabled?metrics:undefined});t.after(()=>dom.window.close());await tick();f.events=events;f.phase=name=>metrics.snapshot().phases.find(p=>p.name===name);return f;
}
test('actual refresh separates fetch/render while total includes both',async t=>{
 const f=await fixture(t);f.clock=100;f.fetchCost=20;f.renderCost=8;await f.workspace.refresh();assert.deepEqual(f.phase('browserFetch'),{name:'browserFetch',calls:2,totalMs:20,busyMs:20,inFlight:0});assert.deepEqual(f.phase('browserRender'),{name:'browserRender',calls:2,totalMs:8,busyMs:8,inFlight:0});assert.deepEqual(f.phase('browserRefresh'),{name:'browserRefresh',calls:2,totalMs:28,busyMs:28,inFlight:0});
});
test('stale and rejected tab reads count fetch and total without counting unperformed renders',async t=>{
 const f=await fixture(t);f.clock=100;const wait=deferred();f.waitRead=wait;const first=f.workspace.refresh();f.clock=105;await f.workspace.refresh();f.clock=150;wait.resolve();await first;assert.equal(f.phase('browserFetch').calls,3);assert.equal(f.phase('browserFetch').totalMs,50);assert.equal(f.phase('browserRefresh').totalMs,50);assert.equal(f.phase('browserFetch').busyMs,50);assert.equal(f.phase('browserRefresh').busyMs,50);assert.equal(f.phase('browserRender').calls,2);
 f.fail=true;f.fetchCost=7;await f.workspace.refresh();assert.equal(f.phase('browserFetch').totalMs,57);assert.equal(f.phase('browserRefresh').totalMs,57);assert.equal(f.phase('browserRender').calls,2);
});
test('total refresh includes pending focus wait but fetch/render do not',async t=>{
 const f=await fixture(t);f.clock=100;await f.workspace.dispatch('new');f.waitFocus=deferred();f.tabs=[{id:1,url:'https://one.example/',title:'first',active:false},{id:2,url:'',title:'',active:true}];f.events['browser-tabs-changed']();await tick();assert.equal(f.phase('browserRefresh').calls,2);assert.equal(f.phase('browserRefresh').totalMs,0);f.clock=115;assert.equal(f.phase('browserRefresh').busyMs,15);assert.equal(f.phase('browserRefresh').totalMs,0);f.clock=130;f.waitFocus.resolve();await tick();assert.equal(f.phase('browserFetch').totalMs,0);assert.equal(f.phase('browserRender').totalMs,0);assert.equal(f.phase('browserRefresh').totalMs,30);
});

test('render exception propagates unchanged and completes both render and total counters',async t=>{
 const f=await fixture(t),error=Error('DOM failure');f.clock=100;f.list.replaceChildren=()=>{f.clock+=6;throw error;};await assert.rejects(f.workspace.refresh(),e=>e===error);assert.equal(f.phase('browserRender').totalMs,6);assert.equal(f.phase('browserRefresh').totalMs,6);assert.equal(f.phase('browserFetch').totalMs,0);
});
test('omitting optional metrics preserves refresh and exact tab rendering with no observed counters',async t=>{
 const f=await fixture(t,{enabled:false});f.tabs=[{id:8,url:'https://latest.example/',title:'latest',active:true}];await f.workspace.refresh();assert.equal(f.list.querySelector('[data-tab-id]').dataset.tabId,'8');assert.equal(f.list.querySelector('.browser-tab-title').textContent,'latest');assert.ok(f.metrics.snapshot().phases.every(p=>p.calls===0));
});
