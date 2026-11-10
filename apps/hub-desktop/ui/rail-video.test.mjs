import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import * as rv from './rail-video.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const dom=t=>{const w=new JSDOM('<!doctype html><body></body>').window;t.after(()=>w.close());return w;};
const tick=()=>new Promise(r=>setTimeout(r,0));
const flush=async()=>{for(let i=0;i<6;i++)await tick();};

const yt=(id,extra={})=>({id:'v-'+id,title:'動画 '+id,channel:'Ch '+id,provider:'youtube',sourceUrl:`https://www.youtube.com/watch?v=${id.padEnd(11,'x')}`,availabilityStatus:'available',publishedAt:'2026-11-01T00:00:00Z',...extra});

test('sorts are おすすめ / フォロー中 / 人気 and map to server order recent / popular',()=>{
 assert.deepEqual(rv.VIDEO_SORTS.map(([,l])=>l),['おすすめ','フォロー中','人気']);
 assert.equal(rv.videoOrderFor('popular'),'popular');
 assert.equal(rv.videoOrderFor('recommended'),'recent');
 assert.equal(rv.videoOrderFor('following'),'recent');
 assert.equal(rv.normalizeVideoSort('evil'),'recommended');
});

test('フォロー中 keeps only followed channels (by name or id); おすすめ lifts followed-tag videos',()=>{
 const videos=[yt('a',{channel:'Kaze Trio'}),yt('b',{channel:'Other'}),yt('c',{channel:'x',channelId:'ch9'})];
 assert.deepEqual(rv.followingVideos(videos,[{id:'ch1',name:'kaze trio'},{id:'ch9',name:'zzz'}]).map(v=>v.id),['v-a','v-c']);
 assert.deepEqual(rv.followingVideos(videos,[]),[]);
 const rec=rv.recommendVideos([yt('a',{title:'料理'}),yt('b',{title:'旅の記録'}),yt('c',{title:'雑談'})],['#旅']);
 assert.deepEqual(rec.map(v=>v.id),['v-b','v-a','v-c'],'tag match first, rest keep server order');
 assert.deepEqual(rv.recommendVideos([yt('a'),yt('b')],[]).map(v=>v.id),['v-a','v-b']);
});

function build(t,{signedIn=true,observe=null,calls=[]}={}){
 const w=dom(t),document=w.document;
 const store=new Map();
 const dockCalls=[];
 const iframe=document.createElement('iframe');document.body.append(iframe); // the shared dock's iframe lives in document.body
 const dock={play(args){dockCalls.push(['play',args.key,args.autoplay,args.slot.isConnected]);return true;},release(slot){dockCalls.push(['release',slot.className]);},
  subscribe(){return()=>{};},isPlaying:()=>true,layout(){dockCalls.push(['layout']);},stop(){dockCalls.push(['STOP']);}};
 const invoke=async(name,args)=>{calls.push([name,args]);
  if(name==='hub_resource'&&args.resource==='videos'){
   const base=args.order==='popular'?['p1','p2']:['r1','r2'];
   return {videos:base.map(id=>yt(id,{channel:id==='r2'?'Kaze Trio':'Other',title:id==='r2'?'旅の動画':'料理'})),hasMore:args.offset===0};
  }
  if(name==='hub_detail'&&args.name==='sidebar')return {channels:[{id:'ch1',name:'Kaze Trio'}],followedTags:['旅']};
  throw new Error('unexpected '+name);};
 const opened=[],reopened=[];
 const deps={hubAsset(){},relTime:()=>'1日前',icon:n=>`<svg data-icon="${n}"></svg>`,dock,openExternal:u=>opened.push(['ext',u]),nativePlay:()=>{},openCentral:v=>opened.push(['central',v.id]),
  signedIn:()=>signedIn,connect:()=>opened.push(['connect']),friendlyError:e=>String(e?.message??e),storage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},observe,onReopen:v=>reopened.push(v.id)};
 const video=rv.createRailVideo({document,invoke,deps});
 document.body.append(video.element);
 return {w,document,video,calls,dockCalls,iframe,opened,reopened,store};
}

test('list: おすすめ is the default; each switch reads its own order; the choice is remembered',async t=>{
 const ctx=build(t);
 await ctx.video.load();
 assert.deepEqual(ctx.calls.find(c=>c[0]==='hub_resource')[1],{resource:'videos',query:'',offset:0,category:'',order:'recent'});
 const titles=()=>[...ctx.document.querySelectorAll('.rail-video-list .video-card strong')].map(n=>n.textContent);
 assert.deepEqual(titles(),['旅の動画','料理'],'followed tag lifts the matching video');
 ctx.document.querySelector('[data-rail-subtab="popular"]').click();await flush();
 assert.equal(ctx.calls.filter(c=>c[0]==='hub_resource').at(-1)[1].order,'popular');
 ctx.document.querySelector('[data-rail-subtab="following"]').click();await flush();
 assert.deepEqual(titles(),['旅の動画'],'only the followed channel');
 assert.equal(JSON.parse(ctx.store.get(rv.VIDEO_KEY)).sort,'following');
});

