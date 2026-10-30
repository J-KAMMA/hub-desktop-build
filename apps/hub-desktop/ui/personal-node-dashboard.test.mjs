import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPersonalNodeDashboard } from './personal-node-dashboard.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const state = () => ({ viewerId: 'hub-profile', node: { nodeUrl: 'https://node.example', keyThumbprint: 'public-fingerprint', status: 'active' }, relays: [{ relayUrl: 'https://relay.example', priority: 0, enabled: 1 }], devices: [{ deviceId: 'device-1', label: 'This PC', deviceType: 'computer', keyThumbprint: 'public-fingerprint', scopes: ['post:write'], status: 'active' }] });
async function fixture(t, overrides = {}) {
  const dom = new JSDOM('<body></body>'), f = { dom, current: true, account: 'generation-1', data: state(), calls: [], failedWrite: false };
  f.controller = createPersonalNodeDashboard(dom.window.document, { isCurrent: () => f.current, getAccount: () => f.account, invoke: async (name, args) => {
    f.calls.push({ name, args }); if (name === 'hub_client') return f.data; if (f.failedWrite) throw Error('unavailable');
    if (args.action === 'personal_node_relays') { f.data = { ...f.data, relays: args.options.relays.map((relayUrl, priority) => ({ relayUrl, priority, enabled: 1 })) }; return { relays: args.options.relays }; }
    f.data = { ...f.data, devices: f.data.devices.map(device => ({ ...device, status: 'revoked' })) }; return { revoked: true, deviceId: args.target };
  }, ...overrides });
  dom.window.document.body.append(f.controller.element); t.after(() => { f.controller.dispose(); dom.window.close(); }); f.root = f.controller.element; f.button = label => [...f.root.querySelectorAll('button')].find(node => node.textContent === label); f.input = value => { const input = f.root.querySelector('textarea'); input.value = value; input.dispatchEvent(new dom.window.Event('input')); }; await f.controller.ready; return f;
}
const writes = f => f.calls.filter(call => call.name === 'hub_client_action');

