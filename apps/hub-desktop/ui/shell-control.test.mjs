import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initShellControl,validShellLayout,validShellState} from './shell-control.mjs';
const tick=()=>new Promise(setImmediate);
const state=()=>({view:'feed',sidebarOpen:true,railOpen:false,sidebarWidth:198,railWidth:300,sidebarSelected:1,nativeRevision:1,nativeIds:[1,2,3]});
async function fixture(t) {
  const f={time:100,current:state(),calls:[],applied:[],inspect:true,layout:true};
  f.bridge=initShellControl({listen:async(name,callback)=>{assert.equal(name,'shell-control');f.event=callback;return ()=>f.stopped=true;},invoke:async(name,args)=>f.calls.push({name,args}),now:()=>f.time,canInspect:()=>f.inspect,canLayout:()=>f.layout,readState:()=>f.current,applyLayout:async(value,alive)=>{f.applied.push(value);if(f.wait)await f.wait;if(alive())Object.assign(f.current,value);}});
  await f.bridge.ready;t.after(()=>f.bridge.destroy());
  f.send=(requestId=1,layout=null,expiresAt=10_100)=>f.event({payload:{requestId,expiresAt,layout}});
  return f;
}
test('closed layout/state reject malformed shapes, foreign actions, missing null-view, and integer edges',()=>{
  assert.ok(validShellLayout({view:'settings',sidebarOpen:true,railOpen:true}));
  for(const v of [{view:'browser',sidebarOpen:true,railOpen:true},{view:'settings',sidebarOpen:1,railOpen:true},{view:'feed',sidebarOpen:true,railOpen:false,script:'x'}])assert.ok(!validShellLayout(v));
  const good=state();assert.ok(validShellState(good));assert.ok(validShellState({...good,view:null,sidebarSelected:0,nativeIds:[]}));
  for(const bad of [{...good,view:undefined},{...good,sidebarWidth:189.99},{...good,railWidth:480.01},{...good,sidebarWidth:NaN},{...good,nativeIds:[1,1]},{...good,nativeIds:[4]},{...good,nativeRevision:0},{...good,nativeRevision:Number.MAX_SAFE_INTEGER+1},{...good,sidebarSelected:1.5},{...good,railOpen:0},{...good,title:'not allowed'}])assert.ok(!validShellState(bad));
  for(const [name,ids] of Object.entries({feed:[1,2,3],notifications:[4,5,6,7,8],market:[9,10,11],settings:[12,13,14,15]}))assert.ok(validShellState({...good,view:name,sidebarSelected:ids[0],nativeIds:ids,nativeRevision:Number.MAX_SAFE_INTEGER}));
});
test('inspect sends only a copied metadata state and never changes layout',async t=>{
  const f=await fixture(t);f.send();await tick();assert.equal(f.applied.length,0);assert.deepEqual(f.calls,[{name:'shell_control_ack',args:{requestId:1,outcome:'applied',state:state()}}]);f.current.nativeIds.push(9);assert.deepEqual(f.calls[0].args.state.nativeIds,[1,2,3]);
});
test('layout uses the existing adapter once, then verifies the requested view and both columns',async t=>{
  const f=await fixture(t),layout={view:'settings',sidebarOpen:false,railOpen:true};f.current.sidebarSelected=12;f.current.nativeIds=[];f.send(1,layout);await tick();assert.deepEqual(f.applied,[layout]);assert.equal(f.calls[0].args.outcome,'applied');assert.equal(f.calls[0].args.state.view,'settings');
});
test('layout receives a fresh clamped request budget while two-argument adapters stay compatible',async t=>{
 let time=100,receive,release,remaining;const acks=[];
 const bridge=initShellControl({listen:async(_name,handler)=>{receive=handler;return()=>{};},invoke:async(_name,args)=>acks.push(args),now:()=>time,canInspect:()=>true,canLayout:()=>true,readState:state,applyLayout:async(_layout,alive,budget)=>{remaining=budget;assert.equal(alive(),true);assert.equal(budget(),9000);await new Promise(resolve=>release=resolve);}});
 await bridge.ready;t.after(()=>bridge.destroy());receive({payload:{requestId:1,expiresAt:9100,layout:{view:'feed',sidebarOpen:true,railOpen:false}}});await tick();
 time=6100;assert.equal(remaining(),3000);time=9100;assert.equal(remaining(),0);time=9200;assert.equal(remaining(),0);release();await tick();assert.deepEqual(acks,[{requestId:1,outcome:'superseded',state:null}]);
});

