// アーティスト・アルバムの頁（Web の MusicCollectionView と同じ構成）。
// 表紙、題、アーティスト、曲数、全曲再生、曲の一覧。Hub 公開曲はここからアプリ内で再生する。
// 購入・決済の操作は置かない。データはデスクトップが既に読める音楽の目録（music_tracks / hub_resource music）から組む。
import { createArtwork, youtubeSource } from './music-youtube.mjs';
import { filterWorks } from './yt-unplayable.mjs';
import { musicMenuButton } from './music-track-menu.mjs';

const HUB_TRACK = /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BARE_TRACK = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Web と同じ比較: NFKC・前後の空白除去・ja-JP の小文字化。 */
export const collectionKey = (value) => (typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase('ja-JP') : '');
/** アルバム名。無ければ曲名（シングル）。Web の musicAlbumLabel と同じ。 */
export const albumLabel = (item) => (typeof item?.album === 'string' && item.album.normalize('NFKC').trim()) || (typeof item?.title === 'string' ? item.title.normalize('NFKC').trim() : '');

const trackOf = (work) => ({ ...work, id: work.id.startsWith('music:') ? work.id.slice(6) : work.id });

/**
 * 目録の項目（Hub の公開曲 / 作品）を統一する。同じ曲は1つにまとめる（Hub 曲は music:<uuid> が鍵）。
 * @returns {{key:string,hub:boolean,work:object,track:object|null}[]}
 */
export function normalizeEntries(...sources) {
  const map = new Map();
  for (const list of sources) {
    if (!Array.isArray(list)) continue;
    for (const item of filterWorks(list)) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.title !== 'string' || !item.title) continue;
      const bare = BARE_TRACK.test(item.id);
      const prefixed = HUB_TRACK.test(item.id);
      const key = bare ? `music:${item.id}` : item.id;
      const hub = bare || prefixed;
      const work = bare ? { ...item, id: key } : item;
      const previous = map.get(key);
      if (previous) {
        previous.work = { ...previous.work, ...work };
        if (hub) previous.track = trackOf(previous.work);
        continue;
      }
      map.set(key, { key, hub, work, track: hub ? trackOf(work) : null });
    }
  }
  return [...map.values()];
}

/** 目録から1つの頁の曲を選ぶ。Hub 公開曲を先に、その中は元の順。 */
export function selectCollection(entries, { kind, name, artist = '' }) {
  const wanted = collectionKey(name), by = collectionKey(artist);
  if (!wanted) return [];
  const rows = entries.filter((entry) => (kind === 'artist'
    ? collectionKey(entry.work.artist) === wanted
    : collectionKey(albumLabel(entry.work)) === wanted && (!by || collectionKey(entry.work.artist) === by)));
  return [...rows.filter((entry) => entry.hub), ...rows.filter((entry) => !entry.hub)];
}

export const collectionTypeLabel = (kind, rows) => (kind === 'artist' ? 'アーティスト' : rows.length > 1 ? 'アルバム' : 'シングル');

const secondsLabel = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** 曲の並び（selectCollection の結果）からアルバムの札を作る。アルバム名を持つ曲だけ。初めに現れた順で安定。 */
export function albumTiles(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.work.album) continue;
    const label = albumLabel(row.work), key = collectionKey(label);
    if (!key) continue;
    const entry = map.get(key) ?? { name: label, count: 0, cover: row.work };
    entry.count++;
    map.set(key, entry);
  }
  return [...map.values()];
}

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const link = (document, label, action, aria) => {
  const node = el(document, 'button', 'mc-link', label);
  node.type = 'button';
  if (aria) node.setAttribute('aria-label', aria);
  node.onclick = action;
  return node;
};

/**
 * @param seed     いま手元にある曲・作品（同期で先に出す）
 * @param load     追加で目録を引く。配列（またはその Promise）を返す。失敗しても seed の分は残る
 * @param actions  { playTracks(tracks, startTrack), playWork(work), enqueue(track), openArtist(name), openAlbum(name, artist) }
 */
