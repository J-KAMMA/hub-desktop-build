import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createAiConnectionsPanel,validateForm,keyStatus,CLI_STATE_TEXT} from './byok-connections.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setTimeout(r,0));};
const ID='11111111-1111-4111-8111-111111111111';
const conn={id:ID,kind:'openai',name:'OpenAI',baseUrl:null,defaultModel:'gpt-5',enabled:true,keyHint:'1234',hasKey:true};
const cliRows=[{id:'claude',label:'Claude Code',state:'logged_in',suggestedModels:['sonnet'],enabled:false,defaultModel:null},
  {id:'codex',label:'OpenAI Codex',state:'not_installed',suggestedModels:[],enabled:false,defaultModel:null},
  {id:'gemini',label:'Gemini CLI',state:'not_logged_in',suggestedModels:[],enabled:true,defaultModel:'gemini-2.5-pro'}];
const by=(root,text)=>[...root.querySelectorAll('button')].find(b=>b.textContent===text);

test('key status shows only the last four, never a key',()=>{
  assert.equal(keyStatus(conn),'保存済み ••••1234');assert.equal(keyStatus({hasKey:true,keyHint:null}),'保存済み');assert.equal(keyStatus({hasKey:false}),'キー未登録');
});

test('form validation mirrors the Rust endpoint and key rules',()=>{
  const ok={kind:'openai',name:'a',baseUrl:'',apiKey:'sk-abc',editing:false};
  assert.equal(validateForm(ok),'');
  assert.match(validateForm({...ok,apiKey:''}),/APIキー/);assert.equal(validateForm({...ok,apiKey:'',editing:true}),'');
  assert.match(validateForm({...ok,name:' '}),/表示名/);assert.match(validateForm({...ok,apiKey:'a b'}),/空白/);
  const custom={...ok,kind:'openai_compatible',baseUrl:'https://openrouter.ai/api/v1'};
  assert.equal(validateForm(custom),'');
  assert.match(validateForm({...custom,baseUrl:'http://example.com/v1'}),/https/);
  assert.equal(validateForm({...custom,baseUrl:'http://localhost:1234/v1',apiKey:''}),'');
  assert.match(validateForm({...custom,baseUrl:'https://u:p@x.com'}),/パスワード/);
  assert.match(validateForm({...custom,baseUrl:'nope'}),/アドレス/);
  assert.match(validateForm({...ok,kind:'x'}),/種類/);
});

function mount(handlers){
  const dom=new JSDOM('<body></body>'),document=dom.window.document,calls=[];
  const invoke=async(name,args)=>{calls.push([name,args]);return handlers[name]?.(args);};
  const panel=createAiConnectionsPanel({document,invoke});document.body.append(panel.element);
  return {panel,document,calls,root:panel.element};
}

test('panel lists connections without a key and CLIs with their login state',async()=>{
  const t=mount({byok_list:()=>({connections:[conn],cli:cliRows})});
  await t.panel.refresh();
  assert.match(t.root.textContent,/保存済み ••••1234/);assert.match(t.root.textContent,/既定: gpt-5/);
  assert.ok(t.root.textContent.includes(CLI_STATE_TEXT.logged_in));assert.match(t.root.textContent,/未インストール/);assert.match(t.root.textContent,/未ログイン/);
  const toggles=[...t.root.querySelectorAll('.byok-row-head input[type=checkbox]')];
  assert.equal(toggles.length,4);assert.equal(toggles[2].disabled,true);assert.equal(toggles[2].checked,false);
  assert.match(t.root.textContent,/Hubは読み取りも送信もしません/);
  assert.ok(![...t.root.querySelectorAll('input')].some(i=>i.value.includes('sk-')));
});

test('saving sends the key once, clears the field, and never re-renders it',async()=>{
  const t=mount({byok_list:()=>({connections:[],cli:[]}),byok_save:()=>conn});
  await t.panel.refresh();
  by(t.root,'＋ 接続を追加').click();
  const key=t.root.querySelector('input[type=password]');
  const select=t.root.querySelector('select');select.value='openai';select.dispatchEvent(new t.document.defaultView.Event('change'));
  t.root.querySelector('form input').value='私のOpenAI';key.value='sk-live-SECRET1234';
  t.root.querySelector('form').dispatchEvent(new t.document.defaultView.Event('submit',{cancelable:true}));await settle();
  const save=t.calls.find(c=>c[0]==='byok_save');
  assert.equal(save[1].input.apiKey,'sk-live-SECRET1234');assert.equal(save[1].input.id,null);assert.equal(save[1].input.baseUrl,null);
  assert.equal(key.value,'');assert.equal(t.root.querySelector('form').hidden,true);
  assert.doesNotMatch(t.root.innerHTML,/SECRET/);
});

test('failed save shows a fixed message and clears the key; invalid input never reaches Rust',async()=>{
  const t=mount({byok_list:()=>({connections:[],cli:[]}),byok_save:()=>{throw new Error('byok_store_unavailable: sk-leak');}});
  await t.panel.refresh();by(t.root,'＋ 接続を追加').click();
  const submit=()=>t.root.querySelector('form').dispatchEvent(new t.document.defaultView.Event('submit',{cancelable:true}));
  submit();await settle();assert.equal(t.calls.filter(c=>c[0]==='byok_save').length,0);
  t.root.querySelector('form input').value='名前';t.root.querySelector('input[type=password]').value='sk-abcdef123';
  submit();await settle();
  assert.match(t.root.textContent,/保管庫/);assert.doesNotMatch(t.root.textContent,/sk-leak/);assert.equal(t.root.querySelector('input[type=password]').value,'');
});

