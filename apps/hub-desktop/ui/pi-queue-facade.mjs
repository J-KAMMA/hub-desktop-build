const uuid=value=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length
  &&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const safe=value=>Number.isSafeInteger(value)&&value>=0;
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/\p{Surrogate}|\u0000/u.test(value);
const workspace=value=>text(value,32768)&&value.length>0&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const model=value=>text(value,512)&&value.includes('/')&&!/\s/u.test(value)&&!value.startsWith('/')&&!value.endsWith('/');
const permissions=value=>exact(value,['allowWrite','allowExec','allowHttp'])&&Object.values(value).every(flag=>typeof flag==='boolean');
const states=new Set(['queued','held','starting','running','done','failed','cancelled','unknown']);
const terminal=new Set(['done','failed','cancelled']);
const editable=item=>item&&['queued','held'].includes(item.state);
const copy=value=>structuredClone(value);
const failure=code=>Object.assign(new Error(code),{code,outcomeUnknown:code==='pi_queue_unknown'||code==='pi_queue_release_unknown'});
const reject=code=>Promise.reject(failure(code));
// These exact codes are guaranteed by Native's atomic apply/adapter preapply boundary.
const preapplyCodes=new Set(['pi_work_queue_invalid_request','pi_work_queue_context_changed','pi_work_queue_revision_conflict',
  'pi_work_queue_request_conflict','pi_work_queue_state_conflict','pi_work_queue_limit','pi_work_queue_unavailable',
  'pi_queue_invalid','pi_queue_stale','pi_queue_unavailable']);
