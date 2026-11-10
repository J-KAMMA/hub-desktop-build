const kinds = {chat:'雑談', guide:'共同ページ', question:'質問', party:'募集'};
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const id = (value, max=128) => typeof value === 'string' && value.length >= 1 && value.length <= max && !/[^A-Za-z0-9_-]/u.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/\p{Surrogate}/u.test(value);
const uuid = value => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const messageId = value => id(value,80) || typeof value === 'string' && value.length === 46 && /^scheduled:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const imageId = value => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const same = (a,b) => a && b && a.key === b.key && a.generation === b.generation;
function scopeValue(value) {
  if(value === null) return null;
  if(!exact(value,['key','generation']) || !Number.isSafeInteger(value.generation) || value.generation < 0
    || typeof value.key !== 'string' || value.key.length > 4096) throw Error('post_scope_invalid');
  const pair = JSON.parse(value.key);
  if(!Array.isArray(pair) || pair.length !== 2 || !text(pair[0],512) || !id(pair[1]) || JSON.stringify(pair) !== value.key) throw Error('post_scope_invalid');
  const url = new URL(pair[0]);
  if(url.origin !== pair[0] || url.username || url.password || !(url.protocol === 'https:'
    || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw Error('post_scope_invalid');
  return {...value, origin:pair[0], deviceId:pair[1]};
}
async function expectedMessageId(viewerId, communityId, requestId) {
  const bytes = new TextEncoder().encode(JSON.stringify(['hub-community-message-v1',viewerId,communityId,requestId]));
  return 'cm-' + [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Entry-owned memory only. File references and message text are never logged or stored. */
export function createCommunityPostComposer({document,communityId,viewerId,state,invoke,getScope,isCurrent=()=>true,
  uploadFiles,onSent=()=>{},onError=()=>{},formatError=()=> '操作を完了できませんでした。'}) {
  if(!id(communityId,80) || !id(viewerId) || !state || typeof state !== 'object'
    || ![Object.prototype,null].includes(Object.getPrototypeOf(state)) || typeof invoke !== 'function' || typeof getScope !== 'function') throw Error('post_composer_invalid');
  const make = (tag, label, className='') => {const node=document.createElement(tag);node.className=className;if(label!==undefined)node.textContent=label;return node;};
  const element=make('form',undefined,'community-composer'), textarea=make('textarea','','community-composer-input'), kind=make('select'), status=make('p','','meta');
  textarea.rows=1;textarea.maxLength=2000;textarea.placeholder='メッセージを書く';textarea.setAttribute('aria-label','メッセージ（Enterで送信、Shift+Enterで改行）');textarea.autocomplete='off';
  for(const [value,label] of Object.entries(kinds)){const option=make('option',label);option.value=value;kind.append(option);}kind.setAttribute('aria-label','投稿カテゴリ');
  const replyHint=make('p','','meta'), clearReply=make('button','返信先を解除','head-action');clearReply.type='button';
  const imageInput=make('input');imageInput.type='file';imageInput.accept='image/jpeg,image/png,image/webp';imageInput.multiple=true;imageInput.hidden=true;
  const images=make('div',undefined,'composer-images'), add=make('button','画像','community-composer-item'), submit=make('button','','approve community-composer-send'), recheck=make('button','送信結果を再取得','head-action');
  add.type=recheck.type='button';add.setAttribute('role','menuitem');submit.type='submit';submit.setAttribute('aria-label','送信');submit.title='送信';submit.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12V3.5M3.5 8 8 3.5 12.5 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';submit.dataset.postAction='send';recheck.dataset.postAction='recheck';status.setAttribute('role','status');
  const plus=make('button','','community-composer-plus'),menu=make('div',undefined,'community-composer-menu'),actions=make('div',undefined,'community-composer-row');
  plus.type='button';plus.setAttribute('aria-label','追加');plus.title='追加';plus.setAttribute('aria-haspopup','menu');plus.setAttribute('aria-expanded','false');plus.setAttribute('data-keep-text','');plus.textContent='＋';
  menu.setAttribute('role','menu');menu.hidden=true;add.setAttribute('data-keep-text','');menu.append(add);
  const closeMenu=()=>{menu.hidden=true;plus.setAttribute('aria-expanded','false');};
  const outside=event=>{if(!element.isConnected){document.removeEventListener('click',outside);return;}if(!menu.hidden&&!menu.contains(event.target)&&event.target!==plus)closeMenu();};
  plus.onclick=()=>{if(plus.disabled)return;menu.hidden=!menu.hidden;plus.setAttribute('aria-expanded',String(!menu.hidden));if(!menu.hidden){document.addEventListener('click',outside);menu.querySelector('button:not(:disabled)')?.focus?.();}};
  element.addEventListener('keydown',event=>{if(event.key==='Escape'&&!menu.hidden){event.stopPropagation();closeMenu();plus.focus();}});
  /** Extra actions in the ＋ menu (poll, schedule). Each closes the menu and runs. */
  const addAction=(label,run)=>{const item=make('button',label,'community-composer-item');item.type='button';item.setAttribute('role','menuitem');item.setAttribute('data-keep-text','');item.onclick=()=>{closeMenu();run();};menu.append(item);return item;};
  const grow=()=>{textarea.style.height='auto';const h=Math.min(textarea.scrollHeight||0,160);if(h>0)textarea.style.height=h+'px';};
  actions.append(plus,kind,textarea,submit);element.append(replyHint,clearReply,actions,menu,imageInput,images,status,recheck);
  let disposed=false,invalidated=false,busy=true,initialized=false,scope=null,epoch=0;
  const live=()=>!disposed&&!invalidated&&isCurrent()===true;
  const connected=()=>live()&&element.isConnected;
  const fileValid=file=>file instanceof (document.defaultView?.File ?? globalThis.File) && file.size > 0 && file.size <= 5*1024*1024
    && ['image/jpeg','image/png','image/webp'].includes(file.type) && text(file.name,255);
  const filesValid=files=>Array.isArray(files)&&files.length<=4&&new Set(files).size===files.length&&Array.from(files).every(fileValid);
  const replyValid=reply=>reply===null||exact(reply,['id','label'])&&messageId(reply.id)&&text(reply.label,120);
  const operationValid=op=>op===null||exact(op,['requestId','messageId','body','kind','replyToMessageId','files','imageIds','status','revision'])
    &&uuid(op.requestId)&&typeof op.messageId==='string'&&/^cm-[a-f0-9]{64}$/u.test(op.messageId)&&op.messageId.length===67
    &&text(op.body,2000)&&Object.hasOwn(kinds,op.kind)&&(op.replyToMessageId===null||messageId(op.replyToMessageId))&&filesValid(op.files)
    &&Array.isArray(op.imageIds)&&op.imageIds.length<=4&&Array.from(op.imageIds).every(imageId)&&new Set(op.imageIds).size===op.imageIds.length
    &&['uploading','sending','unknown','rejected'].includes(op.status)&&Number.isSafeInteger(op.revision)&&op.revision>=0
    &&(!['sending','unknown'].includes(op.status)||op.imageIds.length===op.files.length);
  const stateValid=()=>exact(state,['version','scopeKey','generation','viewerId','communityId','body','kind','reply','files','revision','operation'])
    &&state.version===1&&state.scopeKey===scope.key&&state.generation===scope.generation&&state.viewerId===viewerId
    &&state.communityId===communityId&&text(state.body,2000)&&Object.hasOwn(kinds,state.kind)
    &&replyValid(state.reply)&&filesValid(state.files)&&Number.isSafeInteger(state.revision)&&state.revision>=0&&operationValid(state.operation);
  function clearState(){for(const key of Reflect.ownKeys(state))delete state[key];}
  function initializeState(){clearState();Object.assign(state,{version:1,scopeKey:scope.key,generation:scope.generation,viewerId,communityId,
    body:'',kind:'chat',reply:null,files:[],revision:0,operation:null});}
  function invalidate(){if(disposed||invalidated)return;invalidated=true;initialized=false;epoch++;scope=null;clearState();textarea.value='';kind.value='chat';images.replaceChildren();replyHint.textContent='';status.textContent='接続が変わりました。画面を開き直してください。';paint();}
  const current=(captured,turn,op)=>connected()&&turn===epoch&&same(scope,captured)&&(!op||state.operation===op);
  const assertCurrent=(captured,turn,op)=>{if(!current(captured,turn,op))throw Error('post_context_changed');};
  async function fresh(captured,turn,op){
    assertCurrent(captured,turn,op);
    let next;try{next=scopeValue(await getScope());}catch{next=null;}
    if(!current(captured,turn,op))throw Error('post_context_changed');
    if(!same(captured,next)){invalidate();throw Error('post_context_changed');}
    return next;
  }
  function paint(){
    if(disposed)return;
    const draft=initialized?state:null,blocked=!connected()||!scope||!draft||busy||['sending','unknown'].includes(draft.operation?.status);
    submit.disabled=blocked||!textarea.value.trim()&&!(draft?.files.length);add.disabled=blocked||(draft?.files.length??0)>=4;
    textarea.disabled=kind.disabled=clearReply.disabled=plus.disabled=blocked;imageInput.disabled=blocked;recheck.disabled=!connected()||busy||draft?.operation?.status!=='unknown';recheck.hidden=draft?.operation?.status!=='unknown';
    element.setAttribute('aria-busy',String(busy));replyHint.hidden=clearReply.hidden=!draft?.reply;
    replyHint.textContent=draft?.reply?`返信先: ${draft.reply.label}`:'';
    images.replaceChildren(...(draft?.files??[]).map((file,index)=>{const row=make('span',undefined,'composer-image-frame'),label=make('span',`${file.name} (${file.size} bytes)`),remove=make('button','外す','head-action');
      remove.type='button';remove.disabled=blocked;remove.onclick=()=>{if(!connected()||busy||state.operation?.status==='unknown')return;state.files.splice(index,1);state.revision++;paint();};row.append(label,remove);return row;}));  grow();
  }
  function syncInput(force=false){
    if(!scope||!initialized||invalidated||disposed||!force&&!live()||state.scopeKey!==scope.key||state.viewerId!==viewerId)return;
    if(!text(textarea.value,2000)||!Object.hasOwn(kinds,kind.value)){status.textContent='本文は2000文字以内で入力してください。';return false;}
    if(state.body!==textarea.value||state.kind!==kind.value){state.body=textarea.value;state.kind=kind.value;state.revision++;}
    return true;
  }
  textarea.oninput=kind.onchange=()=>{syncInput();paint();grow();};
  textarea.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();if(!submit.disabled)element.requestSubmit?element.requestSubmit(submit):element.dispatchEvent(new document.defaultView.Event('submit',{cancelable:true}));}});
  function setReply(message){
    if(!connected()||!scope||busy||state.operation?.status==='unknown')return false;
    if(message===null)state.reply=null;
    else{
      if(!message||!messageId(message.id)||message.communityId!==undefined&&message.communityId!==communityId)return false;
      const label=typeof message.label==='string'?message.label:[...(message.body??'')].slice(0,40).join('');
      if(!text(label,120))return false;state.reply={id:message.id,label};
    }
    state.revision++;paint();return true;
  }
  function addFiles(files){
    if(!connected()||!scope||busy||state.operation?.status==='unknown')return false;
    const added=Array.from(files??[]),next=[...state.files,...added];
    if(!filesValid(next)){status.textContent='JPEG・PNG・WebP画像を、1枚5MiB以下・4枚以内で選択してください。';return false;}
    state.files=next;state.revision++;paint();return true;
  }
  add.onclick=()=>{closeMenu();if(!add.disabled&&connected())imageInput.click();};imageInput.onchange=()=>{const files=Array.from(imageInput.files??[]);imageInput.value='';addFiles(files);};clearReply.onclick=()=>setReply(null);
  function matchMessage(message,op){
    if(!message||message.id!==op.messageId||message.communityId!==communityId||message.authorProfileId!==viewerId||message.body!==op.body
      ||message.kind!==op.kind||!Object.hasOwn(message,'replyToMessageId')||message.replyToMessageId!==op.replyToMessageId||!Array.isArray(message.images))return false;
    const attached=Array.from(message.images,image=>image?.id);
    return attached.length===op.imageIds.length&&new Set(attached).size===attached.length&&attached.every(id=>op.imageIds.includes(id));
  }
  async function accept(op,captured,turn,receipt){
    await fresh(captured,turn,op);syncInput();
    const unchanged=state.revision===op.revision&&state.body.trim()===op.body&&state.kind===op.kind&&(state.reply?.id??null)===op.replyToMessageId
      &&state.files.length===op.files.length&&state.files.every((file,index)=>file===op.files[index]);
    if(unchanged){state.body='';state.reply=null;state.files=[];textarea.value='';}
    state.operation=null;busy=false;status.textContent='送信を確認しました。';paint();
    assertCurrent(captured,turn);
    try{await onSent(receipt,{assertCurrent:()=>assertCurrent(captured,turn)});}
    catch{if(current(captured,turn)){status.textContent='送信は確認済みです。表示を更新できませんでした。';onError({code:'post_refresh_failed'});}}
  }
  async function send(){
    if(!connected()||!scope||busy||state.operation?.status==='unknown'||state.operation?.status==='sending'||syncInput()===false)return false;
    const body=state.body.trim();if(!body&&!state.files.length)return false;
    const captured={...scope},turn=epoch,snapshot={body,kind:state.kind,replyToMessageId:state.reply?.id??null,files:Object.freeze([...state.files]),revision:state.revision};
    busy=true;paint();let op=null,sent=false;
    try{
      await fresh(captured,turn);
      const requestId=globalThis.crypto.randomUUID(),messageId=await expectedMessageId(viewerId,communityId,requestId);await fresh(captured,turn);
      op={requestId,messageId,...snapshot,imageIds:[],status:'uploading'};state.operation=op;status.textContent='送信を準備しています…';
      if(op.files.length){
        if(typeof uploadFiles!=='function')throw Error('post_upload_unavailable');
        const ids=await uploadFiles(op.files,{assertCurrent:()=>assertCurrent(captured,turn,op),
          invoke:async(command,args)=>{if(command!=='hub_upload_image')throw Error('post_upload_command_invalid');await fresh(captured,turn,op);
            const value=await invoke(command,{...args,expectedDeviceId:captured.deviceId,expectedOrigin:captured.origin,expectedViewerId:viewerId});await fresh(captured,turn,op);return value;},
          onProgress:message=>{if(current(captured,turn,op)&&text(message,120))status.textContent=message;}});
        await fresh(captured,turn,op);
        if(!Array.isArray(ids)||ids.length!==op.files.length||Array.from(ids).some(id=>!imageId(id))||new Set(ids).size!==ids.length)throw Error('post_upload_receipt_invalid');
        op.imageIds=[...ids];
      }
      await fresh(captured,turn,op);op.status='sending';sent=true;status.textContent='送信中…';
      const result=await invoke('hub_client_action',{action:'community_post',target:communityId,text:op.body,requestId:op.requestId,
        options:{kind:op.kind,replyToMessageId:op.replyToMessageId,...(op.imageIds.length?{imageIds:[...op.imageIds]}:{}),
          expectedDeviceId:captured.deviceId,expectedOrigin:captured.origin,expectedViewerId:viewerId}});
      await fresh(captured,turn,op);
      if(!exact(result,['message'])||!matchMessage(result.message,op))throw Error('post_send_unconfirmed');
      await accept(op,captured,turn,result);return true;
    }catch(error){
      if(!current(captured,turn,op))return false;
      if(['community_post_scope_conflict','image_scope_conflict','desktop_not_connected','account_changed'].includes(String(error?.message??error))){invalidate();onError({code:'post_scope_changed'});return false;}
      // Status alone is not proof of no write: the current server can reject
      // after image publication/readback. Only an explicit zero-effect code is safe.
      const known=/^community_post_prewrite_rejected:(400|401|403|404|413|429)(?::|$)/u.test(String(error));
      if(op)op.status=sent&&!known?'unknown':'rejected';
      status.textContent=sent&&!known?'送信結果が不明です。再送せず、結果を再取得してください。':formatError(error);
      onError({code:sent&&!known?'post_send_unknown':'post_send_rejected'});return false;
    }finally{if(current(captured,turn,op)){busy=false;paint();}}
  }
  async function recheckResult(){
    const op=state.operation;if(!connected()||busy||op?.status!=='unknown'||!scope)return false;
    const captured={...scope},turn=epoch;busy=true;paint();status.textContent='送信結果を再取得しています…';
    try{
      await fresh(captured,turn,op);const data=await invoke('hub_detail',{name:'community_posts',ids:[communityId]});await fresh(captured,turn,op);
      if(data?.viewerProfileId!==viewerId||!Array.isArray(data.messages))throw Error('post_read_unconfirmed');
      const matched=data.messages.filter(message=>message?.id===op.messageId);
      if(matched.length!==1||!matchMessage(matched[0],op)){status.textContent='この投稿の保存結果をまだ確認できません。再送せず、コミュニティの投稿を確認してください。';return false;}
      await accept(op,captured,turn,{message:matched[0]});return true;
    }catch{if(current(captured,turn,op))status.textContent='結果を再取得できませんでした。未確認の投稿と草稿を保持しています。';return false;}
    finally{if(current(captured,turn,op)){busy=false;paint();}}
  }
  element.onsubmit=event=>{event.preventDefault();void send();};recheck.onclick=()=>void recheckResult();
  const accountChanged=()=>invalidate();document.defaultView?.addEventListener('hub-account-changed',accountChanged);
  function destroy(){
    if(disposed)return;
    if(scope&&!invalidated&&state.scopeKey===scope.key&&state.viewerId===viewerId){syncInput(true);if(state.operation?.status==='sending')state.operation.status='unknown';else if(state.operation?.status==='uploading')state.operation=null;}
    disposed=true;epoch++;document.defaultView?.removeEventListener('hub-account-changed',accountChanged);element.remove();
  }
  const ready=(async()=>{
    try{const next=scopeValue(await getScope());if(!live())return false;scope=next;if(!scope){invalidate();return false;}
      if(!stateValid())initializeState();initialized=true;
      if(state.operation){const captured={...scope},turn=epoch,expected=await expectedMessageId(viewerId,communityId,state.operation.requestId);await fresh(captured,turn);if(state.operation.messageId!==expected)initializeState();}
      if(state.operation?.status==='uploading')state.operation=null;else if(state.operation?.status==='sending')state.operation.status='unknown';
      textarea.value=state.body;kind.value=state.kind;if(state.operation?.status==='unknown')status.textContent='前回の送信結果が未確認です。再送せず、結果を再取得してください。';return true;
    }catch{invalidate();return false;}
    finally{busy=false;paint();}
  })();
  paint();return {element,ready,destroy,invalidate,setReply,addAction,textarea,kind,hasImages:()=>Boolean(state.files?.length),addFiles,send,recheck:recheckResult};
}
