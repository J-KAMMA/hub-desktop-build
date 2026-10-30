import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.env.HUB_AI_UI_ROOT?pathToFileURL(process.env.HUB_AI_UI_ROOT.replace(/[\\/]+$/,'')+'/'):new URL('.',import.meta.url);
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const work=await import(new URL('pi-work.mjs',root));
const drafts=await import(new URL('pi-work-drafts.mjs',root));
const {renderPiApproval}=await import(new URL('pi-approval.mjs',root));
const {createDesktopControlMetrics}=await import(new URL('desktop-control-metrics.mjs',root));
const {initShellControl}=await import(new URL('shell-control.mjs',root));
const {createPiModelPicker}=await import(new URL('pi-model-picker.mjs',root));
const {createPiPermissionPresets}=await import(new URL('pi-permission-presets.mjs',root));
const {createConnectionChat,createConnectionModels,parseRef}=await import(new URL('byok-chat.mjs',root));
const connectionPicker=await import(new URL('pi-work-connection.mjs',root));
const {createPiChanges}=await import(new URL('pi-changes.mjs',root));
const helperUrl=process.env.HUB_AI_HISTORY_FILE?pathToFileURL(process.env.HUB_AI_HISTORY_FILE):new URL('./pi-work-history.mjs',root);
const {renderPiWorkHistory}=await import(helperUrl);
const app=readFileSync(process.env.HUB_AI_APP_FILE??new URL('./app.js',root),'utf8');
const start=app.indexOf('function initPiWork('),end=app.indexOf('\nif (!startupTool) window.addEventListener("beforeunload"',start);
assert.ok(start>=0&&end>start);
const initialize=new Function('deps',`
  const {document,invoke,history,Node,Event,navigator,ResizeObserver,controlMetrics,renderPiWorkHistory,renderPiApproval,createPiModelPicker,createPiChanges,createPiWorkController,createPiWorkDrafts,piWorkDraftLength,hubWorkHistoryEntries,pendingActionsOf,toolCallsOf,piWorkIsTerminal,piWorkStatusLabel,piWorkErrorText}=deps;
  const {createPiPermissionPresets,createConnectionChat,createConnectionModels,parseRef}=deps;
  const {CONNECTION_NOTE,connectionChoices,renderConnectionPicker,syncConnectionModel}=deps;
  const safeStorage=null;
  const railNav={visit(){},handle(){}};
  const WHEN=new Intl.DateTimeFormat('ja-JP');
  let savedWorkspace=deps.workspace,currentView='ai',startupTool=null,refreshPiWorkComposer=()=>{},refreshHubWorkHistory=()=>{},piWorkDraftHandler=null,syncPiChangesView=null;
  const dev={path:document.querySelector('#workspace-path')};
  const requestAnimationFrame=fn=>fn(),updatePiWorkEmptyState=()=>{},autoscroll=()=>{},rightRailAvailable=()=>false,navigateFrom=()=>{},openHubPath=()=>{},enterBrowser=()=>{};
  async function refreshWorkspace(){savedWorkspace=await invoke('dev_workspace');refreshPiWorkComposer();}
  ${app.slice(start,end)}
  const controller=initPiWork(deps.piWorkOptions);
  return {controller,handoff: draft=>piWorkDraftHandler(draft),workspace:()=>savedWorkspace,view: value=>{currentView=value;syncPiChangesView?.(value);}};
`);
const run=(overrides={})=>({id:'r1',workspace:'C:/work/project',prompt:'依頼1',model:'ollama/model',status:'done',startedAtMs:1,continuation:{available:true},pendingActions:[],toolCalls:[],...overrides});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{runs=[run()],workspace='C:/work/project',cli=[],diff=null,workOptions=null}={}){
  const dom=new JSDOM(readFileSync(process.env.HUB_AI_HTML_FILE??new URL('index.html',root),'utf8'),{url:'http://fixture.invalid/'}),document=dom.window.document,calls=[];
  dom.window.HTMLElement.prototype.scrollTo=function({top=0}={}){this.scrollTop=top;};dom.window.HTMLElement.prototype.scrollIntoView=function(){};
  document.querySelector('#ai-more').showModal=function(){this.open=true;};
  let selectedWorkspace=workspace,pick=null,startError=null,modelCatalog={models:[]};
  const invoke=async(command,args)=>{calls.push([command,args]);if(command==='pi_work_diff'&&diff)return diff(args);if(command==='pi_work_list')return runs;if(command==='pi_work_models')return modelCatalog;if(command==='dev_workspace')return selectedWorkspace;if(command==='set_dev_workspace'){selectedWorkspace=args.path;return;}if(command==='pick_dev_workspace'){if(pick)selectedWorkspace=pick;return pick;}if(command==='pi_work_start'){if(startError)throw startError;return run({id:'started',workspace:selectedWorkspace,status:'running',prompt:args.prompt,continuation:{available:false}});}if(command==='pi_work_decide'||command==='pi_work_cancel')return run({id:args.runId??args.id,status:'running'});throw Error('unexpected '+command);};
  const timers={setInterval:()=>1,clearInterval:()=>{}};
  const api=initialize({...work,...drafts,...connectionPicker,createPiPermissionPresets,createConnectionChat,createConnectionModels,parseRef,document,invoke,piWorkOptions:workOptions?.(invoke),history:cli,workspace,Node:dom.window.Node,Event:dom.window.Event,navigator:dom.window.navigator,ResizeObserver:class{observe(){}},controlMetrics:createDesktopControlMetrics({now:()=>0}),renderPiWorkHistory,renderPiApproval,createPiModelPicker,createPiChanges,createPiWorkController:options=>work.createPiWorkController({...options,timers})});
  t.after(()=>{api.controller.dispose();dom.window.close();});await flush();
  const el=id=>document.querySelector('#'+id),select=id=>{document.querySelector(`.piw-history-item[data-kind="hub"][data-run-id="${id}"]`).click();};
  return {...api,dom,document,calls,el,select,pick:value=>{pick=value;},failStart:value=>{startError=value;},models:value=>{modelCatalog=value;}};
}

