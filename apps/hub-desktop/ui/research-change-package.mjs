export const RESEARCH_CHANGE_BYTES=500000;
const invalid=()=>{throw Error('変更ファイルの対象・版・内容を確認できません。');};
const record=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)??{},'value')))invalid();return value;};
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/\p{Surrogate}/u.test(value)?value:invalid();
const hash=value=>typeof value==='string'&&value.length===71&&/^sha256:[a-f0-9]{64}$/u.test(value)?value:invalid();
export function normalizeResearchHubOrigin(value){
  if(typeof value!=='string'||value.length>512)invalid();const url=new URL(value.trim());
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))invalid();return url.origin;
}
export function validateResearchChangeTarget(value){
  const target=record(value,['origin','projectId','documentId','baseVersion','baseHash']),origin=normalizeResearchHubOrigin(target.origin);
  if(origin!==target.origin||typeof target.projectId!=='string'||target.projectId.length!==35||!/^rp_[a-f0-9]{32}$/u.test(target.projectId)||!text(target.documentId,100)||/[^A-Za-z0-9_.-]/u.test(target.documentId)||!Number.isSafeInteger(target.baseVersion)||target.baseVersion<1)invalid();
  return{origin,projectId:target.projectId,documentId:target.documentId,baseVersion:target.baseVersion,baseHash:hash(target.baseHash)};
}
export const researchForkDigest=async value=>`sha256:${Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('')}`;
export async function parseResearchChangePackage(input){
  const packet=record(input,['protocol','target','body','summary','contentHash']);if(packet.protocol!=='hub.research-change.v1')invalid();
  const result={protocol:packet.protocol,target:validateResearchChangeTarget(packet.target),body:text(packet.body,100000),summary:text(packet.summary,500),contentHash:hash(packet.contentHash)};
  if(result.summary!==result.summary.trim()||new TextEncoder().encode(JSON.stringify(result)).byteLength>RESEARCH_CHANGE_BYTES||result.contentHash!==await researchForkDigest(result.body))invalid();return result;
}
export async function readResearchChangeFile(file){
  if(!file||!Number.isSafeInteger(file.size)||file.size<0||file.size>RESEARCH_CHANGE_BYTES||typeof file.arrayBuffer!=='function')throw Error('変更ファイルは500KBまでです。');
  const bytes=await file.arrayBuffer();if(!(bytes instanceof ArrayBuffer)||bytes.byteLength>RESEARCH_CHANGE_BYTES)throw Error('変更ファイルは500KBまでです。');
  return parseResearchChangePackage(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
}
