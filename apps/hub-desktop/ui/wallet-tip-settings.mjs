const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
const id=value=>typeof value==='string'&&value.length>=1&&value.length<=128&&!/[^A-Za-z0-9_-]/u.test(value);
const clean=(value,max)=>typeof value==='string'&&value.length<=max&&!/\p{Cc}|\p{Surrogate}/u.test(value);
const address=value=>typeof value==='string'&&value.length===42&&/^0x[0-9a-fA-F]{40}$/u.test(value);
const networks=new Map([[1,'ETH'],[137,'POL'],[80002,'POL'],[8453,'ETH'],[42161,'ETH'],[10,'ETH']]);
function scopeValue(value){
  if(value===null)return null;
  if(!exact(value,['key','generation'])||!Number.isSafeInteger(value.generation)||value.generation<0||typeof value.key!=='string'||value.key.length>4096)throw Error('wallet_tip_scope_invalid');
  const pair=JSON.parse(value.key);if(!Array.isArray(pair)||pair.length!==2||!clean(pair[0],512)||!id(pair[1])||JSON.stringify(pair)!==value.key)throw Error('wallet_tip_scope_invalid');
  const url=new URL(pair[0]);if(!['http:','https:'].includes(url.protocol)||url.origin!==pair[0]||url.username||url.password)throw Error('wallet_tip_scope_invalid');
  return{...value,origin:pair[0],deviceId:pair[1]};
}
const sameScope=(left,right)=>left&&right&&left.key===right.key&&left.generation===right.generation;
const rowKey=row=>`${row.chainId}:${row.address.toLowerCase()}`;
function amount(value){
  if(typeof value!=='string'||value.length<1||value.length>100||!/^[0-9]+(?:\.[0-9]{0,18})?$/u.test(value)||/\p{Cc}/u.test(value))throw Error('wallet_tip_amount_invalid');
  const [whole,fraction='']=value.split('.'),wei=BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,'0'));
  if(wei>(1n<<256n)-1n)throw Error('wallet_tip_amount_invalid');
  const tail=(wei%10n**18n).toString().padStart(18,'0').replace(/0+$/u,'');return `${wei/10n**18n}${tail?'.'+tail:''}`;
}
function rowValue(value){
  if(!exact(value,['address','chainId','network','symbol','tipsEnabled','minimumAmount','visibility'])||!address(value.address)||!networks.has(value.chainId)||!clean(value.network,120)||!value.network||value.symbol!==networks.get(value.chainId)||typeof value.tipsEnabled!=='boolean'||!['public','private'].includes(value.visibility))throw Error('wallet_tip_row_invalid');
  return{...value,minimumAmount:amount(value.minimumAmount)};
}
function settingsValue(value){
  if(!exact(value,['viewerId','links'])||!id(value.viewerId)||!Array.isArray(value.links)||value.links.length>100)throw Error('wallet_tip_settings_invalid');
  const links=value.links.map(rowValue);if(new Set(links.map(rowKey)).size!==links.length||new TextEncoder().encode(JSON.stringify(value)).length>262144)throw Error('wallet_tip_settings_invalid');
  return{viewerId:value.viewerId,links};
}
function receiptValue(value,operation){
  if(!exact(value,['viewerId','address','chainId','tipsEnabled','minimumAmount','visibility','symbol'])||value.viewerId!==operation.viewerId||!address(value.address)||value.chainId!==operation.row.chainId||rowKey(value)!==operation.key||typeof value.tipsEnabled!=='boolean'||!['public','private'].includes(value.visibility)||value.symbol!==operation.row.symbol)throw Error('wallet_tip_receipt_invalid');
  return{...value,minimumAmount:amount(value.minimumAmount)};
}
function matches(row,operation){
  if(!row||rowKey(row)!==operation.key||row.symbol!==operation.row.symbol)return false;
  const desired=operation.desired;
  if(Object.hasOwn(desired,'enabled'))return row.tipsEnabled===desired.enabled&&row.visibility===(desired.enabled?'public':'private');
  return row.minimumAmount===desired.minimumAmount&&row.tipsEnabled===operation.row.tipsEnabled&&row.visibility===operation.row.visibility;
}

