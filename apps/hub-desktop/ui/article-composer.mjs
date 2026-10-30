const uuid=value=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const id=value=>typeof value==='string'&&value.length<=128&&!/\p{Cc}/u.test(value)&&/^[A-Za-z0-9_-]+$/u.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const valid=value=>typeof value==='string'&&!/\0|\p{Surrogate}/u.test(value);
const scalar=value=>[...value].length;
function normalize(fields){
  if(!exact(fields,['title','summary','body','tags'])||!Object.values(fields).every(valid)||fields.title.length>240||fields.summary.length>800||fields.body.length>200000||fields.tags.length>400)throw Error('article_input_invalid');
  const title=fields.title.trim(),summary=fields.summary.trim(),text=fields.body.replaceAll('\r\n','\n').trim();
  const tags=[...new Set(fields.tags.split(',').map(tag=>tag.trim()).filter(Boolean))];
  if(!title||!text||scalar(title)>120||scalar(summary)>400||scalar(text)>100000||tags.length>8||tags.some(tag=>tag.length>24))throw Error('article_input_invalid');
  return{text,options:{title,summary,tags:tags.join(',')}};
}
function scopeValue(value){
  if(value===null)return null;
  if(!exact(value,['key','generation'])||typeof value.key!=='string'||value.key.length>4096||!Number.isSafeInteger(value.generation)||value.generation<0)throw Error('article_scope_invalid');
  const pair=JSON.parse(value.key);
  if(!Array.isArray(pair)||pair.length!==2||!valid(pair[0])||pair[0].length>512||!id(pair[1]))throw Error('article_scope_invalid');
  const url=new URL(pair[0]);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.origin!==pair[0]||JSON.stringify(pair)!==value.key)throw Error('article_scope_invalid');
  return{...value};
}
const sameScope=(left,right)=>left&&right&&left.key===right.key&&left.generation===right.generation;
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
function receipt(value,requestId,lookup=false){
  const keys=lookup?['found','id','href','clientRequestId']:['id','href','duplicate','clientRequestId'];
  if(!exact(value,keys)||value.clientRequestId!==requestId||!id(value.id)||value.href!==`/articles/${value.id}`||(lookup?value.found!==true:typeof value.duplicate!=='boolean'))throw Error('article_receipt_invalid');
  return lookup?{id:value.id,href:value.href,clientRequestId:requestId,duplicate:true,fromLookup:true}:{...value};
}
function operationValue(value,key){
  if(!exact(value,['version','scopeKey','generation','requestId','payload','status','receipt'])||value.version!==1||value.scopeKey!==key||!Number.isSafeInteger(value.generation)||value.generation<0||!uuid(value.requestId)
    ||!['pending','unknown','rejected','conflict','resolved'].includes(value.status)||!exact(value.payload,['text','options'])||!exact(value.payload.options,['title','summary','tags']))throw Error('article_operation_invalid');
  const payload=normalize({body:value.payload.text,...value.payload.options});if(!equal(payload,value.payload))throw Error('article_operation_invalid');
  let result=null;if(value.receipt!==null){if(!['resolved','conflict'].includes(value.status))throw Error('article_operation_invalid');
    if(value.receipt.fromLookup===true&&!exact(value.receipt,['id','href','duplicate','clientRequestId','fromLookup']))throw Error('article_operation_invalid');
    result=value.receipt.fromLookup===true?receipt({found:true,id:value.receipt.id,href:value.receipt.href,clientRequestId:value.receipt.clientRequestId},value.requestId,true):receipt(value.receipt,value.requestId);}
  return{...structuredClone(value),payload,receipt:result,status:value.status==='pending'?'unknown':value.status};
}

