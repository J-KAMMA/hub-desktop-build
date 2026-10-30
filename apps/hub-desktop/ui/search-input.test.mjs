import {test} from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {bindSearchInput,matchesSearch} from "./search-input.mjs";
import {createMediaSearch} from "./media-search.mjs";
import {createHubSearch} from "./hub-search.mjs";
const wait=()=>new Promise(resolve=>setTimeout(resolve,15));
test("IME composition invalidates old results immediately and submits only after composition", async()=>{
  const dom=new JSDOM('<form><input type="search"></form>'),input=dom.window.document.querySelector('input'),form=input.form;
  const searches=[];let invalidated=0;
  bindSearchInput(input,{form,delay:1,search:q=>searches.push(q),invalidate:()=>invalidated++});
  input.dispatchEvent(new dom.window.CompositionEvent('compositionstart'));
  input.value='山';input.dispatchEvent(new dom.window.InputEvent('input',{isComposing:true}));
  form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await wait();
  assert.deepEqual(searches,[]);assert.ok(invalidated>=2);
  input.dispatchEvent(new dom.window.CompositionEvent('compositionend'));await wait();
  assert.deepEqual(searches,['山']);
  input.value='';input.dispatchEvent(new dom.window.Event('input'));await wait();assert.deepEqual(searches,['山','']);dom.window.close();
});
test("local matching combines terms and handles full width text literally",()=>{
  assert.ok(matchesSearch('ＨＵＢ 研究','Hub project','研究ノート'));
  assert.equal(matchesSearch('%_','anything'),false);
  assert.ok(matchesSearch('%_','literal %_'));
});
test("catalog pages retain distinct slugs without a known total",async()=>{
  let state;
  const search=createMediaSearch({allowUnknownTotal:true,key:item=>item.slug,changed:value=>state=value,
    fetchPage:async({offset})=>({items:offset?[{slug:'a'},{slug:'b'}]:[{slug:'a'}],total:null,hasMore:offset===0})});
  await search.search('query',{},true);await search.more();assert.deepEqual(state.items.map(x=>x.slug),['a','b']);assert.equal(state.offset,3);
});
test("whole Hub searches keep source pagination, retries and independent workspaces",async()=>{
  const calls=[];let fail=true;
  const invoke=async(command,args)=>{
    calls.push({...args,command});
    if(args.resource==='search') return {coreEntities:[{sourceGroup:'posts',ref:{id:args.cursor?'two':'one'},title:args.query}],nextCursor:args.cursor?null:'signed.'+'a'.repeat(43)};
    if(args.resource==='articles'){if(args.offset&&fail)throw Error('offline');return {articles:[{id:args.offset?'a2':'a1'}],hasMore:!args.offset};}
    const key=command==='music_tracks'?'tracks':{music:'works',research:'projects',books:'books'}[args.resource];return {[key]:[],hasMore:false};
  };
  const main=createHubSearch({invoke,changed(){}}),side=createHubSearch({invoke,changed(){}});
  await main.search('main');await side.search('side');await main.more('hub');
  assert.deepEqual(main.snapshot().data.coreEntities.map(x=>x.ref.id),['one','two']);
  assert.equal(side.snapshot().query,'side');assert.equal(side.snapshot().data.coreEntities.length,1);
  await main.more('articles');assert.equal(main.snapshot().data.articles.length,1);assert.ok(main.snapshot().errors.articles);
  fail=false;await main.retry('articles');assert.deepEqual(main.snapshot().data.articles.map(x=>x.id),['a1','a2']);
  assert.ok(calls.some(call=>call.query==='main'&&call.cursor==='signed.'+'a'.repeat(43)));
  const before=calls.length;await main.search('');await main.search('x'.repeat(101));assert.equal(calls.length,before);
});
