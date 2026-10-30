import {parseResearchForkPackage,researchForkPackagePath} from './research-public-package.mjs';

const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
function originValue(raw,remote){
  if(typeof raw!=='string'||raw.length>(remote?2048:512)||/[\u0000-\u001f\u007f]/u.test(raw)||!remote&&!/^https?:\/\/[^/?#\\\s]+\/?$/iu.test(raw))throw Error('research_public_export_invalid_request');
  const url=new URL(raw);
  if((remote?url.origin!==raw:url.pathname!=='/'||url.search||url.hash)||url.username||url.password||url.protocol!=='https:'&&(remote||url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('research_public_export_invalid_request');return remote?raw:url.origin;
}
const node=(document,tag,text,className)=>{const value=document.createElement(tag);if(text!=null)value.textContent=text;if(className)value.className=className;return value;};

/** Public metadata/content only; reading and OS saving always require a click. */
export function researchPublicExport(root,source,options={}){
  if(!root||typeof options.invoke!=='function')return null;
  const document=root.ownerDocument,projectId=source?.projectId,requestedOrigin=source?.origin;
  try{researchForkPackagePath(projectId);if(requestedOrigin!==undefined)originValue(requestedOrigin,true);}catch{return null;}
  const box=node(document,'details',null,'research-editor'),summary=node(document,'summary','公開版を持ち出す');box.append(summary);root.append(box);
  let active=true,busy=false,value=null,resolvedOrigin=null,message='',failed=false,viewObserver=null;
  const sourceCurrent=()=>source?.projectId===projectId&&source?.origin===requestedOrigin;
  const live=()=>{try{return active&&sourceCurrent()&&(options.isCurrent?.()??true)===true;}catch{return false;}};
  const button=(label,run)=>{const value=node(document,'button',label,'head-action');value.type='button';value.disabled=busy;value.onclick=()=>{if(live()&&!busy)void run();};return value;};
  function render(){
    if(!live())return;box.replaceChildren(summary,node(document,'p','公開文書・コードの最新版を保存します。Git履歴・PDF・課題・変更提案は含みません。','meta'));
    if(value){
      box.append(node(document,'h3',value.project.title),node(document,'p',`取得元：${resolvedOrigin}`,'meta'),node(document,'p',`プロジェクト：${value.project.id} · ${value.documents.length}文書`,'meta'),node(document,'p',`ライセンス：${value.project.license??'未設定。再利用には権利者の許可が必要です。'}`,'meta'),node(document,'p','元のHub・文書の版・ハッシュを含みます。公開されていることだけでは、再利用の許可にはなりません。','meta'),node(document,'code',value.snapshotHash),node(document,'p','ハッシュは内容の識別用で、著者の署名ではありません。','meta'),button(busy?'保存を確認しています…':'確認した公開版を保存',save),button('公開版を再確認',read));
    }else box.append(button(busy?'確認しています…':'内容と利用条件を確認',read));
    if(message){const status=node(document,'p',message,'meta');status.setAttribute('role',failed?'alert':'status');box.append(status);}box.setAttribute('aria-busy',String(busy));
  }
  async function read(){
    if(!live()||busy)return false;busy=true;message='';failed=false;render();
    try{
      const origin=requestedOrigin??await options.invoke('hub_origin');if(!live())return false;
      const captured=originValue(origin,requestedOrigin!==undefined),raw=await options.invoke('research_public_export_read',{origin:captured,projectId});if(!live())return false;
      const packet=await parseResearchForkPackage(raw,captured,projectId);if(!live())return false;
      value=freeze(packet);resolvedOrigin=captured;message='内容と利用条件を確認し、保存する版を選んでください。';return true;
    }catch{if(live()){failed=true;message=value?'新しい版を確認できませんでした。前に確認した公開版は保持しています。':'公開版を確認できませんでした。公開状態と接続先を確認してください。';}return false;}
    finally{if(live()){busy=false;render();}}
  }
  async function save(){
    if(!live()||busy||!value)return false;const packet=value,origin=resolvedOrigin;busy=true;message='';failed=false;render();
    try{
      if(!live()||packet!==value)return false;
      const result=await options.invoke('research_public_export_save',{origin,projectId,snapshotHash:packet.snapshotHash,packet});if(!live()||packet!==value)return false;
      if(exact(result,['cancelled'])&&result.cancelled===true){message='保存を取り消しました。確認した公開版は保持しています。';return false;}
      if(!exact(result,['saved','snapshotHash'])||result.saved!==true||result.snapshotHash!==packet.snapshotHash)throw Error('research_public_export_save_unknown');
      message='確認した公開版を保存しました。';return true;
    }catch{if(live()){failed=true;message='保存結果を確認できませんでした。端末の保存先を確認してください。確認した公開版は保持しています。';}return false;}
    finally{if(live()){busy=false;render();}}
  }
  function invalidate(){if(!active)return;active=false;value=null;resolvedOrigin=null;busy=false;detach();box.replaceChildren(summary,node(document,'p','接続先または画面が変わりました。画面を読み直してください。','meta'));}
  const events=['hub-account-changed','hub-origin-changed'];
  function detach(){viewObserver?.disconnect();for(const name of events)document.defaultView?.removeEventListener(name,invalidate);}
  for(const name of events)document.defaultView?.addEventListener(name,invalidate);
  const panel=root.closest('[data-view-panel]');
  if(panel?.classList.contains('on')&&document.defaultView?.MutationObserver){
    viewObserver=new document.defaultView.MutationObserver(records=>{if(!panel.classList.contains('on')||records.some(record=>!(record.oldValue??'').split(/\s+/).includes('on')))invalidate();});
    viewObserver.observe(panel,{attributes:true,attributeFilter:['class'],attributeOldValue:true});
  }
  render();return{root:box,ready:Promise.resolve(),read,save,invalidate,dispose(){active=false;value=null;resolvedOrigin=null;detach();box.remove();}};
}
