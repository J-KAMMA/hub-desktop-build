import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createDmController} from './dm-controller.mjs';
const origin='https://hub.example',scope={key:JSON.stringify([origin,'device-a']),generation:1};
const request='11111111-1111-4111-8111-111111111111',image='22222222-2222-4222-8222-222222222222';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const messageId=(viewer,conversation,req=request)=>'dm-'+createHash('sha256').update(JSON.stringify(['hub-dm-send-v1',viewer,conversation,req])).digest('hex');
const conversation=(id='conversation-a',viewer='viewer-a',isE2ee=false)=>({id,participantIds:[viewer,'peer'],isE2ee,verificationStatus:'unverified',fingerprint:'',unreadCountByProfileId:{[viewer]:1,peer:0},lastMessageAt:'2026-10-07T00:00:00Z'});
const message=(body='hello',conv='conversation-a',viewer='viewer-a',images=[])=>({id:messageId(viewer,conv),conversationId:conv,senderProfileId:viewer,encryptedPayload:'',previewText:body,encryptionVersion:'plaintext-v1',encryptionState:'sealed',createdAt:'2026-10-07T00:01:00Z',images:images.map(id=>({id,url:'/api/media/dm-images/'+id,fullUrl:'/api/media/dm-images/'+id+'?variant=full',width:1,height:1,altText:''}))});
const packet=(viewer='viewer-a',convs=[conversation('conversation-a',viewer)],messages=[])=>({currentProfileId:viewer,conversations:convs,messages,profiles:[{id:viewer,displayName:'<script>本人</script>',handle:'self'},{id:'peer',displayName:'相手',handle:'peer'}],messageCount:1});
function fixture(overrides={}){
  const f={scope:{...scope},active:true,draft:{text:'hello',images:[],revision:1},packet:packet(),calls:[],data:[],states:[],sent:[],cleared:[],selections:[]};
  f.invoke=async(command,args)=>{f.calls.push({command,args:structuredClone(args)});if(f.handler)return f.handler(command,args);if(command==='hub_detail')return structuredClone(f.packet);if(args.action==='read_conversation')return{viewerId:f.packet.currentProfileId,conversationId:args.target,unreadCount:0};return{viewerId:f.packet.currentProfileId,message:message(args.text,args.target,f.packet.currentProfileId,args.options.imageIds)};};
  f.controller=createDmController({invoke:f.invoke,getScope:async()=>f.scope,isCurrent:()=>f.active,getDraft:()=>f.draft,onData:(data,meta)=>f.data.push({data,meta}),onState:s=>f.states.push(s),onSent:(...args)=>f.sent.push(args),onClearDraft:d=>f.cleared.push(d),onSelection:id=>f.selections.push(id),requestId:()=>request,...overrides});
  return f;
}
const sends=f=>f.calls.filter(x=>x.args.action==='send_message');
const reads=f=>f.calls.filter(x=>x.args.action==='read_conversation');

