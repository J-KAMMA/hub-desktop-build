const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)&&value.toLowerCase()!=='00000000-0000-0000-0000-000000000000';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\0\p{Surrogate}]/u.test(value);
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const count=value=>Number.isSafeInteger(value)&&value>=0;
const dimension=(value,max)=>Number.isSafeInteger(value)&&value>=1&&value<=max;
const iso=value=>typeof value==='string'&&value.length===24&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const audience=value=>['public','followers'].includes(value);
const failure=code=>Error(code);
function scopeValue(value){
  if(!exact(value,['origin','device','viewer','generation'])||!id(value.device)||!id(value.viewer)||value.generation==null)throw failure('feed_operation_scope_conflict');
  let origin;try{origin=new URL(value.origin);}catch{throw failure('feed_operation_scope_conflict');}
  if(!['http:','https:'].includes(origin.protocol)||origin.origin!==value.origin)throw failure('feed_operation_scope_conflict');return Object.freeze({...value});
}
function imageValue(item){
  if(!item||typeof item.blob?.arrayBuffer!=='function'||typeof item.thumbnailBlob?.arrayBuffer!=='function'||!dimension(item.width,1600)||!dimension(item.height,1600)||!dimension(item.thumbnailWidth,480)||!dimension(item.thumbnailHeight,480))throw failure('feed_operation_invalid_draft');
  return Object.freeze({blob:item.blob,thumbnailBlob:item.thumbnailBlob,width:item.width,height:item.height,thumbnailWidth:item.thumbnailWidth,thumbnailHeight:item.thumbnailHeight});
}
function draftValue(raw,now){
  if(!raw||!text(raw.body,500)||!audience(raw.audience)||!Array.isArray(raw.images)||raw.images.length>4||!(raw.scheduledAt==null||text(raw.scheduledAt,64)))throw failure('feed_operation_invalid_draft');
  const body=raw.body.normalize('NFKC').replace(/\r\n/g,'\n').trim(),images=Object.freeze(raw.images.map(imageValue)),scheduledRaw=raw.scheduledAt??'';
  if(!text(body,500))throw failure('feed_operation_invalid_draft');
  let scheduledAt=null;if(scheduledRaw){const date=new Date(scheduledRaw);if(!Number.isFinite(date.getTime())||date.getTime()<now+60000)throw failure('feed_operation_invalid_schedule');scheduledAt=date.toISOString();}
  if(!body&&!images.length||scheduledAt&&(!body||images.length))throw failure('feed_operation_invalid_draft');
  return Object.freeze({body,rawBody:raw.body,images,audience:raw.audience,scheduledRaw,scheduledAt,kind:scheduledAt?'scheduled':'post'});
}
function sameDraft(raw,draft){
  return raw?.body===draft.rawBody&&raw.audience===draft.audience&&(raw.scheduledAt??'')===draft.scheduledRaw&&Array.isArray(raw.images)&&raw.images.length===draft.images.length&&raw.images.every((item,index)=>['blob','thumbnailBlob','width','height','thumbnailWidth','thumbnailHeight'].every(key=>item[key]===draft.images[index][key]));
}
const postKeys=['id','body','createdAt','authorName','authorHandle','authorProfileId','avatarUrl','replyCount','repostCount','likeCount','likedByViewer','bookmarkedByViewer','viewerRepostId','images','tags','referenced','audience'];
function receiptValue(raw,op,allowMissing){
  if(!exact(raw,['viewerId','clientRequestId','post','scheduled'])||raw.viewerId!==op.source.viewer||!uuid(raw.clientRequestId)||raw.clientRequestId.toLowerCase()!==op.requestId)throw failure('feed_operation_unknown');
  if(raw.post===null&&raw.scheduled===null){if(allowMissing)return null;throw failure('feed_operation_unknown');}
  if(op.draft.kind==='scheduled'){
    const item=raw.scheduled;if(raw.post!==null||!exact(item,['id','body','audience','scheduledAt','status'])||!id(item.id)||item.body!==op.draft.body||item.audience!==op.draft.audience||item.scheduledAt!==op.draft.scheduledAt||!['scheduled','published','cancelled','failed'].includes(item.status))throw failure('feed_operation_unknown');
    return Object.freeze({viewerId:raw.viewerId,clientRequestId:raw.clientRequestId,post:null,scheduled:Object.freeze({...item})});
  }
  const post=raw.post;
  if(raw.scheduled!==null||!exact(post,postKeys)||!id(post.id)||post.body!==op.draft.body||post.audience!==op.draft.audience||post.authorProfileId!==op.source.viewer||!iso(post.createdAt)||!text(post.authorName,300)||!(post.authorHandle===null||text(post.authorHandle,128))||!(post.avatarUrl===null||text(post.avatarUrl,4096))||!['replyCount','repostCount','likeCount'].every(key=>count(post[key]))||typeof post.likedByViewer!=='boolean'||typeof post.bookmarkedByViewer!=='boolean'||!(post.viewerRepostId===null||id(post.viewerRepostId))||post.referenced!==null||!Array.isArray(post.tags)||post.tags.length>32||!post.tags.every(tag=>text(tag,80))||!Array.isArray(post.images)||post.images.length!==op.imageIds.length)throw failure('feed_operation_unknown');
  const seen=new Set(),expected=new Set(op.imageIds);
  const images=post.images.map(image=>{
    if(!exact(image,['id','url','width','height','altText'])||!uuid(image.id)||!expected.has(image.id.toLowerCase())||seen.has(image.id.toLowerCase())||!text(image.url,4096)||!dimension(image.width,1600)||!dimension(image.height,1600)||!text(image.altText,600))throw failure('feed_operation_unknown');seen.add(image.id.toLowerCase());return Object.freeze({...image,id:image.id.toLowerCase()});
  });
  return Object.freeze({viewerId:raw.viewerId,clientRequestId:raw.clientRequestId,post:Object.freeze({...post,images:Object.freeze(images),tags:Object.freeze([...post.tags])}),scheduled:null});
}

