import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {initBrowserReader} from './browser-reader.mjs';
import {initBrowserWorkspace} from './browser-workspace.mjs';
import {initBrowserPanels} from './browser-panels.mjs';
import {pathToFileURL} from 'node:url';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const source={id:1,url:'https://page.example/',epoch:1};
const dto=extra=>({id:1,url:source.url,title:'Readable',paragraphs:['First paragraph','Second paragraph'],truncated:false,contextToken:'reader-1',...extra});
function fixture(t){const dom=new JSDOM('<section id="reader" hidden></section>'),host=dom.window.document.querySelector('#reader');const f={dom,host,source:{...source},calls:[],errors:[],read:dto(),wait:new Map(),before:0};
 const invoke=async(name,args)=>{f.calls.push({name,args});if(f.wait.has(name))await f.wait.get(name).promise;if(f.fail===name)throw Error('command unavailable');if(name==='browser_reader_read')return f.read;if(name==='browser_reader_open')return f.ack??{id:args.id,opened:true,contextToken:args.contextToken};return f.closeAck??{closed:true};};
 f.reader=initBrowserReader({document:dom.window.document,host,invoke,getContext:()=>f.source,refresh:async()=>{f.calls.push({name:'refresh'});if(f.wait.has('refresh'))await f.wait.get('refresh').promise;f.onRefresh?.();},beforeOpen:()=>{f.before++;},report:error=>f.errors.push(String(error))});t.after(()=>dom.window.close());return f;}

test('Reader finds literal Japanese and case-insensitive title/body matches with forward/backward wrap',async t=>{
 const f=fixture(t);f.read=dto({title:'TITLE 日本語',paragraphs:['First 日本語 paragraph','second title 日本語 TITLE']});await f.reader.open();const before=f.calls.length;
 const title=f.host.querySelector('h2'),paragraphs=[...f.host.querySelectorAll('article p')],original=paragraphs.map(node=>node.textContent);
 assert.deepEqual(f.reader.find('日本語'),{found:true,current:1,total:3});assert.equal(f.host.querySelector('mark').closest('h2'),title);
 assert.equal(f.reader.find('日本語').current,2);assert.equal(f.reader.find('日本語').current,3);assert.equal(f.reader.find('日本語').current,1);assert.equal(f.reader.find('日本語',true).current,3);
 assert.deepEqual(f.reader.find('title',true),{found:true,current:3,total:3});assert.equal(f.reader.find('TITLE').total,3);
 assert.deepEqual(paragraphs.map(node=>node.textContent),original);assert.deepEqual([...f.host.querySelectorAll('article p')],paragraphs);assert.equal(f.host.querySelectorAll('mark').length,1);assert.equal(f.calls.length,before);
});
test('Reader literal metacharacters/XSS, no match, empty and find-close never change body or create links',async t=>{
 const f=fixture(t),literal='<img src=x onerror=alert(1)> [a.*]';f.read=dto({title:'Safe title',paragraphs:[literal]});await f.reader.open();const body=f.host.querySelector('article p');
 assert.equal(f.reader.find(literal).total,1);assert.equal(f.host.querySelector('mark').textContent,literal);assert.equal(f.host.querySelectorAll('img,a,script').length,0);assert.equal(body.textContent,literal);
 assert.equal(f.reader.find('[a.*]').total,1);assert.equal(f.reader.find('a.*').total,1);assert.equal(f.reader.find('missing').found,false);assert.equal(f.host.querySelector('mark'),null);
 f.reader.find('[a.*]');f.reader.clearFind();assert.equal(f.host.querySelector('mark'),null);assert.equal(body.textContent,literal);assert.deepEqual(f.reader.find(''),{found:false,current:0,total:0});
});
test('Reader query UTF16 200 boundary, controls and invalid Unicode are checked without Native find',async t=>{
 const f=fixture(t),term='😀'.repeat(100);f.read=dto({paragraphs:[term+' '+term]});await f.reader.open();const before=f.calls.length;
 assert.equal(f.reader.find(term).total,2);assert.equal(f.reader.find(term,true).current,2);
 for(const query of [term+'x','x'.repeat(201),'x\n','\u0085','\0','\ud800']){assert.throws(()=>f.reader.find(query),/invalid_find_query/);assert.equal(f.host.querySelector('mark'),null);}
 assert.equal(f.calls.length,before);
});
test('Reader search excludes chrome/truncation note and limits highlights to one for maximum body size',async t=>{
 const f=fixture(t);f.read=dto({paragraphs:['日'.repeat(100000)],truncated:true});await f.reader.open();assert.equal(f.reader.find('日').total,100000);assert.equal(f.host.querySelectorAll('mark').length,1);
 assert.equal(f.reader.find('元のページへ').total,0);assert.equal(f.reader.find('一部を省略').total,0);
});
test('Reader close/invalidation/stale context erase marks and a new document has independent search state',async t=>{
 const f=fixture(t);await f.reader.open();f.reader.find('paragraph');f.reader.handleClosed({contextToken:'reader-1'});assert.equal(f.host.querySelector('mark'),null);assert.equal(f.host.hidden,true);
 await f.reader.open();f.reader.find('paragraph');f.source={...f.source,epoch:2};assert.equal(f.reader.find('paragraph').found,false);assert.equal(f.host.querySelector('mark'),null);await f.reader.close();
 f.read=dto({paragraphs:['New 日本語']});await f.reader.open();assert.deepEqual(f.reader.find('日本語'),{found:true,current:1,total:1});await f.reader.dispose();assert.equal(f.host.querySelector('mark'),null);
});

