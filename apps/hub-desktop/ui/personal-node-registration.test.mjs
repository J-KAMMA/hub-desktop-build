import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createPersonalNodeRegistration} from './personal-node-registration.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function fixture(t){
  const dom=new JSDOM('<body></body>'),f={dom,ctx:{viewerId:'hub-profile',account:'account-generation-1',generation:1,node:null},current:true,time:Date.parse('2026-10-06T00:00:00.000Z'),calls:[],sequence:0,prepare:null,final:null,reads:null,readState:{viewerId:'hub-profile',node:null}};
  f.makePreview=nodeUrl=>({previewId:`11111111-1111-4111-8111-${String(++f.sequence).padStart(12,'0')}`,viewerId:f.ctx.viewerId,nodeUrl,keyThumbprint:'a'.repeat(64),expiresAt:new Date(f.time+60000).toISOString(),hubOrigin:'https://hub.example'});
  f.invoke=async(name,args)=>{f.calls.push({name,args});if(name==='personal_node_registration_prepare'){const result=f.prepare?await f.prepare(args):f.makePreview(args.nodeUrl);f.latest=result;return result;}if(name==='personal_node_registration_complete'){if(!args.confirmed)return {cancelled:true};if(f.final)return f.final(args);f.readState={viewerId:f.latest.viewerId,node:{status:'active',nodeUrl:f.latest.nodeUrl,keyThumbprint:f.latest.keyThumbprint}};return {registered:true,viewerId:f.latest.viewerId,nodeUrl:f.latest.nodeUrl,keyThumbprint:f.latest.keyThumbprint};}if(name==='hub_client')return f.reads?f.reads():f.readState;throw Error('unexpected_command');};
  f.controller=createPersonalNodeRegistration(dom.window.document,{invoke:f.invoke,getContext:()=>f.ctx,isCurrent:()=>f.current,now:()=>f.time,onReload:async viewer=>{assert.equal(viewer,'hub-profile');return f.invoke('hub_client',{name:'personal_node'});}});dom.window.document.body.append(f.controller.element);f.root=f.controller.element;
  f.button=label=>[...f.root.querySelectorAll('button')].find(node=>node.textContent===label);f.input=value=>{const input=f.root.querySelector('input');input.value=value;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};f.click=async label=>{assert.ok(f.button(label),label);f.button(label).click();await tick();};
  t.after(()=>{f.controller.dispose();dom.window.close();});return f;
}
const registrations=f=>f.calls.filter(call=>call.name==='personal_node_registration_complete'&&call.args.confirmed);
const cancellations=f=>f.calls.filter(call=>call.name==='personal_node_registration_complete'&&call.args.confirmed===false);
const prepares=f=>f.calls.filter(call=>call.name==='personal_node_registration_prepare');

test('registration uses metadata preview and an explicit separate confirmation; no key, challenge or signature enters UI or IPC',async t=>{
  const f=await fixture(t);assert.equal(f.calls.length,0);f.prepare=async args=>({...f.makePreview(args.nodeUrl),challenge:'PRIVATE-CHALLENGE',signature:'PRIVATE-SIGNATURE',keyBody:'PRIVATE-KEY-BODY'});
  f.input('https://NODE.example/');await f.click('登録内容を確認');assert.deepEqual(prepares(f)[0].args,{nodeUrl:'https://node.example'});assert.equal(registrations(f).length,0);assert.match(f.root.textContent,/https:\/\/node.example/);assert.match(f.root.textContent,/https:\/\/hub.example/);assert.match(f.root.textContent,new RegExp('a'.repeat(64)));assert.doesNotMatch(f.root.textContent,/PRIVATE-/);
  await f.click('確認して登録');assert.equal(registrations(f).length,1);assert.deepEqual(registrations(f)[0].args,{previewId:f.latest.previewId,confirmed:true});assert.deepEqual(f.calls.at(-1),{name:'hub_client',args:{name:'personal_node'}});assert.match(f.root.textContent,/登録状態を確認しました/);assert.doesNotMatch(JSON.stringify(f.calls),/PRIVATE-/);
});

