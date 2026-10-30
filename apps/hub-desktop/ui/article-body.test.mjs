import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {articleBlocks, articleHeadingList, parseArticleInline, renderArticleBodyNodes, safeArticleImageSource} from './article-body.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const fixtures = JSON.parse(readFileSync(new URL('../../hub/lib/article-body-fixtures.json', import.meta.url), 'utf8'));

for (const fixture of fixtures) {
  test(`共通の例題（webと同じ表）: ${fixture.name}`, () => {
    assert.deepEqual(articleBlocks(fixture.input), fixture.expected);
  });
}

const dom = new JSDOM('<div id="root"></div>');
const {document} = dom.window;
function render(body, hooks = {}) {
  const root = document.createElement('div');
  root.append(...renderArticleBodyNodes(document, body, hooks));
  return root;
}

test('見出し一覧はブロックの id と一致する', () => {
  const body = '## 一\n本文\n### 二\n## 一';
  assert.deepEqual(articleHeadingList(body).map((h) => h.id), ['h-一', 'h-二', 'h-一-2']);
});

test('未閉鎖の記号は文字のまま', () => {
  assert.deepEqual(parseArticleInline('**a と *b と `c'), [{t: 'text', v: '**a と *b と `c'}]);
});

test('危険なリンク・画像は成立しない', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd', '//evil.example/x', 'https://u:p@evil.example/']) {
    assert.equal(parseArticleInline(`[x](${url})`).some((n) => n.t === 'link'), false, url);
  }
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', 'http://example.com/a.png', '/api/media/images/../../x', '/other.png', '//evil.example/a.png']) {
    assert.equal(articleBlocks(`![x](${url})`).some((b) => b.kind === 'image'), false, url);
  }
  assert.equal(safeArticleImageSource('/api/media/images/abc'), '/api/media/images/abc');
  assert.equal(safeArticleImageSource('/api/articles/images/img_12345678'), '/api/articles/images/img_12345678');
  assert.equal(safeArticleImageSource('/api/articles/images/../x'), null);
  assert.equal(safeArticleImageSource('/api/articles/other/abc'), null);
});

test('YouTube以外・偽ホスト・崩れたIDは埋め込まない', () => {
  for (const url of ['https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://evil.example/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short', 'https://vimeo.com/1']) {
    assert.equal(articleBlocks(url).some((b) => b.kind === 'embed'), false, url);
  }
});

test('描画: タグ・属性は注入されず、全部textContentになる', () => {
  const root = render([
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '## <b>見出し</b>',
    '[x](javascript:alert(1))', '![x](data:text/html,hi)', '```\n<script>alert(2)</script>\n```',
    '> <iframe src=//evil.example></iframe>', '- <svg onload=alert(3)>',
  ].join('\n\n'));
  assert.equal(root.querySelector('script, img, iframe, svg, b, a'), null);
  assert.ok(root.textContent.includes('<script>alert(1)</script>'));
  assert.ok(root.textContent.includes('<svg onload=alert(3)>'));
});

test('描画: リンクは href 属性を持たずクリックで開く。外部HTTPSの画像は読み込まずリンクに落とす', () => {
  const opened = [], assets = [];
  const root = render('[a](https://example.com/a) と [内](/v2/articles/x)\n\n![猫](https://example.com/c.png)\n\n![自](/api/media/images/abc)', {
    openLink: (href, external) => opened.push([href, external]),
    hubAsset: (img, src) => assets.push([img.alt, src]),
  });
  assert.equal(root.querySelector('a'), null);
  assert.equal(root.querySelectorAll('img').length, 1);
  assert.deepEqual(assets, [['自', '/api/media/images/abc']]);
  assert.equal(root.querySelector('img').loading, 'lazy');
  const buttons = [...root.querySelectorAll('button.detail-link')];
  assert.equal(buttons.length, 3);
  buttons.forEach((b) => b.onclick());
  assert.deepEqual(opened, [['https://example.com/a', true], ['/v2/articles/x', false], ['https://example.com/c.png', true]]);
});

test('描画: YouTubeは既存の nocookie プレーヤー部品だけ', () => {
  const calls = [];
  const root = render('https://youtu.be/dQw4w9WgXcQ', {
    createYouTubePlayer: (doc, options) => { calls.push(options); const d = doc.createElement('div'); d.className = 'yt-player'; return d; },
  });
  assert.deepEqual(calls, [{id: 'dQw4w9WgXcQ', title: 'YouTube動画'}]);
  assert.equal(root.querySelectorAll('.yt-player').length, 1);
});

test('描画: 見出しに id、順序付きリスト、コードブロック、区切り線', () => {
  const root = render('## はじめに\n\n1. 一\n2. 二\n\n---\n\n```js\nlet a;\n```');
  assert.equal(root.querySelector('h3').id, 'h-はじめに');
  assert.equal(root.querySelectorAll('ol > li').length, 2);
  assert.equal(root.querySelector('pre > code').textContent, 'let a;');
  assert.ok(root.querySelector('hr'));
});
