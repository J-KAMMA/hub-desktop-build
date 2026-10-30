import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {initNativeSidebar,nativeSidebarId} from './native-sidebar.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(setImmediate), deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const groups={feed:[[1,'おすすめ'],[2,'人気'],[3,'フォロー中']],notifications:[[4,'すべて'],[5,'未読'],[6,'フィード'],[7,'コミュニティ'],[8,'お知らせ']],market:[[9,'商品'],[10,'出品'],[11,'販売者']],settings:[[12,'Desktopアカウント'],[13,'この端末'],[14,'通知と受信'],[15,'その他の設定']]};
async function fixture(t,{view='feed',registration,resetFloor=1,resetWait,resetFailure=false}={}){
 const dom=new JSDOM('<div class="app-shell"><aside class="sidebar"><div id="sidebar-context"></div></aside></div><div id="sources"></div><input id="draft"><dialog></dialog>',{url:'https://sidebar.invalid/',pretendToBeVisual:true}),{window}=dom,{document}=window,context=document.querySelector('#sidebar-context'),sidebar=document.querySelector('.sidebar'),shell=document.querySelector('.app-shell'),frames=[],calls=[],events={},clicked=[],sources=new Map(),observed=new Set();
 const f={dom,window,document,context,sidebar,shell,frames,calls,events,clicked,sources,view,resetCalls:[],eligible:true,selected:groups[view][0][0],rects:new Map(),container:{x:52,y:44,width:240,height:400},tokens:{'--panel':'#fff','--interactive':'rgba(0, 0, 0, .05)','--selected':'#eee','--text':'#111','--muted':'rgba(0, 0, 0, .6)'},font:{fontSize:'13px',paddingLeft:'9px',paddingRight:'9px',borderTopLeftRadius:'9px',borderTopRightRadius:'9px',borderBottomLeftRadius:'9px',borderBottomRightRadius:'9px',fontWeight:'600'},unlistened:0};
 Object.defineProperty(window,'innerWidth',{value:1280,writable:true});Object.defineProperty(window,'innerHeight',{value:800,writable:true});context.getBoundingClientRect=()=>f.container;sidebar.getBoundingClientRect=()=>({x:52,y:44,width:240,height:500});
 const actualStyle=window.getComputedStyle.bind(window);window.getComputedStyle=node=>new Proxy(actualStyle(node),{get(style,key){if(key==='getPropertyValue')return token=>Object.hasOwn(f.tokens,token)?f.tokens[token]:style.getPropertyValue(token);if(node.matches('button[data-native-sidebar-id]')&&Object.hasOwn(f.font,key))return f.font[key];return Reflect.get(style,key);}});
 window.requestAnimationFrame=callback=>{frames.push(callback);return frames.length;};window.cancelAnimationFrame=()=>{frames.length=0;};window.ResizeObserver=class{constructor(callback){f.resize=callback;}observe(node){observed.add(node);}unobserve(node){observed.delete(node);}disconnect(){observed.clear();}};
 f.render=()=>{context.replaceChildren(...groups[f.view].map(([id,label],index)=>{
  let source=sources.get(id);if(!source){source=document.createElement('button');source.onclick=()=>{clicked.push(id);f.selected=id;};document.querySelector('#sources').append(source);sources.set(id,source);}
  const row=document.createElement('button');row.type='button';row.className=f.selected===id?'sidebar-context-item on':'sidebar-context-item';row.dataset.nativeSidebarId=String(id);row.textContent=label;row.style.setProperty('opacity','.7','important');row.style.setProperty('pointer-events','auto','important');row.getBoundingClientRect=()=>f.rects.get(id)??{x:60,y:60+index*38,width:220,height:34};row.onclick=()=>{source.click();f.render();f.bridge.sync();};return row;
 }));};f.render();
 const invoke=async(name,args)=>{if(name==='native_sidebar_reset'){f.resetCalls.push({name,args});if(resetWait)await resetWait;if(resetFailure)throw Error('reset_unavailable');return resetFloor;}calls.push({name,args});if(f.wait)await f.wait;if(f.fail)throw Error('native_unavailable');};
 const listen=(name,callback)=>{events[name]=callback;const wait=registration?.[name];return wait?wait.then(()=>()=>{f.unlistened++;}):Promise.resolve(()=>{f.unlistened++;});};
 f.bridge=initNativeSidebar({document,window,invoke,listen,getView:()=>f.view,eligible:()=>f.eligible});
 f.row=id=>context.querySelector('[data-native-sidebar-id="'+id+'"]');f.flush=async()=>{for(const callback of frames.splice(0))callback();await tick();};f.ready=(ids=calls.at(-1).args.rows.map(row=>row.id),revision=calls.at(-1).args.revision)=>events['native-sidebar-ready']({payload:{revision,ids}});f.action=(id,revision=calls.at(-1).args.revision)=>events['native-sidebar-action']({payload:{revision,id}});f.draft=document.querySelector('#draft');f.draft.value='unsent 日本語';f.draft.focus();
 t.after(()=>{f.bridge.destroy();dom.window.close();});await tick();return f;
}

