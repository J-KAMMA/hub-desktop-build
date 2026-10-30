import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {RAIL_URL_KEY, centerRoute, createRailBrowser, displayAddress, normalizeInfo, railTarget, railUrl, toolbarState} from './rail-browser.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('only plain http(s) pages reach the rail', () => {
  assert.equal(railUrl('https://hub.jkamma.com/music'), 'https://hub.jkamma.com/music');
  assert.equal(railUrl('http://localhost:3020/music'), 'http://localhost:3020/music');
  for (const bad of ['', null, undefined, 42, 'file:///C:/x', 'javascript:alert(1)', 'data:text/html,x', 'about:blank', 'blob:https://a/b', 'ftp://example.com/',
    'https://user:pw@example.com/', 'http://tauri.localhost/index.html', 'https://example.com/\u0007', `https://example.com/${'a'.repeat(2100)}`]) {
    assert.equal(railUrl(bad), null, String(bad).slice(0, 40));
  }
});

test('there is no Hub home any more: the rail starts from the browser new-tab page', async () => {
  const mod = await import('./rail-browser.mjs');
  assert.equal(mod.railHome, undefined);
  assert.equal(mod.RAIL_HOME_PATH, undefined);
});

test('the address field opens addresses and searches everything else', () => {
  assert.equal(railTarget('example.com/a'), 'https://example.com/a');
  assert.equal(railTarget('localhost:3020/music'), 'http://localhost:3020/music');
  assert.match(railTarget('猫の動画'), /^https:\/\/www\.google\.com\/search\?q=/u);
  assert.match(railTarget('猫', 'duckduckgo'), /^https:\/\/duckduckgo\.com\//u);
  assert.equal(railTarget(''), null);
  assert.equal(railTarget('javascript:alert(1)'), null);
  assert.equal(railTarget('file:///C:/x'), null);
  assert.equal(railTarget('https://user:pw@example.com/'), null);
});

test('the compact field drops the scheme and a bare slash', () => {
  assert.equal(displayAddress('https://hub.jkamma.com/'), 'hub.jkamma.com');
  assert.equal(displayAddress('https://hub.jkamma.com/music?x=1'), 'hub.jkamma.com/music?x=1');
  assert.equal(displayAddress('javascript:1'), '');
});

test('"open in centre" sends Hub pages to the matching app view, other Hub pages are refused (never the OS browser), sites to a centre tab', () => {
  const hubs = ['hub.jkamma.com', 'localhost:3020'];
  assert.deepEqual(centerRoute('https://hub.jkamma.com/music', hubs), {kind: 'view', view: 'music', title: '音楽'});
  assert.deepEqual(centerRoute('http://localhost:3020/music/', hubs), {kind: 'view', view: 'music', title: '音楽'});
  assert.deepEqual(centerRoute('http://localhost:3020/', hubs), {kind: 'view', view: 'feed', title: 'フィード'});
  assert.deepEqual(centerRoute('https://hub.jkamma.com/music/track/abc', hubs), {kind: 'refused'});
  assert.deepEqual(centerRoute('https://example.com/x', hubs), {kind: 'tab', url: 'https://example.com/x'});
  assert.equal(centerRoute('file:///x', hubs), null);
  assert.equal(centerRoute('https://hub.jkamma.com.evil.test/music', hubs).kind, 'tab');
});

test('state events must have the exact shape', () => {
  const good = {url: 'https://example.com/', title: 't', loading: false, canBack: true, canForward: false, playingAudio: false, ready: true};
  assert.deepEqual(normalizeInfo(good), good);
  for (const bad of [null, [], 'x', {...good, url: 1}, {...good, loading: 'yes'}, {url: 'x'}, {...good, ready: undefined}]) assert.equal(normalizeInfo(bad), null);
});

test('toolbar state: nothing is usable before the page exists, reload becomes stop while loading', () => {
  const none = toolbarState({url: '', title: '', loading: false, canBack: true, canForward: true, playingAudio: false, ready: false});
  assert.deepEqual([none.back, none.forward, none.reload, none.center], [false, false, false, false]);
  const page = toolbarState({url: 'https://hub.jkamma.com/music', title: '音楽', loading: false, canBack: true, canForward: false, playingAudio: false, ready: true});
  assert.deepEqual([page.back, page.forward, page.reload, page.center, page.reloadMode, page.address, page.title], [true, false, true, true, 'reload', 'hub.jkamma.com/music', '音楽']);
  assert.equal(toolbarState({url: 'https://x.test/', title: '', loading: true, canBack: false, canForward: false, playingAudio: false, ready: true}).reloadMode, 'stop');
  assert.equal(toolbarState({url: 'tauri://x', title: '', loading: false, canBack: false, canForward: false, playingAudio: false, ready: true}).center, false);
});

function fixture(t, {stored = null, shown = true, origin = 'http://localhost:3020'} = {}) {
  const dom = new JSDOM(html, {pretendToBeVisual: true, url: 'http://tauri.localhost/'});
  const {window} = dom, {document} = window;
  window.ResizeObserver = class { observe() {} disconnect() {} };
  const stage = document.querySelector('#rail-browser-stage');
  const box = {x: 600, y: 120, width: 360, height: 500};
  stage.getBoundingClientRect = () => ({...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height});
  const calls = [], events = {}, ui = {centre: [], tab: [], external: [], paused: 0, notices: [], reveal: 0};
  const store = new Map(stored ? [[RAIL_URL_KEY, stored]] : []);
  const state = {shown};
  const rail = createRailBrowser({
    document, window, storage: {getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v)},
    invoke: async (name, args) => { calls.push([name, args]); },
    listen: async (name, handler) => { events[name] = handler; },
    getHubOrigin: async () => origin, getEngine: () => 'google', isShown: () => state.shown,
    reveal: () => { ui.reveal++; state.shown = true; },
    openCenterView: (view, title) => ui.centre.push([view, title]), openCenterTab: (url) => ui.tab.push(url), openExternal: (url) => ui.external.push(url),
    pauseCentre: () => { ui.paused++; }, notice: (text) => ui.notices.push(text),
  });
  t.after(() => window.close());
  const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise((resolve) => window.requestAnimationFrame(resolve)); await new Promise((resolve) => setTimeout(resolve, 0)); } };
  return {dom, window, document, rail, calls, events, ui, store, state, box, settle};
}
const page = (extra = {}) => ({url: 'https://hub.jkamma.com/music', title: '音楽', loading: false, canBack: true, canForward: false, playingAudio: false, ready: true, ...extra});

