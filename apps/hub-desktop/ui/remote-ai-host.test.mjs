import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {RemoteAiHostPeer,createRemoteAiIndicator,createRemoteAiCard} from './remote-ai-host.mjs';
import {RunAssembler,runFrames,chunkText,parseFrame,readSource,safeCode,LIMITS,FRAME_MAX,CHUNK_CHARS,LABEL} from './remote-ai-protocol.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setTimeout(r,0));};
const UUID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

globalThis.RTCPeerConnection=class{constructor(){this.listeners=[];}addEventListener(){}removeEventListener(){}close(){}};

function makePeer(handlers={}){
  const calls=[],sent=[];let emit=()=>{};
  const invoke=async(name,args)=>{calls.push([name,args]);if(handlers[name])return handlers[name](args);return null;};
  const listen=async(name,callback)=>{emit=callback;return()=>{emit=()=>{};};};
  const states=[];
  const peer=new RemoteAiHostPeer({iceServers:[]},s=>states.push(s),{invoke,listen,onActivity:()=>{}});
  peer.channel={readyState:'open',bufferedAmount:0,send:x=>sent.push(JSON.parse(x)),close(){},addEventListener(){},removeEventListener(){}};
  return {peer,calls,sent,states,emit:payload=>emit({payload}),frames:(list)=>list};
}
async function ready(t){t.peer.update({ready:true,code:'AAAA',verified:true,remoteVerified:true});await settle();}
const run=async(t,list)=>{for(const text of list)await t.peer.receive(text);await settle();};

test('the AI channel is its own label and the file protocol is unchanged',()=>{
  assert.equal(LABEL,'hub-ai-v1');
  const t=makePeer();assert.equal(t.peer.label,'hub-ai-v1');
  assert.equal(readFileSync(new URL('./p2p-transfer.mjs',import.meta.url),'utf8').includes("options.label||'hub-file-v1'"),true);
});

test('nothing is accepted before the session is verified on both sides',async()=>{
  const t=makePeer();
  await assert.rejects(()=>t.peer.receive(JSON.stringify({type:'ai.list'})));
  await assert.rejects(()=>t.peer.receive(new ArrayBuffer(4)));
});

test('a verified session tells Rust the session is live and ending it stops phone runs',async()=>{
  const t=makePeer();await ready(t);
  assert.deepEqual(t.calls.find(c=>c[0]==='byok_remote_session')[1],{active:true});
  t.peer.close('x');await settle();
  assert.deepEqual(t.calls.filter(c=>c[0]==='byok_remote_session').at(-1)[1],{active:false});
});

test('listing returns only what Rust allows, one source per frame, and sends nothing else',async()=>{
  const sources=[{source:'api',id:UUID,name:'OpenAI',models:['gpt-5'],defaultModel:'gpt-5'},{source:'cli',id:'claude',name:'Claude Code',models:['sonnet'],defaultModel:null}];
  const t=makePeer({byok_remote_sources:()=>({sources})});await ready(t);
  await run(t,[JSON.stringify({type:'ai.list'})]);
  assert.deepEqual(t.sent.map(m=>m.type),['ai.sources','ai.source','ai.source']);
  assert.equal(t.sent[0].total,2);
  assert.doesNotMatch(JSON.stringify(t.sent),/key|path|env|baseUrl|http/i);
});

test('a refused listing becomes a fixed error code',async()=>{
  const t=makePeer({byok_remote_sources:()=>{throw 'byok_remote_off';}});await ready(t);
  await run(t,[JSON.stringify({type:'ai.list'})]);
  assert.deepEqual(t.sent,[{type:'ai.error',id:null,code:'byok_remote_off'}]);
});

