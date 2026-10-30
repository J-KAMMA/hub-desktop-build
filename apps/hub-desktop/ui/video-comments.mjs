const id = value => typeof value === 'string' && value.length>0 && value.length<=128 && !/[^A-Za-z0-9_-]/u.test(value);
const profileId = value => typeof value === 'string' && value.length>0 && value.length<=160 && /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9._:-]/u.test(value);
const date = value => typeof value==='string' && value.length<=64 && Number.isFinite(Date.parse(value));
function snapshot(value, videoId) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==2 || !(value.viewerId === null || profileId(value.viewerId)) || !Array.isArray(value.comments) || value.comments.length > 300) throw Error('invalid_comments');
  const ids=new Set();
  for(const item of value.comments) {
    if(!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).some(key=>!['id','videoId','parentCommentId','body','playbackSeconds','createdAt','updatedAt','likeCount','likedByViewer','author'].includes(key))
      || !id(item.id) || ids.has(item.id) || item.videoId !== videoId || typeof item.body !== 'string' || !item.body.trim() || item.body.length>1000
      || item.parentCommentId !== undefined && !id(item.parentCommentId) || !date(item.createdAt) || !date(item.updatedAt)
      || item.playbackSeconds!==undefined&&(!Number.isSafeInteger(item.playbackSeconds)||item.playbackSeconds<0||item.playbackSeconds>604800)
      || !Number.isSafeInteger(item.likeCount) || item.likeCount<0 || typeof item.likedByViewer!=='boolean'
      || !item.author || typeof item.author!=='object' || Array.isArray(item.author) || Object.keys(item.author).some(key=>!['profileId','displayName','handle','avatarUrl'].includes(key))
      || !profileId(item.author.profileId) || typeof item.author.displayName!=='string' || item.author.displayName.length>200
      || typeof item.author.handle!=='string' || item.author.handle.length>64 || item.author.avatarUrl!==undefined&&typeof item.author.avatarUrl!=='string') throw Error('invalid_comments');
    ids.add(item.id);
  }
  const byId=new Map(value.comments.map(item=>[item.id,item]));
  if(value.comments.some(item=>item.parentCommentId===item.id || item.parentCommentId&&byId.get(item.parentCommentId)?.parentCommentId)) throw Error('invalid_reply');
  return value;
}

