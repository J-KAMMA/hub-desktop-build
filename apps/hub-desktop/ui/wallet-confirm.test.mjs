import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import vm from 'node:vm';
const source=(await readFile(new URL('./app.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
const start=source.indexOf('{\n  const dialog = document.querySelector("#wallet-confirm-dialog")');
assert.ok(start>0);
const block=source.slice(start,source.indexOf('const returnToHub',start));
const ID='11111111-1111-4111-8111-111111111111',NEXT='22222222-2222-4222-8222-222222222222',THIRD='33333333-3333-4333-8333-333333333333';
async function fixture(t){
 const dom=new JSDOM(html,{url:'http://localhost'}),{document}=dom.window,listeners=new Map(),calls=[],timers=new Map();
 let time=1000000,timerId=0,invokeResult=()=>Promise.resolve();
 const dialog=document.querySelector('#wallet-confirm-dialog'),approve=document.querySelector('#wallet-confirm-approve'),deny=document.querySelector('#wallet-confirm-deny');
 dialog.showModal=()=>{dialog.setAttribute('open','');};
 dialog.close=()=>{dialog.removeAttribute('open');dialog.dispatchEvent(new dom.window.Event('close'));};
 class Clock extends Date {static now(){return time;}}
 const ctx=vm.createContext({document,window:dom.window,Date:Clock,TextEncoder,
 setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,at:time+ms});return id;},clearTimeout:id=>timers.delete(id),
 invoke:(name,args)=>{calls.push({name,args:{...args}});return invokeResult();}});
 dom.window.__TAURI__={event:{listen:async(name,cb)=>{listeners.set(name,cb);}}};
 await vm.runInContext('(async()=>'+block+')()',ctx);
 const payload=(extra={})=>({id:ID,summary:'送信先・ネットワークの確認 😀',detail:'0xabcdef\n<img onerror="bad()">\n最後の文字😀',expiresAt:time+120000,...extra});
 const emit=extra=>listeners.get('wallet-confirm-request')({payload:payload(extra)});
 const closed=(id,reason='completed')=>listeners.get('wallet-confirm-closed')({payload:{id,reason}});
 const advance=ms=>{time+=ms;for(const [id,timer]of [...timers])if(timer.at<=time&&timers.has(id)){timers.delete(id);timer.fn();}};
 t.after(()=>dom.window.close());
 return {dom,document,dialog,approve,deny,calls,timers,emit,closed,advance,payload,ctx,setResult:fn=>{invokeResult=fn;},setTime:next=>{time=next;}};
}
const responses=f=>f.calls.map(({name,args})=>{assert.equal(name,'wallet_confirm_respond');return args;});

