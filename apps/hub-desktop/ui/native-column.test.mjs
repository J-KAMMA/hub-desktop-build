import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import vm from 'node:vm';
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const desktopShell = document.querySelector(".app-shell");'),source.indexOf('async function travelToolbar(direction)'));
const tick=()=>new Promise(setImmediate);
test('Browser preserves DOM splitters and prevents Native overlay over external fullscreen content',async t=>{
 const f=await fixture(t); f.ready();
 f.event('sidebar','start',1,400); f.event('sidebar','move',1,410);
 f.shell.classList.add('browser-active'); await f.flush();
 assert.equal(f.calls.at(-1).args.sidebar,null); assert.equal(f.calls.at(-1).args.rail,null);
 assert.equal(f.width('sidebar'),245); assert.equal(f.document.body.classList.contains('column-resizing'),false);
 f.ready(false,false); assert.equal(f.document.getElementById('sidebar-resizer').style.pointerEvents,'auto');
 f.shell.classList.remove('browser-active'); await f.flush();
 assert.ok(f.calls.at(-1).args.sidebar); assert.ok(f.calls.at(-1).args.rail);
});
async function fixture(t,{tool=null,viewport=1440,registration=null}={}){
 const dom=new JSDOM(readFileSync(new URL('./index.html',import.meta.url),'utf8'),{url:'https://resize.invalid/',pretendToBeVisual:true}),{document,localStorage}=dom.window,shell=document.querySelector('.app-shell');const events={},frames=[],calls=[],resizes=[];
 const f={dom,document,shell,events,frames,calls,resizes,fail:false,tokens:{'--panel':'#fff','--line-strong':'rgba(0, 0, 0, .3)','--action':'rgba(0, 100, 200, .5)'},rects:{sidebar:{x:240,y:44,width:6,height:800},rail:{x:1070,y:44,width:6,height:800}}};
 shell.classList.add('rail-open');Object.defineProperty(dom.window,'innerWidth',{value:viewport,writable:true});localStorage.setItem('hub.desktop.sidebarWidth.compact','245');localStorage.setItem('hub.desktop.railWidth','360');
 const actualStyle=dom.window.getComputedStyle.bind(dom.window);dom.window.getComputedStyle=node=>node===shell?{getPropertyValue:token=>f.tokens[token]??''}:actualStyle(node);
 dom.window.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};
 const invoke=async(name,args)=>{calls.push({name,args});if(f.wait)await f.wait;if(f.fail)throw Error('unsupported');};
 dom.window.__TAURI__={core:{invoke},event:{listen:(name,callback)=>{events[name]=callback;return registration==='reject'?Promise.reject(Error('listen_failed')):registration??Promise.resolve(()=>{});}}};
 for(const [side,id] of [['sidebar','sidebar-resizer'],['rail','rail-resizer']]){const h=document.getElementById(id);h.style.pointerEvents='auto';h.getBoundingClientRect=()=>f.rects[side];let capture;h.setPointerCapture=id=>capture=id;h.hasPointerCapture=id=>capture===id;h.releasePointerCapture=()=>capture=null;}
 const observers=[];const context=vm.createContext({document,window:dom.window,localStorage,invoke,startupTool:tool,currentView:'feed',appsOpen:false,sidebarCollapsedForRail:false,accountSidebarAutoCollapsed:false,renderSidebarContext(){},syncToolbarSidebar(){},saveRailChoice(){},setDesktopRailOpen(open){shell.classList.toggle('rail-open',open)},MutationObserver:class{constructor(callback){const o=new dom.window.MutationObserver(callback);observers.push(o);return o;}},ResizeObserver:class{constructor(callback){resizes.push(callback);}observe(){}}});
 vm.runInContext(code,context);t.after(()=>{for(const o of observers)o.disconnect();dom.window.close();});
 f.read=s=>vm.runInContext(s,context);f.width=side=>Number(document.getElementById(side+'-resizer').getAttribute('aria-valuenow'));f.ready=(sidebar=true,rail=true)=>events['native-shell-resize-ready']({payload:{sidebar,rail}});f.event=(side,phase,session,x)=>events['native-shell-resize']({payload:{side,phase,session,x}});f.flush=async()=>{const work=frames.splice(0);for(const fn of work)fn();await tick();};await tick();return f;
}

