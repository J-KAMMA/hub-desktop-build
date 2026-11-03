// 音楽の内側左列の木（2026-11-02、旦那様の決定：列は木で、押しても列は変わらない）。
// 根：ホーム / ライブラリ（枝：お気に入り・プレイリスト（各プレイリストがその子）・アーティスト）/ アップロード（できる人だけ）。
// 枝は曲がり線でぶら下がる（フィードの木と同じ class：sidebar-tree / sidebar-tree-root / sidebar-tree-children / is-tree-first / is-tree-last）。
// 行を押すと onGo(route) を呼ぶだけで、列は作り直さない。選択中の行だけ select(route) で付け替える。
import { sidebarIcon } from './sidebar-media.mjs';

/** route の同一性。{page:'playlist', id} は id まで見る。 */
export const sameRoute = (a, b) => Boolean(a && b) && a.page === b.page && (a.id ?? null) === (b.id ?? null);
export const routeKey = route => `${route.page}${route.id ? `:${route.id}` : ''}`;

/** 木の定義。playlists は [{id, title}]。canUpload が偽ならアップロードの根は無い。 */
export function musicTreeModel({ playlists = [], canUpload = false } = {}) {
  const roots = [
    { label: 'ホーム', icon: 'home', route: { page: 'home' }, children: null },
    {
      label: 'ライブラリ', icon: 'tracks', route: { page: 'favorites' },
      children: [
        { label: 'お気に入り', icon: 'favorite', route: { page: 'favorites' } },
        {
          label: 'プレイリスト', icon: 'playlist', route: { page: 'playlists' },
          children: playlists.filter(item => item && typeof item.id === 'string').map(item => ({ label: item.title || 'プレイリスト', route: { page: 'playlist', id: item.id } })),
        },
        { label: 'アーティスト', icon: 'channel', route: { page: 'artists' } },
      ],
    },
  ];
  if (canUpload) roots.push({ label: 'アップロード', icon: 'upload', route: { page: 'upload' }, children: null });
  return roots;
}

/** 枝の最初と最後に印を付ける（線の上端と、最後の行の曲がり角）。app.js の markTreeEdges と同じ規則。 */
export function markEdges(kids) {
  const items = [...kids.querySelectorAll(':scope > .sidebar-context-item')];
  for (const node of kids.querySelectorAll(':scope > .is-tree-first, :scope > .is-tree-last')) node.classList.remove('is-tree-first', 'is-tree-last');
  items[0]?.classList.add('is-tree-first');
  items.at(-1)?.classList.add('is-tree-last');
}

/**
 * host に木を描く。返す select(route) は選択中の行を付け替えるだけ（列は作り直さない）。
 * 「プレイリスト」は枝の見出しでもあり行でもある：押すとプレイリストの一覧へ。その子は字下げの行。
 */
export function renderMusicTree({ document, host, model, route, onGo }) {
  const rows = [];
  const row = (parent, entry, className) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sidebar-context-item ${className}`.trim();
    button.dataset.route = routeKey(entry.route);
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
    if (root.children) {
      const kids = document.createElement('div');
      kids.className = 'sidebar-tree-children';
      kids.setAttribute('role', 'group');
      kids.setAttribute('aria-label', root.label);
      for (const child of root.children) {
        row(kids, child, child.icon ? 'sidebar-nav-row' : '');
        if (child.children?.length) {
          const nested = document.createElement('div');
          nested.className = 'sidebar-tree-children music-tree-nested';
          nested.setAttribute('role', 'group');
          nested.setAttribute('aria-label', child.label);
          for (const grand of child.children) row(nested, grand, 'music-tree-leaf');
          markEdges(nested);
          kids.append(nested);
        }
      }
      markEdges(kids);
      group.append(kids);
    }
    groups.push(group);
  }
  host.append(...groups);

  // ライブラリの根と、その子「お気に入り」は同じ route。選択中の印は、より深い行（子）に付ける。
  function select(next) {
    let marked = false;
    for (const item of [...rows].reverse()) {
      const on = !marked && sameRoute(item.route, next);
      if (on) marked = true;
      item.button.classList.toggle('on', on);
      if (on) item.button.setAttribute('aria-current', 'page'); else item.button.removeAttribute('aria-current');
    }
  }
  select(route);
  return { select, rows: () => rows.map(item => item.button) };
}
