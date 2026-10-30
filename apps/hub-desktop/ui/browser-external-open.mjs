const tabsValue=value=>{
  if(!Array.isArray(value)||value.length>64)throw Error('browser_external_unavailable');
  const ids=new Set();
  for(const tab of value){
    if(!tab||typeof tab!=='object'||!Number.isSafeInteger(tab.id)||tab.id<=0||ids.has(tab.id)||typeof tab.active!=='boolean'||typeof tab.url!=='string'||tab.url.length>8192)throw Error('browser_external_unavailable');
    ids.add(tab.id);
  }
  if(value.filter(tab=>tab.active).length>1)throw Error('browser_external_unavailable');
  return value.map(tab=>({id:tab.id,active:tab.active,url:tab.url}));
};
const targetValue=value=>{
  if(typeof value!=='string'||!value.trim()||value.length>8192||/[\p{Cc}\ud800-\udfff]/u.test(value))throw Error('browser_external_invalid_url');
  const url=new URL(value.trim());
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)throw Error('browser_external_invalid_url');
  return url.href;
};
const bounded=async(promise,ms,code)=>{
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(code)),Math.max(1,ms));})]);}
  finally{clearTimeout(timer);}
};

/** One explicit external-link operation; ready polling is read-only and effects never retry. */
export function createBrowserExternalOpen({url,invoke,enter,isCurrent,canInspect=isCurrent,now=()=>performance.now(),pause=()=>new Promise(done=>setTimeout(done,50))}){
  let phase='idle',code=null,pending=null,inspection=null,baseline=new Set(),reuseId=null;
  const publish=(value,error=null)=>{phase=value;code=error;return value==='opened';};
  let target;try{target=targetValue(url);}catch{target=null;}
  const current=()=>{try{return isCurrent()===true;}catch{return false;}};
  const inspectable=()=>{try{return canInspect()===true;}catch{return false;}};
  const proof=rows=>reuseId!==null?rows.some(tab=>tab.id===reuseId&&tab.url===target):rows.filter(tab=>!baseline.has(tab.id)&&tab.url===target).length===1;
  async function openOnce(){
    if(!target)return publish('unavailable','browser_external_invalid_url');
    let sent=false;
    try{
      if(!current())return publish('superseded');
      const started=now();if(!Number.isFinite(started))return publish('unavailable','browser_external_unavailable');
      const preparation=promise=>bounded(promise,Math.min(5000,5000-(now()-started)),'browser_external_not_ready');
      const before=tabsValue(await preparation(invoke('browser_tabs')));if(!current())return publish('superseded');
      const source=before.find(tab=>tab.active)?.id??null;
      if(before.length&&source===null)return publish('unavailable','browser_external_unavailable');
      publish('preparing');await preparation(enter());if(!current())return publish('superseded');
      let ready;
      for(let reads=0;reads<101;reads++){
        const rows=tabsValue(await preparation(invoke('browser_tabs')));if(!current())return publish('superseded');
        const elapsed=now()-started;if(!Number.isFinite(elapsed)||elapsed<0||elapsed>=5000)return publish('unavailable','browser_external_not_ready');
        const active=rows.find(tab=>tab.active);
        if(source!==null&&active&&active.id!==source)return publish('superseded');
        if(active){
          if(before.length===0&&(rows.length!==1||active.url!==''))return publish('superseded');
          ready=rows;reuseId=before.length===0?active.id:null;break;
        }
        if(reads===100)return publish('unavailable','browser_external_not_ready');
        await pause();if(!current())return publish('superseded');
      }
      if(!ready)return publish('unavailable','browser_external_not_ready');
      baseline=new Set(ready.map(tab=>tab.id));if(!current())return publish('superseded');
      publish('opening');sent=true;
      if(reuseId!==null)await bounded(invoke('browser_navigate_from_address',{id:reuseId,url:target}),30000,'browser_external_outcome_unknown');
      else await bounded(invoke('browser_open_tab',{url:target,foreground:true}),30000,'browser_external_outcome_unknown');
      if(!current())return publish('unknown','browser_external_outcome_unknown');
      const rows=tabsValue(await bounded(invoke('browser_tabs'),5000,'browser_external_outcome_unknown'));if(!current())return publish('unknown','browser_external_outcome_unknown');
      return proof(rows)?publish('opened'):publish('unknown','browser_external_outcome_unknown');
    }catch(error){
      const reason=typeof error==='string'?error:error instanceof Error?error.message:'';
      const definite=new Set(['invalid_url','hub_origin_blocked','tab_limit','tab_not_found','browser_unavailable']);
      return publish(sent&&!definite.has(reason)?'unknown':'unavailable',sent&&!definite.has(reason)?'browser_external_outcome_unknown':reason==='browser_external_not_ready'?reason:'browser_external_unavailable');
    }
  }
  return Object.freeze({
    open(){pending??=openOnce();return pending;},
    status:()=>Object.freeze({state:phase,...(code?{code}:{})}),
    recheck(){
      if(phase!=='unknown'||!inspectable())return Promise.resolve(false);
      if(inspection)return inspection;
      inspection=Promise.resolve().then(async()=>{
        try{const rows=tabsValue(await bounded(invoke('browser_tabs'),5000,'browser_external_outcome_unknown'));if(!inspectable())return false;if(proof(rows))return publish('opened');}catch{}
        return false;
      }).finally(()=>{inspection=null;});return inspection;
    },
  });
}
