import {faviconSlot,validFavicon} from './browser-favicon.mjs';
const preference='hub.browser.bookmarkBar';
const text=(value,max)=>typeof value==='string'&&Array.from(value).length<=max&&!/[\p{Cc}\ud800-\udfff]/u.test(value);
function checked(value){
  if(!Array.isArray(value)||value.length>1000)throw Error('bookmark_bar_invalid');
  return value.map(item=>{
    if(!item||typeof item!=='object'||!text(item.url,4096)||new TextEncoder().encode(item.url).length>4096||!text(item.title??'',300)||!text(item.folder??'',80))throw Error('bookmark_bar_invalid');
    let url;try{url=new URL(item.url);}catch{throw Error('bookmark_bar_invalid');}
    if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)throw Error('bookmark_bar_invalid');
    return{url:url.href,title:item.title||url.hostname,folder:item.folder||'',...validFavicon(item.icon)?{icon:item.icon}:{}};
  });
}

/** Metadata-only bar. All page opening and bookmark editing remain owned by the existing workspace. */
export function createBrowserBookmarkBar({document,window,host,open,manage,isCurrent=()=>true,report=()=>{},storage=window.localStorage}){
  if(!host||host.ownerDocument!==document||typeof open!=='function'||typeof manage!=='function')throw Error('bookmark_bar_invalid_host');
  let visible=false,destroyed=false,initialized=false,generation={},entries=[],groups=[],buttons=[],overflow=[],frame=null,anchor=null;
  const requestFrame=window.requestAnimationFrame?.bind(window)??(callback=>window.setTimeout(callback,0));
  const cancelFrame=window.cancelAnimationFrame?.bind(window)??window.clearTimeout.bind(window);
  // 2026-10-29 所有者指定：既定で表示する。保存した '0' の端末だけ隠す。
  try{const saved=storage?.getItem(preference);visible=saved!=='0';}catch{visible=true;}
  host.classList.add('browser-bookmark-bar');host.setAttribute('aria-label','ブックマークバー');host.hidden=!visible;
  const row=document.createElement('div');row.className='browser-bookmark-row';row.setAttribute('role','toolbar');row.setAttribute('aria-label','ブックマーク');
  const popup=document.createElement('div');popup.className='browser-bookmark-popup';popup.setAttribute('role','menu');popup.hidden=true;
  const more=document.createElement('button');more.type='button';more.className='browser-bookmark-more';more.textContent='»';more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.hidden=true;
  const empty=document.createElement('button');empty.type='button';empty.className='browser-bookmark-empty';empty.textContent='ブックマークを管理';
  host.replaceChildren(row,popup);
  const live=token=>!destroyed&&visible&&host.isConnected&&isCurrent()===true&&token===generation;
  function close(restore=false){const previous=anchor;anchor=null;popup.hidden=true;popup.replaceChildren();for(const button of [...buttons,more])button.setAttribute('aria-expanded','false');if(restore&&previous?.isConnected&&!previous.hidden&&visible&&isCurrent())previous.focus();}
  function action(item,token,event){
    if(!live(token)||event?.altKey||event?.type==='auxclick'&&event.button!==1||event?.button>1)return;
    event?.preventDefault();const separate=event?.button===1||event?.ctrlKey||event?.metaKey||event?.shiftKey;
    close();Promise.resolve().then(()=>{if(live(token))return open({...item},separate?event?.shiftKey?'foreground':'background':'current');}).catch(report);
  }
  function itemButton(item,token,inPopup=false){
    const node=document.createElement('button');node.type='button';node.className='browser-bookmark-item';if(inPopup)node.setAttribute('role','menuitem');
    node.append(faviconSlot(document,{icon:item.icon,url:item.url}),item.title);node.title=item.title+'\n'+item.url;node.dataset.bookmarkUrl=item.url;
    node.onclick=event=>{if(node.isConnected&&!node.closest('[hidden]'))action(item,token,event);};node.onauxclick=node.onclick;
    node.onmousedown=event=>{if(event.button===1)event.preventDefault();};
    node.oncontextmenu=event=>{if(!live(token))return;event.preventDefault();close();manage();};return node;
  }
  function menuItems(list,token){
    return list.map(group=>{
      if(!group.folder)return itemButton(group.items[0],token,true);
      const node=document.createElement('button');node.type='button';node.className='browser-bookmark-folder';node.textContent='▸ '+group.folder;node.title=group.folder;node.setAttribute('role','menuitem');node.onclick=()=>{if(live(token))show(group.items.map(item=>({folder:'',items:[item]})),node,group.folder,token);};return node;
    });
  }
  function show(list,trigger,title,token){
    if(!live(token))return;const opener=popup.contains(trigger)?more:trigger;close();anchor=opener;opener.setAttribute('aria-expanded','true');popup.setAttribute('aria-label',title);
    const heading=document.createElement('span');heading.className='browser-bookmark-popup-title';heading.textContent=title;
    const nodes=menuItems(list,token),edit=document.createElement('button');edit.type='button';edit.className='browser-bookmark-manage';edit.setAttribute('role','menuitem');edit.textContent='ブックマークを管理';edit.onclick=()=>{if(live(token)){close();manage();}};
    popup.append(heading,...nodes,edit);popup.hidden=false;nodes[0]?.focus();
  }
  function reflow(){
    if(destroyed||!visible||!row.clientWidth)return;
    for(const button of buttons)button.hidden=false;more.hidden=false;
    const style=window.getComputedStyle(row),gap=4,width=row.clientWidth-(parseFloat(style.paddingLeft)||0)-(parseFloat(style.paddingRight)||0),moreWidth=more.getBoundingClientRect().width||28;
    const widths=buttons.map(button=>button.getBoundingClientRect().width),total=widths.reduce((sum,value)=>sum+value+gap,0);
    let used=0,count=buttons.length;
    if(total>width){count=0;for(const value of widths){if(used+value+gap+moreWidth+gap>width)break;used+=value+gap;count++;}}
    buttons.forEach((button,index)=>{button.hidden=index>=count;});overflow=groups.slice(count);more.hidden=overflow.length===0;
    more.setAttribute('aria-label','そのほかのブックマーク '+overflow.length+'件');more.title='そのほかのブックマーク';
    if(anchor===more)close();
  }
  function schedule(){if(frame!==null)return;frame=requestFrame(()=>{frame=null;reflow();});}
  more.onclick=()=>{if(anchor===more)close(true);else show(overflow,more,'そのほかのブックマーク',generation);};
  empty.onclick=()=>{if(live(generation))manage();};
  function update(value){
    let next;try{next=checked(value);}catch(error){generation={};initialized=false;entries=[];groups=[];buttons=[];close();row.replaceChildren();const note=document.createElement('span');note.className='browser-bookmark-empty';note.textContent='ブックマークを確認できません';row.append(note);throw error;}
    if(initialized&&JSON.stringify(next)===JSON.stringify(entries))return;initialized=true;
    generation={};entries=next;close();groups=[];const folders=new Map();
    for(const item of entries){if(!item.folder)groups.push({folder:'',items:[item]});else if(folders.has(item.folder))folders.get(item.folder).items.push(item);else{const group={folder:item.folder,items:[item]};folders.set(item.folder,group);groups.push(group);}}
    const token=generation;buttons=groups.map(group=>{
      if(!group.folder)return itemButton(group.items[0],token);
      const node=document.createElement('button');node.type='button';node.className='browser-bookmark-folder';node.textContent='▸ '+group.folder;node.title=group.folder;node.setAttribute('aria-haspopup','menu');node.setAttribute('aria-expanded','false');node.onclick=()=>{if(anchor===node)close(true);else show(group.items.map(item=>({folder:'',items:[item]})),node,group.folder,token);};return node;
    });row.replaceChildren(...(buttons.length?buttons:[empty]),more);schedule();
  }
  function setVisible(value){if(typeof value!=='boolean'||destroyed)return false;visible=value;host.hidden=!value;close();try{storage?.setItem(preference,value?'1':'0');}catch{report(Error('browser_preference_unavailable'));}if(value)schedule();return visible;}
  function keyboard(event){
    if(event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='Escape'&&!popup.hidden){event.preventDefault();close(true);return;}
    const inPopup=popup.contains(event.target),list=inPopup?[...popup.querySelectorAll('button')]:[...row.querySelectorAll('button')].filter(node=>!node.hidden),index=list.indexOf(document.activeElement);
    const direction=inPopup?{ArrowDown:1,ArrowUp:-1}:{ArrowRight:1,ArrowLeft:-1};let next;
    if(Object.hasOwn(direction,event.key))next=(index+direction[event.key]+list.length)%list.length;
    else if(event.key==='Home')next=0;else if(event.key==='End')next=list.length-1;else return;
    if(list[next]){event.preventDefault();list[next].focus();}
  }
  host.addEventListener('keydown',keyboard);
  const outside=event=>{if(!host.contains(event.target))close();};document.addEventListener('pointerdown',outside);
  const observer=window.ResizeObserver?new window.ResizeObserver(schedule):null;observer?.observe(row);
  update([]);
  return{update,toggle:()=>setVisible(!visible),setVisible,isVisible:()=>visible,close,reflow,
    destroy(){if(destroyed)return;destroyed=true;generation={};close();observer?.disconnect();if(frame!==null)cancelFrame(frame);document.removeEventListener('pointerdown',outside);host.removeEventListener('keydown',keyboard);host.replaceChildren();}};
}
