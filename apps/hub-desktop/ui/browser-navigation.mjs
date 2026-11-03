export const SEARCH_ENGINES = Object.freeze({
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  brave: { label: 'Brave', url: 'https://search.brave.com/search?q=' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
});

export function navigationTarget(input, engine = 'google') {
  const value = String(input ?? '').trim();
  if (!value) return null;
  if (value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('invalid_url');
  const explicit = /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^\s:/?#]+:\d+(?:[/?#]|$)/u.test(value);
  const address = explicit || !/\s/u.test(value) && (/^[^/?#]+\.[^/?#]+/u.test(value) || /^localhost(?:[:/?#]|$)/i.test(value) || /^\[[\da-f:]+\](?:[:/?#]|$)/i.test(value) || /^[^\s:/?#]+:\d+(?:[/?#]|$)/u.test(value));
  if (!address) return (Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine] : SEARCH_ENGINES.google).url + encodeURIComponent(value);
  try {
    const url = new URL(explicit ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error();
    if (!explicit && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname))) url.protocol = 'http:';
    return url.href;
  } catch { throw Error('invalid_url'); }
}

export function pageUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname !== 'tauri.localhost' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

// Suggestions are local. Typing never calls a search provider or loads a page.
export function addressSuggestions(query, { tabs = [], favorites = [], history = [], engine = 'google' } = {}) {
  const q = query.trim().toLocaleLowerCase();
  const entries = [], seen = new Set();
  for (const [kind, list] of [['tab', tabs], ['favorite', favorites], ['history', history]]) {
    for (const entry of list) {
      if (!pageUrl(entry.url) || seen.has(entry.url) || q && !`${entry.title ?? ''} ${entry.url}`.toLocaleLowerCase().includes(q)) continue;
      seen.add(entry.url);
      entries.push({ kind, id: entry.id, url: entry.url, title: entry.title || new URL(entry.url).hostname });
      if (entries.length === 7) break;
    }
    if (entries.length === 7) break;
  }
  if (q) {
    try {
      const url = navigationTarget(query, engine);
      if (url && !seen.has(url)) {
        const provider = Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine] : SEARCH_ENGINES.google;
        const search = url === provider.url + encodeURIComponent(query.trim());
        entries.unshift({ kind:'navigate', url, title:search ? `${provider.label}で「${query.trim()}」を検索` : 'このアドレスを開く', detail:search ? `Web検索 · ${provider.label}` : `開く · ${url}` });
      }
    } catch { /* invalid schemes never become a search request */ }
  }
  return entries.slice(0, 8);
}

export function browserShortcut({ key, ctrlKey, metaKey, altKey, shiftKey }) {
  if (typeof key !== 'string' || /[\u0000-\u001f\u007f]/u.test(key)) return null;
  const k = key.toLowerCase();
  const lookup = actions => Object.hasOwn(actions, k) ? actions[k] : null;
  // Chrome / Edge と同じ割り当て。Alt+D と F6 はアドレス欄、Ctrl+F5 と Ctrl+Shift+R はキャッシュを使わない再読み込み。
  if (altKey && !ctrlKey && !metaKey && !shiftKey) return lookup({ arrowleft: 'back', arrowright: 'forward', d: 'address' });
  const plain = !altKey && !ctrlKey && !metaKey && !shiftKey;
  if (k === 'f5' && !altKey) return ctrlKey || metaKey ? 'hard-reload' : 'reload';
  if (k === 'f6' && plain) return 'address';
  if (k === 'f11' && plain) return 'fullscreen';
  if (!(ctrlKey || metaKey) || altKey) return null;
  if (k === '+' || k === '=') return 'zoom-in';
  if (k === '-') return 'zoom-out';
  if (shiftKey) return lookup({ t: 'restore', tab: 'previous', a: 'tabs', n: 'private-new', o: 'favorites', r: 'hard-reload' });
  return lookup({ l: 'address', t: 'new', w: 'close', tab: 'next', pagedown: 'next', pageup: 'previous', f: 'find', r: 'reload', d: 'favorite', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset', h: 'history', j: 'downloads' }) ?? (/^[1-9]$/.test(k) ? `tab-${k}` : null);
}

// Ctrl+Enter: 単語だけなら www. と .com を補う（Chrome と同じ）。それ以外は null で、通常の判定に回す。
export function completeDotCom(input) {
  const value = String(input ?? '').trim();
  if (!/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(value)) return null;
  return `https://www.${value.toLowerCase()}.com/`;
}

// 選んだ文字列のWeb検索。制御文字と連続する空白は1つの空白にし、200文字で切る。
export function selectionSearchUrl(text, engine = 'google') {
  if (typeof text !== 'string') return null;
  const query = Array.from(text.replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim()).slice(0, 200).join('');
  if (!query) return null;
  return (Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine] : SEARCH_ENGINES.google).url + encodeURIComponent(query);
}

export function filterBrowserTabs(tabs, query = '') {
  const text = value => typeof value === 'string' ? value : '';
  const tokens = text(query).trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const seen = new Set();
  return (Array.isArray(tabs) ? tabs : []).filter(tab => {
    if (tab === null || typeof tab !== 'object' || Array.isArray(tab) || !Number.isSafeInteger(tab.id) || tab.id <= 0 || seen.has(tab.id)) return false;
    seen.add(tab.id);
    const haystack = [text(tab.title), text(tab.url), !text(tab.url).trim() ? '新しいタブ' : '', tab.pinned === true ? '固定' : '', tab.discarded === true ? '休止中 メモリ解放' : ''].join(' ').toLocaleLowerCase();
    return tokens.every(token => haystack.includes(token));
  });
}
