import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSearch } from './media-search.mjs';
const page = (id, total = 1, hasMore = false) => ({items:[{id}],total,hasMore});
test('late search and page responses never replace newer input, even during debounce', async () => {
  const requests=[]; let state;
  const search=createMediaSearch({fetchPage:args=>new Promise(resolve=>requests.push({args,resolve})),changed:next=>state=next,delay:5});
  const first=search.search('old',{},true);
  search.search('new');
  requests[0].resolve(page('old')); await first;
  assert.equal(state.items.length,0);
  await new Promise(resolve=>setTimeout(resolve,15));
  requests[1].resolve(page('new',2,true)); await new Promise(resolve=>setTimeout(resolve,0));
  const more=search.more();
  const final=search.search('last',{},true);
  requests[2].resolve(page('old-page',2)); await more;
  assert.equal(state.items.length,0);
  requests[3].resolve(page('last')); await final;
  assert.deepEqual(state.items,[{id:'last'}]);
});
test('paging keeps query and filters, ignores duplicate click, and retries failed page without losing rows', async () => {
  let state, fail=true; const requests=[];
  const search=createMediaSearch({changed:next=>state=next,fetchPage:async args=>{
    requests.push(args); if(!args.offset)return page('one',3,true);
    if(fail)throw Error('offline');return {items:[{id:'one'},{id:'two'}],total:3,hasMore:false};
  }});
  await search.search('山 音楽',{category:'自然',order:'popular'},true);
  const more=search.more(); assert.equal(search.more(),undefined); await more;
  assert.equal(state.items.length,1); assert.ok(state.error);
  fail=false; await search.retry();
  assert.deepEqual(requests.at(-1),{query:'山 音楽',category:'自然',order:'popular',offset:1});
  assert.deepEqual(state.items.map(x=>x.id),['one','two']); assert.equal(state.offset,3);
});
test('empty success, invalid page, input bounds, and clearing input have explicit states', async () => {
  let state,calls=0;
  const search=createMediaSearch({changed:s=>state=s,fetchPage:async ()=>{calls++;return {items:[],total:0,hasMore:false};}});
  await search.search('',{},true); assert.equal(state.error,null); assert.equal(state.loading,false);
  await search.search('a'.repeat(101),{},true); assert.ok(state.error); assert.equal(calls,1);
  await search.search('a b c d e f g h i',{},true); assert.equal(calls,1);
  await search.search('',{},true); assert.equal(state.query,''); assert.equal(calls,2);
  const broken=createMediaSearch({changed:s=>state=s,fetchPage:async ()=>({items:[],total:5,hasMore:true})});
  await broken.search('',{},true); assert.ok(state.error); assert.equal(state.loading,false);
});

const scope = { origin: 'https://hub.example', deviceId: 'device1', viewerId: 'viewer1', generation: 1 };

test('scope-bound capture/restore retains the loaded page, full metadata, facets and filters without requests', async () => {
  let calls = 0, displayed;
  const original = createMediaSearch({ changed: () => {}, fetchPage: async ({ offset }) => { calls++; return { items: [{ id: `video${offset}`, title: '<b>literal</b>', sourceUrl: 'https://video.example/watch' }], total: 3, hasMore: true, categories: [{ name: '自然', count: 3 }] }; } });
  await original.search('山', { category: '自然', order: 'popular' }, true, scope); await original.more();
  const memory = original.capture(scope); assert.ok(memory); memory.snapshot.items[0].title = 'caller edit'; assert.equal(original.snapshot().items[0].title, '<b>literal</b>');
  const next = createMediaSearch({ changed: value => displayed = value, fetchPage: async ({ offset }) => { calls++; assert.equal(offset, 2); return { items: [{ id: 'last' }], total: 3, hasMore: false }; } });
  assert.equal(next.restore(original.capture(scope), scope), true); assert.equal(calls, 2);
  assert.equal(displayed.offset, 2); assert.equal(displayed.items.length, 2); assert.deepEqual(displayed.filters, { category: '自然', order: 'popular' }); assert.deepEqual(displayed.categories, [{ name: '自然', count: 3 }]);
  await next.more(); assert.equal(calls, 3); assert.equal(next.snapshot().offset, 3);
});

