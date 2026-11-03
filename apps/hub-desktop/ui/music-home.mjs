// 音楽のホーム：検索欄と、横に並ぶ4本の棚（最近再生 / おすすめ / 新着 / YouTube Music）。
// 各棚は1回だけ読み込む（music-shelves.mjs）。続きを読む操作も、無限送りも無い。並びは描き直しても変わらない。
// Hub のオリジナル曲は Hub の再生経路、外部の曲は YouTube の埋め込みだけ（2026-10-12）。購入の操作は置かない。
import { createArtwork, youtubeSource } from './music-youtube.mjs';
import { peerArtworkWork } from './peer-music.mjs';
import { createShelfStore, SHELF_EMPTY } from './music-shelves.mjs';
import { musicMenuButton } from './music-track-menu.mjs';

const RECENT_LIMIT = 20;

export function greetingFor(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return 'おはようございます';
  if (hour >= 11 && hour < 18) return 'こんにちは';
  return 'こんばんは';
}

/** このセッションで再生した作品。永続化しない。 */
export function createMusicHistory(limit = RECENT_LIMIT) {
  let entries = [];
  const keyOf = entry => `${entry.kind}:${entry.kind === 'track' ? entry.track.id : entry.work.id}`;
  return {
    add(entry) {
      if (!entry || (entry.kind !== 'work' && entry.kind !== 'track')) return;
      if ((entry.kind === 'work' && !entry.work?.id) || (entry.kind === 'track' && !entry.track?.id)) return;
      entries = [entry, ...entries.filter(item => keyOf(item) !== keyOf(entry))].slice(0, limit);
    },
    list: () => [...entries],
    clear() { entries = []; },
  };
}

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const SEARCH_ICON = 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 20 20';
function searchIcon(document) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'mh-search-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', SEARCH_ICON);
  svg.append(path);
  return svg;
}