test('test, enable, edit and remove call the matching commands; test failures use fixed text',async()=>{
  const t=mount({byok_list:()=>({connections:[conn],cli:cliRows}),byok_test:()=>({ok:false,code:'byok_auth_failed'}),byok_set_enabled:()=>conn,byok_remove:()=>null,byok_cli_set:()=>null});
  await t.panel.refresh();
  by(t.root,'接続を試す').click();await settle();
  assert.deepEqual(t.calls.find(c=>c[0]==='byok_test')[1],{id:ID});assert.match(t.root.textContent,/APIキーが無効/);
  const toggle=t.root.querySelector('.byok-row-head input[type=checkbox]');toggle.checked=false;toggle.dispatchEvent(new t.document.defaultView.Event('change'));await settle();
  assert.deepEqual(t.calls.find(c=>c[0]==='byok_set_enabled')[1],{id:ID,enabled:false});
  by(t.root,'編集').click();
  assert.equal(t.root.querySelector('input[type=password]').value,'');assert.match(t.root.querySelector('input[type=password]').placeholder,/保存済み ••••1234/);
  by(t.root,'キャンセル').click();
  by(t.root,'削除').click();by(t.root,'削除する').click();await settle();
  assert.deepEqual(t.calls.find(c=>c[0]==='byok_remove')[1],{id:ID});
  const cliToggle=[...t.root.querySelectorAll('.byok-row-head input[type=checkbox]')][1];cliToggle.checked=true;cliToggle.dispatchEvent(new t.document.defaultView.Event('change'));await settle();
  assert.deepEqual(t.calls.find(c=>c[0]==='byok_cli_set')[1],{id:'claude',enabled:true,defaultModel:null});
});

test('index.html carries the nav item, the panel host and the stylesheet',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/data-settings-sec="ai"[^>]*>AI</);assert.match(html,/data-settings-panel="ai"[^>]*hidden/);assert.match(html,/id="settings-ai"/);assert.match(html,/href="\.\/byok\.css"/);
});

test('no UI source stores a key or reads one back',()=>{
  for(const file of ['byok-connections.mjs','byok-chat.mjs']){
    const source=readFileSync(new URL(`./${file}`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/localStorage|sessionStorage|console\./);
  }
  assert.doesNotMatch(readFileSync(new URL('./byok-chat.mjs',import.meta.url),'utf8'),/apiKey/);
});

test('every connection and CLI has a phone switch that starts off and calls byok_remote_set',async()=>{
  const t=mount({byok_list:()=>({connections:[conn,{...conn,id:'22222222-2222-4222-8222-222222222222',name:'停止中',enabled:false,remoteAllowed:true}],cli:cliRows}),byok_remote_set:()=>null});
  await t.panel.refresh();
  const phone=[...t.root.querySelectorAll('.byok-remote input')];
  assert.equal(phone.length,5);
  assert.deepEqual(phone.map(b=>b.checked),[false,false,false,false,false],'default off; a disabled connection never shows as allowed');
  assert.deepEqual(phone.map(b=>b.disabled),[false,true,true,true,false],'only usable sources can be switched on');
  phone[0].checked=true;phone[0].dispatchEvent(new t.document.defaultView.Event('change'));await settle();
  assert.deepEqual(t.calls.find(c=>c[0]==='byok_remote_set')[1],{source:'api',id:ID,allowed:true});
  const claude=cliRows[0];assert.equal(claude.id,'claude');
  assert.match(t.root.textContent,/スマホから使える/);assert.match(t.root.textContent,/ファイルを書き換えない/);
});

test('a failed phone switch goes back and shows a fixed message',async()=>{
  const t=mount({byok_list:()=>({connections:[conn],cli:[]}),byok_remote_set:()=>{throw new Error('byok_disabled');}});
  await t.panel.refresh();
  const box=t.root.querySelector('.byok-remote input');box.checked=true;box.dispatchEvent(new t.document.defaultView.Event('change'));await settle();
  assert.equal(box.checked,false);assert.match(t.root.querySelector(':scope > [role=status]').textContent,/.+/);
});

test('turning a connection off in the main switch also switches the phone switch off',async()=>{
  const t=mount({byok_list:()=>({connections:[{...conn,remoteAllowed:true}],cli:[]}),byok_set_enabled:()=>conn});
  await t.panel.refresh();
  const box=t.root.querySelector('.byok-remote input');assert.equal(box.checked,true);
  const main=t.root.querySelector('.byok-row-head input[type=checkbox]');main.checked=false;main.dispatchEvent(new t.document.defaultView.Event('change'));await settle();
  assert.equal(box.checked,false);assert.equal(box.disabled,true);
});

test('the phone card appears only when the app can listen for events',async()=>{
  assert.doesNotMatch(mount({byok_list:()=>({connections:[],cli:[]})}).root.textContent,/スマホから使う/);
  const dom=new JSDOM('<body></body>'),document=dom.window.document;
  const panel=createAiConnectionsPanel({document,invoke:async()=>'https://hub.jkamma.com',listen:async()=>()=>{}});
  assert.match(panel.element.textContent,/スマホから使う/);assert.match(panel.element.textContent,/スマホにもHubにも送りません/);
});
