// 画面の文言の言語（この端末だけ）。元の文言は日本語のまま書き、表示のときに辞書で置き換える。
// 置き換えるのは、辞書にある UI の文言と完全に一致する文字だけ。利用者が書いた中身（投稿・名前・題）は訳さない。
// 鍵は localStorage の hub.desktop.locale。辞書は ./locales/<言語>.mjs（EXACT: 一致、PATTERNS: 数や時刻を含む形）。
export const LOCALE_KEY = 'hub.desktop.locale';
export const LOCALES = Object.freeze([['ja', '日本語'], ['en', 'English']]);
export const DEFAULT_LOCALE = 'ja';
const JAPANESE = /[぀-ヿ㐀-鿿]/;
const ATTRS = ['title', 'aria-label', 'placeholder', 'data-short-label'];
// 利用者が書いた中身の入れ物。中の文字は、UI の文言と同じ字面でも訳さない。
export const USER_CONTENT = [
  '[translate="no"]', '[data-user-content]', 'textarea', 'pre', 'code',
  '.post-body', '.post-author', '.post-handle', '.thread-row-title', '.thread-head-row > h3', '.thread-post', '.sidebar-detail-current',
  '.community-card-name', '.community-card-desc', '.community-head-name', '.community-head-desc', '.community-row-title', '.nav-community-name',
  '.article-title', '.article-reader-body', '.browser-bookmark-row', '.sidebar-tab', '.rail-chat-message', '.message-body', '.profile-name', '.profile-bio',
  '.piw-history-list', '.piw-title', '.piw-messages', '.card.history', '.community-card-icon', '.nav-community-face', '.community-head-icon', '.post-avatar', '.thread-tags',
].join(', ');

export const normalizeLocale = (value) => (LOCALES.some(([id]) => id === value) ? value : DEFAULT_LOCALE);
export function loadLocale(storage) { try { return normalizeLocale(storage?.getItem(LOCALE_KEY)); } catch { return DEFAULT_LOCALE; } }
export function saveLocale(storage, locale) { try { storage?.setItem(LOCALE_KEY, normalizeLocale(locale)); return true; } catch { return false; } }

/** 辞書から、1つの文言を訳す関数を作る。訳が無ければ null。前後の空白はそのまま残す。 */
export function createTranslator({ exact = {}, patterns = [], scoped = [] } = {}) {
  const table = new Map(Object.entries(exact));
  // scoped: [[セレクタ, { 日本語: 訳 }]]。同じ日本語でも置き場で訳が変わる文言（共有＝Share / Shared）。要素がそのセレクタの中にあるときだけ使う。
  return (text, element = null) => {
    if (typeof text !== 'string' || !JAPANESE.test(text)) return null;
    const core = text.trim();
    if (!core) return null;
    const lead = text.slice(0, text.indexOf(core)), tail = text.slice(text.indexOf(core) + core.length);
    if (element?.closest) for (const [selector, entries] of scoped) if (Object.hasOwn(entries, core) && element.closest(selector)) return lead + entries[core] + tail;
    if (table.has(core)) return lead + table.get(core) + tail;
    for (const [pattern, replacement] of patterns) if (pattern.test(core)) return lead + core.replace(pattern, replacement) + tail;
    // 「分類 件数」（雑談 13）の形：前の言葉が辞書にあれば、数はそのままで訳す。
    const counted = core.match(/^(.+?) ([\d,]+)$/);
    if (counted && table.has(counted[1])) return lead + table.get(counted[1]) + ' ' + counted[2] + tail;
    return null;
  };
}

/**
 * 文書に訳を当て続ける。locale が ja のあいだは何もしない。
 * dictionaries: { en: { exact, patterns } }。戻り値: { locale(), setLocale(), source(node), missing() }。
 */
