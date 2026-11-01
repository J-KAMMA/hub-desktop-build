import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createMediaSearch} from './media-search.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const document = new JSDOM(html).window.document;

// 余分な閉じタグが1つあると、その後ろの要素が #hub-shell の外へ押し出され、
// 右列が画面の下に落ちて見えなくなる（2026-10-14、設定画面の </div> が1つ多かった）。
test('the right rail, players and resizer stay inside the shell grid', () => {
  const shell = document.querySelector('#hub-shell');
  assert.ok(shell, '#hub-shell exists');
  for (const selector of ['aside.rail', '#rail-resizer', '#music-player', '#music-yt-bar']) {
    const element = document.querySelector(selector);
    assert.ok(element, `${selector} exists`);
    assert.ok(shell.contains(element), `${selector} is inside #hub-shell`);
  }
});

test('settings device panel keeps its cache and P2P hosts', () => {
  const device = document.querySelector('[data-settings-panel="device"]');
  for (const id of ['settings-cache', 'settings-media-p2p']) {
    assert.ok(device.contains(document.getElementById(id)), `#${id} is inside the device panel`);
  }
});

test('every view panel stays inside the main workspace', () => {
  const main = document.querySelector('#hub-shell main');
  assert.ok(main, 'main inside #hub-shell');
  const views = [...document.querySelectorAll('section.view[data-view-panel]')];
  assert.ok(views.length > 10);
  for (const view of views) assert.ok(main.contains(view), `${view.id} is inside main`);
});

test('the articles screen uses the shared page header and grid layout', () => {
  const view = document.getElementById('view-articles');
  assert.ok(view.classList.contains('layout-grid'));
  const header = view.querySelector('.page-header');
  assert.ok(header);
  assert.equal(header.querySelector('.page-title').textContent, '記事');
  assert.ok(header.querySelector('.page-actions'));
  assert.ok(header.querySelector('#articles-create-toggle').classList.contains('btn-primary'));
});

test('the videos screen uses the shared page header and grid layout', () => {
  const view = document.getElementById('view-videos');
  assert.ok(view.classList.contains('layout-grid'));
  const header = view.querySelector('.page-header');
  assert.ok(header);
  assert.equal(header.querySelector('.page-title').textContent, '動画');
  assert.ok(header.querySelector('.page-actions'));
  assert.ok(header.querySelector('#video-refresh').classList.contains('btn-ghost'));
});

test('the music screen uses the shared page header and grid layout', () => {
  const view = document.getElementById('view-music');
  assert.ok(view.classList.contains('layout-grid'));
  const header = view.querySelector('.page-header');
  assert.ok(header);
  assert.equal(header.querySelector('.page-title').textContent, '音楽');
  assert.ok(header.querySelector('.page-actions'));
  assert.ok(header.querySelector('#music-refresh').classList.contains('btn-ghost'));
});

test('the market screen uses the shared page header, grid and state panel', () => {
  const view = document.getElementById('view-market');
  const header = view.querySelector('.page-header');
  assert.ok(header);
  assert.equal(header.querySelector('.page-title').textContent, 'マーケット');
  assert.ok(header.querySelector('.page-actions #market-cart-open'));
  assert.ok(view.querySelector('#shop-results.layout-grid'));
});

