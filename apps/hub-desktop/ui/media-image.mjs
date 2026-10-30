// 画像の出どころの検査と、読めない画像の代わりの表紙。
// 窓の CSP の img-src は 'self'・blob:・data:・Hub の出どころ・i.ytimg.com だけ（広げない）。
// それ以外の画像は <img> を出さず、題を組んだ表紙（.ds-cover）にする。壊れた画像の記号を見せない。

const ALLOWED_ORIGINS = new Set(['http://localhost:3020', 'http://127.0.0.1:3020', 'https://hub.jkamma.com', 'https://i.ytimg.com']);
const YT_THUMB = /^https:\/\/i\.ytimg\.com\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\/[a-z0-9]+\.(?:jpg|webp)$/;

/** この URL の画像を窓が読めるか。Hub の相対パスは Hub の出どころに解決されるので読める。 */
export function isAllowedImageUrl(value, { hubOrigin = '' } = {}) {
  if (typeof value !== 'string' || !value || value.length > 2048) return false;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/')) return true;
  if (/^(?:blob|data):/i.test(value)) return /^data:image\//i.test(value) || /^blob:/i.test(value);
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  return ALLOWED_ORIGINS.has(url.origin) || (hubOrigin !== '' && url.origin === hubOrigin);
}

/**
 * 正方形の枠に入れる YouTube の絵。hqdefault / sddefault（4:3）は上下に黒帯を焼き込んでいるので、
 * 帯の無い 16:9 の mqdefault（320×180）に替える。正方形には object-fit: cover で中央を切る。
 */
export function squareArtworkUrl(value) {
  if (typeof value !== 'string') return value;
  const match = YT_THUMB.exec(value);
  return match ? `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg` : value;
}

/** 題を組んだ表紙。画像が無い・許可されない・読めないときの代わり。 */
export function createTextCover(document, title, className = '') {
  const cover = document.createElement('span');
  cover.className = `ds-cover${className ? ` ${className}` : ''}`;
  cover.textContent = String(title ?? '').trim() || 'Hub';
  return cover;
}

export function createGeneratedCover(document, label, className = '') {
  const cover = document.createElement('span');
  cover.className = `ds-cover ds-cover-generated${className ? ` ${className}` : ''}`;
  const caption = document.createElement('span');
  caption.className = 'ds-cover-label';
  caption.textContent = String(label ?? '').trim() || '記事';
  cover.append(caption);
  return cover;
}

/**
 * 媒体枠（.ds-media）。許可された画像だけ <img> を入れ、読めなければ表紙に替える。
 * ratio は CSS の aspect-ratio の値（例 '16 / 9'）。枠の寸法は画像より先に決まる（CLS を出さない）。
 */
export function createCoverMedia(document, { url, title, fallbackLabel, hubAsset, hubOrigin = '', ratio = '16 / 9', className = '', square = false } = {}) {
  const frame = document.createElement('span');
  frame.className = `ds-media${className ? ` ${className}` : ''}`;
  frame.style.setProperty('--ratio', ratio);
  const fallback = () => frame.append(fallbackLabel === undefined ? createTextCover(document, title) : createGeneratedCover(document, fallbackLabel));
  const target = square ? squareArtworkUrl(url) : url;
  if (!isAllowedImageUrl(target, { hubOrigin }) || typeof hubAsset !== 'function') {
    fallback();
    return frame;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.onerror = () => { img.remove(); fallback(); };
  hubAsset(img, target);
  frame.append(img);
  return frame;
}
