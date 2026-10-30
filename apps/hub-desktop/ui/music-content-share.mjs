import {contentShareReference} from './content-share-contract.mjs';
export function attachMusicContentShare(root,{workId,title},{invoke,isCurrent,onShare,getViewer}) {
  if(typeof workId!=='string'||typeof title!=='string'||title.length>480)return null;
  const selected=contentShareReference(`/v2/music/works/${encodeURIComponent(workId)}`);
  if(!selected||selected.kind!=='music')return null;
  const document=root.ownerDocument,button=document.createElement('button'),state=document.createElement('p');
  button.type='button';button.className='head-action';button.textContent='投稿で紹介';state.className='meta';state.setAttribute('role','status');root.append(button,state);
  let disposed=false,busy=false;
  const current=()=>!disposed&&root.isConnected&&button.isConnected&&root.contains(button)&&isCurrent?.()!==false;
  button.onclick=async()=>{
    if(busy||!current())return false;busy=true;button.disabled=true;state.textContent='公開状態を確認しています…';
    try {
      const viewer=await getViewer();if(!current()||typeof viewer!=='string'||!viewer)return false;
      const context=await invoke('hub_detail',{name:'music_share_context',ids:[workId]});
      if(!current())return false;
      if(!context||Reflect.ownKeys(context).length!==3||context.viewerId!==viewer||context.publicAvailable!==true
        ||!context.reference||Reflect.ownKeys(context.reference).length!==2||context.reference.kind!=='music'||context.reference.href!==selected.href)throw Error('unavailable');
      const offered=await onShare({href:selected.href,title,isCurrent:current});
      if(current())state.textContent=offered?'':'紹介先を開けません。もう一度試してください。';return offered;
    }catch{if(current())state.textContent='作品の公開状態を確認できません。開き直してください。';return false;}
    finally{busy=false;if(!disposed)button.disabled=false;}
  };
  return{dispose(){disposed=true;button.remove();state.remove();},invalidate(){disposed=true;button.disabled=true;}};
}