test('expired, too-future, non-safe, unknown-field and replay requests never execute',async t=>{
  const f=await fixture(t),layout={view:'feed',sidebarOpen:true,railOpen:true};
  for(const payload of [{requestId:1,expiresAt:100,layout},{requestId:1,expiresAt:10101,layout},{requestId:Number.MAX_SAFE_INTEGER+1,expiresAt:1000,layout},{requestId:1,expiresAt:1000,layout,script:'x'},{requestId:1,expiresAt:1000,layout:{...layout,url:'x'}}])f.event({payload});
  await tick();assert.equal(f.applied.length,0);assert.equal(f.calls.length,0);f.send(1,layout);await tick();f.send(1,layout);await tick();assert.equal(f.applied.length,1);assert.equal(f.calls.length,1);
});
test('main/tool, browser/modal/drag/narrow gates fail without calling the layout adapter',async t=>{
  const f=await fixture(t),layout={view:'feed',sidebarOpen:true,railOpen:true};f.inspect=false;f.send(1);await tick();f.inspect=true;f.layout=false;f.send(2,layout);await tick();assert.equal(f.applied.length,0);assert.deepEqual(f.calls.map(c=>c.args),[{requestId:1,outcome:'failed',state:null},{requestId:2,outcome:'failed',state:null}]);
});
test('a mismatching layout or user context change is superseded, not successful',async t=>{
  const f=await fixture(t);f.current.sidebarSelected=12;f.current.nativeIds=[];let release;f.wait=new Promise(resolve=>release=resolve);f.send(1,{view:'settings',sidebarOpen:true,railOpen:true});await tick();f.layout=false;release();await tick();assert.equal(f.calls[0].args.outcome,'superseded');assert.equal(f.calls[0].args.state,null);
});
test('expiry during a delayed adapter prevents further layout changes and success',async t=>{
  const f=await fixture(t);let release;f.wait=new Promise(resolve=>release=resolve);f.send(1,{view:'feed',sidebarOpen:false,railOpen:true},200);await tick();f.time=200;release();await tick();assert.equal(f.current.sidebarOpen,true);assert.equal(f.current.railOpen,false);assert.equal(f.calls[0].args.outcome,'superseded');
});
test('concurrent requests fail closed and each consumed ID cannot be replayed',async t=>{
  const f=await fixture(t);let release;f.wait=new Promise(resolve=>release=resolve);const layout={view:'feed',sidebarOpen:true,railOpen:true};f.send(1,layout);await tick();f.send(2,layout);await tick();assert.equal(f.applied.length,1);assert.deepEqual(f.calls[0].args,{requestId:2,outcome:'failed',state:null});release();await tick();f.send(2,layout);await tick();assert.equal(f.applied.length,1);assert.equal(f.calls.length,2);
});
test('adapter exceptions, invalid metadata and rejected ACK transport expose no error content',async t=>{
  const f=await fixture(t);f.current.sidebarWidth=Infinity;f.send();await tick();assert.deepEqual(f.calls[0].args,{requestId:1,outcome:'failed',state:null});
  const b=initShellControl({listen:async(_name,handler)=>{f.other=handler;return ()=>{};},invoke:async()=>{throw Error('private diagnostic');},canInspect:()=>true,canLayout:()=>true,applyLayout:()=>{throw Error('private diagnostic');},readState:state,now:()=>100});await b.ready;f.other({payload:{requestId:1,expiresAt:1000,layout:{view:'feed',sidebarOpen:true,railOpen:true}}});await tick();b.destroy();
});
test('destroy cancels a pending callback and unregisters without a late ACK',async t=>{
  const f=await fixture(t);let release;f.wait=new Promise(resolve=>release=resolve);f.send(1,{view:'feed',sidebarOpen:false,railOpen:true});await tick();f.bridge.destroy();release();await tick();assert.equal(f.calls.length,0);assert.equal(f.current.sidebarOpen,true);assert.equal(f.stopped,true);f.send(2);await tick();assert.equal(f.calls.length,0);
});

