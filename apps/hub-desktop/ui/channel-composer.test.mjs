import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {communityMessageRequestIdentity} from '../../hub/lib/server/community-message-request.ts';
import {createChannelComposer} from './channel-composer.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const COMMUNITY='community-A', CHANNEL='channel-A', VIEWER='viewer-A', IMAGE='12345678-1234-4234-8234-123456789abc';
const scope=(device='device-A',generation=1)=>({key:JSON.stringify(['http://127.0.0.1:3020',device]),generation});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate());}
async function receipt(args){
  const identity=await communityMessageRequestIdentity(args.options.expectedViewerId,args.requestId,{communityId:args.target,channelId:args.options.channelId,
    body:args.text,kind:args.options.kind,replyToMessageId:args.options.replyToMessageId,imageIds:args.options.imageIds});
  return{message:{id:identity.messageId,channelId:args.options.channelId,authorProfileId:args.options.expectedViewerId,body:args.text,
    kind:args.options.kind,replyToMessageId:args.options.replyToMessageId,images:(args.options.imageIds??[]).map(id=>({id}))}};
}
async function rig(t,overrides={}){
  const dom=new JSDOM('<main></main>'),state=overrides.state??{},calls=[],sent=[],errors=[];
  let currentScope=scope(),active=true;
  const invoke=async(name,args)=>{calls.push({name,args});return overrides.invoke?overrides.invoke(name,args):name==='hub_client_action'?receipt(args):{};};
  const options={document:dom.window.document,communityId:COMMUNITY,channelId:CHANNEL,viewerId:VIEWER,state,invoke,getScope:()=>currentScope,isCurrent:()=>active,
    onSent:value=>sent.push(value),onError:value=>errors.push(value),formatError:()=> '準備できませんでした。',...overrides};
  // Keep the test's tracking wrapper even when a deferred transport is injected.
  options.invoke=invoke;
  const controller=createChannelComposer(options);dom.window.document.querySelector('main').append(controller.element);await controller.ready;
  t.after(()=>{controller.destroy();dom.window.close();});
  return{dom,state,calls,sent,errors,options,controller,setScope:value=>{currentScope=value;},setActive:value=>{active=value;},
    input:value=>{controller.textarea.value=value;controller.textarea.dispatchEvent(new dom.window.Event('input'));},
    file:()=>new dom.window.File(['synthetic bytes'],'private-selection.png',{type:'image/png'})};
}

test('logout during image preparation clears private state and never invokes upload or channel send',async t=>{
  const gate=defer(),entered=defer();
  const r=await rig(t,{uploadFiles:async(files,ctx)=>{entered.resolve();await gate.promise;await ctx.invoke('hub_upload_image',{image:[1]});return[IMAGE];}});
  r.input('private draft');r.controller.addFiles([r.file()]);const pending=r.controller.send();await entered.promise;
  r.setScope(null);r.dom.window.dispatchEvent(new r.dom.window.Event('hub-account-changed'));gate.resolve();
  assert.equal(await pending,false);assert.deepEqual(r.calls,[]);assert.deepEqual(r.state,{});assert.equal(r.controller.textarea.value,'');assert.equal(r.sent.length,0);
});

test('a changed device detected by upload invoke blocks every mutation even without an account event',async t=>{
  const gate=defer(),entered=defer();
  const r=await rig(t,{uploadFiles:async(files,ctx)=>{entered.resolve();await gate.promise;await ctx.invoke('hub_upload_image',{image:[1]});return[IMAGE];}});
  r.input('draft A');r.controller.addFiles([r.file()]);const pending=r.controller.send();await entered.promise;r.setScope(scope('device-B',2));gate.resolve();
  assert.equal(await pending,false);assert.deepEqual(r.calls,[]);assert.deepEqual(r.state,{});
});

