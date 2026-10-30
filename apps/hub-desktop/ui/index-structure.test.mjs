import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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

// メニュー（左列の開閉）は上の帯の一番左で左列の真上。幅は --rail-w に従う（2026-10-15、所有者指定）。メニュー → 戻る → 進む の順。
test('the menu button is the first interactive control of the toolbar and is not in the rail', () => {
  const toolbar = document.querySelector('.app-toolbar');
  const first = toolbar.querySelector('button, input, a[href]');
  assert.equal(first.id, 'rail-expand-toggle');
  assert.ok(first.closest('.toolbar-navigation'));
  assert.equal(document.querySelectorAll('#rail-expand-toggle').length, 1);
  assert.equal(document.querySelector('.icon-rail #rail-expand-toggle'), null);
  assert.ok(first.title && first.getAttribute('aria-label'));
  const order = [...toolbar.querySelectorAll('.toolbar-navigation > button')].map((button) => button.id);
  assert.deepEqual(order.slice(0, 3), ['rail-expand-toggle', 'toolbar-back', 'toolbar-forward']);
  assert.equal(document.querySelector('.icon-rail .icon-nav-item').dataset.view, 'feed');
});

test('the menu cell follows the rail width so it sits above the rail icons', () => {
  const css = readFileSync(new URL('./desktop-shell.css', import.meta.url), 'utf8');
  const rule = css.match(/#hub-shell \.app-toolbar #rail-expand-toggle \{([^}]*)\}/)[1];
  assert.match(rule, /width:\s*var\(--rail-w\)/);
  assert.match(rule, /padding:\s*0 0 0 18px/);
  assert.match(css, /#hub-shell \.app-toolbar \{[^}]*padding:\s*0;/);
  assert.match(css, /#hub-shell\.rail-expanded \{ --rail-w: 208px; \}/);
});

test('the menu button toggles the rail width class and its state', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const start = app.indexOf('toggle = document.querySelector("#rail-expand-toggle");');
  assert.ok(start > 0);
  const open = app.lastIndexOf('\n{\n', start) + 1;
  const end = app.indexOf('\n}\n', start);
  const block = app.slice(open, end + 2);
  const dom = new JSDOM(html, {runScripts: 'outside-only', url: 'http://localhost/'});
  dom.window.eval(block);
  const shell = dom.window.document.querySelector('.app-shell');
  const button = dom.window.document.querySelector('#rail-expand-toggle');
  assert.equal(shell.classList.contains('rail-expanded'), false);
  button.click();
  assert.equal(shell.classList.contains('rail-expanded'), true);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  button.click();
  assert.equal(shell.classList.contains('rail-expanded'), false);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});
