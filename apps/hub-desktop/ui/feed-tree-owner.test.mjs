import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, settle, source } from "./sidebar-context.fixture.mjs";

// フィードの木の行を押しても列は入れ替わらない（2026-11-02、所有者の指定）。
// ブックマークとリストの画面は同じ作りの木（根は「ブックマーク」「リスト」）。
const roots = (f) => [...f.document.querySelectorAll("#sidebar-context .sidebar-tree-root")].map((node) => node.textContent);
const current = (f) => [...f.document.querySelectorAll("#sidebar-context [aria-current]")].map((node) => node.textContent);
const byText = (f, text) => [...f.document.querySelectorAll("#sidebar-context .sidebar-context-item")].find((node) => node.textContent.includes(text));
const FEED_ROOTS = ["フィード", "スレッド", "コミュニティ"];
// 木の行が押す「アイコンの列」の行き先（app.js の railGo と同じ探し方）。押された回数を数える。
const railTarget = (f, view) => f.document.querySelector(`.icon-rail [data-view="${view}"], #primary-nav [data-view="${view}"], .account-nav [data-view="${view}"]`);
const watch = (f, view) => { const hits = []; railTarget(f, view).addEventListener("click", () => hits.push(view)); return hits; };

async function feedWithTree() {
  const f = fixture();
  f.show("feed");
  await settle();
  return f;
}

test("clicking a tag in the feed tree keeps the feed tree and marks the tag current", async () => {
  const f = await feedWithTree();
  byText(f, "#UI").click();
  assert.deepEqual(f.calls.filter(([kind]) => kind === "detail"), [["detail", "tag", "UI"]]);
  f.state.currentView = "detail";
  f.state.detailTrail = [{ name: "tag", ids: ["UI"] }];
  f.api.renderSidebarContext("detail");
  await settle();
  assert.deepEqual(roots(f), FEED_ROOTS);
  assert.equal(f.document.querySelector(".sidebar .brand h1").textContent, "フィード");
  assert.deepEqual(current(f), ["#UI"]);
  f.dom.window.close();
});

test("clicking a list in the feed tree keeps the feed tree and marks the list current", async () => {
  const f = await feedWithTree();
  byText(f, "友だち").click();
  assert.deepEqual(f.calls.filter(([kind]) => kind === "detail"), [["detail", "list", "list-1"]]);
  f.state.currentView = "detail";
  f.state.detailTrail = [{ name: "list", ids: ["list-1"] }];
  f.api.renderSidebarContext("detail");
  await settle();
  assert.deepEqual(roots(f), FEED_ROOTS);
  assert.deepEqual(current(f), ["友だち2"]);
  f.dom.window.close();
});

test("話題を探す, すべて見る, 探す・作る and コミュニティを探す open their view with the feed tree still in place", async () => {
  for (const [label, view] of [["話題を探す", "search"], ["すべて見る", "lists"], ["探す・作る", "threads"], ["コミュニティを探す", "community"]]) {
    const f = await feedWithTree();
    const hits = watch(f, view);
    byText(f, label).click();
    assert.deepEqual(hits, [view], `${label} asks for ${view}`);
    f.show(view);
    await settle();
    assert.deepEqual(roots(f), FEED_ROOTS, label);
    assert.ok(current(f).includes(label), `${label} is current`);
    assert.equal(f.document.querySelector("#sidebar-context .sidebar-mine"), null, "no lower block");
    f.dom.window.close();
  }
});

test("a joined community row also keeps the feed tree (the row marks the owner before opening)", () => {
  assert.match(source, /onOpen: \(row\) => \{ if \(communitiesHost\.closest\("\.sidebar-tree"\)\) sidebarContextOwner = "feed"; void openDetail\("community"/);
});

test("navigating from the icon rail restores the normal context for that view", async () => {
  const f = await feedWithTree();
  byText(f, "話題を探す").click();
  f.show("search");
  assert.deepEqual(roots(f), FEED_ROOTS);
  // ユーザーがアイコンの列を直接押す（木の行ではない）。
  railTarget(f, "search").click();
  f.show("search");
  assert.deepEqual(roots(f), [], "the search view gets its own column again");
  f.dom.window.close();
});

test("opening a post from the main column drops the feed tree (a detail that is not a tree destination)", async () => {
  const f = await feedWithTree();
  byText(f, "#UI").click();
  f.state.currentView = "detail";
  f.state.detailTrail = [{ name: "post", ids: ["post-1"] }];
  f.api.renderSidebarContext("detail");
  assert.notDeepEqual(roots(f), FEED_ROOTS);
  f.dom.window.close();
});

test("the lists view entered any other way gets the lists tree: roots ブックマーク and リスト, no 保存したもの, no すべてのリスト", async () => {
  const f = fixture();
  f.show("lists");
  await settle();
  assert.deepEqual(roots(f), ["ブックマーク", "リスト"]);
  const text = f.document.querySelector("#sidebar-context").textContent;
  assert.ok(!text.includes("保存したもの"));
  assert.ok(!text.includes("すべてのリスト"));
  const kids = [...f.document.querySelectorAll("#sidebar-context .sidebar-tree-children .sidebar-context-item")].map((node) => node.textContent);
  assert.deepEqual(kids, ["友だち2", "すべて見る"], "the user's lists hang under リスト, すべて見る last");
  assert.equal(f.document.querySelector("#sidebar-context .sidebar-tree-children .is-tree-last").textContent, "すべて見る");
  assert.deepEqual(current(f), ["リスト"], "the リスト root is current in the lists view");
  f.dom.window.close();
});

test("the bookmarks view uses the same tree with ブックマーク current; a list detail marks that list", async () => {
  const f = fixture();
  f.show("bookmarks");
  await settle();
  assert.deepEqual(roots(f), ["ブックマーク", "リスト"]);
  assert.deepEqual(current(f), ["ブックマーク"]);
  f.state.currentView = "detail";
  f.state.detailTrail = [{ name: "list", ids: ["list-1"] }];
  f.api.renderSidebarContext("detail");
  assert.deepEqual(roots(f), ["ブックマーク", "リスト"]);
  assert.deepEqual(current(f), ["友だち2"]);
  f.dom.window.close();
});

test("the リスト root opens the all-lists view through the icon rail", async () => {
  const f = fixture();
  f.show("bookmarks");
  await settle();
  const hits = watch(f, "lists");
  f.document.querySelectorAll("#sidebar-context .sidebar-tree-root")[1].click();
  assert.deepEqual(hits, ["lists"]);
  f.dom.window.close();
});
