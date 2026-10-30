const id=value=>typeof value==='string'&&value.length>=1&&value.length<=128&&!/[^A-Za-z0-9_-]/u.test(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,keys)=>record(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const count=value=>Number.isSafeInteger(value)&&value>=0;
const sameScope=(left,right)=>left&&right&&left.key===right.key&&left.generation===right.generation;
function scopeValue(value){
  if(value===null)return null;if(!exact(value,['key','generation'])||typeof value.key!=='string'||value.key.length>4096||!count(value.generation))throw Error('notification_scope_invalid');
  const pair=JSON.parse(value.key);if(!Array.isArray(pair)||pair.length!==2||JSON.stringify(pair)!==value.key||typeof pair[0]!=='string'||pair[0].length>512||!id(pair[1]))throw Error('notification_scope_invalid');
  const url=new URL(pair[0]);if(!['http:','https:'].includes(url.protocol)||url.origin!==pair[0]||url.username||url.password)throw Error('notification_scope_invalid');return{...value,deviceId:pair[1],origin:pair[0]};
}
function dataValue(value){
  if(!exact(value,['viewerId','notifications','unreadCount','actors','threadPostDestinations','communityMessageDestinations'])||!id(value.viewerId)||!count(value.unreadCount)||!Array.isArray(value.notifications)||value.notifications.length>200||!Array.isArray(value.actors)||value.actors.length>200||!record(value.threadPostDestinations)||!record(value.communityMessageDestinations))throw Error('notification_unknown');
  const ids=new Set();for(const item of value.notifications){if(!record(item)||!id(item.id)||ids.has(item.id)||typeof item.isRead!=='boolean')throw Error('notification_unknown');ids.add(item.id);}
  if(new TextEncoder().encode(JSON.stringify(value)).length>2097152)throw Error('notification_unknown');return structuredClone(value);
}
const errorCode=error=>typeof error==='string'?error:error?.code??error?.message;
const denied=error=>['notification_scope_conflict','desktop_not_connected','desktop_account_changed','notification_rejected:403'].includes(errorCode(error));

/** Native and the managed API verify the echoed viewer; actor/recipient display metadata grants no authority. */
export function createNotificationsController({invoke,getScope,isCurrent,onData=()=>{},onState=()=>{},onBadge=()=>{},onChanged=()=>{}}){
  if([invoke,getScope,isCurrent,onData,onState,onBadge,onChanged].some(value=>typeof value!=='function'))throw Error('notification_controller_invalid');
  let destroyed=false,epoch=0,requestRevision=0,dataRevision=0,adoptRevision=-1,freshRevision=-1,ownerScope=null,viewerId=null,data=null,loading=null,writing=null;
  const tickets=new WeakMap(),uncertain=new Map();
  const active=()=>{try{return !destroyed&&isCurrent()===true;}catch{return false;}};
  const pending=()=>!!loading||!!writing;
  function state(phase,error){if(!destroyed)onState({phase,pending:pending(),...(error===undefined?{}:{error})});}
  function invalidate(reason='scope'){
    if(destroyed)return;epoch++;requestRevision++;dataRevision++;adoptRevision=-1;freshRevision=-1;data=null;loading=null;writing=null;uncertain.clear();
    // Retain this source's viewer pin until a genuinely different registered scope is observed.
    onData(null,null);onBadge(null,null);state(reason==='unconnected'?'unconnected':'idle');
  }
  function checkActive(){if(active())return true;if(!destroyed&&(data||loading||writing))invalidate('view');return false;}
  function isTicketCurrent(ticket){
    const value=ticket&&tickets.get(ticket);return !!value&&checkActive()&&!!data&&value.epoch===epoch&&value.requestRevision===requestRevision&&adoptRevision===requestRevision&&value.dataRevision===dataRevision&&value.viewerId===viewerId&&sameScope(value.scope,ownerScope);
  }
  function capture(ids){
    if(!checkActive()||!data||adoptRevision!==requestRevision)return null;const chosen=ids===undefined?data.notifications.map(item=>item.id):ids;
    if(!Array.isArray(chosen)||chosen.length>200||new Set(chosen).size!==chosen.length||chosen.some(value=>!id(value)||!data.notifications.some(item=>item.id===value)))return null;
    const ticket=Object.freeze({});tickets.set(ticket,{epoch,requestRevision,dataRevision,scope:{...ownerScope},viewerId,ids:Object.freeze([...chosen])});return ticket;
  }
  function emit(){
    if(!checkActive()||!data||adoptRevision!==requestRevision)return;const ticket=capture();onData(structuredClone(data),ticket);if(isTicketCurrent(ticket))onBadge(data.unreadCount,ticket);
  }
  const loadCurrent=job=>!destroyed&&loading===job&&epoch===job.epoch&&requestRevision===job.revision&&checkActive();
  const writeCurrent=job=>!destroyed&&writing===job&&isTicketCurrent(job.ticket);
  async function freshWrite(job){
    let value;try{value=scopeValue(await getScope());}catch{value=null;}if(!writeCurrent(job))return null;
    if(!value||!sameScope(value,job.scope)){invalidate(value?'scope':'unconnected');return null;}return value;
  }
  function replaceOwner(scope){
    if(ownerScope&&!sameScope(ownerScope,scope)){data=null;viewerId=null;adoptRevision=-1;freshRevision=-1;dataRevision++;writing=null;uncertain.clear();onData(null,null);onBadge(null,null);}
    ownerScope=scope;
  }
  function reconcile(){
    let changed=false,unconfirmed=false;for(const[key,item]of uncertain){
      if(!sameScope(item.scope,ownerScope)||item.viewerId!==viewerId){uncertain.delete(key);continue;}
      const row=item.kind==='one'?data.notifications.find(row=>row.id===item.id):null;
      const confirmed=item.kind==='one'?row?.isRead===true:data.unreadCount===0&&data.notifications.every(row=>row.isRead);
      if(confirmed){uncertain.delete(key);changed=true;}
      else if(item.kind==='one'&&!row){uncertain.delete(key);unconfirmed=true;}
      else item.rechecked=true;
    }return{changed,unconfirmed};
  }
  async function performLoad(expectedScope=null,expectedViewer=null){
    if(!checkActive())return false;const job={epoch,revision:++requestRevision,phase:'error',error:undefined};loading=job;adoptRevision=-1;dataRevision++;state('loading');
    try{
      const scope=scopeValue(await getScope());if(!loadCurrent(job))return false;
      if(!scope){invalidate('unconnected');return false;}
      if(expectedScope&&!sameScope(scope,expectedScope)){invalidate('scope');return false;}
      replaceOwner(scope);if(!loadCurrent(job))return false;job.scope={...scope};job.viewerId=expectedViewer??viewerId;
      const raw=await invoke('hub_detail',{name:'notification_snapshot',ids:[scope.deviceId,scope.origin,...(job.viewerId===null?[]:[job.viewerId])]});
      if(!loadCurrent(job))return false;const fresh=scopeValue(await getScope());if(!loadCurrent(job))return false;
      if(!sameScope(scope,fresh)){invalidate(fresh?'scope':'unconnected');return false;}
      const result=dataValue(raw);if(viewerId!==null&&viewerId!==result.viewerId||job.viewerId!==null&&job.viewerId!==result.viewerId){invalidate('scope');return false;}
      viewerId=result.viewerId;data=result;adoptRevision=job.revision;freshRevision=job.revision;dataRevision++;const recovery=reconcile();emit();
      if(!loadCurrent(job))return false;if(recovery.changed)onChanged(capture());job.phase=uncertain.size||recovery.unconfirmed?'uncertain':'ready';state(job.phase);return true;
    }catch(error){
      if(!loadCurrent(job))return false;if(denied(error)){invalidate(errorCode(error)==='desktop_not_connected'?'unconnected':'scope');state('error',error);return false;}
      let fresh;try{fresh=scopeValue(await getScope());}catch{fresh=null;}if(!loadCurrent(job))return false;
      if(!fresh||job.scope&&!sameScope(fresh,job.scope)||ownerScope&&!sameScope(fresh,ownerScope)){invalidate(fresh?'scope':'unconnected');return false;}
      if(data){adoptRevision=job.revision;dataRevision++;emit();}job.phase=uncertain.size?'uncertain':'error';job.error=error;if(loadCurrent(job))state(job.phase,error);return false;
    }finally{if(loading===job){loading=null;if(active())state(job.phase,job.error);}}
  }
  function load(){return performLoad();}
  async function mark(kind,notificationId,ticket){
    if(!isTicketCurrent(ticket)||loading||writing||kind==='one'&&!id(notificationId))return false;
    const source=tickets.get(ticket);if(kind==='one'&&!source.ids.includes(notificationId))return false;
    const key=kind==='all'?'all':`one:${notificationId}`,old=uncertain.get(key);if(old&&!old.rechecked){state('uncertain');return false;}
    const job={ticket,scope:{...source.scope},viewerId:source.viewerId,kind,id:notificationId};writing=job;state(uncertain.size?'uncertain':'ready');let recheck=false,confirmed=false,unknown=false;
    try{
      const fresh=await freshWrite(job);if(!fresh)return false;
      if(kind==='one'&&data.notifications.find(item=>item.id===notificationId)?.isRead)confirmed=true;
      else{
        const raw=await invoke('hub_client_action',{action:kind==='one'?'read_notification':'read_all_notifications',...(kind==='one'?{target:notificationId}:{}),options:{expectedDeviceId:fresh.deviceId,expectedOrigin:fresh.origin,expectedViewerId:source.viewerId}});
        if(!writeCurrent(job)||!await freshWrite(job))return false;
        if(!exact(raw,['viewerId','unreadCount'])||!id(raw.viewerId)||!count(raw.unreadCount))throw Error('notification_unknown');
        if(raw.viewerId!==source.viewerId){invalidate('scope');return false;}
        data={...data,unreadCount:raw.unreadCount,notifications:data.notifications.map(item=>kind==='all'||item.id===notificationId?{...item,isRead:true}:item)};uncertain.delete(key);emit();
        if(writeCurrent(job))onChanged(capture());confirmed=true;recheck=kind==='all';
      }
    }catch(error){
      if(!writeCurrent(job))return false;if(denied(error)){invalidate(errorCode(error)==='desktop_not_connected'?'unconnected':'scope');state('error',error);return false;}
      uncertain.set(key,{kind,id:notificationId,scope:{...source.scope},viewerId:source.viewerId,rechecked:false});state('uncertain',error);recheck=true;unknown=true;
    }finally{
      if(writing===job){writing=null;if(recheck&&active())await performLoad(job.scope,job.viewerId);else if(active())state(uncertain.size?'uncertain':data?'ready':'idle');}
    }
    if(!active()||!sameScope(ownerScope,job.scope)||viewerId!==job.viewerId||!data)return false;
    if(unknown)return freshRevision===requestRevision&&(kind==='one'?data.notifications.find(item=>item.id===notificationId)?.isRead===true:data.unreadCount===0&&data.notifications.every(item=>item.isRead));
    return confirmed&&(recheck||isTicketCurrent(ticket));
  }
  return{load,capture,isTicketCurrent,markOne:(notificationId,ticket)=>mark('one',notificationId,ticket),markAll:ticket=>mark('all',null,ticket),invalidate,
    destroy(){if(destroyed)return;invalidate('disposed');destroyed=true;ownerScope=null;viewerId=null;onState({phase:'disposed',pending:false});}};
}
