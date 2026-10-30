import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {apiRef,cliRef,parseRef,mergeCatalog,errorCode,errorText,createConnectionModels,createConnectionChat,BILLING_NOTE} from './byok-chat.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,0));};
const ID='11111111-1111-4111-8111-111111111111';

test('refs round trip and foreign values are not ours',()=>{
  assert.deepEqual(parseRef(apiRef(ID,'anthropic/claude-sonnet-4.5')),{source:'api',id:ID,model:'anthropic/claude-sonnet-4.5'});
  assert.deepEqual(parseRef(cliRef('claude','sonnet')),{source:'cli',id:'claude',model:'sonnet'});
  assert.deepEqual(parseRef(cliRef('codex',null)),{source:'cli',id:'codex',model:null});
  for(const bad of ['', 'gpt-5', 'openai/gpt-5','byok:','byok:x','byok:x/','cli:/m',null,5])assert.equal(parseRef(bad),null,String(bad));
});

test('catalog merge adds connections and CLIs without touching existing entries',()=>{
  const base={models:['openai/gpt-5'],ready:['openai/gpt-5'],default:'openai/gpt-5',locations:{'openai/gpt-5':'local'}};
  const {catalog,groups}=mergeCatalog(base,[
    {kind:'api',id:ID,name:'私のOpenRouter',models:['a/b','c']},
    {kind:'cli',id:'claude',name:'Claude Code',models:['sonnet']},
  ]);
  assert.deepEqual(catalog.models,['openai/gpt-5',apiRef(ID,'a/b'),apiRef(ID,'c'),cliRef('claude',null),cliRef('claude','sonnet')]);
  assert.equal(catalog.locations[apiRef(ID,'c')],'api');assert.equal(catalog.locations[cliRef('claude','sonnet')],'cli');
  assert.ok(catalog.ready.includes(apiRef(ID,'c')));
  assert.equal(groups[apiRef(ID,'c')],'私のOpenRouter');assert.equal(groups[cliRef('claude',null)],'Claude Code（CLI）');
  assert.equal(catalog.default,'openai/gpt-5');assert.deepEqual(base.models,['openai/gpt-5']);
  const none=mergeCatalog({models:['m']},[{kind:'api',id:ID,name:'x',models:['bad model']}]);
  assert.deepEqual(none.catalog.models,['m']);
  assert.equal('ready' in none.catalog,false);
});

test('model wrapper survives a failing connection list and remembers only our refs',async()=>{
  const calls=[],store=new Map();
  const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  const invoke=async(name)=>{calls.push(name);if(name==='byok_models')throw Error('boom');return {models:['m']};};
  const wrapper=createConnectionModels({invoke,storage});
  assert.deepEqual(await wrapper.invoke('pi_work_models',{}),{models:['m']});
  assert.deepEqual(await wrapper.invoke('dev_agents'),{models:['m']});
  assert.deepEqual(calls,['pi_work_models','byok_models','dev_agents']);
  wrapper.remember(apiRef(ID,'x'));assert.equal(wrapper.remembered(),apiRef(ID,'x'));
  wrapper.remember('openai/gpt-5');assert.equal(wrapper.remembered(),null);
});

test('error codes become fixed Japanese sentences that never echo input',()=>{
  assert.equal(errorCode(new Error('x byok_auth_failed y')),'byok_auth_failed');
  assert.match(errorText('byok_auth_failed'),/APIキー/);assert.match(errorText('byok_rate_limited'),/多すぎ/);assert.match(errorText('byok_quota_exceeded'),/利用枠|残高/);
  assert.equal(errorText('sk-secret-value'),errorText('byok_provider_failed'));
  assert.doesNotMatch(errorText('sk-secret-value'),/secret/);
});

function setup(){
  const dom=new JSDOM('<div class="piw-shell"><div class="piw-timeline-wrap"><div id="t"></div></div></div>'),document=dom.window.document;
  const sent=[],handlers=[];let failStart=null;
  const invoke=async(name,args)=>{sent.push([name,args]);if(name==='byok_chat_start'){if(failStart)throw failStart;return 'req-1';}return null;};
  const listen=async(name,cb)=>{handlers.push(cb);return()=>{};};
  const host=document.querySelector('.piw-timeline-wrap'),timeline=document.querySelector('#t');
  const chat=createConnectionChat({document,invoke,listen,host,timeline});
  return {chat,sent,emit:p=>handlers.forEach(h=>h({payload:p})),host,timeline,fail:e=>{failStart=e;},document};
}

