// Hub動画（自作）をデスクトップの視聴画面で鳴らす。
// Rust の native_video_play が返す {playlist, expiresAt} を blob: URL にして、同梱の hls.js に渡す。
// 札（ticket）は Rust の外へ出ない。ここにあるのは絶対URLのプレイリスト（区切りのトークン入り）だけで、画面にも記録にも出さない。
// hls.js は同梱（ui/vendor/hls）。Worker は使わない（enableWorker:false）ので worker-src は要らない。
export const HLS_SCRIPT = './vendor/hls/hls.min.js';
const REFRESH_MARGIN_MS = 60_000;
const REFRESH_MIN_MS = 5_000;
const REFRESH_DEFAULT_MS = 10 * 60_000;

/** 期限の1分前に取り直す。期限が読めないときは10分。短すぎる値は5秒に丸める。 */
export function nextRefreshDelay(expiresAt, now = Date.now()) {
  const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(at)) return REFRESH_DEFAULT_MS;
  return Math.max(REFRESH_MIN_MS, at - now - REFRESH_MARGIN_MS);
}

let hlsPromise = null;
/** 同梱の hls.js を必要になったときだけ読む。読めなければ null。 */
export function loadHls(doc = document, win = window) {
  if (win.Hls) return Promise.resolve(win.Hls);
  hlsPromise ??= new Promise((resolve) => {
    const script = doc.createElement('script');
    script.src = HLS_SCRIPT;
    script.async = true;
    script.onload = () => resolve(win.Hls ?? null);
    script.onerror = () => { hlsPromise = null; resolve(null); };
    doc.head.append(script);
  });
  return hlsPromise;
}

/**
 * <video> に Hub動画を付ける。期限前にプレイリストを取り直し、位置はそのまま続ける。
 * 失敗は例外（始まらない）か onError（途中）。呼び手は「Hubで再生」へ戻す。
 */
export async function attachNativeHls(video, { play, loadHls: load = loadHls, onError = () => {}, createObjectURL = (b) => URL.createObjectURL(b), revokeObjectURL = (u) => URL.revokeObjectURL(u), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), now = () => Date.now() }) {
  let destroyed = false;
  let blobUrl = null;
  let hls = null;
  let timer = null;
  const fetchBlob = async () => {
    const issued = await play();
    const text = issued?.playlist;
    if (typeof text !== 'string' || !text.startsWith('#EXTM3U')) throw new Error('native_video_bad_response');
    const url = createObjectURL(new Blob([text], { type: 'application/vnd.apple.mpegurl' }));
    const previous = blobUrl;
    blobUrl = url;
    if (previous) setTimer(() => revokeObjectURL(previous), 60_000);
    return { url, delay: nextRefreshDelay(issued.expiresAt, now()) };
  };
  const first = await fetchBlob();
  if (destroyed) return { destroy() {} };
  const Hls = await load();
  if (!Hls || !Hls.isSupported()) { revokeObjectURL(first.url); throw new Error('native_video_unsupported'); }
  hls = new Hls({ enableWorker: false, lowLatencyMode: false });
  hls.on(Hls.Events.ERROR, (...args) => {
    const data = args[1];
    if (!data?.fatal) return;
    if (data.type === 'mediaError') hls?.recoverMediaError?.();
    else onError(new Error('native_video_playback'));
  });
  hls.loadSource(first.url);
  hls.attachMedia(video);
  const schedule = (delay) => { timer = setTimer(() => void refresh(), delay); };
  const refresh = async () => {
    if (destroyed) return;
    try {
      const resume = video.currentTime;
      const next = await fetchBlob();
      if (destroyed) return;
      hls.loadSource(next.url);
      hls.startLoad?.(resume);
      schedule(next.delay);
    } catch { if (!destroyed) onError(new Error('native_video_refresh')); }
  };
  schedule(first.delay);
  return {
    destroy() {
      destroyed = true;
      if (timer !== null) clearTimer(timer);
      hls?.destroy();
      hls = null;
      video.removeAttribute?.('src');
      video.load?.();
      if (blobUrl) revokeObjectURL(blobUrl);
      blobUrl = null;
    },
  };
}
