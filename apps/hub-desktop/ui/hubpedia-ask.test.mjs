import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {REFUSAL,parseEvidence,buildPrompt,checkAnswer,splitSentences,renderCitations} from './hubpedia-ask.mjs';
import {apiRef,createConnectionChat} from './byok-chat.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,0));};
const ID='11111111-1111-4111-8111-111111111111';

const claim={kind:'claim',id:'c1',text:'富士山の標高は3776メートルである。',title:'富士山',url:'https://hub.jkamma.com/hubpedia/fuji',status:'verified',source:{url:'https://example.org/a',publisher:'国土地理院'}};
const wiki={kind:'wikipedia',id:'w1',text:'東京は日本の首都であり、人口が最も多い都市である。',title:'東京都',url:'https://hub.jkamma.com/hubpedia/tokyo',status:'unverified',source:{url:'https://ja.wikipedia.org/wiki/東京都',publisher:'Wikipedia',historyUrl:'https://ja.wikipedia.org/w/index.php?title=東京都&action=history',licence:'CC-BY-SA-4.0'}};
const body={version:1,items:[claim,wiki]};

test('evidence parsing keeps the versioned shape and drops unattributable Wikipedia items',()=>{
  assert.equal(parseEvidence(body).length,2);
  assert.deepEqual(parseEvidence({version:2,items:[claim]}),[]);
  assert.deepEqual(parseEvidence(null),[]);
  const noHistory={...wiki,source:{...wiki.source,historyUrl:undefined}};
  assert.equal(parseEvidence({version:1,items:[noHistory,{...claim,url:'javascript:alert(1)'},{...claim,status:'x'}]}).length,0);
});

test('prompt carries only the question and numbered items',()=>{
  const p=buildPrompt('富士山の高さは',parseEvidence(body));
  assert.match(p,/質問: 富士山の高さは/);assert.match(p,/\[1\] （富士山）/);assert.match(p,/\[2\] （東京都）/);
  assert.ok(!p.includes('example.org'));
});

test('post-check drops uncited, out-of-range and unrelated sentences, and refuses when nothing survives',()=>{
  const items=parseEvidence(body);
  const r=checkAnswer('富士山の標高は3776メートルです。[1]\n根拠のない文です。\n東京は首都です。[9]\n猫は動物だと言われる。[1]',items);
  assert.equal(r.grounded,true);assert.deepEqual(r.answer.split('\n'),['富士山の標高は3776メートルです。[1]']);
  assert.deepEqual(r.citations.map(c=>c.n),[1]);assert.equal(r.citations[0].attribution,null);
  const w=checkAnswer('東京は日本の首都です。[2]',items);
  assert.equal(w.citations[0].attribution.history,new URL(wiki.source.historyUrl).toString());assert.match(w.citations[0].attribution.text,/CC BY-SA/);
  for(const out of ['',`${REFUSAL}[1]`,'根拠なし。','猫は動物だと言われる。[1]'])assert.deepEqual(checkAnswer(out,items),{answer:REFUSAL,citations:[],grounded:false},out);
  assert.equal(checkAnswer('富士山の標高は3776メートルです。[1]',[]).grounded,false);
  assert.deepEqual(splitSentences('a。[1] b。[2]'),['a。[1]','b。[2]']);
});

test('citations render titles, status badges and Wikipedia attribution links as buttons',()=>{
  const document=new JSDOM('<div></div>').window.document,opened=[];
  const box=renderCitations(document,checkAnswer('富士山の標高は3776メートルです。[1]\n東京は日本の首都です。[2]',parseEvidence(body)),u=>opened.push(u));
  assert.match(box.textContent,/確認済み/);assert.match(box.textContent,/未検証/);assert.match(box.textContent,/元の頁/);assert.match(box.textContent,/編集履歴/);
  [...box.querySelectorAll('button')].find(b=>b.textContent==='編集履歴').click();
  assert.deepEqual(opened,[new URL(wiki.source.historyUrl).toString()]);assert.equal(box.querySelector('a'),null);
});

