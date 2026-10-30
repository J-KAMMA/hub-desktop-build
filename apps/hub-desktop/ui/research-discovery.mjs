import {contentShareReference} from './content-share-contract.mjs';
const names=Object.freeze({article:'research_backlinks_article',video:'research_backlinks_video',music:'research_backlinks_music',hubpedia:'research_backlinks_hubpedia',thread:'research_backlinks_thread',community:'research_backlinks_community'});
const FEED_UPDATES_COLLAPSED_KEY='hub.desktop.feedUpdatesCollapsed',FEED_UPDATES_PREVIEW=5;
const labels={article:'記事',video:'動画',music:'音楽',hubpedia:'資料・知識',thread:'スレッド',community:'コミュニティ'};
const cleanText=value=>typeof value==='string'&&!/[\u0000-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const safeId=value=>cleanText(value)&&value.length>0&&value.length<=240&&value.trim()===value&&value!=='.'&&value!=='..'&&!/[\s/\\?#%:]/u.test(value);
const invalid=()=>{throw Error('関連プロジェクトの内容を確認できませんでした。');};
function projects(value){
  if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==1||!Array.isArray(value.projects)||value.projects.length>20)invalid();
  const seen=new Set();return value.projects.map(project=>{
    if(!project||typeof project!=='object'||Array.isArray(project)||!Object.keys(project).every(key=>['id','title','href'].includes(key))||typeof project.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(project.id)||!cleanText(project.title)||!project.title.trim()||project.title.length>240||seen.has(project.id)||Object.hasOwn(project,'href')&&project.href!==`/v2/research/${project.id}`)invalid();
    seen.add(project.id);return {id:project.id,title:project.title};
  });
}
export function appendResearchUpdates(target,updates,{isCurrent=()=>true,openLink}={}){
  if(!target.isConnected||!isCurrent()||Array.isArray(updates)&&!updates.length)return null;
  const document=target.ownerDocument,root=document.createElement('section');root.className='research-feed-updates';
  const node=(tag,text)=>{const value=document.createElement(tag);value.textContent=text;return value;};root.append(node('h3','作品・研究の更新'));
  try{
    if(!Array.isArray(updates)||updates.length>20)invalid();const seen=new Set();
    const found=updates.map(item=>{
      if(!item||typeof item!=='object'||Array.isArray(item)||!['research','article','video','music'].includes(item.kind)||typeof item.id!=='string'||!(item.kind==='music'?contentShareReference(`/v2/music/works/${encodeURIComponent(item.id)}`):/^[A-Za-z0-9_-]{1,128}$/.test(item.id))||!cleanText(item.title)||!item.title.trim()||item.title.length>240||!cleanText(item.updatedAt)||!item.updatedAt.trim()||item.updatedAt.length>64||!Number.isFinite(Date.parse(item.updatedAt)))invalid();
      let href,key=`${item.kind}:${item.id}`;
      if(item.kind==='research'){
        if(typeof item.projectId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(item.projectId)||!cleanText(item.projectTitle)||!item.projectTitle.trim()||item.projectTitle.length>240||!Number.isSafeInteger(item.version)||item.version<1)invalid();
        const legacy=`/v2/research/${item.projectId}?document=${item.id}`;href=`${legacy}&version=${item.version}`;key+=`:${item.projectId}`;
        if(item.href!==href&&item.href!==legacy)invalid();
      }else{
        href=item.kind==='music'?`/v2/music/works/${encodeURIComponent(item.id)}`:`/v2/${item.kind==='article'?'articles':'videos'}/${item.id}`;if(item.href!==href&&!(item.kind==='music'&&item.href===`/v2/music?q=${encodeURIComponent(item.title)}`))invalid();
      }
      if(seen.has(key))invalid();seen.add(key);
      return {href,title:item.title,kind:{research:'研究',article:'記事',video:'動画',music:'音楽作品'}[item.kind],text:item.kind==='research'?`${item.title} · v${item.version} — ${item.projectTitle}`:item.title};
    });
    const list=document.createElement('div');list.className='feed-updates-list';root.append(list);
    const rows=[];
    for(const item of found){const button=document.createElement('button');button.type='button';button.className='feed-update-row';button.setAttribute('aria-label',`${item.kind} · ${item.text}`);const tag=node('span',item.kind);tag.className='feed-update-kind';const title=node('span',item.text);title.className='feed-update-title';title.title=item.text;button.append(tag,title);const current=()=>{try{return button.isConnected&&root.isConnected&&root.contains(button)&&root.parentNode===target&&target.isConnected&&isCurrent()===true;}catch{return false;}};button.onclick=()=>{if(current())return openLink?.(item.href,item.title,current);};rows.push(button);list.append(button);}
    // Compact view: show at most FEED_UPDATES_PREVIEW rows, expandable; whole block collapsible per device.
    let expanded=false,collapsed=false;
    try{collapsed=document.defaultView?.localStorage?.getItem(FEED_UPDATES_COLLAPSED_KEY)==='1';}catch{}
    const more=found.length>FEED_UPDATES_PREVIEW?document.createElement('button'):null;
    const fold=document.createElement('button');fold.type='button';fold.className='feed-updates-fold';
    if(more){more.type='button';more.className='feed-updates-more';root.append(more);}
    root.append(fold);
    const sync=()=>{
      rows.forEach((row,index)=>{row.hidden=!expanded&&index>=FEED_UPDATES_PREVIEW;});
      list.hidden=collapsed;root.classList.toggle('is-collapsed',collapsed);
      if(more){more.hidden=collapsed;more.textContent=expanded?'閉じる':`すべて見る（${found.length}件）`;more.setAttribute('aria-expanded',String(expanded));}
      fold.textContent=collapsed?'表示する':'折りたたむ';fold.setAttribute('aria-expanded',String(!collapsed));
      fold.setAttribute('aria-label',collapsed?'作品・研究の更新を表示する':'作品・研究の更新を折りたたむ');
    };
    if(more)more.onclick=()=>{expanded=!expanded;sync();};
    fold.onclick=()=>{collapsed=!collapsed;try{document.defaultView?.localStorage?.setItem(FEED_UPDATES_COLLAPSED_KEY,collapsed?'1':'0');}catch{}sync();};
    sync();
  }catch{const note=node('p','作品・研究の更新を確認できませんでした。');note.className='meta';note.setAttribute('role','status');root.append(note);}
  if(!isCurrent()||!target.isConnected)return null;target.prepend(root);return root;
}
export function appendResearchBacklinks(target,{kind,id,invoke,isCurrent=()=>true,openProject}={}){
  const document=target.ownerDocument,root=document.createElement('section');root.className='research-related-projects';target.append(root);
  let active=true,generation=0,timer,cancelRead;
  const live=token=>active&&token===generation&&root.isConnected&&root.parentNode===target&&isCurrent();
  const node=(tag,text,cls='')=>{const value=document.createElement(tag);value.textContent=text;value.className=cls;return value;};
  const heading=()=>root.replaceChildren(node('h3',`${labels[kind]??'資料'}に関連するプロジェクト`),node('p','関連プロジェクトで資料・コード・版履歴・変更提案を確認できます。','meta'));
  async function retry(){
    const token=++generation;cancelRead?.();clearTimeout(timer);if(!live(token))return;
    root.hidden=false;heading();const status=node('p','関連プロジェクトを確認しています…','meta');status.setAttribute('role','status');root.append(status);root.setAttribute('aria-busy','true');
    try{
      if(!Object.hasOwn(names,kind)||!safeId(id)||typeof invoke!=='function')invalid();
      const value=await Promise.race([Promise.resolve().then(()=>{if(!live(token))throw Error('cancelled');return invoke('hub_detail',{name:names[kind],ids:[id]});}),new Promise((_,reject)=>{cancelRead=()=>reject(Error('cancelled'));timer=setTimeout(()=>reject(Error('関連プロジェクトの取得が時間切れになりました。')),15000);})]);
      if(!live(token))return;const found=projects(value);heading();
      if(!found.length){root.hidden=true;return;}
      for(const project of found){const button=node('button',project.title,'ghost');button.type='button';const current=()=>{try{return live(token)===true&&button.isConnected&&root.contains(button)&&target.isConnected;}catch{return false;}};button.onclick=()=>{if(current())return openProject?.({...project},current);};root.append(button);}
    }catch(error){if(!live(token))return;heading();const note=node('p',error?.message==='関連プロジェクトの取得が時間切れになりました。'?error.message:'関連プロジェクトは取得できませんでした。','meta');note.setAttribute('role','status');const button=node('button','再試行','ghost');button.type='button';button.onclick=()=>live(token)&&retry();root.append(note,button);
    }finally{if(token===generation){clearTimeout(timer);cancelRead=undefined;if(live(token))root.setAttribute('aria-busy','false');}}
  }
  function dispose(){if(!active)return;active=false;generation++;cancelRead?.();cancelRead=undefined;clearTimeout(timer);document.defaultView?.removeEventListener('hub-account-changed',dispose);root.replaceChildren();root.remove();}
  document.defaultView?.addEventListener('hub-account-changed',dispose);
  const ready=retry();return {root,ready,retry,dispose,invalidate:dispose};
}
