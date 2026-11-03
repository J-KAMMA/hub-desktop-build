// 内側左列の部品（2026-10-15、旦那様の参考画面に合わせた形）。
// 上の段（ホーム・ショート）→ 区切り → 「フォロー中 ›」と顔つきの行 → 区切り → 「マイページ ›」と記号つきの行。
// カテゴリとタグは本文の上の横一列のチップに置き、列には並べない。
// 記号はこのアプリのために描いた単純な線画（外部の資産やロゴは使わない）。
import { railAvatarModel } from './rail-avatar.mjs';

const ICONS = {
  home: 'M4 11.5 12 5l8 6.5V20h-5.5v-5.5h-5V20H4z',
  shorts: 'M8 3.5h8a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2ZM10.5 9.5v5l4-2.5z',
  channel: 'M4 4.5h16v15H4zM12 8.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6ZM7.8 17a4.2 4.2 0 0 1 8.4 0',
  history: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7M12 8v4.5l3 1.8',
  playlist: 'M4 6.5h12M4 11h12M4 15.5h7M15 14v6l5-3z',
  later: 'M12 4.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15ZM12 8v4.3l2.8 1.7',
  favorite: 'M12 19.5s-7-4.3-7-9.2A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.3c0 4.9-7 9.2-7 9.2Z',
  tracks: 'M9 17V6l10-2v11M9 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  external: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.3 2.3 3.4 5.2 3.4 8.5s-1.1 6.2-3.4 8.5c-2.3-2.3-3.4-5.2-3.4-8.5s1.1-6.2 3.4-8.5Z',
  bookmark: 'M7 4h10v16l-5-3.5L7 20z',
  list: 'M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01',
  draft: 'M5 19h4l10-10-4-4L5 15zM13 7l4 4',
  thread: 'M20 14.5a3 3 0 0 1-3 3H9l-4 3V7a3 3 0 0 1 3-3h9a3 3 0 0 1 3 3z',
  community: 'M9 11a3.3 3.3 0 1 0 0-6.6A3.3 3.3 0 0 0 9 11ZM3.5 19a5.5 5.5 0 0 1 11 0M15.5 4.6a3.3 3.3 0 0 1 0 6.3M16 14.2a5 5 0 0 1 4.5 4.8',
  popular: 'M12 20c3.6 0 6-2.4 6-5.6 0-3.9-3.4-5.5-4.3-9.4-1.9 1.5-2.4 3.4-2.2 5.2-1.2-.5-2-1.6-2.3-3C7.6 8.8 6 11 6 14.4 6 17.6 8.4 20 12 20Z',
  back: 'M14.5 5.5 8 12l6.5 6.5',
  chevron: 'M9.5 5.5 16 12l-6.5 6.5',
  mail: 'M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6',
  contacts: 'M12 11.5a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM5.5 19.5a6.5 6.5 0 0 1 13 0',
  bell: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  at: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm0 0v1.3a2.2 2.2 0 0 0 4.4 0V12a8.4 8.4 0 1 0-3.3 6.7',
  heart: 'M12 19.5s-7-4.3-7-9.2A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.3c0 4.9-7 9.2-7 9.2Z',
  reply: 'M10 7 4.5 12 10 17M5 12h9a5.5 5.5 0 0 1 5.5 5.5',
  post: 'M5 19h4l10-10-4-4L5 15zM13 7l4 4',
  image: 'M4.5 5.5h15v13h-15zM8.5 10.2a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4.5 16l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5',
  userplus: 'M10 11.5a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8ZM3.5 19.5a6.5 6.5 0 0 1 13 0M18 8v6M15 11h6',
  system: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM12 11v5M12 8h.01',
  article: 'M6 4.5h9l3 3V19.5H6zM9 11h6M9 14.5h6',
  video: 'M4.5 6.5h11v11h-11zM15.5 10.5l4-2.5v8l-4-2.5',
  code: 'M9 8l-4 4 4 4M15 8l4 4-4 4',
  research: 'M9.5 4.5h5M10.5 4.5v5.2L5.4 18a1.6 1.6 0 0 0 1.4 2.5h10.4a1.6 1.6 0 0 0 1.4-2.5l-5.1-8.3V4.5M7.8 15h8.4',
  market: 'M5.5 8.5h13l-1 11h-11zM9 8.5V7a3 3 0 0 1 6 0v1.5',
  lock: 'M6.5 11h11v8.5h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  display: 'M12 4.5a7.5 7.5 0 1 0 0 15c1.3 0 1.8-1 1.3-2-.5-1 .2-2.3 1.4-2.3H17a2.5 2.5 0 0 0 2.5-2.7A7.4 7.4 0 0 0 12 4.5ZM8.5 11.5h.01M12 8.5h.01M15.5 10h.01',
  sparkle: 'M12 4.5l1.8 5.2 5.2 1.8-5.2 1.8L12 18.5l-1.8-5.2L5 11.5l5.2-1.8zM18.5 4.5v3M17 6h3',
  wallet: 'M4.5 7.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5V6.5a1.5 1.5 0 0 1 1.5-1.5H16M15.5 13.5h4.5v3h-4.5a1.5 1.5 0 0 1 0-3Z',
  device: 'M4.5 5.5h15v10h-15zM9 19.5h6M12 15.5v4',
  upload: 'M12 15V4.5M7.8 8.7 12 4.5l4.2 4.2M5 14.5V19h14v-4.5',
};

