const invalid=()=>{throw Error('node_sync_invalid_response');};
const plain=value=>value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const closed=(value,keys)=>{if(!plain(value)||Reflect.ownKeys(value).some(key=>!keys.includes(key)))invalid();};
const unicode=value=>typeof value==='string'&&!/[\uD800-\uDFFF]/u.test(value);
const text=(value,max)=>unicode(value)&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const pattern=(value,expression)=>typeof value==='string'&&!/[\r\n]/u.test(value)&&expression.test(value);
const hex=value=>pattern(value,/^[a-f0-9]{64}$/u);
const fingerprint=value=>pattern(value,/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
const peerId=value=>pattern(value,/^peer-[a-f0-9]{64}$/u);
const contentId=value=>pattern(value,/^urn:hub:content:[a-f0-9]{32}$/u);
const eventId=value=>pattern(value,/^event:[a-f0-9]{32}$/u);
function origin(value){
  if(!text(value,2048)||value!==value.trim())return false;
  try{const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/u,'');
    return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&url.pathname==='/'&&!url.search&&!url.hash
      &&host.length>0&&host!=='localhost'&&!host.endsWith('.localhost')&&!host.endsWith('.local')&&!/^\d+(?:\.\d+){3}$/u.test(host)&&!host.includes(':');
  }catch{return false;}
}
function budget(value){let body;try{body=JSON.stringify(value);}catch{invalid();}if(!body||new TextEncoder().encode(body).length>512*1024)invalid();}
function preview(value,cursor){
  budget(value);closed(value,['context','items','page','queued','excluded']);
  if(!hex(value.context)||!Array.isArray(value.items)||value.items.length>16||!integer(value.queued)||!integer(value.excluded))invalid();
  closed(value.page,['cursor','nextCursor','truncated','scanned']);
  if(value.page.cursor!==cursor||!integer(value.page.cursor)||value.page.nextCursor!==null&&(!integer(value.page.nextCursor)||value.page.nextCursor<=cursor)
    ||typeof value.page.truncated!=='boolean'||!integer(value.page.scanned)||value.page.scanned>512||value.page.scanned<value.items.length)invalid();
  const sequences=new Set(),events=new Set();
  for(const item of value.items){closed(item,['sequence','contentId','portableEventId','bodyPreview','truncated','targets']);
    if(!integer(item.sequence,1)||sequences.has(item.sequence)||!contentId(item.contentId)||!eventId(item.portableEventId)||events.has(item.portableEventId)
      ||!unicode(item.bodyPreview)||item.bodyPreview.includes('\0')||[...item.bodyPreview].length>300||typeof item.truncated!=='boolean'||!Array.isArray(item.targets)||item.targets.length>8)invalid();
    sequences.add(item.sequence);events.add(item.portableEventId);const peers=new Set();
    for(const target of item.targets){closed(target,['peerId','nodeUrl','keyThumbprint','status']);
      if(!peerId(target.peerId)||peers.has(target.peerId)||!origin(target.nodeUrl)||!fingerprint(target.keyThumbprint)||!['waiting','unconfirmed','unavailable','accepted'].includes(target.status))invalid();peers.add(target.peerId);}
  }return structuredClone(value);
}
function nodeState(value){
  closed(value,['nodeId','deviceName','enabled','launchAtLogin','storagePath','hubUrl','syncState','publicKeyJwk','keyThumbprint','lastSyncAt','queuedItems','lastSyncConfirmed']);
  if(!pattern(value.nodeId,/^[a-f0-9]{32}$/u)||!text(value.deviceName,4096)||typeof value.enabled!=='boolean'||typeof value.launchAtLogin!=='boolean'
    ||!text(value.storagePath,32768)||!text(value.hubUrl,2048)||!['ready','syncing','error'].includes(value.syncState)
    ||value.lastSyncAt!==null&&!integer(value.lastSyncAt)||!integer(value.queuedItems)||value.lastSyncConfirmed!==undefined&&typeof value.lastSyncConfirmed!=='boolean')invalid();
  if(value.keyThumbprint!==undefined&&value.keyThumbprint!==null&&!fingerprint(value.keyThumbprint))invalid();
  if(value.publicKeyJwk!==undefined&&value.publicKeyJwk!==null){closed(value.publicKeyJwk,['kty','crv','x','y']);
    if(value.publicKeyJwk.kty!=='EC'||value.publicKeyJwk.crv!=='P-256'||!fingerprint(value.publicKeyJwk.x)||!fingerprint(value.publicKeyJwk.y))invalid();}
  return structuredClone(value);
}
function delivery(value,input){
  budget(value);closed(value,['context','sequence','portableEventId','peerId','status','complete','state']);
  if(['context','sequence','portableEventId','peerId'].some(key=>value[key]!==input[key])||!['accepted','already_accepted','unknown'].includes(value.status)||typeof value.complete!=='boolean')invalid();
  return {...structuredClone(value),state:nodeState(value.state)};
}
const eligible=target=>['waiting','unconfirmed'].includes(target.status);
const labels={waiting:'未送信',unconfirmed:'受領未確認',unavailable:'利用できない宛先',accepted:'受領確認済み'};