test('model picker integration loads initially and an explicit refresh preserves typed models while discovering new candidates',async t=>{
  const f=await fixture(t,{runs:[]});
  assert.deepEqual(f.calls.filter(([command])=>command==='pi_work_models'),[['pi_work_models',{refresh:false}]]);
  f.el('pi-work-model').value='my-provider/typed-model';
  f.models({models:['provider/new-model'],ready:['provider/new-model'],default:'provider/new-model',locations:{'provider/new-model':'api'}});
  f.el('pi-work-model-refresh').click();await flush();
  assert.deepEqual(f.calls.filter(([command])=>command==='pi_work_models'),[['pi_work_models',{refresh:false}],['pi_work_models',{refresh:true}]]);
  assert.equal(f.el('pi-work-model').value,'my-provider/typed-model');
  assert.deepEqual([...f.el('pi-work-model-list').options].map(option=>option.value),['provider/new-model','my-provider/typed-model']);
  assert.match(f.el('pi-work-model-status').textContent,/利用可能 1件/);assert.match(f.el('pi-work-model-list').options[0].label,/API/);
});

test('history inspection and repeated polling keep model, grants and verification untouched and captured start/Enter cannot launch',async t=>{
  const f=await fixture(t);f.el('pi-work-model').value='my-model';for(const id of ['allow-write','allow-exec','allow-http'])f.el('pi-work-'+id).checked=true;f.el('pi-work-verify-program').value='node';f.el('pi-work-verify-args').value='verify.mjs';f.el('pi-work-prompt').value='new draft';
  const captured=f.el('pi-work-start').onclick;f.select('r1');await f.controller.poll();
  assert.equal(f.el('pi-work-model').value,'my-model');for(const id of ['allow-write','allow-exec','allow-http'])assert.equal(f.el('pi-work-'+id).checked,true);assert.equal(f.el('pi-work-verify-program').value,'node');assert.equal(f.el('pi-work-verify-args').value,'verify.mjs');
  assert.equal(f.el('pi-work-finished').hidden,false);assert.equal(f.document.querySelector('.piw-composer').hidden,true);assert.equal(f.el('pi-work-start').disabled,true);assert.equal(f.el('pi-work-resume').hidden,true);
  f.el('pi-work-prompt').value='saved run draft';f.el('pi-work-start').disabled=false;captured();f.el('pi-work-prompt').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();assert.equal(f.calls.filter(([command])=>command==='pi_work_start').length,0);
  f.el('pi-work-new').click();assert.equal(f.el('pi-work-prompt').value,'new draft');f.select('r1');assert.equal(f.el('pi-work-prompt').value,'saved run draft');
});