test('valid read is prepared as literal paragraphs before native open, and matching close restores its context',async t=>{
 const f=fixture(t);f.read=dto({title:'<img src=x>',paragraphs:['<script>bad()</script>','https://untrusted.example/image.png'],truncated:true});await f.reader.open();
 assert.deepEqual(f.calls.map(c=>c.name),['browser_reader_read','refresh','browser_reader_open']);assert.equal(f.host.hidden,false);assert.equal(f.before,1);assert.equal(f.host.querySelector('img,a,script,iframe'),null);assert.equal(f.host.querySelector('h2').textContent,'<img src=x>');assert.equal(f.host.querySelector('p').textContent,'<script>bad()</script>');assert.ok(f.host.textContent.includes('一部を省略'));assert.equal(f.reader.active,true);
 await f.reader.close();assert.equal(f.host.hidden,true);assert.equal(f.reader.active,false);assert.deepEqual(f.calls.at(-1),{name:'browser_reader_close',args:{contextToken:'reader-1'}});
});

test('closed DTO rejects every count, Unicode, token, identity, type and byte boundary before native open',async t=>{
 for(const data of [dto({id:2}),dto({url:'https://other.example/'}),dto({extra:true}),dto({title:'😀'.repeat(301)}),dto({paragraphs:Array(1001).fill('x')}),dto({paragraphs:['😀'.repeat(100001)]}),dto({paragraphs:['\u0000']}),dto({paragraphs:['\ud800']}),dto({paragraphs:[' ']}),dto({paragraphs:[]}),dto({contextToken:'x'.repeat(129)}),dto({contextToken:'space token'}),dto({contextToken:'日本語'}),dto({contextToken:null}),dto({truncated:'false'}),dto({paragraphs:['\u0001'.repeat(100000)]})]){const f=fixture(t);f.read=data;await f.reader.open();assert.equal(f.calls.some(c=>c.name==='browser_reader_open'),false);assert.equal(f.host.hidden,true);assert.equal(f.errors.length,1);}
 const f=fixture(t);f.read=dto({title:'😀'.repeat(300),paragraphs:['😀'.repeat(100000)],contextToken:'x'.repeat(128)});await f.reader.open();assert.equal(f.host.hidden,false);assert.equal(f.host.querySelector('p').textContent,f.read.paragraphs[0]);
});

test('cancel read and a changed source or fresh getter prevent late body or native open',async t=>{
 for(const mode of ['cancel','tab','url','epoch','fresh','dispose']){const f=fixture(t),wait=deferred();f.wait.set('browser_reader_read',wait);const pending=f.reader.open();await tick();
  if(mode==='cancel')await f.reader.close();if(mode==='dispose')await f.reader.dispose();if(mode==='tab')f.source={...source,id:2};if(mode==='url')f.source={...source,url:'https://new.example/'};if(mode==='epoch')f.source={...source,epoch:2};if(mode==='fresh')f.onRefresh=()=>{f.source={...source,epoch:2};};wait.resolve();await pending;assert.equal(f.host.hidden,true);assert.equal(f.calls.some(c=>c.name==='browser_reader_open'),false);assert.equal(f.errors.length,0);
 }
});

