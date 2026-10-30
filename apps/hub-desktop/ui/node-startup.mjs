const known=value=>value==='enabled'||value==='disabled';
const messages={
  unknown:'Windowsの起動設定は未確認です。保存済みの希望は保持しています。',
  pending:'Windowsの起動設定を確認しています。変更はまだ適用していません。',
  enabled:'Windowsのログイン起動に登録されています。保存するとチェックの選択を適用します。実際の起動はWindows側の設定でも確認してください。',
  disabled:'Windowsのログイン起動には登録されていません。保存するとチェックの選択を適用します。',
  different_path:'別の場所のHubが登録されています。この画面から起動設定は変更しません。保存済みの希望は保持しています。',
  unavailable:'Windowsの起動設定を確認できません。保存済みの希望は保持しています。',
  unsupported:'この環境ではログイン起動を設定できません。保存済みの希望は保持しています。',
};
function checked(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==2
    ||!Object.hasOwn(value,'supported')||!Object.hasOwn(value,'status')||typeof value.supported!=='boolean')return 'unavailable';
  return value.supported===true&&['enabled','disabled','different_path','unavailable'].includes(value.status)
    ||value.supported===false&&value.status==='unsupported'?value.status:'unavailable';
}

/** Actual readonly OS registration and the saved Node preference remain separate. */
export function createNodeStartup({document,invoke,checkbox,status,isMain,isCurrent}){
  if(!document||checkbox?.ownerDocument!==document||checkbox.type!=='checkbox'||status?.ownerDocument!==document
    ||[invoke,isMain,isCurrent].some(value=>typeof value!=='function'))throw Error('node_startup_invalid_host');
  let disposed=false,generation=0,inFlight=null,saved=checkbox.checked,dirty=false,draft=checkbox.checked,state='unknown';
  const alive=()=>!disposed&&isMain()===true&&isCurrent()===true;
  function render(){
    checkbox.disabled=!alive()||!known(state);
    checkbox.checked=known(state)?dirty?draft:state==='enabled':state==='pending'&&dirty?draft:saved;
    status.textContent=messages[state]+(known(state)&&dirty?' 選択の変更はまだ保存していません。':'');
  }
  const edited=()=>{if(!alive()||checkbox.disabled||!known(state))return;draft=checkbox.checked;dirty=true;render();};
  checkbox.addEventListener('change',edited);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  render();
  function refresh(){
    if(!alive())return Promise.resolve();
    if(inFlight)return inFlight;
    const turn=++generation;state='pending';render();
    const task=Promise.resolve().then(async()=>{
      if(!alive()||turn!==generation)return;
      try{
        const value=await invoke('node_startup_status');
        if(!alive()||turn!==generation)return;
        state=checked(value);
        // Only a fresh OS read and matching saved preference confirm a draft.
        if(dirty&&known(state)&&(state==='enabled')===draft&&saved===draft)dirty=false;
        render();
      }catch{if(alive()&&turn===generation){state='unavailable';render();}}
    }).finally(()=>{if(inFlight===task)inFlight=null;});
    inFlight=task;return task;
  }
  return Object.freeze({
    setSavedPreference(value){if(typeof value!=='boolean')throw Error('node_startup_invalid_preference');if(disposed||isMain()!==true)return;saved=value;if(alive())render();},
    refresh,
    saveInput(){return alive()&&!inFlight&&known(state)?{launchAtLogin:checkbox.checked,applyStartup:true}:{launchAtLogin:saved,applyStartup:false};},
    destroy(){if(disposed)return;disposed=true;generation++;checkbox.removeEventListener('change',edited);checkbox.disabled=true;},
  });
}