test('closed source selectors map exactly to all 15 IDs and never accept another view or selector',()=>{
 const selectors=['#view-feed [data-scope="recommended"]','#view-feed [data-scope="popular"]','#view-feed [data-scope="following"]','#view-notifications [data-notif-tab="all"]','#view-notifications [data-notif-tab="unread"]','#view-notifications [data-notif-tab="feed"]','#view-notifications [data-notif-tab="community"]','#view-notifications [data-notif-tab="system"]','#view-market [data-shop-tab="products"]','#view-market [data-shop-tab="listings"]','#view-market [data-shop-tab="seller"]','[data-settings-sec="account"]','[data-settings-sec="device"]','[data-settings-sec="notifications"]','[data-settings-sec="other"]'];
 for(const [view,rows] of Object.entries(groups))for(const [id] of rows){assert.equal(nativeSidebarId(view,selectors[id-1]),id);assert.equal(nativeSidebarId('browser',selectors[id-1]),0);assert.equal(nativeSidebarId(view,selectors[id-1]+' '),0);}
 assert.equal(nativeSidebarId('__proto__','constructor'),0);
});
for(const view of Object.keys(groups))test(view+' Native action invokes the connected mirror closure once and matches existing source selection',async t=>{
 const f=await fixture(t,{view});await f.flush();const command=f.calls.at(-1);assert.equal(command.name,'native_sidebar_sync');assert.equal(command.args.view,view);assert.deepEqual(command.args.rows.map(row=>row.id),groups[view].map(([id])=>id));f.ready();const id=groups[view][1][0],revision=command.args.revision;assert.deepEqual(f.bridge.status().ids,groups[view].map(([id])=>id));f.action(id,revision);f.action(id,revision);assert.deepEqual(f.clicked,[id]);assert.equal(f.bridge.status().selected,id);assert.equal(f.draft.value,'unsent 日本語');assert.equal(f.document.activeElement,f.draft);await f.flush();assert.equal(f.calls.at(-1).args.rows.find(row=>row.id===id).selected,true);
});

test('ready hides only acknowledged rows with exact inline restoration and never loops from its own style writes',async t=>{
 const f=await fixture(t);await f.flush();f.ready([1,2]);assert.equal(f.row(1).style.opacity,'0');assert.equal(f.row(1).style.pointerEvents,'none');assert.equal(f.row(3).style.opacity,'0.7');assert.equal(f.row(1).tabIndex,0);await tick();assert.equal(f.frames.length,0);assert.equal(f.calls.length,1);f.bridge.sync();assert.equal(f.row(1).style.opacity,'0.7');assert.equal(f.row(1).style.getPropertyPriority('opacity'),'important');assert.equal(f.row(1).style.pointerEvents,'auto');assert.equal(f.row(1).style.getPropertyPriority('pointer-events'),'important');assert.deepEqual(f.bridge.status().ids,[]);
});

