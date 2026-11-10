// 埋め込みで再生できない YouTube の動画ID（IFrame API の onError 100/101/150）をこの端末に覚え、
// 音楽・動画の一覧から外す。Hub 自前の曲・動画（YouTube ではない）には一切触れない。
import { youtubeVideoId } from './youtube-embed.mjs';

// v2（2026-11-05）：v1 は 152/153 まで覚えて、再生できる曲まで一覧から消していた。旧い一覧は引き継がない。
export const UNPLAYABLE_KEY = 'hub.desktop.ytUnplayable.v2';
export const UNPLAYABLE_CODES = new Set([100, 101, 150]);
// 152/153 は埋め込み側の設定や送り元の問題で、動画そのものの性質ではない。その回は止めるが、覚えない。
export const TRANSIENT_CODES = new Set([152, 153]);
export const isTransientCode = (code) => TRANSIENT_CODES.has(Number(code));
export const MAX_UNPLAYABLE = 2000;
export const UNPLAYABLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{11}$/;

/** 埋め込みの onError の値が「再生不可」を表すか。 */
export const isUnplayableCode = (code) => UNPLAYABLE_CODES.has(Number(code));

/** storage は localStorage 互換。読み書きの失敗は握りつぶし、メモリだけで動く。 */
export function createUnplayableStore({ storage = null, now = Date.now } = {}) {
  let entries = null; // Map<id, timestamp>（挿入順＝古い順）
  const listeners = new Set();
  const load = () => {
    if (entries) return entries;
    entries = new Map();
    try {
      const raw = JSON.parse(storage?.getItem(UNPLAYABLE_KEY) ?? '[]');
      if (Array.isArray(raw)) for (const row of raw) if (Array.isArray(row) && ID.test(row[0]) && Number.isFinite(row[1])) entries.set(row[0], row[1]);
    } catch { /* 読めなければ空から */ }
    return entries;
  };
  const prune = () => {
    const map = load(), limit = now() - UNPLAYABLE_TTL_MS;
    let changed = false;
    for (const [id, at] of map) if (at < limit) { map.delete(id); changed = true; }
    return changed;
  };
  const save = () => { try { storage?.setItem(UNPLAYABLE_KEY, JSON.stringify([...load()])); } catch { /* 覚えられなくても動く */ } };
  return {
    has(id) {
      if (typeof id !== 'string') return false;
      const map = load(), at = map.get(id);
      if (at === undefined) return false;
      if (at < now() - UNPLAYABLE_TTL_MS) { map.delete(id); save(); return false; }
      return true;
    },
    add(id) {
      if (typeof id !== 'string' || !ID.test(id)) return false;
      const map = load(), fresh = !map.has(id);
      map.delete(id); map.set(id, now());
      prune();
      while (map.size > MAX_UNPLAYABLE) map.delete(map.keys().next().value);
      save();
      if (fresh) for (const fn of [...listeners]) { try { fn(id); } catch { listeners.delete(fn); } }
      return true;
    },
    size() { prune(); return load().size; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

const globalStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
let shared = null;
/** 端末で共有する1つの store。 */
export const unplayable = () => (shared ??= createUnplayableStore({ storage: globalStorage() }));
/** テスト用：共有 store を差し替える。 */
export const setUnplayableStore = (store) => { shared = store; };

/** 動画（sourceUrl が YouTube）の動画ID。 */
export const videoIdOf = (video) => (video && typeof video.sourceUrl === 'string' ? youtubeVideoId(video.sourceUrl) : null);
/** 作品（services の中の YouTube）の動画ID。 */
export function workIdOf(work) {
  const services = Array.isArray(work?.services) ? work.services : [];
  for (const service of services) {
    if (!service || typeof service !== 'object') continue;
    const id = youtubeVideoId(service.embedUrl) ?? youtubeVideoId(service.url);
    if (id) return id;
  }
  return null;
}

/** 唯一の絞り込み。idOf が YouTube の動画IDを返し、それが再生不可として覚えられていれば外す。それ以外は触らない。 */
export function filterPlayable(list, idOf, store = unplayable()) {
  if (!Array.isArray(list)) return list;
  return list.filter((item) => { const id = idOf(item); return !(id && store.has(id)); });
}
export const filterVideos = (list, store) => filterPlayable(list, videoIdOf, store);
export const filterWorks = (list, store) => filterPlayable(list, workIdOf, store);

/** Hub 窓口の応答（videos / works / items / related）を、同じ絞り込みで通す。他の項目はそのまま。 */
export function filterResource(data, store = unplayable()) {
  if (!data || typeof data !== 'object') return data;
  let out = data;
  for (const [key, fn] of [['videos', videoIdOf], ['works', workIdOf]]) {
    if (Array.isArray(data[key])) { const kept = filterPlayable(data[key], fn, store); if (kept.length !== data[key].length) out = { ...out, [key]: kept }; }
  }
  return out;
}

/** invoke を包み、hub_resource の応答だけを filterResource に通す（ここが一覧の入口の共通の網）。 */
export const filterInvoke = (invoke) => async (command, ...rest) => {
  const result = await invoke(command, ...rest);
  return command === 'hub_resource' ? filterResource(result) : result;
};