test('ready changes only pointer hit testing, restores prior inline value and leaves geometry/tabindex/paint',async t=>{
 const f=await fixture(t),h=f.document.getElementById('sidebar-resizer'),before={rect:h.getBoundingClientRect(),tab:h.tabIndex,role:h.getAttribute('role'),class:h.className};f.ready(true,false);assert.equal(h.style.pointerEvents,'none');assert.equal(f.document.getElementById('rail-resizer').style.pointerEvents,'auto');assert.deepEqual({rect:h.getBoundingClientRect(),tab:h.tabIndex,role:h.getAttribute('role'),class:h.className},before);f.ready(false,false);assert.equal(h.style.pointerEvents,'auto');assert.equal(h.hidden,false);
});
for(const [side,min,initial,sign] of [['sidebar',190,245,1],['rail',240,360,-1]])test(side+' Native shares dead-zone save/cancel/collapse/reset and stale session behavior',async t=>{
 const f=await fixture(t);f.ready();f.event(side,'start',1,400);f.event(side,'move',1,400+(min-initial-40)*sign);assert.equal(f.width(side),min);assert.equal(f.document.body.classList.contains('column-resizing'),true);f.event(side,'move',2,900);assert.equal(f.width(side),min);f.event(side,'cancel',1,400);assert.equal(f.width(side),initial);assert.equal(f.read('preferredColumnWidth.'+side),initial);
 f.event(side,'start',2,400);f.event(side,'move',2,400+10*sign);f.event(side,'end',2,400);assert.equal(f.width(side),initial+10);f.event(side,'move',2,0);assert.equal(f.width(side),initial+10);
 f.event(side,'start',3,400);f.event(side,'move',3,400+(min-(initial+10)-41)*sign);assert.equal(f.read('preferredColumnWidth.'+side),initial+10);assert.equal(f.document.body.classList.contains('column-resizing'),false);f.event(side,'end',3,400);
 f.shell.classList.toggle(side==='sidebar'?'sidebar-collapsed':'rail-open',side!=='sidebar');f.read('applyColumnWidths()');f.event(side,'reset',4,400);assert.equal(f.read('preferredColumnWidth.'+side),null);assert.equal(f.width(side),side==='sidebar'?210:300);f.event(side,'start',3,400);assert.equal(f.document.body.classList.contains('column-resizing'),false);
});
test('malformed exact payload and unsafe numeric widths/session cause no state mutation',async t=>{
 const f=await fixture(t);f.ready();const before=f.width('sidebar'),valid={side:'sidebar',phase:'start',session:1,x:400};for(const payload of [null,[],{...valid,extra:0},{...valid,side:'__proto__'},{...valid,phase:'constructor'},{...valid,session:0},{...valid,session:1.5},{...valid,session:Number.MAX_SAFE_INTEGER+1},{...valid,x:NaN},{...valid,x:Infinity},{...valid,x:32768},Object.create(valid)])f.events['native-shell-resize']({payload});assert.equal(f.width('sidebar'),before);assert.equal(f.document.body.classList.contains('column-resizing'),false);
 f.event('sidebar','start',Number.MAX_SAFE_INTEGER,-32767);f.event('sidebar','move',Number.MAX_SAFE_INTEGER,32767);f.event('sidebar','end',Number.MAX_SAFE_INTEGER,32767);assert.equal(f.width('sidebar'),260);f.event('sidebar','reset',1,0);assert.notEqual(f.read('preferredColumnWidth.sidebar'),null);
});
test('main/live actual rect and modal checks reject starts; disappearing rect and ready false cancel existing width',async t=>{
 const f=await fixture(t);f.ready();const h=f.document.getElementById('rail-resizer');h.hidden=true;f.event('rail','start',1,400);assert.equal(f.document.body.classList.contains('column-resizing'),false);h.hidden=false;
 f.rects.rail.height=0;f.event('rail','start',2,400);assert.equal(f.document.body.classList.contains('column-resizing'),false);f.rects.rail.height=800;
 const dialog=f.document.getElementById('wallet-confirm-dialog');dialog.setAttribute('open','');f.event('rail','start',3,400);assert.equal(f.document.body.classList.contains('column-resizing'),false);dialog.removeAttribute('open');f.event('rail','start',4,400);f.event('rail','move',4,380);assert.equal(f.width('rail'),380);f.ready(true,false);assert.equal(f.width('rail'),360);
 f.ready();f.event('sidebar','start',5,400);f.event('sidebar','move',5,410);assert.equal(f.width('sidebar'),255);f.rects.sidebar.height=0;f.resizes[0]();await f.flush();assert.equal(f.width('sidebar'),245);assert.equal(f.calls.at(-1).args.sidebar,null);
 const tool=await fixture(t,{tool:'harness'});assert.deepEqual(Object.keys(tool.events),[]);assert.equal(tool.frames.length,0);
});
test('sync coalesces RAF and sends current actual asymmetric visibility plus composited semantic RGB arrays',async t=>{
 const f=await fixture(t);f.rects.rail.height=0;f.read('applyColumnWidths()');f.resizes[0]();f.resizes[0]();assert.equal(f.frames.length,1);await f.flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'native_shell_resize_sync');assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args.sidebar)),{x:240,y:44,w:6,h:800});assert.equal(f.calls[0].args.rail,null);assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args.colors)),{background:[255,255,255],divider:[179,179,179],active:[128,178,228]});
 f.tokens={'--panel':'#1b1b1b','--line-strong':'#575757','--action':'#5d8ee5'};f.rects.rail.height=800;f.resizes[0]();await f.flush();assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).args.colors)),{background:[27,27,27],divider:[87,87,87],active:[93,142,229]});assert.ok(f.calls.at(-1).args.rail);
});
test('sync rejection restores DOM pointer and cancels Native drag; malformed ready is ignored',async t=>{
 const f=await fixture(t);f.ready();f.event('sidebar','start',1,400);f.event('sidebar','move',1,410);f.fail=true;await f.flush();assert.equal(f.width('sidebar'),245);assert.equal(f.document.getElementById('sidebar-resizer').style.pointerEvents,'auto');
 for(const payload of [null,[],{sidebar:true},{sidebar:true,rail:true,extra:1},{sidebar:1,rail:true},Object.create({sidebar:true,rail:true})])f.events['native-shell-resize-ready']({payload});assert.equal(f.document.getElementById('sidebar-resizer').style.pointerEvents,'auto');
});