test('first time the rail is shown: layout in CSS px, then the new-tab page opens (no Hub page)', async (t) => {
  const f = fixture(t);
  await f.settle();
  const names = f.calls.map(([name]) => name);
  assert.deepEqual(names.slice(0, 3), ['rail_browser_layout', 'rail_browser_scheme', 'rail_browser_open']);
  assert.deepEqual(f.calls[0][1], {rect: {x: 600, y: 120, w: 360, h: 500}, visible: true});
  assert.deepEqual(f.calls[2][1], {url: null});
});

test('the rail page follows the app colour scheme, not the OS', async (t) => {
  const f = fixture(t);
  await f.settle();
  const schemes = () => f.calls.filter(([name]) => name === 'rail_browser_scheme').map(([, args]) => args.dark);
  assert.deepEqual(schemes(), [true], 'dark is the app default');
  f.document.documentElement.dataset.theme = 'light'; await f.settle();
  assert.deepEqual(schemes(), [true, false]);
  f.document.documentElement.dataset.theme = 'light'; f.document.documentElement.dataset.other = '1'; await f.settle();
  assert.deepEqual(schemes(), [true, false], 'unchanged themes are not resent');
  f.document.documentElement.dataset.theme = 'dark'; await f.settle();
  assert.deepEqual(schemes(), [true, false, true]);
});

test('a remembered page wins over the new-tab page; a non-web value or a remembered Hub address is ignored', async (t) => {
  const f = fixture(t, {stored: 'https://example.com/read'});
  await f.settle();
  assert.deepEqual(f.calls.find(([name]) => name === 'rail_browser_open')[1], {url: 'https://example.com/read'});
  const g = fixture(t, {stored: 'javascript:alert(1)'});
  await g.settle();
  assert.deepEqual(g.calls.find(([name]) => name === 'rail_browser_open')[1], {url: null});
  for (const hub of ['https://hub.jkamma.com/music', 'http://localhost:3020/music']) {
    const h = fixture(t, {stored: hub});
    await h.settle();
    assert.deepEqual(h.calls.find(([name]) => name === 'rail_browser_open')[1], {url: null}, hub);
  }
});

