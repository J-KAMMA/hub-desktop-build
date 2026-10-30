import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {renderBrowserLibrary} from './browser-library.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const find = (root, label) => [...root.querySelectorAll('button')].find(node => node.textContent === label);
const rows = root => [...root.querySelectorAll('.browser-menu-row')];
const fixture = (t, items = [{url:'https://one.example/',title:'One',folder:''},{url:'https://two.example/',title:'Two',folder:'研究'},{url:'https://three.example/',title:'Three',folder:'*'}]) => {
  const dom = new JSDOM('<section id="menu"></section>', {url:'http://localhost'}), document = dom.window.document, host = document.querySelector('#menu');
  t.after(() => dom.window.close());
  const state = {dom, document, host, items, calls:[], errors:[], opened:[], refreshed:0, handler:async()=>{}, readError:null};
  const button = (label, action, className = '') => {const node=document.createElement('button');node.type='button';node.textContent=label;node.className=className;node.onclick=action;return node;};
  state.library = renderBrowserLibrary({document,window:dom.window,host,items,button,invoke:async(name,args)=>{state.calls.push({name,args});if(name==='browser_favorites'){if(state.readError)throw state.readError;return state.items;}return state.handler(name,args);},refresh:async()=>state.refreshed++,report:error=>state.errors.push(error),open:url=>state.opened.push(url)});
  state.choose = async (text, size) => {const input=host.querySelector('input[type=file]'),file=new dom.window.File([text],'favorites.json',{type:'application/json'});if(size!==undefined)Object.defineProperty(file,'size',{value:size});Object.defineProperty(input,'files',{configurable:true,value:[file]});await input.onchange();};
  return state;
};

test('flat folder and title/URL filters render text safely, including a literal star folder', async t => {
  const f=fixture(t);f.items[0].title='<img src=x onerror=bad()>';await f.library.reload();assert.equal(f.host.querySelector('img'),null);
  const folder=f.host.querySelector('select');folder.value=JSON.stringify('*');folder.onchange();assert.equal(rows(f.host).length,1);assert.match(rows(f.host)[0].textContent,/Three/);
  folder.value='';folder.onchange();const search=f.host.querySelector('input[type=search]');search.value='TWO.EXAMPLE';search.oninput();assert.equal(rows(f.host).length,1);await rows(f.host)[0].querySelector('.browser-menu-open').onclick();assert.deepEqual(f.opened,['https://two.example/']);
});

test('moves use global positions when filtered and boundaries cannot invoke a mutation', async t => {
  const f=fixture(t);assert.equal(find(rows(f.host)[0],'↑').disabled,true);assert.equal(find(rows(f.host).at(-1),'↓').disabled,true);await find(rows(f.host)[0],'↑').onclick();assert.equal(f.calls.length,0);
  const folder=f.host.querySelector('select');folder.value=JSON.stringify('研究');folder.onchange();await find(rows(f.host)[0],'↑').onclick();assert.deepEqual(f.calls[0],{name:'browser_move_favorite',args:{url:'https://two.example/',position:0}});assert.equal(f.refreshed,1);
});

test('edit cancels without a write, accepts Unicode bounds and preserves a rejected draft', async t => {
  const f=fixture(t);await find(rows(f.host)[0],'編集').onclick();await find(f.host,'キャンセル').onclick();assert.equal(f.calls.length,0);
  await find(rows(f.host)[0],'編集').onclick();let title=f.host.querySelector('[aria-label="お気に入りのタイトル"]'),folder=f.host.querySelector('[aria-label="フォルダー名"]');title.value='😀'.repeat(300);folder.value='本'.repeat(80);
  f.handler=async()=>{throw Error('write_failed');};await find(f.host,'保存').onclick();assert.equal(f.calls[0].args.title,'😀'.repeat(300));assert.equal(f.calls[0].args.folder,'本'.repeat(80));assert.equal(f.errors.length,1);assert.equal(f.host.querySelector('[aria-label="お気に入りのタイトル"]').value,'😀'.repeat(300));
  const prior=f.calls.length;title=f.host.querySelector('[aria-label="お気に入りのタイトル"]');title.value='😀'.repeat(301);await find(f.host,'保存').onclick();assert.equal(f.calls.length,prior);assert.match(f.host.textContent,/300文字/);
  title.value='OK';folder=f.host.querySelector('[aria-label="フォルダー名"]');folder.value='bad\u0085folder';await find(f.host,'保存').onclick();assert.equal(f.calls.length,prior);
});

