import {gitCommitOid,parseResearchGitCommitDetail,type ResearchGitCommitDetail} from './research-git-browse';
export const gitProposalId=(value:unknown):value is string=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const gitProposalText=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);
export async function gitComparisonHash(value:ResearchGitCommitDetail){const bytes=new TextEncoder().encode(JSON.stringify(parseResearchGitCommitDetail(value,value.projectId,value.commit.oid,value.baseOid)));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');}
export type GitProposal={id:string;projectId:string;baseOid:string;headOid:string;title:string;summary:string;status:'open'|'approved'|'rejected';createdAt:string;resolvedAt:string|null;mine:boolean};
export type GitProposalReview={proposal:GitProposal;canManage:boolean;canReview:boolean;snapshot:string;comparison?:ResearchGitCommitDetail;comparisonHash?:string;comparisonError?:string};
export type GitProposalPage={projectId:string;proposals:GitProposal[];nextCursor:string|null};
export type GitProposalCreate={action:'create';requestId:string;baseOid:string;headOid:string;title:string;summary:string;comparisonHash:string};
export type GitProposalDecision={action:'approve'|'reject';proposalId:string;snapshot:string;comparisonHash?:string;fullReviewConfirmed?:boolean};
const fail=():never=>{throw Error('invalid_git_proposal_response');};
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail();
const bounded=(value:unknown)=>{try{if(new TextEncoder().encode(JSON.stringify(value)).length>512*1024)return fail();}catch{return fail();}};
const hash=(value:unknown)=>typeof value==='string'&&value.length===64&&/^[a-f0-9]+$/.test(value);
const time=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function parseGitProposal(value:unknown,projectId:string,id?:string):GitProposal{
  const row=record(value);if(!gitProposalId(row.id)||id!==undefined&&row.id!==id||row.projectId!==projectId||!gitCommitOid(row.baseOid)||!gitCommitOid(row.headOid)||row.baseOid.length!==row.headOid.length||row.baseOid===row.headOid||!gitProposalText(row.title,240)||!gitProposalText(row.summary,500)||typeof row.status!=='string'||!['open','approved','rejected'].includes(row.status)||!time(row.createdAt)||typeof row.mine!=='boolean'||(row.status==='open'?row.resolvedAt!==null:!time(row.resolvedAt)))return fail();
  return {id:row.id,projectId,baseOid:row.baseOid,headOid:row.headOid,title:row.title,summary:row.summary,status:row.status as GitProposal['status'],createdAt:row.createdAt as string,resolvedAt:row.resolvedAt as string|null,mine:row.mine};
}
export function parseGitProposalReview(value:unknown,projectId:string,id:string):GitProposalReview{
  bounded(value);
  const row=record(value),proposal=parseGitProposal(row.proposal,projectId,id);if(typeof row.canManage!=='boolean'||typeof row.canReview!=='boolean'||!hash(row.snapshot)||row.canReview&&(!row.canManage||proposal.status!=='open'))return fail();
  const result:GitProposalReview={proposal,canManage:row.canManage,canReview:row.canReview,snapshot:row.snapshot as string};
  if(row.comparison!==undefined){if(!hash(row.comparisonHash))return fail();result.comparison=parseResearchGitCommitDetail(row.comparison,projectId,proposal.headOid,proposal.baseOid);result.comparisonHash=row.comparisonHash as string;}
  else if(row.comparisonHash!==undefined)return fail();
  if(row.comparisonError!==undefined){if(!gitProposalText(row.comparisonError,500)||row.comparison!==undefined)return fail();result.comparisonError=row.comparisonError;}
  return result;
}
export function parseGitProposalPage(value:unknown,projectId:string):GitProposalPage{
  bounded(value);
  const row=record(value);if(row.projectId!==projectId||!Array.isArray(row.proposals)||row.proposals.length>50||!(row.nextCursor===null||typeof row.nextCursor==='string'&&row.nextCursor.length<=256))return fail();
  const proposals=row.proposals.map(item=>parseGitProposal(item,projectId));if(new Set(proposals.map(item=>item.id)).size!==proposals.length)return fail();return {projectId,proposals,nextCursor:row.nextCursor as string|null};
}