test('content libraries and node use only closed screen names with no native sidebar selections',()=>{
 for(const view of ['music','node','search','videos','wallet','ai','articles','threads','messages','saved_articles','video_library','music_library']) {
  assert.ok(validShellLayout({view,sidebarOpen:true,railOpen:false}));
  assert.ok(validShellState({...state(),view,sidebarSelected:0,nativeIds:[]}));
  assert.equal(validShellState({...state(),view,sidebarSelected:1,nativeIds:[1]}),false);
 }
 for(const view of ['research_project?actor=x','browser','__proto__','music;eval'])assert.equal(validShellLayout({view,sidebarOpen:true,railOpen:false}),false);
});
test('AI accepts the legacy 190px fallback and finite widths up to 8192 without native sidebar IDs',()=>{
 const ai={...state(),view:'ai',sidebarSelected:0,nativeIds:[]};
 for(const sidebarWidth of [190,198,207.999,208,208.5,260,260.5,8192])assert.equal(validShellState({...ai,sidebarWidth}),true);
 for(const sidebarWidth of [189.999,8192.001,NaN,Infinity,-Infinity])assert.equal(validShellState({...ai,sidebarWidth}),false);
 for(const sidebarWidth of [190,208,8192]){
  assert.equal(validShellState({...ai,sidebarWidth,sidebarSelected:1}),false);
  assert.equal(validShellState({...ai,sidebarWidth,nativeIds:[1]}),false);
 }
 for(const view of ['feed','notifications','market','settings','wallet',null]){
  const normal={...state(),view,sidebarSelected:0,nativeIds:[]};
  for(const sidebarWidth of [190,198,208,260])assert.equal(validShellState({...normal,sidebarWidth}),true);
  for(const sidebarWidth of [260.001,8192,189.999,NaN,Infinity])assert.equal(validShellState({...normal,sidebarWidth}),false);
 }
});
test('aiSurface is an optional closed phase only for AI, preserving old shape and actual metadata',()=>{
 const legacy=state();assert.equal(Object.keys(legacy).length,8);assert.equal(validShellState(legacy),true);
 assert.equal(validShellState({...legacy,aiSurface:null}),true);
 const ai={...legacy,view:'ai',sidebarSelected:0,nativeIds:[]};
 for(const aiSurface of ['legacy','preparing','workspace_required','failed']){
  const value={...ai,aiSurface};assert.equal(Object.keys(value).length,9);assert.equal(validShellState(value),true);assert.equal(value.sidebarWidth,198);
  assert.equal(validShellState({...legacy,aiSurface}),false);assert.equal(validShellState({...ai,view:null,aiSurface}),false);
 }
 for(const aiSurface of ['t3','T3','unknown','',false,1,undefined,{},[]])assert.equal(validShellState({...ai,aiSurface}),false);
 assert.equal(validShellState({...ai,aiSurface:null}),true);assert.equal(validShellState({...ai,aiSurface:'legacy',unexpected:true}),false);
 for(const sidebarWidth of [190,208,8192])assert.equal(validShellState({...ai,aiSurface:'legacy',sidebarWidth}),true);
 for(const sidebarWidth of [189.999,8192.001,NaN,Infinity])assert.equal(validShellState({...ai,aiSurface:'legacy',sidebarWidth}),false);
 assert.equal(validShellState({...ai,aiSurface:'legacy',nativeIds:[1]}),false);
});
test('readonly AI inspection ACK retains only the real supplied phase and does not infer a surface from width',async t=>{
 const f=await fixture(t);Object.assign(f.current,{view:'ai',sidebarSelected:0,nativeIds:[],aiSurface:'legacy',sidebarWidth:260});f.send();await tick();
 assert.equal(f.calls[0].args.state.aiSurface,'legacy');assert.equal(f.calls[0].args.state.sidebarWidth,260);
 f.current.aiSurface='failed';f.current.sidebarWidth=208;f.send(2);await tick();assert.equal(f.calls[1].args.state.aiSurface,'failed');assert.equal(f.calls[1].args.state.sidebarWidth,208);
});
