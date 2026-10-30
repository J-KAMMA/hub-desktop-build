
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {appendResearchBacklinks,appendResearchUpdates} from './research-discovery.mjs';
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function bindings(dom,invoke,opened){
  const functions=app.match(/async function appendResearchBacklinks\(target,kind,id,current=\(\)=>true\) \{[\s\S]+?(?=async function openDetail)/)?.[0];
  assert.ok(functions,'Actual app wrappers must be present');
  const guards=[];
  const apply=record=>{if(record.current&&!record.current())return false;opened.push(record.destination);return true;};
  const openProject=(name,ids,options)=>{const record={raw:[name,ids,options],current:options.isCurrent,destination:[name,ids,{title:options.title}]};guards.push(record);return apply(record);};
  const openPath=(href,title,current)=>{const record={raw:[href,title,current],current,destination:[href,title]};guards.push(record);return apply(record);};
  const api=new Function('renderResearchBacklinks','appendResearchUpdates','invoke','openDetail','openHubPath',`let desktopAccount={},homeAccountEpoch={};${functions};return {backlinks:appendResearchBacklinks,updates:renderFeedResearchUpdates,changeAccount(){desktopAccount={};homeAccountEpoch={};}}`)(appendResearchBacklinks,appendResearchUpdates,invoke,openProject,openPath);
  return {...api,guards,async replay(index,before){const record=guards[index];await before;return apply(record);}};
}
test('app bindings discard backlinks after account identity change and retain fixed detail destination',async()=>{
  const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),opened=[];
  const api=bindings(dom,async()=>({projects:[{id:'rp_1',title:'Project'}]}),opened);
  const controller=await api.backlinks(target,'thread','t_1');await controller.ready;
  const button=target.querySelector('button');button.click();
  assert.deepEqual(opened,[['research_project',['rp_1'],{title:'Project'}]]);
  api.changeAccount();button.click();assert.equal(opened.length,1);
  controller.dispose();dom.window.close();
});
test('app feed binding and actual path parser open the displayed revision and suppress stale clicks',()=>{
  const dom=new JSDOM('<main><article>Existing post</article></main>'),target=dom.window.document.querySelector('main'),opened=[];
  const api=bindings(dom,()=>{},opened),href='/v2/research/rp_1?document=d_1&version=2';
  const root=api.updates(target,[{id:'d_1',title:'Document',projectId:'rp_1',projectTitle:'Project',version:2,kind:'research',updatedAt:'2026-10-04',href}]);
  root.querySelector('button').click();assert.deepEqual(opened,[[href,'Document']]);
  const parser=app.match(/function detailForHubPath\(path\) \{[\s\S]+?(?=\/\/ Hubpedia)/)?.[0];assert.ok(parser);
  const actualParser=new Function(`${parser};return detailForHubPath;`)();
  assert.deepEqual(actualParser(href),{name:'research_revision',ids:['rp_1','d_1','2'],title:'文書 · v2'});
  assert.equal(target.querySelector('article').textContent,'Existing post');
  api.changeAccount();root.querySelector('button').click();assert.equal(opened.length,1);
  assert.ok(app.includes('renderFeedResearchUpdates(feed.list,result.researchUpdates,current);'));
  dom.window.close();
});
test('app preserves optional omitted updates on local feed failure or older response',()=>{
  const dom=new JSDOM('<main><article>Existing post</article></main>'),target=dom.window.document.querySelector('main');
  const api=bindings(dom,()=>{},[]);
  assert.equal(api.updates(target,undefined),null);
  assert.equal(target.children.length,1);assert.equal(target.textContent,'Existing post');
  dom.window.close();
});

test('actual app opens only canonical music work pages',()=>{
 const parser=app.match(/function detailForHubPath\(path\) \{[\s\S]+?(?=\/\/ Hubpedia)/)?.[0];assert.ok(parser);
 const parse=new Function(`${parser};return detailForHubPath;`)();
 for(const id of ['catalog','music:00000000-0000-4000-8000-000000000000'])assert.deepEqual(parse('/v2/music/works/'+encodeURIComponent(id)),{name:'music_work',ids:[id],title:'音楽作品'});
 for(const path of ['/v2/music/works/catalog?token=secret','/v2/music/works/music:00000000-0000-4000-8000-000000000000','/v2/music/works/../x','/v2/music/works/catalog\n','/v2/music/works/%252F'])assert.equal(parse(path),null);
});
test('market product paths no longer open a native detail',()=>{
 const parser=app.match(/function detailForHubPath\(path\) \{[\s\S]+?(?=\/\/ Hubpedia)/)?.[0];const parse=new Function(`${parser};return detailForHubPath;`)();
 for(const path of ['/v2/market/products/pr1','/market/products/pr1','/v2/market/products/%E5%95%86','/v2/market/products/'])assert.equal(parse(path),null);
});
test('actual parent navigation guards remain captured and reject delayed stale destinations',async()=>{
  for(const kind of ['project','revision']){
    const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),opened=[];
    const api=bindings(dom,async()=>({projects:[{id:'rp_1',title:'Project'}]}),opened);
    let controller;
    if(kind==='project'){controller=await api.backlinks(target,'thread','t_1');await controller.ready;}
    else api.updates(target,[{id:'d_1',title:'Document',projectId:'rp_1',projectTitle:'Project',version:2,kind:'research',updatedAt:'2026-10-04',href:'/v2/research/rp_1?document=d_1&version=2'}]);
    target.querySelector('button').click();
    assert.equal(typeof api.guards[0].current,'function');
    assert.equal(typeof(kind==='project'?api.guards[0].raw[2].isCurrent:api.guards[0].raw[2]),'function');
    assert.equal(api.guards[0].current(),true);
    let resume;const currentDelay=new Promise(resolve=>{resume=resolve;});
    const current=api.replay(0,currentDelay);assert.equal(opened.length,1);resume();assert.equal(await current,true);assert.equal(opened.length,2);
    const staleDelay=new Promise(resolve=>{resume=resolve;}),stale=api.replay(0,staleDelay);
    api.changeAccount();assert.equal(api.guards[0].current(),false);resume();assert.equal(await stale,false);assert.equal(opened.length,2);
    controller?.dispose();dom.window.close();
  }
});
