import test from 'node:test';
import assert from 'node:assert/strict';
import {createPiQueueFacade} from './pi-queue-facade.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const selected=()=>({bridgeId:id(1),anchorRunId:id(2),expectedWorkspace:'C:\\synthetic\\workspace',expectedModel:'ollama/test-model'});
const flags=()=>({allowWrite:false,allowExec:true,allowHttp:false});
const context=()=>({token:id(3),workspace:selected().expectedWorkspace,model:selected().expectedModel,engine:'pi',permissions:flags()});
const row=(n=1,extra={})=>({queueId:id(10+n),requestId:id(100+n),userMessageId:id(200+n),anchorRunId:id(2),workspace:selected().expectedWorkspace,
  text:'queued text',model:selected().expectedModel,engine:'pi',permissions:flags(),position:n,held:false,requestedAtMs:123,state:'queued',nativeRunId:null,...extra});
const snap=(extra={})=>({context:context(),revision:0,available:true,items:[],...extra});
const enqueue=(extra={})=>({expectedRevision:0,requestId:id(500),action:'enqueue',anchorRunId:id(2),text:' raw instruction ',...extra});
const ack=(input,extra={})=>({context:id(3),requestId:input.requestId,revision:input.expectedRevision+1,queueId:input.queueId??id(11),applied:true,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const code=value=>error=>{assert.equal(error.code,value);assert.equal(error.message,value);return true;};
async function rig(t,options={}){
  let capture=selected(),active=true,value=snap();const calls=[],invalidations=[];
  const transport=async(name,args)=>{calls.push({name,args:structuredClone(args)});assert.deepEqual(Object.keys(args),['request']);
    if(options.transport)return options.transport(name,args.request);
    if(name==='pi_work_queue_context'||name==='pi_work_queue_snapshot')return structuredClone(value);
    if(name==='pi_work_queue_action')return ack(args.request);
    if(name==='pi_work_queue_release')return null;
    assert.fail('unexpected Native command');};
  const facade=createPiQueueFacade({invoke:transport,getContext:()=>capture,isCurrent:()=>active,onInvalidate:note=>invalidations.push(note)});
  t.after(()=>facade.dispose().catch(()=>{}));
  const r={facade,calls,invalidations,setScope:next=>{capture=next;},setActive:next=>{active=next;},setSnapshot:next=>{value=next;}};
  if(options.initialize!==false)await facade.snapshot();return r;
}

test('only fixed wrapped commands use fresh capture and actual available=false never enables actions',async t=>{
  const r=await rig(t);assert.deepEqual(r.calls[0],{name:'pi_work_queue_context',args:{request:selected()}});
  assert.deepEqual(r.calls[1],{name:'pi_work_queue_snapshot',args:{request:{context:id(3)}}});
  const a=await r.facade.snapshot();a.context.permissions.allowWrite=true;
  assert.equal((await r.facade.snapshot()).context.permissions.allowWrite,false);
  r.setSnapshot(snap({available:false}));assert.equal((await r.facade.snapshot()).available,false);
  await assert.rejects(r.facade.action(enqueue()),code('pi_queue_unavailable'));
  assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,0);
});

test('closed operation shapes reject injected authority, malformed UUID and Unicode before Native write',async t=>{
  const r=await rig(t);
  for(const input of [enqueue({permissions:flags()}),enqueue({script:'injected'}),enqueue({model:'other/model'}),enqueue({context:id(3)}),
    enqueue({requestId:id(500)+'\n'}),enqueue({text:'x\u0000y'}),enqueue({text:'\ud800'}),enqueue({text:'😀'.repeat(4001)}),
    enqueue({text:' \n ' }),enqueue({expectedRevision:Number.MAX_SAFE_INTEGER+1}),enqueue({action:'__proto__'})]){
    await assert.rejects(r.facade.action(input),code('pi_queue_invalid'));
  }
  const withGetter=enqueue();Object.defineProperty(withGetter,'text',{get(){assert.fail('getter must not execute');},enumerable:true});
  await assert.rejects(r.facade.action(withGetter),code('pi_queue_invalid'));
  assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,0);
});

