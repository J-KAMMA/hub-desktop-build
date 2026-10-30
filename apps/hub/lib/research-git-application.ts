import {gitCommitOid} from './research-git-browse';
import {gitProposalId,gitProposalText} from './research-git-proposals';
export const gitBranchName=(value:unknown):value is string=>gitProposalText(value,200)&&new TextEncoder().encode(value).length<=200&&!/[\x00-\x20\x7f\\]/u.test(value);
const hash=(v:unknown):v is string=>typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v);
export type GitApplicationIdentity={projectId:string;proposalId:string;snapshot:string;baseOid:string;headOid:string;comparisonHash:string};
export type GitApplicationPlan=GitApplicationIdentity & {branches:{branch:string;oid:string}[]};
export type GitApplicationResult=GitApplicationIdentity & {branch:string;currentOid:string;outcome:'updated'|'already_included'|'not_included'};
const fail=():never=>{throw Error('invalid_git_application_response');};
export function parseGitApplicationIdentity(value:unknown,project:string,id:string):GitApplicationIdentity{
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();const r=value as Record<string,unknown>;
 if(!gitProposalId(id)||r.projectId!==project||r.proposalId!==id||!hash(r.snapshot)||!hash(r.comparisonHash)||!gitCommitOid(r.baseOid)||!gitCommitOid(r.headOid)||r.baseOid===r.headOid||r.baseOid.length!==r.headOid.length)return fail();
 return {projectId:project,proposalId:id,snapshot:r.snapshot,comparisonHash:r.comparisonHash,baseOid:r.baseOid,headOid:r.headOid};
}
export function parseGitApplicationPlan(value:unknown,project:string,id:string):GitApplicationPlan{
 const identity=parseGitApplicationIdentity(value,project,id),r=value as Record<string,unknown>;
 if(!Array.isArray(r.branches)||r.branches.length>100)return fail();const branches=r.branches.map(v=>{if(!v||!gitBranchName(v.branch)||!gitCommitOid(v.oid)||v.oid.length!==identity.headOid.length)return fail();return {branch:v.branch as string,oid:v.oid as string};});
 if(new Set(branches.map(v=>v.branch)).size!==branches.length)return fail();return {...identity,branches};
}
export function parseGitApplicationResult(value:unknown,expected:GitApplicationIdentity,branch:string,readOnly=false):GitApplicationResult{
 const identity=parseGitApplicationIdentity(value,expected.projectId,expected.proposalId),r=value as Record<string,unknown>;
 if(Object.keys(identity).some(key=>identity[key as keyof GitApplicationIdentity]!==expected[key as keyof GitApplicationIdentity])||r.branch!==branch||!gitBranchName(r.branch)||!gitCommitOid(r.currentOid)||r.currentOid.length!==identity.headOid.length||!['already_included',readOnly?'not_included':'updated'].includes(String(r.outcome)))return fail();
 return {...identity,branch,currentOid:r.currentOid,outcome:r.outcome as GitApplicationResult['outcome']};
}
