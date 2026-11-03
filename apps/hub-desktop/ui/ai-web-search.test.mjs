import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {createWebSearch,parseResults,withSearchContext,searchErrorText} from './ai-web-search.mjs';
import {createConnectionChat,apiRef} from './byok-chat.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const ID='11111111-1111-4111-8111-111111111111';
const html='<div class="piw-shell"><div class="piw-timeline-wrap"><div id="t"></div></div></div><input id="pi-work-web-search" type="checkbox"><p id="pi-work-web-search-note"></p>';

function setup({search}={}){
  const dom=new JSDOM(html),document=dom.window.document,calls=[];
  const invoke=async(name,args)=>{calls.push([name,args]);if(name==='web_search_chat')return search(args);if(name==='byok_chat_start')return 'req-1';return null;};
  const chat=createConnectionChat({document,invoke,listen:async()=>()=>{},host:document.querySelector('.piw-timeline-wrap'),timeline:document.querySelector('#t')});
  return {chat,calls,box:document.querySelector('#pi-work-web-search')};
}

test('the toggle ships unchecked in the page and starts off',()=>{
  const page=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const tag=/<input[^>]*id="pi-work-web-search"[^>]*>/.exec(page)?.[0]??'';
  assert.ok(tag);assert.doesNotMatch(tag,/\bchecked\b/);
  const {box}=setup();assert.equal(box.checked,false);
  const dom=new JSDOM(html),w=createWebSearch({document:dom.window.document,invoke:async()=>null});
  assert.equal(w.enabled(),false);
});

test('with the toggle off, chat never calls the search',async()=>{
  const t=setup({search:()=>{throw Error('must not run');}});
  assert.equal(await t.chat.send('質問',apiRef(ID,'m')),true);
  assert.deepEqual(t.calls.map(c=>c[0]),['byok_chat_start']);
  assert.equal(t.calls[0][1].input.messages.at(-1).content,'質問');
});

test('with the toggle on, results ride on the question only and reset turns it off',async()=>{
  const t=setup({search:()=>({results:[{title:'Rust',url:'https://www.rust-lang.org/',snippet:'s',engine:'wikipedia_ja'},{title:'bad',url:'javascript:1',snippet:'',engine:'x'}]})});
  t.box.checked=true;
  await t.chat.send('Rustとは',apiRef(ID,'m'));
  assert.deepEqual(t.calls.map(c=>c[0]),['web_search_chat','byok_chat_start']);
  assert.deepEqual(t.calls[0][1],{query:'Rustとは'});
  const sent=t.calls[1][1].input.messages.at(-1).content;
  assert.match(sent,/^Rustとは/);assert.match(sent,/\[1\] Rust\nhttps:\/\/www\.rust-lang\.org\//);assert.doesNotMatch(sent,/javascript:/);
  assert.ok(t.chat.isBusy()===true);
  // finish the stream so reset is allowed
  t.chat.destroy();
});

test('a denied search still answers, without search context',async()=>{
  const t=setup({search:()=>{throw new Error('approval_denied');}});
  t.box.checked=true;
  await t.chat.send('質問',apiRef(ID,'m'));
  assert.equal(t.calls[1][1].input.messages.at(-1).content,'質問');
});

test('result parsing and context building are bounded',()=>{
  assert.deepEqual(parseResults(null),[]);
  const many=Array.from({length:30},(_,i)=>({title:`t${i}`,url:`https://a.example/${i}`,snippet:'x'.repeat(900),engine:'e'}));
  const out=parseResults({results:many});assert.equal(out.length,10);assert.equal(out[0].snippet.length,400);
  assert.ok(withSearchContext('q',out).length<7000);assert.equal(withSearchContext('q',[]),'q');
  assert.match(searchErrorText(new Error('approval_denied')),/承認されません/);
  assert.doesNotMatch(searchErrorText(new Error('secret rust query')),/secret/);
});
