// Hub のオリジナル曲を先に、YouTube などの外部の曲は足りない分の穴埋めにだけ使う（2026-10-14、旦那様の決定）。
// Web の apps/hub/lib/music-originals-first.ts と同じ規則の純粋関数。表示順・件数配分はここに集める。
// Desktop の曲は3種類ある: Music Worker の公開曲（kind "track"）、作品（kind "work"、id が music:<uuid> ならオリジナル）、
// 他Hubの曲（peer。audioPath があれば相手のHubのオリジナル、YouTube だけなら外部）。

/** 1つの枠（棚・格子）の標準の件数。オリジナルで埋まれば外部の曲は出さない。 */
export const MUSIC_SLOT_SIZE = 12;
/** 検索でオリジナルがこの件数以上あるとき、外部の曲は折りたたむ。 */
export const MUSIC_SEARCH_COLLAPSE_AT = 5;
/** オリジナルがこの件数より少ないときだけ、外部の曲のジャンル棚を出す。 */
export const MUSIC_EXTERNAL_BROWSE_BELOW = 6;

const HUB_ORIGINAL_ID = /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 作品 id が Hub のオリジナル（Music Worker の公開曲）か。 */
export function isHubOriginalWork(work) {
  return typeof work?.id === 'string' && HUB_ORIGINAL_ID.test(work.id);
}

/**
 * 音楽ホームの項目（{kind:'track'|'work'|'peer', ...}）がオリジナルか。
 * 公開曲は常にオリジナル。他Hubの曲は音声の経路があるものだけ。YouTube の作品は外部。
 */
export function isOriginalEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === 'track') return true;
  if (entry.kind === 'peer') return Boolean(entry.peer?.audioPath);
  if (entry.kind === 'work') return isHubOriginalWork(entry.work);
  return false;
}

export function splitByOrigin(entries) {
  const originals = [];
  const external = [];
  for (const entry of entries) (isOriginalEntry(entry) ? originals : external).push(entry);
  return { originals, external };
}

/** 順序を保ったまま、オリジナルを前へ。 */
export function originalsFirst(entries) {
  const { originals, external } = splitByOrigin(entries);
  return [...originals, ...external];
}

const entryKey = entry => (entry.kind === 'track' ? `track:${entry.track?.id}` : entry.kind === 'peer' ? `peer:${entry.peer?.key}` : `work:${entry.work?.id}`);

/**
 * 枠を埋める。オリジナルを先に最大 size 件、足りない分だけ外部の曲で埋める。
 * オリジナルが size 件以上なら外部の曲は 0 件。
 */
export function fillSlot(originals, external, size = MUSIC_SLOT_SIZE) {
  const head = originals.slice(0, Math.max(0, size));
  const room = Math.max(0, size - head.length);
  const keys = new Set(head.map(entryKey));
  return { originals: head, external: external.filter(entry => !keys.has(entryKey(entry))).slice(0, room) };
}

/** 検索・絞り込みの結果。オリジナルが多ければ外部の曲は折りたたむ。 */
export function searchLayout(entries, collapseAt = MUSIC_SEARCH_COLLAPSE_AT) {
  const { originals, external } = splitByOrigin(entries);
  return { originals, external, collapseExternal: originals.length >= collapseAt && external.length > 0 };
}

/**
 * 続けて再生する待ち行列。開始曲を先頭に、残りはオリジナル、外部の曲の順。
 * 外部の曲はオリジナルの候補が尽きてからだけ鳴る。
 */
export function orderPlaybackQueue(entries, startKey) {
  const start = startKey ? entries.find(entry => entryKey(entry) === startKey) : undefined;
  const rest = originalsFirst(entries.filter(entry => entry !== start));
  return start ? [start, ...rest] : rest;
}

/** 重複を除く（先に来たものを残す）。 */
export function uniqueEntries(entries) {
  const seen = new Set();
  return entries.filter(entry => { const key = entryKey(entry); if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * 音楽ホームの構成を決める。DOM を持たない。
 *  - hero: 注目のオリジナル1曲（公開曲を先頭に、無ければ他のオリジナル）。無ければ null
 *  - originalShelves: オリジナルの棚（順に並べる。空の棚は含めない）
 *  - external: 外部の曲。オリジナルが size 件に満たない分だけ。オリジナルが十分なら folded に回す
 */
export function arrangeMusicHome({ recent = [], favorites = [], tracks = [], peers = [], recommended = [] }, size = MUSIC_SLOT_SIZE) {
  const trackEntries = tracks.map(track => ({ kind: 'track', track }));
  const favoriteEntries = favorites.map(work => ({ kind: 'work', work }));
  const peerEntries = peers.map(peer => ({ kind: 'peer', peer }));
  const recommendedEntries = recommended.map(work => ({ kind: 'work', work }));
  const recentSplit = splitByOrigin(recent);
  const favoriteSplit = splitByOrigin(favoriteEntries);
  const peerSplit = splitByOrigin(peerEntries);

  const everyOriginal = uniqueEntries([...trackEntries, ...favoriteSplit.originals, ...peerSplit.originals, ...recentSplit.originals]);
  const hero = everyOriginal[0] ?? null;
  const originalShelves = [
    { id: 'recent', name: '最近再生した', entries: uniqueEntries(recentSplit.originals).slice(0, size) },
    { id: 'tracks', name: '新しいオリジナル', entries: trackEntries.slice(0, size) },
    { id: 'favorites', name: 'お気に入り', entries: favoriteSplit.originals.slice(0, size) },
    { id: 'peers', name: 'ほかのHubのオリジナル', entries: peerSplit.originals.slice(0, size) },
  ].filter(shelf => shelf.entries.length > 0);

  const externalPool = uniqueEntries([...recentSplit.external, ...favoriteSplit.external, ...peerSplit.external, ...recommendedEntries]);
  const filled = fillSlot(everyOriginal, externalPool, size);
  // 外部の曲は、オリジナルが枠に満たない分だけ見せる。枠が埋まっていれば畳んだ一覧に回す。
  const folded = filled.external.length === 0 ? externalPool.slice(0, size) : [];
  return { hero, originalShelves, originalCount: everyOriginal.length, external: filled.external, folded };
}
