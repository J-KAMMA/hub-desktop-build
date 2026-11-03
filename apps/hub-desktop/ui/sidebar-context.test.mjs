// 内側左列（#sidebar-context）の画面ごとの中身（2026-10-15、旦那様「内側左列の使い方が下手すぎる」と参考画面）。
// 動画は「上の段 → フォロー中 › → マイページ ›」、音楽・フィード・記事は「上の段 → マイページ ›」の骨組み（フォロー中は動画だけ）。カテゴリとタグは本文の上のチップ。
// 列はアイコンの列の行き先を繰り返さない（マイページだけは本人の画面を開く）。中身が無い画面では列ごと畳む。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture, settle, source, css, html, WITH_CONTENT, EMPTY } from "./sidebar-context.fixture.mjs";

test("each view's column holds its own navigation and never repeats a rail destination ", async () => {
  const f = fixture();
  for (const view of WITH_CONTENT) { f.show(view); await settle(); }
  for (const view of WITH_CONTENT) {
    f.show(view);
    assert.equal(f.shell.classList.contains("sidebar-collapsed"), false, `${view} keeps the column open`);
    assert.ok(f.items().length >= 1, `${view} has at least its home row`);
    for (const node of f.items()) {
      f.calls.length = 0;
      node.click();
      // マーケットの木（マーケット/自分）は、買い物の画面どうしの行き来でマーケットへ戻る（木の根が行き先）。
      assert.deepEqual(f.calls.filter(([kind, target]) => kind === "rail" && !(["market", "cart", "purchased", "order"].includes(view) && target === "market")), [], `${view}: "${node.textContent}" does not jump to a rail destination`);
      f.show(view);
    }
  }
  f.dom.window.close();
});

test("profile keeps the column open and mirrors the body's sections as selected rows", async () => {
  const f = fixture();
  f.show("profile");
  await settle();
  f.show("profile");
  assert.equal(f.shell.classList.contains("sidebar-collapsed"), false, "profile has its own rows");
  const rows = f.items().slice(1); // 先頭は根「プロフィール」
  const labels = [...f.document.querySelectorAll("#sidebar-context .sidebar-item-label")].map((node) => node.textContent);
  assert.deepEqual(labels, ["プロフィール", "投稿", "メディア", "スレッド"]);
  assert.deepEqual([...f.document.querySelectorAll("#sidebar-context .sidebar-item-meta")].map((node) => node.textContent), ["1", "1"]);
  assert.ok(rows[0].classList.contains("on"));
  assert.equal(rows[0].getAttribute("aria-current"), "true");
  f.calls.length = 0;
  rows[1].click();
  assert.deepEqual(f.calls.filter(([kind]) => kind === "rail"), [], "a section row never jumps to a rail destination");
  const after = f.items().slice(1);
  assert.equal(after[1].classList.contains("on"), true, "the pressed section is selected");
  assert.equal(after[1].getAttribute("aria-current"), "true");
  assert.equal(after[0].classList.contains("on"), false);
  assert.equal(f.document.querySelector("#profile-posts .profile-panel").dataset.tab, "media", "the body follows the same tab");
  f.dom.window.close();
});

