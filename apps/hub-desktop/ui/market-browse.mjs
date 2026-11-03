// マーケットの一覧（2026-11-03）：検索・種別のチップ・並べ替え・正方形の札の格子。
// 読み込みは app.js が渡す既存の読み（commerce_catalog / market_tickets）だけ。ここは読みを作らない。
// 続きは「さらに表示」を押したときだけ（先読みしない）。種別はカタログがサーバー側で受けないので、読んだ分から選ぶ。
import { CATEGORIES, SORTS, categoryLabel, inCategory, isCategory, isSort, matchesQuery, normalizeProduct, normalizeTicket, priceView, KIND_LABEL } from './market-model.mjs';
import { button, el, emptyState, media, skeletonTile } from './market-dom.mjs';

const SKELETON_COUNT = 8;

/** 札1枚：正方形の絵・題（2行）・価格（等幅数字）・販売者（淡色）。枠も面も無い。 */
export function renderTile(document, item, { onOpen, asset, showKind = false } = {}) {
  const tile = el(document, 'button', 'mk-tile');
  tile.type = 'button';
  tile.dataset.id = item.id;
  tile.dataset.kind = item.kind;
  tile.setAttribute('aria-label', `${item.title}の詳細を見る`);
  tile.append(media(document, { url: item.images[0], label: item.sellerName || item.title, alt: '', asset }));
  const body = el(document, 'span', 'mk-tile-body');
  body.append(el(document, 'span', 'mk-tile-title', item.title));
  const price = priceView(item);
  const priceLine = el(document, 'span', 'mk-tile-price');
  priceLine.append(el(document, 'span', 'mk-num', price.main));
  if (price.sub.startsWith('税込')) priceLine.append(el(document, 'span', 'mk-tile-tax', '税込'));
  body.append(priceLine);
  const seller = [showKind && item.kind !== 'goods' ? KIND_LABEL[item.kind] : '', item.sellerName].filter(Boolean).join(' · ');
  if (seller) body.append(el(document, 'span', 'mk-tile-seller', seller));
  tile.append(body);
  if (onOpen) tile.addEventListener('click', () => onOpen(item));
  return tile;
}

/**
 * deps：
 *  loadProducts({ query, sort, before }) -> Promise<{ items: 生の商品[], nextCursor }>   （既存の fetchShopCatalog を包む）
 *  loadTickets() -> Promise<生のイベント[]>                                            （既存の market_tickets）
 *  gamesHost / openGames() / setGamesQuery(q)                                           （既存の market-games.mjs の面）
 *  asset(img, url) / openItem(item) / friendlyError(error)
 */
