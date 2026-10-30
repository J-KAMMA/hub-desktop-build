const checkedKind = kind => { if (!['article', 'video'].includes(kind)) throw Error('invalid_content_kind'); return kind; };
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const validCursor = (kind, cursor) => {
  if(kind==='article')return validId(cursor);
  if(typeof cursor!=='string'||cursor.length>153)return false;
  const match=cursor.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([A-Za-z0-9_-]{1,128})$/);
  return Boolean(match&&Number.isFinite(Date.parse(match[1]))&&new Date(match[1]).toISOString()===match[1]);
};
const button = (document, label, action) => {const node=document.createElement('button');node.type='button';node.className='head-action';node.textContent=label;node.onclick=action;return node;};
const message = document => {const node=document.createElement('p');node.className='meta';node.setAttribute('role','status');return node;};
const live = (root, isCurrent) => root.isConnected && !root.closest('[hidden]') && isCurrent();

export function attachContentSave({document, host, kind, id, invoke, isCurrent = () => true, onChanged = () => {}, initialSaved}) {
  checkedKind(kind); if (!validId(id)) throw Error('invalid_content_id');
  const root=document.createElement('div');root.className='actions';root.setAttribute('aria-label',kind==='article'?'記事の保存':'動画の保存');host.append(root);
  let saved=typeof initialSaved==='boolean'?initialSaved:null, pending=false, generation=0, disposed=false, failed=false;
  const current=()=>!disposed&&live(root,isCurrent), status=message(document);
  const save=button(document,'',async()=>{
    if (!current()||pending||saved===null) return;
    const before=saved, expected=!before, turn=++generation;let changed=false;pending=true;status.textContent='保存結果を確認しています…';paint();
    try {
      const data=await invoke('hub_client_action',{action:`${expected?'save':'unsave'}_${kind}`,target:id});
      if (turn!==generation||!current()) return;
      if (typeof data?.saved!=='boolean'||data.saved!==expected) throw Error('invalid_saved_state');
      saved=data.saved;status.textContent=saved?(kind==='article'?'記事を保存しました。':'あとで見るに保存しました。'):'保存を解除しました。';
      changed=true;
    } catch {if(turn===generation&&current()){saved=before;status.textContent='保存状態を更新できませんでした。もう一度操作してください。';}}
    finally {if(turn===generation){pending=false;if(current())paint();}}
    if(changed&&current())onChanged({kind,id,saved});
  });
  const retry=button(document,'保存状態を再取得',()=>reload());root.append(save,status,retry);
  function paint(){save.textContent=saved===true?'保存済み・解除':kind==='article'?'記事を保存':'あとで見る';save.disabled=pending||saved===null;save.setAttribute('aria-pressed',String(saved===true));retry.hidden=saved!==null||pending||!failed;retry.disabled=pending;root.setAttribute('aria-busy',String(pending));}
  async function reload(){
    if(!current()||pending)return;
    const turn=++generation;pending=true;failed=false;status.textContent='';paint();
    try {
      const data=await invoke('hub_detail',{name:`${kind}_save`,ids:[id]});
      if(turn!==generation||!current())return;
      if(typeof data?.saved!=='boolean')throw Error('invalid_saved_state');
      saved=data.saved;status.textContent='';
    }catch{if(turn===generation&&current()){failed=true;status.textContent='保存状態を確認できませんでした。Hubへの接続を確認して再取得してください。';}}
    finally{if(turn===generation){pending=false;if(current())paint();}}
  }
  paint();const ready=saved===null?(root.isConnected?reload():Promise.resolve().then(()=>reload())):Promise.resolve();return {ready,reload,destroy:()=>{disposed=true;generation++;root.remove();}};
}

export function renderContentLibrary({document,host,kind,invoke,isCurrent=()=>true,onOpen,embedded=false,renderCover}){
  checkedKind(kind);
  const root=document.createElement('section');root.className=embedded?'':'card';root.setAttribute('aria-label',kind==='article'?'保存した記事':'あとで見る');host.append(root);
  if(!embedded){const heading=document.createElement('h3');heading.textContent=kind==='article'?'保存した記事':'あとで見る';root.append(heading);}
  const status=message(document), list=document.createElement('div');list.className='result-grid';
  let items=[],cursor=null,pending=false,generation=0,disposed=false,failed=false,retryCursor=null;
  const current=()=>!disposed&&live(root,isCurrent);
  const update=button(document,'更新',()=>reload());
  const retry=button(document,'再試行',()=>load(retryCursor));
  const more=button(document,'続きを表示',()=>cursor!==null?load(cursor):undefined);root.append(update,status,retry,list,more);
  function paint(){
    root.setAttribute('aria-busy',String(pending));update.disabled=retry.disabled=more.disabled=pending;retry.hidden=!failed;more.hidden=cursor===null||failed;
    list.replaceChildren();
    if(!items.length&&!pending&&!failed){const empty=message(document);empty.textContent=kind==='article'?'保存した記事はまだありません。':'あとで見るに保存した動画はありません。';list.append(empty);}
    for(const item of items){
      const row=document.createElement('div');row.className='card';row.dataset.contentId=item.id;
      if(typeof renderCover==='function'){try{const cover=renderCover(item);if(cover){const slot=document.createElement('span');slot.className='media-item-cover';slot.dataset.kind=kind;slot.append(cover);row.classList.add('media-item-row');row.append(slot);}}catch{}}
      const open=button(document,'',()=>{if(current()&&list.contains(row))return onOpen(item);});open.setAttribute('aria-label',`${item.title}を開く`);
      const title=document.createElement('strong');title.textContent=item.title;open.append(title);
      const summary=message(document);summary.textContent=kind==='article'?item.summary||'':[item.channel,item.provider,item.availabilityStatus==='unavailable'?'提供元で視聴できません':''].filter(Boolean).join(' · ');row.append(open,summary);
      list.append(row);
    }
  }
  async function load(after=null){
    if(!current()||pending)return;
    const turn=++generation;pending=true;failed=false;retryCursor=after;status.textContent='保存した項目を読み込んでいます…';paint();
    try {
      const data=await (after!==null?invoke('hub_detail',{name:kind==='article'?'saved_articles_page':'video_library_page',ids:[after]}):invoke('hub_client',{name:kind==='article'?'saved_articles':'video_library'}));
      if(turn!==generation||!current())return;
      const entries=kind==='article'?data?.articles:data?.savedVideos, next=data?.nextCursor;
      if(!Array.isArray(entries)||entries.length>100||entries.some(item=>!item||!validId(item.id)||typeof item.title!=='string')||!(next===null||validCursor(kind,next)&&next!==after)||next!==null&&!entries.length)throw Error('invalid_content_library');
      items=after===null?entries:[...new Map([...items,...entries].map(item=>[item.id,item])).values()];cursor=next;status.textContent=`${items.length} 件を表示`;
    }catch{if(turn===generation&&current()){failed=true;status.textContent='保存した項目を読み込めませんでした。表示中の項目を保持しています。';}}
    finally{if(turn===generation){pending=false;if(current())paint();}}
  }
  function reload(){return load(null);}
  paint();const ready=reload();return {ready,reload,destroy:()=>{disposed=true;generation++;root.remove();}};
}
