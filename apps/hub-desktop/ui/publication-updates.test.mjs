import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
import {createPublicationUpdates} from './publication-updates.mjs';
const tick=()=>new Promise(setImmediate),deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const update=(id='one')=>({kind:'music',id,title:'Same title',updatedAt:'2026-10-08T00:00:00Z',href:'/v2/music/works/'+id});
function fixture(t,{invoke}={}){const dom=new JSDOM('<main><article>Existing post</article></main>'),target=dom.window.document.querySelector('main'),calls=[],opened=[];let current=true;
 const controller=createPublicationUpdates(target,{origin:'https://hub.example',isCurrent:()=>current,invoke:invoke??(async(name,args)=>{calls.push({name,args});return{updates:[update(),update('two')]};}),openLink:(...args)=>opened.push(args)});
 t.after(()=>{controller.dispose();dom.window.close();});return{...controller,dom,target,calls,opened,change(){current=false;}};
}
test('only fixed public metadata is read and exact work IDs open without replacing posts',async t=>{const f=fixture(t);await f.ready;
 assert.deepEqual(f.calls,[{name:'hub_detail',args:{name:'research_publication_updates',ids:[]}}]);assert.equal(f.target.querySelector('article').textContent,'Existing post');
 assert.match(f.root.textContent,/配信元: https:\/\/hub.example/);const buttons=f.root.querySelectorAll('.feed-update-row');assert.equal(buttons.length,2);buttons.forEach(button=>button.click());assert.deepEqual(f.opened.map(value=>value[0]),['/v2/music/works/one','/v2/music/works/two']);
});
test('empty data hides only the update area; failures retry independently without duplicate reads',async t=>{let count=0;const pending=deferred();const f=fixture(t,{invoke:async()=>{count++;if(count===1)throw Error('offline');return pending.promise;}});await f.ready;
 assert.equal(f.target.querySelector('article').textContent,'Existing post');assert.match(f.root.textContent,/読み込めません/);const retry=f.root.querySelector('button');const first=retry.onclick();retry.onclick();await tick();assert.equal(count,2);pending.resolve({updates:[]});await first;assert.equal(f.root.hidden,true);assert.ok(f.target.querySelector('article'));
});
test('unsafe envelopes and targets expose no content links and never alter posts',async t=>{for(const value of [null,[],{updates:[] ,privateBody:'not rendered'},{updates:[{...update(),href:'/v2/music/works/other'}]},{updates:[update(),update()]},{updates:Array.from({length:21},(_,i)=>update(String(i)))}]){const f=fixture(t,{invoke:async()=>value});await f.ready;assert.equal(f.root.querySelectorAll('.research-feed-updates button').length,0);assert.ok(f.root.querySelector('button'));assert.doesNotMatch(f.root.textContent,/not rendered/);assert.ok(f.target.querySelector('article'));}});
test('late responses and captured controls are inert after account, origin, view or host changes',async t=>{for(const mode of ['account','origin','view','host','dispose']){
 const pending=deferred(),f=fixture(t,{invoke:()=>pending.promise});await tick();if(mode==='account'||mode==='origin')f.dom.window.dispatchEvent(new f.dom.window.Event('hub-'+mode+'-changed'));else if(mode==='view')f.change();else if(mode==='host')f.target.replaceChildren();else f.dispose();
 pending.resolve({updates:[update()]});await f.ready;assert.equal(f.root.querySelector('.research-feed-updates'),null);assert.deepEqual(f.opened,[]);
 }const f=fixture(t);await f.ready;const button=f.root.querySelector('button');f.change();button.click();assert.deepEqual(f.opened,[]);
});
test('deadline and explicit retry suppress the old result without an automatic request',async t=>{t.mock.timers.enable({apis:['setTimeout']});const pending=deferred();let count=0;const f=fixture(t,{invoke:()=>++count===1?pending.promise:Promise.resolve({updates:[update('fresh')]})});await tick();t.mock.timers.tick(15000);await f.ready;assert.match(f.root.textContent,/時間切れ/);assert.equal(count,1);await f.root.querySelector('button').onclick();pending.resolve({updates:[update('old')]});await tick();assert.equal(count,2);assert.doesNotMatch(f.root.textContent,/old/);f.root.querySelector('button').click();assert.equal(f.opened[0][0],'/v2/music/works/fresh');});

test('removed retry buttons cannot issue a later read after successful retry',async t=>{let count=0;const f=fixture(t,{invoke:async()=>{if(++count===1)throw Error('offline');return{updates:[update()]};}});await f.ready;const old=f.root.querySelector('button');await old.onclick();assert.equal(count,2);await old.onclick();assert.equal(count,2);assert.equal(f.root.querySelectorAll('.research-feed-updates .feed-update-row').length,1);});
test('initially stale or detached hosts issue no read; invalid origins show only the retry state',async t=>{for(const mode of ['stale','detached','origin']){const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());const target=dom.window.document.querySelector('main');if(mode==='detached')target.remove();let calls=0;const f=createPublicationUpdates(target,{origin:mode==='origin'?'https://hub.example/path':'https://hub.example',isCurrent:()=>mode!=='stale',invoke:async()=>{calls++;return{updates:[]};},openLink:()=>assert.fail('Invalid source')});await f.ready;assert.equal(calls,0);if(mode==='origin')assert.ok(f.root.querySelector('button'));f.dispose();}});

import vm from 'node:vm';import {readFileSync} from 'node:fs';

test('actual work navigation rechecks its source after asynchronous browser exit',async t=>{
 const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
 const actual=signature=>{const start=source.indexOf(signature),end=source.indexOf('\n}',start);assert.ok(start>=0&&end>start);return source.slice(start,end+2);};
 for(const path of ['/v2/articles/a','/v2/videos/v','/v2/music/works/m','/v2/research/p','/v2/research/p?document=d&version=7']){
  const exit=deferred(),dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());let current=true;
  const ctx=vm.createContext({document:dom.window.document,URL,URLSearchParams,currentView:'detail',detailTrail:[],detailForwardTrail:[],exitBrowser:()=>exit.promise,viewScroller:()=>null,saveDetailTrail(){},showView(){},renderDetailEntry(){assert.fail('A stale target was rendered');}});
  vm.runInContext(['async function openHubPath(','function detailForHubPath(','async function openDetail('].map(actual).join('\n'),ctx);
  const pending=ctx.openHubPath(path,undefined,()=>current);current=false;exit.resolve();await pending;await tick();assert.equal(ctx.detailTrail.length,0);
 }
});
