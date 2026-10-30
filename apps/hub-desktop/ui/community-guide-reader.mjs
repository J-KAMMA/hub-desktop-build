import {guideDirectorySelect} from './community-guide-directories.mjs';
import {communityGuideReview} from './community-guide-review.mjs';
import {communityGuideEditor} from './community-guide-editor.mjs';
const node = (document, tag, text = '', className = '') => { const result=document.createElement(tag);result.textContent=text;result.className=className;return result; };
const button = (document,label,action) => { const result=node(document,'button',label,'head-action');result.type='button';result.onclick=action;return result; };
const statuses={open:'レビュー待ち',changes_requested:'修正依頼',merged:'統合済み',closed:'終了'};
export function communityGuideRequest(entry) {
  if(entry.name==='community_guides' && entry.guidePage?.directoryId)return {name:'community_guides_directory_page',ids:[...entry.ids,String(entry.guidePage.offset??0),entry.guidePage.directoryId]};
  if (!['community_guides','community_guide_revisions','community_guide_proposals'].includes(entry.name) || !entry.guidePage?.offset) return {name:entry.name,ids:entry.ids};
  return {name:entry.name+'_page',ids:[...entry.ids,String(entry.guidePage.offset)]};
}
export function communityGuideCatalog(document,{communityId,data,invoke,onOpen,history=false,proposals=false,pageId,state={},draft={}}) {
  const root=node(document,'section','','detail-form community-guide-detail'),list=node(document,'div','','detail-form'),notice=node(document,'p','','meta');notice.setAttribute('role','status');let current=data,busy=false;
  const directory=!history&&!proposals?guideDirectorySelect(document,data.directories??[],data.directoryId,'すべての分類'):null;
  const itemsKey=history?'revisions':proposals?'proposals':'pages',readName=history?'community_guide_revisions_page':proposals?'community_guide_proposals_page':'community_guides_page';
  async function load(offset,directoryId=current.directoryId??null) {
    if(busy)return;busy=true;notice.textContent='読み込み中…';list.querySelectorAll('button').forEach(item=>item.disabled=true);if(directory)directory.disabled=true;
    try {
      const next=await invoke('hub_detail',{name:directoryId&&!history&&!proposals?'community_guides_directory_page':readName,ids:history?[communityId,pageId,String(offset)]:directoryId&&!proposals?[communityId,String(offset),directoryId]:[communityId,String(offset)]});
      if(!Array.isArray(next[itemsKey])||!next.page)throw new Error('一覧を確認できませんでした。');
      if(next.page.offset!==offset)throw new Error('ページを確認できませんでした。');
      if(directory && (next.directoryId??null)!==directoryId)throw new Error('分類を確認できませんでした。');
      current=next;state.offset=offset;if(directory)state.directoryId=directoryId;render();notice.textContent='';
    } catch(error) {notice.textContent=String(error?.message??error);render();}
    finally{busy=false;if(directory){directory.disabled=false;directory.value=current.directoryId??'';}}
  }
  function render() {
    const items=current[itemsKey];if(!Array.isArray(items)||!current.page){list.replaceChildren(node(document,'p','一覧を確認できませんでした。','meta'));return;}
    const cards=items.map(item=>{
      const card=node(document,'article','','card'),name=history?'community_guide_revision':proposals?'community_guide_proposal':'community_guide';
      const open=button(document,history?'v'+item.revisionNo+' '+item.title:item.title,()=>onOpen(name,history?[communityId,pageId,item.id]:[communityId,item.id],item.title));open.classList.add('community-guide-open');
      const meta=history?(item.createdAt??'')+' · '+(item.editorName??'退会したユーザー'):proposals?(statuses[item.status]??'状態不明')+' · '+(item.updatedAt??''):[item.directoryName,'v'+item.version,item.updatedAt].filter(Boolean).join(' · ');
      card.append(open,node(document,'p',meta,'meta'));if(proposals)card.append(node(document,'p',item.summary,'detail-p'));return card;
    });
    const navigation=node(document,'nav','','detail-form-row');navigation.setAttribute('aria-label',history?'ガイドの改訂ページ':proposals?'編集案のページ':'ガイドのページ');
    const previous=button(document,'前の20件',()=>load(Math.max(0,current.page.offset-20))),next=button(document,'次の20件',()=>load(current.page.nextOffset));
    previous.disabled=current.page.offset===0;next.disabled=!current.page.hasMore;navigation.append(previous,next);
    list.replaceChildren(...(cards.length?cards:[node(document,'p',history?'改訂履歴はまだありません。':proposals?'編集案はまだありません。':'ガイドはまだありません。','meta')]),navigation);
  }
  state.offset=current.page?.offset??0;if(directory)state.directoryId=current.directoryId??null;
  root.append(node(document,'h3',history?'改訂履歴':proposals?'編集案':'コミュニティのガイド'));
  if(directory){directory.onchange=()=>void load(0,directory.value||null);const label=node(document,'label','分類','detail-form');label.append(directory);root.append(label);}
  root.append(list,notice);
  if(!history&&!proposals){
    root.append(button(document,'編集案の一覧',()=>onOpen('community_guide_proposals',[communityId],'編集案')));
    if(data.canPropose){const host=node(document,'div');root.append(button(document,'新しいガイドを提案',()=>{if(!Object.hasOwn(draft,'proposedDirectoryId'))draft.proposedDirectoryId=current.directoryId??null;host.replaceChildren(communityGuideEditor(document,{communityId,directories:current.directories??[],state:draft,invoke,onSaved:item=>onOpen('community_guide_proposal',[communityId,item.id],item.title)}));}),host);}
  }
  render();return root;
}
export function communityGuidePage(document,{data,communityId,pageId,onOpen,revision=false,invoke,draft={}}) {
  const root=node(document,'article','','card detail-form community-guide-detail'),page=revision?data.revision:data.page;
  if(!page){root.append(node(document,'p','ガイドを確認できませんでした。','meta'));return root;}
  root.append(node(document,'h3',page.title),node(document,'p',revision?'v'+page.revisionNo+' · '+(page.createdAt??'')+' · '+(page.editorName??'退会したユーザー'):[page.directoryName,'v'+page.version,page.updatedAt].filter(Boolean).join(' · '),'meta'),node(document,'p',page.body,'detail-p community-guide-body'));
  if(!revision){root.append(button(document,'改訂履歴',()=>onOpen('community_guide_revisions',[communityId,pageId],page.title)));
    if(data.canPropose){const host=node(document,'div');root.append(button(document,'編集案を作る',()=>{host.replaceChildren(communityGuideEditor(document,{communityId,page,directories:data.directories??[],state:draft,invoke,onSaved:item=>onOpen('community_guide_proposal',[communityId,item.id],item.title)}));}),host);}}
  return root;
}
export function communityGuideProposal(document,{data,communityId,proposalId,invoke,state={},onOpen}) {
  const root=node(document,'article','','card detail-form community-guide-detail'),proposal=data.proposal;
  if(!proposal){root.append(node(document,'p','編集案を確認できませんでした。','meta'));return root;}
  const status=node(document,'p',(statuses[proposal.status]??'状態不明')+' · 元の版: v'+proposal.baseVersion,'meta');
  root.append(node(document,'h3',proposal.title),status,node(document,'p',proposal.summary,'detail-p'),node(document,'h4',proposal.proposedTitle),node(document,'p',proposal.proposedBody,'community-guide-body'));
  if(invoke)root.append(communityGuideReview(document,{communityId,proposalId,data,state,invoke,onOpen,onUpdated:next=>{status.textContent=(statuses[next.proposal.status]??'状態不明')+' · 元の版: v'+next.proposal.baseVersion;}}));
  return root;
}