/** 24px の線画の記号。 */
export function sidebarIcon(document, name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'sidebar-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.list);
  svg.append(path);
  return svg;
}
export const SIDEBAR_ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** 28px の丸い顔。画像は Hub 自身の "/" 始まりの経路だけ（rail-avatar.mjs と同じ決まり）。それ以外は頭字。 */
export function channelAvatar(document, channel, resolve) {
  const slot = document.createElement('span');
  slot.className = 'sidebar-avatar';
  const model = railAvatarModel({ displayName: channel?.name, avatarUrl: channel?.type === 'profile' ? channel.avatarUrl : null });
  if (model.src && typeof resolve === 'function') {
    const img = document.createElement('img');
    img.width = 28; img.height = 28; img.alt = '';
    img.setAttribute('loading', 'lazy'); img.setAttribute('decoding', 'async');
    img.addEventListener('error', () => { slot.classList.remove('has-image'); slot.replaceChildren(document.createTextNode(model.initial)); }, { once: true });
    resolve(img, model.src);
    slot.classList.add('has-image');
    slot.append(img);
  } else slot.textContent = model.initial;
  return slot;
}

/** 長さの文字（"0:45" "1:02:03" "PT45S"）を秒にする。読めないときは null。 */
export function durationSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/iu.exec(text);
  if (iso && (iso[1] || iso[2] || iso[3])) return Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0);
  if (!/^\d{1,3}(?::\d{1,2}){1,2}$/u.test(text)) return null;
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** 縦長か。幅と高さが分かれば「高さが幅より大きい」。分からなければ null（YouTube の一覧などは寸法を持たない）。 */
export function isVerticalVideo(video) {
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return height > width;
}

/** ショート：長さが分かっていて 60 秒以下、ライブではなく、寸法が分かるなら縦長のもの。 */
export function isShortVideo(video) {
  if (!video || video.broadcastStatus === 'live' || video.broadcastStatus === 'upcoming') return false;
  const seconds = durationSeconds(video.duration);
  if (seconds === null || seconds <= 0 || seconds > 60) return false;
  return isVerticalVideo(video) !== false;
}

/**
 * 本文の上の横一列のチップ（すべて・カテゴリ・フォロー中のタグ）。選択中は反転。
 * 溢れたら右端に › の送りボタン、左へ戻れるときは ‹ を出す。
 * chips: [{ key, label, selected, kind }]
 */
