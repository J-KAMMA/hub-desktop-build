const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const preSignatureErrors = new Set(['invalid_preview','expired','account_changed','identity_changed','origin_changed','existing','invalid_challenge'].map(code => `personal_node_registration_${code}`));
function publicOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  try {
    const url = new URL(value.trim()), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !host.includes('.') || host.endsWith('.') || /\.(?:localhost|local|internal)$/u.test(host)) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/u.test(host)) {
      const [a,b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0,168].includes(b) || a === 198 && [18,19].includes(b)) return null;
    }
    return url.origin;
  } catch { return null; }
}
function hubOrigin(value) {
  if (publicOrigin(value) === value) return true;
  return ['http://localhost:3020','http://127.0.0.1:3020'].includes(value);
}
function context(value) {
  return value && safeId(value.viewerId) && typeof value.account === 'string' && value.account && Number.isSafeInteger(value.generation) && value.generation >= 0 && value.node === null;
}

export function createPersonalNodeRegistration(document, {invoke,getContext,isCurrent=()=>true,onReload,now=Date.now}) {
  const element=document.createElement('section');element.className='detail-form';element.setAttribute('aria-label','Personal Nodeを登録');
  const bound=getContext();
  const status=document.createElement('p');status.className='meta';status.setAttribute('role','status');
  const form=document.createElement('form');form.className='detail-form';
  const label=document.createElement('label');label.textContent='Personal Nodeの公開HTTPS接続先';
  const input=document.createElement('input');input.type='url';input.maxLength=2048;input.placeholder='https://node.example';input.setAttribute('aria-label','Personal Nodeの接続先');label.append(input);
  const previewHost=document.createElement('div');
  let disposed=false,pending=false,locked=false,turn=0,preview=null;
  const cancelled=new Set();
  const matches=()=>{const value=getContext();return context(value)&&value.viewerId===bound?.viewerId&&value.account===bound.account&&value.generation===bound.generation;};
  const current=()=>!disposed&&context(bound)&&element.isConnected&&!element.closest('[hidden]')&&isCurrent()&&matches();
  const active=operation=>current()&&turn===operation;
  const button=(text,action)=>{const node=document.createElement('button');node.type='button';node.className='head-action';node.textContent=text;node.onclick=action;return node;};
  const paragraph=value=>{const node=document.createElement('p');node.className='meta';node.textContent=value;return node;};
  function cancelNative(id) {
    if(!uuid(id)||cancelled.has(id))return Promise.resolve();cancelled.add(id);
    try{return Promise.resolve(invoke('personal_node_registration_complete',{previewId:id,confirmed:false})).catch(()=>{});}catch{return Promise.resolve();}
  }
  function invalidate(message='登録の確認内容を破棄しました。') {
    turn++;const old=preview;preview=null;if(old)void cancelNative(old.previewId);
    if(!disposed){previewHost.replaceChildren();status.textContent=message;paint();}
  }
  function validPreview(value,nodeUrl) {
    const expiry=typeof value?.expiresAt==='string'?Date.parse(value.expiresAt):NaN;
    return uuid(value?.previewId)&&value.viewerId===bound.viewerId&&value.nodeUrl===nodeUrl&&publicOrigin(value.nodeUrl)===nodeUrl&&typeof value.keyThumbprint==='string'&&/^[0-9a-f]{64}$/iu.test(value.keyThumbprint)&&Number.isFinite(expiry)&&new Date(expiry).toISOString()===value.expiresAt&&expiry>now()&&expiry-now()<=600000&&hubOrigin(value.hubOrigin);
  }
  function paint() {
    element.setAttribute('aria-busy',String(pending));prepare.disabled=pending||locked;input.disabled=pending&&locked;recheck.hidden=!locked;recheck.disabled=pending;
    previewHost.replaceChildren();if(!preview)return;
    previewHost.append(paragraph(`Hubプロフィール: ${preview.viewerId}`),paragraph(`登録先: ${preview.nodeUrl}`),paragraph(`Hub: ${preview.hubOrigin}`),paragraph(`公開鍵の指紋: ${preview.keyThumbprint}`),paragraph(`確認期限: ${preview.expiresAt}`));
    const captured=preview;
    const confirm=button('確認して登録',()=>complete(captured)),cancel=button('キャンセル',async()=>{
      if(!current()||pending||locked||preview!==captured)return;
      const operation=++turn;preview=null;pending=true;paint();await cancelNative(captured.previewId);
      if(!active(operation))return;pending=false;status.textContent='確認内容を破棄しました。登録は実行していません。';paint();
    });
    confirm.disabled=pending||locked;cancel.disabled=pending||locked;previewHost.append(confirm,cancel);
  }
  async function prepareRegistration() {
    if(!current()||pending||locked)return;
    const draft=input.value,nodeUrl=publicOrigin(draft);
    if(!nodeUrl){status.textContent='公開HTTPSの接続先を入力してください。パス・クエリ・認証情報は指定できません。';return;}
    const old=preview;preview=null;if(old)void cancelNative(old.previewId);
    const operation=++turn;pending=true;status.textContent='登録内容を確認しています…';paint();
    try{
      const result=await invoke('personal_node_registration_prepare',{nodeUrl});
      if(!active(operation)||input.value!==draft){void cancelNative(result?.previewId);return;}
      if(!validPreview(result,nodeUrl)){locked=true;void cancelNative(result?.previewId);status.textContent='登録の準備結果を確認できませんでした。状態を再確認してください。';return;}
      preview={previewId:result.previewId,viewerId:result.viewerId,nodeUrl:result.nodeUrl,keyThumbprint:result.keyThumbprint,expiresAt:result.expiresAt,hubOrigin:result.hubOrigin,draft};status.textContent='接続先と公開鍵の指紋を確認してから登録してください。';
    }catch(error){if(active(operation)){locked=!preSignatureErrors.has(String(error?.message??error));status.textContent=locked?'登録の準備結果を確認できませんでした。状態を再確認してください。':'登録内容を確認できませんでした。接続先を確認してもう一度準備してください。';}}
    finally{pending=false;if(current())paint();}
  }
  async function complete(captured) {
    if(!current()||pending||locked||preview!==captured)return;
    if(input.value!==captured.draft||publicOrigin(input.value)!==captured.nodeUrl||Date.parse(captured.expiresAt)<=now()){invalidate('入力または確認期限が変わりました。もう一度登録内容を確認してください。');return;}
    const operation=++turn;pending=true;locked=true;status.textContent='登録結果を確認しています…';paint();
    try{
      const result=await invoke('personal_node_registration_complete',{previewId:captured.previewId,confirmed:true});
      if(!active(operation)||input.value!==captured.draft)return;
      if(result?.registered!==true||result.viewerId!==captured.viewerId||result.nodeUrl!==captured.nodeUrl||result.keyThumbprint!==captured.keyThumbprint)throw Error('personal_node_registration_unknown');
      const latest=await onReload(bound.viewerId);
      if(!active(operation))return;
      if(latest?.viewerId!==bound.viewerId||latest.node?.status!=='active'||latest.node.nodeUrl!==captured.nodeUrl||latest.node.keyThumbprint!==captured.keyThumbprint)throw Error('personal_node_registration_unknown');
      preview=null;status.textContent='登録状態を確認しました。';
    }catch(error){if(active(operation)){const known=preSignatureErrors.has(String(error?.message??error));locked=!known;if(known){preview=null;void cancelNative(captured.previewId);}status.textContent=known?'確認内容の有効性を確認できませんでした。もう一度準備してください。':'登録結果が不明です。再度登録せず、状態を再確認してください。';}}
    finally{pending=false;if(current())paint();}
  }
  const prepare=button('登録内容を確認',prepareRegistration);
  const recheck=button('状態を再確認',async()=>{
    if(!current()||pending||!locked)return;
    const operation=++turn;pending=true;status.textContent='登録状態を再確認しています…';paint();
    try{
      const latest=await onReload(bound.viewerId);if(!active(operation))return;
      if(latest?.viewerId!==bound.viewerId||latest.node!==null)throw Error('state_unconfirmed');
      preview=null;locked=false;status.textContent='未登録の状態を確認しました。';
    }catch{if(active(operation))status.textContent='登録状態を確認できませんでした。登録の再実行はできません。';}
    finally{pending=false;if(current())paint();}
  });
  input.oninput=()=>invalidate('入力が変わりました。もう一度登録内容を確認してください。');form.onsubmit=event=>{event.preventDefault();void prepareRegistration();};
  if(context(bound)){form.append(label,prepare);element.append(form,previewHost,recheck,status);paint();}
  else{status.textContent='本人の未登録状態を確認してから登録してください。';element.append(status);}
  return {element,invalidate,dispose(){if(disposed)return;invalidate();disposed=true;turn++;element.remove();}};
}
