import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createPeerInboxReader,peerInboxBodyReason} from './peer-inbox-reader.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const CONTEXT='a'.repeat(64),DELIVERY='delivery-'+'b'.repeat(64),CONTENT='urn:hub:content:'+'c'.repeat(32);
const scope=(device='device-A',generation=1)=>({key:JSON.stringify(['http://127.0.0.1:3020',device]),generation});
const item=(extra={})=>({context:CONTEXT,deliveryId:DELIVERY,contentId:CONTENT,mediaType:'text/plain',byteLength:200,kind:'text',status:'ready',title:'Synthetic received original',senderNodeId:'https://synthetic.example/',...extra});
const reply=(text='synthetic text',extra={})=>({context:CONTEXT,deliveryId:DELIVERY,contentId:CONTENT,mediaType:'text/plain',text,byteLength:new TextEncoder().encode(text).length,...extra});
const deferred=()=>{let resolve;const promise=new Promise(a=>{resolve=a;});return{promise,resolve};};
function rig(t,options={}){
  const dom=new JSDOM('<main></main>'),document=dom.window.document,calls=[];let currentScope=scope(),active=true;
  const reader=createPeerInboxReader({document,getScope:options.getScope??(()=>currentScope),isCurrent:()=>active,
    invoke:async(name,args)=>{calls.push({name,args});return options.invoke?options.invoke(name,args):reply();}});
  document.querySelector('main').append(reader.element);t.after(()=>{reader.dispose();dom.window.close();});
  return{dom,document,reader,calls,body:reader.element.querySelector('[data-peer-inbox-body]'),setScope:value=>{currentScope=value;},setActive:value=>{active=value;}};
}

test('explicit read has only fixed IDs/context and renders HTML-looking text without interpreting it',async t=>{
  const text='<img src="https://example.invalid/" onerror="unsafe()"> markdown [link](https://example.invalid/)';
  const r=rig(t,{invoke:async()=>reply(text)});assert.deepEqual(r.calls,[]);
  assert.equal(await r.reader.open(item()),true);assert.equal(r.body.textContent,text);assert.equal(r.body.querySelector('img'),null);
  assert.deepEqual(r.calls,[{name:'hub_peer_control',args:{action:'read',deliveryId:DELIVERY,expectedContext:CONTEXT}}]);
  // Ciphertext representation length is deliberately not compared to plaintext length.
  assert.notEqual(item().byteLength,new TextEncoder().encode(text).length);
  r.reader.close();assert.equal(r.body.textContent,'');assert.equal(r.reader.element.hidden,true);
});

test('legacy delivery IDs and every exact supported MIME retain the closed read semantics',async t=>{
  for(const mediaType of ['text/plain','text/markdown','application/json']){
    const legacy='delivery-'+'b'.repeat(32),r=rig(t,{invoke:async()=>reply('{}',{deliveryId:legacy,mediaType})});
    assert.equal(await r.reader.open(item({deliveryId:legacy,mediaType})),true);assert.equal(r.body.textContent,'{}');
  }
});

test('unsupported metadata/missing context never auto-read or request staging/download paths',async t=>{
  const r=rig(t);
  for(const value of [item({context:null}),item({context:CONTEXT+'\n'}),item({deliveryId:DELIVERY+'\n'}),item({contentId:CONTENT+'\n'}),
    item({mediaType:'text/html'}),item({mediaType:'image/png'}),item({mediaType:'text/plain; charset=utf-8'}),item({byteLength:NaN})]){
    assert.ok(peerInboxBodyReason(value));assert.equal(await r.reader.open(value),false);assert.equal(r.body.textContent,'');
  }
  const getter=item();Object.defineProperty(getter,'context',{get(){assert.fail('metadata getter');}});
  assert.equal(await r.reader.open(getter),false);assert.deepEqual(r.calls,[]);
});

test('exact UTF8/UTF16 bounds succeed; oversized bodies, NUL, invalid Unicode and dishonest byteLength fail closed',async t=>{
  for(const text of ['x'.repeat(100000),'😀'.repeat(50000),'界'.repeat(87381)]){
    const r=rig(t,{invoke:async()=>reply(text)});assert.equal(await r.reader.open(item()),true);assert.equal(r.body.textContent,text);
  }
  for(const response of [reply('x'.repeat(100001)),reply('界'.repeat(87382)),reply('x\u0000y'),reply('\ud800'),reply('real',{byteLength:1}),
    reply('real',{byteLength:Number.MAX_SAFE_INTEGER+1}),reply('real',{data:'forbidden base64'}),reply('real',{context:'d'.repeat(64)}),
    reply('real',{deliveryId:'delivery-'+'e'.repeat(64)}),reply('real',{contentId:'urn:hub:content:'+'e'.repeat(32)}),reply('real',{mediaType:'text/markdown'})]){
    const r=rig(t,{invoke:async()=>response});assert.equal(await r.reader.open(item()),false);assert.equal(r.body.textContent,'');
  }
});

test('close during scope preparation suppresses read; a second open during pending work invokes no duplicate',async t=>{
  const scopeGate=deferred(),entered=deferred();const r=rig(t,{getScope:async()=>{entered.resolve();return scopeGate.promise;}});
  const pending=r.reader.open(item());await entered.promise;assert.equal(await r.reader.open(item()),false);r.reader.close();scopeGate.resolve(scope());
  assert.equal(await pending,false);assert.deepEqual(r.calls,[]);assert.equal(r.body.textContent,'');
});

