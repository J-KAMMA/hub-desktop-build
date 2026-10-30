const intervals=[0,5,10,30,60,300,600,3600];
const node=(d,tag,text='',cls='')=>{const n=d.createElement(tag);n.textContent=text;n.className=cls;return n;};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=100&&!/[^A-Za-z0-9_-]/.test(v);
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const date=v=>typeof v==='string'&&v.length>0&&v.length<=64&&!/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(v)&&Number.isFinite(Date.parse(v));
const offset=v=>Number.isSafeInteger(v)&&v>=0&&v%20===0&&Number.isSafeInteger(v+20);
const label=v=>v===0?'制限なし':`${v}秒`;
const invalid=()=>{throw Error('チャンネルの設定を確認できませんでした。');};
function channel(value){
  if(!value||!id(value.id)||typeof value.name!=='string'||!value.name.trim()||value.name.length>50||/[\ud800-\udfff]/u.test(value.name)||!intervals.includes(value.slowmodeSeconds)||(value.archivedAt!==null&&!date(value.archivedAt)))invalid();
  return{id:value.id,name:value.name,slowmodeSeconds:value.slowmodeSeconds,archivedAt:value.archivedAt};
}
function page(value,communityId,requested){
  try{if(new TextEncoder().encode(JSON.stringify(value)).length>128*1024)invalid();}catch{invalid();}
  if(value?.communityId!==communityId||!id(value.viewerId)||!['owner','moderator'].includes(value.role)||value.offset!==requested||!offset(value.offset)||typeof value.hasMore!=='boolean'||!Array.isArray(value.channels)||value.channels.length>20)invalid();
  const channels=value.channels.map(channel);if(new Set(channels.map(item=>item.id)).size!==channels.length)invalid();
  return{communityId,viewerId:value.viewerId,role:value.role,channels,offset:value.offset,hasMore:value.hasMore};
}

