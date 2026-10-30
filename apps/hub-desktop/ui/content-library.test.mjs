import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {attachContentSave,renderContentLibrary} from './content-library.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const find=(host,text)=>[...host.querySelectorAll('button')].find(node=>node.textContent===text);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(t){const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost'});t.after(()=>dom.window.close());const f={dom,document:dom.window.document,host:dom.window.document.querySelector('#host'),current:true,calls:[],changes:[],opened:[],handler:async()=>({saved:false})};f.invoke=async(command,args)=>{f.calls.push({command,args});return f.handler(command,args);};f.isCurrent=()=>f.current;return f;}
const savedControl=(f,kind='article',options={})=>attachContentSave({document:f.document,host:f.host,kind,id:`${kind}-1`,invoke:f.invoke,isCurrent:f.isCurrent,onChanged:change=>f.changes.push(change),...options});
const library=(f,kind='article',options={})=>renderContentLibrary({document:f.document,host:f.host,kind,invoke:f.invoke,isCurrent:f.isCurrent,onOpen:item=>f.opened.push(item),...options});

for(const kind of ['article','video'])test(`${kind}: reads status, confirms save/un-save and blocks duplicate submits`,async t=>{
  const f=fixture(t),initial=deferred();f.handler=()=>initial.promise;const controls=savedControl(f,kind);assert.equal(f.host.querySelector('button').disabled,true);assert.deepEqual(f.calls[0],{command:'hub_detail',args:{name:`${kind}_save`,ids:[`${kind}-1`]}});initial.resolve({saved:false});await controls.ready;
  const pending=deferred();f.handler=()=>pending.promise;const save=f.host.querySelector('button'),operation=save.onclick();await save.onclick();assert.equal(f.calls.length,2);assert.equal(save.disabled,true);assert.equal(save.getAttribute('aria-pressed'),'false');pending.resolve({saved:true});await operation;assert.equal(save.getAttribute('aria-pressed'),'true');assert.deepEqual(f.changes,[{kind,id:`${kind}-1`,saved:true}]);
  f.handler=async()=>({saved:false});await save.onclick();assert.deepEqual(f.calls.at(-1),{command:'hub_client_action',args:{action:`unsave_${kind}`,target:`${kind}-1`}});assert.equal(save.getAttribute('aria-pressed'),'false');
});

test('read failure and malformed states remain unknown until retry; failed or mismatched mutations preserve confirmed state',async t=>{
  const f=fixture(t);f.handler=async()=>{throw Error('desktop_authentication_failed');};const control=savedControl(f);await control.ready;const save=f.host.querySelector('button');assert.equal(save.disabled,true);assert.match(f.host.textContent,/再取得/);assert.equal(f.changes.length,0);
  f.handler=async()=>({saved:'yes'});await find(f.host,'保存状態を再取得').onclick();assert.equal(save.disabled,true);
  f.handler=async()=>({saved:true});await find(f.host,'保存状態を再取得').onclick();assert.equal(save.getAttribute('aria-pressed'),'true');
  f.handler=async()=>{throw Error('unavailable');};await save.onclick();assert.equal(save.getAttribute('aria-pressed'),'true');assert.equal(save.disabled,false);assert.equal(f.changes.length,0);
  f.handler=async()=>({saved:true});await save.onclick();assert.equal(save.getAttribute('aria-pressed'),'true');assert.equal(f.changes.length,0);assert.match(f.host.textContent,/更新できません/);
});

test('stale initial read or save response cannot update detached, hidden or superseded details',async t=>{
  for(const stale of [f=>{f.current=false;},f=>{f.host.hidden=true;},f=>f.host.remove()]){
    const f=fixture(t),pending=deferred();f.handler=()=>pending.promise;const control=savedControl(f);stale(f);pending.resolve({saved:true});await control.ready;assert.equal(f.host.querySelector('button').getAttribute('aria-pressed'),'false');assert.equal(f.changes.length,0);
  }
  const f=fixture(t),pending=deferred();const control=savedControl(f,'article',{initialSaved:false});await control.ready;f.handler=()=>pending.promise;const operation=f.host.querySelector('button').onclick();control.destroy();pending.resolve({saved:true});await operation;assert.equal(f.changes.length,0);assert.equal(f.host.children.length,0);
});

test('saved articles reopen with exact records, page through cursor and preserve prior pages on failure',async t=>{
  const f=fixture(t),first={id:'article-1',title:'<img src=x>',summary:'Summary'};f.handler=async()=>({articles:[first],nextCursor:'cursor-1'});const view=library(f);await view.ready;assert.equal(f.host.querySelector('img'),null);await find(f.host,first.title).onclick();assert.deepEqual(f.opened,[first]);
  f.handler=async()=>{throw Error('unavailable');};await find(f.host,'続きを表示').onclick();assert.ok(find(f.host,first.title));assert.match(f.host.textContent,/保持しています/);
  f.handler=async()=>({articles:[{id:'article-2',title:'Second'},first],nextCursor:null});await find(f.host,'再試行').onclick();assert.deepEqual(f.calls.at(-1),{command:'hub_detail',args:{name:'saved_articles_page',ids:['cursor-1']}});assert.equal(f.host.querySelectorAll('[data-content-id]').length,2);assert.equal(find(f.host,'続きを表示').hidden,true);
});

