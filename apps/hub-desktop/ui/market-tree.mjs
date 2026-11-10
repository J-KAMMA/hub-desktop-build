// マーケットの内側左列の木（2026-11-03、旦那様の決定：列は木で、押しても列は変わらない）。
// 根は2つ：マーケット（すべて・デジタル・グッズ・チケット・ゲーム）/ 自分（カート・ライブラリ・注文、出品者なら出品中/売上）。
// 枝は曲がり線でぶらさがる（フィードの木と同じ class：sidebar-tree / sidebar-tree-root / sidebar-tree-children / is-tree-first / is-tree-last）。
// 行を押すと onGo(route) を呼ぶだけで列は作り直さない。選択中の行とカートの数だけ select / setCount で付け替える。
// 根の行は子の先頭へ行くだけで、自分では選ばれない（選択は葉だけ）。
import { CATEGORIES } from './market-model.mjs';

const MAX_CHILDREN = 12;

// このアプリのために描いた線画（外部の資産やロゴは使わない）。
const ICONS = {
  store: 'M4 9.5 5.5 4.5h13L20 9.5M4 9.5h16M4 9.5V19h16V9.5M9.5 19v-5h5v5',
  all: 'M5 5h5.5v5.5H5zM13.5 5H19v5.5h-5.5zM5 13.5h5.5V19H5zM13.5 13.5H19V19h-5.5z',
  digital: 'M12 4v11M7.8 10.8 12 15l4.2-4.2M5 19h14',
  goods: 'M6 8h12l-1 12H7L6 8ZM9 8V7a3 3 0 0 1 6 0v1',
  ticket: 'M4 8.5a1.5 1.5 0 0 0 0 3v0a1.5 1.5 0 0 1 0 3V17h16v-2.5a1.5 1.5 0 0 1 0-3v0a1.5 1.5 0 0 0 0-3V6.5H4zM14 7v10',
  game: 'M7.5 8h9a4 4 0 0 1 3.9 4.9l-.8 3.6a2 2 0 0 1-3.3 1.1L14 16h-4l-2.3 1.6a2 2 0 0 1-3.3-1.1l-.8-3.6A4 4 0 0 1 7.5 8ZM8 10.5v3M6.5 12h3',
  me: 'M12 11.5a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM5.5 19.5a6.5 6.5 0 0 1 13 0',
  cart: 'M3.5 5h2.2l1.9 9.5h9.3l1.6-7H7M10 19a1 1 0 1 0 0 .01M17 19a1 1 0 1 0 0 .01',
  purchased: 'M5 12.5 9.5 17 19 7.5',
  library: 'M5 4.5h3v15H5zM10 4.5h3v15h-3zM15.2 5.3l2.9-.8 3.7 14.5-2.9.8z',
  orders: 'M7 4.5h10a1 1 0 0 1 1 1V20l-3-1.8-3 1.8-3-1.8L6 20V5.5a1 1 0 0 1 1-1ZM9 9h6M9 12.5h6',
  selling: 'M5 19V11M12 19V5M19 19v-6',
  listings: 'M5 6h14M5 12h14M5 18h9',
  sell: 'M12 19V6M7 10.5 12 5.5l5 5M5 19h14',
  api: 'M8.5 7 4 12l4.5 5M15.5 7 20 12l-4.5 5M13.5 5l-3 14',
  stock: 'M4 8 12 4l8 4v8l-8 4-8-4ZM4 8l8 4 8-4M12 12v8',
  shipping: 'M3 6.5h11v9.5H3ZM14 9.5h3.8l3.2 3.2V16h-7M7 18.5a1.5 1.5 0 1 0 0 .01M17.5 18.5a1.5 1.5 0 1 0 0 .01',
  sort: 'M7.5 4.5v15M4.5 16.5l3 3 3-3M16.5 19.5v-15M13.5 7.5l3-3 3 3',
};

export const sameMarketRoute = (a, b) => Boolean(a && b) && a.page === b.page && String(a.category ?? '') === String(b.category ?? '');
export const marketRouteKey = route => `${route.page}${route.category ? `:${route.category}` : ''}`;

export function marketIcon(document, name) { return icon(document, name); }

function icon(document, name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'sidebar-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.all);
  svg.append(path);
  return svg;
}

