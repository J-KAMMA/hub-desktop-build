
import { createPostRow } from './post-row.mjs';
import { researchDiscussionReference, researchGitDiscussionReference } from './research-reference.mjs';
import {communityMembershipReviewRequest} from "./community-membership-review.mjs";
import {communityReportReviewRequest} from "./community-report-review.mjs";
import {communityAppealReviewRequest} from "./community-appeal-review.mjs";
import { communityGuideRequest } from "./community-guide-reader.mjs";
import { createHubSearch } from "./hub-search.mjs";
import { matchesSearch } from "./search-input.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("the right rail gives the main canvas room when a wide window narrows", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("function syncSidebarForRail(open) {");
  const end = source.indexOf("\nlet appsOpen = false;", start);
  assert.ok(start >= 0 && end > start);
  const classes = new Set();
  const shell = { classList: {
    contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name),
  } };
  let width = 1280;
  const matchMedia = (query) => ({ matches: [...query.matchAll(/(min|max)-width:\s*(\d+)px/g)]
    .every(([, kind, limit]) => kind === "min" ? width >= Number(limit) : width <= Number(limit)) });
  const { sync, autoCollapsed } = new Function("document", "matchMedia", `
    let sidebarCollapsedForRail = false, sidebarEmptyView = false, sidebarCollapsedForEmpty = false;
    ${source.slice(start, end)}
    return { sync: syncSidebarForRail, autoCollapsed: () => sidebarCollapsedForRail };
  `)({ querySelector: () => shell }, matchMedia);
  sync(true);
  assert.equal(classes.has("sidebar-collapsed"), false);
  width = 920;
  sync(true);
  assert.equal(classes.has("sidebar-collapsed"), true);
  assert.equal(autoCollapsed(), true);
  width = 1280;
  sync(true);
  assert.equal(classes.has("sidebar-collapsed"), false);
  classes.add("sidebar-collapsed");
  width = 920;
  sync(true);
  width = 1280;
  sync(true);
  assert.equal(classes.has("sidebar-collapsed"), true, "a user's own collapsed sidebar stays collapsed");
});

test("cart keeps a public product snapshot across searches and restart", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const section = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
  };
  const storage = new Map();
  const product = {
    id: "item-1", title: "本", priceJpyc: 500, shippingJpyc: 100,
    stockQuantity: 3, fulfillmentType: "seller_shipping",
    seller: { publicName: "店", legalDisplayUrl: "https://example.com/legal", privateField: "omit" },
    privateField: "omit",
  };
  const setup = new Function("localStorage", "product", `
    const SHOP_CART_KEY = "hub.desktop.shop-cart.v1";
    const SHOP_CART_PRODUCTS_KEY = "hub.desktop.shop-cart-products.v1";
    const SHOP_ORDERS_KEY = "hub.desktop.shop-orders.v1";
    const shop = { products: [], cart: {}, cartProducts: {}, orders: [] };
    ${section("function shopLoad() {", "function shopTokenKey(")}
    ${section("function mergeShopProducts(products) {", "async function fetchShopCatalog(")}
    ${section("function cartProductSnapshot(product) {", "async function renderCart() {")}
    mergeShopProducts([product]);
    shop.cart[product.id] = 1;
    shop.cartProducts[product.id] = cartProductSnapshot(product);
    shopSave();
    shop.products = [];
    shop.cart = {};
    shop.cartProducts = {};
    shopLoad();
    const restored = cartLines();
    mergeShopProducts([{ ...product, priceJpyc: 550 }]);
    return { restored, updated: cartLines(), snapshot: shop.cartProducts[product.id] };
  `);
  const result = setup({ getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) }, product);
  assert.equal(result.restored[0].product.title, "本");
  assert.equal(result.restored[0].saved, true);
  assert.equal(result.updated[0].product.priceJpyc, 550);
  assert.equal(result.updated[0].saved, false);
  assert.equal(result.snapshot.privateField, undefined);
  assert.equal(result.snapshot.seller.privateField, undefined);
});

test("search results keep typed hits once and retain unmatched index hits", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("function publicGroups(data) {");
  const end = source.indexOf("\n// 空・未接続", start);
  assert.ok(start >= 0 && end > start);
  const publicGroups = new Function(`return (${source.slice(start, end)});`)();
  const groups = publicGroups({
    coreEntities: [
      { sourceGroup: "posts", ref: { id: "post-1" } },
      { sourceGroup: "profiles", ref: { id: "person-1" } },
      { sourceGroup: "listings", ref: { id: "post-1" } },
      { sourceGroup: "posts", ref: { id: "post-2" } },
      { sourceGroup: "posts" },
    ],
    posts: [{ id: "post-1" }],
    profiles: [{ id: "person-1" }],
  });
  assert.deepEqual(groups.map(([key, records]) => [key, records.length]),
    [["posts", 1], ["profiles", 1], ["coreEntities", 3]]);
  assert.deepEqual(publicGroups({ posts: [{ id: "post-1" }], coreEntities: [
    { sourceGroup: "posts", ref: { id: "post-1" } },
  ] }).map(([key]) => key), ["posts"]);
});

test("a newer search wins and a failed source stays distinguishable from no results", async () => {
  const pending = new Map();
  let state;
  const search = createHubSearch({changed: value => {state=value;}, invoke: (command, args) => new Promise((resolve,reject) => pending.set(`${args.query}:${args.resource ?? command}`,{resolve,reject}))});
  void search.search("old");
  void search.search("new");
  pending.get("new:search").resolve({coreEntities:[],products:[{id:"new"}]});
  await new Promise(resolve=>setImmediate(resolve));
  pending.get("old:search").reject(Error("old failed"));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.data.products[0].id,"new");
  assert.equal(state.errors.hub,undefined);
  pending.get("new:articles").reject(Error("articles unavailable"));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.data.products[0].id,"new");
  assert.match(state.errors.articles.message,/unavailable/);
  search.invalidate();
  pending.get("new:research").resolve({projects:[{id:"late"}],hasMore:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(state.data,{});
});

test("a search repost without preview opens its detail instead of rendering empty actions", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("function searchPost(record) {");
  const end = source.indexOf("\n// 検索結果のグループ", start);
  assert.ok(start >= 0 && end > start);
  const opened = [];
  const card = { classList: { add() {} }, click() { this.onclick(); } };
  const searchPost = new Function("deps", `
    const { textValue, resultCard, postCard, openDetail } = deps;
    ${source.slice(start, end)}
    return searchPost;
  `)({ textValue: (record) => record.displayName, resultCard: () => card,
    postCard: () => "full post", openDetail: (...args) => opened.push(args) });
  assert.equal(searchPost({ id: "repost", displayName: "Noa", body: "", images: [] }), card);
  card.onkeydown({ key: "Enter" });
  assert.deepEqual(opened[0].slice(0, 2), ["post", ["repost"]]);
  assert.equal(searchPost({ id: "image", body: "", images: [{ url: "https://example.com/image" }] }), "full post");
  assert.equal(searchPost({ id: "", body: "" }), null);
});

