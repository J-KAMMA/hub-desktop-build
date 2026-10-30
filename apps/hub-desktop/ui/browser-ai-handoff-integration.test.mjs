import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createBrowserAiReference} from './browser-ai-reference.mjs';
import {initBrowserWorkspace} from './browser-workspace.mjs';
import {initBrowserAiControl} from './browser-ai-control.mjs';

const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const between=(start,end)=>{const a=app.indexOf(start),b=app.indexOf(end,a);assert.ok(a>=0&&b>a);return app.slice(a,b);};
const rootReferenceInit=between('let browserAiReference=null,browserAiReferenceGeneration=0;','let syncPiChangesView = null;');
const rootStageAndControls=between('async function stageBrowserAiDraft(draft, source) {','// --- アプリの主要画面 ---');
const rootNativeControl=between('  initBrowserAiControl({listen,invoke,','  initShellControl({');
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const draft='  Synthetic selected page\n<img src=x onerror=run()>\n日本語  ';
const url='http://127.0.0.1:8123/__hub_ai_fixture';
const material={title:'Synthetic exact page',url,text:draft};

async function fixture(t){
 const dom=new JSDOM(readFileSync(new URL('./index.html',import.meta.url),'utf8'),{url:'https://synthetic-shell.invalid/'}),document=dom.window.document,events={},calls=[],received=[],opened=[];
 dom.window.matchMedia=()=>({matches:false,addEventListener(){}});dom.window.HTMLElement.prototype.scrollIntoView=function(){};
 dom.window.__TAURI__={event:{listen:async(name,callback)=>{events[name]=callback;return()=>{delete events[name];};}}};
 document.querySelector('#rail-browser-reference').getClientRects=()=>[{}];
 const tab={id:2,url,title:material.title,active:true,pinned:false,discarded:false,loading:false,zoom:1,canBack:false,canForward:false};
 const f={dom,document,events,calls,received,opened,readWait:null,tab,control:null};
 const invoke=async(name,args)=>{
  calls.push({name,args});
  if(name==='browser_workspace_snapshot')return{version:1,tabs:[f.tab],favorites:[],history:[]};
  if(name==='browser_send_to_ai'){if(f.readWait)await f.readWait.promise;return draft;}
  if(name==='browser_protection_status')return{version:1,supported:true,enabled:true,ready:true,blockedCount:0,listsVersion:'synthetic'};
  if(['browser_downloads','browser_site_requests'].includes(name))return[];
  if(name==='browser_session_status')return 0;
  if(['native_browser_chrome_layout','browser_ai_control_ack'].includes(name))return undefined;
  throw Error('unexpected synthetic IPC: '+name);
 };
 const createRoot=new Function('deps',`
  const {document,window,invoke,createBrowserAiReference,initBrowserWorkspace,initBrowserAiControl,opened}=deps;
  const startupTool=null,icon=()=>'<svg></svg>',controlMetrics={begin:()=>()=>{}},appsOpen=false;
  let researchAccountGeneration=0,desktopAccount={state:'registered',deviceId:'synthetic-alice'},currentView='browser',browserActive=true,browserControls;
  const enterBrowser=url=>opened.push(url),travelToolbar=()=>{};
  ${rootReferenceInit}
  ${rootStageAndControls}
  initBrowserControls();
  const listen=(name,callback)=>window.__TAURI__.event.listen(name,callback);
  ${rootNativeControl}
  return{stage:stageBrowserAiDraft,controls:browserControls,reference:browserAiReference,setHandler(value){piWorkDraftHandler=value;},toAi(){currentView='ai';browserActive=false;},view:()=>currentView,
   changeActor(){desktopAccount={state:'registered',deviceId:'synthetic-bob'};researchAccountGeneration++;window.dispatchEvent(new window.Event('hub-account-changed'));},
   changeOrigin(){researchAccountGeneration++;window.dispatchEvent(new window.Event('hub-origin-changed'));},
   clear(){browserAiReference.clear();},current:()=>currentView==='browser'&&browserActive};
 `);
 f.api=createRoot({document,window:dom.window,invoke,createBrowserAiReference,initBrowserWorkspace,initBrowserAiControl:options=>(f.control=initBrowserAiControl(options)),opened});
 f.referenceHost=document.querySelector('#rail-browser-reference');f.api.setHandler(async(text,source)=>{received.push({text,source});source.onAccepted();f.api.toAi();return true;});
 await f.control.ready;await tick();
 f.send=()=>events['browser-ai-control']({payload:{requestId:1,expiresAt:Date.now()+19000,tabId:2,port:8123}});
 f.receipt=()=>calls.filter(c=>c.name==='browser_ai_control_ack').at(-1)?.args;
 t.after(()=>{f.control.destroy();dom.window.close();});return f;
}
const assertScrubbed=f=>{assert.equal(f.referenceHost.hidden,true);assert.equal(f.referenceHost.textContent,'');assert.equal(f.api.reference.hasReference(),false);assert.deepEqual(f.opened,[]);};