function setup({retrieveBody=body}={}){
  const document=new JSDOM('<div class="piw-shell"><div class="piw-timeline-wrap"><div id="t"></div></div></div>').window.document;
  const sent=[],handlers=[],retrieved=[];
  const invoke=async(name,args)=>{sent.push([name,args]);return name==='byok_chat_start'?'req-1':null;};
  const listen=async(n,cb)=>{handlers.push(cb);return()=>{};};
  const host=document.querySelector('.piw-timeline-wrap');
  const chat=createConnectionChat({document,invoke,listen,host,timeline:document.querySelector('#t')});
  const retrieve=async(q)=>{retrieved.push(q);return retrieveBody;};
  return {chat,sent,retrieved,retrieve,host,emit:p=>handlers.forEach(h=>h({payload:p}))};
}

test('asking sends the retrieval query, then only the question and items to the chosen model, and shows only checked text',async()=>{
  const t=setup();
  assert.equal(await t.chat.askHubpedia('富士山の高さは？',apiRef(ID,'m1'),'m1',{retrieve:t.retrieve}),true);
  await settle();
  assert.deepEqual(t.retrieved,['富士山の高さは?']);
  const start=t.sent.find(s=>s[0]==='byok_chat_start')[1].input;
  assert.equal(start.messages.length,1);assert.match(start.messages[0].content,/\[1\] （富士山）/);
  t.emit({requestId:'req-1',type:'delta',text:'富士山の標高は3776メートルです。[1]'});t.emit({requestId:'req-1',type:'delta',text:'\n余計な文です。'});
  assert.equal(t.host.querySelector('.byok-assistant').textContent,'ハブペディアを調べています…');
  t.emit({requestId:'req-1',type:'done'});await settle();
  assert.equal(t.host.querySelector('.byok-assistant').textContent,'富士山の標高は3776メートルです。[1]');
  assert.ok(t.host.querySelector('.hubpedia-ask-sources'));assert.equal(t.chat.isBusy(),false);
  assert.match(t.host.querySelector('.byok-status').textContent,/資料は2件/);
});

test('empty retrieval refuses without calling the model; an ungrounded answer is refused too',async()=>{
  const none=setup({retrieveBody:{version:1,items:[]}});
  await none.chat.askHubpedia('何か',apiRef(ID,'m1'),'m1',{retrieve:none.retrieve});await settle();
  assert.equal(none.host.querySelector('.byok-assistant').textContent,REFUSAL);
  assert.equal(none.sent.some(s=>s[0]==='byok_chat_start'),false);assert.equal(none.chat.isBusy(),false);
  const broken=setup();
  await broken.chat.askHubpedia('x質問',apiRef(ID,'m1'),'m1',{retrieve:async()=>{throw new Error('down');}});await settle();
  assert.equal(broken.host.querySelector('.byok-assistant').textContent,REFUSAL);
  const bad=setup();
  await bad.chat.askHubpedia('富士山',apiRef(ID,'m1'),'m1',{retrieve:bad.retrieve});await settle();
  bad.emit({requestId:'req-1',type:'delta',text:'月は地球の衛星です。[1]'});bad.emit({requestId:'req-1',type:'done'});await settle();
  assert.equal(bad.host.querySelector('.byok-assistant').textContent,REFUSAL);assert.equal(bad.host.querySelector('.hubpedia-ask-sources'),null);
});

test('provider errors keep the fixed message and the exchange is not added to chat history',async()=>{
  const t=setup();
  await t.chat.askHubpedia('富士山',apiRef(ID,'m1'),'m1',{retrieve:t.retrieve});await settle();
  t.emit({requestId:'req-1',type:'error',code:'byok_auth_failed'});await settle();
  assert.match(t.host.querySelector('.byok-status').textContent,/APIキー/);assert.equal(t.chat.isBusy(),false);
  await t.chat.send('普通の会話',apiRef(ID,'m1'));
  assert.deepEqual(t.sent.at(-1)[1].input.messages,[{role:'user',content:'普通の会話'}]);
});