test("videos, music, feed and articles are curved-line trees; no heading rows, no マイページ section (2026-11-02)", async () => {
  const f = fixture();
  const expected = {
    videos: { roots: ["ホーム", "ショート", "フォロー中", "ライブラリ"], rows: ["あとで見る", "再生リスト", "履歴", "自分の動画"], title: "動画を見る" },
    music: { roots: ["ホーム", "ライブラリ"], rows: ["お気に入り", "プレイリスト", "アーティスト"], title: "音楽を聴く" },
    feed: { roots: ["フィード", "スレッド", "コミュニティ"], rows: [], title: "フィード" },
    articles: { roots: ["ホーム", "マガジン"], rows: ["フォロー中のタグ", "下書き", "シリーズ", "保存した記事"], title: "記事を読む" },
  };
  for (const [view, shape] of Object.entries(expected)) {
    f.show(view);
    await settle();
    f.show(view);
    assert.equal(f.document.querySelector(".sidebar .brand h1").textContent, shape.title);
    const roots = [...f.document.querySelectorAll("#sidebar-context .sidebar-tree-root")];
    assert.deepEqual(roots.map((node) => node.textContent), shape.roots, `${view} roots`);
    assert.ok(roots.every((node) => node.querySelector("svg.sidebar-icon")), `${view} roots carry an icon`);
    assert.deepEqual(f.headings(), [], `${view}: no heading rows (no フォロー中 ›)`);
    assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-divider").length, 0, `${view} dividers`);
    const hasChannels = view === "videos";
    assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-channel-row").length, hasChannels ? 30 : 0, `${view}: the first page of channels`);
    const rowLabels = [...f.document.querySelectorAll("#sidebar-context .sidebar-tree-children .sidebar-item-label, #sidebar-context .sidebar-tree-children .sidebar-tree-sub")].map((node) => node.textContent);
    for (const item of shape.rows) assert.ok(rowLabels.includes(item), `${view}: "${item}" stays reachable as a tree row`);
    assert.ok(!f.document.querySelector("#sidebar-context").textContent.includes("マイページ"), `${view}: no マイページ section`);
    assert.equal(f.document.querySelectorAll("#sidebar-context [data-sidebar-mypage]").length, 0, `${view}: no マイページ marks`);
    assert.equal(f.document.querySelectorAll("#sidebar-context .nav-group").length, 0, `${view}: no categories or tags in the column`);
    assert.ok(!f.labels().some((label) => /すべて表示|もっと見る/u.test(label)), `${view}: no "show all" row`);
  }
  f.dom.window.close();
});

test("channels page in with a keyset cursor and keep scrolling in the one column", async () => {
  const f = fixture();
  f.show("videos");
  await settle();
  f.show("videos");
  assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-more-sentinel").length, 1, "a sentinel waits at the end");
  await f.api.sidebarRemote.more("videos");
  f.show("videos");
  const rows = [...f.document.querySelectorAll("#sidebar-context .sidebar-channel-row")];
  assert.equal(rows.length, 34, "all of them, no cap");
  assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-more-sentinel").length, 0, "no sentinel after the last page");
  assert.equal(f.document.querySelectorAll("#sidebar-context [style*='overflow']").length, 0, "no nested scroll area");
  // 顔は Hub の "/" 始まりの画像だけ。外の URL は頭字に落とす。
  assert.equal(rows[0].querySelector("img")?.getAttribute("src"), "https://hub.invalid/api/avatars/p0.png");
  assert.equal(rows[1].querySelector("img"), null);
  assert.equal(rows[1].querySelector(".sidebar-avatar").textContent, "V");
  // フォロー中の人 = 動画のチャンネル。押すとその人のチャンネルページを開く（検索には変えない）。
  f.calls.length = 0;
  rows[2].click();
  assert.deepEqual(f.calls.filter(([kind]) => kind === "videoMode" || kind === "searchVideos" || kind === "videoChannel"), [["videoChannel", "h2"]]);
  for (const view of ["feed", "music", "articles"]) {
    f.show(view);
    await settle();
    f.show(view);
    assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-channel-row").length, 0, `${view}: no channel rows`);
  }
  f.dom.window.close();
});