test('the whole JSON byte budget accepts its exact limit and refuses overflow without slicing',async t=>{
 const base=dto({paragraphs:['\u0001'.repeat(85000)+'x']});const bytes=new TextEncoder().encode(JSON.stringify(base)).byteLength;
 for(const size of [524287,524288,524289]){const f=fixture(t);f.read={...base,paragraphs:[base.paragraphs[0]+' '.repeat(size-bytes)]};assert.equal(new TextEncoder().encode(JSON.stringify(f.read)).byteLength,size);await f.reader.open();assert.equal(f.host.hidden,size>524288);assert.equal(f.calls.some(c=>c.name==='browser_reader_open'),size<=524288);if(size<=524288)assert.equal(f.host.querySelector('p').textContent,f.read.paragraphs[0]);}
 const f=fixture(t);f.read=dto({paragraphs:Array(1000).fill('text')});await f.reader.open();assert.equal(f.host.querySelectorAll('.browser-reader-body p').length,1000);
});

test('single pending read and matching cleanup close late native opens after cancellation',async t=>{
 const f=fixture(t),wait=deferred();f.wait.set('browser_reader_open',wait);const pending=f.reader.open();await tick();await f.reader.open();assert.equal(f.calls.filter(c=>c.name==='browser_reader_read').length,1);assert.equal(f.host.hidden,true);
 await f.reader.close();assert.equal(f.calls.filter(c=>c.name==='browser_reader_close').length,1);wait.resolve();await pending;assert.equal(f.host.hidden,true);assert.equal(f.reader.active,false);assert.equal(f.calls.filter(c=>c.name==='browser_reader_close').length,2);
});

test('a cancelled old read never blocks another panel or replaces a new-tab reader when it returns',async t=>{
 const f=fixture(t),wait=deferred();f.wait.set('browser_reader_read',wait);const old=f.reader.open();await tick();await f.reader.close();assert.equal(f.reader.busy,false);f.wait.clear();f.source={id:2,url:'https://second.example/',epoch:2};f.read=dto({id:2,url:f.source.url,title:'Second',contextToken:'reader-2'});await f.reader.open();assert.equal(f.host.hidden,false);wait.resolve();await old;assert.equal(f.host.querySelector('h2').textContent,'Second');assert.equal(f.reader.active,true);assert.deepEqual(f.calls.filter(c=>c.name==='browser_reader_open').map(c=>c.args.id),[2]);
});

test('an older panel opening waits for matching reader close and cannot overwrite a newer panel',async t=>{
 const dom=new JSDOM('<div id="browser-menu" hidden></div><div id="browser-tools"></div>');t.after(()=>dom.window.close());dom.window.__TAURI__={event:{listen:()=>{}}};const document=dom.window.document,wait=deferred();let first=true;
 const button=(label,fn)=>{const node=document.createElement('button');node.textContent=label;node.onclick=fn;return node;};
 const panels=initBrowserPanels({document,window:dom.window,invoke:async name=>name==='browser_session_status'?0:[],button,report:()=>{},refresh:async()=>{},hideSuggestions:()=>{},beforePanelOpen:()=>first?(first=false,wait.promise):true});await tick();panels.addTools(document.querySelector('#browser-tools'));const controls=[...document.querySelector('#browser-tools').children];controls.find(node=>node.textContent==='ダウンロード').click();assert.equal(document.querySelector('#browser-menu').hidden,true);controls.find(node=>node.textContent==='サイト権限').click();wait.resolve(true);await tick();assert.ok(document.querySelector('#browser-menu').textContent.includes('サイト権限'));
});

test('unavailable commands and invalid open acknowledgements do not succeed and release only their token',async t=>{
 for(const ack of [{id:2,opened:true,contextToken:'reader-1'},{id:1,opened:false,contextToken:'reader-1'},{id:1,opened:true,contextToken:'other'},{id:1,opened:true,contextToken:'reader-1',extra:true}]){const f=fixture(t);f.ack=ack;await f.reader.open();assert.equal(f.host.hidden,true);assert.equal(f.reader.active,false);assert.deepEqual(f.calls.at(-1),{name:'browser_reader_close',args:{contextToken:'reader-1'}});}
 for(const command of ['browser_reader_read','browser_reader_open']){const f=fixture(t);f.fail=command;await f.reader.open();assert.equal(f.host.hidden,true);assert.equal(f.reader.active,false);assert.equal(f.errors.length,1);}
});

