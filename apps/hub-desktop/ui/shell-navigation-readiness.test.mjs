import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { initShellControl } from './shell-control.mjs';
import { initResearch } from './research.mjs';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const navigation = source.slice(source.indexOf('async function navigateFrom('), source.indexOf('for (const item of document.querySelectorAll(".nav-item, .mobile-nav-item"))'));
const controlStart = source.indexOf('  initShellControl({');
const adapter = source.slice(controlStart, source.indexOf('\n  });', controlStart) + 7);
assert.ok(navigation.startsWith('async function navigateFrom('));
assert.ok(adapter.includes('applyLayout: async (layout, alive, remaining = () => 5000) => {') && adapter.includes('readState: () => {'));
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// Frozen from the pre-change app.js read; this reference does not derive from the edited function.
const beforeNavigation = `async function navigateFrom(item, history = {}) {
    const view = item.dataset.view;
    if(view==="feed"&&(history.replay||history.detailReplay)){const scene=history.detailReplay?detailReturn.socialScene:toolbarTrail[toolbarTrailIndex]?.socialScene;if(scene){socialMode=scene.mode;socialFilter=scene.filter;socialScope=scene.scope;feedScope=scene.feedScope;socialWantedScene=scene;}}
    if (view === currentView && view !== "browser" && !history.replay && !history.detailReplay
        && (view !== "threads" || (item.dataset.boardKey || "") === threadBoardKey)) {
      if (appsOpen) showView(view, document.querySelector("#toolbar-current").textContent);
      const scroller = viewScroller();
      if (scroller) scroller.scrollTop = 0;
      if (view === "search") focusSearchInput();
      return;
    }
    if (!history.replay && !history.detailReplay) detailForwardTrail = [];
    if (currentView === "detail" && !history.detailReplay) saveDetailTrail();
    if (view === "browser") { await enterBrowser(undefined, history); return; }
    await exitBrowser();
    if (view === "threads") {
      const previousBoard = threadBoardKey;
      threadBoardKey = item.dataset.boardKey || "";
      threadBoardTitle = threadBoardKey ? item.dataset.boardTitle || "掲示板" : "";
      document.querySelector("#threads-board-clear").hidden = !threadBoardKey;
      document.querySelector("#threads-query").placeholder = threadBoardKey ? "この板のスレッドを検索" : "スレッドを検索";
      const query = document.querySelector("#threads-query");
      if (item.dataset.query !== undefined) query.value = item.dataset.query;
      else if (threadBoardKey !== previousBoard) query.value = "";
    }
    // 通常面へ出るときは詳細の履歴を捨てる——一覧に帰ってから
    // 「戻る」で古い詳細が出ると迷子になる。
    detailTrail = [];
    const labelText = [...item.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("").trim();
    const title = view === "threads" && threadBoardKey
      ? \`\${threadBoardTitle}のスレッド\`
      : item.dataset.title ?? item.getAttribute?.("aria-label") ?? (labelText || "Hub");
    for (const control of document.querySelectorAll(".nav-item.on, .mobile-nav-item.on")) control.classList.remove("on");
    for (const control of document.querySelectorAll(\`.nav-item[data-view="\${view}"], .mobile-nav-item[data-view="\${view}"]\`)) control.classList.add("on");
    if (view === "notifications") {
      showView(view, title, history);
      await loadNotifications();
    } else if (view === "messages") {
      showView(view, title, history);
      await loadMessages();
    } else if (view === "mail") {
      showView(view, title, history);
      await loadMail();
    } else if (view === "profile") {
      showView(view, title, history);
      await loadProfile();
    } else {
      const restoredVideo=view==='videos'&&(history.replay||history.detailReplay)?await restoreVideoScene(toolbarTrail[toolbarTrailIndex]):false;
      if(restoredVideo===null)return;
      showView(view, title, history);
      if(restoredVideo)paintRestoredVideoScene();
      if (view === "feed") await loadFeed();
      if (view === "home") await loadHomeSummary();
      if (view === "ai") { void loadAiStatus(); void subscriptionUsageController?.refresh(); }
      if (view === "node") await loadNode();
      if (view === "compute") await loadCompute();
      if (view === "research") await researchWorkspace.load();
      if (view === "market" && !history.detailReplay) void loadShop();
      if (view === "purchased") renderOrders();
      if (view === "music") {
        void loadMusicTracks();
        if (musicTab === "catalog") { await loadCatalog(view); musicCatalogLoaded = true; }
      }
      if (CATALOGS[view] && view !== "music" && !restoredVideo) await loadCatalog(view);
    }
    if (view === "search") {
      focusSearchInput();
    }
}`;

