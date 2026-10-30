import test from 'node:test';
import assert from 'node:assert/strict';
import {initBrowserAiControl} from './browser-ai-control.mjs';
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function fixture(t){
 const f={time:100,ready:true,accepted:true,result:{accepted:true,reference:true,surface:'pi'},calls:[],sent:[],reads:[],stopped:false};
 f.control=initBrowserAiControl({listen:async(name,handler)=>{assert.equal(name,'browser-ai-control');f.handler=handler;return()=>{f.stopped=true;};},
  invoke:async(name,args)=>{assert.equal(name,'browser_ai_control_ack');f.calls.push(args);if(f.ackError)throw Error('private diagnostic');return f.ackResult;},
  isReady:()=>{if(f.readyError)throw Error('private diagnostic');return f.ready;},sendToAi:async(context,markPhase)=>{f.sent.push(context);for(const phase of f.phases??[])markPhase(phase);if(f.sendWait)await f.sendWait.promise;if(f.sendError)throw Error('private diagnostic');return f.accepted;},
  readResult:async(tabId,url)=>{f.reads.push({tabId,url});if(f.readWait)await f.readWait.promise;if(f.readError)throw Error('private diagnostic');return f.result;},now:()=>f.time});
 await f.control.ready;t.after(()=>f.control.destroy());
 f.payload=(patch={})=>({requestId:1,expiresAt:20100,tabId:2,port:8123,...patch});f.send=patch=>f.handler({payload:f.payload(patch)});return f;
}

test('fixture control derives only exact loopback URL and ACKs a closed accepted reference result',async t=>{
 const f=await fixture(t);await f.send();assert.equal(f.sent[0].tabId,2);assert.equal(f.sent[0].url,'http://127.0.0.1:8123/__hub_ai_fixture');assert.deepEqual(Object.keys(f.sent[0]).sort(),['isCurrent','tabId','url']);
 assert.deepEqual(f.reads,[{tabId:2,url:f.sent[0].url}]);assert.deepEqual(f.calls,[{requestId:1,tabId:2,outcome:'applied',result:{accepted:true,reference:true,surface:'pi'}}]);
 assert.equal(f.sent[0].isCurrent(),false,'receipt does not keep a live fixture operation');
});

test('invalid event envelopes, IDs, bounds, credentials and arbitrary text do not invoke or ACK',async t=>{
 const f=await fixture(t);
 for(const payload of [null,[],{...f.payload(),url:'https://other.example'},{...f.payload(),text:'private'},f.payload({requestId:0}),f.payload({requestId:Number.MAX_SAFE_INTEGER+1}),f.payload({tabId:0}),f.payload({tabId:2.1}),f.payload({port:1023}),f.payload({port:65536}),f.payload({port:3020}),f.payload({port:'8123'}),f.payload({expiresAt:100}),f.payload({expiresAt:20101}),f.payload({expiresAt:NaN})])await f.handler({payload});
 assert.equal(f.sent.length,0);assert.equal(f.calls.length,0);
 await f.send({port:1024});await f.send({requestId:2,port:65535});assert.equal(f.calls.length,2);
});

test('monotonic IDs and single active request bound duplicate and busy replays',async t=>{
 const f=await fixture(t);f.sendWait=deferred();const first=f.send();await tick();
 await f.send({requestId:2});await f.send({requestId:2});await f.send();assert.equal(f.sent.length,1);assert.deepEqual(f.calls,[{requestId:2,tabId:2,outcome:'failed',result:null}]);
 f.sendWait.resolve();await first;assert.equal(f.calls[1].outcome,'applied');await f.send({requestId:2});assert.equal(f.calls.length,2);
});

test('expiry while reading or accepting never produces a success receipt',async t=>{
 for(const phase of ['send','read']){const f=await fixture(t),wait=deferred();f[phase==='send'?'sendWait':'readWait']=wait;const pending=f.send();await tick();assert.equal(f.sent[0].isCurrent(),true);f.time=20100;assert.equal(f.sent[0].isCurrent(),false);wait.resolve();await pending;assert.deepEqual(f.calls,[{requestId:1,tabId:2,outcome:'superseded',result:null}]);}
});