// 実物の renderShopResults と statePanel を動かし、空・失敗が共通の .state-panel で出ること、
// 失敗時は主ボタン (.btn.btn-primary) の再試行が loadShop を呼ぶことを確かめる。
test('market results render the shared state panel and a secondary retry on failure', () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const slice = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `${start} is present`);
    return source.slice(from, to);
  };
  const dom = new JSDOM('<main><div id="shop-filter"></div><span id="shop-count"></span><p id="shop-state"></p><div id="shop-results"></div></main>');
  const {document: doc} = dom.window;
  const shop = {visible: [], otherProducts: [], sellerFilter: null, query: '', busy: false, localFailed: true, loadError: ''};
  let loads = 0;
  const build = new Function('document', 'icon', 'shop', 'loadShop', 'searchShop',
    `${slice('function statePanel(', '\nfunction ')}
     ${slice('function renderShopCount(', '\nfunction renderShopResults')}
     ${slice('function renderShopResults(', '  // 札は絵')}
     }
     return renderShopResults;`);
  const renderShopResults = build(doc, () => '<svg></svg>', shop, () => { loads++; }, () => {});
  renderShopResults();
  const target = doc.getElementById('shop-results');
  const panel = target.querySelector('.state-panel');
  assert.ok(panel, 'the failed catalog uses .state-panel');
  const retry = panel.querySelector('button.btn.btn-secondary');
  assert.ok(retry, 'the failure has a secondary retry');
  retry.click();
  assert.equal(loads, 1);
  shop.localFailed = false;
  shop.query = '本';
  renderShopResults();
  const empty = target.querySelector('.state-panel');
  assert.ok(empty, 'an empty search uses .state-panel');
  assert.match(empty.textContent, /「本」は見つかりません/);
  assert.equal(empty.querySelector('button'), null);
  dom.window.close();
});

test('the research screen uses the shared page header, list and state panel', () => {
  const view = document.getElementById('view-research');
  const header = view.querySelector('.page-header');
  assert.ok(header);
  assert.equal(header.querySelector('.page-title').textContent, 'プロジェクトと研究');
  assert.ok(header.querySelector('#research-create-web').classList.contains('btn-primary'));
  assert.ok(header.querySelector('#research-refresh').classList.contains('btn-ghost'));
  assert.ok(view.querySelector('#research-results.layout-list'));
  const source = readFileSync(new URL('./research.mjs', import.meta.url), 'utf8');
  assert.match(source, /function emptyPanel\([^)]*\)[\s\S]*?state-panel/);
  assert.match(source, /target\.append\(emptyPanel\(document,/);
});

test('the notifications screen uses the shared page header and list layout', () => {
  const view = document.getElementById('view-notifications');
  assert.ok(view.classList.contains('layout-list'));
  const header = view.querySelector('.page-header');
  assert.ok(header);
  assert.equal(header.querySelector('.page-title').textContent, '通知');
  assert.ok(header.querySelector('.page-actions'));
  assert.ok(header.querySelector('#notifications-refresh').classList.contains('btn-ghost'));
});

test('the messages screen uses the shared page header', () => {
  const view = document.getElementById('view-messages');
  const header = view.querySelector('.page-header');
  assert.ok(header);
  assert.equal(header.querySelector('.page-title').textContent, 'メッセージ');
  assert.ok(header.querySelector('.page-actions'));
  assert.ok(header.querySelector('#messages-refresh').classList.contains('btn-ghost'));
});

// 外部作品の一覧は readingDirectory の外にあるため、0件の失敗でも共通の
// .state-panel と二番手の再試行が出ることを実際の catalogSearch で確かめる。
test('a failed music catalog load shows the state panel and a retry', async () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const slice = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `${start} is present`);
    return source.slice(from, to);
  };
  const dom = new JSDOM('<main><div><div id="music-results"></div></div><p id="music-state"></p></main>');
  const {document} = dom.window;
  let fail = true;
  const catalogSearch = new Function(
    'document', 'icon', 'createMediaSearch', 'invoke', 'CATALOGS', 'readingDirectory',
    'friendlyError', 'skeletonResult', 'renderReadingCatalog', 'renderSidebarContext', 'currentView', 'catalogSearches',
    `${slice('function emptyState(', '\nfunction webDiscoveryAction')}
     ${slice('function retryButton(', '\nfunction showClientError')}
     ${slice('function catalogSearch(', '\nasync function loadCatalog')}
     return catalogSearch;`,
  )(
    document,
    () => '<svg></svg>',
    createMediaSearch,
    async () => {
      if (fail) throw new Error('offline');
      return {works: [], total: 0, hasMore: false};
    },
    {music: {resource: 'music', items: data => data?.works, empty: '外部作品はまだありません', card: () => document.createElement('article')}},
    new Map(),
    error => error.message,
    () => document.createElement('span'),
    () => {},
    () => {},
    'music',
    new Map(),
  );
  const controller = catalogSearch('music');
  await controller.search('', {}, true);
  const target = document.getElementById('music-results');
  const panel = target.querySelector('.state-panel');
  assert.ok(panel, 'the failed music catalog uses .state-panel');
  assert.match(panel.textContent, /読み込めませんでした/);
  const retry = panel.querySelector('.state-action');
  assert.ok(retry, 'the state panel has a retry');
  assert.ok(retry.classList.contains('btn-primary'));
  assert.equal(document.querySelector('#music-state button'), null, 'the retry is not duplicated in the status line');
  fail = false;
  await controller.retry();
  assert.match(target.querySelector('.state-panel')?.textContent ?? '', /外部作品はまだありません/);
  dom.window.close();
});

