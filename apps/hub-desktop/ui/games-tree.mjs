// ゲームの内側左列の木（2026-11-02、旦那様の決定：列は木で、押しても列は変わらない）。
// 根：ライブラリ（枝：このPCに登録したゲーム。1本ずつがその子）/ ストア（マーケットのゲームの種別を開く入口。この画面の本文は替えない）。
// 登録済み以外の「持っているゲーム」を表すデータは今ない（invoke("games") だけ）ので、子は登録済みのゲームだけ。
// 枝は曲がり線でぶらさがる（フィードの木と同じ class：sidebar-tree / sidebar-tree-root / sidebar-tree-children / is-tree-first / is-tree-last）。
// 行を押すと onGo(route) を呼ぶだけで、列は作り直さない。選択中の行だけ select(route) で付け替える。
import { sidebarIcon } from './sidebar-media.mjs';

const MAX_CHILDREN = 40;

export const sameGamesRoute = (a, b) => Boolean(a && b) && a.page === b.page && String(a.id ?? '') === String(b.id ?? '');
export const gamesRouteKey = route => `${route.page}${route.id !== undefined && route.id !== null ? `:${route.id}` : ''}`;

/** 木の定義。installed は invoke("games") の行 [{id, title}]。 */
export function gamesTreeModel({ installed = [] } = {}) {
  const children = installed
    .filter(entry => entry && entry.id !== undefined && entry.id !== null && typeof entry.title === 'string' && entry.title)
    .slice(0, MAX_CHILDREN)
    .map(entry => ({ label: entry.title, route: { page: 'game', id: String(entry.id) } }));
  return [
    { label: 'ライブラリ', icon: 'list', route: { page: 'library' }, children },
    { label: 'ストア', icon: 'popular', route: { page: 'store' }, children: null },
  ];
}

/** 枝の最初と最後に印を付ける（app.js の markTreeEdges と同じ規則）。 */
export function markGamesTreeEdges(kids) {
  const items = [...kids.querySelectorAll(':scope > .sidebar-context-item')];
  for (const node of kids.querySelectorAll(':scope > .is-tree-first, :scope > .is-tree-last')) node.classList.remove('is-tree-first', 'is-tree-last');
  items[0]?.classList.add('is-tree-first');
  items.at(-1)?.classList.add('is-tree-last');
}

/** host に木を描く。返す select(route) は選択中の行を付け替えるだけ（列は作り直さない）。 */
export function renderGamesTree({ document, host, model, route, onGo }) {
  const rows = [];
  const row = (parent, entry, className) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sidebar-context-item ${className}`.trim();
    button.dataset.route = gamesRouteKey(entry.route);
    const label = document.createElement('span');
    label.className = 'sidebar-item-label';
    label.textContent = entry.label;
    button.title = entry.label;
    if (entry.icon) button.append(sidebarIcon(document, entry.icon));
    button.append(label);
    button.onclick = () => onGo(entry.route);
    rows.push({ button, route: entry.route });
    parent.append(button);
    return button;
  };
  const groups = [];
  for (const root of model) {
    const group = document.createElement('div');
    group.className = 'sidebar-tree';
    row(group, root, 'sidebar-nav-row sidebar-tree-root');
    if (root.children?.length) {
      const kids = document.createElement('div');
      kids.className = 'sidebar-tree-children';
      kids.setAttribute('role', 'group');
      kids.setAttribute('aria-label', root.label);
      for (const child of root.children) row(kids, child, '');
      markGamesTreeEdges(kids);
      group.append(kids);
    }
    groups.push(group);
  }
  host.append(...groups);

  function select(next) {
    for (const item of rows) {
      const on = sameGamesRoute(item.route, next);
      item.button.classList.toggle('on', on);
      if (on) item.button.setAttribute('aria-current', 'page'); else item.button.removeAttribute('aria-current');
    }
  }
  select(route);
  return { select, rows: () => rows.map(item => item.button) };
}
