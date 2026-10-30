import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createHubNetwork,mergeHubItems,normalizeHubOrigin,hubCatalogResearchQuery} from './hub-network.mjs';
test('research query preserves width and spelling, trims JS whitespace and enforces raw UTF16 bounds',()=>{
 assert.equal(hubCatalogResearchQuery('\ufeff Ａ & + 日本語 \u00a0'),'Ａ & + 日本語');
 assert.equal(hubCatalogResearchQuery('😀'.repeat(50)),'😀'.repeat(50));
 assert.equal(hubCatalogResearchQuery('a '.repeat(7)+'a'),'a '.repeat(7)+'a');
 for(const value of [null,42,'a'.repeat(101),' '+'a'.repeat(100),'😀'.repeat(51),'a '.repeat(8)+'a','bad\nquery','bad\u007f','bad\u0085','\ud800','\udc00'])assert.throws(()=>hubCatalogResearchQuery(value));
});
function researchNetworkFixture(t){
 const dom=new JSDOM('<section id="view-node"></section><section id="view-research"><div class="view-head"></div></section>',{url:'http://localhost'});
 t.after(()=>dom.window.close());dom.window.localStorage.setItem('hub.network.sources.v1',JSON.stringify(['https://a.example','https://b.example']));
 const f={dom,calls:[],read:async args=>({query:args.query??'',items:[]})};
 f.network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,changed:()=>{},manage:()=>{},openWeb:()=>{},invoke:async(name,args)=>{
  if(name==='hub_origin')return 'https://main.example';f.calls.push([name,args]);return f.read(args);
 }});return f;
}
test('only research nonempty query is transmitted, selected source alone receives exact trimmed query',async t=>{
 const f=researchNetworkFixture(t);await f.network.ready;
 const filter=f.dom.window.document.querySelector('[aria-label="プロジェクト作成の表示元"]');filter.value='https://b.example';filter.onchange();
 await f.network.load('research','\ufeff 日本語 & + \ufeff');assert.deepEqual(f.calls.map(([,args])=>args),[{origin:'https://b.example',kind:'research',query:'日本語 & +'}]);
 f.calls=[];await f.network.load('research','   ');assert.equal(f.calls.some(([,args])=>Object.hasOwn(args,'query')),false);
 f.calls=[];await assert.rejects(f.network.load('research','bad\u0085'));assert.deepEqual(f.calls,[]);
});
test('nonempty search rejects absent or mismatched echo per Hub while retaining matching origin rows',async t=>{
 const f=researchNetworkFixture(t);await f.network.ready;
 f.read=async({origin,query})=>({...(origin==='https://b.example'?{query}:{}),items:[{id:'same',title:origin,updatedAt:'2026-10-04'}]});
 const found=await f.network.load('research','older');assert.deepEqual(found.map(item=>item.origin),['https://b.example']);assert.equal(f.network.errors('research').length,1);
 f.read=async()=>({query:'wrong',items:[]});assert.deepEqual(await f.network.load('research','older'),[]);assert.equal(f.network.errors('research').length,2);
 f.read=async()=>({items:Array.from({length:30},(_,i)=>({id:String(i)}))});assert.equal((await f.network.load('research')).length,60);
});
test('cleared query, changed source and changed account invalidate late network statuses and results',async t=>{
 const f=researchNetworkFixture(t);await f.network.ready;let pending=[];
 f.read=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
 for(const invalidate of [()=>f.network.invalidate('research'),()=>{const filter=f.dom.window.document.querySelector('[aria-label="プロジェクト作成の表示元"]');filter.value='https://b.example';filter.onchange();},()=>f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'))]){
  pending=[];const old=f.network.load('research','old');await new Promise(setImmediate);invalidate();for(const p of pending)p.resolve({query:'old',items:[{id:'old'}]});assert.deepEqual(await old,[]);
  assert.equal(f.dom.window.document.querySelector('#view-research [role="status"]').textContent,'');
 }
});
test('same IDs on independent Hubs stay separate; only exact copies collapse',()=>{
 const item={id:'same',updatedAt:'2026-09-30'};
 assert.equal(mergeHubItems([{origin:'https://a.example',items:[item,item]},{origin:'https://b.example',items:[item]}]).length,2);
 for(const url of ['javascript:alert(1)','https://name:pass@a.example','https://a.example/other','http://a.example'])assert.throws(()=>normalizeHubOrigin(url));
});
test('offline source does not block others, filters keep origin, and destination stays on selected Hub',async()=>{
 const dom=new JSDOM('<section id="view-node"></section><section id="view-feed"><div class="view-head"></div></section><section id="view-research"><div class="view-head"></div></section>',{url:'http://localhost'});
 const storage=dom.window.localStorage;storage.setItem('hub.network.sources.v1',JSON.stringify(['https://a.example','https://b.example']));const calls=[],opened=[];
 const network=createHubNetwork({document:dom.window.document,storage,changed:()=>{},manage:()=>{},openWeb:url=>opened.push(url),invoke:async(name,args)=>{calls.push([name,args]);if(name==='hub_origin')return 'https://main.example';if(args.origin==='https://a.example')throw Error('offline');return {items:[{id:'same',title:'B',summary:'<script>no()</script>',path:'/v2/research/same',updatedAt:'2026-09-30'}]};}});
 await network.ready;const items=await network.load('research');assert.equal(items.length,1);assert.equal(items[0].origin,'https://b.example');assert.match(dom.window.document.body.textContent,/a.example は接続できません/);
 const filter=dom.window.document.querySelector('[aria-label="プロジェクト作成の表示元"]');filter.value='https://b.example';filter.dispatchEvent(new dom.window.Event('change'));assert.equal(network.includePrimary('research'),false);
 calls.length=0;await network.load('research');assert.deepEqual(calls.map(([,args])=>args.origin),['https://b.example']);
 const destination=dom.window.document.querySelector('[aria-label="プロジェクト作成の保存先"]');destination.value='https://b.example';[...destination.parentElement.querySelectorAll('button')].find(b=>b.textContent==='プロジェクト作成の画面を開く').click();assert.equal(opened[0],'https://b.example/v2/research');
 const card=network.card(items[0]);assert.equal(card.querySelector('script'),null);card.querySelector('button').click();assert.equal(opened[1],'https://b.example/v2/research/same');
 assert.equal(calls.some(([name])=>name==='hub_client_action'),false);dom.window.close();
});
test('account changes during the public connection check cannot add a source to the new account',async()=>{
 const dom=new JSDOM('<section id="view-node"></section>',{url:'http://localhost'});
 let account={state:'registered',deviceId:'alice'},release;const mutations=[];
 const network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,getAccount:()=>account,changed:()=>{},manage:()=>{},openWeb:()=>{},invoke:async(name,args)=>{
   if(name==='hub_origin')return 'https://main.example';
   if(name==='hub_network_read')return new Promise(resolve=>release=resolve);
   if(args.action!=='list')mutations.push(args);return {sources:[]};
 }});
 await network.ready;const form=dom.window.document.querySelector('form');form.querySelector('input').value='https://other.example';
 const pending=form.onsubmit({preventDefault(){}});
 account={state:'registered',deviceId:'bob'};dom.window.dispatchEvent(new dom.window.Event('hub-account-changed'));
 release({items:[]});await pending;
 assert.deepEqual(mutations,[]);assert.match(dom.window.document.body.textContent,/アカウントが変わりました/);dom.window.close();
});