export function communityChannelPolicyControls(document,{communityId,invoke,state:storage={},isCurrent=()=>true,onChanged}={}){
  const key=JSON.stringify([communityId]),entries=storage.channelPolicies??={},state=entries[key]??={},root=node(document,'details','','card detail-form community-channel-policy');state.offset??=0;root.open=Boolean(state.open);let active=true,pendingRead;
  const retained=()=>!state.invalidated&&entries[key]===state;
  const valid=()=>{if(!retained())return false;let current=false;try{current=isCurrent()!==false;}catch{}if(!current){if(active)invalidate();return false;}return true;};
  const live=()=>active&&valid(),sync=()=>state.sync?.();
  const errorText=e=>String(e?.message??e).replace(/^community_channel_policy_rejected:(?:400|403|404|409):/,'');
  const denied=e=>/見つかりませんでした|権限がありません|このアカウントは停止|ハブが (?:401|403|404) を返しています|desktop_not_connected|community_channel_policy_rejected:(?:403|404):/.test(String(e?.message??e));
  function button(text,fn){const n=node(document,'button',text,'head-action');n.type='button';n.onclick=()=>{if(live())return fn();};return n;}
  function clearReader(){delete state.data;delete state.note;delete state.selected;delete state.slowmodeSeconds;if(state.saved)delete state.saved.channel;state.permissionLost=true;state.readerStale=true;state.readToken={};state.loading=false;if(!state.attempted&&!state.sending)delete state.operation;sync();}
  const currentChannel=()=>state.data?.channels.find(item=>item.id===(state.operation?.options.channelId??state.saved?.options.channelId??state.selected));
  const canEdit=()=>state.data&&!state.readerStale&&!state.loading&&!state.sending&&!state.operation&&!state.saved;
  const canClose=()=>Boolean((state.rejected||(state.uncertain&&state.operation?.action==='archive'&&state.data?.role==='moderator'))&&!state.readerStale&&!state.loading&&!state.sending&&state.data?.viewerId===state.actor&&currentChannel());
  function render(){
    if(!live())return;root.replaceChildren(node(document,'summary','投稿間隔・アーカイブ'));
    const status=node(document,'p',state.error||state.notice||'','meta');status.setAttribute('role','status');if(state.error)status.classList.add('warning');root.append(status);
    if(state.loading)root.append(node(document,'p','チャンネルの設定を読み込んでいます…','meta'));
    if(state.readerStale&&state.data)root.append(node(document,'p','表示中の設定は以前の読み込み結果です。再確認するまで変更できません。','meta'));
    const data=state.data,selected=currentChannel();
    if(data){
      const choice=node(document,'select');choice.setAttribute('aria-label','設定するチャンネル');for(const item of data.channels){const option=node(document,'option',item.name);option.value=item.id;choice.append(option);}choice.value=selected?.id??state.selected??'';choice.disabled=!canEdit();choice.onchange=()=>{if(!live()||!canEdit())return;state.selected=choice.value;state.slowmodeSeconds=data.channels.find(item=>item.id===choice.value)?.slowmodeSeconds;state.error='';sync();};
      const selection=node(document,'label','設定するチャンネル','detail-form');selection.append(choice);root.append(selection);
      if(!data.channels.length)root.append(node(document,'p','このページにチャンネルはありません。','meta'));
      if(selected)root.append(node(document,'h4',selected.name),node(document,'p',`現在の投稿間隔: ${label(selected.slowmodeSeconds)} · ${selected.archivedAt?'アーカイブ中 · '+selected.archivedAt:'アーカイブされていません'}`,'meta'));
      const nav=node(document,'nav','','detail-form-row');nav.setAttribute('aria-label','チャンネル設定のページ');const previous=button('前の20件',()=>load(Math.max(0,data.offset-20))),next=button('次の20件',()=>load(data.offset+20));previous.disabled=!data.offset||Boolean(state.loading||state.sending||state.operation);next.disabled=!data.hasMore||Boolean(state.loading||state.sending||state.operation);nav.append(previous,next,node(document,'span',`${data.offset/20+1}ページ`,'meta'));root.append(nav);
    }
    if(state.saved){
      root.append(node(document,'p','変更は保存済みです。同じ操作を再送しません。','meta'));
      const current=selected??state.saved.channel,desired=state.saved.options;
      if(current&&((state.saved.action==='slowmode'&&current.slowmodeSeconds!==desired.slowmodeSeconds)||(state.saved.action==='archive'&&Boolean(current.archivedAt)!==desired.archived)))root.append(node(document,'p','現在の設定は確認した変更内容と異なります。保存済みの操作を再適用しません。','meta'));
      const reset=button('別の設定を変更',()=>{if(!state.saved||state.loading||state.sending||state.readerStale||!state.data)return;delete state.saved;delete state.operation;delete state.attempted;delete state.rejected;delete state.uncertain;state.note='';state.notice='';state.error='';state.selected=state.data.channels[0]?.id;state.slowmodeSeconds=state.data.channels[0]?.slowmodeSeconds;sync();});reset.disabled=Boolean(state.loading||state.sending||state.readerStale||!data);root.append(reset);
    }else if(state.operation){
      const operation=state.operation,preview=node(document,'section','','card detail-form');preview.setAttribute('aria-label','チャンネル設定の確認');
      preview.append(node(document,'h4',selected?.name??operation.options.channelId));
      if(data&&!state.readerStale){preview.append(node(document,'p',`確認時の投稿間隔: ${label(operation.options.expectedSlowmodeSeconds)} · ${operation.options.expectedArchivedAt?'アーカイブ中 · '+operation.options.expectedArchivedAt:'アーカイブされていません'}`,'meta'));
        preview.append(node(document,'p',operation.action==='slowmode'?`変更後の投稿間隔: ${label(operation.options.slowmodeSeconds)}`:operation.options.archived?'アーカイブします。新しい投稿を受け付けない状態にします。メッセージは削除しません。':'アーカイブを解除し、投稿を受け付ける状態に戻します。'),node(document,'h5','変更の理由'),node(document,'p',operation.options.note));
      }else preview.append(node(document,'p','現在の設定を再確認してください。','meta'));
      if(state.uncertain)preview.append(node(document,'p','保存結果が不明です。対象・設定・理由・操作IDを変えずに同じ操作の結果を確認してください。','meta'));
      if(state.rejected)preview.append(node(document,'p','この操作は受け付けられませんでした。現在の設定を再確認してください。以前の保存結果は確定できない場合があります。','meta'));
      const save=button(state.attempted?'同じ変更の保存結果を確認':'確認して変更を保存',()=>saveOperation());save.disabled=Boolean(state.loading||state.sending||state.readerStale||state.rejected||!selected||!data||(operation.action==='archive'&&data.role!=='owner'));preview.append(save);
      if(!state.attempted&&!state.sending)preview.append(button('編集に戻る',()=>{delete state.operation;sync();}));
      if(canClose())preview.append(node(document,'p','以前の操作の保存結果は確定できません。現在の設定を確認して、この操作を閉じます。再送しません。','meta'),button('現在の設定を確認して操作を閉じる',()=>{if(!canClose())return;delete state.operation;delete state.attempted;delete state.uncertain;delete state.rejected;state.error='';state.notice='以前の操作を閉じました。現在の設定は変更していません。';sync();}));
      root.append(preview);
    }else if(selected&&data){
      const form=node(document,'form','','detail-form'),interval=node(document,'select');interval.name='slowmodeSeconds';interval.setAttribute('aria-label','変更後の投稿間隔');for(const seconds of intervals){const option=node(document,'option',label(seconds));option.value=seconds;interval.append(option);}interval.value=state.slowmodeSeconds??selected.slowmodeSeconds;interval.disabled=!canEdit();interval.onchange=()=>{if(live()&&canEdit())state.slowmodeSeconds=intervals.some(value=>String(value)===interval.value)?Number(interval.value):NaN;};
      const reason=node(document,'textarea');reason.name='note';reason.rows=3;reason.maxLength=1000;reason.value=state.note??'';reason.setAttribute('aria-label','設定変更の理由');reason.placeholder='設定変更の理由（5〜1000文字）';reason.disabled=!canEdit();reason.oninput=()=>{if(live()&&canEdit())state.note=reason.value;};
      const intervalLabel=node(document,'label','変更後の投稿間隔','detail-form'),reasonLabel=node(document,'label','設定変更の理由','detail-form');intervalLabel.append(interval);reasonLabel.append(reason);const slow=button('投稿間隔の変更を確認',()=>prepare('slowmode')),archive=button(selected.archivedAt?'アーカイブ解除を確認':'アーカイブを確認',()=>prepare('archive'));slow.disabled=!canEdit();archive.disabled=!canEdit();form.onsubmit=e=>{e.preventDefault();if(live())prepare('slowmode');};form.append(intervalLabel,reasonLabel,slow);if(data.role==='owner')form.append(archive);else form.append(node(document,'p','アーカイブの変更はオーナーだけが行えます。','meta'));root.append(form);
    }
    const reread=button('設定を再読み込み',()=>load(state.failedOffset??state.offset??0));reread.disabled=Boolean(state.loading||state.sending);root.append(reread);
  }
  function prepare(action){
    if(!live()||!canEdit())return;const selected=currentChannel();if(!selected||(action==='archive'&&state.data.role!=='owner'))return;
    const note=(state.note??'').normalize('NFKC').trim(),seconds=state.slowmodeSeconds??selected.slowmodeSeconds;
    if(note.length<5||note.length>1000||/[\ud800-\udfff]/u.test(note)||!intervals.includes(seconds)){state.error='理由を5〜1000文字で入力し、投稿間隔を確認してください。';sync();return;}
    const options={channelId:selected.id,note,expectedSlowmodeSeconds:selected.slowmodeSeconds,expectedArchivedAt:selected.archivedAt,...(action==='slowmode'?{slowmodeSeconds:seconds}:{archived:!selected.archivedAt})};
    state.operation={action,requestId:crypto.randomUUID(),options:Object.freeze(options)};state.error='';state.notice='';sync();
  }
  async function saveOperation(){
    const operation=state.operation;if(!live()||!operation||state.saved||state.sending||state.loading||state.readerStale||state.rejected||!currentChannel()||(operation.action==='archive'&&state.data?.role!=='owner'))return;
    state.sending=true;state.attempted=true;state.uncertain=true;state.error='';sync();
    try{
      const value=await invoke('hub_client_action',{action:`community_channel_${operation.action}`,target:communityId,requestId:operation.requestId,options:operation.options});if(!valid())return;
      const receipt=value?.receipt,updated=channel(value?.channel);if(value.communityId!==communityId||updated.id!==operation.options.channelId||!uuid(receipt?.auditId)||receipt.auditId!==operation.requestId||receipt.targetId!==operation.options.channelId||receipt.action!==(operation.action==='slowmode'?'channel_controls':'set_channel_archived')||!date(receipt.confirmedAt)||typeof receipt.replayed!=='boolean')throw Error('保存結果を確認できませんでした。同じ操作で再試行してください。');
      state.saved={...operation,...(!state.permissionLost?{channel:updated}:{}),receipt:{auditId:receipt.auditId,targetId:receipt.targetId,action:receipt.action,confirmedAt:receipt.confirmedAt,replayed:receipt.replayed}};if(state.data)state.data={...state.data,channels:state.data.channels.map(item=>item.id===updated.id?updated:item)};delete state.operation;delete state.uncertain;delete state.rejected;state.notice='変更は保存済みです。';state.readerStale=true;state.sending=false;sync();
      if(live()){try{if(!state.permissionLost)await onChanged?.({communityId,channel:updated,receipt:state.saved.receipt});}catch(error){if(valid())state.error=`変更は保存済みです。画面の更新を確認できませんでした: ${errorText(error)}`;}if(live())await load(state.offset??0);}
    }catch(error){if(valid()){if(/接続が変わりました/.test(String(error?.message??error))){invalidate();return;}const rejected=String(error?.message??error).match(/^community_channel_policy_rejected:(400|403|404|409):/);state.rejected=rejected?Number(rejected[1]):undefined;state.uncertain=!rejected;state.error=errorText(error);state.readerStale=Boolean(rejected);if(denied(error))clearReader();}}
    finally{if(valid()){state.sending=false;sync();}else if(!active&&retained()){state.sending=false;sync();}if(!active)document.defaultView?.removeEventListener('hub-account-changed',invalidate);}
  }
  async function readPage(requested){
    if(!live()||state.loading||state.sending)return;const token={};state.readToken=token;state.loading=true;state.error='';sync();
    try{if(!id(communityId)||!offset(requested))invalid();const value=await invoke('hub_detail',{name:'community_channel_policy_page',ids:[communityId,String(requested)]});if(!valid()||state.readToken!==token)return;const next=page(value,communityId,requested);if(state.actor&&state.actor!==next.viewerId){invalidate();return;}
      state.actor=next.viewerId;state.data=next;state.offset=requested;state.readerStale=false;state.permissionLost=false;delete state.failedOffset;if(!state.operation&&!state.saved&&!next.channels.some(item=>item.id===state.selected)){state.selected=next.channels[0]?.id;state.slowmodeSeconds=next.channels[0]?.slowmodeSeconds;}
    }catch(error){if(valid()&&state.readToken===token){state.failedOffset=requested;state.error=`${state.saved?'変更は保存済みです。現在の設定を再読み込みできませんでした: ':''}${errorText(error)}`;state.readerStale=true;if(denied(error)){const message=state.error;clearReader();state.error=message;sync();}}}
    finally{if(valid()&&state.readToken===token){state.loading=false;delete state.readToken;sync();}else if(!active&&retained()&&state.readToken===token){state.loading=false;state.readerStale=true;delete state.readToken;sync();}if(!active&&!state.sending)document.defaultView?.removeEventListener('hub-account-changed',invalidate);}
  }
  function load(requested){return pendingRead=readPage(requested);}
  function invalidate(){for(const entry of Object.values(entries)){const notify=entry.sync;for(const name of Object.keys(entry))delete entry[name];entry.invalidated=true;notify?.();}for(const name of Object.keys(entries))delete entries[name];if(active)root.replaceChildren(node(document,'summary','投稿間隔・アーカイブ'),node(document,'p','接続が変わりました。設定を読み直してください。','meta'));document.defaultView?.removeEventListener('hub-account-changed',invalidate);}
  function dispose(){if(!active)return;active=false;if(!state.loading&&!state.sending)document.defaultView?.removeEventListener('hub-account-changed',invalidate);if(state.sync===render)delete state.sync;root.ontoggle=null;for(const control of root.querySelectorAll('button,input,textarea,select'))control.disabled=true;}
  root.ontoggle=()=>{if(!live())return;state.open=root.open;if(root.open&&!state.data&&!state.loading&&!state.sending)return load(state.offset??0);};document.defaultView?.addEventListener('hub-account-changed',invalidate);state.sync=render;render();if(root.open)load(state.offset??0);
  return{root,get ready(){return pendingRead??Promise.resolve();},dispose,invalidate,clearReader};
}
