// Only encrypted WebRTC connection metadata passes through the pairing relay.
export const PAIRING_RELAY_ORIGIN='https://hub-p2p-test.jammakamma0.workers.dev';
const TTL=600000,CLOCK_SKEW=60000,MAX=90000,encoder=new TextEncoder();
const hex=bytes=>Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=value=>Uint8Array.from(value.match(/../g),x=>parseInt(x,16));
export function createPairing(){return {room:hex(crypto.getRandomValues(new Uint8Array(16))),key:hex(crypto.getRandomValues(new Uint8Array(32))),expires:Date.now()+TTL};}
export function readPairing(fragment,now=Date.now()){
  const match=/^#pair=1\.([a-f0-9]{32})\.([a-f0-9]{64})\.([0-9]{13})$/.exec(fragment);
  if(!match||Number(match[3])<=now||Number(match[3])>now+TTL+CLOCK_SKEW)throw Error('招待の有効期限が切れたか、リンクが不正です。新しい招待を作ってください。');
  return {room:match[1],key:match[2],expires:Number(match[3])};
}
// A new document URL also refreshes an already-open phone tab running the old relay client.
export function pairingLink(origin,ticket){return `${new URL('/?pairing=2',origin).href}#pair=1.${ticket.room}.${ticket.key}.${ticket.expires}`;}
async function cipher(ticket,type){
  if(!['offer','answer'].includes(type))throw Error('Invalid signal type');
  const key=await crypto.subtle.importKey('raw',unhex(ticket.key),'AES-GCM',false,['encrypt','decrypt']);
  return {key,additionalData:encoder.encode(`hub-pair-v1:${ticket.room}:${ticket.expires}:${type}`)};
}
export async function sealSignal(ticket,type,text){
  if(typeof text!=='string')throw Error('Invalid signal size');
  const bytes=encoder.encode(text);if(bytes.byteLength<1||bytes.byteLength>MAX)throw Error('Invalid signal size');
  const {key,additionalData}=await cipher(ticket,type),iv=crypto.getRandomValues(new Uint8Array(12));
  const body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData},key,bytes);
  const frame=new Uint8Array(12+body.byteLength);frame.set(iv);frame.set(new Uint8Array(body),12);return frame.buffer;
}
export async function openSignal(ticket,type,frame){
  checkFrame(frame);
  const {key,additionalData}=await cipher(ticket,type);
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:frame.slice(0,12),additionalData},key,frame.slice(12));
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function checkFrame(frame){if(!(frame instanceof ArrayBuffer)||frame.byteLength<29||frame.byteLength>MAX+28)throw Error('Invalid encrypted signal');}
async function webTransport({origin,room,role,expires,method,action,body,signal}){
  const url=new URL(`/pair/${room}/${role}?expires=${expires}&transport=http`,origin);if(action)url.searchParams.set('action',action);
  const response=await fetch(url,{method,body,headers:body?{'Content-Type':'application/octet-stream'}:{},credentials:'omit',cache:'no-store',signal});
  return {status:response.status,data:response.status===200&&method==='GET'?await response.arrayBuffer():null};
}
export class AutoPair {
  constructor(peer,ticket,origin,role,onError,transport=webTransport){Object.assign(this,{peer,ticket,origin,role,onError,transport});this.closed=false;this.exchanged=false;this.handled=false;this.controllers=new Set();}
  async connect(){
    if(this.closed||this.url)throw Error('接続は終了しているか、すでに開始しています。');
    const {room,expires}=this.ticket;
    readPairing(new URL(pairingLink(this.origin,this.ticket)).hash);
    const origin=new URL(this.origin);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||!['host','guest'].includes(this.role)||typeof this.transport!=='function')throw Error('Invalid pairing transport');
    this.origin=origin.origin;
    this.url=new URL(`/pair/${room}/${this.role}?expires=${expires}&transport=http`,this.origin);
    this.expiry=setTimeout(()=>this.fail('招待の有効期限が切れました。新しい招待でやり直してください。'),Math.min(TTL,expires-Date.now()));
    try{await this.request('POST','start');if(!this.closed)this.pollTimer=setTimeout(()=>void this.poll(),500);}catch(error){this.close();throw error;}
  }
  async request(method='GET',action='',body){
    if(this.closed)throw Error('接続は終了しています。');
    const polling=method==='GET'&&action===''&&body===undefined;
    if(!this.url||!(polling||method==='POST'&&(action==='start'&&body===undefined||action==='signal'&&body instanceof ArrayBuffer)))throw Error('Invalid pairing operation');
    if(body!==undefined)checkFrame(body);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);this.controllers.add(controller);
    let onAbort;
    const aborted=new Promise((_,reject)=>{onAbort=()=>reject(Error('Pairing request aborted'));controller.signal.addEventListener('abort',onAbort,{once:true});});
    try{
      const response=await Promise.race([this.transport({origin:this.origin,room:this.ticket.room,role:this.role,expires:this.ticket.expires,method,action,body,signal:controller.signal}),aborted]);
      if(this.closed||controller.signal.aborted)throw Error('接続は終了しています。');
      if(!response||!Number.isInteger(response.status)||response.status<100||response.status>599)throw Error('Invalid pairing response');
      if(response.status<200||response.status>=300){
        const messages={400:'招待の期限か端末の時計を確認できません。新しい招待を作ってください。',403:'この接続サービスでは、このHubからの接続が許可されていません。利用するHubが許可されたサービスを選んでください。',409:'この招待は使えなくなっています。新しい招待を作ってください。',410:'相手側の接続待ちが終了しました。新しい招待でやり直してください。',429:'接続が集中しています。1分後にもう一度お試しください。'};
        throw Error(messages[response.status]||`接続サービスでエラーが発生しました（${response.status}）。`);
      }
      if(polling&&response.status===200)checkFrame(response.data);
      else if(response.status!==204&&!(polling&&response.status===202&&this.role==='host')||response.data!==null)throw Error('Invalid pairing response');
      return {status:response.status,data:response.data};
    }catch(error){if(this.closed)throw Error('接続は終了しています。');if(controller.signal.aborted||error instanceof TypeError)throw Error('接続サービスに届きません。利用するHubの許可設定や回線を確認してください。');throw error;}
    finally{clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);this.controllers.delete(controller);}
  }
  async poll(){
    try{
      const response=await this.request();if(this.closed)return;
      if(response.status===202&&!this.started)await this.receive('joined');
      else if(response.data)await this.receive(response.data);
      if(!this.closed&&!this.exchanged)this.pollTimer=setTimeout(()=>void this.poll(),1000);
    }catch(error){if(!this.closed)this.fail(error instanceof Error?error.message:'接続情報を確認できませんでした。新しいQRでやり直してください。');}
  }
  async receive(data){
    if(this.closed)return;
    if(data==='joined'&&this.role==='host'){
      if(this.started)throw Error('Duplicate peer');this.started=true;
      const offer=await this.peer.invite();if(!this.closed)await this.send('offer',offer);return;
    }
    if(typeof data==='string')throw Error('Unexpected relay message');
    if(this.handled)throw Error('Duplicate signal');this.handled=true;
    const text=await openSignal(this.ticket,this.role==='host'?'answer':'offer',data);
    if(this.closed)return;
    if(this.role==='host')await this.peer.answer(text);
    else {const answer=await this.peer.join(text);if(!this.closed)await this.send('answer',answer);}
    if(this.closed)return;
    this.exchanged=true;
    if(!this.closed)this.connectionTimer=setTimeout(()=>this.fail('直接つながりませんでした。同じWi-Fiで試すか、回線・中継の設定を確認してください。'),45000);
  }
  async send(type,text){if(this.closed)return;const frame=await sealSignal(this.ticket,type,text);if(!this.closed)await this.request('POST','signal',frame);}
  fail(message){if(this.closed)return;this.close();this.peer.close(message);this.onError(message);}
  close(){this.closed=true;clearTimeout(this.expiry);clearTimeout(this.connectionTimer);clearTimeout(this.pollTimer);for(const controller of this.controllers)controller.abort();}
}