test('cached sources are ready before an unavailable account service finishes responding',async()=>{
 const dom=new JSDOM('<section id="view-node"></section>',{url:'http://localhost'});
 dom.window.localStorage.setItem('hub.network.account-sources.v1.https%3A%2F%2Fmain.example',JSON.stringify({deviceId:'alice',sources:['https://cached.example']}));
 let finish;
 const network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,getAccount:()=>({state:'registered',deviceId:'alice'}),changed:()=>{},manage:()=>{},openWeb:()=>{},invoke:async(name)=>{
   if(name==='hub_origin')return 'https://main.example';
   if(name==='hub_network_sources')return new Promise(resolve=>finish=resolve);
   return {items:[]};
 }});
 await network.ready;assert.match(dom.window.document.querySelector('.hub-network-source').textContent,/cached.example/);
 assert.deepEqual(await network.load('post'),[]);finish({sources:[]});await new Promise(resolve=>setImmediate(resolve));dom.window.close();
});

function readingFixture(){
 const dom=new JSDOM('<section id="view-node"></section><section id="view-feed"><div class="view-head"></div></section><section id="view-research"><div class="view-head"></div></section>',{url:'http://localhost'});
 dom.window.localStorage.setItem('hub.network.sources.v1',JSON.stringify(['https://a.example','https://b.example']));
 const f={dom,calls:[],read:async()=>({items:[]})};
 f.network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,changed:kind=>{f.loading=f.network.load(kind);},manage:()=>{},openWeb:()=>{},invoke:async(name,args)=>{
   if(name==='hub_origin')return 'https://main.example';f.calls.push([name,args]);return f.read(args);
 }});return f;
}
test('a late failed read cannot overwrite the status of a newer successful read',async t=>{
 const f=readingFixture();t.after(()=>f.dom.window.close());await f.network.ready;
 const pending=[];f.read=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
 const old=f.network.load('post');await new Promise(setImmediate);
 f.read=async()=>({items:[]});await f.network.load('post');
 for(const p of pending)p.reject(Error('offline'));await old;
 assert.match(f.dom.window.document.querySelector('#view-feed [role="status"]').textContent,/2 Hubから取得/);
});
test('retry distinguishes partial and complete failures and runs only a read for the selected kind',async t=>{
 const f=readingFixture();t.after(()=>f.dom.window.close());await f.network.ready;
 f.read=async({origin})=>{if(origin==='https://a.example')throw Error('offline');return {items:[{id:'one',title:'B',updatedAt:'2026-10-01'}]};};
 assert.equal((await f.network.load('post')).length,1);
 const view=f.dom.window.document.querySelector('#view-feed'),status=view.querySelector('[role="status"]'),retry=view.querySelector('[data-hub-retry]');
 assert.match(status.textContent,/1\/2 Hub/);assert.equal(retry.hidden,false);
 f.read=async()=>{throw Error('offline');};await f.network.load('post');assert.match(status.textContent,/追加Hubの内容を取得できませんでした/);
 const pending=[];f.read=()=>new Promise(resolve=>pending.push(resolve));f.calls.length=0;
 retry.click();retry.click();await new Promise(setImmediate);assert.equal(retry.disabled,true);assert.equal(f.calls.length,2);
 for(const done of pending)done({items:[]});await f.loading;assert.equal(retry.hidden,true);
 assert.ok(f.calls.every(([name,args])=>name==='hub_network_read'&&args.kind==='post'));
});
test('switching one kind does not invalidate another kind and discards the previous selection',async t=>{
 const f=readingFixture();t.after(()=>f.dom.window.close());await f.network.ready;
 const pending=[];f.read=args=>new Promise(resolve=>pending.push({args,resolve}));
 const products=f.network.load('research'),oldPosts=f.network.load('post');await new Promise(setImmediate);
 const filter=f.dom.window.document.querySelector('[aria-label="投稿の表示元"]');
 filter.value='https://b.example';filter.dispatchEvent(new f.dom.window.Event('change'));await new Promise(setImmediate);
 for(const p of pending)p.resolve({items:[{id:'one',title:p.args.origin,updatedAt:'2026-10-01'}]});
 assert.equal((await products).length,2);assert.deepEqual(await oldPosts,[]);assert.equal((await f.loading).length,1);
 assert.match(f.dom.window.document.querySelector('#view-feed [role="status"]').textContent,/1 Hubから取得/);
});