export function createMarketBrowse({ document, host, deps, debounceMs = 250 }) {
  const state = {
    category: 'all', query: '', sort: 'new',
    products: { status: 'idle', items: [], nextCursor: null, key: '', more: false, message: '' },
    tickets: { status: 'idle', items: [], message: '' },
    token: 0, timer: null, inStock: false, freeShipping: false,
  };
  const waiters = new Set();
  const settle = () => { if (!state.products.status.startsWith('loading') && state.tickets.status !== 'loading') { for (const done of waiters) done(); waiters.clear(); } };

  const root = el(document, 'div', 'mk-browse');
  const bar = el(document, 'div', 'mk-bar');
  const searchLabel = el(document, 'label', 'mk-search');
  const search = document.createElement('input');
  search.type = 'search';
  search.maxLength = 100;
  search.placeholder = '商品・販売者を検索';
  search.setAttribute('aria-label', 'マーケットを検索');
  searchLabel.append(search);
  const sortLabel = el(document, 'label', 'mk-sort');
  sortLabel.append(el(document, 'span', 'mk-sort-label', '並べ替え'));
  const sort = document.createElement('select');
  sort.setAttribute('aria-label', '並べ替え');
  for (const { key, label } of SORTS) { const option = document.createElement('option'); option.value = key; option.textContent = label; sort.append(option); }
  sortLabel.append(sort);
  bar.append(searchLabel, sortLabel);

  const chips = el(document, 'div', 'mk-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', '種別');
  const chipButtons = new Map();
  for (const { key, label } of CATEGORIES) {
    const chip = button(document, label, 'mk-chip', () => api.setCategory(key));
    chip.dataset.category = key;
    chipButtons.set(key, chip);
    chips.append(chip);
  }
  // 在庫あり・送料無料：同じ見た目のチップ（押すと入れ替わるスイッチ）。カタログの読みへそのまま渡す。
  const toggles = el(document, 'span', 'mk-toggles');
  const toggleButtons = new Map();
  for (const [key, label] of [['inStock', '在庫あり'], ['freeShipping', '送料無料']]) {
    const chip = button(document, label, 'mk-chip mk-toggle', () => { state[key] = !state[key]; syncChrome(); ensureLoaded(); renderBody(); });
    chip.dataset.toggle = key;
    toggleButtons.set(key, chip);
    toggles.append(chip);
  }
  chips.append(toggles);
  const count = el(document, 'p', 'mk-count');
  count.setAttribute('aria-live', 'polite');
  const body = el(document, 'div', 'mk-body');
  root.append(bar, chips, count, body);
  host.replaceChildren(root);

  const tileOptions = () => ({ onOpen: deps.openItem, asset: deps.asset, showKind: state.category === 'all' });

  function visibleItems() {
    if (state.category === 'ticket') return state.tickets.items.filter(item => matchesQuery(item, state.query));
    return state.products.items.filter(item => inCategory(item, state.category));
  }

  function syncChrome() {
    for (const [key, chip] of chipButtons) {
      const on = key === state.category;
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', String(on));
    }
    for (const [key, chip] of toggleButtons) { chip.classList.toggle('on', state[key]); chip.setAttribute('aria-pressed', String(state[key])); }
    toggles.hidden = state.category === 'game' || state.category === 'ticket';
    const isGame = state.category === 'game';
    sortLabel.hidden = isGame || state.category === 'ticket';
    root.dataset.category = state.category;
    if (search.value !== state.query) search.value = state.query;
    sort.value = state.sort;
  }

  function renderBody() {
    syncChrome();
    if (state.category === 'game') body.dataset.games = '1'; else delete body.dataset.games;
    if (state.category === 'game') {
      count.textContent = '';
      body.replaceChildren(deps.gamesHost);
      return;
    }
    const source = state.category === 'ticket' ? state.tickets : state.products;
    const loading = source.status === 'loading' || source.status === 'idle' || (source.status === 'loading-first');
    if (loading) {
      count.textContent = '';
      const grid = el(document, 'div', 'mk-grid');
      grid.append(...Array.from({ length: SKELETON_COUNT }, () => skeletonTile(document)));
      body.replaceChildren(grid);
      body.setAttribute('aria-busy', 'true');
      return;
    }
    body.removeAttribute('aria-busy');
    if (source.status === 'error') {
      count.textContent = '';
      body.replaceChildren(emptyState(document, { title: '読み込めませんでした', body: source.message || '接続を確認して、もう一度お試しください。', actionLabel: 'もう一度', onAction: () => api.reload(), role: 'alert' }));
      return;
    }
    const items = visibleItems();
    const filter = state.category === 'ticket' ? null : deps.filter?.();
    const filterRow = () => { if (!filter) return []; const row = el(document, 'p', 'mk-note mk-filter', `${filter.label} `); row.append(button(document, '解除', 'mk-link', () => { filter.clear(); api.reload(); })); return [row]; };
    const more = state.category !== 'ticket' && state.products.nextCursor;
    if (!items.length) {
      count.textContent = '';
      if (more) {
        body.replaceChildren(...filterRow(), emptyState(document, { title: 'この種別の商品はまだ見つかっていません', body: '読み込んだ範囲には含まれていません。続きを読み込んで探せます。', actionLabel: 'さらに表示', onAction: () => api.more() }));
        return;
      }
      const label = categoryLabel(state.category);
      body.replaceChildren(...filterRow(), emptyState(document, state.query
        ? { title: `「${state.query}」は見つかりません`, body: '別のキーワードを試してください。', actionLabel: '検索を消す', onAction: () => api.setQuery('') }
        : { title: state.category === 'all' ? '商品はまだありません' : `${label}はまだありません`, body: '販売者が出品すると、ここに表示されます。' }));
      return;
    }
    count.textContent = `${items.length.toLocaleString('ja-JP')}件${more ? '以上' : ''}`;
    const grid = el(document, 'div', 'mk-grid');
    grid.append(...items.map(item => renderTile(document, item, tileOptions())));
    const nodes = [...filterRow(), grid];
    if (more) {
      const row = el(document, 'div', 'mk-more');
      const next = button(document, state.products.more ? '読み込んでいます' : 'さらに表示', 'mk-btn', () => api.more());
      next.disabled = state.products.more;
      row.append(next);
      nodes.push(row);
    }
    if (state.products.message && state.category !== 'ticket') nodes.push(el(document, 'p', 'mk-note', state.products.message));
    body.replaceChildren(...nodes);
  }

  async function loadProducts({ more = false } = {}) {
    const token = ++state.token;
    const key = JSON.stringify([state.query, state.sort, deps.filter?.()?.key ?? '', state.inStock, state.freeShipping]);
    const products = state.products;
    if (more) { if (!products.nextCursor || products.more) return; products.more = true; products.message = ''; }
    else { products.status = 'loading'; products.items = []; products.nextCursor = null; products.key = key; products.message = ''; }
    renderBody();
    try {
      const result = await deps.loadProducts({ query: state.query, sort: state.sort, before: more ? products.nextCursor : null, inStock: state.inStock, freeShipping: state.freeShipping });
      if (token !== state.token) return;
      const known = new Set(more ? products.items.map(item => item.id) : []);
      const items = (result?.items ?? []).map(normalizeProduct).filter(item => item && !known.has(item.id));
      products.items = more ? [...products.items, ...items] : items;
      products.nextCursor = result?.nextCursor ?? null;
      products.status = 'ready';
      products.more = false;
    } catch (error) {
      if (token !== state.token) return;
      products.more = false;
      if (more) products.message = '続きを読み込めませんでした。もう一度お試しください。';
      else { products.status = 'error'; products.message = deps.friendlyError ? deps.friendlyError(error) : ''; }
    }
    renderBody();
    settle();
  }

  async function loadTickets() {
    const tickets = state.tickets;
    tickets.status = 'loading';
    renderBody();
    try {
      const events = await deps.loadTickets();
      tickets.items = (events ?? []).map(normalizeTicket).filter(Boolean);
      tickets.status = 'ready';
    } catch (error) {
      tickets.status = 'error';
      tickets.message = deps.friendlyError ? deps.friendlyError(error) : '';
    }
    renderBody();
    settle();
  }

  function ensureLoaded() {
    if (state.category === 'game') { deps.openGames?.(); return; }
    if (state.category === 'ticket') { if (state.tickets.status === 'idle' || state.tickets.status === 'error') void loadTickets(); return; }
    const key = JSON.stringify([state.query, state.sort, deps.filter?.()?.key ?? '', state.inStock, state.freeShipping]);
    if (state.products.status === 'idle' || state.products.status === 'error' || state.products.key !== key) void loadProducts();
  }

  function applyQuery() {
    state.timer = null;
    if (state.category === 'game') deps.setGamesQuery?.(state.query);
    ensureLoaded();
    renderBody();
  }

  const api = {
    root,
    state: () => ({ category: state.category, query: state.query, sort: state.sort }),
    show(category = state.category) { state.category = isCategory(category) ? category : 'all'; renderBody(); ensureLoaded(); },
    setCategory(category) {
      if (!isCategory(category)) return;
      state.category = category;
      deps.onCategory?.(category);
      renderBody();
      ensureLoaded();
    },
    setQuery(query, { immediate = true } = {}) {
      state.query = String(query ?? '').trim();
      if (search.value !== state.query && immediate) search.value = state.query;
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      if (immediate || !debounceMs) applyQuery(); else state.timer = setTimeout(applyQuery, debounceMs);
    },
    setSort(next) {
      if (!isSort(next)) return;
      state.sort = next;
      sort.value = next;
      if (state.category === 'all' || state.category === 'digital' || state.category === 'goods') ensureLoaded();
      renderBody();
    },
    more() { void loadProducts({ more: true }); },
    reload() {
      if (state.category === 'ticket') void loadTickets();
      else if (state.category !== 'game') void loadProducts();
    },
    /** 読み込みが終わるまで待つ（テスト用）。 */
    settled() { return (state.products.status.startsWith('loading') || state.tickets.status === 'loading') ? new Promise(resolve => waiters.add(resolve)) : Promise.resolve(); },
    /** 商品の一覧から同じ販売者の札を返す（読み込み済みの範囲だけ。新しい読みはしない）。 */
    loadedProducts: () => state.products.items,
  };

  search.addEventListener('input', () => api.setQuery(search.value, { immediate: false }));
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); api.setQuery(search.value); } });
  sort.addEventListener('change', () => api.setSort(sort.value));
  syncChrome();
  return api;
}