function durationLabel(value) {
  if (typeof value === 'string' && /^\d{1,3}:[0-5]\d$/.test(value.trim())) return value.trim();
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function itemView(entry) {
  if (entry.kind === 'track') return { title: entry.track.title || '楽曲', artist: entry.track.artist || '', artworkSource: entry.track, key: `track:${entry.track.id}`, duration: durationLabel(entry.track.durationSeconds) };
  if (entry.kind === 'peer') return { title: entry.peer.title || '楽曲', artist: entry.peer.artist || '', artworkSource: peerArtworkWork(entry.peer), key: `peer:${entry.peer.key}`, host: entry.peer.host, duration: durationLabel(entry.peer.durationSeconds) };
  return { title: entry.work.title || '楽曲', artist: entry.work.artist || '', artworkSource: entry.work, key: `work:${entry.work.id}`, duration: durationLabel(entry.work.durationSeconds ?? entry.work.duration) };
}

export function createMusicHome({ document, host, hubAsset, history, loaders, actions, now = () => new Date() }) {
  const root = el(document, 'div', 'mh');
  host.append(root);
  const store = createShelfStore({ loaders });
  let disposed = false;

  const head = el(document, 'header', 'mh-head');
  const greeting = el(document, 'p', 'mh-greeting', greetingFor(now()));
  const form = el(document, 'form', 'mh-search');
  form.setAttribute('role', 'search');
  const input = el(document, 'input');
  input.type = 'search';
  input.maxLength = 100;
  input.placeholder = '曲名・アーティストを検索';
  input.setAttribute('aria-label', '音楽を検索');
  const submit = el(document, 'button', 'mh-search-go');
  submit.type = 'submit';
  submit.setAttribute('aria-label', '検索');
  submit.append(searchIcon(document));
  form.append(input, submit);
  form.onsubmit = event => { event.preventDefault(); actions.search(input.value.trim()); };
  head.append(form, greeting);

  const playable = entry => entry.kind === 'track' || entry.kind === 'peer' || youtubeSource(entry.work) !== null;
  const open = entry => {
    if (entry.kind === 'track') actions.playTrack(entry.track);
    else if (entry.kind === 'peer') actions.playPeer?.(entry.peer);
    else actions.playWork(entry.work);
  };
  const play = entry => {
    if (entry.kind === 'track') actions.playTrack(entry.track);
    else if (entry.kind === 'peer') actions.playPeer?.(entry.peer);
    else actions.playWork(entry.work);
  };
  const label = (view, suffix) => `${view.title}${view.artist ? `、${view.artist}` : ''}${suffix}`;

  // 正方形の絵・題・アーティストの札。ホバーで再生ボタン（再生できるものだけ）。
  function tile(entry, shelfId) {
    const view = itemView(entry);
    const node = el(document, 'article', entry.kind === 'peer' ? 'mh-card mh-peer-card' : 'mh-card');
    node.dataset.key = view.key;
    node.setAttribute('role', 'listitem');
    const button = el(document, 'button', 'mh-card-open');
    button.type = 'button';
    button.setAttribute('aria-label', label(view, entry.kind === 'peer' ? `を${view.host}から再生` : 'を開く'));
    button.append(createArtwork(document, view.artworkSource, { hubAsset, className: 'mw-art mw-art-card' }), el(document, 'strong', 'mh-card-title', view.title), el(document, 'span', 'mh-card-artist', view.artist));
    if (view.host) button.append(el(document, 'span', 'mh-card-origin meta', view.host));
    button.onclick = () => open(entry);
    node.append(button);
    if (entry.kind !== 'peer') node.append(musicMenuButton(document, entry.kind === 'track' ? { ...entry.track, id: `music:${entry.track.id}` } : entry.work, { className: 'mh-card-more' }));
    if (playable(entry)) {
      const playButton = el(document, 'button', 'mh-card-play', '▶');
      playButton.type = 'button';
      playButton.setAttribute('aria-label', `${view.title}を再生`);
      playButton.onclick = () => play(entry);
      node.append(playButton);
    }
    return node;
  }

  function shelf(spec) {
    const section = el(document, 'section', 'mh-shelf');
    section.dataset.shelf = spec.id;
    section.setAttribute('aria-label', spec.name);
    section.append(el(document, 'h3', 'mh-shelf-title', spec.name));
    if (spec.entries.length) {
      const row = el(document, 'div', 'mh-row');
      row.setAttribute('role', 'list');
      for (const entry of spec.entries) row.append(tile(entry, spec.id));
      section.append(row);
    } else if (store.state.loading || !store.state.loaded) {
      const row = el(document, 'div', 'mh-row');
      for (let index = 0; index < 6; index++) row.append(el(document, 'span', 'ds-skeleton mh-skeleton-card'));
      section.setAttribute('aria-busy', 'true');
      section.append(row);
    } else if (spec.id === 'youtube' && store.state.error) {
      const state = el(document, 'div', 'mh-quiet');
      state.append(el(document, 'p', 'mh-quiet-line', 'いまは外部作品を読み込めません。'));
      const retry = el(document, 'button', 'btn btn-secondary state-action', '再試行');
      retry.type = 'button';
      retry.onclick = () => void reload();
      state.append(retry);
      section.append(state);
    } else section.append(el(document, 'p', 'mh-quiet-line', SHELF_EMPTY[spec.id]));
    return section;
  }

  function paint() {
    if (disposed) return;
    greeting.textContent = greetingFor(now());
    root.replaceChildren(head, ...store.shelves(history).map(shelf));
  }

  // 読み込み済みなら何もしない（各棚は1回だけ）。入る・戻るたびに呼ばれても読み直さない。
  function refresh() { return disposed ? Promise.resolve() : store.ensure(paint).then(paint); }
  // 利用者が「更新」を押したときだけ読み直す。
  function reload() { return disposed ? Promise.resolve() : (paint(), store.reload(paint).then(paint)); }

  paint();
  return {
    element: root,
    refresh,
    reload,
    repaint: paint,
    destroy() { disposed = true; root.remove(); },
  };
}