test('device-managed sources can be added and read while the primary Hub and account service are unavailable',async t=>{
 const dom=new JSDOM('<section id="view-node"></section><section id="view-feed"><div class="view-head"></div></section>',{url:'http://localhost'});t.after(()=>dom.window.close());const calls=[];
 const network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,getAccount:()=>null,changed:()=>{},manage:()=>{},openWeb:()=>{},invoke:async(name,args)=>{calls.push([name,args]);if(name==='hub_origin')return 'https://main.example';if(name==='hub_network_sources')throw Error('network_unavailable');return{items:[{id:'public-one',title:'独立Hubの公開投稿',path:'/v2/posts/public-one',summary:'内容',updatedAt:'2026-10-01'}]};}});
 await network.ready;const scope=dom.window.document.querySelector('[aria-label="接続先の管理方法"]');scope.value='device';await scope.onchange();
 const form=dom.window.document.querySelector('form');form.querySelector('input').value='https://independent.example';await form.onsubmit({preventDefault(){}});
 assert.deepEqual((await network.load('post')).map(i=>i.origin),['https://independent.example']);assert.ok(!calls.some(([name])=>name==='hub_network_sources'||name==='hub_client_action'));
 assert.match(dom.window.document.querySelector('#view-node').textContent,/標準Hubやログインに依存せず/);
});

