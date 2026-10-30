import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {attachMusicFavorite,renderMusicLibrary} from './music-library.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const find=(host,label)=>[...host.querySelectorAll('button')].find(node=>node.textContent===label);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const trackId='music:0f8fad5b-d9cb-469f-a165-70867728950c';
const work=(id,title=id)=>({id,title,artist:'Artist',album:'Album',services:[],description:'Description',genre:'Genre',year:2026});
const page=(ids,offset=0,unavailableIds=[])=>{const selected=ids.slice(offset,offset+50),missing=selected.filter(id=>unavailableIds.includes(id));return {favoriteIds:ids,works:selected.filter(id=>!missing.includes(id)).map(id=>work(id)),unavailableIds:missing,nextOffset:offset+50<ids.length?offset+50:null,total:ids.length};};
function fixture(t){const dom=new JSDOM('<div id="host"></div>',{url:'http://localhost'});t.after(()=>dom.window.close());const f={dom,document:dom.window.document,host:dom.window.document.querySelector('#host'),calls:[],changed:[],opened:[],played:[],current:true,handler:async()=>({favoriteIds:[]})};f.invoke=async(command,args)=>{f.calls.push({command,args});return f.handler(command,args);};f.isCurrent=()=>f.current;return f;}
const favorite=(f,options={})=>attachMusicFavorite({document:f.document,host:f.host,workId:'work-1',invoke:f.invoke,isCurrent:f.isCurrent,onChanged:change=>f.changed.push(change),...options});
const library=(f,options={})=>renderMusicLibrary({document:f.document,host:f.host,invoke:f.invoke,isCurrent:f.isCurrent,onOpen:work=>f.opened.push(work),onPlay:(work,queue)=>f.played.push({work,queue}),...options});

test('favorites use closed commands, confirmed state and one request while a mutation is pending',async t=>{
  const f=fixture(t),initial=deferred();f.handler=()=>initial.promise;const control=favorite(f);assert.equal(f.host.querySelector('button').disabled,true);initial.resolve({favoriteIds:[]});await control.ready;assert.deepEqual(f.calls[0],{command:'hub_client',args:{name:'music_favorites'}});
  const pending=deferred();f.handler=()=>pending.promise;const toggle=f.host.querySelector('button'),operation=toggle.onclick();await toggle.onclick();assert.equal(f.calls.length,2);assert.equal(toggle.getAttribute('aria-pressed'),'false');pending.resolve({favoriteIds:['work-1']});await operation;assert.equal(toggle.getAttribute('aria-pressed'),'true');assert.deepEqual(f.calls[1],{command:'hub_client_action',args:{action:'favorite_music',target:'work-1'}});
  f.handler=async()=>({favoriteIds:[]});await toggle.onclick();assert.equal(toggle.getAttribute('aria-pressed'),'false');assert.equal(f.changed.length,2);assert.equal(f.calls.at(-1).args.action,'unfavorite_music');
});

test('unknown reads retry, failed and mismatched mutations preserve the last confirmed favorites',async t=>{
  const f=fixture(t);f.handler=async()=>{throw Error('auth_failed');};const control=favorite(f);await control.ready;const toggle=f.host.querySelector('button');assert.equal(toggle.disabled,true);assert.match(f.host.textContent,/再取得/);
  f.handler=async()=>({favoriteIds:['work-1']});await find(f.host,'保存状態を再取得').onclick();assert.equal(toggle.getAttribute('aria-pressed'),'true');
  for(const result of [()=>Promise.reject(Error('unavailable')),async()=>({favoriteIds:['work-1']}),async()=>({favoriteIds:['work-1','work-1']})]){f.handler=result;await toggle.onclick();assert.equal(toggle.getAttribute('aria-pressed'),'true');assert.equal(f.changed.length,0);assert.match(f.host.textContent,/更新できません/);}
});

test('legacy favorites over 200 stay readable and removable while additions at the limit make no IPC call',async t=>{
  const f=fixture(t),ids=Array.from({length:250},(_,i)=>`work-${i}`);const control=favorite(f,{workId:'new-work',initialFavoriteIds:ids});await control.ready;await f.host.querySelector('button').onclick();assert.equal(f.calls.length,0);assert.match(f.host.textContent,/200件/);control.destroy();
  const remove=favorite(f,{workId:'work-1',initialFavoriteIds:ids});await remove.ready;f.handler=async()=>({favoriteIds:ids.filter(id=>id!=='work-1')});await f.host.querySelector('button').onclick();assert.equal(f.calls[0].args.action,'unfavorite_music');assert.equal(f.changed[0].favoriteIds.length,249);
});

