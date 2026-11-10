import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {initBrowserWorkspace} from './browser-workspace.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const markup=process.env.HUB_BROWSER_MARKUP?pathToFileURL(process.env.HUB_BROWSER_MARKUP):new URL('./index.html',import.meta.url);
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tab=(overrides={})=>({id:1,url:'https://one.example/full/path?q=1',title:'first',active:true,pinned:false,discarded:false,loading:false,zoom:1,canBack:true,canForward:false,...overrides});
async function fixture(t,{tabs=[tab(),tab({id:2,title:'second',url:'https://two.example/x',active:false})],active=true,view='browser',savedEngine=null,tabLayout=null,collapsedGroups=null,metrics=undefined,hub=false}={}){
 const dom=new JSDOM(readFileSync(markup,'utf8'),{url:'http://fixture.invalid/'}),document=dom.window.document,events={},calls=[];
 const f={dom,document,events,calls,tabs,active,view,favorites:[],history:[],fail:new Set(),wait:new Map(),drafts:[],scrollCalls:[],enterWait:null,navigationEffects:[],hubCalls:[],hubHistory:{back:{available:true,label:'動画に戻る'},forward:{available:true,label:'記事を進む'}}};
 if(tabLayout!==null)dom.window.localStorage.setItem('hub.browser.tabLayout',tabLayout);
 if(savedEngine!==null)dom.window.localStorage.setItem('hub.browser.searchEngine',savedEngine);
 if(collapsedGroups!==null)dom.window.localStorage.setItem('hub.browser.collapsedGroups',collapsedGroups);
 dom.window.matchMedia=()=>({matches:false,addEventListener:()=>{}});dom.window.HTMLElement.prototype.scrollIntoView=function(options){f.scrollCalls.push({id:this.id,options});};
 dom.window.__TAURI__={event:{listen:(name,callback)=>{events[name]=callback;return Promise.resolve(()=>{});}}};
 const invoke=async(name,args)=>{if(name==='browser_menu_overlay'){f.menuOverlay=args;return null;}calls.push({name,args});if(name==='browser_protection_status')return{version:1,supported:true,enabled:true,ready:true,blockedCount:0,listsVersion:'2026-10-07'};if(name==='browser_find'&&f.findRead)return f.findRead(args);if(name==='browser_workspace_snapshot'&&f.snapshotRead)return f.snapshotRead();if(f.readOverride&&['browser_tabs','browser_favorites','browser_history'].includes(name))return f.readOverride(name,args);if(name==='browser_tabs')return f.tabs;if(name==='browser_favorites')return f.favorites;if(name==='browser_history')return f.history;if(name==='browser_downloads'||name==='browser_site_requests')return [];if(name==='browser_session_status')return 0;
  if(f.wait.has(name))await f.wait.get(name).promise;if(f.fail.has(name))throw Error(name==='browser_activate_tab'?'tab_not_found':name==='browser_new_private_tab'?'private_unavailable':'operation_failed');
  if(name==='browser_activate_tab'){if(!f.tabs.some(tab=>tab.id===args.id))throw Error('tab_not_found');f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===args.id}));}
  if(name==='browser_navigate_from_address'){if(!f.active||f.view!=='browser'||f.tabs.find(tab=>tab.active)?.id!==args.id)throw Error('browser_tab_context_changed');f.navigationEffects.push(args);}
  // Native ACK precedes asynchronous creation; tests explicitly emit its eventual change.
  if(name==='browser_close_tab')f.tabs=f.tabs.filter(tab=>tab.id!==args.id);
  if(name==='browser_set_tab_group')f.tabs=f.tabs.map(tab=>tab.id===args.id?{...tab,group:args.group}:tab);
  if(name==='browser_set_muted'){if(f.applyMute!==false)f.tabs=f.tabs.map(tab=>tab.id===args.id?{...tab,muted:args.muted}:tab);return {version:1,tabs:f.tabs,favorites:f.favorites,history:f.history};}
  if(name==='browser_show_print')return f.printResult??{tabId:args.id,dialogShown:true};
  if(name==='browser_send_to_ai')return f.aiDraft??'page draft';
  if(name==='browser_reader_read')return{id:args.id,url:args.url,title:'Synthetic reader',paragraphs:['Synthetic article paragraph.'],truncated:false,contextToken:'reader-token-1'};
  if(name==='browser_reader_open')return{id:args.id,contextToken:args.contextToken,opened:true};
  if(name==='browser_reader_close')return{closed:true};
 };
 f.workspace=initBrowserWorkspace({document,window:dom.window,invoke,icon:()=>'<svg></svg>',enterBrowser:async()=>{calls.push({name:'fixture_enter'});if(f.enterWait)await f.enterWait.promise;f.active=true;f.view='browser';},isActive:()=>f.active,getView:()=>f.view,onAiDraft:async (draft,source)=>{if(f.acceptDraft)return f.acceptDraft(draft,source);if(f.draftFailure)throw Error('ai_work_busy');f.drafts.push(draft);},getHubHistory:hub?()=>f.hubHistory:undefined,onHubHistory:hub?async direction=>{f.hubCalls.push(direction);}:undefined,metrics});
 t.after(()=>dom.window.close());await tick();f.initialCalls=[...calls];calls.length=0;
 f.el=id=>document.querySelector('#'+id);f.type=(id,value)=>{const el=f.el(id);el.value=value;el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 f.key=(target,key,options={})=>{const event=new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event;};f.open=()=>f.el('browser-tab-search').click();f.addNewTab=()=>{f.tabs=[...f.tabs.map(tab=>({...tab,active:false})),tab({id:Math.max(0,...f.tabs.map(tab=>tab.id))+1,title:'',url:''})];f.events['browser-tabs-changed']();};return f;
}

const audioTab=overrides=>tab({muted:false,playingAudio:true,canMute:true,canPrint:true,printContextToken:'ctx-'+(overrides?.id??1),...overrides});
const menuTab=(f,id=1)=>f.key(f.el(`browser-tab-${id}`).querySelector('.browser-tab-select'),'ContextMenu');
const menuItem=(f,label)=>[...f.el('browser-menu').querySelectorAll('button')].find(b=>b.textContent===label);
const openTools=f=>{f.el('browser-tools').click();menuItem(f,'その他の操作').click();};
const control=(f,kind)=>f.el('browser-menu').querySelector(`[data-browser-control="${kind}"]`);

test('Ctrl/meta Shift N and Native private-new share one pending private creation with no ordinary fallback',async t=>{
 for(const meta of [false,true]){const f=await fixture(t),wait=deferred();f.wait.set('browser_new_private_tab',wait);
  const event=f.key(f.document,'N',{ctrlKey:!meta,metaKey:meta,shiftKey:true});f.key(f.document,'N',{ctrlKey:!meta,metaKey:meta,shiftKey:true,repeat:true});f.events['browser-shortcut']({payload:'private-new'});await tick();
  assert.equal(event.defaultPrevented,true);assert.deepEqual(f.calls.filter(call=>call.name==='browser_new_private_tab'),[{name:'browser_new_private_tab',args:{url:null}}]);assert.equal(f.calls.some(call=>call.name==='browser_new_tab'),false);
  wait.resolve();await tick();f.view='feed';await f.workspace.dispatch('private-new');assert.equal(f.calls.filter(call=>call.name==='browser_new_private_tab').length,1);
 }
});
test('private shortcut ignores repeat, wrong view/inactive, Alt and all IME variants before creation',async t=>{
 for(const options of [{},{view:'feed'},{active:false}]){const f=await fixture(t,options);
  f.key(f.document,'N',{ctrlKey:true,shiftKey:true,repeat:true});f.key(f.document,'N',{ctrlKey:true,shiftKey:true,altKey:true});f.key(f.document,'N',{ctrlKey:true,shiftKey:true,isComposing:true});f.key(f.document,'N',{ctrlKey:true,shiftKey:true,keyCode:229});
  if(options.view||options.active===false){f.key(f.document,'N',{ctrlKey:true,shiftKey:true});await f.workspace.dispatch('private-new');}
  f.el('browser-url').dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.events['browser-shortcut']({payload:'private-new'});await tick();assert.equal(f.calls.some(call=>call.name==='browser_new_private_tab'||call.name==='browser_new_tab'),false);
 }
});
test('private creation rejection reports failure and never enters an ordinary tab; late ACK does not steal focus',async t=>{
 const f=await fixture(t);f.fail.add('browser_new_private_tab');await assert.rejects(f.workspace.dispatch('private-new'),/private_unavailable/);assert.equal(f.calls.some(call=>call.name==='browser_new_tab'),false);
 f.key(f.document,'N',{ctrlKey:true,shiftKey:true});await tick();assert.match(f.el('browser-error').textContent,/通常のタブには切り替えていません/);
 f.fail.clear();const wait=deferred();f.wait.set('browser_new_private_tab',wait);const pending=f.workspace.dispatch('private-new');await tick();f.view='feed';f.active=false;f.workspace.cancelPendingFocus();wait.resolve();await pending;
 assert.equal(f.calls.some(call=>call.name==='browser_focus_address'||call.name==='browser_focus_controls'),false);assert.equal(f.calls.some(call=>call.name==='browser_new_tab'),false);
});

test('one-page real markup keeps the compact audio indicator outside clipped titles in both tab layouts',async t=>{
 for(const tabLayout of ['vertical','horizontal']){const title='<img src=x onerror=alert(1)> 日'.repeat(100),f=await fixture(t,{tabs:[audioTab({title,private:true}),audioTab({id:2,active:false,title:'other',muted:true})],tabLayout});
  const row=f.el('browser-tab-1'),indicator=row.querySelector('[aria-label="音声再生中"]'),select=row.querySelector('.browser-tab-select');assert.equal(indicator.parentElement,row.querySelector('[data-tab-action="audio"]'));assert.equal(indicator.parentElement.parentElement,row);assert.equal(select.contains(indicator),false);assert.equal(indicator.closest('.browser-tab-title'),null);assert.equal(row.querySelector('.browser-tab-title').textContent,title);assert.equal(row.querySelector('img'),null);assert.equal(row.querySelector('.browser-tab-badge').textContent,'◇');
  assert.equal(f.el('browser-tab-2').querySelector('[aria-label="音声ミュート中"]').parentElement,f.el('browser-tab-2').querySelector('[data-tab-action="audio"]'));assert.equal(f.calls.some(c=>['browser_set_muted','browser_show_print'].includes(c.name)),false);
 }
});

test('audio control preserves actual state until ACK and a fresh getter, locking duplicate submissions',async t=>{
 const f=await fixture(t,{tabs:[audioTab()]}),wait=deferred();menuTab(f);f.wait.set('browser_set_muted',wait);
 assert.equal(control(f,'mute').textContent,'音声をミュート');assert.ok(f.el('browser-tab-1').querySelector('[aria-label="音声再生中"]'));
 const old=control(f,'mute');old.click();old.click();await tick();
 assert.equal(old.disabled,true);assert.equal(f.calls.filter(c=>c.name==='browser_set_muted').length,1);assert.deepEqual(f.calls.find(c=>c.name==='browser_set_muted').args,{id:1,muted:true});
 assert.ok(f.el('browser-tab-1').querySelector('[aria-label="音声再生中"]'));assert.equal(f.el('browser-tab-1').querySelector('[aria-label="音声ミュート中"]'),null);
 wait.resolve();await tick();await tick();assert.ok(f.el('browser-tab-1').querySelector('[aria-label="音声ミュート中"]'));assert.equal(control(f,'mute').textContent,'音声のミュートを解除');assert.equal(control(f,'mute').disabled,false);
 control(f,'mute').click();await tick();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_set_muted').map(c=>c.args),[{id:1,muted:true},{id:1,muted:false}]);
});

test('mute targets background tab identity even for duplicate URLs and never derives state from mutation ACK',async t=>{
 const f=await fixture(t,{tabs:[audioTab(),audioTab({id:2,active:false,title:'background'})]});f.applyMute=false;menuTab(f,2);control(f,'mute').click();await tick();await tick();
 assert.deepEqual(f.calls.find(c=>c.name==='browser_set_muted').args,{id:2,muted:true});assert.equal(f.tabs[0].muted,false);assert.equal(f.tabs[1].muted,false);assert.equal(control(f,'mute').textContent,'音声をミュート');
});

test('missing or unknown capability DTOs and discarded tabs remain inoperable without false indicators',async t=>{
 for(const data of [{},{muted:'false',playingAudio:'true',canMute:true,canPrint:'true'},{muted:null,playingAudio:null,canMute:true,canPrint:false},{muted:false,playingAudio:false,canMute:false,canPrint:false},{muted:false,playingAudio:false,canMute:true,canPrint:true,discarded:true}]){
  const f=await fixture(t,{tabs:[tab(data)]});menuTab(f);assert.equal(control(f,'mute').disabled,true);control(f,'mute').click();f.el('browser-tools').click();assert.equal(control(f,'print').disabled,true);control(f,'print').click();f.key(f.document,'p',{ctrlKey:true});f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});await tick();
  assert.equal(f.calls.some(c=>['browser_set_muted','browser_show_print'].includes(c.name)),false);assert.equal(f.el('browser-tab-1').querySelector('[role="img"]'),null);
 }
});

test('restored private and normal muted tabs display native state while discard and recreation use fresh capabilities',async t=>{
 const f=await fixture(t,{tabs:[audioTab({private:true,muted:true,playingAudio:false}),audioTab({id:2,active:false,muted:true})]});
 assert.ok(f.el('browser-tab-1').textContent.includes('プライベート'));assert.ok(f.el('browser-tab-1').querySelector('[aria-label="音声ミュート中"]'));assert.ok(f.el('browser-tab-2').querySelector('[aria-label="音声ミュート中"]'));
 f.tabs=[audioTab({private:true,discarded:true,muted:null,playingAudio:null,canMute:false,canPrint:false})];await f.workspace.refresh();menuTab(f);assert.equal(control(f,'mute').disabled,true);
 f.tabs=[audioTab({private:true,muted:true,playingAudio:false})];await f.workspace.refresh();menuTab(f);assert.equal(control(f,'mute').disabled,false);assert.equal(control(f,'mute').textContent,'音声のミュートを解除');
 assert.equal([...Array.from({length:f.dom.window.localStorage.length},(_,i)=>f.dom.window.localStorage.key(i))].some(key=>/muted|audio/i.test(key)),false);
});

test('mute failure retains the actual indicator and a delayed failure cannot overwrite another browser context',async t=>{
 const f=await fixture(t,{tabs:[audioTab()]});menuTab(f);f.fail.add('browser_set_muted');control(f,'mute').click();await tick();assert.ok(f.el('browser-tab-1').querySelector('[aria-label="音声再生中"]'));assert.equal(f.el('browser-error').hidden,false);assert.equal(control(f,'mute').disabled,false);
 const wait=deferred();f.fail.clear();f.wait.set('browser_set_muted',wait);control(f,'mute').click();await tick();f.view='feed';f.active=false;f.workspace.cancelPendingFocus();f.el('browser-error').hidden=true;wait.reject(Error('browser_audio_unavailable'));await tick();await tick();assert.equal(f.el('browser-error').hidden,true);
});

test('printing through tools, main CtrlP and fixed native event uses only the exact active tab and never prints silently',async t=>{
 for(const action of ['tools','key','native']){const f=await fixture(t,{tabs:[audioTab({active:false}),audioTab({id:2,title:'selected',url:'https://selected.example/',active:true})]});
  if(action==='tools'){f.el('browser-tools').click();assert.equal(control(f,'print').textContent,'ページを印刷…');control(f,'print').click();}
  else if(action==='key')assert.equal(f.key(f.document,'p',{ctrlKey:true}).defaultPrevented,true);
  else f.events['browser-print-request']({payload:{tabId:2,contextToken:'ctx-2'}});
  await tick();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_show_print'),[{name:'browser_show_print',args:{id:2,contextToken:'ctx-2'}}]);assert.equal(f.el('browser-menu').hidden,true);assert.equal(f.el('browser-error').hidden,true);assert.equal(f.document.body.textContent.includes('印刷が完了'),false);
 }
});