async function sharingFixture(t,{onShare,isCurrent}={}){
 const dom=new JSDOM('<section id="view-node"></section><section id="view-feed"><div class="view-head"></div></section><section id="view-research"><div class="view-head"></div></section>',{url:'http://localhost'});
 t.after(()=>dom.window.close());dom.window.localStorage.setItem('hub.network.sources.v1',JSON.stringify(['https://a.example','https://b.example']));
 const f={dom,calls:[],shared:[],opened:[],forked:[],account:{state:'signed_out'},current:true};
 f.network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,changed:()=>{},manage:()=>{},getAccount:()=>f.account,openWeb:href=>f.opened.push(href),openResearchFork:item=>f.forked.push(item),isCurrent:isCurrent??(()=>f.current),onShare:onShare??(reference=>f.shared.push(reference)),invoke:async(name,args)=>{
  if(name==='hub_origin')return 'https://main.example';f.calls.push([name,args]);return name==='hub_network_sources'?{sources:['https://a.example','https://b.example']}:{items:[]};
 }});
 await f.network.ready;
 f.card=(patch={})=>{const card=f.network.card({origin:'https://a.example',id:'same',path:'/v2/posts/same',title:'公開項目',summary:'この要約は共有しない',...patch});dom.window.document.body.append(card);return card;};
 f.share=card=>[...card.querySelectorAll('button')].find(button=>button.textContent==='投稿で紹介');
 return f;
}

test('network sharing preserves same IDs on distinct origins and freezes the exact reference at card creation',async t=>{
 const f=await sharingFixture(t);
 const item={origin:'https://a.example',id:'same',path:'/v2/posts/same',title:'固定された題名',summary:'共有しない本文'};
 const card=f.network.card(item);f.dom.window.document.body.append(card);
 item.origin='https://b.example';item.path='/v2/posts/changed';item.id='changed';item.title='変更後';
 await f.share(card).onclick();await f.share(f.card({origin:'https://b.example'})).onclick();
 assert.deepEqual(f.shared.map(({href,title})=>({href,title})),[{href:'https://a.example/v2/posts/same',title:'固定された題名'},{href:'https://b.example/v2/posts/same',title:'公開項目'}]);
 assert.ok(f.shared.every(reference=>Object.keys(reference).sort().join(',')==='href,isCurrent,title'&&reference.isCurrent()));
 card.querySelector('button').click();assert.deepEqual(f.opened,['https://a.example/v2/posts/same']);assert.deepEqual(f.calls,[]);
});

test('network cards share only recognized exact post and project path and ID pairs',async t=>{
 const f=await sharingFixture(t);
 for(const path of ['/v2/posts/same','/v2/research/same'])await f.share(f.card({path})).onclick();
 assert.deepEqual(f.shared.map(reference=>reference.href),['https://a.example/v2/posts/same','https://a.example/v2/research/same']);
 for(const patch of [{origin:'https://A.example/'},{origin:'https://a.exa\nmple'},{id:'different'},{path:'/v2/posts/same?x=1'},{path:'/v2/posts/same#fragment'},{path:'/v2/articles/same'},{path:'/v2/market/products/same'},{path:'/v2/posts/%73ame'},{id:'a'.repeat(129),path:'/v2/posts/'+ 'a'.repeat(129)},{origin:'https://name:pass@a.example'},{origin:'http://a.example'}]){
  const card=f.card(patch);assert.equal(f.share(card),undefined);card.querySelector('button').click();
 }
 assert.deepEqual(f.opened,[]);assert.deepEqual(f.calls,[]);
 const unknown=f.card({origin:'https://unknown.example'}),primary=f.card({origin:'https://main.example'});
 await f.share(unknown).onclick();await f.share(primary).onclick();assert.equal(f.shared.length,2);
});

