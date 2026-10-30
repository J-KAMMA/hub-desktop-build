import {guideDirectorySelect,guideDirectoryLabel} from './community-guide-directories.mjs';
const node=(document,tag,text='',className='')=>{const result=document.createElement(tag);result.textContent=text;result.className=className;return result;};
export function communityGuideEditor(document,{communityId,page=null,directories=[],state={},invoke,onSaved}) {
  const form=node(document,'form','','detail-form'),fields={},preview=node(document,'section','','card detail-form'),notice=node(document,'p','','meta');notice.setAttribute('role','status');preview.hidden=true;
  let busy=false,confirmed=null;
  state.baseVersion??=page?.version??0;
  for(const [key,label,limit,initial] of [['proposedTitle','タイトル',120,page?.title??''],['proposedBody','本文',30000,page?.body??''],['summary','変更の説明',500,'']]) {
    const group=node(document,'label',label,'detail-form'),input=node(document,key==='proposedTitle'?'input':'textarea');if(input.tagName==='INPUT')input.type='text';input.maxLength=limit;input.required=true;input.value=state[key]??initial;input.setAttribute('aria-label',label);if(input.tagName==='TEXTAREA')input.rows=key==='proposedBody'?10:3;
    state[key]=input.value;input.oninput=()=>{state[key]=input.value;confirmed=null;preview.hidden=true;};group.append(input);fields[key]=input;form.append(group);
  }
  if(!Object.hasOwn(state,'proposedDirectoryId'))state.proposedDirectoryId=page?.directoryId??null;
  const directory=guideDirectorySelect(document,directories,state.proposedDirectoryId,page?'現在の分類を維持':'未分類'),directoryGroup=node(document,'label','分類','detail-form');
  directory.onchange=()=>{state.proposedDirectoryId=directory.value||null;confirmed=null;preview.hidden=true;};directoryGroup.append(directory);form.append(directoryGroup);
  const check=node(document,'button','提案を確認','head-action');check.type='submit';form.append(check,preview,notice);
  form.onsubmit=event=>{
    event.preventDefault();if(busy)return;
    if(state.proposedDirectoryId && !directories.some(item=>item.id===state.proposedDirectoryId)){notice.textContent='下書きの分類が見つかりません。分類を選び直してください。';return;}
    const values=Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,field.value.trim()]));
    if(Object.entries(fields).some(([key,field])=>!values[key]||values[key].length>field.maxLength)){notice.textContent='タイトル・本文・変更の説明を文字数の範囲内で入力してください。';return;}
    confirmed={...values,title:Array.from(values.summary).slice(0,60).join(''),pageId:page?.id??null,baseVersion:state.baseVersion,proposedDirectoryId:directory.value||null};
    const submit=node(document,'button','この内容で提案','primary');submit.type='button';submit.onclick=()=>void save();
    preview.replaceChildren(node(document,'p','分類: '+(confirmed.proposedDirectoryId?guideDirectoryLabel(directories,confirmed.proposedDirectoryId):page?'現在の分類を維持':'未分類'),'meta'),node(document,'h4',values.proposedTitle),node(document,'p',values.summary,'detail-p'),node(document,'p',values.proposedBody,'community-guide-body'),node(document,'p',page?'元の版: v'+state.baseVersion:'新しいガイドの提案','meta'),submit);preview.hidden=false;notice.textContent='確認してから提案してください。公開版は管理者の統合後に変わります。';
  };
  async function save() {
    if(busy||!confirmed)return;busy=true;form.querySelectorAll('button,input,textarea,select').forEach(field=>field.disabled=true);
    const input=confirmed,key=JSON.stringify(input);if(state.request?.key!==key)state.request={key,id:crypto.randomUUID()};const id=state.request.id;
    let saved;
    try {
      const result=await invoke('hub_action',{action:'community_guide_propose',target:communityId,text:input.proposedBody,requestId:id,options:{title:input.title,proposedTitle:input.proposedTitle,summary:input.summary,pageId:input.pageId,baseVersion:input.baseVersion,proposedDirectoryId:input.proposedDirectoryId}});
      if(result.proposal?.id!==id||result.proposal.communityId!==communityId)throw new Error('保存結果を確認できませんでした。同じ内容で再試行してください。');
      saved=result.proposal;Object.keys(state).forEach(key=>delete state[key]);Object.values(fields).forEach(field=>field.value='');directory.value='';confirmed=null;preview.hidden=true;notice.textContent='編集案を保存しました。';
    } catch(error){notice.textContent=String(error?.message??error);}
    finally{busy=false;form.querySelectorAll('button,input,textarea,select').forEach(field=>field.disabled=false);}
    if(saved)try{await onSaved?.(saved);}catch{notice.textContent='編集案は保存済みです。詳細を開けないため、編集案の一覧から確認してください。';}
  }
  return form;
}
