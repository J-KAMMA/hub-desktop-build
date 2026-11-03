import { SEARCH_ENGINES } from './browser-navigation.mjs';

/*
 * Web検索の送信先（2026-11-03 所有者承認）。Hub内はHub自身の検索、Webは選んだ検索サイトをアプリ内ブラウザで開くだけ。
 * メタ検索もスクレイピングもしない。入力中の文字は確定するまでWebへ送らない。
 */
export const WEB_SEARCH_KEY = 'hub.desktop.webSearchEngine';
export const LEGACY_WEB_SEARCH_KEY = 'hub.browser.searchEngine';
export const DEFAULT_WEB_SEARCH_ENGINE = 'duckduckgo';

/** id -> { label, template } with `{q}` standing for the URL-encoded query. */
export const WEB_SEARCH_ENGINES = Object.freeze(Object.fromEntries(
  Object.entries(SEARCH_ENGINES).map(([id, value]) => [id, Object.freeze({ label: value.label, template: `${value.url}{q}` })])));

export const isWebSearchEngine = id => typeof id === 'string' && Object.hasOwn(WEB_SEARCH_ENGINES, id);

export function getWebSearchEngine(storage) {
  for (const key of [WEB_SEARCH_KEY, LEGACY_WEB_SEARCH_KEY]) {
    try { const saved = storage?.getItem(key); if (isWebSearchEngine(saved)) return saved; } catch { /* optional preference */ }
  }
  return DEFAULT_WEB_SEARCH_ENGINE;
}

export function setWebSearchEngine(storage, id) {
  if (!isWebSearchEngine(id)) return false;
  try { storage?.setItem(WEB_SEARCH_KEY, id); return true; } catch { return false; }
}

/** The search address for `query`, or null for an empty query or unknown engine. */
export function webSearchUrl(id, query) {
  const text = String(query ?? '').trim();
  if (!text || text.length > 2048 || !isWebSearchEngine(id)) return null;
  return WEB_SEARCH_ENGINES[id].template.replace('{q}', () => encodeURIComponent(text));
}

export const webSearchLabel = id => (isWebSearchEngine(id) ? WEB_SEARCH_ENGINES[id] : WEB_SEARCH_ENGINES[DEFAULT_WEB_SEARCH_ENGINE]).label;

/** Settings row 「Web検索」: one flat chip per engine. */
export function createWebSearchSetting({ document, storage, onChange }) {
  const row = document.createElement('div');
  row.className = 'setting-row is-stacked'; row.dataset.setting = 'Web検索'; row.dataset.keywords = '検索 エンジン DuckDuckGo Brave Google Bing ブラウザ';
  const text = document.createElement('span'); text.className = 'setting-text';
  const name = document.createElement('span'); name.className = 'setting-label'; name.textContent = 'Web検索';
  const desc = document.createElement('span'); desc.className = 'setting-desc'; desc.textContent = 'アドレス欄の「Webで探す」で開く検索サイトです。確定するまで入力は送られません。';
  text.append(name, desc);
  const group = document.createElement('span'); group.className = 'setting-control chip-row'; group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Web検索');
  const buttons = new Map();
  const paint = () => {
    const current = getWebSearchEngine(storage);
    for (const [id, button] of buttons) { button.classList.toggle('on', id === current); button.setAttribute('aria-checked', String(id === current)); button.tabIndex = id === current ? 0 : -1; }
  };
  for (const [id, engine] of Object.entries(WEB_SEARCH_ENGINES)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'chip'; button.setAttribute('role', 'radio'); button.dataset.engine = id; button.textContent = engine.label;
    button.addEventListener('click', () => { setWebSearchEngine(storage, id); paint(); onChange?.(id); });
    buttons.set(id, button); group.append(button);
  }
  paint();
  row.append(text, group);
  return { element: row, refresh: paint };
}
