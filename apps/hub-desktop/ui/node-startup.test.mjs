import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createNodeStartup} from './node-startup.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(t,{saved=false,reply={supported:true,status:'disabled'},current=true,main=true}={}){
  const dom=new JSDOM('<input id="node-login" type="checkbox"><p id="node-startup-state"></p>'),document=dom.window.document,checkbox=document.querySelector('input'),status=document.querySelector('p');
  checkbox.checked=saved;
  const f={dom,document,checkbox,status,current,main,reply,calls:[]};
  const invoke=(...args)=>{f.calls.push(args);if(f.fail)throw Error('private registry path C:/not-for-display cookie');return f.wait?f.wait.promise:f.reply;};
  f.api=createNodeStartup({document,invoke,checkbox,status,isMain:()=>f.main,isCurrent:()=>f.current});
  f.edit=value=>{checkbox.checked=value;checkbox.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
  t.after(()=>{f.api.destroy();dom.window.close();});return f;
}

test('initial node state loaded outside the node view still preserves its preference without OS changes',async t=>{
 const f=fixture(t,{current:false}),wait=deferred();
 f.api.setSavedPreference(true);assert.equal(f.calls.length,0);assert.deepEqual(f.api.saveInput(),{launchAtLogin:true,applyStartup:false});
 f.current=true;f.wait=wait;const pending=f.api.refresh();await tick();
 assert.deepEqual(f.api.saveInput(),{launchAtLogin:true,applyStartup:false});
 wait.resolve({supported:true,status:'disabled'});await pending;
 assert.deepEqual(f.api.saveInput(),{launchAtLogin:false,applyStartup:true});
});

test('factory is readonly and starts disabled; legacy saved true does not imply OS registration',async t=>{
 const f=fixture(t,{saved:true});assert.deepEqual(f.calls,[]);assert.equal(f.checkbox.disabled,true);assert.equal(f.checkbox.checked,true);assert.deepEqual(f.api.saveInput(),{launchAtLogin:true,applyStartup:false});
 await f.api.refresh();assert.deepEqual(f.calls,[['node_startup_status']]);assert.equal(f.checkbox.disabled,false);assert.equal(f.checkbox.checked,false);assert.deepEqual(f.api.saveInput(),{launchAtLogin:false,applyStartup:true});assert.ok(f.status.textContent.includes('登録されていません'));
});

test('known enabled and disabled expose actual registration and the editable saved input only',async t=>{
 for(const state of ['enabled','disabled']){const f=fixture(t,{saved:state==='disabled',reply:{supported:true,status:state}});await f.api.refresh();assert.equal(f.checkbox.checked,state==='enabled');assert.equal(f.checkbox.disabled,false);f.edit(state!=='enabled');assert.deepEqual(f.api.saveInput(),{launchAtLogin:state!=='enabled',applyStartup:true});assert.ok(f.status.textContent.includes('保存すると'));assert.ok(f.status.textContent.includes('まだ保存していません'));}
});

test('unsupported unavailable and another executable path preserve saved preference without applying OS changes',async t=>{
 for(const state of ['unsupported','unavailable','different_path'])for(const saved of [false,true]){const f=fixture(t,{saved,reply:{supported:state!=='unsupported',status:state}});await f.api.refresh();assert.equal(f.checkbox.disabled,true);assert.equal(f.checkbox.checked,saved);f.checkbox.checked=!saved;assert.deepEqual(f.api.saveInput(),{launchAtLogin:saved,applyStartup:false});assert.ok(f.status.textContent.includes('保持'));assert.equal(f.calls.length,1);}
});

test('malformed private cookie and inconsistent payloads stay unknown and never leak supplied fields',async t=>{
 const extras=['registry','path','cookie','cookies','privateKey','token','owner'];
 const replies=[null,[],true,'enabled',{},Object.create({supported:true,status:'enabled'}),{supported:1,status:'enabled'},{supported:true},{status:'enabled'},
  {supported:false,status:'enabled'},{supported:false,status:'disabled'},{supported:false,status:'different_path'},{supported:false,status:'unavailable'},
  {supported:true,status:'unsupported'},{supported:true,status:'enabled\n'},{supported:true,status:'<img src=x>'},
  ...extras.map(key=>({supported:true,status:'enabled',[key]:'do-not-render'}))];
 for(const reply of replies){const f=fixture(t,{saved:true,reply});await f.api.refresh();assert.equal(f.checkbox.disabled,true);assert.deepEqual(f.api.saveInput(),{launchAtLogin:true,applyStartup:false});assert.equal(f.status.textContent.includes('do-not-render'),false);assert.equal(f.document.querySelector('img'),null);}
});