test('a streamed answer fills the bubble, and the history carries it into the next turn',async()=>{
  const t=setup();
  assert.equal(await t.chat.send('こんにちは',apiRef(ID,'m1')),true);
  assert.deepEqual(t.sent[0],['byok_chat_start',{input:{source:'api',id:ID,model:'m1',messages:[{role:'user',content:'こんにちは'}]}}]);
  assert.equal(t.timeline.hidden,true);assert.ok(t.host.textContent.includes(BILLING_NOTE));
  t.emit({requestId:'other',type:'delta',text:'無視'});
  t.emit({requestId:'req-1',type:'delta',text:'やあ'});t.emit({requestId:'req-1',type:'delta',text:'！'});
  assert.equal(t.chat.isBusy(),true);
  assert.equal(await t.chat.send('割り込み',apiRef(ID,'m1')),false);
  t.emit({requestId:'req-1',type:'done'});
  assert.equal(t.chat.isBusy(),false);
  assert.equal(t.host.querySelector('.byok-assistant').textContent,'やあ！');
  await t.chat.send('続き',apiRef(ID,'m1'));
  assert.deepEqual(t.sent.at(-1)[1].input.messages.map(m=>m.role),['user','assistant','user']);
});

test('events that arrive before the start call resolves are not lost',async()=>{
  const dom=new JSDOM('<div class="piw-shell"><div class="piw-timeline-wrap"><div id="t"></div></div></div>'),document=dom.window.document;
  let handler=null;const host=document.querySelector('.piw-timeline-wrap');
  const chat=createConnectionChat({document,host,timeline:document.querySelector('#t'),listen:async(n,cb)=>{handler=cb;return()=>{};},
    invoke:async(name)=>{if(name!=='byok_chat_start')return null;handler({payload:{requestId:'r9',type:'delta',text:'早い'}});handler({payload:{requestId:'r9',type:'done'}});return 'r9';}});
  await chat.send('q',cliRef('claude',null));
  assert.equal(host.querySelector('.byok-assistant').textContent,'早い');assert.equal(chat.isBusy(),false);
});

test('provider errors show a fixed message, drop the unanswered turn, and keep the draft retryable',async()=>{
  const t=setup();
  await t.chat.send('質問',apiRef(ID,'m1'));
  t.emit({requestId:'req-1',type:'error',code:'byok_auth_failed'});
  assert.match(t.host.querySelector('.byok-status').textContent,/APIキー/);assert.equal(t.chat.isBusy(),false);
  await t.chat.send('もう一度',apiRef(ID,'m1'));
  assert.deepEqual(t.sent.at(-1)[1].input.messages,[{role:'user',content:'もう一度'}]);
  t.emit({requestId:'req-1',type:'done'});
  const bad=setup();bad.fail(new Error('byok_quota_exceeded'));
  await bad.chat.send('x',apiRef(ID,'m'));
  assert.match(bad.host.querySelector('.byok-status').textContent,/残高|利用枠/);assert.equal(bad.chat.isBusy(),false);
});

test('stop asks Rust to cancel, reset is refused while streaming and restores the timeline after',async()=>{
  const t=setup();
  await t.chat.send('長い',apiRef(ID,'m'));
  t.host.querySelector('.byok-stop').click();await settle();
  assert.deepEqual(t.sent.at(-1),['byok_chat_cancel',{requestId:'req-1'}]);
  assert.equal(t.chat.reset(),false);
  t.emit({requestId:'req-1',type:'done',cancelled:true});
  assert.equal(t.chat.reset(),true);assert.equal(t.timeline.hidden,false);assert.equal(t.host.querySelectorAll('.byok-msg').length,0);
  assert.equal(await t.chat.send('',apiRef(ID,'m')),false);
  assert.equal(await t.chat.send('x','openai/gpt-5'),false);
});
