import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SessionManager} from './workspace/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';
import {createImageTransfer} from './image-transfer.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=number=>`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const png=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S9sAAAAASUVORK5CYII=','base64');
const ref=(number=1,bytes=png(),mimeType='image/png')=>({id:id(number),mimeType,sizeBytes:bytes.length,sha256:digest(bytes)});
function loaded(refs=[ref()],payloads=[png()],promptImageIds=[refs[0].id]){
  const transfer=createImageTransfer({imageRefs:refs,promptImageIds});
  refs.forEach((record,index)=>{const bytes=payloads[index];for(let offset=0,part=0;offset<bytes.length;offset+=192*1024,part++)transfer.accept({type:'image_chunk',imageId:record.id,index:part,data:bytes.subarray(offset,offset+192*1024).toString('base64')});transfer.accept({type:'image_end',imageId:record.id});});return transfer;
}
const seed=block=>[{type:'session',version:3,id:'synthetic',cwd:'C:/synthetic',timestamp:'2026-10-07T00:00:00.000Z'},
  {type:'message',id:'message',parentId:null,timestamp:'2026-10-07T00:00:00.000Z',message:{role:'user',content:[{type:'text',text:'inspect'},block],timestamp:1}}];
const typed=(record=ref())=>({type:'hub_image_ref',id:record.id,mimeType:record.mimeType,sha256:record.sha256});
test('text-only session retains old data/frame behavior and creates no images or metadata payload',()=>{
  const transfer=createImageTransfer();assert.equal(transfer.enabled,false);assert.equal(transfer.ready(),true);transfer.eof();assert.equal(transfer.partial('ordinary text'),'ordinary text');assert.equal(transfer.flushPartial(),'');const event={type:'ordinary',message:{role:'assistant',content:[]}};assert.equal(transfer.event(event),event);assert.equal(transfer.checkpoint([]).length,0);assert.deepEqual(transfer.promptImages([]),[]);
});
test('closed declarations and 4/10MiB/40MiB limits reject malformed IDs, widths, hashes and undeclared prompt IDs',()=>{
  for(const value of [{imageRefs:null},{imageRefs:Array(5).fill(ref())},{imageRefs:[ref(),ref()]},{imageRefs:[{...ref(),id:id(1)+'\n'}]},{imageRefs:[{...ref(),id:id(1).replace('-4000-','-3000-')}]},{imageRefs:[{...ref(),mimeType:'image/svg+xml'}]},
    {imageRefs:[{...ref(),sizeBytes:0}]},{imageRefs:[{...ref(),sizeBytes:10*1024*1024+1}]},{imageRefs:[{...ref(),sizeBytes:1.1}]},{imageRefs:[{...ref(),sha256:'A'.repeat(64)}]},{imageRefs:[{...ref(),data:'private'}]},{imageRefs:[ref()],promptImageIds:[id(2)]},{imageRefs:[ref()],promptImageIds:[id(1),id(1)]},{promptImageIds:[]}])assert.throws(()=>createImageTransfer(value),/transfer_invalid/);
});
test('complete bytes/hash/MIME are required before any SDK image/context is returned',()=>{
  const record=ref(),transfer=createImageTransfer({imageRefs:[record],promptImageIds:[record.id]});assert.equal(transfer.ready(),false);assert.throws(()=>transfer.promptImages([]),/transfer_invalid/);
  assert.equal(transfer.accept({type:'image_chunk',imageId:record.id,index:0,data:png().toString('base64')}),false);assert.equal(transfer.ready(),false);
  assert.equal(transfer.accept({type:'image_end',imageId:record.id}),true);const images=transfer.promptImages([]);assert.deepEqual(Object.keys(images[0]),['type','mimeType','data']);assert.equal(images[0].data,png().toString('base64'));assert.deepEqual(transfer.inputsEvent(),{type:'image_inputs',promptImageIds:[record.id],reattachedImageIds:[]});
});
test('192KiB full chunk plus short final and exact 10MiB image survive; max4 total40MiB fits',()=>{
  const bytes=Buffer.alloc(10*1024*1024);png().copy(bytes);const refs=Array.from({length:4},(_,i)=>ref(i+1,bytes)),transfer=loaded(refs,Array(4).fill(bytes),[refs[3].id]);
  assert.equal(transfer.ready(),true);const images=transfer.promptImages([]);assert.equal(images.length,4);assert.equal(Buffer.from(images[0].data,'base64').length,10*1024*1024);assert.deepEqual(transfer.inputsEvent(),{type:'image_inputs',promptImageIds:[refs[3].id],reattachedImageIds:refs.slice(0,3).map(row=>row.id)});transfer.eof();
});
test('unknown/order/oversize/noncanonical/extra/duplicate/missing/end digest or MIME fail closed',()=>{
  const record=ref();for(const frame of [{type:'image_chunk',imageId:id(2),index:0,data:'AA=='},{type:'image_chunk',imageId:record.id,index:1,data:'AA=='},{type:'image_chunk',imageId:record.id,index:-1,data:'AA=='},{type:'image_chunk',imageId:record.id,index:0,data:'AB=='},{type:'image_chunk',imageId:record.id,index:0,data:'AA==\n'},{type:'image_chunk',imageId:record.id,index:0,data:Buffer.alloc(192*1024+1).toString('base64')},{type:'image_chunk',imageId:record.id,index:0,data:'AA==',path:'secret'},{type:'image_end',imageId:record.id}]){
    const transfer=createImageTransfer({imageRefs:[record]});assert.throws(()=>transfer.accept(frame),/transfer_invalid/);
  }
  const complete=loaded();assert.throws(()=>complete.accept({type:'image_end',imageId:record.id}),/transfer_invalid/);
  const missing=createImageTransfer({imageRefs:[record]});assert.throws(()=>missing.eof(),/transfer_invalid/);
  const short=createImageTransfer({imageRefs:[record]});short.accept({type:'image_chunk',imageId:record.id,index:0,data:Buffer.from([1]).toString('base64')});assert.throws(()=>short.accept({type:'image_chunk',imageId:record.id,index:1,data:'AA=='}),/transfer_invalid/);
  for(const override of [{sha256:'f'.repeat(64)},{mimeType:'image/jpeg'}]){const transfer=createImageTransfer({imageRefs:[{...record,...override}]});transfer.accept({type:'image_chunk',imageId:record.id,index:0,data:png().toString('base64')});assert.throws(()=>transfer.accept({type:'image_end',imageId:record.id}),/transfer_invalid/);}
});
test('typed refs are rehydrated before SDK, preserve exact checksum and become bounded refs before checkpoint',()=>{
  const transfer=loaded(),original=seed(typed()),hydrated=transfer.rehydrate(original);assert.equal(original[1].message.content[1].type,'hub_image_ref');assert.equal(hydrated[1].message.content[1].type,'image');
  const exported=transfer.checkpoint(hydrated);assert.deepEqual(exported.slice(1),original.slice(1));assert.deepEqual(exported[0].hubImageRefs,[ref()]);assert.ok(Buffer.byteLength(JSON.stringify(exported))<1024*1024);assert.ok(!JSON.stringify(exported).includes(png().toString('base64')));
  assert.deepEqual(transfer.promptImages(original).map(row=>row.type),['image']);assert.deepEqual(transfer.inputsEvent().reattachedImageIds,[]);
});
test('unknown/mismatched/missing/extra/raw/non-user refs reject resume or export rather than omit content',()=>{
  const transfer=loaded();for(const block of [{...typed(),id:id(2)},{...typed(),sha256:'f'.repeat(64)},{...typed(),mimeType:'image/jpeg'},{...typed(),data:'private'},{type:'image',mimeType:'image/png',data:png().toString('base64')}])assert.throws(()=>transfer.rehydrate(seed(block)),/transfer_invalid/);
  assert.throws(()=>createImageTransfer().rehydrate(seed(typed())),/transfer_invalid/);assert.throws(()=>transfer.rehydrate([{type:'custom',payload:typed()}]),/transfer_invalid/);
  assert.throws(()=>transfer.checkpoint(seed({type:'image',mimeType:'image/png',data:Buffer.from('unknown').toString('base64')})),/transfer_invalid/);
  for(const refs of [[ref(),ref()],[{...ref(),sha256:'f'.repeat(64)}],[{...ref(),data:'private'}]])assert.throws(()=>transfer.rehydrate([{type:'session',hubImageRefs:refs}]),/transfer_invalid/);
});
test('compaction-removed old references are explicitly reattached while retained old refs stay in context',()=>{
  const first=ref(),jpeg=Buffer.from([255,216,255,217]),second=ref(2,jpeg,'image/jpeg'),transfer=loaded([first,second],[png(),jpeg],[second.id]);
  const afterCompaction=[{type:'session',version:3,id:'synthetic'},{type:'compaction',summary:'ordinary summary'}];
  assert.equal(transfer.promptImages(afterCompaction).length,2);assert.deepEqual(transfer.inputsEvent(),{type:'image_inputs',promptImageIds:[second.id],reattachedImageIds:[first.id]});
  assert.equal(transfer.promptImages(seed(typed(first))).length,1);assert.deepEqual(transfer.inputsEvent().reattachedImageIds,[]);
});
test('stream holdback crosses every 64-character echo boundary; ordinary text is reproduced exactly',()=>{
  const text='ordinary text / '.repeat(30),transfer=loaded();let output='';for(let offset=0;offset<text.length;offset+=7)output+=transfer.partial(text.slice(offset,offset+7));output+=transfer.flushPartial();assert.equal(output,text);
  const raw=png().toString('base64');for(let split=1;split<64;split++){const gate=loaded();gate.partial(raw.slice(0,split));assert.throws(()=>gate.partial(raw.slice(split,64)),/payload_disallowed/);assert.throws(()=>gate.flushPartial(),/payload_disallowed/);}
});
test('holdback never cuts a Unicode surrogate pair and empty compaction still exports header references for Native recovery',()=>{
  const transfer=loaded(),text='x'.repeat(10)+'😀'+'y'.repeat(62);const part=transfer.partial(text);assert.ok(!/[\uD800-\uDFFF]/u.test(part));assert.equal(part+transfer.flushPartial(),text);
  const exported=transfer.checkpoint([{type:'session',version:3,id:'synthetic'},{type:'compaction',summary:'no image block retained'}]);assert.deepEqual(exported[0].hubImageRefs,[ref()]);assert.equal(exported[0].type,'session');assert.equal(transfer.promptImages(exported).length,1);assert.deepEqual(transfer.inputsEvent().reattachedImageIds,[]);
  const oldOnly=loaded([ref()],[png()],[]);const restored=oldOnly.checkpoint([{type:'session',version:3,id:'synthetic'}]);assert.equal(oldOnly.promptImages(restored).length,1);assert.deepEqual(oldOnly.inputsEvent().reattachedImageIds,[ref().id]);
});
test('user events are metadata-only; final/event/tool/checkpoint payload echoes fail rather than silently replace content',()=>{
  const transfer=loaded(),raw=png().toString('base64');const safe=transfer.event({type:'message_end',message:{role:'user',content:[{type:'image',mimeType:'image/png',data:raw}],timestamp:1}});
  assert.deepEqual(safe,{type:'message_end',message:{role:'user',timestamp:1}});
  for(const value of [{type:'message_end',message:{role:'assistant',content:[{type:'text',text:raw}]}},{type:'tool_execution_start',args:{content:raw}}])assert.throws(()=>transfer.event(value),/payload_disallowed/);
  assert.throws(()=>transfer.check({content:raw}),/payload_disallowed/);assert.throws(()=>transfer.checkpoint(seed({type:'text',text:raw})),/payload_disallowed/);
});
test('declarations and source context ownership are cloned; altered checksums or image bodies cannot change the map',()=>{
  const record=ref(),transfer=createImageTransfer({imageRefs:[record],promptImageIds:[record.id]});record.sha256='f'.repeat(64);record.id=id(2);
  transfer.accept({type:'image_chunk',imageId:id(1),index:0,data:png().toString('base64')});transfer.accept({type:'image_end',imageId:id(1)});const images=transfer.promptImages([]);images[0].data='changed';assert.throws(()=>transfer.checkpoint(seed(images[0])),/transfer_invalid/);assert.equal(transfer.promptImages([])[0].data,png().toString('base64'));
});
test('actual pinned SDK in-memory user image survives ref export/restore with no plaintext session persistence',()=>{
  const transfer=loaded(),manager=SessionManager.inMemory('C:/synthetic');const image=transfer.promptImages([])[0];manager.appendMessage({role:'user',content:[{type:'text',text:'inspect'},image],timestamp:1});
  assert.equal(manager.isPersisted(),false);const exported=transfer.checkpoint([manager.getHeader(),...manager.getBranch()]);assert.equal(exported[0].type,'session');assert.deepEqual(exported[0].hubImageRefs,[ref()]);
  assert.equal(exported[1].message.content[1].type,'hub_image_ref');assert.ok(!JSON.stringify(exported).includes(image.data));
  const resumed=SessionManager.inMemory('C:/synthetic',undefined,transfer.rehydrate(exported));assert.equal(resumed.isPersisted(),false);
  assert.equal(resumed.buildSessionContext().messages[0].content[1].data,image.data);const again=transfer.checkpoint([resumed.getHeader(),...resumed.getBranch()]);assert.deepEqual(again[0].hubImageRefs,[ref()]);assert.equal(again[1].message.content[1].type,'hub_image_ref');
});