test('IDs accept 128-character metadata keys and strict Music public UUID keys; invalid IDs never invoke IPC',async t=>{
  const f=fixture(t);for(const id of ['x'.repeat(128),trackId]){const control=favorite(f,{workId:id,initialFavoriteIds:[]});await control.ready;control.destroy();}
  for(const id of ['',null,42,'../x','a/b','x'.repeat(129),'music:bad','music:0f8fad5b-d9cb-969f-a165-70867728950c','user:secret'])assert.throws(()=>favorite(f,{workId:id,initialFavoriteIds:[]}),/invalid_music_work_id/);
  assert.equal(f.calls.length,0);
});

test('disposed, hidden or superseded favorites ignore late private reads and mutation callbacks',async t=>{
  for(const stale of [f=>{f.current=false;},f=>{f.host.hidden=true;},f=>f.host.remove()]){const f=fixture(t),pending=deferred();f.handler=()=>pending.promise;const control=favorite(f);stale(f);pending.resolve({favoriteIds:['work-1']});await control.ready;assert.equal(f.host.querySelector('button').getAttribute('aria-pressed'),'false');assert.equal(f.changed.length,0);}
  const f=fixture(t),pending=deferred();const control=favorite(f,{initialFavoriteIds:[]});f.handler=()=>pending.promise;const operation=f.host.querySelector('button').onclick();control.destroy();pending.resolve({favoriteIds:['work-1']});await operation;assert.equal(f.changed.length,0);assert.equal(f.host.children.length,0);
});

test('library keeps text inert and separates public-track playback from external-work detail',async t=>{
  const f=fixture(t),ids=[trackId,'external-work'];const result=page(ids);result.works[0].title='<img src=x>';f.handler=async()=>result;const view=library(f);await view.ready;assert.equal(f.host.querySelector('img'),null);assert.deepEqual(f.calls[0],{command:'hub_client',args:{name:'music_library'}});
  await find(f.host,'再生').onclick();assert.equal(f.played[0].work.id,trackId);assert.deepEqual(f.played[0].queue.map(item=>item.id),[trackId]);await find(f.host,'詳細・提供元を開く').onclick();assert.equal(f.opened[0].id,'external-work');
});

test('library reads all legacy favorites in bounded pages, including missing works, with page retry',async t=>{
  const f=fixture(t),ids=Array.from({length:251},(_,i)=>`work-${i}`);f.handler=async(_command,args)=>page(ids,args.name==='music_library_page'?Number(args.ids[0]):0,['work-1','work-250']);const view=library(f);await view.ready;assert.equal(f.host.querySelectorAll('[data-music-work-id]').length,50);assert.match(f.host.textContent,/公開情報を取得できない作品 1 件/);
  const success=f.handler;f.handler=async()=>{throw Error('unavailable');};await find(f.host,'続きを表示').onclick();assert.equal(f.host.querySelectorAll('[data-music-work-id]').length,50);assert.match(f.host.textContent,/保持しています/);f.handler=success;await find(f.host,'再試行').onclick();assert.deepEqual(f.calls.at(-1),{command:'hub_detail',args:{name:'music_library_page',ids:['50']}});
  while(!find(f.host,'続きを表示').hidden)await find(f.host,'続きを表示').onclick();assert.equal(f.host.querySelectorAll('[data-music-work-id]').length,251);assert.match(f.host.textContent,/251 \/ 251/);assert.ok([...f.host.querySelectorAll('[data-music-work-id]')].some(node=>node.dataset.musicWorkId==='work-250'));
});

test('malformed pagination cannot replace verified works or skip IDs',async t=>{
  const f=fixture(t),ids=Array.from({length:51},(_,i)=>`work-${i}`);f.handler=async()=>page(ids);const view=library(f);await view.ready;
  for(const invalid of [{...page(ids,50),nextOffset:50},{...page(ids,50),total:52},{...page(ids,50),works:[]},{...page(ids,50),works:[work('intruder')]},{...page(ids,50),unavailableIds:['work-50']},{...page(ids,50),works:[{...work('work-50'),services:undefined}]}]){f.handler=async()=>invalid;await (find(f.host,'再試行').hidden?find(f.host,'続きを表示'):find(f.host,'再試行')).onclick();assert.equal(f.host.querySelectorAll('[data-music-work-id]').length,50);assert.ok([...f.host.querySelectorAll('[data-music-work-id]')].every(node=>node.dataset.musicWorkId!=='intruder'));}
});