test('explicit Continue resets permissions and verification and sends the exact original conversation only after workspace match',async t=>{
  const f=await fixture(t,{workspace:'C:/other'});f.el('pi-work-model').value='previous-model';for(const id of ['allow-write','allow-exec','allow-http'])f.el('pi-work-'+id).checked=true;f.el('pi-work-verify-program').value='node';f.select('r1');f.el('pi-work-finished-action').click();
  assert.equal(f.el('pi-work-model').value,'ollama/model');for(const id of ['allow-write','allow-exec','allow-http'])assert.equal(f.el('pi-work-'+id).checked,false);assert.equal(f.el('pi-work-verify-program').value,'');assert.equal(f.el('pi-work-resume').hidden,false);assert.equal(f.document.querySelector('.piw-composer').hidden,false);
  f.el('pi-work-prompt').value='続き';f.el('pi-work-prompt').dispatchEvent(new f.dom.window.Event('input'));assert.equal(f.el('pi-work-start').disabled,true);
  await f.el('pi-work-resume-workspace').onclick();assert.equal(f.workspace(),'C:/work/project');assert.equal(f.el('pi-work-start').disabled,false);f.el('pi-work-start').click();await flush();
  const request=f.calls.find(([command])=>command==='pi_work_start')[1];assert.equal(request.resumeRunId,'r1');assert.equal(request.engine,'thin');assert.equal(request.workspace,'C:/work/project');assert.equal(request.prompt,'続き');assert.equal(request.allowWrite,false);assert.equal(request.allowExec,false);assert.equal(request.allowHttp,false);assert.equal(Object.hasOwn(request,'verification'),false);
});


test('a saved standard run is view-only: retired note, new-run button, no resume, and the new run is thin',async t=>{
  const f=await fixture(t,{runs:[run({engine:'pi',prompt:'旧方式の依頼',continuation:{available:false,error:'standard_engine_retired'}})]});
  f.select('r1');
  assert.equal(f.el('pi-work-finished').hidden,false);assert.equal(f.el('pi-work-finished-text').textContent,'この作業は旧方式のため再開できません');assert.equal(f.el('pi-work-finished-action').textContent,'この依頼で新しく始める');
  f.el('pi-work-finished-action').click();
  assert.equal(f.el('pi-work-resume').hidden,true);assert.equal(f.el('pi-work-prompt').value,'旧方式の依頼');assert.equal(f.document.querySelector('.piw-composer').hidden,false);
  f.el('pi-work-start').click();await flush();
  const request=f.calls.find(([command])=>command==='pi_work_start')[1];assert.equal(request.engine,'thin');assert.equal(Object.hasOwn(request,'resumeRunId'),false);assert.equal(request.prompt,'旧方式の依頼');
  assert.equal(f.document.querySelector('#pi-work-engine'),null);
});
test('browser handoff while inspecting terminal history creates a new draft and explicit Continue preserves same-run append',async t=>{
  const f=await fixture(t);f.el('pi-work-model').value='unchanged';f.el('pi-work-prompt').value='new note';f.select('r1');f.el('pi-work-prompt').value='run note';f.handoff('browser note');assert.equal(f.el('pi-work-title').textContent,'新しい作業');assert.equal(f.el('pi-work-prompt').value,'new note\n\nbrowser note');assert.equal(f.el('pi-work-model').value,'unchanged');assert.equal(f.el('pi-work-resume').hidden,true);
  f.select('r1');assert.equal(f.el('pi-work-prompt').value,'run note');f.el('pi-work-finished-action').click();f.handoff('continued page');assert.equal(f.el('pi-work-prompt').value,'run note\n\ncontinued page');assert.equal(f.el('pi-work-resume').hidden,false);assert.equal(f.calls.filter(([command])=>command==='pi_work_start').length,0);
});

