import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {guardWalletChain} from './wallet-network.mjs';
import {AI_PAID_EXECUTION} from './ai-paid-execution.mjs';
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const native=readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');
const registry=native.slice(native.indexOf('.invoke_handler(tauri::generate_handler!['));
const names=new Set(registry.slice(registry.indexOf('[')+1,registry.indexOf(']')).split(',').map(value=>value.trim().split('::').at(-1)));

test('actual parent routes legacy community actions to the registered Native command without changing the request',async()=>{
 const lines=app.split('\n').filter(line=>line.startsWith('const rawInvoke = ')||line.startsWith('const invoke = '));assert.equal(lines.length,2);const source=lines.join('\n');
 const calls=[],receipt=Object.freeze({ok:true}),context={guardWalletChain,AI_PAID_EXECUTION,confirmWalletNetworkSwitch:async()=>assert.fail('no switch prompt for a successful call'),window:{__TAURI__:{core:{invoke:(name,args)=>{assert.ok(names.has(name),`unregistered command: ${name}`);calls.push({name,args});return Promise.resolve(receipt);}}}}};
 vm.createContext(context);vm.runInContext(source+'\nglobalThis.testInvoke=invoke;',context);
 for(const action of ['community_appeal_submit','community_appeal_review','community_guide_propose','community_guide_review','community_membership_review','community_sanction']){
  const request=Object.freeze({action,target:'synthetic-community',requestId:'synthetic-operation',options:Object.freeze({reason:'synthetic'}),text:'synthetic-draft'});
  assert.equal(await context.testInvoke('hub_action',request),receipt);assert.equal(calls.at(-1).name,'hub_client_action');assert.equal(calls.at(-1).args,request);
 }
 const request=Object.freeze({name:'research'});assert.equal(await context.testInvoke('hub_resource',request),receipt);assert.equal(calls.at(-1).name,'hub_resource');assert.equal(calls.at(-1).args,request);
});

test('wallet confirmation and browser extraction enforce bundled main caller before the sensitive operation',()=>{
 const wallet=native.split('fn wallet_confirm_respond(')[1]?.split('\n}')[0];assert.ok(wallet);
 assert.match(wallet,/window:\s*tauri::Webview/);assert.match(wallet,/local_pairing_address\(window.label\(\),\s*&url\)/);
 assert.ok(wallet.indexOf('local_pairing_address(')<wallet.indexOf('desktop_wallet::resolve_confirmation('));
 const browser=readFileSync(new URL('../src-tauri/src/browser_window.rs',import.meta.url),'utf8');
 const send=browser.split('pub async fn browser_send_to_ai(')[1]?.split('\n}')[0];assert.ok(send);
 assert.match(send,/webview:\s*tauri::Webview/);assert.match(send,/browser_media_guard\(&webview\)\?/);
 assert.ok(send.indexOf('browser_media_guard(')<send.indexOf('observe_page('));
});