export function createWalletTipSettings({document,invoke,getScope,isCurrent}){
  if(!document||[invoke,getScope,isCurrent].some(value=>typeof value!=='function'))throw Error('wallet_tip_host_invalid');
  const make=(tag,label,className='')=>{const node=document.createElement(tag);node.className=className;if(label!==undefined)node.textContent=label;return node;};
  const element=make('details',undefined,'wallet-section wallet-tip-settings');element.append(make('summary','チップの受取設定'));
  const form=make('form',undefined,'detail-form'),status=make('p','','wallet-note'),addressNote=make('p','','wallet-note'),previewBox=make('section',undefined,'detail-form');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const select=make('select');select.name='walletTipAddress';select.setAttribute('aria-label','受取アドレス');
  const minimum=make('input');minimum.type='text';minimum.name='walletTipMinimum';minimum.inputMode='decimal';minimum.maxLength=100;minimum.setAttribute('aria-label','最低受取額');
  const enabled=make('input');enabled.type='checkbox';enabled.name='walletTipEnabled';
  const label=(text,node)=>{const item=make('label',undefined,'field');item.append(make('span',text,'wallet-note'),node);return item;};
  const enabledLabel=make('label',undefined,'check');enabledLabel.append(enabled,document.createTextNode('チップを受け取る'));
  const actions=make('div',undefined,'actions'),buttons={};
  const button=(name,label,action)=>{const node=make('button',label,'head-action');node.type='button';node.dataset.tipSettingsAction=name;node.onclick=()=>{if(current()&&!busy&&!node.disabled)void Promise.resolve().then(action).catch(()=>{if(current())status.textContent='設定を確認できません。入力は保持しています。';});};actions.append(node);buttons[name]=node;return node;};
  form.append(make('p','本人確認済みのアドレスの受取設定です。この設定で資産は移動しません。','wallet-note'),label('受取アドレス',select),addressNote,enabledLabel,label('最低受取額',minimum),actions,previewBox,status);element.append(form);
  let destroyed=false,invalidated=false,busy=false,epoch=0,scope=null,viewerId=null,links=[],loaded=false,selectedKey='',revision=0,preview=null,intent=null,retryReady=false,rejectionChecked=false;
  const drafts=new Map();
  const current=()=>{try{return !destroyed&&!invalidated&&element.isConnected&&isCurrent()===true;}catch{return false;}};
  const selected=()=>links.find(row=>rowKey(row)===selectedKey);
  const capturedCurrent=(captured,turn)=>current()&&epoch===turn&&sameScope(scope,captured);
  function invalidate(message='接続や本人情報が変わりました。受取設定を開き直してください。'){
    if(destroyed||invalidated)return;invalidated=true;epoch++;scope=null;viewerId=null;links=[];drafts.clear();preview=null;intent=null;loaded=false;select.replaceChildren();minimum.value='';enabled.checked=false;addressNote.textContent='';previewBox.replaceChildren();status.textContent=message;paint();
  }
  async function fresh(captured=scope,turn=epoch){
    if(!current())return null;let next;try{next=scopeValue(await getScope());}catch{next=null;}
    if(!current()||turn!==epoch)return null;
    if(!next){if(scope)invalidate('Hubへの接続を確認できません。受取設定を開き直してください。');else status.textContent='受取設定の保存にはHubへの接続が必要です。';return null;}
    if(captured&&!sameScope(captured,next)){invalidate();return null;}if(!scope)scope=next;return next;
  }
  function paint(){
    const available=current()&&loaded&&!!scope&&!!selected();
    for(const node of Object.values(buttons))node.disabled=!available||busy;
    buttons.reload.disabled=!current()||busy;buttons.reload.hidden=busy;
    select.disabled=!available||busy||!!intent;minimum.disabled=!available||busy||!!intent;enabled.disabled=!available||busy||!!intent;
    buttons.enable.disabled=!available||busy||!!intent;buttons.minimum.disabled=!available||busy||!!intent;
    buttons.confirm.hidden=!preview||!!intent;buttons.confirm.disabled=!available||busy||!preview||preview.revision!==revision;
    buttons.cancel.hidden=!preview||!!intent;
    buttons.retry.hidden=!intent||intent.status!=='unknown';buttons.retry.disabled=!available||busy||!retryReady;
    buttons.review.hidden=!intent||intent.status!=='rejected';buttons.review.disabled=!available||busy||!rejectionChecked;
    element.setAttribute('aria-busy',String(busy));
  }
  function displaySelection(){
    const row=selected();if(!row){minimum.value='';enabled.checked=false;addressNote.textContent='';return;}
    const draft=drafts.get(selectedKey)??{minimumAmount:row.minimumAmount,enabled:row.tipsEnabled};drafts.set(selectedKey,draft);
    minimum.value=draft.minimumAmount;enabled.checked=draft.enabled;addressNote.textContent=`${row.network} · ${row.symbol} · ${row.address} · ${row.visibility==='public'?'公開':'非公開'}`;
  }
  function adopt(value){
    if(viewerId!==null&&value.viewerId!==viewerId){invalidate();throw Error('wallet_tip_viewer_changed');}viewerId=value.viewerId;
    const previous=new Map(links.map(row=>[rowKey(row),row])),visible=new Set(value.links.map(rowKey));
    for(const row of value.links){const key=rowKey(row),draft=drafts.get(key),old=previous.get(key);if(draft&&old)drafts.set(key,{enabled:draft.enabled===old.tipsEnabled?row.tipsEnabled:draft.enabled,minimumAmount:draft.minimumAmount===old.minimumAmount?row.minimumAmount:draft.minimumAmount});}
    for(const key of drafts.keys())if(!visible.has(key)&&key!==intent?.key)drafts.delete(key);
    links=value.links;loaded=true;select.replaceChildren();
    for(const row of links){const option=make('option',`${row.network} · ${row.symbol} · ${row.address.slice(0,8)}…${row.address.slice(-6)}`);option.value=rowKey(row);select.append(option);}
    if(!links.some(row=>rowKey(row)===selectedKey))selectedKey=intent?intent.key:links[0]?rowKey(links[0]):'';
    select.value=selectedKey;displaySelection();
  }
  const detail=captured=>invoke('hub_detail',{name:'wallet_tip_settings',ids:[captured.deviceId,captured.origin]});
  function confirmed(row){
    const old=intent;intent=null;preview=null;retryReady=false;rejectionChecked=false;previewBox.replaceChildren();
    if(revision===old.revision){const draft=drafts.get(old.key)??{enabled:row.tipsEnabled,minimumAmount:row.minimumAmount};drafts.set(old.key,{...draft,...(Object.hasOwn(old.desired,'enabled')?{enabled:row.tipsEnabled}:{minimumAmount:row.minimumAmount})});}displaySelection();status.textContent='希望した受取設定を確認しました。';
  }
  async function read(){
    if(busy||!current())return false;busy=true;paint();status.textContent=intent?'保存済みの設定を再確認しています…':'受取設定を読み込んでいます…';const turn=epoch;
    try{const captured=await fresh();if(!captured)return false;const raw=await detail(captured);if(!capturedCurrent(captured,turn)||!await fresh(captured,turn))return false;
      const value=settingsValue(raw);adopt(value);if(!current())return false;
      if(intent){const row=value.links.find(row=>rowKey(row)===intent.key);retryReady=!!row;rejectionChecked=!!row;
        if(matches(row,intent))confirmed(row);else status.textContent=row?'希望した設定は確認できません。表示した状態を確認して、同じ設定だけを再試行できます。':'対象のアドレスを確認できません。受取設定を開き直してください。';}
      else status.textContent=links.length?'現在の受取設定を確認しました。':'本人確認済みのアドレスはありません。';return true;
    }catch(error){if(current()){const code=typeof error==='string'?error:error?.code??error?.message;if(['desktop_not_connected','desktop_account_changed'].includes(code))invalidate();else{loaded=false;retryReady=false;rejectionChecked=false;status.textContent='受取設定を取得できませんでした。入力を保持して再確認できます。';}}return false;}
    finally{busy=false;if(current())paint();}
  }
  function showPreview(plan){
    preview=plan;previewBox.replaceChildren(make('strong',plan.mode==='enable'?'受取設定の確認':'最低受取額の確認'),make('p',`${plan.row.network} · ${plan.row.symbol} · ${plan.row.address}`,'wallet-note'));
    if(plan.mode==='minimum')previewBox.append(make('p',`最低受取額: ${plan.desired.minimumAmount} ${plan.row.symbol}`),make('p','最低額だけを変更します。受取の有効・停止やアドレスの公開設定は変更しません。','wallet-note'));
    else previewBox.append(make('p',plan.desired.enabled?'受取を有効にすると、この公開アドレスとHubプロフィールの関連が公開されます。':'受取を停止し、Hub上のアドレスとプロフィールの関連を非公開にします。既存のブロックチェーン記録は消えません。','wallet-note'));
    status.textContent='表示した設定を確認してから保存してください。';paint();
  }
  async function prepare(mode){
    if(busy||intent||!loaded||!scope||!selected()||!current())return;const row=selected(),captured=scope;
    try{const desired=mode==='enable'?{enabled:enabled.checked}:{minimumAmount:amount(minimum.value)};
      if(mode==='enable'&&desired.enabled===row.tipsEnabled&&row.visibility===(desired.enabled?'public':'private')||mode==='minimum'&&desired.minimumAmount===row.minimumAmount){status.textContent='設定は変わっていません。';preview=null;previewBox.replaceChildren();paint();return;}
      showPreview({mode,row:structuredClone(row),key:rowKey(row),viewerId,scope:{...captured},desired,revision});
    }catch{preview=null;previewBox.replaceChildren();status.textContent='最低額は0以上、小数部18桁以内の数値で入力してください。入力は保持しています。';paint();}
  }
  async function save(retry=false){
    if(busy||!current()||!loaded)return;const plan=retry?intent:preview;if(!plan||retry&&!retryReady||!retry&&(intent||plan.revision!==revision))return;
    busy=true;retryReady=false;rejectionChecked=false;paint();const turn=epoch;
    try{const captured=await fresh(plan.scope,turn);if(!captured||!capturedCurrent(captured,turn)||viewerId!==plan.viewerId||selectedKey!==plan.key||!retry&&revision!==plan.revision)return;
      intent??={...structuredClone(plan),status:'pending'};intent.status='pending';preview=null;status.textContent='受取設定を保存して確認しています…';paint();
      const options={address:plan.row.address,chainId:plan.row.chainId,...plan.desired,...(plan.desired.enabled===true?{publishAddress:true}:{}),expectedViewerId:plan.viewerId,expectedDeviceId:captured.deviceId,expectedOrigin:captured.origin};
      const raw=await invoke('hub_client_action',{action:'tip_settings',options});if(!capturedCurrent(captured,turn)||!await fresh(captured,turn))return;
      const ack=receiptValue(raw,intent);if(!matches(ack,intent))throw Error('wallet_tip_unknown');
      const value=settingsValue(await detail(captured));if(!capturedCurrent(captured,turn)||!await fresh(captured,turn))return;adopt(value);if(!current())return;
      const row=value.links.find(row=>rowKey(row)===plan.key);if(!matches(row,intent))throw Error('wallet_tip_unknown');confirmed(row);
    }catch(error){if(current()&&intent){const code=typeof error==='string'?error:error?.code??error?.message;
      if(['desktop_not_connected','desktop_account_changed'].includes(code)){invalidate();return;}
      const rejected=code==='wallet_tip_conflict'||typeof code==='string'&&!/\p{Cc}/u.test(code)&&/^wallet_tip_rejected:(400|403|413|429)$/u.test(code);
      intent.status=rejected?'rejected':'unknown';status.textContent=rejected?'設定の保存は拒否されました。入力は保持しています。状態を再確認してから入力を見直せます。':'保存結果は不明です。自動では再送しません。状態を再確認して、同じ設定だけを明示的に再試行できます。';}}
    finally{busy=false;if(current())paint();}
  }
  button('enable','受取設定を確認',()=>prepare('enable'));button('minimum','最低額を確認',()=>prepare('minimum'));button('confirm','確認して保存',()=>save());
  button('cancel','取消',()=>{preview=null;previewBox.replaceChildren();status.textContent='保存せずに確認を閉じました。入力は保持しています。';paint();});
  button('reload','状態を再確認',read);button('retry','同じ設定を再試行',()=>save(true));
  button('review','確認した設定から入力へ戻る',()=>{if(intent?.status!=='rejected'||!rejectionChecked)return;intent=null;preview=null;retryReady=false;rejectionChecked=false;previewBox.replaceChildren();status.textContent='入力を見直して、保存する設定を確認してください。';paint();});
  const changed=()=>{if(!selected())return;drafts.set(selectedKey,{enabled:enabled.checked,minimumAmount:minimum.value});revision++;preview=null;previewBox.replaceChildren();paint();};
  minimum.oninput=changed;enabled.onchange=changed;
  select.onchange=()=>{if(busy||intent)return;selectedKey=select.value;revision++;preview=null;previewBox.replaceChildren();displaySelection();paint();};
  form.onsubmit=event=>{event.preventDefault();if(current()&&!busy)void prepare('enable');};
  const accountChanged=()=>invalidate();document.defaultView?.addEventListener('hub-account-changed',accountChanged);
  paint();const ready=Promise.resolve().then(read);
  return{element,ready,destroy(){if(destroyed)return;destroyed=true;epoch++;drafts.clear();links=[];preview=null;intent=null;for(const node of Object.values(buttons))node.onclick=null;minimum.oninput=null;enabled.onchange=null;select.onchange=null;form.onsubmit=null;document.defaultView?.removeEventListener('hub-account-changed',accountChanged);element.replaceChildren();element.remove();}};
}
