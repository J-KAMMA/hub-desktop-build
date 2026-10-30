// Playlist APIs return bare ids. This resolves them to displayable works/videos through the
// existing hub_detail reads, with a small concurrency limit and a cache (misses are cached too).
const MAX_CACHE = 600;

export function createItemResolver({ invoke, kind, concurrency = 3 }) {
  if (kind !== 'music' && kind !== 'video') throw Error('invalid_resolver_kind');
  const cache = new Map(); // id -> Promise<item|null>
  const done = new Map(); // id -> item|null (settled)
  const waiting = [];
  let running = 0;

  const pump = () => {
    while (running < concurrency && waiting.length) {
      const job = waiting.shift();
      running++;
      Promise.resolve()
        .then(() => invoke('hub_detail', { name: kind === 'music' ? 'music_work' : 'video', ids: [job.id] }))
        .then((data) => {
          const item = kind === 'music' ? data?.work : data?.video;
          return item && typeof item === 'object' && typeof item.title === 'string' ? item : null;
        })
        .catch(() => null)
        .then((item) => { running--; done.set(job.id, item); job.resolve(item); pump(); });
    }
  };

  return {
    /** 同期で引ける（解決済みのときだけ）。 */
    peek: (id) => done.get(id),
    resolve(id) {
      if (typeof id !== 'string' || !id) return Promise.resolve(null);
      let promise = cache.get(id);
      if (!promise) {
        if (cache.size >= MAX_CACHE) { const first = cache.keys().next().value; cache.delete(first); done.delete(first); }
        promise = new Promise((resolve) => { waiting.push({ id, resolve }); });
        cache.set(id, promise);
        pump();
      }
      return promise;
    },
    /** 取れなかった id を次回また試す。 */
    forgetMisses() { for (const [id, item] of done) if (item === null) { done.delete(id); cache.delete(id); } },
    stats: () => ({ running, waiting: waiting.length, cached: cache.size }),
  };
}