/** Preview existing approved destinations; only an explicit click delivers this page. */
export function createNodeSync({document,invoke,isMain,isCurrent,onState=()=>{},onInspectOriginal=()=>{}}){
  if(!document?.createElement||[invoke,isMain,isCurrent,onState,onInspectOriginal].some(value=>typeof value!=='function'))throw Error('node_sync_invalid_host');
  let disposed=false,busy=false,generation=0,data=null,unknown=null,loaded=false;const completed=new Set();
  const alive=()=>!disposed&&isMain()===true&&isCurrent()===true;
  const current=turn=>alive()&&generation===turn;
  const element=document.createElement('section');element.className='card detail-form';element.setAttribute('aria-label','Personal Nodeの同期');
  const make=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const button=(text,callback)=>{const node=make('button',text,'head-action');node.type='button';node.onclick=callback;return node;};
  const status=make('p','','meta');status.setAttribute('role','status');
  const content=make('div');
  const reload=button('受領状態を再確認',()=>{if(!busy)void(unknown?readReceipt():load(data?.page.cursor??0));});
  const send=button('確認した宛先へ送る',()=>void deliverPage());
  const next=button('次のページを確認',()=>{if(!busy&&!unknown&&loaded&&data&&data.page.nextCursor!==null)void load(data.page.nextCursor);});
  element.append(make('h3','保存済み原本の同期'),make('p','表示した原本と承認済み宛先を確認してから送信します。設定や以前の時刻だけでは受領確認になりません。','meta'),content,reload,send,next,status);
  const jobsFor=snapshot=>snapshot.items.flatMap(item=>{
    if(completed.has(item.sequence))return[];
    const pending=item.targets.filter(eligible),reconcile=!pending.length&&item.targets.length>0&&item.targets.every(target=>target.status==='accepted');
    return(reconcile?[item.targets[0]]:pending).map(target=>({context:snapshot.context,sequence:item.sequence,portableEventId:item.portableEventId,...target,reconcile}));
  });
  const sync=()=>{const disabled=busy||!alive(),jobs=data?jobsFor(data):[];reload.disabled=disabled;send.disabled=disabled||!!unknown||!loaded||!jobs.length;next.disabled=disabled||!!unknown||!loaded||!data||data.page.nextCursor===null;
    send.textContent=jobs.length&&jobs.every(job=>job.reconcile)?'受領記録を反映':jobs.some(job=>job.reconcile)?'確認した配信先と受領記録を処理':'確認した宛先へ送る';
    for(const node of content.querySelectorAll('button'))node.disabled=disabled;};
  function render(){
    content.replaceChildren();if(!data)return;
    content.append(make('p',`待ち ${data.queued}件 · 対象外 ${data.excluded}件 · このページ ${data.items.length}件（確認 ${data.page.scanned}件）`,'meta'));
    if(data.page.truncated)content.append(make('p','表示は一部です。続きは次のページで確認してください。','meta'));
    if(!data.items.length)content.append(make('p','このページに送信できる原本はありません。対象外・未承認の残件は送信しません。','meta'));
    for(const item of data.items){const article=make('article',undefined,'card'),turn=generation;
      article.append(make('h4',`原本 ${item.sequence}`),make('p',item.bodyPreview,'detail-p'));
      if(item.truncated)article.append(make('p','本文は先頭300文字までの表示です。原本で全文を確認してください。','meta'));
      article.append(button('原本を確認',()=>{if(!busy&&current(turn)){try{Promise.resolve(onInspectOriginal(item.sequence)).catch(()=>{if(current(turn))status.textContent='原本を開けませんでした。';});}catch{status.textContent='原本を開けませんでした。';}}}));
      if(!item.targets.length)article.append(make('p','承認済みの保存先がありません。送信対象外です。','meta'));
      for(const target of item.targets){article.append(make('p',target.nodeUrl,'meta'),make('p',`公開鍵の指紋: ${target.keyThumbprint}`,'meta'),make('p',labels[target.status],'meta'));}
      content.append(article);
    }
    sync();
  }
  async function load(cursor){
    if(!alive()||busy||unknown)return;const turn=++generation;busy=true;loaded=false;sync();status.textContent='保存済みの原本と宛先を確認しています。';
    try{const value=await invoke('node_sync_control',{action:'preview',cursor});if(!current(turn))return;const fresh=preview(value,cursor);
      status.textContent='原本とすべての保存先を確認してから送信してください。全体の同期完了を示すものではありません。';
      data=fresh;loaded=true;completed.clear();render();
    }catch{if(current(turn))status.textContent=unknown?'受領状態を確認できません。再送と次の送信は行いません。':'同期プレビューを取得できませんでした。再確認してください。';}
    finally{if(current(turn)){busy=false;sync();}}
  }
  async function readReceipt(){
    if(!alive()||busy||!unknown)return;const turn=generation,job=structuredClone(unknown);
    const input={context:job.context,sequence:job.sequence,portableEventId:job.portableEventId,peerId:job.peerId,nodeUrl:job.nodeUrl,keyThumbprint:job.keyThumbprint,confirmed:false};
    busy=true;sync();status.textContent='送信せずに、保存された受領証拠を確認しています。';
    try{const raw=await invoke('node_sync_control',{action:'receipt',input});if(!current(turn))return;const result=delivery(raw,input);
      if(result.status==='accepted')invalid();
      if(result.status==='unknown'){status.textContent='先ほどの宛先の受領はまだ確認できません。再送と次の送信は行いません。';return;}
      unknown=null;if(result.complete)completed.add(job.sequence);
      const item=data?.items.find(item=>item.sequence===job.sequence&&item.portableEventId===job.portableEventId);
      const target=item?.targets.find(target=>target.peerId===job.peerId&&target.nodeUrl===job.nodeUrl&&target.keyThumbprint===job.keyThumbprint);
      if(target)target.status='accepted';
      try{onState(result.state);}catch{}
      if(!current(turn))return;
      busy=false;await load(data?.page.cursor??0);
      if(alive()&&generation===turn+1&&loaded&&!unknown)status.textContent='先ほどの宛先の受領を確認しました。残る宛先へ送るにはもう一度確認して操作してください。';
    }catch{if(current(turn))status.textContent='受領証拠を確認できません。再送と次の送信は行いません。';}
    finally{if(current(turn)){busy=false;sync();}}
  }
  async function deliverPage(){
    if(!alive()||busy||unknown||!loaded||!data)return;
    const snapshot=structuredClone(data),jobs=jobsFor(snapshot);
    if(!jobs.length)return;const turn=generation;busy=true;sync();let accepted=0;
    for(const job of jobs){if(!current(turn))break;if(completed.has(job.sequence))continue;
      const input={context:job.context,sequence:job.sequence,portableEventId:job.portableEventId,peerId:job.peerId,nodeUrl:job.nodeUrl,keyThumbprint:job.keyThumbprint,confirmed:true};
      status.textContent=job.reconcile?`受領記録を反映しています（${accepted+1}/${jobs.length}）。`:`確認した宛先へ送っています（${accepted+1}/${jobs.length}）。`;
      try{const raw=await invoke('node_sync_control',{action:'deliver',input});if(!current(turn))break;const result=delivery(raw,input);
        if(result.status==='unknown'){unknown=job;break;}
        accepted++;data.items.find(item=>item.sequence===job.sequence).targets.find(target=>target.peerId===job.peerId).status='accepted';if(result.complete)completed.add(job.sequence);
        try{onState(result.state);}catch{}
      }catch{if(current(turn))unknown=job;break;}
    }
    if(current(turn)){busy=false;render();status.textContent=unknown?`${accepted}件の受領を確認しました。続く宛先の結果は不明です。再送と次の送信を止めました。受領状態を再確認してください。`:
      `このページで${accepted}件の受領を確認しました。対象外・未承認・他ページの残件は含みません。`;sync();}
  }
  const ready=Promise.resolve().then(()=>load(0));sync();
  return Object.freeze({element,ready,destroy(){if(disposed)return;disposed=true;generation++;for(const node of element.querySelectorAll('button'))node.onclick=null;data=null;unknown=null;element.remove();}});
}
