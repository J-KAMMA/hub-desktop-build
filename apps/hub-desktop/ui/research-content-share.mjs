import {contentShareReference} from './content-share-contract.mjs';

function reference(data) {
  if(data?.canDiscuss!==true||data.document?.visibility!=='public'||!Number.isSafeInteger(data.revision?.version)||data.revision.version<1
    ||typeof data.document.projectId!=='string'||typeof data.document.id!=='string'||typeof data.document.title!=='string'||data.document.title.length>480
    ||typeof data.revision.contentHash!=='string'||!/^sha256:[a-f0-9]{64}$/.test(data.revision.contentHash))return null;
  const href=`/v2/research/${encodeURIComponent(data.document.projectId)}?document=${encodeURIComponent(data.document.id)}&version=${data.revision.version}`;
  return contentShareReference(href);
}
export function attachResearchContentShare(root,data,{invoke,isCurrent,onShare}) {
  const selected=reference(data);
  if(!selected||typeof invoke!=='function'||typeof onShare!=='function')return null;
  const document=root.ownerDocument,button=document.createElement('button'),state=document.createElement('p');
  button.type='button';button.className='head-action';button.textContent='投稿で紹介';state.className='meta';state.setAttribute('role','status');root.append(button,state);
  let disposed=false,busy=false;
  const current=()=>!disposed&&root.isConnected&&button.isConnected&&root.contains(button)&&isCurrent?.()!==false;
  button.onclick=async()=>{
    if(busy||!current())return false;
    busy=true;button.disabled=true;state.textContent='公開状態を確認しています…';
    try {
      const fresh=await invoke('hub_detail',{name:'research_revision',ids:[data.document.projectId,data.document.id,String(data.revision.version)]});
      const checked=reference(fresh);
      if(!current())return false;
      if(!checked||checked.href!==selected.href||fresh.revision.contentHash!==data.revision.contentHash)throw Error('changed');
      const offered=await onShare({href:selected.href,title:`${data.document.title} · v${data.revision.version}`,isCurrent:current});
      if(current())state.textContent=offered?'':'紹介先を開けません。もう一度試してください。';return offered;
    } catch {if(current())state.textContent='この版の公開状態を確認できません。文書を開き直してください。';return false;}
    finally {busy=false;if(!disposed)button.disabled=false;}
  };
  return {dispose(){disposed=true;button.remove();state.remove();},invalidate(){disposed=true;button.disabled=true;state.textContent='文書を開き直してください。';}};
}