test('print dispatch busy only covers pending ACK and does not invent dialog-close state',async t=>{
 const f=await fixture(t,{tabs:[audioTab()]}),wait=deferred();f.wait.set('browser_show_print',wait);f.el('browser-tools').click();const old=control(f,'print');old.click();old.click();f.key(f.document,'p',{ctrlKey:true});f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});await tick();assert.equal(f.calls.filter(c=>c.name==='browser_show_print').length,1);
 wait.resolve();await tick();await tick();f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});await tick();await tick();assert.equal(f.calls.filter(c=>c.name==='browser_show_print').length,2);
});

test('print acknowledgement rejects wrong identity, false, malformed and extra fields without replay',async t=>{
 for(const result of [{tabId:2,dialogShown:true},{tabId:1,dialogShown:false},{tabId:'1',dialogShown:true},{dialogShown:true},{tabId:1,dialogShown:true,path:'arbitrary'},true,[]]){
  const f=await fixture(t,{tabs:[audioTab()]});f.printResult=result;f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});await tick();await tick();assert.equal(f.calls.filter(c=>c.name==='browser_show_print').length,1);assert.equal(f.el('browser-error').hidden,false);assert.equal(f.calls.some(c=>/save|printer|silent/i.test(c.name)),false);
 }
});

test('captured print and mute controls reject changed, closed, switched and exited contexts before dispatch',async t=>{
 for(const change of ['navigate','close','switch-return','exit-return'])for(const kind of ['print','mute']){
  const f=await fixture(t,{tabs:[audioTab(),audioTab({id:2,active:false,url:'https://two.example/'})]});if(kind==='print')f.el('browser-tools').click();else menuTab(f);const old=control(f,kind);
  if(change==='navigate'){f.tabs[0]={...f.tabs[0],url:'https://new.example/'};await f.workspace.refresh();}
  if(change==='close'){f.tabs=f.tabs.slice(1).map(tab=>({...tab,active:true}));await f.workspace.refresh();}
  if(change==='switch-return'){f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===2}));await f.workspace.refresh();f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===1}));await f.workspace.refresh();}
  if(change==='exit-return'){f.active=false;f.view='feed';f.workspace.cancelPendingFocus();f.active=true;f.view='browser';}
  old.onclick();await tick();assert.equal(f.calls.some(c=>c.name===(kind==='print'?'browser_show_print':'browser_set_muted')),false);
 }
});

test('late print ACK after navigation, selection, exit or closure cannot refresh or expose status in the new context',async t=>{
 for(const change of ['navigate','switch-return','exit-return','close']){const f=await fixture(t,{tabs:[audioTab(),audioTab({id:2,active:false})]}),wait=deferred();f.wait.set('browser_show_print',wait);f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});await tick();
  if(change==='navigate')f.tabs[0]={...f.tabs[0],url:'https://new.example/'};
  if(change==='close')f.tabs=f.tabs.slice(1).map(tab=>({...tab,active:true}));
  if(change==='switch-return'){f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===2}));await f.workspace.refresh();f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===1}));}
  if(change==='exit-return'){f.view='feed';f.workspace.cancelPendingFocus();f.view='browser';}
  await f.workspace.refresh();f.calls.length=0;wait.resolve();await tick();await tick();assert.equal(f.calls.some(c=>c.name==='browser_tabs'),false);assert.equal(f.el('browser-error').hidden,true);
 }
});

test('failed or pending getters disable capability operations until a new successful read',async t=>{
 const f=await fixture(t,{tabs:[audioTab()]});f.el('browser-tools').click();const print=control(f,'print'),wait=deferred();f.readOverride=async(name)=>{if(name==='browser_tabs')return wait.promise;return []};const pending=f.workspace.refresh();await tick();assert.equal(print.disabled,true);f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});assert.equal(f.calls.some(c=>c.name==='browser_show_print'),false);wait.reject(Error('browser_audio_unavailable'));await pending;assert.equal(print.disabled,true);delete f.readOverride;await f.workspace.refresh();f.el('browser-tools').click();f.el('browser-tools').click();assert.equal(control(f,'print').disabled,false);
});

test('print shortcuts preserve IME, modifier and off-view boundaries',async t=>{
 for(const options of [{isComposing:true},{altKey:true},{shiftKey:true},{keyCode:229}]){const f=await fixture(t,{tabs:[audioTab()]});f.key(f.document,'p',{ctrlKey:true,...options});await tick();assert.equal(f.calls.some(c=>c.name==='browser_show_print'),false);}
 for(const context of [{view:'feed'},{active:false},{tabs:[audioTab({url:''})]}]){const f=await fixture(t,{tabs:[audioTab()],...context});f.key(f.document,'p',{ctrlKey:true});f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});await tick();assert.equal(f.calls.some(c=>c.name==='browser_show_print'),false);}
});

test('child print delivery cannot retarget another tab or dispatch from an untyped legacy event',async t=>{
 const f=await fixture(t,{tabs:[audioTab(),audioTab({id:2,active:false,url:'https://two.example/'})]});
 f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===2}));await f.workspace.refresh();f.calls.length=0;
 f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});f.events['browser-shortcut']({payload:'print'});await tick();assert.equal(f.calls.some(c=>c.name==='browser_show_print'),false);
 f.events['browser-print-request']({payload:{tabId:2,contextToken:'ctx-2'}});await tick();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_show_print'),[{name:'browser_show_print',args:{id:2,contextToken:'ctx-2'}}]);
});

test('typed child print checks a fresh snapshot and locks duplicate requests throughout the read',async t=>{
 for(const change of ['none','switch','navigate','closed','exit']){const f=await fixture(t,{tabs:[audioTab(),audioTab({id:2,active:false,url:'https://two.example/'})]}),wait=deferred();
  f.readOverride=async name=>name==='browser_tabs'?wait.promise:[];f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});f.key(f.document,'p',{ctrlKey:true});await tick();assert.equal(f.calls.filter(c=>c.name==='browser_tabs').length,1);assert.equal(f.calls.some(c=>c.name==='browser_show_print'),false);
  if(change==='switch')f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===2}));
  if(change==='navigate')f.tabs[0]={...f.tabs[0],url:'https://changed.example/'};
  if(change==='closed')f.tabs=f.tabs.slice(1).map(tab=>({...tab,active:true}));
  if(change==='exit'){f.active=false;f.view='feed';f.workspace.cancelPendingFocus();}
  wait.resolve(f.tabs);await tick();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_show_print'),change==='none'?[{name:'browser_show_print',args:{id:1,contextToken:'ctx-1'}}]:[]);
 }
});

test('child print rejects every malformed ID or envelope and supports dialog cancellation without completion claims',async t=>{
 const f=await fixture(t,{tabs:[audioTab()]});
 for(const value of [null,[],true,'print',{}, {tabId:0},{tabId:-1},{tabId:1.1},{tabId:NaN},{tabId:Infinity},{tabId:9007199254740992},{tabId:'1'},{tabId:1,path:'ignored'},{tabId:2}]){const payload=value&&typeof value==='object'&&!Array.isArray(value)?{contextToken:'ctx-1',...value}:value;f.events['browser-print-request']({payload});}
 await tick();assert.equal(f.calls.some(c=>c.name==='browser_show_print'||c.name==='browser_tabs'),false);
 f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});await tick();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_show_print'),[{name:'browser_show_print',args:{id:1,contextToken:'ctx-1'}}]);
 assert.equal(f.document.body.textContent.includes('印刷が完了'),false);assert.equal(f.calls.some(c=>/save|cancel.*print|printer|silent/i.test(c.name)),false);
 // Native provides no close/cancel callback: a later explicit request is legal.
 f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});await tick();await tick();assert.equal(f.calls.filter(c=>c.name==='browser_show_print').length,2);
});

test('a delayed same-ID child request cannot print a new URL or replaced child after UI has updated',async t=>{
 for(const change of ['navigation','child']){const f=await fixture(t,{tabs:[audioTab()]});
  f.tabs=[audioTab({url:change==='navigation'?'https://new.example/':tab().url,printContextToken:'replacement-token'})];await f.workspace.refresh();f.calls.length=0;
  f.events['browser-print-request']({payload:{tabId:1,contextToken:'ctx-1'}});await tick();assert.equal(f.calls.some(c=>c.name==='browser_show_print'||c.name==='browser_tabs'),false);
  f.events['browser-print-request']({payload:{tabId:1,contextToken:'replacement-token'}});await tick();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_show_print'),[{name:'browser_show_print',args:{id:1,contextToken:'replacement-token'}}]);
 }
});

test('main shortcuts and tools require a matching fresh token and legacy or invalid tokens never grant print capability',async t=>{
 for(const entry of ['tools','main']){const f=await fixture(t,{tabs:[audioTab()]});if(entry==='tools')f.el('browser-tools').click();f.tabs=[audioTab({printContextToken:'new-native-token'})];
  if(entry==='tools')control(f,'print').click();else f.key(f.document,'p',{ctrlKey:true});await tick();await tick();assert.equal(f.calls.some(c=>c.name==='browser_show_print'),false);
 }
 for(const token of [undefined,null,'',true,1,'contains space','line\n','\u0000','\u007f','\u0085','日本語','a'.repeat(129)]){const f=await fixture(t,{tabs:[audioTab({printContextToken:token})]});f.el('browser-tools').click();assert.equal(control(f,'print').disabled,true);f.key(f.document,'p',{ctrlKey:true});f.events['browser-print-request']({payload:{tabId:1,contextToken:token}});await tick();assert.equal(f.calls.some(c=>c.name==='browser_show_print'),false);}
 for(const token of ['!', 'a'.repeat(128)]){const f=await fixture(t,{tabs:[audioTab({printContextToken:token})]});f.events['browser-print-request']({payload:{tabId:1,contextToken:token}});await tick();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_show_print'),[{name:'browser_show_print',args:{id:1,contextToken:token}}]);}
});

test('process controller selects through normal tab flow and closes menu only after native ACK',async t=>{
 const f=await fixture(t),wait=deferred();f.open();f.wait.set('browser_activate_tab',wait);
 f.events['browser-control-select']({payload:2});await tick();
 assert.equal(f.el('browser-menu').hidden,false);assert.deepEqual(f.calls.find(c=>c.name==='browser_activate_tab').args,{id:2});
 wait.resolve();await tick();await tick();assert.equal(f.el('browser-menu').hidden,true);assert.equal(f.tabs.find(t=>t.active).id,2);
});

test('AI handoff captures tab ID and URL and only appends a draft after a matching successful response',async t=>{
 const f=await fixture(t),wait=deferred();f.wait.set('browser_send_to_ai',wait);const action=f.el('browser-ai').onclick;
 const pending=action();await action();assert.equal(f.calls.filter(call=>call.name==='browser_send_to_ai').length,1);assert.deepEqual(f.calls.find(call=>call.name==='browser_send_to_ai').args,{id:1,url:tab().url});assert.deepEqual(f.drafts,[]);
 wait.resolve();await pending;assert.deepEqual(f.drafts,['page draft']);assert.equal(f.calls.some(call=>call.name==='pi_work_start'),false);assert.equal(f.el('browser-ai').disabled,false);
});

test('AI handoff drops delayed extraction after tab changes, navigation, closing, view exit and return, or a superseding refresh',async t=>{
 for(const change of ['switch','navigate','close','view','inactive','exit-return','switch-return','navigation-return','refresh']){
  const f=await fixture(t),wait=deferred();f.wait.set('browser_send_to_ai',wait);const pending=f.el('browser-ai').onclick();
  if(change==='switch'||change==='switch-return'){f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===2}));await f.workspace.refresh();if(change==='switch-return'){f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===1}));await f.workspace.refresh();}}
  if(change==='navigate'||change==='navigation-return'){f.tabs=f.tabs.map(entry=>entry.id===1?{...entry,url:'https://navigated.example/'}:entry);f.events['browser-url-changed']();await tick();if(change==='navigation-return'){f.tabs=f.tabs.map(entry=>entry.id===1?{...entry,url:tab().url}:entry);await f.workspace.refresh();}}
  if(change==='close'){f.tabs=[];await f.workspace.refresh();}
  if(change==='view')f.view='feed';if(change==='inactive')f.active=false;
  if(change==='exit-return'){f.workspace.cancelPendingFocus();f.view='feed';f.active=false;f.view='browser';f.active=true;}
  if(change==='refresh'){f.tabs=f.tabs.map(entry=>entry.id===1?{...entry,discarded:true}:entry);await f.workspace.refresh();}
  wait.resolve();await pending;assert.deepEqual(f.drafts,[],change);assert.equal(f.calls.some(call=>call.name==='pi_work_start'),false,change);
 }
});

test('AI handoff does not start off-view or from a blank tab and keeps previous drafts on extraction or composer failure',async t=>{
 for(const options of [{view:'feed'},{active:false},{tabs:[tab({url:''})]}]){const f=await fixture(t,options);await f.el('browser-ai').onclick();assert.equal(f.calls.some(call=>call.name==='browser_send_to_ai'),false);}
 const f=await fixture(t);f.drafts.push('existing unsent draft');f.fail.add('browser_send_to_ai');await f.el('browser-ai').onclick();assert.deepEqual(f.drafts,['existing unsent draft']);assert.equal(f.el('browser-error').hidden,false);assert.equal(f.el('browser-ai').disabled,false);
 f.fail.clear();f.draftFailure=true;await f.el('browser-ai').onclick();assert.deepEqual(f.drafts,['existing unsent draft']);assert.match(f.el('browser-error').textContent,/送信・操作中/);
 f.draftFailure=false;f.aiDraft=tab().url;await f.el('browser-ai').onclick();assert.deepEqual(f.drafts,['existing unsent draft',tab().url]);assert.equal(f.calls.some(call=>call.name==='pi_work_start'),false);
});

test('process controller ignores unsafe IDs, missing tabs, off-view and in-progress IME composition',async t=>{
 const f=await fixture(t);f.open();
 for(const payload of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'2',null,{},999])f.events['browser-control-select']({payload});
 f.el('browser-tab-menu-query').dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.events['browser-control-select']({payload:2});
 await tick();assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'),false);
 f.el('browser-tab-menu-query').dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));f.view='feed';f.events['browser-control-select']({payload:2});
 await tick();assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'),false);
});

test('process controller menu close preserves tabs and input query',async t=>{
 const f=await fixture(t);f.open();f.type('browser-tab-menu-query','second');await f.workspace.dispatch('tabs-close');
 assert.equal(f.el('browser-menu').hidden,true);assert.equal(f.el('sidebar-tab-query').value,'second');assert.equal(f.tabs.length,2);assert.equal(f.calls.some(c=>c.name==='browser_close_tab'),false);
});

test('sidebar and tabs popup share local query and exact counts; typing causes zero IPC after initial refresh',async t=>{
 const f=await fixture(t,{tabLayout:'vertical',tabs:[tab(),tab({id:2,title:'first',url:'https://two.example/full/path?q=2',active:false}),tab({id:3,title:'',url:'',active:false,pinned:true,discarded:true})]});
 f.type('sidebar-tab-query','two.example full');assert.equal(f.document.querySelectorAll('.sidebar-tab').length,1);assert.equal(f.el('sidebar-tab-count').textContent,'1 / 3 タブ · 休止中 1');assert.equal(f.calls.length,0);
 f.open();assert.equal(f.el('browser-tab-menu-query').value,'two.example full');assert.equal(f.el('browser-tab-menu-count').textContent,'1 / 3 タブ');assert.equal(f.el('browser-tab-menu-query'),f.document.activeElement);
 f.type('browser-tab-menu-query','固定 メモリ解放');assert.equal(f.el('sidebar-tab-query').value,'固定 メモリ解放');assert.equal(f.document.querySelector('.sidebar-tab').dataset.tabId,'3');assert.equal(f.document.querySelector('.browser-tab-results [data-tab-id]').dataset.tabId,'3');assert.equal(f.calls.length,0);
 f.type('sidebar-tab-query','absent');assert.equal(f.el('browser-tab-menu-query').value,'absent');assert.equal(f.el('sidebar-tab-empty').hidden,false);assert.equal(f.el('browser-tab-menu-empty').hidden,false);assert.equal(f.el('browser-tab-menu-count').textContent,'0 / 3 タブ');assert.equal(f.calls.length,0);
});