test('signed out: フォロー中 asks to connect and reads nothing private',async t=>{
 const ctx=build(t,{signedIn:false});
 ctx.document.querySelector('[data-rail-subtab="following"]').click();await flush();
 assert.ok(ctx.document.querySelector('.rail-state--signedOut'));
 ctx.document.querySelector('.rail-state--signedOut button').click();assert.deepEqual(ctx.opened.at(-1),['connect']);
 assert.ok(!ctx.calls.some(c=>c[0]==='hub_detail'));
});

test('infinite scroll appends the next page',async t=>{
 let fire=null;
 const ctx=build(t,{observe:cb=>{fire=cb;return{observe(){},disconnect(){}};}});
 await ctx.video.load();
 assert.equal(ctx.document.querySelectorAll('.rail-video-list .video-card').length,2);
 fire();await flush();
 assert.equal(ctx.calls.filter(c=>c[0]==='hub_resource').at(-1)[1].offset,2);
});

test('playing inside the rail: the dock gets a slot in the rail; leaving hands the same player to the mini window',async t=>{
 const ctx=build(t);
 await ctx.video.load();
 const changes=[];ctx.video.onChange(c=>changes.push(c.type));
 ctx.document.querySelector('.rail-video-list .video-card').click();
 assert.equal(ctx.video.watching.id,'v-r2');
 assert.deepEqual(ctx.dockCalls.find(c=>c[0]==='play').slice(1),['video:v-r2',true,false],'slot is created (it joins the page right after)');
 assert.ok(ctx.document.querySelector('.rail-video-watch .yt-player-slot'));
 assert.equal(ctx.document.querySelector('.rail-video-listview').hidden,true);
 assert.deepEqual(changes,['watch']);
 const before=ctx.dockCalls.length;
 ctx.video.release();
 assert.deepEqual(ctx.dockCalls.slice(before).filter(c=>c[0]==='release').length,1,'slot released once');
 ctx.video.release();
 assert.equal(ctx.dockCalls.filter(c=>c[0]==='release').length,1,'release is idempotent');
 assert.ok(!ctx.dockCalls.some(c=>c[0]==='STOP'),'the player is never stopped or recreated');
 assert.ok(ctx.iframe.isConnected&&ctx.iframe.parentElement===ctx.document.body,'the dock iframe stays in document.body');
 // back in the panel: same key, no autoplay jump, slot re-attached
 ctx.video.show();
 const replay=ctx.dockCalls.filter(c=>c[0]==='play').at(-1);
 assert.deepEqual(replay.slice(1,3),['video:v-r2',false]);
 ctx.video.show();
 assert.equal(ctx.dockCalls.filter(c=>c[0]==='play').length,2,'show() is idempotent while mounted');
 ctx.document.querySelector('.rail-video-back').click();
 assert.equal(ctx.document.querySelector('.rail-video-listview').hidden,false);
 assert.equal(ctx.video.watching,null);
 assert.deepEqual(changes,['watch','list']);
});

test('central open and reopen from the mini window',async t=>{
 const ctx=build(t);
 await ctx.video.load();
 ctx.document.querySelector('.rail-video-list .video-card').click();
 ctx.document.querySelector('.rail-video-central').click();
 assert.deepEqual(ctx.opened.at(-1),['central','v-r2']);
});

test('reset (account change) drops the watch view and the lists',async t=>{
 const ctx=build(t);
 await ctx.video.load();
 ctx.document.querySelector('.rail-video-list .video-card').click();
 ctx.video.reset();
 assert.equal(ctx.video.watching,null);
 assert.equal(ctx.document.querySelector('.rail-video-listview').hidden,false);
 assert.equal(ctx.document.querySelectorAll('.rail-video-list .video-card').length,0);
});

test('the module never moves the player element or touches the dock iframe',()=>{
 const src=readFileSync(new URL('./rail-video.mjs',import.meta.url),'utf8').split('\n').filter(l=>!l.trim().startsWith('//')).join('\n');
 assert.ok(!/iframe|appendChild|\.src\b|yt-dock|dock\.stop|dock\.element|insertBefore/.test(src.replace(/yt-player-slot/g,'')),'only dock.layout / the stage slot are used');
 const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
 assert.match(app,/if \(open && railView === "video"\) railVideo\.show\(\); else railVideo\.release\(\);/,'every view/rail change releases or re-attaches');
});
