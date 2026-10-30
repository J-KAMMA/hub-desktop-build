import {isMissingCommandError} from './pi-work.mjs';

/** Narrow native Pi calls for one explicit local trial; every answer is validated before it is used. */
class ComparisonError extends Error {
  constructor(code, outcomeUnknown = false) { super(code); this.name = 'ComparisonError'; this.code = code; this.outcomeUnknown = outcomeUnknown; }
}
const fail = (code = 'comparison_invalid_request', unknown = false) => { throw new ComparisonError(code, unknown); };
const record = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const unicode = value => typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const path = value => unicode(value) && value.trim() && value.length <= 32768 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const engine = value => ['thin', 'dsh'].includes(value);
const model = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9_.:/-]/u.test(value) && !value.includes('..');
const normalize = value => value.replace(/^\\\\\?\\UNC\\/iu, '//').replace(/^\\\\\?\\/u, '').replace(/[\\/]+/gu, '/').replace(/\/+$/u, '').replace(/[A-Z]/g, char => char.toLowerCase());
const sameWorkspace = (a, b) => normalize(a) === normalize(b);
const rejections = new Set(['pi_work_comparison_confirmation_required','pi_work_comparison_workspace_changed',
  'pi_work_comparison_model_invalid','pi_work_comparison_generation_invalid','pi_work_comparison_invalid_request',
  'pi_work_comparison_unavailable','prompt_empty','prompt_too_long','native_window_required','run already in progress']);
function runSnapshot(value, id, unknown = false) {
  if (!record(value) || !uuid(value.id) || id !== undefined && value.id !== id || !path(value.workspace)
    || !engine(value.engine) || !['running', 'done', 'failed', 'cancelled'].includes(value.status)
    || !unicode(value.prompt) || !unicode(value.model)
    || !Array.isArray(value.toolCalls) || value.toolCalls.length > 256 || !Array.isArray(value.pendingActions) || value.pendingActions.length > 64
    || value.pendingActions.some(action => !record(action) || !uuid(action.id) || typeof action.tool !== 'string')) fail(unknown ? 'comparison_result_unknown' : 'comparison_invalid_response', unknown);
  return structuredClone(value);
}
function createComparisonTransport({invoke, isCurrent}) {
  let compareSupported = true, comparing = false, comparisonUnknown = false;
  const current = unknown => {
    let alive = false;
    try { alive = isCurrent() === true; } catch {}
    if (!alive) fail('comparison_superseded', unknown);
  };
  const call = async (command, args, unknown = false) => {
    current(false);
    try { const value = await invoke(command, structuredClone(args)); current(unknown); return value; }
    catch (error) { current(unknown); throw error; }
  };
  const workspace = async () => {
    current(false);
    const value = await call('dev_workspace', {});
    if (value !== null && !path(value)) fail('comparison_invalid_response');
    return value;
  };
  return {
    workspace,
    async models() {
      current(false);
      const value = await call('pi_work_models', {refresh: false});
      if (!record(value) || !Array.isArray(value.models) || value.models.some(item => typeof item !== 'string')) fail('comparison_invalid_response');
      return value;
    },
    async compareRun(input) {
      current(false);
      const generation = input.generation;
      if (!path(input.workspace) || !unicode(input.prompt) || input.prompt.includes('\0') || !input.prompt.trim() || input.prompt.length > 8000
        || !model(input.model) || !input.model.startsWith('ollama/') || input.model.length <= 7 || !engine(input.engine) || input.confirmed !== true
        || !Number.isFinite(generation.temperature) || generation.temperature < 0 || generation.temperature > 2
        || !Number.isSafeInteger(generation.maxTokens) || generation.maxTokens < 1 || generation.maxTokens > 8192
        || !['off','minimal','low','medium','high','xhigh','max'].includes(generation.reasoning)) fail();
      if (!compareSupported) fail('comparison_unavailable');
      if (comparisonUnknown) fail('comparison_result_unknown', true);
      if (comparing) fail('comparison_pending');
      const request = structuredClone(input);
      comparing = true;
      let submitted = false, received = false;
      try {
        const before = await workspace();
        if (before === null || !sameWorkspace(before, request.workspace)) fail('comparison_workspace_changed');
        const catalog = await call('pi_work_models', {refresh: false});
        if (!record(catalog) || !Array.isArray(catalog.models) || !catalog.models.includes(request.model)) fail('comparison_model_unavailable');
        if (await workspace() !== before) fail('comparison_workspace_changed');
        submitted = true;
        const response = await call('pi_work_compare_start', request, true); received = true;
        const started = runSnapshot(response, undefined, true);
        const fresh = runSnapshot(await call('pi_work_status', {id: started.id}), started.id);
        const after = await workspace();
        const sameGeneration = value => record(value) && Reflect.ownKeys(value).length === 3
          && ['temperature','maxTokens','reasoning'].every(key => value[key] === request.generation[key]);
        for (const run of [started, fresh]) {
          if (run.engine !== request.engine || run.model !== request.model || run.prompt !== request.prompt || !sameWorkspace(run.workspace, before)
            || !sameGeneration(run.generation) || run.hello?.generation !== undefined && !sameGeneration(run.hello.generation)
            || ['allowWrite','allowExec','allowHttp','allowTest'].some(key => run[key] !== false)
            || run.continuation?.resumedFrom != null) fail('comparison_result_unknown', true);
        }
        if (after !== before) fail('comparison_result_unknown', true);
        return fresh;
      } catch (error) {
        if (submitted && !received && isMissingCommandError(error)) { compareSupported = false; fail('comparison_unavailable'); }
        const message = typeof error === 'string' ? error : error?.message;
        if (submitted && !received && rejections.has(message)) fail(message === 'pi_work_comparison_unavailable' ? 'comparison_unavailable' : 'comparison_rejected');
        if (submitted) { comparisonUnknown = true; fail(error?.code === 'comparison_superseded' ? error.code : 'comparison_result_unknown', true); }
        throw error;
      } finally { comparing = false; }
    }
  };
}