test('project history delegates exact hub/CLI identities, full paths, search, groups and live busy guards',async t=>{
  const cli={id:'r1',workspace:'C:/other/project',prompt:'CLI task',agent:'codex',status:'done',startedAtMs:2},f=await fixture(t,{cli:[cli]});let opened=0;const card=f.document.createElement('article'),button=f.document.createElement('button'),details=f.document.createElement('div');details.className='history-details';details.hidden=true;button.onclick=()=>{opened++;details.hidden=false;};card.append(button,details);f.el('dev-history').append(card);
  assert.equal(f.document.querySelectorAll('.piw-history-project').length,2);assert.ok([...f.document.querySelectorAll('.piw-history-project-head')].some(el=>el.title==='C:/other/project'));
  const row=f.document.querySelector('[data-kind="cli"][data-run-id="r1"]');row.click();assert.equal(opened,1);assert.equal(f.el('ai-more').open,true);assert.equal(f.el('pi-work-title').textContent,'新しい作業');
  const old=row.onclick;f.controller.state.busy=true;old();assert.equal(opened,1);f.controller.state.busy=false;
  f.el('pi-work-history-search').value='C:/other';f.el('pi-work-history-search').dispatchEvent(new f.dom.window.Event('input'));assert.equal(f.document.querySelectorAll('.piw-history-item').length,1);assert.equal(f.document.querySelector('.piw-history-item').dataset.kind,'cli');
});

test('readonly summary separates pending, execution, unverified response, verification results and interruption without HTML',async t=>{
  for(const [override,label,modifier] of [[{status:'running',pendingActions:[{id:'a',tool:'hub_edit',summary:'edit',detail:{path:'file',before:'a',after:'b'}}]},'承認待ち 1件','is-warning'],[{status:'running'},'実行中',''],[{},'返答終了',''],[{verification:{status:'passed'}},'指定検証に合格','is-verified'],[{verification:{status:'failed'}},'返答終了','is-failed'],[{verification:{status:'incomplete'}},'返答終了','is-warning'],[{status:'cancelled'},'中断','is-warning'],[{status:'failed'},'失敗','is-failed']]){
    const hostile='<img src="https://invalid/" onerror="bad()">',f=await fixture(t,{runs:[run({...override,workspace:'C:/full/'+hostile,model:hostile})]});f.select('r1');const turn=f.document.querySelector('.piw-turn');
    assert.equal(f.document.querySelector('.piw-work-summary'),null);const process=turn.querySelector('.piw-process');assert.ok(process);assert.equal(process.open,override.status==='running');assert.equal(turn.querySelector('img,script,a'),null);
    assert.equal(f.document.querySelector('.piw-process-mark').classList.contains(override.status==='running'?'is-running':override.status==='failed'||override.status==='cancelled'?'is-failed':'is-ok'),true);
    const verify=turn.querySelector('.piw-verify');if(override.verification)assert.ok(verify.textContent.includes({passed:'合格',failed:'不合格',incomplete:'未完了'}[override.verification.status]));else assert.equal(verify,null);
    if(override.pendingActions){
      assert.match(process.textContent,/承認待ち 1件/);assert.equal(process.querySelector('.piw-approval'),null);const seat=f.el('pi-work-approval-seat');assert.equal(seat.hidden,false);assert.equal(seat.querySelectorAll('.piw-approval pre').length,2);assert.equal(seat.querySelector('.piw-approval .approve').disabled,false);assert.equal(f.document.querySelector('.piw-composer').classList.contains('is-approval-pending'),true);assert.equal(seat.textContent.includes('すべて承認'),false);assert.equal(seat.querySelector('.piw-approval-nav'),null);
    }else{assert.equal(f.el('pi-work-approval-seat').hidden,true);assert.equal(f.document.querySelector('.piw-composer').classList.contains('is-approval-pending'),false);}
  }
});