test('pending input never re-enables send; an old ACK preserves a new input revision',async t=>{
  const ack=defer();let payload;const r=await rig(t,{invoke:async(name,args)=>{payload=args;return ack.promise;}});
  r.input('original');const first=r.controller.send();await until(()=>r.calls.length===1);
  assert.equal(r.controller.textarea.disabled,true);r.input('new input');assert.equal(r.controller.element.querySelector('[data-channel-action=send]').disabled,true);
  assert.equal(await r.controller.send(),false);assert.equal(r.calls.length,1);ack.resolve(await receipt(payload));assert.equal(await first,true);
  assert.equal(r.state.body,'new input');assert.equal(r.controller.textarea.value,'new input');assert.equal(r.sent.length,1);
});

test('an edit and return to the same text still prevents ACK draft clearing',async t=>{
  const ack=defer();let payload;const r=await rig(t,{invoke:async(name,args)=>{payload=args;return ack.promise;}});
  r.input('original');const pending=r.controller.send();await until(()=>r.calls.length===1);r.input('temporary');r.input('original');
  ack.resolve(await receipt(payload));assert.equal(await pending,true);assert.equal(r.state.body,'original');
});

test('same scope view disposal and refresh preserve draft, scheduled reply, kind and selected File references',async t=>{
  const r=await rig(t),file=r.file(),reply='scheduled:12345678-1234-4234-8234-123456789abc';
  r.input('saved draft');r.controller.kind.value='guide';r.controller.kind.dispatchEvent(new r.dom.window.Event('change'));
  assert.equal(r.controller.setReply({id:reply,channelId:CHANNEL,label:'selected reply'}),true);r.controller.addFiles([file]);
  r.setActive(false);r.controller.destroy();
  const restored=createChannelComposer({...r.options,isCurrent:()=>true});r.dom.window.document.querySelector('main').append(restored.element);await restored.ready;t.after(()=>restored.destroy());
  assert.equal(restored.textarea.value,'saved draft');assert.equal(restored.kind.value,'guide');assert.equal(r.state.reply.id,reply);assert.equal(r.state.files[0],file);
  assert.equal(restored.hasImages(),true);assert.equal(r.calls.length,0);
});

test('late ACK after disposal makes no callback and a fresh read can resolve the fixed operation once',async t=>{
  const ack=defer();let payload,saved;const r=await rig(t,{invoke:async(name,args)=>{if(name==='hub_client_action'){payload=args;return ack.promise;}return{viewerProfileId:VIEWER,messages:[saved.message]};}});
  r.input('sent once');const pending=r.controller.send();await until(()=>r.calls.length===1);saved=await receipt(payload);r.controller.destroy();ack.resolve(saved);
  assert.equal(await pending,false);assert.equal(r.sent.length,0);assert.equal(r.state.operation.status,'unknown');
  const restored=createChannelComposer({...r.options,isCurrent:()=>true});r.dom.window.document.querySelector('main').append(restored.element);await restored.ready;t.after(()=>restored.destroy());
  assert.equal(await restored.send(),false);assert.equal(await restored.recheck(),true);assert.equal(r.sent.length,1);assert.equal(r.state.body,'');
  assert.equal(r.calls.filter(call=>call.name==='hub_client_action').length,1);
});

test('HTTP-like rejection after invocation remains unknown; absent read proof never unlocks a new send',async t=>{
  const r=await rig(t,{invoke:async(name)=>{if(name==='hub_client_action')throw Error('channel_message_rejected:400');return{viewerProfileId:VIEWER,messages:[]};}});
  r.input('may already be stored');assert.equal(await r.controller.send(),false);const requestId=r.state.operation.requestId;
  assert.equal(r.state.operation.status,'unknown');assert.equal(await r.controller.recheck(),false);assert.equal(r.state.operation.requestId,requestId);
  assert.equal(await r.controller.send(),false);assert.equal(r.calls.filter(call=>call.name==='hub_client_action').length,1);
});