test('watch-later preserves supplied video metadata and opens the saved video',async t=>{
  const f=fixture(t),entry={id:'video-1',title:'Movie',sourceUrl:'https://provider.example/video',availabilityStatus:'unavailable'};f.handler=async()=>({savedVideos:[entry],savedVideoIds:['video-1'],nextCursor:null});const view=library(f,'video');await view.ready;assert.deepEqual(f.calls[0],{command:'hub_client',args:{name:'video_library'}});assert.match(f.host.textContent,/提供元で視聴できません/);await find(f.host,'Movie').onclick();assert.deepEqual(f.opened,[entry]);
  f.handler=async()=>{throw Error('unavailable');};await find(f.host,'更新').onclick();assert.ok(find(f.host,'Movie'));assert.equal(find(f.host,'続きを表示').hidden,true);
});

test('malformed library or repeated cursor does not destroy previously verified rows; stale rows cannot reopen',async t=>{
  const f=fixture(t);f.handler=async()=>({articles:[{id:'article-1',title:'First'}],nextCursor:'cursor-1'});const view=library(f);await view.ready;
  for(const data of [{articles:[],nextCursor:'cursor-1'},{articles:[{id:'article-2',title:'Second'}],nextCursor:'cursor-1'},{articles:[{id:'../bad',title:'Bad'}],nextCursor:null},{articles:[{id:'article-2',title:3}],nextCursor:null}]){f.handler=async()=>data;await (find(f.host,'再試行').hidden?find(f.host,'続きを表示'):find(f.host,'再試行')).onclick();assert.ok(find(f.host,'First'));assert.equal(find(f.host,'Second'),undefined);}
  const stale=find(f.host,'First');f.handler=async()=>({articles:[],nextCursor:null});await view.reload();await stale.onclick();assert.equal(f.opened.length,0);assert.match(f.host.textContent,/まだありません/);
});

test('superseded list reads cannot render private results and invalid kinds/IDs never invoke native',async t=>{
  const f=fixture(t),pending=deferred();f.handler=()=>pending.promise;const view=library(f);f.current=false;pending.resolve({articles:[{id:'article-private',title:'Private'}],nextCursor:null});await view.ready;assert.equal(find(f.host,'Private'),undefined);f.current=true;f.handler=async()=>({articles:[],nextCursor:null});await view.reload();
  const count=f.calls.length;for(const id of ['', '../other', 'x'.repeat(129)])assert.throws(()=>savedControl(f,'article',{id}),/invalid_content_id/);assert.throws(()=>savedControl(f,'music'),/invalid_content_kind/);assert.equal(f.calls.length,count);
});

test('watch-later keyset pages are explicit, retryable and preserve records on invalid cursor responses',async t=>{
  const f=fixture(t),cursor='2026-10-05T00:00:00.000Z|video-1';f.handler=async()=>({savedVideos:[{id:'video-1',title:'First'}],nextCursor:cursor});const view=library(f,'video');await view.ready;assert.equal(find(f.host,'続きを表示').hidden,false);
  f.handler=async()=>{throw Error('unavailable');};await find(f.host,'続きを表示').onclick();assert.ok(find(f.host,'First'));
  f.handler=async()=>({savedVideos:[{id:'video-2',title:'Second'}],nextCursor:'2026-02-30T00:00:00.000Z|video-2'});await find(f.host,'再試行').onclick();assert.equal(find(f.host,'Second'),undefined);
  f.handler=async()=>({savedVideos:[{id:'video-2',title:'Second'}],nextCursor:null});await find(f.host,'再試行').onclick();assert.deepEqual(f.calls.at(-1),{command:'hub_detail',args:{name:'video_library_page',ids:[cursor]}});assert.ok(find(f.host,'Second'));assert.equal(find(f.host,'続きを表示').hidden,true);
});

test('article IDs and cursors accept 128 characters and never send 129-character identifiers to IPC',async t=>{
  const f=fixture(t),id='a'.repeat(128),invalid='a'.repeat(129);const control=savedControl(f,'article',{id});await control.ready;assert.deepEqual(f.calls[0],{command:'hub_detail',args:{name:'article_save',ids:[id]}});
  const before=f.calls.length;assert.throws(()=>savedControl(f,'article',{id:invalid}),/invalid_content_id/);assert.equal(f.calls.length,before);control.destroy();
  f.handler=async()=>({articles:[{id,title:'Boundary'}],nextCursor:id});const view=library(f);await view.ready;await find(f.host,'Boundary').onclick();assert.equal(f.opened[0].id,id);
  f.handler=async()=>({articles:[{id:'article-2',title:'Second'}],nextCursor:invalid});await find(f.host,'続きを表示').onclick();assert.deepEqual(f.calls.at(-1),{command:'hub_detail',args:{name:'saved_articles_page',ids:[id]}});assert.ok(find(f.host,'Boundary'));assert.equal(find(f.host,'Second'),undefined);
  assert.equal(f.calls.some(call=>call.args.ids?.includes(invalid)||call.args.target===invalid),false);
});

test('embedded article and video libraries omit only their outer frame and heading while default libraries retain them',async t=>{
  for(const kind of ['article','video'])for(const embedded of [undefined,false,true]){
    const f=fixture(t),item={id:`${kind}-1`,title:'Fixture'};f.handler=async()=>kind==='article'?{articles:[item],nextCursor:null}:{savedVideos:[item],nextCursor:null};
    const view=library(f,kind,{embedded});await view.ready;const root=f.host.querySelector('section');assert.equal(root.classList.contains('card'),embedded!==true);assert.equal(root.querySelectorAll(':scope > h3').length,embedded===true?0:1);
    assert.equal(root.getAttribute('aria-label'),kind==='article'?'保存した記事':'あとで見る');assert.equal(root.querySelector('[data-content-id]').classList.contains('card'),true);await find(root,'Fixture').onclick();assert.deepEqual(f.opened,[item]);
    f.handler=async()=>{throw Error('unavailable');};await find(root,'更新').onclick();assert.ok(find(root,'Fixture'));assert.equal(find(root,'再試行').hidden,false);
  }
});