test("catalog and wallet waits end on success, failure, or deadline", async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("function settleWithin(");
  const end = source.indexOf("\nconst catalogSearches", start);
  assert.ok(start >= 0 && end > start);
  const settleWithin = new Function(`return (${source.slice(start, end)});`)();
  assert.equal(await settleWithin(Promise.resolve("ready"), 20), "ready");
  await assert.rejects(settleWithin(Promise.reject("offline"), 20), (error) => error === "offline");
  await assert.rejects(settleWithin(new Promise(() => {}), 5), (error) => error === "request_timeout");
});

test("an older detail response cannot replace the selected detail", async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("async function renderDetailEntry(entry) {");
  const end = source.indexOf("\nasync function openDetail", start);
  assert.ok(start >= 0 && end > start);
  const requests = [];
  const target = { replaceChildren(...children) { this.children = children; } };
  const state = { textContent: "", classList: { remove() {}, add() {} } };
  const create = new Function("deps", `
    let researchDetailController=null,communityDetailController=null,communityInviteController=null;
    ${source.slice(source.indexOf('function releaseResearchDetail('),start)}
    let detailRenderRevision = 0, researchAccountGeneration = 0;
    const detailTrail = [];
    let currentView = "detail";
    const { paintDetailHead, detailState, detailContent, skeletonResult, invoke, DETAIL_RENDERERS, communityGuideRequest, communityMembershipReviewRequest, communityReportReviewRequest, communityAppealReviewRequest } = deps;
    const readingDirectory = new Map(), DETAIL_PARENT_VIEW = {}, attachDetailAiHandoff = () => {};
    ${source.slice(start, end)}
    return { renderDetailEntry: entry => { detailTrail.splice(0, detailTrail.length, entry); return renderDetailEntry(entry); }, leaveDetail: () => { currentView = "feed"; } };
  `);
  const { renderDetailEntry, leaveDetail } = create({
    communityGuideRequest,communityMembershipReviewRequest,communityReportReviewRequest,communityAppealReviewRequest,
    paintDetailHead: () => {}, detailState: () => state, detailContent: () => target,
    skeletonResult: () => "loading",
    invoke: () => new Promise((resolve) => requests.push(resolve)),
    DETAIL_RENDERERS: { post: (node, data) => node.replaceChildren(data.body) },
  });
  const first = renderDetailEntry({ name: "post", ids: ["first"], title: "投稿" });
  const second = renderDetailEntry({ name: "post", ids: ["second"], title: "投稿" });
  requests[1]({ body: "second" });
  await second;
  requests[0]({ body: "first" });
  await first;
  assert.deepEqual(target.children, ["second"]);
  const third = renderDetailEntry({ name: "post", ids: ["third"], title: "投稿" });
  leaveDetail();
  requests[2]({ body: "third" });
  await third;
  assert.deepEqual(target.children, ["loading", "loading", "loading"]);
});

// readable() lives in app.js but is not exported (app.js is a top-level-await
// script wired to the DOM, not an importable module). Pull just its source
// out of the file and evaluate it, so this test tracks the real function
// instead of a hand-copied duplicate that could drift from it.
function loadReadable() {
  const appPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js");
  const source = readFileSync(appPath, "utf8");
  const start = source.indexOf("function readable(line) {");
  assert.notEqual(start, -1, "readable() not found in app.js");
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.notEqual(end, -1, "could not find end of readable()");
  const fnSource = source.slice(start, end);
  // eslint-disable-next-line no-eval
  return (0, eval)(`(${fnSource})`);
}

const readable = loadReadable();

test("wallet balance keeps sending unavailable until a valid positive balance is known", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("function walletBalanceSummary(value) {");
  const end = source.indexOf("\nasync function renderWallet", start);
  assert.ok(start >= 0 && end > start);
  const summarize = new Function(`return (${source.slice(start, end)});`)();
  assert.deepEqual(summarize("0"), { label: "0", canSend: false });
  assert.deepEqual(summarize("1"), { label: "0.000001未満", canSend: true });
  assert.deepEqual(summarize("1000000000000000000"), { label: "1", canSend: true });
  for (const invalid of [null, "-1", "1.5", "abc", (1n << 128n).toString()]) {
    assert.throws(() => summarize(invalid), RangeError);
  }
});

test("external resources only open HTTPS pages on their verified origin", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(directory, "app.js"), "utf8");
  const start = source.indexOf("function distributedResourceUrl(resource) {");
  const end = source.indexOf("\nfunction distributedResourceCard", start);
  assert.ok(start >= 0 && end > start);
  const resourceUrl = new Function(`return (${source.slice(start, end)});`)();
  const resource = { origin: "https://seller.example/", canonicalUrl: "https://seller.example/item/1" };
  assert.equal(resourceUrl(resource), resource.canonicalUrl);
  assert.equal(resourceUrl({ ...resource, canonicalUrl: "https://other.example/item/1" }), null);
  assert.equal(resourceUrl({ ...resource, canonicalUrl: "http://seller.example/item/1" }), null);
  assert.equal(resourceUrl({ ...resource, canonicalUrl: "https://user:pass@seller.example/item/1" }), null);
  assert.equal(resourceUrl({ ...resource, canonicalUrl: "https://seller.example:8443/item/1" }), null);
  assert.equal(resourceUrl({ ...resource, canonicalUrl: "invalid" }), null);
});

test("federated posts reject unsafe destination URLs", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(directory, "app.js"), "utf8");
  const start = source.indexOf("function activityPubUrl(item) {");
  const end = source.indexOf("\nfunction activityPubCard", start);
  assert.ok(start >= 0 && end > start);
  const postUrl = new Function(`return (${source.slice(start, end)});`)();
  assert.equal(postUrl({ url: "https://social.example/posts/1" }), "https://social.example/posts/1");
  assert.equal(postUrl({ url: "http://social.example/posts/1" }), null);
  assert.equal(postUrl({ url: "https://user:pass@social.example/posts/1" }), null);
  assert.equal(postUrl({ url: "https://social.example:8443/posts/1" }), null);
});

