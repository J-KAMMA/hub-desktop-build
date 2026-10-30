import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { youtubeVideoId, youtubeEmbedUrl, createYouTubePlayer, youtubeThumbnailUrl } from './youtube-embed.mjs';

test('reads the video ID only from YouTube URLs', () => {
  for (const url of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtu.be/jNQXAC9IVRw', 'https://music.youtube.com/watch?v=jNQXAC9IVRw&list=x', 'https://www.youtube.com/embed/jNQXAC9IVRw', 'https://www.youtube.com/shorts/jNQXAC9IVRw', 'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw?rel=0'])
    assert.equal(youtubeVideoId(url), 'jNQXAC9IVRw', url);
  for (const url of ['https://evil.example/watch?v=jNQXAC9IVRw', 'https://www.youtube.com.evil.example/watch?v=jNQXAC9IVRw', 'javascript:alert(1)', 'https://www.youtube.com/watch?v=short', 'https://u:p@www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=jNQXAC9IVR%22', 42, null])
    assert.equal(youtubeVideoId(url), null, String(url));
});

test('embed URL is always youtube-nocookie and only for valid IDs', () => {
  assert.equal(youtubeEmbedUrl('jNQXAC9IVRw'), 'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw?rel=0&modestbranding=1&playsinline=1&enablejsapi=1');
  assert.match(youtubeEmbedUrl('jNQXAC9IVRw', { autoplay: true, start: 12 }), /autoplay=1&start=12$/);
  assert.equal(youtubeEmbedUrl('../../x'), null);
  assert.equal(youtubeThumbnailUrl('jNQXAC9IVRw'), 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg');
  assert.equal(youtubeThumbnailUrl('jNQXAC9IVRw', 'x'), null);
});

test('player is a sandboxed iframe that cannot navigate the Hub window', () => {
  const document = new JSDOM('').window.document;
  const player = createYouTubePlayer(document, { id: 'jNQXAC9IVRw', title: '動物園' });
  const iframe = player.querySelector('iframe');
  assert.equal(player.className, 'yt-player');
  assert.equal(new URL(iframe.src).hostname, 'www.youtube-nocookie.com');
  assert.equal(iframe.title, '動物園');
  const sandbox = iframe.getAttribute('sandbox').split(' ');
  assert.ok(sandbox.includes('allow-scripts'));
  assert.ok(!sandbox.includes('allow-top-navigation') && !sandbox.includes('allow-forms'));
  assert.equal(createYouTubePlayer(document, { id: 'bad' }), null);
});
