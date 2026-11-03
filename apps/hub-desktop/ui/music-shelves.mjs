// 音楽ホームの棚の組み立て（DOM を持たない）。
// 棚は 最近再生 / おすすめ / 新着 / YouTube Music の4本。各棚は1回だけ読み、続きは読まない（無限送りなし）。
// 並びは安定させる：新着は最初に得た順を凍結し、再描画やほかの画面の検索で並べ替えない。
// 外部の曲（YouTube）は YouTube Music の棚にだけ置き、Hub のオリジナルの棚には混ぜない。
import { isOriginalEntry, MUSIC_SLOT_SIZE } from './music-originals-first.mjs';
import { unplayable, workIdOf } from './yt-unplayable.mjs';

export const SHELF_SIZE = MUSIC_SLOT_SIZE;
export const SHELVES = Object.freeze([
  { id: 'recent', name: '最近再生' },
  { id: 'recommended', name: 'おすすめ' },
  { id: 'new', name: '新着' },
  { id: 'youtube', name: 'YouTube Music' },
]);

/** 棚の空のときの一行（静かな文言）。 */
export const SHELF_EMPTY = Object.freeze({
  recent: 'まだ再生した曲はありません。',
  recommended: 'おすすめはまだありません。',
  new: '新しい公開曲はまだありません。',
  youtube: 'YouTube Music の曲は見つかりませんでした。',
});

// Hub の公開曲は track の id（uuid）と作品の id（music:uuid）で同じ曲を指す。同じ鍵にそろえる。
const keyOf = entry => {
  if (entry.kind === 'track') return `hub:${entry.track?.id}`;
  if (entry.kind === 'peer') return `peer:${entry.peer?.key}`;
  const id = String(entry.work?.id);
  return id.startsWith('music:') ? `hub:${id.slice(6)}` : `work:${id}`;
};
const dedupe = entries => { const seen = new Set(); return entries.filter(entry => { const key = keyOf(entry); if (seen.has(key)) return false; seen.add(key); return true; }); };
const toEntry = work => ({ kind: 'work', work });

/**
 * 棚の中身を決める。
 *  new:         tracks をそのままの順で（呼び出し側が最初の非空の取得を凍結して渡す）
 *  recommended: Hub のオリジナル（おすすめ・お気に入り・ほかの Hub）から、新着に出た曲を除いたもの
 *  youtube:     外部の曲（おすすめ・お気に入り・再生履歴）。Hub のオリジナルは入れない
 *  recent:      再生履歴（新しい順。Hub 曲も外部の曲も）
 */
export function buildShelves({ recent = [], recommended = [], favorites = [], tracks = [], peers = [] }, size = SHELF_SIZE) {
  const newEntries = dedupe(tracks.map(track => ({ kind: 'track', track }))).slice(0, size);
  const taken = new Set(newEntries.map(keyOf));
  const pool = [...recommended.map(toEntry), ...favorites.map(toEntry), ...peers.map(peer => ({ kind: 'peer', peer }))];
  const recommendedEntries = dedupe(pool.filter(isOriginalEntry)).filter(entry => !taken.has(keyOf(entry))).slice(0, size);
  const youtubeEntries = dedupe([...pool, ...recent].filter(entry => !isOriginalEntry(entry))).slice(0, size);
  const lists = { recent: dedupe(recent).slice(0, size), recommended: recommendedEntries, new: newEntries, youtube: youtubeEntries };
  // 埋め込みで再生できないと分かった YouTube の曲は、どの棚にも出さない（Hub の曲は対象外）。
  const shown = entry => entry.kind !== 'work' || !workIdOf(entry.work) || !unplayable().has(workIdOf(entry.work));
  return SHELVES.map(shelf => ({ ...shelf, entries: lists[shelf.id].filter(shown) }));
}

/**
 * 読み込みの状態。各読み込み元（recommended / favorites / peers）は load() ごとに1回だけ呼ぶ。
 * ensure() は読み込み済みなら何もしない。reload() は利用者が更新を押したときだけ読み直す。
 * tracks は最初に非空で得た並びを凍結する（reload でだけ取り直す）。
 */
export function createShelfStore({ loaders = {} }) {
  const data = { recommended: [], favorites: [], peers: [] };
  const state = { loaded: false, loading: false, error: false };
  let frozenTracks = null;
  let inflight = null;
  const validWorks = value => (Array.isArray(value) ? value.filter(work => work && typeof work.id === 'string') : []);

  const freezeTracks = () => {
    if (frozenTracks?.length) return;
    const current = loaders.tracks?.();
    if (Array.isArray(current) && current.length) frozenTracks = current.map(track => ({ ...track }));
  };

  async function run(onProgress) {
    state.loading = true; state.error = false;
    const others = Promise.resolve().then(() => (loaders.peers ? loaders.peers() : [])).then(value => (Array.isArray(value) ? value : []), () => []);
    const [works, saved] = await Promise.allSettled([loaders.recommended?.() ?? [], loaders.favorites?.() ?? []]);
    data.recommended = works.status === 'fulfilled' ? validWorks(works.value) : [];
    data.favorites = saved.status === 'fulfilled' ? validWorks(saved.value) : [];
    state.error = works.status === 'rejected';
    state.loaded = true; state.loading = false;
    onProgress?.();
    // 接続先が遅い・落ちていても、ほかの棚は先に出ている。
    data.peers = await others;
    onProgress?.();
  }

  return {
    state,
    /** 読み込み済みなら何もしない。読み込み中なら同じ約束を返す。 */
    ensure(onProgress) {
      if (state.loaded && !state.error) return Promise.resolve();
      if (inflight) return inflight;
      inflight = run(onProgress).finally(() => { inflight = null; });
      return inflight;
    },
    /** 利用者の「更新」。凍結した並びも取り直す。 */
    reload(onProgress) {
      if (inflight) return inflight;
      frozenTracks = null;
      inflight = run(onProgress).finally(() => { inflight = null; });
      return inflight;
    },
    shelves(history) {
      freezeTracks();
      return buildShelves({ recent: history.list(), tracks: frozenTracks ?? [], ...data });
    },
  };
}
