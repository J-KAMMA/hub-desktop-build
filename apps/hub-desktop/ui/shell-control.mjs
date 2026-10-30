const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ranges = {feed:[1,3],notifications:[4,8],market:[9,11],settings:[12,15],music:[1,0],node:[1,0],search:[1,0],videos:[1,0],wallet:[1,0],ai:[1,0],articles:[1,0],threads:[1,0],research:[1,0],messages:[1,0],saved_articles:[1,0],video_library:[1,0],music_library:[1,0],video_playlists:[1,0],music_playlists:[1,0]};
const view = value => typeof value === 'string' && Object.hasOwn(ranges,value);
const idFor = (name,id) => view(name) && Number.isInteger(id) && id >= ranges[name][0] && id <= ranges[name][1];
export const validShellLayout = value => exact(value,['view','sidebarOpen','railOpen']) && view(value.view) && typeof value.sidebarOpen === 'boolean' && typeof value.railOpen === 'boolean';
export function validShellState(value) {
  const keys=['view','sidebarOpen','railOpen','sidebarWidth','railWidth','sidebarSelected','nativeRevision','nativeIds'];
  if(value && typeof value==='object' && Object.hasOwn(value,'aiSurface'))keys.push('aiSurface');
  return exact(value,keys)
    && (value.view === null || view(value.view)) && typeof value.sidebarOpen === 'boolean' && typeof value.railOpen === 'boolean'
    && (!Object.hasOwn(value,'aiSurface') || value.aiSurface === null || value.view === 'ai' && ['legacy','preparing','workspace_required','failed'].includes(value.aiSurface))
    && Number.isFinite(value.sidebarWidth) && value.sidebarWidth >= 190 && value.sidebarWidth <= (value.view === 'ai' ? 8192 : 260)
    && Number.isFinite(value.railWidth) && value.railWidth >= 240 && value.railWidth <= 480
    && (value.sidebarSelected === 0 || idFor(value.view,value.sidebarSelected))
    && Number.isSafeInteger(value.nativeRevision) && value.nativeRevision >= 0
    && Array.isArray(value.nativeIds) && value.nativeIds.length <= 5 && new Set(value.nativeIds).size === value.nativeIds.length
    && (!value.nativeIds.length || value.nativeRevision > 0) && value.nativeIds.every(id => idFor(value.view,id));
}
/** Main-only ACK admission and control opt-in are enforced by Rust. */
export function initShellControl({listen,invoke,canInspect,canLayout,applyLayout,readState,now=Date.now}) {
  let disposed=false,active=null,lastRequest=0,unlisten;
  const ack=(requestId,outcome,state=null)=>{try{return Promise.resolve(invoke('shell_control_ack',{requestId,outcome,state})).catch(()=>{});}catch{return Promise.resolve();}};
  async function receive(payload) {
    const time=now();
    if(disposed || !exact(payload,['requestId','expiresAt','layout']) || !Number.isSafeInteger(payload.requestId) || payload.requestId <= lastRequest
      || !Number.isSafeInteger(payload.expiresAt) || !Number.isSafeInteger(time) || time < 0 || payload.expiresAt <= time || payload.expiresAt-time > 10_000
      || (payload.layout !== null && !validShellLayout(payload.layout))) return;
    lastRequest=payload.requestId;
    if(active) { await ack(payload.requestId,'failed'); return; }
    const request={...payload,layout:payload.layout && {...payload.layout}};active=request;
    const alive=()=>!disposed && active===request && now()<request.expiresAt;
    const remaining=()=>Math.max(0,request.expiresAt-now());
    let outcome='failed',state=null;
    try {
      if(!canInspect() || (request.layout && !canLayout())) throw Error('unavailable');
      if(request.layout) await applyLayout(request.layout,alive,remaining);
      if(!alive()) outcome='superseded';
      else {
        const current=readState();
        if(!validShellState(current)) throw Error('invalid_state');
        if(request.layout && (!canLayout() || ['view','sidebarOpen','railOpen'].some(key=>current[key]!==request.layout[key]))) outcome='superseded';
        else { outcome='applied';state={...current,nativeIds:[...current.nativeIds]}; }
      }
    } catch { outcome='failed'; }
    finally { if(active===request) active=null; }
    if(!disposed) await ack(request.requestId,outcome,state);
  }
  const ready=Promise.resolve().then(()=>listen('shell-control',event=>void receive(event.payload))).then(stop=>{
    if(disposed) stop?.();else unlisten=stop;
  }).catch(()=>{});
  return {ready,destroy(){disposed=true;active=null;unlisten?.();}};
}