test("the フォロー中 root opens its page; music keeps its tree; signed-out videos skip channels", async () => {
  const f = fixture();
  f.show("videos");
  await settle();
  f.show("videos");
  f.calls.length = 0;
  [...f.document.querySelectorAll("#sidebar-context .sidebar-tree-root")].find((node) => node.textContent === "フォロー中").click();
  assert.deepEqual(f.calls.at(-1), ["videoMode", "subscriptions"]);
  f.show("music");
  assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-heading.is-link").length, 0, "music has no heading link");
  assert.deepEqual(f.labels(), ["ホーム", "ライブラリ", "お気に入り", "プレイリスト", "アーティスト"], "music is a tree: ホーム / ライブラリ (お気に入り・プレイリスト・アーティスト); no upload row without an upload path");
  f.calls.length = 0;
  [...f.document.querySelectorAll("#sidebar-context .sidebar-nav-row")].find((node) => node.textContent === "アーティスト").click();
  assert.deepEqual(f.calls.at(-1), ["detail", "music_artists"]);
  await settle();
  f.dom.window.close();
  const signedOut = fixture({ registered: false });
  signedOut.show("videos");
  assert.deepEqual(signedOut.headings(), []);
  assert.deepEqual([...signedOut.document.querySelectorAll("#sidebar-context .sidebar-tree-root")].map((node) => node.textContent), ["ホーム", "ショート", "ライブラリ"], "no フォロー中 root without an account");
  assert.equal(signedOut.calls.filter(([kind]) => kind === "invoke").length, 0, "no Hub read without an account");
  signedOut.dom.window.close();
});

test("views with nothing of their own collapse the column, and it reopens on the next view with content", async () => {
  const f = fixture();
  f.show("feed");
  await settle();
  for (const view of EMPTY) {
    f.show("feed");
    assert.equal(f.shell.classList.contains("sidebar-collapsed"), false);
    f.show(view);
    assert.equal(f.shell.classList.contains("sidebar-collapsed"), true, `${view} collapses`);
    assert.equal(f.shell.classList.contains("sidebar-empty-view"), true);
    assert.deepEqual(f.labels(), [], `${view} shows no filler`);
  }
  f.show("music");
  assert.equal(f.shell.classList.contains("sidebar-collapsed"), false, "reopens for a view with content");
  // 利用者が自分で畳んだ列は、中身のある画面へ移っても畳んだまま。
  f.shell.classList.add("sidebar-collapsed");
  f.show("profile");
  f.show("feed");
  assert.equal(f.shell.classList.contains("sidebar-collapsed"), true, "a user's own collapse is kept");
  await settle();
  f.dom.window.close();
});

test("messages: the column is the メール / 連絡先 tree, the DM list stays in the page, there is no switch", () => {
  const f = fixture();
  f.show("messages");
  assert.equal(f.document.querySelector(".messages-side").parentElement, f.document.querySelector(".messages-layout"));
  assert.equal(f.document.querySelector(".sidebar-switch"), null);
  assert.deepEqual([...f.document.querySelectorAll("#sidebar-context .sidebar-tree-root")].map((node) => node.textContent), ["メール", "連絡先"]);
  f.dom.window.close();
});

test("one inner-column toggle: the toolbar button; the brand-row buttons are gone", () => {
  assert.match(html, /id="toolbar-sidebar"/);
  assert.doesNotMatch(html, /desktop-sidebar-collapse|desktop-sidebar-expand/);
  assert.doesNotMatch(source, /desktop-sidebar-collapse|desktop-sidebar-expand/);
  const shortcuts = readFileSync(new URL("./shortcuts.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(shortcuts, /desktop-sidebar-expand/);
});

test("the column and chips use tokens only, with a neutral focus ring and inverted selected chips", () => {
  assert.match(css, /#hub-shell:not\(\.sidebar-collapsed\) #view-market > \.segmented \{ display: none; \}/);
  assert.match(css, /\.sidebar-chip\[aria-pressed="true"\] \{ background: var\(--text\); color: var\(--bg\); \}/);
  assert.match(css, /\.sidebar-nav-row \{[^}]*min-height: 40px;[^}]*border-radius: var\(--radius-sm\);/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\bwhite\b(?!-)|\bblack\b|\bred\b/);
  for (const focus of css.match(/:focus-visible[^}]*\}/g) ?? []) assert.match(focus, /var\(--focus-ring\)/);
  assert.match(html, /<link rel="stylesheet" href="\.\/sidebar-context\.css">/);
});

