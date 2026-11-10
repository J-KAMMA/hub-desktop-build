import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {subscribeGroup,realtimeGroup} from './rail-group-live.mjs';

const tick=()=>new Promise(r=>setTimeout(r,0));
const flush=async()=>{for(let i=0;i<6;i++)await tick();};

function rig({kind='public',id='c1'}={}){
 const timers=[];let tid=0;const handlers={};const calls=[];let failOpen=false;
 const win={document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},setTimeout:(fn,ms)=>{timers.push({id:++tid,fn,ms});return tid;},clearTimeout:i=>{const k=timers.findIndex(x=>x.id===i);if(k>=0)timers.splice(k,1);},addEventListener(){},removeEventListener(){}};
 const realtime={invoke:async(name,args)=>{calls.push([name,args]);if(failOpen&&name==='hub_realtime_open')throw new Error('x');},
  listen:async(name,fn)=>{handlers[name]=fn;return()=>{delete handlers[name];};}};
 const s={active:true,refreshed:0};
 const live=subscribeGroup({win,group:{kind,id},realtime,refresh:async()=>{s.refreshed++;},isActive:()=>s.active,isFocused:()=>true});
 return {live,timers,handlers,calls,s,fail:()=>{failOpen=true;}};
}

test('without a realtime bridge the poller is used unchanged',()=>{
 const win={document:{},setTimeout:()=>1,clearTimeout(){},addEventListener(){},removeEventListener(){}};
 const live=subscribeGroup({win,group:{kind:'public',id:'c'},refresh(){},isActive:()=>true,isFocused:()=>true});
 assert.equal(typeof live.sync,'function');assert.equal(live.realtime,undefined);live.stop();
});

test('opens the socket for the group, polls until it is open, then stops polling',async()=>{
 const r=rig();await flush();
 assert.deepEqual(r.calls[0],['hub_realtime_open',{communities:['c1'],dm:false}]);
 assert.equal(r.timers.length,1,'polling runs while the socket is not open');
 r.handlers['hub-realtime-status']({state:'open'});await flush();
 assert.equal(r.timers.length,0,'polling stops while connected');assert.equal(r.live.realtime,true);
 assert.equal(r.s.refreshed,1,'one catch-up pull on open');
 r.handlers['hub-realtime-status']({state:'closed'});await flush();
 assert.equal(r.timers.length,1,'fallback to polling when the socket drops');
 r.live.stop();
});

test('events for this group trigger a pull; other groups and other types do not; bursts coalesce',async()=>{
 const r=rig();await flush();r.handlers['hub-realtime-status']({state:'open'});await flush();
 const base=r.s.refreshed;
 r.handlers['hub-realtime']({type:'group-message',communityId:'other',messageId:'m',ordinal:1,at:'x'});
 r.handlers['hub-realtime']({type:'dm-message',conversationId:'c1',cursor:1,at:'x'});await flush();
 assert.equal(r.s.refreshed,base);
 for(let i=0;i<3;i++)r.handlers['hub-realtime']({type:'group-message',communityId:'c1',messageId:'m'+i,ordinal:i,at:'x'});
 await flush();assert.ok(r.s.refreshed>=base+1&&r.s.refreshed<=base+2,'coalesced');
 r.live.stop();
});

test('a private group subscribes to the DM topic and matches its conversation id',async()=>{
 const r=rig({kind:'private',id:'g1'});await flush();
 assert.deepEqual(r.calls[0],['hub_realtime_open',{communities:[],dm:true}]);
 r.handlers['hub-realtime-status']({state:'open'});await flush();const base=r.s.refreshed;
 r.handlers['hub-realtime']({type:'dm-message',conversationId:'zzz',cursor:2,at:'x'});await flush();assert.equal(r.s.refreshed,base);
 r.handlers['hub-realtime']({type:'dm-message',conversationId:'g1',cursor:3,at:'x'});await flush();assert.equal(r.s.refreshed,base+1);
 r.live.stop();
});

test('closes the socket when the rail is hidden, reopens on sync, closes on stop',async()=>{
 const r=rig();await flush();
 r.s.active=false;r.live.sync();await flush();
 assert.equal(r.calls.at(-1)[0],'hub_realtime_close');assert.equal(r.timers.length,0);
 r.s.active=true;r.live.sync();await flush();
 assert.deepEqual(r.calls.map(c=>c[0]),['hub_realtime_open','hub_realtime_close','hub_realtime_open']);
 r.live.stop();await flush();
 assert.equal(r.calls.at(-1)[0],'hub_realtime_close');assert.deepEqual(Object.keys(r.handlers),[],'listeners removed');
});

test('if the socket cannot be opened the 10 s polling keeps working',async()=>{
 const timers=[];const win={document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},setTimeout:(fn,ms)=>{timers.push(ms);return timers.length;},clearTimeout(){},addEventListener(){},removeEventListener(){}};
 const live=realtimeGroup({win,group:{kind:'public',id:'c1'},realtime:{invoke:async()=>{throw new Error('no');},listen:async()=>()=>{}},refresh:async()=>{},isActive:()=>true,isFocused:()=>true});
 await flush();assert.equal(timers.at(-1),10_000);live.stop();
});

test('only open/close commands cross the bridge: no ticket, URL or device credential in the window',()=>{
 const src=readFileSync(new URL('./rail-group-live.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(src,/ticket|assertion|new WebSocket/i);
});