test('versioned and legacy imports only preview until explicit merge; exact input reaches native', async t => {
  const f=fixture(t);const items=[{url:'https://one.example/',title:'Overwrite attempt',folder:'別'},{url:'https://new.example/',title:'New'}];
  for (const input of [JSON.stringify({version:1,items}),JSON.stringify(items)]) {
    f.calls=[];await f.choose(input);assert.equal(f.calls.length,0);assert.match(f.host.textContent,/2 件/);assert.match(f.host.textContent,/既存のお気に入りを保持/);
    f.handler=async(name,args)=>{assert.equal(name,'browser_import_favorites');assert.equal(args.input,input);return 1;};await find(f.host,'確認して統合').onclick();assert.equal(f.calls.filter(call=>call.name==='browser_import_favorites').length,1);assert.equal(find(f.host,'確認して統合'),undefined);assert.equal(f.items[0].title,'One');
  }
});

test('import rejects size, count, URL and text boundaries without invoking native', async t => {
  const f=fixture(t),entry={url:'https://safe.example/',title:'safe',folder:''};
  await f.choose('[]',1048577);assert.match(f.host.textContent,/1 MiB/);assert.equal(f.calls.length,0);
  const bad=[null,{version:2,items:[]},[null],Array.from({length:1001},()=>entry),[{...entry,url:'javascript:bad()'}],[{...entry,url:'https://user:password@example.com/'}],[{...entry,url:`https://example.com/${'x'.repeat(4096)}`}],[{...entry,title:'x'.repeat(301)}],[{...entry,folder:'x'.repeat(81)}],[{...entry,title:'bad\u0000'}],[{...entry,folder:3}]];
  for(const value of bad){await f.choose(JSON.stringify(value));assert.equal(find(f.host,'確認して統合'),undefined);}
  assert.equal(f.calls.length,0);await f.choose('[]',1048576);assert.ok(find(f.host,'確認して統合'));await find(f.host,'取り込みをキャンセル').onclick();assert.equal(find(f.host,'確認して統合'),undefined);
});

test('export uses a local Blob download and releases its URL without network calls', async t => {
  const f=fixture(t),payload=JSON.stringify({version:1,items:f.items}),blobs=[],revoked=[],downloads=[];
  f.dom.window.URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:local-test';};f.dom.window.URL.revokeObjectURL=url=>revoked.push(url);f.dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push({href:this.href,name:this.download});};f.handler=async name=>{assert.equal(name,'browser_export_favorites');return payload;};
  await find(f.host,'JSONを書き出す').onclick();assert.equal(blobs[0].type,'application/json');assert.equal(blobs[0].size,Buffer.byteLength(payload));assert.deepEqual(downloads,[{href:'blob:local-test',name:'hub-favorites.json'}]);assert.deepEqual(revoked,['blob:local-test']);assert.equal(f.calls.length,1);
});

test('pending writes block duplicate actions; refresh failure disables stale controls and retry recovers', async t => {
  const f=fixture(t);let release;f.handler=()=>new Promise(resolve=>{release=resolve;});const old=find(rows(f.host)[0],'削除'),pending=old.onclick();await old.onclick();assert.equal(f.calls.length,1);assert.equal(find(rows(f.host)[0],'削除').disabled,true);f.readError=Error('read_failed');release();await pending;assert.match(f.host.textContent,/最新の状態を確認できません/);await find(rows(f.host)[0],'削除').onclick();assert.equal(f.calls.filter(call=>call.name==='browser_remove_favorite').length,1);
  f.readError=null;await find(f.host,'再取得').onclick();assert.equal(find(rows(f.host)[0],'削除').disabled,false);
});

test('detached or replaced favorite rows cannot invoke stale handlers', async t => {
  const f=fixture(t),remove=find(rows(f.host)[0],'削除');const search=f.host.querySelector('input[type=search]');search.value='Two';search.oninput();await remove.onclick();assert.equal(f.calls.length,0);const live=find(rows(f.host)[0],'削除');f.host.hidden=true;await live.onclick();f.host.hidden=false;f.host.remove();await live.onclick();assert.equal(f.calls.length,0);f.document.body.append(f.host);f.host.replaceChildren();await live.onclick();assert.equal(f.calls.length,0);
});