test("removed shopping product links no longer open a native detail", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(directory, "app.js"), "utf8");
  const start = source.indexOf("function detailForHubPath(path) {");
  const end = source.indexOf("\n// Hubpedia", start);
  assert.ok(start >= 0 && end > start);
  const detailForHubPath = new Function(`return (${source.slice(start, end)});`)();
  for (const link of ["/market/products/hub-ec-test-earphones", "/v2/market/products/hub-ec-test-earphones", "/market/products/../admin"]) assert.equal(detailForHubPath(link), null);
});

test("catalog links reach their native screens without claiming a Web handoff", async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("async function openHubPath(");
  const end = source.indexOf("\nfunction showNotice", start);
  assert.ok(start >= 0 && end > start);
  const visits = [];
  const notices = [];
  const openHubPath = new Function("deps", `
    const { detailForHubPath, openDetail, navigateFrom, showNotice } = deps;
    ${source.slice(start, end)}
    return openHubPath;
  `)({ detailForHubPath: () => null, openDetail: () => {},
    navigateFrom: async (item) => visits.push(item.dataset.view), showNotice: (message) => notices.push(message) });
  await openHubPath("/world"); // 世界は Web で停止中。Desktop には画面が無く、通知だけ出る
  await openHubPath("/v2/token?token=token-ranking-eth");
  await openHubPath("/v2/services");
  await openHubPath("/v2/tokenized");
  assert.deepEqual(visits, ["ranking", "services"]);
  assert.equal(notices.length, 2);
});

test("top navigation returns from the browser to the previous app screen", async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("async function travelToolbar(direction) {");
  const end = source.indexOf("\ndocument.querySelector(\"#toolbar-back\").onclick", start);
  assert.ok(start >= 0 && end > start);
  const state = new Function(`
    let currentView = "browser";
    const toolbarTrail = [{ view: "feed" }, { view: "videos" }, { view: "browser" }];
    let toolbarTrailIndex = 2;
    let toolbarReplaying = false;
    let videoWatchIndex = -1;
    const videoWatchHistory = [];
    const detailForwardTrail = [];
    const detailReturn = { view: "feed" };
    const visits = [];
    const document = { querySelector(selector) {
      if (selector.startsWith("#browser-")) throw Error("page history used for app navigation");
      return null;
    } };
    async function navigateFrom(item) { visits.push(item.dataset.view); currentView = item.dataset.view; }
    async function detailBack() {}
    async function detailForward() {}
    function updateToolbarNavigation() {}
    ${source.slice(start, end)}
    return { travelToolbar, visits };
  `)();
  await state.travelToolbar(-1);
  await state.travelToolbar(1);
  assert.deepEqual(state.visits, ["videos", "browser"]);
});

test("top navigation follows related videos back to the list and forward again", async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("async function travelToolbar(direction) {");
  const end = source.indexOf('\ndocument.querySelector("#toolbar-back").onclick', start);
  assert.ok(start >= 0 && end > start);
  const state = new Function(`
    let currentView = "videos";
    const toolbarTrail = [{ view: "videos" }];
    let toolbarTrailIndex = 0;
    let videoWatchIndex = 1;
    const videoWatchHistory = [{ title: "first" }, { title: "related" }];
    const detailForwardTrail = [];
    const detailReturn = { view: "feed" };
    const visits = [];
    const panels = { "#video-watch": { hidden: false }, "#video-discover": { hidden: true }, ".workspace-main": { scrollTop: 10 } };
    const document = { querySelector: (selector) => panels[selector] };
    const videoListScroll=10,viewScroller=()=>panels[".workspace-main"];
    function rememberVideoScroll() {}
    function openVideoWatch(video, replay) { visits.push([video.title, replay]); }
    function renderSidebarContext() {}
    function updateToolbarNavigation() {}
    ${source.slice(start, end)}
    return { travelToolbar, visits, panels, index: () => videoWatchIndex };
  `)();
  await state.travelToolbar(-1);
  await state.travelToolbar(-1);
  assert.equal(state.index(), -1);
  assert.equal(state.panels["#video-watch"].hidden, true);
  assert.equal(state.panels["#video-discover"].hidden, false);
  await state.travelToolbar(1);
  await state.travelToolbar(1);
  assert.deepEqual(state.visits, [["first", true], ["first", true], ["related", true]]);
});

test("selecting the current destination keeps its loaded content", async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("async function navigateFrom(item");
  const end = source.indexOf('\nfor (const item of document.querySelectorAll(".nav-item, .mobile-nav-item"))', start);
  assert.ok(start >= 0 && end > start);
  const state = new Function(`
    let currentView = "market", appsOpen = false, toolbarReplaying = false, detailHistoryReplaying = false;
    let threadBoardKey = "";
    const scroller = { scrollTop: 430 };
    function viewScroller() { return scroller; }
    async function exitBrowser() { throw Error("same destination reloaded"); }
    ${source.slice(start, end)}
    return { navigateFrom, scroller };
  `)();
  await state.navigateFrom({ dataset: { view: "market" } });
  assert.equal(state.scroller.scrollTop, 0);
  const board = new Function(`
    let currentView = "threads", appsOpen = false, toolbarReplaying = false, detailHistoryReplaying = false;
    let detailForwardTrail = [], threadBoardKey = "board-1";
    function viewScroller() { throw Error("board selection was incorrectly kept"); }
    async function exitBrowser() { throw Error("board navigation continued"); }
    ${source.slice(start, end)}
    return navigateFrom;
  `)();
  await assert.rejects(board({ dataset: { view: "threads" } }), /board navigation continued/);
});

test("browser side panel has its own open choice", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("const railChoiceFor = (view) =>");
  const end = source.indexOf("\nlet appsOpen = false;", start);
  assert.ok(start >= 0 && end > start);
  const state = new Function(`
    let railUserChoice = true, browserRailChoice = false, currentView = "browser";
    const saved = new Map();
    const localStorage = { setItem: (key, value) => saved.set(key, value) };
    ${source.slice(start, end)}
    return { railChoiceFor, saveRailChoice, saved, setView: (view) => { currentView = view; } };
  `)();
  assert.equal(state.railChoiceFor("browser"), false);
  assert.equal(state.railChoiceFor("feed"), true);
  state.saveRailChoice(true);
  assert.equal(state.saved.get("hub.desktop.browserRailOpen"), "true");
  state.saveRailChoice(false);
  assert.equal(state.railChoiceFor("feed"), true);
  state.setView("feed");
  state.saveRailChoice(false);
  assert.equal(state.saved.get("hub.desktop.railOpen"), "false");
  assert.equal(state.railChoiceFor("browser"), false);
});

