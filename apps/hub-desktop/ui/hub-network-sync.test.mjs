import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSourceSync} from './hub-network-sync.mjs';
const legacy='hub.network.sources.v1',base='https://main.example',key=`hub.network.account-sources.v1.${encodeURIComponent(base)}`;
const account=deviceId=>({state:'registered',deviceId});
function fixture() {
  const values=new Map(),calls=[];
  const f={account:account('alice-device'),sources:['https://web.example'],error:null,reply:null};
  const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const invoke=async(name,args)=>{calls.push({name,...args});if(f.reply)return f.reply;if(f.error)throw f.error;
    if(args.action==='add')f.sources=[...new Set([...f.sources,args.origin])];
    if(args.action==='remove')f.sources=f.sources.filter(s=>s!==args.origin);
    return {sources:[...f.sources]};
  };
  return Object.assign(f,{values,calls,storage,create:()=>createSourceSync({base,storage,invoke,getAccount:()=>f.account,onChange:()=>{}})});
}
test('Web is authoritative; add/remove shares preferences and removed sources never resurrect',async()=>{
  const f=fixture(),sync=f.create();await sync.refresh();assert.deepEqual(sync.state.sources,f.sources);
  await sync.change('add','https://desktop.example/');assert.deepEqual(f.sources,['https://web.example','https://desktop.example']);
  f.sources=['https://desktop.example'];await sync.refresh();assert.deepEqual(sync.state.sources,f.sources);
  await sync.change('remove','https://desktop.example');assert.deepEqual(sync.state.sources,[]);
  assert.ok(f.calls.every(c=>c.name==='hub_network_sources'&&c.expectedDeviceId==='alice-device'));
});
test('offline restart keeps this account cache; explicit auth denial clears it',async()=>{
  const f=fixture();await f.create().refresh();f.error='network_unavailable';const sync=f.create();await sync.refresh();
  assert.equal(sync.state.mode,'offline');assert.deepEqual(sync.state.sources,['https://web.example']);
  await assert.rejects(sync.change('add','https://other.example'));assert.equal(f.calls.length,2);
  f.error='account_required';await sync.refresh();assert.deepEqual(sync.state.sources,[]);assert.equal(f.values.has(key),false);
});
test('account switch ignores stale reads and never uses another account cache',async()=>{
  const f=fixture(),sync=f.create();await sync.refresh();let resolve;
  f.reply=new Promise(r=>resolve=r);const pending=sync.refresh();
  f.account=account('bob-device');f.reply=null;f.error='network_unavailable';await sync.refresh();
  assert.deepEqual(sync.state.sources,[]);assert.equal(f.values.has(key),false);
  resolve({sources:['https://old-account.example']});await pending;assert.deepEqual(sync.state.sources,[]);
});
test('logout ignores a pending mutation and removes its account cache',async()=>{
  const f=fixture(),sync=f.create();await sync.refresh();let resolve;
  f.reply=new Promise(r=>resolve=r);const pending=sync.change('add','https://late.example');
  f.account={state:'signed_out'};f.reply=null;await sync.refresh();assert.equal(sync.state.mode,'local');
  resolve({sources:['https://late.example']});await assert.rejects(pending);assert.deepEqual(sync.state.sources,[]);assert.equal(f.values.has(key),false);
});
test('startup waits for account status without deleting the offline cache',async()=>{
  const f=fixture();await f.create().refresh();f.account=null;const sync=f.create();await sync.refresh();
  assert.deepEqual(sync.state.sources,[]);assert.equal(f.values.has(key),true);
  f.account=account('alice-device');f.error='network_unavailable';await sync.refresh();assert.deepEqual(sync.state.sources,['https://web.example']);
});
test('legacy sources migrate only on request; partial failure preserves unimported sources',async()=>{
  const f=fixture();f.values.set(legacy,JSON.stringify(['https://local.example','https://another.example']));
  f.sources=Array.from({length:7},(_,i)=>`https://web${i}.example`);
  const sync=f.create();await sync.refresh();assert.equal(f.calls.length,1);assert.equal(sync.state.legacy.length,2);
  await assert.rejects(sync.migrate(),/8件/);assert.equal(f.sources.length,8);
  assert.deepEqual(JSON.parse(f.values.get(legacy)),['https://another.example']);
  assert.deepEqual(sync.state.legacy,['https://another.example']);
});
test('signed-out sources stay local and failed local saves do not change the view',async()=>{
  const f=fixture();f.account={state:'signed_out'};const sync=f.create();await sync.refresh();
  await sync.change('add','https://local.example');assert.equal(f.calls.length,0);
  f.storage.setItem=()=>{throw Error('quota');};await assert.rejects(sync.change('remove','https://local.example'),/保存できません/);
  assert.deepEqual(sync.state.sources,['https://local.example']);
});
test('storage failure after server success is disclosed; no overlapping account mutations',async()=>{
  const f=fixture(),sync=f.create();f.storage.setItem=()=>{throw Error('quota');};await sync.refresh();assert.match(sync.state.message,/保存できません/);
  let resolve;f.reply=new Promise(r=>resolve=r);const pending=sync.change('add','https://new.example');
  await assert.rejects(sync.change('remove','https://web.example'),/お待ち/);await sync.refresh();assert.equal(f.calls.length,2);
  resolve({sources:['https://new.example']});await pending;assert.deepEqual(sync.state.sources,['https://new.example']);assert.match(sync.state.message,/保存できません/);
});