test('same request shares one pending call and confirmed receipt; different payload conflicts without replay',async t=>{
  const gate=deferred(),entered=deferred();
  const r=await rig(t,{transport:async(name,input)=>{
    if(name==='pi_work_queue_action'){entered.resolve();return gate.promise;}
    return name==='pi_work_queue_release'?null:snap();
  }});
  const input=enqueue(),first=r.facade.action(input),second=r.facade.action({...input});assert.equal(first,second);await entered.promise;
  await assert.rejects(r.facade.action(enqueue({text:'different'})),code('pi_queue_request_conflict'));
  await assert.rejects(r.facade.action(enqueue({requestId:id(501)})),code('pi_queue_busy'));
  gate.resolve(ack(input));assert.deepEqual(await first,ack(input));assert.deepEqual(await r.facade.action({...input}),ack(input));
  assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,1);
});

test('unknown enqueue blocks writes until explicit snapshot proves the actual reservation, never fabricating ACK',async t=>{
  let value=snap();const r=await rig(t,{transport:async(name)=>{
    if(name==='pi_work_queue_action')throw Error('private prompt/path/token must not escape');
    return name==='pi_work_queue_release'?null:structuredClone(value);
  }});
  const input=enqueue();await assert.rejects(r.facade.action(input),code('pi_queue_unknown'));
  await assert.rejects(r.facade.action(input),code('pi_queue_unknown'));
  await assert.rejects(r.facade.action(enqueue({requestId:id(501)})),code('pi_queue_unknown'));
  value=snap({revision:1,items:[row(1,{requestId:input.requestId,text:'not the same body'})]});await r.facade.snapshot();
  await assert.rejects(r.facade.action(input),code('pi_queue_unknown'));
  value.items[0].text=input.text;const observed=await r.facade.snapshot();assert.equal(observed.items[0].queueId,id(11));
  await assert.rejects(r.facade.action(input),code('pi_queue_observed'));
  await assert.rejects(r.facade.action(enqueue({expectedRevision:1,requestId:id(501)})),code('pi_queue_unknown'));
  assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,2);
});

test('unknown edit remains unknown even when readonly desired state matches because item requestId is original enqueue',async t=>{
  let value=snap({items:[row()]});const r=await rig(t,{transport:async(name)=>{
    if(name==='pi_work_queue_action')throw Error('lost ACK');return name==='pi_work_queue_release'?null:value;
  }});
  const input={expectedRevision:0,requestId:id(500),action:'edit',queueId:id(11),text:'edited text'};
  await assert.rejects(r.facade.action(input),code('pi_queue_unknown'));value=snap({revision:1,items:[row(1,{text:input.text})]});await r.facade.snapshot();
  await assert.rejects(r.facade.action(input),code('pi_queue_unknown'));
  await assert.rejects(r.facade.action({expectedRevision:1,requestId:id(501),action:'cancel',queueId:id(11)}),code('pi_queue_unknown'));
  assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,1);
});

test('receipt identity/shape failures keep unknown and expose only fixed error codes',async t=>{
  for(const change of [{context:id(4)},{requestId:id(501)},{queueId:'invalid'},{applied:false},{extra:'raw-private-payload'},{revision:-1}]){
    const r=await rig(t,{transport:async(name,input)=>name==='pi_work_queue_action'?ack(input,change):name==='pi_work_queue_release'?null:snap()});
    await assert.rejects(r.facade.action(enqueue()),code('pi_queue_unknown'));
    await assert.rejects(r.facade.action(enqueue()),code('pi_queue_unknown'));
    assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,1);
  }
});

test('scope changes after an action ACK suppress adoption and release holds only the captured context',async t=>{
  const entered=deferred(),gate=deferred();const r=await rig(t,{transport:async(name)=>{
    if(name==='pi_work_queue_action'){entered.resolve();return gate.promise;}return name==='pi_work_queue_release'?null:snap();
  }});
  const input=enqueue(),pending=r.facade.action(input);await entered.promise;
  r.setScope({...selected(),expectedModel:'ollama/different-model'});gate.resolve(ack(input));
  await assert.rejects(pending,code('pi_queue_stale'));await r.facade.dispose();
  assert.deepEqual(r.calls.filter(call=>call.name==='pi_work_queue_release').map(call=>call.args),[{request:{context:id(3)}}]);
  assert.deepEqual(r.invalidations,[{code:'pi_queue_stale'}]);
  await assert.rejects(r.facade.snapshot(),code('pi_queue_stale'));
  assert.equal(r.calls.some(call=>/start|cancel_run/u.test(call.name)),false);
});

