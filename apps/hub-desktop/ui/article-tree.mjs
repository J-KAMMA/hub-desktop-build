// 記事の内側左列の木（2026-11-02、旦那様の決定：列は木で、押しても列は変わらない）。
// 根：ホーム（枝：フォロー中のタグ（各タグがその子）・下書き・シリーズ）/ マガジン（枝：保存した記事）。
// 「マガジン」は、いまの読み取りで裏づけのある集まり＝保存した記事だけを持つ。新しい読み取りは足さない。
// 「シリーズ」はWeb版のHubを既定のブラウザで開く（今までと同じ）。行に web 印を付け、ツールチップで伝える。
// 枝は曲がり線でぶら下がる（フィードの木と同じ class：sidebar-tree / sidebar-tree-root / sidebar-tree-children / is-tree-first / is-tree-last）。
// 行を押すと onGo(route) を呼ぶだけで、列は作り直さない。選択中の行だけ select(route) で付け替える。
import { sidebarIcon } from './sidebar-media.mjs';

export const MAX_TREE_TAGS = 12;
const WEB_HINT = 'Web版のHubをブラウザで開きます';

/** route の同一性。{page:'tag', id} は id まで見る。 */
export const sameRoute = (a, b) => Boolean(a && b) && a.page === b.page && (a.id ?? null) === (b.id ?? null);
export const routeKey = route => `${route.page}${route.id ? `:${route.id}` : ''}`;

/** 木の定義。tags はフォロー中のタグ名の配列（既存の sidebarRemote.tags()）。 */
export function articleTreeModel({ tags = [] } = {}) {
  const followed = [...new Set((Array.isArray(tags) ? tags : []).filter(tag => typeof tag === 'string' && tag.trim()))].slice(0, MAX_TREE_TAGS);
  return [
    {
      label: 'ホーム', icon: 'home', route: { page: 'home' },
      children: [
        { label: 'フォロー中のタグ', route: { page: 'tags' }, children: followed.map(tag => ({ label: `#${tag}`, route: { page: 'tag', id: tag } })) },
        { label: '下書き', route: { page: 'drafts' } },
        { label: 'シリーズ', route: { page: 'series' }, web: true },
      ],
    },
    {
      label: 'マガジン', icon: 'bookmark', route: { page: 'saved' },
      children: [{ label: '保存した記事', route: { page: 'saved' } }],
    },
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
 * 「フォロー中のタグ」は枝の見出しでもあり行でもある：押すとタグの絞り込み（チップ）へ。その子は字下げの行。
 */
export function renderArticleTree({ document, host, model, route, onGo }) {
  const rows = [];
  const row = (parent, entry, className) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sidebar-context-item ${className}`.trim();
    button.dataset.route = routeKey(entry.route);
    const label = document.createElement('span');
    label.className = 'sidebar-item-label';
    label.textContent = entry.label;
    button.title = entry.web ? `${entry.label}（${WEB_HINT}）` : entry.label;
    if (entry.web) button.dataset.web = 'true';
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
          nested.className = 'sidebar-tree-children article-tree-nested';
          nested.setAttribute('role', 'group');
          nested.setAttribute('aria-label', child.label);
          for (const grand of child.children) row(nested, grand, 'article-tree-leaf');
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

  // マガジンの根と、その子「保存した記事」は同じ route。選択中の印は、より深い行（子）に付ける。
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