test('DOM preparation failure never occludes the child and post-open display failure cleans up its token',async t=>{
 const f=fixture(t);f.host.replaceChildren=()=>{throw Error('render failure');};await f.reader.open();assert.equal(f.calls.some(c=>c.name==='browser_reader_open'),false);assert.equal(f.host.hidden,true);
 const g=fixture(t);let hidden=true;Object.defineProperty(g.host,'hidden',{get:()=>hidden,set:value=>{if(value===false)throw Error('display failure');hidden=value;}});await g.reader.open();assert.equal(g.reader.active,false);assert.deepEqual(g.calls.at(-1),{name:'browser_reader_close',args:{contextToken:'reader-1'}});
});

test('old native closed events and delayed close replies cannot clear a newer reader',async t=>{
 const f=fixture(t);await f.reader.open();const wait=deferred();f.wait.set('browser_reader_close',wait);const close=f.reader.close();await f.reader.open();assert.equal(f.calls.filter(c=>c.name==='browser_reader_read').length,1);wait.resolve();await close;f.wait.clear();f.read=dto({contextToken:'reader-2'});await f.reader.open();
 f.reader.handleClosed({contextToken:'reader-1'});f.reader.handleClosed({contextToken:'reader-2',extra:true});assert.equal(f.host.hidden,false);assert.equal(f.reader.active,true);f.reader.handleClosed({contextToken:'reader-2'});assert.equal(f.host.hidden,true);assert.equal(f.reader.active,false);
});

test('close failure remains unconfirmed and offers matching-token retry',async t=>{
 const f=fixture(t);await f.reader.open();f.closeAck={closed:false};assert.equal(await f.reader.close(),false);assert.equal(f.reader.active,true);assert.equal(f.host.hidden,false);assert.ok(f.host.textContent.includes('復帰を確認できません'));f.closeAck={closed:true};f.host.querySelector('button').click();await tick();assert.equal(f.reader.active,false);assert.equal(f.host.hidden,true);
});

async function workspace(t){const dom=new JSDOM(readFileSync(process.env.HUB_BROWSER_MARKUP?pathToFileURL(process.env.HUB_BROWSER_MARKUP):new URL('./index.html',import.meta.url),'utf8'),{url:'http://fixture.invalid/'}),document=dom.window.document,events={},calls=[],f={dom,document,events,calls,tab:{id:1,url:source.url,title:'page',active:true,discarded:false,canBack:true,canForward:true,printContextToken:'print-1'},downloads:[],view:'browser',visible:true};dom.window.matchMedia=()=>({matches:false,addEventListener(){}});dom.window.HTMLElement.prototype.scrollIntoView=()=>{};dom.window.__TAURI__={event:{listen:(name,fn)=>{events[name]=fn;return Promise.resolve(()=>{});}}};
 const invoke=async(name,args)=>{calls.push({name,args});if(name==='browser_workspace_snapshot'){if(f.snapshotWait)await f.snapshotWait.promise;return {version:1,tabs:[f.tab],favorites:[],history:[]};}if(name==='browser_downloads')return f.downloads;if(name==='browser_site_requests')return [];if(name==='browser_session_status')return 0;if(name==='browser_reader_read')return dto();if(name==='browser_reader_open'){f.duringOpen?.();return {id:1,opened:true,contextToken:'reader-1'};}if(name==='browser_reader_close'){if(f.closeWait)await f.closeWait.promise;return {closed:true};}};
 f.workspace=initBrowserWorkspace({document,window:dom.window,invoke,icon:()=>'',enterBrowser:async()=>{},isActive:()=>f.visible,getView:()=>f.view,onAiDraft:async()=>{}});t.after(()=>dom.window.close());await tick();f.open=async()=>{document.querySelector('#browser-tools').click();document.querySelector('[data-browser-reader]').click();await tick();await tick();};return f;}

test('workspace tools open reader; hidden-page operations are blocked and Escape releases the matching child',async t=>{
 const f=await workspace(t);await f.open();assert.equal(f.document.querySelector('#browser-reader').hidden,false);assert.equal(f.document.querySelector('#browser-menu').hidden,true);const before=f.calls.length;
 for(const action of ['find','print','zoom-in','zoom-out','zoom-reset'])await f.workspace.dispatch(action);assert.equal(f.calls.length,before);
 f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();assert.equal(f.document.querySelector('#browser-reader').hidden,true);assert.equal(f.calls.at(-1).name,'browser_reader_close');
 await f.open();const start=f.calls.length;await f.workspace.dispatch('back');assert.equal(f.calls.slice(start).find(c=>c.name==='browser_reader_close').args.contextToken,'reader-1');assert.ok(f.calls.slice(start).some(c=>c.name==='browser_back'));
});

