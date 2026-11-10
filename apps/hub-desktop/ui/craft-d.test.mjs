import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const market = readFileSync(new URL('./market-browse.mjs', import.meta.url), 'utf8');
const profile = readFileSync(new URL('./profile-view.mjs', import.meta.url), 'utf8');

test('raw String(error) never reaches the screen', () => {
  assert.equal(/\$\{String\(error\)\}/.test(app), false);
  assert.match(app, /読み込めませんでした。時間をおいて再試行してください。/);
  // friendlyError uses the message of an Error (no "Error: " prefix) and hides internal JS errors
  assert.ok(app.includes('if (error instanceof Error) return /^(Type|Reference|Range|Syntax)Error$/.test(error.name)'));
});

test('post detail survives missing data', () => {
  assert.match(app, /if \(!data\?\.post\) \{ target\.replaceChildren\(pageErrorState\("投稿を開けませんでした"/);
});

test('one failure shape for catalog and video', () => {
  assert.match(app, /\} else if \(emptyError\) \{\s*target\.replaceChildren\(pageErrorState\(/);
  assert.match(app, /target\.replaceChildren\(pageErrorState\("読み込めませんでした", friendlyError\(state\.error\), \(\) => void videoSearch\.retry\(\)\)\)/);
});

test('in-pane duplicates of sidebar choices are gone', () => {
  assert.equal(html.includes('notif-tabs'), false);
  assert.equal(html.includes('feed-sources-toggle'), false);
  assert.match(profile, /tablist\.hidden = true/);
  assert.equal(/CATEGORIES\) \{\s*const chip = iconChip/.test(market), false);
  assert.equal(market.includes('販売者が出品すると'), false);
});

test('feed sources toggle lives in the sidebar feed row', () => {
  assert.match(app, /label: "表示元と接続先", icon: "more"/);
  assert.match(app, /function toggleFeedSources\(\)/);
});

test('all-features list: icons, single line, single current', () => {
  assert.match(app, /\["Hubpedia", "hubpedia"\]/);
  assert.match(app, /glyph\.classList\.add\("sidebar-icon"\)/);
  assert.ok(app.includes('const selected = !appsOpen && item.dataset.view === main;'));
});

test('DM image control is an icon button with a label', () => {
  assert.match(app, /add\.setAttribute\("aria-label", "画像を追加"\)/);
  assert.equal(app.includes('add.textContent = "画像"'), false);
});
