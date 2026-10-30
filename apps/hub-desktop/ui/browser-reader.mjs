const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const token=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[^\x21-\x7e]/.test(value);
const text=value=>typeof value==='string'&&!/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

export function initBrowserReader({document,host,invoke,getContext,refresh,beforeOpen,report,onStateChange=()=>{},canOpen=()=>true}){
  let revision=0,attempt=null,session=null,disposed=false;
  const closing=new Map();
  let searchable=[],matches=[],searchQuery='',searchIndex=-1,searchMark=null;
  function clearFind(){
    if(searchMark){const parent=searchMark.parentNode;if(parent){searchMark.replaceWith(...searchMark.childNodes);parent.normalize();}searchMark=null;}
    matches=[];searchQuery='';searchIndex=-1;
  }
  const contextCurrent=source=>{const now=getContext();return !disposed&&now&&now.id===source.id&&now.url===source.url&&now.epoch===source.epoch;};
  const current=entry=>entry.revision===revision&&contextCurrent(entry.source);
  const hide=()=>{clearFind();searchable=[];host.hidden=true;try{host.replaceChildren();}catch{/* Keep cleanup independent of DOM failures. */}};
  const changed=()=>onStateChange();
  async function cleanup(contextToken){
    if(closing.has(contextToken))return closing.get(contextToken);
    const promise=(async()=>{const value=await invoke('browser_reader_close',{contextToken});if(!exact(value,['closed'])||value.closed!==true)throw Error('browser_reader_close_unknown');return true;})();
    closing.set(contextToken,promise);changed();
    try{return await promise;}finally{closing.delete(contextToken);changed();}
  }
  async function close(){
    ++revision;hide();const target=session??attempt;changed();
    if(!target?.openAttempted)return true;
    try{await cleanup(target.token);if(session===target)session=null;return true;}
    catch{const now=getContext();if(!disposed&&session===target&&now?.id===target.source.id&&now?.url===target.source.url){
      report(Error('browser_reader_close_unknown'));
      try{const retry=document.createElement('button');retry.type='button';retry.className='browser-menu-tab';retry.textContent='元のページへ';retry.onclick=()=>void close();const note=document.createElement('p');note.textContent='元のページへの復帰を確認できません。もう一度閉じてください。';host.replaceChildren(retry,note);host.hidden=false;}catch{}
    }else if(session===target)session=null;return false;}
    finally{changed();}
  }
  function checked(value,source){
    if(!exact(value,['id','url','title','paragraphs','truncated','contextToken'])||value.id!==source.id||value.url!==source.url
      ||!text(value.title)||value.title.length>600||Array.from(value.title).length>300||!token(value.contextToken)||typeof value.truncated!=='boolean'
      ||!Array.isArray(value.paragraphs)||value.paragraphs.length<1||value.paragraphs.length>1000)throw Error('browser_reader_invalid');
    let size=0;for(const paragraph of value.paragraphs){if(!text(paragraph)||paragraph.length>200000)throw Error('browser_reader_invalid');size+=Array.from(paragraph).length;if(size>100000)throw Error('browser_reader_invalid');}
    if(!value.paragraphs.some(paragraph=>paragraph.trim())||new TextEncoder().encode(JSON.stringify(value)).byteLength>524288)throw Error('browser_reader_invalid');
    return {...value,paragraphs:[...value.paragraphs]};
  }
  function render(value){
    clearFind();searchable=[];
    const heading=document.createElement('header');heading.className='browser-reader-head';
    const title=document.createElement('h2');title.textContent=value.title||'読みやすく表示';
    searchable.push(title);
    const back=document.createElement('button');back.type='button';back.className='browser-menu-tab';back.textContent='元のページへ';back.onclick=()=>void close();heading.append(title,back);
    const article=document.createElement('article');article.className='browser-reader-body';article.setAttribute('aria-label','ページ本文');
    for(const paragraph of value.paragraphs){const node=document.createElement('p');node.textContent=paragraph;article.append(node);searchable.push(node);}
    if(value.truncated){const note=document.createElement('p');note.className='browser-menu-empty';note.textContent='本文が長いため、一部を省略しています。';article.append(note);}
    host.replaceChildren(heading,article);return back;
  }
  function find(query,backwards=false){
    if(!text(query)||query.length>200||/\p{Cc}/u.test(query)){clearFind();throw Error('invalid_find_query');}
    if(!session||!current(session)||host.hidden||closing.size||attempt?.revision===revision){clearFind();return {found:false,current:0,total:0};}
    if(!query){clearFind();return {found:false,current:0,total:0};}
    if(query!==searchQuery){
      clearFind();searchQuery=query;
      const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(escaped,'giu');
      for(const node of searchable){for(const match of node.textContent.matchAll(pattern))matches.push({node,start:match.index,end:match.index+match[0].length});}
      searchIndex=backwards?matches.length: -1;
    }
    if(!matches.length)return {found:false,current:0,total:0};
    if(searchMark){const parent=searchMark.parentNode;searchMark.replaceWith(...searchMark.childNodes);parent.normalize();searchMark=null;}
    searchIndex=(searchIndex+(backwards?-1:1)+matches.length)%matches.length;
    const match=matches[searchIndex],range=document.createRange();range.setStart(match.node.firstChild,match.start);range.setEnd(match.node.firstChild,match.end);
    const mark=document.createElement('mark');mark.dataset.browserReaderMatch='current';mark.style.background='var(--interactive)';mark.style.color='inherit';mark.style.outline='2px solid var(--focus-ring)';
    range.surroundContents(mark);searchMark=mark;mark.scrollIntoView?.({block:'center',inline:'nearest'});
    return {found:true,current:searchIndex+1,total:matches.length};
  }
  async function open(){
    if(disposed||attempt?.revision===revision||session||closing.size||!canOpen())return;
    const source=getContext();if(!source||!Number.isSafeInteger(source.id)||source.id<=0||!text(source.url)||!source.url)return;
    const entry={source:{...source},revision:++revision,token:null,openAttempted:false};attempt=entry;changed();
    try{
      const raw=await invoke('browser_reader_read',{id:source.id,url:source.url});if(!current(entry))return;
      const value=checked(raw,source);entry.token=value.contextToken;
      await refresh();if(!current(entry))return;
      const back=render(value);beforeOpen();if(!current(entry))return;
      entry.openAttempted=true;session=entry;
      const ack=await invoke('browser_reader_open',{id:source.id,url:source.url,contextToken:entry.token});
      if(!current(entry)){await cleanup(entry.token);if(session===entry)session=null;return;}
      if(!exact(ack,['id','opened','contextToken'])||ack.id!==source.id||ack.opened!==true||ack.contextToken!==entry.token)throw Error('browser_reader_open_unknown');
      host.hidden=false;back.focus();
    }catch(reason){
      const relevant=current(entry);hide();if(entry.openAttempted)await close();
      if(relevant)report(Error('browser_reader_unavailable'));
    }finally{if(attempt===entry)attempt=null;changed();}
  }
  function update(){const target=session??(attempt?.revision===revision?attempt:null);if(target&&!contextCurrent(target.source))void close();}
  function handleClosed(payload){
    if(!exact(payload,['contextToken'])||!token(payload.contextToken))return;
    const target=session??attempt;if(target?.token!==payload.contextToken)return;
    ++revision;session=null;hide();changed();
  }
  return {open,close,invalidate:close,update,handleClosed,find,clearFind,
    get searchReady(){return Boolean(session&&current(session)&&!host.hidden&&!closing.size&&attempt?.revision!==revision);},
    get busy(){return Boolean(attempt?.revision===revision||closing.size);},get active(){return Boolean(session);},
    dispose(){disposed=true;return close();}};
}