test('a failed read recovers automatically, but a failed mutation is never replayed',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),sync=f.create();t.after(sync.dispose);
  f.error='network_unavailable';await sync.refresh();assert.equal(sync.state.mode,'offline');
  f.error=null;t.mock.timers.tick(1000);await new Promise(setImmediate);
  assert.equal(sync.state.mode,'synced');assert.equal(f.calls.length,2);
  f.error='network_unavailable';await assert.rejects(sync.change('add','https://new.example'));
  f.error=null;t.mock.timers.tick(60000);await new Promise(setImmediate);
  assert.equal(f.calls.filter(c=>c.action==='add').length,1);assert.equal(f.calls.length,3);
});
test('a scheduled read does not run for another account or after disposal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),sync=f.create();t.after(sync.dispose);
  f.error='network_unavailable';await sync.refresh();f.account=account('bob');
  t.mock.timers.tick(60000);await new Promise(setImmediate);assert.equal(f.calls.length,1);
  await sync.refresh();sync.dispose();t.mock.timers.tick(60000);await new Promise(setImmediate);assert.equal(f.calls.length,2);
});


test('device management works with no account or primary Hub and survives a restart',async t=>{
  const f=fixture();f.account=null;f.error='network_unavailable';const sync=f.create();t.after(sync.dispose);
  await sync.setScope('device');await sync.change('add','https://independent.example');
  assert.equal(f.calls.length,0);assert.equal(sync.state.scope,'device');assert.equal(sync.state.mode,'local');
  f.account=account('other-device');const restarted=f.create();t.after(restarted.dispose);await restarted.refresh();
  assert.deepEqual(restarted.state.sources,['https://independent.example']);await restarted.change('remove','https://independent.example');assert.deepEqual(restarted.state.sources,[]);assert.equal(f.calls.length,0);
});
test('device and profile lists stay separate; switching does not synchronize either list',async t=>{
  const f=fixture(),sync=f.create();t.after(sync.dispose);await sync.refresh();
  const shared=f.values.get(key);await sync.setScope('device');assert.deepEqual(sync.state.sources,[]);assert.equal(f.values.get(key),shared);
  await sync.change('add','https://device.example');await sync.setScope('profile');assert.deepEqual(sync.state.sources,['https://web.example']);
  await sync.setScope('device');assert.deepEqual(sync.state.sources,['https://device.example']);assert.ok(f.calls.every(c=>c.action==='list'));assert.deepEqual(f.sources,['https://web.example']);
});
test('a late profile read cannot replace the device list or restart its recovery',async t=>{
  const f=fixture(),sync=f.create();t.after(sync.dispose);let finish;f.reply=new Promise(resolve=>finish=resolve);
  const pending=sync.refresh();await sync.setScope('device');await sync.change('add','https://device.example');finish({sources:['https://late.example']});await pending;
  assert.equal(sync.state.scope,'device');assert.deepEqual(sync.state.sources,['https://device.example']);assert.equal(f.values.has(key),false);
});
test('management preference save failures leave the existing scope and sources intact',async t=>{
  const f=fixture(),sync=f.create();t.after(sync.dispose);await sync.refresh();f.storage.setItem=()=>{throw Error('quota')};
  await assert.rejects(sync.setScope('device'),/保存できません/);assert.equal(sync.state.scope,'profile');assert.deepEqual(sync.state.sources,['https://web.example']);
  await assert.rejects(sync.setScope('invalid'));assert.equal(sync.state.scope,'profile');
});
test('management cannot switch during an outgoing profile mutation',async t=>{
  const f=fixture(),sync=f.create();t.after(sync.dispose);await sync.refresh();let finish;f.reply=new Promise(resolve=>finish=resolve);
  const pending=sync.change('add','https://new.example');await assert.rejects(sync.setScope('device'),/お待ち/);assert.equal(sync.state.scope,'profile');finish({sources:['https://web.example','https://new.example']});await pending;
});