test('canonical ISO expiry accepts exactly ten minutes and rejects noncanonical or wider numeric representations',async t=>{
  const f=await fixture(t);f.prepare=async args=>({...f.makePreview(args.nodeUrl),expiresAt:new Date(f.time+600000).toISOString()});f.input('https://node.example');await f.click('登録内容を確認');assert.ok(f.button('確認して登録'));assert.match(f.root.textContent,/Hubプロフィール: hub-profile/);
  for(const expiresAt of ['2026-10-06T00:10:00Z','2026-10-06T00:10:00.000+00:00',Date.parse('2026-10-06T00:10:00.000Z')]){const bad=await fixture(t);bad.prepare=async args=>({...bad.makePreview(args.nodeUrl),expiresAt});bad.input('https://node.example');await bad.click('登録内容を確認');assert.equal(bad.button('確認して登録'),undefined);assert.equal(registrations(bad).length,0);}
});

test('unsafe URLs do not prepare and cancelling a valid preview never registers',async t=>{
  const f=await fixture(t);for(const url of ['http://node.example','https://localhost','https://127.0.0.1','https://10.0.0.1','https://192.168.1.2','https://169.254.1.2','https://node.local','https://node.example/path','https://node.example?q=x','https://node.example#x','https://node.example:444','https://user:password@node.example','https://[::1]','x'.repeat(2049)]){f.input(url);await f.click('登録内容を確認');assert.equal(prepares(f).length,0);}
  f.input('https://node.example');await f.click('登録内容を確認');await f.click('キャンセル');assert.equal(registrations(f).length,0);assert.equal(cancellations(f).length,1);assert.equal(f.button('確認して登録'),undefined);assert.equal(f.root.querySelector('input').value,'https://node.example');
});

test('edits, expiry and obsolete confirmation callbacks invalidate a preview without registration',async t=>{
  const f=await fixture(t);f.input('https://node.example');await f.click('登録内容を確認');const old=f.button('確認して登録');f.input('https://other.example');old.click();await tick();assert.equal(registrations(f).length,0);assert.equal(cancellations(f).length,1);
  await f.click('登録内容を確認');f.time=Date.parse(f.latest.expiresAt);await f.click('確認して登録');assert.equal(registrations(f).length,0);assert.equal(f.button('確認して登録'),undefined);assert.match(f.root.textContent,/確認期限/);assert.equal(f.button('登録内容を確認').disabled,false);
});

test('single pending operation blocks repeated prepare and final clicks; edits during prepare discard the later response',async t=>{
  const f=await fixture(t),waiting=deferred();f.prepare=()=>waiting.promise;f.input('https://node.example');await f.click('登録内容を確認');await f.click('登録内容を確認');assert.equal(prepares(f).length,1);f.input('https://edited.example');waiting.resolve(f.makePreview('https://node.example'));await tick();assert.equal(f.button('確認して登録'),undefined);assert.equal(cancellations(f).length,1);assert.equal(f.root.querySelector('input').value,'https://edited.example');
  f.prepare=null;await f.click('登録内容を確認');const final=deferred();f.final=()=>final.promise;await f.click('確認して登録');await f.click('確認して登録');assert.equal(registrations(f).length,1);final.reject(Error('personal_node_registration_unknown'));await tick();assert.equal(f.button('登録内容を確認').disabled,true);
});

test('malformed, wrong-viewer and draft-mismatched previews never expose a usable final command',async t=>{
  const values=[base=>null,base=>({...base,previewId:'bad'}),base=>({...base,viewerId:'other'}),base=>({...base,nodeUrl:'https://other.example'}),base=>({...base,keyThumbprint:'x'.repeat(64)}),base=>({...base,expiresAt:'invalid'}),base=>({...base,expiresAt:'2026-10-06T00:00:00.000Z'}),base=>({...base,expiresAt:'2026-10-06T00:10:00.001Z'}),base=>({...base,hubOrigin:'http://evil.example'})];
  for(const change of values){const f=await fixture(t);f.prepare=async args=>change(f.makePreview(args.nodeUrl));f.input('https://node.example');await f.click('登録内容を確認');assert.equal(registrations(f).length,0);assert.equal(f.button('確認して登録'),undefined);assert.equal(f.button('登録内容を確認').disabled,true);assert.equal(f.button('状態を再確認').hidden,false);}
});

