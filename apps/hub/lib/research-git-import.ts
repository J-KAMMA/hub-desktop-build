import {gitBranchName} from './research-git-application';
import {gitCommitOid} from './research-git-browse';
import {gitProposalId} from './research-git-proposals';

export const GIT_IMPORT_MAX_BUNDLE_BYTES=50*1024*1024;
export const GIT_IMPORT_MAX_METADATA_BYTES=1024;
export const GIT_IMPORT_MAX_HEADER_BYTES=2048;
export type GitImportMetadata={requestId:string;branch:string;baseOid:string;headOid:string;bundleSha256:string};
export type GitImportResult=GitImportMetadata & {projectId:string;bundleBytes:number;baseTreeOid:string;headTreeOid:string;objectFormat:'sha1'|'sha256';candidateBranch:string;outcome:'preview'|'imported'|'already_imported'};
export type GitImportCheckResult=Omit<GitImportMetadata,'bundleSha256'> & {projectId:string;candidateBranch:string;currentOid:string|null;outcome:'imported'|'not_imported'};
const metadataKeys=['requestId','branch','baseOid','headOid','bundleSha256'] as const;
const fail=(message='invalid_git_import'):never=>{throw Error(message);};
const encoder=new TextEncoder();
const record=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
  const ownKeys=Reflect.ownKeys(value);
  if(ownKeys.length!==keys.length||ownKeys.some(key=>typeof key!=='string'||!keys.includes(key)))return fail();
  return value as Record<string,unknown>;
};
export const gitImportProjectId=(value:unknown):value is string=>typeof value==='string'&&value.length===35&&/^rp_[a-f0-9]{32}$/.test(value);
export const gitImportBranchName=(value:unknown):value is string=>gitBranchName(value)&&value!=='@'&&!/[\u0080-\u009f~^:?*\[]|\.\.|@\{/u.test(value)&&!value.endsWith('.')&&value.split('/').every(part=>part.length>0&&!part.startsWith('.')&&!part.endsWith('.lock'));

export function parseGitImportMetadata(value:unknown):GitImportMetadata{
  const r=record(value,metadataKeys);
  if(!gitProposalId(r.requestId)||!gitImportBranchName(r.branch)||!gitCommitOid(r.baseOid)||!gitCommitOid(r.headOid)||r.baseOid.length!==r.headOid.length||r.baseOid===r.headOid||typeof r.bundleSha256!=='string'||r.bundleSha256.length!==64||!/^[a-f0-9]{64}$/.test(r.bundleSha256))return fail();
  const metadata={requestId:r.requestId,branch:r.branch,baseOid:r.baseOid,headOid:r.headOid,bundleSha256:r.bundleSha256};
  if(encoder.encode(JSON.stringify(metadata)).length>GIT_IMPORT_MAX_METADATA_BYTES)return fail();
  return metadata;
}
const base64url=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export function encodeGitImportMetadataHeader(value:unknown):string{
  const header=base64url(encoder.encode(JSON.stringify(parseGitImportMetadata(value))));
  if(header.length>GIT_IMPORT_MAX_HEADER_BYTES)return fail();
  return header;
}
export function decodeGitImportMetadataHeader(value:unknown):GitImportMetadata{
  if(typeof value!=='string'||!value.length||value.length>GIT_IMPORT_MAX_HEADER_BYTES||!/^[A-Za-z0-9_-]+$/.test(value)||value.length%4===1)return fail();
  try{
    const bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4)),char=>char.charCodeAt(0));
    if(bytes.length>GIT_IMPORT_MAX_METADATA_BYTES||base64url(bytes)!==value)return fail();
    return parseGitImportMetadata(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)));
  }catch{return fail();}
}
/** Checks lengths only. Callers must independently hash and inspect the actual bundle. */
export function validateGitImportBundleLength(actualBytes:number,declaredLength?:number|string):number{
  if(!Number.isSafeInteger(actualBytes)||actualBytes<1)return fail('invalid_git_import_length');
  if(actualBytes>GIT_IMPORT_MAX_BUNDLE_BYTES)return fail('git_import_bundle_too_large');
  if(declaredLength!==undefined){
    if(typeof declaredLength!=='number'&&(typeof declaredLength!=='string'||!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)||String(Number(declaredLength))!==declaredLength))return fail('invalid_git_import_length');
    const declared=Number(declaredLength);
    if(!Number.isSafeInteger(declared)||declared<1)return fail('invalid_git_import_length');
    if(declared>GIT_IMPORT_MAX_BUNDLE_BYTES)return fail('git_import_bundle_too_large');
    if(declared!==actualBytes)return fail('invalid_git_import_length');
  }
  return actualBytes;
}
function binding(r:Record<string,unknown>,projectId:string,expected:GitImportMetadata,keys:readonly (keyof GitImportMetadata)[]){
  const metadata=parseGitImportMetadata(expected);
  if(!gitImportProjectId(projectId)||r.projectId!==projectId||keys.some(key=>r[key]!==metadata[key])||r.candidateBranch!==`hub-import/${metadata.requestId}`)return fail();
  return metadata;
}
export function parseGitImportResult(value:unknown,projectId:string,expected:GitImportMetadata,mode:'preview'|'save'):GitImportResult{
  const r=record(value,[...metadataKeys,'projectId','bundleBytes','baseTreeOid','headTreeOid','objectFormat','candidateBranch','outcome']);
  const metadata=binding(r,projectId,expected,metadataKeys),width=metadata.headOid.length;
  if(!gitCommitOid(r.baseTreeOid)||!gitCommitOid(r.headTreeOid)||r.baseTreeOid.length!==width||r.headTreeOid.length!==width||r.objectFormat!==(width===40?'sha1':'sha256')||typeof r.bundleBytes!=='number'||!(mode==='preview'?r.outcome==='preview':mode==='save'&&(r.outcome==='imported'||r.outcome==='already_imported')))return fail();
  validateGitImportBundleLength(r.bundleBytes);
  return {...metadata,projectId,bundleBytes:r.bundleBytes,baseTreeOid:r.baseTreeOid,headTreeOid:r.headTreeOid,objectFormat:width===40?'sha1':'sha256',candidateBranch:r.candidateBranch as string,outcome:r.outcome as GitImportResult['outcome']};
}
/** Proves current candidate equality only; it does not prove a historical byte hash or actor. */
export function parseGitImportCheckResult(value:unknown,projectId:string,expected:GitImportMetadata):GitImportCheckResult{
  const keys=['requestId','branch','baseOid','headOid'] as const;
  const r=record(value,[...keys,'projectId','candidateBranch','currentOid','outcome']),metadata=binding(r,projectId,expected,keys);
  if(r.currentOid!==null&&(!gitCommitOid(r.currentOid)||r.currentOid.length!==metadata.headOid.length)||r.outcome!==(r.currentOid===metadata.headOid?'imported':'not_imported'))return fail();
  return {projectId,requestId:metadata.requestId,branch:metadata.branch,baseOid:metadata.baseOid,headOid:metadata.headOid,candidateBranch:r.candidateBranch as string,currentOid:r.currentOid as string|null,outcome:r.outcome as GitImportCheckResult['outcome']};
}
