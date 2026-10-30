// 音楽のホーム：あいさつ、Hub オリジナルのヒーローと棚、その下に別の節として外部（YouTube）の曲。
// Hub のオリジナル曲が主役で、YouTube は足りない分を埋める脇役（2026-10-14、旦那様の決定）。並びと補充は
// music-originals-first.mjs（Web と同じ規則）。再生できる外部の曲は YouTube の埋め込みだけ。
import { createArtwork, youtubeSource } from './music-youtube.mjs';
import { peerArtworkWork } from './peer-music.mjs';
import { arrangeMusicHome, MUSIC_SLOT_SIZE } from './music-originals-first.mjs';

const RECENT_LIMIT = 20;
const SHELF_LIMIT = MUSIC_SLOT_SIZE;

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
  let generation = 0;
  let disposed = false;
  let recommended = [];
  let favorites = [];
  let peers = [];
  let error = false;
  let loading = false;

  const head = el(document, 'header', 'mh-head');
  const greeting = el(document, 'p', 'mh-greeting', greetingFor(now()));
  head.append(greeting);
  const form = el(document, 'form', 'mh-search');
  form.setAttribute('role', 'search');
  const input = el(document, 'input');
  input.type = 'search';
  input.maxLength = 100;
  input.placeholder = '曲名・アーティストを検索';
  input.setAttribute('aria-label', '音楽を検索');
  const submit = el(document, 'button', 'head-action', '検索');
  submit.type = 'submit';
  form.append(input, submit);
  form.onsubmit = event => { event.preventDefault(); actions.search(input.value.trim()); };
  head.append(form);

  const playable = entry => entry.kind === 'track' || entry.kind === 'peer' || youtubeSource(entry.work) !== null;
  const open = entry => {
    if (entry.kind === 'track') actions.playTrack(entry.track);
    else if (entry.kind === 'peer') actions.playPeer?.(entry.peer);
    else actions.openWork(entry.work);
  };
  const play = entry => {
    if (entry.kind === 'track') actions.playTrack(entry.track);
    else if (entry.kind === 'peer') actions.playPeer?.(entry.peer);
    else actions.playWork(entry.work);
  };
  const label = (view, suffix) => `${view.title}${view.artist ? `、${view.artist}` : ''}${suffix}`;

  // オリジナルの札（正方形の絵）。他Hubの曲にはホスト名を添える。
  function card(entry) {
    const view = itemView(entry);
    const node = el(document, 'article', entry.kind === 'peer' ? 'mh-card mh-peer-card' : 'mh-card');
    node.dataset.key = view.key;
    const button = el(document, 'button', 'mh-card-open');
    button.type = 'button';
    button.setAttribute('aria-label', label(view, entry.kind === 'peer' ? `を${view.host}から再生` : 'を開く'));
    const art = createArtwork(document, view.artworkSource, { hubAsset, className: 'mw-art mw-art-card' });
    button.append(art, el(document, 'strong', 'mh-card-title', view.title), el(document, 'span', 'mh-card-artist', view.artist));
    if (view.host) button.append(el(document, 'span', 'mh-card-origin meta', view.host));
    button.onclick = () => open(entry);
    node.append(button);
    if (playable(entry)) {
      const playButton = el(document, 'button', 'mh-card-play', '▶');
      playButton.type = 'button';
      playButton.setAttribute('aria-label', `${view.title}を再生`);
      playButton.onclick = () => play(entry);
      node.append(playButton);
    }
    return node;
  }

  // 外部の曲の行。絵は 40×40。提供元は節の見出しに一度だけ出し、行には繰り返さない。
  function externalRow(entry) {
    const view = itemView(entry);
    const row = el(document, 'div', 'mh-ext-row');
    row.dataset.key = view.key;
    const button = el(document, 'button', 'mh-ext-open');
    button.type = 'button';
    button.setAttribute('aria-label', label(view, 'を開く'));
    const copy = el(document, 'span', 'mh-ext-copy');
    copy.append(el(document, 'strong', 'mh-ext-title', view.title), el(document, 'span', 'mh-ext-artist', view.artist));
    if (view.host) copy.append(el(document, 'span', 'mh-ext-host', view.host));
    button.append(createArtwork(document, view.artworkSource, { hubAsset, className: 'mw-art mw-art-row' }), copy, el(document, 'span', 'mh-ext-duration', view.duration));
    button.onclick = () => open(entry);
    row.append(button);
    if (playable(entry)) {
      const playButton = el(document, 'button', 'mh-ext-play', '▶');
      playButton.type = 'button';
      playButton.setAttribute('aria-label', `${view.title}を再生`);
      playButton.onclick = () => play(entry);
      row.append(playButton);
    }
    return row;
  }

  function heroSection(entry) {
    const section = el(document, 'section', 'mh-hero');
    section.setAttribute('aria-label', '注目のオリジナル');
    if (!entry) {
      section.classList.add('is-empty', 'state-panel');
      section.append(el(document, 'h3', 'state-title', 'Hubのオリジナル曲はまだありません'), el(document, 'p', 'state-body', '公開された曲がここに並びます。YouTube Musicは下の別の節に出ます。'));
      return section;
    }
    const view = itemView(entry);
    const art = createArtwork(document, view.artworkSource, { hubAsset, className: 'mw-art mw-art-hero' });
    const copy = el(document, 'div', 'mh-hero-copy');
    copy.append(el(document, 'span', 'mh-hero-badge', 'Hub Music'), el(document, 'h3', 'mh-hero-title', view.title), el(document, 'p', 'mh-hero-artist', view.artist || view.host || ''));
    const playButton = el(document, 'button', 'mh-hero-play', '▶');
    playButton.type = 'button';
    playButton.setAttribute('aria-label', `${view.title}を再生`);
    playButton.onclick = () => play(entry);
    const actionsRow = el(document, 'div', 'mh-hero-actions');
    actionsRow.append(playButton);
    if (entry.kind === 'work') {
      const details = el(document, 'button', 'head-action mh-hero-open', '詳細');
      details.type = 'button';
      details.onclick = () => open(entry);
      actionsRow.append(details);
    }
    copy.append(actionsRow);
    section.append(art, copy);
    return section;
  }

  function originalShelf(shelf) {
    const section = el(document, 'section', 'mh-shelf mh-shelf-original');
    section.dataset.origin = 'original';
    section.setAttribute('aria-label', shelf.name);
    section.append(el(document, 'h3', 'mh-shelf-title', shelf.name));
    const row = el(document, 'div', 'mh-row');
    for (const entry of shelf.entries.slice(0, SHELF_LIMIT)) row.append(card(entry));
    section.append(row);
    return section;
  }

  function skeletonSection() {
    const section = el(document, 'section', 'mh-shelf mh-skeleton');
    section.setAttribute('aria-busy', 'true');
    section.setAttribute('aria-label', '読み込んでいます');
    const row = el(document, 'div', 'mh-row');
    for (let index = 0; index < 6; index++) row.append(el(document, 'span', 'ds-skeleton mh-skeleton-card'));
    section.append(row);
    return section;
  }

  // 外部（YouTube）の節。すべてのオリジナルの節より下。見出しと札で YouTube Music だと分かるようにする。
  function externalSection(layout) {
    if (!layout.external.length && !layout.folded.length && !error) return null;
    const section = el(document, 'section', 'mh-external');
    section.dataset.origin = 'external';
    section.setAttribute('aria-label', 'YouTube Music');
    const heading = el(document, 'div', 'mh-external-head');
    heading.append(el(document, 'h3', 'mh-shelf-title', 'YouTube Music'));
    section.append(heading);
    const list = rows => {
      const node = el(document, 'div', 'mh-ext-list');
      node.setAttribute('role', 'list');
      for (const entry of rows) node.append(externalRow(entry));
      return node;
    };
    if (layout.external.length) section.append(list(layout.external));
    if (layout.folded.length) {
      const details = el(document, 'details', 'mh-external-folded');
      details.append(el(document, 'summary', '', '外部作品をさらに表示'), list(layout.folded));
      section.append(details);
    }
    if (error && !loading) {
      const state = el(document, 'div', 'state-panel');
      state.append(el(document, 'p', 'state-title', 'いまは外部作品を読み込めません。'));
      const retry = el(document, 'button', 'btn btn-secondary state-action', '再試行');
      retry.type = 'button';
      retry.onclick = () => void refresh();
      state.append(retry);
      section.append(state);
    }
    return section;
  }

  function paint() {
    if (disposed) return;
    greeting.textContent = greetingFor(now());
    const layout = arrangeMusicHome({ recent: history.list(), favorites, tracks: loaders.tracks?.() ?? [], peers, recommended }, SHELF_LIMIT);
    const nodes = [head, heroSection(layout.hero)];
    for (const shelf of layout.originalShelves) nodes.push(originalShelf(shelf));
    if (loading && !layout.originalCount && !recommended.length) nodes.push(skeletonSection());
    const external = externalSection(layout);
    if (external) nodes.push(external);
    root.replaceChildren(...nodes);
  }

  async function refresh() {
    if (disposed) return;
    const turn = ++generation;
    loading = true;
    error = false;
    paint();
    // 他Hubは遅いことがあるので、待たずに先に描く。
    const others = Promise.resolve().then(() => (loaders.peers ? loaders.peers() : [])).then(value => (Array.isArray(value) ? value : []), () => []);
    const [works, saved] = await Promise.allSettled([loaders.recommended(), loaders.favorites ? loaders.favorites() : Promise.resolve([])]);
    if (disposed || turn !== generation) return;
    loading = false;
    recommended = works.status === 'fulfilled' && Array.isArray(works.value) ? works.value.filter(work => work && typeof work.id === 'string') : [];
    error = works.status === 'rejected';
    favorites = saved.status === 'fulfilled' && Array.isArray(saved.value) ? saved.value.filter(work => work && typeof work.id === 'string') : [];
    paint();
    // 接続先が落ちていても棚が出ないだけで、ほかの棚は変えない。
    const found = await others;
    if (disposed || turn !== generation) return;
    peers = found;
    paint();
  }

  paint();
  return {
    element: root,
    refresh,
    repaint: paint,
    destroy() { disposed = true; generation++; root.remove(); },
  };
}