test('tab results preserve duplicate URL identities, full literal text, blank tabs and native 64-tab limit without injected markup',async t=>{
 const hostile='<img src="https://never.invalid/" onerror="bad()">',url='https://same.example/'+('path/'.repeat(100)),f=await fixture(t,{tabs:[tab({title:hostile,url}),tab({id:2,title:hostile,url,active:false}),tab({id:3,title:'',url:'',active:false}),...Array.from({length:61},(_,i)=>tab({id:i+4,title:'more'+i,active:false}))]});f.open();
 assert.equal(f.document.querySelectorAll('.browser-tab-results > button').length,64);assert.equal(f.el('browser-tab-menu-count').textContent,'64 / 64 タブ');assert.equal(f.document.querySelector('.browser-tab-results').querySelector('img,script,iframe'),null);assert.equal(f.document.querySelector('#browser-tab-result-1 strong').textContent,hostile);assert.equal(f.document.querySelector('#browser-tab-result-1 small').textContent,url);assert.equal(f.document.querySelector('#browser-tab-result-2 small').textContent,url);
 assert.equal(f.document.querySelector('#browser-tab-result-3 strong').textContent,'新しいタブ');f.type('browser-tab-menu-query','新しいタブ');f.key(f.el('browser-tab-menu-query'),'Enter');await tick();assert.deepEqual(f.calls.find(call=>call.name==='browser_activate_tab').args,{id:3});assert.equal(f.calls.some(call=>call.name==='browser_navigate'),false);
});

test('Enter and arrow selection activate the exact visible tab, while numeric shortcuts retain original order',async t=>{
 const f=await fixture(t,{tabs:[tab({id:11}),tab({id:22,title:'match B',active:false}),tab({id:33,title:'match C',active:false})]});f.type('sidebar-tab-query','match');f.open();f.key(f.el('browser-tab-menu-query'),'ArrowDown');assert.equal(f.el('browser-tab-menu-query').getAttribute('aria-activedescendant'),'browser-tab-result-33');f.key(f.el('browser-tab-menu-query'),'Enter');await tick();assert.deepEqual(f.calls.find(call=>call.name==='browser_activate_tab').args,{id:33});
 f.calls.length=0;f.key(f.document.body,'1',{ctrlKey:true});await tick();assert.deepEqual(f.calls.find(call=>call.name==='browser_activate_tab').args,{id:11});assert.equal(f.calls.some(call=>call.name==='browser_navigate'),false);
});

test('keyboard selection scrolls the exact selected row into view at 64-tab boundaries without moving query focus',async t=>{
 const f=await fixture(t,{tabs:Array.from({length:64},(_,i)=>tab({id:i+1,title:'tab '+(i+1),active:i===0}))});f.open();const query=f.el('browser-tab-menu-query');assert.equal(f.scrollCalls.length,0);
 for(let i=0;i<19;i++)f.key(query,'ArrowDown');assert.deepEqual(f.scrollCalls.at(-1),{id:'browser-tab-result-20',options:{block:'nearest',inline:'nearest'}});assert.equal(query.getAttribute('aria-activedescendant'),'browser-tab-result-20');assert.equal(f.document.activeElement,query);assert.equal(f.calls.length,0);
 f.type('browser-tab-menu-query','');f.scrollCalls.length=0;f.key(query,'ArrowUp');assert.equal(f.scrollCalls.at(-1).id,'browser-tab-result-64');f.key(query,'ArrowUp');assert.equal(f.scrollCalls.at(-1).id,'browser-tab-result-63');f.key(query,'ArrowDown');assert.equal(f.scrollCalls.at(-1).id,'browser-tab-result-64');f.key(query,'ArrowDown');assert.equal(f.scrollCalls.at(-1).id,'browser-tab-result-1');
 f.scrollCalls.length=0;f.type('browser-tab-menu-query','tab');f.el('browser-tab-result-1').dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));assert.equal(f.scrollCalls.length,0);f.key(query,'ArrowDown',{isComposing:true});f.type('browser-tab-menu-query','absent');f.key(query,'ArrowDown');assert.equal(f.scrollCalls.length,0);assert.equal(f.document.activeElement,query);assert.equal(f.calls.length,0);
});

test('IME events and legacy 229 do not select, clear, close or dispatch shortcuts; Escape clears before closing',async t=>{
 const f=await fixture(t);f.open();f.type('browser-tab-menu-query','second');const query=f.el('browser-tab-menu-query');query.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));
 for(const key of ['ArrowDown','Enter','Escape'])f.key(query,key);f.key(query,'a',{ctrlKey:true,shiftKey:true});f.events['browser-shortcut']({payload:'tabs'});await tick();assert.equal(f.el('browser-menu').hidden,false);assert.equal(query.value,'second');assert.equal(f.calls.length,0);
 query.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));for(const key of ['Enter','Escape'])f.key(query,key,{keyCode:229});assert.equal(query.value,'second');assert.equal(f.calls.length,0);
 f.key(query,'Escape');assert.equal(query.value,'');assert.equal(f.el('sidebar-tab-query').value,'');assert.equal(f.el('browser-menu').hidden,false);f.key(query,'Escape');assert.equal(f.el('browser-menu').hidden,true);
 f.type('sidebar-tab-query','first');f.key(f.el('sidebar-tab-query'),'Enter',{isComposing:true});assert.equal(f.calls.length,0);f.key(f.el('sidebar-tab-query'),'Enter');await tick();assert.deepEqual(f.calls.find(call=>call.name==='browser_activate_tab').args,{id:1});
});

test('closed IDs never fall back to URL navigation or activate another tab from captured results',async t=>{
 const f=await fixture(t);f.open();const old=f.el('browser-tab-result-2'),oldClick=old.onclick;f.tabs=[tab()];await f.workspace.refresh();f.calls.length=0;await oldClick();await tick();assert.equal(f.calls.length,0);
 f.type('browser-tab-menu-query','no match');f.key(f.el('browser-tab-menu-query'),'Enter');assert.equal(f.calls.length,0);
 f.type('browser-tab-menu-query','first');f.fail.add('browser_activate_tab');f.key(f.el('browser-tab-menu-query'),'Enter');await tick();assert.equal(f.calls.filter(call=>call.name==='browser_activate_tab').length,1);assert.equal(f.calls.some(call=>call.name==='browser_navigate'),false);assert.equal(f.el('browser-error').hidden,false);
});

test('CtrlShiftA and native tabs event open the same menu, while delayed focus after leaving cannot steal focus',async t=>{
 const f=await fixture(t);f.key(f.document.body,'A',{ctrlKey:true,shiftKey:true});await tick();assert.equal(f.el('browser-menu').hidden,false);assert.equal(f.el('browser-tab-menu-query'),f.document.activeElement);assert.equal(f.calls.filter(call=>call.name==='browser_focus_controls').length,1);
 f.el('browser-menu').hidden=true;f.events['browser-shortcut']({payload:'tabs'});await tick();assert.equal(f.el('browser-menu').hidden,false);
 const pending=deferred();f.wait.set('browser_focus_controls',pending);f.el('browser-menu').hidden=true;f.el('content-title').focus();const focus=f.document.activeElement;const opening=f.workspace.dispatch('tabs');f.view='feed';f.active=false;pending.resolve();await opening;assert.equal(f.document.activeElement,focus);assert.equal(f.el('browser-menu').hidden,true);
});

test('new tab ACK alone does not focus; eventual active blank new ID clears filter and focuses after Native child activation',async t=>{
 const f=await fixture(t);f.type('sidebar-tab-query','second');f.el('browser-find-query').focus();const previous=f.document.activeElement;
 await f.workspace.dispatch('new');assert.equal(f.document.activeElement,previous);assert.equal(f.calls.some(call=>call.name==='browser_focus_controls'),false);assert.equal(f.el('sidebar-tab-query').value,'second');
 f.addNewTab();await tick();assert.equal(f.calls.filter(call=>call.name==='browser_focus_controls').length,1);assert.equal(f.document.activeElement,f.el('browser-url'));assert.equal(f.el('browser-url').value,'');assert.equal(f.el('sidebar-tab-query').value,'');assert.ok(f.document.querySelector('.sidebar-tab[data-tab-id="3"]'));
 f.events['browser-tabs-changed']();await tick();assert.equal(f.calls.filter(call=>call.name==='browser_focus_controls').length,1);
});

test('event before successful ACK waits for ACK; failed ACK never clears query or focuses even after observed creation',async t=>{
 for(const failed of [false,true]){const f=await fixture(t),ack=deferred();f.wait.set('browser_new_tab',ack);f.type('sidebar-tab-query','second');f.el('browser-find-query').focus();const previous=f.document.activeElement;
 const start=f.workspace.dispatch('new').catch(()=>{});await tick();f.addNewTab();await tick();assert.equal(f.document.activeElement,previous);assert.equal(f.calls.some(call=>call.name==='browser_focus_controls'),false);assert.equal(f.el('sidebar-tab-query').value,'second');
 if(failed)f.fail.add('browser_new_tab');ack.resolve();await start;assert.equal(f.calls.filter(call=>call.name==='browser_focus_controls').length,failed?0:1);assert.equal(f.el('sidebar-tab-query').value,failed?'second':'');assert.equal(f.document.activeElement,failed?previous:f.el('browser-url'));}
});

test('first inactive empty enter also waits for new active blank ID event without duplicate creation',async t=>{
 const f=await fixture(t,{tabs:[],active:false,view:'feed'});await f.workspace.dispatch('new');assert.equal(f.calls.filter(call=>call.name==='fixture_enter').length,1);assert.equal(f.calls.some(call=>call.name==='browser_new_tab'),false);assert.equal(f.calls.some(call=>call.name==='browser_focus_controls'),false);
 f.addNewTab();await tick();assert.equal(f.document.activeElement,f.el('browser-url'));assert.equal(f.tabs.length,1);
});

test('old blank IDs, inactive new IDs and new navigated IDs cannot satisfy pending new tab focus',async t=>{
 const f=await fixture(t,{tabs:[tab({url:'',title:''})]});await f.workspace.dispatch('new');for(const tabs of [[tab({url:'',title:''})],[tab(),tab({id:2,url:'',title:'',active:false})],[tab({id:3,url:'https://other.example'})]]){f.tabs=tabs;f.events['browser-tabs-changed']();await tick();assert.equal(f.calls.some(call=>call.name==='browser_focus_controls'),false);}
 f.addNewTab();await tick();assert.equal(f.document.activeElement,f.el('browser-url'));
});

test('leaving then returning without a tab event cancels pending focus; late child changes cannot clear query or steal it',async t=>{
 const f=await fixture(t);f.type('sidebar-tab-query','second');await f.workspace.dispatch('new');f.workspace.cancelPendingFocus();f.active=false;f.view='feed';f.active=true;f.view='browser';f.el('browser-find-query').focus();const previous=f.document.activeElement;f.addNewTab();await tick();assert.equal(f.document.activeElement,previous);assert.equal(f.el('sidebar-tab-query').value,'second');assert.equal(f.calls.some(call=>call.name==='browser_focus_controls'),false);
});

test('another focus intent, delayed failed ACK, and leaving during controls RPC invalidate pending focus',async t=>{
 for(const intent of ['focus','typing','dispatch','leave','late-ack']){const f=await fixture(t);const wait=deferred();if(intent==='late-ack')f.wait.set('browser_new_tab',wait);const starting=f.workspace.dispatch('new').catch(()=>{});await tick();
 if(intent==='focus')f.el('browser-find-query').focus();if(intent==='typing')f.key(f.el('sidebar-tab-query'),'x');if(intent==='dispatch')await f.workspace.dispatch('tabs');if(intent==='leave'){f.wait.set('browser_focus_controls',wait);f.addNewTab();await tick();f.active=false;f.view='feed';f.workspace.cancelPendingFocus();}if(intent==='late-ack'){f.workspace.cancelPendingFocus();f.fail.add('browser_new_tab');wait.resolve();}
 const previous=f.document.activeElement;if(intent!=='leave')f.addNewTab();else wait.resolve();await starting;await tick();assert.equal(f.document.activeElement,previous);if(intent!=='leave'&&intent!=='dispatch')assert.equal(f.calls.some(call=>call.name==='browser_focus_controls'),false);}
});

test('a newer refresh preserves an observed tabs-change intent; focus intent during controls RPC still cancels',async t=>{
 const f=await fixture(t);await f.workspace.dispatch('new');f.addNewTab();await f.workspace.refresh();await tick();assert.equal(f.document.activeElement,f.el('browser-url'));assert.equal(f.calls.filter(call=>call.name==='browser_focus_controls').length,1);
 const wait=deferred();f.wait.set('browser_focus_controls',wait);await f.workspace.dispatch('new');f.addNewTab();await tick();f.el('browser-find-query').focus();wait.resolve();await tick();assert.equal(f.document.activeElement,f.el('browser-find-query'));
});

test('observed blank tab navigating before ACK or during controls await cancels address focus',async t=>{
 for(const stage of ['ack','controls']){const f=await fixture(t),wait=deferred();f.wait.set(stage==='ack'?'browser_new_tab':'browser_focus_controls',wait);f.type('sidebar-tab-query','second');f.el('browser-find-query').focus();const previous=f.document.activeElement;
 const starting=f.workspace.dispatch('new');await tick();f.addNewTab();await tick();const id=f.tabs.find(tab=>tab.active).id;f.tabs=f.tabs.map(tab=>tab.id===id?{...tab,url:'https://navigated.example/full',title:'navigated'}:tab);f.events['browser-tabs-changed']();await tick();wait.resolve();await starting;await tick();assert.equal(f.document.activeElement,previous);assert.equal(f.el('browser-url').value,'https://navigated.example/full');if(stage==='ack'){assert.equal(f.calls.some(call=>call.name==='browser_focus_controls'),false);assert.equal(f.el('sidebar-tab-query').value,'second');}
 }
});

test('Native controls focus restoration on the current control does not cancel its own new tab address focus',async t=>{
 const f=await fixture(t),wait=deferred();f.el('browser-find-query').focus();f.wait.set('browser_focus_controls',wait);await f.workspace.dispatch('new');f.addNewTab();await tick();f.el('browser-find-query').dispatchEvent(new f.dom.window.FocusEvent('focusin',{bubbles:true}));wait.resolve();await tick();assert.equal(f.document.activeElement,f.el('browser-url'));assert.equal(f.calls.filter(call=>call.name==='browser_focus_controls').length,1);
});

test('unobserved successful ACK expires at ten seconds without timers and cannot focus a later unrelated blank tab',async t=>{
 for(const delta of [9999,10000,10001]){const f=await fixture(t);let now=100000;f.dom.window.Date.now=()=>now;await f.workspace.dispatch('new');now+=delta;f.addNewTab();await tick();assert.equal(f.calls.filter(call=>call.name==='browser_focus_controls').length,delta<10000?1:0);}
});