test('known pre-send preparation failure retains draft; confirmed actor conflict clears private state',async t=>{
  const r=await rig(t,{uploadFiles:async()=>{throw Error('synthetic prepare failure');}});r.input('keep me');r.controller.addFiles([r.file()]);
  assert.equal(await r.controller.send(),false);assert.equal(r.state.body,'keep me');assert.equal(r.state.operation.status,'rejected');assert.equal(r.calls.length,0);
  const conflict=await rig(t,{invoke:async()=>{throw Error('channel_message_scope_conflict');}});conflict.input('discard private');
  assert.equal(await conflict.controller.send(),false);assert.deepEqual(conflict.state,{});assert.equal(conflict.controller.textarea.value,'');
});

test('wrong scope or malformed state is cleared rather than restored into another entry',async t=>{
  const r=await rig(t);r.input('private A');r.controller.addFiles([r.file()]);r.controller.destroy();
  const wrong=createChannelComposer({...r.options,channelId:'channel-B',isCurrent:()=>true});r.dom.window.document.querySelector('main').append(wrong.element);await wrong.ready;t.after(()=>wrong.destroy());
  assert.equal(wrong.textarea.value,'');assert.equal(wrong.hasImages(),false);assert.equal(r.state.channelId,'channel-B');
  wrong.destroy();r.state.files=Array(1);
  const malformed=createChannelComposer({...r.options,channelId:'channel-B',isCurrent:()=>true});r.dom.window.document.querySelector('main').append(malformed.element);await malformed.ready;t.after(()=>malformed.destroy());
  assert.equal(malformed.hasImages(),false);assert.deepEqual(r.state.files,[]);
});

test('current channel scheduled replies are allowed; cross-channel and arbitrary colon or slash targets are refused',async t=>{
  const r=await rig(t),scheduled='scheduled:12345678-1234-4234-8234-123456789abc';
  for(const reply of [{id:'message-1',channelId:'other'},{id:'arbitrary:message',channelId:CHANNEL},{id:'../message',channelId:CHANNEL}]) assert.equal(r.controller.setReply(reply),false);
  assert.equal(r.controller.setReply({id:scheduled,channelId:CHANNEL,label:'scheduled reply'}),true);r.input('reply');
  assert.equal(await r.controller.send(),true);assert.equal(r.calls[0].args.options.replyToMessageId,scheduled);
});

test('body UTF16 and four-image limits reject oversize without a send and preserve NUL text literally',async t=>{
  const r=await rig(t);r.input('😀'.repeat(1001));assert.equal(await r.controller.send(),false);assert.equal(r.calls.length,0);
  r.input('literal\0text');assert.equal(await r.controller.send(),true);assert.equal(r.calls[0].args.text,'literal\0text');
  const files=Array.from({length:5},()=>r.file());assert.equal(r.controller.addFiles(files),false);assert.equal(r.controller.hasImages(),false);
  const oversized=new r.dom.window.File([new Uint8Array(5*1024*1024+1)],'too-large.png',{type:'image/png'});assert.equal(r.controller.addFiles([oversized]),false);
});

test('sparse upload or malformed ACK does not become a successful send; scope guards are attached to uploads and post',async t=>{
  const r=await rig(t,{uploadFiles:async(files,ctx)=>{await ctx.invoke('hub_upload_image',{image:[1]});return Array(1);}});r.input('body');r.controller.addFiles([r.file()]);
  assert.equal(await r.controller.send(),false);assert.equal(r.calls.length,1);assert.equal(r.calls[0].name,'hub_upload_image');
  assert.equal(r.calls[0].args.expectedViewerId,VIEWER);assert.equal(r.calls[0].args.expectedDeviceId,'device-A');
  const bad=await rig(t,{invoke:async()=>({message:{id:'unbound'}})});bad.input('body');assert.equal(await bad.controller.send(),false);
  assert.equal(bad.state.operation.status,'unknown');assert.equal(bad.sent.length,0);
});
