// data: の画像を、形を確かめてから blob: の URL にする。窓の CSP の img-src は data: を許さない。
// 確かめるのは宣言の型・base64 の形・大きさ・先頭の符号（PNG/JPEG/WebP/GIF）。復号は WebView 側のまま
// （作り直しは別の段）。一致しないものは null を返し、呼び出し側は画像なしの表示に落とす。

const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const CACHE_LIMIT = 256;
const cache = new Map();

export function sniffImageKind(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6)))) return 'gif';
  return null;
}

/** data:image/…;base64,… を検査して blob: の URL へ。不合格は null。同じ値は同じ URL を返す。 */
export function dataImageToBlobUrl(value, { maxBytes = 600 * 1024 } = {}) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 40) return null;
  const hit = cache.get(value);
  if (hit) return hit;
  const match = DATA_IMAGE.exec(value);
  if (!match || match[2].length % 4 !== 0) return null;
  let bytes;
  try {
    const binary = atob(match[2]);
    if (binary.length > maxBytes) return null;
    bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch { return null; }
  const kind = sniffImageKind(bytes);
  if (kind !== match[1]) return null;
  let url;
  try { url = globalThis.URL.createObjectURL(new Blob([bytes], { type: MIME[kind] })); } catch { return null; }
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    try { globalThis.URL.revokeObjectURL(cache.get(oldest)); } catch { /* 無くてよい */ }
    cache.delete(oldest);
  }
  cache.set(value, url);
  return url;
}