test('filtered sidebar drag and context moves keep original native positions and exact IDs',async t=>{
 const f=await fixture(t,{tabLayout:'vertical',tabs:[tab({id:11}),tab({id:22,title:'keep B',active:false}),tab({id:33,title:'keep C',active:false})]});f.type('sidebar-tab-query','keep');const rows=[...f.document.querySelectorAll('.sidebar-tab')];let transferred='';rows[0].ondragstart({dataTransfer:{setData:(_,value)=>transferred=value}});rows[1].ondrop({preventDefault:()=>{}});await tick();assert.equal(transferred,'22');assert.deepEqual(f.calls.find(call=>call.name==='browser_move_tab').args,{id:22,position:2});
 f.calls.length=0;f.document.querySelector('.sidebar-tab[data-tab-id="33"] .browser-tab-close').click();const back=[...f.el('browser-menu').querySelectorAll('button')].find(node=>node.textContent==='前へ移動');back.click();await tick();assert.deepEqual(f.calls.find(call=>call.name==='browser_move_tab').args,{id:33,position:1});
});

test('address typing remains local and address IME blocks form submission and arrow selection',async t=>{
 const f=await fixture(t),input=f.el('browser-url');input.focus();f.calls.length=0;f.type('browser-url','search text');assert.equal(f.calls.length,0);input.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.el('browser-form').dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));f.key(input,'ArrowDown');await tick();assert.equal(f.calls.length,0);assert.equal(input.hasAttribute('aria-activedescendant'),false);input.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));
});

test('history, favorites, find, pin, AI handoff and native panel tools remain available alongside tab search',async t=>{
 const f=await fixture(t,{tabs:[audioTab(),tab({id:2,active:false})]});f.favorites=[{url:'https://fav.example',title:'fav'}];f.history=[{url:'https://history.example',title:'history'}];await f.workspace.refresh();f.el('browser-history').click();assert.ok(menuItem(f,'← メニュー'));assert.ok(f.el('browser-menu').textContent.includes('history'));menuItem(f,'← メニュー').click();menuItem(f,'お気に入り').click();assert.ok(f.el('browser-menu').textContent.includes('fav'));
 f.el('browser-find').click();assert.equal(f.el('browser-find-bar').hidden,false);f.type('browser-find-query','needle');f.el('browser-find-form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await tick();assert.equal(f.calls.some(call=>call.name==='browser_find'),true);
 f.el('browser-ai').click();await tick();assert.deepEqual(f.drafts,['page draft']);openTools(f);assert.ok(f.el('browser-menu').textContent.includes('サイト権限'));assert.ok(f.el('browser-menu').textContent.includes('ダウンロード'));
 f.open();f.document.querySelector('.sidebar-tab .browser-tab-close').click();f.el('browser-tab-search').click();assert.ok(f.el('browser-tab-menu-query'));assert.equal(f.el('browser-menu').hidden,false);f.document.querySelector('.sidebar-tab .browser-tab-close').click();[...f.el('browser-menu').querySelectorAll('button')].find(node=>node.textContent==='タブを固定').click();await tick();assert.deepEqual(f.calls.find(call=>call.name==='browser_pin_tab').args,{id:1,pinned:true});
});


test('persisted inherited engine names retain Google fallback and a submitted search has a valid explicit target',async t=>{
 for(const savedEngine of ['__proto__','constructor','toString']){const f=await fixture(t,{savedEngine});assert.match(f.el('browser-url').placeholder,/DuckDuckGo/);openTools(f);const picker=f.document.querySelector('#browser-menu select');picker.value=savedEngine;picker.dispatchEvent(new f.dom.window.Event('change'));assert.match(f.el('browser-url').placeholder,/DuckDuckGo/);f.type('browser-url','Japanese search');await f.el('browser-form').onsubmit({preventDefault:()=>{}});assert.deepEqual(f.calls.find(call=>call.name==='browser_navigate_from_address').args,{id:1,url:'https://duckduckgo.com/?q=Japanese%20search'});assert.equal(f.el('browser-url').placeholder.includes('undefined'),false);}
});


test('pending tabs open cannot reopen or steal focus after explicit close before native ACK',async t=>{
 const f=await fixture(t),ack=deferred();f.wait.set('browser_focus_controls',ack);const opening=f.workspace.dispatch('tabs');await tick();await f.workspace.dispatch('tabs-close');f.el('browser-find-query').focus();const focus=f.document.activeElement;ack.resolve();await opening;assert.equal(f.el('browser-menu').hidden,true);assert.equal(f.document.activeElement,focus);assert.equal(f.el('browser-tab-menu-query'),null);
});


test('only the latest tabs request can open under either reversed native ACK order',async t=>{
 for(const newestFirst of [false,true]){const f=await fixture(t,{tabs:[audioTab()]}),a=deferred(),b=deferred();f.wait.set('browser_focus_controls',a);const older=f.workspace.dispatch('tabs');await tick();f.wait.set('browser_focus_controls',b);const newer=f.workspace.dispatch('tabs');await tick();
 if(newestFirst){b.resolve();await newer;const query=f.el('browser-tab-menu-query');a.resolve();await older;assert.equal(f.el('browser-tab-menu-query'),query);assert.equal(f.document.activeElement,query);}else{a.resolve();await older;assert.equal(f.el('browser-menu').hidden,true);b.resolve();await newer;assert.equal(f.document.activeElement,f.el('browser-tab-menu-query'));}
 assert.equal(f.el('browser-menu').hidden,false);assert.equal(f.calls.filter(c=>c.name==='browser_focus_controls').length,2);}
});

test('new tabs request after explicit close supersedes an older pending opening',async t=>{
 const f=await fixture(t,{tabs:[audioTab()]}),a=deferred(),b=deferred();f.wait.set('browser_focus_controls',a);const older=f.workspace.dispatch('tabs');await tick();await f.workspace.dispatch('tabs-close');f.wait.set('browser_focus_controls',b);const newer=f.workspace.dispatch('tabs');await tick();b.resolve();await newer;const query=f.el('browser-tab-menu-query');f.type('browser-tab-menu-query','second');a.resolve();await older;assert.equal(f.el('browser-tab-menu-query'),query);assert.equal(query.value,'second');assert.equal(f.document.activeElement,query);
});

test('direct history tools tab-context and find choices survive a late tabs opening ACK',async t=>{
 for(const choice of ['history','tools','context','find']){const f=await fixture(t),ack=deferred();f.wait.set('browser_focus_controls',ack);const opening=f.workspace.dispatch('tabs');await tick();
 if(choice==='context')f.document.querySelector('.sidebar-tab .browser-tab-close').onclick();else f.el('browser-'+choice).onclick();const html=f.el('browser-menu').innerHTML,hidden=f.el('browser-menu').hidden,focus=f.document.activeElement;ack.resolve();await opening;assert.equal(f.el('browser-menu').innerHTML,html);assert.equal(f.el('browser-menu').hidden,hidden);assert.equal(f.document.activeElement,focus);assert.equal(f.el('browser-tab-menu-query'),null);}
});

test('Escape cancels a pending tabs opening while retaining ordinary query clearing order',async t=>{
 const f=await fixture(t),ack=deferred();f.open();f.type('browser-tab-menu-query','second');f.wait.set('browser_focus_controls',ack);const opening=f.workspace.dispatch('tabs');await tick();const query=f.el('browser-tab-menu-query');f.key(query,'Escape');assert.equal(query.value,'');assert.equal(f.el('browser-menu').hidden,false);f.key(query,'Escape');assert.equal(f.el('browser-menu').hidden,true);const focus=f.document.activeElement;ack.resolve();await opening;assert.equal(f.el('browser-menu').hidden,true);assert.equal(f.document.activeElement,focus);
});

test('composition start cancels pending tabs open even when composition ends before ACK; explicit close is accepted during IME',async t=>{
 for(const field of ['browser-url','sidebar-tab-query','browser-tab-menu-query']){const f=await fixture(t),ack=deferred();f.open();f.type('browser-tab-menu-query','日本語');f.wait.set('browser_focus_controls',ack);const opening=f.workspace.dispatch('tabs');await tick();const node=f.el(field);node.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));f.events['browser-shortcut']({payload:'tabs-close'});assert.equal(f.el('browser-menu').hidden,true);assert.equal(f.el('sidebar-tab-query').value,'日本語');assert.equal(f.el('browser-tab-menu-query').value,'日本語');node.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));ack.resolve();await opening;assert.equal(f.el('browser-menu').hidden,true);}
 const f=await fixture(t);f.el('sidebar-tab-query').dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));await f.workspace.dispatch('tabs');assert.equal(f.calls.some(c=>c.name==='browser_focus_controls'),false);
});

test('view exit cancellation still prevents reopening after returning before native focus ACK',async t=>{
 const f=await fixture(t),ack=deferred();f.wait.set('browser_focus_controls',ack);const opening=f.workspace.dispatch('tabs');await tick();f.active=false;f.view='feed';f.workspace.cancelPendingFocus();f.active=true;f.view='browser';f.el('browser-find-query').focus();const focus=f.document.activeElement;ack.resolve();await opening;assert.equal(f.el('browser-menu').hidden,true);assert.equal(f.document.activeElement,focus);
});

test('rejected focus remains reported and cannot let an earlier tabs opening reappear',async t=>{
 const f=await fixture(t,{tabs:[audioTab()]}),a=deferred(),b=deferred();f.wait.set('browser_focus_controls',a);const older=f.workspace.dispatch('tabs');await tick();f.wait.set('browser_focus_controls',b);f.events['browser-shortcut']({payload:'tabs'});await tick();b.reject(Error('focus_failed'));await tick();assert.equal(f.el('browser-error').hidden,false);a.resolve();await older;assert.equal(f.el('browser-menu').hidden,true);assert.equal(f.el('browser-error').hidden,false);
 const ack=deferred();f.wait.set('browser_focus_controls',ack);f.events['browser-shortcut']({payload:'tabs'});await tick();await f.workspace.dispatch('tabs-close');ack.reject(Error('focus_failed'));await tick();assert.equal(f.el('browser-error').hidden,false);assert.equal(f.el('browser-menu').hidden,true);
});

test('tabs opening and pending new-tab address focus cancel each other without changing creation or read RPCs',async t=>{
 const f=await fixture(t),ack=deferred();await f.workspace.dispatch('new');f.wait.set('browser_focus_controls',ack);const opening=f.workspace.dispatch('tabs');await tick();f.addNewTab();await tick();assert.equal(f.calls.filter(c=>c.name==='browser_focus_controls').length,1);ack.resolve();await opening;assert.equal(f.document.activeElement,f.el('browser-tab-menu-query'));assert.equal(f.calls.filter(c=>c.name==='browser_new_tab').length,1);
 const older=deferred();f.wait.set('browser_focus_controls',older);const pending=f.workspace.dispatch('tabs');await tick();f.wait.delete('browser_focus_controls');await f.workspace.dispatch('new');f.addNewTab();await tick();const focus=f.document.activeElement;assert.equal(focus,f.el('browser-url'));older.resolve();await pending;assert.equal(f.el('browser-menu').hidden,true);assert.equal(f.document.activeElement,focus);
});

const selectionAcks=f=>f.calls.filter(call=>call.name==='browser_control_select_ack').map(call=>call.args);
const controlRequest=(f,requestId=1,tabId=2,expiresAt=f.dom.window.Date.now()+10_000)=>({requestId,tabId,expiresAt});
const emitControl=(f,payload=controlRequest(f))=>f.events['browser-control-select']({payload});
const readField=(f,name)=>({browser_tabs:f.tabs,browser_favorites:f.favorites,browser_history:f.history})[name];
const snapshot=f=>({version:1,tabs:f.tabs,favorites:f.favorites,history:f.history});

test('native-active new blank missing from UI cache is freshly confirmed before exact activation and settled applied ACK',async t=>{
 let refreshing=0;const f=await fixture(t,{tabs:[tab()],metrics:{begin:name=>{if(name==='browserRefresh')refreshing++;return()=>{if(name==='browserRefresh')refreshing--;};}}}),read=deferred();let reads=0;
 f.tabs=[tab({active:false}),tab({id:3,url:'',title:'',active:true})];f.snapshotRead=()=>++reads===1?read.promise:snapshot(f);
 f.readOverride=()=>{throw Error('legacy must not replace valid snapshot');};
 emitControl(f,controlRequest(f,1,3));await tick();assert.equal(f.el('browser-tab-3'),null);assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'),false);assert.deepEqual(selectionAcks(f),[]);
 read.resolve(snapshot(f));await tick();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_activate_tab'),[{name:'browser_activate_tab',args:{id:3}}]);
 assert.equal(f.document.querySelector('.sidebar-tab.is-active').dataset.tabId,'3');assert.equal(refreshing,0);assert.deepEqual(selectionAcks(f),[{requestId:1,tabId:3,outcome:'applied'}]);
 assert.deepEqual(f.calls.filter(c=>['browser_workspace_snapshot','browser_activate_tab','browser_control_select_ack'].includes(c.name)).map(c=>c.name),['browser_workspace_snapshot','browser_activate_tab','browser_workspace_snapshot','browser_control_select_ack']);
});

test('a newer selection or ordinary click supersedes a pending fresh read without late old activation',async t=>{
 for(const newer of ['nonce','click']){const f=await fixture(t),read=deferred();let reads=0;f.snapshotRead=()=>++reads===1?read.promise:snapshot(f);emitControl(f,controlRequest(f,7,2));await tick();assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'),false);
  if(newer==='nonce')emitControl(f,controlRequest(f,8,1));else f.el('browser-tab-1').querySelector('.browser-tab-select').click();await tick();await tick();
  assert.deepEqual(selectionAcks(f)[0],{requestId:7,tabId:2,outcome:'superseded'});assert.deepEqual(f.calls.filter(c=>c.name==='browser_activate_tab').map(c=>c.args),[{id:1}]);
  read.resolve(snapshot(f));await tick();await tick();assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'&&c.args.id===2),false);assert.equal(selectionAcks(f).some(a=>a.requestId===7&&a.outcome==='applied'),false);
 }
});

test('fresh deleted targets fail both nonce and normal click without native activation',async t=>{
 for(const entry of ['nonce','click']){const f=await fixture(t);f.tabs=[tab()];f.snapshotRead=()=>snapshot(f);
  if(entry==='nonce')emitControl(f);else f.el('browser-tab-2').querySelector('.browser-tab-select').click();await tick();await tick();assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'),false);
  assert.deepEqual(selectionAcks(f),entry==='nonce'?[{requestId:1,tabId:2,outcome:'failed'}]:[]);
 }
});

test('exit, expiry and failed fresh readers cannot activate cached targets after their await',async t=>{
 for(const reason of ['leave','expiry','read-error']){const f=await fixture(t),read=deferred();let now=1000;f.dom.window.Date.now=()=>now;f.snapshotRead=()=>read.promise;f.readOverride=()=>{throw Error('fresh unavailable');};emitControl(f,controlRequest(f,1,2,2000));await tick();assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'),false);
  if(reason==='leave'){f.active=false;f.view='feed';f.workspace.cancelPendingFocus();f.active=true;f.view='browser';}
  if(reason==='expiry')now=2000;
  if(reason==='read-error')read.reject(Error('snapshot unavailable'));else read.resolve(snapshot(f));await tick();await tick();assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'),false);assert.equal(selectionAcks(f).length,1);assert.equal(selectionAcks(f)[0].outcome==='applied',false);
 }
});

test('ordinary click also waits for a fresh native read and keeps the known target on reader failure',async t=>{
 for(const fail of [false,true]){const f=await fixture(t),read=deferred();let reads=0;f.snapshotRead=()=>++reads===1?read.promise:snapshot(f);f.readOverride=()=>{throw Error('fresh unavailable');};f.el('browser-tab-2').querySelector('.browser-tab-select').click();await tick();assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'),false);
  if(fail)read.reject(Error('snapshot unavailable'));else read.resolve(snapshot(f));await tick();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_activate_tab').map(c=>c.args),fail?[]:[{id:2}]);assert.deepEqual(selectionAcks(f),[]);
 }
});