test('dispose during context creation releases late token without adopting or reading its snapshot',async t=>{
  const entered=deferred(),gate=deferred();const r=await rig(t,{initialize:false,transport:async(name)=>{
    if(name==='pi_work_queue_context'){entered.resolve();return gate.promise;}assert.equal(name,'pi_work_queue_release');return null;
  }});
  const pending=r.facade.snapshot();await entered.promise;const disposed=r.facade.dispose();gate.resolve(snap());
  await assert.rejects(pending,code('pi_queue_stale'));await disposed;
  assert.deepEqual(r.calls.map(call=>call.name),['pi_work_queue_context','pi_work_queue_release']);
});

test('release failure does not revive the facade or adopt late requests',async t=>{
  const r=await rig(t,{transport:async(name)=>{if(name==='pi_work_queue_release')throw Error('private raw error');return snap();}});
  await assert.rejects(r.facade.dispose(),code('pi_queue_release_unknown'));
  await assert.rejects(r.facade.action(enqueue()),code('pi_queue_stale'));
  await assert.rejects(r.facade.snapshot(),code('pi_queue_stale'));
  assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_release').length,1);
});

test('out-of-order snapshot cannot replace the newer Native revision used by a following operation',async t=>{
  const old=deferred(),newer=deferred(),first=deferred(),second=deferred();let reads=0,initialized=false;
  const r=await rig(t,{transport:async(name,input)=>{
    if(name==='pi_work_queue_snapshot'&&initialized){reads++;(reads===1?first:second).resolve();return reads===1?old.promise:newer.promise;}
    return name==='pi_work_queue_action'?ack(input):name==='pi_work_queue_release'?null:snap();
  }});initialized=true;
  const a=r.facade.snapshot();await first.promise;const b=r.facade.snapshot();await second.promise;
  newer.resolve(snap({revision:4}));assert.equal((await b).revision,4);old.resolve(snap({revision:3}));await assert.rejects(a,code('pi_queue_stale'));
  assert.equal((await r.facade.action(enqueue({expectedRevision:4}))).revision,5);
});

test('real DTO limits accept boundaries and reject sparse/duplicate/oversize records and invalid context',async t=>{
  const r=await rig(t);const valid=snap({items:Array.from({length:8},(_,i)=>row(i+1,{text:'😀'.repeat(2048)}))});
  r.setSnapshot(valid);assert.equal((await r.facade.snapshot()).items.length,8);
  for(const invalid of [snap({items:Array.from({length:9},(_,i)=>row(i+1))}),snap({items:[row(1,{text:'😀'.repeat(4001)})]}),
    snap({items:[...valid.items.slice(0,7),row(8,{text:'😀'.repeat(2048)+'x'})]}),snap({items:[row(),row()]}),
    snap({items:[row(1,{text:'nul\u0000'})]}),snap({context:{...context(),engine:'codex'}}),snap({context:{...context(),permissions:{...flags(),allowTest:false}}}),
    snap({context:{...context(),workspace:'other workspace'}}),snap({available:true,context:null}),snap({items:Array(1)}),
    snap({items:Array.from({length:33},(_,i)=>row(i+1,{state:'done',nativeRunId:id(300+i)}))})]){
    r.setSnapshot(invalid);await assert.rejects(r.facade.snapshot(),code('pi_queue_unavailable'));
  }
  r.setSnapshot(snap({items:Array.from({length:32},(_,i)=>row(i+1,{state:'done',nativeRunId:id(300+i),text:'x'.repeat(8000)}))}));
  assert.equal((await r.facade.snapshot()).items.length,32);
});

test('reorder/resume use exact queue IDs and closed bodies; snapshots preserve actual permissions',async t=>{
  const r=await rig(t);r.setSnapshot(snap({items:[row(1,{state:'held',held:true}),row(2)]}));await r.facade.snapshot();
  const input={expectedRevision:0,requestId:id(500),action:'resume',queueId:id(11),anchorRunId:id(2)};
  assert.equal((await r.facade.action(input)).queueId,id(11));
  const reorder={expectedRevision:0,requestId:id(501),action:'reorder',queueId:id(12),beforeQueueId:null};await r.facade.action(reorder);
  assert.deepEqual(r.calls.filter(call=>call.name==='pi_work_queue_action').map(call=>call.args.request),[{context:id(3),...input},{context:id(3),...reorder}]);
  await assert.rejects(r.facade.action({...reorder,requestId:id(502),beforeQueueId:id(12)}),code('pi_queue_invalid'));
  await assert.rejects(r.facade.action({...input,requestId:id(503),anchorRunId:id(4)}),code('pi_queue_invalid'));
});