export function createArticleComposer({document,form,toggle,state,invoke,getScope,isCurrent,renderMarkdown,onPublished=()=>{},storage}){
  if(form?.ownerDocument!==document||toggle?.ownerDocument!==document||state?.ownerDocument!==document||[invoke,getScope,isCurrent,renderMarkdown,onPublished].some(value=>typeof value!=='function'))throw Error('article_composer_invalid_host');
  const fields=Object.fromEntries(['title','summary','body','tags'].map(name=>[name,form.elements.namedItem(name)]));if(Object.values(fields).some(field=>!field||typeof field.value!=='string'))throw Error('article_composer_invalid_form');
  let disposed=false,scope=null,epoch=0,revision=0,busy=false,scopePending=null,operation=null,preview=null,retryChecked=false,storageBlocked=false;
  const owner=document.createElement('div');owner.className='detail-form';owner.dataset.articleComposer='controls';form.append(owner);
  const make=(tag,text,className='')=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const buttons={},actions=make('div',undefined,'detail-form-row'),previewBox=make('section',undefined,'detail-form'),counts=make('p','','meta');counts.setAttribute('aria-live','polite');owner.append(counts,actions,previewBox);
  const button=(name,label,run)=>{const node=make('button',label,'head-action');node.type='button';node.dataset.articleAction=name;node.onclick=()=>{if(alive())void Promise.resolve().then(run).catch(()=>{if(alive()){state.textContent='操作を完了できませんでした。入力と公開操作は保持しています。';paint();}});};actions.append(node);buttons[name]=node;return node;};
  const submit=form.querySelector('button[type="submit"]');if(submit){submit.textContent='公開内容を確認';submit.dataset.articleAction='preview';buttons.preview=submit;}
  const raw=()=>Object.fromEntries(Object.entries(fields).map(([name,node])=>[name,node.value]));
  const alive=()=>!disposed&&form.isConnected&&isCurrent()===true;
  const current=(captured,turn)=>alive()&&epoch===turn&&sameScope(scope,captured);
  const key=kind=>`hub.article.${kind}.v1.${encodeURIComponent(scope.key)}`;
  const writeOperation=()=>{if(!scope||!storage)throw Error('article_storage_unavailable');storage.setItem(key('operation'),JSON.stringify(operation));};
  function paint(){
    const locked=!alive()||!scope||busy||!!scopePending||storageBlocked;
    for(const node of Object.values(buttons))node.disabled=locked;
    buttons.confirm.disabled=locked||!preview||!!operation;
    buttons.check.disabled=locked||!operation;buttons.retry.disabled=locked||!operation||!retryChecked||preview?.requestId!==operation.requestId||!['unknown','rejected'].includes(operation.status);
    buttons.release.disabled=locked||!operation||!['rejected','resolved'].includes(operation.status);
    buttons.release.textContent=operation?.status==='resolved'?'新しい記事の確認へ':'入力を修正して新しい確認へ';
    buttons.scope.disabled=!alive()||busy||!!scopePending;
    buttons.open.disabled=locked||!operation?.receipt;buttons.preview.disabled=!alive()||busy||!!scopePending;form.setAttribute('aria-busy',String(busy||!!scopePending));
    buttons.confirm.hidden=!preview||!!operation;buttons.check.hidden=!operation||operation.status==='resolved';
    buttons.retry.hidden=!operation||!retryChecked||!['unknown','rejected'].includes(operation.status);
    buttons.release.hidden=!operation||!['rejected','resolved'].includes(operation.status);buttons.open.hidden=!operation?.receipt;
    buttons.scope.hidden=!!scope&&!storageBlocked;
    counts.textContent=`題名 ${scalar(fields.title.value.trim())}/120 · 要約 ${scalar(fields.summary.value.trim())}/400 · 本文 ${scalar(fields.body.value.replaceAll('\r\n','\n').trim())}/100000文字`;
  }
  async function fresh(){const captured=scope,turn=epoch;let value;try{value=scopeValue(await getScope());}catch{if(current(captured,turn)){scope=null;epoch++;preview=null;previewBox.replaceChildren();state.textContent='接続情報を確認できません。公開・保存は利用できません。';paint();}return null;}
    if(!current(captured,turn))return null;if(!sameScope(captured,value)){await refreshScope();return null;}return{captured,turn};}
  async function refreshScope(){
    if(disposed)return false;if(scopePending)return scopePending;
    const turn=++epoch;preview=null;retryChecked=false;previewBox.replaceChildren();
    scopePending=Promise.resolve().then(async()=>{
      try{const next=scopeValue(await getScope());if(!alive()||epoch!==turn)return false;
        const changed=!scope||!next||scope.key!==next.key;scope=next;storageBlocked=false;if(changed)operation=null;
        if(!scope){state.textContent='Hubに接続すると、この記事の保存・公開を利用できます。';return false;}
        const stored=storage?.getItem(key('operation'));if(stored&&stored.length>1000000)throw Error('article_operation_invalid');operation=stored?operationValue(JSON.parse(stored),scope.key):null;
        if(operation)operation.generation=scope.generation;
        state.textContent=operation?'保存された公開操作があります。結果を確認するまで新しい公開操作は始めません。':'';return true;
      }catch{if(alive()&&epoch===turn){scope=null;storageBlocked=true;state.textContent='接続情報または保存された公開操作を確認できません。公開・保存は利用できません。';}return false;}
      finally{scopePending=null;if(!disposed)paint();}
    });paint();return scopePending;
  }
  function showPreview(payload,requestId=null){
    const nodes=renderMarkdown(payload.text);if(!Array.isArray(nodes)||nodes.some(node=>node?.ownerDocument!==document))throw Error('article_preview_invalid');
    preview={payload:structuredClone(payload),requestId,scope:scope?{...scope}:null,revision};previewBox.replaceChildren(make('h4',requestId?'未確認の公開内容':'一般向け・無料公開の内容'),make('strong',payload.options.title),make('p',payload.options.summary||'要約は本文から作成します。','meta'),make('p',payload.options.tags||'タグなし','meta'),...nodes,
      make('p',scope?'公開結果を確認するため、確認済み本文と要求IDをこの端末に保存します。':'本文はまだ保存・公開されていません。','meta'));paint();
  }
  async function previewNow(){if(busy||scopePending||!alive())return;preview=null;previewBox.replaceChildren();paint();try{const connected=!!scope;if(connected&&!await fresh())return;const pending=connected&&operation&&operation.status!=='resolved';const payload=pending?operation.payload:normalize(raw());showPreview(payload,pending?operation.requestId:null);state.textContent=connected?'表示した公開内容を確認してください。':'本文の表示を確認できます。端末への保存・復元・公開にはHubへの接続が必要です。';}catch{state.textContent='題名120文字、要約400文字、本文100000文字、タグ8件・各24文字以内で入力してください。入力は保持しています。';}}
  async function published(result,captured,turn,attemptRevision){
    if(!current(captured,turn))return;const conflict=operation.status==='conflict';operation.status=conflict?'conflict':'resolved';operation.receipt=result;retryChecked=false;
    try{writeOperation();}catch{storageBlocked=true;state.textContent='保存済みの記事を確認しましたが、端末の操作記録を更新できませんでした。入力は保持しています。';paint();return;}
    state.textContent=conflict?'この要求IDの保存済み記事を確認しました。現在の本文が公開されたとは断定できません。':result.fromLookup?'この要求IDで保存済みの記事を確認しました。':'記事の保存を確認しました。';
    let editorMatches=false;try{editorMatches=equal(normalize(raw()),operation.payload);}catch{}
    if(revision===attemptRevision&&editorMatches){try{await onPublished(result);}catch{if(current(captured,turn))state.textContent='記事の保存は確認しましたが、記事を開けませんでした。';}}
    else state.textContent+=' 現在編集中の草稿は保持しています。';
  }
  async function send(retry=false){
    if(busy||!preview||storageBlocked)return;const verified=await fresh();if(!verified||busy)return;const {captured,turn}=verified;
    if(!sameScope(preview.scope,captured)||!retry&&preview.revision!==revision)return;
    if(retry){if(!operation||!retryChecked||preview.requestId!==operation.requestId||!['unknown','rejected'].includes(operation.status))return;}
    else{if(operation)return;const requestId=globalThis.crypto.randomUUID();if(!uuid(requestId))throw Error('article_operation_invalid');operation={version:1,scopeKey:scope.key,generation:scope.generation,requestId,payload:structuredClone(preview.payload),status:'pending',receipt:null};}
    const attemptRevision=revision;operation.status='pending';retryChecked=false;
    try{writeOperation();}catch{storageBlocked=true;state.textContent='確認済み本文と要求IDを端末に保存できませんでした。公開要求は送っていません。入力は保持しています。';paint();return;}
    busy=true;paint();state.textContent='公開要求を送っています…';const sent=operation;
    const [expectedOrigin,expectedDeviceId]=JSON.parse(captured.key);
    try{const result=await invoke('hub_client_action',{action:'create_article',text:sent.payload.text,requestId:sent.requestId,options:{...structuredClone(sent.payload.options),expectedDeviceId,expectedOrigin}});
      if(!current(captured,turn)||operation!==sent||!await fresh())return;const checked=receipt(result,sent.requestId);await published(checked,captured,turn,attemptRevision);
    }catch(error){if(current(captured,turn)&&operation===sent){const code=typeof error==='string'?error:error?.code??error?.message;
      const rejected=['article_publication_invalid_request','article_publication_request_too_large'].includes(code)||typeof code==='string'&&!/\p{Cc}/u.test(code)&&/^article_publication_rejected:(400|403|413|429)$/u.test(code);
      sent.status=code==='article_publication_conflict'?'conflict':rejected?'rejected':'unknown';
      state.textContent=sent.status==='conflict'?'この要求IDには別の保存済み内容があります。新しいIDで送らず、保存済み結果を確認してください。':sent.status==='rejected'?'公開は拒否されました。入力は保持しています。結果確認または入力を修正して確認してください。':'公開結果は不明です。新しいIDや自動再送は使わず、結果を確認してください。';
      try{writeOperation();}catch{storageBlocked=true;state.textContent+=' 端末の操作記録も更新できませんでした。';}
    }}finally{busy=false;if(alive())paint();}
  }
  async function check(){
    if(busy||!operation)return;const verified=await fresh();if(!verified||busy)return;const {captured,turn}=verified,sent=operation,attemptRevision=revision;
    busy=true;paint();state.textContent='保存済み結果を確認しています…';
    const [expectedOrigin,expectedDeviceId]=JSON.parse(captured.key);
    try{const value=await invoke('hub_detail',{name:'article_publication',ids:[sent.requestId,expectedDeviceId,expectedOrigin]});if(!current(captured,turn)||operation!==sent||!await fresh())return;
      if(exact(value,['found','clientRequestId'])&&value.found===false&&value.clientRequestId===sent.requestId){retryChecked=sent.status!=='conflict';state.textContent='保存済み結果はまだ確認できません。要求が処理中の可能性があります。同じID・同じ公開内容の明示的な再試行だけを利用できます。';showPreview(sent.payload,sent.requestId);}
      else await published(receipt(value,sent.requestId,true),captured,turn,attemptRevision);
    }catch{if(current(captured,turn)){retryChecked=false;state.textContent='保存済み結果を確認できませんでした。新しい公開操作は始めません。';}}
    finally{busy=false;if(alive())paint();}
  }
  async function saveDraft(){if(busy)return;try{if(!await fresh())return;const fields=raw();if(Object.values(fields).some(value=>!valid(value))||fields.title.length>240||fields.summary.length>800||fields.body.length>200000||fields.tags.length>400)throw Error('article_draft_invalid');
    const saved=JSON.stringify({version:1,scopeKey:scope.key,generation:scope.generation,fields,operation:operation?structuredClone(operation):null});if(saved.length>2097152)throw Error('article_draft_invalid');storage.setItem(key('draft'),saved);state.textContent='草稿をこの端末に保存しました。';}catch{state.textContent='草稿をこの端末に保存できませんでした。編集中の内容は保持しています。';}}
  async function restoreDraft(){if(busy)return;try{if(!await fresh())return;const saved=storage.getItem(key('draft'));if(saved&&saved.length>2097152)throw Error('article_draft_invalid');const stored=JSON.parse(saved??'null');
    if(!exact(stored,['version','scopeKey','generation','fields','operation'])||stored.version!==1||stored.scopeKey!==scope.key||!Number.isSafeInteger(stored.generation)||stored.generation<0||!exact(stored.fields,['title','summary','body','tags'])||!Object.values(stored.fields).every(valid)
      ||stored.fields.title.length>240||stored.fields.summary.length>800||stored.fields.body.length>200000||stored.fields.tags.length>400)throw Error('article_draft_invalid');
    const restored=stored.operation?operationValue(stored.operation,scope.key):null;if(restored&&operation&&restored.requestId!==operation.requestId)throw Error('article_operation_conflict');
    if(restored&&!operation){operation=restored;operation.generation=scope.generation;writeOperation();}
    for(const[name,value]of Object.entries(stored.fields))fields[name].value=value;changed();state.textContent='この接続先の草稿を復元しました。';
  }catch{state.textContent='草稿を復元できませんでした。現在の入力と公開操作は保持しています。';}}
  async function deleteDraft(){if(busy)return;try{if(!await fresh())return;storage.removeItem(key('draft'));state.textContent='端末に保存した草稿を削除しました。編集中の本文と未確認の公開操作は残しています。';}catch{state.textContent='保存した草稿を削除できませんでした。';}}
  async function release(){if(busy||!operation||!['rejected','resolved'].includes(operation.status))return;try{if(!await fresh())return;
    if(operation.status==='rejected'&&equal(normalize(raw()),operation.payload)){state.textContent='公開内容を修正してから、新しい確認へ進んでください。';return;}
    storage.removeItem(key('operation'));operation=null;preview=null;previewBox.replaceChildren();retryChecked=false;state.textContent='新しい公開内容を確認してください。';paint();
  }catch{state.textContent='公開操作を解除できませんでした。元の要求IDは保持しています。';}}
  if(!submit)button('preview','公開内容を確認',previewNow);button('confirm','確認して公開',()=>send());button('check','保存済み結果を確認',check);button('retry','同じ公開操作を再試行',()=>send(true));
  button('save','この端末に保存',saveDraft);button('restore','端末の草稿を復元',restoreDraft);button('delete-draft','保存した草稿を削除',deleteDraft);button('release','入力を修正して新しい確認へ',release);
  button('open','保存済みの記事を開く',async()=>{if(!operation?.receipt)return;const verified=await fresh();if(!verified)return;const{captured,turn}=verified;try{await onPublished(operation.receipt);}catch{if(current(captured,turn))state.textContent='保存済みの記事を開けませんでした。入力は保持しています。';}});
  button('scope','接続と操作記録を再確認',refreshScope);
  const drafts=make('details'),draftSummary=make('summary','下書き');drafts.append(draftSummary,buttons.save,buttons.restore,buttons['delete-draft']);owner.insertBefore(drafts,previewBox);
  function changed(){revision++;preview=null;previewBox.replaceChildren();retryChecked=false;paint();}
  const input=event=>{if(Object.values(fields).includes(event.target))changed();};const submitted=event=>{event.preventDefault();void previewNow();};
  const toggled=()=>{form.hidden=!form.hidden;if(!form.hidden)void refreshScope();};
  form.addEventListener('input',input);form.addEventListener('submit',submitted);toggle.addEventListener('click',toggled);
  paint();void refreshScope();
  return{refreshScope,destroy(){if(disposed)return;disposed=true;epoch++;form.removeEventListener('input',input);form.removeEventListener('submit',submitted);toggle.removeEventListener('click',toggled);for(const node of Object.values(buttons))node.onclick=null;owner.remove();}};
}
