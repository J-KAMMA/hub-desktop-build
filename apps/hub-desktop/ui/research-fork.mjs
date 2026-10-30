import {researchPublicExport} from './research-public-export.mjs';
const node=(d,tag,text)=>{const n=d.createElement(tag);if(text!=null)n.textContent=text;return n;};
const id=value=>typeof value==='string'&&value.length===35&&/^rp_[a-f0-9]{32}$/.test(value);
const hash=value=>typeof value==='string'&&value.length===71&&/^sha256:[a-f0-9]{64}$/.test(value);
function source(value){
 if(!value||!id(value.projectId)||typeof value.title!=='string'||value.title.length>240||!hash(value.snapshotHash))throw Error('派生元を確認できませんでした。');
 const u=new URL(value.href);if(u.username||u.password||value.href!==`${u.origin}/v2/research/${value.projectId}`||(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))throw Error('派生元のURLが不正です。');return value;
}
export function researchFork(root,data,options={}){
 if(!options.invoke||!id(data.project?.id))return null;
 const d=root.ownerDocument,p=data.project.id,remote=options.sourceOrigin,storage=options.state??{},draft=storage.fork??(storage.fork={}),box=node(d,'section');box.className='research-editor';box.setAttribute('aria-label','プロジェクトの派生');const meta=root.querySelector('.meta');if(meta)meta.after(box);else root.append(box);
 if(remote){const u=new URL(remote);if(u.origin!==remote||u.protocol!=='https:'||u.username||u.password)throw Error('接続先HubのURLが不正です。');}
 const publicExport=remote?researchPublicExport(root,{origin:remote,projectId:p},options):null;
 let active=true,busy=false,info=draft.preview?{source:null,preview:draft.preview}:null,error=draft.operation?'前回の保存結果が未確認です。同じ操作IDで確認し直せます。':'';
 const live=()=>active&&!draft.invalidated;
 const message=e=>options.friendlyError?.(e)??String(e?.message??e);
 const button=(label,run)=>{const n=node(d,'button',label);n.type='button';n.disabled=busy;n.onclick=()=>{if(live()&&!busy)return run();};return n;};
 function render(){
  if(!live())return;box.replaceChildren();
  if(info?.source){const row=node(d,'p','派生元：');row.append(node(d,'span',info.source.title),node(d,'p',info.source.href));row.append(button('派生元を開く',async()=>{const value=info.source,origin=new URL(await options.invoke('hub_origin')).origin;if(!live())return;if(new URL(value.href).origin===origin)return options.openProject?.({id:value.projectId,title:value.title});return options.openSource?.(value.href);}));if(options.openSource)row.append(button('変更を原本へ提案（Web）',async()=>{const origin=new URL(await options.invoke('hub_origin')).origin;if(live())return options.openSource(`${origin}/v2/research/${p}`);}));box.append(row);}
  if(info?.preview){const preview=info.preview,details=node(d,'details');details.open=Boolean(storage.forkOpen);details.ontoggle=()=>{if(live())storage.forkOpen=details.open;};details.append(node(d,'summary',remote?'自分のHubへfork':'自分のプロジェクトとしてfork'),node(d,'p',`公開文書・コードの最新版${preview.documentCount}件を、自分だけが見られる新しいプロジェクトへ複製します。原本は変更されません。`),node(d,'p',`ライセンス：${preview.license??'未設定。公開だけでは再利用の許可になりません。'}`),node(d,'p','Git履歴・PDF・課題・変更提案は含みません。Git履歴はGitの持ち出し機能を使います。'));
   if(draft.saved)details.append(button('作成したforkを開く',async()=>{try{await options.openProject?.(draft.saved);}catch(e){if(live()){error=`forkは保存済みです。開けませんでした: ${message(e)}`;render();}}}));
   else if(data.signedIn||data.canEdit){const label=node(d,'label','ライセンスと権利者の許可を確認しました'),check=node(d,'input');check.type='checkbox';check.checked=Boolean(draft.confirmed);check.disabled=busy||Boolean(draft.operation);check.onchange=()=>{if(live()&&!busy&&!draft.operation){draft.confirmed=check.checked;render();}};label.prepend(check);details.append(label);const save=button(busy?'保存中…':draft.operation?'同じforkの保存結果を確認':'非公開のforkを作成',send);save.disabled=busy||!draft.confirmed;details.append(save);}
   else details.append(node(d,'p','forkを作成するにはHubへ接続してください。'));box.append(details);
  }
  if(error){const status=node(d,'p',error);status.setAttribute('role','alert');box.append(status);if(!draft.operation)box.append(button('派生元を再確認',load));}
 }
 async function load(){
  if(!live()||busy||draft.operation)return;busy=true;error='';render();
  try{const next=await options.invoke('hub_detail',{name:remote?'research_network_fork':'research_fork',ids:remote?[remote,p]:[p]});if(!live())return;
   if(next.preview){source(next.preview);if(next.preview.projectId!==p||(remote&&new URL(next.preview.href).origin!==remote)||!Number.isSafeInteger(next.preview.documentCount)||next.preview.documentCount<0||next.preview.documentCount>20||!(next.preview.license==null||typeof next.preview.license==='string'&&next.preview.license.length<=200))throw Error('fork情報が不正です。');}
   if(next.source)source(next.source);info=next;
  }catch(e){if(live())error=message(e);}finally{if(live()){busy=false;render();}}
 }
 async function send(){
  if(!live()||busy||!info?.preview||!draft.confirmed)return;
  draft.preview=info.preview;draft.operation??={requestId:(options.randomUUID??(()=>crypto.randomUUID()))(),snapshotHash:info.preview.snapshotHash,rightsConfirmed:true};busy=true;error='';render();
  try{const result=await options.invoke('hub_client_action',{action:remote?'research_network_fork':'research_fork',target:p,options:{...draft.operation,...(remote?{origin:remote}:{})}});if(!live())return;
   if(!id(result.project?.id)||result.project.id!==`rp_${draft.operation.requestId.replaceAll('-','')}`)throw Error('保存結果を確認できませんでした。同じ操作IDで確認し直せます。');draft.saved=result.project;
  }catch(e){if(live()){
   if(/research_fork_rejected:(400|403|404|409|429):/.test(String(e))){delete draft.operation;delete draft.preview;draft.confirmed=false;info=null;error=`forkを作成できませんでした。派生元を再確認してください: ${message(e)}`;}
   else error=`保存結果を確認できませんでした。同じ操作IDで再試行できます: ${message(e)}`;
  }}
  finally{if(live()){busy=false;render();}}
 }
 function invalidate(){publicExport?.invalidate();active=false;draft.invalidated=true;delete draft.operation;delete draft.saved;delete draft.preview;info=null;d.defaultView?.removeEventListener('hub-account-changed',invalidate);box.replaceChildren(node(d,'p','接続が変わりました。画面を再読み込みしてください。'));}
 d.defaultView?.addEventListener('hub-account-changed',invalidate);
 render();const ready=load();
 return{root:box,ready,invalidate,dispose(){publicExport?.dispose();active=false;d.defaultView?.removeEventListener('hub-account-changed',invalidate);box.remove();}};
}
