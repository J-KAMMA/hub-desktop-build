import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createHubNetwork} from './hub-network.mjs';

test('only canonical research cards can open a fork and the source is checked again on click',async t=>{
  const dom=new JSDOM('<section id="view-node"></section>',{url:'http://localhost'});t.after(()=>dom.window.close());
  dom.window.localStorage.setItem('hub.network.sources.v1',JSON.stringify(['https://remote.example']));
  const opened=[],id=`rp_${'a'.repeat(32)}`,origin='https://remote.example';
  const network=createHubNetwork({document:dom.window.document,storage:dom.window.localStorage,changed:()=>{},manage:()=>{},openWeb:()=>{},openResearchFork:item=>opened.push(item),invoke:async name=>name==='hub_origin'?'https://main.example':{items:[]}});
  await network.ready;
  const item={id,origin,path:`/v2/research/${id}`,title:'Remote',summary:''};
  const fork=card=>[...card.querySelectorAll('button')].find(b=>b.textContent==='自分のHubへfork');
  fork(network.card(item)).click();assert.deepEqual(opened,[item]);
  for(const changed of [{path:`/v2/posts/${id}`},{path:`/v2/market/products/${id}`},{id:'other'},{id:id+'\n'}])assert.equal(fork(network.card({...item,...changed})),undefined);
  fork(network.card({...item,origin:'https://unconnected.example'})).click();assert.equal(opened.length,1);
});
