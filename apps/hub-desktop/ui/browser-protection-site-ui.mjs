import {pageSite} from './browser-autoplay-ui.mjs';
const SITE=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{1,63}$/;
function siteValue(value){
  if(value===null||typeof value!=='object'||Array.isArray(value)||value.version!==1||!Number.isSafeInteger(value.tabBlockedCount)||value.tabBlockedCount<0
    ||!Array.isArray(value.allowedSites)||value.allowedSites.length>200||!value.allowedSites.every(site=>typeof site==='string'&&SITE.test(site)))
    throw Error('browser_protection_site_unavailable');
  return {count:value.tabBlockedCount,sites:[...value.allowedSites]};
}
const covered=(sites,site)=>site!==null&&sites.some(allowed=>site===allowed||site.endsWith(`.${allowed}`));

/** Per-site "do not block here" switch and this tab's blocked-request count, inside the protection panel. No IPC on construction. */
export function createBrowserProtectionSite({document,invoke,getUrl,getTabId=()=>null,onError=()=>{}}){
  if(!document||typeof invoke!=='function'||typeof getUrl!=='function')throw Error('browser_protection_site_invalid');
  const node=(tag,text,className='')=>{const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;};
  const element=node('section',undefined,'browser-protection-site');element.setAttribute('aria-label','このサイトの保護');
  const count=node('p','このタブのブロック数: 未確認','browser-protection-note');
  const label=node('label',undefined,'browser-protection-toggle'),input=node('input'),text=node('span','このサイトでは止めない');input.type='checkbox';label.append(input,text);
  element.append(count,label);
  let state=null,busy=false,turn=0,shown=null;
  function paint(){
    const site=pageSite(getUrl()??'');shown=site;
    count.textContent=state?`このタブのブロック数: ${state.count.toLocaleString('ja-JP')}件`:'このタブのブロック数: 未確認';
    label.hidden=site===null;
    text.textContent=site?`このサイトでは止めない（${site}）`:'このサイトでは止めない';
    input.checked=covered(state?.sites??[],site);
    // An allowance inherited from a parent site is changed on that site, not here.
    input.disabled=busy||!state||input.checked&&!state.sites.includes(site);
    element.setAttribute('aria-busy',String(busy));
  }
  async function run(name,args){
    const own=++turn;
    try{const value=siteValue(await invoke(name,args));if(own===turn)state=value;return true;}
    catch{if(own===turn){state=null;try{onError({code:'browser_protection_site_unavailable'});}catch{}}return false;}
    finally{if(own===turn){busy=false;paint();}}
  }
  const load=()=>run('browser_protection_site_status',{tab:getTabId()});
  input.onchange=()=>{
    const site=pageSite(getUrl()??'');
    if(!state||busy||!site||site!==shown){paint();return;}
    const allowed=input.checked;busy=true;paint();void run("browser_set_protection_site",{site,allowed,tab:getTabId()});
  };
  paint();
  return {element,load,paint};
}
