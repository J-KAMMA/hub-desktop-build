// 研究の中の左列の木（2026-11-02、旦那様の決定：列は木で、押しても列は変わらない）。
// 根：プロジェクト（枝：開いているプロジェクト一覧の各プロジェクト）／探す（枝なし）。
// 枝は曲がり線でぶら下がる（フィードの木と同じ class：sidebar-tree / sidebar-tree-root / sidebar-tree-children / is-tree-first / is-tree-last）。
// 行を押すと onGo(route) を呼ぶだけで、列は作り直さない。選択中の行だけ select(route) で付け替える。
// 新しい読み取りは足さない：枝の元は initResearch().projects()（今ある一覧）だけ。
import { sidebarIcon } from './sidebar-media.mjs';

/** route の同一性。{page:'project', id} は id まで見る。 */
export const sameRoute = (a, b) => Boolean(a && b) && a.page === b.page && (a.id ?? null) === (b.id ?? null);
export const routeKey = route => `${route.page}${route.id ? `:${route.id}` : ''}`;

/** 木の定義。projects は [{id, title}]。id が文字列でないものは枝にしない。 */
export function researchTreeModel({ projects = [] } = {}) {
  return [
    {
      label: 'プロジェクト', icon: 'draft', route: { page: 'projects' },
      children: projects
        .filter(item => item && typeof item.id === 'string' && item.id)
        .map(item => ({ label: item.title || 'プロジェクト', route: { page: 'project', id: item.id } })),
    },
    { label: '探す', icon: 'external', route: { page: 'discover' }, children: null },
  ];
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
 * 「プロジェクト」の根は一覧の route を持つ。選択中の印は、より深い行（個別のプロジェクト）に付ける。
 */
export function renderResearchTree({ document, host, model, route, onGo }) {
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
    if (root.children?.length) {
      const kids = document.createElement('div');
      kids.className = 'sidebar-tree-children';
      kids.setAttribute('role', 'group');
      kids.setAttribute('aria-label', root.label);
      for (const child of root.children) row(kids, child, '');
      markEdges(kids);
      group.append(kids);
    }
    groups.push(group);
  }
  host.append(...groups);

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
