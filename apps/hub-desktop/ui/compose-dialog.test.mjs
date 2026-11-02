import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM} from 'jsdom';import {createNodePostComposer} from './node-post-composer.mjs';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8'),app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const tick=()=>new Promise(setImmediate);
const doc=new JSDOM(html).window.document;
test('the feed has no composer or account callout; both live only in the compose dialog',()=>{
  const feed=doc.querySelector('#view-feed'),dialog=doc.querySelector('#compose-dialog');
  assert.ok(feed&&dialog);
  assert.equal(feed.querySelector('#composer,#composer-text,#desktop-account-callout,textarea'),null);
  assert.equal(doc.querySelectorAll('#composer').length,1);
  for(const id of ['#composer','#composer-text','#composer-post','#composer-image-add','#composer-audience','#composer-schedule','#desktop-account-callout'])assert.ok(dialog.querySelector(id),id);
  assert.ok(dialog.querySelector('#desktop-account-callout [data-account="login"]'));
});
test('投稿する opens the dialog and nothing else toggles the composer in the feed',()=>{
  assert.match(app,/function openComposeDialog\(\)[\s\S]*?showModal\(\)/u);
  assert.match(app,/#desktop-compose"\)\?\.addEventListener\("click", openComposeDialog\)/u);
  assert.doesNotMatch(app,/querySelector\("#composer"\)\.hidden=/u);
  assert.doesNotMatch(app,/navigateFrom\(\{ dataset: \{ view: "feed", title: "フィード" \}[^)]*\);\s*document\.querySelector\("\.workspace-main"\)\?\.scrollTo/u);
});
test('the dialog composer offers both Hub and node modes, and node mode keeps the same Rust command path',async()=>{
  const dom=new JSDOM(html,{url:'http://localhost/'}),d=dom.window.document,calls=[];
  const invoke=async(name,args)=>{calls.push(name);if(name==='hub_origin')return'https://hub.example';if(name==='node_public_posts')return[];if(name==='hub_peer_control')return{peers:[]};if(name==='preview_public_content')return{previewId:'p',contentId:'c',kind:'post',visibility:'public',body:args.input.body,nodeUrl:'https://n.example/'};if(name==='publish_public_content')return{status:'queued',previewId:'p',contentId:'c',sequence:1,portableEventId:'e'};if(name==='node_public_post_control')return{sequence:1,portableEventId:'e'};throw Error('unexpected '+name);};
  const form=d.querySelector('#compose-dialog #composer'),text=d.querySelector('#composer-text'),post=d.querySelector('#composer-post'),note=d.querySelector('#composer-note');
  const c=createNodePostComposer({document:d,invoke,form,textarea:text,post,note,getAccount:()=>({state:'signed_out'}),hasImages:()=>false,audience:d.querySelector('#composer-audience'),scheduledAt:d.querySelector('#composer-schedule-at'),manage:()=>{}});
  await tick();
  const mode=d.querySelector('#compose-dialog #composer-storage');assert.ok(mode);assert.deepEqual([...mode.options].map(o=>o.value),['hub','node']);
  mode.value='node';mode.onchange();await tick();
  assert.equal(post.textContent,'公開内容を確認');assert.equal(text.disabled,false);
  text.value='dialog node post';text.dispatchEvent(new dom.window.Event('input'));
  assert.equal(await c.submit(),true);await tick();
  assert.deepEqual(calls.filter(n=>n==='preview_public_content'),['preview_public_content']);
  d.querySelector('[data-confirm]').click();await tick();await tick();
  assert.ok(calls.includes('publish_public_content'));assert.ok(calls.includes('node_public_post_control'));
  assert.equal(text.value,'');
});
