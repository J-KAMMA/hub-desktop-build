import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createMediaP2pSettings, normalizeMediaP2pSettings, formatBytes, MEDIA_P2P_NOTICE} from './media-p2p-settings.mjs';
import {createHubTrackAudio} from './hub-track-audio.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));};

function fixture(options={}){
  const dom=new JSDOM('<main></main>'),document=dom.window.document;
  const init=options.initial??{};
  const calls=[];let stored={receiveFromPeers:init.receive===true,seed:init.seed===true,relayOnly:init.relayOnly??true,allowedOrigins:[],uploadKibPerSec:512,cacheLimitMib:2048};
  const usage=[512*1024**2,1];
  const invoke=async(command,args)=>{
    calls.push({command,args:args?structuredClone(args):undefined});
    if(options.invoke)return options.invoke(command,args);
    if(command==='media_p2p_settings_get')return {...stored};
    if(command==='media_p2p_settings_set'){stored={...args.settings};return {...stored};}
    if(command==='media_cache_usage')return usage;
    throw Error('unexpected');
  };
  const widget=createMediaP2pSettings({document,invoke});
  document.querySelector('main').append(widget.element);
  const box=name=>widget.element.querySelector(`[data-media-p2p="${name}"]`),action=name=>widget.element.querySelector(`[data-media-p2p-action="${name}"]`);
  const toggle=async(name,value)=>{box(name).checked=value;box(name).dispatchEvent(new dom.window.Event('change'));await settle();};
  const sets=()=>calls.filter(c=>c.command==='media_p2p_settings_set');
  const view=()=>({receive:stored.receiveFromPeers,seed:stored.seed,relayOnly:stored.relayOnly});
  return{dom,widget,calls,box,action,toggle,sets,notice:()=>widget.element.querySelector('.media-p2p-notice'),stored:view};
}

test('both opt-ins default off and toggles are disabled until settings load',async()=>{
  const f=fixture();assert.equal(f.box('receive').disabled,true);
  await f.widget.refresh();assert.equal(f.box('receive').checked,false);assert.equal(f.box('seed').checked,false);assert.equal(f.box('receive').disabled,false);
  assert.equal(f.widget.element.textContent.includes('他の端末から受け取る'),true);assert.equal(f.widget.element.textContent.includes('他の端末へ配る'),true);
  assert.equal(f.notice().hidden,true);
});

test('missing command fails closed: controls stay disabled and nothing is written',async()=>{
  const f=fixture({invoke:async()=>{throw Error('command media_p2p_settings_get not found');}});await f.widget.refresh();
  assert.equal(f.box('receive').disabled,true);assert.equal(f.box('seed').disabled,true);assert.match(f.widget.element.querySelector('[role="status"]').textContent,/読み込めません/u);assert.equal(f.sets().length,0);
});

test('enabling receive shows the IP notice first and writes nothing until confirmed',async()=>{
  const f=fixture();await f.widget.refresh();await f.toggle('receive',true);
  assert.equal(f.notice().hidden,false);assert.equal(f.sets().length,0);assert.equal(f.box('receive').checked,false);
  assert.match(f.notice().textContent,/IPアドレス/u);assert.match(f.notice().textContent,/中継/u);assert.match(f.notice().textContent,/Media Tracker/u);
  f.action('confirm').click();await settle();
  assert.equal(f.sets().length,1);assert.equal(f.sets()[0].args.settings.receiveFromPeers,true);assert.equal(f.sets()[0].args.settings.seed,false);
  assert.equal(f.sets()[0].args.settings.cacheLimitMib,2048,'the full settings object is sent, so other values are not reset');assert.equal(f.box('receive').checked,true);assert.equal(f.notice().hidden,true);
});

test('cancel leaves seed off and makes no write',async()=>{
  const f=fixture();await f.widget.refresh();await f.toggle('seed',true);assert.match(f.notice().textContent,/アプリを閉じると配布も止まります/u);
  f.action('cancel').click();await settle();assert.equal(f.sets().length,0);assert.equal(f.box('seed').checked,false);assert.equal(f.notice().hidden,true);
});

test('receive and seed are independent: confirming one does not enable the other',async()=>{
  const f=fixture();await f.widget.refresh();await f.toggle('seed',true);f.action('confirm').click();await settle();
  assert.equal(f.stored().seed,true);assert.equal(f.stored().receive,false);assert.equal(f.box('receive').checked,false);
});

test('turning off and relay-only change immediately without a notice',async()=>{
  const f=fixture({initial:{receive:true,relayOnly:false}});await f.widget.refresh();
  await f.toggle('relayOnly',true);assert.equal(f.notice().hidden,true);await f.toggle('receive',false);
  assert.deepEqual(f.sets().map(c=>[c.args.settings.relayOnly,c.args.settings.receiveFromPeers]),[[true,true],[true,false]]);
});