test('listeners both settle before first sync and rejected registration preserves DOM and removes successful subscription',async t=>{
 const first=deferred(),second=deferred(),f=await fixture(t,{registration:{'native-sidebar-ready':first.promise,'native-sidebar-action':second.promise}});assert.equal(f.frames.length,0);f.bridge.sync();assert.equal(f.calls.length,0);first.resolve();await tick();assert.equal(f.frames.length,0);second.resolve();await tick();await f.flush();assert.equal(f.calls.length,1);
 const denied=deferred(),g=await fixture(t,{registration:{'native-sidebar-action':denied.promise}});denied.reject(Error('listen_denied'));await tick();g.bridge.sync();await g.flush();assert.equal(g.calls.length,0);assert.equal(g.row(1).style.opacity,'0.7');assert.equal(g.unlistened,1);
});

test('rerender or queued generation invalidates old ready and action even before the next Native command',async t=>{
 const f=await fixture(t);await f.flush();const old=f.calls.at(-1).args.revision;f.ready();const detached=f.row(2);f.render();await tick();f.ready([1,2,3],old);f.action(2,old);assert.deepEqual(f.clicked,[]);assert.equal(detached.isConnected,false);assert.equal(f.row(2).style.opacity,'0.7');await f.flush();f.ready();const fresh=f.calls.at(-1).args.revision;f.bridge.sync();f.action(2,fresh);assert.deepEqual(f.clicked,[]);
});

test('whole-row clipping, hidden ancestors, disabled and keyboard focus preserve DOM rows and reappear only when eligible',async t=>{
 const f=await fixture(t);f.rects.set(1,{x:60,y:43,width:220,height:34});f.row(2).disabled=true;await f.flush();assert.deepEqual(f.calls.at(-1).args.rows.map(row=>row.id),[3]);f.ready();f.row(3).focus();await f.flush();assert.deepEqual(f.calls.at(-1).args.rows,[]);assert.equal(f.row(3).style.opacity,'0.7');assert.equal(f.document.activeElement,f.row(3));f.row(3).click();assert.deepEqual(f.clicked,[3]);f.draft.focus();f.rects.delete(1);await tick();await f.flush();assert.deepEqual(f.calls.at(-1).args.rows.map(row=>row.id),[1,2,3]);f.ready();f.context.hidden=true;await tick();f.action(1);assert.deepEqual(f.clicked,[3]);await f.flush();assert.deepEqual(f.calls.at(-1).args.rows,[]);
});

test('scroll and geometry changes reject stale action and send current fully visible coordinates',async t=>{
 const f=await fixture(t);await f.flush();f.ready();const old=f.calls.at(-1).args.revision;f.rects.set(1,{x:60,y:20,width:220,height:34});f.context.dispatchEvent(new f.window.Event('scroll'));f.action(1,old);assert.deepEqual(f.clicked,[]);await f.flush();assert.deepEqual(f.calls.at(-1).args.rows.map(row=>row.id),[2,3]);assert.equal(f.calls.at(-1).args.rows[0].rect.y,98);f.resize();f.resize();assert.equal(f.frames.length,1);
});

test('view/browser/modal/drag/eligibility/visibility refusal hides existing rows and retains source DOM',async t=>{
 const f=await fixture(t);await f.flush();for(const gate of ['browser','modal','drag','eligible','hidden','view']){
  f.ready();const old=f.calls.at(-1).args.revision;
  if(gate==='browser')f.shell.classList.add('browser-active');if(gate==='modal')f.document.querySelector('dialog').open=true;if(gate==='drag')f.document.body.classList.add('column-resizing');if(gate==='eligible')f.eligible=false;if(gate==='hidden')Object.defineProperty(f.document,'visibilityState',{value:'hidden',configurable:true});if(gate==='view')f.view='ai';
  f.bridge.sync();f.action(2,old);await f.flush();assert.deepEqual(f.calls.at(-1).args.rows,[]);assert.equal(f.row(2).style.opacity,'0.7');assert.deepEqual(f.clicked,[]);
  f.shell.classList.remove('browser-active');f.document.querySelector('dialog').open=false;f.document.body.classList.remove('column-resizing');f.eligible=true;Object.defineProperty(f.document,'visibilityState',{value:'visible',configurable:true});f.view='feed';f.bridge.sync();await f.flush();
 }
});

