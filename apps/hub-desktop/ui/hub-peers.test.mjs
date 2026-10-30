import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {initHubPeers} from './hub-peers.mjs';
test('P2P registration and delivery require separate explicit confirmations',async()=>{
 const dom=new JSDOM('<main><section id="hub-network-manager"></section></main>');const document=dom.window.document,calls=[];
 const control=initHubPeers({document,invoke:async(name,args)=>{calls.push([name,args]);if(args.action==='list')return {peers:[{peerId:'peer',nodeId:'https://peer.example'}],events:[{sequence:1,title:'Public document'}],inbox:[]};if(args.action==='preview')return {previewId:'preview',nodeId:'https://peer.example',signingKeyThumbprint:'signing-public-fingerprint',encryptionKeyThumbprint:'encryption-public-fingerprint'};return {status:'received',deliveryId:'delivery'};}});
 await control.load();const form=document.querySelector('form');form.querySelector('input').value='https://peer.example';await form.onsubmit({preventDefault(){}});
 const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
 assert.equal(button('この相手を登録').disabled,true);assert.equal(calls.some(([,a])=>a.action==='confirm'),false);
 const check=document.querySelector('input[type=checkbox]');check.checked=true;check.onchange();await button('この相手を登録').onclick();assert.equal(calls.find(([,a])=>a.action==='confirm')[1].confirmed,true);
 button('送信内容を確認').click();assert.equal(calls.some(([,a])=>a.action==='deliver'),false);
 await button('確認して送信').onclick();const sent=calls.find(([,a])=>a.action==='deliver')[1];assert.deepEqual(sent,{action:'deliver',peerId:'peer',sequence:1,confirmed:true});assert.match(document.body.textContent,/received/);dom.window.close();
});

test('Desktop file transfer stays inside Hub and closes on leaving its view', async () => {
 const dom=new JSDOM('<main><section id="hub-network-manager"></section></main>'), document=dom.window.document,calls=[];
 let config,closed=0;
 const control=initHubPeers({document,invoke:async(...args)=>calls.push(args),createP2P:(host,options)=>{config=options;host.textContent='Native transfer';return{ready:Promise.resolve(),dispose:()=>closed++};}});
 const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='PC・スマホとファイルを送受信');
 await button.onclick(); assert.deepEqual(calls,[]); assert.equal(typeof config.invoke,'function'); assert.match(document.body.textContent,/Native transfer/);
 control.closeTransfer(); assert.equal(closed,1); assert.equal(button.disabled,false); assert.doesNotMatch(document.body.textContent,/Native transfer/);
 await button.onclick(); control.closeTransfer(); assert.equal(closed,2); dom.window.close();
});

test('account changes close Native transfer and permit reopening without Web handoff',async()=>{
 const dom=new JSDOM('<main><section id="hub-network-manager"></section></main>'),document=dom.window.document;let closed=0;
 initHubPeers({document,invoke:()=>{throw Error('unexpected request')},createP2P:()=>({ready:Promise.resolve(),dispose:()=>closed++})});
 const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='PC・スマホとファイルを送受信');await button.onclick();
 dom.window.dispatchEvent(new dom.window.Event('hub-account-changed'));assert.equal(closed,1);assert.equal(button.disabled,false);assert.equal(button.textContent,'PC・スマホとファイルを送受信');
 await button.onclick();await button.onclick();assert.equal(closed,2);dom.window.close();
});