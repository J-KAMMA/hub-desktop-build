import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMusicHome, createMusicHistory, greetingFor } from './music-home.mjs';
import { renderMusicWorkHeader } from './music-work-detail.mjs';
import { createMusicYoutubeSession } from './music-youtube.mjs';

const yt = id => ({ provider: 'youtube', url: `https://music.youtube.com/watch?v=${id}`, embedUrl: `https://www.youtube-nocookie.com/embed/${id}` });
const works = [
  { id: 'sample-mw-1', title: 'Alpha', artist: 'A', services: [yt('dQw4w9WgXcQ')] },
  { id: 'sample-mw-2', title: 'Beta', artist: 'B', services: [{ provider: 'spotify', url: 'https://open.spotify.com/track/x' }] },
];

function homeFixture(t, loaders = {}) {
  const dom = new JSDOM('<main id="host"></main>', { url: 'http://localhost' });
  const { document } = dom.window;
  const calls = [];
  const history = createMusicHistory();
  const home = createMusicHome({
    document, host: document.getElementById('host'), hubAsset: (img, url) => { img.dataset.src = url; }, history,
    loaders: { recommended: async () => works, favorites: async () => [], tracks: () => [], ...loaders },
    actions: {
      openWork: work => calls.push(['open', work.id]), playWork: work => calls.push(['play', work.id]),
      playTrack: track => calls.push(['track', track.id]), search: query => calls.push(['search', query]),
    },
    now: () => new Date(2026, 9, 12, 9, 0),
  });
  t.after(() => { home.destroy(); dom.window.close(); });
  return { document, home, calls, history };
}

test('greeting follows the hour', () => {
  assert.equal(greetingFor(new Date(2026, 0, 1, 7)), 'おはようございます');
  assert.equal(greetingFor(new Date(2026, 0, 1, 13)), 'こんにちは');
  assert.equal(greetingFor(new Date(2026, 0, 1, 22)), 'こんばんは');
});

test('history keeps the newest first, de-duplicates and caps', () => {
  const history = createMusicHistory(3);
  for (const id of ['a', 'b', 'c', 'a', 'd']) history.add({ kind: 'work', work: { id } });
  history.add({ kind: 'bogus' });
  history.add({ kind: 'work', work: {} });
  assert.deepEqual(history.list().map(entry => entry.work.id), ['d', 'a', 'c']);
});

test('with only external works there is no hero, the empty hero says so, and the external section is labelled', async t => {
  const f = homeFixture(t);
  await f.home.refresh();
  const greeting = f.document.querySelector('.mh-greeting');
  assert.equal(greeting.tagName, 'P');
  assert.match(greeting.textContent, /おはよう/);
  const empty = f.document.querySelector('.mh-hero.is-empty');
  assert.ok(empty);
  assert.ok(empty.classList.contains('state-panel'));
  assert.ok(empty.querySelector('.state-title'));
  assert.ok(empty.querySelector('.state-body'));
  assert.equal(f.document.querySelectorAll('.mh-shelf-original').length, 0);
  assert.equal(f.document.querySelector('.mh-external .mh-shelf-title').textContent, 'YouTube Music');
  assert.equal(f.document.querySelector('.mh-external .mh-chip'), null);
  assert.equal(f.document.querySelectorAll('.mh-ext-row').length, 2);
});

test('only works with a YouTube embed get a play button; the row opens the detail', async t => {
  const f = homeFixture(t);
  await f.home.refresh();
  const rows = [...f.document.querySelectorAll('.mh-ext-row')];
  assert.ok(rows[0].querySelector('.mh-ext-play'));
  assert.equal(rows[1].querySelector('.mh-ext-play'), null);
  rows[0].querySelector('.mh-ext-play').click();
  rows[1].querySelector('.mh-ext-open').click();
  assert.deepEqual(f.calls, [['play', 'sample-mw-1'], ['open', 'sample-mw-2']]);
  assert.equal(rows[0].querySelector('.mh-ext-title').textContent, 'Alpha');
  assert.equal(rows[0].querySelector('.mh-ext-artist').textContent, 'A');
  assert.equal(rows[0].querySelector('.mh-ext-duration').textContent, '');
  assert.equal(rows[1].querySelector('.mh-ext-duration').textContent, '');
});

