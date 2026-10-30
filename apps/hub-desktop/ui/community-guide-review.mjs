const node=(document,tag,text='',className='')=>{const item=document.createElement(tag);item.textContent=text;item.className=className;return item;};
const labels={comment:'コメント',approve:'承認',request_changes:'修正依頼',merge:'統合して公開',close:'編集案を終了',reopen:'編集案を再開'};
export function communityGuideReview(document,{communityId,proposalId,data,state={},invoke,onUpdated,onOpen}){
 const root=node(document,'section','','detail-form community-guide-detail'),comparison=node(document,'details','','card detail-form'),reviews=node(document,'section','','detail-form'),controls=node(document,'div','','detail-form-row'),confirmation=node(document,'section','','card detail-form'),notice=node(document,'p','','meta'),field=node(document,'textarea');
 field.rows=3;field.maxLength=2000;field.placeholder='確認した内容や変更の理由を書く';field.setAttribute('aria-label','レビュー本文');field.value=state.reviewBody??'';
 notice.setAttribute('role','status');confirmation.hidden=true;let busy=false,pending=null,current=data;
 field.oninput=()=>{state.reviewBody=field.value;pending=null;confirmation.hidden=true;};
 const button=(label,click)=>{const item=node(document,'button',label,'head-action');item.type='button';item.onclick=click;return item;};
 const reload=button('状態を再読込',()=>void refresh());
 root.append(comparison,node(document,'h4','レビュー'),reviews,field,controls,confirmation,reload,notice);
 function lock(value){busy=value;root.querySelectorAll('button,textarea').forEach(item=>item.disabled=value);}
 function render(){
  const p=current.permissions??{};field.hidden=!p.canComment;controls.replaceChildren();
  for(const [action,permission] of [['comment','canComment'],['approve','canApprove'],['request_changes','canRequestChanges'],['merge','canMerge'],['close','canClose'],['reopen','canReopen']])if(p[permission])controls.append(button(labels[action],()=>confirm(action)));
  if(current.mergeReason&&p.canClose)controls.append(node(document,'p',current.mergeReason,'meta'));
  comparison.replaceChildren(node(document,'summary','公開版と編集案を比較'),node(document,'h4',current.currentPage?.title??'新しいガイド'),node(document,'p',current.currentPage?.body??'まだ公開されていません。','community-guide-body'),node(document,'h4',current.proposal?.proposedTitle??''),node(document,'p',current.proposal?.proposedBody??'','community-guide-body'));
  if(current.proposal?.pageId&&onOpen)comparison.append(button('公開版を開く',()=>onOpen('community_guide',[communityId,current.proposal.pageId],'公開版')));
  renderReviews();
 }
 function renderReviews(){
  const items=(current.reviews??[]).map(review=>{const card=node(document,'article','','card detail-form');card.append(node(document,'strong',(review.authorName??'退会したユーザー')+' · '+(labels[review.decision]??'状態不明')),node(document,'p',review.body,'community-guide-body'),node(document,'p',review.createdAt??'','meta'));return card;});
  const page=current.reviewPage??{offset:0,hasMore:false},navigation=node(document,'nav','','detail-form-row');navigation.setAttribute('aria-label','レビューのページ');
  const previous=button('前の20件',()=>void load(Math.max(0,page.offset-20))),next=button('次の20件',()=>void load(page.nextOffset));previous.disabled=page.offset===0;next.disabled=!page.hasMore;navigation.append(previous,next);
  reviews.replaceChildren(...(items.length?items:[node(document,'p','レビューはまだありません。','meta')]),navigation);
 }
 async function load(offset){
  if(busy)return;lock(true);
  try{const next=await invoke('hub_detail',{name:'community_guide_reviews_page',ids:[communityId,proposalId,String(offset)]});
   if(!Array.isArray(next.reviews)||next.reviewPage?.offset!==offset)throw Error('レビューのページを確認できませんでした。');
   current={...current,...next};state.reviewOffset=offset;render();notice.textContent='';
  }catch(error){notice.textContent=String(error?.message??error);}finally{lock(false);renderReviews();}
 }
 function confirm(action){
  if(busy)return;const review=['comment','approve','request_changes'].includes(action),body=field.value.trim();
  if(review&&(!body||body.length>2000)){notice.textContent='レビューを1〜2000文字で入力してください。';return;}
  pending={action,body:review?body:'',expectedUpdatedAt:current.proposal?.updatedAt};
  confirmation.replaceChildren(node(document,'h4',labels[action]),node(document,'p',review?body:action==='merge'?'確認した編集案を公開版へ統合します。新しい版と改訂履歴が保存されます。':'この編集案の状態を変更します。','community-guide-body'),button('確認して実行',()=>void save()),button('取り消す',()=>{pending=null;confirmation.hidden=true;}));confirmation.hidden=false;
 }
 async function refresh(){
  if(busy)return;lock(true);
  try{const next=await invoke('hub_detail',{name:'community_guide_proposal',ids:[communityId,proposalId]});
   if(next.proposal?.id!==proposalId||next.proposal.communityId!==communityId)throw Error('最新の編集案を確認できませんでした。');
   current=next;state.reviewOffset=0;pending=null;confirmation.hidden=true;render();onUpdated?.(next);notice.textContent='最新の状態を読み込みました。';
  }catch(error){notice.textContent=String(error?.message??error);}finally{lock(false);renderReviews();}
 }
 async function save(){
  if(busy||!pending)return;lock(true);const operation=pending,key=JSON.stringify(operation);
  if(state.reviewRequest?.key!==key)state.reviewRequest={key,id:crypto.randomUUID()};const id=state.reviewRequest.id,review=['comment','approve','request_changes'].includes(operation.action);
  try{const result=await invoke('hub_action',{action:review?'community_guide_review':'community_guide_update',target:communityId,text:operation.body,requestId:id,options:{proposalId,expectedUpdatedAt:operation.expectedUpdatedAt,...(review?{decision:operation.action}:{action:operation.action})}});
   if(result.operationId!==id||result.proposal?.id!==proposalId||result.proposal.communityId!==communityId||review&&result.review?.id!==id)throw Error('保存結果を確認できませんでした。同じ内容で再試行してください。');
   delete state.reviewRequest;if(review){state.reviewBody='';field.value='';}pending=null;confirmation.hidden=true;
   current={...current,proposal:{...current.proposal,...result.proposal},permissions:{}};render();onUpdated?.(current);notice.textContent='保存しました。最新の状態を確認しています。';
   try{const next=await invoke('hub_detail',{name:'community_guide_proposal',ids:[communityId,proposalId]});
    if(next.proposal?.id!==proposalId||next.proposal.communityId!==communityId)throw Error('最新の状態が不明です。');current=next;state.reviewOffset=0;render();onUpdated?.(next);notice.textContent='保存しました。';
   }catch{notice.textContent='保存済みです。最新の状態を取得できないため「状態を再読込」で確認してください。';}
  }catch(error){notice.textContent=String(error?.message??error);}finally{lock(false);renderReviews();}
 }
 render();if(state.reviewOffset>0)void load(state.reviewOffset);return root;
}
