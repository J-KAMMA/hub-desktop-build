const PAGE_SIZE = 50;
const publicTrack = id => typeof id === 'string' && /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);
const validId = id => typeof id === 'string' && (/^[A-Za-z0-9_-]{1,128}$/.test(id) || publicTrack(id));
function checkedIds(value) {
  if (!Array.isArray(value) || value.some(id => !validId(id)) || new Set(value).size !== value.length) throw Error('invalid_music_favorites');
  return [...value];
}
const button = (document,label,action) => {const node=document.createElement('button');node.type='button';node.className='head-action';node.textContent=label;node.onclick=action;return node;};
const text = (document,value) => {const node=document.createElement('p');node.className='meta';node.textContent=value;return node;};
const currentRoot = (root,isCurrent) => root.isConnected && !root.closest('[hidden]') && isCurrent();

export function attachMusicFavorite({document,host,workId,invoke,isCurrent=()=>true,onChanged=()=>{},initialFavoriteIds}) {
  if(!validId(workId))throw Error('invalid_music_work_id');
  let ids=initialFavoriteIds===undefined?null:checkedIds(initialFavoriteIds),pending=false,disposed=false,generation=0,failed=false;
  const root=document.createElement('div');root.className='actions';root.setAttribute('aria-label','音楽のお気に入り');host.append(root);
  const current=()=>!disposed&&currentRoot(root,isCurrent),status=text(document,'');status.setAttribute('role','status');
  const toggle=button(document,'',async()=>{
    if(!current()||pending||ids===null)return;
    const expected=!ids.includes(workId),before=ids;
    if(expected&&ids.length>=200){status.textContent='お気に入りの追加は200件までです。保存済みの作品を解除してから追加してください。';return;}
    const turn=++generation;let changed=false;pending=true;status.textContent='保存結果を確認しています…';paint();
    try{
      const data=await invoke('hub_client_action',{action:expected?'favorite_music':'unfavorite_music',target:workId});
      if(turn!==generation||!current())return;
      const next=checkedIds(data?.favoriteIds);if(next.includes(workId)!==expected)throw Error('invalid_music_favorite_state');
      ids=next;changed=true;status.textContent=expected?'お気に入りに保存しました。':'お気に入りを解除しました。';
    }catch{if(turn===generation&&current()){ids=before;status.textContent='お気に入りを更新できませんでした。もう一度操作してください。';}}
    finally{if(turn===generation){pending=false;if(current())paint();}}
    if(changed&&current())onChanged({workId,favoriteIds:[...ids],isFavorite:expected});
  });
  const retry=button(document,'保存状態を再取得',()=>reload());root.append(toggle,status,retry);
  function paint(){const saved=ids?.includes(workId)===true;toggle.textContent=saved?'お気に入り済み・解除':'お気に入り';toggle.setAttribute('aria-pressed',String(saved));toggle.disabled=pending||ids===null;retry.hidden=ids!==null||pending||!failed;retry.disabled=pending;root.setAttribute('aria-busy',String(pending));}
  async function reload(){
    if(!current()||pending)return;
    const turn=++generation;pending=true;failed=false;status.textContent='';paint();
    try{const data=await invoke('hub_client',{name:'music_favorites'});if(turn!==generation||!current())return;ids=checkedIds(data?.favoriteIds);status.textContent='';}
    catch{if(turn===generation&&current()){failed=true;status.textContent='お気に入りを確認できませんでした。Hubへの接続を確認して再取得してください。';}}
    finally{if(turn===generation){pending=false;if(current())paint();}}
  }
  // The host is normally attached right after this call, so wait a microtask before the first read.
  paint();const ready=ids===null?(root.isConnected?reload():Promise.resolve().then(()=>reload())):Promise.resolve();return {ready,reload,destroy:()=>{disposed=true;generation++;root.remove();}};
}

