import {RESEARCH_CHANGE_BYTES,parseResearchChangePackage,readResearchChangeFile,researchForkDigest,normalizeResearchHubOrigin,validateResearchChangeTarget} from './research-change-package.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const id=value=>typeof value==='string'&&value.length>=1&&value.length<=128&&!/[^A-Za-z0-9_-]/u.test(value);
const validBody=value=>typeof value==='string'&&value.trim()&&value.length<=100000&&!/\p{Surrogate}/u.test(value);
const sha=value=>typeof value==='string'&&value.length===71&&/^sha256:[a-f0-9]{64}$/u.test(value);
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const safeUrl=target=>`${target.origin}/v2/research/${target.projectId}?document=${encodeURIComponent(target.documentId)}&version=${target.baseVersion}`;
function checkedScope(value){
  if(value===null)return null;if(!exact(value,['key','generation'])||typeof value.key!=='string'||value.key.length>4096||!Number.isSafeInteger(value.generation)||value.generation<0)throw Error('research_change_scope_invalid');
  const pair=JSON.parse(value.key);if(!Array.isArray(pair)||pair.length!==2||JSON.stringify(pair)!==value.key||normalizeResearchHubOrigin(pair[0])!==pair[0]||!id(pair[1]))throw Error('research_change_scope_invalid');return{...value,origin:pair[0],deviceId:pair[1]};
}
const sameScope=(left,right)=>left&&right&&left.key===right.key&&left.generation===right.generation;
function snapshotValue(data){
  const projectId=data?.document?.projectId,documentId=data?.document?.id,version=data?.revision?.version,body=data?.revision?.body,contentHash=data?.revision?.contentHash;
  validateResearchChangeTarget({origin:'https://snapshot.invalid',projectId,documentId,baseVersion:version,baseHash:contentHash});if(!validBody(body))throw Error('research_change_document_invalid');
  return{projectId,documentId,version,body,contentHash,signedIn:data.signedIn===true,canEdit:data.canEdit===true};
}

