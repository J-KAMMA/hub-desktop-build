const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const id=value=>typeof value==='string'&&value.length>=1&&value.length<=128&&!/[^A-Za-z0-9_-]/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/\0|\p{Surrogate}/u.test(value);
const date=value=>text(value,40)&&!/[^\x20-\x7e]/.test(value)&&/^(?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)|\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));
const statuses={draft:'下書き',pending:'審査待ち',published:'公開中',paused:'公開停止',rejected:'掲載不可'};
const sameScope=(a,b)=>a&&b&&a.key===b.key&&a.generation===b.generation;
function scopeValue(value){
 if(value===null)return null;if(!exact(value,['key','generation'])||typeof value.key!=='string'||value.key.length>4096||!Number.isSafeInteger(value.generation)||value.generation<0)throw Error('events_scope_invalid');
 const pair=JSON.parse(value.key);if(!Array.isArray(pair)||pair.length!==2||!text(pair[0],512)||!id(pair[1])||JSON.stringify(pair)!==value.key)throw Error('events_scope_invalid');
 const url=new URL(pair[0]);if(!['http:','https:'].includes(url.protocol)||url.origin!==pair[0]||url.username||url.password)throw Error('events_scope_invalid');return {...value,origin:pair[0],deviceId:pair[1]};
}
function safeUrl(value){if(!text(value,2048)||/\p{Cc}/u.test(value))throw Error('events_url_invalid');const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw Error('events_url_invalid');return url.href;}
function reasonValue(value){if(!text(value,500))throw Error('events_reason_invalid');const result=value.replace(/\s+/g,' ').trim();if(!result||result.length>500)throw Error('events_reason_invalid');return result;}
function listingValue(value){
 if(!exact(value,['id','title','kind','status','providerLabel','providerUrl','startsAt','updatedAt','cancelledAt','cancellationReason'])||!id(value.id)||value.kind!=='events'||!Object.hasOwn(statuses,value.status)
  ||!text(value.title,160)||!value.title.trim()||!text(value.providerLabel,120)||!value.providerLabel.trim()||!date(value.updatedAt)||value.startsAt!==null&&!date(value.startsAt))throw Error('events_listing_invalid');
 safeUrl(value.providerUrl);
 if(value.cancelledAt===null?value.cancellationReason!==null:!date(value.cancelledAt)||reasonValue(value.cancellationReason)!==value.cancellationReason)throw Error('events_listing_invalid');
 return {...value};
}
const budget=value=>{if(new TextEncoder().encode(JSON.stringify(value)).length>262144)throw Error('events_response_limit');return value;};
const laterPage=(a,b)=>a.updatedAt<b.updatedAt||a.updatedAt===b.updatedAt&&a.id>b.id;
function checkedCursor(value,last){
 if(typeof value!=='string'||!value.length||value.length>512||/[^A-Za-z0-9_-]/.test(value))throw Error('events_cursor_invalid');
 const binary=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));if(btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==value)throw Error('events_cursor_invalid');
 const item=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,char=>char.charCodeAt(0))));
 if(!exact(item,['updatedAt','id'])||!date(item.updatedAt)||!id(item.id)||item.updatedAt!==last.updatedAt||item.id!==last.id)throw Error('events_cursor_invalid');return item;
}
function listValue(value,viewer,previous,anchor,after){
 if(!exact(value,['viewerId','listings','nextCursor'])||!id(value.viewerId)||viewer!==null&&value.viewerId!==viewer||!Array.isArray(value.listings)||value.listings.length>20)throw Error('events_list_invalid');
 const listings=value.listings.map(listingValue);if(new Set(listings.map(row=>row.id)).size!==listings.length||listings.some((row,index)=>index>0&&!laterPage(row,listings[index-1])))throw Error('events_list_invalid');
 if(after!==null&&listings.some(row=>previous.some(old=>old.id===row.id)||!laterPage(row,anchor)))throw Error('events_list_invalid');
 if(value.nextCursor!==null){if(!listings.length||value.nextCursor===after)throw Error('events_list_invalid');checkedCursor(value.nextCursor,listings.at(-1));}
 return budget({viewerId:value.viewerId,listings,nextCursor:value.nextCursor});
}
function detailValue(value,viewer,listingId){if(!exact(value,['viewerId','listing'])||value.viewerId!==viewer)throw Error('events_detail_invalid');const listing=listingValue(value.listing);if(listing.id!==listingId)throw Error('events_detail_invalid');return budget({viewerId:viewer,listing});}