test('nonce control selection acknowledges exact latest rendered target only after Native ACK and refresh finally',async t=>{
 let refreshing=0;const f=await fixture(t,{metrics:{begin:name=>{if(name==='browserRefresh')refreshing++;return()=>{if(name==='browserRefresh')refreshing--;};}}}),native=deferred(),read=deferred();
 f.wait.set('browser_activate_tab',native);emitControl(f);await tick();assert.deepEqual(selectionAcks(f),[]);f.tabs=f.tabs.map(row=>({...row,active:row.id===2}));await f.workspace.refresh();assert.deepEqual(selectionAcks(f),[]);
 f.readOverride=name=>read.promise.then(()=>{assert.equal(refreshing,1);return readField(f,name);});native.resolve();await tick();assert.deepEqual(selectionAcks(f),[]);read.resolve();await tick();assert.equal(refreshing,0);assert.deepEqual(selectionAcks(f),[{requestId:1,tabId:2,outcome:'applied'}]);assert.equal(f.document.querySelector('.sidebar-tab.is-active').dataset.tabId,'2');
});

test('old successful refresh cannot ACK while newer refresh is pending; latest completion releases ACK without obsolete drain',async t=>{
 for(const obsoleteFirst of [true,false]){
  const f=await fixture(t),old=deferred(),latest=deferred();let generation=0;f.readOverride=name=>{if(name==='browser_tabs')generation++;if(generation===1)return readField(f,name);const wait=generation===2?old:latest;return wait.promise.then(()=>readField(f,name));};
  emitControl(f);await tick();f.events['browser-tabs-changed']();await tick();assert.deepEqual(selectionAcks(f),[]);
  if(obsoleteFirst){old.resolve();await tick();assert.deepEqual(selectionAcks(f),[]);latest.resolve();}else latest.resolve();
  await tick();assert.deepEqual(selectionAcks(f),[{requestId:1,tabId:2,outcome:'applied'}]);old.resolve();await tick();assert.equal(selectionAcks(f).length,1);
 }
});

test('target, tabs and render failures ACK failed; optional library reads preserve selection with their existing warnings',async t=>{
 for(const failure of ['missing','activation','tabs','favorites','history','render']){
  const f=await fixture(t);if(failure==='activation')f.fail.add('browser_activate_tab');if(['tabs','favorites','history'].includes(failure))f.readOverride=name=>{if(name==='browser_'+failure)throw Error('read failed');return readField(f,name);};if(failure==='render')f.document.querySelector('#sidebar-tabs-list').replaceChildren=()=>{throw Error('render failed');};
  emitControl(f,controlRequest(f,1,failure==='missing'?99:2));await tick();assert.deepEqual(selectionAcks(f),[{requestId:1,tabId:failure==='missing'?99:2,outcome:['favorites','history'].includes(failure)?'applied':'failed'}],failure);assert.equal(f.el('browser-error').hidden,!['activation','tabs','favorites','render'].includes(failure),failure);
 }
});

test('valid fresh tabs select the exact ID and ACK applied even when both favorites and history reject',async t=>{
 const f=await fixture(t);f.favorites=[{url:'https://saved.example/',title:'saved'}];f.history=[{url:'https://visited.example/',title:'visited'}];await f.workspace.refresh();
 f.readOverride=name=>{if(name==='browser_tabs')return f.tabs;throw Error('optional read unavailable');};emitControl(f);await tick();await tick();
 assert.deepEqual(f.calls.filter(c=>c.name==='browser_activate_tab').map(c=>c.args),[{id:2}]);assert.deepEqual(selectionAcks(f),[{requestId:1,tabId:2,outcome:'applied'}]);assert.equal(f.document.querySelector('.sidebar-tab.is-active').dataset.tabId,'2');
 assert.equal(f.el('browser-error').hidden,false);f.el('browser-history').click();assert.ok(f.el('browser-menu').textContent.includes('visited'));
});

test('superseded nonce, manual choice and view leave retain original captured request IDs and never produce late applied ACK',async t=>{
 for(const replacement of ['nonce','manual','leave']){
  const f=await fixture(t),native=deferred();f.wait.set('browser_activate_tab',native);emitControl(f,controlRequest(f,7));await tick();
  if(replacement==='nonce')emitControl(f,controlRequest(f,8,1));if(replacement==='manual'){f.wait.delete('browser_activate_tab');f.events['browser-control-select']({payload:1});}if(replacement==='leave'){f.active=false;f.view='feed';f.workspace.cancelPendingFocus();}
  await tick();assert.deepEqual(selectionAcks(f)[0],{requestId:7,tabId:2,outcome:'superseded'});native.resolve();await tick();assert.equal(selectionAcks(f).some(ack=>ack.requestId===7&&ack.outcome==='applied'),false);if(replacement==='nonce')assert.deepEqual(selectionAcks(f)[1],{requestId:8,tabId:1,outcome:'applied'});
 }
});

test('composition, inactive view and deadline equality cannot acknowledge positive; delayed ACK callbacks remain bounded',async t=>{
 for(const failure of ['address-ime','tab-ime','inactive','expired','late']){
  const f=await fixture(t),native=deferred();let now=1000;f.dom.window.Date.now=()=>now;const request=controlRequest(f,1,2,1001);
  if(failure==='address-ime')f.el('browser-url').dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));if(failure==='tab-ime')f.el('sidebar-tab-query').dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));if(failure==='inactive')f.active=false;if(failure==='expired')now=1001;if(failure==='late')f.wait.set('browser_activate_tab',native);
  emitControl(f,request);if(failure==='late'){await tick();now=1001;native.resolve();}await tick();assert.deepEqual(selectionAcks(f),[{requestId:1,tabId:2,outcome:'failed'}],failure);assert.equal(selectionAcks(f).some(ack=>ack.outcome==='applied'),false);
 }
});

test('invalid nonce envelopes and replayed IDs never activate or ACK; MAX_SAFE_INTEGER stays exact',async t=>{
 const f=await fixture(t);for(const payload of [null,{},[],{requestId:1,tabId:2},{...controlRequest(f),extra:1},Object.create(controlRequest(f)),controlRequest(f,0),controlRequest(f,1.5),controlRequest(f,Number.MAX_SAFE_INTEGER+1),controlRequest(f,1,0),controlRequest(f,1,Number.MAX_SAFE_INTEGER+1),controlRequest(f,1,2,Infinity)]){emitControl(f,payload);await tick();}assert.equal(f.calls.length,0);
 const request=controlRequest(f,Number.MAX_SAFE_INTEGER);emitControl(f,request);await tick();assert.deepEqual(selectionAcks(f),[{requestId:Number.MAX_SAFE_INTEGER,tabId:2,outcome:'applied'}]);f.calls.length=0;emitControl(f,request);emitControl(f,controlRequest(f,1));await tick();assert.equal(f.calls.length,0);
});

test('unsupported ACK command is reported without retry and does not fall back to Native-only success',async t=>{
 const f=await fixture(t);f.fail.add('browser_control_select_ack');emitControl(f);await tick();assert.deepEqual(selectionAcks(f),[{requestId:1,tabId:2,outcome:'applied'}]);assert.equal(f.el('browser-error').hidden,false);await f.workspace.refresh();await tick();assert.equal(selectionAcks(f).length,1);
});

test('pending timeout releases its bounded request and late callbacks cannot ACK it or a later request',async t=>{
 const f=await fixture(t),native=deferred(),timers=[],cleared=[];f.dom.window.setTimeout=(callback,delay)=>{timers.push({callback,delay});return timers.length;};f.dom.window.clearTimeout=id=>cleared.push(id);f.wait.set('browser_activate_tab',native);emitControl(f);await tick();assert.ok(timers[0].delay>0&&timers[0].delay<=10_000);timers[0].callback();assert.deepEqual(selectionAcks(f),[{requestId:1,tabId:2,outcome:'failed'}]);assert.deepEqual(cleared,[1]);
 f.wait.delete('browser_activate_tab');emitControl(f,controlRequest(f,2,1));await tick();assert.deepEqual(selectionAcks(f)[1],{requestId:2,tabId:1,outcome:'applied'});assert.deepEqual(cleared,[1,2]);native.resolve();timers[0].callback();await tick();assert.equal(selectionAcks(f).length,2);
});

test('composition beginning during requested read fails the nonce even if composition ends before render finishes',async t=>{
 const f=await fixture(t),read=deferred();f.readOverride=name=>read.promise.then(()=>readField(f,name));emitControl(f);await tick();const input=f.el('browser-url');input.focus();f.type('browser-url','入力中の下書き');input.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));input.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));read.resolve();await tick();assert.deepEqual(selectionAcks(f),[{requestId:1,tabId:2,outcome:'failed'}]);assert.equal(input.value,'入力中の下書き');assert.equal(f.document.activeElement,input);
});

test('Native submission leaves the DOM address usable after menus or Native fallback',async t=>{
 const f=await fixture(t);f.events['browser-native-chrome']({payload:{enabled:true}});
 f.events['browser-native-address-submit']({payload:{tabId:1,value:'example.com'}});await tick();await tick();
 assert.equal(f.calls.filter(c=>c.name==='browser_navigate_from_address').length,1);
 assert.equal(f.el('browser-form').hidden,false);
 f.events['browser-native-chrome']({payload:{enabled:false}});await f.workspace.dispatch('address');
 assert.equal(f.el('browser-form').hidden,false);assert.equal(f.document.activeElement,f.el('browser-url'));
});
test('address candidates focus survives the expected Native-to-DOM handoff but never a changed tab or view',async t=>{
 for(const change of ['native','tab','view']){
  const f=await fixture(t),ack=deferred();f.events['browser-native-chrome']({payload:{enabled:true}});openTools(f);f.wait.set('browser_focus_controls',ack);
  f.el('browser-address-candidates').click();await tick();f.events['browser-native-chrome']({payload:{enabled:false}});
  if(change==='tab'){f.tabs=f.tabs.map(tab=>({...tab,active:tab.id===2}));await f.workspace.refresh();}if(change==='view'){f.view='feed';f.active=false;}
  ack.resolve();await tick();assert.equal(f.document.activeElement===f.el('browser-url'),change==='native');
  assert.equal(f.el('browser-form').hidden,false);
 }
});
test('new tab is reachable without the sidebar and menus retain history, find and zoom',async t=>{
 const f=await fixture(t);f.el('browser-new-tab').click();await tick();assert.equal(f.calls.filter(c=>c.name==='browser_new_tab').length,1);
 f.workspace.cancelPendingFocus();f.el('browser-history').click();openTools(f);assert.equal(f.el('browser-menu').hidden,false);assert.ok(f.el('browser-menu').textContent.includes('リセット'));assert.ok(f.el('browser-address-candidates'));
 f.el('browser-tools').click();f.el('browser-tools').click();assert.equal(f.el('browser-menu').hidden,true);
});

test('vertical tabs are the default; horizontal tabs require a saved choice',async t=>{
 for(const tabLayout of [null,'vertical','invalid']){const f=await fixture(t,{tabLayout});assert.equal(f.el('sidebar-tabs').parentElement,f.document.querySelector('.sidebar'));assert.equal(f.document.querySelector('.browser-tabs-horizontal'),null);}
 const f=await fixture(t);openTools(f);[...f.el('browser-menu').querySelectorAll('button')].find(b=>b.textContent==='横型タブに切り替え').click();assert.equal(f.el('sidebar-tabs').parentElement,f.el('browser-tabbar'));assert.equal(f.dom.window.localStorage.getItem('hub.browser.tabLayout'),'horizontal');
 const restored=await fixture(t,{tabLayout:f.dom.window.localStorage.getItem('hub.browser.tabLayout')});assert.equal(restored.el('sidebar-tabs').parentElement,restored.el('browser-tabbar'));
 openTools(restored);[...restored.el('browser-menu').querySelectorAll('button')].find(b=>b.textContent==='縦型タブに切り替え').click();assert.equal(restored.el('sidebar-tabs').parentElement,restored.document.querySelector('.sidebar'));assert.equal(restored.dom.window.localStorage.getItem('hub.browser.tabLayout'),'vertical');
});
test('Native typed suggestions stay local, preserve draft across refresh and select a search on Enter',async t=>{
 const f=await fixture(t);f.events['browser-native-chrome']({payload:{enabled:true}});
 f.events['browser-native-address-edit']({payload:{tabId:1,value:'日本語の検索'}});assert.equal(f.calls.length,0);assert.equal(f.el('browser-suggestions').hidden,false);await f.workspace.refresh();assert.equal(f.el('browser-url').value,'日本語の検索');
 f.events['browser-native-address-key']({payload:{tabId:1,key:'ArrowDown'}});assert.equal(f.el('browser-url').getAttribute('aria-activedescendant'),'browser-suggestion-0');
 f.events['browser-native-address-submit']({payload:{tabId:1,value:'日本語の検索'}});await tick();assert.equal(f.calls.find(c=>c.name==='browser_navigate_from_address').args.url,'https://duckduckgo.com/?q='+encodeURIComponent('日本語の検索'));assert.equal(f.el('browser-form').hidden,false);
});
test('Native suggestion messages reject stale tabs, malformed strings and wrong views without changing input',async t=>{
 const f=await fixture(t);f.events['browser-native-chrome']({payload:{enabled:true}});const value=f.el('browser-url').value;
 for(const p of [null,[],{tabId:2,value:'bad'},{tabId:1,value:'a'.repeat(8193)},{tabId:1,value:'a\u0000b'},{tabId:1,value:'safe',extra:1},{tabId:'1',value:'safe'}])f.events['browser-native-address-edit']({payload:p});
 assert.equal(f.el('browser-url').value,value);assert.equal(f.calls.length,0);f.view='feed';f.events['browser-native-address-edit']({payload:{tabId:1,value:'off view'}});assert.equal(f.el('browser-url').value,value);
});
test('Native suggestion selection switches an existing exact tab and stale text never uses an old candidate',async t=>{
 for(const stale of [false,true]){const f=await fixture(t);f.events['browser-native-chrome']({payload:{enabled:true}});f.events['browser-native-address-edit']({payload:{tabId:1,value:'second'}});f.events['browser-native-address-key']({payload:{tabId:1,key:'ArrowUp'}});f.events['browser-native-address-submit']({payload:{tabId:1,value:stale?'different search':'second'}});await tick();assert.equal(f.calls.some(c=>c.name==='browser_activate_tab'),!stale);if(stale)assert.ok(f.calls.find(c=>c.name==='browser_navigate_from_address').args.url.includes('different%20search'));else assert.deepEqual(f.calls.find(c=>c.name==='browser_activate_tab').args,{id:2});}
});

test('Native blur keeps a clicked candidate available and a later edit cancels old dismissal',async t=>{
 const f=await fixture(t);f.events['browser-native-chrome']({payload:{enabled:true}});f.events['browser-native-address-edit']({payload:{tabId:1,value:'second'}});
 f.events['browser-native-address-key']({payload:{tabId:1,key:'blur'}});const option=[...f.el('browser-suggestions').children].at(-1);option.focus();await new Promise(r=>setTimeout(r,130));assert.equal(f.el('browser-suggestions').hidden,false);option.click();await tick();assert.deepEqual(f.calls.find(c=>c.name==='browser_activate_tab').args,{id:2});
});

