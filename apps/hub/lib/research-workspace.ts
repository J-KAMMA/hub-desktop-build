import { getInstanceOrigin, getInstanceHost } from "@/lib/instance-origin";
export const RESEARCH_LINK_KINDS = ['article', 'video', 'music', 'hubpedia', 'thread', 'community'] as const;
export type ResearchLinkKind = typeof RESEARCH_LINK_KINDS[number];
export const researchLinkLabels: Record<ResearchLinkKind, string> = {
  article: '記事', video: '動画', music:'音楽', hubpedia: '資料・知識（Hubpedia）', thread: 'スレッド', community: 'コミュニティ',
};
export const researchLinkPurposes: Record<ResearchLinkKind, string> = {
  article: '解説・報告', video: '実演・講義', music:'音源・制作', hubpedia: '背景知識', thread: '議論・検証', community: '活動拠点',
};
export function researchTargetId(kind: ResearchLinkKind, value: string, origin?: string): string | null {
  if (!RESEARCH_LINK_KINDS.includes(kind) || typeof value !== 'string' || value.length > 1000 || origin !== undefined && (typeof origin !== 'string' || origin.length > 512) || /[\u0000-\u001f\u007f-\u009f\\]/u.test(value)) return null;
  try {
    encodeURIComponent(value);
    const input = value.trim(), base = new URL(origin ?? getInstanceOrigin());
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash || !(base.protocol === 'https:' || base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) return null;
    if(kind==='music') {
      const key=(id:string)=>/^[A-Za-z0-9_-]{1,128}$/.test(id)||/^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
      if(key(input))return input;
      const url=new URL(input,base),work=url.pathname==='/v2/music'&&/^\?work=[^&=]+$/.test(url.search)?url.search.slice(6):null;
      if(work!==null){const id=decodeURIComponent(work);return url.origin===base.origin&&!url.username&&!url.password&&!url.hash&&key(id)&&encodeURIComponent(id)===work?id:null;}
      const match=url.pathname.match(/^\/v2\/music\/works\/([^/]+)$/),id=match&&decodeURIComponent(match[1]);
      return url.origin===base.origin&&!url.username&&!url.password&&!url.search&&!url.hash&&id&&key(id)&&encodeURIComponent(id)===match![1]?id:null;
    }
    if (!/[/?#:]/u.test(input)) return input && input.length <= 240 ? input : null;
    if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$|[?#])/iu.test(input)) return null;
    const url = new URL(input, base);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (origin ? url.origin !== base.origin : ![getInstanceHost().split(':')[0],'localhost','127.0.0.1'].includes(url.hostname))) return null;
    if (kind === 'community' && /^\/(v2\/)?community\/?$/.test(url.pathname)) {
      const id = url.searchParams.get('community');
      decodeURIComponent(url.search.slice(1));
      return url.searchParams.size === 1 && id && id.length <= 240 && !/[\u0000-\u001f\u007f-\u009f/\\]/u.test(id) ? id : null;
    }
    if (url.search) return null;
    const route = {article:'articles',video:'videos',hubpedia:'hubpedia',thread:'threads',community:'community'}[kind];
    const match = url.pathname.match(new RegExp(`^/(?:v2/)?${route}/([^/]+)/?$`));
    const id = match && decodeURIComponent(match[1]);
    return id && id.length <= 240 && !/[\u0000-\u001f\u007f-\u009f/\\]/u.test(id) ? id : null;
  } catch { return null; }
}
export function researchTargetPath(kind: ResearchLinkKind, id: string) {
  const value = encodeURIComponent(id);
  if(kind==='music')return `/v2/music?work=${value}`;
  return kind === 'community' ? `/v2/community?community=${value}`
    : `/v2/${({ article: 'articles', video: 'videos', hubpedia: 'hubpedia', thread: 'threads' } as const)[kind]}/${value}`;
}
export type ResearchLink = { kind: ResearchLinkKind; targetId: string; title: string; href: string };
export type ResearchDocument = { id: string; projectId: string; title: string; kind: string; visibility: string; head: number; updatedAt: string };
export type ResearchRevision = { id: string; version: number; body: string; contentHash: string; summary: string; createdAt: string };
export type ResearchProposal = { id: string; documentId: string; baseVersion: number; body: string; summary: string; status: string; createdAt: string };
export type ResearchProposalCreated = {proposalId:string;documentId:string;baseVersion:number;contentHash:string;status:'open'|'accepted'|'rejected'};
export type ResearchProposalSnapshot = {proposalId:string;baseVersion:number;proposalHash:string;baseHash:string;currentHead:number};
export type ResearchProposalDecision = {proposalId:string;status:'accepted'|'rejected';adoptedRevision:{version:number;contentHash:string;href:string}|null};
export type ResearchProposalReview = {proposal:ResearchProposal & {contentHash:string};document:Pick<ResearchDocument,'id'|'projectId'|'title'|'visibility'|'head'>;baseRevision:{version:number;body:string;contentHash:string};snapshot:ResearchProposalSnapshot;canDecide:boolean;canDiscuss:boolean;adoptedRevision:ResearchProposalDecision['adoptedRevision']};
export type ResearchWorkspaceData = { links: ResearchLink[]; documents: ResearchDocument[]; proposals: ResearchProposal[] };

export type ResearchDiscussionSource = {
  projectId: string; projectTitle: string; documentId: string; title: string;
  version: number; contentHash: string; href: string;
};
export function researchDocumentHref(projectId: string, documentId: string, version: number) {
  return `/v2/research/${encodeURIComponent(projectId)}?document=${encodeURIComponent(documentId)}&version=${version}`;
}
export function formatResearchDiscussionBody(source: ResearchDiscussionSource, body: string) {
  return `${body.trim()}\n\n参照: ${source.projectTitle} / ${source.title} · v${source.version}\n${source.contentHash}\n${source.href}`;
}

export type ResearchProposalDiscussionLink={linkId:string;threadId:string;linked:boolean;available:boolean;title:string|null;href:string|null};
export type ResearchProposalDiscussions={proposalId:string;canManage:boolean;links:ResearchProposalDiscussionLink[]};
export type ResearchProposalDiscussionResult={proposalId:string;threadId:string;linkId:string;linked:boolean};
