import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {initNativeBrowserLayout} from './native-browser-layout.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(handler=async()=>{}) {
  const dom=new JSDOM('<body><main class="app-shell"><div id="browser-navigation" class="native-backed"><input id="address"></div><input id="outside"><dialog></dialog></main></body>',{pretendToBeVisual:true});
  const {window}=dom,{document}=window,group=document.querySelector('#browser-navigation');
  const frames=[],observers=[],calls=[];
  let active=true,view='browser',rect={x:20,y:40,left:20,top:40,right:620,bottom:76,width:600,height:36};
  let display='flex',visibility='visible',invalidColor=false;
  const colors={'--panel':'rgb(10, 20, 30)','--surface-sunken':'rgb(31, 32, 33)','--text':'rgba(90, 91, 92, 1)','--muted':'rgb(60, 61, 62)','--line':'rgb(40, 41, 42)','--focus-ring':'rgb(70, 71, 72)'};
  Object.defineProperties(window,{innerWidth:{value:800,writable:true},innerHeight:{value:600,writable:true}});
  group.getBoundingClientRect=()=>({...rect});
  window.getComputedStyle=el=>el===group?{display,visibility}:{color:invalidColor?'rgba(10, 20, 30, 0.5)':colors[el.style.color.slice(4,-1)]};
  window.requestAnimationFrame=cb=>{frames.push(cb);return frames.length;};
  class Observer{constructor(cb){this.cb=cb;observers.push(this);}observe(target,options){this.target=target;this.options=options;}}
  window.ResizeObserver=Observer;window.MutationObserver=Observer;
  let scheme;
  window.matchMedia=()=>({addEventListener:(_,cb)=>{scheme=cb;}});
  const controller=initNativeBrowserLayout({document,window,isActive:()=>active,getView:()=>view,invoke:async(name,args)=>{calls.push({name,args});return handler(name,args);}});
  return {window,document,group,calls,observers,controller,setActive:v=>{active=v;},setView:v=>{view=v;},setRect:v=>{rect={...rect,...v};},setStyle:(d,v)=>{display=d;visibility=v;},badColor:()=>{invalidColor=true;},scheme:()=>scheme(),async frame(){assert.ok(frames.length,'scheduled frame');frames.shift()(0);await tick();},async update(){controller.schedule();await this.frame();},close(){dom.window.close();}};
}
const hidden={rect:null,palette:null,fontSize:13};
test('eligible main geometry resolves semantic palette and exact command payload',async t=>{
 const f=fixture();t.after(()=>f.close());await f.frame();
 assert.deepEqual(f.calls,[{name:'native_browser_chrome_layout',args:{rect:{x:20,y:40,w:600,h:36},palette:{panel:[10,20,30],surface:[31,32,33],text:[90,91,92],muted:[60,61,62],line:[40,41,42],focus:[70,71,72]},fontSize:13}}]);
 assert.equal(f.group.querySelectorAll('span').length,0);
});
test('focused DOM address falls back, and focus outside allows native layout again',async t=>{
 const f=fixture();t.after(()=>f.close());await f.frame();f.document.querySelector('#address').focus();await f.frame();assert.deepEqual(f.calls.at(-1).args,hidden);
 f.document.querySelector('#outside').focus();await f.frame();assert.ok(f.calls.at(-1).args.rect);
});
test('dialog, inactive window, and non-browser view produce null geometry',async t=>{
 const f=fixture();t.after(()=>f.close());await f.frame();
 f.document.querySelector('dialog').setAttribute('open','');await f.update();assert.deepEqual(f.calls.at(-1).args,hidden);
 f.document.querySelector('dialog').removeAttribute('open');await f.update();assert.ok(f.calls.at(-1).args.rect);
 f.setActive(false);await f.update();assert.deepEqual(f.calls.at(-1).args,hidden);
 f.setActive(true);await f.update();f.setView('ai');await f.update();assert.deepEqual(f.calls.at(-1).args,hidden);
});
test('viewport boundaries and hidden or undersized navigation reject native geometry',async t=>{
 for(const change of [{left:-1},{top:-1},{right:801},{bottom:601},{width:239},{height:31},{height:49}]){
  const f=fixture();t.after(()=>f.close());f.setRect(change);await f.frame();assert.deepEqual(f.calls[0].args,hidden);
 }
 for(const [display,visibility] of [['none','visible'],['flex','hidden']]){const f=fixture();t.after(()=>f.close());f.setStyle(display,visibility);await f.frame();assert.deepEqual(f.calls[0].args,hidden);}
});
test('minimum width and both accepted height endpoints remain usable',async t=>{
 for(const height of [32,48]){const f=fixture();t.after(()=>f.close());f.setRect({width:240,height,right:260,bottom:40+height});await f.frame();assert.equal(f.calls[0].args.rect.h,height);assert.equal(f.calls[0].args.rect.w,240);}
});
test('unresolved or translucent computed palette uses DOM fallback',async t=>{
 const f=fixture();t.after(()=>f.close());f.badColor();await f.frame();assert.deepEqual(f.calls[0].args,hidden);
});
test('single in-flight invoke coalesces dirty changes into latest state',async t=>{
 let release;const waiting=new Promise(r=>{release=r;});const f=fixture(()=>f.calls.length===1?waiting:undefined);t.after(()=>f.close());await f.frame();
 f.setRect({x:30,left:30,right:630});await f.update();f.setRect({x:45,left:45,right:645});await f.update();assert.equal(f.calls.length,1);
 release();await tick();await f.frame();assert.equal(f.calls.length,2);assert.equal(f.calls[1].args.rect.x,45);
});
test('in-flight visibility loss sends null after completion rather than stale coordinates',async t=>{
 let release;const waiting=new Promise(r=>{release=r;});const f=fixture(()=>f.calls.length===1?waiting:undefined);t.after(()=>f.close());await f.frame();f.setActive(false);await f.update();assert.equal(f.calls.length,1);release();await tick();await f.frame();assert.deepEqual(f.calls[1].args,hidden);
});
test('successful unchanged state deduplicates observer and color-scheme notifications',async t=>{
 const f=fixture();t.after(()=>f.close());await f.frame();f.observers[0].cb();f.observers[1].cb();f.scheme();await f.frame();assert.equal(f.calls.length,1);
});
test('failed invoke removes native backing and explicit next sync retries unchanged state',async t=>{
 let fail=true;const f=fixture(()=>{if(fail)throw Error('native_unavailable');});t.after(()=>f.close());await f.frame();assert.equal(f.group.classList.contains('native-backed'),false);assert.equal(f.calls.length,1);
 fail=false;await f.update();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].args,f.calls[0].args);assert.equal(f.group.classList.contains('native-backed'),false);
});