test('fixed aliases validate selection/token and share the action ledger without extra Native commands',async t=>{
  const r=await rig(t,{initialize:false});assert.deepEqual(await r.facade.queueContext(selected()),snap());
  assert.deepEqual(r.calls.map(call=>call.name),['pi_work_queue_context']);
  assert.equal((await r.facade.queueSnapshot({context:id(3)})).context.token,id(3));
  const input={context:id(3),...enqueue()};const result=await r.facade.queueAction(input);
  assert.deepEqual(await r.facade.action(enqueue()),result);
  assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,1);
  for(const call of [()=>r.facade.queueContext({...selected(),extra:true}),()=>r.facade.queueSnapshot({context:id(4)}),
    ()=>r.facade.queueAction({...input,context:id(4)}),()=>r.facade.queueRelease({context:id(4)})])await assert.rejects(call());
  await r.facade.queueRelease({context:id(3)});await r.facade.queueRelease({context:id(3)});
  assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_release').length,1);
  await assert.rejects(r.facade.queueSnapshot({context:id(3)}),code('pi_queue_stale'));
});

test('explicit new selection context after release cannot be closed by an old action continuation',async t=>{
  const entered=deferred(),gate=deferred();let currentContext=context();
  const r=await rig(t,{transport:async(name,input)=>{
    if(name==='pi_work_queue_action'){if(input.context===id(3)){entered.resolve();return gate.promise;}return ack(input,{context:input.context});}
    return name==='pi_work_queue_release'?null:snap({context:currentContext});
  }});
  const pending=r.facade.queueAction({context:id(3),...enqueue()});await entered.promise;
  await r.facade.queueRelease({context:id(3)});
  const next={...selected(),expectedModel:'ollama/new-selection'};r.setScope(next);currentContext={...context(),token:id(4),model:next.expectedModel};
  assert.equal((await r.facade.queueContext(next)).context.token,id(4));gate.resolve(ack(enqueue()));
  await assert.rejects(pending,code('pi_queue_stale'));
  assert.equal((await r.facade.queueSnapshot({context:id(4)})).context.token,id(4));
  // A known old token may be released again but cannot invalidate the current observation.
  await r.facade.queueRelease({context:id(3)});
  assert.equal((await r.facade.queueSnapshot({context:id(4)})).context.token,id(4));
  assert.equal((await r.facade.queueAction({context:id(4),...enqueue({requestId:id(501)})})).context,id(4));
});

test('a new explicit selection waits for late old context cleanup, then mints only the new current context',async t=>{
  const entered=deferred(),gate=deferred();let creates=0;
  const r=await rig(t,{initialize:false,transport:async(name,input)=>{
    if(name==='pi_work_queue_context'){
      creates++;if(creates===1){entered.resolve();return gate.promise;}
      return snap({context:{...context(),token:id(4),model:input.expectedModel}});
    }
    assert.equal(name,'pi_work_queue_release');return null;
  }});
  const old=r.facade.queueContext(selected());const oldResult=assert.rejects(old,code('pi_queue_stale'));await entered.promise;
  const next={...selected(),expectedModel:'ollama/changed'};r.setScope(next);
  const fresh=r.facade.queueContext(next);gate.resolve(snap());await oldResult;
  assert.equal((await fresh).context.token,id(4));assert.equal(creates,2);
  assert.deepEqual(r.calls.filter(call=>call.name==='pi_work_queue_release').map(call=>call.args.request.context),[id(3)]);
});

test('aliases refuse wrong capture without touching Native and disposed lifetime cannot be reactivated',async t=>{
  const r=await rig(t,{initialize:false});
  await assert.rejects(r.facade.queueContext({...selected(),expectedWorkspace:'other workspace'}),code('pi_queue_stale'));
  assert.deepEqual(r.calls,[]);await r.facade.dispose();
  await assert.rejects(r.facade.queueContext(selected()),code('pi_queue_stale'));assert.deepEqual(r.calls,[]);
});