test('the source label is named once in the section header, never in a row', async t => {
  const f = homeFixture(t);
  await f.home.refresh();
  const section = f.document.querySelector('.mh-external');
  assert.equal(section.querySelectorAll('.mh-shelf-title').length, 1);
  assert.equal(section.querySelector('.mh-shelf-title').textContent, 'YouTube Music');
  assert.equal((section.textContent.match(/YouTube Music/g) ?? []).length, 1);
  assert.equal(section.querySelectorAll('.mh-ext-tag').length, 0);
  for (const row of section.querySelectorAll('.mh-ext-row')) assert.doesNotMatch(row.textContent, /YouTube Music/);
});

test('a row shows its duration as m:ss when the data has one, and leaves the slot empty otherwise', async t => {
  const timed = { id: 'sample-mw-3', title: 'Gamma', artist: 'C', durationSeconds: 201, services: [yt('aaaaaaaaaaa')] };
  const f = homeFixture(t, { recommended: async () => [timed, works[1]] });
  await f.home.refresh();
  const rows = [...f.document.querySelectorAll('.mh-ext-row')];
  assert.equal(rows[0].querySelector('.mh-ext-duration').textContent, '3:21');
  assert.equal(rows[1].querySelector('.mh-ext-duration').textContent, '');
});

test('Hub tracks lead: hero, original shelves, and the external section is below every original section', async t => {
  const f = homeFixture(t, { tracks: () => [{ id: 'u1', title: 'Track', artist: 'T' }, { id: 'u2', title: 'Second', artist: 'T' }], favorites: async () => [works[1]] });
  f.history.add({ kind: 'work', work: works[0] });
  await f.home.refresh();
  assert.equal(f.document.querySelector('.mh-hero-title').textContent, 'Track');
  assert.equal(f.document.querySelector('.mh-hero-badge').textContent, 'Hub Music');
  const shelves = [...f.document.querySelectorAll('.mh-shelf-original .mh-shelf-title')].map(node => node.textContent);
  assert.deepEqual(shelves, ['新しいオリジナル']);
  const sections = [...f.document.querySelectorAll('.mh > section')].map(node => node.dataset.origin ?? (node.classList.contains('mh-hero') ? 'hero' : '?'));
  assert.deepEqual(sections, ['hero', 'original', 'external']);
  assert.ok(f.document.querySelector('[data-origin="external"]').compareDocumentPosition(f.document.querySelector('[data-origin="original"]')) & 2, 'original precedes external in document order');
  f.document.querySelector('[data-key="track:u1"] .mh-card-play').click();
  assert.deepEqual(f.calls.at(-1), ['track', 'u1']);
  f.document.querySelector('.mh-hero-play').click();
  assert.deepEqual(f.calls.at(-1), ['track', 'u1']);
});

test('external works only fill the gap: twelve originals leave them folded away', async t => {
  const tracks = Array.from({ length: 12 }, (_, index) => ({ id: `u${index}`, title: `T${index}`, artist: 'a' }));
  const f = homeFixture(t, { tracks: () => tracks });
  await f.home.refresh();
  assert.equal(f.document.querySelectorAll('.mh-shelf-original .mh-card').length, 12);
  const folded = f.document.querySelector('.mh-external-folded');
  assert.ok(folded);
  assert.equal(folded.querySelectorAll('.mh-ext-row').length, 2);
  assert.equal(f.document.querySelectorAll('.mh-external > .mh-ext-list').length, 0);
});

test('an external work in favorites does not appear among the originals', async t => {
  const f = homeFixture(t, { favorites: async () => [works[0]], tracks: () => [{ id: 'u1', title: 'Track', artist: 'T' }] });
  await f.home.refresh();
  assert.equal(f.document.querySelectorAll('.mh-shelf-original [data-key="work:sample-mw-1"]').length, 0);
  assert.equal(f.document.querySelectorAll('.mh-external [data-key="work:sample-mw-1"]').length, 1);
});

