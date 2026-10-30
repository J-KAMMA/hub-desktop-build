import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createStoragePanel} from './settings-view.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const MB=1024*1024;
function make(response){
  const document=new JSDOM('<body></body>').window.document;
  const opened=[];
  const panel=createStoragePanel({document,invoke:async(command,args)=>{
    if(command==='hub_origin')return 'https://hub.jkamma.com';
    if(command==='hub_client'&&args?.name==='storage'){if(response instanceof Error)throw response;return response;}
    throw new Error('unexpected '+command);
  },openExternal:async url=>{opened.push(url);}});
  document.body.append(panel.element);
  return {document,panel,opened};
}
const text=d=>d.body.textContent;

test('shows the plan, usage and a meter from the Hub status',async()=>{
  const {document,panel}=make({planCode:'M',state:'active',limitBytes:50*1024*MB,usedBytes:10*1024*MB});
  await panel.refresh();
  assert.match(text(document),/プラン M: 10\.00 GiB \/ 50\.00 GiB（20%）/);
  assert.equal(document.querySelector('[role=progressbar]').getAttribute('aria-valuenow'),'20');
  assert.equal(document.querySelector('[role=progressbar]').hidden,false);
});

test('never shows 0 on a failure or a malformed body',async()=>{
  for(const bad of [new Error('503'),{error:'unavailable'},{planCode:'free',limitBytes:0,usedBytes:0},{planCode:'free',limitBytes:100*MB}]){
    const {document,panel}=make(bad);
    await panel.refresh();
    assert.match(text(document),/読み込めません/);
    assert.equal(document.querySelector('[role=progressbar]').hidden,true);
    assert.doesNotMatch(text(document),/0(\.00)? (B|MiB|GiB)|\b0%/);
  }
});

test('warns at 80% and at the limit, and says files are not deleted',async()=>{
  const near=make({planCode:'free',limitBytes:100*MB,usedBytes:80*MB});
  await near.panel.refresh();
  assert.match(text(near.document),/80%に達しました/);
  const full=make({planCode:'free',limitBytes:100*MB,usedBytes:100*MB});
  await full.panel.refresh();
  assert.match(text(full.document),/止まっています。ファイルは消えません/);
});

test('opens the Hub storage settings, where the plan is bought',async()=>{
  const {document,panel,opened}=make({planCode:'free',limitBytes:100*MB,usedBytes:1});
  await panel.refresh();
  document.querySelector('button').click();
  await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(opened,['https://hub.jkamma.com/v2/settings#v2-settings-storage']);
});

test('is mounted in the device section and refreshed when it opens',()=>{
  assert.ok(html.includes('id="settings-storage"'));
  assert.ok(app.includes('createStoragePanel({'));
  assert.match(app,/section === "device"\)[^\n]*settingsPanels\.storage\.refresh\(\)/);
});
