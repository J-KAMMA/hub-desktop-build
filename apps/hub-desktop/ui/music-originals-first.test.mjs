import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MUSIC_SLOT_SIZE, MUSIC_SEARCH_COLLAPSE_AT, isHubOriginalWork, isOriginalEntry, splitByOrigin, originalsFirst, fillSlot, searchLayout,
  orderPlaybackQueue, uniqueEntries, arrangeMusicHome,
} from './music-originals-first.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const original = n => ({ kind: 'work', work: { id: `music:${uuid(n)}`, title: `O${n}` } });
const external = n => ({ kind: 'work', work: { id: `yt-${n}`, title: `E${n}` } });
const track = n => ({ id: uuid(n), title: `T${n}`, artist: 'a' });
const peerAudio = n => ({ key: `https://h.example\np${n}`, title: `P${n}`, artist: '', host: 'h.example', audioPath: `/music/api/tracks/${n}/audio`, youtubeId: null });
const peerYoutube = n => ({ key: `https://h.example\ny${n}`, title: `Y${n}`, artist: '', host: 'h.example', audioPath: null, youtubeId: 'dQw4w9WgXcQ' });
const ids = list => list.map(entry => entry.work?.id ?? entry.track?.id ?? entry.peer?.key);

test('the slot is twelve, as on the web', () => {
  assert.equal(MUSIC_SLOT_SIZE, 12);
  assert.equal(MUSIC_SEARCH_COLLAPSE_AT, 5);
});

test('only music:<uuid> work ids are Hub originals', () => {
  assert.equal(isHubOriginalWork({ id: `music:${uuid(1)}` }), true);
  assert.equal(isHubOriginalWork({ id: 'music:not-a-uuid' }), false);
  assert.equal(isHubOriginalWork({ id: 'community-1' }), false);
  assert.equal(isHubOriginalWork(null), false);
});

test('entries: Music Worker tracks and peer audio are originals; YouTube works and YouTube-only peers are external', () => {
  assert.equal(isOriginalEntry({ kind: 'track', track: track(1) }), true);
  assert.equal(isOriginalEntry({ kind: 'peer', peer: peerAudio(1) }), true);
  assert.equal(isOriginalEntry({ kind: 'peer', peer: peerYoutube(1) }), false);
  assert.equal(isOriginalEntry(original(1)), true);
  assert.equal(isOriginalEntry(external(1)), false);
  assert.equal(isOriginalEntry({ kind: 'bogus' }), false);
});

test('splitByOrigin and originalsFirst keep order inside each group and put originals in front', () => {
  const mixed = [external(1), original(1), external(2), original(2)];
  const { originals, external: outside } = splitByOrigin(mixed);
  assert.deepEqual(ids(originals), [`music:${uuid(1)}`, `music:${uuid(2)}`]);
  assert.deepEqual(ids(outside), ['yt-1', 'yt-2']);
  assert.deepEqual(ids(originalsFirst(mixed)), [`music:${uuid(1)}`, `music:${uuid(2)}`, 'yt-1', 'yt-2']);
});

test('fillSlot: originals first, external only fills the gap, and none when originals fill the slot', () => {
  const outside = Array.from({ length: 20 }, (_, index) => external(index));
  const few = fillSlot([original(1), original(2)], outside);
  assert.equal(few.originals.length, 2);
  assert.equal(few.external.length, 10);
  const none = fillSlot(Array.from({ length: 12 }, (_, index) => original(index)), outside);
  assert.equal(none.originals.length, 12);
  assert.equal(none.external.length, 0);
  const over = fillSlot(Array.from({ length: 15 }, (_, index) => original(index)), outside);
  assert.equal(over.originals.length, 12);
  assert.equal(over.external.length, 0);
  assert.deepEqual(fillSlot([], outside, 3).external.length, 3);
});

test('fillSlot drops an external entry that duplicates an original', () => {
  const same = original(1);
  assert.equal(fillSlot([same], [same, external(1)]).external.length, 1);
});

test('searchLayout folds external when there are enough originals', () => {
  const few = searchLayout([original(1), external(1)]);
  assert.equal(few.collapseExternal, false);
  const many = searchLayout([...Array.from({ length: 5 }, (_, index) => original(index)), external(1)]);
  assert.equal(many.collapseExternal, true);
  assert.equal(searchLayout(Array.from({ length: 6 }, (_, index) => original(index))).collapseExternal, false);
});

test('orderPlaybackQueue starts with the chosen entry, then originals, then external', () => {
  const list = [external(1), original(1), external(2), original(2)];
  const queue = orderPlaybackQueue(list, 'work:yt-2');
  assert.deepEqual(ids(queue), ['yt-2', `music:${uuid(1)}`, `music:${uuid(2)}`, 'yt-1']);
  assert.deepEqual(ids(orderPlaybackQueue(list)), [`music:${uuid(1)}`, `music:${uuid(2)}`, 'yt-1', 'yt-2']);
});

test('uniqueEntries keeps the first of each key', () => {
  assert.equal(uniqueEntries([external(1), external(1), original(1)]).length, 2);
});

test('home: a Hub track is the hero; originals form the shelves; YouTube fills the gap in its own section', () => {
  const home = arrangeMusicHome({
    recent: [{ kind: 'work', work: external(1).work }, { kind: 'track', track: track(2) }],
    favorites: [external(2).work],
    tracks: [track(1), track(2)],
    peers: [peerAudio(1), peerYoutube(1)],
    recommended: [external(3).work, external(4).work],
  });
  assert.deepEqual(home.hero, { kind: 'track', track: track(1) });
  assert.deepEqual(home.originalShelves.map(shelf => shelf.id), ['recent', 'tracks', 'peers']);
  assert.ok(home.originalShelves.every(shelf => shelf.entries.every(isOriginalEntry)), 'no external entry inside an original shelf');
  assert.equal(home.originalCount, 3);
  assert.ok(home.external.length > 0 && home.external.every(entry => !isOriginalEntry(entry)));
  assert.deepEqual(home.folded, []);
  assert.ok(home.external.length <= 12 - home.originalCount);
});

test('home: with no originals there is no hero and the external works fill the slot', () => {
  const home = arrangeMusicHome({ recommended: Array.from({ length: 30 }, (_, index) => external(index).work) });
  assert.equal(home.hero, null);
  assert.deepEqual(home.originalShelves, []);
  assert.equal(home.external.length, 12);
});

test('home: when originals fill the slot, external goes to the folded list instead', () => {
  const tracks = Array.from({ length: 14 }, (_, index) => track(index));
  const home = arrangeMusicHome({ tracks, recommended: [external(1).work, external(2).work] });
  assert.equal(home.external.length, 0);
  assert.equal(home.folded.length, 2);
  assert.equal(home.originalShelves[0].entries.length, 12);
});

test('home: an external work in favorites or recents is never shown among the originals', () => {
  const home = arrangeMusicHome({ recent: [external(1)], favorites: [external(2).work, original(3).work], tracks: [] });
  assert.deepEqual(home.originalShelves.map(shelf => shelf.id), ['favorites']);
  assert.deepEqual(ids(home.originalShelves[0].entries), [`music:${uuid(3)}`]);
  assert.deepEqual(ids(home.external).sort(), ['yt-1', 'yt-2']);
});
