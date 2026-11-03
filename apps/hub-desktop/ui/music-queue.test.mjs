import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as musicQueue from './music-queue.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const track=n=>({id:id(n),title:`Track ${n}`});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('UUID aliases deduplicate in first order, snapshots detach, and source width is checked first',()=>{
  const first={...track(1),id:'abcdef00-0000-4000-8000-000000000001',title:'first'};
  const queue=musicQueue.normalizeMusicQueue([first,{...first,id:first.id.toUpperCase(),title:'second'},track(2)]);
  assert.equal(queue.length,2);assert.equal(queue[0].title,'first');assert.equal(queue[0].id,first.id);assert.notEqual(queue[0],first);
  for(const source of [[{id:'youtube:external'}],new Array(2),Array(201).fill(track(1)),null]) assert.throws(()=>musicQueue.normalizeMusicQueue(source));
  assert.equal(musicQueue.normalizeMusicQueue(Array.from({length:200},(_,i)=>track(i+1))).length,200);
});
test('next/last enqueue, existing movement, current removal, and unknown current have explicit bounds',()=>{
  const base=[track(1),track(2),track(3)];
  assert.equal(musicQueue.enqueueMusicQueue(base,track(3),id(1),'next').map(x=>x.id).join(),[id(1),id(3),id(2)].join());
  assert.equal(musicQueue.enqueueMusicQueue(base,track(2),id(1),'last').length,3);
  assert.equal(musicQueue.removeMusicQueue(base,id(1)).length,2);
  assert.equal(musicQueue.adjacentMusicQueueTrack(base,id(9),1).id,id(1));assert.equal(musicQueue.adjacentMusicQueueTrack(base,id(9),-1),null);
  assert.equal(musicQueue.adjacentMusicQueueTrack(base,id(1),-1),null);assert.equal(musicQueue.adjacentMusicQueueTrack(base,id(3),1),null);
  assert.throws(()=>musicQueue.enqueueMusicQueue(Array.from({length:200},(_,i)=>track(i+1)),track(201),id(1)));
  assert.equal(base.length,3);
});

const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const functions=between('function musicAudioUrl(', 'function syncMusicPlayerBounds(')
  +between('function updateMusicControls()', 'document.querySelector("#music-search-web")');
