import {matchesSearch} from './search-input.mjs';
import {normalizeHubSearchFilters, hasHubSearchFilters, HUB_SEARCH_TYPES} from './hub-search-filters.mjs';
export const searchSources = Object.freeze({hub: '投稿・人物など', articles: '記事', works: '外部音楽', tracks: '公開曲', projects: 'プロジェクト', books: '本'});
const invalid = () => new Error('検索の続きを確認できませんでした。');
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const validCursor = value => typeof value === 'string' && value.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value);
const coreKey = item => {
  if (!HUB_SEARCH_TYPES.includes(item?.sourceGroup) || !identifier(item?.ref?.id)) throw invalid();
  return `${item.sourceGroup}:${item.ref.id}`;
};
const itemKey = item => { if (!identifier(item?.id)) throw invalid(); return item.id; };
const uniqueKeys = (items, key) => {
  const keys = items.map(key);
  if (new Set(keys).size !== keys.length) throw invalid();
  return keys;
};
export function createHubSearch({invoke, changed}) {
  let generation = 0, query = '', filters = normalizeHubSearchFilters(), order = 'recommended', valid = false;
  let data = {}, errors = {}, pending = new Set(), next = {}, offsets = {}, failedPages = {};
  const sources = () => hasHubSearchFilters(filters) ? ['hub'] : Object.keys(searchSources);
  const snapshot = () => structuredClone({query, filters, order, filtered: hasHubSearchFilters(filters), sources: sources(), data, errors, pending: [...pending], more: Object.keys(next)});
  const emit = () => changed(snapshot());
  const reset = () => { generation++; data = {}; errors = {}; pending = new Set(); next = {}; offsets = {}; failedPages = {}; };
  async function read(source, continuation = false) {
    if (!valid || !sources().includes(source) || (!query && !hasHubSearchFilters(filters)) || pending.has(source) || continuation && !(source in next)) return;
    const version = generation, term = query, offset = continuation ? offsets[source] ?? 0 : 0, token = continuation ? next[source] : null;
    pending.add(source); delete errors[source]; emit();
    try {
      const resource = {hub: 'search', articles: 'articles', works: 'music', projects: 'research', books: 'books'}[source];
      const args = {resource, query: term, cursor: source === 'hub' ? token : null, offset,
        ...(source === 'hub' ? {searchFilters: {...filters}, order} : {})};
      const body = await (source === 'tracks' ? invoke('music_tracks', {query: term, offset}) : invoke('hub_resource', args));
      if (version !== generation) return;
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.hasMore !== undefined && typeof body.hasMore !== 'boolean') throw invalid();
      if (source === 'hub') {
        if (!Array.isArray(body.coreEntities)) throw invalid();
        const keys = uniqueKeys(body.coreEntities, coreKey), following = body.nextCursor ?? null;
        if (following !== null && !validCursor(following) || body.hasMore === true && !following || body.hasMore === false && following || following && !keys.length) throw invalid();
        const previous = new Map((data.coreEntities ?? []).map(item => [coreKey(item), item]));
        if (continuation && (following === token || !keys.some(key => !previous.has(key)))) throw invalid();
        const copy = structuredClone(body);
        if (continuation) data.coreEntities = [...new Map([...previous, ...copy.coreEntities.map(item => [coreKey(item), item])]).values()];
        else data = {...data, ...Object.fromEntries(Object.entries(copy).filter(([, items]) => Array.isArray(items)))};
        delete next[source]; if (following) next[source] = following;
      } else {
        const raw = body[source];
        if (!Array.isArray(raw)) throw invalid();
        uniqueKeys(raw, itemKey);
        const followingOffset = offset + raw.length;
        if (!Number.isSafeInteger(followingOffset) || followingOffset > 0xffffffff) throw invalid();
        const items = source === 'books' ? raw.filter(item => matchesSearch(term, item.title, item.author, item.description)) : raw;
        const previous = new Map((data[source] ?? []).map(item => [itemKey(item), item]));
        if (body.hasMore === true && !items.length || continuation && !items.some(item => !previous.has(itemKey(item)))) throw invalid();
        const copy = structuredClone(items);
        data[source] = continuation ? [...new Map([...previous, ...copy.map(item => [itemKey(item), item])]).values()] : copy;
        offsets[source] = followingOffset;
        delete next[source]; if (body.hasMore === true) next[source] = true;
      }
      delete failedPages[source];
    } catch (error) { if (version === generation) { errors[source] = error; failedPages[source] = continuation; } }
    finally { if (version === generation) { pending.delete(source); emit(); } }
  }
  return {
    search(term, options = {}) {
      reset(); valid = false; query = ''; filters = normalizeHubSearchFilters(); order = 'recommended';
      try {
        if (typeof term !== 'string' || !options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Reflect.ownKeys(options).some(key => !['filters', 'order'].includes(key))) throw invalid();
        query = term.normalize('NFKC').trim().toLocaleLowerCase('ja');
        if (query.length > 100 || query && query.split(/\s+/u).length > 8 || /[\u0000-\u001f\u007f-\u009f]/u.test(query.replace(/\s/gu, ''))) throw new Error('検索語は100文字・8語以内で指定してください。');
        filters = normalizeHubSearchFilters(options.filters);
        const requestedOrder = options.order === undefined ? 'recommended' : options.order;
        if (!['recommended', 'kind'].includes(requestedOrder)) throw invalid();
        order = requestedOrder;
        valid = true;
        if (!query && !hasHubSearchFilters(filters)) { emit(); return Promise.resolve(); }
        return Promise.all(sources().map(source => read(source)));
      } catch (error) { errors.hub = error; emit(); return Promise.resolve(); }
    },
    invalidate() { reset(); valid = false; query = ''; filters = normalizeHubSearchFilters(); order = 'recommended'; emit(); },
    more: source => read(source, true),
    retry: source => read(source, failedPages[source] === true),
    snapshot,
  };
}