/** 木の定義。sells：出品者として使っているか（既存の販売者の面が使えるときだけ true）。cartCount：カートの点数。 */
/** apiMarket：APIの窓口（api-market-view.mjs）を木に出すか。app.js が onGo の page 'api' を扱うまで false のまま（patch-notes-api-market.md）。 */
export function marketTreeModel({ sells = false, canList = false, cartCount = 0, apiMarket = false } = {}) {
  const market = CATEGORIES.map(({ key, label }) => ({ label, icon: key, route: { page: 'browse', category: key } }));
  if (apiMarket) market.push({ label: 'APIの窓口', icon: 'api', route: { page: 'api' } });
  const mine = [
    { label: 'カート', icon: 'cart', route: { page: 'cart' }, count: Math.max(0, Math.trunc(Number(cartCount) || 0)), countKey: 'cart' },
    { label: 'ライブラリ', icon: 'library', route: { page: 'purchased' } },
    { label: '注文', icon: 'orders', route: { page: 'orders' } },
    ...(canList ? [{ label: '出品する', icon: 'sell', route: { page: 'sell' } }] : []),
    ...(sells ? [{ label: '出品中/売上', icon: 'selling', route: { page: 'selling' } }, { label: '出品・チケット', icon: 'listings', route: { page: 'listings' } }] : []),
  ];
  return [
    { label: 'マーケット', icon: 'store', root: 'market', children: market.slice(0, MAX_CHILDREN) },
    { label: '自分', icon: 'me', root: 'mine', children: mine.slice(0, MAX_CHILDREN) },
  ];
}

/** 枝の最初と最後に印を付ける（app.js の markTreeEdges と同じ規則）。 */
export function markMarketTreeEdges(kids) {
  const items = [...kids.querySelectorAll(':scope > .sidebar-context-item')];
  for (const node of kids.querySelectorAll(':scope > .is-tree-first, :scope > .is-tree-last')) node.classList.remove('is-tree-first', 'is-tree-last');
  items[0]?.classList.add('is-tree-first');
  items.at(-1)?.classList.add('is-tree-last');
}

/** host に木を描く。select(route) は選択中の行を付け替えるだけ、setCount(n) はカートの数字を書き替えるだけ。 */
export function renderMarketTree({ document, host, model, route, onGo }) {
  const leaves = [];
  let countNode = null;
  const row = (parent, entry, className) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sidebar-context-item ${className}`.trim();
    button.title = entry.label;
    button.append(icon(document, entry.icon));
    const label = document.createElement('span');
    label.className = 'sidebar-item-label';
    label.textContent = entry.label;
    button.append(label);
    return button;
  };
  const groups = [];
  for (const root of model) {
    const group = document.createElement('div');
    group.className = 'sidebar-tree';
    const head = row(group, root, 'sidebar-nav-row sidebar-tree-root');
    head.dataset.root = root.root;
    head.onclick = () => { if (root.children[0]) onGo(root.children[0].route); };
    group.append(head);
    const kids = document.createElement('div');
    kids.className = 'sidebar-tree-children';
    kids.setAttribute('role', 'group');
    kids.setAttribute('aria-label', root.label);
    for (const child of root.children) {
      const button = row(kids, child, '');
      button.dataset.route = marketRouteKey(child.route);
      if (child.countKey === 'cart') {
        countNode = document.createElement('span');
        countNode.className = 'sidebar-tree-count';
        button.append(countNode);
      }
      button.onclick = () => onGo(child.route);
      leaves.push({ button, route: child.route });
      kids.append(button);
    }
    markMarketTreeEdges(kids);
    group.append(kids);
    groups.push(group);
  }
  host.append(...groups);

  function select(next) {
    for (const item of leaves) {
      const on = sameMarketRoute(item.route, next);
      item.button.classList.toggle('on', on);
      if (on) item.button.setAttribute('aria-current', 'page'); else item.button.removeAttribute('aria-current');
    }
  }
  function setCount(value) {
    if (!countNode) return;
    const count = Math.max(0, Math.trunc(Number(value) || 0));
    countNode.textContent = count ? String(count) : '';
    countNode.hidden = count === 0;
    countNode.parentElement?.setAttribute('aria-label', count ? `カート（${count}）` : 'カート');
  }
  select(route);
  setCount(model.flatMap(root => root.children).find(child => child.countKey === 'cart')?.count ?? 0);
  return { select, setCount, rows: () => leaves.map(item => item.button), roots: () => [...host.querySelectorAll('.sidebar-tree-root')] };
}