test('single flight retains one dirty latest geometry after delayed sync and never sends reversed snapshots',async t=>{
 const f=await fixture(t);let resolve;f.wait=new Promise(yes=>resolve=yes);await f.flush();assert.equal(f.calls.length,1);const first=f.calls[0].args.sidebar.x;
 f.rects.sidebar.x=250;f.resizes[0]();f.rects.sidebar.x=260;f.read('applyColumnWidths()');assert.equal(f.frames.length,0);assert.equal(f.calls.length,1);
 f.wait=null;resolve();await tick();assert.equal(f.frames.length,1);await f.flush();assert.equal(f.calls.length,2);assert.equal(f.calls[0].args.sidebar.x,first);assert.equal(f.calls[1].args.sidebar.x,260);
});
test('invalid colors hide existing Native handles using last valid semantic RGB rather than retaining overlay',async t=>{
 const f=await fixture(t);await f.flush();const colors=JSON.parse(JSON.stringify(f.calls[0].args.colors));f.ready();f.tokens['--panel']='not-a-color';f.resizes[0]();await f.flush();const last=f.calls.at(-1).args;assert.equal(last.sidebar,null);assert.equal(last.rail,null);assert.deepEqual(JSON.parse(JSON.stringify(last.colors)),colors);assert.equal(f.document.getElementById('sidebar-resizer').style.pointerEvents,'auto');
});
test('Native Rect limits reject negative coordinates and overwide/subpixel hit areas; hidden document gives both null',async t=>{
 const f=await fixture(t);f.rects.sidebar.x=-1;f.rects.rail.width=25;await f.flush();assert.equal(f.calls[0].args.sidebar,null);assert.equal(f.calls[0].args.rail,null);
 f.rects.sidebar.x=1;f.rects.sidebar.width=.9;f.rects.rail.width=6;f.resizes[0]();await f.flush();assert.equal(f.calls.at(-1).args.sidebar,null);assert.ok(f.calls.at(-1).args.rail);
 Object.defineProperty(f.document,'visibilityState',{value:'hidden',configurable:true});f.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));await f.flush();assert.equal(f.calls.at(-1).args.sidebar,null);assert.equal(f.calls.at(-1).args.rail,null);
});
test('ready transition cancels captured DOM drag, then keyboard remains usable without Native focus changes',async t=>{
 const f=await fixture(t),h=f.document.getElementById('sidebar-resizer');const pointer=(type,x)=>{const e=new f.dom.window.MouseEvent(type,{button:0,clientX:x});Object.defineProperty(e,'pointerId',{value:1});h.dispatchEvent(e);};
 const draft=f.document.getElementById('browser-url');draft.value='unsent 日本語';draft.focus();pointer('pointerdown',400);pointer('pointermove',410);assert.equal(f.width('sidebar'),255);f.ready();assert.equal(f.width('sidebar'),245);assert.equal(h.hasPointerCapture(1),false);pointer('pointermove',900);assert.equal(f.width('sidebar'),245);
 h.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));assert.equal(f.width('sidebar'),190);assert.equal(h.tabIndex,0);assert.equal(draft.value,'unsent 日本語');assert.equal(f.document.activeElement,draft);
});

