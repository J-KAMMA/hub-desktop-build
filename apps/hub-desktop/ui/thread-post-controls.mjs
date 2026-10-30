const id=value=>typeof value==='string'&&value.length>=1&&value.length<=128&&!/[^A-Za-z0-9_-]/.test(value);
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const text=(value,max,scalars=max)=>typeof value==='string'&&value.length<=max&&!/\0|\p{Surrogate}/u.test(value)&&Array.from(value).length<=scalars;
const timestamp=value=>text(value,40)&&!!value&&!/[^\x20-\x7e]/.test(value)&&Number.isFinite(Date.parse(value));
const equalScope=(a,b)=>a&&b&&a.key===b.key&&a.generation===b.generation;
function checkedScope(value){
  if(value===null)return null;
  if(!exact(value,['key','generation'])||typeof value.key!=='string'||value.key.length>4096||!Number.isSafeInteger(value.generation)||value.generation<0)throw Error('thread_scope_invalid');
  const pair=JSON.parse(value.key);if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||pair[0].length>512||!id(pair[1])||JSON.stringify(pair)!==value.key)throw Error('thread_scope_invalid');
  const url=new URL(pair[0]);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.origin!==pair[0])throw Error('thread_scope_invalid');
  return {...value,origin:pair[0],deviceId:pair[1]};
}
function bounded(value){if(new TextEncoder().encode(JSON.stringify(value)).length>1048576)throw Error('thread_response_limit');return value;}
function relationship(value,viewerId,postId){
  if(!exact(value,['viewerId','postId','control'])||value.viewerId!==viewerId||value.postId!==postId||!exact(value.control,['muted','blocked'])
    ||typeof value.control.muted!=='boolean'||typeof value.control.blocked!=='boolean')throw Error('thread_relationship_invalid');
  return bounded({viewerId,postId,control:{...value.control}});
}
const older=(a,b)=>a.createdAt<b.createdAt||a.createdAt===b.createdAt&&a.id<b.id;
function cursor(value,postId,last){
  if(typeof value!=='string'||!value.length||value.length>512||/[^A-Za-z0-9_-]/.test(value))throw Error('thread_history_cursor_invalid');
  const binary=atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4));
  if(btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==value)throw Error('thread_history_cursor_invalid');
  const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,char=>char.charCodeAt(0))));
  if(!exact(decoded,['postId','createdAt','id'])||decoded.postId!==postId||!id(decoded.id)||!timestamp(decoded.createdAt)
    ||decoded.id!==last.id||decoded.createdAt!==last.createdAt)throw Error('thread_history_cursor_invalid');
  return decoded;
}
function history(value,viewerId,postId,previous,requestedCursor){
  if(!exact(value,['viewerId','postId','revisions','nextCursor'])||value.viewerId!==viewerId||value.postId!==postId||!Array.isArray(value.revisions)||value.revisions.length>5)throw Error('thread_history_invalid');
  const revisions=value.revisions.map(row=>{
    if(!exact(row,['id','postId','body','createdAt','editReason'])||!id(row.id)||row.postId!==postId||!text(row.body,40000,20000)||!text(row.editReason,600,300)||!timestamp(row.createdAt))throw Error('thread_history_invalid');
    return {...row};
  });
  if(new Set(revisions.map(row=>row.id)).size!==revisions.length||revisions.some((row,index)=>index>0&&!older(row,revisions[index-1])))throw Error('thread_history_invalid');
  if(requestedCursor!==null&&(revisions.some(row=>previous.some(old=>old.id===row.id))||revisions.length&&!older(revisions[0],previous.at(-1))))throw Error('thread_history_invalid');
  if(value.nextCursor!==null){if(!revisions.length||value.nextCursor===requestedCursor)throw Error('thread_history_invalid');cursor(value.nextCursor,postId,revisions.at(-1));}
  return bounded({viewerId,postId,revisions,nextCursor:value.nextCursor});
}

