// Shared by the Web UI and bundled Desktop UI. Only public post catalogs can enter this transport.
const encoder=new TextEncoder(),MAX=1048576,CHUNK=8000,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hashPattern=/^[a-f0-9]{64}$/;
export function peerOrigin(raw){
  if(typeof raw!=='string'||raw.length>512)throw Error('invalid_origin');
  const u=new URL(raw);if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||!(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))throw Error('invalid_origin');return u.origin;
}
export function publicPostText(value){
  if(value?.protocol!=='hub.catalog.v1'||value.kind!=='post'||!Array.isArray(value.items)||value.items.length>30)throw Error('invalid_catalog');
  const ids=new Set();
  const items=value.items.map(p=>{
    if(!p||typeof p.id!=='string'||!(/^[A-Za-z0-9_-]{1,128}$/).test(p.id)||ids.has(p.id)||typeof p.title!=='string'||p.title.length>240||typeof p.summary!=='string'||p.summary.length>5000||p.path!==`/v2/posts/${p.id}`||typeof p.updatedAt!=='string'||p.updatedAt.length>64)throw Error('invalid_post');
    ids.add(p.id);return {id:p.id,title:p.title,summary:p.summary,path:p.path,updatedAt:p.updatedAt};
  });
  const text=JSON.stringify({protocol:'hub.catalog.v1',kind:'post',items});if(encoder.encode(text).length>MAX)throw Error('catalog_too_large');return text;
}
export async function catalogDigest(origin,text){
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(`${peerOrigin(origin)}\n${text}`))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function postManifest(origin,catalog){
  const text=publicPostText(catalog);return {protocol:'hub.post-manifest.v1',origin:peerOrigin(origin),digest:await catalogDigest(origin,text),bytes:encoder.encode(text).length,expiresAt:Date.now()+15000};
}
export function checkManifest(value,origin){
  if(value?.protocol!=='hub.post-manifest.v1'||value.origin!==peerOrigin(origin)||!hashPattern.test(value.digest)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>MAX||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||value.expiresAt>Date.now()+20000)throw Error('invalid_manifest');return value;
}
export async function verifyPostText(text,origin,manifest){
  checkManifest(manifest,origin);
  if(typeof text!=='string'||encoder.encode(text).length!==manifest.bytes||await catalogDigest(origin,text)!==manifest.digest)throw Error('unverified_catalog');
  const catalog=JSON.parse(text);if(publicPostText(catalog)!==text)throw Error('noncanonical_catalog');return catalog;
}
const b64=bytes=>{let result='';for(let i=0;i<bytes.length;i+=8192)result+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(result);};
async function sharedKey(privateKey,jwk){
  if(jwk?.kty!=='EC'||jwk.crv!=='P-256'||jwk.d||!(/^[\w-]{43}$/).test(jwk.x)||!(/^[\w-]{43}$/).test(jwk.y))throw Error('invalid_peer_key');
  const publicKey=await crypto.subtle.importKey('jwk',jwk,{name:'ECDH',namedCurve:'P-256'},false,[]);
  return crypto.subtle.deriveKey({name:'ECDH',public:publicKey},privateKey,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function sealPeerSignal(privateKey,publicKey,id,from,to,value){
  const text=JSON.stringify(value);if(encoder.encode(text).length>70000)throw Error('signal_too_large');
  const iv=crypto.getRandomValues(new Uint8Array(12)),key=await sharedKey(privateKey,publicKey);
  const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(`hub-public-posts-v1:${id}:${from}:${to}`)},key,encoder.encode(text)));
  const bytes=new Uint8Array(12+data.length);bytes.set(iv);bytes.set(data,12);return b64(bytes);
}
export async function openPeerSignal(privateKey,publicKey,id,from,to,ciphertext){
  if(typeof ciphertext!=='string'||ciphertext.length>100000)throw Error('signal_too_large');
  const bytes=Uint8Array.from(atob(ciphertext),c=>c.charCodeAt(0));if(bytes.length<29)throw Error('invalid_signal');
  const key=await sharedKey(privateKey,publicKey),data=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:encoder.encode(`hub-public-posts-v1:${id}:${from}:${to}`)},key,bytes.slice(12));
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  if(!UUID.test(value?.connectionId)||!['offer','answer'].includes(value.type)||typeof value.sdp!=='string'||value.sdp.length>65000)throw Error('invalid_signal');return value;
}
function gathered(pc){return new Promise((resolve,reject)=>{
  if(pc.iceGatheringState==='complete'){resolve();return;}
  const finish=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',check);resolve();};
  const check=()=>{if(pc.iceGatheringState==='complete')finish();};
  const timer=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',check);pc.localDescription?.sdp?resolve():reject(Error('ice_timeout'));},4500);
  pc.addEventListener('icegatheringstatechange',check);
});}

