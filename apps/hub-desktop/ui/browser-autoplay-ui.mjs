const SITE=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{1,63}$/;
function policyValue(value){
  if(value===null||typeof value!=='object'||Array.isArray(value)||value.version!==1||typeof value.block!=='boolean'
    ||!Array.isArray(value.allowedSites)||value.allowedSites.length>200||!value.allowedSites.every(site=>typeof site==='string'&&SITE.test(site)))
    throw Error('browser_autoplay_unavailable');
  return {block:value.block,allowedSites:[...value.allowedSites]};
}
/** The page's site as the native side stores it (lowercase host without `www.`), or null for non-web pages. */
export function pageSite(url){
  try{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))return null;
    const host=parsed.hostname.replace(/\.$/,'').replace(/^www\./,'');return SITE.test(host)&&!/(?:^|\.)localhost$/.test(host)&&!/^[\d.]+$/.test(host)?host:null;}catch{return null;}
}
const covered=(sites,site)=>site!==null&&sites.some(allowed=>site===allowed||site.endsWith(`.${allowed}`));

/** Autoplay section of the browser protection panel. Construction performs no IPC. */
export function createBrowserAutoplay({document,invoke,getUrl,onError=()=>{}}){
  if(!document||typeof invoke!=='function'||typeof getUrl!=='function')throw Error('browser_autoplay_invalid');
  const node=(tag,text,className='')=>{const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;};
  const element=node('section',undefined,'browser-autoplay');element.setAttribute('aria-label','動画の自動再生');
  const title=node('strong','動画の自動再生');
  const switchRow=(text)=>{const label=node('label',undefined,'browser-protection-toggle'),input=node('input');input.type='checkbox';label.append(input,node('span',text));return {label,input,text:label.lastChild};};
  const block=switchRow('操作するまで動画を再生しない');block.input.setAttribute('role','switch');
  const here=switchRow('このサイトでは自動再生する');
  const note=node('p','ページを次に読み込んだときから反映されます。','browser-protection-note');
  const list=node('details',undefined,'browser-autoplay-sites'),summary=node('summary','自動再生するサイト'),items=node('ul');list.append(summary,items);
  element.append(title,block.label,here.label,note,list);
  let policy=null,busy=false,turn=0,shown=null;
  function paint(){
    const site=pageSite(getUrl()??'');shown=site;
    block.input.checked=policy?.block===true;block.input.disabled=busy||!policy;
    here.label.hidden=!policy?.block||site===null;
    here.text.textContent=site?`このサイトでは自動再生する（${site}）`:'このサイトでは自動再生する';
    here.input.checked=covered(policy?.allowedSites??[],site);
    // An allowance inherited from a parent site is removed from the list below, not here.
    here.input.disabled=busy||!policy||here.input.checked&&!(policy.allowedSites.includes(site));
    list.hidden=!policy?.block;summary.textContent=`自動再生するサイト（${policy?.allowedSites.length??0}件）`;
    items.replaceChildren(...(policy?.allowedSites??[]).map(allowed=>{
      const row=node('li'),name=node('span',allowed),remove=node('button','外す','browser-protection-recheck');remove.type='button';
      remove.disabled=busy;remove.setAttribute('aria-label',`${allowed} を自動再生するサイトから外す`);
      remove.onclick=()=>void change({site:allowed,allowed:false});row.append(name,remove);return row;}));
    element.setAttribute('aria-busy',String(busy));
  }
  async function change(args){
    if(busy||!policy)return false;
    const own=++turn;busy=true;paint();
    try{policy=policyValue(await invoke('browser_set_autoplay',args));return true;}
    catch{try{onError({code:'browser_autoplay_unavailable'});}catch{}policy=null;void load();return false;}
    finally{if(own===turn){busy=false;paint();}}
  }
  async function load(){
    const own=++turn;
    try{const value=policyValue(await invoke('browser_autoplay_status',{}));if(own===turn)policy=value;}
    catch{if(own===turn){policy=null;try{onError({code:'browser_autoplay_unavailable'});}catch{}}}
    finally{if(own===turn){busy=false;paint();}}
  }
  block.input.onchange=()=>void change({block:block.input.checked});
  // Act only on the site the row showed; if the page changed under the open panel, show the new one instead.
  here.input.onchange=()=>{const site=pageSite(getUrl()??'');if(site&&site===shown)void change({site,allowed:here.input.checked});else paint();};
  paint();
  return {element,load,paint};
}