function preapplyRejection(error){
  try{
    const code=typeof error==='string'?error:Object.getOwnPropertyDescriptor(error??{},'code')?.value
      ??Object.getOwnPropertyDescriptor(error??{},'message')?.value;
    return typeof code==='string'&&preapplyCodes.has(code);
  }catch{return false;}
}
function capture(value){
  if(!exact(value,['bridgeId','anchorRunId','expectedWorkspace','expectedModel'])||!uuid(value.bridgeId)||!uuid(value.anchorRunId)
    ||!workspace(value.expectedWorkspace)||!model(value.expectedModel))throw failure('pi_queue_unavailable');
  return {...value};
}
const sameCapture=(a,b)=>Object.keys(a).every(key=>a[key]===b[key]);
function snapshotValue(value,scope,token=null){
  if(!exact(value,['context','revision','available','items'])||!safe(value.revision)||typeof value.available!=='boolean'
    ||!Array.isArray(value.items)||value.items.length>32)throw failure('pi_queue_unavailable');
  const context=value.context;
  if(context!==null&&(!exact(context,['token','workspace','model','engine','permissions'])||!uuid(context.token)
    ||context.workspace!==scope.expectedWorkspace||context.model!==scope.expectedModel||!['pi','dsh'].includes(context.engine)
    ||!permissions(context.permissions)))throw failure('pi_queue_unavailable');
  if(token!==null&&context?.token!==token||value.available&&context===null)throw failure('pi_queue_unavailable');
  const queueIds=new Set(),requests=new Set(),messages=new Set();let pending=0,total=0;
  for(const item of value.items){
    if(!exact(item,['queueId','requestId','userMessageId','anchorRunId','workspace','text','model','engine','permissions','position','held','requestedAtMs','state','nativeRunId'])
      ||!['queueId','requestId','userMessageId','anchorRunId'].every(key=>uuid(item[key]))||!workspace(item.workspace)||!model(item.model)
      ||!text(item.text,8000)||!item.text.trim()||!['pi','dsh'].includes(item.engine)||!permissions(item.permissions)
      ||!safe(item.position)||item.position<1||item.position>32||typeof item.held!=='boolean'||!safe(item.requestedAtMs)
      ||!states.has(item.state)||item.nativeRunId!==null&&!uuid(item.nativeRunId)
      ||queueIds.has(item.queueId)||requests.has(item.requestId)||messages.has(item.userMessageId))throw failure('pi_queue_unavailable');
    queueIds.add(item.queueId);requests.add(item.requestId);messages.add(item.userMessageId);
    if(item.nativeRunId===null&&!terminal.has(item.state)){pending++;total+=item.text.length;}
  }
  if(pending>8||total>32768)throw failure('pi_queue_unavailable');
  return copy(value);
}
function queueAnchorDescends(items,item,requested,context){
  const sameScope=record=>record.workspace===context.workspace&&record.model===context.model&&record.engine===context.engine
    &&['allowWrite','allowExec','allowHttp'].every(key=>record.permissions[key]===context.permissions[key]);
  if(!sameScope(item))return false;
  const parents=new Map();
  for(const record of items){
    if(record.nativeRunId===null)continue;
    if(parents.has(record.nativeRunId))return false;
    parents.set(record.nativeRunId,record);
  }
  let cursor=item.anchorRunId,reached=false;const visited=new Set();
  for(let step=0;step<=items.length;step++){
    if(visited.has(cursor))return false;
    visited.add(cursor);if(cursor===requested)reached=true;
    const parent=parents.get(cursor);
    if(!parent)return reached;
    // Scope is evidence for the descendant path. Earlier ancestors only check for cycles.
    if(!reached&&!sameScope(parent))return false;
    cursor=parent.anchorRunId;
  }
  return false;
}
function operation(value){
  const keys={enqueue:['anchorRunId','text'],edit:['queueId','text'],cancel:['queueId'],reorder:['queueId','beforeQueueId'],resume:['queueId','anchorRunId']};
  const kind=Object.getOwnPropertyDescriptor(value??{},'action')?.value;
  if(!Object.hasOwn(keys,kind)||!exact(value,['expectedRevision','requestId','action',...keys[kind]])||!safe(value.expectedRevision)
    ||!uuid(value.requestId)||keys[kind].some(key=>key==='text'?!text(value.text,8000)||!value.text.trim():key==='beforeQueueId'?value[key]!==null&&!uuid(value[key]):!uuid(value[key]))
    ||kind==='reorder'&&value.beforeQueueId===value.queueId)throw failure('pi_queue_invalid');
  // Rebuild the fixed body; model/permissions/script/URL never come from an action.
  return {expectedRevision:value.expectedRevision,requestId:value.requestId,action:kind,...Object.fromEntries(keys[kind].map(key=>[key,value[key]]))};
}
function receiptValue(value,token,input){
  if(!exact(value,['context','requestId','revision','queueId','applied'])||value.context!==token||value.requestId!==input.requestId
    ||!safe(value.revision)||value.revision<input.expectedRevision||!uuid(value.queueId)||value.applied!==true
    ||input.queueId&&value.queueId!==input.queueId)throw failure('pi_queue_unknown');
  return copy(value);
}