test('collapsed or on another rail view: hidden, never created, and hidden again when it was shown', async (t) => {
  const f = fixture(t, {shown: false});
  await f.settle();
  assert.deepEqual(f.calls.map(([name]) => name), ['rail_browser_layout']);
  assert.deepEqual(f.calls[0][1], {rect: null, visible: false});
  f.state.shown = true; f.rail.schedule(); await f.settle();
  assert.ok(f.calls.some(([name]) => name === 'rail_browser_open'));
  f.calls.length = 0;
  f.state.shown = false; f.rail.schedule(); await f.settle();
  assert.deepEqual(f.calls, [['rail_browser_layout', {rect: null, visible: false}]]);
});

test('geometry follows the stage; an open dialog or a column drag hides the view', async (t) => {
  const f = fixture(t);
  await f.settle(); f.calls.length = 0;
  f.box.width = 408; f.rail.schedule(); await f.settle();
  assert.deepEqual(f.calls, [['rail_browser_layout', {rect: {x: 600, y: 120, w: 408, h: 500}, visible: true}]]);
  f.calls.length = 0; f.rail.schedule(); await f.settle();
  assert.deepEqual(f.calls, [], 'an unchanged frame is not resent');
  const dialog = f.document.createElement('dialog'); f.document.body.append(dialog); await f.settle(); dialog.setAttribute('open', '');
  await f.settle();
  assert.deepEqual(f.calls.at(-1), ['rail_browser_layout', {rect: null, visible: false}]);
  dialog.remove(); f.document.body.classList.add('column-resizing'); await f.settle();
  assert.deepEqual(f.calls.at(-1), ['rail_browser_layout', {rect: null, visible: false}]);
  f.document.body.classList.remove('column-resizing'); await f.settle();
  assert.equal(f.calls.at(-1)[1].visible, true);
  f.box.width = 40; f.rail.schedule(); await f.settle();
  assert.deepEqual(f.calls.at(-1), ['rail_browser_layout', {rect: null, visible: false}], 'a collapsed rail has no usable frame');
});

test('a stage taller than the window is clamped to the visible client area instead of refusing to start', async (t) => {
  const f = fixture(t);
  const {innerWidth: w, innerHeight: h} = f.window;
  f.box.y = 120; f.box.height = h + 400; // 1088x639-style short window: the stage runs past the bottom
  f.rail.schedule(); await f.settle();
  const layouts = f.calls.filter(([name]) => name === 'rail_browser_layout');
  assert.deepEqual(layouts.at(-1)[1], {rect: {x: 600, y: 120, w: 360, h: h - 120}, visible: true});
  assert.ok(f.calls.some(([name]) => name === 'rail_browser_open'), 'the browser still starts');
  const r = layouts.at(-1)[1].rect;
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h, 'the view stays inside the client area');
  f.box.x = w - 200; f.box.y = -50; f.box.width = 360; f.box.height = 500; f.rail.schedule(); await f.settle(); // overflowing right/top is clamped too
  assert.deepEqual(f.calls.filter(([name]) => name === 'rail_browser_layout').at(-1)[1].rect, {x: w - 200, y: 0, w: 200, h: 450});
  f.box.y = h - 40; f.box.x = 600; f.box.height = 500; f.rail.schedule(); await f.settle(); // almost fully below the window: nothing usable to show
  assert.deepEqual(f.calls.at(-1), ['rail_browser_layout', {rect: null, visible: false}]);
});