test('initial list chooses first only with a second pinned snapshot and adopted opaque ticket',async()=>{
  const f=fixture();assert.equal(await f.controller.load(),true);assert.deepEqual(f.calls.map(x=>x.args.ids),[['device-a',origin,''],['device-a',origin,'conversation-a','viewer-a']]);assert.deepEqual(f.selections,['conversation-a']);const last=f.data.at(-1);assert.equal(last.meta.conversationId,'conversation-a');assert.equal(f.controller.isTicketCurrent(last.meta.ticket),true);assert.equal(f.controller.isTicketCurrent({}),false);
});
test('selection requires existing row/current ticket, marks only selected pinned conversation',async()=>{
  const f=fixture();f.packet.conversations.push(conversation('conversation-b'));await f.controller.load('conversation-a');const ticket=f.controller.capture();assert.equal(await f.controller.select('unknown',ticket),false);assert.equal(await f.controller.select('conversation-b',ticket),true);assert.equal(f.controller.isTicketCurrent(ticket),false);assert.equal(await f.controller.select('conversation-a',ticket),false);assert.equal(reads(f).length,1);assert.deepEqual(reads(f)[0].args,{action:'read_conversation',target:'conversation-b',options:{expectedDeviceId:'device-a',expectedOrigin:origin,expectedViewerId:'viewer-a'}});
});
test('missing requested conversation does not fallback to another',async()=>{
  const f=fixture();assert.equal(await f.controller.load('conversation-b'),false);assert.equal(f.data.length,0);assert.equal(reads(f).length,0);
});
test('read failure rechecks readonly and never fabricates unread zero',async()=>{
  const f=fixture();await f.controller.load('conversation-a');f.handler=async(c,a)=>{if(c==='hub_detail')return f.packet;throw Error('dm_unknown');};assert.equal(await f.controller.select('conversation-a'),false);assert.equal(reads(f).length,1);assert.equal(f.data.at(-1).data.messageCount,1);assert.equal(f.states.at(-1).readFailed,true);assert.equal(f.states.at(-1).pending,false);
});
test('request reordering accepts only latest and old tickets perform no read/nav',async()=>{
  const f=fixture();await f.controller.load('conversation-a');const ticket=f.controller.capture(),a=deferred(),b=deferred();let i=0;f.handler=()=>++i===1?a.promise:b.promise;const old=f.controller.load('conversation-a');await settle();const next=f.controller.load('conversation-a');await settle();b.resolve({...packet(),messageCount:2});assert.equal(await next,true);a.resolve({...packet(),messageCount:99});assert.equal(await old,false);assert.equal(f.data.at(-1).data.messageCount,2);assert.equal(await f.controller.select('conversation-a',ticket),false);
});
test('A response after account B is discarded and first B read has no A viewer pin',async()=>{
  const f=fixture();await f.controller.load('conversation-a');const a=deferred();f.handler=()=>a.promise;const old=f.controller.load('conversation-a');await settle();f.scope={key:JSON.stringify([origin,'device-b']),generation:2};f.controller.invalidate('account');f.packet=packet('viewer-b',[conversation('conversation-b','viewer-b')]);f.handler=undefined;assert.equal(await f.controller.load('conversation-b'),true);a.resolve(packet());assert.equal(await old,false);assert.equal(f.data.at(-1).data.currentProfileId,'viewer-b');assert.deepEqual(f.calls.at(-1).args.ids,['device-b',origin,'conversation-b']);
});
test('unconnected, forged viewer, dispose and exit clear observations',async()=>{
  const f=fixture();await f.controller.load('conversation-a');f.packet=packet('viewer-b',[conversation('conversation-a','viewer-b')]);assert.equal(await f.controller.load('conversation-a'),false);assert.equal(f.data.at(-1).data,null);f.scope=null;assert.equal(await f.controller.load(),false);f.controller.destroy();assert.equal(await f.controller.load(),false);assert.equal(await f.controller.send(),false);
});
test('server idempotency identity uses same JSON digest as independent Node SHA; success clears only captured draft',async()=>{
  const source=readFileSync(new URL('../../hub/lib/server/d1-direct-messages.ts',import.meta.url),'utf8');assert.ok(source.includes('JSON.stringify(["hub-dm-send-v1", senderId, conversationId, clientRequestId.toLowerCase()])'));
  const f=fixture();await f.controller.load('conversation-a');assert.equal(await f.controller.send(),true);assert.equal(sends(f).length,1);assert.equal(f.sent[0][0].id,messageId('viewer-a','conversation-a'));assert.equal(f.cleared.length,1);assert.deepEqual(sends(f)[0].args,{action:'send_message',target:'conversation-a',text:'hello',requestId:request,options:{expectedDeviceId:'device-a',expectedOrigin:origin,expectedViewerId:'viewer-a'}});
});
test('double click and newer text during send do not duplicate or clear new draft',async()=>{
  const f=fixture();await f.controller.load('conversation-a');const ack=deferred();f.handler=(c,a)=>c==='hub_detail'?f.packet:ack.promise;const job=f.controller.send();await settle();assert.equal(await f.controller.send(),false);f.draft={text:'new draft',images:[],revision:2};ack.resolve({viewerId:'viewer-a',message:message()});assert.equal(await job,true);assert.equal(sends(f).length,1);assert.equal(f.cleared.length,0);
});
test('unknown retains immutable UUID/body, requires readonly recheck, retries only explicit same payload',async()=>{
  const f=fixture();await f.controller.load('conversation-a');let fail=true;f.handler=async(c,a)=>{if(c==='hub_detail')return f.packet;if(fail)throw Error('dm_unknown');return{viewerId:'viewer-a',message:message()};};assert.equal(await f.controller.send(),false);f.draft={text:'new draft',images:[],revision:2};assert.equal(await f.controller.send(),false);assert.equal(await f.controller.retrySame(),false);assert.equal(await f.controller.recheck(),false);assert.equal(sends(f).length,1);fail=false;assert.equal(await f.controller.retrySame(),true);assert.deepEqual(sends(f)[0].args,sends(f)[1].args);assert.equal(f.cleared.length,0);
});
test('lost ACK fresh exact own message confirms without retransmission',async()=>{
  const f=fixture();await f.controller.load('conversation-a');f.handler=async(c)=>{if(c==='hub_detail')return f.packet;throw Error('dm_unknown');};await f.controller.send();f.packet.messages=[message()];assert.equal(await f.controller.recheck(),true);assert.equal(f.sent[0][2].fromLookup,true);assert.equal(sends(f).length,1);assert.equal(f.cleared.length,1);
});
test('matching ID with wrong body/image or ACK actor does not confirm',async()=>{
  for(const variant of ['actor','body','image']){const f=fixture();await f.controller.load('conversation-a');f.handler=async(c)=>c==='hub_detail'?f.packet:{viewerId:variant==='actor'?'viewer-b':'viewer-a',message:message(variant==='body'?'changed':'hello','conversation-a','viewer-a',variant==='image'?[image]:[])};assert.equal(await f.controller.send(),false);assert.equal(f.sent.length,0);assert.equal(f.cleared.length,0);if(variant==='actor')assert.equal(f.data.at(-1).data,null);else assert.equal(f.states.at(-1).uncertain,true);}
});
test('fresh participation/E2EE recheck prevents any plaintext or image upload',async()=>{
  let uploads=0;const f=fixture({uploadFiles:async()=>{uploads++;return[image];}});await f.controller.load('conversation-a');f.draft={text:'hello',images:[{}],revision:1};f.packet.conversations[0].isE2ee=true;assert.equal(await f.controller.send(),false);assert.equal(uploads,0);assert.equal(sends(f).length,0);assert.equal(f.states.at(-1).pending,false);
});
test('image upload is restricted and account switch between byte preparation and invoke sends neither image nor text',async()=>{
  const gate=deferred();let ctx;const f=fixture({uploadFiles:async(items,context)=>{ctx=context;await gate.promise;await context.invoke('hub_upload_dm_image',{image:[1],thumbnail:[1]});return[image];}});await f.controller.load('conversation-a');f.draft={text:'hello',images:[{}],revision:1};const job=f.controller.send();await settle();f.scope={key:JSON.stringify([origin,'device-b']),generation:2};gate.resolve();assert.equal(await job,false);assert.equal(f.calls.filter(x=>x.command==='hub_upload_dm_image').length,0);assert.equal(sends(f).length,0);assert.equal(ctx.isCurrent(),false);
});
test('scoped upload carries actor preconditions, exact uploaded IDs reused and changed refs do not clear',async()=>{
  const f=fixture({uploadFiles:async(items,ctx)=>{ctx.assertCurrent();const r=await ctx.invoke('hub_upload_dm_image',{image:[1],thumbnail:[1]});f.draft={text:'hello',images:[{}],revision:2};return[r.image.id];}});
  await f.controller.load('conversation-a');f.draft={text:'hello',images:[{}],revision:1};f.handler=(c,a)=>c==='hub_detail'?f.packet:c==='hub_upload_dm_image'?{image:{id:image}}:{viewerId:'viewer-a',message:message(a.text,a.target,'viewer-a',a.options.imageIds)};assert.equal(await f.controller.send(),true);const upload=f.calls.find(x=>x.command==='hub_upload_dm_image');assert.equal(upload.args.expectedViewerId,'viewer-a');assert.deepEqual(sends(f)[0].args.options.imageIds,[image]);assert.equal(f.cleared.length,0);
});
test('unsupported upload command is rejected before native invoke',async()=>{
  const f=fixture({uploadFiles:async(items,ctx)=>{await ctx.invoke('arbitrary',{secret:'synthetic'});return[image];}});await f.controller.load('conversation-a');f.draft={text:'',images:[{}],revision:1};assert.equal(await f.controller.send(),false);assert.equal(f.calls.some(x=>x.command==='arbitrary'),false);assert.equal(sends(f).length,0);
});
test('formal request identity is allocated once before image upload and reused for send',async()=>{
  let generated=0;const f=fixture({requestId:()=>{generated++;return request;},uploadFiles:async()=>{assert.equal(generated,1);return[image];}});await f.controller.load('conversation-a');f.draft={text:'hello',images:[{}],revision:1};assert.equal(await f.controller.send(),true);assert.equal(generated,1);assert.equal(sends(f)[0].args.requestId,request);assert.equal(f.sent[0][0].id,messageId('viewer-a','conversation-a'));
});
test('view invalidate preserves only same-scope unknown attempt; reentry never creates new ID',async()=>{
  const f=fixture();await f.controller.load('conversation-a');f.handler=async(c)=>{if(c==='hub_detail')return f.packet;throw Error('dm_unknown');};await f.controller.send();f.controller.invalidate('view');await f.controller.load('conversation-a');assert.equal(await f.controller.send(),false);await f.controller.recheck();await f.controller.retrySame();assert.equal(sends(f).length,2);assert.equal(sends(f)[1].args.requestId,request);
});
test('view exit while send is pending retains unknown operation for explicit reconciliation',async()=>{
  const f=fixture();await f.controller.load('conversation-a');const gate=deferred();f.handler=(c)=>c==='hub_detail'?f.packet:gate.promise;const old=f.controller.send();await settle();f.controller.invalidate('view');gate.resolve({viewerId:'viewer-a',message:message()});assert.equal(await old,false);f.handler=undefined;await f.controller.load('conversation-a');assert.equal(f.states.at(-1).uncertain,true);assert.equal(await f.controller.send(),false);f.packet.messages=[message()];assert.equal(await f.controller.recheck(),true);assert.equal(f.sent.length,1);assert.equal(sends(f).length,1);
});
test('known rejected send preserves editable draft; definitive 409 remains locked',async()=>{
  for(const status of [400,409]){const f=fixture();await f.controller.load('conversation-a');f.handler=async(c)=>{if(c==='hub_detail')return f.packet;throw Error('dm_rejected:'+status);};await f.controller.send();assert.equal(f.cleared.length,0);const before=sends(f).length;await f.controller.send();assert.equal(sends(f).length,before+(status===400?1:0));}
});
test('same actor GET permission/member loss clears private body and old callbacks',async()=>{
  for(const status of [403,404]){const f=fixture();f.packet.messages=[message()];await f.controller.load('conversation-a');const ticket=f.controller.capture();f.handler=async()=>{throw Error('dm_rejected:'+status);};assert.equal(await f.controller.load('conversation-a'),false);assert.equal(f.data.at(-1).data,null);assert.equal(f.data.at(-1).meta.reason,'scope');assert.equal(f.controller.isTicketCurrent(ticket),false);const calls=f.calls.length;assert.equal(await f.controller.select('conversation-a',ticket),false);assert.equal(await f.controller.send(),false);assert.equal(f.calls.length,calls);}
});
test('send 403/404/413/429 outcomes keep UUID until readonly recheck and explicit same retry',async()=>{
  for(const status of [403,404,413,429]){const f=fixture();await f.controller.load('conversation-a');f.handler=async(c)=>{if(c==='hub_detail')return f.packet;throw Error('dm_rejected:'+status);};assert.equal(await f.controller.send(),false);assert.equal(f.states.at(-1).uncertain,true);assert.equal(await f.controller.send(),false);assert.equal(await f.controller.retrySame(),false);assert.equal(sends(f).length,1);await f.controller.recheck();assert.equal(await f.controller.retrySame(),false);assert.equal(sends(f).length,2);assert.deepEqual(sends(f)[0].args,sends(f)[1].args);assert.equal(f.cleared.length,0);}
});
test('Native packet validation 400 is definite before wire and leaves draft editable',async()=>{
  const f=fixture();await f.controller.load('conversation-a');f.handler=async(c)=>{if(c==='hub_detail')return f.packet;throw Error('dm_rejected:400');};assert.equal(await f.controller.send(),false);assert.equal(f.states.at(-1).uncertain,false);assert.equal(f.states.at(-1).phase,'rejected');assert.equal(f.cleared.length,0);assert.equal(await f.controller.send(),false);assert.equal(sends(f).length,2);
});
test('unknown retry does not send plaintext after fresh snapshot marks conversation E2EE',async()=>{
  const f=fixture();await f.controller.load('conversation-a');f.handler=async(c)=>{if(c==='hub_detail')return f.packet;throw Error('dm_unknown');};await f.controller.send();f.packet.conversations[0].isE2ee=true;await f.controller.recheck();assert.equal(await f.controller.retrySame(),false);assert.equal(sends(f).length,1);
});
test('existing inclusive GET bounds preserve 100 conversations / 299 messages / 200 profiles',async()=>{
  const f=fixture();f.packet.conversations=Array.from({length:100},(_,i)=>conversation(i?'c'+i:'conversation-a'));f.packet.messages=Array.from({length:299},(_,i)=>({...message(),id:'m'+i}));f.packet.profiles=Array.from({length:200},(_,i)=>({id:i?'p'+i:'viewer-a',displayName:'氏名',handle:'handle'}));assert.equal(await f.controller.load('conversation-a'),true);assert.equal(f.data.at(-1).data.messages.length,299);
});
test('bounds enforce UTF16, Unicode/NUL, exact top fields, limits and terminal ID controls',async()=>{
  for(const body of ['a'.repeat(281),'😀'.repeat(141),'bad\0text','bad\uD800']){const f=fixture();await f.controller.load('conversation-a');f.draft={text:body,images:[],revision:1};assert.equal(await f.controller.send(),false);assert.equal(sends(f).length,0);}
  for(const mutate of [p=>p.extra=true,p=>p.currentProfileId+='\n',p=>p.conversations=Array.from({length:101},(_,i)=>conversation('c'+i)),p=>p.messages=Array.from({length:300},(_,i)=>({...message(),id:'m'+i})),p=>p.profiles=Array.from({length:201},(_,i)=>({id:'p'+i,displayName:'a',handle:'b'}))]){const f=fixture();mutate(f.packet);assert.equal(await f.controller.load('conversation-a'),false);}
  const f=fixture();await f.controller.load('conversation-a');f.draft={text:'😀'.repeat(140),images:[],revision:1};assert.equal(await f.controller.send(),true);
});
test('late send after selection/account/dispose never calls sent/clear',async()=>{
  for(const mode of ['account','view','destroy']){const f=fixture();await f.controller.load('conversation-a');const gate=deferred();f.handler=(c)=>c==='hub_detail'?f.packet:gate.promise;const job=f.controller.send();await settle();if(mode==='destroy')f.controller.destroy();else f.controller.invalidate(mode);gate.resolve({viewerId:'viewer-a',message:message()});assert.equal(await job,false);assert.equal(f.sent.length,0);assert.equal(f.cleared.length,0);}
});
