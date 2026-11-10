import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaSwarmProtocol,mediaFingerprint,MEDIA_LABEL,FRAME,MAX_OUTSTANDING} from './media-swarm-transfer.mjs';

const PRINT=Array.from({length:32},(_,i)=>i.toString(16).padStart(2,'0')).join(':').toUpperCase();
const sdp=(extra='')=>`v=0\r\na=fingerprint:sha-256 ${PRINT}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n${extra}`;
const swarm='a'.repeat(64),digest='b'.repeat(64);

function pair(options={}){
  let a,b;
  const chan=name=>({sent:[],closed:false,send(d){this.sent.push(d);queueMicrotask(()=>(name==='a'?b:a).onMessage(d));},close(){this.closed=true;}});
  const ca=chan('a'),cb=chan('b');
  a=new MediaSwarmProtocol({channel:ca,swarm,revision:3,digest,...(options.a??{})});
  b=new MediaSwarmProtocol({channel:cb,swarm,revision:3,digest,...(options.b??{})});
  return {a,b,ca,cb};
}
const flush=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};

test('media channel uses its own label and the SDP rules of the file channel',()=>{
  assert.equal(MEDIA_LABEL,'hub-media-v1');
  assert.equal(mediaFingerprint(sdp()),PRINT);
  assert.throws(()=>mediaFingerprint(sdp('m=audio 9 RTP/AVP 0\r\n')));
  assert.throws(()=>mediaFingerprint(sdp('m=video 9 RTP/AVP 96\r\n')));
  assert.throws(()=>mediaFingerprint(sdp(`a=fingerprint:sha-256 ${PRINT.replace(/00/,'11')}\r\n`)),'two fingerprints');
  assert.throws(()=>mediaFingerprint('v=0\r\nm=application 9 x\r\n'),'no fingerprint');
  assert.throws(()=>mediaFingerprint(sdp('x'.repeat(48000))),'oversized SDP');
});

test('a piece request is answered in 16 KiB frames and arrives whole',async()=>{
  const data=new Uint8Array(40000).map((_,i)=>i&255);
  const {a,cb}=pair({b:{serve:i=>i===1?data:{reject:'missing'}}});
  const got=await a.request(1);
  assert.deepEqual([...got],[...data]);
  const binary=cb.sent.filter(x=>typeof x!=='string');
  assert.deepEqual(binary.map(x=>x.byteLength),[FRAME,FRAME,40000-2*FRAME]);
  await assert.rejects(a.request(2),/missing/);
});

test('rejects carry a reason; a third outstanding request is refused locally',async()=>{
  const {a}=pair({b:{serve:()=>({reject:'revoked'})}});
  await assert.rejects(a.request(0),/revoked/);
  const slow=pair({b:{serve:()=>new Promise(()=>{})}});
  slow.a.request(0).catch(()=>{});slow.a.request(1).catch(()=>{});
  await assert.rejects(slow.a.request(2),/busy/);
  assert.equal(MAX_OUTSTANDING,2);
  slow.a.close();slow.b.close();
});

test('hello mismatch, oversized control, frame length mismatch and unknown types close the connection',()=>{
  const bad=new MediaSwarmProtocol({channel:{send(){},close(){}},swarm,revision:3,digest});
  bad.onMessage(JSON.stringify({type:'hello',v:1,swarm:'c'.repeat(64),revision:3,manifestSha256:digest}));
  assert.equal(bad.closed,true);
  const ok=()=>{const p=new MediaSwarmProtocol({channel:{send(){},close(){}},swarm,revision:3,digest});p.onMessage(JSON.stringify({type:'hello',v:1,swarm,revision:3,manifestSha256:digest}));return p;};
  let p=ok();p.onMessage(JSON.stringify({type:'nope'}));assert.equal(p.closed,true);
  p=ok();p.onMessage('x'.repeat(5000));assert.equal(p.closed,true);
  p=ok();p.request(0).catch(()=>{});
  p.onMessage(JSON.stringify({type:'piece',req:0,index:0,size:20000}));
  p.onMessage(new Uint8Array(100));assert.equal(p.closed,true,'frame shorter than declared');
  p=ok();p.request(0).catch(()=>{});p.onMessage(JSON.stringify({type:'piece',req:0,index:0,size:524289}));assert.equal(p.closed,true,'piece larger than 512 KiB');
  p=ok();p.onMessage(new Uint8Array(10));assert.equal(p.closed,true,'frame without a piece header');
});

test('requests are rate limited per connection and a silent peer times out',async()=>{
  let t=0;
  const {a,b}=pair({b:{serve:()=>new Uint8Array(1),now:()=>t}});
  for(let i=0;i<256;i++){await a.request(i);}
  await assert.rejects(a.request(300),/rate/);
  t=10*60*1000+1;
  assert.equal((await a.request(301)).byteLength,1);
  a.close();b.close();
  const quiet=pair({a:{timeout:5},b:{serve:()=>new Promise(()=>{})}});
  await assert.rejects(quiet.a.request(0),/timeout/);
  await flush();
  quiet.a.close();quiet.b.close();
});

test('bye closes both sides and pending requests fail',async()=>{
  const {a,b,ca}=pair({b:{serve:()=>new Promise(()=>{})}});
  const pending=a.request(0);
  await flush();
  b.bye();
  await assert.rejects(pending,/bye/);
  assert.equal(a.closed,true);assert.equal(ca.closed,true);
});
