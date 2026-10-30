import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import * as musicQueue from './music-queue.mjs';

const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
function actual(signature){const start=app.indexOf(signature),end=app.indexOf('\n}',start);assert.ok(start>=0&&end>start,signature);return app.slice(start,end+2);}
const functions=['function musicAudioUrl(','function selectedMusicWork()','function homeAccountSnapshot()',
 'function homeAccountCurrent(snapshot)','function homeNativeAccountMatches(snapshot, status)',
 'function homeCanonicalOrigin(raw)','async function captureHomeScope(','async function confirmHomeScope(',
 'async function returnToMusicWork()','async function openDetail('].map(actual).join('\n');
const id='abcdef01-abcd-4abc-8abc-abcdef012345',origin='https://hub.jkamma.com';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);
function fixture(t){
 const player=html.slice(html.indexOf('    <div id="music-player"'),html.indexOf('\n  </main>',html.indexOf('    <div id="music-player"')));
 const dom=new JSDOM('<section id="view-feed"><div class="view-head"><h2>Feed</h2></div></section>'+player,{url:origin});
 const audio=dom.window.document.querySelector('#music-player-audio'),button=dom.window.document.querySelector('#music-return-work');
 assert.ok(button);assert.equal(button.className,'head-action');assert.equal(button.disabled,true);
 audio.src=origin+'/music/api/tracks/'+id+'/audio';audio.currentTime=37;
 for(const method of ['play','pause','load'])audio[method]=()=>assert.fail('Return must not change audio: '+method);
 const f={dom,audio,button,calls:[],entries:[],notices:[],origin,status:{state:'registered',deviceId:'device',keyThumbprint:'synthetic'},
  reply:{work:{id:'music:'+id,title:'Original work'}},originGate:null,metadataGate:null,browserGate:null};
 const context={document:dom.window.document,URL,musicQueue,musicAudio:audio,musicReturnPending:false,
  musicPlayer:{currentId:id,currentTrack:{id,title:'Original work'},sourceRequest:3,queue:[{id,title:'Original work'},{id:id.slice(0,-1)+'6',title:'Next'}]},
  desktopAccountLoaded:true,desktopAccount:{...f.status},homeAccountEpoch:{},researchAccountGeneration:0,
  currentView:'feed',detailTrail:[],detailForwardTrail:[],detailReturn:{},toolbarTrail:[{view:'feed'}],toolbarTrailIndex:0,
  captureSocialScene(){},captureVideoScene(){},saveDetailTrail(){},viewScroller:()=>null,
  exitBrowser:async()=>{if(f.browserGate)await f.browserGate.promise;},
  showView:view=>{context.currentView=view;},renderDetailEntry:async entry=>{f.entries.push(entry);},
  showNotice:message=>f.notices.push(message),friendlyError:String,
  invoke:async(name,args)=>{f.calls.push({name,args:args?structuredClone(args):undefined});
   if(name==='hub_origin')return f.originGate?await f.originGate.promise:f.origin;
   if(name==='desktop_account_status')return f.status;
   if(name==='hub_detail')return f.metadataGate?await f.metadataGate.promise:f.reply;
   assert.fail('Unexpected invoke '+name);}};
 vm.createContext(context);vm.runInContext(functions,context);
 const binding=app.match(/document\.querySelector\("#music-return-work"\)\.onclick = [^\n]+/);assert.ok(binding);vm.runInContext(binding[0],context);
 f.ctx=context;f.open=()=>context.returnToMusicWork();t.after(()=>dom.window.close());return f;
}
test('global explicit activation opens the exact original source detail and preserves audio, time and queue',async t=>{
 const f=fixture(t),queue=f.ctx.musicPlayer.queue;
 assert.equal(f.calls.length,0);assert.equal(f.ctx.selectedMusicWork().origin,origin);
 f.button.disabled=false;f.button.click();await tick();
 assert.equal(f.entries.length,1);const entry=f.entries[0];
 assert.equal(entry.name,'music_work');assert.deepEqual(Array.from(entry.ids),['music:'+id]);assert.equal(entry.local,true);
 assert.equal(entry.data,f.reply);assert.deepEqual(structuredClone(entry.targetSelection),{origin,workId:'music:'+id});
 assert.deepEqual(f.calls.map(call=>call.name),['hub_origin','desktop_account_status','hub_detail','hub_origin','desktop_account_status']);
 assert.deepEqual(f.calls[2].args,{name:'music_work',ids:['music:'+id]});
 assert.equal(f.dom.window.document.querySelector('#music-player-audio'),f.audio);assert.equal(f.audio.currentTime,37);
 assert.equal(f.audio.src,origin+'/music/api/tracks/'+id+'/audio');assert.equal(f.ctx.musicPlayer.queue,queue);
});
test('selected source validates exact UUID types, widths, version, variant and full audio path before any read',async t=>{
 for(const value of [null,42,'',id.slice(0,-1),id+'0',id+'\n',id+'\0',id.replace('-4abc-','-0abc-'),id.replace('-4abc-','-6abc-'),id.replace('-8abc-','-7abc-'),id.replace('-8abc-','-cabc-'),'../work','music:'+id]){
  const f=fixture(t);f.ctx.musicPlayer.currentId=value;f.ctx.musicPlayer.currentTrack.id=value;
  assert.equal(await f.open(),false);assert.equal(f.calls.length,0);assert.equal(f.entries.length,0);
 }
 for(const src of [origin+'/music/api/tracks/'+id+'/audio?token=synthetic',origin+'/music/api/tracks/'+id+'/audio#part',
  origin+'/music/api/tracks/'+id.slice(0,-1)+'6/audio','https://user:synthetic@hub.jkamma.com/music/api/tracks/'+id+'/audio',
  'https://other.example/music/api/tracks/'+id+'/audio','file:///music/'+id+'/audio']){
  const f=fixture(t);f.audio.src=src;assert.equal(await f.open(),false);assert.equal(f.calls.length,0);
 }
 const f=fixture(t);f.ctx.musicPlayer.currentTrack=null;assert.equal(await f.open(),false);assert.equal(f.calls.length,0);
});
test('supported UUID boundaries, canonical aliases and signed-out public navigation stay exact',async t=>{
 for(const workId of [id.replace('-4abc-','-1abc-'),id.replace('-4abc-','-5abc-').replace('-8abc-','-babc-'),id.toUpperCase()]){
  const f=fixture(t);f.ctx.musicPlayer.currentId=workId;f.ctx.musicPlayer.currentTrack.id=workId;
  f.audio.src=origin+'/music/api/tracks/'+workId+'/audio';f.reply={work:{id:'music:'+workId}};
  f.ctx.desktopAccount=f.status={state:'signed_out'};
  assert.equal(await f.open(),true);assert.deepEqual(Array.from(f.entries[0].ids),['music:'+workId]);
 }
});
test('unavailable actor/origin or mismatched current source never loads a detail',async t=>{
 for(const change of [f=>{f.ctx.desktopAccountLoaded=false;},f=>{f.origin='https://other.example';},
  f=>{f.status={...f.status,deviceId:'other'};},f=>{f.ctx.musicPlayer.currentId=id.slice(0,-1)+'6';}]){
  const f=fixture(t);change(f);assert.equal(await f.open(),false);assert.equal(f.entries.length,0);
  assert.equal(f.calls.filter(call=>call.name==='hub_detail').length,0);
 }
});
test('late source reads reject changed actor, epoch, current track or current audio source and suppress duplicate activation',async t=>{
 for(const change of [f=>{f.ctx.desktopAccount={...f.ctx.desktopAccount,deviceId:'other'};},f=>{f.ctx.homeAccountEpoch={};},
  f=>{f.ctx.researchAccountGeneration++;},f=>{f.ctx.musicPlayer.sourceRequest++;},f=>{f.ctx.musicPlayer.currentId=id.slice(0,-1)+'6';},
  f=>{f.audio.src='http://localhost:3020/music/api/tracks/'+id+'/audio';}]){
  const f=fixture(t);f.originGate=deferred();const pending=f.open();await tick();assert.equal(f.button.disabled,true);
  assert.equal(await f.open(),false);change(f);f.originGate.resolve(origin);assert.equal(await pending,false);
  assert.equal(f.entries.length,0);assert.equal(f.calls.filter(call=>call.name==='hub_detail').length,0);
 }
});
test('metadata completion remains tied to selected source and unavailable/mismatched work cannot navigate',async t=>{
 for(const change of [f=>{f.origin='https://other.example';},f=>{f.status={...f.status,deviceId:'other'};},
  f=>{f.ctx.musicPlayer.sourceRequest++;},f=>{f.ctx.homeAccountEpoch={};}]){
  const f=fixture(t);f.metadataGate=deferred();const pending=f.open();await tick();change(f);f.metadataGate.resolve(f.reply);
  assert.equal(await pending,false);assert.equal(f.entries.length,0);
 }
 for(const reply of [null,{work:{id:'music:'+id.slice(0,-1)+'6'}},{work:{id}},{}]){
  const f=fixture(t);f.reply=reply;assert.equal(await f.open(),false);assert.equal(f.entries.length,0);
 }
 const f=fixture(t);f.metadataGate=deferred();const pending=f.open();await tick();f.metadataGate.reject(Error('Synthetic read failure'));
 assert.equal(await pending,false);assert.equal(f.entries.length,0);assert.equal(f.button.disabled,false);
});
test('the existing openDetail guard refuses scope/track changes during pending browser exit',async t=>{
 for(const change of [f=>{f.ctx.homeAccountEpoch={};},f=>{f.ctx.researchAccountGeneration++;},f=>{f.ctx.musicPlayer.sourceRequest++;}]){
  const f=fixture(t);f.browserGate=deferred();const pending=f.open();await tick();assert.equal(f.ctx.currentView,'feed');
  change(f);f.browserGate.resolve();assert.equal(await pending,false);assert.equal(f.entries.length,0);assert.equal(f.ctx.detailTrail.length,0);
 }
});