test('account, generation, viewer, node status and view changes prevent both pending results and old confirmations',async t=>{
  for(const stale of [f=>{f.ctx={...f.ctx,account:'other'};},f=>{f.ctx={...f.ctx,generation:2};},f=>{f.ctx={...f.ctx,viewerId:'other'};},f=>{f.ctx={...f.ctx,node:{status:'active'}};},f=>{f.current=false;}]){
    const f=await fixture(t);f.input('https://node.example');await f.click('登録内容を確認');const old=f.button('確認して登録');stale(f);old.click();await tick();assert.equal(registrations(f).length,0);
    const pending=await fixture(t),waiting=deferred();pending.prepare=()=>waiting.promise;pending.input('https://node.example');await pending.click('登録内容を確認');stale(pending);waiting.resolve(pending.makePreview('https://node.example'));await tick();assert.equal(pending.button('確認して登録'),undefined);assert.equal(registrations(pending).length,0);assert.equal(cancellations(pending).length,1);
  }
});

test('unknown final acknowledgements and network failures lock reprepare until explicit same-viewer state confirmation',async t=>{
  for(const result of [null,{registered:false},{registered:true,viewerId:'other'}, {registered:true,viewerId:'hub-profile',nodeUrl:'https://other.example',keyThumbprint:'a'.repeat(64)}, {registered:true,viewerId:'hub-profile',nodeUrl:'https://node.example',keyThumbprint:'b'.repeat(64)},'NETWORK']){
    const f=await fixture(t);f.input('https://node.example');await f.click('登録内容を確認');f.final=async()=>{if(result==='NETWORK')throw Error('personal_node_registration_unknown');return result;};await f.click('確認して登録');assert.match(f.root.textContent,/結果が不明/);assert.equal(f.button('登録内容を確認').disabled,true);assert.equal(f.button('キャンセル').disabled,true);await f.click('登録内容を確認');assert.equal(prepares(f).length,1);
    f.readState={viewerId:'other',node:null};await f.click('状態を再確認');assert.equal(f.button('登録内容を確認').disabled,true);f.readState={viewerId:'hub-profile',node:null};await f.click('状態を再確認');assert.equal(f.button('登録内容を確認').disabled,false);assert.equal(registrations(f).length,1);assert.equal(prepares(f).length,1);
  }
});

test('only the agreed pre-signature errors unlock retry; drafts survive prepare failure',async t=>{
  for(const code of ['invalid_preview','expired','account_changed','identity_changed','origin_changed','existing','invalid_challenge']){
    const f=await fixture(t);f.prepare=async()=>{throw Error(`personal_node_registration_${code}`);};f.input('https://node.example');await f.click('登録内容を確認');assert.equal(f.button('登録内容を確認').disabled,false);assert.equal(f.root.querySelector('input').value,'https://node.example');
    f.prepare=null;await f.click('登録内容を確認');f.final=async()=>{throw Error(`personal_node_registration_${code}`);};await f.click('確認して登録');assert.equal(f.button('登録内容を確認').disabled,false);assert.equal(f.button('確認して登録'),undefined);
  }
  const f=await fixture(t);f.prepare=async()=>{throw Error('personal_node_registration_unavailable');};f.input('https://node.example');await f.click('登録内容を確認');assert.equal(f.button('登録内容を確認').disabled,true);
});

test('invalidation and disposal best-effort cancel previews and late prepare replies without claiming remote cancellation',async t=>{
  const f=await fixture(t);f.input('https://node.example');await f.click('登録内容を確認');f.controller.invalidate();f.controller.invalidate();await tick();assert.equal(cancellations(f).length,1);assert.equal(registrations(f).length,0);assert.equal(f.button('確認して登録'),undefined);assert.doesNotMatch(f.root.textContent,/登録状態を確認しました/);
  const pending=await fixture(t),waiting=deferred();pending.prepare=()=>waiting.promise;pending.input('https://node.example');await pending.click('登録内容を確認');pending.controller.dispose();waiting.resolve(pending.makePreview('https://node.example'));await tick();assert.equal(cancellations(pending).length,1);assert.equal(registrations(pending).length,0);assert.equal(pending.root.isConnected,false);
});