test('several pending approvals take the composer seat one at a time with paging, per-action decisions and a kept draft',async t=>{
  const pendingActions=['a','b','c'].map(id=>({id,tool:'hub_exec',summary:`command ${id}\nargs: --x`}));
  const f=await fixture(t,{runs:[run({status:'running',pendingActions})]});f.el('pi-work-prompt').value='kept draft';f.select('r1');
  const seat=f.el('pi-work-approval-seat');assert.equal(seat.querySelectorAll('.piw-approval').length,1);assert.match(seat.textContent,/承認待ち 1\/3/);assert.match(seat.textContent,/command a/);
  assert.equal(f.document.querySelectorAll('.approve').length>=1,true);assert.equal([...seat.querySelectorAll('button')].some(button=>/すべて|常に|always/i.test(button.textContent)),false);
  const click=label=>[...seat.querySelectorAll('button')].find(button=>button.textContent===label).click();
  click('次へ');assert.match(seat.textContent,/承認待ち 2\/3/);assert.match(seat.textContent,/command b/);click('次へ');assert.match(seat.textContent,/command c/);
  seat.querySelector('.approve').click();await flush();assert.deepEqual(f.calls.filter(([c])=>c==='pi_work_decide').map(([,args])=>[args.runId,args.actionId,args.approve]),[['r1','c',true]]);
  assert.equal(f.el('pi-work-prompt').value,'kept draft');assert.equal(f.document.querySelector('.piw-composer').classList.contains('is-approval-pending'),false);
});

test('timeline process block keeps manual toggles, collapses finished runs and renders tool previews as text',async t=>{
  const hostile='<img src=x onerror=bad()>';
  const toolCalls=[{name:'hub_exec',ok:true,detail:'node --test',preview:'$ node --test\n'+hostile},{name:'hub_read',ok:false,detail:'a.txt'},{name:'hub_http'}];
  const f=await fixture(t,{runs:[run({id:'r1',status:'running',toolCalls}),run({id:'r2',startedAtMs:2,toolCalls})]});
  f.select('r1');let process=f.document.querySelector('.piw-process');assert.equal(process.open,true);assert.match(process.querySelector('summary').textContent,/作業の経過 · ツール 3件 · hub_http/);
  assert.deepEqual([...process.querySelectorAll('.piw-trace-glyph')].map(node=>node.textContent),['✓','✗','…']);assert.equal(process.querySelector('.piw-trace').dataset.detailKey,'tools');
  const tool=process.querySelector('details.piw-tool');assert.equal(tool.open,false);assert.equal(tool.querySelector('pre').textContent,'$ node --test\n'+hostile);assert.equal(process.querySelector('img'),null);
  process.open=false;await f.controller.refresh();assert.equal(f.document.querySelector('.piw-process').open,false);
  f.select('r2');process=f.document.querySelector('.piw-process');assert.equal(process.open,false);assert.deepEqual([...process.querySelectorAll('.piw-trace-glyph')].map(node=>node.textContent),['✓','✗','■']);
});

test('new-work submit still chooses a workspace, preserves a cancelled draft and never resumes the viewed run',async t=>{
  const f=await fixture(t,{workspace:''});f.el('pi-work-prompt').value='new task';f.el('pi-work-prompt').dispatchEvent(new f.dom.window.Event('input'));f.el('pi-work-start').click();await flush();assert.equal(f.el('pi-work-prompt').value,'new task');assert.equal(f.calls.filter(([command])=>command==='pi_work_start').length,0);
  f.pick('C:/selected');f.el('pi-work-start').click();await flush();const request=f.calls.find(([command])=>command==='pi_work_start')[1];assert.equal(request.workspace,'C:/selected');assert.equal(request.prompt,'new task');assert.equal(Object.hasOwn(request,'resumeRunId'),false);
});