test('state events update the toolbar and remember only web addresses', async (t) => {
  const f = fixture(t);
  await f.settle();
  f.events['rail-browser-state']({payload: page()});
  const get = (id) => f.document.getElementById(id);
  assert.equal(get('rb-back').disabled, false);
  assert.equal(get('rb-forward').disabled, true);
  assert.equal(get('rb-center').disabled, false);
  assert.equal(get('rb-address').value, 'hub.jkamma.com/music');
  assert.equal(get('rb-title').textContent, '音楽');
  assert.equal(f.store.get(RAIL_URL_KEY), 'https://hub.jkamma.com/music');
  f.events['rail-browser-state']({payload: page({url: 'tauri://localhost/x', loading: true})});
  assert.equal(f.store.get(RAIL_URL_KEY), 'https://hub.jkamma.com/music', 'an app address is never remembered');
  assert.equal(get('rb-reload').dataset.mode, 'stop');
  f.events['rail-browser-state']({payload: {nonsense: true}});
  assert.equal(get('rb-reload').dataset.mode, 'stop', 'a malformed event changes nothing');
});

test('toolbar buttons call the native commands', async (t) => {
  const f = fixture(t);
  await f.settle(); f.events['rail-browser-state']({payload: page({canForward: true})}); f.calls.length = 0;
  for (const id of ['rb-back', 'rb-forward', 'rb-reload']) f.document.getElementById(id).click();
  f.events['rail-browser-state']({payload: page({loading: true})});
  f.document.getElementById('rb-reload').click();
  assert.deepEqual(f.calls.map(([name]) => name), ['rail_browser_back', 'rail_browser_forward', 'rail_browser_reload', 'rail_browser_stop']);
  assert.equal(f.document.getElementById('rb-home'), null, 'the rail browser has no home button (2026-10-24)');
});

test('the address field navigates or searches, and refuses what it cannot open', async (t) => {
  const f = fixture(t);
  await f.settle(); f.calls.length = 0;
  const input = f.document.getElementById('rb-address'), form = f.document.getElementById('rb-form');
  input.value = 'example.com/news';
  form.dispatchEvent(new f.window.Event('submit', {cancelable: true})); await f.settle();
  assert.deepEqual(f.calls.at(-1), ['rail_browser_open', {url: 'https://example.com/news'}]);
  input.value = '夜の音楽';
  form.dispatchEvent(new f.window.Event('submit', {cancelable: true})); await f.settle();
  assert.match(f.calls.at(-1)[1].url, /^https:\/\/www\.google\.com\/search\?q=/u);
  f.calls.length = 0; input.value = 'javascript:alert(1)';
  form.dispatchEvent(new f.window.Event('submit', {cancelable: true})); await f.settle();
  assert.deepEqual(f.calls, []);
  assert.equal(f.document.getElementById('rb-note').hidden, false, 'the message is shown inside the rail');
  assert.deepEqual(f.ui.notices, [], 'no full-screen notice while the rail is visible');
});

test('open in centre routes by destination', async (t) => {
  const f = fixture(t);
  await f.settle();
  f.events['rail-browser-state']({payload: page()});
  f.document.getElementById('rb-center').click(); await f.settle();
  assert.deepEqual(f.ui.centre, [['music', '音楽']]);
  f.events['rail-browser-state']({payload: page({url: 'https://example.com/a'})});
  f.document.getElementById('rb-center').click(); await f.settle();
  assert.deepEqual(f.ui.tab, ['https://example.com/a']);
  f.events['rail-browser-state']({payload: page({url: 'http://localhost:3020/market/item/9'})});
  f.document.getElementById('rb-center').click(); await f.settle();
  assert.deepEqual(f.ui.external, [], 'a Hub page without a native view never opens the OS browser');
  assert.match(f.document.getElementById('rb-note').textContent, /Hub/u);
  await f.events['rail-browser-open-center']({payload: {url: 'https://hub.jkamma.com/videos'}}); await f.settle();
  assert.deepEqual(f.ui.centre.at(-1), ['videos', '動画']);
});

test('"open in rail" from the centre reveals the rail and navigates only to web addresses', async (t) => {
  const f = fixture(t, {shown: false});
  await f.settle();
  assert.equal(await f.rail.openInRail('https://example.com/link'), true);
  await f.settle();
  assert.equal(f.ui.reveal, 1);
  assert.deepEqual(f.calls.filter(([name]) => name === 'rail_browser_open').map(([, args]) => args), [{url: 'https://example.com/link'}], 'the link replaces home on first start');
  f.calls.length = 0;
  assert.equal(await f.rail.openInRail('https://example.org/b'), true);
  assert.deepEqual(f.calls.at(-1), ['rail_browser_open', {url: 'https://example.org/b'}]);
  assert.equal(await f.rail.openInRail('file:///C:/Windows/win.ini'), false);
  assert.equal(f.calls.filter(([, args]) => args?.url?.startsWith('file')).length, 0);
  await f.events['rail-browser-open-request']({payload: {url: 'https://example.net/c'}}); await f.settle();
  assert.deepEqual(f.calls.at(-1), ['rail_browser_open', {url: 'https://example.net/c'}]);
});