test('initial sync waits both listener registrations; registration rejection retains DOM fallback without Native IPC',async t=>{
 let resolve;const registration=new Promise(yes=>resolve=yes),f=await fixture(t,{registration});assert.equal(f.frames.length,0);assert.equal(f.calls.length,0);f.ready();assert.equal(f.document.getElementById('sidebar-resizer').style.pointerEvents,'auto');f.resizes[0]();assert.equal(f.frames.length,0);resolve(()=>{});await tick();assert.equal(f.frames.length,1);await f.flush();assert.equal(f.calls.length,1);
 const denied=await fixture(t,{registration:'reject'});assert.equal(denied.frames.length,0);denied.ready();denied.resizes[0]();assert.equal(denied.calls.length,0);assert.equal(denied.document.getElementById('sidebar-resizer').style.pointerEvents,'auto');
});


test('focused separator exposes DOM focus paint and keyboard width, then blur restores Native geometry without changing draft',async t=>{
 for(const side of ['sidebar','rail']){
  const f=await fixture(t),h=f.document.getElementById(side+'-resizer'),other=side==='sidebar'?'rail':'sidebar',draft=f.document.getElementById('browser-url');draft.value='unsent 日本語';await f.flush();f.ready();h.focus();assert.equal(f.document.activeElement,h);assert.equal(f.read('nativeColumnRect("'+side+'")'),null);await f.flush();assert.equal(f.calls.at(-1).args[side],null);assert.ok(f.calls.at(-1).args[other]);f.ready(side!=='sidebar',side!=='rail');assert.equal(h.style.pointerEvents,'auto');
  h.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Home',bubbles:true}));assert.equal(f.width(side),side==='sidebar'?190:240);await f.flush();assert.equal(f.calls.at(-1).args[side],null);assert.equal(f.document.activeElement,h);assert.equal(draft.value,'unsent 日本語');
  draft.focus();await f.flush();assert.ok(f.calls.at(-1).args[side]);f.ready();assert.equal(h.style.pointerEvents,'none');assert.equal(f.document.activeElement,draft);assert.equal(draft.value,'unsent 日本語');
 }
});