test('readonly refresh coalesces and saves while pending retain the saved preference',async t=>{
 const f=fixture(t,{saved:true}),wait=deferred();f.wait=wait;const one=f.api.refresh(),two=f.api.refresh();assert.equal(one,two);assert.equal(f.checkbox.disabled,true);assert.deepEqual(f.api.saveInput(),{launchAtLogin:true,applyStartup:false});await tick();assert.equal(f.calls.length,1);wait.resolve({supported:true,status:'disabled'});await one;await f.api.refresh();assert.equal(f.calls.length,2);
});

test('showNode repeating a saved preference and duplicate OS reads do not erase unsaved choices',async t=>{
 const f=fixture(t,{saved:true});await f.api.refresh();f.edit(true);f.checkbox.checked=true;f.api.setSavedPreference(true);await f.api.refresh();assert.equal(f.checkbox.checked,true);assert.ok(f.status.textContent.includes('まだ保存していません'));
 const g=fixture(t,{saved:false,reply:{supported:true,status:'enabled'}});await g.api.refresh();g.edit(false);g.checkbox.checked=true;g.api.setSavedPreference(true);assert.equal(g.checkbox.checked,false);await g.api.refresh();assert.equal(g.checkbox.checked,false);assert.deepEqual(g.api.saveInput(),{launchAtLogin:false,applyStartup:true});
});

test('a draft is confirmed only by matching fresh OS state and the latest saved preference',async t=>{
 const f=fixture(t,{saved:true});await f.api.refresh();f.edit(true);f.api.setSavedPreference(true);assert.ok(f.status.textContent.includes('まだ保存していません'));f.reply={supported:true,status:'enabled'};await f.api.refresh();assert.equal(f.checkbox.checked,true);assert.equal(f.status.textContent.includes('まだ保存していません'),false);
 const g=fixture(t,{saved:false});await g.api.refresh();g.edit(true);g.reply={supported:true,status:'enabled'};await g.api.refresh();assert.ok(g.status.textContent.includes('まだ保存していません'));g.api.setSavedPreference(true);assert.ok(g.status.textContent.includes('まだ保存していません'));await g.api.refresh();assert.equal(g.status.textContent.includes('まだ保存していません'),false);
});

test('failed readonly refresh preserves preference and draft for later confirmation without raw errors',async t=>{
 const f=fixture(t,{saved:false});await f.api.refresh();f.edit(true);f.fail=true;await f.api.refresh();assert.equal(f.checkbox.disabled,true);assert.deepEqual(f.api.saveInput(),{launchAtLogin:false,applyStartup:false});assert.equal(f.status.textContent.includes('private'),false);assert.equal(f.status.textContent.includes('cookie'),false);f.fail=false;await f.api.refresh();assert.equal(f.checkbox.checked,true);assert.ok(f.status.textContent.includes('まだ保存していません'));
});

test('destroy and superseded view drop late results and do not issue native calls off-view or outside main',async t=>{
 for(const reason of ['destroy','view','main']){const f=fixture(t,{saved:true}),wait=deferred();f.wait=wait;const pending=f.api.refresh();await tick();if(reason==='destroy')f.api.destroy();if(reason==='view')f.current=false;if(reason==='main')f.main=false;const text=f.status.textContent;wait.resolve({supported:true,status:'enabled'});await pending;assert.equal(f.status.textContent,text);assert.equal(f.checkbox.disabled,true);assert.deepEqual(f.api.saveInput(),{launchAtLogin:true,applyStartup:false});await f.api.refresh();assert.equal(f.calls.length,1);}
 for(const options of [{current:false},{main:false}]){const f=fixture(t,options);await f.api.refresh();assert.equal(f.calls.length,0);assert.equal(f.checkbox.disabled,true);}
});

test('a context superseded before the deferred invocation produces no IPC',async t=>{
 const f=fixture(t);const pending=f.api.refresh();f.current=false;await pending;assert.deepEqual(f.calls,[]);assert.deepEqual(f.api.saveInput(),{launchAtLogin:false,applyStartup:false});
});

test('saved preference input is strictly boolean and returned save payloads cannot change component state',async t=>{
 const f=fixture(t);for(const value of [null,undefined,0,1,'false',{},[]])assert.throws(()=>f.api.setSavedPreference(value),/invalid_preference/);f.api.setSavedPreference(true);const payload=f.api.saveInput();payload.launchAtLogin=false;payload.applyStartup=true;assert.deepEqual(f.api.saveInput(),{launchAtLogin:true,applyStartup:false});await f.api.refresh();f.api.destroy();f.checkbox.checked=true;assert.deepEqual(f.api.saveInput(),{launchAtLogin:true,applyStartup:false});
});
