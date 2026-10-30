import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createBrowserAutoplay,pageSite} from './browser-autoplay-ui.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const policy=(extra={})=>({version:1,block:true,allowedSites:['youtube.com','nicovideo.jp','twitch.tv'],...extra});
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate());}
function rig(t,{url='https://news.example.org/a',respond}={}){
  const dom=new JSDOM('<main id="view-browser"></main>'),document=dom.window.document,calls=[],errors=[];let value=policy(),page=url;
  const controller=createBrowserAutoplay({document,getUrl:()=>page,onError:error=>errors.push(error),invoke:async(name,args)=>{
    calls.push({name,args});if(respond)return respond(name,args);
    if(name==='browser_set_autoplay'){
      if('block' in args)value={...value,block:args.block};
      if('site' in args)value={...value,allowedSites:args.allowed?[args.site,...value.allowedSites.filter(s=>s!==args.site)]:value.allowedSites.filter(s=>s!==args.site)};
    }
    return structuredClone(value);}});
  document.querySelector('main').append(controller.element);t.after(()=>dom.window.close());
  const [block,here]=controller.element.querySelectorAll('input');
  const change=(input,checked)=>{input.checked=checked;input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
  return {dom,calls,errors,controller,block,here,change,setUrl:next=>{page=next;}};
}

test('page site matches the native normalization and ignores non-web pages',()=>{
  assert.equal(pageSite('https://www.YouTube.com/watch?v=x'),'youtube.com');
  assert.equal(pageSite('http://sub.example.org:8080/'),'sub.example.org');
  for(const url of ['http://tauri.localhost/new-tab.html','about:blank','file:///c:/x','https://127.0.0.1/','not a url',''])
    assert.equal(pageSite(url),null,url);
});

test('construction does not invoke; load shows the default block and current site',async t=>{
  const r=rig(t);assert.deepEqual(r.calls,[]);await r.controller.load();
  assert.deepEqual(r.calls,[{name:'browser_autoplay_status',args:{}}]);
  assert.equal(r.block.checked,true);assert.equal(r.here.checked,false);
  assert.match(r.controller.element.textContent,/このサイトでは自動再生する（news\.example\.org）/);
  assert.match(r.controller.element.textContent,/自動再生するサイト（3件）/);
  assert.match(r.controller.element.textContent,/次に読み込んだときから/);
});

test('allowing the current site sends only its site, and removing from the list sends that site',async t=>{
  const r=rig(t);await r.controller.load();r.change(r.here,true);
  await until(()=>r.here.disabled===false&&r.calls.length===2);
  assert.deepEqual(r.calls[1],{name:'browser_set_autoplay',args:{site:'news.example.org',allowed:true}});
  assert.equal(r.here.checked,true);
  const remove=[...r.controller.element.querySelectorAll('li button')].find(button=>button.getAttribute('aria-label').startsWith('news.example.org'));
  remove.click();await until(()=>r.calls.length===3&&r.here.disabled===false);
  assert.deepEqual(r.calls[2].args,{site:'news.example.org',allowed:false});assert.equal(r.here.checked,false);
});

test('an allowance inherited from a parent site shows checked but is changed from the list only',async t=>{
  const r=rig(t,{url:'https://m.youtube.com/watch?v=x'});await r.controller.load();
  assert.equal(r.here.checked,true);assert.equal(r.here.disabled,true);
});

test('turning blocking off hides the site controls; no web page hides the site row',async t=>{
  const r=rig(t);await r.controller.load();r.change(r.block,false);
  await until(()=>r.block.disabled===false&&r.calls.length===2);
  assert.deepEqual(r.calls[1].args,{block:false});assert.equal(r.here.closest('label').hidden,true);
  r.setUrl('http://tauri.localhost/new-tab.html');r.change(r.block,true);await until(()=>r.calls.length===3&&r.block.disabled===false);
  assert.equal(r.here.closest('label').hidden,true);
});

test('malformed or failed replies fail closed to an unusable control and report once per failure',async t=>{
  const r=rig(t,{respond:()=>({version:1,block:'yes',allowedSites:[]})});await r.controller.load();
  assert.equal(r.block.disabled,true);assert.equal(r.here.disabled,true);
  assert.deepEqual(r.errors,[{code:'browser_autoplay_unavailable'}]);
  const bad=rig(t,{respond:()=>policy({allowedSites:['</script>']})});await bad.controller.load();assert.equal(bad.block.disabled,true);
});

test('a page change under the open panel never toggles the new site unseen',async t=>{
  const r=rig(t,{url:'https://a.example.org/'});await r.controller.load();
  r.setUrl('https://b.example.org/');r.change(r.here,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.calls.some(call=>call.name==='browser_set_autoplay'),false);
  assert.match(r.controller.element.textContent,/b\.example\.org/);assert.equal(r.here.checked,false);
});
