import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
const root = fileURLToPath(new URL('./',import.meta.url));
const source = readFileSync(root + 'app.js', 'utf8');
const code = source.slice(source.indexOf('const desktopShell = document.querySelector(".app-shell");'), source.indexOf('async function travelToolbar(direction)'));
function fixture(viewport = 1700) {
  const dom = new JSDOM(readFileSync(root+'index.html','utf8'), {url:'https://resize.invalid'});
  const {document,localStorage} = dom.window, shell = document.querySelector('.app-shell'), observers = [], saved = [];
  Object.defineProperty(dom.window, 'innerWidth', {value:viewport});
  localStorage.setItem('hub.desktop.sidebarWidth.compact','245');
  localStorage.setItem('hub.desktop.railWidth','360');
  shell.classList.add('rail-open');
  const context = vm.createContext({document,window:dom.window,localStorage,startupTool:null,currentView:'feed',appsOpen:false,sidebarCollapsedForRail:false,accountSidebarAutoCollapsed:false,
    renderSidebarContext(){},syncToolbarSidebar(){},saveRailChoice(open){saved.push(open)},setDesktopRailOpen(open){shell.classList.toggle('rail-open',open)},
    MutationObserver:class {constructor(callback){const observer=new dom.window.MutationObserver(callback);observers.push(observer);return observer;}}
  });
  for(const id of ['sidebar-resizer','rail-resizer']) {
    const handle=document.getElementById(id);let capture;
    handle.setPointerCapture=id=>{capture=id};handle.hasPointerCapture=id=>capture===id;handle.releasePointerCapture=()=>{capture=null};
  }
  vm.runInContext(code,context);
  const handle = name=>document.getElementById(name==='sidebar'?'sidebar-resizer':'rail-resizer');
  const open = name=>name==='sidebar'?!shell.classList.contains('sidebar-collapsed'):shell.classList.contains('rail-open');
  const width = name=>Number(handle(name).getAttribute('aria-valuenow'));
  const pointer = (name,type,x,id=1)=>{const event=new dom.window.MouseEvent(type,{button:0,clientX:x,bubbles:true});Object.defineProperty(event,'pointerId',{value:id});handle(name).dispatchEvent(event)};
  const read = expression=>vm.runInContext(expression,context);
  return {dom,document,localStorage,shell,context,saved,handle,open,width,pointer,read,dispose(){for(const observer of observers)observer.disconnect();dom.window.close()}};
}
for(const [name,min,initial,sign,key] of [['sidebar',190,245,1,'ArrowLeft'],['rail',240,360,-1,'ArrowRight']]) {
  test(`${name}: crossing the 40px dead zone closes once and retains the width for reopening`,()=>{
    const f=fixture();try {
      f.pointer(name,'pointerdown',400);
      f.pointer(name,'pointermove',400+(min-initial)*sign);assert.equal(f.open(name),true);assert.equal(f.width(name),min);
      f.pointer(name,'pointermove',400+(min-initial-41)*sign);assert.equal(f.open(name),false);
      assert.equal(f.read(`preferredColumnWidth.${name}`),initial);assert.equal(f.width(name),initial);
      assert.equal(f.document.body.classList.contains('column-resizing'),false);assert.equal(f.handle(name).hasPointerCapture(1),false);
      const closeControl=f.document.getElementById(name==='sidebar'?'toolbar-sidebar':'rail-activity-toggle');assert.equal(f.document.activeElement,closeControl);
      f.pointer(name,'pointerup',0);f.pointer(name,'pointermove',900);assert.equal(f.read(`preferredColumnWidth.${name}`),initial);
      if(name==='rail')assert.deepEqual(f.saved,[false]);
      f.shell.classList.toggle(name==='sidebar'?'sidebar-collapsed':'rail-open',name!=='sidebar');f.read('applyColumnWidths()');assert.equal(f.width(name),initial);
    } finally {f.dispose()}
  });
  test(name+': the minimum holds through the dead zone and dragging back widens again',()=>{
    const f=fixture();try {
      f.pointer(name,'pointerdown',400);
      for(const distance of [0,20,40]) {
        f.pointer(name,'pointermove',400+(min-initial-distance)*sign);
        assert.equal(f.open(name),true);assert.equal(f.width(name),min);
        assert.equal(f.document.body.classList.contains('column-resizing'),true);
      }
      f.pointer(name,'pointermove',400+(min-initial+12)*sign);
      assert.equal(f.open(name),true);assert.equal(f.width(name),min+12);
      f.pointer(name,'pointerup',400+(min-initial+12)*sign);
      assert.equal(f.document.body.classList.contains('column-resizing'),false);
    } finally {f.dispose()}
  });
  test(name+': releasing in the dead zone saves the minimum and keeps the column open',()=>{
    const f=fixture();try {
      f.pointer(name,'pointerdown',400);f.pointer(name,'pointermove',400+(min-initial-30)*sign);
      f.pointer(name,'pointerup',400+(min-initial-30)*sign);
      assert.equal(f.open(name),true);assert.equal(f.width(name),min);
      assert.equal(f.read('preferredColumnWidth.'+name),min);
      assert.equal(f.localStorage.getItem(name==='sidebar'?'hub.desktop.sidebarWidth.compact':'hub.desktop.railWidth'),String(min));
      assert.equal(f.document.body.classList.contains('column-resizing'),false);
    } finally {f.dispose()}
  });
  test(name+': a completed resize saves its actual width and a later collapse preserves it',()=>{
    const f=fixture();try {
      f.pointer(name,'pointerdown',400);f.pointer(name,'pointermove',400+10*sign);f.pointer(name,'pointerup',400+10*sign);
      const resized=initial+10;assert.equal(f.width(name),resized);
      assert.equal(f.localStorage.getItem(name==='sidebar'?'hub.desktop.sidebarWidth.compact':'hub.desktop.railWidth'),String(resized));
      f.pointer(name,'pointerdown',400);f.pointer(name,'pointermove',400+(min-resized-41)*sign);
      assert.equal(f.open(name),false);assert.equal(f.read('preferredColumnWidth.'+name),resized);
    } finally {f.dispose()}
  });
  for(const cancel of ['pointercancel','lostpointercapture'])test(`${name}: ${cancel} restores the previous width without closing`,()=>{
    const f=fixture();try {
      f.pointer(name,'pointerdown',400);f.pointer(name,'pointermove',400+20*sign);assert.notEqual(f.width(name),initial);
      f.pointer(name,cancel,0,2);assert.equal(f.document.body.classList.contains('column-resizing'),true);
      f.pointer(name,cancel,0);assert.equal(f.open(name),true);assert.equal(f.width(name),initial);assert.equal(f.document.body.classList.contains('column-resizing'),false);
    } finally {f.dispose()}
  });
  test(`${name}: keyboard minimum remains open; further shrinking closes; double click resets`,()=>{
    const f=fixture();try {
      f.handle(name).dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));assert.equal(f.width(name),min);assert.equal(f.open(name),true);
      f.handle(name).dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key,bubbles:true}));assert.equal(f.open(name),false);
      f.shell.classList.toggle(name==='sidebar'?'sidebar-collapsed':'rail-open',name!=='sidebar');f.handle(name).dispatchEvent(new f.dom.window.MouseEvent('dblclick',{bubbles:true}));
      assert.equal(f.width(name),name==='sidebar'?300:380);assert.equal(f.read(`preferredColumnWidth.${name}`),null);
    } finally {f.dispose()}
  });
}

test('a narrow right panel returns focus to its visible open button',()=>{
  const f=fixture(800);try {f.pointer('rail','pointerdown',400);f.pointer('rail','pointermove',561);assert.equal(f.open('rail'),false);assert.equal(f.document.activeElement,f.document.querySelector('#toolbar-rail'));}finally{f.dispose()}
});

test('the minimum desktop width returns focus to the toolbar open button',()=>{
  const f=fixture(720);try {f.pointer('rail','pointerdown',400);f.pointer('rail','pointermove',561);assert.equal(f.open('rail'),false);assert.equal(f.document.activeElement,f.document.querySelector('#toolbar-rail'));}finally{f.dispose()}
});