test('dashboard reads only Hub metadata and leaves local native node settings to existing UI', async t => {
  const f = await fixture(t); assert.deepEqual(f.calls, [{ name: 'hub_client', args: { name: 'personal_node' } }]); assert.match(f.root.textContent, /登録済み.*https:\/\/node.example/); assert.match(f.root.textContent, /This PC/); assert.match(f.root.textContent, /post:write/); assert.equal(f.root.querySelector('input[type=password]'), null);
  const unregistered = await fixture(t, { invoke: async () => ({ viewerId: 'hub-profile', node: null, relays: [], devices: [] }) }); assert.match(unregistered.root.textContent, /未登録/); assert.equal(unregistered.root.querySelector('textarea'), null); assert.equal(unregistered.button('この端末を失効'), undefined);
});
test('relay changes need a preview and final confirmation; editing invalidates a captured plan', async t => {
  const f = await fixture(t); f.input('https://new.example/'); f.button('接続先を確認').click(); assert.equal(writes(f).length, 0); assert.match(f.root.textContent, /保存する接続先: https:\/\/new.example/);
  const staleSave = f.button('確認して保存').onclick; f.input('https://other.example'); await staleSave(); assert.equal(writes(f).length, 0);
  f.button('接続先を確認').click(); await f.button('確認して保存').onclick(); assert.deepEqual(writes(f)[0].args, { action: 'personal_node_relays', options: { relays: ['https://other.example'] } }); assert.match(f.root.textContent, /保存しました/); assert.equal(f.root.querySelector('textarea').value, 'https://other.example');
  f.input(''); f.button('接続先を確認').click(); assert.match(f.root.textContent, /すべて解除/); await f.button('確認して保存').onclick(); assert.deepEqual(writes(f).at(-1).args.options.relays, []);
});
test('unsafe, duplicate and over-limit relay entries never expose a final save action', async t => {
  const f = await fixture(t); for (const value of ['http://relay.example', 'https://localhost', 'https://127.0.0.1', 'https://192.168.1.2', 'https://user:secret@relay.example', 'https://relay.example/path', 'https://relay.example?q=1', 'https://relay.example#x', 'https://relay.example:444', 'https://a.example\nhttps://A.example/', 'https://a.example\nhttps://b.example\nhttps://c.example\nhttps://d.example', 'x'.repeat(2049)]) { f.input(value); f.button('接続先を確認').click(); assert.equal(f.button('確認して保存'), undefined); } assert.equal(writes(f).length, 0);
});
test('device revocation confirms the exact device and receipt; failed writes keep controls and drafts', async t => {
  const f = await fixture(t); f.button('この端末を失効').click(); assert.equal(writes(f).length, 0); assert.match(f.root.textContent, /This PC（device-1）/); await f.button('確認して端末を失効').onclick(); assert.deepEqual(writes(f)[0].args, { action: 'personal_node_device_revoke', target: 'device-1' }); assert.equal(f.button('この端末を失効'), undefined); assert.match(f.root.textContent, /失効/);
  const failed = await fixture(t); failed.failedWrite = true; failed.input('https://pending.example'); failed.button('接続先を確認').click(); await failed.button('確認して保存').onclick(); assert.equal(failed.root.querySelector('textarea').value, 'https://pending.example'); assert.match(failed.root.textContent, /保存結果を確認できません/); assert.equal(failed.button('確認して保存').disabled, false);
});
test('account and view changes prevent stale reads and writes from updating another view', async t => {
  const waiting = deferred(); let key = 'old', current = true; const dom = new JSDOM('<body>'), calls = []; const controller = createPersonalNodeDashboard(dom.window.document, { getAccount: () => key, isCurrent: () => current, invoke: async (...args) => { calls.push(args); return waiting.promise; } }); key = 'new'; waiting.resolve(state()); await controller.ready; assert.doesNotMatch(controller.element.textContent, /This PC/); current = false; await controller.reload(); assert.equal(calls.length, 1); controller.dispose(); dom.window.close();
  const f = await fixture(t); f.button('この端末を失効').click(); const final = f.button('確認して端末を失効').onclick; f.account = 'other-generation'; await final(); assert.equal(writes(f).length, 0);
  const pending = deferred(), stale = await fixture(t, { invoke: async name => name === 'hub_client' ? state() : pending.promise }); stale.button('この端末を失効').click(); const operation = stale.button('確認して端末を失効').onclick(); const snapshot = stale.root.textContent; stale.current = false; pending.resolve({ revoked: true, deviceId: 'device-1' }); await operation; assert.equal(stale.root.textContent, snapshot);
});
test('account change erases old registration immediately and reload errors never show old metadata', async t => {
  const f = await fixture(t); f.account = null; f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed')); await tick(); assert.doesNotMatch(f.root.textContent, /This PC|node.example|relay.example/); assert.match(f.root.textContent, /Hubへ接続/);
  let succeeds = true; const failed = await fixture(t, { invoke: async () => { if (!succeeds) throw Error('401'); return state(); } }); succeeds = false; await failed.controller.reload(); assert.doesNotMatch(failed.root.textContent, /This PC/); assert.match(failed.root.textContent, /取得できません/);
});
test('malformed metadata and wrong acknowledgements stay unavailable or preserve the previous snapshot', async t => {
  for (const data of [null, { ...state(), viewerId: '' }, { ...state(), relays: [{ relayUrl: 'http://relay.example', priority: 0, enabled: 1 }] }, { ...state(), devices: [{ ...state().devices[0], scopes: ['unknown'] }] }, { ...state(), devices: Array(257).fill(state().devices[0]) }]) { const f = await fixture(t, { invoke: async () => data }); assert.match(f.root.textContent, /取得できません/); assert.equal(f.button('この端末を失効'), undefined); }
  for (const result of [{ revoked: true, deviceId: 'wrong' }, { revoked: false, deviceId: 'device-1' }, null]) { const f = await fixture(t, { invoke: async name => name === 'hub_client' ? state() : result }); f.button('この端末を失効').click(); await f.button('確認して端末を失効').onclick(); assert.ok(f.button('この端末を失効')); assert.match(f.root.textContent, /保存結果を確認できません/); }
});
test('public labels are literal text and an absent account causes no IPC', async t => {
  const data = state(); data.devices[0].label = '<img src=x onerror=bad()>'; const f = await fixture(t, { invoke: async () => data }); assert.match(f.root.textContent, /<img src=x/); assert.equal(f.root.querySelector('img'), null);
  const absent = await fixture(t, { getAccount: () => null }); assert.equal(absent.calls.length, 0);
});

test('active devices accept all seven Federation scopes while unknown and over-limit scope lists stay unavailable',async t=>{
  const allowed=['profile:write','post:write','content:write','follow:write','preference:write','agent:delegate','relay:receive'];
  const data=state();data.devices[0].scopes=allowed;const f=await fixture(t,{invoke:async()=>data});
  assert.ok(f.button('この端末を失効'));for(const scope of allowed)assert.ok(f.root.textContent.includes(scope));assert.doesNotMatch(f.root.textContent,/取得できません/);
  for(const scopes of [[...allowed.slice(0,6),'admin:write'],[...allowed,'profile:write']]){const invalid=state();invalid.devices[0].scopes=scopes;const bad=await fixture(t,{invoke:async()=>invalid});assert.match(bad.root.textContent,/取得できません/);assert.equal(bad.button('この端末を失効'),undefined);}
});

