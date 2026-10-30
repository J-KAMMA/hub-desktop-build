import assert from 'node:assert/strict';
import test from 'node:test';
import { isNativeVideo, NATIVE_VIDEO_LABEL, providerLabel, videoStudioUrl, watchOpenLabel } from './native-video.mjs';
import { createWatchStage } from './video-home.mjs';
import { SIDEBAR_ICON_NAMES } from './sidebar-media.mjs';

test('自作動画だけが「Hub動画」と「Hubで再生」になる', () => {
  assert.equal(isNativeVideo({ provider: 'hub' }), true);
  assert.equal(isNativeVideo({ provider: 'youtube' }), false);
  assert.equal(isNativeVideo(null), false);
  assert.equal(providerLabel('hub'), NATIVE_VIDEO_LABEL);
  assert.equal(providerLabel('youtube'), 'youtube');
  assert.equal(watchOpenLabel({ provider: 'hub' }), 'Hubで再生');
  assert.equal(watchOpenLabel({ provider: 'vimeo' }), '提供元で開く');
});

test('スタジオの行き先は Hub 自身の origin だけ', () => {
  assert.equal(videoStudioUrl('https://hub.jkamma.com'), 'https://hub.jkamma.com/v2/studio/videos');
  assert.equal(videoStudioUrl('http://localhost:3020'), 'http://localhost:3020/v2/studio/videos');
  for (const bad of ['https://evil.example', 'https://user:pw@hub.jkamma.com', 'http://hub.jkamma.com', 'not a url', null, undefined, 3]) {
    assert.equal(videoStudioUrl(bad), null, String(bad));
  }
});

test('「自分の動画」の記号が描ける', () => {
  assert.ok(SIDEBAR_ICON_NAMES.includes('upload'));
});

// 最小の DOM。createWatchStage が使う分だけ。
function fakeDocument() {
  const make = (tag) => {
    const node = {
      tagName: tag, className: '', textContent: '', children: [], hidden: false, dataset: {}, style: { setProperty() {} },
      classList: { add() {}, remove() {} },
      append(...items) { this.children.push(...items); },
      prepend(...items) { this.children.unshift(...items); },
      replaceChildren(...items) { this.children = items; },
      setAttribute() {}, querySelector() { return null; },
    };
    return node;
  };
  return { createElement: make, createElementNS: (_ns, tag) => make(tag) };
}
const labels = (node) => [node.textContent, ...node.children.flatMap(labels)].filter(Boolean);

test('自作動画の視聴画面は「Hubで再生」で Hub のページを開き、YouTube の枠を作らない', () => {
  const opened = [];
  const document = fakeDocument();
  const video = { id: 'h1', provider: 'hub', title: '自作', channel: 'あなた', sourceUrl: 'https://hub.jkamma.com/v2/videos/h1', duration: '1:15' };
  const stage = createWatchStage(document, video, { hubAsset: null, onOpenExternal: (url) => opened.push(url) });
  const text = labels(stage.element);
  assert.ok(text.includes('Hubで再生'), text.join('|'));
  assert.ok(!text.includes('提供元で開く'));
  const button = (function find(node) { return node.tagName === 'button' ? node : node.children.map(find).find(Boolean); })(stage.element);
  button.onclick();
  assert.deepEqual(opened, ['https://hub.jkamma.com/v2/videos/h1']);
});
