import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {createBrowserVerticalTabs} from './browser-vertical-tabs.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(setImmediate);
// saved '0' = the narrow strip the user chose; null = no saved choice (pinned column by default).
function setup(t,{width=true,saved='0',horizontal=false}={}){
 const dom=new JSDOM('<div class="app-shell browser-active"><aside class="sidebar"><div id="sidebar-tabs"><button id="pin">Pin</button><button id="tab">Tab</button></div></aside><div id="tabbar"></div><div id="menu" hidden></div><input id="outside"></div>',{url:'http://fixture.invalid/'}),window=dom.window,document=window.document,shell=document.querySelector('.app-shell'),panel=document.querySelector('#sidebar-tabs'),pin=document.querySelector('#pin'),menu=document.querySelector('#menu');
 const listeners=new Set(),media={matches:width,addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)};window.matchMedia=()=>media;
 const timers=new Map();let serial=0;window.setTimeout=fn=>{const id=++serial;timers.set(id,fn);return id;};window.clearTimeout=id=>timers.delete(id);
 if(saved!==null)window.localStorage.setItem('hub.browser.verticalTabsPinned.v2',saved);
 if(horizontal){shell.classList.add('browser-tabs-horizontal');document.querySelector('#tabbar').append(panel);}
 const state={current:true,blocked:false,mainFocus:true};document.hasFocus=()=>state.mainFocus;
 const controller=createBrowserVerticalTabs({document,window,shell,panel,pin,menu,isCurrent:()=>state.current,isBlocked:()=>state.blocked});
 const fire=(node,type)=>node.dispatchEvent(new window.Event(type,{bubbles:!['pointerenter','pointerleave'].includes(type)}));
 const flush=async()=>{await tick();for(const[id,fn]of [...timers]){timers.delete(id);fn();}await tick();};
 t.after(()=>{controller.destroy();dom.window.close();});return{window,document,shell,panel,pin,menu,controller,state,media,listeners,fire,flush,sidebar:document.querySelector('.sidebar'),open:()=>shell.classList.contains('browser-tabs-peek-open')};
}
test('default icon rail; hover expands; delayed leave and focus preserve selected keyboard target',async t=>{
 const f=setup(t);assert.equal(f.open(),false);assert.ok(f.shell.classList.contains('browser-tabs-peek'));
 f.fire(f.sidebar,'pointerenter');assert.equal(f.open(),true);f.fire(f.sidebar,'pointerleave');assert.equal(f.open(),true);await f.flush();assert.equal(f.open(),false);
 const tab=f.document.querySelector('#tab');tab.focus();assert.equal(f.open(),true);f.fire(f.sidebar,'pointerleave');await f.flush();assert.equal(f.open(),true);assert.equal(f.document.activeElement,tab);
 f.document.querySelector('#outside').focus();await f.flush();assert.equal(f.open(),false);
});
test('menu and drag retain width until completion, without changing tab operations',async t=>{
 const f=setup(t);f.fire(f.sidebar,'pointerenter');f.menu.hidden=false;await tick();f.fire(f.sidebar,'pointerleave');await f.flush();assert.equal(f.open(),true);
 f.menu.hidden=true;await f.flush();assert.equal(f.open(),false);
 f.fire(f.panel,'dragstart');f.fire(f.sidebar,'pointerleave');await f.flush();assert.equal(f.open(),true);f.fire(f.document,'dragend');await f.flush();assert.equal(f.open(),false);
});
test('opening the browser menu does not widen the collapsed column over the page',async t=>{
 const f=setup(t);await f.flush();assert.equal(f.open(),false);
 f.menu.hidden=false;await tick();await f.flush();assert.equal(f.open(),false);assert.equal(f.shell.classList.contains('browser-tabs-peek'),true);
 f.fire(f.sidebar,'pointerenter');assert.equal(f.open(),true);f.fire(f.sidebar,'pointerleave');await f.flush();assert.equal(f.open(),true);
 f.menu.hidden=true;await f.flush();assert.equal(f.open(),false);
});
test('pinned column is the default and sits beside the page; unpin returns to the strip; quota does not break runtime',async t=>{
 const pinned=()=>f.shell.classList.contains('browser-tabs-pinned'),peek=()=>f.shell.classList.contains('browser-tabs-peek');
 const f=setup(t,{saved:null});assert.equal(pinned(),true);assert.equal(peek(),false);assert.equal(f.pin.hidden,false);assert.equal(f.pin.getAttribute('aria-pressed'),'true');
 f.pin.click();await f.flush();assert.equal(pinned(),false);assert.equal(peek(),true);assert.equal(f.open(),false);assert.equal(f.window.localStorage.getItem('hub.browser.verticalTabsPinned.v2'),'0');
 f.pin.click();await tick();assert.equal(pinned(),true);assert.equal(peek(),false);assert.equal(f.window.localStorage.getItem('hub.browser.verticalTabsPinned.v2'),'1');
 Object.defineProperty(f.window.Storage.prototype,'setItem',{value(){throw Error('quota');}});f.pin.click();await f.flush();assert.equal(pinned(),false);
 const restored=setup(t,{saved:'1'});assert.equal(restored.shell.classList.contains('browser-tabs-pinned'),true);
});
test('horizontal initial state, mobile, native apps, explicit close and exited view never gain hover ownership',async t=>{
 const f=setup(t,{horizontal:true});assert.equal(f.shell.classList.contains('browser-tabs-peek'),false);assert.equal(f.pin.hidden,true);
 f.sidebar.append(f.panel);f.shell.classList.remove('browser-tabs-horizontal');await tick();assert.ok(f.shell.classList.contains('browser-tabs-peek'));
 for(const name of ['apps-active','sidebar-collapsed']){f.shell.classList.add(name);await tick();f.fire(f.sidebar,'pointerenter');assert.equal(f.shell.classList.contains('browser-tabs-peek'),false);assert.ok(f.shell.classList.contains(name));f.shell.classList.remove(name);await tick();}
 f.media.matches=false;for(const fn of f.listeners)fn();assert.equal(f.shell.classList.contains('browser-tabs-peek'),false);f.media.matches=true;for(const fn of f.listeners)fn();
 f.state.current=false;f.shell.classList.remove('browser-active');await tick();assert.equal(f.shell.classList.contains('browser-tabs-peek'),false);assert.equal(f.pin.hidden,true);
});
test('destroy cancels delayed collapse and leaves sibling sidebar modes and configured width intact',async t=>{
 const f=setup(t);f.shell.style.setProperty('--desktop-sidebar-width','287px');f.fire(f.sidebar,'pointerenter');f.fire(f.sidebar,'pointerleave');f.controller.destroy();await f.flush();assert.equal(f.shell.classList.contains('browser-tabs-peek'),false);assert.equal(f.shell.style.getPropertyValue('--desktop-sidebar-width'),'287px');f.fire(f.sidebar,'pointerenter');assert.equal(f.open(),false);
});
test('Native child focus does not let the stale main activeElement pin the sidebar open',async t=>{
 const f=setup(t),tab=f.document.querySelector('#tab');tab.focus();f.fire(f.sidebar,'pointerenter');assert.equal(f.open(),true);
 f.state.mainFocus=false;f.fire(f.window,'blur');f.fire(f.sidebar,'pointerleave');await f.flush();assert.equal(f.document.activeElement,tab);assert.equal(f.open(),false);
 f.state.mainFocus=true;f.fire(f.window,'focus');assert.equal(f.open(),true);assert.equal(f.document.activeElement,tab);
});
