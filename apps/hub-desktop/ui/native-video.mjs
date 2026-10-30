// Hub の自作動画（Hub動画）をデスクトップで扱う小さな決まり。
// 投稿・管理は video-studio.mjs（デスクトップ内のスタジオ）が行う。ここでは見分けと入口だけを持つ。
// HLS 再生とファイル送信は Rust 側の命令（native_video_*）を通す。再生は native-video-player.mjs（同梱 hls.js）。
// 窓の CSP は 2026-10-29 に最小限だけ広げた（apps/hub-desktop/AGENTS.md の Native video playback）。
const HUB_ORIGINS = new Set(['https://hub.jkamma.com', 'http://localhost:3020', 'http://127.0.0.1:3020']);

export const NATIVE_VIDEO_LABEL = 'Hub動画';

export function isNativeVideo(video) {
  return Boolean(video) && video.provider === 'hub';
}

/** 提供元の表示名。自作は「Hub動画」、それ以外は渡された名前のまま。 */
export function providerLabel(provider) {
  return provider === 'hub' ? NATIVE_VIDEO_LABEL : provider;
}

/** 視聴画面の「開く」ボタンの文字。自作は Hub の中で再生するので「提供元」とは言わない。 */
export function watchOpenLabel(video) {
  return isNativeVideo(video) ? 'Hubで再生' : '提供元で開く';
}

/** 「自分の動画」の行き先。Hub 自身の origin だけを受け付ける。 */
export function videoStudioUrl(origin) {
  if (typeof origin !== 'string') return null;
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (url.username || url.password || !HUB_ORIGINS.has(url.origin)) return null;
  return `${url.origin}/v2/studio/videos`;
}
