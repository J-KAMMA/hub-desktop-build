export const RESEARCH_GIT_CHANGE_BYTES=8192;
const fields=['protocol','target','baseOid','headOid','title','summary'];
const fail=()=>{throw Error('Git変更ファイルの対象・版・内容を確認できません。');};
function object(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();
  return value;
}
function origin(value){
  if(typeof value!=='string'||value.length>512)fail();
  const url=new URL(value.trim());
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))fail();
  return url.origin;
}
const project=value=>typeof value==='string'&&value.length===35&&/^rp_[a-f0-9]{32}$/.test(value)?value:fail();
const oid=value=>typeof value==='string'&&(value.length===40||value.length===64)&&/^[a-f0-9]+$/.test(value)?value:fail();
const text=(value,max)=>typeof value==='string'&&value.length<=max&&value.trim()&&value===value.trim()&&!/[\0\uD800-\uDFFF]/u.test(value)?value:fail();
function contents(input,keys){
  const value=object(input,keys),target=object(value.target,['origin','projectId']),normalized=origin(target.origin),baseOid=oid(value.baseOid),headOid=oid(value.headOid);
  if(value.protocol!=='hub.research-git-change.v1'||target.origin!==normalized||baseOid.length!==headOid.length||baseOid===headOid)fail();
  return {protocol:'hub.research-git-change.v1',target:{origin:normalized,projectId:project(target.projectId)},baseOid,headOid,title:text(value.title,240),summary:text(value.summary,500)};
}
const digest=async value=>`sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('')}`;
function bounded(value){if(new TextEncoder().encode(JSON.stringify(value)).byteLength>RESEARCH_GIT_CHANGE_BYTES)fail();return value;}
/** This file describes a proposal; its digest does not establish authorship. */
export async function parseResearchGitChangePackage(input){
  const value=contents(input,[...fields,'contentHash']),contentHash=input.contentHash;
  if(typeof contentHash!=='string'||contentHash.length!==71||!/^sha256:[a-f0-9]{64}$/.test(contentHash))fail();
  const result=bounded({...value,contentHash});
  if(contentHash!==await digest(value))fail();
  return result;
}
export async function createResearchGitChangePackage(input){
  const value=contents(input,fields);
  bounded({...value,contentHash:`sha256:${'0'.repeat(64)}`});
  return {...value,contentHash:await digest(value)};
}
export async function readResearchGitChangeFile(file){
  if(!Number.isSafeInteger(file.size)||file.size<0||file.size>RESEARCH_GIT_CHANGE_BYTES)throw Error('Git変更ファイルは8KiBまでです。');
  const bytes=await file.arrayBuffer();
  if(bytes.byteLength>RESEARCH_GIT_CHANGE_BYTES)throw Error('Git変更ファイルは8KiBまでです。');
  return parseResearchGitChangePackage(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
}
export function parseResearchGitChangeTarget(value){
  if(typeof value!=='string'||value!==value.trim()||!/^https?:\/\/[^/?#\\\s]+\/v2\/research\/rp_[a-f0-9]{32}(?:#git)?$/i.test(value))fail();
  const url=new URL(value),projectId=project(url.pathname.slice('/v2/research/'.length));
  if(url.username||url.password||url.search||url.pathname!==`/v2/research/${projectId}`||url.hash&&url.hash!=='#git')fail();
  return {origin:origin(url.origin),projectId};
}
