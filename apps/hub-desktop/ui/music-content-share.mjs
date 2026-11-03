import {contentShareReference} from './content-share-contract.mjs';
const pending=new Set();
/**
 * 「投稿で紹介」：公開状態を Hub に確かめてから、既存の紹介の下書き（onShare）へ渡す。⋯ メニューから呼ぶ。
 * 戻り値は紹介を開けたかどうか。状態の文言は onStatus へ。同じ作品の確認が走っている間の二重実行は false。
 */
export async function shareMusicWork({workId,title},{invoke,isCurrent,onShare,getViewer,onStatus=()=>{}}) {
  if(typeof workId!=='string'||typeof title!=='string'||title.length>480)return false;
  const selected=contentShareReference(`/v2/music/works/${encodeURIComponent(workId)}`);
  if(!selected||selected.kind!=='music'||pending.has(workId))return false;
  const current=()=>isCurrent?.()!==false;
  pending.add(workId);
  try {
    onStatus('公開状態を確認しています…');
    const viewer=await getViewer();if(!current()||typeof viewer!=='string'||!viewer)return false;
    const context=await invoke('hub_detail',{name:'music_share_context',ids:[workId]});
    if(!current())return false;
    if(!context||Reflect.ownKeys(context).length!==3||context.viewerId!==viewer||context.publicAvailable!==true
      ||!context.reference||Reflect.ownKeys(context.reference).length!==2||context.reference.kind!=='music'||context.reference.href!==selected.href)throw Error('unavailable');
    const offered=await onShare({href:selected.href,title,isCurrent:current});
    if(current())onStatus(offered?'':'紹介先を開けません。もう一度試してください。');return offered;
  }catch{if(current())onStatus('作品の公開状態を確認できません。開き直してください。');return false;}
  finally{pending.delete(workId);}
}
