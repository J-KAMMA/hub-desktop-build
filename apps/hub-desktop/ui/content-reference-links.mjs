import {contentShareReference} from './content-share-contract.mjs';

function absoluteReference(raw) {
  if (!/^https?:\/\//u.test(raw)) return null;
  const reference = contentShareReference(raw);
  return reference;
}

const KIND_LABEL={music:"音楽",video:"動画",article:"記事",post:"投稿",project:"研究",research:"研究",git:"コミット"};
const safeDecode=v=>{try{return decodeURIComponent(v);}catch{return v;}};
const clip=(v,n)=>v.length>n?v.slice(0,n-1)+"…":v;
/** Short readable label for a confirmed reference (the full URL stays in title/aria-label). */
export function referenceLabel(reference) {
  try {
    const url=new URL(reference.href,reference.origin||"https://hub.invalid"),parts=url.pathname.split("/").filter(Boolean).map(safeDecode);
    if(reference.kind==="github")return clip("GitHub: "+parts.slice(0,2).join("/")+(parts[2]?" "+parts.slice(2).join(" #"):""),60);
    const id=parts[parts.length-1]||"";
    return clip((KIND_LABEL[reference.kind]||"リンク")+": "+id.replace(/^music:/,""),60);
  } catch { return "リンク"; }
}
/** Host plus a shortened path for an external URL. */
export function externalUrlLabel(raw) {
  try {
    const url=new URL(raw),path=(url.pathname==="/"?"":url.pathname)+url.search;
    return url.hostname.replace(/^www\./u,"")+clip(safeDecode(path),28);
  } catch { return raw; }
}

/** Only contract-confirmed public reference lines become links; the visible body stays exact. */
export function renderContentReferenceLinks(host, text, {open, isCurrent, compact = false, openUrl} = {}) {
  const current = () => { try { return isCurrent() === true; } catch { return false; } };
  if (!host?.ownerDocument || typeof text !== 'string' || typeof open !== 'function'
    || typeof isCurrent !== 'function' || !current()) return false;
  const document = host.ownerDocument, fragment = document.createDocumentFragment();
  text.split(/(\r\n|\r|\n)/u).forEach(line => {
    const raw = line.trim(), reference = absoluteReference(raw);
    if (!reference) {
      if (compact && typeof openUrl === "function" && /^https?:\/\/\S+$/u.test(raw) && raw.length <= 2048) {
        let url = null; try { url = new URL(raw); } catch { /* plain text */ }
        if (url && !url.username && !url.password) {
          const link = document.createElement("a"), at = line.indexOf(raw);
          link.href = url.href; link.className = "content-reference-link external"; link.title = raw; link.setAttribute("aria-label", raw);
          link.textContent = externalUrlLabel(raw);
          link.onclick = link.onauxclick = event => {
            if (event.button !== 0 && event.button !== 1) return;
            event.preventDefault(); event.stopPropagation();
            if (host.isConnected && link.isConnected && host.contains(link) && current()) openUrl(url.href, event);
          };
          fragment.append(document.createTextNode(line.slice(0, at)), link, document.createTextNode(line.slice(at + raw.length)));
          return;
        }
      }
      fragment.append(document.createTextNode(line)); return;
    }
    const anchor = document.createElement('a'), start = line.indexOf(raw);
    anchor.href = reference.href; anchor.className = 'content-reference-link'; anchor.textContent = compact ? referenceLabel(reference) : raw;
    if (compact) { anchor.title = raw; anchor.setAttribute("aria-label", raw); }
    anchor.onclick = anchor.onauxclick = event => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault(); event.stopPropagation();
      if (!host.isConnected || !anchor.isConnected || !host.contains(anchor) || !current()) return false;
      open(reference, event); return true;
    };
    fragment.append(document.createTextNode(line.slice(0, start)), anchor, document.createTextNode(line.slice(start + raw.length)));
  });
  if (!current()) return false;
  host.replaceChildren(fragment); return true;
}
