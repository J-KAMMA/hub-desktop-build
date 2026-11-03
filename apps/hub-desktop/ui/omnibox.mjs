import { navigationTarget, SEARCH_ENGINES, pageUrl } from './browser-navigation.mjs';
import { webSearchUrl, webSearchLabel, DEFAULT_WEB_SEARCH_ENGINE } from './web-search.mjs';

/*
 * 一番上の検索欄をHubの検索とWebのアドレス欄の両方にする（2026-10-12 ユーザー指定）。
 * 候補は「Hubで検索」「Web検索（またはこのアドレスを開く）」と、手元のお気に入り・履歴だけから作る。
 * 入力中の文字はどこへも送らない。確定したときだけ、選んだ先（HubかWeb）へ渡す。
 */

/** The address this text opens, or null when it is a search phrase. */
export function omniboxAddress(text, engine = DEFAULT_WEB_SEARCH_ENGINE) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const provider = Object.hasOwn(SEARCH_ENGINES, engine) ? SEARCH_ENGINES[engine] : SEARCH_ENGINES.google;
  try {
    const url = navigationTarget(value, engine);
    return url && url !== provider.url + encodeURIComponent(value) ? url : null;
  } catch { return null; }
}

const KIND_LABELS = Object.freeze({
  posts: '投稿', threads: '投稿', articles: '記事', videos: '動画', tracks: '音楽', works: '音楽', music: '音楽',
  communities: 'コミュニティ', listings: 'マーケット', hubpedia: 'Hubpedia', games: 'ゲーム', tags: 'タグ', profiles: '人物', boards: '掲示板',
});
const TITLE_KEYS = ['title', 'name', 'displayName', 'display_name', 'handle', 'slug', 'summary', 'body'];
const clip = value => { const text = value.replace(/\s+/gu, ' ').trim(); return text.length > 60 ? text.slice(0, 59) + '…' : text; };

/** Up to N mixed-kind rows from a Hub search body. Kinds are taken in turn so no kind crowds out the rest. */
export function hubResultRows(body, limit = 5) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const lanes = new Map();
  const add = (group, record) => {
    if (!Object.hasOwn(KIND_LABELS, group) || !record || typeof record !== 'object') return;
    const raw = TITLE_KEYS.map(key => record[key]).find(value => typeof value === 'string' && value.trim());
    if (!raw) return;
    const title = clip(raw);
    if (!title) return;
    if (!lanes.has(group)) lanes.set(group, []);
    lanes.get(group).push({ kind: 'result', group, query: title, title, detail: KIND_LABELS[group], record });
  };
  for (const [group, value] of Object.entries(body)) {
    if (!Array.isArray(value)) continue;
    for (const record of value) { if (group === 'coreEntities') add(record?.sourceGroup, record); else add(group, record); }
  }
  const out = [], seen = new Set(), queues = [...lanes.values()];
  for (let i = 0; out.length < limit && queues.some(queue => i < queue.length); i++) {
    for (const queue of queues) {
      const row = queue[i];
      if (!row || out.length >= limit) continue;
      const key = row.group + '\u0000' + row.title;
      if (seen.has(key)) continue;
      seen.add(key); out.push(row);
    }
  }
  return out;
}

/**
 * Rows for the dropdown, best first. For a phrase: the Hub-search row, the Web-search row, Hub results, then local pages.
 * For an address: open, then Hub search. hubFirst false puts the Web row before the Hub row.
 */
export function omniboxRows(text, { engine = DEFAULT_WEB_SEARCH_ENGINE, pages = [], hubFirst = true, hubResults = [] } = {}) {
  const query = String(text ?? '').trim();
  if (!query) return [];
  const address = omniboxAddress(query, engine);
  const hub = { kind: 'hub', query, title: '「' + query + '」をHubで探す', detail: 'Hub内の検索' };
  const rows = [];
  if (address) rows.push({ kind: 'open', url: address, title: 'このアドレスを開く', detail: address }, hub);
  else {
    const url = webSearchUrl(engine, query);
    const label = webSearchLabel(engine);
    const web = url ? { kind: 'web', url, title: '「' + query + '」を' + label + 'で探す', detail: 'Web検索 · ' + label } : null;
    rows.push(...(hubFirst ? [hub, web] : [web, hub]).filter(Boolean));
    rows.push(...hubResults.slice(0, 5));
  }
  const lower = query.toLocaleLowerCase(), seen = new Set(rows.map(row => row.url).filter(Boolean));
  for (const page of pages) {
    if (rows.length >= 12) break;
    if (!pageUrl(page?.url) || seen.has(page.url) || !((page.title ?? '') + ' ' + page.url).toLocaleLowerCase().includes(lower)) continue;
    seen.add(page.url);
    rows.push({ kind: 'page', url: page.url, title: page.title || new URL(page.url).hostname, detail: page.url });
  }
  return rows;
}

