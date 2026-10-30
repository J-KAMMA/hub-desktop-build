import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createSettingsNav, createIdentityPanel, createCachePanel, createBrowserPanel, createAboutPanel, validActorUrl, formatBytes, confirmInline} from './settings-view.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,0));};
const page=()=>new JSDOM(readFileSync(new URL('./index.html',import.meta.url),'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g,''));
const buttonByText=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);

test('every nav item has a panel and selecting switches panel, aria-current and callback',()=>{
  const dom=page(),document=dom.window.document,seen=[];
  const nav=createSettingsNav({document,onSelect:s=>seen.push(s)});
  const items=[...document.querySelectorAll('#view-settings .inner-nav-item')].map(i=>i.dataset.settingsSec);
  assert.deepEqual(items,['account','appearance','notifications','privacy','ai','wallet','browser','device','advanced','app-info']);
  for(const id of items)assert.ok(document.querySelector(`[data-settings-panel="${id}"]`),id);
  for(const id of items){
    document.querySelector(`[data-settings-sec="${id}"]`).click();
    assert.equal([...document.querySelectorAll('[data-settings-panel]')].filter(p=>!p.hidden).map(p=>p.dataset.settingsPanel).join(),id);
    assert.equal(document.querySelectorAll('#view-settings .inner-nav-item[aria-current]').length,1);
    assert.equal(document.querySelector(`[data-settings-sec="${id}"]`).getAttribute('aria-current'),'page');
  }
  assert.deepEqual(seen,items);assert.equal(nav.select('nope'),false);
  assert.doesNotMatch(document.querySelector('#view-settings').textContent,/まだありません/);
});
test('old section names still open the section that now holds them',()=>{
  const dom=page(),document=dom.window.document,seen=[];
  const nav=createSettingsNav({document,onSelect:s=>seen.push(s)});
  for(const [old,now] of [['identity','advanced'],['about','advanced'],['other','advanced'],['account','account'],['device','device'],['notifications','notifications']]){
    assert.equal(nav.select(old),true,old);
    assert.equal([...document.querySelectorAll('[data-settings-panel]')].filter(p=>!p.hidden).map(p=>p.dataset.settingsPanel).join(),now);
    assert.equal(document.querySelector(`[data-settings-sec="${now}"]`).getAttribute('aria-current'),'page');
  }
  assert.ok(document.querySelector('[data-settings-anchor="identity"]').closest('[data-settings-panel="advanced"]'));
  assert.ok(document.querySelector('[data-settings-anchor="about"]').closest('[data-settings-panel="advanced"]'));
});
test('helpers',()=>{
  assert.equal(validActorUrl('https://hub.example/users/a'),true);assert.equal(validActorUrl('http://x/y'),false);assert.equal(validActorUrl('https://a b'),false);assert.equal(validActorUrl(5),false);
  assert.equal(formatBytes(512),'512 B');assert.equal(formatBytes(5*1024**2),'5.0 MiB');assert.equal(formatBytes(-1),'不明');
});
test('identity: shows public key, signs only after confirmation, never sends',async()=>{
  const dom=new JSDOM('<body></body>'),document=dom.window.document,calls=[];
  const invoke=async(c,a)=>{calls.push([c,a]);if(c==='portable_identity_public')return{didKey:'did:key:zABC'};if(c==='portable_identity_sign_move')return{type:'Move',target:a.newActor};throw Error('unexpected '+c);};
  const p=createIdentityPanel({document,invoke});document.body.append(p.element);await p.refresh();
  assert.equal(p.element.querySelector('input[aria-label^="公開している根鍵"]').value,'did:key:zABC');
  const [oldIn,newIn]=p.element.querySelectorAll('input[type=url]');
  const move=buttonByText(p.element,'引っ越し宣言を作る');
  oldIn.value='http://insecure/u';newIn.value='https://new.example/u';move.click();
  assert.equal(calls.filter(c=>c[0].includes('sign')).length,0);assert.match(p.element.textContent,/https:\/\/ で始まる/);
  oldIn.value='https://old.example/u';move.click();
  assert.equal(calls.filter(c=>c[0].includes('sign')).length,0,'no signing before confirm');
  buttonByText(p.element.querySelector('.settings-confirm'),'署名する').click();await settle();
  assert.deepEqual(calls.at(-1),['portable_identity_sign_move',{oldActor:'https://old.example/u',newActor:'https://new.example/u'}]);
  assert.match(p.element.querySelector('textarea').value,/"Move"/);assert.equal(p.element.querySelector('.settings-confirm'),null);
});
test('identity: cancel signs nothing; missing key disables the controls',async()=>{
  const dom=new JSDOM('<body></body>'),document=dom.window.document;let signed=0;
  const bad=createIdentityPanel({document,invoke:async()=>{throw Error('portable_identity_unavailable');}});await bad.refresh();
  assert.ok([...bad.element.querySelectorAll('button')].filter(b=>/作る/.test(b.textContent)).every(b=>b.disabled));
  const ok=createIdentityPanel({document,invoke:async c=>{if(c==='portable_identity_public')return{didKey:'did:key:z'};signed++;return{};}});await ok.refresh();
  const urls=ok.element.querySelectorAll('input[type=url]');urls[2].value='https://h.example/u';
  buttonByText(ok.element,'登録文を作る').click();
  buttonByText(ok.element.querySelector('.settings-confirm'),'やめる').click();await settle();
  assert.equal(signed,0);assert.equal(ok.element.querySelector('.settings-confirm'),null);
});
test('cache: usage shown, clear needs confirmation',async()=>{
  const dom=new JSDOM('<body></body>'),document=dom.window.document,calls=[];let used=[5*1024**2,3];
  const p=createCachePanel({document,invoke:async c=>{calls.push(c);if(c==='media_cache_usage')return used;if(c==='media_cache_clear'){used=[0,0];return;}}});
  await p.refresh();assert.match(p.element.textContent,/5\.0 MiB（3件）/);
  buttonByText(p.element,'キャッシュを消す').click();assert.equal(calls.includes('media_cache_clear'),false);
  p.element.querySelector('.settings-confirm .approve').click();await settle();
  assert.equal(calls.includes('media_cache_clear'),true);assert.match(p.element.textContent,/0 B（0件）/);
});
test('browser: toggle writes protection and an unreadable state disables it',async()=>{
  const dom=new JSDOM('<body></body>'),document=dom.window.document,calls=[];let enabled=false;
  const p=createBrowserPanel({document,invoke:async(c,a)=>{calls.push([c,a]);if(c==='browser_set_protection')enabled=a.enabled;return{supported:true,enabled,ready:true};}});
  await p.refresh();const box=p.element.querySelector('input');assert.equal(box.disabled,false);
  box.checked=true;box.dispatchEvent(new dom.window.Event('change'));await settle();
  assert.deepEqual(calls.find(c=>c[0]==='browser_set_protection')[1],{enabled:true});assert.equal(box.checked,true);
  const dead=createBrowserPanel({document,invoke:async()=>{throw Error('x');}});await dead.refresh();assert.equal(dead.element.querySelector('input').disabled,true);
});
test('about: version, mode, hub host and AGPL licence',async()=>{
  const dom=new JSDOM('<body></body>'),document=dom.window.document;
  const p=createAboutPanel({document,invoke:async c=>c==='desktop_build_mode'?'development':'https://hub.jkamma.com',getVersion:async()=>'0.1.0'});await p.refresh();
  const text=p.element.textContent;assert.match(text,/0\.1\.0/);assert.match(text,/開発版/);assert.match(text,/hub\.jkamma\.com/);assert.match(text,/AGPL-3\.0（ハブ本体）/);
  const broken=createAboutPanel({document,invoke:async()=>{throw Error('x');},getVersion:()=>{throw Error('x');}});await broken.refresh();assert.match(broken.element.textContent,/不明/);
});
test('confirmInline runs nothing until yes',async()=>{
  const dom=new JSDOM('<body><div id=h></div></body>'),document=dom.window.document,host=document.querySelector('#h');let ran=0;
  confirmInline(document,host,{message:'m',yes:'はい',onYes:async()=>{ran++;}});assert.equal(ran,0);
  host.querySelector('.approve').click();await settle();assert.equal(ran,1);assert.equal(host.children.length,0);
});
