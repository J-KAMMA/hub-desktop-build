const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const uuid=value=>typeof value==='string'&&value.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const id=value=>typeof value==='string'&&value.length<=160&&!/\p{Cc}/u.test(value)&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const thumb=value=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/.test(value);
const timestamp=value=>typeof value==='string'&&value.length>0&&value.length<=64&&!/[\p{Cc}\p{Surrogate}]/u.test(value)&&Number.isFinite(Date.parse(value));
const preSign=new Set(['invalid_request','invalid_preview','expired','account_required','account_changed','identity_changed','origin_changed','node_changed','invalid_challenge','unavailable'].map(code=>'personal_node_reactivation_'+code));
function nodeOrigin(value){
  if(typeof value!=='string'||value.length>2048||/[\p{Cc}\p{Surrogate}]/u.test(value))return null;
  try{const url=new URL(value),host=url.hostname;if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.port||!host.includes('.')||host.endsWith('.')||/\.(?:local|localhost|internal)$/.test(host))return null;
    if(/^\d+\.\d+\.\d+\.\d+$/.test(host)){const[a,b]=host.split('.').map(Number);if([0,10,127].includes(a)||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===198&&[18,19].includes(b))return null;}return value;
  }catch{return null;}
}
function hubOrigin(value){
  try{const url=new URL(value);return typeof value==='string'&&value.length<=512&&!/[\p{Cc}\p{Surrogate}]/u.test(value)&&url.origin===value&&!url.username&&!url.password&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname));}catch{return false;}
}
function pin(raw){
  if(!raw||!id(raw.viewerId)||typeof raw.account!=='string'||!raw.account||!Number.isSafeInteger(raw.generation)||raw.generation<0||raw.node?.status!=='revoked'||!nodeOrigin(raw.node.nodeUrl)||!thumb(raw.node.keyThumbprint)||!timestamp(raw.node.updatedAt))return null;
  return Object.freeze({viewerId:raw.viewerId,account:raw.account,generation:raw.generation,node:Object.freeze({nodeUrl:raw.node.nodeUrl,keyThumbprint:raw.node.keyThumbprint,status:'revoked',updatedAt:raw.node.updatedAt})});
}