test('a failed load shows a calm message and a retry in the external section; search goes to the action', async t => {
  let fail = true;
  const f = homeFixture(t, { recommended: async () => { if (fail) throw new Error('down'); return works; } });
  await f.home.refresh();
  assert.match(f.document.querySelector('.mh-external').textContent, /読み込めません/);
  fail = false;
  [...f.document.querySelectorAll('button')].find(button => button.textContent === '再試行').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.document.querySelectorAll('.mh-ext-row').length, 2);
  const input = f.document.querySelector('.mh-search input');
  input.value = ' queen ';
  f.document.querySelector('.mh-search').dispatchEvent(new f.document.defaultView.Event('submit', { cancelable: true }));
  assert.deepEqual(f.calls.at(-1), ['search', 'queen']);
});

test('a YouTube thumbnail shown in a square is the mqdefault (no baked-in letterbox bars)', async t => {
  const hq = { id: 'sample-mw-9', title: 'HQ', artist: 'x', artworkUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', services: [yt('dQw4w9WgXcQ')] };
  const f = homeFixture(t, { recommended: async () => [hq] });
  await f.home.refresh();
  assert.equal(f.document.querySelector('.mh-ext-row img').dataset.src, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
});

function detailFixture(t, work, options = {}) {
  const dom = new JSDOM('<main id="host"><div id="bar" hidden></div></main>', { url: 'http://localhost' });
  const { document } = dom.window;
  const session = createMusicYoutubeSession({ document, bar: document.getElementById('bar'), hubAsset: () => {} });
  const opened = [];
  const header = renderMusicWorkHeader({ document, work, session, hubAsset: () => {}, openExternal: url => opened.push(url), ...options });
  document.getElementById('host').append(header.root);
  t.after(() => { header.destroy(); dom.window.close(); });
  return { document, session, header, opened };
}

test('work detail: YouTube work plays on click only, toggles to stop, and lists other services', t => {
  const work = { id: 'w', title: '大きな題名', artist: '歌手', year: 1987, genre: 'ポップ', services: [yt('dQw4w9WgXcQ'), { provider: 'spotify', url: 'https://open.spotify.com/track/x' }] };
  const f = detailFixture(t, work);
  assert.equal(f.document.querySelector('iframe'), null, 'no autoplay without a click');
  assert.equal(f.document.querySelector('.mw-title').textContent, '大きな題名');
  assert.equal(f.document.querySelector('.mw-credits').textContent, '歌手 · 1987 · ポップ');
  assert.equal(f.header.playButton.disabled, false);
  f.header.playButton.click();
  assert.equal(f.document.querySelectorAll('iframe').length, 1);
  assert.equal(f.header.playButton.getAttribute('aria-pressed'), 'true');
  f.header.playButton.click();
  assert.equal(f.document.querySelector('iframe'), null);
  const link = f.document.querySelector('.mw-link');
  assert.equal(link.textContent, 'Spotifyで開く');
  link.click();
  assert.deepEqual(f.opened, ['https://open.spotify.com/track/x']);
});

test('work detail: no YouTube embed disables play with a reason and never embeds Spotify', t => {
  const work = { id: 'w', title: 'S', artist: 'a', services: [{ provider: 'spotify', url: 'https://open.spotify.com/track/x', embedUrl: 'https://open.spotify.com/embed/track/x' }] };
  const f = detailFixture(t, work);
  assert.equal(f.header.playButton.disabled, true);
  assert.match(f.document.querySelector('.mw-play-note').textContent, /Hub内では再生できません/);
  f.header.playButton.click();
  assert.equal(f.document.querySelector('iframe'), null);
});

test('work detail: autoplay (from a card click) starts once; Hub tracks use the local player', t => {
  const work = { id: 'w', title: 'A', artist: 'a', services: [yt('dQw4w9WgXcQ')] };
  const auto = detailFixture(t, work, { autoplay: true });
  assert.equal(auto.document.querySelectorAll('iframe').length, 1);
  const calls = [];
  const track = detailFixture(t, { id: 'music:x', title: 'T', artist: 'a', services: [] }, { local: { play: () => calls.push('play'), next: () => calls.push('next') } });
  assert.equal(track.header.playButton.disabled, false);
  track.header.playButton.click();
  [...track.document.querySelectorAll('button')].find(button => button.textContent === '次に再生').click();
  assert.deepEqual(calls, ['play', 'next']);
  assert.equal(track.document.querySelector('iframe'), null);
});