/** One immutable, memory-only Hub submission. No persistence, polling or automatic resend. */
export function createFeedComposer({captureScope,scopeCurrent,current,getDraft,getDraftRevision,getViewRevision=()=>null,upload,submit,lookup,onAck=()=>{},onStatus=()=>{},randomUUID=()=>crypto.randomUUID(),now=()=>Date.now()}){
  if(![captureScope,scopeCurrent,current,getDraft,getDraftRevision,getViewRevision,upload,submit,lookup,onAck,onStatus,randomUUID,now].every(value=>typeof value==='function'))throw failure('feed_operation_invalid_controller');
  let operation=null,busy=false,destroyed=false,token={},state='idle';
  const owned=op=>!destroyed&&operation===op&&op.token===token;
  const scopeState=op=>{if(!owned(op))return false;try{return !op.source||scopeCurrent(op.source)===true;}catch{return null;}};
  const scoped=op=>scopeState(op)===true;
  const active=op=>{try{return !op.source||current(op.source)===true;}catch{return false;}};
  const live=op=>scoped(op)&&active(op)&&op.view===getViewRevision();
  function status(){return Object.freeze({busy,state,canRecheck:!busy&&['unknown','request_conflict','paused'].includes(state),canRetry:!busy&&['not_found','preparation_failed'].includes(state)});}
  function paint(op,next){if(op&&scopeState(op)===false)return;state=next;if(!op||live(op))onStatus(status());}
  function check(op){if(scopeState(op)===false)throw failure('feed_operation_scope_conflict');if(!live(op))throw failure('feed_operation_paused');}
  function input(op){return Object.freeze({body:op.draft.body,audience:op.draft.audience,imageIds:Object.freeze([...op.imageIds]),scheduledAt:op.draft.scheduledAt,clientRequestId:op.requestId});}
  function confirmed(op,receipt){
    check(op);let clearDraft=false;try{clearDraft=getDraftRevision()===op.revision&&sameDraft(getDraft(),op.draft);}catch{}
    busy=false;state='confirmed';onStatus(status());check(op);
    try{clearDraft=clearDraft&&getDraftRevision()===op.revision&&sameDraft(getDraft(),op.draft);}catch{clearDraft=false;}
    if(['cancelled','failed'].includes(receipt.scheduled?.status))clearDraft=false;
    operation=null;onAck(receipt,Object.freeze({clearDraft,kind:op.draft.kind,outcome:receipt.scheduled?.status??'posted',source:op.source}));return true;
  }
  async function deliver(op){
    try{
      for(let index=op.imageIds.length;index<op.draft.images.length;index++){
        check(op);paint(op,'preparing');const item=op.draft.images[index];
        check(op);const image=await item.blob.arrayBuffer();check(op);const thumbnail=await item.thumbnailBlob.arrayBuffer();check(op);
        if(Object.prototype.toString.call(image)!=='[object ArrayBuffer]'||image.byteLength<1||image.byteLength>2*1024*1024||Object.prototype.toString.call(thumbnail)!=='[object ArrayBuffer]'||thumbnail.byteLength<1||thumbnail.byteLength>512*1024)throw failure('feed_operation_invalid_image');
        const payload=Object.freeze({image:Object.freeze(Array.from(new Uint8Array(image))),thumbnail:Object.freeze(Array.from(new Uint8Array(thumbnail))),width:item.width,height:item.height,thumbnailWidth:item.thumbnailWidth,thumbnailHeight:item.thumbnailHeight,altText:'',expectedDeviceId:op.source.device,expectedOrigin:op.source.origin,expectedViewerId:op.source.viewer});
        check(op);op.phase='upload';paint(op,'uploading');check(op);const uploaded=await upload(payload,op.source);
        if(!scoped(op))throw failure('feed_operation_scope_conflict');
        if(!uploaded?.image||!uuid(uploaded.image.id)||op.imageIds.includes(uploaded.image.id.toLowerCase()))throw failure('feed_operation_unknown');op.imageIds.push(uploaded.image.id.toLowerCase());op.phase='prepare';check(op);
      }
      check(op);op.phase='post';paint(op,'publishing');check(op);const receipt=await submit(input(op),op.source);check(op);return confirmed(op,receiptValue(receipt,op,false));
    }catch(error){
      if(owned(op)&&scopeState(op)===false){invalidate();return false;}
      if(owned(op)){
        const code=String(error?.message??error),scopeConflict=code==='feed_operation_scope_conflict';
        if(scopeConflict){invalidate();return false;}
        paint(op,code==='feed_operation_preparation_failed'?'preparation_failed':op.phase==='post'?code==='feed_operation_request_conflict'?'request_conflict':'unknown':code==='feed_operation_paused'?'paused':op.phase==='upload'?'upload_unknown':'preparation_failed');
      }return false;
    }finally{if(operation===op){busy=false;if(live(op))onStatus(status());}}
  }
  async function begin(op){
    try{op.source=scopeValue(await captureScope());check(op);return await deliver(op);}
    catch(error){if(owned(op)&&String(error?.message)==='feed_operation_paused')paint(op,'paused');else if(owned(op)){operation=null;busy=false;state='scope_unavailable';onStatus(status());}return false;}
    finally{if(operation===op&&busy){busy=false;if(live(op))onStatus(status());}}
  }
  function send(){
    if(destroyed||busy||operation)return Promise.resolve(false);
    busy=true;let op;try{const revision=getDraftRevision(),draft=draftValue(getDraft(),now()),requestId=randomUUID();if(!uuid(requestId))throw failure('feed_operation_invalid_request');op={token,revision,view:getViewRevision(),draft,requestId:requestId.toLowerCase(),source:null,imageIds:[],phase:'prepare'};operation=op;paint(op,'preparing');}
    catch{busy=false;state='invalid_draft';onStatus(status());return Promise.resolve(false);}
    return begin(op);
  }
  async function recheck(){
    const op=operation;if(destroyed||busy||!['unknown','request_conflict','paused'].includes(state)||!op)return false;
    if(scopeState(op)===false){invalidate();return false;}if(!scoped(op)||!active(op))return false;op.view=getViewRevision();busy=true;paint(op,'checking');
    try{check(op);const result=await lookup(Object.freeze({clientRequestId:op.requestId,kind:op.draft.kind}),op.source);check(op);const receipt=receiptValue(result,op,true);if(receipt)return confirmed(op,receipt);paint(op,'not_found');return false;}
    catch{if(owned(op)&&scopeState(op)===false)invalidate();else if(owned(op))paint(op,'unknown');return false;}
    finally{if(operation===op){busy=false;if(live(op))onStatus(status());}}
  }
  function retry(){
    const op=operation;if(destroyed||busy||!op||!['not_found','preparation_failed'].includes(state))return Promise.resolve(false);
    if(scopeState(op)===false){invalidate();return Promise.resolve(false);}if(!scoped(op)||!active(op))return Promise.resolve(false);op.view=getViewRevision();busy=true;return deliver(op);
  }
  function invalidate(){token={};operation=null;busy=false;state='scope_changed';if(!destroyed)onStatus(status());}
  function abandonUpload(){
    const op=operation;if(destroyed||busy||state!=='upload_unknown'||!op||op.phase!=='upload')return false;
    if(scopeState(op)===false){invalidate();return false;}if(!scoped(op)||!active(op))return false;
    token={};operation=null;state='idle';onStatus(status());return true;
  }
  return{send,recheck,retry,status,invalidate,abandonUpload,refresh(){if(operation&&scopeState(operation)===false)invalidate();else if(!operation)onStatus(status());else if(!busy&&scoped(operation)&&active(operation)){operation.view=getViewRevision();onStatus(status());}},destroy(){if(destroyed)return;destroyed=true;token={};operation=null;busy=false;state='disposed';}};
}