async function fixture(t, navigationSource = navigation) {
  const names = ['feed', 'research', 'settings', 'ai', 'articles', 'search', 'videos', 'music', 'notifications', 'messages', 'threads'];
  const dom = new JSDOM('<main class="app-shell"><nav>' + names.map(name => `<button class="nav-item" data-view="${name}" data-title="${name}">${name}</button>`).join('') + '</nav>'
    + '<span id="toolbar-current">feed</span><div id="sidebar-resizer" aria-valuenow="198"></div><div id="rail-resizer" aria-valuenow="300"></div>'
    + '<section id="research-screen" hidden><div class="research-index-tools"><input id="research-query"><button id="research-refresh"></button><button id="research-create-web"></button></div><p id="research-state"></p><div id="research-results"></div></section>'
    + '<section id="other-screen">OTHER TARGET</section><dialog></dialog></main>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const draft = document.createElement('textarea'); draft.id = 'existing-draft'; draft.value = '  Existing draft\n\nhttps://other.example/v2/articles/source'; document.body.append(draft);
  const reference = document.createElement('a'); reference.id = 'existing-reference'; reference.href = 'https://github.com/owner/repo/commit/' + 'a'.repeat(40); reference.textContent = 'Original source'; document.body.append(reference);
  const f = { dom, document, time: 100, acks: [], shown: [], reads: [], queue: [], catalogReads: [], focus: 0, rail: 0, columns: 0, errors: [] };
  const noop = () => {};
  f.workspace = initResearch({ document, invoke: async (name, args) => { f.reads.push({ name, args }); return f.queue.shift()?.promise ?? { projects: [], hasMore: false }; },
    openProject: noop, changed: noop, friendlyError: error => error.message, openWeb: noop });
  const context = vm.createContext({ document, window: dom.window, Node: dom.window.Node, console,
    currentView: 'feed', startupTool: '', appsOpen: false, desktopShell: document.querySelector('.app-shell'),
    detailTrail: [], detailForwardTrail: [], detailReturn: {}, toolbarTrail: [{}], toolbarTrailIndex: 0,
    threadBoardKey: '', threadBoardTitle: '', sidebarCollapsedForRail: false, musicTab: 'catalog', musicCatalogLoaded: false,
    socialMode: '', socialFilter: '', socialScope: '', feedScope: '', socialWantedScene: null,
    researchWorkspace: f.workspace, CATALOGS: { articles: true, search: true, videos: true },
    nativeSidebar: { status: () => ({ selected: 0, revision: 1, ids: [] }) },
    subscriptionUsageController: null,
    enterBrowser: async () => {}, exitBrowser: () => f.exit?.promise,
    saveDetailTrail: noop, viewScroller: () => ({ scrollTop: 1 }), focusSearchInput: () => f.focus++,
    restoreVideoScene: () => f.restore?.promise ?? false, paintRestoredVideoScene: noop,
    showView: (view, title) => { context.currentView = view; f.shown.push(view); document.querySelector('#toolbar-current').textContent = title; document.querySelector('#research-screen').hidden = view !== 'research'; },
    loadNotifications: async () => {}, loadMessages: async () => {}, loadMail: async () => {}, loadProfile: async () => {},
    loadFeed: async () => {}, loadHomeSummary: async () => {}, loadAiStatus: async () => {}, loadNode: async () => {}, loadCompute: async () => {},
    loadShop: async () => {}, renderOrders: noop, loadMusicTracks: async () => {}, loadCatalog: view => { f.catalogReads.push(view); return f.catalog?.promise; },
    openDetail: async name => { await f.library?.promise; context.currentView = 'detail'; context.detailTrail = [{ name }]; },
    setDesktopRailOpen: value => { f.rail++; context.desktopShell.classList.toggle('rail-open', value); },
    renderSidebarContext: noop, syncToolbarSidebar: noop, applyColumnWidths: () => f.columns++,
    listen: async (_name, handler) => { f.event = handler; return noop; },
    invoke: async (name, args) => { assert.equal(name, 'shell_control_ack'); f.acks.push(JSON.parse(JSON.stringify(args))); },
    initShellControl: options => { f.options = options; f.bridge = initShellControl({ ...options, now: () => f.time }); },
  });
  Object.defineProperty(dom.window, 'innerWidth', { value: 1400, writable: true });
  vm.runInContext(navigationSource + '\n' + adapter, context);
  await f.bridge.ready;
  t.after(() => { f.bridge.destroy(); dom.window.close(); });
  f.context = context;
  f.go = (view, history, progress) => context.navigateFrom(document.querySelector(`[data-view="${view}"]`), history, progress);
  f.send = (view, requestId = 1, expiresAt = 10_100) => f.event({ payload: { requestId, expiresAt, layout: { view, sidebarOpen: false, railOpen: true } } });
  return f;
}
const projects = title => ({ projects: [{ id: title, title, description: '', visibility: 'public', status: 'active', objectCount: 0 }], hasMore: false });

test('real shell adapter ACKs only shown layout metadata while real research GET is pending', async t => {
  const f = await fixture(t), reading = deferred(); f.queue.push(reading); f.send('research'); await tick();
  assert.equal(f.reads.length, 1); assert.equal(f.document.querySelector('#research-results').getAttribute('aria-busy'), 'true');
  assert.equal(f.acks.length, 1); assert.equal(f.acks[0].outcome, 'applied');
  assert.deepEqual(Object.keys(f.acks[0].state).sort(), ['aiSurface', 'nativeIds', 'nativeRevision', 'railOpen', 'railWidth', 'sidebarOpen', 'sidebarSelected', 'sidebarWidth', 'view']);
  assert.equal(f.acks[0].state.view, 'research'); assert.equal(f.acks[0].state.sidebarOpen, false); assert.equal(f.acks[0].state.railOpen, true);
  assert.match(f.document.querySelector('#research-state').textContent, /検索しています/);
  reading.resolve(projects('CURRENT')); await tick();
  assert.match(f.document.querySelector('#research-results').textContent, /CURRENT/); assert.equal(f.acks.length, 1);
});

test('ordinary navigateFrom still waits for data completion and retains catalog focus', async t => {
  const f = await fixture(t), reading = deferred(); f.queue.push(reading); let done = false;
  const navigation = f.go('research').then(() => done = true); await tick();
  assert.equal(f.context.currentView, 'research'); assert.equal(done, false); assert.equal(f.acks.length, 0);
  reading.resolve(projects('NORMAL')); await navigation; assert.equal(done, true);
  f.catalog = deferred(); done = false; const search = f.go('search').then(() => done = true); await tick();
  assert.equal(done, false); assert.equal(f.focus, 0); f.catalog.resolve(); await search; assert.equal(f.focus, 1);
});

test('expiry during exitBrowser prevents the old view switch, data read and column mutations', async t => {
  const f = await fixture(t); f.exit = deferred(); f.send('research', 1, 200); await tick();
  assert.equal(f.shown.length, 0); assert.equal(f.acks.length, 0);
  f.time = 200; f.exit.resolve(); await tick();
  assert.equal(f.context.currentView, 'feed'); assert.deepEqual(f.shown, []); assert.deepEqual(f.reads, []); assert.equal(f.rail, 0); assert.equal(f.columns, 0);
  assert.deepEqual(f.acks, [{ requestId: 1, outcome: 'superseded', state: null }]);
});

test('expiry after awaited video restoration also prevents a late switch or readiness notification', async t => {
  const f = await fixture(t); f.restore = deferred(); let live = true, shown = 0;
  const navigation = f.go('videos', { replay: true }, { alive: () => live, onShown: () => shown++ }); await tick();
  live = false; f.restore.resolve(true); await navigation;
  assert.equal(f.context.currentView, 'feed'); assert.equal(shown, 0); assert.deepEqual(f.shown, []);
});

test('pre-display navigation failures fail the ACK and reveal no internal error text', async t => {
  const f = await fixture(t); f.exit = deferred(); f.send('research'); await tick(); f.exit.reject(Error('private exit detail')); await tick();
  assert.deepEqual(f.acks, [{ requestId: 1, outcome: 'failed', state: null }]); assert.equal(f.reads.length, 0); assert.equal(f.shown.length, 0);
});

test('late uncaught read rejection is consumed after layout ACK without a second or changed ACK', async t => {
  const f = await fixture(t), reading = deferred(); f.context.researchWorkspace = { load: () => reading.promise };
  f.send('research'); await tick(); assert.equal(f.acks[0].outcome, 'applied'); const snapshot = JSON.stringify(f.acks);
  reading.reject(Error('late network failure')); await tick(); assert.equal(JSON.stringify(f.acks), snapshot);
});

test('real research loader still displays its later read error without turning layout ACK into data success', async t => {
  const f = await fixture(t), reading = deferred(); f.queue.push(reading); f.send('research'); await tick();
  reading.reject(Error('Hub unavailable')); await tick();
  assert.equal(f.acks.length, 1); assert.equal(f.acks[0].outcome, 'applied');
  assert.match(f.document.querySelector('#research-state').textContent, /Hub unavailable/); assert.equal(f.document.querySelector('#research-state').classList.contains('warning'), true);
  assert.equal(f.document.querySelector('#research-results').getAttribute('aria-busy'), 'false');
});

test('old real research response cannot replace a newer search or change another screen and ACK target', async t => {
  const f = await fixture(t), old = deferred(), latest = deferred(); f.queue.push(old, latest); f.send('research'); await tick();
  f.document.querySelector('#research-query').value = 'LATEST'; const newSearch = f.workspace.load(); await tick();
  f.send('settings', 2); await tick(); assert.equal(f.acks[1].state.view, 'settings');
  const snapshot = JSON.stringify(f.acks); old.resolve(projects('STALE')); await tick();
  assert.doesNotMatch(f.document.querySelector('#research-results').textContent, /STALE/);
  latest.resolve(projects('LATEST')); await newSearch; await tick();
  assert.equal(f.context.currentView, 'settings'); assert.equal(f.document.querySelector('#research-screen').hidden, true);
  assert.match(f.document.querySelector('#research-results').textContent, /LATEST/); assert.equal(f.document.querySelector('#other-screen').textContent, 'OTHER TARGET');
  assert.equal(JSON.stringify(f.acks), snapshot);
});

test('late control catalog completion cannot focus a different screen after its layout ACK', async t => {
  const f = await fixture(t); f.catalog = deferred(); f.send('search'); await tick(); assert.equal(f.acks[0].state.view, 'search');
  f.send('settings', 2); await tick(); f.catalog.resolve(); await tick();
  assert.equal(f.context.currentView, 'settings'); assert.equal(f.focus, 0); assert.equal(f.acks.length, 2);
});

test('same-screen controls notify readiness without starting duplicate research reads', async t => {
  const f = await fixture(t); f.context.currentView = 'research'; f.send('research'); await tick();
  assert.equal(f.acks[0].outcome, 'applied'); assert.equal(f.reads.length, 0);
});

test('library layout still waits for its real preparation and the AI layout reports the Pi surface', async t => {
  const f = await fixture(t); f.library = deferred(); f.send('saved_articles'); await tick(); assert.equal(f.acks.length, 0);
  f.library.resolve(); await tick(); assert.equal(f.acks[0].state.view, 'saved_articles');
  f.send('ai', 2); await tick(); assert.equal(f.acks.length, 2);
  assert.equal(f.acks[1].outcome, 'applied'); assert.equal(f.acks[1].state.view, 'ai'); assert.equal(f.acks[1].state.aiSurface, 'legacy');
});

test('actual layout admission retains browser, modal, narrow and column drag gates', async t => {
  for (const gate of ['browser', 'modal', 'narrow', 'drag']) {
    const f = await fixture(t);
    if (gate === 'browser') f.context.desktopShell.classList.add('browser-active');
    if (gate === 'modal') f.document.querySelector('dialog').setAttribute('open', '');
    if (gate === 'narrow') f.dom.window.innerWidth = 1179;
    if (gate === 'drag') f.document.body.classList.add('column-resizing');
    f.send('research'); await tick(); assert.equal(f.acks[0].outcome, 'failed'); assert.deepEqual(f.shown, []); assert.equal(f.reads.length, 0);
  }
});

test('frozen pre-change and current ordinary navigation preserve complete final UI, reads, draft and original reference', async t => {
  const snapshots = [];
  for (const navigationSource of [beforeNavigation, navigation]) {
    const f = await fixture(t, navigationSource), reading = deferred(); f.queue.push(reading);
    const originalDraft = f.document.querySelector('#existing-draft').value;
    const originalReference = f.document.querySelector('#existing-reference').outerHTML;
    let finished = false; const pending = f.go('research').then(() => finished = true); await tick();
    assert.equal(finished, false); assert.equal(f.context.currentView, 'research'); assert.equal(f.reads.length, 1);
    reading.resolve(projects('SAME_RESULT')); await pending;
    f.catalog = deferred(); finished = false; const catalog = f.go('search').then(() => finished = true); await tick();
    assert.equal(finished, false); f.catalog.resolve(); await catalog;
    assert.equal(f.document.querySelector('#existing-draft').value, originalDraft);
    assert.equal(f.document.querySelector('#existing-reference').outerHTML, originalReference);
    snapshots.push({ view: f.context.currentView, heading: f.document.querySelector('#toolbar-current').textContent,
      nav: [...f.document.querySelectorAll('.nav-item')].map(item => [item.dataset.view, item.className]),
      shell: f.context.desktopShell.className, research: f.document.querySelector('#research-screen').innerHTML,
      researchHidden: f.document.querySelector('#research-screen').hidden, reads: f.reads, catalogReads: f.catalogReads,
      focus: f.focus, shown: f.shown, draft: f.document.querySelector('#existing-draft').value,
      originalReference: f.document.querySelector('#existing-reference').outerHTML, acks: f.acks });
  }
  assert.deepEqual(snapshots[1], snapshots[0]);
  assert.equal(snapshots[0].reads.length, 1); assert.deepEqual(snapshots[0].catalogReads, ['search']); assert.equal(snapshots[0].focus, 1);
});
