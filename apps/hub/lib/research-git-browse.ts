export type ResearchGitCommit = { oid:string;parentOids:string[];subject:string;committedAt:string };
export type ResearchGitHistory = { projectId:string;commits:ResearchGitCommit[] };
export type ResearchGitCommitDetail = { projectId:string;commit:ResearchGitCommit & {message:string};files:{path:string;status:string;oldPath?:string}[];diff:string;truncated:boolean;baseOid?:string };
export function gitCommitOid(value:unknown):value is string {return typeof value==='string' && (value.length===40||value.length===64) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);}
const invalid=():never=>{throw new Error('invalid_git_response');};
const record=(value:unknown):Record<string,unknown>=>value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:invalid();
function bounded(value:unknown){try{const json=JSON.stringify(value);if(json===undefined||new TextEncoder().encode(json).length>512*1024)return invalid();}catch{return invalid();}}
function text(value:unknown,max:number,controls=false){if(typeof value!=='string'||value.length>max||(!controls&&/[\u0000-\u001f\u007f]/u.test(value)))return invalid();return value;}
function commit(value:unknown):ResearchGitCommit {
  const row=record(value);
  if(!gitCommitOid(row.oid)||!Array.isArray(row.parentOids)||row.parentOids.length>100||!row.parentOids.every(parent=>gitCommitOid(parent)&&parent.length===(row.oid as string).length))return invalid();
  const committedAt=text(row.committedAt,40);
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(committedAt)||!Number.isFinite(Date.parse(committedAt)))return invalid();
  return {oid:row.oid,parentOids:row.parentOids as string[],subject:text(row.subject,4096),committedAt};
}
export function parseResearchGitHistory(value:unknown,projectId:string):ResearchGitHistory {
  bounded(value);
  const row=record(value);if(row.projectId!==projectId||!Array.isArray(row.commits)||row.commits.length>20)return invalid();
  const commits=row.commits.map(commit);if(new Set(commits.map(item=>item.oid)).size!==commits.length)return invalid();return {projectId,commits};
}
export function parseResearchGitCommitDetail(value:unknown,projectId:string,oid:string,baseOid?:string):ResearchGitCommitDetail {
  bounded(value);
  const row=record(value),metadata=commit(row.commit);if(row.projectId!==projectId||metadata.oid!==oid||!Array.isArray(row.files)||row.files.length>100||typeof row.truncated!=='boolean')return invalid();
  if(row.baseOid!==baseOid||(baseOid!==undefined&&(!gitCommitOid(baseOid)||baseOid.length!==oid.length)))return invalid();
  const message=text(record(row.commit).message,65536,true);if(new TextEncoder().encode(message).length>65536)return invalid();
  const pathText=(value:unknown)=>{const path=text(value,8192,true);return !path||path.includes('\0')?invalid():path;};
  const files=row.files.map(value=>{const file=record(value),path=pathText(file.path),status=text(file.status,4);if(!/^(?:[AMDT]|[RC](?:100|[1-9]?[0-9]))$/.test(status))return invalid();return {path,status,...(file.oldPath===undefined?{}:{oldPath:pathText(file.oldPath)})};});
  return {projectId,commit:{...metadata,message},files,diff:text(row.diff,100000,true),truncated:row.truncated,...(baseOid===undefined?{}:{baseOid})};
}