export function renderMusicCollection({ document, host, kind, name, artist = '', seed = [], load, hubAsset, actions, isCurrent = () => true }) {
  if (kind !== 'artist' && kind !== 'album') throw Error('invalid_collection_kind');
  const root = el(document, 'section', 'mc');
  root.setAttribute('aria-label', kind === 'artist' ? 'アーティスト' : 'アルバム');
  host.append(root);
  let entries = normalizeEntries(seed), disposed = false, generation = 0, loading = false, failed = false;
  const live = () => !disposed && root.isConnected && isCurrent();

  function paint() {
    const rows = selectCollection(entries, { kind, name, artist });
    const hubRows = rows.filter((row) => row.hub);
    const hero = el(document, 'div', 'mw-hero mc-hero');
    const cover = rows.find((row) => row.work.artworkUrl || youtubeSource(row.work));
    hero.append(createArtwork(document, cover?.work ?? { title: name }, { hubAsset, className: 'mw-art mw-art-hero mc-cover' }));
    const text = el(document, 'div', 'mw-hero-text');
    text.append(el(document, 'span', 'mw-kind', collectionTypeLabel(kind, rows)), el(document, 'h2', 'mw-title', name));
    const meta = el(document, 'p', 'mw-credits mc-meta');
    const names = [...new Set(rows.map((row) => row.work.artist).filter(Boolean))];
    if (kind === 'album') {
      names.forEach((who, index) => {
        if (index) meta.append('、');
        meta.append(link(document, who, () => actions.openArtist?.(who), `${who}のアーティストページを開く`));
      });
      if (names.length) meta.append(' · ');
    } else meta.append('公開曲・シングル・関連作品 · ');
    meta.append(`${rows.length}曲`);
    text.append(meta);
    const bar = el(document, 'div', 'mw-actions');
    const playAll = el(document, 'button', 'mw-play', '▶');
    playAll.type = 'button';
    playAll.setAttribute('aria-label', `${name}をすべて再生`);
    const first = hubRows[0] ?? rows.find((row) => youtubeSource(row.work));
    playAll.disabled = !first;
    playAll.onclick = () => {
      if (!live() || !first) return;
      if (first.hub) actions.playTracks?.(hubRows.map((row) => row.track), first.track);
      else actions.playWork?.(first.work);
    };
    bar.append(playAll);
    const note = el(document, 'span', 'mw-play-note');
    if (hubRows.length && rows.length > hubRows.length) note.textContent = `Hub公開曲 ${hubRows.length}曲を順に再生します。`;
    else if (!hubRows.length && first) note.textContent = '外部の曲は作品の詳細で再生します。';
    bar.append(note);
    text.append(bar);
    hero.append(text);

    const status = el(document, 'p', 'meta mc-status', loading ? '曲を読み込んでいます…' : failed ? '一部の曲を取得できませんでした。' : '');
    status.setAttribute('role', 'status');
    const list = el(document, 'ol', 'mc-tracks');
    list.setAttribute('aria-label', `${name}の曲`);
    rows.forEach((row, index) => {
      const item = el(document, 'li', 'mc-track');
      item.dataset.workId = row.key;
      item.append(el(document, 'b', 'mc-no', String(index + 1)));
      item.append(createArtwork(document, row.work, { hubAsset, className: 'mw-art mw-art-row mc-art' }));
      const copy = el(document, 'span', 'mc-text');
      const title = el(document, 'button', 'mc-title', row.work.title);
      title.type = 'button';
      title.setAttribute('aria-label', `${row.work.title}を再生`);
      title.onclick = () => {
        if (!live()) return;
        if (row.hub) actions.playTracks?.(hubRows.map((entry) => entry.track), row.track);
        else actions.playWork?.(row.work);
      };
      const sub = el(document, 'span', 'mc-sub');
      if (row.work.artist) sub.append(link(document, row.work.artist, () => actions.openArtist?.(row.work.artist), `${row.work.artist}のアーティストページを開く`));
      const albumName = albumLabel(row.work);
      if (row.work.album && albumName) {
        if (row.work.artist) sub.append(' · ');
        sub.append(link(document, albumName, () => actions.openAlbum?.(albumName, row.work.artist ?? ''), `アルバム ${albumName}を開く`));
      }
      copy.append(title, sub);
      item.append(copy, el(document, 'span', 'mc-time', secondsLabel(row.work.durationSeconds ?? row.work.duration)));
      if (row.hub) {
        const side = el(document, 'button', 'head-action mc-next', '次に再生');
        side.type = 'button';
        side.setAttribute('aria-label', `${row.work.title}を次に再生`);
        side.onclick = () => { if (live()) actions.enqueue?.(row.track); };
        item.append(side);
      }
      item.append(musicMenuButton(document, row.work, { className: 'mc-more' }));
      list.append(item);
    });
    const children = [hero, status];
    if (rows.length) children.push(list);
    else if (!loading) children.push(el(document, 'p', 'meta mc-empty', failed ? '曲を取得できませんでした。' : `${name}の曲は見つかりませんでした。`));
    if (kind === 'artist') {
      const albums = albumTiles(rows);
      if (albums.length) {
        const shelf = el(document, 'section', 'mc-albums');
        shelf.setAttribute('aria-label', 'アルバム');
        shelf.append(el(document, 'h3', 'mh-shelf-title', 'アルバム'));
        const strip = el(document, 'div', 'mh-row');
        strip.setAttribute('role', 'list');
        for (const album of albums) {
          const card = el(document, 'article', 'mh-card mc-album');
          card.setAttribute('role', 'listitem');
          const open = el(document, 'button', 'mh-card-open');
          open.type = 'button';
          open.setAttribute('aria-label', `アルバム ${album.name}を開く`);
          open.append(createArtwork(document, album.cover, { hubAsset, className: 'mw-art mw-art-card' }), el(document, 'strong', 'mh-card-title', album.name), el(document, 'span', 'mh-card-artist', `${album.count}曲`));
          open.onclick = () => { if (live()) actions.openAlbum?.(album.name, name); };
          card.append(open);
          strip.append(card);
        }
        shelf.append(strip);
        children.push(shelf);
      }
    }
    root.replaceChildren(...children);
    root.setAttribute('aria-busy', String(loading));
  }

  async function refresh() {
    if (typeof load !== 'function') return;
    const turn = ++generation;
    loading = true; failed = false; paint();
    try {
      const more = await load();
      if (turn !== generation || disposed) return;
      entries = normalizeEntries(entries.map((entry) => entry.work), more);
    } catch { if (turn === generation) failed = true; }
    if (turn !== generation || disposed) return;
    loading = false;
    paint();
  }

  paint();
  const ready = refresh();
  return { root, ready, reload: refresh, destroy() { disposed = true; generation++; root.remove(); }, invalidate() { disposed = true; generation++; } };
}