test('one flight keeps only dirty latest rows, stale completion cannot acknowledge or render another view',async t=>{
 const f=await fixture(t),wait=deferred();f.wait=wait.promise;await f.flush();const old=f.calls[0].args.revision;f.view='settings';f.selected=12;f.render();f.bridge.sync();await tick();assert.equal(f.calls.length,1);assert.equal(f.frames.length,0);f.ready([1,2,3],old);assert.deepEqual(f.bridge.status().ids,[]);f.wait=null;wait.resolve();await tick();assert.equal(f.frames.length,1);await f.flush();assert.equal(f.calls.length,2);assert.equal(f.calls[1].args.view,'settings');assert.deepEqual(f.calls[1].args.rows.map(row=>row.id),[12,13,14,15]);assert.ok(f.calls[1].args.revision>old);
});

test('semantic RGBA composites and measured typography are preserved; invalid color hides with last valid palette',async t=>{
 const f=await fixture(t);await f.flush();const p=f.calls.at(-1).args;assert.deepEqual(p.colors,{background:[255,255,255],hover:[242,242,242],selected:[238,238,238],text:[17,17,17],muted:[102,102,102]});assert.deepEqual([p.fontSize,p.paddingX,p.radius,p.fontWeight],[13,9,9,600]);f.ready();f.tokens['--panel']='unresolved';f.bridge.sync();await f.flush();assert.deepEqual(f.calls.at(-1).args.rows,[]);assert.deepEqual(f.calls.at(-1).args.colors,p.colors);assert.equal(f.row(1).style.opacity,'0.7');
 f.tokens['--panel']='#fff';f.font.paddingLeft='33px';f.bridge.sync();await f.flush();assert.deepEqual(f.calls.at(-1).args.rows,[]);
});

test('malformed IDs/labels/geometry/ACKs never click, foreign or unsafe action cannot mutate source',async t=>{
 const f=await fixture(t);await f.flush();f.ready();const r=f.calls.at(-1).args.revision;
 for(const payload of [null,[],{revision:r,id:2,extra:0},{revision:0,id:2},{revision:Number.MAX_SAFE_INTEGER+1,id:2},{revision:r,id:2.5},{revision:r,id:15},Object.create({revision:r,id:2})])f.events['native-sidebar-action']({payload});assert.deepEqual(f.clicked,[]);
 for(const payload of [null,{revision:r,ids:[1,1]},{revision:r,ids:[15]},{revision:r,ids:[1],extra:1},Object.create({revision:r,ids:[1]})])f.events['native-sidebar-ready']({payload});assert.deepEqual(f.bridge.status().ids,[1,2,3]);
 f.row(2).textContent='untrusted';await tick();await f.flush();assert.deepEqual(f.calls.at(-1).args.rows,[]);f.render();f.row(2).dataset.nativeSidebarId='1';await tick();await f.flush();assert.deepEqual(f.calls.at(-1).args.rows,[]);f.render();f.rects.set(1,{x:-1,y:60,width:220,height:34});await tick();await f.flush();assert.deepEqual(f.calls.at(-1).args.rows.map(row=>row.id),[2,3]);
});

test('IPC failure restores exact DOM and late ready is rejected, without an observer retry loop',async t=>{
 const f=await fixture(t);await f.flush();f.ready();f.fail=true;f.bridge.sync();await f.flush();const failed=f.calls.at(-2).args.revision;f.ready([1,2,3],failed);assert.deepEqual(f.bridge.status().ids,[]);assert.equal(f.row(1).style.opacity,'0.7');assert.equal(f.row(1).style.getPropertyPriority('opacity'),'important');await tick();assert.equal(f.frames.length,0);
});

