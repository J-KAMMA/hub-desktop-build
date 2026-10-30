import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHarnessComparison} from './harness-comparison.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const id='00000000-0000-4000-8000-000000000001';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,handler){
  const dom=new JSDOM('<body></body>'),document=dom.window.document,calls=[],started=[];let current=true,main=true,last;
  const invoke=async(command,args)=>{calls.push({command,args:structuredClone(args)});
    const fallback=()=>command==='dev_workspace'?'C:/work':command==='pi_work_models'?{models:['openai/a','ollama/local','ollama/too..bad'],default:'ollama/local',ready:['ollama/local'],locations:{'ollama/local':'local'}}:
      command==='pi_work_compare_start'?(last={id,workspace:args.workspace,model:args.model,prompt:args.prompt,engine:args.engine,generation:args.generation,status:'running',allowWrite:false,allowExec:false,allowHttp:false,allowTest:false,toolCalls:[],pendingActions:[]}):command==='pi_work_status'?last:null;
    return handler?handler(command,args,fallback):fallback();};
  const api=createHarnessComparison({document,invoke,isMain:()=>main,isCurrent:()=>current,onStarted:run=>started.push(run)});document.body.append(api.element);
  const field=name=>api.element.querySelector(`[name="${name}"]`),button=text=>[...api.element.querySelectorAll('button')].find(value=>value.textContent===text);
  t.after(()=>{api.destroy();dom.window.close();});return{api,dom,calls,started,field,button,current:value=>current=value,main:value=>main=value,status:()=>api.element.querySelector('[role="status"]').textContent};
}
test('opening reads only existing local metadata, then one explicit trial sends profile and native run callback',async t=>{
  const f=fixture(t);assert.equal(f.button('この条件で開始').disabled,true);await tick();assert.deepEqual(f.calls.map(call=>call.command),['dev_workspace','pi_work_models','dev_workspace']);assert.equal(f.started.length,0);
  assert.deepEqual([...f.field('model').options].map(value=>value.value),['ollama/local']);assert.equal(f.field('maxTokens').value,'1024');assert.ok([...f.api.element.querySelectorAll('button')].every(value=>value.type==='button'));
  f.field('engine').value='dsh';f.field('prompt').value='  実行\nしてください  ';f.field('temperature').value='0.5';f.field('maxTokens').value='128';f.field('reasoning').value='low';
  f.button('この条件で開始').click();f.button('この条件で開始').click();await tick();assert.equal(f.calls.filter(call=>call.command==='pi_work_compare_start').length,1);
  assert.deepEqual(f.calls.find(call=>call.command==='pi_work_compare_start').args,{workspace:'C:/work',prompt:'  実行\nしてください  ',model:'ollama/local',engine:'dsh',generation:{temperature:0.5,maxTokens:128,reasoning:'low'},confirmed:true});
  assert.equal(f.started[0].id,id);assert.match(f.status(),/開始要求.*準備中/);assert.doesNotMatch(f.status(),/成功|速い|優位/);assert.equal(f.button('この条件で開始').disabled,true);
});
test('invalid widths/profile retain draft and never start; user values render as text only',async t=>{
  const f=fixture(t);await tick();for(const text of ['😀'.repeat(4001),'\ud800','\udfff','bad\0']){f.field('prompt').value=text;f.button('この条件で開始').click();await tick();assert.equal(f.field('prompt').value,text);}
  f.field('prompt').value='<img src=x onerror=alert(1)>';f.field('maxTokens').value='8193';f.button('この条件で開始').click();await tick();assert.equal(f.calls.some(call=>call.command==='pi_work_compare_start'),false);assert.equal(f.api.element.querySelector('img'),null);assert.equal(f.button('この条件で開始').disabled,false);
});
test('unknown outcome freezes repetition and keeps draft; definite rejection permits manual corrected attempt only',async t=>{
  for(const message of ['transport','pi_work_comparison_generation_invalid']){const f=fixture(t,(command,args,fallback)=>{if(command==='pi_work_compare_start')throw Error(message);return fallback();});await tick();f.field('prompt').value='原稿';f.button('この条件で開始').click();await tick();assert.equal(f.field('prompt').value,'原稿');assert.equal(f.started.length,0);assert.equal(f.calls.filter(call=>call.command==='pi_work_compare_start').length,1);
    if(message==='transport'){assert.match(f.status(),/開始結果.*自動再送はしません/);assert.equal(f.button('この条件で開始').disabled,true);f.button('この条件で開始').click();await tick();assert.equal(f.calls.filter(call=>call.command==='pi_work_compare_start').length,1);}
    else{assert.equal(f.button('この条件で開始').disabled,false);assert.match(f.status(),/入力は保持/);}}
});
test('readonly metadata failure exposes explicit retry without losing edited fields',async t=>{
  let reads=0;const f=fixture(t,(command,args,fallback)=>{if(command==='pi_work_models'&&++reads===1)throw Error('offline');return fallback();});f.field('prompt').value='入力保持';await tick();assert.equal(f.button('この条件で開始').disabled,true);assert.equal(f.button('作業フォルダーとモデルを再確認').hidden,false);
  f.button('作業フォルダーとモデルを再確認').click();f.button('作業フォルダーとモデルを再確認').click();await tick();assert.equal(reads,2);assert.equal(f.field('prompt').value,'入力保持');assert.equal(f.button('この条件で開始').disabled,false);assert.equal(f.calls.some(call=>call.command==='pi_work_compare_start'),false);
});
test('destroy/current/main changes discard late metadata or start and remove handlers without cancelling native',async t=>{
  for(const phase of ['metadata','start']){let finish;const gate=new Promise(resolve=>finish=resolve),f=fixture(t,(command,args,fallback)=>phase==='metadata'&&command==='pi_work_models'||phase==='start'&&command==='pi_work_compare_start'?gate:fallback());
    if(phase==='start'){await tick();f.field('prompt').value='原稿';f.button('この条件で開始').click();await tick();}
    const button=f.button('この条件で開始');f.api.destroy();finish(phase==='metadata'?{models:['ollama/local'],default:'ollama/local'}:{});await tick();button.click();assert.equal(f.started.length,0);assert.equal(f.api.element.isConnected,false);assert.equal(f.calls.some(call=>call.command==='pi_work_cancel'),false);}
  const f=fixture(t);f.main(false);await tick();assert.equal(f.calls.length,0);f.current(false);f.button('この条件で開始').click();await tick();assert.equal(f.calls.length,0);
});
test('old binary is explicitly unavailable and never makes automatic repeat attempts',async t=>{
  const f=fixture(t,(command,args,fallback)=>{if(command==='pi_work_compare_start')throw Error('Command pi_work_compare_start not found');return fallback();});await tick();f.field('prompt').value='原稿';f.button('この条件で開始').click();await tick();assert.match(f.status(),/このDesktop.*利用できません/);assert.equal(f.button('この条件で開始').disabled,true);assert.equal(f.started.length,0);
});
test('an accepted start already failed by fresh status is shown as failed, never preparing or a successful comparison',async t=>{
  const f=fixture(t,(command,args,fallback)=>command==='pi_work_status'?{...fallback(),status:'failed'}:fallback());await tick();f.field('prompt').value='原稿';f.button('この条件で開始').click();await tick();assert.equal(f.started[0].status,'failed');assert.match(f.status(),/失敗状態/);assert.doesNotMatch(f.status(),/準備中|成功/);assert.equal(f.calls.filter(call=>call.command==='pi_work_compare_start').length,1);
});
