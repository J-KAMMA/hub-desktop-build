// 動画の内側左列の木（2026-11-02、旦那様の決定：列は木で、押しても列は変わらない）。music-tree.mjs と同じ形。
// 根：ホーム / ショート / フォロー中（枝：フォローしていて動画を公開している人。人のフォローと同じ）/ ライブラリ（枝：あとで見る・再生リスト・履歴・自分の動画）。
// 既存の読み取りだけを使う：フォロー中は sidebarRemote の videos（follows の人）、ほかは app.js にある行き先。新しい通信は持たない。
// 枝は曲がり線でぶら下がる（フィードの木と同じ class：sidebar-tree / sidebar-tree-root / sidebar-tree-children / is-tree-first / is-tree-last）。
// 行を押すと onGo(route) を呼ぶだけで、列は作り直さない。選択中の行だけ select(route) で付け替える。
import { sidebarIcon } from './sidebar-media.mjs';

/** route の同一性。{page:'channel', id} は id まで見る。 */
export const sameRoute = (a, b) => Boolean(a && b) && a.page === b.page && (a.id ?? null) === (b.id ?? null);
export const routeKey = route => `${route.page}${route.id ? `:${route.id}` : ''}`;

const CHANNEL_NOTE = Object.freeze({ loading: '読み込み中…', failed: '読み込めませんでした', empty: 'まだフォローしていません' });

/**
 * 木の定義。channels は [{name, ...}]（sidebarRemote の videos）。
 * signedIn が偽ならフォロー中の根は無い（未接続）。canUpload が偽なら自分の動画は無い。
 * channelsStatus: 'loading' | 'failed' | 'done'。枝が空のときだけ note を1行出す。
 */
export function videoTreeModel({ channels = [], signedIn = false, channelsStatus = 'done', canUpload = true } = {}) {
  const roots = [
    { label: 'ホーム', icon: 'home', route: { page: 'home' }, children: null },
    { label: 'ショート', icon: 'shorts', route: { page: 'shorts' }, children: null },
  ];
  if (signedIn) {
    const kids = channels.filter(item => item && typeof item.name === 'string' && item.name)
      .map(item => ({ label: item.name, route: { page: 'channel', id: typeof item.handle === 'string' && item.handle ? item.handle : item.name }, channel: item }));
    const note = kids.length ? '' : (CHANNEL_NOTE[channelsStatus === 'done' ? 'empty' : channelsStatus] ?? CHANNEL_NOTE.empty);
    roots.push({ label: 'フォロー中', icon: 'channel', route: { page: 'subscriptions' }, children: kids, note });
  }
  const library = [
    { label: 'あとで見る', icon: 'later', route: { page: 'later' } },
    { label: '再生リスト', icon: 'playlist', route: { page: 'playlists' } },
    { label: '履歴', icon: 'history', route: { page: 'history' } },
  ];
  if (canUpload) library.push({ label: '自分の動画', icon: 'upload', route: { page: 'studio' } });
  roots.push({ label: 'ライブラリ', icon: 'bookmark', route: { page: 'later' }, children: library });
  return roots;
}

/** 枝の最初と最後に印を付ける（線の上端と、最後の行の曲がり角）。app.js の markTreeEdges と同じ規則。 */
export function markEdges(kids) {
  const items = [...kids.querySelectorAll(':scope > .sidebar-context-item, :scope > .sidebar-tree-note')];
  for (const node of kids.querySelectorAll(':scope > .is-tree-first, :scope > .is-tree-last')) node.classList.remove('is-tree-first', 'is-tree-last');
  items[0]?.classList.add('is-tree-first');
  items.at(-1)?.classList.add('is-tree-last');
}

/**
 * host に木を描く。返す select(route) は選択中の行を付け替えるだけ（列は作り直さない）。
 * avatar(document, channel) があれば、チャンネルの行の頭にそれを置く（app.js の channelAvatar を渡す）。
 */
export function renderVideoTree({ document, host, model, route, onGo, avatar = null }) {
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
    else if (entry.channel && typeof avatar === 'function') button.append(avatar(document, entry.channel));
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
      for (const child of root.children) row(kids, child, child.icon ? 'sidebar-nav-row' : child.channel ? 'sidebar-channel-row' : '');
      if (root.note && !root.children.length) {
        const note = document.createElement('p');
        note.className = 'sidebar-tree-note';
        note.textContent = root.note;
        kids.append(note);
      }
      markEdges(kids);
      group.append(kids);
    }
    groups.push(group);
  }
  host.append(...groups);

  // ライブラリの根と、その子「あとで見る」は同じ route。選択中の印は、より深い行（子）に付ける。
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