async function registrationFixture(t, initialNode = null) {
  const dom = new JSDOM('<body></body>'), f = { dom, current:true, account:'generation-1', data:{viewerId:'hub-profile',node:initialNode,relays:[],devices:[]}, calls:[], failRead:false, unknown:false, waiting:null };
  const thumb='a'.repeat(64), previewId='550e8400-e29b-41d4-a716-446655440000';
  f.controller=createPersonalNodeDashboard(dom.window.document,{getAccount:()=>f.account,isCurrent:()=>f.current,invoke:async(name,args)=>{
    f.calls.push({name,args});
    if(name==='hub_client'){if(f.failRead)throw Error('unavailable');return f.data;}
    if(name==='personal_node_registration_prepare')return f.waiting?.promise??{previewId,viewerId:f.data.viewerId,nodeUrl:args.nodeUrl,keyThumbprint:thumb,expiresAt:new Date(Date.now()+600000).toISOString(),hubOrigin:'http://127.0.0.1:3020'};
    if(name==='personal_node_registration_complete'){
      if(!args.confirmed)return {cancelled:true};
      if(f.unknown)throw Error('personal_node_registration_unknown');
      f.data={...f.data,node:{nodeUrl:'https://node.example',keyThumbprint:thumb,status:'active'}};
      return {registered:true,viewerId:f.data.viewerId,nodeUrl:f.data.node.nodeUrl,keyThumbprint:thumb};
    }
    throw Error('unexpected_command');
  }});
  dom.window.document.body.append(f.controller.element);f.root=f.controller.element;
  f.button=label=>[...f.root.querySelectorAll('button')].find(node=>node.textContent===label);
  f.draft=()=>{const input=f.root.querySelector('input[type=url]');input.value='https://node.example';input.dispatchEvent(new dom.window.Event('input'));};
  f.click=async label=>{f.button(label).click();await tick();};
  f.complete=confirmed=>f.calls.filter(call=>call.name==='personal_node_registration_complete'&&call.args.confirmed===confirmed);
  t.after(()=>{f.controller.dispose();dom.window.close();});await f.controller.ready;return f;
}

test('dashboard offers registration only for an authenticated absent node and rereads the same viewer after explicit registration',async t=>{
  const f=await registrationFixture(t);assert.ok(f.root.querySelector('input[type=url]'));assert.equal(f.complete(true).length,0);
  f.draft();await f.click('登録内容を確認');assert.equal(f.complete(true).length,0);assert.ok(f.button('確認して登録'));
  await f.click('確認して登録');assert.equal(f.complete(true).length,1);assert.equal(f.root.querySelector('input[type=url]'),null);assert.match(f.root.textContent,/登録済み.*https:\/\/node.example/);
  assert.equal(f.calls.filter(call=>call.name==='hub_client').length,2);
  for(const status of ['active','revoked']){const existing=await registrationFixture(t,{nodeUrl:'https://existing.example',keyThumbprint:'b'.repeat(64),status});assert.equal(existing.root.querySelector('input[type=url]'),null);assert.equal(existing.button('登録内容を確認'),undefined);}
  const absent=await registrationFixture(t);absent.account=null;absent.dom.window.dispatchEvent(new absent.dom.window.Event('hub-account-changed'));await tick();assert.equal(absent.root.querySelector('input[type=url]'),null);
});

test('dashboard reload, invalidation, account change and disposal cancel previews and reject captured old confirmations',async t=>{
  for(const operation of ['reload','invalidate','account','hidden-account','dispose']){
    const f=await registrationFixture(t);f.draft();await f.click('登録内容を確認');const final=f.button('確認して登録').onclick;
    if(operation==='reload')await f.controller.reload();
    if(operation==='invalidate')f.controller.invalidate();
    if(operation.includes('account')){f.account='generation-2';if(operation==='hidden-account')f.current=false;f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));await tick();}
    if(operation==='dispose')f.controller.dispose();
    await final();assert.equal(f.complete(true).length,0,operation);assert.equal(f.complete(false).length,1,operation);assert.doesNotMatch(f.root.textContent,/公開鍵の指紋: a{64}/);
  }
  const f=await registrationFixture(t);f.waiting=deferred();f.draft();await f.click('登録内容を確認');f.account=null;f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));
  f.waiting.resolve({previewId:'550e8400-e29b-41d4-a716-446655440000'});await tick();assert.equal(f.complete(false).length,1);assert.equal(f.complete(true).length,0);assert.equal(f.root.querySelector('input[type=url]'),null);
});

test('unknown registration locks another attempt until explicit authoritative reload; failed or wrong-viewer reload stays unavailable',async t=>{
  const f=await registrationFixture(t);f.unknown=true;f.draft();await f.click('登録内容を確認');await f.click('確認して登録');
  assert.equal(f.button('登録内容を確認').disabled,true);assert.equal(f.button('キャンセル').disabled,true);assert.equal(f.complete(true).length,1);
  await f.click('状態を再確認');assert.equal(f.complete(true).length,1);assert.equal(f.button('登録内容を確認').disabled,false);assert.equal(f.calls.filter(call=>call.name==='personal_node_registration_prepare').length,1);
  for(const failure of ['unavailable','wrong-viewer']){
    const bad=await registrationFixture(t);bad.unknown=true;bad.draft();await bad.click('登録内容を確認');await bad.click('確認して登録');
    if(failure==='unavailable')bad.failRead=true;else bad.data={...bad.data,viewerId:'other-profile'};
    await bad.click('状態を再確認');assert.equal(bad.root.querySelector('input[type=url]'),null);assert.match(bad.root.textContent,/取得できません/);assert.equal(bad.complete(true).length,1);
  }
});
