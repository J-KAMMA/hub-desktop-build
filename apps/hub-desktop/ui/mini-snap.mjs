// 小窓（mini-player.mjs と yt-dock.mjs の小窓）が共有する位置の決め方。
// 位置は四隅のどれかに吸着し、端末ごとに覚える（hub. 接頭辞のキー）。覚えられなくても再生は続ける。
export const CORNER_KEY = 'hub.miniPlayer.corner.v1';
export const MARGIN = 16;
export const CORNERS = ['br', 'bl', 'tr', 'tl'];

export function readCorner(storage) {
  try { const value = storage?.getItem(CORNER_KEY); return CORNERS.includes(value) ? value : null; } catch { return null; }
}
export function writeCorner(storage, corner) {
  try { if (CORNERS.includes(corner)) storage?.setItem(CORNER_KEY, corner); } catch { /* 位置は覚えられなくても再生は続ける */ }
}

/** 窓の中心がある側の隅。 */
export function nearestCorner(box, view) {
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  return (cy < view.height / 2 ? 't' : 'b') + (cx < view.width / 2 ? 'l' : 'r');
}

/** 隅から、画面の端までの距離（right/bottom 基準）。窓が画面からはみ出さないよう丸める。 */
export function cornerInsets(corner, size, view, margin = MARGIN) {
  const maxRight = Math.max(margin, view.width - size.width - margin), maxBottom = Math.max(margin, view.height - size.height - margin);
  return { right: corner.endsWith('l') ? maxRight : margin, bottom: corner.startsWith('t') ? maxBottom : margin };
}

/** 動かしている最中の位置を窓の内側に収める。 */
export function clampInsets(value, size, view, margin = MARGIN) {
  const maxRight = Math.max(margin, view.width - size.width - margin), maxBottom = Math.max(margin, view.height - size.height - margin);
  return { right: Math.min(Math.max(value.right, margin), maxRight), bottom: Math.min(Math.max(value.bottom, margin), maxBottom) };
}

/** 上の隅なら下へ、下の隅なら上へ積む（別の小窓の高さ分だけずらす）。 */
export function stackedBottom(corner, base, otherHeight, gap = 8) {
  return corner.startsWith('t') ? base - (otherHeight ? otherHeight + gap : 0) : base + (otherHeight ? otherHeight + gap : 0);
}