export function renderMusicLibrary({document,host,invoke,onOpen,onPlay,onQueue,isCurrent=()=>true,embedded=false,renderCover}){
  const root=document.createElement('section');root.className=embedded?'':'card';root.setAttribute('aria-label','音楽のお気に入り');host.append(root);
  if(!embedded){const title=document.createElement('h3');title.textContent='音楽のお気に入り';root.append(title);}
  const note=text(document,'Hubの公開曲はここで再生します。再生待ちは最大200曲です。外部作品は詳細から提供元を開きます。');
  const status=text(document,'');status.setAttribute('role','status');const list=document.createElement('div');list.className='result-grid';
  let favoriteIds=[],works=[],unavailable=[],nextOffset=null,total=0,pending=false,failed=false,disposed=false,generation=0,retryOffset=0;
  const current=()=>!disposed&&currentRoot(root,isCurrent);
  const update=button(document,'更新',()=>reload()),retry=button(document,'再試行',()=>load(retryOffset)),more=button(document,'続きを表示',()=>nextOffset!==null?load(nextOffset):undefined);
  root.append(note,update,status,retry,list,more);
  function paint(){
    root.setAttribute('aria-busy',String(pending));update.disabled=retry.disabled=more.disabled=pending;retry.hidden=!failed;more.hidden=failed||nextOffset===null;list.replaceChildren();
    if(!works.length&&!unavailable.length&&!pending&&!failed){const empty=text(document,'お気に入りはまだありません。作品の「お気に入り」から保存できます。');list.append(empty);}
    const byId=new Map(works.map(work=>[work.id,work])),missing=new Set(unavailable);
    for(const id of favoriteIds.filter(id=>byId.has(id)||missing.has(id))){
      const work=byId.get(id),row=document.createElement('div');row.className='card';row.dataset.musicWorkId=id;
      if(work&&typeof renderCover==='function'){try{const cover=renderCover(work);if(cover){const slot=document.createElement('span');slot.className='media-item-cover';slot.dataset.kind='music';slot.append(cover);row.classList.add('media-item-row');row.append(slot);}}catch{}}
      const name=document.createElement('strong');name.textContent=work?.title||id;row.append(name);
      if(work)row.append(text(document,[work.artist,work.album,publicTrack(id)?'Hub Music':(work.services?.some(service=>service?.provider==='youtube')?'YouTube Music':'外部作品')].filter(Boolean).join(' · ')));
      else row.append(text(document,'現在、この作品の公開情報を取得できません。非公開化・削除などで利用できない場合があります。'));
      const actions=document.createElement('div');actions.className='actions';
      if(work){
        const action=button(document,publicTrack(id)?'再生':'詳細・提供元を開く',async()=>{
          if(!current()||pending||!list.contains(row))return;
          try{if(publicTrack(id)){if(await onPlay(work,works.filter(item=>publicTrack(item.id)))===false)throw Error('music_play_unconfirmed');}else await onOpen(work);}
          catch{if(current()&&list.contains(row))status.textContent='作品を開けませんでした。もう一度操作してください。';}
        });if(publicTrack(id)&&onQueue){const next=button(document,'次に再生',()=>{if(current()&&!pending&&list.contains(row)&&onQueue(work)===false)status.textContent='再生待ちに追加できませんでした。';});next.disabled=pending;next.setAttribute('aria-label',work.title+'を次に再生');actions.append(next);}
        action.disabled=pending;action.setAttribute('aria-label',`${work.title}を${publicTrack(id)?'再生':'開く'}`);actions.append(action);
      }
      const remove=button(document,'お気に入りを解除',()=>list.contains(row)?removeFavorite(id):undefined);remove.disabled=pending;remove.setAttribute('aria-label',`${work?.title||id}のお気に入りを解除`);actions.append(remove);row.append(actions);list.append(row);
    }
  }
  async function removeFavorite(id){
    if(!current()||pending||!favoriteIds.includes(id))return;
    const turn=++generation;pending=true;status.textContent='解除結果を確認しています…';paint();let done=false;
    try{
      const data=await invoke('hub_client_action',{action:'unfavorite_music',target:id});if(turn!==generation||!current())return;
      const next=checkedIds(data?.favoriteIds);if(next.includes(id))throw Error('invalid_music_favorite_state');
      favoriteIds=next;works=works.filter(item=>next.includes(item.id));unavailable=unavailable.filter(value=>next.includes(value));total=next.length;nextOffset=null;done=true;status.textContent='お気に入りを解除しました。';
    }catch{if(turn===generation&&current())status.textContent='お気に入りを解除できませんでした。表示中の項目を保持しています。';}
    finally{if(turn===generation){pending=false;if(current())paint();}}
    if(done&&current())await reload();
  }
  async function load(offset=0){
    if(!current()||pending)return;
    if(!Number.isSafeInteger(offset)||offset<0||offset>favoriteIds.length||offset%PAGE_SIZE!==0)throw Error('invalid_music_library_offset');
    const turn=++generation;pending=true;failed=false;retryOffset=offset;status.textContent='お気に入りの作品を読み込んでいます…';paint();
    try{
      const data=await(offset===0?invoke('hub_client',{name:'music_library'}):invoke('hub_detail',{name:'music_library_page',ids:[String(offset)]}));if(turn!==generation||!current())return;
      const ids=checkedIds(data?.favoriteIds),page=data?.works,missing=checkedIds(data?.unavailableIds);
      if(offset&&JSON.stringify(ids)!==JSON.stringify(favoriteIds)){retryOffset=0;throw Error('music_library_changed');}
      const end=Math.min(offset+PAGE_SIZE,ids.length),expectedNext=end<ids.length?end:null,wanted=ids.slice(offset,end);
      if(data?.total!==ids.length||!Number.isSafeInteger(data.total)||data.nextOffset!==expectedNext||offset>ids.length||!Array.isArray(page)||page.length>PAGE_SIZE||page.some(work=>!work||!validId(work.id)||typeof work.title!=='string'||typeof work.artist!=='string'||!Array.isArray(work.services)))throw Error('invalid_music_library');
      const received=[...page.map(work=>work.id),...missing];if(new Set(received).size!==received.length||received.length!==wanted.length||received.some(id=>!wanted.includes(id)))throw Error('invalid_music_library');
      favoriteIds=ids;works=offset?[...works,...page]:page;unavailable=offset?[...unavailable,...missing]:missing;total=data.total;nextOffset=data.nextOffset;
      status.textContent=`${works.length+unavailable.length} / ${total} 件を取得${unavailable.length?`（公開情報を取得できない作品 ${unavailable.length} 件）`:''}`;
    }catch(error){if(turn===generation&&current()){failed=true;status.textContent=String(error).includes('music_library_changed')?'お気に入りが変更されました。再試行すると先頭から取得します。':'お気に入りの作品を読み込めませんでした。表示中の項目を保持しています。';}}
    finally{if(turn===generation){pending=false;if(current())paint();}}
  }
  function reload(){return load(0);}
  paint();const ready=reload();return {ready,reload,destroy:()=>{disposed=true;generation++;root.remove();}};
}