test("the feed column is a tree of three roots with their children under the right root", async () => {
  const f = fixture();
  f.show("feed");
  await settle();
  f.show("feed");
  await settle();
  const trees = [...f.document.querySelectorAll("#sidebar-context > .sidebar-tree")];
  assert.equal(trees.length, 3, "three roots");
  assert.deepEqual(trees.map((tree) => tree.querySelector(".sidebar-tree-root").textContent), ["フィード", "スレッド", "コミュニティ"]);
  const kids = trees.map((tree) => [...tree.querySelectorAll(".sidebar-tree-children > *, .sidebar-tree-children .nav-communities > *")].filter((node) => !node.classList.contains("nav-communities")));
  const text = (nodes) => nodes.filter((node) => !node.classList.contains("nav-community-all")).map((node) => node.textContent.trim());
  assert.deepEqual(text(kids[0]), ["フォロー中のタグ", "#UI", "#音楽", "話題を探す", "リスト", "友だち2", "すべて見る"]);
  assert.deepEqual(text(kids[1]), ["探す・作る"]);
  assert.deepEqual(text(kids[2]), ["設計", "音楽", "写真", "コミュニティを探す"]);
  assert.deepEqual([...trees[0].querySelectorAll(".sidebar-tree-sub")].map((node) => node.textContent), ["フォロー中のタグ", "リスト"]);
  // 根は枝の外にあり、線の入れ物（.sidebar-tree-children）に入らない。
  for (const tree of trees) assert.equal(tree.querySelector(".sidebar-tree-children .sidebar-tree-root"), null);
  // 各根の最初と最後の枝に印が付く（最後は曲がり角だけ）。
  for (const tree of trees) {
    assert.equal(tree.querySelectorAll(".is-tree-first").length, 1);
    assert.equal(tree.querySelectorAll(".is-tree-last").length, 1);
  }
  assert.equal(trees[0].querySelector(".is-tree-last").textContent, "すべて見る");
  assert.equal(trees[1].querySelector(".is-tree-last").textContent, "探す・作る");
  assert.equal(trees[2].querySelector(".is-tree-last").textContent, "コミュニティを探す");
  assert.equal(trees[0].querySelector(".is-tree-first").textContent, "フォロー中のタグ");
  assert.equal(trees[2].querySelector(".is-tree-first").textContent, "設計");
  // 根の動作はこれまでどおり。
  f.calls.length = 0;
  trees[1].querySelector(".sidebar-tree-root").click();
  trees[2].querySelector(".sidebar-tree-root").click();
  assert.deepEqual(f.calls.filter(([kind]) => kind === "social"), [["social", "mixed", "thread", "latest"], ["social", "mixed", "community", "latest"]]);
  f.calls.length = 0;
  trees[0].querySelectorAll(".sidebar-tree-children .sidebar-context-item")[0].click();
  assert.deepEqual(f.calls.at(-1), ["detail", "tag", "UI"]);
  f.dom.window.close();
});

test("a root without data children still shows its find row", async () => {
  const f = fixture({ registered: false });
  f.show("feed");
  const trees = [...f.document.querySelectorAll("#sidebar-context > .sidebar-tree")];
  assert.equal(trees.length, 3);
  assert.equal(trees[2].querySelector(".sidebar-tree-children").textContent, "コミュニティを探す");
  assert.equal(trees[2].querySelectorAll(".is-tree-last").length, 1);
  f.dom.window.close();
});

test("the notifications column's heading is 通知, not the tree's 絞り込み group (2026-11-03)", async () => {
  const f = fixture();
  f.show("notifications");
  await settle();
  f.show("notifications");
  assert.equal(f.document.querySelector(".sidebar .brand h1").textContent, "通知");
  f.dom.window.close();
});
