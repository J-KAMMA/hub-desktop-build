import {createReadRecovery} from './hub-read-recovery.mjs';
const LEGACY='hub.network.sources.v1';
export function normalizeHubOrigin(raw) {
  if(typeof raw!=='string'||raw.length>512)throw Error('HubのURLを確認してください。');
  const url=new URL(raw.trim());
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('HTTPSのHub URLを指定してください。ローカルHubはHTTPも使えます。');
  return url.origin;
}

// Only public source URLs are cached. The local device ID binds the cache to its owner.
export function createSourceSync({base,invoke,storage,getAccount,onChange}) {
  const key=`hub.network.account-sources.v1.${encodeURIComponent(base)}`;
  const localKey=`hub.network.device-sources.v1.${encodeURIComponent(base)}`,scopeKey=`hub.network.source-scope.v1.${encodeURIComponent(base)}`;
  let version=0,owner='',busy=false,disposed=false;
  let state={sources:[],legacy:[],mode:'loading',message:'接続先を確認しています…',busy:false};
  const clean=value=>Array.isArray(value)?[...new Set(value.flatMap(raw=>{try{return [normalizeHubOrigin(raw)];}catch{return [];}}))].filter(s=>s!==base).slice(0,8):[];
  const read=key=>{try{return JSON.parse(storage.getItem(key)||'null');}catch{return null;}};
  let localOnly=read(scopeKey)==='device';
  const account=()=>{if(localOnly)return '';const a=getAccount();return !a?null:a.state==='registered'&&a.deviceId?a.deviceId:'';};
  const emit=patch=>{state={...state,...patch,busy,scope:localOnly?'device':'profile'};onChange({...state});};
  const cache=sources=>{try{storage.setItem(key,JSON.stringify({deviceId:owner,sources}));return true;}catch{return false;}};
  const forget=()=>{try{storage.removeItem(key);}catch{/* The current view still drops the old account's sources. */}};
  const isCurrent=(token,device)=>!disposed&&token===version&&account()===device;
  const recovery=createReadRecovery({retry:()=>refresh(true),active:()=>!disposed&&!!owner&&account()===owner&&state.mode==='offline'});
  const failure=(error,retryRead=false)=>{
    if(/account_required|account_changed/.test(String(error))){forget();emit({sources:[],mode:'auth',message:'Desktopを接続し直してください。'});}
    else {emit({mode:'offline',message:'接続先設定を取得できません。前回の一覧で閲覧できます。再試行してください。'});if(retryRead&&recovery.schedule(error))emit({message:'Hubへの接続を待っています。前回の一覧を使いながら自動で再取得します。'});}
  };
  async function refresh(automatic=false) {
    if(disposed)return;
    if(!automatic)recovery.reset();
    const device=account();
    if(busy&&device===owner)return;
    const token=++version;busy=false;
    if(device===null){emit({sources:[],mode:'loading'});return;}
    if(localOnly){owner='';emit({sources:clean(read(localKey)),legacy:[],mode:'local',message:'この端末で接続先を管理しています。標準Hubやログインに依存せず、各Hubの公開内容を取得します。'});return;}
    const legacy=clean(read(LEGACY));
    const stored=read(key);
    if(!device||stored?.deviceId!==device)forget();
    owner=device;
    if(!device){emit({sources:legacy,legacy:[],mode:'local',message:'この端末に保存しています。Desktop接続後にWebと共有できます。'});return;}
    emit({sources:stored?.deviceId===device?clean(stored.sources):[],legacy,mode:'loading',message:'アカウントの接続先を確認しています…'});
    try{
      const result=await invoke('hub_network_sources',{action:'list',expectedDeviceId:device});
      if(!isCurrent(token,device))return;
      if(!Array.isArray(result?.sources))throw Error('invalid_response');
      const sources=clean(result.sources),saved=cache(sources);recovery.reset();
      emit({sources,mode:'synced',message:saved?'同じHubプロフィールのWeb・デスクトップで共有しています。':'共有済みですが、この端末に前回の一覧を保存できませんでした。'});
    }catch(error){if(isCurrent(token,device))failure(error,true);}
  }
  async function change(action,raw) {
    const origin=normalizeHubOrigin(raw),device=account();
    if(!['add','remove'].includes(action)||origin===base)throw Error('別のHubのURLを指定してください。');
    if(busy)throw Error('保存が終わるまでお待ちください。');
    if(device!==owner||device===null){await refresh();throw Error('接続状態を確認してから、もう一度操作してください。');}
    if(action==='add'&&!state.sources.includes(origin)&&state.sources.length>=8)throw Error('追加の接続先は8件までです。');
    if(!device){
      const sources=action==='remove'?state.sources.filter(s=>s!==origin):[...new Set([...state.sources,origin])];
      try{storage.setItem(localOnly?localKey:LEGACY,JSON.stringify(sources));}catch{throw Error('この端末に保存できませんでした。');}
      emit({sources});return;
    }
    if(state.mode!=='synced')throw Error('接続先設定を再取得してから変更してください。');
    const token=++version;busy=true;emit({});
    try{
      const result=await invoke('hub_network_sources',{action,origin,expectedDeviceId:device});
      if(!isCurrent(token,device))throw Error('account_changed');
      if(!Array.isArray(result?.sources))throw Error('invalid_response');
      const sources=clean(result.sources),saved=cache(sources);
      emit({sources,message:saved?'接続先を共有しました。':'共有済みですが、この端末に前回の一覧を保存できませんでした。'});
    }catch(error){
      if(isCurrent(token,device)&&String(error)!=='source_limit')failure(error);
      throw Error(String(error)==='source_limit'?'追加の接続先は8件までです。':'保存を確認できませんでした。接続先を再取得してください。');
    }finally{if(token===version){busy=false;emit({});}}
  }
  async function migrate() {
    const device=owner;
    if(!device||state.mode!=='synced'||busy)throw Error('接続先設定を取得してから引き継いでください。');
    for(const source of [...state.legacy]){
      await change('add',source);
      if(account()!==device)throw Error('接続するアカウントが変わりました。');
      const legacy=clean(read(LEGACY)).filter(s=>s!==source);
      try{storage.setItem(LEGACY,JSON.stringify(legacy));}catch{throw Error('引き継ぎ済みですが、この端末の旧一覧を更新できませんでした。');}
      emit({legacy});
    }
  }
  async function setScope(scope) {
    if(!['device','profile'].includes(scope))throw Error('接続先の管理方法を確認してください。');
    if(busy)throw Error('保存が終わるまでお待ちください。');
    try{storage.setItem(scopeKey,JSON.stringify(scope));}catch{throw Error('この端末に管理方法を保存できませんでした。');}
    localOnly=scope==='device';version++;recovery.reset();
    await refresh();
  }
  return {refresh,change,migrate,setScope,dispose:()=>{disposed=true;version++;recovery.reset();},get state(){return {...state,scope:localOnly?'device':'profile'};}};
}