test('detached cards and invalid callback scopes cannot share, open or fork',async t=>{
 const f=await sharingFixture(t),id='rp_'+'a'.repeat(32);
 for(const invalidate of [card=>card.remove(),()=>{f.current=false;}]){
  f.current=true;const card=f.card({id,path:`/v2/research/${id}`});invalidate(card);
  for(const button of card.querySelectorAll('button'))await button.onclick();
 }
 assert.deepEqual(f.shared,[]);assert.deepEqual(f.opened,[]);assert.deepEqual(f.forked,[]);
});

test('removing or selecting away from a source invalidates existing cards and their late guards',async t=>{
 const f=await sharingFixture(t),card=f.card();await f.share(card).onclick();const old=f.shared[0];
 const filter=f.dom.window.document.querySelector('[aria-label="投稿の表示元"]');filter.value='https://b.example';filter.onchange();
 assert.equal(old.isCurrent(),false);filter.value='all';filter.onchange();await f.share(card).onclick();assert.equal(f.shared.length,1);
 const fresh=f.card();await f.share(fresh).onclick();const latest=f.shared[1];
 const source=[...f.dom.window.document.querySelectorAll('.hub-network-source')].find(row=>row.textContent.includes('a.example'));
 await source.querySelector('button').onclick();assert.equal(latest.isCurrent(),false);await f.share(fresh).onclick();assert.equal(f.shared.length,2);
 const unrelated=f.card({origin:'https://b.example'});await f.share(unrelated).onclick();assert.equal(f.shared.length,3);
});

test('account changes and source management scope changes invalidate cards even without a changed source list',async t=>{
 const f=await sharingFixture(t),card=f.card();await f.share(card).onclick();const old=f.shared[0];
 f.account={state:'registered',deviceId:'alice'};assert.equal(old.isCurrent(),false);await f.share(card).onclick();
 f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));await new Promise(setImmediate);
 const registered=f.card();await f.share(registered).onclick();assert.equal(f.shared.length,2);
 f.account={state:'signed_out'};assert.equal(f.shared[1].isCurrent(),false);
 f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));await new Promise(setImmediate);
 const scoped=f.card();await f.share(scoped).onclick();const beforeScope=f.shared[2];
 const scope=f.dom.window.document.querySelector('[aria-label="接続先の管理方法"]');
 f.dom.window.localStorage.setItem('hub.network.device-sources.v1.https%3A%2F%2Fmain.example',JSON.stringify(['https://a.example','https://b.example']));scope.value='device';await scope.onchange();
 assert.equal(beforeScope.isCurrent(),false);scope.value='profile';await scope.onchange();assert.equal(beforeScope.isCurrent(),false);await f.share(scoped).onclick();assert.equal(f.shared.length,3);
});

test('share double clicks invoke once and delayed callers receive a live guard',async t=>{
 let release;const staged=[];const f=await sharingFixture(t,{onShare:reference=>{staged.push(reference);return new Promise(resolve=>release=resolve);}}),card=f.card(),share=f.share(card);
 const pending=share.onclick();assert.equal(share.disabled,true);await share.onclick();assert.equal(staged.length,1);assert.equal(staged[0].isCurrent(),true);
 card.remove();assert.equal(staged[0].isCurrent(),false);release();assert.equal(await pending,false);assert.equal(share.disabled,true);assert.deepEqual(f.calls,[]);
});

test('share completion restores the action only while its source and caller remain current',async t=>{
 let release;const f=await sharingFixture(t,{onShare:()=>new Promise(resolve=>release=resolve)}),card=f.card(),share=f.share(card);
 const pending=share.onclick();release();assert.equal(await pending,true);assert.equal(share.disabled,false);
 const again=share.onclick();f.current=false;release();assert.equal(await again,false);assert.equal(share.disabled,true);
});

