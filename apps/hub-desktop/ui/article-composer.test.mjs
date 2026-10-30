import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createArticleComposer} from './article-composer.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const key=JSON.stringify(['https://hub.example','device-one']);
const settled=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const ack=args=>({id:'article-one',href:'/articles/article-one',duplicate:false,clientRequestId:args.requestId});
function fixture(options={}){
  const dom=new JSDOM('<button id="toggle"></button><p id="status"></p><form><input name="title"><textarea name="summary"></textarea><textarea name="body"></textarea><input name="tags"><button type="submit">公開</button></form>');
  const document=dom.window.document,form=document.querySelector('form'),state=document.querySelector('#status'),toggle=document.querySelector('#toggle');
  const values={title:' 題名 ',summary:' 要約 ',body:' 本文\r\n次の行 ',tags:'自然, 科学,自然'};
  for(const[name,value]of Object.entries(values))form.elements.namedItem(name).value=value;
  const store=options.store??new Map(),storage=options.storage??{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
  const calls=[],published=[],rendered=[];let scope={key,generation:1},current=true;
  const controller=createArticleComposer({document,form,toggle,state,storage,getScope:async()=>options.getScope?options.getScope(scope):scope,isCurrent:()=>current,invoke:async(command,args)=>{calls.push({command,args});return options.invoke?options.invoke(command,args):command==='hub_detail'?{found:false,clientRequestId:args.ids[0]}:ack(args);},renderMarkdown:body=>{rendered.push(body);const node=document.createElement('p');node.textContent=body;return[node];},onPublished:async value=>published.push(value)});
  const field=name=>form.elements.namedItem(name),button=name=>form.querySelector(`[data-article-action="${name}"]`);
  const click=async name=>{button(name).click();await settled();};
  const edit=(name,value)=>{field(name).value=value;field(name).dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  return{dom,document,form,state,toggle,store,calls,published,rendered,controller,field,button,click,edit,setScope:value=>{scope=value;},setCurrent:value=>{current=value;},operation:()=>JSON.parse(store.get(`hub.article.operation.v1.${encodeURIComponent(key)}`)??'null')};
}
async function ready(options){const f=fixture(options);await f.controller.refreshScope();return f;}

test('preview canonical body equals published payload, with closed native ownership options',async()=>{
  const f=await ready();await f.click('preview');assert.deepEqual(f.rendered,['本文\n次の行']);assert.equal(f.calls.length,0);await f.click('confirm');
  const {command,args}=f.calls[0];assert.equal(command,'hub_client_action');assert.equal(args.action,'create_article');assert.equal(args.text,f.rendered[0]);
  assert.deepEqual(args.options,{title:'題名',summary:'要約',tags:'自然,科学',expectedDeviceId:'device-one',expectedOrigin:'https://hub.example'});
  assert.equal(f.operation().payload.options.expectedOrigin,undefined);assert.match(args.requestId,/^[a-f0-9-]{36}$/u);assert.equal(f.published.length,1);assert.equal(f.field('body').value,' 本文\n次の行 ');
});
test('Unicode scalar limits allow supplementary characters without truncation and count normalized text',async()=>{
  const f=await ready();f.edit('title','😀'.repeat(120));f.edit('summary','😀'.repeat(400));f.edit('body','😀'.repeat(100000));await f.click('preview');
  assert.equal(f.button('confirm').disabled,false);assert.equal(f.rendered[0].length,200000);assert.match(f.form.textContent,/本文 100000\/100000/u);await f.click('confirm');assert.equal(f.calls[0].args.text.length,200000);
});
test('over-limit and malformed Unicode invalidate an earlier preview without cutting draft',async()=>{
  const f=await ready();await f.click('preview');f.field('title').value='x'.repeat(121);await f.click('preview');assert.equal(f.button('confirm').disabled,true);assert.equal(f.field('title').value.length,121);assert.equal(f.rendered.length,1);
  f.edit('title','題名');f.edit('body','bad\ud800');await f.click('preview');assert.equal(f.button('confirm').disabled,true);assert.equal(f.calls.length,0);
  f.edit('body','bad\0body');await f.click('preview');assert.equal(f.button('confirm').disabled,true);
});
test('tags beyond count or width reject rather than silently normalize away fields',async()=>{
  const f=await ready();f.edit('tags',Array.from({length:9},(_,i)=>`t${i}`).join(','));await f.click('preview');assert.equal(f.button('confirm').disabled,true);
  f.edit('tags','x'.repeat(25));await f.click('preview');assert.equal(f.button('confirm').disabled,true);assert.equal(f.calls.length,0);
  f.edit('tags','😀'.repeat(13));await f.click('preview');assert.equal(f.button('confirm').disabled,true);
  f.edit('tags',' 科学の 歴史 ,科学の 歴史');await f.click('preview');await f.click('confirm');assert.equal(f.calls[0].args.options.tags,'科学の 歴史');
});
test('publish requires preview; edits require another explicit preview',async()=>{
  const f=await ready();await f.click('confirm');assert.equal(f.calls.length,0);await f.click('preview');f.edit('body','更新');await f.click('confirm');assert.equal(f.calls.length,0);await f.click('preview');await f.click('confirm');assert.equal(f.calls[0].args.text,'更新');
});
test('operation journal must save before native publication; storage failure preserves fields and sends nothing',async()=>{
  const f=await ready({storage:{getItem:()=>null,setItem:()=>{throw Error('full');},removeItem:()=>{}}});await f.click('preview');await f.click('confirm');assert.equal(f.calls.length,0);assert.match(f.state.textContent,/送っていません/u);assert.equal(f.field('title').value,' 題名 ');
});
test('pending click deduplication and edited draft survives late exact acknowledgment',async()=>{
  const pending=deferred();const f=await ready({invoke:()=>pending.promise});await f.click('preview');await f.click('confirm');await f.click('confirm');assert.equal(f.calls.length,1);assert.equal(f.operation().status,'pending');f.edit('body','次の記事');pending.resolve(ack(f.calls[0].args));await settled();assert.equal(f.published.length,0);assert.equal(f.field('body').value,'次の記事');assert.equal(f.operation().status,'resolved');assert.match(f.state.textContent,/草稿は保持/u);
});
test('unknown outcome permits only explicit same UUID and immutable payload after scoped lookup',async()=>{
  let writes=0;const f=await ready({invoke:(_command,args)=>{if(args.action){if(++writes===1)throw Error('article_publication_unknown');return ack(args);}return{found:false,clientRequestId:args.ids[0]};}});
  await f.click('preview');await f.click('confirm');const original=f.calls[0].args;f.edit('body','新しい草稿');await f.click('retry');assert.equal(writes,1);
  await f.click('check');assert.deepEqual(f.calls[1],{command:'hub_detail',args:{name:'article_publication',ids:[original.requestId,'device-one','https://hub.example']}});assert.equal(writes,1);assert.match(f.state.textContent,/処理中/u);
  await f.click('retry');assert.equal(writes,2);assert.deepEqual(f.calls[2].args,original);assert.equal(f.field('body').value,'新しい草稿');assert.equal(f.published.length,0);
});
test('lookup confirmed result is labeled as stored lookup, no duplicate send and no new UUID',async()=>{
  const f=await ready({invoke:(command,args)=>{if(command==='hub_client_action')throw Error('offline');return{found:true,id:'stored',href:'/articles/stored',clientRequestId:args.ids[0]};}});
  await f.click('preview');await f.click('confirm');await f.click('check');assert.equal(f.published[0].fromLookup,true);assert.equal(f.published[0].duplicate,true);assert.equal(f.calls.filter(call=>call.command==='hub_client_action').length,1);assert.equal(f.button('confirm').disabled,true);
});
test('forged IDs, href, extra fields and lookup shapes never confirm publication',async()=>{
  for(const mutation of [value=>({...value,clientRequestId:'a1111111-1111-4111-8111-111111111111'}),value=>({...value,href:'https://evil.example'}),value=>({...value,actor:'other'}),value=>({...value,id:'bad\n',href:'/articles/bad\n'})]){
    const f=await ready({invoke:(_command,args)=>mutation(ack(args))});await f.click('preview');await f.click('confirm');assert.equal(f.published.length,0);assert.equal(f.operation().status,'unknown');
  }
  const f=await ready({invoke:(command,args)=>{if(command==='hub_client_action')throw Error('offline');return{found:false,clientRequestId:args.ids[0],id:'extra'};}});await f.click('preview');await f.click('confirm');await f.click('check');assert.equal(f.button('retry').disabled,true);
});
test('scope generation changes before publication deny send and preserve editor',async()=>{
  const f=await ready();await f.click('preview');f.setScope({key,generation:2});await f.click('confirm');assert.equal(f.calls.length,0);assert.equal(f.field('title').value,' 題名 ');assert.equal(f.button('confirm').disabled,true);
});
test('changed origin or disconnected account after pending write does not confirm or move journal',async()=>{
  for(const next of [null,{key:JSON.stringify(['https://other.example','device-two']),generation:2}]){
    const pending=deferred();const f=await ready({invoke:()=>pending.promise});await f.click('preview');await f.click('confirm');f.setScope(next);pending.resolve(ack(f.calls[0].args));await settled();assert.equal(f.published.length,0);assert.equal(f.operation().status,'pending');assert.equal(f.field('body').value,' 本文\n次の行 ');
  }
});
test('view stale and disposal reject late ACK and retained controls do not invoke',async()=>{
  for(const mode of ['view','destroy']){const pending=deferred();const f=await ready({invoke:()=>pending.promise});await f.click('preview');await f.click('confirm');const button=f.button('check');if(mode==='view')f.setCurrent(false);else f.controller.destroy();pending.resolve(ack(f.calls[0].args));await settled();button.click();await settled();assert.equal(f.published.length,0);assert.equal(f.calls.length,1);assert.equal(f.operation().status,'pending');}
});
test('local raw draft save restore delete is explicit and does not delete unresolved operation',async()=>{
  const f=await ready({invoke:()=>{throw Error('offline');}});assert.equal(f.store.size,0);f.edit('title','');f.edit('body','unfinished\r\ntext');await f.click('save');assert.equal(f.store.size,1);f.edit('title','題名');f.edit('body','public');await f.click('preview');await f.click('confirm');const request=f.operation().requestId;
  await f.click('restore');assert.equal(f.field('title').value,'');assert.equal(f.field('body').value,'unfinished\ntext');await f.click('delete-draft');assert.equal(f.store.size,1);assert.equal(f.operation().requestId,request);
});
test('restart reads only scoped operation and keeps raw body untouched until explicit restore',async()=>{
  const f=await ready({invoke:()=>{throw Error('offline');}});await f.click('preview');await f.click('confirm');await f.click('save');const request=f.operation().requestId;f.controller.destroy();
  const restored=await ready({store:f.store});assert.equal(restored.calls.length,0);assert.equal(restored.operation().requestId,request);assert.equal(restored.button('confirm').disabled,true);assert.equal(restored.field('title').value,' 題名 ');await restored.click('check');assert.equal(restored.calls[0].args.ids[0],request);
  restored.setScope({key:JSON.stringify(['https://hub.example','device-two']),generation:2});await restored.controller.refreshScope();await restored.click('restore');assert.match(restored.state.textContent,/復元できません/u);assert.equal(restored.field('title').value,' 題名 ');
});
test('conflict cannot unlock new request ID even after a stored article is found',async()=>{
  const f=await ready({invoke:(command,args)=>{if(command==='hub_client_action')throw Error('article_publication_conflict');return{found:true,id:'original',href:'/articles/original',clientRequestId:args.ids[0]};}});await f.click('preview');await f.click('confirm');f.edit('body','別内容');await f.click('release');await f.click('check');assert.equal(f.operation().status,'conflict');assert.equal(f.button('release').disabled,true);assert.equal(f.button('retry').disabled,true);assert.match(f.state.textContent,/断定できません/u);
  await f.controller.refreshScope();assert.equal(f.button('release').disabled,true);assert.equal(f.operation().status,'conflict');
});
test('actual definite rejection codes release journal only after explicit changed-body operation',async()=>{
  for(const code of ['article_publication_rejected:400','article_publication_rejected:403','article_publication_rejected:413','article_publication_rejected:429','article_publication_invalid_request','article_publication_request_too_large']){
    const f=await ready({invoke:()=>{throw Error(code);}});await f.click('preview');await f.click('confirm');const original=f.operation().requestId;assert.equal(f.operation().status,'rejected');await f.click('release');assert.equal(f.operation().requestId,original);f.edit('body','修正内容');assert.equal(f.operation().requestId,original);await f.click('release');assert.equal(f.operation(),null);await f.click('preview');await f.click('confirm');assert.notEqual(f.operation().requestId,original);
  }
  for(const code of ['article_publication_rejected:404','article_publication_rejected:400\n','article_publication_rejected']){const f=await ready({invoke:()=>{throw Error(code);}});await f.click('preview');await f.click('confirm');assert.equal(f.operation().status,'unknown');assert.equal(f.button('release').hidden,true);}
});
test('corrupt or oversized journal closes publication; scope retry can recover without changing draft',async()=>{
  for(const stored of ['{"extra":true}','x'.repeat(1000001)]){const store=new Map([[`hub.article.operation.v1.${encodeURIComponent(key)}`,stored]]);const f=await ready({store});assert.equal(f.button('confirm').disabled,true);assert.equal(f.button('save').disabled,true);assert.equal(f.calls.length,0);store.clear();await f.click('scope');await f.click('preview');assert.equal(f.button('confirm').disabled,false);}
});
test('unconnected scope rejects saving and publishing; raw storage is not read',async()=>{
  const f=fixture({storage:{getItem:()=>{throw Error('should not read');},setItem:()=>{throw Error('should not write');},removeItem:()=>{throw Error('should not remove');}}});f.setScope(null);await f.controller.refreshScope();await f.click('save');await f.click('confirm');assert.equal(f.calls.length,0);assert.equal(f.button('save').disabled,true);assert.match(f.state.textContent,/接続/u);
});
test('preview renders untrusted article as text nodes, never user HTML',async()=>{
  const f=await ready();f.edit('title','<img src=x onerror=alert(1)>');f.edit('body','<script>payload</script>');await f.click('preview');assert.equal(f.form.querySelector('img,script'),null);assert.match(f.form.textContent,/<script>payload<\/script>/u);
});
test('unfinished raw draft at UTF16 bound remains restorable even with JSON escaping',async()=>{
  const f=await ready();const body='\u0001'.repeat(200000);f.edit('body',body);await f.click('save');assert.match(f.state.textContent,/保存しました/u);f.edit('body','other');await f.click('restore');assert.equal(f.field('body').value,body);assert.equal(f.calls.length,0);
});
test('late scope failure after disposal or view change does not update status or submit state',async()=>{
  for(const mode of ['destroy','view']){let gate=null;const f=await ready({getScope:scope=>gate?gate.promise:scope});gate=deferred();f.button('preview').click();await settled();const status=f.state.textContent,disabled=f.form.querySelector('[type="submit"]').disabled;
    if(mode==='destroy')f.controller.destroy();else f.setCurrent(false);gate.reject(Error('scope failed'));await settled();assert.equal(f.state.textContent,status);assert.equal(f.form.querySelector('[type="submit"]').disabled,disabled);assert.equal(f.calls.length,0);}
});
test('late old-scope success cannot invalidate the new scope preview',async()=>{
  let next=null;const f=await ready({getScope:scope=>{if(!next)return scope;const pending=next;next=null;return pending.promise;}});const gate=next=deferred();f.button('preview').click();await settled();f.setScope({key,generation:2});await f.controller.refreshScope();await f.click('preview');assert.equal(f.button('confirm').disabled,false);const status=f.state.textContent;
  gate.resolve({key,generation:1});await settled();assert.equal(f.button('confirm').disabled,false);assert.equal(f.state.textContent,status);assert.equal(f.calls.length,0);
});
test('existing submit previews once, and state-specific actions and draft details stay compact',async()=>{
  const f=await ready({invoke:()=>{throw Error('offline');}});assert.equal(f.form.querySelectorAll('[data-article-action="preview"]').length,1);assert.equal(f.button('preview').type,'submit');assert.equal(f.button('confirm').hidden,true);assert.equal(f.button('check').hidden,true);assert.equal(f.button('scope').hidden,true);assert.equal(f.button('save').parentElement.tagName,'DETAILS');assert.equal(f.button('save').parentElement.querySelector('summary').textContent,'下書き');
  await f.click('preview');assert.equal(f.rendered.length,1);assert.equal(f.button('confirm').hidden,false);await f.click('confirm');assert.equal(f.button('confirm').hidden,true);assert.equal(f.button('check').hidden,false);assert.equal(f.button('retry').hidden,true);
});
test('guest previews normalized Markdown locally with no scope read, storage or IPC; connecting invalidates preview',async()=>{
  let scopeReads=0,storageReads=0,storageWrites=0;const f=fixture({getScope:scope=>{scopeReads++;return scope;},storage:{getItem:()=>{storageReads++;return null;},setItem:()=>{storageWrites++;},removeItem:()=>{storageWrites++;}}});f.setScope(null);await f.controller.refreshScope();const baseline=scopeReads;
  assert.equal(f.button('preview').disabled,false);await f.click('preview');assert.deepEqual(f.rendered,['本文\n次の行']);assert.equal(f.button('confirm').disabled,true);assert.equal(f.button('save').disabled,true);assert.equal(f.button('restore').disabled,true);assert.equal(f.calls.length,0);assert.equal(scopeReads,baseline);assert.equal(storageReads,0);assert.equal(storageWrites,0);assert.match(f.state.textContent,/接続が必要/u);
  f.setScope({key,generation:2});await f.controller.refreshScope();assert.equal(f.button('confirm').hidden,true);assert.equal(f.rendered.length,1);await f.click('confirm');assert.equal(f.calls.length,0);await f.click('preview');assert.equal(f.button('confirm').disabled,false);
});