for(const rejection of ['pi_work_queue_revision_conflict','pi_work_queue_limit']){
  test(`exact preapply ${rejection} keeps the original rejection and permits a new explicit request after snapshot`,async t=>{
    let value=snap();const r=await rig(t,{transport:async(name,input)=>{
      if(name==='pi_work_queue_action'){if(input.requestId===id(500))throw Error(rejection);return ack(input);}
      return name==='pi_work_queue_release'?null:value;
    }});
    const input=enqueue(),first=r.facade.action(input);
    await assert.rejects(first,error=>error.code==='pi_queue_rejected'&&error.outcomeUnknown===false);
    assert.equal(r.facade.action({...input}),first);await assert.rejects(first,code('pi_queue_rejected'));
    await assert.rejects(r.facade.action(enqueue({text:'changed payload'})),code('pi_queue_request_conflict'));
    await assert.rejects(r.facade.action(enqueue({requestId:id(501)})),code('pi_queue_conflict'));
    assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,1);
    value=snap({revision:4});await r.facade.snapshot();
    assert.equal((await r.facade.action(enqueue({requestId:id(501),expectedRevision:4}))).applied,true);
    assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,2);
  });
}

test('only exact preapply codes are known; unknown strings and malformed receipt keep writes locked',async t=>{
  for(const error of ['pi_work_queue_limit raw detail','pi_work_queue_limit\n','pi_work_queue_timeout',
    Object.assign(new Error('pi_work_queue_limit'),{code:'unknown_outer_code'})]){
    const r=await rig(t,{transport:async(name)=>{if(name==='pi_work_queue_action')throw error;return name==='pi_work_queue_release'?null:snap();}});
    await assert.rejects(r.facade.action(enqueue()),error=>error.code==='pi_queue_unknown'&&error.outcomeUnknown===true);
    await r.facade.snapshot();await assert.rejects(r.facade.action(enqueue({requestId:id(501)})),code('pi_queue_unknown'));
    assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,1);
  }
});

test('unknown enqueue observes an actual same-scope Native run descendant without manufacturing an action ACK',async t=>{
  let value=snap();const r=await rig(t,{transport:async(name)=>{if(name==='pi_work_queue_action')throw Error('lost ACK');return name==='pi_work_queue_release'?null:value;}});
  const input=enqueue();await assert.rejects(r.facade.action(input),code('pi_queue_unknown'));
  value=snap({revision:3,items:[row(1,{nativeRunId:id(300),state:'done'}),row(2,{anchorRunId:id(300),nativeRunId:id(301),state:'done'}),
    row(3,{requestId:input.requestId,anchorRunId:id(301),text:input.text})]});
  const observed=await r.facade.snapshot();assert.equal(observed.items[2].anchorRunId,id(301));
  await assert.rejects(r.facade.action(input),code('pi_queue_observed'));
  assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,1);
});

test('unknown enqueue does not accept cycles, ambiguous run IDs, foreign scope or missing Native chain',async t=>{
  const cases=[
    [row(1,{nativeRunId:id(300),anchorRunId:id(301),state:'done'}),row(2,{nativeRunId:id(301),anchorRunId:id(300),state:'done'})],
    [row(1,{nativeRunId:id(300),state:'done'}),row(2,{nativeRunId:id(300),state:'done'})],
    ...['workspace','model','engine','permissions'].map(key=>[row(1,{nativeRunId:id(300),state:'done',
      [key]:key==='workspace'?'C:/foreign':key==='model'?'ollama/foreign':key==='engine'?'dsh':{...flags(),allowWrite:true}})]),
    [],
    // Reaching the requested root cannot hide a cycle through that same root.
    [row(1,{nativeRunId:id(300),state:'done'}),row(2,{nativeRunId:id(2),anchorRunId:id(300),state:'done'})],
  ];
  for(const ancestors of cases){
    let value=snap();const r=await rig(t,{transport:async(name)=>{if(name==='pi_work_queue_action')throw Error('lost ACK');return name==='pi_work_queue_release'?null:value;}});
    const input=enqueue();await assert.rejects(r.facade.action(input),code('pi_queue_unknown'));
    value=snap({revision:2,items:[...ancestors,row(3,{requestId:input.requestId,anchorRunId:id(300),text:input.text})]});
    await r.facade.snapshot();await assert.rejects(r.facade.action(input),code('pi_queue_unknown'));
    await assert.rejects(r.facade.action(enqueue({requestId:id(501),expectedRevision:2})),code('pi_queue_unknown'));
    assert.equal(r.calls.filter(call=>call.name==='pi_work_queue_action').length,1);
  }
});
