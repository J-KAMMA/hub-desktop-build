const id=v=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[^A-Za-z0-9_-]/u.test(v);
const uuid=v=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const imageId=v=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(v);
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>record(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const count=v=>Number.isSafeInteger(v)&&v>=0;
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const code=e=>typeof e==='string'?e:e?.code??e?.message;
const scopeError=e=>['dm_scope_conflict','dm_scope_changed','desktop_account_changed','desktop_not_connected'].includes(code(e));
// Native emits dm_rejected:400 only for its packet check before sending.
// Other send HTTP failures have an unknown outcome; never discard their ID.
const rejected=e=>['dm_rejected:400','dm_rejected:409','dm_invalid_request','dm_request_too_large'].includes(code(e));
const readDenied=e=>scopeError(e)||['dm_rejected:403','dm_rejected:404'].includes(code(e));
const same=(a,b)=>!!a&&!!b&&a.key===b.key&&a.generation===b.generation;
function scopeValue(v){
  if(v===null)return null;
  if(!exact(v,['key','generation'])||typeof v.key!=='string'||!((typeof v.generation==='string'&&v.generation.length<=128)||count(v.generation)))throw Error('dm_scope_invalid');
  const pair=JSON.parse(v.key);if(!Array.isArray(pair)||pair.length!==2||JSON.stringify(pair)!==v.key||typeof pair[0]!=='string'||pair[0].length>512||!id(pair[1]))throw Error('dm_scope_invalid');
  const url=new URL(pair[0]);if(!['http:','https:'].includes(url.protocol)||url.origin!==pair[0]||url.username||url.password)throw Error('dm_scope_invalid');
  return{...v,origin:pair[0],deviceId:pair[1]};
}
function messageValue(v){
  if(!record(v)||!id(v.id)||!id(v.conversationId)||!id(v.senderProfileId)||!text(v.previewText,280)||typeof v.encryptedPayload!=='string'||!text(v.encryptionVersion,128)||!['sealed','draft'].includes(v.encryptionState)||!text(v.createdAt,128))throw Error('dm_unknown');
  if(v.images!==undefined&&(!Array.isArray(v.images)||v.images.length>4||new Set(v.images.map(x=>x?.id)).size!==v.images.length||v.images.some(x=>!record(x)||!imageId(x.id)||!text(x.altText,1000)||!Number.isSafeInteger(x.width)||x.width<=0||!Number.isSafeInteger(x.height)||x.height<=0||typeof x.url!=='string'||typeof x.fullUrl!=='string')))throw Error('dm_unknown');
  return v;
}
function dataValue(v){
  if(!exact(v,['currentProfileId','conversations','messages','profiles','messageCount'])||!id(v.currentProfileId)||!count(v.messageCount)||!Array.isArray(v.conversations)||v.conversations.length>100||!Array.isArray(v.messages)||v.messages.length>299||!Array.isArray(v.profiles)||v.profiles.length>200||new TextEncoder().encode(JSON.stringify(v)).length>2097152)throw Error('dm_unknown');
  const conversations=new Set(),messages=new Set(),profiles=new Set();
  for(const row of v.conversations){
    if(!record(row)||!id(row.id)||conversations.has(row.id)||!Array.isArray(row.participantIds)||row.participantIds.length<2||row.participantIds.length>200||new Set(row.participantIds).size!==row.participantIds.length||row.participantIds.some(x=>!id(x))||!row.participantIds.includes(v.currentProfileId)||typeof row.isE2ee!=='boolean'||!['verified','unverified'].includes(row.verificationStatus)||!text(row.fingerprint,1000)||!record(row.unreadCountByProfileId)||Object.entries(row.unreadCountByProfileId).some(([k,n])=>!id(k)||!row.participantIds.includes(k)||!count(n))||!text(row.lastMessageAt,128))throw Error('dm_unknown');conversations.add(row.id);
  }
  for(const row of v.messages){messageValue(row);const conversation=v.conversations.find(x=>x.id===row.conversationId);if(messages.has(row.id)||!conversation||!conversation.participantIds.includes(row.senderProfileId))throw Error('dm_unknown');messages.add(row.id);}
  for(const row of v.profiles){if(!record(row)||!id(row.id)||profiles.has(row.id)||!text(row.displayName,1000)||!text(row.handle,1000))throw Error('dm_unknown');profiles.add(row.id);}
  return structuredClone(v);
}
function draftValue(v){
  if(!exact(v,['text','images','revision'])||!text(v.text,280)||!Array.isArray(v.images)||v.images.length>4||!((typeof v.revision==='string'&&v.revision.length<=128)||count(v.revision))||(!v.text.trim()&&!v.images.length))throw Error('dm_invalid_request');
  return{text:v.text,images:[...v.images],revision:v.revision};
}
const unchanged=(draft,current)=>record(current)&&current.text===draft.text&&current.revision===draft.revision&&Array.isArray(current.images)&&current.images.length===draft.images.length&&current.images.every((x,i)=>x===draft.images[i]);
async function expectedMessageId(viewer,conversation,requestId){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['hub-dm-send-v1',viewer,conversation,requestId])));return'dm-'+Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');}

