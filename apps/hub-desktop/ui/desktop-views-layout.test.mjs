import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fixture, settle} from './sidebar-context.fixture.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const profileCss = readFileSync(new URL('./profile-view.css', import.meta.url), 'utf8');
const settingsCss = readFileSync(new URL('./settings-view.css', import.meta.url), 'utf8');
const commerceCss = readFileSync(new URL('./desktop-commerce.css', import.meta.url), 'utf8');
const aiCss = readFileSync(new URL('./ai-composer.css', import.meta.url), 'utf8');
const document = new JSDOM(html).window.document;

test('profile uses the shared page header and list width, and its sections are rows in the left column', () => {
  const view = document.getElementById('view-profile');
  const header = view.querySelector(':scope > .page-header');
  assert.ok(header, 'profile has a direct page header');
  assert.equal(header.querySelector('.page-title').textContent, 'プロフィール');
  const list = view.querySelector(':scope > .layout-list');
  assert.ok(list, 'profile content sits in .layout-list');
  for (const id of ['profile-avatar', 'profile-state', 'profile-posts']) assert.ok(list.contains(document.getElementById(id)), id);
  assert.match(app, /statePanel\("alert", "読み込めませんでした", friendlyError\(error\), loadProfile\)/);
  assert.match(profileCss, /#view-profile \.profile-tabs\s*\{\s*display:\s*none/);
});

test('profile sections become real sidebar rows and follow the selected tab', async () => {
  const f = fixture();
  f.show('profile');
  await settle();
  f.show('profile');
  const labels = [...f.document.querySelectorAll('#sidebar-context .sidebar-item-label')].map((node) => node.textContent);
  assert.deepEqual(labels, ['投稿', 'メディア', 'スレッド']);
  const rows = f.items();
  assert.equal(rows[0].getAttribute('aria-current'), 'true', 'the first section starts selected');
  rows[1].click();
  const after = f.items();
  assert.equal(after[1].getAttribute('aria-current'), 'true', 'the pressed section becomes selected');
  assert.equal(after[0].hasAttribute('aria-current'), false);
  f.dom.window.close();
});

test('settings uses a left-aligned reading column with secondary card actions and a wrapping status pill', () => {
  const view = document.getElementById('view-settings');
  const header = view.querySelector(':scope > .page-header');
  assert.ok(header, 'settings has a direct page header');
  assert.equal(header.querySelector('.page-title').textContent, '設定');
  const layout = view.querySelector(':scope > .inner-layout');
  assert.ok(layout.classList.contains('layout-reading'));
  assert.match(settingsCss, /#view-settings \.inner-layout\.layout-reading\s*\{[^}]*max-width:\s*720px/);
  assert.match(settingsCss, /#view-settings \.inner-layout\.layout-reading\s*\{[^}]*padding:\s*var\(--space-5\)/);
  const login = view.querySelector('[data-account="login"]');
  assert.ok(login.classList.contains('btn') && login.classList.contains('btn-secondary'));
  const logout = view.querySelector('[data-account="logout"]');
  assert.ok(logout.classList.contains('btn-ghost'));
  assert.ok(logout.classList.contains('deny'), 'the existing danger class stays for the danger text');
  assert.match(settingsCss, /\.setting-header \.setting-label\s*\{[^}]*font-size:\s*var\(--type-headline\)/);
  assert.match(settingsCss, /\.setting-desc\s*\{[^}]*color:\s*var\(--muted\)/);
  assert.match(commerceCss, /#view-settings \.state-pill\s*\{[^}]*white-space:\s*normal/);
  assert.match(commerceCss, /#view-settings \.state-pill\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('AI new-work screen starts with a title3 heading and keeps the composer above a reading-width recent list', () => {
  assert.match(app, /recent\.className = "piw-empty-recent layout-reading"/);
  assert.match(app, /heading\.textContent = "AIに何を依頼しますか？"/);
  const heading = aiCss.match(/#view-ai \.piw-shell\.is-new \.piw-empty strong \{([^}]*)\}/);
  assert.ok(heading, 'the new-work heading rule exists');
  assert.match(heading[1], /font-size:\s*var\(--type-title3\)/);
  assert.doesNotMatch(heading[1], /--type-title2/);
  assert.match(heading[1], /margin:\s*clamp\(/);
  const recent = aiCss.match(/#view-ai \.piw-shell\.is-new \.piw-empty-recent \{([^}]*)\}/);
  assert.ok(recent, 'the recent list rule exists');
  assert.match(recent[1], /max-width:\s*720px/);
  assert.match(aiCss, /\.piw-empty-recent-item \{[^}]*font-size:\s*var\(--type-subhead\)/);
  assert.match(aiCss, /\.piw-empty-recent-item > small \{[^}]*color:\s*var\(--muted\)[^}]*font-size:\s*var\(--type-caption\)/);
});

// 実物の loadProfile の失敗の枝を動かし、共通の .state-panel と二番手の再試行が出て、
// 再試行が loadProfile をもう一度呼ぶことを確かめる。
test('a failed profile load shows the state panel and a secondary retry that reloads', async () => {
  const source = app.replaceAll('\r\n', '\n');
  const from = source.indexOf('async function loadProfile()');
  const to = source.indexOf('\n}\n', from);
  assert.ok(from >= 0 && to > from, 'loadProfile is present');
  const stateStart = source.indexOf('function statePanel(');
  const stateEnd = source.indexOf('\n}\n', stateStart);
  const dom = new JSDOM('<main><p id="profile-state"></p><div class="profile-card"></div><div id="profile-posts"></div></main>');
  const doc = dom.window.document;
  let calls = 0;
  const build = new Function('document', 'icon', 'invoke', 'skeletonPost', 'accountNeeded', 'connectState', 'friendlyError',
    `let profileRequest = 0, researchAccountGeneration = 0, desktopAccount = null, currentView = 'profile';
     ${source.slice(stateStart, stateEnd + 2)}
     ${source.slice(from, to + 2)}
     return loadProfile;`);
  const loadProfile = build(doc, () => '<svg></svg>', async () => { calls++; throw new Error('offline'); },
    () => doc.createElement('div'), () => false, () => doc.createElement('div'), (error) => error.message);
  await loadProfile();
  const panel = doc.querySelector('#profile-posts .state-panel');
  assert.ok(panel, 'the failure uses .state-panel');
  assert.equal(panel.querySelector('.state-title').textContent, '読み込めませんでした');
  assert.equal(panel.querySelector('.state-body').textContent, 'offline');
  assert.equal(doc.querySelector('.profile-card').hidden, true);
  const retry = panel.querySelector('button.btn.btn-secondary');
  assert.ok(retry, 'the panel has a secondary retry');
  retry.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2, 'retry reloads the profile');
  dom.window.close();
});
