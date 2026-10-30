const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length
  &&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const validText=value=>typeof value==='string'&&!/\p{Surrogate}|\u0000/u.test(value);
const context=value=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/u.test(value);
const delivery=value=>typeof value==='string'&&[41,73].includes(value.length)&&/^delivery-(?:[a-f0-9]{32}|[a-f0-9]{64})$/u.test(value);
const content=value=>typeof value==='string'&&value.length===48&&/^urn:hub:content:[a-f0-9]{32}$/u.test(value);
const media=new Set(['text/plain','text/markdown','application/json']);
const bytes=value=>new TextEncoder().encode(value).byteLength;
const MAX_BYTES=256*1024,MAX_TEXT=100000,MAX_JSON=768*1024;
function scopeValue(value){
  if(value===null)return null;
  if(!exact(value,['key','generation'])||!Number.isSafeInteger(value.generation)||value.generation<0||!validText(value.key)||value.key.length>4096)throw Error('scope_invalid');
  const pair=JSON.parse(value.key);
  if(!Array.isArray(pair)||pair.length!==2||JSON.stringify(pair)!==value.key||!validText(pair[0])||pair[0].length>512
    ||!validText(pair[1])||!pair[1].length||pair[1].length>128||/[^\x21-\x7e]/u.test(pair[1]))throw Error('scope_invalid');
  const url=new URL(pair[0]);
  if(url.origin!==pair[0]||url.username||url.password||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('scope_invalid');
  return {...value};
}
export function peerInboxBodyReason(item){
  if(!item||typeof item!=='object'||Array.isArray(item)
    ||['context','deliveryId','contentId','mediaType','byteLength'].some(key=>!Object.hasOwn(Object.getOwnPropertyDescriptor(item,key)??{},'value')))return '原本の情報を確認できないため、本文を開けません。';
  if(!context(item?.context))return 'この実行環境は原本の本文読取に対応していません。';
  if(!delivery(item?.deliveryId)||!content(item?.contentId))return '原本の情報を確認できないため、本文を開けません。';
  if(!media.has(item?.mediaType))return 'この形式の全文表示は未対応です。';
  // The representation's byteLength may be ciphertext length, not plaintext length.
  if(!Number.isSafeInteger(item?.byteLength)||item.byteLength<0)return '原本の容量を確認できないため、本文を開けません。';
  return '';
}
function receiptValue(value,item){
  if(!exact(value,['context','deliveryId','contentId','mediaType','text','byteLength'])||value.context!==item.context
    ||value.deliveryId!==item.deliveryId||value.contentId!==item.contentId||value.mediaType!==item.mediaType||!media.has(value.mediaType)
    ||!validText(value.text)||value.text.length>MAX_TEXT||!Number.isSafeInteger(value.byteLength)||value.byteLength<0
    ||value.byteLength>MAX_BYTES||bytes(value.text)!==value.byteLength||bytes(JSON.stringify(value))>MAX_JSON)throw Error('invalid_receipt');
  return value;
}
const errorText=error=>{
  let code;try{code=typeof error==='string'?error:Object.getOwnPropertyDescriptor(error??{},'code')?.value??Object.getOwnPropertyDescriptor(error??{},'message')?.value;}catch{}
  if(code==='node_peer_read_unsupported')return '保存済みの暗号化されたテキスト原本だけ表示できます。この原本の全文表示は未対応です。';
  if(code==='node_peer_read_too_large')return '本文が表示上限を超えているため、全文を表示できません。';
  if(code==='node_peer_read_context_changed')return '接続やノードの設定が変わりました。一覧を更新してください。';
  return '本文を取得できませんでした。一覧と接続状態を確認してください。';
};

/** Explicit local read only. The body lives solely in the current text node. */
export function createPeerInboxReader({document,invoke,getScope,isCurrent=()=>true}){
  if(!document||typeof invoke!=='function'||typeof getScope!=='function'||typeof isCurrent!=='function')throw Error('peer_inbox_reader_invalid');
  const make=(tag,text,className='')=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const element=make('section',undefined,'card detail-form');element.hidden=true;element.setAttribute('aria-label','受信した原本の本文');
  const title=make('h4','受信した原本'),closeButton=make('button','本文を閉じる','head-action'),notice=make('p','','meta'),body=make('pre','','detail-p');
  closeButton.type='button';notice.setAttribute('role','status');body.dataset.peerInboxBody='';body.style.whiteSpace='pre-wrap';body.style.overflowWrap='anywhere';body.style.maxHeight='60vh';body.style.overflow='auto';
  element.append(title,closeButton,make('p','保存済みの暗号化されたテキスト原本を表示します。公開の平文原本・画像・ファイルの全文表示は未対応です。','meta'),notice,body);
  let disposed=false,busy=false,revision=0,opener=null;
  const active=()=>{try{return !disposed&&element.isConnected&&isCurrent()===true;}catch{return false;}};
  const clear=()=>{revision++;busy=false;body.textContent='';notice.textContent='';element.hidden=true;element.setAttribute('aria-busy','false');};
  function close(){clear();if(active()&&opener?.isConnected)opener.focus();opener=null;}
  function invalidate(){clear();opener=null;}
  closeButton.onclick=close;
  async function open(input,button){
    if(!active()||busy)return false;
    const reason=peerInboxBodyReason(input);if(reason){invalidate();element.hidden=false;notice.textContent=reason;return false;}
    const item={context:input.context,deliveryId:input.deliveryId,contentId:input.contentId,mediaType:input.mediaType};
    const own=++revision;busy=true;opener=button??null;body.textContent='';notice.textContent='本文を読み込んでいます…';element.hidden=false;element.setAttribute('aria-busy','true');
    const current=()=>active()&&own===revision&&!element.hidden;
    try{
      const before=scopeValue(await getScope());if(!current())return false;
      if(!before){notice.textContent='Desktopの接続状態を確認してから、一覧を開き直してください。';return false;}
      const raw=await invoke('hub_peer_control',{action:'read',deliveryId:item.deliveryId,expectedContext:item.context});
      if(!current())return false;
      const after=scopeValue(await getScope());if(!current())return false;
      if(!after||before.key!==after.key||before.generation!==after.generation){invalidate();return false;}
      const value=receiptValue(raw,item);body.textContent=value.text;notice.textContent=value.text?'':'本文は空です。';return true;
    }catch(error){if(current()){body.textContent='';notice.textContent=errorText(error);}return false;}
    finally{if(own===revision){busy=false;element.setAttribute('aria-busy','false');}}
  }
  const accountChanged=()=>invalidate();document.defaultView?.addEventListener('hub-account-changed',accountChanged);
  return {element,open,close,invalidate,dispose(){if(disposed)return;invalidate();disposed=true;element.remove();document.defaultView?.removeEventListener('hub-account-changed',accountChanged);}};
}
