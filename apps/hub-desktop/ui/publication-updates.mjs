import {appendResearchUpdates} from './research-discovery.mjs';

export function createPublicationUpdates(target,{invoke,isCurrent,origin,openLink}) {
 const document=target.ownerDocument,root=document.createElement('div');root.className='publication-updates';target.prepend(root);
 let active=true,busy=false,generation=0,timer,cancelRead;
 const live=turn=>{try{return active&&turn===generation&&root.isConnected&&root.parentNode===target&&isCurrent()===true;}catch{return false;}};
 const node=(tag,text)=>{const value=document.createElement(tag);value.textContent=text;return value;};
 function heading(){root.replaceChildren(node('h3','作品・研究の更新'));}
 function error(message){heading();const status=node('p',message);status.className='meta';status.setAttribute('role','status');
  const button=node('button','更新欄を再試行');button.type='button';button.className='head-action';const turn=generation;button.onclick=()=>button.isConnected&&root.contains(button)&&live(turn)&&retry();root.append(status,button);}
 async function retry(){
  if(busy||!live(generation))return false;const turn=++generation;busy=true;root.hidden=false;heading();root.setAttribute('aria-busy','true');
  const status=node('p','作品・研究の更新を確認しています…');status.setAttribute('role','status');root.append(status);
  try{
   const source=new URL(origin);if(source.origin!==origin||source.username||source.password||!['https:','http:'].includes(source.protocol))throw Error('invalid_source');
   const value=await Promise.race([Promise.resolve().then(()=>{if(!live(turn))throw Error('cancelled');return invoke('hub_detail',{name:'research_publication_updates',ids:[]});}),new Promise((_,reject)=>{cancelRead=()=>reject(Error('cancelled'));timer=setTimeout(()=>reject(Error('deadline')),15000);})]);
   if(!live(turn))return false;
   if(!value||Array.isArray(value)||typeof value!=='object'||Reflect.ownKeys(value).length!==1||!Object.hasOwn(value,'updates')||!Array.isArray(value.updates))throw Error('invalid_updates');
   root.replaceChildren();const section=appendResearchUpdates(root,value.updates,{isCurrent:()=>live(turn),openLink});
   if(section?.querySelector('[role="status"]'))throw Error('invalid_updates');
   if(section){const label=node('p','配信元: '+source.origin);label.className='meta';section.querySelector('h3').after(label);}
   root.hidden=!section;return true;
  }catch(reason){if(live(turn))error(reason?.message==='deadline'?'更新欄の取得が時間切れになりました。':'作品・研究の更新を読み込めませんでした。');return false;}
  finally{if(turn===generation){clearTimeout(timer);cancelRead=undefined;busy=false;if(live(turn))root.setAttribute('aria-busy','false');}}
 }
 function dispose(){if(!active)return;active=false;generation++;cancelRead?.();cancelRead=undefined;clearTimeout(timer);root.remove();for(const event of ['hub-account-changed','hub-origin-changed'])document.defaultView?.removeEventListener(event,dispose);}
 for(const event of ['hub-account-changed','hub-origin-changed'])document.defaultView?.addEventListener(event,dispose);
 const ready=retry();return{root,ready,retry,dispose};
}