test('horizontal tab search filters the popup without hiding or renumbering the strip',async t=>{
 const f=await fixture(t,{tabLayout:'horizontal'});f.open();f.type('browser-tab-menu-query','second');assert.equal(f.document.querySelectorAll('.sidebar-tab').length,2);assert.equal(f.document.querySelectorAll('.browser-tab-results > button').length,1);assert.equal(f.calls.length,0);
 f.workspace.dispatch('tabs-close');assert.equal(f.document.querySelectorAll('.sidebar-tab').length,2);assert.equal(f.el('browser-tab-1').classList.contains('is-active'),true);
});
test('tab refresh preserves button focus, and closed focused tabs return to the active tab',async t=>{
 const f=await fixture(t),select=f.el('browser-tab-2').querySelector('.browser-tab-select');select.focus();await f.workspace.refresh();assert.equal(f.document.activeElement,f.el('browser-tab-2').querySelector('.browser-tab-select'));
 const close=f.el('browser-tab-2').querySelector('[data-tab-action="close"]');close.focus();close.click();await tick();assert.equal(f.document.activeElement,f.el('browser-tab-1').querySelector('.browser-tab-select'));
 f.active=false;f.view='feed';f.el('browser-tab-1').querySelector('.browser-tab-select').focus();await f.workspace.refresh();assert.equal(f.document.activeElement,f.document.body);
});
test('active overflow tab scrolls on selection, not on periodic refresh after manual scrolling',async t=>{
 const f=await fixture(t,{tabLayout:'horizontal',tabs:Array.from({length:64},(_,i)=>tab({id:i+1,active:i===0}))}),list=f.el('sidebar-tabs-list');Object.defineProperty(list,'clientWidth',{value:300});
 Object.defineProperty(f.dom.window.HTMLElement.prototype,'offsetLeft',{configurable:true,get(){return this.dataset.tabId?(Number(this.dataset.tabId)-1)*190:0;}});Object.defineProperty(f.dom.window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.dataset.tabId?190:0;}});
 f.tabs=f.tabs.map(t=>({...t,active:t.id===64}));await f.workspace.refresh();assert.deepEqual(f.scrollCalls.at(-1),{id:'browser-tab-64',options:{block:'nearest',inline:'nearest'}});f.scrollCalls.length=0;await f.workspace.refresh();assert.equal(f.scrollCalls.length,0);
});
test('middle click closes the exact current unpinned tab only; pinned or stale rows stay safe',async t=>{
 const f=await fixture(t,{tabs:[tab({pinned:true}),tab({id:2,active:false})]}),old=f.el('browser-tab-2');const click=row=>row.dispatchEvent(new f.dom.window.MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));
 click(f.el('browser-tab-1'));await tick();assert.equal(f.calls.length,0);click(old);await tick();assert.deepEqual(f.calls.find(c=>c.name==='browser_close_tab').args,{id:2});f.calls.length=0;click(old);await tick();assert.equal(f.calls.length,0);
 f.key(f.el('browser-tab-1').querySelector('.browser-tab-select'),'F10',{shiftKey:true});assert.equal(f.el('browser-menu').hidden,false);assert.ok(f.el('browser-menu').textContent.includes('固定を解除'));
});
test('address keyboard selection keeps the final candidate visible for DOM and Native entry',async t=>{
 for(const native of [false,true]){const f=await fixture(t,{tabs:Array.from({length:7},(_,i)=>tab({id:i+1,title:'match '+i,active:i===0,url:'https://example.com/'+i}))});
 if(native){f.events['browser-native-chrome']({payload:{enabled:true}});f.events['browser-native-address-edit']({payload:{tabId:1,value:'match'}});f.events['browser-native-address-key']({payload:{tabId:1,key:'ArrowUp'}});}else{f.type('browser-url','match');f.key(f.el('browser-url'),'ArrowUp');}
 assert.deepEqual(f.scrollCalls.at(-1),{id:'browser-suggestion-7',options:{block:'nearest',inline:'nearest'}});assert.equal(f.calls.length,0);
 }
});

test('toolbar uses the bundled controls without requesting a native overlay',async t=>{
 const f=await fixture(t,{tabs:[tab({canForward:true})]});
 for(const id of ['browser-back','browser-forward','browser-reload']){assert.equal(f.document.querySelectorAll('#'+id).length,1);assert.ok(f.document.querySelector('.app-toolbar .toolbar-navigation').contains(f.el(id)));assert.equal(f.el('view-browser').contains(f.el(id)),false);}
 assert.deepEqual(f.initialCalls.filter(c=>c.name==='native_browser_chrome_layout'),[{name:'native_browser_chrome_layout',args:{rect:null,palette:null,fontSize:13}}]);
 f.el('browser-back').click();f.el('browser-forward').click();f.el('browser-reload').click();await tick();
 assert.deepEqual(f.calls.filter(c=>['browser_back','browser_forward','browser_reload'].includes(c.name)).map(c=>c.name),['browser_back','browser_forward','browser_reload']);
 f.tabs=[tab({loading:true})];await f.workspace.refresh();assert.equal(f.el('browser-reload').getAttribute('aria-label'),'読み込みを停止');f.el('browser-reload').click();await tick();assert.ok(f.calls.some(c=>c.name==='browser_stop'));
 await f.workspace.dispatch('address');assert.equal(f.document.activeElement,f.el('browser-url'));assert.ok(f.calls.some(c=>c.name==='browser_focus_controls'));assert.equal(f.calls.some(c=>c.name==='browser_focus_address'),false);
 f.tabs=[tab({url:'',canBack:false,canForward:false})];await f.workspace.refresh();for(const id of ['browser-back','browser-forward','browser-reload'])assert.equal(f.el(id).disabled,true);
 assert.equal(f.calls.some(c=>c.name==='native_browser_chrome_layout'),false);assert.equal(f.el('sidebar-tabs').parentElement,f.document.querySelector('.sidebar'));
});

const menuButton=(f,label)=>[...f.el('browser-menu').querySelectorAll('button')].find(node=>node.textContent===label);
const editGroup=(f,id)=>{f.el('browser-tab-'+id).querySelector('.browser-tab-options').click();menuButton(f,'グループを変更').click();return f.document.querySelector('.browser-tab-group-form input');};
const submitGroup=f=>f.document.querySelector('.browser-tab-group-form').dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));
const groupHeadings=f=>[...f.document.querySelectorAll('.browser-tab-group')];

test('legacy tabs without metadata remain ordinary tabs with no group heading or private label',async t=>{
 const f=await fixture(t);assert.equal(groupHeadings(f).length,0);assert.equal(f.document.querySelectorAll('.sidebar-tab').length,2);assert.equal(f.el('sidebar-tabs-list').textContent.includes('プライベート'),false);assert.equal(editGroup(f,2).value,'');assert.equal(f.calls.length,0);
});

test('group sections are coherent while shortcuts, context moves and drops retain global positions',async t=>{
 const f=await fixture(t,{tabs:[tab({id:11,pinned:true,group:'仕事'}),tab({id:22,active:false,group:'調査'}),tab({id:33,active:false}),tab({id:44,active:false,group:'調査'}),tab({id:55,active:false,group:'仕事'})]});
 assert.deepEqual([...f.document.querySelectorAll('.sidebar-tab')].map(row=>Number(row.dataset.tabId)),[11,22,44,33,55]);assert.deepEqual(groupHeadings(f).map(node=>node.dataset.tabGroup),['仕事','調査','仕事']);
 await f.workspace.dispatch('tab-3');assert.deepEqual(f.calls.find(c=>c.name==='browser_activate_tab').args,{id:33});f.calls.length=0;
 f.el('browser-tab-44').querySelector('.browser-tab-options').click();menuButton(f,'前へ移動').click();await tick();assert.deepEqual(f.calls.find(c=>c.name==='browser_move_tab').args,{id:44,position:2});f.calls.length=0;
 f.el('browser-tab-22').ondragstart({dataTransfer:{setData:()=>{}}});f.el('browser-tab-55').ondrop({preventDefault:()=>{}});await tick();assert.deepEqual(f.calls.find(c=>c.name==='browser_move_tab').args,{id:22,position:4});
});

test('group collapse persists, expands on demand and never conceals active or private tabs',async t=>{
 const rows=[tab(),tab({id:2,active:false,group:'資料'}),tab({id:3,active:false,group:'資料'})],f=await fixture(t,{tabs:rows});groupHeadings(f)[0].focus();groupHeadings(f)[0].click();assert.equal(f.document.activeElement,groupHeadings(f)[0]);assert.equal(f.el('browser-tab-2'),null);assert.equal(groupHeadings(f)[0].getAttribute('aria-expanded'),'false');const saved=f.dom.window.localStorage.getItem('hub.browser.collapsedGroups');assert.deepEqual(JSON.parse(saved),['資料']);
 const restored=await fixture(t,{tabs:rows,collapsedGroups:saved});assert.equal(restored.el('browser-tab-3'),null);groupHeadings(restored)[0].click();assert.ok(restored.el('browser-tab-2'));assert.deepEqual(JSON.parse(restored.dom.window.localStorage.getItem('hub.browser.collapsedGroups')),[]);
 f.tabs=rows.map(row=>({...row,active:row.id===2}));await f.workspace.refresh();assert.ok(f.el('browser-tab-2'));assert.ok(f.el('browser-tab-3'));assert.equal(groupHeadings(f)[0].disabled,true);assert.equal(groupHeadings(f)[0].getAttribute('aria-expanded'),'true');
 f.tabs=rows.map(row=>({...row,private:row.id===3}));await f.workspace.refresh();assert.ok(f.el('browser-tab-3'));assert.equal(groupHeadings(f)[0].disabled,true);assert.ok(f.el('browser-tab-3').textContent.includes('プライベート'));assert.equal(f.el('browser-tab-3').querySelector('.browser-tab-badge').textContent,'◇');f.open();assert.ok(f.el('browser-tab-result-3').textContent.includes('プライベート'));
});

test('search exposes collapsed group matches and horizontal tabs keep the original strip',async t=>{
 const rows=[tab(),tab({id:2,title:'target',active:false,group:'資料'}),tab({id:3,active:false,group:'資料'})],f=await fixture(t,{tabs:rows,collapsedGroups:'["資料"]'});f.type('sidebar-tab-query','target');assert.ok(f.el('browser-tab-2'));assert.equal(groupHeadings(f)[0].disabled,true);f.type('sidebar-tab-query','');assert.equal(f.el('browser-tab-2'),null);
 const horizontal=await fixture(t,{tabs:rows,collapsedGroups:'["資料"]',tabLayout:'horizontal'});assert.equal(groupHeadings(horizontal).length,0);assert.deepEqual([...horizontal.document.querySelectorAll('.sidebar-tab')].map(row=>row.dataset.tabId),['1','2','3']);
});

test('DOM group editor assigns trimmed names, clears groups and rejects controls or overlong names',async t=>{
 const f=await fixture(t);f.dom.window.prompt=()=>{throw Error('native prompt must not be used');};let input=editGroup(f,2);assert.equal(input.maxLength,80);assert.equal(f.document.activeElement,input);input.value='  調査  ';submitGroup(f);await tick();assert.deepEqual(f.calls.find(c=>c.name==='browser_set_tab_group').args,{id:2,group:'調査'});assert.equal(groupHeadings(f)[0].dataset.tabGroup,'調査');
 f.calls.length=0;input=editGroup(f,2);assert.equal(input.value,'調査');menuButton(f,'グループを解除').click();await tick();assert.deepEqual(f.calls.find(c=>c.name==='browser_set_tab_group').args,{id:2,group:null});assert.equal(groupHeadings(f).length,0);
 for(const name of ['x'.repeat(81),'a\u0001b','a\u0085b']){f.calls.length=0;input=editGroup(f,2);input.value=name;submitGroup(f);await tick();assert.equal(f.calls.length,0);assert.equal(f.document.querySelector('.browser-tab-group-form [role="status"]').hidden,false);}
 input.value='x'.repeat(80);submitGroup(f);await tick();assert.equal(f.calls.find(c=>c.name==='browser_set_tab_group').args.group.length,80);f.calls.length=0;input=editGroup(f,2);input.value='   ';submitGroup(f);await tick();assert.deepEqual(f.calls.find(c=>c.name==='browser_set_tab_group').args,{id:2,group:null});
});

test('group editor blocks IME, never assigns a closed tab and reports failed native writes',async t=>{
 const f=await fixture(t);let input=editGroup(f,2);input.value='資料';input.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart'));submitGroup(f);await tick();assert.equal(f.calls.length,0);input.dispatchEvent(new f.dom.window.CompositionEvent('compositionend'));f.fail.add('browser_set_tab_group');submitGroup(f);await tick();assert.equal(f.el('browser-menu').hidden,false);assert.equal(f.el('browser-error').hidden,false);f.fail.clear();f.tabs=[tab()];await f.workspace.refresh();f.calls.length=0;submitGroup(f);await tick();assert.equal(f.calls.length,0);
});

test('pinned boundaries disable impossible moves and refuse cross-boundary drops',async t=>{
 const f=await fixture(t,{tabs:[tab({pinned:true,group:'資料'}),tab({id:2,active:false,group:'資料'})]});f.el('browser-tab-1').querySelector('.browser-tab-options').click();assert.equal(menuButton(f,'前へ移動').disabled,true);assert.equal(menuButton(f,'後ろへ移動').disabled,true);f.el('browser-tab-2').querySelector('.browser-tab-options').click();assert.equal(menuButton(f,'前へ移動').disabled,true);
 f.el('browser-tab-2').ondragstart({dataTransfer:{setData:()=>{}}});f.el('browser-tab-1').ondrop({preventDefault:()=>{}});await tick();assert.equal(f.calls.some(c=>c.name==='browser_move_tab'),false);assert.equal(f.calls.some(c=>c.name==='native_browser_chrome_layout'),false);
});

test('integrated library and privacy menus expose real controls without issuing a deletion on opening', async t=>{
 const f=await fixture(t,{favorites:[{url:'https://example.org/',title:'Saved',folder:'Research'}],tabs:[tab({private:false})]});
 f.el('browser-tools').click(); const go=(label)=>{if(!menuItem(f,label))menuItem(f,'← メニュー').click();menuItem(f,label).click();};
 go('お気に入り'); assert.ok(f.document.querySelector('[aria-label="お気に入りのフォルダー"]')); assert.ok(f.document.querySelector('[aria-label="お気に入りの管理"]'));
 go('閲覧データを削除'); assert.ok(f.document.querySelector('[aria-label="削除する閲覧履歴の期間"]')); assert.equal(f.calls.some(call=>call.name.startsWith('browser_clear_')),false);
 const preview=[...f.el('browser-menu').querySelectorAll('button')].find(button=>button.textContent==='閲覧履歴の削除を確認'); preview.click();
 const stale=[...f.el('browser-menu').querySelectorAll('button')].find(button=>button.textContent==='確認した内容を削除');
 go('開いているタブを検索'); stale.click(); await tick(); assert.equal(f.calls.some(call=>call.name.startsWith('browser_clear_')),false);
});

test('pointer gestures keep background favorite/history/suggestion links separate and Shift selects the new tab',async t=>{
 for(const surface of ['favorites','history','suggestion'])for(const gesture of [{type:'auxclick',button:1},{type:'click',button:0,ctrlKey:true},{type:'click',button:0,metaKey:true},{type:'click',button:0,ctrlKey:true,shiftKey:true},{type:'auxclick',button:1,shiftKey:true}]){
  const f=await fixture(t);const url='https://gesture.example/';f.favorites=[{url,title:'Gesture'}];f.history=[{url,title:'Gesture'}];await f.workspace.refresh();
  let link;
  if(surface==='suggestion'){f.type('browser-url','gesture');link=[...f.el('browser-suggestions').children].find(n=>n.textContent.includes('Gesture'));}
  else {f.el('browser-history').click();if(surface==='favorites'){menuItem(f,'← メニュー').click();menuItem(f,'お気に入り').click();}link=f.el('browser-menu').querySelector('.browser-menu-open');}
  f.calls.length=0;const event=new f.dom.window.MouseEvent(gesture.type,{bubbles:true,cancelable:true,...gesture});link.dispatchEvent(event);await tick();
  assert.equal(event.defaultPrevented,true);assert.deepEqual(f.calls.filter(c=>c.name==='browser_open_tab'),[{name:'browser_open_tab',args:{url,foreground:Boolean(gesture.shiftKey)}}]);assert.equal(f.calls.some(c=>c.name==='browser_navigate'||c.name==='browser_activate_tab'),false);assert.equal(f.tabs.find(t=>t.active).id,1);
  assert.equal((surface==='suggestion'?f.el('browser-suggestions'):f.el('browser-menu')).hidden,Boolean(gesture.shiftKey));
 }
});

