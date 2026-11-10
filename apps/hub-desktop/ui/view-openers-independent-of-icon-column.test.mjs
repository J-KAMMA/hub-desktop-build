import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const rail = html.slice(html.indexOf('<nav class="icon-rail"'), html.indexOf('</nav>', html.indexOf('<nav class="icon-rail"')));
const railViews = new Set([...rail.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1]));
const primary = html.slice(html.indexOf('<nav id="primary-nav"'), html.indexOf('</nav>', html.indexOf('<nav id="primary-nav"')));
const primaryViews = new Set([...primary.matchAll(/data-view="([a-z]+)"/g)].map(m => m[1]));

test('the icon column keeps the agreed order: communities live in the sidebar, market/browser/AI sit low above 投稿', () => {
  const order = [...rail.matchAll(/(?:data-view="([a-z]+)"|id="(desktop-apps)")/g)].map(m => m[1] || m[2]);
  assert.deepEqual(order, ['feed', 'notifications', 'messages', 'videos', 'music', 'articles', 'desktop-apps', 'market', 'browser', 'ai', 'profile', 'settings']);
});

test('every opener that clicks an icon-column button also falls back to the hidden primary nav', () => {
  // 左の列から外した画面は、`.icon-rail [data-view=…]` だけを探す開き口では黙って何も起きなくなる。
  // 列に無い画面を指す開き口は、必ず #primary-nav も探すこと。
  const offenders = [];
  const clickers = [/querySelector\('([^'\n]*)'\)\?\.click\(\)/g, /querySelector\(`([^`]*)`\)\?\.click\(\)/g];
  for (const m of clickers.flatMap(re => [...app.matchAll(re)])) {
    const selector = m[1];
    if (!selector.includes('.icon-rail')) continue;
    if (selector.includes('#primary-nav')) continue;
    const literal = /data-view="([a-z]+)"/.exec(selector)?.[1];
    if (literal && !railViews.has(literal)) offenders.push(selector);
    if (selector.includes('${') && /\[data-view=/.test(selector)) offenders.push(selector);
  }
  assert.deepEqual(offenders, []);
});

test('browser, AI, games and research stay reachable without a column button', () => {
  for (const view of ['browser', 'ai', 'games', 'research']) {
    assert.ok(primaryViews.has(view), `${view} must stay in #primary-nav as the opener of last resort`);
  }
  // 選択中の印は、列にボタンが無い画面でも計算できる（browser/ai を含む）。
  assert.ok(app.includes('? contextView : ({ discovery: "home"'));
});

test('the quick switcher and right rail open browser and AI by view name, not by a column button', () => {
  assert.match(app, /\["ブラウザ", "browser"\]/);
  assert.match(app, /\["AI", "ai"\]/);
  assert.match(app, /openCenterView: \(view, title\) => void navigateFrom\(\{ dataset: \{ view, title \}/);
  assert.match(app, /if \(view === "browser"\) \{ await enterBrowser\(undefined, history\); return; \}/);
});
