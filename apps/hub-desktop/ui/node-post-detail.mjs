export function createNodePostDetails({document,invoke}) {
  const node=(tag,text,className='')=>{const element=document.createElement(tag);element.textContent=text??'';element.className=className;return element;};
  const dialog=node('dialog'),shell=node('div',null,'dialog-shell'),header=node('header',null,'dialog-head'),title=node('h2','投稿の原本'),close=node('button','閉じる','deny dialog-close');
  dialog.id='node-post-detail';title.id='node-post-detail-title';dialog.setAttribute('aria-labelledby',title.id);close.type='button';header.append(title,close);
  const tabs=node('nav',null,'scopes');tabs.setAttribute('aria-label','原本の表示');
  const bodyTab=node('button','本文','scope'),deliveryTab=node('button','配信状況','scope');bodyTab.type=deliveryTab.type='button';tabs.append(bodyTab,deliveryTab);
  const content=node('section',null,'detail-form'),note=node('p',null,'meta');note.setAttribute('aria-live','polite');shell.append(header,tabs,content,note);dialog.append(shell);document.body.append(dialog);
  let revision=0,sequence=null,opener=null,busy=false,view='body';
  const select=next=>{view=next;bodyTab.classList.toggle('on',next==='body');deliveryTab.classList.toggle('on',next==='delivery');bodyTab.setAttribute('aria-pressed',String(next==='body'));deliveryTab.setAttribute('aria-pressed',String(next==='delivery'));const body=content.querySelector('[data-original-body]'),deliveries=content.querySelector('[data-deliveries]');if(body)body.hidden=next!=='body';if(deliveries)deliveries.hidden=next!=='delivery';};
  bodyTab.onclick=()=>select('body');deliveryTab.onclick=()=>select('delivery');
  const finish=()=>{revision++;sequence=null;busy=false;opener?.focus();};
  close.onclick=()=>dialog.close();dialog.addEventListener('close',finish);
  dialog.addEventListener('cancel',()=>{revision++;});
  const labels={accepted:'受領を確認済み',waiting:'未送信',unconfirmed:'受領を未確認',unavailable:'配信先の登録を確認できません'};
  function render(data){
    if(data?.sequence!==sequence||typeof data.body!=='string'||!Array.isArray(data.deliveries))throw Error('原本の詳細を確認できません。');
    const body=node('p',data.body,'detail-p'),deliveries=node('section',null,'detail-form');body.dataset.originalBody='';deliveries.dataset.deliveries='';
    content.replaceChildren(node('p',`原本 #${data.sequence} · ${new Date(data.createdAt).toLocaleString('ja-JP')}`,'meta'),node('p',data.nodeUrl,'meta'),body,deliveries);
    deliveries.append(node('p','相手の受領確認は、SNSへの掲載や検索への登録を保証しません。','meta'));
    if(!data.deliveries.length)deliveries.append(node('p','記録された配信先はありません。この端末に原本を保存しています。','meta'));
    for(const delivery of data.deliveries){
      const row=node('section',null,'card detail-form');row.dataset.peerId=delivery.peerId;row.append(node('p',delivery.nodeUrl,'detail-p'),node('p',labels[delivery.status]??'状況を確認できません','meta'));
      if(delivery.receivedAt)row.append(node('p',`受領日時: ${new Date(delivery.receivedAt).toLocaleString('ja-JP')}`,'meta'));
      if(delivery.retryable&&['waiting','unconfirmed'].includes(delivery.status)){
        const retry=node('button',delivery.status==='waiting'?'この配信先へ送る':'この配信先へ再試行','head-action');retry.type='button';
        retry.onclick=()=>{if(busy)return;const confirmation=node('section',null,'detail-form'),confirm=node('button','確認して配信','head-action'),cancel=node('button','戻る','head-action');confirm.type=cancel.type='button';confirmation.append(node('p',`表示中の公開原本を ${delivery.nodeUrl} へ配信します。`,'detail-p'),confirm,cancel);retry.hidden=true;row.append(confirmation);cancel.onclick=()=>{confirmation.remove();retry.hidden=false;};confirm.onclick=()=>void send(delivery.peerId);};row.append(retry);
      }
      deliveries.append(row);
    }
    select(view);
  }
  async function read(){const own=++revision;note.textContent='原本と配信記録を読み込み中…';try{const data=await invoke('node_public_post_control',{action:'detail',sequence});if(own!==revision||!dialog.open)return;render(data);note.textContent='';}catch(error){if(own===revision&&dialog.open){content.replaceChildren();note.textContent=String(error?.message??error);}}}
  async function send(peerId){if(busy)return;busy=true;const own=++revision,original=sequence;content.querySelectorAll('button').forEach(button=>button.disabled=true);note.textContent='配信中…';try{const data=await invoke('node_public_post_control',{action:'retry',sequence:original,peerId,confirmed:true});if(own!==revision||!dialog.open)return;render(data);note.textContent='配信記録を更新しました。';}catch(error){if(own===revision&&dialog.open)note.textContent=`原本は保存済みです。${String(error?.message??error)}`;}finally{if(own===revision){busy=false;content.querySelectorAll('button').forEach(button=>button.disabled=false);}}}
  return {open:async(value,button)=>{if(!Number.isSafeInteger(value)||value<1)return;revision++;sequence=value;opener=button;busy=false;content.replaceChildren();select('body');if(!dialog.open)dialog.showModal();close.focus();await read();},dialog};
}
