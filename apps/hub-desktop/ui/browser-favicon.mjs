/** Site icons arrive from the native side as bounded PNG data URLs; nothing else is ever put in an img src. */
export const FAVICON_PREFIX = 'data:image/png;base64,';
export const FAVICON_MAX_BYTES = 32 * 1024;
const MAX_LENGTH = FAVICON_PREFIX.length + Math.ceil(FAVICON_MAX_BYTES / 3) * 4;
// base64 of the first 7.5 bytes of the PNG signature (the 11th character depends on the next byte).
const PNG_HEAD = 'iVBORw0KGg';

export function validFavicon(value) {
  if (typeof value !== 'string' || value.length > MAX_LENGTH || !value.startsWith(FAVICON_PREFIX)) return false;
  const body = value.slice(FAVICON_PREFIX.length);
  return body.startsWith(PNG_HEAD) && body.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body);
}

/** The icon as an <img>, or null when the value is absent or not an acceptable PNG data URL. */
export function faviconImage(document, value) {
  if (!validFavicon(value)) return null;
  const image = document.createElement('img');
  image.alt = ''; image.width = 16; image.height = 16; image.decoding = 'async'; image.draggable = false;
  image.setAttribute('aria-hidden', 'true'); image.src = value;
  return image;
}

/** 16x16 slot: the icon when valid, otherwise the host's first letter drawn by CSS (not part of the text). */
export function faviconSlot(document, { icon, url = '' } = {}) {
  const slot = document.createElement('span'); slot.className = 'browser-favicon'; slot.setAttribute('aria-hidden', 'true');
  const image = faviconImage(document, icon);
  if (image) { slot.append(image); return slot; }
  let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* no host */ }
  slot.classList.add('is-fallback'); slot.dataset.letter = host ? Array.from(host)[0].toUpperCase() : '◎';
  return slot;
}