const peerLabel=value=>typeof value==='string'&&value.trim()&&value.length<=40&&!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)?value.trim():'Hub';
export function peerReadText(read){return read?`直近の取得: ${new URL(read.origin).host} · ${read.via==='peer'?`${read.peerLabel}から取得`:'配信元Hubから取得'}`:'公開投稿の取得はまだありません。';}
export function createPeerCatalog({base,storage,control,readCatalog,readManifest,label='Hubブラウザ',onState=()=>{},iceServers=[{urls:'stun:stun.cloudflare.com:3478'}]}){
  base=peerOrigin(base);
  let generation=0,readGeneration=0,device=null,profile='',timer,keys,roster=new Map(),lastPoll=0,enabled=false,disposed=false,retryAttempt=0;
  const connections=new Map(),cache=new Map(),listeners=new Set([onState]);
  let state={enabled:false,connected:0,status:'off',viaPeer:0,peers:[],lastRead:null};
  const snapshot=()=>({...state,peers:state.peers.map(p=>({...p})),lastRead:state.lastRead?{...state.lastRead}:null});
  const notify=patch=>{
    const peers=[...roster.values()].filter(p=>p.id!==device).map(p=>({id:p.id,label:peerLabel(p.label),status:connections.get(p.id)?.channel?.readyState==='open'?'connected':connections.has(p.id)?'connecting':'available'}));
    state={...state,...patch,enabled,peers,connected:peers.filter(p=>p.status==='connected').length};for(const f of listeners)f(snapshot());
  };
  const consentKey=id=>`hub.public-post-peers.v1.${encodeURIComponent(base)}.${id}`;
  const hasConsent=()=>{try{return !!profile&&storage.getItem(consentKey(profile))==='on';}catch{return false;}};
  const allowed=()=>{
    const all=[...roster.keys()].sort(),i=all.indexOf(device);if(i<0||all.length<2)return [];
    return [...new Set([all[(i+1)%all.length],all[(i+all.length-1)%all.length]])].filter(id=>id!==device);
  };
  function closePeer(id,expected){const p=connections.get(id);if(!p||(expected&&p!==expected))return;connections.delete(id);clearTimeout(p.deadline);p.pc.close();for(const r of p.pending.values()){clearTimeout(r.timer);r.reject(Error('peer_closed'));}p.pending.clear();notify({});}
  async function stop(invalidateReads=true){
    if(invalidateReads)++readGeneration;
    const token=++generation;clearTimeout(timer);const previous=device;device=null;keys=null;roster.clear();lastPoll=0;
    for(const id of [...connections.keys()])closePeer(id);cache.clear();
    if(previous)void control({action:'remove',deviceId:previous}).catch(()=>{});notify({status:'off',viaPeer:0,...(invalidateReads?{lastRead:null}:{})});return token;
  }
  async function syncConsent(){if(enabled&&!hasConsent()){enabled=false;await stop();}}
  async function failed(error,token){
    if(token!==generation)return;
    const signedOut=['account_required','account_changed'].includes(String(error?.message??error));
    const next=await stop(signedOut);if(next!==generation||disposed)return;
    if(signedOut){enabled=false;profile='';notify({status:'unavailable'});return;}
    if(profile&&!hasConsent()){++readGeneration;enabled=false;notify({status:'off'});return;}
    notify({status:String(error?.message??error)==='account_pending'?'waiting_account':'reconnecting'});
    const delay=Math.min(30000,2000*2**Math.min(retryAttempt++,4));
    timer=setTimeout(()=>{if(next===generation&&!disposed)return refresh(true);},delay);
  }
  function remember(origin,text){
    // Eviction is bounded independently of requests; only data read from a public source enters this map.
    const token=generation;
    return catalogDigest(origin,text).then(digest=>{
      if(token!==generation||!enabled||!device||!hasConsent())return;
      cache.delete(digest);cache.set(digest,{origin,text,expires:Date.now()+120000});
      while(cache.size>8||[...cache.values()].reduce((n,x)=>n+encoder.encode(x.text).length,0)>4*MAX)cache.delete(cache.keys().next().value);
    });
  }
  async function send(p,message){
    const channel=p.channel;if(channel?.readyState!=='open'||!enabled||!hasConsent())throw Error('peer_closed');
    const end=Date.now()+2000;while(channel.bufferedAmount>131072){if(channel.readyState!=='open'||Date.now()>end)throw Error('peer_backpressure');await new Promise(r=>setTimeout(r,15));}
    if(!enabled||!hasConsent()||connections.get(p.id)!==p)throw Error('peer_closed');
    channel.send(JSON.stringify(message));
  }
  async function serve(p,message){
    const entry=cache.get(message.digest),time=Date.now();
    p.requests=p.requests.filter(t=>t>time-10000);if(p.serving||p.requests.length>=4)throw Error('peer_request_limit');p.requests.push(time);p.serving=true;
    try{
      if(!entry||entry.expires<=time){await send(p,{type:'miss',id:message.id});return;}
      // Recheck the publisher before serving: withdrawn/restricted posts cannot be served from an old cache.
      const manifest=checkManifest(await readManifest(entry.origin),entry.origin);
      if(manifest.digest!==message.digest||Date.now()-lastPoll>15000||!roster.has(p.id))throw Error('source_changed');
      await send(p,{type:'begin',id:message.id,bytes:manifest.bytes});
      let seq=0;
      for(let start=0;start<entry.text.length;){let end=Math.min(start+CHUNK,entry.text.length);if(end<entry.text.length&&/[\uD800-\uDBFF]/.test(entry.text[end-1]))end--;await send(p,{type:'chunk',id:message.id,seq:seq++,text:entry.text.slice(start,end)});start=end;}
      await send(p,{type:'end',id:message.id});
    }catch{await send(p,{type:'miss',id:message.id}).catch(()=>{});}finally{p.serving=false;}
  }
  function attach(p,channel){
    if(channel.label!=='hub-public-posts-v1'||p.channel){channel.close();return;}p.channel=channel;
    channel.onopen=()=>{clearTimeout(p.deadline);if(connections.get(p.id)===p)notify({status:'ready'});};channel.onclose=()=>closePeer(p.id,p);
    channel.onmessage=event=>{
      try{
        if(!enabled||!hasConsent()||typeof event.data!=='string'||encoder.encode(event.data).length>50000||Date.now()-lastPoll>15000||!roster.has(p.id))throw Error('invalid_frame');
        const m=JSON.parse(event.data);if(!UUID.test(m.id))throw Error('invalid_request');
        if(m.type==='get'){
          if(!hashPattern.test(m.digest))throw Error('invalid_digest');void serve(p,m).catch(()=>closePeer(p.id,p));return;
        }
        const request=p.pending.get(m.id);if(!request)return;
        if(m.type==='miss'){clearTimeout(request.timer);p.pending.delete(m.id);request.reject(Error('cache_miss'));return;}
        if(m.type==='begin'){
          if(request.parts||!Number.isSafeInteger(m.bytes)||m.bytes<1||m.bytes>MAX)throw Error('invalid_size');request.parts=[];request.bytes=m.bytes;request.received=0;return;
        }
        if(m.type==='chunk'){
          if(!request.parts||m.seq!==request.parts.length||request.parts.length>=256||typeof m.text!=='string'||m.text.length>CHUNK)throw Error('invalid_chunk');
          request.received+=encoder.encode(m.text).length;if(request.received>request.bytes)throw Error('invalid_size');request.parts.push(m.text);return;
        }
        if(m.type==='end'&&request.parts&&request.received===request.bytes){clearTimeout(request.timer);p.pending.delete(m.id);request.resolve(request.parts.join(''));return;}
        throw Error('invalid_frame');
      }catch{closePeer(p.id,p);}
    };
  }
  function connect(id,connectionId){
    closePeer(id);const pc=new RTCPeerConnection({iceServers}),p={id,connectionId,pc,pending:new Map(),requests:[],serving:false};connections.set(id,p);
    p.deadline=setTimeout(()=>closePeer(id,p),25000);pc.ondatachannel=e=>attach(p,e.channel);
    pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState))closePeer(id,p);};return p;
  }
  async function signal(p,type){
    const peer=roster.get(p.id);if(!device||!keys||!peer||connections.get(p.id)!==p)throw Error('peer_closed');
    const id=crypto.randomUUID(),from=device,ciphertext=await sealPeerSignal(keys.privateKey,peer.publicKey,id,from,p.id,{type,connectionId:p.connectionId,sdp:p.pc.localDescription.sdp});
    if(device===from&&connections.get(p.id)===p)await control({action:'signal',deviceId:from,toPeer:p.id,id,ciphertext});
  }
  async function offer(id){const p=connect(id,crypto.randomUUID());try{attach(p,p.pc.createDataChannel('hub-public-posts-v1'));await p.pc.setLocalDescription(await p.pc.createOffer());await gathered(p.pc);await signal(p,'offer');}catch{if(connections.get(id)===p)closePeer(id);}}
  async function receive(message,token){
    const peer=roster.get(message.fromPeer);if(!peer||!allowed().includes(peer.id))return;
    const value=await openPeerSignal(keys.privateKey,peer.publicKey,message.id,peer.id,device,message.ciphertext);if(token!==generation)return;
    if(value.type==='offer'&&peer.id<device){const p=connect(peer.id,value.connectionId);try{await p.pc.setRemoteDescription({type:'offer',sdp:value.sdp});await p.pc.setLocalDescription(await p.pc.createAnswer());await gathered(p.pc);await signal(p,'answer');}catch{if(connections.get(peer.id)===p)closePeer(peer.id);}}
    else if(value.type==='answer'){const p=connections.get(peer.id);if(p&&p.connectionId===value.connectionId&&p.pc.signalingState==='have-local-offer')await p.pc.setRemoteDescription({type:'answer',sdp:value.sdp});}
  }
  async function poll(token){
    try{
      if(token!==generation||disposed)return;
      if(!hasConsent()){await syncConsent();return;}
      const data=await control({action:'poll',deviceId:device});if(token!==generation)return;
      if(!hasConsent()){await syncConsent();return;}
      if(!Array.isArray(data.peers)||data.peers.length>8||!Array.isArray(data.signals)||data.signals.length>16||data.peers.some(p=>!UUID.test(p.id)))throw Error('invalid_roster');
      if(!data.peers.some(p=>p.id===device)||new Set(data.peers.map(p=>p.id)).size!==data.peers.length)throw Error('invalid_roster');
      roster=new Map(data.peers.map(p=>[p.id,p]));lastPoll=Date.now();
      for(const id of [...connections.keys()])if(!allowed().includes(id))closePeer(id);
      const handled=new Set();
      for(const message of data.signals){if(handled.has(message.fromPeer))continue;handled.add(message.fromPeer);try{await receive(message,token);}catch{closePeer(message.fromPeer);}if(token!==generation)return;}
      if(data.signals.length)await control({action:'ack',deviceId:device,ids:data.signals.map(m=>m.id)});
      if(token!==generation)return;
      for(const id of allowed())if(device<id&&!connections.has(id))void offer(id);
      retryAttempt=0;notify({status:'ready'});timer=setTimeout(()=>poll(token),4000);
    }catch(error){await failed(error,token);}
  }
  async function refresh(automatic=false){
    const token=await stop(!automatic);if(disposed||token!==generation)return;
    if(automatic&&profile&&!hasConsent()){enabled=false;notify({status:'off'});return;}
    if(!automatic)retryAttempt=0;
    try{
      const identity=await control({action:'identity'});if(token!==generation)return;
      if(typeof identity.profileId!=='string'||identity.profileId.length>128)throw Error('invalid_identity');
      if(profile&&profile!==identity.profileId){++readGeneration;notify({lastRead:null});}
      profile=identity.profileId;enabled=storage.getItem(consentKey(profile))==='on';notify({status:enabled?'connecting':'off'});
      if(!enabled)return;
      const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveKey']);
      const publicKey=await crypto.subtle.exportKey('jwk',pair.publicKey);
      if(token!==generation)return;
      if(!hasConsent()){await syncConsent();return;}
      const registered=await control({action:'register',scope:'public-posts-v1',consent:true,label:peerLabel(label),publicKey:{kty:publicKey.kty,crv:publicKey.crv,x:publicKey.x,y:publicKey.y}});
      if(token!==generation||!hasConsent()){void control({action:'remove',deviceId:registered.id}).catch(()=>{});if(token===generation)await syncConsent();return;}
      if(!UUID.test(registered.id))throw Error('invalid_peer');device=registered.id;keys=pair;await poll(token);
    }catch(error){await failed(error,token);}
  }
  async function setEnabled(value){
    // Stopping the active transport must not depend on browser-storage availability.
    if(!value){enabled=false;await stop();if(profile)storage.setItem(consentKey(profile),'');return;}
    if(!profile){await refresh();if(!profile)throw Error('Hubへのログインを確認してください。');}
    storage.setItem(consentKey(profile),'on');enabled=true;await refresh();
  }
  function request(p,digest){return new Promise((resolve,reject)=>{
    if(p.pending.size>=4){reject(Error('peer_busy'));return;}
    const id=crypto.randomUUID(),timer=setTimeout(()=>{p.pending.delete(id);reject(Error('peer_timeout'));},1800);p.pending.set(id,{resolve,reject,timer});
    void send(p,{type:'get',id,digest}).catch(error=>{clearTimeout(timer);p.pending.delete(id);reject(error);});
  });}
  async function read(origin,signal){
    origin=peerOrigin(origin);const token=readGeneration;
    const peers=[...connections.values()].filter(p=>p.channel?.readyState==='open');
    if(enabled&&hasConsent()&&peers.length&&Date.now()-lastPoll<=15000){
      try{
        const manifest=checkManifest(await readManifest(origin,signal),origin);
        const {catalog,source}=await Promise.any(peers.map(async p=>({catalog:await verifyPostText(await request(p,manifest.digest),origin,manifest),source:peerLabel(roster.get(p.id)?.label)})));
        if(signal?.aborted||token!==readGeneration)throw Error('stale_read');
        await remember(origin,publicPostText(catalog));if(signal?.aborted||token!==readGeneration)throw Error('stale_read');notify({viaPeer:state.viaPeer+1,lastRead:{origin,via:'peer',peerLabel:source}});return catalog;
      }catch{/* A miss, malformed data, or unreachable peer always falls back to the publisher. */}
    }
    if(signal?.aborted)throw Error('aborted');
    const catalog=await readCatalog(origin,signal),text=publicPostText(catalog);
    if(signal?.aborted||token!==readGeneration)throw Error('stale_read');
    if(enabled)await remember(origin,text);if(signal?.aborted||token!==readGeneration)throw Error('stale_read');notify({lastRead:{origin,via:'publisher'}});return JSON.parse(text);
  }
  return {read,refresh,syncConsent,setEnabled,subscribe(fn){listeners.add(fn);fn(snapshot());return ()=>listeners.delete(fn);},async dispose(){disposed=true;enabled=false;await stop();listeners.clear();},get state(){return snapshot();}};
}