function fixture(options={}){
  const nodes=new Map(),calls=[],plays=[];
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{textContent:'',hidden:true,style:{},setAttribute(){},removeAttribute(){}});return nodes.get(selector);};
  const audio={src:'',paused:true,ended:false,currentTime:12,pauseCalls:0,loads:0,
    pause(){this.paused=true;this.pauseCalls++;},load(){this.loads++;},play(){this.paused=false;const gate=options.play?.(plays.length)??Promise.resolve();plays.push(gate);return gate;}};
  const context={musicQueue,musicAudio:audio,musicPlayer:{tracks:[],queue:[],currentId:null,currentTrack:null,currentIndex:-1,artUrl:null,request:0,sourceRequest:0,directUrl:null},
    hubTrackAudio:{resolve:async({directUrl})=>directUrl,release(){}},
    researchAccountGeneration:0,hubOrigin:options.origin===undefined?'https://hub.jkamma.com':options.origin,musicQueueView:null,
    document:{querySelector:node,addEventListener(){}},URL,Blob,syncMusicPlayerBounds(){},renderMusicTracks(){},renderRailNowPlaying(){},friendlyError:error=>error.message,
    createProfileAttribution:()=>({}),commerceProofFetcher:()=>null,musicProofFetcher:()=>null,
    invoke:async(name,args)=>{calls.push({name,args});return options.invoke?.(name,args);}};
  vm.runInNewContext(functions,context);
  return {context,audio,calls,plays,status:()=>node('#music-playback-state').textContent,node,
    play:(t,q,o)=>context.playMusicTrack(t,q,o),replace:q=>context.replaceMusicQueue(q),enqueue:(t,p)=>context.enqueueMusicTrack(t,p),remove:i=>context.removeMusicQueueTrack(i),
    snapshot:()=>context.getMusicQueueState(),toggle:()=>context.toggleMusicPlayback()};
}
test('explicit same ID updates queue without pausing or resetting audio; toggle alone pauses and resumes',async()=>{
  const f=fixture();assert.equal(await f.play(track(1),[track(1),track(2)]),true);
  const before={src:f.audio.src,loads:f.audio.loads,pause:f.audio.pauseCalls,plays:f.plays.length};
  assert.equal(await f.play(track(1),[track(3),track(1)]),true);
  assert.equal(f.snapshot().currentIndex,1);assert.equal(f.audio.src,before.src);assert.equal(f.audio.loads,before.loads);
  assert.equal(f.audio.pauseCalls,before.pause);assert.equal(f.plays.length,before.plays);assert.equal(f.audio.currentTime,12);
  assert.equal(await f.toggle(),true);assert.equal(f.audio.paused,true);
  assert.equal(await f.play(track(1),[track(1),track(2)]),true);assert.equal(f.audio.paused,false);assert.equal(f.audio.loads,before.loads);
});
test('queue edits preserve current audio, detach snapshots, and unknown current next begins switched queue',async()=>{
  const f=fixture();await f.play(track(1),[track(1),track(2)]);const src=f.audio.src,loads=f.audio.loads;
  assert.equal(f.enqueue(track(3),'next'),true);assert.equal(f.snapshot().queue.map(x=>x.id).join(),[id(1),id(3),id(2)].join());
  assert.equal(f.remove(id(3)),true);assert.equal(f.replace([track(4),track(5)]),true);assert.equal(f.snapshot().currentIndex,-1);
  assert.equal(f.audio.src,src);assert.equal(f.audio.loads,loads);assert.equal(f.audio.paused,false);
  const snapshot=f.snapshot();snapshot.queue[0].title='changed';snapshot.queue.pop();assert.equal(f.snapshot().queue.length,2);assert.equal(f.snapshot().queue[0].title,'Track 4');
});
test('invalid source never changes queue or audio and an empty-player queue does not autoplay',async()=>{
  const f=fixture();assert.equal(f.enqueue(track(1)),true);assert.equal(f.plays.length,0);assert.equal(f.audio.src,'');
  assert.equal(f.node('#music-player').hidden,false);assert.equal(f.node('#music-player-title').textContent,'再生待ち');
  const before=f.snapshot().queue.map(x=>x.id).join();assert.equal(await f.play(track(2),Array(201).fill(track(2))),false);
  assert.equal(f.snapshot().queue.map(x=>x.id).join(),before);assert.equal(f.audio.src,'');assert.equal(await f.toggle(),true);assert.equal(f.snapshot().currentId,id(1));
});
test('old play success or failure cannot erase newer loading/error status after song selection',async()=>{
  for(const rejects of [false,true]){
    const old=deferred(),next=deferred(),f=fixture({play:n=>n===0?old.promise:next.promise});
    const a=f.play(track(1),[track(1)]);await turn();const b=f.play(track(2),[track(2)]);await turn();assert.equal(f.status(),'読み込み中…');
    rejects?old.reject(Error('old private error')):old.resolve();assert.equal(await a,false);assert.equal(f.status(),'読み込み中…');
    next.reject(Error('current failure'));assert.equal(await b,false);assert.equal(f.status(),'current failure');
  }
});
test('queue editing invalidates delayed origin without overwriting new queue or changing current audio',async()=>{
  const origin=deferred(),f=fixture({origin:null,invoke:name=>name==='hub_origin'?origin.promise:undefined});
  const pending=f.play(track(1),[track(1)]);await turn();assert.equal(f.enqueue(track(2),'next'),true);origin.resolve('https://hub.jkamma.com');
  assert.equal(await pending,false);assert.equal(f.audio.src,'');assert.equal(f.snapshot().queue[0].id,id(2));assert.equal(f.status(),'');
});
test('stub fetches only the chosen metadata and stale account/queue/guard responses never set audio',async()=>{
  for(const invalidate of [f=>f.context.researchAccountGeneration++,f=>f.enqueue(track(3)),f=>f.context.guard=false]){
    const metadata=deferred(),f=fixture({invoke:name=>name==='hub_detail'?metadata.promise:undefined});f.context.guard=true;
    const pending=f.play({...track(1),playlistStub:true},[{...track(1),playlistStub:true},{...track(2),playlistStub:true}],{isCurrent:()=>f.context.guard});await turn();
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.ids[0],'music:'+id(1));invalidate(f);metadata.resolve({work:{...track(1),id:'music:'+id(1)}});
    assert.equal(await pending,false);assert.equal(f.audio.src,'');assert.equal(f.plays.length,0);
  }
  const f=fixture({invoke:name=>name==='hub_detail'?{work:{...track(1),id:'music:'+id(1),artist:'Public artist'}}:undefined});
  assert.equal(await f.play({...track(1),playlistStub:true},[{...track(1),playlistStub:true},{...track(2),playlistStub:true}]),true);
  assert.equal(f.calls.filter(call=>call.name==='hub_detail').length,1);assert.equal(f.node('#music-player-artist').textContent,'Public artist');
  const mismatch=fixture({invoke:()=>({work:{id:'music:'+id(2)}})});assert.equal(await mismatch.play({...track(1),playlistStub:true},[track(1)]),false);assert.equal(mismatch.audio.src,'');
});
test('queue editing also invalidates pending play acknowledgment while keeping its audio source',async()=>{
  for(const reject of [false,true]){
    const gate=deferred(),f=fixture({play:()=>gate.promise});const pending=f.play(track(1),[track(1)]);await turn();const src=f.audio.src;
    f.enqueue(track(2));reject?gate.reject(Error('obsolete')):gate.resolve();assert.equal(await pending,false);
    assert.equal(f.status(),'');assert.equal(f.audio.src,src);assert.equal(f.audio.paused,false);assert.equal(f.snapshot().queue.length,2);
  }
});