test('close and view departure suppress late body; reopening cannot be overwritten by the old response',async t=>{
  const entered=deferred(),gate=deferred();let count=0;const r=rig(t,{invoke:async()=>{if(++count===1){entered.resolve();return gate.promise;}return reply('new body');}});
  const old=r.reader.open(item());await entered.promise;r.reader.close();assert.equal(await r.reader.open(item()),true);
  gate.resolve(reply('old body'));assert.equal(await old,false);assert.equal(r.body.textContent,'new body');
  r.reader.close();r.setActive(false);assert.equal(await r.reader.open(item()),false);assert.equal(r.body.textContent,'');
});

test('account event, Hub/device/generation changes and explicit node invalidation clear or reject private body',async t=>{
  for(const change of [r=>{r.setScope(scope('device-B',2));},r=>{r.setScope({...scope(),key:JSON.stringify(['https://other.example','device-A'])});},
    r=>{r.dom.window.dispatchEvent(new r.dom.window.Event('hub-account-changed'));},r=>r.reader.invalidate()]){
    const entered=deferred(),gate=deferred(),r=rig(t,{invoke:async()=>{entered.resolve();return gate.promise;}});
    const pending=r.reader.open(item());await entered.promise;change(r);gate.resolve(reply('must not appear'));
    assert.equal(await pending,false);assert.equal(r.body.textContent,'');
  }
  const r=rig(t);await r.reader.open(item());r.dom.window.dispatchEvent(new r.dom.window.Event('hub-account-changed'));assert.equal(r.body.textContent,'');
});

test('null/invalid actor scope and raw errors display only fixed messages; plain stored originals stay honestly unsupported',async t=>{
  for(const getScope of [()=>null,()=>({key:'invalid',generation:1}),()=>({...scope(),generation:NaN})]){
    const r=rig(t,{getScope});assert.equal(await r.reader.open(item()),false);assert.deepEqual(r.calls,[]);
  }
  const r=rig(t,{invoke:async()=>{throw Error('private body/path/token http://secret.invalid/');}});
  assert.equal(await r.reader.open(item()),false);assert.doesNotMatch(r.reader.element.textContent,/secret|private body|token/);
  const unsupported=rig(t,{invoke:async()=>{throw 'node_peer_read_unsupported';}});assert.equal(await unsupported.reader.open(item()),false);
  assert.match(unsupported.reader.element.textContent,/暗号化.*テキスト原本.*未対応/);
});

const peersCode=(await readFile(new URL('./hub-peers.mjs',import.meta.url),'utf8'))
  .replace("from './p2p-transfer-panel.mjs'","from '" + new URL('./p2p-transfer-panel.mjs',import.meta.url).href + "'")
  .replace("from './peer-inbox-reader.mjs'",`from '${new URL('./peer-inbox-reader.mjs',import.meta.url).href}'`);
const {initHubPeers}=await import('data:text/javascript;base64,'+Buffer.from(peersCode).toString('base64'));
test('actual inbox list mounts explicit read, preserves transfer UI, and existing departure hook clears the body',async t=>{
  const dom=new JSDOM('<main><section id="hub-network-manager"></section></main>'),document=dom.window.document,calls=[];
  const control=initHubPeers({document,getScope:()=>scope(),isCurrent:()=>true,createP2P:()=>({ready:Promise.resolve(),dispose(){}}),
    invoke:async(name,args)=>{calls.push({name,args});return args.action==='list'?{context:CONTEXT,peers:[],events:[],inbox:[item()]}:reply();}});
  t.after(()=>{control.dispose();dom.window.close();});await control.load();assert.deepEqual(calls.map(call=>call.args.action),['list']);
  const show=[...document.querySelectorAll('button')].find(button=>button.textContent==='本文を開く');assert.ok(show);await show.onclick();
  assert.equal(document.querySelector('[data-peer-inbox-body]').textContent,'synthetic text');assert.deepEqual(calls.map(call=>call.args.action),['list','read']);
  control.closeTransfer();assert.equal(document.querySelector('[data-peer-inbox-body]').textContent,'');
  await show.onclick();assert.equal(document.querySelector('[data-peer-inbox-body]').textContent,'synthetic text');
  assert.ok([...document.querySelectorAll('button')].some(button=>button.textContent==='PC・スマホとファイルを送受信'));
});

test('actual inbox missing context/unsupported rows have honest disabled controls; account changes discard late list',async t=>{
  const dom=new JSDOM('<main><section id="hub-network-manager"></section></main>'),document=dom.window.document,gate=deferred(),entered=deferred();let deferredRead=false;
  const control=initHubPeers({document,getScope:()=>scope(),isCurrent:()=>true,invoke:async(_name,args)=>{
    assert.equal(args.action,'list');if(deferredRead){entered.resolve();return gate.promise;}return {peers:[],events:[],inbox:[item({mediaType:'image/png'})]};}});
  t.after(()=>{control.dispose();dom.window.close();});await control.load();assert.ok([...document.querySelectorAll('button')].find(button=>button.textContent==='全文未対応')?.disabled);
  deferredRead=true;const pending=control.load();await entered.promise;dom.window.dispatchEvent(new dom.window.Event('hub-account-changed'));
  gate.resolve({context:CONTEXT,peers:[],events:[],inbox:[item()]});await pending;
  assert.equal([...document.querySelectorAll('button')].some(button=>button.textContent==='本文を開く'),false);
});