test('automatic verification progress shows rounds used of the cap, and only for numeric values',async t=>{
  for(const [verification,text] of [[{status:'failed',attempts:3,limit:5},'指定検証: 不合格（3/5回）'],[{status:'passed',attempts:1,limit:5},'指定検証: 合格（1/5回）'],[{status:'running',attempts:9,limit:5},'指定検証: 実行中（5/5回）'],[{status:'passed',attempts:1},'指定検証: 合格'],[{status:'passed',attempts:'1',limit:'5'},'指定検証: 合格'],[{status:'passed',attempts:1,limit:0},'指定検証: 合格']]){
    const f=await fixture(t,{runs:[run({verification})]});f.select('r1');
    assert.equal(f.document.querySelector('.piw-verify').textContent,text);
  }
});
test('unknown verification enums including inherited keys remain unverified literal state',async t=>{
  for(const status of ['constructor','__proto__','toString','unknown']){
    const f=await fixture(t,{runs:[run({verification:{status}})]});f.select('r1');
    const verify=f.document.querySelector('.piw-verify');assert.equal(verify.textContent,'指定検証: 状態不明');assert.equal(verify.classList.contains('is-ok'),false);assert.ok(!f.document.querySelector('.piw-turn').textContent.includes('function'));
  }
});

test('compact summary avoids repeated model/status/verification while preserving actual outcome usage and diagnostics',async t=>{
  const f=await fixture(t,{runs:[run({verification:{status:'passed'},usage:{inputTokens:12,outputTokens:34},allowExec:true,outcome:{ok:false,exitCode:7,error:'explicit failure'},stderrTail:'diagnostic tail'})]});f.select('r1');const turn=f.document.querySelector('.piw-turn'),text=turn.textContent;
  assert.equal(text.includes('ollama/model'),false);assert.equal(text.split('指定検証: 合格').length-1,1);assert.ok(text.includes('トークン 12/34'));assert.ok(text.includes('書き込み都度承認'));assert.ok(text.includes('実行失敗 · exit 7'));assert.ok(text.includes('explicit failure'));assert.ok(turn.querySelector('.piw-process .piw-stderr').textContent.includes('diagnostic tail'));assert.equal(turn.querySelectorAll('.piw-work-summary').length,0);
});


test('historical epoch zero is valid and out-of-range or missing dates do not crash selected turns or live elapsed',async t=>{
  for(const status of ['done','running'])for(const timestamp of [0,Number.MAX_SAFE_INTEGER,NaN,undefined]){
    const f=await fixture(t,{runs:[run({status,startedAtMs:timestamp})]});f.select('r1');const meta=f.document.querySelector('.piw-turn > .piw-meta');assert.ok(meta);
    if(status==='running')assert.match(meta.textContent,/^\d+秒$/);else if(timestamp===0)assert.match(meta.textContent,/1970/);else assert.equal(meta.textContent,'日時不明');
    assert.equal(f.el('pi-work-error').textContent,'');
  }
});