export function createOwnedEventListings({document,invoke,getScope,isCurrent,onOpen}){
 const element=document.createElement('details');element.className='owned-event-listings';const summary=document.createElement('summary');summary.textContent='自分のイベント掲載';element.append(summary);
 const node=(tag,copy,className)=>{const value=document.createElement(tag);if(copy!==undefined)value.textContent=copy;if(className)value.className=className;return value;};
 const status=node('p','','meta');status.setAttribute('role','status');const note=node('p','この操作はHub上のイベント掲載だけを取り消します。開催そのものや、注文・チケットの取消にはなりません。','meta');
 const filter=node('input');filter.type='search';filter.maxLength=160;filter.setAttribute('aria-label','このページのイベント掲載を絞り込む');filter.placeholder='このページの掲載を絞り込む';
 const controls=node('div',undefined,'actions'),rows=node('div',undefined,'result-grid'),editor=node('div',undefined,'detail-form');element.append(note,filter,controls,status,editor,rows);
 let disposed=false,invalidated=false,pending=false,scope=null,viewer=null,listings=[],nextCursor=null,anchor=null,page=0,selectedId=null,intent=null;
 const drafts=new Map();
 const alive=()=>{try{return !disposed&&!invalidated&&element.isConnected&&!element.closest('[hidden]')&&isCurrent()===true;}catch{return false;}};
 const button=(label,action)=>{const value=node('button',label,'head-action');value.type='button';value.onclick=()=>{if(alive()&&!pending&&!value.disabled&&element.contains(value))void action();};return value;};
 const selected=()=>listings.find(row=>row.id===selectedId);
 function changedScope(){invalidated=true;scope=null;viewer=null;listings=[];nextCursor=null;anchor=null;selectedId=null;intent=null;rows.replaceChildren();editor.replaceChildren();status.textContent='接続情報が変わりました。この一覧を開き直してください。';paint();}
 async function fresh(expected=null){if(!alive())return null;let next;try{next=scopeValue(await getScope());}catch{next=null;}if(!alive())return null;
  if(!next||expected&&!sameScope(expected,next)||scope&&!sameScope(scope,next)){changedScope();return null;}scope??=next;return next;}
 const detail=async(captured,listingId)=>{const raw=await invoke('hub_detail',{name:'owned_event_listing',ids:[listingId,viewer,captured.deviceId,captured.origin]});if(!alive()||!await fresh(captured))return null;return detailValue(raw,viewer,listingId).listing;};
 function paint(){
  element.setAttribute('aria-busy',String(pending));filter.disabled=pending;controls.replaceChildren();
  const reload=button('一覧を再取得',()=>load(null));reload.disabled=pending||invalidated||intent!==null;controls.append(reload);
  if(nextCursor!==null){const next=button('次の掲載',()=>load(nextCursor));next.disabled=pending||intent!==null;controls.append(next);}if(page>1){const first=button('最初の掲載へ',()=>load(null));first.disabled=pending||intent!==null;controls.append(first);}
  rows.replaceChildren();const query=filter.value.normalize('NFKC').trim().toLocaleLowerCase(),visible=listings.filter(row=>`${row.title} ${row.providerLabel}`.normalize('NFKC').toLocaleLowerCase().includes(query));
  if(!visible.length)rows.append(node('p',query?'このページに一致する掲載はありません。':'このページに掲載はありません。','meta'));
  for(const item of visible){const card=node('section',undefined,'card');card.append(node('strong',item.title),node('p',`${item.providerLabel} · ${item.cancelledAt?'掲載取消済み':statuses[item.status]}`,'meta'));
   const choose=button('掲載を選ぶ',()=>{selectedId=item.id;renderEditor();paint();});choose.disabled=pending||intent!==null;if(item.id===selectedId)choose.setAttribute('aria-pressed','true');card.append(choose);rows.append(card);}
  for(const action of editor.querySelectorAll('button'))action.disabled=pending||invalidated;
  const input=editor.querySelector('textarea');if(input)input.disabled=pending||intent!==null;
 }
 function renderEditor(){
  editor.replaceChildren();const item=selected();if(!item)return;
  editor.append(node('h3',item.title));const open=button('提供元のページを開く',async()=>{const captured=await fresh(scope);if(!captured||selectedId!==item.id)return;
   try{if(await onOpen(safeUrl(item.providerUrl))===false)throw Error('events_open_unconfirmed');if(!alive()||!await fresh(captured))return;}catch{if(alive())status.textContent='提供元のページを開けませんでした。';}});editor.append(open);
  if(item.cancelledAt){editor.append(node('p','掲載を取り消した日時: '+item.cancelledAt,'meta'),node('p','掲載取消理由: '+item.cancellationReason,'detail-p'));}
  if(intent){
   const box=node('section',undefined,'card');box.append(node('p',`「${intent.title}」のHub掲載を取り消します。開催や注文・チケットは取り消しません。`),node('p','掲載取消理由: '+intent.reason,'detail-p'));
   if(intent.state==='preview'){box.append(button('確認して掲載を取り消す',()=>cancel()),button('確認をやめる',()=>{intent=null;renderEditor();paint();}));}
   else if(intent.state==='unknown')box.append(button('取消状態を再確認',()=>recheck()),button('同じ理由で取消を再試行',()=>cancel()));
   else box.append(node('p','別の理由で掲載取消済みです。この理由では再送しません。','meta'),button('確認を閉じる',()=>{intent=null;renderEditor();paint();}));
   editor.append(box);return;
  }
  if(item.cancelledAt)return;
  const label=node('label','掲載取消の理由（1〜500文字）','field'),input=node('textarea');input.rows=3;input.maxLength=500;input.setAttribute('aria-label','掲載取消の理由');input.value=drafts.get(item.id)??'';
  input.oninput=()=>{if(alive()&&!pending&&selectedId===item.id&&!intent)drafts.set(item.id,input.value);};label.append(input);editor.append(label,button('掲載取消の内容を確認',()=>preview(item.id)));
 }
 async function load(after){if(pending||!alive()||intent||after!==null&&after!==nextCursor)return;pending=true;status.textContent='自分のイベント掲載を確認しています…';paint();
  try{const captured=await fresh(scope);if(!captured)return;const raw=await invoke('hub_detail',{name:'owned_event_listings',ids:[captured.deviceId,captured.origin,...(after===null?[]:[after])]});if(!alive()||!await fresh(captured))return;
   const value=listValue(raw,viewer,listings,anchor,after);if(after!==null&&page===Number.MAX_SAFE_INTEGER)throw Error('events_page_limit');viewer??=value.viewerId;listings=value.listings;nextCursor=value.nextCursor;anchor=listings.length?{updatedAt:listings.at(-1).updatedAt,id:listings.at(-1).id}:null;page=after===null?1:page+1;
   if(!selected())selectedId=null;renderEditor();status.textContent=`${page}ページ · ${listings.length}件。絞り込みはこのページの掲載だけが対象です。`;
  }catch{if(alive())status.textContent='一覧を確認できません。表示中の掲載と理由の下書きは保持しています。';}finally{pending=false;if(alive())paint();}}
 async function preview(listingId){if(pending||!alive()||selectedId!==listingId||intent)return;let reason;try{reason=reasonValue(drafts.get(listingId)??'');}catch{status.textContent='理由は1〜500文字、空欄や不正な文字を含めず入力してください。';return;}
  pending=true;paint();try{const captured=await fresh(scope);if(!captured)return;const item=await detail(captured,listingId);if(!item||selectedId!==listingId)return;
   listings=listings.map(row=>row.id===listingId?item:row);if(item.cancelledAt){status.textContent='この掲載は取消済みです。日時と理由を確認してください。';renderEditor();return;}
   intent={id:listingId,title:item.title,reason,scope:{...captured},updatedAt:item.updatedAt,state:'preview',ack:null};renderEditor();status.textContent='掲載だけを取り消す内容を確認してください。';
  }catch{if(alive())status.textContent='掲載の現在の状態を確認できません。理由の下書きは保持しています。';}finally{pending=false;if(alive())paint();}}
 function accepted(plan,item){listings=listings.map(row=>row.id===item.id?item:row);intent=null;status.textContent='Hub上の掲載取消の日時と理由を確認しました。開催や注文・チケットの取消ではありません。';renderEditor();}
 async function observe(plan,ack=null){
  const first=await detail(plan.scope,plan.id);if(!first||intent!==plan||selectedId!==plan.id)return;
  if(first.cancelledAt===null){plan.state='unknown';status.textContent='掲載取消を確認できません。理由は保持しています。再確認または同じ理由での明示的な再試行だけができます。';return;}
  if(first.cancellationReason!==plan.reason){plan.state='conflict';listings=listings.map(row=>row.id===first.id?first:row);status.textContent='別の理由で掲載取消済みです。この操作は再送しません。';return;}
  const second=ack??await detail(plan.scope,plan.id);if(!second||intent!==plan||selectedId!==plan.id)return;
  if(second.cancelledAt!==first.cancelledAt||second.cancellationReason!==first.cancellationReason){plan.state='unknown';status.textContent='掲載取消の日時と理由が一致しません。再送せず状態を再確認してください。';return;}accepted(plan,first);
 }
 async function cancel(){const plan=intent;if(!plan||pending||!alive()||selectedId!==plan.id||plan.state==='conflict')return;pending=true;status.textContent='Hub掲載の取消結果を確認しています…';paint();
  try{if(!await fresh(plan.scope))return;
   const raw=await invoke('hub_client_action',{action:'cancel_event_listing',target:plan.id,text:plan.reason,options:{expectedViewerId:viewer,expectedDeviceId:plan.scope.deviceId,expectedOrigin:plan.scope.origin}});
   if(!alive()||!await fresh(plan.scope)||intent!==plan||selectedId!==plan.id)return;const ack=detailValue(raw,viewer,plan.id).listing;
   if(ack.cancelledAt===null||ack.cancellationReason!==plan.reason)throw Error('event_listing_unknown');plan.ack=ack;await observe(plan,ack);
  }catch(error){if(alive()&&intent===plan){plan.state='unknown';const code=typeof error==='string'?error:error?.code??error?.message;
    if(code==='desktop_account_changed'||code==='desktop_not_connected'){changedScope();return;}
    if(code==='event_listing_conflict'){plan.state='conflict';status.textContent='別の理由で掲載取消済みです。この操作は再送しません。';return;}
    try{if(await fresh(plan.scope))await observe(plan);}catch{if(alive())status.textContent='取消結果を確認できません。理由を保持しています。重ねて送信せず、状態を再確認してください。';}
   }}finally{pending=false;if(alive()){renderEditor();paint();}}}
 async function recheck(){const plan=intent;if(!plan||pending||!alive()||plan.state!=='unknown'||selectedId!==plan.id)return;pending=true;paint();try{if(await fresh(plan.scope))await observe(plan,plan.ack);}catch{if(alive())status.textContent='取消結果を確認できません。理由は保持しています。';}finally{pending=false;if(alive()){renderEditor();paint();}}}
 filter.oninput=()=>{if(alive()&&!pending)paint();};paint();const ready=Promise.resolve().then(()=>load(null));
 return {element,ready,destroy(){disposed=true;intent=null;scope=null;viewer=null;listings=[];drafts.clear();element.replaceChildren();element.remove();}};
}
