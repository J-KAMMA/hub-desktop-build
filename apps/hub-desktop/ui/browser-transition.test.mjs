import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const {JSDOM} = createRequire(process.env.HUB_BROWSER_PACKAGE || new URL('../../hub/package.json',import.meta.url))('jsdom');
const source = readFileSync(process.env.HUB_BROWSER_APP_SOURCE || new URL('app.js',import.meta.url),'utf8');
const start = source.indexOf('const browserStage = document.querySelector("#browser-stage");');
const end = source.indexOf('\nif (!startupTool)',start);
assert.ok(start >= 0 && end > start);
// These cases exercise re-entry within the browser; external handoff has its own suite.
function fixture(t) {
  const dom = new JSDOM('<div id="browser-stage"></div><div id="browser-empty" hidden></div><button class="nav-item" data-view="browser"></button>');
  t.after(()=>dom.window.close());
  const calls=[],pending=[];
  const ctx=vm.createContext({document:dom.window.document,currentView:'browser',showView(view){ctx.currentView=view;},invoke(command,args){
    calls.push({command,args});
    if(command !== 'browser_enter') return Promise.resolve();
    return new Promise((resolve,reject)=>pending.push({resolve,reject}));
  }});
  vm.runInContext(source.slice(start,end),ctx);
  return {ctx,calls,pending,hint:dom.window.document.querySelector('#browser-empty'),active:()=>vm.runInContext('browserActive',ctx)};
}
test('old enter failure cannot overwrite a newer successful browser entry',async t=>{
  const f=fixture(t),a=f.ctx.enterBrowser('https://a.example/'),b=f.ctx.enterBrowser('https://b.example/');
  f.pending[1].resolve();await b;f.pending[0].reject(Error('old'));await a;
  assert.equal(f.active(),true);assert.equal(f.hint.hidden,true);assert.equal(f.hint.querySelector('button'),null);
  assert.equal(f.calls.filter(x=>x.command==='browser_enter').length,2);
});
test('old success does not hide the current entry loading state',async t=>{
  const f=fixture(t),a=f.ctx.enterBrowser(),b=f.ctx.enterBrowser();
  f.pending[0].resolve();await a;assert.equal(f.hint.hidden,false);
  f.pending[1].reject(Error('latest'));await b;
  assert.equal(f.active(),false);assert.match(f.hint.textContent,/開けません/);
});
test('entry response after leaving does not mutate another view or expose retry',async t=>{
  for(const reject of [false,true]) {
    const f=fixture(t),a=f.ctx.enterBrowser();await f.ctx.exitBrowser();f.ctx.currentView='threads';
    if(reject)f.pending[0].reject(Error('late'));else f.pending[0].resolve();await a;
    assert.equal(f.active(),false);assert.equal(f.ctx.currentView,'threads');assert.equal(f.hint.querySelector('button'),null);
    assert.equal(f.calls.filter(x=>x.command==='browser_exit').length,1);
  }
});
test('obsolete captured retry cannot replace new browser work',async t=>{
  const f=fixture(t),a=f.ctx.enterBrowser('https://a.example/');f.pending[0].reject(Error('first'));await a;
  const retry=f.hint.querySelector('button').onclick,b=f.ctx.enterBrowser('https://b.example/');
  retry();assert.equal(f.pending.length,2);f.pending[1].resolve();await b;
  retry();assert.equal(f.pending.length,2);assert.equal(f.active(),true);
});
test('leaving a failed entry invalidates its captured retry without duplicate exit',async t=>{
  const f=fixture(t),a=f.ctx.enterBrowser();f.pending[0].reject(Error('first'));await a;
  const retry=f.hint.querySelector('button').onclick;await f.ctx.exitBrowser();retry();
  assert.equal(f.pending.length,1);assert.equal(f.calls.filter(x=>x.command==='browser_exit').length,0);
});
test('current retry uses exact original URL and current view',async t=>{
  const f=fixture(t),url='https://example.test/a?b=1',a=f.ctx.enterBrowser(url);f.pending[0].reject(Error('first'));await a;
  f.hint.querySelector('button').onclick();assert.equal(f.pending.length,2);
  assert.equal(f.calls[1].args.url,url);assert.equal(f.ctx.currentView,'browser');f.pending[1].resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.hint.hidden,true);assert.equal(f.active(),true);
});
test('every browser departure cancels pending tab focus even when already inactive',async t=>{
  const f=fixture(t);let cancelled=0;f.ctx.notify=()=>++cancelled;
  vm.runInContext('browserControls = {cancelPendingFocus: notify};',f.ctx);
  await f.ctx.exitBrowser();assert.equal(cancelled,1);assert.equal(f.calls.length,0);
  const a=f.ctx.enterBrowser();await f.ctx.exitBrowser();assert.equal(cancelled,2);
  f.pending[0].resolve();await a;assert.equal(f.active(),false);
});