test('optional sharing callback preserves legacy card actions without adding a share control',async t=>{
 const dom=new JSDOM('<section id="view-node"></section>',{url:'http://localhost'});t.after(()=>dom.window.close());dom.window.localStorage.setItem('hub.network.sources.v1',JSON.stringify(['https://a.example']));const opened=[],forked=[];
 const network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,changed:()=>{},manage:()=>{},openWeb:href=>opened.push(href),openResearchFork:item=>forked.push(item),invoke:async name=>name==='hub_origin'?'https://main.example':{items:[]}});await network.ready;
 const id='rp_'+'a'.repeat(32),card=network.card({origin:'https://a.example',id,path:`/v2/research/${id}`,title:'Project',summary:'Existing summary'});
 assert.equal(card.querySelectorAll('button').length,2);for(const button of card.querySelectorAll('button'))await button.onclick();
 assert.deepEqual(opened,[`https://a.example/v2/research/${id}`]);assert.equal(forked.length,1);assert.equal(forked[0].origin,'https://a.example');
});

test('Hub-origin change permanently invalidates old card controls and pending caller guards',async t=>{
 const f=await sharingFixture(t),card=f.card();await f.share(card).onclick();const selected=f.shared[0];
 f.dom.window.dispatchEvent(new f.dom.window.Event('hub-origin-changed'));
 assert.equal(selected.isCurrent(),false);for(const button of card.querySelectorAll('button'))await button.onclick();
 assert.equal(f.shared.length,1);assert.deepEqual(f.opened,[]);
});
for(const kind of ['post','research'])for(const sharing of [true,false])
test(`failed ${kind} origin disables recreated controls and recovers with sharing=${sharing}`,async t=>{
 const dom=new JSDOM('<section id="view-node"></section>',{url:'http://localhost'});t.after(()=>dom.window.close());
 const a='https://a.example',b='https://b.example';dom.window.localStorage.setItem('hub.network.sources.v1',JSON.stringify([a,b]));
 const id=kind==='research'?'rp_'+'a'.repeat(32):'same',path=kind==='post'?`/v2/posts/${id}`:`/v2/research/${id}`;
 const opened=[],shared=[],forked=[];let denial=null;
 const network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,changed:()=>{},manage:()=>{},
  openWeb:href=>opened.push(href),openResearchFork:item=>forked.push(item),...(sharing?{onShare:ref=>shared.push(ref)}:{}),
  invoke:async(name,args)=>{if(name==='hub_origin')return 'https://main.example';if(name==='hub_network_read'){if(args.origin===a&&denial)throw typeof denial==="number"?`ハブが ${denial} を返しています`:denial;return{items:[{id,path,title:'Public',summary:'Public metadata'}]};}return{items:[]};}});
 await network.ready;assert.equal((await network.load(kind)).length,2);
 const item={origin:a,id,path,title:'A',summary:'Metadata'},original=network.card(item);
 assert.ok([...original.querySelectorAll('button')].every(button=>!button.disabled),'mounting must not be required to enable valid controls');
 dom.window.document.body.append(original);
 for(const status of ["network_timeout",401,403]){
  denial=status;const items=await network.load(kind);assert.equal(items.length,1);assert.equal(items[0].origin,b);
  for(const button of original.querySelectorAll('button'))await button.onclick();
  const failed=network.card(item);assert.ok([...failed.querySelectorAll('button')].every(button=>button.disabled));dom.window.document.body.append(failed);
  for(const button of failed.querySelectorAll('button'))await button.onclick();
  assert.deepEqual(opened,[]);assert.deepEqual(shared,[]);assert.deepEqual(forked,[]);
  const available=network.card(items[0]);assert.ok([...available.querySelectorAll('button')].every(button=>!button.disabled));dom.window.document.body.append(available);
  for(const button of available.querySelectorAll('button'))await button.onclick();
  assert.deepEqual(opened,[b+path]);if(sharing)assert.equal(shared[0].href,b+path);if(kind==='research')assert.equal(forked[0].origin,b);
  opened.length=shared.length=forked.length=0;
 }
 denial=null;assert.equal((await network.load(kind)).length,2);
 const recovered=network.card(item);assert.ok([...recovered.querySelectorAll('button')].every(button=>!button.disabled));dom.window.document.body.append(recovered);
 for(const button of recovered.querySelectorAll('button'))await button.onclick();
 assert.deepEqual(opened,[a+path]);if(sharing)assert.equal(shared[0].href,a+path);if(kind==='research')assert.equal(forked[0].origin,a);
});

