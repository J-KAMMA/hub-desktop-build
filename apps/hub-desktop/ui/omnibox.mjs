import { navigationTarget, SEARCH_ENGINES, pageUrl } from './browser-navigation.mjs';

/*
 * 一番上の検索欄をHubの検索とWebのアドレス欄の両方にする（2026-10-12 ユーザー指定）。
 * 候補は「Hubで検索」「Web検索（またはこのアドレスを開く）」と、手元のお気に入り・履歴だけから作る。
 * 入力中の文字はどこへも送らない。確定したときだけ、選んだ先（HubかWeb）へ渡す。
 */

/** The address this text opens, or null when it is a search phrase. */
export function omniboxAddress(text, engine = 'google') {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const provider = Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine] : SEARCH_ENGINES.google;
  try {
    const url = navigationTarget(value, engine);
    return url && url !== provider.url + encodeURIComponent(value) ? url : null;
  } catch { return null; }
}

/** Rows for the dropdown, best first. `hubFirst` puts Hub search before the Web row when the text is not an address. */
export function omniboxRows(text, { engine = 'google', pages = [], hubFirst = true } = {}) {
  const query = String(text ?? '').trim();
  if (!query) return [];
  const provider = Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine] : SEARCH_ENGINES.google;
  const address = omniboxAddress(query, engine);
  const hub = { kind: 'hub', query, title: `Hubで「${query}」を検索`, detail: 'Hub内の検索' };
  const rows = [];
  if (address) rows.push({ kind: 'open', url: address, title: 'このアドレスを開く', detail: address }, hub);
  else {
    let web = null;
    try { web = { kind: 'web', url: navigationTarget(query, engine), title: `${provider.label}で「${query}」を検索`, detail: `Web検索 · ${provider.label}` }; } catch { web = null; }
    rows.push(...(hubFirst ? [hub, web] : [web, hub]).filter(Boolean));
  }
  const lower = query.toLocaleLowerCase(), seen = new Set(rows.map(row => row.url).filter(Boolean));
  for (const page of pages) {
    if (rows.length >= 7) break;
    if (!pageUrl(page?.url) || seen.has(page.url) || !`${page.title ?? ''} ${page.url}`.toLocaleLowerCase().includes(lower)) continue;
    seen.add(page.url);
    rows.push({ kind: 'page', url: page.url, title: page.title || new URL(page.url).hostname, detail: page.url });
  }
  return rows;
}

export function createOmnibox({ document, window, form, input, getEngine = () => 'google', hubFirst = () => true, loadPages = async () => [], onHubSearch, onOpen }) {
  if (!document || !form || !input || typeof onHubSearch !== 'function' || typeof onOpen !== 'function') throw Error('omnibox_invalid');
  const list = document.createElement('div');
  list.id = 'toolbar-suggestions'; list.className = 'omnibox-suggestions'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '検索とアドレスの候補'); list.hidden = true;
  document.body.append(list);
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'false');
  let rows = [], index = -1, pages = null, loading = null, composing = false;
  const ensurePages = () => {
    if (pages || loading) return;
    loading = Promise.resolve().then(loadPages).then(value => { pages = Array.isArray(value) ? value : []; }, () => { pages = []; }).finally(() => { loading = null; if (!list.hidden) render(); });
  };
  function place() {
    const rect = form.getBoundingClientRect();
    list.style.setProperty('--omnibox-left', `${Math.round(rect.left)}px`);
    list.style.setProperty('--omnibox-top', `${Math.round(rect.bottom + 4)}px`);
    list.style.setProperty('--omnibox-width', `${Math.round(rect.width)}px`);
  }
  function select(next) {
    index = next;
    [...list.children].forEach((node, i) => node.setAttribute('aria-selected', String(i === index)));
    if (index >= 0) input.setAttribute('aria-activedescendant', `toolbar-suggestion-${index}`); else input.removeAttribute('aria-activedescendant');
  }
  function hide() { list.hidden = true; list.replaceChildren(); rows = []; input.setAttribute('aria-expanded', 'false'); select(-1); }
  function activate(row) {
    if (!row) return;
    hide();
    if (row.kind === 'hub') void Promise.resolve(onHubSearch(row.query));
    else void Promise.resolve(onOpen(row.url));
  }
  function render() {
    const engine = getEngine();
    rows = omniboxRows(input.value, { engine, pages: pages ?? [], hubFirst: hubFirst() });
    list.replaceChildren();
    rows.forEach((row, i) => {
      const node = document.createElement('button'); node.type = 'button'; node.id = `toolbar-suggestion-${i}`; node.className = 'omnibox-row'; node.setAttribute('role', 'option'); node.dataset.kind = row.kind;
      const title = document.createElement('strong'); title.textContent = row.title;
      const detail = document.createElement('small'); detail.textContent = row.detail;
      node.append(title, detail);
      node.onmousedown = event => event.preventDefault();
      node.onclick = () => activate(row);
      list.append(node);
    });
    if (!rows.length) { hide(); return; }
    place(); list.hidden = false; input.setAttribute('aria-expanded', 'true'); select(0);
  }
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; render(); });
  input.addEventListener('input', () => { ensurePages(); if (!composing) render(); });
  input.addEventListener('focus', () => { ensurePages(); if (input.value.trim()) render(); });
  input.addEventListener('blur', () => window?.setTimeout?.(() => { if (!list.contains(document.activeElement)) hide(); }, 0));
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || composing) return;
    if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); hide(); return; }
    if (list.hidden || !rows.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); select((index + 1) % rows.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); select((index - 1 + rows.length) % rows.length); }
    else if (event.key === 'Enter' && index >= 0) { event.preventDefault(); activate(rows[index]); }
  });
  window?.addEventListener?.('resize', () => { if (!list.hidden) place(); });
  return { hide, render, element: list, invalidatePages() { pages = null; } };
}
