import { HUB_SOCIAL_POST_MAX_CHARACTERS } from './social-post-limits';
import { researchDocumentHref } from './research-workspace';
import {gitCommitOid} from './research-git-browse';
import {parseGitHubRepositoryInput} from './github-repository';

export type ContentShareReference = ({ kind: 'article' | 'video' | 'music' | 'post' | 'project'; href: string } | { kind: 'research'; href: string; version: number } | {kind:'git';href:string;commit:string;base?:string}
  | {kind:'github';href:string;origin:'https://github.com';resource:'repository'|'issue'|'pull_request'|'commit';commit?:string;number?:number}) & {origin?:string};
const segment = (value: string) => value.length > 0 && value.length <= 240 && value !== '.' && value !== '..'
  && !/[\s\p{Cc}\p{Surrogate}/\\]/u.test(value);

function githubReference(raw: string): ContentShareReference | null {
  const match=raw.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)(?:\/(issues|pull|commit)\/([^/]+))?$/);
  const repository=match&&parseGitHubRepositoryInput(match[1]);
  if(!match||!repository||repository.href!==`https://github.com/${match[1]}`)return null;
  const reference={kind:'github' as const,href:raw,origin:'https://github.com' as const};
  if(!match[2])return {...reference,resource:'repository'};
  if(match[2]==='commit')return gitCommitOid(match[3])?{...reference,resource:'commit',commit:match[3]}:null;
  const number=Number(match[3]);
  return /^[1-9][0-9]*$/.test(match[3])&&Number.isSafeInteger(number)
    ?{...reference,resource:match[2]==='issues'?'issue':'pull_request',number}:null;
}

/** Only a public-page reference is transported, never its body or delivery URL. */
export function contentShareReference(raw: unknown): ContentShareReference | null {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\p{Cc}\p{Surrogate}]/u.test(raw)) return null;
  if (/^https?:\/\//.test(raw)) {
    try {
      const url=new URL(raw);
      if(url.href!==raw||url.origin.length>512||url.username||url.password
        ||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))return null;
      if(url.hostname==='github.com')return githubReference(raw);
      const reference=contentShareReference(url.pathname+url.search+url.hash);
      return reference&&reference.kind!=='github'?{...reference,href:raw,origin:url.origin}:null;
    }catch{return null;}
  }
  const catalog=raw.match(/^\/v2\/(posts|research)\/([A-Za-z0-9_-]{1,128})$/);
  if(catalog)return{kind:catalog[1]==='posts'?'post':'project',href:raw};
  const work = raw.match(/^\/v2\/(articles|videos)\/([A-Za-z0-9_-]{1,128})$/);
  if (work) return { kind: work[1] === 'articles' ? 'article' : 'video', href: raw };
  const music = raw.match(/^\/v2\/music\/works\/([^/?#]+)$/) ?? raw.match(/^\/v2\/music\?work=([^&#=]+)$/);
  if (music) {
    try {
      const id=decodeURIComponent(music[1]);
      return (/^[A-Za-z0-9_-]{1,128}$/.test(id)||/^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
        && encodeURIComponent(id)===music[1]?{kind:'music',href:raw}:null;
    } catch {return null;}
  }
  const git=raw.match(/^\/v2\/research\/(rp_[a-f0-9]{32})\?commit=([a-f0-9]+)(?:&base=([a-f0-9]+))?#git$/);
  if(git){
    const commit=git[2],base=git[3];
    return gitCommitOid(commit)&&(base===undefined||gitCommitOid(base)&&base.length===commit.length)
      ?{kind:'git',href:raw,commit,...(base===undefined?{}:{base})}:null;
  }
  const research = raw.match(/^\/v2\/research\/([^/?#]+)\?document=([^&#]+)&version=([1-9][0-9]*)$/);
  if (!research) return null;
  try {
    const project = decodeURIComponent(research[1]), document = decodeURIComponent(research[2]), version = Number(research[3]);
    return segment(project) && segment(document) && Number.isSafeInteger(version)
      && researchDocumentHref(project, document, version) === raw ? { kind: 'research', href: raw, version } : null;
  } catch { return null; }
}

export function contentShareHref(raw: unknown): string | null {
  const reference = contentShareReference(raw);
  return reference ? `/v2?social=post&feed=latest&share=${encodeURIComponent(reference.href)}#compose` : null;
}

export function appendContentShare(body: string, raw: unknown, origin: string): string {
  const reference = contentShareReference(raw), base = new URL(origin);
  if (!reference || !['http:', 'https:'].includes(base.protocol) || base.origin !== origin) throw Error('content_share_invalid');
  if (body.length > HUB_SOCIAL_POST_MAX_CHARACTERS) throw Error('content_share_full');
  const target = new URL(reference.href, base), href=target.href;
  const display=href;
  if (body.split(/\r?\n/).some(line => [href, display, reference.href].includes(line.trim()))) return body;
  const next = body + (body.length ? '\n\n' : '') + display;
  if (next.length > HUB_SOCIAL_POST_MAX_CHARACTERS) throw Error('content_share_full');
  return next;
}
