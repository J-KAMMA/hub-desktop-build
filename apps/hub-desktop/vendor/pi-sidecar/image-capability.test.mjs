import test from 'node:test';
import assert from 'node:assert/strict';
import {imageCapability,imageModel,requireImageModel} from './image-capability.mjs';
const model=(extra={})=>({provider:'ollama',id:'installed:latest',baseUrl:'http://localhost:11434/v1',input:['text'],contextWindow:4096,maxTokens:1024,...extra});
const runtime=(value=model(),ready=true)=>({getModel:(provider,id)=>value?.provider===provider&&value.id===id?value:null,hasConfiguredAuth:()=>ready,
  checkAuth:()=>{throw Error('auth refresh forbidden');},getAvailable:()=>{throw Error('all-provider probe forbidden');}});
const reply=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
test('registered image input is authoritative and no provider/network/auth-refresh operation occurs',async()=>{
  const vision=model({provider:'registered',input:['text','image']}),rt=runtime(vision);let calls=0;
  assert.deepEqual(await imageCapability(rt,'registered/installed:latest',()=>{calls++;throw Error('network forbidden');}),{type:'imageCapability',model:'registered/installed:latest',ready:true,supported:true});assert.equal(calls,0);
  assert.equal(await imageModel(vision,()=>{throw Error('network forbidden');}),vision);requireImageModel(vision);
  assert.deepEqual(await imageCapability(runtime(vision,false),'registered/installed:latest',()=>{throw Error('network forbidden');}),{type:'imageCapability',model:'registered/installed:latest',ready:false,supported:true});
});
test('selected auto-Ollama model probes only fixed loopback show, bounded timeout/redirect and upgrades only an ephemeral copy',async()=>{
  const original=model(),calls=[];const fetcher=async(url,options)=>{calls.push({url,options});return reply({capabilities:['completion','vision']});};
  assert.deepEqual(await imageCapability(runtime(original),'ollama/installed:latest',fetcher),{type:'imageCapability',model:'ollama/installed:latest',ready:true,supported:true});
  const updated=await imageModel(original,fetcher);assert.notEqual(updated,original);assert.deepEqual(updated.input,['text','image']);assert.deepEqual(original.input,['text']);assert.equal(updated.maxTokens,1024);
  for(const call of calls){assert.equal(call.url,'http://127.0.0.1:11434/api/show');assert.equal(call.options.method,'POST');assert.equal(call.options.redirect,'error');assert.deepEqual(JSON.parse(call.options.body),{model:'installed:latest'});assert.ok(call.options.signal instanceof AbortSignal);}
});
test('selected metadata is checked afresh on each run/resume, never inferred from a vision-like name',async()=>{
  const original=model({id:'vision-looking-name'});let calls=0;const fetcher=async()=>reply({capabilities:++calls===1?['vision']:['completion']});
  requireImageModel(await imageModel(original,fetcher));const second=await imageModel(original,fetcher);assert.equal(second,original);assert.throws(()=>requireImageModel(second),/unsupported_model/);assert.equal(calls,2);
  assert.equal((await imageCapability(runtime(original),'ollama/vision-looking-name',async()=>reply({capabilities:['completion']}))).supported,false);
});
test('unsupported registered providers and custom/credential/local-alias endpoints never trigger metadata requests',async()=>{
  for(const value of [model({provider:'remote'}),model({baseUrl:'https://remote.example/v1'}),model({baseUrl:'http://user:pass@127.0.0.1:11434/v1'}),model({baseUrl:'http://127.0.0.1:9999/v1'}),model({baseUrl:'http://127.0.0.1:11434/custom'}),model({baseUrl:'http://127.0.0.1:11434/v1?q=secret'})]){
    const forbidden=()=>{throw Error('must not request');};assert.equal((await imageCapability(runtime(value),`${value.provider}/${value.id}`,forbidden)).supported,false);assert.equal(await imageModel(value,forbidden),value);
  }
  for(const input of [undefined,null,'image',[]])assert.throws(()=>requireImageModel({input}),/unsupported_model/);
});
test('capability result is closed even with untrusted metadata fields and readiness remains configured-auth only',async()=>{
  const result=await imageCapability(runtime(null,false),'ollama/installed:latest',async()=>reply({capabilities:['vision'],privateKey:'not exported',template:'not exported',model_info:{secret:'not exported'}}));
  assert.deepEqual(result,{type:'imageCapability',model:'ollama/installed:latest',ready:false,supported:true});assert.deepEqual(Object.keys(result),['type','model','ready','supported']);
});
test('read failure is unavailable, while a valid nonvision capability report alone means unsupported',async()=>{
  for(const data of [null,{},[],{capabilities:'vision'},{capabilities:['vision',1]},{capabilities:Array(33).fill('vision')},{capabilities:['vision','x'.repeat(81)]}])await assert.rejects(imageCapability(runtime(),'ollama/installed:latest',async()=>reply(data)),error=>error.message==='pi_image_unavailable');
  for(const capabilities of [[],['Vision'],['completion']])assert.equal((await imageCapability(runtime(),'ollama/installed:latest',async()=>reply({capabilities}))).supported,false);
  for(const fetcher of [async()=>new Response('bad json'),async()=>new Response(Uint8Array.from([255,254])),async()=>new Response('',{status:503}),async()=>{throw Error('private transport');}]){
    await assert.rejects(imageCapability(runtime(),'ollama/installed:latest',fetcher),error=>error.message==='pi_image_unavailable');
    await assert.rejects(imageModel(model(),fetcher),error=>error.message==='pi_image_unavailable');
  }
});
test('79,767-byte model info and exact 256KiB streaming response stay bounded and retain closed capability output',async()=>{
  const small=JSON.stringify({capabilities:['vision'],model_info:''});
  for(const size of [79767,256*1024-1,256*1024]){
    const body=JSON.stringify({capabilities:['vision'],model_info:'x'.repeat(size-small.length)});assert.equal(Buffer.byteLength(body),size);
    const fetcher=async()=>new Response(new ReadableStream({start(controller){const bytes=Buffer.from(body);for(let index=0;index<bytes.length;index+=8192)controller.enqueue(bytes.subarray(index,index+8192));controller.close();}}));
    assert.deepEqual(await imageCapability(runtime(),'ollama/installed:latest',fetcher),{type:'imageCapability',model:'ollama/installed:latest',ready:true,supported:true});
  }
  let cancelled=false;const oversized=Buffer.from(JSON.stringify({capabilities:['vision'],model_info:'x'.repeat(256*1024+1-small.length)}));assert.equal(oversized.length,256*1024+1);
  await assert.rejects(imageCapability(runtime(),'ollama/installed:latest',async()=>new Response(new ReadableStream({start(controller){controller.enqueue(oversized);},cancel(){cancelled=true;}}))),error=>error.message==='pi_image_unavailable');assert.equal(cancelled,true);
});
test('model identifiers remain bounded and malformed inputs never perform runtime lookup or metadata I/O',async()=>{
  const rt={getModel(){throw Error('lookup forbidden');},hasConfiguredAuth(){throw Error('auth forbidden');}};
  for(const name of ['', 'ollama/','ollama/model\n','ollama/model\0','ollama/../../other','ollama/'+ 'x'.repeat(58),'remote model','ollama/\ud800','ollama/\udfff'])await assert.rejects(imageCapability(rt,name,()=>{throw Error('I/O forbidden');}),/invalid_model/);
});
test('capability metadata cannot substitute another registered model or provider for the selected identity',async()=>{
  const fetcher=()=>{throw Error('wrong-model probe forbidden');};
  for(const value of [model({id:'other',input:['image']}),model({provider:'other',input:['image']})]){
    assert.deepEqual(await imageCapability({getModel:()=>value,hasConfiguredAuth:()=>true},'ollama/installed:latest',fetcher),{type:'imageCapability',model:'ollama/installed:latest',ready:false,supported:false});
  }
});
test('unregistered selected Ollama can register the confirmed default memory profile only and use actual new auth readiness',async()=>{
  let models=[],ready=false;const writes=[];const rt={getModels:()=>models,getModel:(provider,id)=>models.find(row=>row.provider===provider&&row.id===id),hasConfiguredAuth:()=>ready,
    registerProvider(provider,options){writes.push({provider,options});models=options.models.map(row=>({...row,provider,baseUrl:options.baseUrl}));ready=true;}};
  const result=await imageCapability(rt,'ollama/installed:latest',async()=>reply({capabilities:['vision']}));assert.deepEqual(result,{type:'imageCapability',model:'ollama/installed:latest',ready:true,supported:true});
  assert.equal(writes.length,1);assert.equal(writes[0].options.apiKey,'ollama');assert.equal(writes[0].options.baseUrl,'http://127.0.0.1:11434/v1');assert.deepEqual(writes[0].options.models.map(row=>row.id),['installed:latest']);
  for(const baseUrl of ['http://remote.example:11434/v1','http://127.0.0.1:9999/v1','http://user:password@127.0.0.1:11434/v1']){
    const blocked={...rt,getModel:()=>null,getModels:()=>[model({baseUrl})],registerProvider:()=>{throw Error('overwrite forbidden');}};
    assert.equal((await imageCapability(blocked,'ollama/new',()=>{throw Error('probe forbidden');})).supported,false);
  }
});
test('selected model added to an existing default local provider preserves its settings and other models',async()=>{
  const existing=model({id:'other',privateSettings:'not returned'});let models=[existing],options;
  const rt={getModels:()=>models,getModel:(provider,id)=>models.find(row=>row.id===id&&row.provider===provider),hasConfiguredAuth:()=>true,
    registerProvider(provider,value){options=value;models=value.models.map(row=>({...row,provider,baseUrl:existing.baseUrl}));}};
  const result=await imageCapability(rt,'ollama/installed:latest',async()=>reply({capabilities:['vision']}));assert.equal(result.ready,true);assert.equal(result.supported,true);
  assert.deepEqual(Object.keys(options),['models']);assert.equal(options.models[0],existing);assert.deepEqual(options.models.map(row=>row.id),['other','installed:latest']);assert.equal(existing.privateSettings,'not returned');assert.equal(JSON.stringify(result).includes('privateSettings'),false);
});