export function createVideoComments(document,{videoId,invoke,isCurrent=()=>true,state={},onProfile=()=>{},readOnly=false}) {
  if(!id(videoId)) throw Error('invalid_video');
  const element=document.createElement('section');element.className='detail-section';element.setAttribute('aria-label','Hubの動画コメント');
  const heading=document.createElement('h3');heading.textContent='Hubのコメント';
  const note=document.createElement('p');note.className='meta';note.textContent='このHubに登録された動画へのコメントです。提供元には送信しません。';
  const status=document.createElement('p');status.className='meta';status.setAttribute('role','status');
  const list=document.createElement('div'),form=document.createElement('form');form.className='detail-form';
  const reply=document.createElement('p');reply.className='meta';
  const input=document.createElement('textarea');input.maxLength=1000;input.rows=3;input.setAttribute('aria-label','動画へのコメント');input.value=typeof state.body==='string'?state.body:'';
  const count=document.createElement('span');count.className='meta';
  const button=(text,action)=>{const node=document.createElement('button');node.type='button';node.className='head-action';node.textContent=text;node.onclick=action;return node;};
  const clear=button('返信先を解除',()=>{if(!usable()||pending)return;delete state.parentCommentId;paint();});
  const send=button('コメントを投稿',()=>submit());send.type='submit';send.onclick=null;
  const refresh=button('コメントを更新',()=>usable()&&reload());
  const resume=button('一覧を確認して再投稿を許可',()=>{if(!usable()||pending||!checkedUnknown)return;state.uncertain=false;checkedUnknown=false;status.textContent='重複がないことを確認してから投稿してください。';paint();});
  let comments=[],viewerId=null,loaded=false,pending=false,disposed=false,generation=0,checkedUnknown=false,viewerChanged=false;
  const current=()=>!disposed&&isCurrent();
  const usable=()=>current()&&element.isConnected&&!element.closest('[hidden]');
  const active=turn=>current()&&turn===generation;
  input.oninput=()=>{if(!usable()||pending||viewerChanged)return;state.body=input.value;count.textContent=`${input.value.length} / 1000`;send.disabled=!!state.uncertain||!input.value.trim()||input.value.length>1000;};
  form.onsubmit=event=>{event.preventDefault();return submit();};
  form.append(reply,clear,input,count,send);element.append(heading,note,refresh,status,list,form,resume);
  // 新しいコメントは投稿として書く（video-posts.mjs）。ここは以前のコメントを読むだけにする。
  if(readOnly){heading.textContent='以前のコメント';element.setAttribute('aria-label','以前のコメント');for(const node of [note,refresh,form,resume,status])node.remove();element.hidden=true;}
  function paint(){
    element.setAttribute('aria-busy',String(pending));refresh.disabled=pending;input.disabled=pending;clear.disabled=pending;
    form.hidden=!loaded||viewerId===null;send.disabled=pending||!!state.uncertain||!input.value.trim()||input.value.length>1000;
    resume.hidden=!state.uncertain||!checkedUnknown;resume.disabled=pending;count.textContent=`${input.value.length} / 1000`;
    const parent=comments.find(item=>item.id===state.parentCommentId&&!item.parentCommentId);
    reply.textContent=parent?`返信先: ${parent.author.displayName} · ${parent.body.slice(0,80)}`:state.parentCommentId?'返信先のコメントを確認できません。返信先を解除してから投稿してください。':'';
    clear.hidden=!state.parentCommentId;
    list.replaceChildren();
    if(readOnly)element.hidden=!loaded||!comments.length;
    if(!readOnly&&loaded&&!comments.length) {const empty=document.createElement('p');empty.className='meta';empty.textContent='まだコメントはありません。';list.append(empty);}
    if(!readOnly&&loaded&&viewerId===null){const auth=document.createElement('p');auth.className='meta';auth.textContent='コメント・いいね・通報にはHubへの接続が必要です。';list.append(auth);}
    const byId=new Map(comments.map(item=>[item.id,item]));
    const row=item=>{
      const card=document.createElement('article');card.className='card';card.dataset.commentId=item.id;
      const author=button(item.author.displayName,()=>{if(usable()&&list.contains(card))onProfile(item.author.handle);});author.setAttribute('aria-label',`${item.author.displayName}のプロフィール`);
      const meta=document.createElement('p');meta.className='meta';meta.textContent=`@${item.author.handle} · ${new Date(item.createdAt).toLocaleString('ja-JP')}`;
      const body=document.createElement('p');body.className='detail-p';body.textContent=item.body;card.append(author,meta,body);
      if(item.parentCommentId){const context=document.createElement('p');context.className='meta';context.textContent=`返信先: ${byId.get(item.parentCommentId)?.author.displayName??'現在表示できないコメント'}`;card.append(context);}
      const actions=document.createElement('div');actions.className='detail-form-row';
      const like=button(`いいね ${item.likeCount}`,()=>list.contains(card)&&mutate(item.likedByViewer?'video_comment_unlike':'video_comment_like',{commentId:item.id}));like.setAttribute('aria-pressed',String(item.likedByViewer));like.disabled=viewerId===null||pending;actions.append(like);
      if(!item.parentCommentId){const choose=button('返信',()=>{if(!usable()||pending||!list.contains(card))return;state.parentCommentId=item.id;paint();input.focus();});choose.disabled=viewerId===null||pending;actions.append(choose);}
      if(viewerId!==null){const reasons=document.createElement('select');reasons.setAttribute('aria-label','コメントを通報');reasons.disabled=pending;for(const [value,text] of [['','通報…'],['spam','スパム'],['harassment','嫌がらせ'],['other','その他']]){const option=document.createElement('option');option.value=value;option.textContent=text;reasons.append(option);}reasons.onchange=()=>{const reason=reasons.value;reasons.value='';if(reason&&list.contains(card))void mutate('video_comment_report',{commentId:item.id,reason});};actions.append(reasons);}
      if(!readOnly)card.append(actions);list.append(card);
    };
    for(const item of comments.filter(item=>!item.parentCommentId)) {row(item);for(const child of comments.filter(child=>child.parentCommentId===item.id))row(child);}
    for(const item of comments.filter(item=>item.parentCommentId&&!byId.has(item.parentCommentId))) row(item);
    if(state.uncertain&&!checkedUnknown&&!pending&&!viewerChanged)status.textContent='投稿結果が不明です。まずコメントを更新し、重複がないことを確認してください。';
  }
  function bindViewer(value){if(Object.hasOwn(state,'viewerId')&&value!==state.viewerId)throw Error('viewer_changed');state.viewerId=value;}
  function lockViewer(){viewerChanged=true;loaded=false;viewerId=null;comments=[];checkedUnknown=false;status.textContent='Hubへの接続が変わりました。コメント一覧を開き直してください。';}
  async function reload(){
    if(!current()||pending)return;const turn=++generation;pending=true;checkedUnknown=false;status.textContent='コメントを読み込んでいます…';paint();
    try{const value=snapshot(await invoke('hub_detail',{name:'video_comments',ids:[videoId]}),videoId);if(!active(turn))return;
      bindViewer(value.viewerId);comments=value.comments;viewerId=value.viewerId;loaded=true;viewerChanged=false;checkedUnknown=!!state.uncertain&&viewerId!==null;status.textContent=`${comments.length} 件のコメント`;
    }catch(error){if(active(turn)){if(error?.message==='viewer_changed')lockViewer();else status.textContent='コメントを取得できませんでした。表示中のコメントと下書きを保持しています。';}}
    finally{if(active(turn)){pending=false;paint();}}
  }
  async function mutate(action,options){
    if(!usable()||pending||viewerId===null)return;
    const turn=++generation,viewer=viewerId;pending=true;status.textContent='反映しています…';paint();
    try{const value=await invoke('hub_client_action',{action,target:videoId,options});if(!active(turn)||!usable())return;
      if(action==='video_comment_report'){if(value?.viewerId!==viewer)throw Error('viewer_changed');if(Object.keys(value).length!==3||value.reported!==true||value.commentId!==options.commentId)throw Error('unconfirmed');status.textContent='通報を受け付けました。';}
      else{snapshot(value,videoId);if(value.viewerId!==viewer)throw Error('viewer_changed');comments=value.comments;status.textContent='いいねを更新しました。';}
    }catch(error){if(active(turn)){if(error?.message==='viewer_changed')lockViewer();else status.textContent='結果を確認できませんでした。コメントを更新して確認してください。';}}
    finally{if(active(turn)){pending=false;paint();}}
  }
  async function submit(){
    if(!usable()||pending||viewerId===null||state.uncertain)return;
    const body=input.value.trim(),parent=state.parentCommentId;
    if(!body||body.length>1000||parent&&!comments.some(item=>item.id===parent&&!item.parentCommentId))return;
    const turn=++generation,viewer=viewerId;pending=true;state.uncertain=true;checkedUnknown=false;status.textContent='投稿しています…';paint();
    try{const value=snapshot(await invoke('hub_client_action',{action:'video_comment_create',target:videoId,options:{body,...(parent?{parentCommentId:parent}:{})}}),videoId);if(!active(turn)||!usable())return;
      if(value.viewerId!==viewer)throw Error('viewer_changed');comments=value.comments;state.uncertain=false;state.body='';delete state.parentCommentId;input.value='';status.textContent='コメントを投稿しました。';
    }catch(error){if(active(turn)){state.uncertain=true;checkedUnknown=false;if(error?.message==='viewer_changed')lockViewer();else status.textContent='投稿結果が不明です。コメントを更新して確認してください。';}}
    finally{if(active(turn)){pending=false;paint();}}
  }
  const invalidate=()=>{disposed=true;generation++;comments=[];viewerId=null;state.body='';delete state.parentCommentId;delete state.viewerId;state.uncertain=false;element.replaceChildren();};
  document.defaultView?.addEventListener('hub-account-changed',invalidate);
  paint();const ready=reload();return {element,ready,reload,destroy(){disposed=true;generation++;document.defaultView?.removeEventListener('hub-account-changed',invalidate);element.remove();}};
}