test('favorite changes between pages preserve display then retry from the first page',async t=>{
  const f=fixture(t),ids=Array.from({length:51},(_,i)=>`work-${i}`);f.handler=async()=>page(ids);const view=library(f);await view.ready;const changed=[...ids,'new-work'];f.handler=async()=>page(changed,50);await find(f.host,'続きを表示').onclick();assert.match(f.host.textContent,/先頭から取得/);assert.equal(f.host.querySelectorAll('[data-music-work-id]').length,50);
  f.handler=async()=>page(changed);await find(f.host,'再試行').onclick();assert.deepEqual(f.calls.at(-1),{command:'hub_client',args:{name:'music_library'}});assert.match(f.host.textContent,/50 \/ 52/);
});

test('library removal waits for confirmation, blocks duplicate commands, reloads after success and retains errors',async t=>{
  const f=fixture(t);f.handler=async()=>page(['work-1']);const view=library(f);await view.ready;const pending=deferred();f.handler=()=>pending.promise;const remove=find(f.host,'お気に入りを解除'),operation=remove.onclick();await remove.onclick();assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);assert.equal(f.host.querySelectorAll('[data-music-work-id]').length,1);pending.reject(Error('unavailable'));await operation;assert.equal(f.host.querySelectorAll('[data-music-work-id]').length,1);
  f.handler=async command=>command==='hub_client_action'?{favoriteIds:[]}:page([]);await find(f.host,'お気に入りを解除').onclick();assert.equal(f.host.querySelectorAll('[data-music-work-id]').length,0);assert.match(f.host.textContent,/まだありません/);
});

test('stale or disposed library responses cannot render or operate old rows',async t=>{
  const f=fixture(t),pending=deferred();f.handler=()=>pending.promise;const view=library(f);f.current=false;pending.resolve(page(['private-work']));await view.ready;assert.equal(f.host.querySelectorAll('[data-music-work-id]').length,0);
  f.current=true;f.handler=async()=>page(['work-1']);await view.reload();const old=find(f.host,'詳細・提供元を開く');f.handler=async()=>page([]);await view.reload();await old.onclick();assert.equal(f.opened.length,0);view.destroy();assert.equal(f.host.children.length,0);
});

test('embedded music library omits its frame and heading without losing playback, detail and failure recovery',async t=>{
  for(const embedded of [undefined,false,true]){
    const f=fixture(t);f.handler=async()=>page([trackId,'external-work']);const view=library(f,{embedded});await view.ready;const root=f.host.querySelector('section');
    assert.equal(root.classList.contains('card'),embedded!==true);assert.equal(root.querySelectorAll(':scope > h3').length,embedded===true?0:1);assert.equal(root.getAttribute('aria-label'),'音楽のお気に入り');assert.equal(root.querySelector('[data-music-work-id]').classList.contains('card'),true);
    await find(root,'再生').onclick();await find(root,'詳細・提供元を開く').onclick();assert.equal(f.played[0].work.id,trackId);assert.equal(f.opened[0].id,'external-work');
    f.handler=async()=>{throw Error('unavailable');};await find(root,'更新').onclick();assert.equal(root.querySelectorAll('[data-music-work-id]').length,2);assert.equal(find(root,'再試行').hidden,false);
  }
});

test('next-play library entry accepts public tracks only and ignores stale or disposed rows',async t=>{
  const f=fixture(t),queued=[];f.handler=async()=>page([trackId,'external-work']);const view=library(f,{onQueue:work=>queued.push(work.id)});await view.ready;
  const next=find(f.host,'次に再生');assert.equal([...f.host.querySelectorAll('button')].filter(button=>button.textContent==='次に再生').length,1);
  next.onclick();assert.deepEqual(queued,[trackId]);assert.equal(f.calls.length,1);
  f.current=false;next.onclick();assert.equal(queued.length,1);f.current=true;view.destroy();next.onclick();assert.equal(queued.length,1);
});
test('unconfirmed playback and rejected queue additions remain visible as failures',async t=>{
  const f=fixture(t);f.handler=async()=>page([trackId]);const view=library(f,{onPlay:()=>false,onQueue:()=>false});await view.ready;
  await find(f.host,'再生').onclick();assert.match(f.host.textContent,/作品を開けません/);find(f.host,'次に再生').onclick();assert.match(f.host.textContent,/再生待ちに追加できません/);assert.equal(f.calls.length,1);
});