test('actual workspace and app control wiring accepts the exact source before intentional browser to AI navigation and emits the closed receipt',async t=>{
 const f=await fixture(t);await f.send();assert.equal(f.api.view(),'ai');assert.equal(f.received.length,1);assert.equal(f.received[0].text,draft);assert.equal(f.received[0].source.isCurrent(),false,'intentional view change follows acceptance');
 assert.deepEqual(f.calls.filter(c=>c.name==='browser_send_to_ai').map(c=>c.args),[{id:2,url}]);assert.equal(f.referenceHost.querySelector('h3').textContent,material.title);assert.equal(f.referenceHost.querySelector('.meta').textContent,url);assert.equal(f.referenceHost.querySelector('pre').textContent,draft);assert.equal(f.referenceHost.querySelector('img,script,iframe'),null);assert.equal(f.referenceHost.querySelector('details').open,false);
 assert.deepEqual(f.receipt(),{requestId:1,tabId:2,outcome:'applied',result:{accepted:true,reference:true,surface:'pi'}});assert.deepEqual(f.opened,[]);f.referenceHost.querySelector('button').click();assert.deepEqual(f.opened,[url]);
 assert.equal(f.calls.some(c=>/^(pi_work_start|pi_work_resume|wallet_|hub_client_action|open_external)/.test(c.name)),false);
});

test('refusal, missing acceptance callback and unavailable handler never display a reference or ACK success',async t=>{
 for(const mode of ['refusal','no-callback','nonboolean','unavailable']){const f=await fixture(t);f.api.setHandler(mode==='unavailable'?null:async()=>mode==='refusal'?false:mode==='nonboolean'?'true':true);await f.send();assert.deepEqual(f.receipt(),{requestId:1,tabId:2,outcome:mode==='unavailable'?'draft_failed':'draft_refused',result:null});assertScrubbed(f);}
});

test('a malformed reference or stale source snapshot cannot produce a successful handoff or executable DOM',async t=>{
 for(const reference of [{...material,url:'https://synthetic.invalid/'+'\n'},{...material,text:'broken\ud800'},{...material,extra:'private'},{...material,text:'x'.repeat(32001)},Object.assign(Object.create({private:'forbidden'}),material)]){const f=await fixture(t);f.api.setHandler(async(_text,source)=>{source.onAccepted();return true;});assert.equal(await f.api.stage(draft,{isCurrent:()=>true,reference}),false);assertScrubbed(f);}
 const f=await fixture(t);let calls=0;f.api.setHandler(async()=>{calls++;return true;});assert.equal(await f.api.stage(draft,{isCurrent:()=>false,reference:material}),false);assert.equal(calls,0);assertScrubbed(f);
});