test('actual block renders exact hostile Unicode plaintext and focuses refusal, then approves exactly once',async t=>{
 const f=await fixture(t),p=f.payload();f.emit();assert.equal(f.dialog.open,true);assert.equal(f.document.activeElement,f.deny);assert.equal(f.document.querySelector('#wallet-confirm-summary').textContent,p.summary);assert.equal(f.document.querySelector('#wallet-confirm-detail').textContent,p.detail);assert.equal(f.dialog.querySelector('img'),null);const callback=f.approve.onclick;callback();callback();f.deny.click();assert.deepEqual(responses(f),[{id:ID,approved:true}]);assert.equal(f.dialog.open,false);assert.equal(f.document.querySelector('#wallet-confirm-detail').textContent,'');assert.equal(f.timers.size,0);
});
test('same ID cannot replace immutable display or extend deadline; other ID is refused once without replacing active request',async t=>{
 const f=await fixture(t);f.emit({expiresAt:1000100});const original=f.document.querySelector('#wallet-confirm-detail').textContent;f.emit({summary:'改変',detail:'差替',expiresAt:1120000});f.emit({id:NEXT});f.emit({id:NEXT});assert.equal(f.document.querySelector('#wallet-confirm-detail').textContent,original);assert.deepEqual(responses(f),[{id:NEXT,approved:false}]);assert.equal(f.dialog.open,true);f.advance(100);assert.deepEqual(responses(f),[{id:NEXT,approved:false},{id:ID,approved:false}]);assert.equal(f.dialog.open,false);
});
test('captured old action and old timer cannot respond to a newer request',async t=>{
 const f=await fixture(t);f.emit();const oldApprove=f.approve.onclick,oldDeny=f.deny.onclick,oldTimer=[...f.timers.values()][0].fn;f.deny.click();f.emit({id:NEXT});oldApprove();oldDeny();oldTimer();assert.equal(f.dialog.open,true);assert.equal(f.calls.length,1);f.approve.click();assert.deepEqual(responses(f),[{id:ID,approved:false},{id:NEXT,approved:true}]);
});
test('Escape cancel, unexpected close and pagehide each refuse once',async t=>{
 for(const mode of ['cancel','close','pagehide']){const f=await fixture(t);f.emit();if(mode==='cancel'){const e=new f.dom.window.Event('cancel',{cancelable:true});f.dialog.dispatchEvent(e);assert.equal(e.defaultPrevented,true);}else if(mode==='close')f.dialog.close();else f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));f.dom.window.dispatchEvent(new f.dom.window.Event('pagehide'));f.deny.click();assert.deepEqual(responses(f),[{id:ID,approved:false}]);assert.equal(f.dialog.open,false);assert.equal(f.timers.size,0);}
});
test('expiry fallback refuses once and late approval at exact deadline cannot approve',async t=>{
 const f=await fixture(t);f.emit({expiresAt:1000010});f.advance(10);f.approve.click();assert.deepEqual(responses(f),[{id:ID,approved:false}]);const g=await fixture(t);g.emit({expiresAt:1000010});g.setTime(1000010);g.approve.click();assert.deepEqual(responses(g),[{id:ID,approved:false}]);
});
test('native matching closed ends only its request with no extra response, stale closed cannot dismiss next ID',async t=>{
 const f=await fixture(t);f.emit();f.closed(NEXT);f.closed(ID,'unknown');assert.equal(f.dialog.open,true);f.closed(ID,'expired');assert.equal(f.dialog.open,false);assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);f.emit({id:NEXT});f.closed(ID);f.dialog.dispatchEvent(new f.dom.window.Event('close'));assert.equal(f.dialog.open,true);f.approve.click();assert.deepEqual(responses(f),[{id:NEXT,approved:true}]);
});
test('invalid IDs are ignored; invalid known ID content is denied once without enabling approval',async t=>{
 const f=await fixture(t);for(const id of [null,123,'00000000-0000-0000-0000-000000000000',ID.replace('-4111-','-1111-'),'ABCDEF11-1111-4111-8111-111111111111'])f.emit({id});assert.equal(f.calls.length,0);f.emit({summary:null});f.emit({summary:null});assert.deepEqual(responses(f),[{id:ID,approved:false}]);assert.equal(f.dialog.open,false);assert.equal(f.approve.disabled,true);assert.equal(f.deny.disabled,true);
});
test('invalid expiry widths/types and missing text fail closed before displaying',async t=>{
 const cases=[{expiresAt:1000000},{expiresAt:1120001},{expiresAt:1000000.5},{expiresAt:'1000010'},{expiresAt:Infinity},{expiresAt:Number.MAX_SAFE_INTEGER+1},{detail:undefined},{summary:42},{detail:'\ud800'}];
 for(const extra of cases){const f=await fixture(t);f.emit(extra);assert.deepEqual(responses(f),[{id:ID,approved:false}]);assert.equal(f.dialog.open,false);assert.equal(f.document.querySelector('#wallet-confirm-detail').textContent,'');assert.equal(f.timers.size,0);}
});
test('UTF8 exact byte limits preserve full last byte; Unicode exceeding byte limit is refused',async t=>{
 const f=await fixture(t),detail='😀'.repeat(32768);f.emit({summary:'a'.repeat(8192),detail});assert.equal(f.dialog.open,true);assert.equal(f.document.querySelector('#wallet-confirm-detail').textContent,detail);f.deny.click();
 for(const extra of [{summary:'a'.repeat(8193)},{summary:'😀'.repeat(2049)},{detail:'a'.repeat(131073)},{detail:'😀'.repeat(32769)}]){const g=await fixture(t);g.emit(extra);assert.deepEqual(responses(g),[{id:ID,approved:false}]);assert.equal(g.dialog.open,false);}
});
test('modal unavailable and synchronous or asynchronous response failures stay closed and cannot affect next request',async t=>{
 const f=await fixture(t);f.dialog.showModal=()=>{throw Error('unavailable');};f.emit();assert.deepEqual(responses(f),[{id:ID,approved:false}]);assert.equal(f.timers.size,0);
 const g=await fixture(t);let reject;g.setResult(()=>new Promise((_,no)=>{reject=no;}));g.emit();g.deny.click();g.emit({id:NEXT});reject(Error('late result'));await new Promise(setImmediate);assert.equal(g.dialog.open,true);assert.equal(g.calls.length,1);g.setResult(()=>{throw Error('sync result');});g.deny.click();g.emit({id:THIRD});assert.equal(g.dialog.open,true);assert.deepEqual(responses(g),[{id:ID,approved:false},{id:NEXT,approved:false}]);
});
test('actual outside click handler refuses wallet request while other dialogs retain generic close behavior',async t=>{
 const f=await fixture(t),from=source.indexOf('for (const dialog of document.querySelectorAll("dialog")) {',source.indexOf('// ダイアログの外側'));
 vm.runInContext(source.slice(from,source.indexOf('// タイムラインのタブ',from)),f.ctx);f.emit();f.dialog.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true}));assert.deepEqual(responses(f),[{id:ID,approved:false}]);
});
test('reserved presign error descriptions remain actionable without leaking unknown payloads',async t=>{
 const f=await fixture(t),from=source.indexOf('function shopPaymentError(error) {');vm.runInContext(source.slice(from,source.indexOf('function renderCartReview()',from)),f.ctx);
 assert.match(vm.runInContext('shopPaymentError("wallet_confirm_busy")',f.ctx),/完了してから/);assert.match(vm.runInContext('shopPaymentError("wallet_confirm_unavailable")',f.ctx),/送金は行われていません/);assert.match(vm.runInContext('shopPaymentError("wallet_confirm_busy: secret")',f.ctx),/再送せず/);assert.doesNotMatch(vm.runInContext('shopPaymentError("wallet_confirm_busy: secret")',f.ctx),/secret/);
});
