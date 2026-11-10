import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserProtectionSite} from './browser-protection-site-ui.mjs';

class El{constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.hidden=false;this.disabled=false;this.checked=false;this.textContent='';}
  append(...c){this.children.push(...c);}setAttribute(k,v){this.attrs[k]=v;}}
const doc={createElement:t=>new El(t)};
const setup=(url,reply)=>{
  const calls=[];let current=url;
  const invoke=async(name,args)=>{calls.push({name,args});return reply(name,args);};
  const view=createBrowserProtectionSite({document:doc,invoke,getUrl:()=>current,getTabId:()=>7});
  const [count,label]=view.element.children;const input=label.children[0];
  return {view,calls,count,label,input,setUrl:u=>{current=u;}};
};
const status=(n,sites=[])=>({version:1,tabBlockedCount:n,allowedSites:sites});

test('construction does no IPC and shows an unconfirmed count',()=>{
  const t=setup('https://news.example/a',()=>status(0));
  assert.equal(t.calls.length,0);assert.match(t.count.textContent,/未確認/);assert.equal(t.input.disabled,true);
});
test('load shows the number for this tab and the site switch state',async()=>{
  const t=setup('https://www.news.example/a',()=>status(1234,['news.example']));
  await t.view.load();
  assert.deepEqual(t.calls,[{name:'browser_protection_site_status',args:{tab:7}}]);
  assert.match(t.count.textContent,/1,234件/);assert.equal(t.input.checked,true);assert.equal(t.label.hidden,false);
});
test('toggle sends the page site and the new allowed value',async()=>{
  const t=setup('https://news.example/a',(name,args)=>name==='browser_set_protection_site'?status(3,args.allowed?['news.example']:[]):status(3));
  await t.view.load();t.input.checked=true;t.input.onchange();await new Promise(r=>setTimeout(r));
  assert.deepEqual(t.calls.at(-1),{name:'browser_set_protection_site',args:{site:'news.example',allowed:true,tab:7}});
  assert.equal(t.input.checked,true);
});
test('non-web pages hide the switch and send nothing',async()=>{
  const t=setup('about:blank',()=>status(0));await t.view.load();
  assert.equal(t.label.hidden,true);t.input.onchange();assert.equal(t.calls.length,1);
});
test('malformed or failed status never enables the switch',async()=>{
  for(const bad of [null,{version:1,tabBlockedCount:-1,allowedSites:[]},{version:1,tabBlockedCount:0,allowedSites:['bad host']},{version:2,tabBlockedCount:0,allowedSites:[]}]){
    const t=setup('https://news.example/',()=>bad);await t.view.load();
    assert.equal(t.input.disabled,true);assert.match(t.count.textContent,/未確認/);
  }
});
test('a site inherited from a parent cannot be unset from the child',async()=>{
  const t=setup('https://m.news.example/',()=>status(0,['news.example']));await t.view.load();
  assert.equal(t.input.checked,true);assert.equal(t.input.disabled,true);
});
