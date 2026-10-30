import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createHubSearch} from './hub-search.mjs';
import {createHubSearchFilters} from './hub-search-filter-panel.mjs';
import {bindSearchInput} from './search-input.mjs';
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
function section(from,to){const start=source.indexOf(from),end=source.indexOf(to,start+from.length);assert.ok(start>=0&&end>start);return source.slice(start,end);}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(t){
 const dom=new JSDOM('<form id="hub-search"><input id="search-query"></form><input id="toolbar-search-input"><div id="search-filter-host"></div><p id="search-state"></p><form id="rail-search-form"><input id="rail-search-query"></form><div id="rail-search-filter-host"></div><p id="rail-search-state"></p>');
 const {window}=dom,{document}=window,calls=[],snapshots={};
 const controller=side=>createHubSearch({changed:state=>snapshots[side]=state,invoke:async(command,args)=>{
  calls.push({side,command,...args});return args.resource==='search'?{coreEntities:[],nextCursor:null}:{[{articles:'articles',music:'works',research:'projects',books:'books'}[args.resource]??'tracks']:[],hasMore:false};
 }});
 const mainSearch=controller('main'),sideSearch=controller('side');
 const boot=new Function('document','window','createHubSearchFilters','bindSearchInput','mainSearch','sideSearch',`const startupTool='fixture';let currentView='search',searchGroupFilter='all';const mainSearchBindings=[];const railSearchQuery=document.querySelector('#rail-search-query');${section('const mainSearchFilters=createHubSearchFilters(', 'document.querySelector("#search-web").onclick')}${section('let sideSearchBinding=null;', 'const railActivityToggle =')}return {main:mainSearchFilters,side:sideSearchFilters};`);
 const panels=boot(document,window,createHubSearchFilters,bindSearchInput,mainSearch,sideSearch);
 const field=(side,name)=>panels[side].element.querySelector(`[name="${name}"]`);
 const edit=(side,name,value)=>{const node=field(side,name);node.value=value;node.dispatchEvent(new window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));};
 const click=(side,label)=>[...panels[side].element.querySelectorAll('button')].find(node=>node.textContent===label).click();
 t.after(()=>{panels.main.destroy();panels.side.destroy();dom.window.close();});return {document,window,calls,snapshots,panels,field,edit,click};
}
test('main and right apply filters with empty query through separate controllers',async t=>{
 const f=fixture(t);f.edit('main','type','videos');f.click('main','条件を適用');await settle();
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].searchFilters,{from:'',to:'',maxPrice:'',currency:'JPY',type:'videos'});assert.equal(f.calls[0].query,'');assert.equal(f.calls[0].side,'main');assert.equal(f.snapshots.main.filtered,true);assert.equal(f.snapshots.side,undefined);
 f.edit('side','language','ja');f.click('side','条件を適用');await settle();assert.equal(f.calls.length,2);assert.equal(f.calls[1].side,'side');assert.equal(f.calls[1].searchFilters.language,'ja');assert.equal(f.snapshots.main.filters.type,'videos');
});
test('changing conditions cancels both pending query timers and invalidates old results',async t=>{
 const f=fixture(t);f.edit('main','type','videos');f.click('main','条件を適用');await settle();
 for(const id of ['search-query','toolbar-search-input']){const node=f.document.getElementById(id);node.value='pending';node.dispatchEvent(new f.window.Event('input'));}
 f.edit('main','type','posts');await new Promise(resolve=>setTimeout(resolve,310));assert.equal(f.calls.length,1);assert.deepEqual(f.snapshots.main.data,{});assert.match(f.document.querySelector('#search-state').textContent,/適用/);
 f.click('main','条件を適用');await settle();assert.equal(f.calls[1].query,'pending');assert.equal(f.calls[1].searchFilters.type,'posts');
});
test('invalid main and right drafts block form searches and preserve user input',async t=>{
 const f=fixture(t);for(const [side,id] of [['main','hub-search'],['side','rail-search-form']]){f.edit(side,'maxPrice','1.2');f.document.getElementById(id).dispatchEvent(new f.window.Event('submit',{cancelable:true}));}
 await settle();assert.equal(f.calls.length,0);for(const side of ['main','side']){assert.equal(f.field(side,'maxPrice').value,'1.2');assert.equal(f.panels[side].element.querySelector('[role="alert"]').hidden,false);}
});
test('clearing conditions keeps the query and restores the six-source search',async t=>{
 const f=fixture(t);f.document.querySelector('#search-query').value='研究';f.edit('main','type','threads');f.click('main','条件を適用');await settle();f.click('main','条件を解除');await settle();
 assert.equal(f.calls.length,7);assert.ok(f.calls.every(call=>call.query==='研究'));assert.equal(f.document.querySelector('#toolbar-search-input').value,'研究');assert.equal(f.snapshots.main.sources.length,6);assert.equal(f.snapshots.main.filtered,false);
});
test('editing right conditions cancels its queued query without changing main conditions',async t=>{
 const f=fixture(t);f.edit('main','type','posts');f.click('main','条件を適用');await settle();const query=f.document.querySelector('#rail-search-query');query.value='pending';query.dispatchEvent(new f.window.Event('input'));f.edit('side','region','Tokyo');await new Promise(resolve=>setTimeout(resolve,310));assert.equal(f.calls.length,1);assert.equal(f.snapshots.main.filters.type,'posts');f.click('side','条件を適用');await settle();assert.equal(f.calls[1].searchFilters.region,'tokyo');
});