test('actor and origin changes during source extraction prevent both draft acceptance and successful receipts',async t=>{
 for(const boundary of ['changeActor','changeOrigin']){const f=await fixture(t);f.readWait=deferred();const pending=f.send();await tick();f.api[boundary]();f.readWait.resolve();await pending;assert.equal(f.received.length,0);assert.equal(f.receipt().outcome,'source_changed');assertScrubbed(f);}
});

test('deferred acceptance refuses actor and origin changes before the callback without retaining reference DOM',async t=>{
 for(const boundary of ['changeActor','changeOrigin']){const f=await fixture(t),wait=deferred();let captured;f.api.setHandler(async(_text,source)=>{captured=source;await wait.promise;source.onAccepted();return true;});const pending=f.send();await tick();assert.ok(captured);f.api[boundary]();wait.resolve();await pending;assert.equal(f.receipt().outcome,'source_changed');assertScrubbed(f);assert.equal(captured.onAccepted(),false);assertScrubbed(f);}
});

test('actor and origin changes after acceptance scrub old cards and captured source callbacks before the async handler returns',async t=>{
 for(const boundary of ['changeActor','changeOrigin']){const f=await fixture(t),wait=deferred();let captured;f.api.setHandler(async(_text,source)=>{captured=source;source.onAccepted();await wait.promise;return true;});const pending=f.send();await tick();const card=f.referenceHost.firstChild,oldOpen=f.referenceHost.querySelector('button').onclick;assert.ok(card);assert.equal(card.querySelector('pre').textContent,draft);f.api[boundary]();oldOpen();captured.onAccepted();assert.equal(card.textContent,'');assertScrubbed(f);wait.resolve();await pending;assert.equal(f.receipt().outcome,'source_changed');assertScrubbed(f);}
});

test('cleared, hidden or detached accepted references cannot ACK success after an async append completes',async t=>{
 for(const boundary of ['clear','hidden','detached']){const f=await fixture(t),wait=deferred();f.api.setHandler(async(_text,source)=>{source.onAccepted();await wait.promise;return true;});const pending=f.send();await tick();if(boundary==='clear')f.api.clear();else if(boundary==='hidden')f.referenceHost.hidden=true;else f.referenceHost.remove();wait.resolve();await pending;assert.equal(f.receipt().outcome,'draft_refused');if(boundary==='clear')assertScrubbed(f);assert.equal(f.api.reference.matches(url),false);}
});

test('disposed control rejects a captured late callback and sends no receipt',async t=>{
 const f=await fixture(t),wait=deferred();let captured;f.api.setHandler(async(_text,source)=>{captured=source;await wait.promise;source.onAccepted();return true;});const pending=f.send();await tick();f.control.destroy();wait.resolve();await pending;assert.equal(f.receipt(),undefined);assert.equal(captured.onAccepted(),false);assertScrubbed(f);
});
test('accepted callback is one-shot: user clear under the same live authority cannot revive the reference or produce a success receipt',async t=>{
 const f=await fixture(t),wait=deferred();let captured;
 f.api.setHandler(async(_text,source)=>{captured=source;assert.equal(source.onAccepted(),true);await wait.promise;return true;});
 const pending=f.send();await tick();assert.ok(captured);assert.equal(captured.isCurrent(),true);assert.equal(f.api.current(),true);
 const card=f.referenceHost.firstChild,oldOpen=card.querySelector('button').onclick;assert.equal(card.querySelector('pre').textContent,draft);
 f.api.clear();assert.equal(captured.isCurrent(),true,'user clear does not change actor, Hub or browser view');assert.equal(f.api.current(),true);assert.equal(card.textContent,'');assertScrubbed(f);
 assert.equal(captured.onAccepted(),false);oldOpen();assertScrubbed(f);
 wait.resolve();await pending;assert.deepEqual(f.receipt(),{requestId:1,tabId:2,outcome:'draft_refused',result:null});assertScrubbed(f);
});