/** One explicit local trial. No automatic runs, downloads or performance conclusions. */
export function createHarnessComparison({document,invoke,isMain,isCurrent,onStarted=()=>{}}) {
  if (!document?.createElement || typeof invoke !== 'function' || typeof isMain !== 'function'
    || typeof isCurrent !== 'function' || typeof onStarted !== 'function') throw Error('harness_comparison_invalid_host');
  let destroyed=false,busy=false,unknown=false,started=false,unavailable=false,workspace=null,choices=[];
  const alive=()=>!destroyed&&isMain()===true&&isCurrent()===true;
  const transport=createComparisonTransport({invoke,isCurrent:alive});
  const element=document.createElement('section');element.className='harness-comparison';
  const node=(tag,text,className)=>{const value=document.createElement(tag);if(text!==undefined)value.textContent=text;if(className)value.className=className;return value;};
  element.append(node('h3','ローカル実行方式を試す'),node('p','ファイル変更は個別確認。自動的に性能優位を判定しない','piw-meta'));
  const location=node('p','作業フォルダーとモデルを確認してください。','piw-meta');element.append(location);
  const form=node('form');element.append(form);
  const fields={};
  function field(name,title,tag='input') {
    const label=node('label'),control=node(tag);control.name=name;control.setAttribute('aria-label',title);label.append(node('span',title),control);form.append(label);fields[name]=control;return control;
  }
  function select(name,title,values){const control=field(name,title,'select');for(const[value,label]of values){const option=node('option',label);option.value=value;control.append(option);}return control;}
  select('engine','実行方式',[['thin','Pi の道具'],['dsh','DeepSeek Harness']]);
  select('model','ローカルモデル',[]);
  const temperature=field('temperature','Temperature');temperature.type='number';temperature.min='0';temperature.max='2';temperature.step='any';temperature.value='0';
  const maxTokens=field('maxTokens','最大出力トークン');maxTokens.type='number';maxTokens.min='1';maxTokens.max='8192';maxTokens.step='1';maxTokens.value='1024';
  select('reasoning','Reasoning',[...['off','minimal','low','medium','high','xhigh','max'].map(value=>[value,value])]);
  const prompt=field('prompt','依頼','textarea');prompt.maxLength=8000;prompt.rows=4;
  form.append(node('p','選択した方式で1件の試行を開始します。実行・通信・テストの自動許可はありません。同じ初期ファイルの比較は行いません。','piw-meta'));
  const actions=node('div',undefined,'detail-interaction-actions');form.append(actions);
  const refresh=node('button','作業フォルダーとモデルを再確認','head-action');refresh.type='button';refresh.hidden=true;actions.append(refresh);
  const start=node('button','この条件で開始','head-action');start.type='button';actions.append(start);
  const status=node('p','','piw-meta');status.setAttribute('role','status');element.append(status);
  const sync=()=>{
    const disabled=busy||unknown||started||unavailable||!alive();
    refresh.disabled=disabled;start.disabled=disabled||!workspace||choices.length===0;
    for(const control of Object.values(fields))control.disabled=disabled;
  };
  async function load() {
    if(!alive()||busy||unknown||started||unavailable)return;
    busy=true;sync();status.textContent='作業フォルダーとモデルを確認しています。';
    try{
      const currentWorkspace=await transport.workspace(),catalog=await transport.models({refresh:false});
      if(!alive())return;
      const confirmedWorkspace=await transport.workspace();if(!alive())return;
      if(confirmedWorkspace!==currentWorkspace)throw Error('workspace_changed');
      const previous=fields.model.value;
      choices=[...new Set(catalog.models.filter(value=>value.startsWith('ollama/')&&value.length>7&&value.length<=64&&!value.includes('..')&&!/[^A-Za-z0-9_.:/-]/u.test(value)))];
      workspace=currentWorkspace;fields.model.replaceChildren();
      for(const value of choices){const option=node('option',value);option.value=value;fields.model.append(option);}
      if(choices.includes(previous))fields.model.value=previous;else if(choices.includes(catalog.default))fields.model.value=catalog.default;
      location.textContent=workspace?'作業フォルダー: '+workspace:'作業フォルダーが選択されていません。Hubの環境設定で選択してください。';
      refresh.hidden=workspace!==null&&choices.length>0;
      status.textContent=choices.length?'条件を確認して開始してください。':'既存のローカル Ollama モデルが見つかりません。';
    }catch{if(alive()){workspace=null;refresh.hidden=false;status.textContent='作業フォルダーとモデルを確認できませんでした。入力は保持しています。';}}
    finally{busy=false;sync();}
  }
  async function submit() {
    if(!alive()||busy||unknown||started||unavailable||!workspace)return;
    if(!choices.includes(fields.model.value)||!temperature.value||!maxTokens.value){status.textContent='モデルと生成条件を確認してください。';return;}
    const request={workspace,prompt:prompt.value,model:fields.model.value,engine:fields.engine.value,
      generation:{temperature:temperature.valueAsNumber,maxTokens:maxTokens.valueAsNumber,reasoning:fields.reasoning.value},confirmed:true};
    busy=true;sync();status.textContent='開始要求を送っています。';
    try{
      const run=await transport.compareRun(request);if(!alive())return;
      started=true;status.textContent=run.status==='running'
        ? run.hello?.generation?'開始要求を受け付けました。実行履歴で状態を確認してください。':'開始要求を受け付けました。準備中です。実行履歴で状態を確認してください。'
        : '開始要求を受け付けました。実行は'+({done:'終了',failed:'失敗',cancelled:'中断'}[run.status])+'状態です。実行履歴で内容を確認してください。';
      try{await onStarted(run);}catch{if(alive())status.textContent='開始要求を受け付けましたが、履歴を開けませんでした。AI画面で実行履歴を確認してください。';}
    }catch(error){if(!alive())return;
      if(error.outcomeUnknown){unknown=true;status.textContent='開始結果を確認できません。自動再送はしません。AIの実行履歴を確認してください。入力は保持しています。';}
      else if(error.code==='comparison_unavailable'){unavailable=true;status.textContent='このDesktopでは比較開始を利用できません。入力は保持しています。';}
      else {refresh.hidden=false;status.textContent='開始できませんでした。作業フォルダー、モデル、入力条件を確認してください。入力は保持しています。';}
    }finally{busy=false;sync();}
  }
  const prevent=event=>event.preventDefault();
  refresh.addEventListener('click',load);start.addEventListener('click',submit);form.addEventListener('submit',prevent);sync();
  Promise.resolve().then(load);
  return Object.freeze({element,destroy(){if(destroyed)return;destroyed=true;refresh.removeEventListener('click',load);start.removeEventListener('click',submit);form.removeEventListener('submit',prevent);element.remove();}});
}