test('successful restore retires an old in-flight request and owns its cloned metadata', async () => {
  let finish; const next = createMediaSearch({ changed: () => {}, fetchPage: () => new Promise(resolve => finish = resolve) });
  const source = createMediaSearch({ changed: () => {}, fetchPage: async () => page('retained') }); await source.search('', {}, true, scope);
  const memory = source.capture(scope), pending = next.search('old', {}, true, scope);
  assert.equal(next.restore(memory, scope), true); memory.snapshot.items[0].id = 'changed'; finish(page('late')); await pending;
  assert.equal(next.snapshot().items[0].id, 'retained'); assert.equal(next.snapshot().query, '');
});

test('cross-origin/device/viewer/generation and malformed memory reject atomically without callbacks', async () => {
  const source = createMediaSearch({ changed: () => {}, fetchPage: async () => page('retained') }); await source.search('', {}, true, scope); const memory = source.capture(scope);
  for (const changed of [{ ...scope, origin: 'https://other.example' }, { ...scope, deviceId: 'device2' }, { ...scope, viewerId: 'viewer2' }, { ...scope, generation: 2 }]) { let emissions = 0; const target = createMediaSearch({ changed: () => emissions++, fetchPage: () => { throw Error('no requests'); } }); assert.equal(target.restore(memory, changed), false); assert.equal(emissions, 0); }
  const bad = [value => value.extra = true, value => value.snapshot.offset = -1, value => value.snapshot.filters.order = 'unknown', value => value.snapshot.filters.actor = 'wrong', value => value.snapshot.categories = [{ name: 'x', count: -1 }], value => value.snapshot.items.push({ id: 'retained' }), value => value.snapshot.items = Array(1), value => value.snapshot.items[0].title = 'x'.repeat(100001), value => value.snapshot.loading = true, value => value.snapshot.error = {}, value => Object.setPrototypeOf(value.snapshot.items[0], { inherited: true }), value => Object.defineProperty(value.snapshot.items[0], 'private', { get() { throw Error('getter must not run'); }, enumerable: true })];
  for (const mutate of bad) { const value = structuredClone(memory); mutate(value); let emissions = 0; const target = createMediaSearch({ changed: () => emissions++, fetchPage: () => { throw Error('no requests'); } }); assert.equal(target.restore(value, scope), false); assert.equal(emissions, 0); assert.equal(target.snapshot().items.length, 0); }
});

test('capture refuses pending/failed/unbound state and explicit metadata validator closes invalid restored video fields', async () => {
  let finish; const pending = createMediaSearch({ changed: () => {}, fetchPage: () => new Promise(resolve => finish = resolve) }); const work = pending.search('', {}, true, scope); assert.equal(pending.capture(scope), null); finish(page('one')); await work;
  assert.equal(pending.capture({ ...scope, viewerId: 'wrong' }), null);
  const unbound = createMediaSearch({ changed: () => {}, fetchPage: async () => page('one') }); await unbound.search('', {}, true); assert.equal(unbound.capture(scope), null);
  const target = createMediaSearch({ changed: () => {}, fetchPage: () => { throw Error('no requests'); }, validateItem: item => typeof item.title === 'string' }); assert.equal(target.restore(pending.capture(scope), scope), false);
  const guest = { ...scope, deviceId: null, viewerId: null }; await unbound.search('', {}, true, guest); assert.ok(unbound.capture(guest)); assert.equal(target.restore(unbound.capture(guest), { ...guest, deviceId: 'mixed' }), false);
});

test('UTF8 memory budget, scalar bounds and non-enumerable metadata fail closed while an empty page restores', async () => {
  const source = createMediaSearch({ changed: () => {}, fetchPage: async () => ({ items: [], total: 0, hasMore: false }) }); await source.search('', {}, true, scope);
  const empty = source.capture(scope), target = createMediaSearch({ changed: () => {}, fetchPage: () => { throw Error('no requests'); } }); assert.equal(target.restore(empty, scope), true);
  const oversized = structuredClone(empty); oversized.snapshot.items = Array.from({ length: 8 }, (_, index) => ({ id: String(index), text: 'あ'.repeat(100000) })); oversized.snapshot.offset = oversized.snapshot.total = 8;
  assert.equal(target.restore(oversized, scope), false);
  for (const mutate of [value => value.snapshot.offset = Number.MAX_SAFE_INTEGER + 1, value => value.snapshot.filters.category = 'x'.repeat(101), value => value.snapshot.items = [{ id: 'x', text: '\ud800' }], value => Object.defineProperty(value.snapshot, 'secret', { value: true })]) { const value = structuredClone(empty); mutate(value); assert.equal(target.restore(value, scope), false); }
});