export function createOmnibox({ document, window, form, input, getEngine = () => DEFAULT_WEB_SEARCH_ENGINE, hubFirst = () => true, loadPages = async () => [], searchHub = null, debounceMs = 250, onHubSearch, onOpen, onOpenResult = null }) {
  if (!document || !form || !input || typeof onHubSearch !== 'function' || typeof onOpen !== 'function') throw Error('omnibox_invalid');
  const list = document.createElement('div');
  list.id = 'toolbar-suggestions'; list.className = 'omnibox-suggestions'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '検索とアドレスの候補'); list.hidden = true;
  document.body.append(list);
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', list.id); input.setAttribute('aria-expanded', 'false');
  let rows = [], index = -1, pages = null, loading = null, composing = false;
  let hubResults = [], hubFor = '', hubGeneration = 0, hubTimer = null, hubAbort = null;
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
  function cancelHub() { hubGeneration++; if (hubTimer !== null) window?.clearTimeout?.(hubTimer); hubTimer = null; try { hubAbort?.abort(); } catch { /* already settled */ } hubAbort = null; }
  const rowKey = row => (row ? row.kind + '\u0000' + (row.url ?? row.title) : null);
  function hide() { cancelHub(); list.hidden = true; list.replaceChildren(); rows = []; input.setAttribute('aria-expanded', 'false'); select(-1); }
  function activate(row) {
    if (!row) return;
    hide();
    // A Hub result opens the item itself when the shell knows how; otherwise it falls back to searching its title.
    if (row.kind === 'result' && typeof onOpenResult === 'function' && onOpenResult(row.group, row.record) === true) return;
    if (row.kind === 'hub' || row.kind === 'result') void Promise.resolve(onHubSearch(row.query));
    else void Promise.resolve(onOpen(row.url));
  }
  function render() {
    const engine = getEngine();
    const keep = rowKey(rows[index]);
    const typed = input.value.trim();
    rows = omniboxRows(typed, { engine, pages: pages ?? [], hubFirst: hubFirst(), hubResults: hubFor === typed ? hubResults : [] });
    list.replaceChildren();
    rows.forEach((row, i) => {
      const node = document.createElement('button'); node.type = 'button'; node.id = `toolbar-suggestion-${i}`; node.className = 'omnibox-row'; node.setAttribute('role', 'option'); node.dataset.kind = row.kind;
      const title = document.createElement('strong'); title.textContent = row.title;
      const detail = document.createElement('small'); detail.textContent = row.detail;
      if (row.kind === 'result') { node.setAttribute('aria-label', row.detail + ' ' + row.title); detail.className = 'omnibox-kind'; }
      node.append(title, detail);
      node.onmousedown = event => event.preventDefault();
      node.onclick = () => activate(row);
      list.append(node);
    });
    if (!rows.length) { hide(); return; }
    place(); list.hidden = false; input.setAttribute('aria-expanded', 'true');
    const kept = keep === null ? -1 : rows.findIndex(row => rowKey(row) === keep);
    select(kept >= 0 ? kept : 0);
  }
  /* Hub results: debounced, one request in flight, stale answers dropped. Addresses never search Hub. */
  function scheduleHub() {
    if (typeof searchHub !== 'function') return;
    const typed = input.value.trim();
    cancelHub();
    if (!typed || omniboxAddress(typed, getEngine())) { hubResults = []; hubFor = ''; return; }
    if (hubFor !== typed) { hubResults = []; hubFor = ''; }
    const generation = hubGeneration;
    hubTimer = window?.setTimeout?.(async () => {
      hubTimer = null;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      hubAbort = controller;
      let found = [];
      try { found = hubResultRows(await searchHub(typed, controller?.signal), 5); } catch { found = []; }
      if (generation !== hubGeneration || input.value.trim() !== typed) return;
      hubAbort = null; hubResults = found; hubFor = typed;
      if (!list.hidden) render();
    }, debounceMs);
  }
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; render(); scheduleHub(); });
  input.addEventListener('input', () => { ensurePages(); if (!composing) { render(); scheduleHub(); } });
  input.addEventListener('focus', () => { ensurePages(); if (input.value.trim()) { render(); scheduleHub(); } });
  input.addEventListener('blur', () => window?.setTimeout?.(() => { if (!list.contains(document.activeElement)) hide(); }, 0));
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || composing) return;
    if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); hide(); return; }
    if (list.hidden || !rows.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); select((index + 1) % rows.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); select((index - 1 + rows.length) % rows.length); }
    else if (event.key === 'Enter' && index >= 0) {
      event.preventDefault();
      // Enter runs the selected row (Hub search by default); Alt+Enter runs the Web search (or open-address) row.
      activate(event.altKey ? rows.find(row => row.kind === 'web' || row.kind === 'open') ?? rows[index] : rows[index]);
    }
  });
  window?.addEventListener?.('resize', () => { if (!list.hidden) place(); });
  return { hide, render, element: list, invalidatePages() { pages = null; } };
}
