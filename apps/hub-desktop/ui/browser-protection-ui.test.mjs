import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createBrowserProtection} from './browser-protection-ui.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const status=(extra={})=>({version:1,supported:true,enabled:true,ready:true,blockedCount:12,listsVersion:'EasyList 2026-10-07 / EasyPrivacy 2026-10-07',...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate());}
function rig(t,{invoke,beforeOpen}={}){
  const dom=new JSDOM('<main id="view-browser"><div id="bar"></div></main>'),document=dom.window.document,calls=[],errors=[];let active=true,value=status();
  const controller=createBrowserProtection({document,isCurrent:()=>active,beforeOpen,invoke:async(name,args)=>{
    calls.push({name,args});return invoke?invoke(name,args):structuredClone(value);},onError:error=>errors.push(error)});
  document.querySelector('#bar').append(controller.button);document.querySelector('main').append(controller.element);
  t.after(()=>{controller.dispose();dom.window.close();});
  const toggle=controller.element.querySelector('input'),recheck=[...controller.element.querySelectorAll('button')].find(button=>button.textContent==='状態を再確認');
  return{dom,document,calls,errors,controller,toggle,recheck,setActive:value=>{active=value;},setStatus:next=>{value=next;},
    async open(){controller.button.click();await until(()=>controller.button.getAttribute('aria-expanded')==='true'&&controller.button.disabled===false);},
    change(enabled){toggle.checked=enabled;toggle.dispatchEvent(new dom.window.Event('change',{bubbles:true}));}};
}

test('construction does not invoke; shield and global panel use native controls and exact status',async t=>{
  const r=rig(t);assert.deepEqual(r.calls,[]);assert.equal(r.controller.button.type,'button');
  assert.equal(r.controller.button.querySelector('svg').getAttribute('width'),'17');await r.open();
  assert.deepEqual(r.calls,[{name:'browser_protection_status',args:{}}]);assert.equal(r.toggle.checked,true);assert.equal(r.toggle.disabled,false);
  assert.match(r.controller.element.textContent,/すべてのタブに適用/);assert.match(r.controller.element.textContent,/この起動中.*12件/);
  assert.match(r.controller.element.textContent,/EasyList.*EasyPrivacy/);
});

test('explicit toggle sends one boolean only, without optimism, reload or duplicate mutation',async t=>{
  const entered=deferred(),gate=deferred();const r=rig(t,{invoke:async(name)=>name==='browser_set_protection'?(entered.resolve(),gate.promise):status()});
  await r.open();r.change(false);await entered.promise;
  assert.equal(r.toggle.checked,true);assert.equal(r.toggle.disabled,true);r.change(false);
  assert.equal(r.calls.filter(call=>call.name==='browser_set_protection').length,1);
  gate.resolve(status({enabled:false,blockedCount:14}));await until(()=>r.toggle.disabled===false);
  assert.equal(r.toggle.checked,false);assert.match(r.controller.element.textContent,/オフ/);
  assert.deepEqual(r.calls.find(call=>call.name==='browser_set_protection').args,{enabled:false});
  assert.equal(r.calls.some(call=>/reload|navigate|tab/u.test(call.name)),false);
});

test('supported false and ready false remain honest unavailable states with manual read',async t=>{
  for(const value of [status({supported:false,ready:false,enabled:false,listsVersion:''}),status({ready:false})]){
    const r=rig(t);r.setStatus(value);assert.equal(await r.controller.load(),false);assert.equal(r.toggle.disabled,true);
    await r.open();assert.equal(r.recheck.hidden,false);r.change(true);assert.equal(r.calls.some(call=>call.name==='browser_set_protection'),false);
    assert.doesNotMatch(r.controller.element.textContent,/ブロックはオン/);
  }
});

test('malformed closed DTOs and private raw errors never become success or leak raw strings',async t=>{
  for(const value of [status({version:2}),status({enabled:'true'}),status({blockedCount:-1}),status({blockedCount:Infinity}),
    status({blockedCount:Number.MAX_SAFE_INTEGER+1}),status({listsVersion:'bad\u0000version'}),status({listsVersion:'\ud800'}),status({listsVersion:'x'.repeat(257)}),
    {...status(),urls:['private']},null,[]]){
    const r=rig(t);r.setStatus(value);assert.equal(await r.controller.load(),false);assert.equal(r.toggle.disabled,true);assert.equal(r.recheck.hidden,false);
  }
  const r=rig(t,{invoke:async()=>{throw Error('private path/token https://secret.invalid/');}});assert.equal(await r.controller.load(),false);
  assert.doesNotMatch(r.controller.element.textContent,/secret|private|token/);assert.deepEqual(r.errors,[{code:'browser_protection_unavailable'}]);
});

