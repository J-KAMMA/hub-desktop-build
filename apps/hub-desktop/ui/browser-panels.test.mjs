import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {initBrowserPanels} from './browser-panels.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const row=(overrides={})=>({id:1,name:'archive.zip',received:256,total:1024,status:'active',path:null,canResume:false,choosingDestination:false,interruptReason:null,...overrides});
const find=(root,text)=>[...root.querySelectorAll('button')].find(button=>button.textContent===text);
async function fixture(t,rows=[row()],history=false){
 const dom=new JSDOM('<div><section id="browser-menu" hidden></section><div id="browser-tools"></div></div>',{url:'http://localhost'}),document=dom.window.document,events={},calls=[],f={dom,document,calls,rows,requests:[],session:0,readError:null,errors:[],refreshed:0,hidden:0,command:async(name,args)=>name==='browser_save_download'?{id:args.id,queued:true}:undefined,reads:null};
 dom.window.__TAURI__={event:{listen:(name,callback)=>{events[name]=callback;}}};
 const button=(text,run,className='')=>{const node=document.createElement('button');node.type='button';node.className=className;node.textContent=text;node.onclick=run;return node;};
 const invoke=async(name,args)=>{calls.push({name,args});if(name==='browser_session_status')return f.session;if(name==='browser_downloads'){if(f.readError)throw f.readError;return f.reads?f.reads():f.rows;}if(name==='browser_site_requests')return f.requests;return f.command(name,args);};
 f.tab={id:1,active:true,url:'https://example.test',private:false,epoch:0};f.view='browser';f.before=()=>true;f.settle=()=>true;
 f.panels=initBrowserPanels({document,window:dom.window,invoke,button,report:error=>f.errors.push(error),refresh:async()=>f.refreshed++,hideSuggestions:()=>f.hidden++,...history?{getActiveTab:()=>f.tab,getView:()=>f.view,beforePanelOpen:()=>f.before(),beforeDownloadHistory:current=>f.settle(current)}:{}});await tick();f.menu=document.querySelector('#browser-menu');document.querySelector('#browser-downloads').click();f.events=events;t.after(()=>dom.window.close());return f;
}
test('active can pause, native paused eligibility can resume, and completion is only shown from the refreshed DTO',async t=>{
 const f=await fixture(t);assert.ok(find(f.menu,'一時停止'));assert.equal(find(f.menu,'再開'),undefined);assert.ok(find(f.menu,'キャンセル'));assert.match(f.menu.textContent,/再起動後は引き継げません/);
 f.command=async(name,args)=>{assert.deepEqual(args,{id:1});assert.equal(name,'browser_pause_download');f.rows=[row({status:'paused',canResume:true,interruptReason:28})];};await find(f.menu,'一時停止').onclick();assert.match(f.menu.textContent,/一時停止中/);assert.ok(find(f.menu,'再開'));assert.equal(find(f.menu,'フォルダーで確認'),undefined);
 f.command=async(name,args)=>{assert.equal(name,'browser_resume_download');assert.deepEqual(args,{id:1});return {status:'complete'};};await find(f.menu,'再開').onclick();assert.match(f.menu.textContent,/一時停止中/);assert.equal(find(f.menu,'フォルダーで確認'),undefined);
 f.rows=[row({status:'complete',received:1024,path:'C:/private/downloads/archive.zip'})];await f.panels.load();assert.ok(find(f.menu,'フォルダーで確認'));assert.equal(find(f.menu,'再開'),undefined);assert.equal(find(f.menu,'キャンセル'),undefined);assert.doesNotMatch(f.menu.textContent,/C:|private/);
});
test('resumption requires reported CanResume and an allowed reason, legacy and security reasons do not resume',async t=>{
 const f=await fixture(t,[]);
 for(const reason of [12,13,14,15,28]){f.rows=[row({status:'interrupted',canResume:true,interruptReason:reason})];await f.panels.load();assert.ok(find(f.menu,'再開'));assert.ok(find(f.menu,'キャンセル'));}
 for(const reason of [null,undefined,-1,0,1,2,11,16,18,20,27,29,999,Number.MAX_SAFE_INTEGER+1,'12']){f.rows=[row({status:'interrupted',canResume:true,interruptReason:reason})];await f.panels.load();assert.equal(find(f.menu,'再開'),undefined);assert.match(f.menu.textContent,/現在このダウンロードは再開できません/);assert.ok(find(f.menu,'キャンセル'));}
 for(const canResume of [undefined,false,'true',1]){f.rows=[row({status:'paused',canResume,interruptReason:28})];await f.panels.load();assert.equal(find(f.menu,'再開'),undefined);}
 f.rows=[{id:1,name:'old.zip',received:0,total:0,status:'active',path:null}];await f.panels.load();assert.ok(find(f.menu,'一時停止'));assert.equal(find(f.menu,'再開'),undefined);
});
test('pending action protects every captured and newly rendered row control against duplicate commands',async t=>{
 const f=await fixture(t),pending=deferred();f.command=()=>pending.promise;const pause=find(f.menu,'一時停止'),cancel=find(f.menu,'キャンセル');const action=pause.onclick();await tick();assert.equal(find(f.menu,'一時停止').disabled,true);assert.equal(find(f.menu,'キャンセル').disabled,true);assert.match(f.menu.textContent,/操作結果を確認しています/);
 await pause.onclick();await cancel.onclick();await f.panels.load();assert.equal(find(f.menu,'一時停止').disabled,true);await find(f.menu,'キャンセル').onclick();assert.equal(f.calls.filter(call=>call.name==='browser_pause_download'||call.name==='browser_cancel_download').length,1);
 f.rows=[row({status:'paused',canResume:true,interruptReason:28})];pending.resolve();await action;assert.equal(find(f.menu,'再開').disabled,false);await pause.onclick();assert.equal(f.calls.filter(call=>call.name==='browser_pause_download').length,1);
});
test('command failures show local Japanese status, refresh real state once, and never replay or leak raw details',async t=>{
 const f=await fixture(t);const expected={download_not_active:'状態が変わりました',download_not_resumable:'再開できません',download_unavailable:'現在操作できません',download_operation_failed:'操作結果を確認できません'};
 for(const [error,message] of Object.entries(expected)){
  f.rows=[row()];await f.panels.load();f.calls.length=0;f.command=async()=>{f.rows=[row({status:'paused',canResume:true,interruptReason:28})];throw Error(error);};await find(f.menu,'一時停止').onclick();assert.match(f.menu.querySelector('[role="status"]').textContent,new RegExp(message));assert.match(f.menu.textContent,/一時停止中/);assert.equal(f.calls.filter(call=>call.name==='browser_pause_download').length,1);assert.equal(f.calls.filter(call=>call.name==='browser_downloads').length,1);
 }
 f.rows=[row()];await f.panels.load();f.command=async()=>{throw Error('https://private.example/file?token=SECRET C:/private/file');};await find(f.menu,'一時停止').onclick();assert.doesNotMatch(f.menu.textContent,/private|SECRET|https:/);assert.match(f.menu.textContent,/操作結果を確認できません/);
 for(const error of [null,undefined,'__proto__','constructor']){f.command=()=>Promise.reject(error);await find(f.menu,'一時停止').onclick();assert.match(f.menu.querySelector('[role="status"]').textContent,/操作結果を確認できません/);assert.doesNotMatch(f.menu.textContent,/function|\[object/);}
});
test('failed download refresh keeps known rows disabled until an explicit state update succeeds',async t=>{
 const f=await fixture(t);f.command=async()=>{f.readError=Error('private raw failure');throw Error('download_operation_failed');};await find(f.menu,'一時停止').onclick();assert.match(f.menu.textContent,/状態を再取得できません/);assert.equal(find(f.menu,'一時停止').disabled,true);assert.equal(find(f.menu,'キャンセル').disabled,true);assert.ok(find(f.menu,'再取得'));
 f.readError=null;f.rows=[row({status:'paused',canResume:true,interruptReason:28})];await find(f.menu,'状態を更新').onclick();assert.equal(find(f.menu,'再開').disabled,false);assert.equal(f.calls.filter(call=>call.name==='browser_pause_download').length,1);
});
test('choosing retains both fixed destinations, cancel permits all live states and terminal states only reveal complete',async t=>{
 const f=await fixture(t,[row({status:'choosing'})]);assert.ok(find(f.menu,'ダウンロードフォルダーに保存'));assert.ok(find(f.menu,'場所を選ぶ'));
 await find(f.menu,'場所を選ぶ').onclick();assert.deepEqual(f.calls.find(call=>call.name==='browser_save_download').args,{id:1,location:'choose'});f.rows=[row({status:'choosing'})];await f.panels.load();await find(f.menu,'ダウンロードフォルダーに保存').onclick();assert.deepEqual(f.calls.filter(call=>call.name==='browser_save_download').at(-1).args,{id:1,location:'downloads'});
 for(const state of ['choosing','active','paused','interrupted']){f.rows=[row({status:state})];await f.panels.load();await find(f.menu,'キャンセル').onclick();assert.deepEqual(f.calls.filter(call=>call.name==='browser_cancel_download').at(-1).args,{id:1});}
 for(const state of ['failed','cancelled','unknown']){f.rows=[row({status:state})];await f.panels.load();assert.equal(find(f.menu,'キャンセル'),undefined);assert.equal(find(f.menu,'再開'),undefined);assert.equal(find(f.menu,'フォルダーで確認'),undefined);}
 f.rows=[row({status:'complete'})];await f.panels.load();await find(f.menu,'フォルダーで確認').onclick();assert.deepEqual(f.calls.filter(call=>call.name==='browser_reveal_download').at(-1).args,{id:1});
});
test('pending chosen destination blocks another choice and cancel for that row while another download remains usable',async t=>{
 const f=await fixture(t,[row({status:'choosing'}),row({id:2,name:'second.zip'})]),pending=deferred();f.command=async(name,args)=>args.id===1?pending.promise:undefined;
 const rows=()=>[...f.menu.querySelectorAll('.browser-download-row')],chosen=rows().find(item=>item.textContent.includes('archive.zip')),choose=find(chosen,'場所を選ぶ'),cancel=find(chosen,'キャンセル');const selecting=choose.onclick();await tick();await choose.onclick();await cancel.onclick();await f.panels.load();const active=rows().find(item=>item.textContent.includes('second.zip'));assert.equal(find(active,'一時停止').disabled,false);await find(active,'一時停止').onclick();assert.equal(f.calls.filter(call=>call.name==='browser_save_download').length,1);assert.equal(f.calls.filter(call=>call.name==='browser_cancel_download').length,0);assert.deepEqual(f.calls.find(call=>call.name==='browser_pause_download').args,{id:2});assert.equal(find(rows().find(item=>item.textContent.includes('archive.zip')),'場所を選ぶ').disabled,true);pending.resolve();await selecting;assert.equal(find(rows().find(item=>item.textContent.includes('archive.zip')),'場所を選ぶ').disabled,false);
});
test('malformed DTOs stay bounded, unsafe IDs disable controls, names/paths/URLs are hidden and unsafe counters are unknown',async t=>{
 const f=await fixture(t,[]);
 for(const value of [null,{},'bad',Array.from({length:101},()=>row())]){f.rows=value;await f.panels.load();assert.equal(f.menu.querySelectorAll('.browser-download-row').length,0);assert.match(f.menu.textContent,/状態を確認できません/);}
 for(const id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1',undefined]){f.rows=[row({id})];await f.panels.load();assert.equal(find(f.menu,'一時停止').disabled,true);await find(f.menu,'一時停止').onclick();}
 for(const name of ['C:/private/file','https://private.example/file','x'.repeat(241),'bad\u0085','\ud800']){f.rows=[row({name,status:'active',received:Infinity,total:Number.MAX_SAFE_INTEGER+1,path:'SECRET'})];await f.panels.load();assert.match(f.menu.textContent,/ダウンロード · ダウンロード中 · 不明/);assert.doesNotMatch(f.menu.textContent,/private|SECRET|Infinity|NaN/);assert.equal(f.menu.querySelector('progress').hasAttribute('value'),false);}
 f.rows=[row(),row({name:'duplicate.zip'})];await f.panels.load();assert.equal([...f.menu.querySelectorAll('.browser-download-row button')].every(button=>button.disabled),true);
 f.rows=Array.from({length:100},(_,i)=>row({id:i+1,status:'complete'}));await f.panels.load();assert.equal(f.menu.querySelectorAll('.browser-download-row').length,100);
});
test('out-of-order download reads cannot replace a newer snapshot and refresh can enable a reported resumable state',async t=>{
 const f=await fixture(t,[row({status:'paused',canResume:false,interruptReason:28})]),pending=deferred();f.reads=()=>pending.promise;const old=f.panels.load();await tick();f.reads=null;f.rows=[row({status:'paused',canResume:true,interruptReason:28})];await find(f.menu,'状態を更新').onclick();pending.resolve([row({status:'complete'})]);await old;assert.ok(find(f.menu,'再開'));assert.equal(find(f.menu,'フォルダーで確認'),undefined);
});
test('permission replies, session restoration and menu choosing behavior remain available',async t=>{
 const f=await fixture(t,[]);f.requests=[{id:8,status:'pending',origin:'https://public.example',kind:2,tab:1,top_origin:'https://public.example'}];f.rows=[row({status:'choosing'})];f.session=3;f.panels.updateTabs([{id:1,active:true,url:'https://public.example/page',title:'要求元'}]);await f.panels.load();const pending=f.document.querySelector('#browser-permissions');assert.equal(pending.hidden,false);assert.match(pending.textContent,/カメラ/);await find(pending,'拒否').onclick();assert.deepEqual(f.calls.find(call=>call.name==='browser_permission_reply').args,{id:8,allow:false});await find(pending,'許可').onclick();assert.deepEqual(f.calls.filter(call=>call.name==='browser_permission_reply').at(-1).args,{id:8,allow:true});
 f.panels.updateTabs([{url:'',pinned:false}]);const notice=f.document.querySelector('#browser-session-notice');assert.equal(notice.hidden,false);await find(notice,'前回のタブを復元').onclick();assert.equal(f.refreshed,1);assert.ok(f.calls.some(call=>call.name==='browser_restore_session'));const host=f.document.createElement('div');f.panels.addTools(host);find(host,'サイト権限').click();assert.match(f.menu.textContent,/未回答の要求は60秒/);find(host,'ダウンロード').click();assert.ok(find(f.menu,'場所を選ぶ'));
});

test('native early queued ACK keeps destination controls locked until the chooser DTO leaves pending',async t=>{
 const f=await fixture(t,[row({status:'choosing'})]);f.command=async(name,args)=>{assert.equal(name,'browser_save_download');f.rows=[row({status:'choosing',choosingDestination:true})];return{id:args.id,queued:true};};
 const old=find(f.menu,'場所を選ぶ');await old.onclick();assert.equal(find(f.menu,'場所を選ぶ').disabled,true);assert.match(f.menu.textContent,/保存先の選択を完了/);await old.onclick();assert.equal(f.calls.filter(c=>c.name==='browser_save_download').length,1);
 f.rows=[row({status:'cancelled'})];await f.panels.load();await old.onclick();assert.equal(f.calls.filter(c=>c.name==='browser_save_download').length,1);assert.equal(find(f.menu,'場所を選ぶ'),undefined);
});
test('permission allowance follows the requesting tab and embedding origin, including detached callbacks',async t=>{
 const f=await fixture(t,[]),request={id:9,tab:1,origin:'https://embed.example',top_origin:'https://one.example',kind:2,status:'pending'};
 f.requests=[request];f.panels.updateTabs([{id:1,active:true,url:'https://one.example/path',title:'元のタブ'},{id:2,active:false,url:'https://two.example',title:'別のタブ'}]);await f.panels.load();
 const pending=f.document.querySelector('#browser-permissions'),old=find(pending,'許可');assert.equal(old.disabled,false);assert.match(pending.textContent,/元のタブ.*https:\/\/one.example/u);
 f.panels.updateTabs([{id:1,active:false,url:'https://one.example/path',title:'元のタブ'},{id:2,active:true,url:'https://two.example',title:'別のタブ'}]);assert.equal(find(pending,'許可').disabled,true);await old.onclick();assert.equal(f.calls.filter(c=>c.name==='browser_permission_reply').length,0);
 f.panels.updateTabs([{id:1,active:true,url:'https://navigated.example/path',title:'遷移後'}]);await old.onclick();assert.equal(f.calls.filter(c=>c.name==='browser_permission_reply').length,0);
 await find(pending,'拒否').onclick();assert.deepEqual(f.calls.find(c=>c.name==='browser_permission_reply').args,{id:9,allow:false});
});
test('an older runtime without chooser state cannot advertise a safe save destination',async t=>{
 const f=await fixture(t,[row({status:'choosing',choosingDestination:undefined})]);assert.equal(find(f.menu,'場所を選ぶ').disabled,true);await find(f.menu,'場所を選ぶ').onclick();assert.equal(f.calls.filter(c=>c.name==='browser_save_download').length,0);
});

test('profile history is explicit even with empty session downloads, closes menus before IPC and accepts private exact ACK',async t=>{
 const f=await fixture(t,[],true);assert.equal(f.calls.some(c=>c.name==='browser_download_history'),false);assert.match(f.menu.textContent,/この起動中のダウンロードはありません/);assert.match(f.menu.textContent,/プライベートはそのプロフィールだけ/);f.tab.private=true;await f.panels.load();let before=0,settles=0;f.before=()=>{before++;return true;};f.settle=current=>{settles++;assert.equal(f.menu.hidden,true);assert.equal(current(),true);return true;};f.command=async(name,args)=>{assert.equal(name,'browser_download_history');assert.deepEqual(args,{expectedTabId:1});assert.equal(f.menu.hidden,true);return{tabId:1,open:true,private:true};};await find(f.menu,'プロフィールのダウンロード履歴').onclick();assert.equal(before,1);assert.equal(settles,1);assert.equal(f.errors.length,0);assert.equal(f.calls.filter(c=>c.name==='browser_download_history').length,1);
});
test('profile history pending and captured detached callbacks cannot invoke twice',async t=>{
 const f=await fixture(t,[],true),pending=deferred();f.command=()=>pending.promise;const old=find(f.menu,'プロフィールのダウンロード履歴'),opening=old.onclick();await tick();await old.onclick();f.document.querySelector('#browser-downloads').click();assert.equal(find(f.menu,'プロフィールのダウンロード履歴').disabled,true);await find(f.menu,'プロフィールのダウンロード履歴').onclick();assert.equal(f.calls.filter(c=>c.name==='browser_download_history').length,1);pending.resolve({tabId:1,open:true,private:false});await opening;assert.equal(find(f.menu,'プロフィールのダウンロード履歴').disabled,false);
});
test('profile history close and layout awaits reject changed tab, view or view epoch before open',async t=>{
 const f=await fixture(t,[],true);
 for(const change of [()=>{f.tab={...f.tab,id:2};},()=>{f.view='home';},()=>{f.tab={...f.tab,epoch:1};}]){f.tab={id:1,private:false,url:'https://example.test',epoch:0};f.view='browser';f.before=()=>true;f.document.querySelector('#browser-downloads').click();const pending=deferred();f.before=()=>pending.promise;const opening=find(f.menu,'プロフィールのダウンロード履歴').onclick();change();pending.resolve(true);await opening;}
 f.tab={id:1,private:false,url:'https://example.test',epoch:0};f.view='browser';f.before=()=>true;f.document.querySelector('#browser-downloads').click();const pending=deferred();f.settle=()=>pending.promise;const opening=find(f.menu,'プロフィールのダウンロード履歴').onclick();await tick();f.tab={...f.tab,private:true};pending.resolve(true);await opening;assert.equal(f.calls.filter(c=>c.name==='browser_download_history').length,0);assert.equal(f.errors.length,0);
});
test('profile history late ACK or rejection never changes another tab or view UI',async t=>{
 const f=await fixture(t,[],true);
 for(const reject of [false,true]){f.tab={id:1,private:false,url:'https://example.test',epoch:0};f.view='browser';f.document.querySelector('#browser-downloads').click();const pending=deferred();f.command=()=>pending.promise;const opening=find(f.menu,'プロフィールのダウンロード履歴').onclick();await tick();f.tab={id:2,private:false,url:'https://two.test',epoch:1};f.view='home';f.menu.replaceChildren(f.document.createTextNode('new view'));if(reject)pending.reject(Error('private provider details'));else pending.resolve({tabId:1,open:true,private:false});await opening;assert.equal(f.menu.textContent,'new view');assert.equal(f.errors.length,0);}
});
test('profile history invalid ACK is unknown, locks same source and never replays or exposes private details',async t=>{
 const f=await fixture(t,[],true);
 const malformed=[null,{tabId:2,open:true,private:false},{tabId:1,open:false,private:false},{tabId:1,open:true,private:true},{tabId:1,open:true,private:false,url:'https://private.test'},Object.assign({tabId:1,open:true,private:false},{[Symbol('extra')]:true})];
 for(const result of malformed){f.tab={...f.tab,epoch:f.tab.epoch+1};f.document.querySelector('#browser-downloads').click();f.command=async()=>result;const old=find(f.menu,'プロフィールのダウンロード履歴');await old.onclick();f.document.querySelector('#browser-downloads').click();assert.equal(find(f.menu,'プロフィールのダウンロード履歴').disabled,true);const count=f.calls.length;await old.onclick();assert.equal(f.calls.length,count);assert.match(f.menu.textContent,/開けたか確認できません/);assert.doesNotMatch(f.menu.textContent,/https:|private\.test/);assert.equal(f.errors.at(-1).message,'download_history_unknown');}
});
test('profile history unsupported is friendly and explicit retry is permitted, unknown transport never auto replays',async t=>{
 const f=await fixture(t,[],true);f.command=async()=>{throw Error('download_history_unsupported');};await find(f.menu,'プロフィールのダウンロード履歴').onclick();f.document.querySelector('#browser-downloads').click();assert.match(f.menu.textContent,/この環境では/);assert.equal(find(f.menu,'プロフィールのダウンロード履歴').disabled,false);f.command=async()=>{throw Error('https://private.test/?token=private-detail');};await find(f.menu,'プロフィールのダウンロード履歴').onclick();await f.panels.load();f.document.querySelector('#browser-downloads').click();assert.equal(find(f.menu,'プロフィールのダウンロード履歴').disabled,true);assert.doesNotMatch(f.menu.textContent,/private-detail|token=|https:/);assert.equal(f.calls.filter(c=>c.name==='browser_download_history').length,2);
});
test('profile history optional legacy callbacks use reported active tab, reject unsafe IDs and keep current controls',async t=>{
 const f=await fixture(t,[row()]);assert.equal(find(f.menu,'プロフィールのダウンロード履歴').disabled,true);for(const id of [0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1]){f.panels.updateTabs([{id,active:true,private:false,url:''}]);await find(f.menu,'プロフィールのダウンロード履歴').onclick();}assert.equal(f.calls.some(c=>c.name==='browser_download_history'),false);f.panels.updateTabs([{id:9,active:true,private:false,url:''}]);f.command=async(name,args)=>{if(name==='browser_download_history')return{tabId:args.expectedTabId,open:true,private:false};};assert.equal(find(f.menu,'一時停止').disabled,false);assert.equal(find(f.menu,'キャンセル').disabled,false);await find(f.menu,'プロフィールのダウンロード履歴').onclick();assert.deepEqual(f.calls.find(c=>c.name==='browser_download_history').args,{expectedTabId:9});
});
test('profile history detached source and false close permission cannot open',async t=>{
 const f=await fixture(t,[],true),old=find(f.menu,'プロフィールのダウンロード履歴');f.tab={...f.tab,id:2};await old.onclick();f.document.querySelector('#browser-downloads').click();f.before=()=>false;await find(f.menu,'プロフィールのダウンロード履歴').onclick();assert.equal(f.calls.some(c=>c.name==='browser_download_history'),false);assert.equal(f.menu.hidden,false);
});

test('profile history new incoming choosing restores automatic destination prompt while empty refresh stays closed',async t=>{
 const f=await fixture(t,[],true),pending=deferred();f.command=()=>pending.promise;const opening=find(f.menu,'プロフィールのダウンロード履歴').onclick();await tick();assert.equal(f.menu.hidden,true);await f.panels.load();assert.equal(f.menu.hidden,true);pending.resolve({tabId:1,open:true,private:false});await opening;await f.panels.load();assert.equal(f.menu.hidden,true);f.rows=[row({status:'choosing'})];await f.panels.load();assert.equal(f.menu.hidden,false);assert.ok(find(f.menu,'場所を選ぶ'));assert.ok(find(f.menu,'キャンセル'));assert.equal(f.calls.filter(c=>c.name==='browser_download_history').length,1);find(f.menu,'閉じる').click();f.document.querySelector('#browser-downloads').click();assert.equal(f.menu.hidden,false);
});
test('profile history managed busy rejection retains Hub controls and never hides the native safety rule',async t=>{
 const f=await fixture(t,[row()],true);f.command=async()=>{throw Error('download_history_busy');};await find(f.menu,'プロフィールのダウンロード履歴').onclick();f.document.querySelector('#browser-downloads').click();assert.match(f.menu.textContent,/進行中・一時停止中のダウンロードはHubの一覧で操作/);assert.equal(find(f.menu,'プロフィールのダウンロード履歴').disabled,false);assert.ok(find(f.menu,'一時停止'));assert.ok(find(f.menu,'キャンセル'));assert.equal(f.errors.at(-1).message,'download_history_busy');assert.equal(f.calls.filter(c=>c.name==='browser_download_history').length,1);
});