test('pointer middle-down suppresses autoscroll without opening, right clicks and detached library links do nothing',async t=>{
 const f=await fixture(t);f.favorites=[{url:'https://gesture.example/',title:'Gesture'}];await f.workspace.refresh();f.el('browser-history').click();menuItem(f,'← メニュー').click();menuItem(f,'お気に入り').click();const link=f.el('browser-menu').querySelector('.browser-menu-open');f.calls.length=0;
 for(const node of [link,f.el('browser-tab-2').querySelector('.browser-tab-select')]){const down=new f.dom.window.MouseEvent('mousedown',{button:1,bubbles:true,cancelable:true});node.dispatchEvent(down);assert.equal(down.defaultPrevented,true);}
 link.dispatchEvent(new f.dom.window.MouseEvent('auxclick',{button:2,bubbles:true}));await tick();assert.equal(f.calls.length,0);
 f.el('browser-tools').click();f.calls.length=0;link.dispatchEvent(new f.dom.window.MouseEvent('auxclick',{button:1,bubbles:true}));await tick();assert.equal(f.calls.length,0);
});

test('pointer ordinary clicks navigate once while Alt clicks and off-view actions cannot open links',async t=>{
 const f=await fixture(t);f.history=[{url:'https://gesture.example/',title:'Gesture'}];await f.workspace.refresh();f.el('browser-history').click();const link=f.el('browser-menu').querySelector('.browser-menu-open');f.calls.length=0;
 link.dispatchEvent(new f.dom.window.MouseEvent('click',{button:0,altKey:true,bubbles:true}));await tick();assert.equal(f.calls.length,0);f.view='feed';link.dispatchEvent(new f.dom.window.MouseEvent('auxclick',{button:1,bubbles:true}));await tick();assert.equal(f.calls.length,0);f.view='browser';link.click();await tick();assert.deepEqual(f.calls.filter(c=>c.name==='browser_navigate'),[{name:'browser_navigate',args:{url:'https://gesture.example/'}}]);assert.equal(f.calls.some(c=>c.name==='browser_open_tab'),false);
});

test('pointer Alt Enter opens the typed address in a foreground tab and respects IME and invalid schemes',async t=>{
 for(const invalid of [false,true]){const f=await fixture(t);f.type('browser-url',invalid?'javascript:alert(1)':'alt-enter.example/path');f.calls.length=0;const event=f.key(f.el('browser-url'),'Enter',{altKey:true});await tick();assert.equal(event.defaultPrevented,true);assert.deepEqual(f.calls.filter(c=>c.name==='browser_open_tab'),invalid?[]:[{name:'browser_open_tab',args:{url:'https://alt-enter.example/path',foreground:true}}]);assert.equal(f.calls.some(c=>c.name==='browser_navigate'),false);}
 const f=await fixture(t);f.type('browser-url','alt-enter.example');f.calls.length=0;f.key(f.el('browser-url'),'Enter',{altKey:true,isComposing:true});await tick();assert.equal(f.calls.length,0);
});

test('plain find keeps the newest query result when replies arrive in reverse order',async t=>{
 const f=await fixture(t,{tabs:[audioTab()]}),a=deferred(),b=deferred();f.findRead=args=>args.query==='first'?a.promise:b.promise;
 f.el('browser-find').click();f.type('browser-find-query','first');f.el('browser-find-next').click();await tick();f.type('browser-find-query','second');f.el('browser-find-next').click();await tick();
 const calls=f.calls.filter(c=>c.name==='browser_find');assert.equal(calls.length,2);assert.equal(calls[0].args.expectedUrl,f.tabs[0].url);assert.equal(calls[0].args.expectedContextToken,'ctx-1');
 b.resolve(true);await tick();assert.equal(f.el('browser-find-status').textContent,'一致箇所を表示');a.resolve(false);await tick();assert.equal(f.el('browser-find-status').textContent,'一致箇所を表示');
});
test('closing find or same-URL navigation invalidates a delayed plain-page result',async t=>{
 for(const action of ['close','navigation']){
  const f=await fixture(t,{tabs:[audioTab()]}),pending=deferred();f.findRead=()=>pending.promise;f.el('browser-find').click();f.type('browser-find-query','needle');f.el('browser-find-next').click();await tick();
  if(action==='close')f.el('browser-find-close').click();else{f.tabs[0].printContextToken='ctx-after-reload';f.events['browser-url-changed']();await tick();}
  pending.resolve(true);await tick();assert.equal(f.el('browser-find-status').textContent,'');if(action==='close')assert.equal(f.el('browser-find-bar').hidden,true);
 }
});

test('Stage32 DOM address retains same-tab focused draft but rejects Enter and captured candidates on a different tab',async t=>{
 const f=await fixture(t),input=f.el('browser-url');input.focus();f.type('browser-url','draft-a.example/path');
 const candidate=f.el('browser-suggestion-0');await f.workspace.refresh();assert.equal(input.value,'draft-a.example/path');
 f.tabs=f.tabs.map(row=>({...row,active:row.id===2}));await f.workspace.refresh();f.calls.length=0;
 await f.el('browser-form').onsubmit({preventDefault(){}});candidate.click();f.key(input,'Enter',{altKey:true});await tick();
 assert.equal(f.calls.length,0);assert.equal(input.value,'draft-a.example/path');assert.match(f.el('browser-error').textContent,/タブが変わりました/);
 await f.workspace.dispatch('address');assert.equal(input.value,'https://two.example/x');f.type('browser-url','draft-b.example/path');f.calls.length=0;
 await f.el('browser-form').onsubmit({preventDefault(){}});
 assert.deepEqual(f.calls.filter(call=>call.name==='browser_navigate_from_address'),[{name:'browser_navigate_from_address',args:{id:2,url:'https://draft-b.example/path'}}]);
 assert.equal(f.calls.some(call=>call.name==='browser_navigate'),false);assert.equal(f.tabs[0].url,tab().url);
});

test('Stage32 DOM address suggestions and explicit edits use the exact input-owner tab with no generic navigate',async t=>{
 const f=await fixture(t),input=f.el('browser-url');input.focus();f.type('browser-url','suggestion.example/path');f.calls.length=0;
 f.el('browser-suggestion-0').click();await tick();
 assert.deepEqual(f.navigationEffects,[{id:1,url:'https://suggestion.example/path'}]);assert.equal(f.calls.some(call=>call.name==='browser_navigate'),false);
 f.tabs=f.tabs.map(row=>({...row,active:row.id===2}));await f.workspace.refresh();input.dispatchEvent(new f.dom.window.Event('pointerdown'));input.focus();f.type('browser-url','another.example/');
 await f.el('browser-form').onsubmit({preventDefault(){}});assert.deepEqual(f.navigationEffects.at(-1),{id:2,url:'https://another.example/'});
});

test('Stage32 late address navigation cannot blur or paint a changed tab/view or a new draft',async t=>{
 for(const change of ['tab','view','return']){
  const f=await fixture(t),input=f.el('browser-url'),ack=deferred();input.focus();f.type('browser-url','old-request.example/');f.wait.set('browser_navigate_from_address',ack);
  const pending=f.el('browser-form').onsubmit({preventDefault(){}});await tick();
  if(change==='view'){f.view='ai';f.active=false;f.el('content-title').focus();}
  else{f.tabs=f.tabs.map(row=>({...row,active:row.id===2}));await f.workspace.refresh();if(change==='return'){f.tabs=f.tabs.map(row=>({...row,active:row.id===1}));await f.workspace.refresh();}f.type('browser-url','new untouched draft');}
  const focus=f.document.activeElement,error=f.el('browser-error').textContent,hidden=f.el('browser-error').hidden;ack.resolve();await pending;
  assert.equal(f.document.activeElement,focus,change);assert.equal(f.el('browser-error').textContent,error,change);assert.equal(f.el('browser-error').hidden,hidden,change);
  if(change!=='view')assert.equal(input.value,'new untouched draft');assert.equal(f.navigationEffects.length,change==='return'?1:0);
 }
});

test('Stage32 CtrlL and CtrlF ignore late success/failure after tab/view/URL changes or a newer focus intent',async t=>{
 for(const action of ['address','find'])for(const change of ['tab','view','url','newer'])for(const reject of [false,true]){
  const f=await fixture(t),ack=deferred();f.el('content-title').focus();f.wait.set('browser_focus_controls',ack);
  const pending=f.workspace.dispatch(action);await tick();
  if(change==='tab'){f.tabs=f.tabs.map(row=>({...row,active:row.id===2}));await f.workspace.refresh();}
  if(change==='view'){f.active=false;f.view='ai';}
  if(change==='url'){f.tabs=f.tabs.map(row=>row.active?{...row,url:'https://new-page.example/'}:row);await f.workspace.refresh();}
  if(change==='newer'){f.wait.delete('browser_focus_controls');await f.workspace.dispatch(action==='address'?'find':'address');}
  const focus=f.document.activeElement,findHidden=f.el('browser-find-bar').hidden,suggestionsHidden=f.el('browser-suggestions').hidden,error=f.el('browser-error').textContent;
  if(reject)ack.reject(Error('synthetic focus failure'));else ack.resolve();await pending;
  assert.equal(f.document.activeElement,focus,`${action}/${change}/${reject}`);assert.equal(f.el('browser-find-bar').hidden,findHidden);assert.equal(f.el('browser-suggestions').hidden,suggestionsHidden);assert.equal(f.el('browser-error').textContent,error);
 }
});

test('Stage32 unchanged CtrlL/F still focus their controls; off-view and IME requests issue no focus IPC',async t=>{
 const f=await fixture(t);await f.workspace.dispatch('address');assert.equal(f.document.activeElement,f.el('browser-url'));
 await f.workspace.dispatch('find');assert.equal(f.document.activeElement,f.el('browser-find-query'));assert.equal(f.el('browser-find-bar').hidden,false);
 f.calls.length=0;f.view='ai';f.active=false;await f.workspace.dispatch('address');await f.workspace.dispatch('find');assert.equal(f.calls.length,0);
 f.view='browser';f.active=true;f.el('browser-url').dispatchEvent(new f.dom.window.CompositionEvent('compositionstart'));await f.workspace.dispatch('address');await f.workspace.dispatch('find');assert.equal(f.calls.length,0);
});
test('Stage32 external navigation intent survives readonly refresh but user input and tab selection invalidate it',async t=>{
 const f=await fixture(t),current=f.workspace.captureNavigationIntent();assert.equal(current(),true);await f.workspace.refresh();assert.equal(current(),true);
 f.type('browser-url','new intent');assert.equal(current(),false);const next=f.workspace.captureNavigationIntent();await f.workspace.dispatch('next');assert.equal(next(),false);
 const hidden=f.workspace.captureNavigationIntent();f.view='ai';f.active=false;assert.equal(hidden(),false);
});

test('HistoryFallback legacy callers retain page-only buttons and their original Native shortcut dispatch',async t=>{
 const f=await fixture(t,{tabs:[tab({canBack:false,canForward:false})]});
 assert.equal(f.el('browser-back').disabled,true);assert.equal(f.el('browser-forward').disabled,true);assert.equal(f.el('browser-back').title,'ページに戻る');
 await f.workspace.dispatch('back');assert.deepEqual(f.calls.filter(call=>call.name==='browser_back'),[{name:'browser_back',args:undefined}]);assert.deepEqual(f.hubCalls,[]);
});
test('HistoryFallback page history takes priority over Hub for both physical buttons and shortcuts',async t=>{
 const f=await fixture(t,{tabs:[tab({canBack:true,canForward:true})],hub:true});
 assert.equal(f.el('browser-back').title,'ページに戻る');assert.equal(f.el('browser-forward').title,'ページを進む');
 f.el('browser-back').click();f.key(f.document.body,'ArrowRight',{altKey:true});await tick();
 assert.equal(f.calls.filter(call=>call.name==='browser_back').length,1);assert.equal(f.calls.filter(call=>call.name==='browser_forward').length,1);assert.deepEqual(f.hubCalls,[]);
});
test('HistoryFallback unavailable page history uses live Hub destinations on button and shortcut without Native navigation',async t=>{
 const f=await fixture(t,{tabs:[tab({canBack:false,canForward:false})],hub:true});
 assert.equal(f.el('browser-back').disabled,false);assert.equal(f.el('browser-back').title,'動画に戻る');assert.equal(f.el('browser-forward').getAttribute('aria-label'),'記事を進む');
 f.el('browser-back').click();f.key(f.document.body,'ArrowRight',{altKey:true});await tick();assert.deepEqual(f.hubCalls,[-1,1]);
 assert.equal(f.calls.some(call=>call.name==='browser_back'||call.name==='browser_forward'),false);
 f.hubHistory={back:{available:false,label:'動画に戻る'},forward:{available:false,label:'記事を進む'}};f.workspace.syncNavigation();assert.equal(f.el('browser-back').disabled,true);
 await f.workspace.dispatch('back');assert.deepEqual(f.hubCalls,[-1,1]);
});
test('HistoryFallback sync only updates buttons and keeps address owner, draft and focus with zero IPC',async t=>{
 const f=await fixture(t,{tabs:[tab({canBack:false,canForward:false})],hub:true}),input=f.el('browser-url');input.focus();f.type('browser-url','unchanged address draft');f.calls.length=0;
 f.hubHistory={back:{available:true,label:'検索に戻る'},forward:{available:false,label:'進む'}};f.workspace.syncNavigation();
 assert.equal(f.el('browser-back').title,'検索に戻る');assert.equal(f.el('browser-forward').disabled,true);assert.equal(input.value,'unchanged address draft');assert.equal(f.document.activeElement,input);assert.equal(f.calls.length,0);
});
async function openHistoryReader(f){
 f.el('browser-tools').click();const button=f.el('browser-menu').querySelector('[data-browser-reader]');assert.ok(button);button.click();
 for(let i=0;i<8&&f.el('browser-reader').hidden;i++)await tick();assert.equal(f.el('browser-reader').hidden,false);f.calls.length=0;
}
test('HistoryFallback unchanged reader close executes exactly one Hub fallback or Native page back after the ACK',async t=>{
 for(const page of [false,true]){
  const f=await fixture(t,{tabs:[tab({canBack:page})],hub:true});await openHistoryReader(f);const close=deferred();f.wait.set('browser_reader_close',close);
  const pending=f.workspace.dispatch('back');await tick();assert.equal(f.calls.filter(call=>call.name==='browser_reader_close').length,1);assert.equal(f.calls.some(call=>call.name==='browser_back'),false);assert.deepEqual(f.hubCalls,[]);
  close.resolve();await pending;assert.equal(f.calls.filter(call=>call.name==='browser_back').length,page?1:0);assert.deepEqual(f.hubCalls,page?[]:[-1]);
 }
});
test('HistoryFallback reader-close await rejects switched tab/view/URL and tab-away-return for both destinations',async t=>{
 for(const page of [false,true])for(const change of ['tab','view','url','return']){
  const f=await fixture(t,{tabs:[tab({canBack:page}),tab({id:2,active:false})],hub:true});await openHistoryReader(f);const close=deferred();f.wait.set('browser_reader_close',close);
  const pending=f.workspace.dispatch('back');await tick();
  if(change==='view'){f.view='ai';f.active=false;}
  else if(change==='url'){f.tabs=f.tabs.map(row=>row.active?{...row,url:'https://changed.example/'}:row);await f.workspace.refresh();}
  else{f.tabs=f.tabs.map(row=>({...row,active:row.id===2}));await f.workspace.refresh();if(change==='return'){f.tabs=f.tabs.map(row=>({...row,active:row.id===1}));await f.workspace.refresh();}}
  close.resolve();await pending;assert.deepEqual(f.hubCalls,[],`${page}/${change}`);assert.equal(f.calls.some(call=>call.name==='browser_back'||call.name==='browser_forward'),false);
 }
});