test('unknown setter failure only offers readonly confirmation and never resends',async t=>{
  let unknown=false;const r=rig(t,{invoke:async(name)=>{if(name==='browser_set_protection'){unknown=true;throw Error('lost raw ACK');}return status({enabled:unknown?false:true});}});
  await r.open();r.change(false);await until(()=>r.errors.length===1);assert.equal(r.toggle.disabled,true);assert.equal(r.recheck.hidden,false);
  r.change(false);assert.equal(r.calls.filter(call=>call.name==='browser_set_protection').length,1);
  r.recheck.click();await until(()=>r.toggle.disabled===false);assert.equal(r.toggle.checked,false);
  assert.equal(r.calls.filter(call=>call.name==='browser_set_protection').length,1);
});

test('mismatched and malformed setter ACKs keep unknown until a real getter succeeds',async t=>{
  for(const value of [status({enabled:true}),{...status({enabled:false}),applied:true},status({enabled:false,blockedCount:'3'})]){
    const r=rig(t,{invoke:async(name)=>name==='browser_set_protection'?value:status()});await r.open();r.change(false);
    await until(()=>r.errors.some(error=>error.code==='browser_protection_unknown'));assert.equal(r.toggle.disabled,true);assert.equal(r.recheck.hidden,false);
    assert.equal(r.calls.filter(call=>call.name==='browser_set_protection').length,1);
  }
});

test('old getter and beforeOpen after view exit never open or paint a reentered view',async t=>{
  const pending=deferred(),entered=deferred();const r=rig(t,{invoke:async()=>{entered.resolve();return pending.promise;}});
  const read=r.controller.load();await entered.promise;r.setActive(false);r.controller.invalidate();r.setActive(true);
  const before=r.controller.element.textContent;pending.resolve(status({blockedCount:999}));assert.equal(await read,false);assert.equal(r.controller.element.textContent,before);
  const opening=deferred(),f=rig(t,{beforeOpen:()=>opening.promise});f.controller.button.click();f.controller.close();opening.resolve(true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.controller.element.hidden,true);assert.deepEqual(f.calls,[]);
});

test('close/reopen while mutation is pending discards old ACK and permits readonly recovery after it settles',async t=>{
  const entered=deferred(),gate=deferred();let actual=true;const r=rig(t,{invoke:async(name)=>name==='browser_set_protection'?(entered.resolve(),gate.promise):status({enabled:actual})});
  await r.open();r.change(false);await entered.promise;r.controller.invalidate();await r.open();
  assert.equal(r.toggle.disabled,true);assert.equal(r.recheck.disabled,false);actual=false;gate.resolve(status({enabled:false,blockedCount:999}));
  await new Promise(resolve=>setImmediate(resolve));assert.doesNotMatch(r.controller.element.textContent,/999/);
  r.recheck.click();await until(()=>r.toggle.disabled===false);assert.equal(r.toggle.checked,false);
  assert.equal(r.calls.filter(call=>call.name==='browser_set_protection').length,1);
});

test('out-of-order getters do not replace the latest count/version',async t=>{
  const first=deferred(),second=deferred();let count=0;const r=rig(t,{invoke:()=>++count===1?first.promise:second.promise});
  const a=r.controller.load(),b=r.controller.load();second.resolve(status({blockedCount:55}));assert.equal(await b,true);
  first.resolve(status({blockedCount:4}));assert.equal(await a,false);assert.match(r.controller.element.textContent,/55件/);
});

test('Escape closes through keyboard, respects IME, and restores shield focus',async t=>{
  const r=rig(t);await r.open();const ime=new r.dom.window.KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true});
  r.toggle.dispatchEvent(ime);assert.equal(r.controller.element.hidden,false);
  const escape=new r.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});r.toggle.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented,true);assert.equal(r.controller.element.hidden,true);assert.equal(r.document.activeElement,r.controller.button);
});

test('dispose removes both surfaces and ignores every late result',async t=>{
  const entered=deferred(),gate=deferred();const r=rig(t,{invoke:async()=>{entered.resolve();return gate.promise;}});
  const read=r.controller.load();await entered.promise;r.controller.dispose();gate.resolve(status());assert.equal(await read,false);
  assert.equal(r.controller.button.isConnected,false);assert.equal(r.controller.element.isConnected,false);assert.equal(r.calls.length,1);
});