test('a Hub address typed or clicked is never loaded in the rail: native view in the centre, or a refusal', async (t) => {
  const f = fixture(t, {shown: false});
  await f.settle();
  assert.equal(await f.rail.openInRail('https://hub.jkamma.com/videos'), true);
  assert.deepEqual(f.ui.centre.at(-1), ['videos', '動画']);
  assert.equal(await f.rail.openInRail('http://localhost:3020/music'), true);
  assert.deepEqual(f.ui.centre.at(-1), ['music', '音楽']);
  assert.equal(await f.rail.openInRail('https://hub.jkamma.com/market/item/9'), false);
  assert.deepEqual(f.ui.external, []);
  assert.equal(f.calls.filter(([name, args]) => name === 'rail_browser_open' && /hub.jkamma.com|localhost:3020/u.test(args?.url ?? '')).length, 0);
  assert.equal(f.ui.reveal, 0, 'a Hub address does not open the rail');
  const input = f.document.getElementById('rb-address'), form = f.document.getElementById('rb-form');
  f.state.shown = true; f.calls.length = 0; input.value = 'https://hub.jkamma.com/notifications';
  form.dispatchEvent(new f.window.Event('submit', {cancelable: true})); await f.settle();
  assert.deepEqual(f.ui.centre.at(-1), ['notifications', '通知']);
  assert.equal(f.calls.filter(([name]) => name === 'rail_browser_open').length, 0);
});

test('two players never fight: rail audio pauses the centre once, the centre pauses the rail', async (t) => {
  const f = fixture(t);
  await f.settle();
  f.events['rail-browser-state']({payload: page({playingAudio: true})});
  f.events['rail-browser-state']({payload: page({playingAudio: true, title: 'x'})});
  assert.equal(f.ui.paused, 1, 'only the rising edge pauses the centre');
  f.events['rail-browser-state']({payload: page({playingAudio: false})});
  f.events['rail-browser-state']({payload: page({playingAudio: true})});
  assert.equal(f.ui.paused, 2);
  f.calls.length = 0; f.rail.pauseRail();
  assert.deepEqual(f.calls, [['rail_browser_pause_media', undefined]]);
});

test('the controller only sends URLs and frames to native code', () => {
  const source = readFileSync(new URL('./rail-browser.mjs', import.meta.url), 'utf8');
  const commands = [...source.matchAll(/(?:invoke\(|run\()'(rail_browser_[a-z_]+)'/gu)].map((m) => m[1]);
  assert.ok(commands.length >= 6);
  assert.ok(!/__TAURI__|eval\(|innerHTML|insertAdjacentHTML/u.test(source));
});

test('the rail toolbar lifts into the title bar in both states: Hub view and centre browser', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('function placeBrowserStrip()'), app.indexOf('window.addEventListener("resize", placeBrowserStrip)'));
  // The lift must not depend on the centre being a browser.
  assert.match(fn, /const railOpen = Boolean\(shell\?\.classList\.contains\("rail-open"\)\);/u);
  assert.doesNotMatch(fn, /railOpen = !centreBrowser/u);
  // The centre browser strip stops before the lifted rail column instead of overlapping it.
  assert.match(fn, /dataset\.railBar === "top"[\s\S]*--rail-bar-left[\s\S]*right = Math\.min\(right, railLeft - 8 \+ 120\)/u);
  // The CSS lift is keyed on the rail state only, never on browser-active.
  const css = readFileSync(new URL('./rail-browser.css', import.meta.url), 'utf8');
  assert.match(css, /html\[data-rail-bar="top"\] #hub-shell\.rail-open\.rail-browser-view \.rb-bar \{/u);
  assert.doesNotMatch(css, /browser-active/u);
});
