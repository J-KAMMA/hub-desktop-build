const kinds={invites:'招待',rules:'ルール',questions:'参加時の質問'};
const node=(d,tag,text='',cls='')=>{const n=d.createElement(tag);n.textContent=text;n.className=cls;return n;};
const id=v=>typeof v==='string'&&v.length>=1&&v.length<=100&&!/[^A-Za-z0-9_-]/.test(v);
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const text=(v,max)=>typeof v==='string'&&Boolean(v.trim())&&v.length<=max&&!/[\ud800-\udfff]/u.test(v);
const safeText=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\ud800-\udfff]/u.test(v);
const normalized=(v,max)=>safeText(v,max)?v.normalize('NFKC').trim():null;
const date=v=>text(v,64)&&!/[\u0000-\u001f\u007f]/.test(v)&&Number.isFinite(Date.parse(v));
const nullableDate=v=>v===null||date(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const offset=v=>integer(v)&&v%20===0&&Number.isSafeInteger(v+20);
const invalid=()=>{throw Error('管理情報を確認できませんでした。');};
function item(v,kind){
  if(!v||!id(v.id)||!date(v.createdAt))invalid();
  if(kind==='invites'){
    if(!safeText(v.label,80)||!(v.maxUses===null||(integer(v.maxUses)&&v.maxUses>0))||!integer(v.useCount)||!nullableDate(v.expiresAt)||!nullableDate(v.revokedAt))invalid();
    return{id:v.id,label:v.label,maxUses:v.maxUses,useCount:v.useCount,expiresAt:v.expiresAt,revokedAt:v.revokedAt,createdAt:v.createdAt};
  }
  if(typeof v.required!=='boolean'||!integer(v.position))invalid();
  if(kind==='rules'){if(!text(v.title,80)||!text(v.body,1000)||!date(v.updatedAt))invalid();return{id:v.id,title:v.title,body:v.body,required:v.required,position:v.position,createdAt:v.createdAt,updatedAt:v.updatedAt};}
  if(!text(v.prompt,200))invalid();return{id:v.id,prompt:v.prompt,required:v.required,position:v.position,createdAt:v.createdAt};
}
function bounded(v){try{if(new TextEncoder().encode(JSON.stringify(v)).length>128*1024)invalid();}catch{invalid();}}
function page(v,cid,kind,requested){
  bounded(v);if(v?.communityId!==cid||v.kind!==kind||!id(v.viewerId)||!['owner','moderator'].includes(v.role)||v.offset!==requested||!offset(v.offset)||typeof v.hasMore!=='boolean'||!Array.isArray(v.items)||v.items.length>20||(v.hasMore&&v.items.length!==20))invalid();
  const items=v.items.map(value=>item(value,kind));if(new Set(items.map(value=>value.id)).size!==items.length)invalid();return{communityId:cid,viewerId:v.viewerId,role:v.role,kind,items,offset:requested,hasMore:v.hasMore};
}
const title=v=>v.label!==undefined?(v.label||'名前なしの招待'):v.title??v.prompt;
const actionFor=(kind,remove)=>kind==='invites'?(remove?'revoke_invite':'create_invite'):kind==='rules'?(remove?'delete_rule':'create_rule'):(remove?'delete_onboarding_question':'create_onboarding_question');

export function communityAccessManagement(target,{communityId,invoke,isCurrent=()=>true,onChanged,storage={}}={}){
  const document=target.ownerDocument??target,root=node(document,'details','','card detail-form community-access-management'),entries=storage.accessManagement??={},scope=JSON.stringify([communityId]);
  let kind=storage.accessManagementKind?.[scope]??'invites',active=true,pendingRead,code=null; if(!Object.hasOwn(kinds,kind))kind='invites';
  const entry=()=>entries[JSON.stringify([communityId,kind])]??=( {offset:0} );let state=entry();root.open=Boolean(state.open);
  const states=()=>Object.entries(entries).filter(([key])=>{try{return JSON.parse(key)[0]===communityId;}catch{return false;}}).map(([,value])=>value);
  const retained=s=>!s.invalidated&&entries[JSON.stringify([communityId,s.kind??kind])]===s;
  const valid=s=>{if(!retained(s))return false;let current=false;try{current=isCurrent()!==false;}catch{}if(!current){if(active)invalidate();return false;}return true;};
  const live=()=>active&&valid(state),sync=s=>s.sync?.();
  const denied=e=>/見つかりませんでした|権限がありません|このアカウントは停止|ハブが (?:401|403|404) を返しています|desktop_not_connected|community_access_rejected:(?:401|403|404):/.test(String(e?.message??e));
  const errorText=e=>String(e?.message??e).replace(/^community_access_rejected:(?:400|403|404|409):/,'');
  const locked=()=>states().some(s=>s.operation||s.sending);
  const canManage=(s,remove=false)=>s.data&&((s.kind==='invites'&&!remove)||s.data.role==='owner');
  const canEdit=()=>canManage(state)&&!state.stale&&!state.loading&&!state.sending&&!locked()&&!state.saved;
  function button(label,fn){const b=node(document,'button',label,'head-action');b.type='button';b.onclick=()=>{if(live())return fn();};return b;}
  function clearReader(s){delete s.data;delete s.draft;s.stale=true;s.permissionLost=true;s.readToken={};s.loading=false;code=null;if(!s.attempted&&!s.sending)delete s.operation;sync(s);}
  function closeAllowed(){return Boolean(state.operation&&(state.rejected||(state.uncertain&&state.operation.remove&&state.data?.role==='moderator'))&&!state.loading&&!state.sending&&!state.stale&&state.data?.viewerId===state.actor);}
  function render(){
    if(!live())return;root.replaceChildren(node(document,'summary','招待・ルール・参加時の質問'));
    const tabs=node(document,'nav','','detail-form-row');tabs.setAttribute('aria-label','管理する項目');for(const [key,label] of Object.entries(kinds)){const b=button(label,()=>switchKind(key));b.setAttribute('aria-pressed',String(kind===key));b.disabled=Boolean(state.loading||locked()||code);tabs.append(b);}root.append(tabs);
    const status=node(document,'p',state.error||state.notice||'','meta');status.setAttribute('role','status');if(state.error)status.classList.add('warning');root.append(status);
    if(state.loading)root.append(node(document,'p','管理情報を読み込んでいます…','meta'));
    if(state.stale&&state.data)root.append(node(document,'p','表示は以前の読み込み結果です。再確認するまで変更できません。','meta'));
    if(state.data){
      if(!canManage(state))root.append(node(document,'p','この項目の変更はオーナーだけが行えます。','meta'));
      if(!state.data.items.length)root.append(node(document,'p','このページに登録はありません。','meta'));
      const list=node(document,'ul','','detail-form');for(const value of state.data.items){const row=node(document,'li','','card detail-form');row.append(node(document,'h4',title(value)));if(kind==='invites')row.append(node(document,'p',`使用 ${value.useCount} / ${value.maxUses??'上限なし'} · 有効期限: ${value.expiresAt??'期限なし'} · ${value.revokedAt?'無効化済み':'有効'}`,'meta'));else row.append(node(document,'p',kind==='rules'?value.body:`${value.required?'回答必須':'任意回答'}`));if(canManage(state,true)&&!(kind==='invites'&&value.revokedAt)){const remove=button(kind==='invites'?'無効化を確認':'削除を確認',()=>prepare(true,value));remove.disabled=!canEdit();row.append(remove);}list.append(row);}root.append(list);
      const nav=node(document,'nav','','detail-form-row');nav.setAttribute('aria-label','管理項目のページ');const prev=button('前の20件',()=>load(state.offset-20)),next=button('次の20件',()=>load(state.offset+20));prev.disabled=!state.offset||Boolean(state.loading||locked());next.disabled=!state.data.hasMore||Boolean(state.loading||locked());nav.append(prev,next,node(document,'span',`${state.offset/20+1}ページ`,'meta'));root.append(nav);
    }
    if(state.saved){
      root.append(node(document,'p','変更は保存済みです。同じ操作を再送しません。','meta'));
      if(state.saved.different)root.append(node(document,'p','以前の操作は保存済みですが、現在の登録は確認した内容と異なるか、削除されています。再適用しません。','meta'));
      if(state.saved.action==='create_invite'){
        if(code){const box=node(document,'section','','card detail-form');box.setAttribute('aria-label','今回発行した招待');box.append(node(document,'p','この招待URLはこの画面で一度だけ表示します。画面を離れる前に控えてください。'));if(code.origin){const url=`${code.origin}/v2/community/invite/${code.value}`,link=node(document,'output',url);link.setAttribute('aria-label','招待URL');box.append(link);}else{box.append(node(document,'p',`招待コード: ${code.value}`),node(document,'p',code.error||'招待URLを確認しています…','meta'));if(code.error)box.append(button('招待URLを確認',()=>loadOrigin(state)));}box.append(button('コード表示を閉じる',()=>{code=null;sync(state);if(live())return onChanged?.();}));root.append(box);}
        else root.append(node(document,'p','招待は発行済みです。招待URLは復元できません。必要なら現在の招待を確認し、無効化と再発行を別の操作として行ってください。','meta'));
      }
      const reset=button('別の変更を行う',()=>{if(state.stale||state.loading||state.sending||!state.data||code)return;delete state.saved;delete state.operation;delete state.attempted;delete state.uncertain;delete state.rejected;state.draft={};state.error='';state.notice='';sync(state);});reset.disabled=Boolean(state.stale||state.loading||state.sending||!state.data||code);root.append(reset);
    }else if(state.operation){
      const op=state.operation,preview=node(document,'section','','card detail-form');preview.setAttribute('aria-label','管理変更の確認');preview.append(node(document,'h4',`${kinds[kind]} · ${op.remove?(kind==='invites'?'無効化':'削除'):'追加'}`),node(document,'p',`対象コミュニティ: ${communityId}`,'meta'));
      if(!state.permissionLost){const value=op.options.expected??op.options;preview.append(node(document,'p',title(value)??''));if(kind==='rules')preview.append(node(document,'p',value.body),node(document,'p',value.required===false?'確認任意':'確認必須','meta'));if(kind==='questions')preview.append(node(document,'p',`${value.required?'回答必須':'任意回答'}`));if(kind==='invites')preview.append(node(document,'p',op.remove?`現在: 使用 ${value.useCount} / ${value.maxUses??'上限なし'} · 有効期限 ${value.expiresAt??'期限なし'} · ${value.revokedAt?'無効化済み · '+value.revokedAt:'有効'}`:`発行後: 有効期限 ${value.expiresInDays}日 · 利用上限 ${value.maxUses??'なし'}`));if(op.remove){preview.append(node(document,'p',`登録日時: ${value.createdAt}`,'meta'));if(kind!=='invites')preview.append(node(document,'p',`表示順: ${value.position}`,'meta'));if(kind==='rules')preview.append(node(document,'p',`更新日時: ${value.updatedAt}`,'meta'));}preview.append(node(document,'h5','変更の理由'),node(document,'p',op.options.note));}
      if(kind==='invites'&&!op.remove)preview.append(node(document,'p','招待URLは発行直後に一度だけ表示します。再試行では復元できない場合があります。','meta'));
      if(kind==='questions'&&op.remove)preview.append(node(document,'p','この質問に寄せられた既存の回答も削除されます。','meta'));
      if(state.uncertain)preview.append(node(document,'p','保存結果が不明です。同じ対象・内容で結果を確認してください。','meta'));
      if(state.rejected)preview.append(node(document,'p','この操作は受け付けられませんでした。現在の登録を再確認してください。以前の保存結果は確定できない場合があります。','meta'));
      const save=button(state.attempted?'同じ変更の保存結果を確認':'確認して変更を保存',saveOperation);save.disabled=Boolean(state.loading||state.sending||state.stale||state.rejected||!canManage(state,op.remove));preview.append(save);
      if(!state.attempted)preview.append(button('編集に戻る',()=>{delete state.operation;sync(state);}));
      if(closeAllowed())preview.append(node(document,'p','以前の保存結果は確定できません。現在の登録を確認して、以前の操作を閉じます。再送しません。','meta'),button('現在の登録を確認して操作を閉じる',()=>{if(!closeAllowed())return;delete state.operation;delete state.attempted;delete state.rejected;delete state.uncertain;state.error='';state.notice='以前の操作を閉じました。登録内容は変更していません。';sync(state);}));root.append(preview);
    }else if(canManage(state))renderForm();
    const retry=button('管理情報を再読み込み',()=>load(state.failedOffset??state.offset));retry.disabled=Boolean(state.loading||state.sending);root.append(retry);
  }
  function field(form,label,name,max,type='input',defaultValue=''){
    const wrap=node(document,'label',label,'detail-form'),input=node(document,type);input.name=name;input.setAttribute('aria-label',label);if(max)input.maxLength=max;if(type==='textarea')input.rows=3;input.value=state.draft?.[name]??defaultValue;input.disabled=!canEdit();input.oninput=()=>{if(live()&&canEdit())(state.draft??={})[name]=input.value;};wrap.append(input);form.append(wrap);return input;
  }
  function renderForm(){
    const form=node(document,'form','','detail-form');if(kind==='invites'){field(form,'招待の名前','label',80);for(const [label,name,value] of [['有効期限（日）','expiresInDays','7'],['利用上限（空欄で上限なし）','maxUses','25']]){const input=field(form,label,name,null,'input',value);input.type='number';input.min='1';input.step='1';if(name==='expiresInDays')input.max='365';}}
    if(kind==='rules'){field(form,'ルールの見出し','title',80);field(form,'ルールの本文','body',1000,'textarea');form.append(node(document,'p','追加したルールは確認必須になります。','meta'));}
    if(kind==='questions'){field(form,'参加時の質問','prompt',200,'textarea');const wrap=node(document,'label','回答を必須にする','detail-form-row'),required=node(document,'input');required.type='checkbox';required.name='required';required.checked=state.draft?.required??false;required.disabled=!canEdit();required.onchange=()=>{if(live()&&canEdit())(state.draft??={}).required=required.checked;};wrap.append(required);form.append(wrap);}
    field(form,'変更の理由','note',1000,'textarea');const confirm=button('追加内容を確認',()=>prepare(false));confirm.disabled=!canEdit();form.append(confirm);form.onsubmit=e=>{e.preventDefault();if(live())prepare(false);};root.append(form);
  }
  function prepare(remove,selected){
    if(!live()||!canEdit()||!canManage(state,remove))return;const d=state.draft??{},note=normalized(d.note??'',1000);if(!text(note,1000)||note.length<5){state.error='変更の理由を5〜1000文字で入力してください。';sync(state);return;}
    let options={note};if(remove){const value=state.data.items.find(v=>v.id===selected?.id);if(!value)return;options={...options,[kind==='invites'?'inviteId':kind==='rules'?'ruleId':'questionId']:value.id,expected:Object.freeze({...value})};}
    else if(kind==='invites'){const label=normalized(d.label??'',80),days=Number(d.expiresInDays??7),raw=d.maxUses??'25',maxUses=String(raw).trim()===''?null:Number(raw);if(!safeText(label,80)||!Number.isInteger(days)||days<1||days>365||!(maxUses===null||(integer(maxUses)&&maxUses>0))){state.error='招待の名前・1〜365日の有効期限・利用上限を確認してください。';sync(state);return;}options={...options,label,expiresInDays:days,maxUses};}
    else if(kind==='rules'){const title=normalized(d.title??'',80),body=normalized(d.body??'',1000);if(!text(title,80)||!text(body,1000)){state.error='ルールの見出しと本文を入力してください。';sync(state);return;}options={...options,title,body};}
    else{const prompt=normalized(d.prompt??'',200);if(!text(prompt,200)||!(d.required===undefined||typeof d.required==='boolean')){state.error='参加時の質問を200文字以内で入力してください。';sync(state);return;}options={...options,prompt,required:d.required??false};}
    state.operation={action:actionFor(kind,remove),requestId:crypto.randomUUID(),options:Object.freeze(options),remove};state.error='';state.notice='';sync(state);
  }
  function result(v,s,op){
    bounded(v);const receipt=v?.receipt,expectedId=op.remove?(op.options.inviteId??op.options.ruleId??op.options.questionId):null;
    if(v?.communityId!==communityId||v.kind!==s.kind||!id(v.targetId)||v.targetId!==(expectedId??op.requestId)||receipt?.auditId!==op.requestId||!uuid(receipt?.auditId)||receipt.action!==op.action||receipt.targetId!==v.targetId||!date(receipt.confirmedAt)||typeof receipt.replayed!=='boolean')invalid();
    const target=v.target===null?null:item(v.target,s.kind);if(target&&target.id!==v.targetId)invalid();if(!op.remove&&!target&&!receipt.replayed)invalid();if(op.action==='create_invite'){if(!(v.inviteCode===null||(typeof v.inviteCode==='string'&&v.inviteCode.length===32&&/^[a-f0-9]{32}$/.test(v.inviteCode)))||(v.inviteCode!==null&&receipt.replayed))invalid();}else if(v.inviteCode!==null)invalid();
    const matches=targetMatches(target,op);if(!receipt.replayed&&!matches)invalid();
    return{targetId:v.targetId,receipt:{auditId:receipt.auditId,action:receipt.action,targetId:receipt.targetId,confirmedAt:receipt.confirmedAt,replayed:receipt.replayed},code:v.inviteCode,different:!matches};
  }
  function targetMatches(value,op){if(op.action.startsWith('delete'))return value===null;if(!value)return false;const expected=op.options;if(op.action==='revoke_invite')return value.revokedAt!==null&&Object.entries(expected.expected).every(([key,val])=>key==='revokedAt'||value[key]===val);if(op.action==='create_invite')return value.label===expected.label&&value.maxUses===expected.maxUses&&value.useCount===0&&value.revokedAt===null&&value.expiresAt!==null&&Date.parse(value.expiresAt)>Date.parse(value.createdAt);if(op.action==='create_rule')return value.title===expected.title&&value.body===expected.body&&value.required===true;return value.prompt===expected.prompt&&value.required===expected.required;}
  async function loadOrigin(s){const held=code;if(!held||held.loading||!active||!valid(s))return;held.loading=true;try{const value=await invoke('hub_origin');if(!active||!valid(s)||code!==held)return;const url=new URL(value);if(typeof value!=='string'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)&&url.port==='3020')))throw Error('招待URLの接続先を確認できませんでした。');held.origin=url.origin;delete held.error;}catch{if(active&&valid(s)&&code===held)held.error='招待は発行済みですが、招待URLを作成できませんでした。コードを控えて、接続先を再確認してください。';}finally{held.loading=false;if(active&&valid(s)&&code===held)sync(s);}}
  async function saveOperation(){
    const s=state,op=s.operation;if(!live()||!op||s.saved||s.sending||s.loading||s.stale||s.rejected||!canManage(s,op.remove))return;s.sending=true;s.attempted=true;s.uncertain=true;s.error='';sync(s);
    try{const value=await invoke('hub_client_action',{action:`community_access_${op.action}`,target:communityId,requestId:op.requestId,options:op.options});if(!valid(s))return;const ack=result(value,s,op);s.saved={action:op.action,requestId:op.requestId,targetId:ack.targetId,receipt:ack.receipt,different:ack.different};delete s.operation;delete s.uncertain;delete s.rejected;s.stale=true;s.sending=false;s.notice='変更は保存済みです。';if(active&&!s.permissionLost&&ack.code)code={value:ack.code};sync(s);if(code)await loadOrigin(s);
      if(active&&valid(s)){if(!code&&!s.permissionLost){try{await onChanged?.();}catch(e){if(valid(s))s.error=`変更は保存済みです。画面を更新できませんでした: ${errorText(e)}`;}}if(active&&valid(s))await load(s.offset);}
    }catch(e){if(valid(s)){if(/接続が変わりました/.test(String(e?.message??e))){invalidate();return;}const rejection=String(e?.message??e).match(/^community_access_rejected:(400|403|404|409):/);s.rejected=rejection?Number(rejection[1]):undefined;s.uncertain=!rejection;s.stale=Boolean(rejection);s.error=errorText(e);if(denied(e))for(const other of states())clearReader(other);}}
    finally{if(valid(s)){s.sending=false;sync(s);}else if(!active&&retained(s)){s.sending=false;sync(s);}if(!active&&!states().some(v=>v.loading||v.sending))document.defaultView?.removeEventListener('hub-account-changed',invalidate);}
  }
  async function readPage(s,requested){
    if(!live()||s.loading||s.sending)return;const token={};s.readToken=token;s.loading=true;s.error='';sync(s);
    try{if(!id(communityId)||!offset(requested))invalid();const value=await invoke('hub_detail',{name:'community_access_management_page',ids:[communityId,s.kind,String(requested)]});if(!valid(s)||s.readToken!==token)return;const data=page(value,communityId,s.kind,requested);if(states().some(v=>v.actor&&v.actor!==data.viewerId)){invalidate();return;}s.actor=data.viewerId;s.data=data;s.offset=requested;s.stale=false;s.permissionLost=false;delete s.failedOffset;}
    catch(e){if(valid(s)&&s.readToken===token){s.failedOffset=requested;s.stale=true;s.error=`${s.saved?'変更は保存済みです。現在の登録を確認できませんでした: ':''}${errorText(e)}`;if(denied(e)){const message=s.error;for(const other of states())clearReader(other);s.error=message;}}}
    finally{if(valid(s)&&s.readToken===token){s.loading=false;delete s.readToken;sync(s);}else if(!active&&retained(s)&&s.readToken===token){s.loading=false;s.stale=true;delete s.readToken;sync(s);}if(!active&&!states().some(v=>v.loading||v.sending))document.defaultView?.removeEventListener('hub-account-changed',invalidate);}
  }
  const load=requested=>pendingRead=readPage(state,requested);
  function switchKind(next){if(locked()||state.loading||code||next===kind)return;if(state.sync===render)delete state.sync;kind=next;(storage.accessManagementKind??={})[scope]=kind;state=entry();state.kind=kind;state.open=root.open;state.sync=render;render();if(root.open&&(!state.data||state.stale))load(state.offset);}
  function invalidate(){code=null;for(const s of states()){const notify=s.sync;for(const key of Object.keys(s))delete s[key];s.invalidated=true;notify?.();}for(const key of Object.keys(entries)){try{if(JSON.parse(key)[0]===communityId)delete entries[key];}catch{}}delete storage.accessManagementKind?.[scope];if(active)root.replaceChildren(node(document,'summary','招待・ルール・参加時の質問'),node(document,'p','接続が変わりました。管理画面を閉じて開き直してください。','meta'));document.defaultView?.removeEventListener('hub-account-changed',invalidate);}
  function dispose(){if(!active)return;active=false;code=null;[...root.querySelectorAll('[aria-label]')].find(node=>(globalThis.__hubI18n?.sourceAttr(node,'aria-label')??node.getAttribute('aria-label'))==='今回発行した招待')?.remove();if(state.sync===render)delete state.sync;root.ontoggle=null;for(const control of root.querySelectorAll('input,textarea,select,button'))control.disabled=true;if(!states().some(v=>v.loading||v.sending))document.defaultView?.removeEventListener('hub-account-changed',invalidate);}
  state.kind=kind;state.sync=render;root.ontoggle=()=>{if(!live())return;state.open=root.open;if(root.open&&(!state.data||state.stale)&&!state.loading&&!state.sending)return load(state.offset);};document.defaultView?.addEventListener('hub-account-changed',invalidate);render();if(root.open&&(!state.data||state.stale))load(state.offset);
  return{root,get ready(){return pendingRead??Promise.resolve();},dispose,invalidate};
}