/** Post capability flags are presentation metadata; the fixed Native/API path checks authority. */
export function createThreadPostControls({document,post,viewerId,invoke,getScope,isCurrent,onChanged=()=>{}}){
  const postId=post?.id,own=post?.viewerIsAuthor===true;
  const canRelate=id(postId)&&id(viewerId)&&post?.viewerIsAuthor===false&&post?.canControlAuthor===true&&!post?.moderatedAt&&!post?.deletedAt;
  const canHistory=id(postId)&&id(viewerId)&&own&&timestamp(post?.editedAt);
  const element=document.createElement('details');element.className='thread-post-controls';element.hidden=!canRelate&&!canHistory;
  const summary=document.createElement('summary');summary.textContent='投稿の操作';element.append(summary);
  const status=document.createElement('p');status.className='meta';status.setAttribute('role','status');element.append(status);
  const controls=document.createElement('div');controls.className='actions';const historyBox=document.createElement('div');historyBox.className='detail-form';element.append(controls,historyBox);
  const signature=()=>JSON.stringify([post?.id,post?.viewerIsAuthor,post?.canControlAuthor,post?.editedAt??null,post?.moderatedAt??null,post?.deletedAt??null]),original=signature();
  let disposed=false,invalidated=false,pending=false,scope=null,control=null,intent=null,revisions=[],nextCursor=null,historyLoaded=false,page=0;
  const alive=()=>{try{return !disposed&&!invalidated&&signature()===original&&element.isConnected&&!element.closest('[hidden]')&&isCurrent()===true;}catch{return false;}};
  function stale(){invalidated=true;scope=null;control=null;revisions=[];nextCursor=null;historyLoaded=false;historyBox.replaceChildren();status.textContent='接続や投稿が変わりました。この投稿を開き直してください。';paint();}
  async function fresh(captured=null){
    if(!alive())return null;let next;try{next=checkedScope(await getScope());}catch{next=null;}
    if(!alive())return null;
    if(!next||captured&&!equalScope(captured,next)||scope&&!equalScope(scope,next)){stale();return null;}
    if(!scope)scope=next;return next;
  }
  const detail=(name,captured,after=null)=>invoke('hub_detail',{name,ids:[postId,captured.deviceId,captured.origin,viewerId,...(after===null?[]:[after])]});
  const button=(label,action)=>{const node=document.createElement('button');node.type='button';node.className='head-action';node.textContent=label;node.onclick=()=>{if(alive()&&!pending&&element.contains(node)&&!node.disabled)void action();};return node;};
  function notify(value){if(alive()){const failed=()=>{if(alive())status.textContent='状態を確認しました。表示を更新するにはこの投稿を開き直してください。';};try{void Promise.resolve(onChanged(structuredClone(value))).catch(failed);}catch{failed();}}}
  function paint(){
    controls.replaceChildren();element.setAttribute('aria-busy',String(pending));
    if(canRelate){
      for(const [kind,key,label]of [['mute','muted','ミュート'],['block','blocked','ブロック']]){
        const enabled=control? !control[key]:null,action=button(control?.[key]?label+'を解除':label,()=>change(kind,enabled));
        action.disabled=pending||invalidated||control===null||intent!==null;controls.append(action);
      }
      const read=button('状態を確認',()=>readRelationship());read.disabled=pending||invalidated;controls.append(read);
      if(intent){const retry=button(`${intent.kind==='mute'?'ミュート':'ブロック'}${intent.enabled?'する':'を解除する'}操作を再試行`,()=>change(intent.kind,intent.enabled,true));retry.disabled=pending||scope===null;controls.append(retry);}
    }
    if(canHistory){const read=button(historyLoaded?'履歴を再取得':'編集履歴',()=>readHistory(null));read.disabled=pending||invalidated;controls.append(read);
      if(nextCursor!==null){const more=button('古い履歴を表示',()=>readHistory(nextCursor));more.disabled=pending;controls.append(more);}
      if(page>1){const first=button('最初の履歴へ',()=>readHistory(null));first.disabled=pending;controls.append(first);}
    }
  }
  async function readRelationship(){
    if(!canRelate||pending||!alive())return;pending=true;status.textContent='状態を確認しています…';paint();
    try{const captured=await fresh();if(!captured)return;const raw=await detail('thread_post_relationship',captured);if(!alive()||!await fresh(captured))return;
      const value=relationship(raw,viewerId,postId);control=value.control;
      if(intent){const key=intent.kind==='mute'?'muted':'blocked';if(control[key]===intent.enabled){intent=null;status.textContent='希望した状態を確認しました。';notify(value);}else status.textContent='希望した状態は確認できません。同じ操作を再試行できます。';}
      else status.textContent='現在の状態を確認しました。';
    }catch{if(alive()){control=null;status.textContent='状態を確認できません。変更せずに再確認してください。';}}
    finally{pending=false;if(alive())paint();}
  }
  async function change(kind,enabled,retry=false){
    if(!canRelate||pending||!alive()||!['mute','block'].includes(kind)||typeof enabled!=='boolean'||(retry?!intent||intent.kind!==kind||intent.enabled!==enabled:control===null||intent!==null))return;
    pending=true;status.textContent='変更した状態を確認しています…';paint();
    try{
      const captured=await fresh(intent?.scope??scope);if(!captured)return;
      intent??={kind,enabled,scope:{...captured}};paint();
      const raw=await invoke('hub_client_action',{action:'thread_post_relationship',target:postId,options:{kind,enabled,expectedDeviceId:captured.deviceId,expectedOrigin:captured.origin,expectedViewerId:viewerId}});
      if(!alive()||!await fresh(captured))return;
      const receipt=relationship(raw,viewerId,postId),key=kind==='mute'?'muted':'blocked';if(receipt.control[key]!==enabled)throw Error('thread_relationship_unconfirmed');
      const confirmed=await detail('thread_post_relationship',captured);if(!alive()||!await fresh(captured))return;
      const value=relationship(confirmed,viewerId,postId);if(value.control[key]!==enabled)throw Error('thread_relationship_unconfirmed');
      control=value.control;intent=null;status.textContent='希望した状態を確認しました。';notify(value);
    }catch{if(alive())status.textContent='変更結果を確認できません。希望する状態は保持しています。状態を確認するか、同じ操作を再試行してください。';}
    finally{pending=false;if(alive())paint();}
  }
  function renderHistory(){
    historyBox.replaceChildren();const count=document.createElement('p');count.className='meta';count.textContent=revisions.length?`編集履歴 · ${page}ページ（${revisions.length}件）`:'編集履歴はありません。';historyBox.append(count);
    for(const row of revisions){const item=document.createElement('section');item.className='card';const date=document.createElement('p');date.className='meta';date.textContent=row.createdAt;
      const body=document.createElement('p');body.className='detail-p';body.style.whiteSpace='pre-wrap';body.textContent=row.body;
      const disclosure=document.createElement('details'),heading=document.createElement('summary');heading.textContent=`編集前の本文を表示（${Array.from(row.body).length}文字）`;disclosure.append(heading,body);item.append(date,disclosure);
      if(row.editReason){const reason=document.createElement('p');reason.className='meta';reason.textContent='編集理由: '+row.editReason;item.append(reason);}historyBox.append(item);}
  }
  async function readHistory(after){
    if(!canHistory||pending||!alive()||after!==null&&after!==nextCursor)return;pending=true;status.textContent='編集履歴を確認しています…';paint();
    try{const captured=await fresh();if(!captured)return;const raw=await detail('thread_post_history',captured,after);if(!alive()||!await fresh(captured))return;
      const value=history(raw,viewerId,postId,revisions,after);if(after!==null&&page===Number.MAX_SAFE_INTEGER)throw Error('thread_history_page_limit');
      revisions=value.revisions;nextCursor=value.nextCursor;page=after===null?1:page+1;historyLoaded=true;renderHistory();status.textContent='編集履歴を確認しました。本文はこのページの最大5件を表示します。';
    }catch{if(alive())status.textContent='編集履歴を確認できません。表示済みの履歴は保持しています。';}
    finally{pending=false;if(alive())paint();}
  }
  element.ontoggle=()=>{if(element.open&&canRelate&&control===null&&!intent&&!pending&&alive())void readRelationship();};
  paint();return {element,destroy(){disposed=true;intent=null;control=null;revisions=[];nextCursor=null;scope=null;element.ontoggle=null;element.replaceChildren();element.remove();}};
}