// 左ナビは幅で自動に 275 / 88 に変わる（2026-11-01、DESIGN-SYSTEM §1）。メニューの開閉ボタンは廃止した。戻る → 進む が上の帯の先頭。
test('the toolbar starts with back and forward; the rail-expand button is gone and the first destination is search', () => {
  const toolbar = document.querySelector('.app-toolbar');
  const first = toolbar.querySelector('button, input, a[href]');
  assert.equal(first.id, 'toolbar-back');
  assert.ok(first.closest('.toolbar-navigation'));
  assert.equal(document.querySelectorAll('#rail-expand-toggle').length, 0);
  const order = [...toolbar.querySelectorAll('.toolbar-navigation > button')].map((button) => button.id);
  assert.deepEqual(order.slice(0, 2), ['toolbar-back', 'toolbar-forward']);
  const destinations = [...document.querySelectorAll('.icon-rail .icon-nav-item')].map((item) => item.dataset.view);
  assert.deepEqual(destinations.slice(0, 5), ['search', 'feed', 'notifications', 'messages', 'community']);
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /rail-expand-toggle|rail-expanded/);
});

test('the nav is 275 at 1280 and above and an 88 icon rail below; one grid definition owns the shell', () => {
  const frame = readFileSync(new URL('./desktop-frame.css', import.meta.url), 'utf8');
  assert.ok(frame.includes('--nav-w: var(--ds-nav-w-rail);'));
  assert.ok(frame.includes('@media (min-width: 1280px) {\n  #hub-shell.app-shell:not([data-template="browser"]) { --nav-w: var(--ds-nav-w); }'.replaceAll('\n', frame.includes('\r\n') ? '\r\n' : '\n')));
  assert.ok(frame.includes('grid-template-columns: var(--nav-w) var(--spacer) var(--ctx-col) minmax(0, var(--main-w)) var(--spacer) var(--rail-col);'));
  const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
  assert.match(tokens, /--ds-nav-w: 275px;/);
  assert.match(tokens, /--ds-nav-w-rail: 88px;/);
  // どの CSS も .app-shell と、その子（左ナビ・内側の列・本文・右の列・つまみ）の格子の位置を決めない。決めるのは desktop-frame.css だけ。
  const shellSubject = /^(?:\.app-shell|\.sidebar|\.workspace-main|\.icon-rail|\.rail|#sidebar-resizer|#rail-resizer|\.app-toolbar)(?:[:.#\[].*)?$/;
  for (const file of readdirSync(new URL('./', import.meta.url)).filter((name) => name.endsWith('.css') && name !== 'desktop-frame.css')) {
    const css = readFileSync(new URL('./' + file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selector, body] of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      if (!/grid-template-(columns|rows)|grid-column|grid-row|grid-area/.test(body)) continue;
      for (const part of selector.split(',')) {
        const last = part.trim().split(/[\s>+~]+/).pop();
        assert.doesNotMatch(last, shellSubject, `${file}: ${selector.trim().slice(0, 100)} places a shell column outside desktop-frame.css`);
      }
    }
  }
});