test('source guard and exact captured reference remain valid until AI accepts the draft',async t=>{
 const f=await fixture(t);let captured;f.acceptDraft=async(draft,source)=>{captured={draft,source};};await f.el('browser-ai').onclick();
 assert.equal(captured.draft,'page draft');assert.deepEqual(captured.source.reference,{title:tab().title,url:tab().url,text:'page draft'});assert.equal(captured.source.isCurrent(),true);
 f.tabs=f.tabs.map(value=>({...value,active:value.id===2}));await f.workspace.refresh();assert.equal(captured.source.isCurrent(),false);
 assert.equal(f.calls.some(call=>call.name==='pi_work_start'),false);
});
test('shared sendToAi and the original button use the same selected page and require explicit acceptance',async t=>{
 const f=await fixture(t);f.acceptDraft=async()=>true;
 assert.equal(await f.workspace.sendToAi({tabId:1,url:tab().url,isCurrent:()=>true}),true);
 assert.equal(await f.el('browser-ai').onclick(),true);
 assert.deepEqual(f.calls.filter(c=>c.name==='browser_send_to_ai').map(c=>c.args),[{id:1,url:tab().url},{id:1,url:tab().url}]);
 for(const value of [undefined,false,'accepted',{accepted:true}]){f.acceptDraft=async()=>value;assert.equal(await f.workspace.sendToAi(),false);}
 f.acceptDraft=async()=>{f.active=false;f.view='ai';return true;};
 assert.equal(await f.workspace.sendToAi(),true,'intentional navigation after acceptance is permitted');
});

test('internal AI context rejects malformed, mismatched, noncanonical and expired input before reading',async t=>{
 const f=await fixture(t);const valid={tabId:1,url:tab().url,isCurrent:()=>true};
 for(const context of [null,[],{...valid,text:'arbitrary'},{...valid,tabId:0},{...valid,tabId:2},{...valid,tabId:1.1},{...valid,url:'https://ONE.example/full/path?q=1'},{...valid,url:'https://user:pass@one.example/'},{...valid,url:'javascript:alert(1)'},{...valid,url:'https://other.example/'},{...valid,isCurrent:true},{...valid,isCurrent:()=>false},{...valid,isCurrent:()=>{throw Error('expired');}}]){const phases=[];assert.equal(await f.workspace.sendToAi(context,phase=>phases.push(phase)),false);assert.deepEqual(phases,['source_changed']);}
 assert.equal(f.calls.some(c=>c.name==='browser_send_to_ai'),false);
});

test('AI page retrieval rejects tab, URL, actor, Hub-origin and expiry races without staging a draft',async t=>{
 for(const change of ['tab','url','actor','origin','expiry']){
  const f=await fixture(t),wait=deferred();let alive=true,accepted=0;
  f.wait.set('browser_send_to_ai',wait);f.acceptDraft=async()=>{accepted++;return true;};
  const phases=[];const pending=f.workspace.sendToAi({tabId:1,url:tab().url,isCurrent:()=>alive},phase=>phases.push(phase));await tick();
  if(change==='tab'){f.tabs=f.tabs.map(value=>({...value,active:value.id===2}));await f.workspace.refresh();}
  if(change==='url'){f.tabs=f.tabs.map(value=>value.id===1?{...value,url:'https://changed.example/'}:value);await f.workspace.refresh();}
  if(change==='actor'||change==='origin')f.dom.window.dispatchEvent(new f.dom.window.Event(change==='actor'?'hub-account-changed':'hub-origin-changed'));
  if(change==='expiry')alive=false;
  wait.resolve();assert.equal(await pending,false);assert.deepEqual(phases,['extracting','source_changed']);assert.equal(accepted,0);assert.equal(f.el('browser-ai').disabled,false);
 }
});

test('AI callback keeps the source guard through acceptance await and suppresses overlapping sends',async t=>{
 const f=await fixture(t),wait=deferred();let captured;
 f.acceptDraft=async(_draft,source)=>{captured=source;await wait.promise;return source.isCurrent();};
 const pending=f.workspace.sendToAi();await tick();assert.equal(await f.workspace.sendToAi(),false);
 assert.equal(captured.isCurrent(),true);f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));assert.equal(captured.isCurrent(),false);
 wait.resolve();assert.equal(await pending,false);assert.equal(f.calls.filter(c=>c.name==='browser_send_to_ai').length,1);
});

test('AI handoff survives same-page display refresh during extraction and acceptance',async t=>{
 for(const phase of ['extract','accept']){
  const f=await fixture(t),wait=deferred();let source;
  f.acceptDraft=async(_draft,captured)=>{source=captured;if(phase==='accept')await wait.promise;return captured.isCurrent();};
  if(phase==='extract')f.wait.set('browser_send_to_ai',wait);
  const pending=f.workspace.sendToAi();await tick();
  f.tabs=f.tabs.map(entry=>({...entry,title:'Updated title',loading:false,canBack:true,muted:false}));
  await f.workspace.refresh();
  if(source)assert.equal(source.isCurrent(),true);
  wait.resolve();assert.equal(await pending,true,phase);
  assert.equal(f.calls.filter(call=>call.name==='browser_send_to_ai').length,1);
  assert.equal(f.calls.some(call=>call.name==='pi_work_start'),false);
 }
});
test('AI phase observer identifies extraction, staging, refusal and acceptance without source content',async t=>{
 for(const outcome of ['extract_failed','draft_failed','draft_refused','accepted']){
  const f=await fixture(t),observed=[];
  if(outcome==='extract_failed')f.fail.add('browser_send_to_ai');
  f.acceptDraft=async()=>{if(outcome==='draft_failed')throw Error('private diagnostic');return outcome==='accepted';};
  const accepted=await f.workspace.sendToAi(undefined,(...args)=>observed.push(args));
  assert.equal(accepted,outcome==='accepted');
  assert.deepEqual(observed,(outcome==='extract_failed'?['extracting',outcome]:['extracting','staging',outcome]).map(phase=>[phase]));
  assert.equal(f.el('browser-ai').disabled,false);
 }
});

test('throwing and rejecting AI phase observers cannot change draft acceptance or failure',async t=>{
 for(const observer of [()=>{throw Error('observer diagnostic');},async()=>{throw Error('observer diagnostic');}]){
  for(const accepted of [true,false]){
   const f=await fixture(t);f.acceptDraft=async()=>accepted;
   assert.equal(await f.workspace.sendToAi(undefined,observer),accepted);await tick();
   assert.equal(f.calls.filter(call=>call.name==='browser_send_to_ai').length,1);assert.equal(f.el('browser-ai').disabled,false);
  }
 }
 const f=await fixture(t),phases=[];f.acceptDraft=async()=>{f.active=false;f.view='ai';return true;};
 assert.equal(await f.workspace.sendToAi(undefined,phase=>phases.push(phase)),true);assert.deepEqual(phases,['extracting','staging','accepted']);
});

test('AI staging classifies changed actor and origin before refusal or error as source_changed',async t=>{
 for(const event of ['hub-account-changed','hub-origin-changed']){
  for(const throws of [false,true]){
   const f=await fixture(t),wait=deferred(),phases=[];
   f.acceptDraft=async()=>{await wait.promise;if(throws)throw Error('private diagnostic');return false;};
   const pending=f.workspace.sendToAi(undefined,phase=>phases.push(phase));await tick();
   f.dom.window.dispatchEvent(new f.dom.window.Event(event));wait.resolve();
   assert.equal(await pending,false);assert.deepEqual(phases,['extracting','staging','source_changed']);assert.equal(f.el('browser-ai').disabled,false);
  }
 }
});

test('tab rows show a valid PNG favicon, and fall back to the host letter for absent, foreign or oversize icons',async t=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
 const f=await fixture(t,{tabs:[tab({favicon:png}),tab({id:2,active:false,url:'https://two.example/',favicon:'data:image/svg+xml;base64,PHN2Zy8+'}),tab({id:3,active:false,url:'https://three.example/',favicon:'javascript:alert(1)'}),tab({id:4,active:false,url:'https://four.example/',favicon:'data:image/png;base64,iVBORw0KGgo'+'A'.repeat(50000)}),tab({id:5,active:false,url:'https://five.example/'})]});
 const image=f.el('browser-tab-1').querySelector('.browser-tab-badge img');assert.match(image.getAttribute('src'),/^blob:/);assert.equal(image.alt,'');assert.equal(f.el('browser-tab-1').querySelector('.browser-tab-badge').textContent,'');
 for(const [id,letter] of [[2,'T'],[3,'T'],[4,'F'],[5,'F']])assert.equal(f.el('browser-tab-'+id).querySelector('img'),null),assert.equal(f.el('browser-tab-'+id).querySelector('.browser-tab-badge').textContent,letter);
});

test('sleeping tabs read 休止中, the tab menu sleeps only hidden tabs, and the tools menu sleeps the silent rest',async t=>{
 const f=await fixture(t,{tabLayout:'vertical',tabs:[tab(),tab({id:2,title:'second',url:'https://two.example/x',active:false}),tab({id:3,title:'third',url:'https://three.example/',active:false,discarded:true}),audioTab({id:4,active:false}),tab({id:5,url:'https://five.example/',active:false,private:true})]});
 const sleeping=f.el('browser-tab-3');assert.ok(sleeping.classList.contains('is-discarded'));assert.equal(sleeping.querySelector('.browser-tab-sleeping').textContent,'休止中');
 assert.ok(sleeping.querySelector('.browser-tab-select').getAttribute('aria-label').startsWith('休止中 · '));assert.equal(f.el('browser-tab-2').querySelector('.browser-tab-sleeping'),null);
 menuTab(f,1);assert.equal(menuItem(f,'このタブを休止').disabled,true);
 menuTab(f,5);assert.equal(menuItem(f,'このタブを休止').disabled,true);
 menuTab(f,3);assert.equal(menuItem(f,'休止中（選ぶと再開）').disabled,true);
 menuTab(f,2);const item=menuItem(f,'このタブを休止');assert.equal(item.disabled,false);item.click();await tick();await tick();
 assert.deepEqual(f.calls.filter(call=>call.name==='browser_sleep_tab'),[{name:'browser_sleep_tab',args:{id:2}}]);
 openTools(f);const bulk=f.el('browser-menu').querySelector('[data-browser-sleep-others]');
 // Tab 2 is the only silent, hidden, ordinary, awake tab: 1 active, 3 slept, 4 playing, 5 private.
 assert.equal(bulk.dataset.browserSleepOthers,'1');assert.equal(bulk.textContent,'ほかの1タブを休止してメモリを空ける');bulk.click();await tick();await tick();
 assert.equal(f.calls.filter(call=>call.name==='browser_sleep_background_tabs').length,1);
 f.tabs=[tab()];await f.workspace.refresh();openTools(f);const none=f.el('browser-menu').querySelector('[data-browser-sleep-others]');assert.equal(none.disabled,true);assert.equal(none.textContent,'休ませられるタブはありません');
});

test('the tab audio mark toggles mute in place and stays a plain indicator when mute is unavailable',async t=>{
 const f=await fixture(t,{tabLayout:'vertical',tabs:[tab(),audioTab({id:2,active:false}),audioTab({id:3,active:false,muted:true,playingAudio:false,canMute:false})]});
 const toggle=f.el('browser-tab-2').querySelector('[data-tab-action="audio"]');assert.ok(toggle);assert.equal(toggle.getAttribute('aria-label'),'firstの音声をミュート');assert.ok(toggle.querySelector('[aria-label="音声再生中"]'));
 toggle.click();await tick();await tick();assert.deepEqual(f.calls.filter(call=>call.name==='browser_set_muted').map(call=>call.args),[{id:2,muted:true}]);
 assert.ok(f.el('browser-tab-2').querySelector('[data-tab-action="audio"] [aria-label="音声ミュート中"]'));
 assert.equal(f.el('browser-tab-3').querySelector('[data-tab-action="audio"]'),null);assert.ok(f.el('browser-tab-3').querySelector('.browser-tab-select [aria-label="音声ミュート中"]'));
 assert.equal(f.calls.some(call=>call.name==='browser_activate_tab'),false);
});

test('address bar Esc reverts an edit first and blurs on the second press', async t => {
 const f = await fixture(t), input = f.el('browser-url');
 input.focus(); f.type('browser-url', 'typed text');
 assert.equal(f.key(input, 'Escape').defaultPrevented, true);
 assert.equal(input.value, 'https://one.example/full/path?q=1'); assert.equal(f.document.activeElement, input);
 f.key(input, 'Escape'); assert.notEqual(f.document.activeElement, input);
});
test('Ctrl+Enter completes a bare word with www. and .com in the current tab', async t => {
 const f = await fixture(t), input = f.el('browser-url');
 input.focus(); f.type('browser-url', 'example');
 assert.equal(f.key(input, 'Enter', { ctrlKey: true }).defaultPrevented, true); await tick();
 assert.deepEqual(f.calls.find(c => c.name === 'browser_navigate_from_address')?.args, { id: 1, url: 'https://www.example.com/' });
});
test('Esc stops a loading page only when nothing else is open', async t => {
 const f = await fixture(t, { tabs: [tab({ loading: true })] });
 f.key(f.document.body, 'Escape'); await tick();
 assert.equal(f.calls.filter(c => c.name === 'browser_stop').length, 1);
 const g = await fixture(t);
 g.key(g.document.body, 'Escape'); await tick();
 assert.equal(g.calls.some(c => c.name === 'browser_stop'), false);
});
test('Chrome keys reach their commands: Ctrl+PgDn, Ctrl+D, Ctrl+F5', async t => {
 const f = await fixture(t);
 f.key(f.document.body, 'PageDown', { ctrlKey: true }); await tick(); await tick();
 assert.deepEqual(f.calls.find(c => c.name === 'browser_activate_tab')?.args, { id: 2 });
 const g = await fixture(t);
 g.key(g.document.body, 'd', { ctrlKey: true }); await tick();
 assert.ok(g.calls.some(c => c.name === 'browser_add_favorite' && c.args.url === 'https://one.example/full/path?q=1'));
 g.key(g.document.body, 'F5', { ctrlKey: true }); await tick();
 assert.equal(g.calls.filter(c => c.name === 'browser_hard_reload').length, 1);
 assert.equal(g.calls.some(c => c.name === 'browser_reload'), false);
});
test('double-clicking empty tab-list space opens a new tab; a tab row does not', async t => {
 const f = await fixture(t), list = f.el('sidebar-tabs-list');
 f.el('browser-tab-1').dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick();
 assert.equal(f.calls.some(c => c.name === 'browser_new_tab'), false);
 list.dispatchEvent(new f.dom.window.MouseEvent('dblclick', { bubbles: true })); await tick(); await tick();
 assert.equal(f.calls.filter(c => c.name === 'browser_new_tab').length, 1);
});
test('selection search opens the configured engine in a foreground tab for the active tab only', async t => {
 const f = await fixture(t, { savedEngine: 'duckduckgo' });
 f.events['browser-search-selection']({ payload: { tabId: 2, text: 'ignored' } });
 f.events['browser-search-selection']({ payload: { tabId: 1, text: 'x', extra: 1 } });
 f.events['browser-search-selection']({ payload: { tabId: 1, text: ' 研究\n code ' } }); await tick();
 assert.deepEqual(f.calls.filter(c => c.name === 'browser_open_tab').map(c => c.args), [{ url: 'https://duckduckgo.com/?q=%E7%A0%94%E7%A9%B6%20code', foreground: true }]);
});
test('tab context menu offers reload for the shown tab and reopening a closed tab', async t => {
 const f = await fixture(t);
 menuTab(f, 1); assert.ok(menuItem(f, '再読み込み')); assert.ok(menuItem(f, '閉じたタブを開く'));
 menuItem(f, '再読み込み').click(); await tick();
 assert.equal(f.calls.filter(c => c.name === 'browser_reload').length, 1);
 menuTab(f, 2); assert.equal(menuItem(f, '再読み込み'), undefined);
});
