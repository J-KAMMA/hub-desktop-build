const plain=value=>!!value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const supported=model=>Array.isArray(model?.input)&&model.input.includes('image');
const modelSpec=value=>typeof value==='string'&&value.length>0&&value.length<=64&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(value)&&!value.includes('..')&&!/[\r\n]/u.test(value)&&value.indexOf('/')>0;
function local(model){
  try{const url=new URL(model.baseUrl);return url.protocol==='http:'&&!url.username&&!url.password
    &&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.port==='11434'&&['/','/v1','/v1/'].includes(url.pathname)&&!url.search&&!url.hash;}catch{return false;}
}
async function showVision(id,fetcher){
  try{const response=await fetcher('http://127.0.0.1:11434/api/show',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:id}),redirect:'error',signal:AbortSignal.timeout(1500)});
    if(!response.ok)throw Error('pi_image_unavailable');
    const reader=response.body?.getReader();if(!reader)throw Error('pi_image_unavailable');let count=0;const chunks=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>256*1024){await reader.cancel();throw Error('pi_image_unavailable');}chunks.push(value);}}finally{reader.releaseLock();}
    const data=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(!plain(data)||!Array.isArray(data.capabilities)||data.capabilities.length>32||data.capabilities.some(value=>typeof value!=='string'||value.length>80))throw Error('pi_image_unavailable');
    return data.capabilities.includes('vision');
  }catch{throw Error('pi_image_unavailable');}
}
/** Only selected-model metadata. Auth readiness uses local configuration, never refreshes credentials. */
export async function imageCapability(runtime,selected,fetcher=fetch){
  if(!modelSpec(selected))throw Error('pi_image_invalid_model');
  const slash=selected.indexOf('/'),provider=selected.slice(0,slash),id=selected.slice(slash+1);
  if(!id)throw Error('pi_image_invalid_model');
  let model=runtime.getModel(provider,id);const ready=runtime.hasConfiguredAuth(provider)===true;
  if(model&&(model.provider!==provider||model.id!==id))return{type:'imageCapability',model:selected,ready:false,supported:false};
  const known=provider==='ollama'&&typeof runtime.getModels==='function'?runtime.getModels('ollama'):[];
  if(!model&&provider==='ollama'&&known.some(value=>!local(value)))return{type:'imageCapability',model:selected,ready:false,supported:false};
  const vision=supported(model)||provider==='ollama'&&(!model||local(model))&&await showVision(id,fetcher);
  if(vision&&!model&&provider==='ollama'&&typeof runtime.registerProvider==='function'){
    runtime.registerProvider('ollama',{...(!known.length?{baseUrl:'http://127.0.0.1:11434/v1',api:'openai-completions',apiKey:'ollama'}:{}),
      models:[...known,{id,name:id,reasoning:false,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:1024}]});
    model=runtime.getModel(provider,id);
    return{type:'imageCapability',model:selected,ready:!!model&&runtime.hasConfiguredAuth(provider)===true,supported:!!model&&model.provider===provider&&model.id===id&&supported(model)};
  }
  return{type:'imageCapability',model:selected,ready,supported:vision};
}
/** A per-run model copy only. Passing the original registry model makes each new run/resume fresh. */
export async function imageModel(model,fetcher=fetch){
  if(supported(model))return model;
  if(model?.provider!=='ollama'||!local(model)||!modelSpec(`ollama/${model.id}`))return model;
  return await showVision(model.id,fetcher)?{...model,input:['text','image']}:model;
}
export function requireImageModel(model){
  if(!supported(model))throw Error('pi_image_unsupported_model');
}
