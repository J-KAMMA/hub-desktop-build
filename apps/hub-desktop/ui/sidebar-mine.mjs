// 内側左列の下段「この画面の自分のもの」（2026-10-29、旦那様の決定。Web 版と同じ形）。
// 上の段（既存の行き先）はそのまま、その下に画面ごとの自分の一覧を置く。
// 行は 36px（--tap-height）・顔か記号は 24px（--avatar-24）・節の見出しは caption。最大 6 件と「すべて見る」。
// 先頭固定は端末の保存領域に、プロフィール（端末の鍵）ごとに覚える。色は意味名の変数だけ（sidebar-mine.css）。
// データは app.js が渡す sources（既存の hub_client / hub_detail の呼び出し）から読む。無い一覧は節ごと出さない。
import { avatarTint, displayInitial, createState } from './state-view.mjs';

export const MINE_LIMIT = 6;
export const PIN_KEY = 'hub.desktop.sidebarMine.pins.v1';

// 節の定義。account: true は接続（登録）が要る一覧。empty は空のときの 1 行と 1 つの操作。
export const MINE_SECTIONS = {
  feed: [
    { key: 'feed.tags', title: 'フォロー中のタグ', account: true, tag: true, empty: { text: 'まだタグをフォローしていません', action: '話題を探す' } },
    { key: 'feed.lists', title: 'リスト', account: true, empty: { text: 'リストはまだありません', action: 'リストを作る' } },
  ],
  articles: [
    { key: 'articles.writers', title: 'フォロー中の書き手', account: true, person: true, empty: { text: 'まだ書き手をフォローしていません', action: '記事を探す' } },
    { key: 'articles.tags', title: 'フォロー中のタグ', account: true, tag: true, empty: { text: 'まだタグをフォローしていません', action: '記事を探す' } },
    { key: 'articles.drafts', title: '下書き', account: true, count: true, empty: { text: '下書きはありません', action: '記事を書く' } },
    { key: 'articles.saved', title: '保存した記事', account: true, empty: { text: '保存した記事はありません', action: '記事を探す' } },
  ],
  videos: [
    { key: 'videos.tags', title: 'フォロー中のタグ', account: true, tag: true, empty: { text: 'まだタグをフォローしていません', action: '動画を探す' } },
    { key: 'videos.channels', title: '登録チャンネル', account: true, person: true, empty: { text: 'まだチャンネルを登録していません', action: '動画を探す' } },
    { key: 'videos.later', title: 'あとで見る', account: true, empty: { text: '保存した動画はありません', action: '動画を探す' } },
  ],
  music: [
    { key: 'music.tags', title: 'フォロー中のタグ', account: true, tag: true, empty: { text: 'まだタグをフォローしていません', action: '曲を探す' } },
    { key: 'music.playlists', title: 'プレイリスト', account: true, empty: { text: 'プレイリストはありません', action: '曲を探す' } },
    { key: 'music.favorites', title: 'お気に入り', account: true, empty: { text: 'お気に入りはありません', action: '曲を探す' } },
    { key: 'music.recent', live: true, title: '最近聴いた曲', account: false, empty: { text: 'まだ曲を聴いていません', action: '曲を探す' } },
  ],
  market: [
    { key: 'market.cart', live: true, title: 'カート', account: false, count: true, empty: { text: 'カートは空です', action: '商品を見る' } },
  ],
  games: [
    { key: 'games.library', title: 'ライブラリ', account: false, empty: { text: 'ゲームを追加すると、ここから起動できます', action: 'ゲームを追加' } },
  ],
  research: [
    { key: 'research.projects', live: true, title: '自分のプロジェクト', account: false, empty: { text: 'プロジェクトはまだありません', action: 'プロジェクトを作る' } },
  ],
};