test('destroy during pending sync restores DOM, stops listeners/observers and hides with a newer revision after settle',async t=>{
 const f=await fixture(t);await f.flush();f.ready();const wait=deferred();f.wait=wait.promise;f.bridge.sync();await f.flush();const pending=f.calls.at(-1).args.revision;f.bridge.destroy();assert.equal(f.row(1).style.opacity,'0.7');f.action(2,pending);assert.deepEqual(f.clicked,[]);f.wait=null;wait.resolve();await tick();assert.deepEqual(f.calls.at(-1).args.rows,[]);assert.ok(f.calls.at(-1).args.revision>pending);assert.equal(f.unlistened,2);assert.equal(f.frames.length,0);
});


test('reset follows both listeners, waits before sync and advances above a surviving Native floor while refusing old events',async t=>{
 const listener=deferred(),reset=deferred(),f=await fixture(t,{registration:{'native-sidebar-action':listener.promise},resetWait:reset.promise,resetFloor:1000});assert.equal(f.resetCalls.length,0);listener.resolve();await tick();assert.equal(f.resetCalls.length,1);assert.equal(f.frames.length,0);f.bridge.sync();f.events['native-sidebar-ready']({payload:{revision:1000,ids:[1,2,3]}});f.action(2,1000);assert.deepEqual(f.clicked,[]);assert.equal(f.row(1).style.opacity,'0.7');reset.resolve();await tick();await f.flush();assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.revision,1001);f.ready([1,2,3],1000);f.action(2,1000);assert.deepEqual(f.bridge.status().ids,[]);assert.deepEqual(f.clicked,[]);f.ready();f.action(2);assert.deepEqual(f.clicked,[2]);
});

test('failed or malformed reset floor never sends a sync or accepts old Native rows and retains DOM fallback',async t=>{
 for(const resetFloor of [0,-1,1.5,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,null,'12',{},undefined]){
  const f=await fixture(t,{resetFloor:resetFloor===undefined?NaN:resetFloor});f.bridge.sync();await f.flush();assert.equal(f.resetCalls.length,1);assert.equal(f.calls.length,0);assert.equal(f.frames.length,0);f.events['native-sidebar-ready']({payload:{revision:1,ids:[1,2,3]}});f.action(2,1);assert.deepEqual(f.clicked,[]);assert.deepEqual(f.bridge.status().ids,[]);assert.equal(f.row(1).style.opacity,'0.7');assert.equal(f.unlistened,2);
 }
 const failed=await fixture(t,{resetFailure:true});failed.bridge.sync();await failed.flush();assert.equal(failed.calls.length,0);assert.equal(failed.row(1).style.pointerEvents,'auto');assert.equal(failed.unlistened,2);
});

test('near-limit reset reserves the final safe revision for empty hide, never reuses it on cleanup',async t=>{
 const f=await fixture(t,{resetFloor:Number.MAX_SAFE_INTEGER-2});await f.flush();assert.equal(f.calls[0].args.revision,Number.MAX_SAFE_INTEGER-1);assert.equal(f.calls[0].args.rows.length,3);f.ready();f.bridge.sync();await f.flush();assert.equal(f.calls[1].args.revision,Number.MAX_SAFE_INTEGER);assert.deepEqual(f.calls[1].args.rows,[]);f.ready([]);f.action(2,Number.MAX_SAFE_INTEGER-1);assert.deepEqual(f.clicked,[]);f.bridge.sync();await f.flush();f.bridge.destroy();await tick();assert.equal(f.calls.length,2);assert.equal(f.bridge.status().revision,Number.MAX_SAFE_INTEGER);assert.equal(f.row(1).style.opacity,'0.7');
});

test('destroy while reset is pending cannot resurrect Native sync and releases registered listeners',async t=>{
 const reset=deferred(),f=await fixture(t,{resetWait:reset.promise,resetFloor:1000});assert.equal(f.resetCalls.length,1);f.bridge.destroy();reset.resolve();await tick();await f.flush();assert.equal(f.calls.length,0);assert.equal(f.frames.length,0);assert.equal(f.unlistened,2);assert.equal(f.row(1).style.opacity,'0.7');
});
