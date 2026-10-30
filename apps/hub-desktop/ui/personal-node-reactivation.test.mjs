import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createPersonalNodeReactivation} from './personal-node-reactivation.mjs';
const{JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom'),tick=()=>new Promise(setImmediate),instant=Date.parse('2026-10-07T12:00:00.000Z'),thumb='a'.repeat(64),previewId='11111111-1111-4111-8111-111111111111';
const context=()=>({viewerId:'hub-profile',node:{status:'revoked',nodeUrl:'https://node.example',keyThumbprint:thumb,updatedAt:'2026-10-07T11:00:00.000Z'},account:'account-generation',generation:1});
const preview=()=>({previewId,viewerId:'hub-profile',nodeUrl:'https://node.example',keyThumbprint:thumb,revokedAt:'2026-10-07T11:00:00.000Z',expiresAt:'2026-10-07T12:10:00.000Z',hubOrigin:'http://127.0.0.1:3020'});
const ack=()=>({viewerId:'hub-profile',reactivated:true,nodeUrl:'https://node.example',keyThumbprint:thumb});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function fixture(t,{data=context()}={}){
 const dom=new JSDOM('<main data-view-panel="node" class="view on"></main>'),f={dom,data,current:true,time:instant,calls:[],reloads:[],prepare:null,complete:null,reload:null};
 f.controller=createPersonalNodeReactivation(dom.window.document,{getContext:()=>f.data,isCurrent:()=>f.current,now:()=>f.time,invoke:async(name,args)=>{f.calls.push({name,args});if(name==='personal_node_reactivation_prepare')return f.prepare?f.prepare(args):preview();if(name==='personal_node_reactivation_complete')return f.complete?f.complete(args):args.confirmed?ack():{cancelled:true};throw Error('unexpected_command');},onReload:async viewer=>{f.reloads.push(viewer);return f.reload?f.reload(viewer):{viewerId:f.data.viewerId,node:{...f.data.node,status:'active'}};}});
 dom.window.document.querySelector('main').append(f.controller.element);f.root=f.controller.element;f.button=label=>[...f.root.querySelectorAll('button')].find(node=>node.textContent===label);t.after(()=>{f.controller.dispose();dom.window.close();});await tick();return f;
}
const signed=f=>f.calls.filter(call=>call.name==='personal_node_reactivation_complete'&&call.args.confirmed===true),prepared=f=>f.calls.filter(call=>call.name==='personal_node_reactivation_prepare');
test('constructor has zero IPC and shows fixed URL/thumb and device effect without URL/key input',async t=>{
 const f=await fixture(t);assert.equal(f.calls.length,0);assert.equal(f.reloads.length,0);assert.equal(f.root.querySelector('input'),null);assert.match(f.root.textContent,/元の接続先: https:\/\/node.example/);assert.match(f.root.textContent,/失効した端末の権限は復活しません/);assert.match(f.root.textContent,/別の変更・復旧手順/);
 for(const node of [null,{...context().node,status:'active'},{...context().node,keyThumbprint:'legacy-fingerprint'},{...context().node,updatedAt:undefined}]){const invalid=await fixture(t,{data:{...context(),node}});assert.equal(invalid.button('再有効化の内容を確認'),undefined);assert.equal(invalid.calls.length,0);}
});
test('prepare binds exactly original metadata; explicit one-use confirmation verifies ACK then readonly source',async t=>{
 const f=await fixture(t);await f.button('再有効化の内容を確認').onclick();assert.deepEqual(prepared(f)[0].args,{expectedViewerId:'hub-profile',expectedNodeUrl:'https://node.example',expectedKeyThumbprint:thumb});assert.equal(signed(f).length,0);
 const confirm=f.button('確認して再有効化'),gate=deferred();f.complete=()=>gate.promise;const pending=confirm.onclick();assert.equal(await confirm.onclick(),undefined);gate.resolve(ack());await pending;assert.equal(signed(f).length,1);assert.deepEqual(signed(f)[0].args,{previewId,confirmed:true});assert.deepEqual(f.reloads,['hub-profile']);assert.match(f.root.textContent,/有効な登録状態を確認/);await confirm.onclick();assert.equal(signed(f).length,1);
});
test('cancel and expiry perform no signed operation; old confirmation callbacks cannot be replayed',async t=>{
 const f=await fixture(t);await f.button('再有効化の内容を確認').onclick();const old=f.button('確認して再有効化');await f.button('キャンセル').onclick();assert.equal(signed(f).length,0);assert.deepEqual(f.calls.at(-1).args,{previewId,confirmed:false});await old.onclick();assert.equal(signed(f).length,0);
 const expired=await fixture(t);await expired.button('再有効化の内容を確認').onclick();expired.time+=600000;await expired.button('確認して再有効化').onclick();assert.equal(signed(expired).length,0);assert.match(expired.root.textContent,/確認期限/);
});
test('pending prepare double-click is single; wrong revokedAt/receipt/expiry/source never allows signing',async t=>{
 const f=await fixture(t),gate=deferred();f.prepare=()=>gate.promise;const prepare=f.button('再有効化の内容を確認'),pending=prepare.onclick();prepare.click();assert.equal(prepared(f).length,1);gate.resolve(preview());await pending;
 for(const mutate of [value=>({...value,revokedAt:'2026-10-07T10:00:00.000Z'}),value=>({...value,keyThumbprint:'b'.repeat(64)}),value=>({...value,viewerId:'other'}),value=>({...value,nodeUrl:'https://other.example'}),value=>({...value,extra:true}),value=>({...value,expiresAt:'2026-10-07T12:10:01.000Z'})]){const bad=await fixture(t);bad.prepare=()=>mutate(preview());await bad.button('再有効化の内容を確認').onclick();assert.equal(bad.button('確認して再有効化'),undefined);assert.equal(signed(bad).length,0);assert.ok(bad.button('状態を再確認'));}
});
test('source/account/generation mutation after prepare invalidates immutable binding and signs zero',async t=>{
 for(const change of [f=>f.data.node.updatedAt='2026-10-07T10:00:00.000Z',f=>f.data.node.nodeUrl='https://other.example',f=>f.data.node.keyThumbprint='b'.repeat(64),f=>f.data.viewerId='other',f=>f.data.account='other',f=>f.data.generation++]){
  const f=await fixture(t);await f.button('再有効化の内容を確認').onclick();const old=f.button('確認して再有効化');change(f);await old.onclick();assert.equal(signed(f).length,0);assert.equal(f.button('確認して再有効化'),undefined);assert.match(f.root.textContent,/画面が変わりました/);
 }
});
test('delayed prepare is dropped for account/origin/view-away-return/disposal; no late confirmation UI',async t=>{
 for(const change of ['account','origin','view','dispose']){
  const f=await fixture(t),gate=deferred();f.prepare=()=>gate.promise;const pending=f.button('再有効化の内容を確認').onclick();
  if(change==='dispose')f.controller.dispose();else if(change==='view'){const panel=f.root.parentElement;panel.classList.remove('on');panel.classList.add('on');await tick();}else f.dom.window.dispatchEvent(new f.dom.window.Event(change==='account'?'hub-account-changed':'hub-origin-changed'));
  gate.resolve(preview());await pending;assert.equal(f.button('確認して再有効化'),undefined);assert.equal(signed(f).length,0);
 }
});
test('lost ACK locks signing; explicit readonly recheck observes active without attributing another write',async t=>{
 const f=await fixture(t);await f.button('再有効化の内容を確認').onclick();f.complete=()=>Promise.reject(Error('personal_node_reactivation_unknown'));await f.button('確認して再有効化').onclick();assert.equal(signed(f).length,1);assert.equal(f.reloads.length,0);assert.equal(f.button('再有効化の内容を確認').disabled,true);assert.match(f.root.textContent,/結果が不明/);await f.button('状態を再確認').onclick();assert.equal(signed(f).length,1);assert.match(f.root.textContent,/現在有効.*新たな再有効化は実行していません/);assert.equal(prepared(f).length,1);
});
test('still-revoked read unlocks only fresh explicit prepare; read failure or foreign source stays locked',async t=>{
 const f=await fixture(t);await f.button('再有効化の内容を確認').onclick();f.complete=()=>Promise.reject(Error('personal_node_reactivation_unknown'));await f.button('確認して再有効化').onclick();f.reload=()=>({viewerId:f.data.viewerId,node:{...f.data.node}});await f.button('状態を再確認').onclick();assert.equal(f.button('再有効化の内容を確認').disabled,false);assert.equal(prepared(f).length,1);await f.button('再有効化の内容を確認').onclick();assert.equal(prepared(f).length,2);assert.equal(signed(f).length,1);
 for(const response of [()=>Promise.reject(Error('unavailable')),()=>({viewerId:'other',node:context().node}),()=>({viewerId:'hub-profile',node:{...context().node,nodeUrl:'https://other.example',status:'active'}})]){const bad=await fixture(t);await bad.button('再有効化の内容を確認').onclick();bad.complete=()=>Promise.reject(Error('personal_node_reactivation_unknown'));await bad.button('確認して再有効化').onclick();bad.reload=response;await bad.button('状態を再確認').onclick();assert.equal(bad.button('再有効化の内容を確認').disabled,true);assert.equal(signed(bad).length,1);}
});
test('wrong ACK/source or late complete cannot show success or issue a second signature',async t=>{
 for(const response of [()=>({...ack(),reactivated:false}),()=>({...ack(),viewerId:'other'}),()=>({...ack(),nodeUrl:'https://other.example'}),()=>({...ack(),extra:true})]){const f=await fixture(t);await f.button('再有効化の内容を確認').onclick();f.complete=response;await f.button('確認して再有効化').onclick();assert.equal(f.reloads.length,0);assert.match(f.root.textContent,/結果が不明/);assert.equal(signed(f).length,1);}
 const f=await fixture(t),gate=deferred();await f.button('再有効化の内容を確認').onclick();f.complete=()=>gate.promise;const pending=f.button('確認して再有効化').onclick();f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));gate.resolve(ack());await pending;assert.equal(f.reloads.length,0);assert.equal(f.root.textContent.includes('有効な登録状態を確認'),false);assert.equal(signed(f).length,1);
});
test('dashboard integration mounts revoked only and preserves active relay/devices and initial registration',async t=>{
 const{createPersonalNodeDashboard}=await import('./personal-node-dashboard.mjs');
 for(const status of ['revoked','active',null]){
  const dom=new JSDOM('<body>'),calls=[],data={viewerId:'hub-profile',node:status?{...context().node,status}:null,relays:[],devices:[{deviceId:'device-a',label:'Synthetic device',deviceType:'computer',keyThumbprint:thumb,scopes:['post:write'],status:'active'}]},controller=createPersonalNodeDashboard(dom.window.document,{invoke:async(name,args)=>{calls.push({name,args});if(name==='hub_client')return data;throw Error('synthetic_unavailable');},getAccount:()=> 'account-generation'});
  dom.window.document.body.append(controller.element);t.after(()=>{controller.dispose();dom.window.close();});await controller.ready;const buttons=[...controller.element.querySelectorAll('button')].map(node=>node.textContent);
  assert.equal(buttons.includes('再有効化の内容を確認'),status==='revoked');assert.equal(buttons.includes('この端末を失効'),status==='active');assert.equal(controller.element.querySelector('input[type=url]')!==null,status===null);assert.equal(calls.some(call=>call.name==='personal_node_reactivation_prepare'||call.name==='personal_node_reactivation_complete'),false);
 }
});
test('dashboard verified readonly refresh handles ACK/lost ACK and never adopts a foreign active source',async t=>{
 const{createPersonalNodeDashboard}=await import('./personal-node-dashboard.mjs');
 for(const mode of ['ack','lost','wrong-read']){
  const dom=new JSDOM('<body>'),calls=[];let data={viewerId:'hub-profile',node:{...context().node},relays:[],devices:[]};
  const controller=createPersonalNodeDashboard(dom.window.document,{getAccount:()=> 'account-generation',invoke:async(name,args)=>{
    calls.push({name,args});if(name==='hub_client')return structuredClone(data);
    if(name==='personal_node_reactivation_prepare')return{...preview(),expiresAt:new Date(Date.now()+600000).toISOString()};
    if(name==='personal_node_reactivation_complete'){if(!args.confirmed)return{cancelled:true};data={...data,node:{...data.node,status:'active',...(mode==='wrong-read'?{nodeUrl:'https://other.example'}:{})}};if(mode==='lost')throw Error('personal_node_reactivation_unknown');return ack();}
    throw Error('synthetic_unavailable');}});
  dom.window.document.body.append(controller.element);t.after(()=>{controller.dispose();dom.window.close();});await controller.ready;
  const button=label=>[...controller.element.querySelectorAll('button')].find(node=>node.textContent===label);
  await button('再有効化の内容を確認').onclick();await button('確認して再有効化').onclick();
  if(mode==='lost'){assert.match(controller.element.textContent,/結果が不明/);await button('状態を再確認').onclick();}
  assert.equal(calls.filter(call=>call.name==='personal_node_reactivation_complete'&&call.args.confirmed).length,1);
  if(mode==='wrong-read'){assert.doesNotMatch(controller.element.textContent,/other.example/);assert.ok(button('状態を再確認'));assert.match(controller.element.textContent,/結果が不明/);}
  else{assert.match(controller.element.textContent,/登録済み.*https:\/\/node.example/);assert.match(controller.element.textContent,/現在有効/);assert.equal(button('再有効化の内容を確認'),undefined);}
 }
});
test('closed cancellation receipt and literal identifier widths fail closed without signing',async t=>{
 for(const response of [{cancelled:false},{cancelled:true,extra:true},null]){const f=await fixture(t);await f.button('再有効化の内容を確認').onclick();f.complete=()=>response;await f.button('キャンセル').onclick();assert.equal(signed(f).length,0);assert.equal(f.button('再有効化の内容を確認').disabled,true);assert.match(f.root.textContent,/破棄を確認できません/);assert.ok(f.button('状態を再確認'));}
 const invalid=await fixture(t,{data:{...context(),viewerId:'hub-profile\n'}});assert.equal(invalid.button('再有効化の内容を確認'),undefined);assert.equal(invalid.calls.length,0);
 const trailing=await fixture(t);trailing.prepare=()=>({...preview(),previewId:previewId+'\n'});await trailing.button('再有効化の内容を確認').onclick();assert.equal(trailing.button('確認して再有効化'),undefined);assert.equal(signed(trailing).length,0);
});