const changeRunId='11111111-1111-4111-8111-111111111111',changeId='22222222-2222-4222-8222-222222222222';
const bodyHash=body=>createHash('sha256').update(body).digest('hex');
function changedRun(){
  const item={id:changeId,path:'src/changed.txt',kind:'modified',beforeSha256:bodyHash('before'),afterSha256:bodyHash('after'),status:'available'};
  const record=run({id:changeRunId,changes:{coverage:'hub_file_tools',baseline:'before_first_write',status:'tracked',reason:null,untrackedCommands:false,items:[item]}});
  const response={runId:changeRunId,changeId,path:item.path,before:'before',after:'after',beforeSha256:item.beforeSha256,afterSha256:item.afterSha256,status:'available',currentState:'matches',coverage:'hub_file_tools',baseline:'before_first_write'};
  return {record,response};
}
const settled=()=>new Promise(resolve=>setTimeout(resolve,25));
test('selected-run diff is explicit and survives history refresh without re-fetching private bodies',async t=>{
  const {record,response}=changedRun(),f=await fixture(t,{runs:[record],diff:()=>response});f.select(record.id);
  assert.equal(f.calls.filter(([name])=>name==='pi_work_diff').length,0);
  const panel=f.document.querySelector('.piw-changes');panel.querySelector('button').click();for(let i=0;i<80&&!/before/.test(panel.querySelector('.piw-change-diff')?.textContent??'');i++)await settled();
  assert.match(panel.querySelector('.piw-change-diff').textContent,/before.*after/s);
  assert.deepEqual(f.calls.filter(([name])=>name==='pi_work_diff'),[['pi_work_diff',{runId:record.id,changeId}]]);
  record.finalOutput='new result';await f.controller.refresh();
  assert.equal(f.document.querySelector('.piw-changes'),panel);assert.match(panel.textContent,/before.*after/s);
  assert.equal(f.calls.filter(([name])=>name==='pi_work_diff').length,1);
});
test('changing the selected run destroys a pending diff and ignores its late response',async t=>{
  const {record,response}=changedRun();let deliver;const pending=new Promise(resolve=>{deliver=resolve;}),f=await fixture(t,{runs:[record,run()],diff:()=>pending});f.select(record.id);
  const panel=f.document.querySelector('.piw-changes');panel.querySelector('button').click();await flush();f.select('r1');deliver(response);await settled();
  assert.equal(panel.isConnected,false);assert.equal(panel.textContent,'');assert.equal(f.document.querySelector('.piw-change-diff'),null);
  assert.equal(f.document.querySelector('.piw-turn .piw-changes').textContent.includes('旧記録'),true);
});
test('leaving AI discards an in-flight private diff even when returning to the same run',async t=>{
  const {record,response}=changedRun();let deliver;const pending=new Promise(resolve=>{deliver=resolve;}),f=await fixture(t,{runs:[record],diff:()=>pending});f.select(record.id);
  const panel=f.document.querySelector('.piw-changes');panel.querySelector('button').click();await flush();f.view('feed');f.view('ai');await flush();deliver(response);await settled();
  assert.equal(panel.isConnected,false);assert.equal(panel.textContent,'');const fresh=f.document.querySelector('.piw-changes');assert.ok(fresh);assert.notEqual(fresh,panel);assert.equal(fresh.querySelector('.piw-change-diff').textContent,'');
  assert.equal(f.calls.filter(([name])=>name==='pi_work_diff').length,1);
});

test('permission presets only set the hidden checkboxes that pi_work_start sends; write needs the inline confirm',async t=>{
  const f=await fixture(t,{runs:[]});const preset=id=>f.document.querySelector(`#pi-work-perm-popover [data-preset="${id}"]`);
  assert.equal(f.el('pi-work-perm-chip-label').textContent,'都度承認');
  preset('write').click();assert.equal(f.el('pi-work-allow-write').checked,false);assert.equal(f.el('pi-work-write-confirm').hidden,false);
  preset('tools').click();assert.deepEqual(['write','exec','http'].map(id=>f.el('pi-work-allow-'+id).checked),[false,true,true]);assert.equal(f.el('pi-work-perm-chip-label').textContent,'コマンドと通信を使う');
  preset('write').click();f.el('pi-work-write-confirm-ok').click();assert.deepEqual(['write','exec','http'].map(id=>f.el('pi-work-allow-'+id).checked),[true,false,false]);
  f.el('pi-work-prompt').value='作業';f.el('pi-work-prompt').dispatchEvent(new f.dom.window.Event('input'));f.el('pi-work-start').click();await flush();
  const request=f.calls.find(([command])=>command==='pi_work_start')[1];assert.deepEqual([request.allowWrite,request.allowExec,request.allowHttp],[true,false,false]);
});

test('permission presets are locked while a run is live and the draft check keeps a verifier hint',async t=>{
  const f=await fixture(t,{runs:[run({status:'running'})]});await flush();
  assert.equal(f.el('pi-work-perm-lock').hidden,false);assert.equal(f.document.querySelector('#pi-work-perm-popover [data-preset="tools"]').disabled,true);
  f.document.querySelector('#pi-work-perm-popover [data-preset="tools"]').click();assert.equal(f.el('pi-work-allow-exec').checked,false);
});