export function createResearchForkChangeTransfer({document,data,invoke,getScope,isCurrent,onImport,onOpen,createP2P}){
  if(!document||[invoke,getScope,isCurrent].some(value=>typeof value!=='function')||[onImport,onOpen,createP2P].some(value=>value!==undefined&&typeof value!=='function'))throw Error('research_change_host_invalid');
  const make=(tag,text,className='')=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const element=make('details',undefined,'detail-form research-change-transfer');element.append(make('summary','文書の変更を受け渡す'));
  const exportBox=make('details',undefined,'detail-form'),importBox=make('details',undefined,'detail-form'),status=make('p','','meta');status.setAttribute('role','status');
  exportBox.append(make('summary','原本のHubへ変更を提案する'),make('p','表示中の本文には非公開の内容も含まれます。原本のHubでログインし、変更提案の内容を確認してください。ファイルのhashは本人や出自の証明ではありません。','meta'));
  importBox.append(make('summary','変更ファイルを取り込む'),make('p','読み込みだけでは保存・投稿しません。対象のHub・文書・基準版を確認してから提案フォームへ渡します。ファイルの作者を本人認証として扱いません。','meta'));
  const summary=make('input');summary.type='text';summary.maxLength=500;summary.setAttribute('aria-label','原本への変更の理由');
  const file=make('input');file.type='file';file.accept='application/json,.json';file.setAttribute('aria-label','変更ファイル（JSON）');
  const exportActions=make('div',undefined,'actions'),importActions=make('div',undefined,'actions'),exportPreview=make('section',undefined,'detail-form'),importPreview=make('section',undefined,'detail-form'),peerHost=make('div'),peerActions=make('div',undefined,'actions');
  exportBox.append(summary,exportActions,exportPreview);importBox.append(file,importActions,importPreview);element.append(exportBox,importBox,peerHost,peerActions,status);
  let snapshot=null,original='',destroyed=false,invalidated=false,epoch=0,editRevision=0,fileRevision=0,peerRevision=0,scope=null,viewerId=null,context=null,noFork=false,documentVerified=false,busy=false,fileBusy=false,prepared=null,staged=null,stagedMatches=false,peer=null;
  try{snapshot=snapshotValue(data);original=JSON.stringify(snapshot);}catch{status.textContent='文書の版・本文・hashを確認できません。';}
  const canExport=!!snapshot?.signedIn&&snapshot.canEdit,canImport=!!snapshot?.signedIn&&typeof onImport==='function';
  const buttons={};
  function releasePeer(){peerRevision++;peer?.dispose?.();peer?.destroy?.();peer=null;peerHost.replaceChildren();}
  function clearPrepared(){prepared=null;exportPreview.replaceChildren();releasePeer();}
  function invalidate(){if(destroyed||invalidated)return;invalidated=true;epoch++;fileRevision++;scope=null;viewerId=null;context=null;staged=null;documentVerified=false;summary.value='';file.value='';clearPrepared();importPreview.replaceChildren();status.textContent='接続や文書が変わりました。文書を開き直してください。';paint();}
  function current(){if(destroyed||invalidated)return false;try{if(!isCurrent()||snapshot&&JSON.stringify(snapshotValue(data))!==original){invalidate();return false;}}catch{invalidate();return false;}return element.isConnected;}
  const capturedCurrent=(captured,turn)=>current()&&epoch===turn&&sameScope(scope,captured);
  async function fresh(captured=scope,turn=epoch){
    if(!current())return null;let next;try{next=checkedScope(await getScope());}catch{next=null;}if(!current()||turn!==epoch)return null;
    if(!next){if(scope)invalidate();else status.textContent='変更ファイルの受け渡しにはHubへの接続が必要です。';return null;}if(captured&&!sameScope(captured,next)){invalidate();return null;}if(!scope)scope=next;return next;
  }
  function button(host,name,label,action){const node=make('button',label,'head-action');node.type='button';node.dataset.researchChangeAction=name;node.onclick=()=>{if(current()&&!node.disabled)void Promise.resolve().then(action).catch(()=>{if(current())status.textContent='操作を確認できません。内容は保存・投稿していません。';});};host.append(node);buttons[name]=node;return node;}
  function paint(){
    const available=current()&&documentVerified&&!!scope;
    exportBox.hidden=!canExport||noFork;importBox.hidden=!canImport;element.hidden=!canExport&&!canImport||noFork&&!canImport;
    summary.disabled=!available||busy||!context;file.disabled=!available||busy;
    for(const node of Object.values(buttons))node.disabled=!available||busy;
    buttons.prepare.disabled=!available||busy||!context||!summary.value.trim();buttons.save.disabled=!available||busy||!prepared;
    buttons.save.hidden=!prepared;buttons.exportOpen.hidden=!prepared||!onOpen;buttons.sendPeer.hidden=!prepared||!createP2P;buttons.closePeer.hidden=!peer;
    buttons.reload.hidden=!canExport||noFork;buttons.reload.disabled=!current()||busy;
    buttons.apply.disabled=!available||busy||fileBusy||!staged||!stagedMatches;buttons.apply.hidden=!staged;
    buttons.importOpen.hidden=!staged||!onOpen;buttons.receivePeer.hidden=!createP2P||!canImport;
    element.setAttribute('aria-busy',String(busy||fileBusy));
  }
  async function checkedContext(raw,captured,turn){
    if(!exact(raw,['viewerId','projectId','documentId','version','body','contentHash','source'])||!id(raw.viewerId)||raw.projectId!==snapshot.projectId||raw.documentId!==snapshot.documentId||raw.version!==snapshot.version||raw.body!==snapshot.body||raw.contentHash!==snapshot.contentHash||new TextEncoder().encode(JSON.stringify(raw)).byteLength>1048576)throw Error('research_change_context_invalid');
    const source=validateResearchChangeTarget(raw.source);if(raw.contentHash!==await researchForkDigest(raw.body))throw Error('research_change_context_invalid');
    if(!capturedCurrent(captured,turn))return null;if(viewerId!==null&&viewerId!==raw.viewerId){invalidate();return null;}viewerId=raw.viewerId;return{viewerId,projectId:raw.projectId,documentId:raw.documentId,version:raw.version,body:raw.body,contentHash:raw.contentHash,source};
  }
  async function requestContext(captured,turn){
    const ids=[snapshot.projectId,snapshot.documentId,String(snapshot.version),captured.deviceId,captured.origin,...(viewerId===null?[]:[viewerId])];
    const raw=await invoke('hub_detail',{name:'research_change_context',ids});if(!capturedCurrent(captured,turn)||!await fresh(captured,turn))return null;return checkedContext(raw,captured,turn);
  }
  async function loadContext(){
    if(busy||!current()||!canExport)return false;busy=true;paint();const turn=epoch;
    try{const captured=await fresh();if(!captured)return false;const value=await requestContext(captured,turn);if(!value)return false;
      context=value;noFork=false;clearPrepared();status.textContent='表示中の版と原本の対応を確認しました。';return true;
    }catch(error){if(current()){const code=typeof error==='string'?error:error?.code??error?.message;context=null;clearPrepared();if(code==='research_change_not_found'){noFork=true;status.textContent='';}else status.textContent='原本との対応を取得できません。文書の情報を再確認してください。';}return false;}
    finally{busy=false;if(current())paint();}
  }
  function showPacket(host,packet,title){host.replaceChildren(make('strong',title),make('p',`${packet.target.origin} · ${packet.target.projectId} · ${packet.target.documentId} · 基準 v${packet.target.baseVersion}`,'meta'),make('p',`基準 ${packet.target.baseHash} · 内容 ${packet.contentHash}`,'meta'),make('p',packet.summary),make('pre',packet.body,'dev-output'));}
  async function prepare(){
    if(busy||!context||!canExport||!documentVerified)return;const source=context,revision=editRevision,turn=epoch;busy=true;clearPrepared();paint();
    try{const captured=await fresh();if(!captured)return;const packet=await parseResearchChangePackage({protocol:'hub.research-change.v1',target:structuredClone(source.source),body:snapshot.body,summary:summary.value.trim(),contentHash:snapshot.contentHash});
      if(!capturedCurrent(captured,turn)||revision!==editRevision||source!==context)return;
      const FileType=globalThis.File??document.defaultView?.File;if(!FileType)throw Error('research_change_file_unavailable');
      prepared={packet,file:new FileType([JSON.stringify(packet)],'hub-research-change.json',{type:'application/json'}),context:structuredClone(source),scope:{...captured},revision};showPacket(exportPreview,packet,'端末へ保存する変更内容');status.textContent='本文・変更理由・送付先を全文確認してください。まだファイルは保存していません。';
    }catch{if(current()&&revision===editRevision)status.textContent='変更ファイルを準備できません。理由は500文字、本文は100000UTF16、JSONは500KB以内で確認してください。';}
    finally{busy=false;if(current())paint();}
  }
  async function verifyPrepared(item){
    const turn=epoch,captured=await fresh(item.scope,turn);if(!captured||prepared!==item||item.revision!==editRevision)return null;
    const value=await requestContext(captured,turn);if(!value||prepared!==item||item.revision!==editRevision)return null;if(!equal(value,item.context)){context=value;clearPrepared();paint();return null;}return{captured,turn};
  }
  async function save(){
    if(busy||!prepared)return;busy=true;paint();const item=prepared;let issued=false;
    try{const verified=await verifyPrepared(item);if(!verified){if(current())status.textContent='表示版や原本との対応が変わりました。変更ファイルを準備し直してください。';return;}const{captured,turn}=verified;
      issued=true;const result=await invoke('research_change_save',{projectId:snapshot.projectId,documentId:snapshot.documentId,version:snapshot.version,expectedViewerId:item.context.viewerId,expectedDeviceId:captured.deviceId,expectedOrigin:captured.origin,packet:structuredClone(item.packet)});
      if(!capturedCurrent(captured,turn)||prepared!==item||!await fresh(captured,turn))return;
      if(exact(result,['cancelled'])&&result.cancelled===true)status.textContent='ファイルの保存を取り消しました。準備した内容は保持しています。';
      else if(exact(result,['saved','contentHash'])&&result.saved===true&&result.contentHash===item.packet.contentHash)status.textContent='確認した内容の変更ファイルを保存しました。変更提案はまだ投稿していません。';
      else throw Error('research_change_save_unknown');
    }catch{if(current()&&prepared===item)status.textContent=issued?'ファイルの保存結果を確認できません。内容と保存先を確認してください。自動では再実行しません。':'保存前の情報を確認できません。保存要求は送っていません。文書と送付先を再確認してください。';}
    finally{busy=false;if(current())paint();}
  }
  async function matchingTarget(packet,captured,turn){
    const target=packet.target;if(target.origin!==captured.origin||target.projectId!==snapshot.projectId||target.documentId!==snapshot.documentId||target.baseVersion!==snapshot.version||target.baseHash!==snapshot.contentHash)return false;
    const actual=await researchForkDigest(snapshot.body);return capturedCurrent(captured,turn)&&actual===target.baseHash;
  }
  async function stageFile(item){
    if(!canImport||busy||!current())return false;const token=++fileRevision,turn=epoch;fileBusy=true;staged=null;stagedMatches=false;importPreview.replaceChildren();paint();
    try{const captured=await fresh();if(!captured)return false;const packet=await readResearchChangeFile(item);if(!capturedCurrent(captured,turn)||token!==fileRevision||!await fresh(captured,turn))return false;
      const match=await matchingTarget(packet,captured,turn);if(!capturedCurrent(captured,turn)||token!==fileRevision)return false;staged={packet,scope:{...captured},token};stagedMatches=match;
      showPacket(importPreview,packet,'読み込んだ変更内容');status.textContent=match?'対象と基準の一致を確認しました。提案フォームへ渡すまでは草稿を変更しません。':'このHub・文書・表示版・基準hashと一致しません。原本の対応する版を確認してください。自動では文書や版を変更しません。';return true;
    }catch{if(current()&&token===fileRevision)status.textContent='変更ファイルを読み込めません。500KB以内のJSON・UTF-8・対象・hashを確認してください。既存の提案草稿は変更していません。';return false;}
    finally{if(token===fileRevision){fileBusy=false;if(current())paint();}}
  }
  async function apply(){
    if(busy||fileBusy||!staged||!stagedMatches||!canImport)return;const item=staged,turn=epoch;busy=true;paint();
    try{const captured=await fresh(item.scope,turn);if(!captured||staged!==item||item.token!==fileRevision||!await matchingTarget(item.packet,captured,turn))return;
      const accepted=await onImport(structuredClone(item.packet));if(!capturedCurrent(captured,turn)||staged!==item||item.token!==fileRevision||!await fresh(captured,turn))return;
      status.textContent=accepted===true?'確認した変更を提案フォームへ取り込みました。保存・投稿はまだ行っていません。':'提案フォームへ取り込めませんでした。既存の草稿・確認済み内容・送信状態を確認してください。';
    }catch{if(current()&&staged===item)status.textContent='提案フォームへの取込みを確認できません。内容と既存の草稿は保持しています。';}
    finally{busy=false;if(current())paint();}
  }
  async function open(target,item){if(!onOpen||busy||!current())return;busy=true;paint();try{const turn=epoch,captured=await fresh();if(captured&&capturedCurrent(captured,turn)&&(prepared===item||staged===item))await onOpen(safeUrl(target));}finally{busy=false;if(current())paint();}}
  async function startPeer(sending){
    if(!createP2P||busy||!current()||sending&&!prepared||!sending&&!canImport)return;const item=prepared,turn=epoch;busy=true;paint();
    try{const verified=sending?await verifyPrepared(item):await fresh();if(!verified)return;const captured=sending?verified.captured:verified;if(!capturedCurrent(captured,turn))return;releasePeer();
      const peerToken=peerRevision,peerCurrent=()=>peerToken===peerRevision&&capturedCurrent(captured,turn)&&(!sending||prepared===item&&item.revision===editRevision);
      peer=createP2P(peerHost,{invoke:async(name,args)=>{if(!peerCurrent())throw Error('research_change_scope_invalid');const result=await invoke(name,args);if(!peerCurrent()||name==='hub_origin'&&result!==captured.origin){invalidate();throw Error('research_change_scope_invalid');}return result;},...(sending?{sendFile:item.file,invitationUrl:safeUrl(item.packet.target)}:{}),onReceiveFile:received=>peerCurrent()?stageFile(received):false,maxFileBytes:RESEARCH_CHANGE_BYTES,receivedFileType:'application/json',isCurrent:peerCurrent});
    }catch{if(current())status.textContent='端末間の受け渡しを準備できません。接続情報を確認してください。';}
    finally{busy=false;if(current())paint();}
  }
  button(exportActions,'prepare','変更ファイルを準備',prepare);button(exportActions,'save','確認して変更ファイルを保存',save);button(exportActions,'exportOpen','原本の文書を開く',()=>prepared&&open(prepared.packet.target,prepared));button(exportActions,'sendPeer','端末間で変更ファイルを渡す',()=>startPeer(true));button(exportActions,'reload','原本との対応を再確認',loadContext);
  button(importActions,'apply','提案フォームへ取り込む',apply);button(importActions,'importOpen','対象の原本を開く',()=>staged&&open(staged.packet.target,staged));button(importActions,'receivePeer','端末から変更ファイルを受け取る',()=>startPeer(false));button(peerActions,'closePeer','端末間の受け渡しを閉じる',()=>{releasePeer();paint();});
  summary.oninput=()=>{editRevision++;clearPrepared();paint();};file.onchange=()=>{const selected=file.files?.[0];file.value='';if(selected)void stageFile(selected);};
  const accountChanged=()=>invalidate();document.defaultView?.addEventListener('hub-account-changed',accountChanged);paint();
  const ready=Promise.resolve().then(async()=>{if(!snapshot||!current()||!canExport&&!canImport)return false;const turn=epoch,captured=await fresh();if(!captured)return false;try{const digest=await researchForkDigest(snapshot.body);if(!capturedCurrent(captured,turn))return false;if(digest!==snapshot.contentHash)throw Error('research_change_document_invalid');documentVerified=true;paint();if(!canExport)return true;const exported=await loadContext();return exported||canImport&&documentVerified&&current();}catch{if(current())status.textContent='表示中の本文とhashを確認できません。文書を開き直してください。';return false;}});
  return{element,ready,destroy(){if(destroyed)return;destroyed=true;epoch++;fileRevision++;releasePeer();prepared=null;staged=null;context=null;scope=null;summary.value='';file.value='';summary.oninput=null;file.onchange=null;for(const node of Object.values(buttons))node.onclick=null;document.defaultView?.removeEventListener('hub-account-changed',accountChanged);element.replaceChildren();element.remove();}};
}