/** Same-key reactivation only. Native owns the purpose-bound challenge and signing. */
export function createPersonalNodeReactivation(document,{invoke,getContext,isCurrent=()=>true,onReload,now=Date.now}){
  const element=document.createElement('section');element.className='detail-form';element.setAttribute('aria-label','Personal Nodeを再有効化');
  const paragraph=value=>{const node=document.createElement('p');node.className='meta';node.textContent=value;return node;};
  const status=paragraph('');status.setAttribute('role','status');
  let bound;try{bound=pin(getContext());}catch{bound=null;}
  let disposed=false,invalid=false,busy=false,locked=false,preview=null,turn={},viewObserver=null;
  const matches=()=>{try{const next=pin(getContext());return next&&bound&&next.viewerId===bound.viewerId&&next.account===bound.account&&next.generation===bound.generation&&['nodeUrl','keyThumbprint','updatedAt'].every(key=>next.node[key]===bound.node[key]);}catch{return false;}};
  const current=()=>{try{if(!disposed&&!invalid&&bound&&!matches()){invalidate();return false;}return !disposed&&!invalid&&bound&&element.isConnected&&!element.closest('[hidden]')&&isCurrent()===true;}catch{return false;}};
  const active=token=>current()&&token===turn;
  const button=(label,action)=>{const node=document.createElement('button');node.type='button';node.className='head-action';node.textContent=label;node.onclick=()=>{if(current()&&!busy)return action();};return node;};
  const previewHost=document.createElement('div');
  async function cancelNative(id){if(!uuid(id))return false;try{const result=await invoke('personal_node_reactivation_complete',{previewId:id,confirmed:false});return exact(result,['cancelled'])&&result.cancelled===true;}catch{return false;}}
  function detach(){viewObserver?.disconnect();for(const event of ['hub-account-changed','hub-origin-changed'])document.defaultView?.removeEventListener(event,invalidate);}
  function invalidate(){if(disposed||invalid)return;invalid=true;turn={};const old=preview;preview=null;if(old)void cancelNative(old.previewId);detach();previewHost.replaceChildren();prepare.disabled=true;recheck.hidden=true;status.textContent='接続先・本人・画面が変わりました。登録状態を読み直してください。';}
  function validPreview(value){
    const expiry=typeof value?.expiresAt==='string'?Date.parse(value.expiresAt):NaN;
    return exact(value,['previewId','viewerId','nodeUrl','keyThumbprint','revokedAt','expiresAt','hubOrigin'])&&uuid(value.previewId)&&value.viewerId===bound.viewerId&&value.nodeUrl===bound.node.nodeUrl&&value.keyThumbprint===bound.node.keyThumbprint&&value.revokedAt===bound.node.updatedAt&&Number.isFinite(expiry)&&new Date(expiry).toISOString()===value.expiresAt&&expiry>now()&&expiry-now()<=600000&&hubOrigin(value.hubOrigin);
  }
  function paint(){
    element.setAttribute('aria-busy',String(busy));prepare.disabled=busy||locked;recheck.hidden=!locked;recheck.disabled=busy;previewHost.replaceChildren();if(!preview)return;
    const captured=preview;previewHost.append(paragraph(`Hubプロフィール: ${captured.viewerId}`),paragraph(`再接続するノード: ${captured.nodeUrl}`),paragraph(`元の公開鍵の指紋: ${captured.keyThumbprint}`),paragraph(`Hub: ${captured.hubOrigin}`),paragraph(`失効時刻: ${captured.revokedAt}`),paragraph(`確認期限: ${captured.expiresAt}`));
    const confirm=button('確認して再有効化',()=>complete(captured)),cancel=button('キャンセル',async()=>{
      if(locked||preview!==captured)return;const token=turn={};preview=null;busy=true;paint();const cancelled=await cancelNative(captured.previewId);if(!active(token))return;busy=false;locked=!cancelled;status.textContent=cancelled?'確認内容を破棄しました。再有効化は実行していません。':'確認内容の破棄を確認できませんでした。再署名せず、状態を再確認してください。';paint();
    });confirm.disabled=cancel.disabled=busy||locked;previewHost.append(confirm,cancel);
  }
  async function prepareReactivation(){
    if(!current()||busy||locked)return;const token=turn={},old=preview;preview=null;busy=true;status.textContent='元の登録情報と再有効化の内容を確認しています…';paint();
    try{
      if(old&&!await cancelNative(old.previewId)){if(active(token)){locked=true;status.textContent='前の確認内容の破棄を確認できませんでした。状態を再確認してください。';}return;}if(!active(token))return;
      const value=await invoke('personal_node_reactivation_prepare',{expectedViewerId:bound.viewerId,expectedNodeUrl:bound.node.nodeUrl,expectedKeyThumbprint:bound.node.keyThumbprint});
      if(!active(token)){void cancelNative(value?.previewId);return;}
      if(!validPreview(value)){void cancelNative(value?.previewId);throw Error('personal_node_reactivation_invalid_challenge');}
      preview=Object.freeze({...value});status.textContent='元の接続先・公開鍵の指紋・端末への影響を確認してから再有効化してください。';
    }catch{if(active(token)){locked=true;status.textContent='再有効化の準備を確認できませんでした。状態を再確認してください。';}}
    finally{if(active(token)){busy=false;paint();}}
  }
  const sameNode=latest=>latest?.viewerId===bound.viewerId&&latest.node?.nodeUrl===bound.node.nodeUrl&&latest.node.keyThumbprint===bound.node.keyThumbprint;
  async function complete(captured){
    if(!current()||busy||locked||preview!==captured)return;
    if(Date.parse(captured.expiresAt)<=now()){preview=null;void cancelNative(captured.previewId);status.textContent='確認期限が過ぎました。もう一度、登録内容を確認してください。';paint();return;}
    const token=turn={};preview=null;busy=true;locked=true;status.textContent='再有効化の結果を確認しています…';paint();
    try{
      const result=await invoke('personal_node_reactivation_complete',{previewId:captured.previewId,confirmed:true});if(!active(token))return;
      if(!exact(result,['viewerId','reactivated','nodeUrl','keyThumbprint'])||result.reactivated!==true||result.viewerId!==bound.viewerId||result.nodeUrl!==bound.node.nodeUrl||result.keyThumbprint!==bound.node.keyThumbprint)throw Error('personal_node_reactivation_unknown');
      const latest=await onReload(bound.viewerId);
      if(!sameNode(latest)||latest.node.status!=='active')throw Error('personal_node_reactivation_unknown');
      if(active(token))status.textContent='同じ接続先と鍵の有効な登録状態を確認しました。';
    }catch(error){if(active(token)){status.textContent=preSign.has(String(error?.message??error))?'再有効化は実行できませんでした。状態を再確認してから、もう一度準備してください。':'再有効化の結果が不明です。再署名せず、状態を再確認してください。';}}
    finally{if(active(token)){busy=false;paint();}}
  }
  const prepare=button('再有効化の内容を確認',prepareReactivation),recheck=button('状態を再確認',async()=>{
    if(!locked)return;const token=turn={};busy=true;status.textContent='登録状態を再確認しています…';paint();
    try{
      const latest=await onReload(bound.viewerId);if(!sameNode(latest))throw Error('state_unconfirmed');
      if(!active(token))return;
      if(latest.node.status==='active')status.textContent='同じ接続先と鍵の登録は現在有効です。新たな再有効化は実行していません。';
      else if(latest.node.status==='revoked'&&latest.node.updatedAt===bound.node.updatedAt){locked=false;status.textContent='失効中の登録状態を確認しました。新しい確認内容を明示的に準備できます。';}
      else throw Error('state_unconfirmed');
    }catch{if(active(token))status.textContent='登録状態の一致を確認できませんでした。再署名せず、登録状態を読み直してください。';}
    finally{if(active(token)){busy=false;paint();}}
  });
  if(bound){element.append(paragraph(`元の接続先: ${bound.node.nodeUrl}`),paragraph(`元の公開鍵の指紋: ${bound.node.keyThumbprint}`),paragraph('既存の有効な端末は、同じ権限で再接続できるようになります。失効した端末の権限は復活しません。'),paragraph('接続先・鍵の変更や鍵の紛失は、この操作では扱いません。別の変更・復旧手順が必要です。'),prepare,previewHost,recheck,status);paint();}
  else{status.textContent='失効状態と元の接続先・鍵・失効時刻を確認してから再有効化してください。';element.append(status);}
  for(const event of ['hub-account-changed','hub-origin-changed'])document.defaultView?.addEventListener(event,invalidate);
  Promise.resolve().then(()=>{const panel=element.closest('[data-view-panel]');if(!disposed&&!invalid&&panel?.classList.contains('on')&&document.defaultView?.MutationObserver){viewObserver=new document.defaultView.MutationObserver(records=>{if(!panel.classList.contains('on')||records.some(record=>!(record.oldValue??'').split(/\s+/).includes('on')))invalidate();});viewObserver.observe(panel,{attributes:true,attributeFilter:['class'],attributeOldValue:true});}});
  return{element,invalidate,dispose(){if(disposed)return;invalidate();disposed=true;turn={};detach();element.remove();}};
}
