import {initP2PTransfer} from './p2p-transfer-panel.mjs';
import {createPeerInboxReader,peerInboxBodyReason} from './peer-inbox-reader.mjs';
export function initHubPeers({document,invoke,createP2P=initP2PTransfer,getScope=()=>null,isCurrent=()=>true}) {
 const node=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
 const root=node('section');root.className='card hub-network-manager';root.append(node('h3','端末とP2Pでつなぐ'),node('p','PC・スマホのブラウザとファイルを送受信できます。公開HTTPSノードとの原本共有は下の詳細から操作できます。'));
 const browser=node('button','PC・スマホとファイルを送受信'),transferHost=node('div');let transfer=null,transferVersion=0;browser.type='button';
 let inboxReadEpoch=0,inboxContext=null;
 const reader=createPeerInboxReader({document,invoke,getScope,isCurrent});
 function closeTransfer(){reader.close();++transferVersion;transfer?.dispose();transfer=null;transferHost.replaceChildren();browser.disabled=false;browser.textContent='PC・スマホとファイルを送受信';}
 browser.onclick=async()=>{if(transfer){closeTransfer();return;}const version=++transferVersion;browser.disabled=true;try{transfer=createP2P(transferHost,{invoke});await transfer.ready;if(version===transferVersion){browser.disabled=false;browser.textContent='送受信画面を閉じる';}}catch{if(version===transferVersion){closeTransfer();status.textContent='送受信画面を開けませんでした。';}}};root.append(browser,transferHost);
 const open=node('details'),summary=node('summary','P2P接続と共有を開く');open.append(summary);root.append(open);
 const status=node('p');status.className='meta';status.setAttribute('role','status');
 const refresh=node('button','一覧を更新');refresh.type='button';
 const form=node('form'),url=node('input'),previewButton=node('button','相手を確認');url.type='url';url.required=true;url.placeholder='https://peer.example';url.setAttribute('aria-label','P2P接続先');previewButton.type='submit';form.append(url,previewButton);
 const confirmation=node('div'),peers=node('select'),events=node('select');peers.setAttribute('aria-label','P2P送信先');events.setAttribute('aria-label','送信する公開原本');
 const send=node('button','送信内容を確認');send.type='button';const sendPreview=node('div'),inbox=node('div');
 open.append(status,refresh,form,confirmation,node('h4','公開原本を送る'),peers,events,send,sendPreview,node('h4','受信した原本'),inbox,reader.element);
 document.querySelector('#hub-network-manager')?.after(root);
 let busy=false,loaded=false;
 const call=(action,args={})=>invoke('hub_peer_control',{action,...args});
 const report=error=>{status.textContent=String(error.message??error);};
 async function load(){
  if(busy)return;busy=true;const version=++inboxReadEpoch;reader.close();status.textContent='確認中…';sendPreview.replaceChildren();
  try{
   const data=await call('list');if(version!==inboxReadEpoch||isCurrent()!==true)return;
   peers.replaceChildren(...data.peers.map(p=>new document.defaultView.Option(p.nodeId,p.peerId)));
   events.replaceChildren(...data.events.map(e=>new document.defaultView.Option(`${e.title||'公開原本'} · #${e.sequence}`,String(e.sequence))));
   send.disabled=!data.peers.length||!data.events.length;inboxContext=data.context??null;
   inbox.replaceChildren(...data.inbox.map(item=>{
    const row=node('section');row.className='detail-form';row.append(node('p',`${item.title||item.contentId} · ${item.senderNodeId} · ${item.status}`));
    const captured={...item,context:inboxContext},reason=peerInboxBodyReason(captured),show=node('button',reason?'全文未対応':'本文を開く');
    show.type='button';show.className='head-action';show.disabled=!!reason;
    if(reason){show.title=reason;const note=node('p',reason);note.className='meta';row.append(note);}
    show.onclick=async()=>{if(show.disabled||!row.isConnected||version!==inboxReadEpoch||isCurrent()!==true)return;show.disabled=true;try{await reader.open(captured,show);}finally{if(row.isConnected&&version===inboxReadEpoch)show.disabled=false;}};
    row.append(show);return row;
   }));
   status.textContent=`${data.peers.length}接続先 · ${data.events.length}件の配信待ち原本`;loaded=true;
  }catch(e){if(version===inboxReadEpoch&&isCurrent()===true)report(e);}finally{busy=false;}
 }
 open.ontoggle=()=>{if(open.open&&!loaded)void load();};refresh.onclick=load;
 form.onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;confirmation.replaceChildren();try{const preview=await call('preview',{nodeUrl:url.value});confirmation.append(node('p',preview.nodeId),node('p',`署名鍵: ${preview.signingKeyThumbprint}`),node('p',`暗号鍵: ${preview.encryptionKeyThumbprint}`));const label=node('label'),check=node('input');check.type='checkbox';label.append(check,document.createTextNode('相手と鍵の指紋を照合した'));const accept=node('button','この相手を登録');accept.type='button';accept.disabled=true;check.onchange=()=>{accept.disabled=!check.checked;};accept.onclick=async()=>{if(busy||!check.checked)return;busy=true;try{await call('confirm',{previewId:preview.previewId,confirmed:true});confirmation.replaceChildren();url.value='';busy=false;await load();}catch(e){report(e);}finally{busy=false;}};confirmation.append(label,accept);}catch(e){report(e);}finally{busy=false;}};
 send.onclick=()=>{sendPreview.replaceChildren();const peerId=peers.value,sequence=Number(events.value);if(!peerId||!Number.isSafeInteger(sequence)||sequence<1)return;sendPreview.append(node('p',`${peers.selectedOptions[0].textContent} に「${events.selectedOptions[0].textContent}」を送信します。`));const confirm=node('button','確認して送信');confirm.type='button';confirm.onclick=async()=>{if(busy)return;busy=true;confirm.disabled=true;try{const receipt=await call('deliver',{peerId,sequence,confirmed:true});status.textContent=`相手の応答: ${receipt.status} · 配送ID ${receipt.deliveryId}`;sendPreview.replaceChildren();}catch(e){report(e);confirm.disabled=false;}finally{busy=false;}};sendPreview.append(confirm);};
 const invalidate=()=>{++inboxReadEpoch;closeTransfer();loaded=false;inboxContext=null;inbox.replaceChildren();};
 document.defaultView?.addEventListener('hub-account-changed',invalidate);
 return {load,closeTransfer,invalidate,dispose(){invalidate();reader.dispose();document.defaultView?.removeEventListener('hub-account-changed',invalidate);}};
}