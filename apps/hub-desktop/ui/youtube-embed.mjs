// Hubの中で再生できるのは YouTube の埋め込み（youtube-nocookie.com）だけ。
// 窓の CSP は frame-src にこの1つだけを許す。埋め込みの中から Hub の命令は呼べない（ACL で拒否されることを確認済み）。
const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);

/** YouTube の動画IDを URL から取り出す。YouTube 以外や形の崩れたものは null。 */
export function youtubeVideoId(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || !HOSTS.has(url.hostname.toLowerCase())) return null;
  const host = url.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (url.pathname === '/watch') id = url.searchParams.get('v');
  else {
    const match = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/);
    if (match) id = match[1];
  }
  return id && ID.test(id) ? id : null;
}

/** 埋め込み用の URL。動画IDが正しくなければ null。 */
export function youtubeEmbedUrl(id, { autoplay = false, start = 0 } = {}) {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  const params = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1', enablejsapi: '1' });
  if (autoplay) params.set('autoplay', '1');
  if (Number.isSafeInteger(start) && start > 0) params.set('start', String(start));
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}

/** 16:9 の枠に入った埋め込みプレーヤー。動画IDが正しくなければ null を返す。 */
export function createYouTubePlayer(document, { id, title = 'YouTube動画', autoplay = false } = {}) {
  const src = youtubeEmbedUrl(id, { autoplay });
  if (!src) return null;
  const frame = document.createElement('div');
  frame.className = 'yt-player';
  const iframe = document.createElement('iframe');
  iframe.src = src;
  iframe.title = title;
  iframe.loading = 'lazy';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  iframe.setAttribute('allowfullscreen', '');
  // 上の窓を動かせない・フォームを送れない。再生に要るものだけ許す。
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox');
  frame.append(iframe);
  return frame;
}

/** YouTube のサムネイル画像の URL（i.ytimg.com）。hubAsset 経由で読む。 */
export function youtubeThumbnailUrl(id, size = 'hqdefault') {
  return typeof id === 'string' && ID.test(id) && /^(?:default|mqdefault|hqdefault|sddefault|maxresdefault)$/.test(size) ? `https://i.ytimg.com/vi/${id}/${size}.jpg` : null;
}