/** Native owns execution. This facade keeps only this surface's ephemeral observations. */
export function createPiQueueFacade({invoke,getContext,isCurrent,onInvalidate=()=>{}}){
  if(typeof invoke!=='function'||typeof getContext!=='function'||typeof isCurrent!=='function'||typeof onInvalidate!=='function')throw failure('pi_queue_invalid');
  let closed=false,disposed=false,epoch=0,scope=null,token=null,latest=null,opening=null,openingEpoch=null,readTurn=0,rejectedContext=null;
  const ledger=new Map(),releases=new Map(),issued=new Set();
  const current=()=>{try{return isCurrent()===true;}catch{return false;}};
  function release(value){
    if(!uuid(value))return Promise.resolve();
    if(!releases.has(value))releases.set(value,Promise.resolve().then(()=>invoke('pi_work_queue_release',{request:{context:value}})).then(()=>undefined,()=>{throw failure('pi_queue_release_unknown');}));
    return releases.get(value);
  }
  function invalidate(){
    if(!closed){closed=true;epoch++;readTurn++;latest=null;const old=token;token=null;
      if(old)void release(old).catch(()=>{});
      try{onInvalidate({code:'pi_queue_stale'});}catch{}
    }
  }
  async function fresh(expected,turn){
    if(closed||turn!==epoch)throw failure('pi_queue_stale');
    if(!current()){invalidate();throw failure('pi_queue_stale');}
    let actual;try{actual=capture(await getContext());}catch{invalidate();throw failure('pi_queue_stale');}
    if(closed||turn!==epoch)throw failure('pi_queue_stale');
    if(!current()||expected&&!sameCapture(actual,expected)){invalidate();throw failure('pi_queue_stale');}
    return actual;
  }
  async function establish(expected){
    if(token)return;
    if(opening&&openingEpoch!==epoch){
      const turn=epoch;try{await opening;}catch{}
      await fresh(expected,turn);if(token)return;
    }
    if(!opening)openingEpoch=epoch;
    if(!opening)opening=(async()=>{
      const turn=epoch,selected=await fresh(expected,turn);scope=selected;
      await fresh(selected,turn);let raw;
      try{raw=await invoke('pi_work_queue_context',{request:selected});}catch{await fresh(selected,turn);throw failure('pi_queue_unavailable');}
      // Even a late/invalid result's generated context is released, never adopted.
      const generated=Object.getOwnPropertyDescriptor(Object.getOwnPropertyDescriptor(raw??{},'context')?.value??{},'token')?.value;
      if(uuid(generated))issued.add(generated);
      try{await fresh(selected,turn);const parsed=snapshotValue(raw,selected);token=parsed.context?.token??null;latest=parsed;}
      catch(error){if(uuid(generated))void release(generated).catch(()=>{});throw error;}
    })().finally(()=>{opening=null;openingEpoch=null;});
    return opening;
  }
  function reconcile(value){
    for(const entry of ledger.values()){
      if(entry.state!=='unknown'||entry.input.action!=='enqueue'||entry.context!==value.context?.token)continue;
      const item=value.items.find(item=>item.requestId===entry.input.requestId);
      if(item&&queueAnchorDescends(value.items,item,entry.input.anchorRunId,value.context)&&item.text===entry.input.text&&item.workspace===scope.expectedWorkspace
        &&item.model===scope.expectedModel&&item.engine===value.context.engine
        &&['allowWrite','allowExec','allowHttp'].every(key=>item.permissions[key]===value.context.permissions[key])){
        // This proves an actual reservation ID, not a synthetic action ACK.
        entry.state='observed';entry.queueId=item.queueId;
      }
    }
  }
  async function snapshot(){
    const turn=epoch,selected=await fresh(scope,turn);await establish(selected);await fresh(selected,turn);
    if(!token)return copy(latest);
    const sequence=++readTurn,activeToken=token;let raw;
    try{raw=await invoke('pi_work_queue_snapshot',{request:{context:activeToken}});}catch{await fresh(scope,turn);throw failure('pi_queue_unavailable');}
    await fresh(scope,turn);
    if(sequence!==readTurn)throw failure('pi_queue_stale');
    const value=snapshotValue(raw,scope,activeToken);
    if(latest&&value.revision<latest.revision)throw failure('pi_queue_stale');
    latest=value;if(rejectedContext===activeToken)rejectedContext=null;reconcile(value);return copy(value);
  }
  function action(value){
    let input;try{input=operation(value);}catch(error){return Promise.reject(error);}
    if(closed||!current()){invalidate();return reject('pi_queue_stale');}
    if(!token||!latest?.available||!scope)return reject('pi_queue_unavailable');
    const signature=JSON.stringify(input),prior=ledger.get(input.requestId);
    if(prior){
      if(prior.signature!==signature||prior.context!==token)return reject('pi_queue_request_conflict');
      if(prior.state==='pending')return prior.promise;
      if(prior.state==='rejected')return prior.promise;
      if(prior.state==='confirmed')return fresh(scope,epoch).then(()=>copy(prior.receipt));
      return reject(prior.state==='observed'?'pi_queue_observed':'pi_queue_unknown');
    }
    if([...ledger.values()].some(entry=>entry.context===token&&entry.state==='unknown'))return reject('pi_queue_unknown');
    if([...ledger.values()].some(entry=>entry.context===token&&entry.state==='pending'))return reject('pi_queue_busy');
    if(rejectedContext===token)return reject('pi_queue_conflict');
    if(input.expectedRevision!==latest.revision)return reject('pi_queue_conflict');
    if(input.anchorRunId&&input.anchorRunId!==scope.anchorRunId)return reject('pi_queue_invalid');
    if(input.queueId){
      const item=latest.items.find(item=>item.queueId===input.queueId);
      if(!editable(item)||input.action==='resume'&&!item.held)return reject('pi_queue_invalid');
      if(input.action==='reorder'&&input.beforeQueueId!==null&&!editable(latest.items.find(item=>item.queueId===input.beforeQueueId)))return reject('pi_queue_invalid');
    }
    const selected={...scope},turn=epoch,entry={input,signature,context:token,state:'pending',promise:null,receipt:null,queueId:null};
    ledger.set(input.requestId,entry);
    entry.promise=(async()=>{
      let sent=false;
      try{
        await fresh(selected,turn);sent=true;
        const raw=await invoke('pi_work_queue_action',{request:{context:entry.context,...input}});
        await fresh(selected,turn);const receipt=receiptValue(raw,entry.context,input);
        entry.state='confirmed';entry.receipt=receipt;entry.queueId=receipt.queueId;return copy(receipt);
      }catch(error){
        try{await fresh(selected,turn);}catch{}
        entry.state=sent?'unknown':'rejected';
        if(closed||turn!==epoch)throw failure('pi_queue_stale');
        if(sent&&preapplyRejection(error)){
          entry.state='rejected';rejectedContext=entry.context;
          throw failure('pi_queue_rejected');
        }
        throw failure(sent?'pi_queue_unknown':'pi_queue_stale');
      }
    })();
    return entry.promise;
  }
  async function dispose(){
    disposed=true;invalidate();if(opening)try{await opening;}catch{}
    const results=await Promise.allSettled([...releases.values()]);ledger.clear();scope=null;
    if(results.some(result=>result.status==='rejected'))throw failure('pi_queue_release_unknown');
  }
  async function queueContext(input){
    let requested;try{requested=capture(input);}catch{throw failure('pi_queue_invalid');}
    if(disposed||!current())throw failure('pi_queue_stale');
    const turn=epoch;let actual;try{actual=capture(await getContext());}catch{throw failure('pi_queue_unavailable');}
    if(disposed||turn!==epoch||!current())throw failure('pi_queue_stale');
    if(!sameCapture(actual,requested))throw failure('pi_queue_stale');
    if(scope&&!sameCapture(scope,actual))invalidate();
    // Only this explicit selection hook can open a new observation after release/change.
    // Old await continuations keep their original epoch and cannot close/adopt the new one.
    if(closed){closed=false;epoch++;scope=null;latest=null;readTurn++;}
    const selectedTurn=epoch;await establish(actual);await fresh(actual,selectedTurn);
    return copy(latest);
  }
  function queueSnapshot(input){
    if(!exact(input,['context'])||!uuid(input.context))return reject('pi_queue_invalid');
    if(!token||input.context!==token)return reject('pi_queue_stale');
    return snapshot();
  }
  function queueAction(input){
    if(input===null||typeof input!=='object'||Array.isArray(input))return reject('pi_queue_invalid');
    const keys=Reflect.ownKeys(input);
    if(keys.some(key=>typeof key!=='string')||!exact(input,keys)||!keys.includes('context')||!uuid(input.context))return reject('pi_queue_invalid');
    if(!token||input.context!==token)return reject('pi_queue_stale');
    return action(Object.fromEntries(keys.filter(key=>key!=='context').map(key=>[key,input[key]])));
  }
  function queueRelease(input){
    if(!exact(input,['context'])||!uuid(input.context)||!issued.has(input.context))return reject('pi_queue_invalid');
    if(input.context===token)invalidate();
    return release(input.context);
  }
  return {snapshot,action,invalidate,dispose,queueContext,queueSnapshot,queueAction,queueRelease};
}