test('failed save does not show the option as enabled',async()=>{
  let fail=false;const f=fixture({invoke:async(command)=>{if(command==='media_p2p_settings_get')return{};if(fail)throw Error('x');return{};}});
  await f.widget.refresh();fail=true;await f.toggle('seed',true);f.action('confirm').click();await settle();
  assert.equal(f.box('seed').checked,false);assert.match(f.widget.element.querySelector('[role="status"]').textContent,/保存できませんでした/u);
});

test('quota and usage come from the Rust settings and media_cache_usage',async()=>{
  const f=fixture();await f.widget.refresh();
  const text=f.widget.element.textContent;assert.match(text,/512 MiB \/ 2\.0 GiB|512 MiB \/ 2 GiB/u);
  assert.equal(f.widget.element.querySelector('progress').value,25);
});

test('helpers normalize untrusted values',()=>{
  assert.deepEqual(normalizeMediaP2pSettings({receive:'yes',seed:1,quotaBytes:-1,usedBytes:1.5}),{receive:false,seed:false,relayOnly:false,quotaBytes:0,usedBytes:0,seedingTracks:0,sentBytes:0});
  assert.equal(formatBytes(1536),'1.5 KiB');assert.ok(MEDIA_P2P_NOTICE.common.includes('IPアドレス'));
});

test('source: notice is flagged pending legal review and no raw colors are introduced',()=>{
  const source=readFileSync(new URL('./media-p2p-settings.mjs',import.meta.url),'utf8');
  assert.match(source,/法務確認待ち/u);assert.doesNotMatch(source,/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/u);
});

const id='abcdef01-abcd-4abc-8abc-abcdef012345',origin='https://hub.jkamma.com',direct=`${origin}/music/api/tracks/${id}/audio`;
function urlApi(){let n=0;const revoked=[],created=[];return{revoked,created,createObjectURL:()=>{const url='blob:test/'+(++n);created.push(url);return url;},revokeObjectURL:url=>revoked.push(url)};}

test('playback: media_audio bytes become a blob URL and the previous one is revoked',async()=>{
  const api=urlApi(),calls=[];const audio=createHubTrackAudio({URLApi:api,invoke:async(name,args)=>{calls.push({name,args});return new Uint8Array([1,2,3]);}});
  assert.equal(await audio.resolve({origin,trackId:id,directUrl:direct}),'blob:test/1');
  assert.deepEqual(calls,[{name:'media_audio',args:{origin,trackId:id}}]);
  assert.equal(await audio.resolve({origin,trackId:id,directUrl:direct}),'blob:test/2');assert.deepEqual(api.revoked,['blob:test/1']);
  audio.release();assert.deepEqual(api.revoked,['blob:test/1','blob:test/2']);
});

test('playback: missing or failing command falls back to the direct URL and frees the old blob',async()=>{
  const api=urlApi();let mode='ok';const audio=createHubTrackAudio({URLApi:api,invoke:async()=>{if(mode==='fail')throw Error('not found');if(mode==='empty')return new Uint8Array();return new Uint8Array([9]);}});
  await audio.resolve({origin,trackId:id,directUrl:direct});mode='fail';
  assert.equal(await audio.resolve({origin,trackId:id,directUrl:direct}),direct);assert.deepEqual(api.revoked,['blob:test/1']);
  mode='empty';assert.equal(await audio.resolve({origin,trackId:id,directUrl:direct}),direct);
});

test('playback: stale request is dropped and its blob is revoked',async()=>{
  const api=urlApi();const audio=createHubTrackAudio({URLApi:api,invoke:async()=>new Uint8Array([1])});
  assert.equal(await audio.resolve({origin,trackId:id,directUrl:direct,isCurrent:()=>false}),null);assert.deepEqual(api.revoked,[]);assert.deepEqual(api.created,[]);
});

test('playback: non-Worker ids (YouTube, peer) never call media_audio',async()=>{
  const api=urlApi();let called=0;const audio=createHubTrackAudio({URLApi:api,invoke:async()=>{called++;return new Uint8Array([1]);}});
  for(const trackId of ['dQw4w9WgXcQ','peer:abc','yt:dQw4w9WgXcQ','music:'+id,''])assert.equal(await audio.resolve({origin,trackId,directUrl:'x'}),'x');
  assert.equal(called,0);
});

test('wiring: app mounts the section in the device settings panel and plays through hub-track-audio',()=>{
  const app=readFileSync(new URL('./app.js',import.meta.url),'utf8'),html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/data-settings-panel="device"[\s\S]*id="settings-media-p2p"/u);
  assert.match(app,/createMediaP2pSettings\(\{ document, invoke/u);assert.match(app,/hubTrackAudio\.resolve\(/u);
  assert.doesNotMatch(app,/musicAudio\.src = url;/u);
});
