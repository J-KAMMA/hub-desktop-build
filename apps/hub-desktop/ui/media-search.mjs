const record = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/u.test(value);
function mediaScope(value) {
  if (!record(value, ['origin', 'deviceId', 'viewerId', 'generation']) || typeof value.origin !== 'string' || value.origin.length > 512 || !Number.isSafeInteger(value.generation) || value.generation < 0) throw Error('invalid_media_scope');
  const url = new URL(value.origin);
  if (url.origin !== value.origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol) || !(value.deviceId === null && value.viewerId === null || identifier(value.deviceId) && identifier(value.viewerId))) throw Error('invalid_media_scope');
  return { ...value };
}
const sameScope = (left, right) => left && right && ['origin', 'deviceId', 'viewerId', 'generation'].every(key => left[key] === right[key]);
function plainJson(value, depth = 0) {
  if (depth > 6) throw Error('invalid_media_memory');
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string' && value.length <= 100000 && !/\p{Surrogate}/u.test(value)) return;
  if (!value || typeof value !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) throw Error('invalid_media_memory');
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw Error('invalid_media_memory');
  if (Reflect.ownKeys(value).length !== Object.keys(value).length + Number(Array.isArray(value))) throw Error('invalid_media_memory');
  for (const key of Object.keys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !Object.hasOwn(descriptor, 'value') || ['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('invalid_media_memory'); plainJson(descriptor.value, depth + 1); }
}

// One request generation per search; paging always uses that generation's filters.
export function createMediaSearch({ fetchPage, changed, delay = 250, key = item => item.id, allowUnknownTotal = false, validateItem = () => true }) {
  let generation = 0, timer, retryOffset = 0;
  let boundScope = null;
  let state = { query: "", filters: {}, items: [], total: 0, categories: [], offset: 0, hasMore: false, loading: false, error: null };
  const emit = () => changed({ ...state });
  async function run(offset, version) {
    state = { ...state, loading: true, error: null }; retryOffset = offset; emit();
    try {
      let timer; // 応答が来ないまま読み込み中で止まらないよう、30秒で失敗にして再試行を出す。
      const page = await Promise.race([fetchPage({ query: state.query, ...state.filters, offset }), new Promise((_, reject) => { timer = setTimeout(() => reject("request_timeout"), 30_000); })]).finally(() => clearTimeout(timer));
      if (version !== generation) return;
      if (!Array.isArray(page.items) || !(Number.isSafeInteger(page.total) && page.total >= 0 || allowUnknownTotal && page.total === null) || typeof page.hasMore !== "boolean" || (page.hasMore && !page.items.length)) throw new Error("検索結果を確認できません。接続先Hubを更新して再試行してください。");
      const items = offset ? [...new Map([...state.items, ...page.items].map(item => [key(item), item])).values()] : page.items;
      state = { ...state, items, total: page.total, categories: page.categories ?? [], offset: offset + page.items.length, hasMore: page.hasMore, loading: false, error: null };
    } catch (error) {
      if (version !== generation) return;
      state = { ...state, loading: false, error };
    }
    emit();
  }
  function search(query, filters = {}, immediate = false, scope = null) {
    boundScope = scope === null ? null : mediaScope(scope);
    clearTimeout(timer); const version = ++generation;
    state = { query: query.trim(), filters: { ...filters }, items: [], total: 0, categories: [], offset: 0, hasMore: false, loading: true, error: null };
    if (state.query.length > 100 || state.query.split(/\s+/u).length > 8) {
      state.loading = false; state.error = new Error("検索語は100文字・8語以内で指定してください。"); emit(); return;
    }
    if (immediate) return run(0, version);
    emit(); timer = setTimeout(() => void run(0, version), delay);
  }
  return {
    search,
    invalidate() { clearTimeout(timer); generation++; state = { ...state, loading: false, hasMore: false }; },
    more: () => !state.loading && state.hasMore ? run(state.offset, generation) : undefined,
    retry: () => !state.loading ? (state.query.length > 100 || state.query.split(/\s+/u).length > 8 ? search(state.query, state.filters, true) : run(retryOffset, generation)) : undefined,
    snapshot: () => ({ ...state }),
    capture(scope) {
      try {
        const expected = mediaScope(scope); if (!sameScope(boundScope, expected) || state.loading || state.error) return null;
        const result = { version: 1, scope: expected, snapshot: state }; plainJson(result);
        if (new TextEncoder().encode(JSON.stringify(result)).length > 2 * 1024 * 1024) return null;
        return structuredClone(result);
      } catch { return null; }
    },
    restore(value, scope) {
      try {
        const expected = mediaScope(scope);
        plainJson(value); if (!record(value, ['version', 'scope', 'snapshot']) || value.version !== 1 || !sameScope(mediaScope(value.scope), expected) || new TextEncoder().encode(JSON.stringify(value)).length > 2 * 1024 * 1024) return false;
        const next = value.snapshot;
        if (!record(next, ['query', 'filters', 'items', 'total', 'categories', 'offset', 'hasMore', 'loading', 'error']) || typeof next.query !== 'string' || next.query !== next.query.trim() || next.query.length > 100 || next.query.split(/\s+/u).length > 8 || !record(next.filters, Object.keys(next.filters ?? {})) || Object.keys(next.filters).some(key => !['category', 'order'].includes(key)) || next.filters.category !== undefined && (typeof next.filters.category !== 'string' || next.filters.category.length > 100) || next.filters.order !== undefined && !['recent', 'popular', 'live'].includes(next.filters.order) || !Array.isArray(next.items) || !(Number.isSafeInteger(next.total) && next.total >= 0 || allowUnknownTotal && next.total === null) || !Array.isArray(next.categories) || !Number.isSafeInteger(next.offset) || next.offset < next.items.length || typeof next.hasMore !== 'boolean' || next.hasMore && (!next.items.length || next.total !== null && next.offset >= next.total) || next.loading !== false || next.error !== null) return false;
        const seen = new Set();
        for (const item of next.items) { const itemKey = key(item); if (typeof itemKey !== 'string' || !itemKey || itemKey.length > 128 || /\p{Cc}/u.test(itemKey) || seen.has(itemKey) || !validateItem(item)) return false; seen.add(itemKey); }
        const categories = new Set();
        for (const item of next.categories) { if (!record(item, ['name', 'count']) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || categories.has(item.name) || !Number.isSafeInteger(item.count) || item.count < 0) return false; categories.add(item.name); }
        const restored = structuredClone(next);
        clearTimeout(timer); generation++; state = restored; boundScope = expected; retryOffset = next.offset; emit(); return true;
      } catch { return false; }
    },
  };
}
