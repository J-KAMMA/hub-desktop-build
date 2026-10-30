import {normalizeHubOrigin} from './hub-network-client';

export const RESEARCH_FORK_BYTES = 1_000_000;
export type ResearchForkDocument = {id:string;title:string;kind:'paper'|'software'|'dataset'|'notebook';head:number;body:string;contentHash:string};
export type ResearchForkPackage = {
  protocol:'hub.research-fork.v1';
  project:{id:string;title:string;description:string;license:string|null;status:'draft'|'active'|'paused'|'completed';updatedAt:string};
  href:string;snapshotHash:string;documents:ResearchForkDocument[];
};
const invalid = ():never=>{throw Error('公開プロジェクトの版を確認できませんでした。');};
const record=(value:unknown,keys:string[])=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))return invalid();
  return value as Record<string,unknown>;
};
const text=(value:unknown,max:number,min=0):string=>typeof value==='string'&&value.length>=min&&value.length<=max&&!/[\uD800-\uDFFF]/u.test(value)?value:invalid();
const sha=(value:unknown):string=>typeof value==='string'&&value.length===71&&/^sha256:[a-f0-9]{64}$/.test(value)?value:invalid();
export const researchForkDigest=async(value:string)=>`sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('')}`;
export function researchForkPackagePath(id:string) {
  if(id.length!==35||!/^rp_[a-f0-9]{32}$/.test(id))return invalid();
  return `/api/network/v1/research/${id}/fork`;
}
/** The digest identifies content, not an author's signature or a transport-authenticated origin. */
export async function parseResearchForkPackage(input:unknown,origin:string,id:string):Promise<ResearchForkPackage> {
  origin=normalizeHubOrigin(origin);researchForkPackagePath(id);
  const raw=record(input,['protocol','project','href','snapshotHash','documents']);
  if(raw.protocol!=='hub.research-fork.v1'||raw.href!==`${origin}/v2/research/${id}`||!Array.isArray(raw.documents)||raw.documents.length>20)return invalid();
  const p=record(raw.project,['id','title','description','license','status','updatedAt']);
  if(p.id!==id||!['draft','active','paused','completed'].includes(String(p.status)))return invalid();
  const project:ResearchForkPackage['project']={id,title:text(p.title,240,3),description:text(p.description,5000),license:p.license===null?null:text(p.license,200,1),status:p.status as ResearchForkPackage['project']['status'],updatedAt:text(p.updatedAt,64,1)};
  if(!project.title.trim()||!Number.isFinite(Date.parse(project.updatedAt)))return invalid();
  let previous='';
  const documents:ResearchForkDocument[]=[];
  for(const item of raw.documents){
    const d=record(item,['id','title','kind','head','body','contentHash']), docId=text(d.id,128,1),body=text(d.body,100000,1),contentHash=sha(d.contentHash);
    if(!/^[A-Za-z0-9_.-]+$/.test(docId)||docId<=previous||!Number.isSafeInteger(d.head)||(d.head as number)<1||!['paper','software','dataset','notebook'].includes(String(d.kind))||!body.trim()||contentHash!==await researchForkDigest(body))return invalid();
    const title=text(d.title,240,1);if(!title.trim())return invalid();
    previous=docId;documents.push({id:docId,title,kind:d.kind as ResearchForkDocument['kind'],head:d.head as number,body,contentHash});
  }
  const value:ResearchForkPackage={protocol:'hub.research-fork.v1',project,href:raw.href as string,snapshotHash:sha(raw.snapshotHash),documents};
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>RESEARCH_FORK_BYTES||value.snapshotHash!==await researchForkDigest(JSON.stringify([value.href,project.title,project.description,project.license,project.status,project.updatedAt,documents])))return invalid();
  return value;
}
