// 端末どうしの音声の受け渡しの会話（DESIGN §5.1–§5.3）。データチャネル `hub-media-v1` の上の決まりだけを持つ。
// 対面のファイル転送（hub-file-v1、p2p-transfer.mjs）とは別で、確認番号は使わない。正しさは断片の SHA-256 で決まる。
// 断片の照合と保管は Rust（media_swarm.rs）の仕事。この層は「断片を要求し、要求に答える」だけ。
// RTCPeerConnection との結線と、群れの Worker との信号の橋は、この層の外（まだ未接続）。
import {fingerprint} from './p2p-transfer.mjs';

export const MEDIA_LABEL='hub-media-v1';
export const PIECE_MAX=524288, FRAME=16384, CONTROL_MAX=4096, SDP_MAX=48000;
export const MAX_OUTSTANDING=2, PIECE_TIMEOUT=20000, REQUESTS_PER_WINDOW=256, WINDOW=10*60*1000;
const REASONS=['busy','missing','revoked','rate'];

// SDP の検査: sha-256 の指紋がちょうど1つ、m=application があり、m=audio / m=video が無い、48,000字以下。
export function mediaFingerprint(sdp){
  if(typeof sdp!=='string'||sdp.length>SDP_MAX)throw Error('接続情報が大きすぎます。');
  return fingerprint(sdp);
}
export function mediaChannelOptions(){return {label:MEDIA_LABEL,options:{ordered:true}};}

const isIndex=n=>Number.isSafeInteger(n)&&n>=0&&n<2**32;

export class MediaSwarmProtocol {
  // channel: {send(data), close()}。serve(index) は Uint8Array を返すか、{reject:'missing'|'revoked'|'busy'} を返す。
  constructor({channel,swarm,revision,digest,serve=()=>({reject:'missing'}),now=()=>Date.now(),timeout=PIECE_TIMEOUT}){
    Object.assign(this,{channel,swarm,revision,digest,serveFn:serve,now,timeout});
    this.helloSeen=false;this.closed=false;this.pending=new Map();this.incoming=null;this.times=[];this.serving=0;
    this.send({type:'hello',v:1,swarm,revision,manifestSha256:digest});
  }
  send(message){this.channel.send(JSON.stringify(message));}
  close(why='bye'){
    if(this.closed)return;this.closed=true;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(why));}
    this.pending.clear();this.incoming=null;
    try{this.channel.close();}catch{}
  }
  bye(){try{this.send({type:'bye'});}catch{}this.close('bye');}
  request(index){
    if(this.closed)return Promise.reject(Error('closed'));
    if(!isIndex(index)||this.pending.size>=MAX_OUTSTANDING)return Promise.reject(Error('busy'));
    const req=this.nextReq=((this.nextReq??-1)+1)%2**32;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(req);try{this.send({type:'cancel',req});}catch{}reject(Error('timeout'));},this.timeout);
      this.pending.set(req,{index,resolve,reject,timer});
      this.send({type:'request',req,index});
    });
  }
  // 受信1件（文字列 = 制御、ArrayBuffer/Uint8Array = 断片の枠）。不正なら閉じる。
  onMessage(data){
    if(this.closed)return;
    try{typeof data==='string'?this.control(data):this.frame(data);}catch{this.close('protocol');}
  }
  control(text){
    if(text.length>CONTROL_MAX)throw Error();
    if(this.incoming)throw Error(); // 断片の途中に制御は来ない
    const m=JSON.parse(text);
    if(!this.helloSeen){
      if(m.type!=='hello'||m.v!==1||m.swarm!==this.swarm||m.revision!==this.revision||m.manifestSha256!==this.digest)throw Error();
      this.helloSeen=true;return;
    }
    switch(m.type){
      case 'request':return void this.onRequest(m);
      case 'piece':{
        const p=this.pending.get(m.req);
        if(!p||m.index!==p.index||!Number.isSafeInteger(m.size)||m.size<1||m.size>PIECE_MAX)throw Error();
        this.incoming={req:m.req,size:m.size,frames:[],count:0};return;
      }
      case 'reject':{
        const p=this.pending.get(m.req);if(!p||!REASONS.includes(m.reason))throw Error();
        clearTimeout(p.timer);this.pending.delete(m.req);p.reject(Error(m.reason));return;
      }
      case 'cancel':return;
      case 'tombstone':this.tombstone?.(m.tombstone);return;
      case 'bye':this.close('bye');return;
      default:throw Error();
    }
  }
  frame(data){
    const bytes=data instanceof Uint8Array?data:new Uint8Array(data);
    const inc=this.incoming;if(!inc)throw Error();
    const want=Math.min(FRAME,inc.size-inc.count);
    if(bytes.byteLength!==want)throw Error(); // 枠の長さが宣言と食い違えば閉じる
    inc.frames.push(bytes);inc.count+=bytes.byteLength;
    if(inc.count<inc.size)return;
    this.incoming=null;
    const p=this.pending.get(inc.req);if(!p)throw Error();
    clearTimeout(p.timer);this.pending.delete(inc.req);
    const piece=new Uint8Array(inc.size);let at=0;for(const f of inc.frames){piece.set(f,at);at+=f.byteLength;}
    p.resolve(piece); // 照合は呼び出し側（Rust）。合わなければ呼び出し側がこの接続を閉じる
  }
  onRequest(m){
    if(!isIndex(m.req)||!isIndex(m.index))throw Error();
    const t=this.now();this.times=this.times.filter(x=>t-x<WINDOW);
    if(this.times.length>=REQUESTS_PER_WINDOW)return void this.send({type:'reject',req:m.req,reason:'rate'});
    if(this.serving>=MAX_OUTSTANDING)return void this.send({type:'reject',req:m.req,reason:'busy'});
    this.times.push(t);this.serving++;
    Promise.resolve(this.serveFn(m.index)).then(result=>{
      if(this.closed)return;
      if(!(result instanceof Uint8Array)||result.byteLength<1||result.byteLength>PIECE_MAX){
        const reason=REASONS.includes(result?.reject)?result.reject:'missing';
        this.send({type:'reject',req:m.req,reason});return;
      }
      this.send({type:'piece',req:m.req,index:m.index,size:result.byteLength});
      for(let o=0;o<result.byteLength;o+=FRAME)this.channel.send(result.slice(o,o+FRAME));
    }).catch(()=>{if(!this.closed)this.send({type:'reject',req:m.req,reason:'missing'});}).finally(()=>{this.serving--;});
  }
}
