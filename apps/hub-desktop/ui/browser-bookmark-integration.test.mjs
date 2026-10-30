import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
import {initBrowserWorkspace} from './browser-workspace.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom'),html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const tick=()=>new Promise(setImmediate),deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function fixture(t){
 const dom=new JSDOM(html,{url:'http://fixture.invalid/',pretendToBeVisual:true}),document=dom.window.document;
 const f={dom,document,active:true,view:'browser',calls:[],events:{},favorites:[{url:'https://bookmark.example/',title:'First bookmark',folder:''}],tabs:[{id:1,url:'https://a.example/',title:'A',active:true},{id:2,url:'https://b.example/',title:'B',active:false}],close:null};
 dom.window.localStorage.setItem('hub.browser.bookmarkBar','1'); // shown, as a user who turned it on
 dom.window.matchMedia=()=>({matches:false,addEventListener(){}});dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
 dom.window.__TAURI__={event:{listen:async(name,fn)=>{f.events[name]=fn;return()=>{};}}};
 const invoke=async(name,args)=>{
  f.calls.push({name,args});if(name==='browser_workspace_snapshot')return{version:1,tabs:f.tabs,favorites:f.favorites,history:[]};
  if(['browser_downloads','browser_site_requests'].includes(name))return[];if(name==='browser_session_status')return 0;
  if(name==='browser_reader_read')return{id:args.id,url:args.url,title:'Synthetic reader',paragraphs:['Synthetic text.'],truncated:false,contextToken:'reader-fixed'};
  if(name==='browser_reader_open')return{id:args.id,contextToken:args.contextToken,opened:true};
  if(name==='browser_reader_close'){if(f.close)await f.close.promise;return{closed:true};}
 };
 f.controller=initBrowserWorkspace({document,window:dom.window,invoke,icon:()=>'<svg></svg>',enterBrowser:async()=>{},isActive:()=>f.active,getView:()=>f.view,onAiDraft:async()=>{}});
 t.after(()=>dom.window.close());await tick();f.calls.length=0;return f;
}
test('workspace refresh updates bar after existing edits/moves, CtrlShiftB/menu toggle and private-safe fixed gestures reuse existing IPC',async t=>{
 const f=await fixture(t),host=f.document.querySelector('#browser-bookmark-bar');assert.match(host.textContent,/First bookmark/);
 host.querySelector('[data-bookmark-url]').click();await tick();assert.deepEqual(f.calls.find(call=>call.name==='browser_navigate_from_address').args,{id:1,url:'https://bookmark.example/'});assert.equal(f.calls.some(call=>call.name==='browser_navigate'),false);
 f.favorites=[{url:'https://changed.example/',title:'Updated bookmark',folder:''}];await f.controller.refresh();assert.match(host.textContent,/Updated bookmark/);assert.equal(host.textContent.includes('First bookmark'),false);
 const key=(repeat=false)=>new f.dom.window.KeyboardEvent('keydown',{key:'B',ctrlKey:true,shiftKey:true,repeat,bubbles:true,cancelable:true});f.document.body.dispatchEvent(key());assert.equal(host.hidden,true);f.document.body.dispatchEvent(key(true));assert.equal(host.hidden,true);f.document.body.dispatchEvent(key());assert.equal(host.hidden,false);
 f.document.querySelector('#browser-tools').click();const top=[...f.document.querySelectorAll('#browser-menu button')],toggle=top.find(node=>node.textContent==='ブックマークバーを隠す');assert.ok(toggle,'toggle is on the top level of the browser menu');assert.equal(toggle.dataset.keys,'Ctrl+Shift+B');toggle.click();assert.equal(host.hidden,true);
 f.document.querySelector('#browser-tools').click();[...f.document.querySelectorAll('#browser-menu button')].find(node=>node.textContent==='その他の操作').click();assert.equal([...f.document.querySelectorAll('#browser-menu button')].some(node=>/ブックマークバー/.test(node.textContent)),false,'no longer nested under その他の操作');
});
test('bookmark source tab is pinned across delayed reader close; changed tab or view performs zero page opens',async t=>{
 for(const change of ['tab','view']){
  const f=await fixture(t);f.document.querySelector('#browser-tools').click();f.document.querySelector('[data-browser-reader]').click();for(let i=0;i<8&&f.document.querySelector('#browser-reader').hidden;i++)await tick();assert.equal(f.document.querySelector('#browser-reader').hidden,false);
  f.close=deferred();f.calls.length=0;f.document.querySelector('#browser-bookmark-bar [data-bookmark-url]').click();await tick();assert.ok(f.calls.some(call=>call.name==='browser_reader_close'));
  if(change==='tab'){f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===2}));await f.controller.refresh();}else{f.active=false;f.view='ai';f.controller.cancelPendingFocus();}
  f.close.resolve();await tick();await tick();assert.equal(f.calls.some(call=>['browser_navigate','browser_navigate_from_address','browser_open_tab'].includes(call.name)),false,change);
 }
});
