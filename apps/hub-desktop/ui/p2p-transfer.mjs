// One explicitly paired, in-memory WebRTC file transfer. No file storage; signalling is handled separately.
export const MAX_FILE_BYTES=16*1024*1024;
const CHUNK=16*1024,TTL=10*60*1000,CLOCK_SKEW=60000;
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
export const fingerprint=sdp=>{
  const prints=[...new Set([...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm)].map(m=>m[1].toUpperCase()))];
  if(prints.length!==1||!/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(prints[0]))throw Error('接続情報の鍵を確認できません。');
  if(!/^m=application /m.test(sdp)||/^m=(audio|video) /m.test(sdp))throw Error('ファイル接続以外の接続情報は使えません。');
  return prints[0];
};
export function readSignal(code,type,now=Date.now()) {
  try {
    if(typeof code!=='string'||code.length>90000)throw Error();
    const signal=JSON.parse(atob(code.trim()));
    if(signal.v!==1||signal.type!==type||!/^[-a-f0-9]{36}$/.test(signal.id)||!Number.isSafeInteger(signal.expires)||signal.expires<=now||signal.expires>now+TTL+CLOCK_SKEW||typeof signal.sdp!=='string'||signal.sdp.length>48000)throw Error();
    fingerprint(signal.sdp);return signal;
  }catch{throw Error('接続コードが不正か、10分の有効期限が切れています。');}
}
export function iceConfiguration(stun='stun:stun.l.google.com:19302',turn='',username='',credential='',relay=false){
  const valid=(url,protocol)=>new RegExp(`^${protocol}:[a-zA-Z0-9.-]+(?::[0-9]{1,5})?(?:\\?transport=(?:udp|tcp))?$`).test(url)&&url.length<=256;
  const iceServers=[];
  if(stun){if(!valid(stun,'stuns?'))throw Error('STUNのURLを確認してください。');iceServers.push({urls:stun});}
  if(turn){if(!valid(turn,'turns?')||!username||!credential||username.length>512||credential.length>512)throw Error('TURNのURL・利用者名・認証情報を確認してください。');iceServers.push({urls:turn,username,credential});}
  if(relay&&!turn)throw Error('中継のみを使うにはTURN設定が必要です。');
  return {iceServers,iceTransportPolicy:relay?'relay':'all'};
}
export class PeerTransfer {
  constructor(configuration,onChange,options={}){
    this.label=options.label||'hub-file-v1';this.change=onChange;this.state={status:'接続の準備中',code:'',ready:false,verified:false,remoteVerified:false};
    this.closed=false;this.pc=new RTCPeerConnection(configuration);this.id='';this.expires=0;this.chunks=[];
    this.opened=new Promise(resolve=>{this.markOpen=resolve;});
    this.pc.ondatachannel=event=>{if(this.channel){event.channel.close();this.close('接続チャネルが重複しました。');}else this.attach(event.channel);};
    this.pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(this.pc.connectionState))this.close('接続が終了しました。必要なら新しいQRで接続してください。');if(this.pc.connectionState==='disconnected')this.update({status:'回線が切れています。再接続を待っています。',ready:false});if(this.pc.connectionState==='connected'&&this.state.verified&&this.state.remoteVerified)this.update({ready:true,status:'相手を確認済み · 送受信できます'});};
  }
  update(patch){Object.assign(this.state,patch);this.change({...this.state});}
  guard(){if(this.closed)throw Error('接続は終了しています。');}
  async gather(){
    if(this.pc.iceGatheringState==='complete')return;
    await new Promise((resolve,reject)=>{const done=()=>{if(this.pc.iceGatheringState==='complete'){clearTimeout(timer);this.pc.removeEventListener('icegatheringstatechange',done);resolve();}};const timer=setTimeout(()=>{this.pc.removeEventListener('icegatheringstatechange',done);reject(Error('接続候補を取得できません。ネットワークや中継設定を確認してください。'));},15000);this.pc.addEventListener('icegatheringstatechange',done);done();});this.guard();
  }
  deadline(){this.expiryTimer=setTimeout(()=>this.close('接続コードの有効期限が切れました。'),Math.min(TTL,Math.max(0,this.expires-Date.now())));}
  signal(){return btoa(JSON.stringify({v:1,id:this.id,expires:this.expires,type:this.pc.localDescription.type,sdp:this.pc.localDescription.sdp}));}
  async invite(){this.id=crypto.randomUUID();this.expires=Date.now()+TTL;this.deadline();this.attach(this.pc.createDataChannel(this.label,{ordered:true}));await this.pc.setLocalDescription(await this.pc.createOffer());await this.gather();this.update({status:'相手の端末と接続情報を交換しています…'});return this.signal();}
  async join(code){const offer=readSignal(code,'offer');this.id=offer.id;this.expires=offer.expires;this.deadline();await this.pc.setRemoteDescription({type:'offer',sdp:offer.sdp});await this.pc.setLocalDescription(await this.pc.createAnswer());await this.gather();this.update({status:'接続情報を確認しています…'});return this.signal();}
  async answer(code){this.guard();const answer=readSignal(code,'answer');if(answer.id!==this.id||answer.expires!==this.expires)throw Error('別の招待への応答です。');await this.pc.setRemoteDescription({type:'answer',sdp:answer.sdp});this.update({status:'接続中…つながらない場合はTURN中継を設定して作り直してください。'});}
  attach(channel){
    this.channel=channel;channel.binaryType='arraybuffer';channel.bufferedAmountLowThreshold=65536;
    channel.onopen=async()=>{try{if(channel.label!==this.label)throw Error();const prints=[fingerprint(this.pc.localDescription.sdp),fingerprint(this.pc.remoteDescription.sdp)].sort();const code=(await hash(new TextEncoder().encode(`${this.id}\n${prints.join('\n')}`))).slice(0,16).toUpperCase().match(/.{4}/g).join(' ');this.guard();clearTimeout(this.expiryTimer);this.update({code,status:'両方の画面で確認番号が同じか、通話などで照合してください。'});this.markOpen();}catch{this.close('接続の鍵を確認できませんでした。');}};
    channel.onclose=()=>this.close('接続を終了しました。');channel.onerror=()=>this.close('通信に失敗しました。');
    channel.onmessage=event=>{void this.receive(event.data).catch(()=>this.close('転送データを確認できませんでした。接続を終了しました。'));};
  }
  control(message){this.guard();if(this.channel?.readyState!=='open')throw Error('まだ接続できていません。');this.channel.send(JSON.stringify(message));}
  verify(){if(!this.state.code)throw Error('接続完了を待ってください。');this.control({type:'verify'});this.update({verified:true,ready:this.state.remoteVerified,status:this.state.remoteVerified?'相手を確認済み · 送受信できます':'相手の確認を待っています。'});}
  async offer(file){
    if(!this.state.ready||this.outgoing||this.incoming||this.preparing)throw Error('接続確認を終え、進行中の転送を完了してください。');
    if(!file.size||file.size>MAX_FILE_BYTES)throw Error('1バイト〜16MiBのファイルを選んでください。');
    this.preparing=true;
    try{const bytes=await file.arrayBuffer();if(bytes.byteLength!==file.size)throw Error('ファイルのサイズが変わりました。選び直してください。');const digest=await hash(bytes);this.guard();if(!this.state.ready||this.incoming)throw Error('相手からの受信を先に完了してください。');const item={id:crypto.randomUUID(),name:file.name.replace(/[\x00-\x1f/\\]/g,'_').slice(0,160)||'download',size:bytes.byteLength,digest};this.outgoing={...item,bytes};this.control({type:'offer',...item});this.transferDeadline();this.update({status:'相手の受信許可を待っています。'});}finally{this.preparing=false;}
  }
  transferDeadline(){clearTimeout(this.transferTimer);this.transferTimer=setTimeout(()=>this.close('転送の待機時間を超えました。'),120000);}
  accept(){if(!this.incoming||this.incoming.accepted||!this.state.ready)throw Error('受信待ちのファイルがありません。');this.incoming.accepted=true;this.control({type:'accept',id:this.incoming.id});this.update({pending:undefined,status:'受信中…'});}
  reject(){if(!this.incoming||this.incoming.accepted)return;this.control({type:'reject',id:this.incoming.id});this.incoming=undefined;clearTimeout(this.transferTimer);this.update({pending:undefined,status:'受信を断りました。'});}
  async send(){
    const item=this.outgoing;if(!item||item.sending)throw Error();item.sending=true;
    this.update({status:'送信中…'});
    for(let offset=0;offset<item.size;offset+=CHUNK){this.guard();if(this.channel.bufferedAmount>262144)await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);this.channel.removeEventListener('bufferedamountlow',done);resolve();};const timer=setTimeout(()=>{this.channel.removeEventListener('bufferedamountlow',done);reject(Error('送信待機が長すぎます。'));},10000);this.channel.addEventListener('bufferedamountlow',done);if(this.channel.bufferedAmount<=65536)done();});this.guard();this.channel.send(item.bytes.slice(offset,offset+CHUNK));}
    this.control({type:'complete',id:item.id});this.update({status:'送信済み · 相手の検証完了を待っています。'});
  }
  async receive(data){
    this.guard();
    if(data instanceof ArrayBuffer){if(!this.state.ready||!this.incoming?.accepted||data.byteLength===0||data.byteLength!==Math.min(CHUNK,this.incoming.size-this.incoming.count))throw Error();this.incoming.count+=data.byteLength;this.chunks.push(data);return;}
    if(typeof data!=='string'||data.length>4096)throw Error();const message=JSON.parse(data);
    if(message.type==='verify'){if(this.verificationReceived)throw Error();this.verificationReceived=true;await this.opened;this.guard();if(!this.state.code)throw Error();this.update({remoteVerified:true,ready:this.state.verified,status:this.state.verified?'相手を確認済み · 送受信できます':'相手は確認済みです。この画面でも番号を照合してください。'});return;}
    if(!this.state.ready)throw Error();
    if(message.type==='offer'){
      if(this.incoming||this.outgoing||this.preparing){this.control({type:'reject',id:message.id});return;}
      if(!/^[-a-f0-9]{36}$/.test(message.id)||typeof message.name!=='string'||message.name.length>160||/[\x00-\x1f/\\]/.test(message.name)||!Number.isSafeInteger(message.size)||message.size<1||message.size>MAX_FILE_BYTES||!(/^[a-f0-9]{64}$/).test(message.digest))throw Error();
      this.incoming={id:message.id,name:message.name,size:message.size,digest:message.digest,count:0,accepted:false};this.chunks=[];this.transferDeadline();this.update({pending:{name:message.name,size:message.size},status:'相手がファイルを送りたいと通知しています。'});return;
    }
    if(message.type==='accept'&&message.id===this.outgoing?.id){await this.send();return;}
    if(message.type==='reject'&&message.id===this.outgoing?.id){this.outgoing=undefined;clearTimeout(this.transferTimer);this.update({status:'相手が受信を断りました。'});return;}
    if(message.type==='received'&&this.outgoing?.sending&&message.id===this.outgoing.id){this.outgoing=undefined;clearTimeout(this.transferTimer);this.update({status:'相手の受信とファイル照合が完了しました。'});return;}
    if(message.type==='complete'&&this.incoming?.accepted&&message.id===this.incoming.id){const item=this.incoming;item.accepted=false;if(item.count!==item.size)throw Error();const blob=new Blob(this.chunks,{type:'application/octet-stream'});if(await hash(await blob.arrayBuffer())!==item.digest)throw Error();this.guard();this.control({type:'received',id:item.id});this.incoming=undefined;this.chunks=[];clearTimeout(this.transferTimer);this.update({received:{name:item.name,blob},pending:undefined,status:'受信・ファイル照合が完了しました。保存ボタンで端末に保存できます。'});return;}
    throw Error();
  }
  close(status='接続を終了しました。'){
    if(this.closed)return;this.closed=true;this.markOpen();clearTimeout(this.expiryTimer);clearTimeout(this.transferTimer);this.channel?.close();this.pc.close();this.outgoing=undefined;this.incoming=undefined;this.chunks=[];this.update({status,ready:false,pending:undefined,code:'',verified:false,remoteVerified:false});
  }
}
