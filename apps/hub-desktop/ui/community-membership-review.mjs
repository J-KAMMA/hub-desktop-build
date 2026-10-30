const node=(document,tag,text='',className='')=>{const result=document.createElement(tag);result.textContent=text;result.className=className;return result;};
const button=(document,text,action)=>{const result=node(document,'button',text,'head-action');result.type='button';result.onclick=action;return result;};
const statuses={pending:'審査待ち',approved:'承認済み',rejected:'却下済み',cancelled:'取り下げ済み'};
export function communityMembershipReviewRequest(entry) {
 return entry.name==='community_membership_requests' && entry.membershipReviewPage?.offset?{name:'community_membership_requests_page',ids:[...entry.ids,String(entry.membershipReviewPage.offset)]}:null;
}
export function communityMembershipRequests(document,{communityId,data,state={},invoke,onOpen}) {
 const root=node(document,'section','','detail-form community-membership-review'),list=node(document,'div','','detail-form'),notice=node(document,'p','','meta');notice.setAttribute('role','status');let current=data,busy=false;
 async function load(offset) {
  if(busy)return;busy=true;list.querySelectorAll('button').forEach(item=>item.disabled=true);notice.textContent='読み込み中…';
  try{
   const next=await invoke('hub_detail',{name:'community_membership_requests_page',ids:[communityId,String(offset)]});
   if(next.communityId!==communityId || !Array.isArray(next.requests) || next.page?.offset!==offset)throw Error('申請一覧を確認できませんでした。');
   current=next;state.offset=offset;render();notice.textContent='';
  }catch(error){notice.textContent=String(error?.message??error);render();}finally{busy=false;}
 }
 function render() {
  const cards=(current.requests??[]).map(item=>{const card=node(document,'article','','card detail-form');card.append(button(document,item.displayName,()=>onOpen('community_membership_request',[communityId,item.profileId],item.displayName+'の参加申請')),node(document,'p',item.createdAt,'meta'));return card;});
  const nav=node(document,'nav','','detail-form-row');nav.setAttribute('aria-label','参加申請のページ');const previous=button(document,'前の20件',()=>load(Math.max(0,current.page.offset-20))),next=button(document,'次の20件',()=>load(current.page.nextOffset));previous.disabled=!current.page?.offset;next.disabled=!current.page?.hasMore;nav.append(previous,next);
  list.replaceChildren(...(cards.length?cards:[node(document,'p','審査待ちの参加申請はありません。','meta')]),nav);
 }
 state.offset=current.page?.offset??0;root.append(node(document,'h3','参加申請'),list,notice);render();return root;
}
export function communityMembershipReview(document,{communityId,profileId,data,state={},invoke,onReload}) {
 const root=node(document,'section','','card detail-form community-membership-review'),request=data.request,notice=node(document,'p','','meta');notice.setAttribute('role','status');
 if(data.communityId!==communityId || !request || request.profileId!==profileId){root.append(node(document,'p','参加申請を確認できませんでした。','meta'));return root;}
 let saved=false;
 const status=node(document,'p',(statuses[request.status]??'状態不明')+' · '+request.createdAt,'meta');root.append(node(document,'h3',request.displayName+'の参加申請'),status,node(document,'h4','参加質問の回答'));
 for(const answer of data.answers??[]){const card=node(document,'section','','detail-form');card.append(node(document,'h4',answer.prompt),node(document,'p',answer.answer,'detail-p'));root.append(card);}
 if(!data.answers?.length)root.append(node(document,'p','回答が必要な参加質問はありません。','meta'));
 const reload=button(document,'状態を再読込',async()=>{try{await onReload?.();}catch{notice.textContent='最新の申請を読み込めませんでした。'+(saved?'審査は保存済みです。':'');}});root.append(reload);
 if(request.status!=='pending' || request.profileId===data.viewerId || !['owner','moderator'].includes(data.role)){root.append(notice);return root;}
 const reason=node(document,'textarea');reason.rows=3;reason.maxLength=1000;reason.setAttribute('aria-label','判断理由');reason.placeholder='判断理由を5〜1000文字で入力';reason.value=state.note??'';
 const label=node(document,'label','判断理由','detail-form'),preview=node(document,'section','','card detail-form'),controls=node(document,'div','','detail-form-row');preview.hidden=true;label.append(reason);let busy=false,confirmed=null;
 reason.oninput=()=>{state.note=reason.value;confirmed=null;preview.hidden=true;};
 const confirm=decision=>{
  if(busy||saved)return;const note=reason.value.normalize('NFKC').trim();if(note.length<5 || note.length>1000){notice.textContent='判断理由は5〜1000文字で入力してください。';return;}
  confirmed={decision,note,expectedCreatedAt:request.createdAt};
  const submit=button(document,'確認して実行',()=>void save());
  preview.replaceChildren(node(document,'h4',request.displayName+'の申請を'+(decision==='approve'?'承認':'却下')),node(document,'p',decision==='approve'?'参加者として閲覧・投稿できる状態にします。':'この申請での参加を認めません。本人は再申請できます。','detail-p'),node(document,'p',note,'detail-p'),submit);preview.hidden=false;notice.textContent='対象・回答・判断理由を確認して実行してください。';
 };
 controls.append(button(document,'却下',()=>confirm('reject')));if(request.canApprove)controls.append(button(document,'承認',()=>confirm('approve')));else root.append(node(document,'p','制限中のプロフィールは承認できません。','meta'));
 async function save() {
  if(busy||saved||!confirmed)return;busy=true;root.querySelectorAll('button,textarea').forEach(field=>field.disabled=true);
  const input=confirmed,key=JSON.stringify(input);if(state.request?.key!==key)state.request={key,id:crypto.randomUUID()};const id=state.request.id;
  try{
   const result=await invoke('hub_action',{action:'community_membership_review',target:communityId,requestId:id,options:{profileId,...input}});
   if(result.ok!==true || result.receipt?.auditId!==id || result.receipt?.targetId!==profileId || result.receipt?.action!=='membership' || (result.request && result.request.profileId!==profileId))throw Error('保存結果を確認できませんでした。同じ内容で再試行してください。');
   saved=true;Object.keys(state).forEach(key=>delete state[key]);reason.value='';confirmed=null;preview.hidden=true;notice.textContent='審査を保存しました。必要なら状態を再読込してください。';if(result.request)status.textContent=(statuses[result.request.status]??'状態不明')+' · '+result.request.createdAt;
  }catch(error){notice.textContent=String(error?.message??error);}finally{busy=false;root.querySelectorAll('button,textarea').forEach(field=>field.disabled=saved);reload.disabled=false;}
 }
 root.append(label,controls,preview,notice);return root;
}
