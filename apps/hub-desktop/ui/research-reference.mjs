/** Recognize the canonical, version-pinned reference at the end of discussion text. */
export function researchDiscussionReference(body) {
  if(typeof body!=='string'||body.length>4000)return null;
  const match=body.match(/(?:^|\n)sha256:[a-f0-9]{64}\n(\/v2\/research\/([^/?#\s]+)\?document=([^&#\s]+)&version=([1-9][0-9]*))$/);
  if(!match)return null;
  const [,href,project,document,rawVersion]=match,version=Number(rawVersion);
  if(!Number.isSafeInteger(version)||href.length>2048)return null;
  try {
    for(const encoded of [project,document]) {
      const id=decodeURIComponent(encoded);
      if(!id||id.length>240||/[\u0000-\u0020\u007f-\u009f/\\]/u.test(id)||id==='.'||id==='..'||encodeURIComponent(id)!==encoded)return null;
    }
    return {href,version};
  }catch{return null;}
}

/** Recognize only the canonical same-hash Git reference at the end of visible text. */
export function researchGitDiscussionReference(body) {
  if(typeof body!=='string'||body.length>4000)return null;
  const match=body.match(/(?:^|\n)参照Git: [^\r\n]+\n([a-f0-9]{40}|[a-f0-9]{64})\n(\/v2\/research\/rp_[a-f0-9]{32}\?commit=([a-f0-9]{40}|[a-f0-9]{64})#git)$/);
  if(!match||match.index+match[0].length!==body.length||match[1]!==match[3])return null;
  return {href:match[2],oid:match[1]};
}