export function installI18n({ document, storage = null, dictionaries = {}, locale = loadLocale(storage) }) {
  const view = document.defaultView;
  let current = normalizeLocale(locale);
  let translate = current === DEFAULT_LOCALE ? null : createTranslator(dictionaries[current]);
  const textSource = new WeakMap(), textShown = new WeakMap(); // 文字のノード → 元の日本語／当てた訳
  const attrSource = new WeakMap(), attrShown = new WeakMap(); // 要素 → { 属性: 値 }
  const touchedText = new Set(), touchedElements = new Set();
  const missing = new Set();
  const skipped = (element) => Boolean(element?.closest?.(USER_CONTENT));

  const applyText = (node) => {
    if (!translate) return;
    const value = node.nodeValue;
    if (textShown.get(node) === value) return; // 自分が当てた訳
    const parent = node.parentElement;
    if (!parent || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE' || skipped(parent)) return;
    const next = translate(value, parent);
    if (next === null) { if (JAPANESE.test(value)) missing.add(value.trim()); textSource.delete(node); textShown.delete(node); return; }
    textSource.set(node, value); textShown.set(node, next); touchedText.add(new view.WeakRef(node));
    node.nodeValue = next;
  };
  const applyAttrs = (element) => {
    if (!translate || !element.hasAttribute) return;
    for (const name of ATTRS) {
      if (!element.hasAttribute(name)) continue;
      const value = element.getAttribute(name);
      if (attrShown.get(element)?.[name] === value) continue;
      if (skipped(element)) continue;
      const next = translate(value, element);
      if (next === null) { if (JAPANESE.test(value)) missing.add(value.trim()); continue; }
      // CSS が日本語の aria-label で要素を選ぶ所のために、元の値を data-ja-label に残す。
      if (name === 'aria-label') element.setAttribute('data-ja-label', value);
      attrSource.set(element, { ...attrSource.get(element), [name]: value });
      attrShown.set(element, { ...attrShown.get(element), [name]: next });
      touchedElements.add(new view.WeakRef(element));
      element.setAttribute(name, next);
    }
  };
  const prune = () => {
    if (touchedText.size + touchedElements.size < 4000) return;
    for (const ref of touchedText) if (!ref.deref()?.isConnected) touchedText.delete(ref);
    for (const ref of touchedElements) if (!ref.deref()?.isConnected) touchedElements.delete(ref);
  };
  const walk = (root) => {
    if (!translate || !root) return;
    prune();
    if (root.nodeType === 3) { applyText(root); return; }
    if (root.nodeType !== 1) return;
    applyAttrs(root);
    const walker = document.createTreeWalker(root, 0x1 | 0x4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) { if (node.nodeType === 3) applyText(node); else applyAttrs(node); }
  };
  const restore = () => {
    for (const ref of touchedText) { const node = ref.deref(); if (node && textSource.has(node) && textShown.get(node) === node.nodeValue) node.nodeValue = textSource.get(node); if (node) { textSource.delete(node); textShown.delete(node); } }
    for (const ref of touchedElements) {
      const element = ref.deref(); if (!element) continue;
      const source = attrSource.get(element) ?? {}, shown = attrShown.get(element) ?? {};
      for (const name of Object.keys(source)) if (element.getAttribute(name) === shown[name]) element.setAttribute(name, source[name]);
      element.removeAttribute('data-ja-label');
      attrSource.delete(element); attrShown.delete(element);
    }
    touchedText.clear(); touchedElements.clear();
  };
  const observer = view.MutationObserver ? new view.MutationObserver((records) => {
    if (!translate) return;
    for (const record of records) {
      if (record.type === 'characterData') applyText(record.target);
      else if (record.type === 'attributes') applyAttrs(record.target);
      else for (const node of record.addedNodes) walk(node);
    }
  }) : null;
  observer?.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  const paint = () => { document.documentElement.setAttribute('lang', current); walk(document.documentElement); };
  paint();
  return {
    locale: () => current,
    setLocale(next) {
      const value = normalizeLocale(next);
      if (value === current) return current;
      restore();
      current = value;
      translate = current === DEFAULT_LOCALE ? null : createTranslator(dictionaries[current]);
      missing.clear();
      saveLocale(storage, current);
      paint();
      return current;
    },
    /** 画面の文字で判断している所のために、要素の元の日本語を返す。 */
    source(node) {
      if (!node) return '';
      if (node.nodeType === 3) return textSource.get(node) ?? node.nodeValue;
      let out = '';
      const walker = document.createTreeWalker(node, 0x4);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) out += textSource.get(text) ?? text.nodeValue;
      return out;
    },
    sourceAttr: (element, name) => attrSource.get(element)?.[name] ?? element?.getAttribute?.(name) ?? null,
    /** 訳が無くて日本語のまま出た文言（辞書を足すときの材料）。 */
    missing: () => [...missing],
    dispose() { observer?.disconnect(); restore(); },
  };
}

/** 設定の「表示」に置く言語の行。選ぶとすぐ切り替わり、保存する。言語の名前そのものは訳さない。 */
export function createLanguageSetting({ document, i18n }) {
  const row = document.createElement('div');
  row.className = 'setting-row appearance-group language-setting';
  row.dataset.setting = '言語';
  row.dataset.keywords = '言語 language english 英語 日本語 japanese';
  const text = document.createElement('span');
  text.className = 'setting-text';
  const label = document.createElement('span'); label.className = 'setting-label'; label.textContent = '言語';
  const desc = document.createElement('span'); desc.className = 'setting-desc'; desc.textContent = '画面の文言の言語です。投稿や名前など、書かれた中身は変わりません。';
  text.append(label, desc);
  const control = document.createElement('span');
  control.className = 'setting-control segmented';
  control.setAttribute('role', 'radiogroup');
  control.setAttribute('aria-label', '言語');
  const buttons = new Map();
  const sync = () => { for (const [id, button] of buttons) { const on = i18n.locale() === id; button.setAttribute('aria-checked', String(on)); button.classList.toggle('on', on); } };
  for (const [id, name] of LOCALES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('translate', 'no');
    button.dataset.locale = id;
    button.lang = id;
    button.textContent = name;
    button.addEventListener('click', () => { i18n.setLocale(id); sync(); });
    buttons.set(id, button);
    control.append(button);
  }
  sync();
  row.append(text, control);
  return row;
}
