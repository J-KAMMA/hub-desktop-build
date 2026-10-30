import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const folder=mkdtempSync(join(tmpdir(),'hub-saved-search-test-'));
copyFileSync(fileURLToPath(new URL('./saved-searches.mjs',import.meta.url)),join(folder,'saved-searches.mjs'));
copyFileSync(new URL('./hub-search-filters.mjs',import.meta.url),join(folder,'hub-search-filters.mjs'));
const {createSavedSearches}=await import(pathToFileURL(join(folder,'saved-searches.mjs')).href);
test.after(()=>{if(resolve(folder).startsWith(resolve(tmpdir())+sep)&&folder.includes('hub-saved-search-test-'))rmSync(folder,{recursive:true,force:true});});
const prefix='hub.desktop.search.saved.v1:';
const value=(query='test',group='all',filters={},order='recommended')=>({query,group,filters,order});
const scope=(origin='https://hub.example',profile='guest',generation=1)=>({key:JSON.stringify([origin,profile]),generation});
const tick=()=>new Promise(done=>setImmediate(done));
const pending=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function setup(t,options={}){
  const dom=new JSDOM('<main></main>'),memory=new Map(),calls=[],applied=[];
  let currentScope=scope(),currentValue=value(),active=true;
  const storage={getItem(key){calls.push(['get',key]);return memory.get(key)??null;},setItem(key,data){calls.push(['set',key]);memory.set(key,data);},removeItem(key){calls.push(['remove',key]);memory.delete(key);}};
  const api=createSavedSearches({document:dom.window.document,storage,getScope:()=>currentScope,getValue:()=>currentValue,isCurrent:()=>active,
    apply:options.apply??((data,guard)=>{if(guard())applied.push(data);return true;})});
  dom.window.document.querySelector('main').append(api.element);api.element.open=true;
  t.after(()=>{api.destroy();dom.window.close();});
  const input=()=>api.element.querySelector('input[aria-label="検索条件の名前"]');
  const save=(name='saved')=>{input().value=name;api.element.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));};
  const rows=()=>[...api.element.querySelectorAll('div > details')];
  const button=(row,label)=>[...row.querySelectorAll('button')].find(node=>node.textContent===label);
  const stored=()=>JSON.parse(memory.get(prefix+currentScope.key)??'{"version":1,"items":[]}');
  return{api,dom,memory,calls,applied,storage,input,save,rows,button,stored,
    setValue(next){currentValue=next;},setScope(next){currentScope=next;},setActive(next){active=next;},key:()=>prefix+currentScope.key};
}
test('guest explicitly saves closed conditions, applies a fresh copy, renames and deletes',async t=>{
 const f=setup(t);assert.equal(await f.api.ready,true);assert.equal(f.memory.size,0);f.setValue(value(' ＨＵＢ ', 'articles',{language:'zh',region:' ΟΣ ',maxPrice:'001.20',currency:'usd'},'kind'));f.save('My search');
 const item=f.stored().items[0];assert.deepEqual(Object.keys(item).sort(),['id','name','value']);assert.equal(item.value.query,'hub');assert.equal(item.value.filters.language,'zh-CN');assert.equal(item.value.filters.region,'ος');assert.equal(item.value.filters.maxPrice,'1.2');assert.equal(item.value.order,'kind');
 f.button(f.rows()[0],'この検索を呼び出す').click();await tick();assert.deepEqual(f.applied,[item.value]);f.applied[0].filters.region='changed';assert.equal(f.stored().items[0].value.filters.region,'ος');
 const row=f.rows()[0],rename=row.querySelector('form');rename.querySelector('input').value='Renamed';rename.dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));assert.equal(f.stored().items[0].name,'Renamed');
 f.button(f.rows()[0],'削除').click();assert.equal(f.stored().items.length,0);
});
test('deduplicates exact normalized values including group/order but allows same names for distinct conditions',async t=>{
 const f=setup(t);f.save('same');const id=f.stored().items[0].id;f.setValue(value(' ＴＥＳＴ '));f.save('renamed');assert.equal(f.stored().items.length,1);assert.equal(f.stored().items[0].id,id);assert.equal(f.stored().items[0].name,'renamed');
 for(const next of [value('test','articles'),value('test','all',{},'kind'),value('test','all',{language:'en'})]){f.setValue(next);f.save('same');}assert.equal(f.stored().items.length,4);assert.equal(new Set(f.stored().items.map(row=>row.id)).size,4);
});
test('accepts filter-only searches and rejects empty conditions, unknown groups/keys/orders and malformed filters',t=>{
 const f=setup(t);f.setValue(value('','products',{maxPrice:'0',currency:'JPY'}));f.save();assert.equal(f.stored().items.length,1);const original=f.memory.get(f.key());
 for(const next of [value(''),value('x','admin'),value('x','all',{},'recent'),{...value(),body:'private'},value('x','all',{owner:'private'}),value('x','all',{from:'2026-02-30'}),value('x','all',{from:'2026-02-03',to:'2026-01-01'}),value('x','all',{region:'\ud800'})]){f.setValue(next);f.save();assert.equal(f.memory.get(f.key()),original);}
});
test('matches native NFKC, UTF16 and eight-word query boundaries without truncation',t=>{
 const f=setup(t);for(const query of ['🧪'.repeat(50),'a\tb\nc','a b c d e f g h','ΟΣ']){f.setValue(value(query));f.save();}assert.equal(f.stored().items.length,4);assert.equal(f.stored().items[0].value.query,'ος');const original=f.memory.get(f.key());
 for(const query of ['🧪'.repeat(50)+'x','㌖'.repeat(20),'a b c d e f g h i','a\0b','a\u0085b','\ud800']){f.setValue(value(query));f.save();assert.equal(f.memory.get(f.key()),original);}
});
test('bounds names before and after normalization and never parses names as HTML',t=>{
 const f=setup(t);f.save('<img src=x onerror=1>');assert.equal(f.api.element.querySelector('img'),null);assert.ok(f.api.element.textContent.includes('<img src=x onerror=1>'));const original=f.memory.get(f.key());
 for(const name of ['x'.repeat(33),'🌿'.repeat(17),'㌖'.repeat(6),'bad\0name','\ud800']){f.setValue(value('other'));f.save(name);assert.equal(f.memory.get(f.key()),original);}
 f.setValue(value('last'));f.save('🌿'.repeat(16));assert.equal(f.stored().items[0].name,'🌿'.repeat(16));
});
test('refuses an eleventh entry instead of removing a saved condition',t=>{
 const f=setup(t);for(let i=0;i<10;i++){f.setValue(value(`q${i}`));f.save(`n${i}`);}const original=f.memory.get(f.key());f.setValue(value('eleven'));f.save();assert.equal(f.memory.get(f.key()),original);assert.equal(f.stored().items.length,10);assert.ok(f.api.element.textContent.includes('10件まで'));
});
test('never reads old Web or foreign-service keys and separates profile/origin buckets',t=>{
 const f=setup(t);f.memory.set('hub.search.saved','private legacy');f.memory.set('vault.saved','private foreign');f.memory.set('music.saved','private foreign');f.save('guest');const first=f.key();
 f.setScope(scope('https://hub.example','profile-a',2));assert.equal(f.api.refreshScope(),true);assert.equal(f.rows().length,0);f.setValue(value('owned'));f.save('owned');const second=f.key();
 f.setScope(scope('https://other.example','profile-a',3));f.api.refreshScope();assert.equal(f.rows().length,0);f.setScope(scope());f.api.refreshScope();assert.equal(f.rows()[0].querySelector('summary').textContent,'guest');
 assert.notEqual(first,second);assert.ok(f.calls.every(([,key])=>key.startsWith(prefix)));
});
test('corrupt, unknown-version, legacy, duplicate and over-byte storage fail closed without writes',t=>{
 const f=setup(t);f.save();const good=f.stored();
 for(const raw of ['[]','broken',JSON.stringify({...good,version:2}),JSON.stringify({...good,owner:'secret'}),JSON.stringify({version:1,items:[good.items[0],good.items[0]]}),JSON.stringify({version:1,items:[{...good.items[0],body:'private'}]}),JSON.stringify({version:1,items:[{...good.items[0],name:'bad\nname'}]}),' '.repeat(32769),'é'.repeat(16385)]){
  f.memory.set(f.key(),raw);const before=f.calls.filter(([op])=>op==='set').length;assert.equal(f.api.refreshScope(),false);f.save();assert.equal(f.memory.get(f.key()),raw);assert.equal(f.calls.filter(([op])=>op==='set').length,before);assert.equal(f.rows().length,0);
 }
});
test('quota failure and a partial failing setter retain original data with no success claim',t=>{
 const f=setup(t);f.save('old');const original=f.memory.get(f.key()),real=f.storage.setItem;
 f.storage.setItem=()=>{throw Error('quota');};f.setValue(value('new'));f.save();assert.equal(f.memory.get(f.key()),original);assert.ok(f.api.element.textContent.includes('保存できませんでした'));assert.equal(f.rows()[0].querySelector('summary').textContent,'old');
 let first=true;f.storage.setItem=(key,raw)=>{real(key,raw);if(first){first=false;throw Error('partial');}};f.save();assert.equal(f.memory.get(f.key()),original);
});
test('failed initial scope/read never falls back to guest and cannot save',t=>{
 const f=setup(t);f.setScope(null);assert.equal(f.api.refreshScope(),false);f.save();assert.equal(f.memory.size,0);
 f.setScope({...scope(),key:'[ "https://hub.example", "guest" ]'});assert.equal(f.api.refreshScope(),false);f.save();assert.equal(f.memory.size,0);
 f.setScope(scope());f.storage.getItem=()=>{throw Error('blocked');};assert.equal(f.api.refreshScope(),false);f.save();assert.equal(f.memory.size,0);
});
test('old row/save callbacks cannot mutate a new scope or a destroyed view',t=>{
 const f=setup(t);f.save('old');const old=f.rows()[0],remove=f.button(old,'削除').onclick,save=f.api.element.querySelector('form').onsubmit;
 f.setScope(scope('https://hub.example','next',2));f.api.refreshScope();remove();save({preventDefault(){}});assert.equal(f.memory.has(f.key()),false);f.api.destroy();remove();save({preventDefault(){}});assert.equal(f.memory.has(f.key()),false);
});
test('rechecks stored record before apply and prevents stale root work through the supplied guard',async t=>{
 const wait=pending(),committed=[];const f=setup(t,{apply:async(data,guard)=>{await wait.promise;if(guard())committed.push(data);}});f.save();f.button(f.rows()[0],'この検索を呼び出す').click();
 f.setScope(scope('https://hub.example','other',2));f.api.refreshScope();wait.resolve();await tick();assert.equal(committed.length,0);assert.ok(!f.api.element.textContent.includes('呼び出しました'));
 const g=setup(t);g.save();const stale=g.button(g.rows()[0],'この検索を呼び出す');g.memory.set(g.key(),JSON.stringify({version:1,items:[]}));stale.click();await tick();assert.equal(g.applied.length,0);
});
test('out-of-order apply resolution cannot override a newer request, and disposal cancels callbacks',async t=>{
 const one=pending(),two=pending(),committed=[];let calls=0;const f=setup(t,{apply:async(data,guard)=>{await(calls++?two.promise:one.promise);if(guard())committed.push(data.query);}});
 f.setValue(value('one'));f.save('one');f.setValue(value('two'));f.save('two');f.button(f.rows()[1],'この検索を呼び出す').click();f.api.refreshScope();f.button(f.rows()[0],'この検索を呼び出す').click();two.resolve();await tick();one.resolve();await tick();assert.deepEqual(committed,['two']);
 const wait=pending(),late=[];const g=setup(t,{apply:async(data,guard)=>{await wait.promise;if(guard())late.push(data);}});g.save();g.button(g.rows()[0],'この検索を呼び出す').click();g.api.destroy();wait.resolve();await tick();assert.equal(late.length,0);
});
test('inactive view has no mutations or apply and scope changes during storage write are rolled back',async t=>{
 const f=setup(t);f.save();const original=f.memory.get(f.key()),row=f.rows()[0];f.setActive(false);f.button(row,'削除').click();f.button(row,'この検索を呼び出す').click();f.save();await tick();assert.equal(f.memory.get(f.key()),original);assert.equal(f.applied.length,0);
 f.setActive(true);const oldKey=f.key(),real=f.storage.setItem;let once=true;f.storage.setItem=(key,raw)=>{real(key,raw);if(once){once=false;f.setScope(scope('https://other.example','guest',2));}};f.setValue(value('new'));f.save();assert.equal(f.memory.get(oldKey),original);assert.equal(f.memory.has(f.key()),false);
});