export function renderChipRow(document, host, { label, chips, onSelect }) {
  host.classList.add('sidebar-chip-strip');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', label);
  const previousScroll = host.querySelector('.sidebar-chip-track')?.scrollLeft ?? 0;
  const track = document.createElement('div');
  track.className = 'sidebar-chip-track';
  for (const chip of chips) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sidebar-chip${chip.kind === 'tag' ? ' is-tag' : ''}`;
    button.textContent = chip.kind === 'tag' ? `#${chip.label}` : chip.label;
    button.setAttribute('aria-pressed', String(Boolean(chip.selected)));
    button.onclick = () => onSelect(chip);
    track.append(button);
  }
  const step = (direction) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sidebar-chip-step is-${direction}`;
    button.setAttribute('aria-label', direction === 'next' ? '右へ送る' : '左へ戻す');
    button.append(sidebarIcon(document, 'back'));
    button.onclick = () => track.scrollBy({ left: (direction === 'next' ? 1 : -1) * Math.max(120, track.clientWidth * 0.8), behavior: 'smooth' });
    return button;
  };
  const back = step('prev'), next = step('next');
  const sync = () => {
    const max = track.scrollWidth - track.clientWidth;
    back.hidden = track.scrollLeft <= 1;
    next.hidden = max <= 1 || track.scrollLeft >= max - 1;
  };
  track.addEventListener('scroll', sync, { passive: true });
  host.replaceChildren(back, track, next);
  track.scrollLeft = previousScroll;
  sync();
  const View = document.defaultView;
  if (View?.ResizeObserver) { host._chipObserver?.disconnect(); host._chipObserver = new View.ResizeObserver(sync); host._chipObserver.observe(track); }
  else View?.requestAnimationFrame?.(sync);
  host.hidden = chips.length === 0;
  return { sync };
}

/**
 * フォロー中とフォロー中のタグの読み込み。種類ごとに1頁30件ずつ、キーセットで続きを読む。
 * アカウントが変わったら全部捨てる。読み込みが終わるたびに changed(kind) を呼ぶ。
 */
export function createSidebarRemote({ invoke, epoch, registered, changed }) {
  let owner = null;
  let tags = [];
  const kinds = new Map();
  const reset = () => { owner = epoch(); tags = []; kinds.clear(); };
  const state = (kind) => {
    if (owner !== epoch()) reset();
    if (!kinds.has(kind)) kinds.set(kind, { items: [], next: null, loaded: false, loading: false, failed: false });
    return kinds.get(kind);
  };
  const read = async (kind, more) => {
    const entry = state(kind);
    if (!registered() || entry.loading || (more ? !entry.next : entry.loaded)) return;
    const mine = owner;
    entry.loading = true;
    try {
      const data = await invoke('hub_detail', more ? { name: 'sidebar_page', ids: [kind, entry.next] } : { name: 'sidebar', ids: [kind] });
      if (mine !== epoch()) return;
      const channels = Array.isArray(data?.channels) ? data.channels.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string') : [];
      const known = new Set(entry.items.map((item) => item.id));
      entry.items = [...entry.items, ...channels.filter((item) => !known.has(item.id))];
      entry.next = typeof data?.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
      if (!more && Array.isArray(data?.followedTags)) tags = data.followedTags.filter((tag) => typeof tag === 'string' && tag).slice(0, 100);
      entry.loaded = true;
      entry.failed = false;
    } catch {
      if (mine !== epoch()) return;
      entry.loaded = true;
      entry.failed = true;
    } finally {
      if (mine === epoch()) { entry.loading = false; changed(kind); }
    }
  };
  return {
    state,
    tags: () => { if (owner !== epoch()) reset(); return tags; },
    load: (kind) => read(kind, false),
    more: (kind) => read(kind, true),
  };
}