test('a run is assembled from small frames, handed to Rust once, and streamed back in chunks',async()=>{
  const t=makePeer({byok_remote_run:()=>'req-1'});await ready(t);
  const text='あ'.repeat(CHUNK_CHARS*2+5);
  await run(t,runFrames(UUID,{source:'api',sourceId:UUID,model:'gpt-5'},[{role:'user',content:'こんにちは'},{role:'assistant',content:'はい'},{role:'user',content:text}]));
  const call=t.calls.find(c=>c[0]==='byok_remote_run');
  assert.equal(call[1].input.messages.length,3);assert.equal(call[1].input.messages[2].content,text);
  assert.deepEqual([call[1].input.source,call[1].input.id,call[1].input.model],['api',UUID,'gpt-5']);
  t.emit({requestId:'other',type:'delta',text:'無関係'});
  t.emit({requestId:'req-1',type:'delta',text:'い'.repeat(CHUNK_CHARS+10)});
  t.emit({requestId:'req-1',type:'done'});await settle();
  const out=t.sent.filter(m=>m.type==='ai.out');
  assert.equal(out.length,2);assert.deepEqual(out.map(m=>m.seq),[0,1]);assert.ok(out.every(m=>m.text.length<=CHUNK_CHARS));
  assert.equal(t.sent.at(-1).type,'ai.end');assert.ok(!JSON.stringify(t.sent).includes('無関係'));
});

test('events that arrive before the request id is known are not lost',async()=>{
  let release;const gate=new Promise(r=>{release=r;});
  const t=makePeer({byok_remote_run:async()=>{await gate;return 'req-2';}});await ready(t);
  const p=run(t,runFrames(UUID,{source:'cli',sourceId:'claude'},[{role:'user',content:'hi'}]));
  await settle();t.emit({requestId:'req-2',type:'delta',text:'早い'});release();await p;await settle();
  assert.equal(t.sent.find(m=>m.type==='ai.out').text,'早い');
});