test("quick switcher opens matching screens before searching", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("function quickItemsFor(term) {");
  const end = source.indexOf("\nfunction renderQuickSwitcher()", start);
  assert.ok(start >= 0 && end > start);
  const quickItemsFor = new Function("matchesSearch", `
    const quickDestinations = [["SNS", "feed"], ["AI", "ai"], ["ブラウザ", "browser"]];
    ${source.slice(start, end)}
    return quickItemsFor;
  `)(matchesSearch);
  assert.deepEqual(quickItemsFor("AI").map((item) => item.view), ["ai", "search"]);
  assert.deepEqual(quickItemsFor("ブラ").map((item) => item.view), ["browser", "search"]);
  assert.deepEqual(quickItemsFor("未登録").map((item) => item.view), ["search"]);
  assert.deepEqual(quickItemsFor("").map((item) => item.view), ["search", "feed", "ai", "browser", "apps"]);
});

test("top navigation restores a post detail after opening search", async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("async function travelToolbar(direction) {");
  const end = source.indexOf("\ndocument.querySelector(\"#toolbar-back\").onclick", start);
  assert.ok(start >= 0 && end > start);
  const state = new Function(`
    let currentView = "search";
    const post = { name: "post", title: "投稿", scrollTop: 0 };
    const toolbarTrail = [{ view: "feed" }, { view: "detail", detailTrail: [post], detailForwardTrail: [], detailReturn: { view: "feed", title: "タイムライン" } }, { view: "search" }];
    let toolbarTrailIndex = 2;
    let toolbarReplaying = false;
    let detailTrail = [];
    let detailForwardTrail = [];
    let detailReturn = { view: "feed" };
    const visits = [];
    const document = { querySelector: () => null };
    async function navigateFrom(item) { currentView = item.dataset.view; visits.push(currentView); }
    async function renderDetailEntry(entry) { visits.push(entry.name); }
    async function detailBack() {}
    async function detailForward() {}
    function showView(view) { currentView = view; }
    function viewScroller() { return null; }
    function updateToolbarNavigation() {}
    ${source.slice(start, end)}
    return { travelToolbar, visits };
  `)();
  await state.travelToolbar(-1);
  await state.travelToolbar(1);
  assert.deepEqual(state.visits, ["post", "search"]);
});

test("AI send continues after a workspace is chosen and keeps the draft when cancelled", async () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const start = source.indexOf("  const send = async () => {");
  const end = source.indexOf("\n  els.start.onclick", start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  let chosen = false;
  const prompt = { value: "作業を確認して" };
  const state = new Function("deps", `
    const { calls, prompt, choose } = deps;
    const els = { start: { disabled: false }, prompt, model: { value: "" }, allowWrite: { checked: false }, allowExec: { checked: false }, allowHttp: { checked: false }, verifyProgram: { value: "" }, verifyArgs: { value: "" } };
    const controller = { state: { selectedId: null }, start: async (args) => { calls.push(args); return false; } };
    const connectionChat = { handles: () => false, reset() {} };
    let savedWorkspace = "", stickToBottom = false, newWork = true, resumeFrom = null, draftContext = null;
    const drafts = new Map();
    const pickWorkspace = async () => { if (!choose()) return false; savedWorkspace = "C:/work"; return true; };
    ${source.slice(start, end)}
    return send;
  `)({ calls, prompt, choose: () => chosen });
  await state();
  assert.equal(calls.length, 0);
  assert.equal(prompt.value, "作業を確認して");
  chosen = true;
  await state();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "作業を確認して");
});