test('false acceptance, changed actor/reference, legacy surface and poisoned results fail closed',async t=>{
 for(const result of [null,false,{accepted:true,reference:false,surface:'pi'},{accepted:true,reference:true,surface:'t3'},{accepted:true,reference:true,surface:'pi',draft:'forbidden'},{accepted:1,reference:true,surface:'pi'}]){const f=await fixture(t);f.result=result;await f.send();assert.deepEqual(f.calls,[{requestId:1,tabId:2,outcome:'reference_unavailable',result:null}]);}
 for(const accepted of [false,undefined,'true',{accepted:true}]){const f=await fixture(t);f.accepted=accepted;await f.send();assert.equal(f.reads.length,0);assert.equal(f.calls[0].outcome,'failed');}
 const f=await fixture(t);f.ready=false;await f.send();assert.equal(f.sent.length,0);assert.deepEqual(f.calls,[{requestId:1,tabId:2,outcome:'not_ready',result:null}]);
});

test('ACK transport cannot poison the validated receipt and exceptions expose no diagnostics',async t=>{
 const f=await fixture(t);f.ackResult={accepted:true,draft:'do not expose'};await f.send();assert.deepEqual(Object.keys(f.calls[0].result).sort(),['accepted','reference','surface']);
 const g=await fixture(t);g.ackError=true;Object.defineProperty(g.result,'accepted',{get(){throw Error('private diagnostic');}});await g.send();assert.deepEqual(g.calls,[{requestId:1,tabId:2,outcome:'failed',result:null}]);
});

test('disposal invalidates pending callback and unregisters without a late ACK',async t=>{
 const f=await fixture(t);f.sendWait=deferred();const pending=f.send();await tick();f.control.destroy();assert.equal(f.sent[0].isCurrent(),false);f.sendWait.resolve();await pending;assert.equal(f.calls.length,0);assert.equal(f.stopped,true);await f.send({requestId:2});assert.equal(f.sent.length,1);
});

test('invalid clocks during a request invalidate the guard and never ACK success',async t=>{
 for(const time of [-1,NaN,Infinity,1.5]){const f=await fixture(t);f.sendWait=deferred();const pending=f.send();await tick();f.time=time;assert.equal(f.sent[0].isCurrent(),false);f.sendWait.resolve();await pending;assert.deepEqual(f.calls,[{requestId:1,tabId:2,outcome:'superseded',result:null}]);}
});

test('only fixed terminal phases classify a refusal and every negative ACK has a null result',async t=>{
 for(const phase of ['source_changed','extract_failed','draft_failed','draft_refused','draft_not_ready','draft_snapshot_failed','draft_navigation_changed','draft_context_invalid','draft_history_changed']){
  const f=await fixture(t);f.accepted=false;f.phases=['extracting','staging',phase,'private diagnostic',{outcome:'applied'},null];await f.send();
  assert.equal(f.reads.length,0);assert.deepEqual(f.calls,[{requestId:1,tabId:2,outcome:phase,result:null}]);
 }
 for(const phase of ['extracting','staging','accepted','private diagnostic',null,{outcome:'applied'}]){
  const f=await fixture(t);f.accepted=false;f.phases=[phase];await f.send();assert.deepEqual(f.calls,[{requestId:1,tabId:2,outcome:'failed',result:null}]);
 }
 const f=await fixture(t);f.phases=['draft_failed','accepted'];await f.send();assert.equal(f.calls[0].outcome,'applied');
});

test('unexpected readiness, send and reference errors remain generic without diagnostics',async t=>{
 for(const field of ['readyError','sendError','readError']){
  const f=await fixture(t);f[field]=true;f.phases=['draft_failed'];await f.send();assert.deepEqual(f.calls,[{requestId:1,tabId:2,outcome:'failed',result:null}]);
 }
});
