import {isTransientReadError} from './hub-read-recovery.mjs';
import {createPeerCatalog,peerReadText} from './hub-peer-catalog.mjs';
import {createSourceSync,normalizeHubOrigin} from './hub-network-sync.mjs';
import {contentShareReference} from './content-share-contract.mjs';
export {normalizeHubOrigin} from './hub-network-sync.mjs';
const paths={post:'/v2#compose',research:'/v2/research'};
const titles={post:'投稿',research:'プロジェクト作成'};
export function hubCatalogResearchQuery(value='') {
  if(typeof value!=='string'||value.length>100||/[\u0000-\u001f\u007f-\u009f]/.test(value)||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))throw Error('検索語は100文字・8語以内で、制御文字を含めず指定してください。');
  const query=value.trim();if(query&&query.split(/\s+/u).length>8)throw Error('検索語は100文字・8語以内で指定してください。');return query;
}
export function mergeHubItems(groups) {
  return [...new Map(groups.flatMap(group=>group.items.map(item=>({...item,origin:group.origin}))).map(item=>[`${item.origin}\n${item.id}`,item])).values()]
    .sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0));
}
export function createHubNetwork({document,invoke,storage,changed,openWeb,manage,openResearchFork,onShare,isCurrent=()=>true,getAccount=()=>({state:"signed_out"})}) {
  let base='',sources=[],sourceScope='',epoch=0,sync,peers;
  const reads={post:0,research:0,music:0,video:0},errors={post:[],research:[],music:[],video:[]},failedOrigins={post:[],research:[],music:[],video:[]};
  const selected={post:'all',research:'all',music:'all',video:'all'},bars=new Map(); // music and video have no bar: their home shelves read every connected Hub
  const invalidateRead=kind=>{reads[kind]++;errors[kind]=[];failedOrigins[kind]=[];const bar=bars.get(kind);if(bar){bar.status.textContent='';bar.retryRead.hidden=true;bar.retryRead.disabled=false;}};
  const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
  const origins=()=>[base,...sources].filter(Boolean);
  const paintPeers=(container,state)=>{
    const list=node('ul');list.setAttribute('aria-label','同じHubプロフィールの端末');
    for(const peer of state.peers){const row=node('li');row.append(node('span',`${peer.label} · ${peer.id.slice(0,6)}`),node('span',peer.status==='connected'?'接続中':peer.status==='connecting'?'接続を試行中':'待機中'));list.append(row);}
    container.replaceChildren(node('p',`${state.connected}台に接続${state.status==='waiting_account'?' · ログイン状態を確認しています':state.status==='reconnecting'?' · 再接続しています':state.status==='unavailable'?' · ログインと接続状態を確認してください':!state.enabled?' · 共有は停止中です':''}`),list);
    if(state.enabled&&!state.peers.length)container.append(node('p','別の端末で同じHubプロフィールにログインし、公開投稿の共有を許可すると表示されます。'));
    container.append(node('p','追加したHubの公開投稿一覧が対象です。端末に投稿がない場合は配信元Hubから取得します。'));
  };
  const label=origin=>new URL(origin).host;
  const update=()=>{
    for(const [kind,bar] of bars){
      for(const select of [bar.filter,bar.destination]){const value=select.value;select.replaceChildren();if(select===bar.filter)select.append(new document.defaultView.Option('すべてのHub','all'));for(const origin of origins())select.append(new document.defaultView.Option(label(origin),origin));select.value=[...select.options].some(o=>o.value===value)?value:select===bar.filter?'all':base;}
      selected[kind]=bar.filter.value;if(bar.peerPanel)bar.peerPanel.hidden=!sources.length;
      bar.hint.textContent=`この画面での作成は ${label(base)} に保存します。別のHubには以下のWeb画面から保存します。`;
    }
    list.replaceChildren(...sources.map(origin=>{const row=node('div',null,'hub-network-source');const remove=node('button','接続を外す');remove.type='button';remove.disabled=!sync||sync.state.busy||!['local','synced'].includes(sync.state.mode);remove.onclick=async()=>{try{await sync.change('remove',origin);}catch(error){notice.textContent=error.message;}};row.append(node('span',label(origin)),remove);return row;}));
    if(!sources.length)list.append(node('p','追加したHubはありません。URLで接続先を追加できます。','meta'));
  };

  const manager=node('section',null,'card hub-network-manager');manager.id='hub-network-manager';manager.append(node('h3','接続するHub'),node('p','同じHubプロフィールで接続先を共有できます。ログイン情報は他のHubへ渡しません。公開一覧は各Hubから直接取得します。','meta'));
  const form=node('form'),input=node('input'),add=node('button','追加');input.type='url';input.required=true;input.placeholder='https://community.example';input.setAttribute('aria-label','接続するHubのURL');add.type='submit';form.append(input,add);const notice=node('p',null,'meta');notice.setAttribute('role','status');const list=node('div');const retry=node('button','接続先を再取得'),migrate=node('button','この端末の接続先を引き継ぐ'),legacy=node('p',null,'meta');retry.type=migrate.type='button';migrate.hidden=true;add.disabled=true;retry.onclick=()=>sync?.refresh();migrate.onclick=async()=>{try{await sync.migrate();}catch(error){notice.textContent=error.message;}};manager.append(form,notice,retry,legacy,migrate,list);const nodeView=document.querySelector('#view-node');if(nodeView?.querySelector('.view-head'))nodeView.querySelector('.view-head').after(manager);else nodeView?.prepend(manager);
  const scope=node('select');scope.setAttribute('aria-label','接続先の管理方法');scope.append(new document.defaultView.Option('プロフィールで共有','profile'),new document.defaultView.Option('この端末で管理（ログイン不要）','device'));scope.disabled=true;const scopeLabel=node('label','接続先の管理方法');scopeLabel.append(scope);const scopeHint=node('p','端末での管理とプロフィール共有は別の一覧です。切り替えても接続先を自動で転送しません。','meta');form.before(scopeLabel,scopeHint);scope.onchange=async()=>{try{await sync.setScope(scope.value);}catch(error){notice.textContent=error.message;scope.value=sync.state.scope;}};
  form.onsubmit=async event=>{event.preventDefault();const accountKey=()=>sync?.state.scope==='device'?'device':JSON.stringify([getAccount()?.state,getAccount()?.deviceId,sync?.state.scope]);const actor=accountKey();add.disabled=true;notice.textContent='接続を確認しています…';try{const origin=normalizeHubOrigin(input.value);if(origins().includes(origin))throw Error('すでに接続しています。');if(sources.length>=8)throw Error('追加の接続先は8件までです。');await invoke('hub_network_read',{origin,kind:'post'});if(actor!==accountKey())throw Error('アカウントが変わりました。追加する接続先をもう一度確認してください。');await sync.change('add',origin);input.value='';}catch(error){notice.textContent=String(error.message??error);}finally{add.disabled=!sync||sync.state.busy||!['local','synced'].includes(sync.state.mode);}};
  for(const [kind,target] of [['post',document.querySelector('#view-feed')],['research',document.querySelector('#view-research')]]){
    if(!target)continue;
    const bar=node('section',null,kind==='research'?'hub-network-bar filter-row':'hub-network-bar'),filter=node('select'),destination=node('select'),status=node('span',null,'meta');
    filter.setAttribute('aria-label',`${titles[kind]}の表示元`);destination.setAttribute('aria-label',`${titles[kind]}の保存先`);
    const retryRead=node('button','再取得');retryRead.type='button';retryRead.dataset.hubRetry=kind;retryRead.setAttribute('aria-label',`${titles[kind]}の追加Hubを再取得`);retryRead.hidden=true;retryRead.onclick=()=>{if(retryRead.disabled)return;retryRead.disabled=true;changed(kind);};
    const controls=node('div',null,'hub-network-controls'),filterLabel=node('label','表示元');
    filterLabel.append(filter);
    const details=node('details',null,'hub-network-options'),summary=node('summary','接続・保存先');
    const options=node('div',null,'hub-network-options-body');
    const edit=node('button','接続するHubを管理');edit.type='button';edit.onclick=()=>manage();
    const heading=node('strong',`${titles[kind]}の保存先`),hint=node('p','選んだHubのWeb画面でログインして保存します。','meta');
    const create=node('button',`${titles[kind]}の画面を開く`);create.type='button';
    create.onclick=()=>{const origin=destination.value;if(origins().includes(origin))openWeb(origin+paths[kind]);};
    options.append(edit,heading,hint,destination,create);details.append(summary,options);controls.append(filterLabel,details);
    status.setAttribute('role','status');
    const feedback=node('div',null,'hub-network-feedback');feedback.append(status,retryRead);
    bar.append(controls,feedback);const tools=kind==='research'?target.querySelector('.research-index-tools'):null;if(tools)tools.append(bar);else target.querySelector('.view-head')?.after(bar);
    let peerPanel,peerSummary,peerDetails;
    if(kind==='post'){peerPanel=node('details',null,'hub-peer-status');peerSummary=node('summary','公開投稿の取得はまだありません。');peerDetails=node('div');const settings=node('button','端末間共有の設定');settings.type='button';settings.onclick=()=>manage();peerPanel.append(peerSummary,peerDetails,settings);peerPanel.hidden=true;options.append(peerPanel);}
    bars.set(kind,{filter,destination,status,hint,retryRead,peerPanel,peerSummary,peerDetails});filter.onchange=()=>{selected[kind]=filter.value;reads[kind]++;status.textContent='';retryRead.hidden=true;changed(kind);};
  }
  const ready=invoke('hub_origin').then(async origin=>{
    base=normalizeHubOrigin(origin);
    sync=createSourceSync({base,invoke,storage,getAccount,onChange:state=>{
      const different=JSON.stringify(sources)!==JSON.stringify(state.sources)||sourceScope!==state.scope;sources=state.sources;sourceScope=state.scope;
      if(different){epoch++;for(const bar of bars.values()){bar.status.textContent='';bar.retryRead.hidden=true;}}
      scope.value=state.scope;scope.disabled=state.busy;notice.textContent=state.message;add.disabled=state.busy||!['local','synced'].includes(state.mode);
      retry.disabled=state.busy;migrate.hidden=!state.legacy.length;migrate.disabled=state.busy||state.mode!=='synced';
      legacy.textContent=state.legacy.length?`この端末だけに保存したHub: ${state.legacy.map(label).join('、')}`:'';
      update();if(different)for(const kind of Object.keys(selected))changed(kind);
    }});
    if(typeof RTCPeerConnection==='function'){
      peers=createPeerCatalog({base,storage,label:'Hub Desktop',
        control:input=>{const a=getAccount();if(!a)return Promise.reject(Error('account_pending'));if(a.state!=='registered')return Promise.reject(Error('account_required'));return invoke('hub_post_peer_control',{expectedDeviceId:a.deviceId,input});},
        readCatalog:origin=>invoke('hub_network_read',{origin,kind:'post'}),
        readManifest:origin=>invoke('hub_post_manifest',{origin}),
      });
      const panel=node('section',null,'card hub-network-manager'),title=node('h3','自分の端末から公開投稿を取得'),copy=node('p','同じHubプロフィールで許可した端末同士を自動接続します。接続先Hubで閲覧した公開投稿だけを共有し、つながらなければ配信元Hubから取得します。','meta'),privacy=node('p','接続相手と接続補助サービスにIPアドレスが伝わります。DM・非公開投稿・端末内ファイルは共有しません。','meta'),toggle=node('button','この端末の公開投稿共有を許可'),retryPeer=node('button','接続を再確認'),status=node('p',null,'meta');
      panel.id='public-post-peers';toggle.type=retryPeer.type='button';status.setAttribute('role','status');panel.append(title,copy,privacy,toggle,retryPeer,status);manager.after(panel);
      const readStatus=node('p',null,'meta'),devices=node('details',null,'hub-peer-status'),deviceDetails=node('div');devices.append(node('summary','端末の接続状況'),deviceDetails);panel.append(readStatus,devices);
      peers.subscribe(state=>{readStatus.textContent=peerReadText(state.lastRead);paintPeers(deviceDetails,state);const feed=bars.get('post');if(feed?.peerSummary){feed.peerSummary.textContent=peerReadText(state.lastRead);paintPeers(feed.peerDetails,state);}toggle.textContent=state.enabled?'この端末の共有を停止':'この端末の公開投稿共有を許可';toggle.disabled=getAccount()?.state!=='registered';retryPeer.hidden=state.status!=='unavailable';status.textContent=state.status==='waiting_account'?'この端末のログイン状態を確認しています…':state.status==='reconnecting'?'接続が戻り次第、自動で再接続します。投稿は配信元Hubから取得します。':state.status==='unavailable'?'ログインと接続状態を確認してください。投稿は配信元Hubから取得します。':state.enabled?`${state.connected}台に接続 · 端末からの取得 ${state.viaPeer}回`:'端末間共有は停止中です。';});
      toggle.onclick=async()=>{toggle.disabled=true;try{await peers.setEnabled(!peers.state.enabled);}catch(error){status.textContent=String(error.message??error);}finally{toggle.disabled=getAccount()?.state!=='registered';}};
      retryPeer.onclick=()=>void peers.refresh();void peers.refresh();
      document.defaultView.addEventListener('storage',event=>{if(event.storageArea===storage&&(!event.key||event.key.startsWith(`hub.public-post-peers.v1.${encodeURIComponent(base)}.`)))void peers.syncConsent();});
      document.defaultView.addEventListener('online',()=>{if(peers.state.status==='reconnecting')void peers.refresh();});
      document.defaultView.addEventListener('pagehide',()=>void peers.dispose());
    }
    document.defaultView.addEventListener('hub-origin-changed',()=>{epoch++;for(const kind of Object.keys(reads))invalidateRead(kind);});
    document.defaultView.addEventListener('hub-account-changed',()=>{epoch++;for(const kind of Object.keys(reads))invalidateRead(kind);void sync.refresh();void peers?.refresh();});
    document.defaultView.addEventListener('focus',()=>{void sync.refresh();if(peers?.state.status==='reconnecting')void peers.refresh();});
    document.defaultView.addEventListener('pagehide',()=>sync.dispose(),{once:true});
    void sync.refresh(); // Cached sources are usable while the account request is pending.
  }).catch(()=>{notice.textContent='標準Hubの接続先を取得できませんでした。';});
  return {
    ready,
    context:kind=>JSON.stringify([epoch,selected[kind]]),
    errors:kind=>[...errors[kind]],
    failedOrigins:(kind,transientOnly=false)=>failedOrigins[kind].filter((_origin,index)=>!transientOnly||isTransientReadError(errors[kind][index])),
    includePrimary:kind=>selected[kind]==='all'||selected[kind]===base,
    invalidate:invalidateRead,
    async load(kind,query=''){const term=kind==='research'?hubCatalogResearchQuery(query):'',read=++reads[kind];await ready;if(read!==reads[kind])return [];const version=epoch;const targets=sources.filter(origin=>selected[kind]==='all'||selected[kind]===origin);const bar=bars.get(kind);if(bar){bar.status.textContent=targets.length?'各Hubを確認しています…':'';bar.retryRead.disabled=true;}
      const results=await Promise.allSettled(targets.map(async origin=>{const catalog=await (kind==='post'&&peers?peers.read(origin):invoke('hub_network_read',{origin,kind,...(kind==='research'&&term?{query:term}:{})}));if(kind==='research'&&(catalog.query!==undefined&&catalog.query!==term||term&&catalog.query!==term))throw Error('このHubは指定した研究検索に対応していません。');return {origin,items:catalog.items};}));
      if(version!==epoch||read!==reads[kind])return [];
      failedOrigins[kind]=results.flatMap((r,i)=>r.status==='rejected'?[targets[i]]:[]);
      errors[kind]=results.flatMap(r=>r.status==='rejected'?[r.reason]:[]);
      const failures=results.flatMap((r,i)=>r.status==='rejected'?[label(targets[i])]:[]),received=targets.length-failures.length;
      if(bar){bar.status.textContent=failures.length?received?`${failures.join('、')} は接続できません。${received}/${targets.length} Hubの内容を表示しています。`:`追加Hubの内容を取得できませんでした（${failures.join('、')}）。`:targets.length?`${targets.length} Hubから取得 · 各Hub最大30件`:'';bar.retryRead.hidden=!failures.length;bar.retryRead.disabled=false;}
      return mergeHubItems(results.filter(r=>r.status==='fulfilled').map(r=>r.value));
    },
    card(item){
      let origin='',reference=null;
      try{origin=normalizeHubOrigin(item.origin);const match=typeof item.path==='string'&&item.path.match(/^\/v2\/(posts|research)\/([A-Za-z0-9_-]{1,128})$/);if(origin===item.origin&&match&&match[2]===item.id)reference=contentShareReference(origin+item.path);}catch{/* Invalid catalog references cannot open or share. */}
      const frozen=Object.freeze({...item,origin}),kind=reference?.kind==='project'?'research':reference?.kind;
      const version=epoch,read=reads[kind],selection=selected[kind];
      const actor=()=>JSON.stringify([getAccount()?.state,getAccount()?.deviceId,sync?.state.scope]),owner=actor();
      const card=node('article',null,'card hub-network-card');card.dataset.hubOrigin=origin;
      const sourceAvailable=()=>!failedOrigins[kind]?.includes(origin);
      const guard=()=>!!reference&&sourceAvailable()&&isCurrent(kind)&&version===epoch&&read===reads[kind]&&selection===selected[kind]&&owner===actor()&&sources.includes(origin)&&(selected[kind]==='all'||selected[kind]===origin)&&card.isConnected;
      const canOpen=()=>onShare?guard():!!reference&&sourceAvailable()&&isCurrent(kind)&&origins().includes(origin);
      const heading=node('h3',frozen.title),body=node('p',frozen.summary),source=node('span',origin?label(origin):'Hub','meta'),open=node('button','元のHubで開く ↗');
      open.type='button';open.disabled=!reference||!sourceAvailable();open.onclick=()=>{if(canOpen())openWeb(reference.href);};card.append(source,heading,body,open);
      if(openResearchFork&&reference?.kind==='project'&&/^rp_[a-f0-9]{32}$/.test(frozen.id)){
        const fork=node('button','自分のHubへfork');fork.type='button';fork.disabled=!sourceAvailable();fork.onclick=()=>{if(canOpen()&&sources.includes(origin))return openResearchFork(frozen);};card.append(fork);
      }
      if(typeof onShare==='function'&&reference){
        const share=node('button','投稿で紹介');share.type='button';share.disabled=!sourceAvailable();let busy=false;
        share.onclick=async()=>{if(busy||!guard())return;busy=true;share.disabled=true;try{await onShare({href:reference.href,title:frozen.title,isCurrent:guard});return guard();}finally{busy=false;if(guard())share.disabled=false;}};
        card.append(share);
      }
      return card;
    },
  };
}

