const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length
  &&keys.every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value'));
function statusValue(value){
  if(!exact(value,['version','supported','enabled','ready','blockedCount','listsVersion'])||value.version!==1
    ||!['supported','enabled','ready'].every(key=>typeof value[key]==='boolean')
    ||!Number.isSafeInteger(value.blockedCount)||value.blockedCount<0||typeof value.listsVersion!=='string'||value.listsVersion.length>256
    ||/[\p{Cc}\p{Surrogate}]/u.test(value.listsVersion))throw Error('browser_protection_unavailable');
  return {...value};
}

/** Global Native preference only. Construction performs no IPC, fetch, reload or persistence. */
export function createBrowserProtection({document,invoke,isCurrent,beforeOpen=()=>true,onError=()=>{}}){
  if(!document||typeof invoke!=='function'||typeof isCurrent!=='function'||typeof beforeOpen!=='function'||typeof onError!=='function')throw Error('browser_protection_invalid');
  const node=(tag,text,className='')=>{const value=document.createElement(tag);value.className=className;if(text!==undefined)value.textContent=text;return value;};
  const button=node('button',undefined,'browser-protection-button');button.id='browser-protection';button.type='button';
  button.setAttribute('aria-label','広告とトラッカーの保護');button.setAttribute('aria-controls','browser-protection-panel');button.setAttribute('aria-expanded','false');
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','17');svg.setAttribute('height','17');
  svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M12 3 20 6v6c0 5-5 8-8 9-3-1-8-4-8-9V6l8-3Z');svg.append(path);button.append(svg);
  const element=node('section',undefined,'browser-protection-panel');element.id='browser-protection-panel';element.hidden=true;element.setAttribute('aria-label','広告とトラッカーの保護設定');
  const heading=node('div',undefined,'browser-protection-heading'),title=node('strong','広告とトラッカーの保護'),closeButton=node('button','閉じる','browser-protection-close');closeButton.type='button';heading.append(title,closeButton);
  const label=node('label',undefined,'browser-protection-toggle'),toggle=node('input');toggle.type='checkbox';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label','広告・トラッカーをブロック');
  label.append(toggle,node('span','広告・トラッカーをブロック'));
  const scope=node('p','すべてのタブに適用します。設定の変更でページを自動再読込しません。 YouTubeの広告対策は、切り替え後にページを再読み込みすると反映されます。','browser-protection-note');
  const message=node('p','状態を確認してください。','browser-protection-note');message.setAttribute('role','status');
  const count=node('p','この起動中のブロック数: 未確認','browser-protection-note'),version=node('p','EasyList / EasyPrivacy: 未確認','browser-protection-note');
  const recheck=node('button','状態を再確認','browser-protection-recheck');recheck.type='button';recheck.hidden=true;
  element.append(heading,label,scope,message,count,version,recheck);
  let disposed=false,epoch=0,readTurn=0,openTurn=0,state=null,stale=true,uncertain=false,reading=false,mutation=null,opening=false;
  const current=()=>{try{return !disposed&&isCurrent()===true;}catch{return false;}};
  const notify=code=>{try{onError({code});}catch{}};
  function paint(){
    if(disposed)return;
    const usable=current()&&!stale&&!uncertain&&state?.supported===true&&state.ready===true;
    toggle.disabled=!usable||reading||mutation!==null;toggle.checked=state?.enabled===true;
    button.disabled=opening;button.setAttribute('aria-expanded',String(!element.hidden));button.dataset.state=usable?(state.enabled?'on':'off'):'unknown';
    button.title=usable?`広告とトラッカーの保護: ${state.enabled?'オン':'オフ'}`:'広告とトラッカーの保護状態を確認';
    count.textContent=state?`この起動中のブロック数: ${Math.max(0,state.blockedCount).toLocaleString('ja-JP')}件${stale?'（前回取得）':''}`:'この起動中のブロック数: 未確認';
    version.textContent=`EasyList / EasyPrivacy${state&&stale?'（前回取得）':''}: ${state?.listsVersion||'未確認'}`;
    recheck.hidden=!(stale||uncertain||!state?.supported||!state.ready);recheck.disabled=reading||!current();
    element.setAttribute('aria-busy',String(reading||mutation!==null));
  }
  function describe(){
    if(uncertain)return '変更結果を確認できません。再送せず、状態を再確認してください。';
    if(stale||!state)return '保護の状態を確認できません。状態を再確認してください。';
    if(!state.supported)return 'この実行環境では広告・トラッカーのブロックを利用できません。';
    if(!state.ready)return '保護の準備が完了していません。状態を再確認してください。';
    return state.enabled?'広告・トラッカーのブロックはオンです。':'広告・トラッカーのブロックはオフです。';
  }
  function close(){
    epoch++;readTurn++;openTurn++;opening=false;reading=false;stale=true;
    if(mutation)uncertain=true;
    element.hidden=true;button.setAttribute('aria-expanded','false');paint();
  }
  async function load(){
    if(!current())return false;
    const own=epoch,turn=++readTurn;reading=true;paint();
    try{
      const raw=await invoke('browser_protection_status',{});
      if(!current()||own!==epoch||turn!==readTurn)return false;
      state=statusValue(raw);stale=false;if(!mutation)uncertain=false;message.textContent=describe();return state.supported&&state.ready;
    }catch{
      if(current()&&own===epoch&&turn===readTurn){stale=true;message.textContent=describe();notify('browser_protection_unavailable');}return false;
    }finally{if(own===epoch&&turn===readTurn){reading=false;if(current())paint();}}
  }
  async function setEnabled(){
    if(!current()||element.hidden||toggle.disabled||mutation||reading||stale||uncertain||!state?.supported||!state.ready)return false;
    const requested=toggle.checked,own=epoch,operation={requested};mutation=operation;readTurn++;message.textContent='設定を確認しています…';paint();
    try{
      const raw=await invoke('browser_set_protection',{enabled:requested});
      if(!current()||own!==epoch){uncertain=true;stale=true;return false;}
      const value=statusValue(raw);
      if(value.enabled!==requested)throw Error('browser_protection_unknown');
      state=value;stale=false;uncertain=false;readTurn++;message.textContent=describe();return state.supported&&state.ready;
    }catch{
      uncertain=true;stale=true;
      if(current()&&own===epoch){message.textContent=describe();notify('browser_protection_unknown');}return false;
    }finally{if(mutation===operation){mutation=null;if(current()&&own===epoch)paint();}}
  }
  async function open(){
    if(!current()||opening)return false;
    if(!element.hidden){close();button.focus();return true;}
    const own=epoch,turn=++openTurn;opening=true;paint();
    try{
      const ready=await beforeOpen();if(ready===false||!current()||own!==epoch||turn!==openTurn)return false;
      element.hidden=false;button.setAttribute('aria-expanded','true');await load();
      if(!current()||own!==epoch||turn!==openTurn)return false;
      (toggle.disabled?recheck:toggle).focus();return true;
    }catch{if(current()&&own===epoch){notify('browser_protection_unavailable');}return false;}
    finally{if(own===epoch&&turn===openTurn){opening=false;paint();}}
  }
  button.onclick=()=>void open();toggle.onchange=()=>void setEnabled();recheck.onclick=()=>void load();closeButton.onclick=()=>{close();button.focus();};
  element.onkeydown=event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.isComposing&&event.keyCode!==229){event.preventDefault();close();button.focus();}};
  paint();
  return {button,element,load,close,invalidate:close,dispose(){if(disposed)return;close();disposed=true;button.remove();element.remove();}};
}