/** No DOM, persistent drafts, authority claims or automatic message retries. */
export function createDmController({invoke,getScope,isCurrent,getDraft,onData=()=>{},onState=()=>{},onSent=()=>{},onClearDraft=()=>{},onSelection=()=>{},uploadFiles,requestId=()=>crypto.randomUUID()}){
  if([invoke,getScope,isCurrent,getDraft,onData,onState,onSent,onClearDraft,onSelection,requestId].some(x=>typeof x!=='function')||uploadFiles!==undefined&&typeof uploadFiles!=='function')throw Error('dm_controller_invalid');
  let destroyed=false,epoch=0,revision=0,owner=null,viewer=null,data=null,selected=null,loading=null,writing=null;
  const tickets=new WeakMap(),attempts=new Map();
  const active=()=>{try{return!destroyed&&isCurrent()===true;}catch{return false;}};
  const current=job=>active()&&job.epoch===epoch&&same(job.scope,owner)&&job.viewer===viewer&&job.conversation===selected;
  const attempt=()=>selected?attempts.get(selected):null;
  let phase='idle',stateError;
  function state(next,error){phase=next;stateError=error;if(active())onState({phase,pending:!!loading||!!writing,conversationId:selected,readFailed:phase==='read_error',attemptState:attempt()?.status??null,uncertain:attempt()?.status==='unknown',retryAvailable:attempt()?.status==='unknown'&&attempt()?.rechecked===true,...(error===undefined?{}:{error})});}
  function invalidate(reason='account'){
    if(destroyed)return;epoch++;revision++;data=null;selected=null;loading=null;writing=null;
    if(reason!=='view'){owner=null;viewer=null;attempts.clear();}else for(const a of attempts.values())if(a.status==='pending'){a.status='unknown';a.rechecked=false;}
    onData(null,{ticket:null,conversationId:null,reason});if(!destroyed)onState({phase:'idle',pending:false,conversationId:null,readFailed:false,attemptState:null,uncertain:false,retryAvailable:false});
  }
  function capture(){if(!active()||!data||loading)return null;const ticket=Object.freeze({});tickets.set(ticket,{epoch,revision,scope:owner,viewer,conversation:selected});return ticket;}
  function isTicketCurrent(ticket){const t=ticket&&tickets.get(ticket);return!!t&&active()&&!!data&&!loading&&t.epoch===epoch&&t.revision===revision&&same(t.scope,owner)&&t.viewer===viewer&&t.conversation===selected;}
  function emit(){if(active()&&data&&!loading){const ticket=capture();onData(structuredClone(data),{ticket,conversationId:selected});}}
  function choose(conversation){if(selected!==conversation){selected=conversation;revision++;onSelection(conversation);}}
  async function fresh(job){
    let scope;try{scope=scopeValue(await getScope());}catch{scope=null;}
    if(!current(job))return false;if(!same(scope,job.scope)){invalidate(scope?'scope':'account');return false;}return true;
  }
  function setOwner(scope){if(owner&&!same(scope,owner)){invalidate('scope');}owner=scope;}
  async function read(conversation,expected=null){
    if(!active()||conversation!==undefined&&conversation!==null&&!id(conversation))return false;
    const job={epoch,revision:++revision};loading=job;state('loading');
    const valid=()=>active()&&loading===job&&epoch===job.epoch&&revision===job.revision;
    try{
      const scope=scopeValue(await getScope());if(!valid())return false;if(!scope){invalidate('account');return false;}
      if(expected&&!same(scope,expected.scope)){invalidate('scope');return false;}
      if(owner&&!same(scope,owner)){const old=loading;setOwner(scope);job.epoch=epoch;job.revision=++revision;loading=old;}else owner=scope;
      if(!valid())return false;
      const pinned=expected?.viewer??viewer;
      const raw=await invoke('hub_detail',{name:'dm_snapshot',ids:[scope.deviceId,scope.origin,conversation??'',...(pinned?[pinned]:[])]});
      if(!valid())return false;const after=scopeValue(await getScope());if(!valid())return false;if(!same(scope,after)){invalidate('scope');return false;}
      const result=dataValue(raw);if(pinned&&result.currentProfileId!==pinned){invalidate('scope');return false;}
      if(conversation&&!result.conversations.some(x=>x.id===conversation))throw Error('dm_conversation_unavailable');
      viewer=result.currentProfileId;data=result;selected=conversation??null;loading=null;
      for(const a of attempts.values())if(same(a.scope,owner)&&a.viewer===viewer)a.epoch=epoch;
      emit();state('ready');return true;
    }catch(error){if(valid()){loading=null;if(readDenied(error)){invalidate('scope');return false;}emit();state('error',error);}return false;}
    finally{if(loading===job){loading=null;state('error','dm_unknown');}}
  }
  async function load(conversation){
    if(writing)return false;const chosen=conversation??selected;
    const ok=await read(chosen);if(!ok)return false;
    // The list's server default is not an explicit selected-thread snapshot.
    if(!chosen&&data.conversations.length){const first=data.conversations[0].id;choose(first);return read(first,{scope:owner,viewer});}return true;
  }
  async function select(conversation,ticket){
    if(!active()||writing||loading||!data||!id(conversation)||(ticket!==undefined&&!isTicketCurrent(ticket))||!data.conversations.some(x=>x.id===conversation))return false;
    const expected={scope:owner,viewer};choose(conversation);if(!await read(conversation,expected))return false;
    const job={epoch,scope:owner,viewer,conversation};writing=job;state('reading');
    try{
      if(!await fresh(job))return false;
      const result=await invoke('hub_client_action',{action:'read_conversation',target:conversation,options:options(job)});
      if(!await fresh(job))return false;
      if(record(result)&&id(result.viewerId)&&result.viewerId!==job.viewer)throw Error('dm_scope_conflict');
      if(!exact(result,['viewerId','conversationId','unreadCount'])||result.viewerId!==job.viewer||result.conversationId!==conversation||!count(result.unreadCount))throw Error('dm_unknown');
      writing=null;return read(conversation,expected);
    }catch(error){if(current(job)){writing=null;if(scopeError(error)){invalidate('scope');return false;}await read(conversation,expected);if(active()&&same(owner,expected.scope)&&viewer===expected.viewer&&selected===conversation)state('read_error',error);}return false;}
    finally{if(writing===job){writing=null;state(phase,stateError);}}
  }
  function options(job){return{expectedDeviceId:job.scope.deviceId,expectedOrigin:job.scope.origin,expectedViewerId:job.viewer};}
  function matching(message,a){return message.id===a.messageId&&message.conversationId===a.conversation&&message.senderProfileId===a.viewer&&message.previewText===a.text&&message.encryptionVersion==='plaintext-v1'&&message.encryptionState==='sealed'&&message.encryptedPayload===''&&JSON.stringify((message.images??[]).map(x=>x.id).sort())===JSON.stringify([...a.imageIds].sort());}
  function confirmed(a,message,fromLookup=false){
    if(!current(a))return false;attempts.delete(a.conversation);onSent(structuredClone(message),capture(),{fromLookup});
    if(current(a)&&unchanged(a.draft,getDraft()))onClearDraft({...a.draft,images:[...a.draft.images]});state('sent');return true;
  }
  async function deliver(a){
    if(!current(a)||writing)return false;
    if(data?.conversations.find(x=>x.id===a.conversation)?.isE2ee!==false){state('error','dm_e2ee_unavailable');return false;}
    writing=a;a.rechecked=false;state('sending');
    try{
      if(!await fresh(a))return false;
      const result=await invoke('hub_client_action',{action:'send_message',target:a.conversation,text:a.text,requestId:a.requestId,options:{...options(a),...(a.imageIds.length?{imageIds:[...a.imageIds]}:{})}});
      if(!await fresh(a))return false;
      if(record(result)&&id(result.viewerId)&&result.viewerId!==a.viewer)throw Error('dm_scope_conflict');
      if(!exact(result,['viewerId','message'])||result.viewerId!==a.viewer)throw Error('dm_unknown');messageValue(result.message);if(!matching(result.message,a))throw Error('dm_unknown');
      writing=null;const ok=confirmed(a,result.message);if(ok&&current(a))await read(a.conversation,{scope:a.scope,viewer:a.viewer});return ok;
    }catch(error){if(current(a)){writing=null;if(scopeError(error)){invalidate('scope');return false;}a.status=rejected(error)?'rejected':'unknown';if(a.status==='rejected'&&code(error)!=='dm_rejected:409')attempts.delete(a.conversation);state(a.status,error);}return false;}
    finally{if(writing===a){writing=null;state(a.status??'unknown');}}
  }
  async function send(){
    if(!active()||writing||loading||!data||!selected||attempt())return false;
    if(attempts.size>=16){state('error','dm_pending_limit');return false;}
    let draft;try{draft=draftValue(getDraft());}catch(error){state('error',error);return false;}
    const job={epoch,scope:owner,viewer,conversation:selected};writing=job;state('preparing');
    try{
      if(!await fresh(job))return false;
      // Revalidate current participation/E2EE before any upload or send.
      if(!await read(job.conversation,{scope:job.scope,viewer:job.viewer})||!current(job))return false;
      if(data.conversations.find(x=>x.id===selected)?.isE2ee)throw Error('dm_e2ee_unavailable');
      const request=requestId();if(!uuid(request))throw Error('dm_invalid_request');
      const messageId=await expectedMessageId(job.viewer,job.conversation,request);
      if(!current(job))return false;
      let images=[];
      if(draft.images.length){
        if(!uploadFiles)throw Error('dm_upload_unavailable');
        images=await uploadFiles([...draft.images],{conversationId:job.conversation,scope:{key:job.scope.key,generation:job.scope.generation},isCurrent:()=>current(job),assertCurrent:()=>{if(!current(job))throw Error('dm_scope_changed');},invoke:async(command,args)=>{
          if(command!=='hub_upload_dm_image')throw Error('dm_invalid_request');if(!await fresh(job))throw Error('dm_scope_changed');
          const result=await invoke(command,{...args,...options(job)});if(!await fresh(job))throw Error('dm_scope_changed');return result;
        }});
      }
      if(!current(job)||!await fresh(job))return false;
      if(!Array.isArray(images)||images.length!==draft.images.length||images.some(x=>!imageId(x))||new Set(images).size!==images.length)throw Error('dm_unknown');
      const a={...job,draft,requestId:request,text:draft.text.trim(),imageIds:Object.freeze([...images]),messageId,status:'pending',rechecked:false};
      if(!current(job))return false;attempts.set(job.conversation,a);writing=null;return deliver(a);
    }catch(error){if(current(job)){if(scopeError(error))invalidate('scope');else state('error',error);}return false;}
    finally{if(writing===job){writing=null;state(phase,stateError);}}
  }
  async function recheck(){
    const a=attempt();if(!a||a.status!=='unknown'||writing||loading||!current(a))return false;
    a.rechecked=false;if(!await read(a.conversation,{scope:a.scope,viewer:a.viewer})||!current(a))return false;
    const message=data.messages.find(x=>x.id===a.messageId);
    if(message){if(matching(message,a))return confirmed(a,message,true);state('conflict','dm_request_conflict');return false;}
    a.rechecked=true;state('unknown','dm_unknown');return false;
  }
  async function retrySame(){const a=attempt();if(!a||a.status!=='unknown'||!a.rechecked||writing||loading||!current(a))return false;return deliver(a);}
  function destroy(){if(destroyed)return;invalidate('destroy');destroyed=true;attempts.clear();}
  return{load,select,send,recheck,retrySame,capture,isTicketCurrent,invalidate,destroy};
}