test('Reader toolbar/CtrlF search uses existing findbar with no Native page_find or focus IPC',async t=>{
 const f=await workspace(t);await f.open();const before=f.calls.length,query=f.document.querySelector('#browser-find-query'),form=f.document.querySelector('#browser-find-form');
 f.document.querySelector('#browser-find').click();assert.equal(f.document.querySelector('#browser-find-bar').hidden,false);query.value='paragraph';form.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(f.document.querySelector('#browser-find-status').textContent,'1 / 2');assert.equal(f.document.querySelector('mark').textContent,'paragraph');
 f.document.querySelector('#browser-find-next').click();await tick();assert.equal(f.document.querySelector('#browser-find-status').textContent,'2 / 2');f.document.querySelector('#browser-find-previous').click();await tick();assert.equal(f.document.querySelector('#browser-find-status').textContent,'1 / 2');
 f.document.querySelector('#browser-find-close').click();assert.equal(f.document.querySelector('mark'),null);assert.equal(f.document.querySelector('#browser-reader').hidden,false);
 f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));await tick();assert.equal(f.document.querySelector('#browser-find-bar').hidden,false);
 assert.equal(f.calls.slice(before).some(call=>['browser_find','browser_focus_controls'].includes(call.name)),false);
 f.document.querySelector('#browser-reader button').click();await tick();assert.equal(f.document.querySelector('#browser-find-bar').hidden,true);assert.equal(f.document.querySelector('#browser-find-status').textContent,'');
 f.document.querySelector('#browser-find').click();query.value='paragraph';form.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.ok(f.calls.some(call=>call.name==='browser_find'));
});

test('private shortcut closes Reader first and a late close cannot create in a different tab/view',async t=>{
 for(const stale of [false,true]){const f=await workspace(t);await f.open();f.closeWait=deferred();const before=f.calls.length,pending=f.workspace.dispatch('private-new');await tick();assert.equal(f.calls.slice(before).some(call=>call.name==='browser_new_private_tab'),false);
  if(stale){f.view='feed';f.visible=false;f.workspace.cancelPendingFocus();}f.closeWait.resolve();await pending;
  assert.equal(f.calls.slice(before).filter(call=>call.name==='browser_new_private_tab').length,stale?0:1);assert.equal(f.calls.some(call=>call.name==='browser_new_tab'),false);assert.equal(f.document.querySelector('mark'),null);
 }
});

test('navigation, exit and auto download panels invalidate reader without overlapping UI panels',async t=>{
 for(const reason of ['url','tab','exit','download']){const f=await workspace(t);await f.open();if(reason==='url'){f.tab={...f.tab,url:'https://changed.example/'};f.events['browser-url-changed']();}if(reason==='tab'){f.tab={...f.tab,id:2};await f.workspace.refresh();}if(reason==='exit'){f.visible=false;f.view='feed';f.workspace.cancelPendingFocus();}if(reason==='download'){f.downloads=[{id:1,name:'fixture.txt',received:0,total:1,status:'choosing'}];f.events['browser-access-changed']();}await tick();await tick();assert.equal(f.document.querySelector('#browser-reader').hidden,true);assert.ok(f.calls.some(c=>c.name==='browser_reader_close'));if(reason==='download')assert.equal(f.document.querySelector('#browser-menu').hidden,false);}
});

test('Reader Escape respects other open dialogs and delayed close cannot navigate a different current tab',async t=>{
 const f=await workspace(t);await f.open();const modal=f.document.querySelector('#notice-dialog');modal.setAttribute('open','');const before=f.calls.length;f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();assert.equal(f.calls.length,before);assert.equal(f.document.querySelector('#browser-reader').hidden,false);modal.removeAttribute('open');f.closeWait=deferred();const pending=f.workspace.dispatch('back');await tick();f.tab={...f.tab,id:2,url:'https://second.example/'};await f.workspace.refresh();f.closeWait.resolve();await pending;assert.equal(f.calls.some(c=>c.name==='browser_back'),false);
});

test('same-tab metadata refresh pending at open ACK does not invalidate the reader source',async t=>{
 const f=await workspace(t),wait=deferred();f.duringOpen=()=>{f.snapshotWait=wait;f.events['browser-tabs-changed']();};await f.open();assert.equal(f.document.querySelector('#browser-reader').hidden,false);assert.equal(f.calls.some(c=>c.name==='browser_reader_close'),false);wait.resolve();await tick();assert.equal(f.document.querySelector('#browser-reader').hidden,false);
});