for(const kind of ['post','research'])test(`${kind}: transient failed origins align with mixed source errors and clear on recovery`,async t=>{
 const dom=new JSDOM('<section id="view-node"></section>',{url:'http://localhost'});t.after(()=>dom.window.close());
 const origins=['a','b','c','d'].map(host=>`https://${host}.example`);dom.window.localStorage.setItem('hub.network.sources.v1',JSON.stringify(origins));
 let failures=new Map();
 const network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,changed:()=>{},manage:()=>{},openWeb:()=>{},
  invoke:async(name,args)=>{if(name==='hub_origin')return 'https://main.example';if(name==='hub_network_read'){if(failures.has(args.origin))throw failures.get(args.origin);return{items:[{id:'same',title:args.origin,path:kind==='post'?'/v2/posts/same':'/v2/research/same'}]};}return{items:[]};}});
 await network.ready;
 const [a,b,c,d]=origins;
 for(const [entries,transient] of [
  [[[a,'network_timeout'],[c,'ハブが 401 を返しています'],[d,'invalid_catalog']],[a]],
  [[[a,'ハブが 401 を返しています'],[c,'network_timeout'],[d,'ハブが 403 を返しています']],[c]],
  [[[a,'ハブが 403 を返しています'],[c,'invalid_catalog'],[d,'ハブが 503 を返しています']],[d]],
 ]){
  failures=new Map(entries);const loaded=await network.load(kind);assert.equal(loaded.length,1);assert.equal(loaded[0].origin,b);
  assert.deepEqual(network.failedOrigins(kind),[a,c,d]);assert.deepEqual(network.failedOrigins(kind,false),[a,c,d]);
  assert.deepEqual(network.failedOrigins(kind,true),transient);assert.deepEqual(network.errors(kind),entries.map(([,error])=>error));
 }
 failures.clear();assert.equal((await network.load(kind)).length,4);assert.deepEqual(network.failedOrigins(kind),[]);assert.deepEqual(network.failedOrigins(kind,true),[]);assert.deepEqual(network.errors(kind),[]);
});

test('card guards pass only the contract-confirmed post or research kind to the caller',async t=>{
 let allowed='post';const kinds=[];
 const f=await sharingFixture(t,{isCurrent:kind=>{kinds.push(kind);return kind===allowed;}});
 for(const [kind,path]of [['post','/v2/posts/same'],['research','/v2/research/same']]){
  allowed=kind;const card=f.card({path,kind:'untrusted-kind'});await f.share(card).onclick();card.querySelector('button').click();
 }
 assert.deepEqual(f.shared.map(value=>value.href),['https://a.example/v2/posts/same','https://a.example/v2/research/same']);
 assert.deepEqual(f.opened,f.shared.map(value=>value.href));assert.equal(kinds.every(kind=>['post','research'].includes(kind)),true);
});
test('research bar lands inside .research-index-tools as a filter-row, and only the source select is narrowed',async t=>{
 const dom=new JSDOM('<section id="view-node"></section><section id="view-research"><div class="view-head"><div class="research-index-tools"></div></div></section>',{url:'http://localhost'});
 t.after(()=>dom.window.close());
 const network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,changed:()=>{},manage:()=>{},openWeb:()=>{},invoke:async name=>{if(name==='hub_origin')return 'https://main.example';return {items:[]};}});
 await network.ready;
 const bar=dom.window.document.querySelector('#view-research .research-index-tools > .hub-network-bar');
 assert.ok(bar,'the bar is inside .research-index-tools');
 assert.ok(bar.classList.contains('filter-row'));
 assert.equal(dom.window.document.querySelectorAll('#view-research .hub-network-bar').length,1);
 assert.ok(bar.querySelector('.hub-network-controls > label > select'),'the source select matches the narrowed selector');
 assert.ok(bar.querySelector('.hub-network-options-body > select'),'the destination select sits outside it');
});