// 今の端末に既存の読み出しが無く、節を出さないもの（報告用。Rust の許可表には足していない）。
export const MINE_MISSING = [
  'feed.communities（参加中のコミュニティ）',
  'videos.mine（自分の動画の一覧。作成・管理はスタジオが持つ）',
  'market.listings（出品中の商品。読み出し口が無い）',
  'popular_tags（よく使われているタグ。Hub の /api/tags?mode=popular は在るが許可表に無く、種類の絞りも無い）',
  'research.following（フォロー中のプロジェクト）',
];

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 先頭固定の保存。{ [profile]: { [sectionKey]: [id, ...] } }。壊れていたら空から始める。 */
export function createMinePins({ storage, profile }) {
  const read = () => {
    try {
      const value = JSON.parse(storage?.getItem(PIN_KEY) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const ids = (section) => {
    const list = read()[profile()]?.[section];
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  };
  return {
    ids,
    has: (section, id) => ids(section).includes(id),
    toggle(section, id) {
      const all = read();
      const mine = all[profile()] && typeof all[profile()] === 'object' ? all[profile()] : {};
      const current = ids(section);
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id].slice(-24);
      if (next.length) mine[section] = next; else delete mine[section];
      all[profile()] = mine;
      try { storage?.setItem(PIN_KEY, JSON.stringify(all)); } catch { /* 覚えられなくても操作は効く */ }
      return next.includes(id);
    },
  };
}

/** 固定したものを先頭に、残りは元の順で。上限を超えたら固定を優先して切る。 */
export function orderWithPins(items, pinned, limit = MINE_LIMIT) {
  const set = new Set(pinned);
  const first = items.filter((item) => set.has(item.id));
  return [...first, ...items.filter((item) => !set.has(item.id))].slice(0, limit);
}

function face(doc, item, section) {
  const node = el(doc, 'span', 'sidebar-mine-face');
  node.setAttribute('aria-hidden', 'true');
  const seed = item.label;
  node.dataset.tint = String(avatarTint(seed));
  node.textContent = section.tag ? '#' : displayInitial(seed);
  if (section.tag) node.classList.add('is-tag');
  return node;
}

/**
 * options: { document, storage, profile(), epoch(), registered(), sources, actions, changed(), iconSvg? }
 * sources[key]() -> { items:[{id,label,meta?}], count? } またはその Promise（読めなければ投げる）
 * actions: { open(key, item), seeAll(key), empty(key), signIn() }
 */
export function createSidebarMine(options) {
  const { document: doc, sources, actions, changed = () => {} } = options;
  const pins = createMinePins({ storage: options.storage, profile: options.profile ?? (() => 'local') });
  const cache = new Map();
  let owner = null;
  const entry = (key) => {
    if (owner !== options.epoch()) { cache.clear(); owner = options.epoch(); }
    if (!cache.has(key)) cache.set(key, { status: 'idle', items: [], count: null });
    return cache.get(key);
  };
  const accept = (state, data) => {
    const items = Array.isArray(data?.items) ? data.items.filter((item) => item && typeof item.id === 'string' && typeof item.label === 'string') : [];
    Object.assign(state, { status: 'ready', items, count: Number.isFinite(data?.count) ? data.count : items.length });
  };
  // live の節（端末の中だけで決まるもの）は描くたびに同期で読み直す。それ以外は非同期に 1 回読んで覚える。
  const load = (section) => {
    const state = entry(section.key);
    const source = sources[section.key];
    if (typeof source !== 'function' || state.status === 'loading' || state.status === 'failed' || (state.status === 'ready' && !section.live)) return;
    if (section.account && !options.registered()) return;
    const mine = owner;
    let out;
    try { out = source(); } catch { state.status = 'failed'; return; }
    if (!out || typeof out.then !== 'function') { accept(state, out); return; }
    state.status = 'loading';
    out.then((data) => {
      if (mine !== owner) return;
      accept(state, data);
    }).catch(() => {
      if (mine === owner) state.status = 'failed';
    }).then(() => { if (mine === owner) changed(section.key); });
  };

  const row = (section, item, pinned, rerender) => {
    const wrap = el(doc, 'div', `sidebar-mine-item${pinned ? ' is-pinned' : ''}`);
    const open = el(doc, 'button', 'sidebar-mine-row');
    open.type = 'button';
    open.title = item.label;
    open.append(face(doc, item, section), el(doc, 'span', 'sidebar-mine-label', item.label));
    if (item.meta !== undefined && item.meta !== null && item.meta !== '') open.append(el(doc, 'span', 'sidebar-mine-meta', String(item.meta)));
    open.onclick = () => actions.open?.(section.key, item);
    const pin = el(doc, 'button', 'sidebar-mine-pin', pinned ? '固定中' : '固定');
    pin.type = 'button';
    pin.setAttribute('aria-pressed', String(pinned));
    pin.setAttribute('aria-label', pinned ? `${item.label}の固定を外す` : `${item.label}を先頭に固定する`);
    pin.onclick = () => { pins.toggle(section.key, item.id); rerender(); };
    wrap.append(open, pin);
    return wrap;
  };

  const sectionNode = (section, rerender) => {
    load(section);
    const state = entry(section.key);
    const box = el(doc, 'section', 'sidebar-mine-section');
    box.dataset.mineSection = section.key;
    const heading = el(doc, 'p', 'sidebar-mine-heading', section.title);
    if (section.count && state.status === 'ready' && state.count > 0) heading.append(el(doc, 'span', 'sidebar-mine-count', String(state.count)));
    box.append(heading);
    const note = (text, label, run) => {
      box.append(el(doc, 'p', 'sidebar-mine-note', text));
      if (label && run) {
        const button = el(doc, 'button', 'sidebar-mine-action', label);
        button.type = 'button';
        button.onclick = run;
        box.append(button);
      }
    };
    if (state.status === 'failed') note('読み込めませんでした', '再試行', () => { state.status = 'idle'; rerender(); });
    else if (state.status !== 'ready') box.append(createState(doc, { kind: 'loading', rows: 2, compact: true }));
    else if (!state.items.length) note(section.empty.text, section.empty.action, () => actions.empty?.(section.key));
    else {
      const shown = orderWithPins(state.items, pins.ids(section.key));
      for (const item of shown) box.append(row(section, item, pins.has(section.key, item.id), rerender));
      if (state.items.length > shown.length || typeof actions.seeAll === 'function') {
        const all = el(doc, 'button', 'sidebar-mine-all', 'すべて見る');
        all.type = 'button';
        all.onclick = () => actions.seeAll?.(section.key);
        box.append(all);
      }
    }
    return box;
  };

  /** その画面の下段を作る。出す節が無い画面は null。 */
  function render(view) {
    const sections = (MINE_SECTIONS[view] ?? []).filter((section) => typeof sources[section.key] === 'function');
    if (!sections.length) return null;
    const root = el(doc, 'div', 'sidebar-mine');
    root.dataset.mineView = view;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'あなたのもの');
    const rerender = () => { const next = render(view); if (next && root.isConnected) root.replaceWith(next); };
    const registered = options.registered();
    if (!registered && sections.some((section) => section.account)) {
      root.append(createState(doc, { kind: 'signedOut', compact: true, title: 'ログインが必要です', note: 'フォローや保存したものは、接続すると表示されます。', action: { label: 'ログイン', onClick: () => actions.signIn?.() }, iconSvg: options.iconSvg }));
    }
    for (const section of sections) {
      if (section.account && !registered) continue;
      root.append(sectionNode(section, rerender));
    }
    return root.childElementCount ? root : null;
  }

  return { render, pins, invalidate: (key) => { if (key) cache.delete(key); else cache.clear(); } };
}