test("the bundled app UI is the primary surface and the Web Hub opens in the in-app browser", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(path.join(directory, "index.html"), "utf8");
  const app = readFileSync(path.join(directory, "app.js"), "utf8");
  const css = readFileSync(path.join(directory, "styles.css"), "utf8");
  const rust = readFileSync(path.join(directory, "../src-tauri/src/lib.rs"), "utf8");
  const windowRust = readFileSync(path.join(directory, "../src-tauri/src/hub_window.rs"), "utf8");
  const capability = readFileSync(path.join(directory, "../src-tauri/capabilities/default.json"), "utf8");
  const config = readFileSync(path.join(directory, "../src-tauri/tauri.conf.json"), "utf8");
  const browserRust = readFileSync(path.join(directory, "../src-tauri/src/browser_window.rs"), "utf8");
  const newtab = readFileSync(path.join(directory, "newtab.html"), "utf8");
  // The main window stays on the bundled UI; nothing navigates it to the Hub URL.
  assert.doesNotMatch(rust, /window\.navigate\(/);
  assert.match(rust, /fn open_harness_window\(/);
  assert.match(rust, /fn hub_origin\(\)/);
  assert.match(windowRust, /http:\/\/localhost:3020/);
  // Remote pages get no IPC at all: no remote URL list, no event bridge.
  assert.doesNotMatch(capability, /"remote"/);
  assert.doesNotMatch(rust, /listen\("browser-enter"/);
  const mainWindow = JSON.parse(config).app.windows.find((window) => window.label === "main");
  assert.equal(mainWindow.maximized, true);
  assert.equal(mainWindow.preventOverflow, true);
  assert.match(html, /<dialog id="harness-dialog"/);
  assert.doesNotMatch(html, /games-dialog/);
  // The browser is one destination inside the app, rendered by child webviews.
  assert.match(html, /data-view="browser"/);
  assert.match(html, /id="view-browser"/);
  assert.match(app, /invoke\("browser_enter"/);
  assert.match(app, /invoke\("browser_exit"\)/);
  assert.match(app, /if \(!startupTool\) void invoke\("browser_exit"\)/);
  assert.match(browserRust, /const NEW_TAB_PAGE: &str = "newtab\.html"/);
  assert.doesNotMatch(newtab, /app-shell|app\.js/);
  assert.match(newtab, /newtab\.js/);
  assert.doesNotMatch(app, /launch_game/);
  assert.match(html, /id="ai-workspace"/);
  assert.match(html, /id="sidebar-ai-history"/);
  assert.match(app, /document\.querySelector\("#ai-workspace"\)\.append\(layout\)/);
  assert.doesNotMatch(app, /invoke\("open_harness_window"\)/);
  assert.match(app, /listen\("hub-open-harness"/);
  assert.doesNotMatch(app, /hub-open-games/);
  assert.match(app, /listen\("browser-open-request"/);
  assert.match(app, /classList\.add\("native-tool"\)/);
  assert.match(css, /\.native-tool \.app-shell/);
});

test("the main AI view owns work while other tool windows skip it", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(path.join(directory, "app.js"), "utf8");
  // Main and the legacy bundled harness can initialize work; games/newtab cannot.
  assert.match(app, /!startupTool \|\| startupTool === "harness"\) \{\s*legacyPiWorkController = initPiWork\(\);/);
  assert.match(app, /!startupTool \|\| startupTool === "harness"\) \{\s*if \(startupTool === "harness"\) await refresh\(\);/);
  assert.match(app, /if \(!startupTool\) void refreshDesktopAccount\(true\);/);
  assert.doesNotMatch(app, /startupTool === "games"/);
});

test("desktop keeps the icon rail, the contextual sidebar and the workspace in one grid", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(path.join(directory, "index.html"), "utf8");
  const app = readFileSync(path.join(directory, "app.js"), "utf8");
  const rail = html.match(/<nav class="icon-rail"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(rail);
  for (const view of ["feed", "messages", "notifications", "videos", "music", "articles", "market", "settings"]) {
    assert.match(rail, new RegExp(`data-view="${view}"`));
  }
  assert.doesNotMatch(rail, /data-view="hubpedia"/);
  assert.doesNotMatch(rail, /rail-expand-toggle/);
  // 2026-11-02: 元の左の帯に戻した。タイムライン、通知、メッセージが先頭。検索とコミュニティは帯に置かない（コミュニティは内側の列に参加中の一覧を持つ）。
  const firstFour = [...rail.matchAll(/<button[^>]*data-view="([^"]+)"/g)].map((m) => m[1]).slice(0, 4);
  assert.deepEqual(firstFour, ["feed", "notifications", "messages", "videos"]);
  assert.doesNotMatch(rail, /data-view="search"|id="nav-communities"/);
  // スレッドは今もタイムラインの札。ウォレットは右の帯（右列）にある。
  assert.doesNotMatch(rail, /data-view="threads"/);
  assert.doesNotMatch(rail, /data-view="wallet"/);
  assert.doesNotMatch(html.match(/<aside class="sidebar"[\s\S]*?<\/aside>/)?.[0] ?? "", /data-view="wallet"/);
  const compose = rail.match(/<button[^>]*id="desktop-compose"[^>]*>/)?.[0];
  assert.ok(compose, "post button exists in the left column");
  assert.doesNotMatch(compose, /hidden/);
  assert.match(compose, /aria-label="投稿する"/);
  // 並び（2026-11-07 所有者承認 IA.md）: タイムライン、通知、メッセージ、コミュニティ｜動画、音楽、記事、マーケット、すべて｜投稿｜プロフィール、設定。
  const railOrder = ['data-view="feed"', 'data-view="notifications"', 'data-view="messages"', 'data-view="videos"', 'data-view="music"', 'data-view="articles"', 'id="desktop-apps"', 'data-view="market"', 'data-view="browser"', 'data-view="ai"', 'id="desktop-compose"', 'data-view="profile"', 'data-view="settings"'].map((k) => rail.indexOf(k));
  assert.ok(railOrder.every((x, i) => x > 0 && (i === 0 || x > railOrder[i - 1])), "rail order follows IA.md");
  assert.ok(rail.indexOf('id="desktop-compose"') < rail.indexOf('class="icon-rail-bottom"'), "above the bottom group");
  assert.doesNotMatch(rail, /data-view="community"/, "2026-11-09: communities live in the sidebar tree and すべて, not the rail");
  assert.ok(rail.indexOf('id="desktop-compose"') < rail.indexOf('data-view="profile"'));
  const marks = html.match(/<nav class="rail-marks"[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.match(marks, /data-rail-view="wallet"/);
  assert.match(html, /data-rail-view="wallet" hidden><div id="rail-wallet"/);
  // Owner 2026-11-06 (docs/hub-groups/DESIGN.md): notifications, messages, timeline, music, video, browser, AI, wallet last.
  const order = (s, keys) => keys.map((k) => s.indexOf(k));
  const sorted = (xs) => xs.every((x, i) => x > 0 && (i === 0 || x > xs[i - 1]));
  assert.ok(sorted(order(marks, ['data-rail-view="notifications" type', 'data-rail-view="messages" type', 'data-rail-view="posts" type', 'data-rail-view="music" type', 'data-rail-view="video" type', 'data-rail-view="browser" type', 'data-rail-view="ai" type', 'data-rail-view="wallet" type'])), "strip bottom group: browser, AI, wallet");
  assert.match(marks, /rail-mark--bottom/);
  // 投稿ボタンは白黒で --text の塗り、黒金で金の線と字（塗りなし）。値は --ds-btn-primary-*。
  const shellCss = readFileSync(path.join(directory, "desktop-shell.css"), "utf8");
  const railCss = shellCss.slice(shellCss.indexOf("/* ===== 左の記号の帯"), shellCss.indexOf("/* ===== 画面のサイドバーと右列の帯"));
  const composeCss = railCss.slice(railCss.indexOf("#hub-shell .icon-rail #desktop-compose:not([hidden]) {"));
  assert.match(composeCss, /border: 1px solid var\(--ds-btn-primary-line\)/);
  assert.match(composeCss, /background: var\(--ds-btn-primary-bg\)/);
  assert.match(composeCss, /color: var\(--ds-btn-primary-fg\)/);
  assert.doesNotMatch(railCss, /#[0-9a-fA-F]{3,8}|rgb\(|hsl\(|gradient/, "rail css uses tokens only and no gradient fill");
  const mobile = html.match(/<nav class="mobile-nav"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(mobile);
  for (const view of ["feed", "ai", "market", "wallet", "browser", "settings"]) {
    assert.match(mobile, new RegExp(`data-view="${view}"`));
  }
  assert.match(html, /<div\b[^>]*\bclass="app-shell"[^>]*>\s*<header\b[^>]*\bclass="app-toolbar"/);
  for (const action of ["back", "forward", "sidebar", "search"]) assert.match(html, new RegExp(`id="toolbar-${action}"`));
  // 外郭の格子は元の構造: 左の記号の帯（56 / 208）→ 内側の列 → 本文 → 右の帯。型は本文の幅だけを変える。
  const styles = readFileSync(path.join(directory, "styles.css"), "utf8");
  assert.ok(styles.includes(".app-shell:not(.browser-active):not(.sidebar-collapsed){grid-template-columns:var(--rail-w) var(--desktop-sidebar-width,clamp(210px,13.5vw,250px)) minmax(0,1fr) 48px}"));
  assert.ok(styles.includes(".app-toolbar{position:relative;z-index:30;grid-column:1/-1;grid-row:1;"));
  assert.ok(!existsSync(path.join(directory, "desktop-frame.css")), "the 275/88 frame is gone");
  const layouts = readFileSync(path.join(directory, "desktop-layouts.css"), "utf8");
  assert.match(layouts, /\.app-shell \{ --main-w: var\(--ds-col-main\); \}/);
  assert.match(layouts, /\[data-template="wide"\] \{ --main-w: var\(--ds-col-wide\); \}/);
  assert.match(layouts, /\[data-template="reading"\] \{ --main-w: var\(--ds-col-reading\); \}/);
  assert.match(app, /shell\.dataset\.template = templateFor\(view, detailTrail\.at\(-1\)\?\.name\)/);
  assert.match(html, /id="sidebar-ai-new"/);
  // 受信トレイの列は切り替え無しの木：根「メール」と根「連絡先」（2026-11-02）。会話の一覧は本文側に残る。
  assert.doesNotMatch(app, /switchRow\("受信の種類"/);
  assert.match(app, /tree\("メール", "mail"/);
  assert.match(app, /tree\("連絡先", "contacts"/);
});

test("native tool windows do not duplicate the Web Hub shell", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(path.join(directory, "styles.css"), "utf8");
  assert.match(css, /\.native-tool \.app-shell,[^{]*\.native-tool>\.mobile-nav\{display:none\}/);
  assert.match(css, /\.native-tool dialog\{[^}]*width:min\(860px,100%\)/);
});

test("assistant: joins text parts", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] }
  });
  assert.equal(readable(line), "hello\nworld");
});

test("assistant: tool_use becomes → name", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read" }] }
  });
  assert.equal(readable(line), "→ Read");
});

test("result: returns the result text", () => {
  const line = JSON.stringify({ type: "result", result: "done" });
  assert.equal(readable(line), "done");
});

test("reads Codex progress and answers", () => {
  assert.equal(readable(JSON.stringify({ type: "item.started", item: { type: "command_execution" } })), "→ Command");
  assert.equal(readable(JSON.stringify({ type: "item.started", item: { type: "file_change" } })), "→ File change");
  assert.equal(readable(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })), "done");
});

test("unparsable line: returned as-is", () => {
  const line = "not json";
  assert.equal(readable(line), line);
});

test("other type: returns empty string", () => {
  const line = JSON.stringify({ type: "system" });
  assert.equal(readable(line), "");
});

test("content lists and their details keep their own primary destination selected", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const main = source.split("\n").find(line => line.startsWith("  const main = ") && line.includes("contextView"));
  assert.ok(main);
  const select = new Function("contextView", "shell", "document", `const view = contextView;\n${main}\nreturn main;`);
  const primaryViews = new Set(["feed", "threads", "community", "articles", "research", "videos", "music", "market", "wallet", "profile"]);
  const document = {querySelector: selector => primaryViews.has(selector.match(/data-view="([^"]+)"/)[1]) ? {} : null};
  const shell = {dataset:{sidebarContext:"discovery"}};
  for (const view of ["articles", "research", "videos", "music"]) assert.equal(select(view, shell, document), view);
  assert.equal(select("hubpedia", shell, document), "research");
  // 2026-11-02: 元の左の帯に戻した。コミュニティもスレッドもタイムラインの項目の下に付く（帯にコミュニティの項目は無い）。
  for(const view of ["feed","threads","community"])assert.equal(select(view,shell,document),"feed");
  assert.equal(select("community",shell,document),"feed");
  const parents = new Function(`return (${source.match(/const DETAIL_PARENT_VIEW = (\{[\s\S]*?\});/)[1]});`)();
  for (const [detail, view] of [["article","articles"],["hubpedia_article","research"],["research_project","research"],["research_document","research"]]) {
    assert.equal(select(parents[detail], shell, document), view);
  }
  assert.equal(select("cart", {dataset:{sidebarContext:"market"}}, document), "market");
  assert.equal(select("mail", {dataset:{sidebarContext:"messages"}}, document), "messages");
});


for(const name of ["community_guide","community_membership_request","community_members","community_reports","community_report","community_appeals","community_appeal","community_appeal_history"])test("account changes clear private data and invalidate earlier reads: "+name, async () => {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function renderDetailEntry(entry) {");
  const end = source.indexOf("\nasync function openDetail", start);
  const accountStart = source.indexOf("function invalidateDetailContext(reload=true) {");
  const accountEnd = source.indexOf("\nwindow.addEventListener('hub-origin-changed'", accountStart);
  assert.ok(accountStart >= 0 && accountEnd > accountStart);
  const dom = new JSDOM('<nav><button>Private sidebar</button></nav>'), sidebarContext = dom.window.document.querySelector('nav');
  const listeners = {}, requests = [], entry = {name,ids:["private","guide"],channelPolicyState:{note:"private policy"},membershipReviewDraft:{note:"private review"},memberState:{query:"private members"},reportDraft:{note:"private report"},reportPage:{offset:20},appealReviewDraft:{note:"private appeal"},appealSubmitDraft:{note:"private submit"},appealPage:{offset:20}};
  const target = {replaceChildren(...children){this.children=children;}};
  const state = {textContent:"",classList:{remove(){},add(){}}};
  const create = new Function("deps", `
    let researchDetailController=null,communityDetailController=null,communityInviteController=null;
    ${source.slice(source.indexOf('function releaseResearchDetail('),start)}
    let detailRenderRevision=0,researchAccountGeneration=0,currentView="detail";
    const detailTrail=[deps.entry],detailForwardTrail=[],toolbarTrail=[],readingDirectory=new Map(),DETAIL_PARENT_VIEW={},attachDetailAiHandoff=()=>{};
    const {sidebarContext,window,paintDetailHead,detailState,detailContent,skeletonResult,invoke,DETAIL_RENDERERS,communityGuideRequest,communityMembershipReviewRequest,communityReportReviewRequest,communityAppealReviewRequest,friendlyError}=deps;
    ${source.slice(start,end)}
    ${source.slice(accountStart,accountEnd)}
    return renderDetailEntry;
  `);
  const render=create({entry,sidebarContext,communityReportReviewRequest:()=>null,communityAppealReviewRequest:()=>null,window:{addEventListener:(event,handler)=>{listeners[event]=handler;}},communityGuideRequest,communityMembershipReviewRequest,
    paintDetailHead:()=>{},detailState:()=>state,detailContent:()=>target,skeletonResult:()=>"loading",
    invoke:()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),friendlyError:String,
    DETAIL_RENDERERS:{[name]:(node,data)=>node.replaceChildren(data.page.body)}});
  const first=render(entry);requests[0].resolve({page:{body:"private guide"}});await first;assert.deepEqual(target.children,["private guide"]);
  const pending=render(entry);listeners['hub-account-changed']();assert.equal(sidebarContext.childElementCount,0);assert.equal(entry.data,undefined);assert.equal(entry.channelPolicyState,undefined);assert.equal(entry.membershipReviewDraft,undefined);assert.equal(entry.memberState,undefined);assert.equal(entry.reportDraft,undefined);assert.equal(entry.reportPage,undefined);assert.equal(entry.appealReviewDraft,undefined);assert.equal(entry.appealSubmitDraft,undefined);assert.equal(entry.appealPage,undefined);assert.deepEqual(target.children,["loading","loading","loading"]);
  requests[2].reject(Error("not allowed"));await new Promise(setImmediate);assert.deepEqual(target.children,[]);assert.match(state.textContent,/not allowed/);
  requests[1].resolve({page:{body:"old account guide"}});await pending;assert.deepEqual(target.children,[]);assert.equal(entry.data,undefined);dom.window.close();
});

test("account changes clear thread knowledge drafts and refresh the thread viewer", () => {
  const source=readFileSync(new URL("./app.js",import.meta.url),"utf8");
  const start=source.indexOf("function invalidateDetailContext(reload=true) {");
  const end=source.indexOf("\nwindow.addEventListener('hub-origin-changed'",start);
  assert.ok(start >= 0 && end > start);
  const dom=new JSDOM('<nav><button>Private sidebar</button></nav>'),sidebarContext=dom.window.document.querySelector('nav');
  const entry={name:"thread",knowledge:{proposal:"previous account draft"},replyDraft:"reply",data:{viewer:"owner"}},events={},reads=[];
  new Function("entry","window","renderDetailEntry","sidebarContext",
    "let researchDetailController=null,communityDetailController=null,communityInviteController=null,researchAccountGeneration=0,detailRenderRevision=0,currentView='detail';const detailTrail=[entry],detailForwardTrail=[],toolbarTrail=[];"+source.slice(source.indexOf("function releaseResearchDetail("),source.indexOf("async function renderDetailEntry("))+source.slice(start,end)
  )(entry,{addEventListener:(name,handler)=>{events[name]=handler;}},item=>reads.push(item),sidebarContext);
  events['hub-account-changed']();assert.equal(sidebarContext.childElementCount,0);assert.equal(entry.knowledge,undefined);assert.equal(entry.replyDraft,undefined);assert.equal(entry.data,undefined);assert.deepEqual(reads,[entry]);dom.window.close();
});

test("the account-bound detail invoke rejects a late read or write result and prevents requests after switching",async()=>{
  const source=readFileSync(new URL("./app.js",import.meta.url),"utf8"),start=source.indexOf("function researchEditorOptions(entry) {");
  const end=source.indexOf("function invalidateDetailContext(reload=true) {",start);
  for(const name of ["hub_detail","hub_action","hub_client_action"]){
    let done,calls=0;
    const frame=new Function("invoke","friendlyError",
      "const offerPublicContentShare=()=>false;let researchAccountGeneration=0;"+source.slice(start,end)+"return {options:researchEditorOptions({}),change:()=>researchAccountGeneration++};"
    )(()=>{calls++;return new Promise(resolve=>done=resolve);},String);
    const pending=frame.options.invoke(name,{});frame.change();done({saved:true});
    await assert.rejects(pending,/接続が変わりました/);await assert.rejects(frame.options.invoke(name,{}),/接続が変わりました/);assert.equal(calls,1);
  }
});

test('member refresh preserves saved feedback on a failed or mismatched read and clears only acknowledged targets after a valid read',async()=>{
 const source=readFileSync(new URL('./app.js',import.meta.url),'utf8'),start=source.indexOf('function renderCommunityMembers('),end=source.indexOf('\nfunction renderCommunityGuides',start);
 const saved={saved:true,message:'saved'},pending={saved:false,note:'keep draft'},memberState={query:'member',page:1,targets:new Map([['p1',saved],['p2',pending]])},entry={ids:['c1'],memberState,data:{communityId:'c1',members:[]}};
 const target={replaceChildren(...items){this.items=items;}},current=entry.data;
 let result=Error('offline');
 const render=new Function('entry','target','options','communityMemberControls','let currentView="detail";const detailTrail=[entry],document={};const researchEditorOptions=()=>options;'+source.slice(start,end)+';return renderCommunityMembers;')(entry,target,{invoke:async()=>{if(result instanceof Error)throw result;return result;}},(_document,options)=>options);
 render(target,current,entry);const old=target.items[0];
 await assert.rejects(old.refresh(),/offline/);assert.equal(target.items[0],old);assert.equal(memberState.targets.get('p1'),saved);
 result={communityId:'foreign',members:[]};await assert.rejects(old.refresh(),/一覧を確認/);assert.equal(entry.data,current);assert.equal(memberState.targets.get('p1'),saved);
 result={communityId:'c1',members:[{id:'p1',role:'member',status:'muted'}]};await old.refresh();assert.equal(entry.data,result);assert.equal(memberState.targets.has('p1'),false);assert.equal(memberState.targets.get('p2'),pending);assert.equal(memberState.query,'member');assert.equal(memberState.page,1);assert.notEqual(target.items[0],old);
});

test('research reference navigation retains the exact version and refuses ambiguous queries',()=>{
  const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
  const start=source.indexOf('function detailForHubPath(path) {'),end=source.indexOf('\n}',start)+2;
  const detail=new Function(`return (${source.slice(start,end)});`)();
  assert.deepEqual(detail('/v2/research/p?document=d&version=2'),{name:'research_revision',ids:['p','d','2'],title:'文書 · v2'});
  assert.deepEqual(detail('/v2/research/p?document=d'),{name:'research_document',ids:['p','d'],title:'文書'});
  for(const query of ['document=d&version=0','document=d&version=1e2','document=d&version=9007199254740992','document=d&version=1&version=2','document=d&document=x&version=1','version=1'])assert.equal(detail(`/v2/research/p?${query}`),null);
});

test('thread references return to the pinned document and disappear for hidden posts',()=>{
  const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
  const start=source.indexOf('function threadPostCard('),end=source.indexOf('function renderThreadDetail(');
  const {document}=new JSDOM('<body></body>').window;
  let opened;
  const card=new Function('document','window','relTime','researchDiscussionReference','researchGitDiscussionReference','openHubPath','createPostRow','icon','paintAvatar','hubAsset','addBaitRow',`${source.slice(start,end)};return threadPostCard;`)(document,document.defaultView,()=>'',researchDiscussionReference,researchGitDiscussionReference,href=>{opened=href;},createPostRow,()=>'',()=>{},()=>{},()=>null);
  const post={id:'post',no:1,body:`A research discussion\nsha256:${'a'.repeat(64)}\n/v2/research/p?document=d&version=2`};
  const visible=card(post,{},()=>{}),link=visible.querySelector('.detail-link');
  assert.equal(link.textContent,'参照した文書の版（v2）');link.click();assert.equal(opened,'/v2/research/p?document=d&version=2');
  assert.ok(visible.textContent.includes('A research discussion'));
  for(const state of ['deletedAt','moderatedAt','viewerMuted','viewerBlocked'])assert.equal(card({...post,[state]:true},{},()=>{}).querySelector('.detail-link'),null);
});

test('visible Git discussion returns to the same commit and hidden posts expose no reference',()=>{
  const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
  const start=source.indexOf('function threadPostCard('),end=source.indexOf('function renderThreadDetail(');
  const {document}=new JSDOM('<body></body>').window;
  let opened;
  const card=new Function('document','window','relTime','researchDiscussionReference','researchGitDiscussionReference','openHubPath','createPostRow','icon','paintAvatar','hubAsset','addBaitRow',`${source.slice(start,end)};return threadPostCard;`)(document,document.defaultView,()=>'',researchDiscussionReference,researchGitDiscussionReference,href=>{opened=href;},createPostRow,()=>'',()=>{},()=>{},()=>null);
  const p='rp_'+'a'.repeat(32),oid='b'.repeat(40),href=`/v2/research/${p}?commit=${oid}#git`;
  const post={id:'post',no:1,body:`A Git discussion\n\n参照Git: Project / Fix\n${oid}\n${href}`};
  const visible=card(post,{},()=>{}),link=visible.querySelector('.detail-link');
  assert.equal(link.textContent,`参照したコードの変更（${oid.slice(0,12)}）`);link.click();assert.equal(opened,href);
  for(const state of ['deletedAt','moderatedAt','viewerMuted','viewerBlocked'])assert.equal(card({...post,[state]:true},{},()=>{}).querySelector('.detail-link'),null);
});

for (const [name, shipping, amount, pending] of [
  ['unknown', [null], '2,400', true],
  ['zero', [0], '2,400', false],
  ['known', [300], '2,700', false],
  ['mixed', [null, 0, 300], '5,100', true],
]) test(`actual cart DOM preserves ${name} shipping without claiming unknown shipping is included`, async t => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function renderCart() {');
  const end = source.indexOf('\nlet checkoutBusy = false;', start);
  assert.ok(start >= 0 && end > start);
  const dom = new JSDOM('<div id="cart-state"></div><div id="cart-lines"></div><section id="cart-summary"><div id="cart-review"></div><div id="cart-totals"></div><select id="cart-asset"></select></section>');
  t.after(() => dom.window.close());
  const {document} = dom.window;
  const entries = shipping.map((shippingJpyc, index) => ({
    product: {id: `sale-${index}`, title: `商品${index}`, priceJpyc: 1200, shippingJpyc, stockQuantity: 4,
      seller: {publicName: '販売者', legalDisplayUrl: 'https://seller.example/legal'}},
    quantity: index === 0 ? 2 : 1, saved: index === 0,
  }));
  const shop = {cart: Object.fromEntries(entries.map(({product, quantity}) => [product.id, quantity])),
    assertions: {}, zones: {}, assets: [{currency: 'JPYC', chainId: 137, chainName: 'Polygon'}], prepared: null};
  const calls = [];
  const {renderCart: renderCartRows} = await import('./market-me.mjs');
  const render = new Function('document', 'shop', 'entries', 'calls', 'renderCartRows', `
    const hubAsset = () => {}, shopCartLocked = () => false, openDetail = () => {}, discardPrepared = async () => true, updateCartBadge = () => {}, shopSave = () => {}, confirmFulfillment = () => {}, showNotice = () => {};
    const checkoutBusy = false, checkoutRequests = [], checkoutAttempt = null, checkoutPendingError = '', checkoutFinishError = '', checkoutSelection = null;
    const refreshCheckoutPending = async () => calls.push('pending-read');
    const cartLines = () => entries, renderCartReview = () => {}, syncCartControls = () => {};
    const invoke = () => { throw Error('unexpected external operation'); };
    ${source.slice(start, end)}
    return renderCart;
  `)(document, shop, entries, calls, renderCartRows);
  await render();
  assert.deepEqual(calls, ['pending-read']);
  const lines = [...document.querySelectorAll('#cart-lines .mk-row')];
  assert.equal(lines.length, entries.length);
  entries.forEach(({product, quantity}, index) => {
    const price = lines[index].querySelector('.mk-row-price').textContent;
    assert.match(lines[index].textContent, /販売者/);
    assert.match(lines[index].textContent, /販売条件・返品/);
    // 行の金額は商品分だけ（送料は合計の欄で扱う）。送料込みとは言わない。
    assert.equal(price, `${(product.priceJpyc * quantity).toLocaleString()} JPYC`);
    assert.doesNotMatch(lines[index].textContent, /送料込/);
  });
  const total = document.querySelector('#cart-totals dl > div');
  assert.equal(total.querySelector('dt').textContent, pending ? '商品・確認済み送料（税込・目安）' : '商品・送料（税込・目安）');
  assert.equal(total.querySelector('dd').textContent, `${amount} JPYC${pending ? ' ＋ 未確定送料（注文時に確認）' : ''}`);
  assert.equal(document.querySelector('#cart-asset').value, '137:JPYC');
  assert.match(document.querySelector('#cart-totals').textContent, /確定額は注文時にCommerceが表示/);
});

// Owner 2026-10-18: games open the Hub games list; info moves into settings.
test("rail ゲーム opens /v2/games, local launch sits there, 情報 lives in settings", async () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const rail = html.match(/<nav class="icon-rail[\s\S]*?<\/nav>/)?.[0] ?? html;
  assert.ok(rail.includes('id="desktop-apps"'), "すべての機能 stays in the rail");
  assert.doesNotMatch(rail, /data-short-label="情報"/);
  assert.match(html, /<button class="nav-item" data-view="games"/);
  assert.doesNotMatch(rail, /data-view="(games|research)"/);
  // 2026-11-09 所有者決定: マーケット・ブラウザ・AIは左の列の下（投稿の上）。
  assert.ok(rail.indexOf('id="desktop-apps"') < rail.indexOf('data-view="market"') && rail.indexOf('data-view="market"') < rail.indexOf('data-view="browser"') && rail.indexOf('data-view="browser"') < rail.indexOf('data-view="ai"') && rail.indexOf('data-view="ai"') < rail.indexOf('id="desktop-compose"'));
  assert.doesNotMatch(html, /id="view-games"/);
  assert.match(app, /resource: "games_store"/);
  assert.doesNotMatch(app, /#rail-games"\)\.onclick/);
  assert.doesNotMatch(html, /browser-local-games/);
  assert.doesNotMatch(app, /onLocalGames/);
  assert.doesNotMatch(html, /data-settings-sec="app-info"/);
  assert.match(html, /data-settings-panel="advanced"[\s\S]*id="settings-about-panel"[^>]*desktop-rail-toggle/);
});
