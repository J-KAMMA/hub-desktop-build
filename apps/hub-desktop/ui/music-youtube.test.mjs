import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { youtubeSource, openLinks, workArtworkUrl, createMusicYoutubeSession } from './music-youtube.mjs';

const work = {
  id: 'w1', title: '曲', artist: '歌手',
  services: [
    { provider: 'spotify', label: 'Spotify', url: 'https://open.spotify.com/track/abc' },
    { provider: 'youtube', label: 'YouTube', url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ', embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' },
    { provider: 'apple', label: 'Apple Music', url: 'javascript:alert(1)' },
    { provider: 'amazon', label: 'Amazon Music', url: 'https://music.amazon.co.jp/search/x' },
  ],
};

function fixture(t) {
  const dom = new JSDOM('<main><div id="panel" hidden></div><div id="bar" hidden></div></main>', { url: 'http://localhost' });
  const { document } = dom.window;
  const played = [];
  const session = createMusicYoutubeSession({ document, bar: document.getElementById('bar'), hubAsset: (img, url) => { img.dataset.src = url; }, onPlayed: item => played.push(item.id) });
  t.after(() => dom.window.close());
  return { document, session, panel: document.getElementById('panel'), bar: document.getElementById('bar'), played };
}

test('youtubeSource finds the embeddable YouTube service and ignores the rest', () => {
  assert.equal(youtubeSource(work).id, 'dQw4w9WgXcQ');
  assert.equal(youtubeSource({ services: [{ provider: 'spotify', url: 'https://open.spotify.com/track/abc' }] }), null);
  assert.equal(youtubeSource({ services: [{ provider: 'youtube', url: 'https://www.youtube.com/watch?v=bad' }] }), null);
  assert.equal(youtubeSource({}), null);
});

test('openLinks lists other services as "〇〇で開く", skipping the played one and unsafe URLs', () => {
  assert.deepEqual(openLinks(work).map(link => link.label), ['Spotifyで開く', 'Amazon Musicで開く']);
  assert.ok(openLinks(work).every(link => link.url.startsWith('https://')));
  assert.deepEqual(openLinks({ services: [{ provider: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] }, null).map(link => link.label), ['YouTubeで開く']);
});

test('artwork falls back to the YouTube thumbnail', () => {
  assert.equal(workArtworkUrl({ artworkUrl: '/a.png', services: [] }), '/a.png');
  assert.equal(workArtworkUrl(work), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
  assert.equal(workArtworkUrl({ services: [] }), null);
});

test('play mounts a sandboxed youtube-nocookie iframe and shows the now-playing bar', t => {
  const f = fixture(t);
  assert.equal(f.session.play({ work, panel: f.panel }), true);
  const iframe = f.panel.querySelector('iframe');
  assert.match(iframe.src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.ok(iframe.getAttribute('sandbox').includes('allow-scripts'));
  assert.equal(f.panel.hidden, false);
  assert.equal(f.bar.hidden, false);
  assert.match(f.bar.textContent, /曲/);
  assert.match(f.bar.textContent, /歌手/);
  assert.ok(f.session.isPlaying('w1'));
  assert.deepEqual(f.played, ['w1']);
});

test('play refuses works without a YouTube embed and does nothing', t => {
  const f = fixture(t);
  assert.equal(f.session.play({ work: { id: 'x', services: [{ provider: 'spotify', url: 'https://open.spotify.com/x' }] }, panel: f.panel }), false);
  assert.equal(f.panel.querySelector('iframe'), null);
  assert.equal(f.bar.hidden, true);
});

test('the close button removes the iframe and hides the bar', t => {
  const f = fixture(t);
  f.session.play({ work, panel: f.panel });
  f.bar.querySelector('button').click();
  assert.equal(f.panel.querySelector('iframe'), null);
  assert.equal(f.panel.hidden, true);
  assert.equal(f.bar.hidden, true);
  assert.equal(f.bar.children.length, 0);
  assert.equal(f.session.active(), null);
});

test('leaving the music context or losing the panel stops playback', t => {
  const f = fixture(t);
  f.session.play({ work, panel: f.panel });
  f.session.sync(true);
  assert.ok(f.session.isPlaying('w1'));
  f.session.sync(false);
  assert.equal(f.document.querySelector('iframe'), null);
  f.session.play({ work, panel: f.panel });
  f.panel.remove();
  f.session.sync(true);
  assert.equal(f.session.active(), null);
  assert.equal(f.bar.hidden, true);
});

test('playing another work replaces the iframe; subscribers are told', t => {
  const f = fixture(t);
  const seen = [];
  f.session.subscribe(id => seen.push(id));
  f.session.play({ work, panel: f.panel });
  f.session.play({ work: { ...work, id: 'w2' }, panel: f.panel });
  assert.equal(f.document.querySelectorAll('iframe').length, 1);
  f.session.stop();
  assert.deepEqual(seen, ['w1', null, 'w2', null]);
});

test('autoplay requests are single-use and per work', t => {
  const f = fixture(t);
  f.session.requestAutoplay('w1');
  assert.equal(f.session.consumeAutoplay('w2'), false);
  f.session.requestAutoplay('w1');
  assert.equal(f.session.consumeAutoplay('w1'), true);
  assert.equal(f.session.consumeAutoplay('w1'), false);
});