test('a second run while one is active is refused with the busy code',async()=>{
  const t=makePeer({byok_remote_run:()=>'req-3'});await ready(t);
  await run(t,runFrames(UUID,{source:'cli',sourceId:'claude'},[{role:'user',content:'a'}]));
  await run(t,[JSON.stringify({type:'ai.run',id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',source:'cli',sourceId:'claude',model:null,messages:1})]);
  assert.deepEqual(t.sent.at(-1),{type:'ai.error',id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',code:'byok_busy'});
});

test('Rust refusals reach the phone only as byok_* codes; anything else is a generic code',async()=>{
  const t=makePeer({byok_remote_run:()=>{throw 'byok_remote_not_allowed';}});await ready(t);
  await run(t,runFrames(UUID,{source:'api',sourceId:UUID},[{role:'user',content:'hi'}]));
  assert.equal(t.sent.at(-1).code,'byok_remote_not_allowed');
  assert.equal(safeCode('C:\\Users\\me\\secret'),'byok_failed');assert.equal(safeCode('sk-ant-123'),'byok_failed');assert.equal(safeCode('byok_timeout'),'byok_timeout');
});

test('cancel from the phone reaches Rust; cancel before go just drops the request',async()=>{
  const t=makePeer({byok_remote_run:()=>'req-4'});await ready(t);
  await run(t,runFrames(UUID,{source:'cli',sourceId:'claude'},[{role:'user',content:'hi'}]));
  await run(t,[JSON.stringify({type:'ai.cancel',id:UUID})]);
  assert.deepEqual(t.calls.find(c=>c[0]==='byok_remote_cancel')[1],{requestId:'req-4'});
  const u=makePeer();await ready(u);
  await run(u,[JSON.stringify({type:'ai.run',id:UUID,source:'cli',sourceId:'claude',model:null,messages:1}),JSON.stringify({type:'ai.cancel',id:UUID})]);
  assert.deepEqual(u.sent.at(-1),{type:'ai.end',id:UUID,cancelled:true});assert.equal(u.calls.filter(c=>c[0]==='byok_remote_run').length,0);
});

test('malformed, oversized and unknown frames end the connection instead of being guessed at',async()=>{
  const t=makePeer();await ready(t);
  await assert.rejects(()=>t.peer.receive('x'.repeat(FRAME_MAX+1)));
  await assert.rejects(()=>t.peer.receive(JSON.stringify({type:'offer',id:UUID})));
  await assert.rejects(()=>t.peer.receive(JSON.stringify({type:'ai.shell',cmd:'dir'})));
  await assert.rejects(()=>t.peer.receive('not json'));
});

test('the protocol enforces the prompt limits while assembling',()=>{
  const header={type:'ai.run',id:UUID,source:'api',sourceId:UUID,model:null,messages:1};
  assert.throws(()=>new RunAssembler({...header,messages:LIMITS.messages+1}));
  assert.throws(()=>new RunAssembler({...header,source:'shell'}));
  assert.throws(()=>new RunAssembler({...header,sourceId:'../x'}));
  const a=new RunAssembler(header);
  assert.throws(()=>a.push({id:UUID,m:0,role:'system',text:'x',end:true}));
  const b=new RunAssembler(header);
  for(let i=0;i<5;i++)b.push({id:UUID,m:0,role:'user',text:'x'.repeat(CHUNK_CHARS),end:false});
  assert.throws(()=>b.push({id:UUID,m:0,role:'user',text:'y'.repeat(501),end:false}),/too large/);
  assert.throws(()=>runFrames(UUID,{source:'api',sourceId:UUID},[{role:'user',content:'x'.repeat(LIMITS.messageChars+1)}]));
  assert.throws(()=>new RunAssembler(header).finish());
  const c=new RunAssembler({...header,messages:2});c.push({id:UUID,m:0,role:'user',text:'a',end:true});
  assert.throws(()=>c.finish());
  assert.throws(()=>c.push({id:UUID,m:5,role:'user',text:'a',end:true}));
});

test('chunks never split a character and every frame fits the frame limit',()=>{
  const text='😀'.repeat(CHUNK_CHARS+1);
  const parts=chunkText(text);assert.equal(parts.length,2);assert.equal(parts.join(''),text);
  for(const f of runFrames(UUID,{source:'api',sourceId:UUID},[{role:'user',content:'\u0001'.repeat(LIMITS.messageChars)}]))assert.ok(f.length<=FRAME_MAX);
  assert.throws(()=>parseFrame('{"type":"x"}'));assert.throws(()=>parseFrame('[]'));
  assert.throws(()=>readSource({source:'api',id:'../x',name:'n',models:[]}));
  assert.throws(()=>readSource({source:'api',id:UUID,name:'n',models:Array(LIMITS.models+1).fill('m')}));
  assert.deepEqual(readSource({source:'cli',id:'claude',name:'C',models:['a']}),{source:'cli',id:'claude',name:'C',models:['a'],defaultModel:null});
});

test('the indicator shows the running connection and a stop button for the owner',async()=>{
  const dom=new JSDOM('<body></body>'),document=dom.window.document;let stopped=0;
  const ind=createRemoteAiIndicator({document,onStop:async()=>{stopped++;}});document.body.append(ind.element);
  assert.equal(ind.element.hidden,true);
  ind.update({session:true,runs:[]});assert.equal(ind.element.hidden,false);assert.match(ind.element.textContent,/つながっています/);assert.equal(ind.element.querySelector('button').hidden,true);
  ind.update({session:true,runs:[{name:'Claude Code'}]});assert.match(ind.element.textContent,/Claude Code/);
  ind.element.querySelector('button').click();await settle();assert.equal(stopped,1);
  ind.update({session:false,runs:[]});assert.equal(ind.element.hidden,true);
});

test('the card opens no connection until the owner acts, and its link targets the AI page',async()=>{
  const dom=new JSDOM('<body></body>'),document=dom.window.document,calls=[];
  const card=createRemoteAiCard({document,invoke:async(n)=>{calls.push(n);return n==='hub_origin'?'https://hub.jkamma.com':null;},listen:async()=>()=>{}});
  document.body.append(card.element);await card.panel.ready;
  assert.deepEqual(calls,['hub_origin']);
  assert.match(card.element.textContent,/スマホから使う/);assert.match(card.element.textContent,/スマホとつなぐ/);
  assert.doesNotMatch(card.element.textContent,/ファイルを送信/);
  card.dispose();
});
