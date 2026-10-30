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
      assert.deepEqual(f.calls.filter(([kind]) => kind === "rail"), [], `${view}: "${node.textContent}" does not jump to a rail destination`);
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
  const rows = f.items();
  const labels = [...f.document.querySelectorAll("#sidebar-context .sidebar-item-label")].map((node) => node.textContent);
  assert.deepEqual(labels, ["投稿", "メディア", "スレッド"]);
  assert.deepEqual([...f.document.querySelectorAll("#sidebar-context .sidebar-item-meta")].map((node) => node.textContent), ["1", "1"]);
  assert.ok(rows[0].classList.contains("on"));
  assert.equal(rows[0].getAttribute("aria-current"), "true");
  f.calls.length = 0;
  rows[1].click();
  assert.deepEqual(f.calls.filter(([kind]) => kind === "rail"), [], "a section row never jumps to a rail destination");
  const after = f.items();
  assert.equal(after[1].classList.contains("on"), true, "the pressed section is selected");
  assert.equal(after[1].getAttribute("aria-current"), "true");
  assert.equal(after[0].classList.contains("on"), false);
  assert.equal(f.document.querySelector("#profile-posts .profile-panel").dataset.tab, "media", "the body follows the same tab");
  f.dom.window.close();
});

test("only videos carry フォロー中 ›; no view has a マイページ section (2026-10-18)", async () => {
  const f = fixture();
  const expected = {
    videos: { top: ["ホーム", "ショート"], library: ["履歴", "再生リスト", "あとで見る", "自分の動画"], title: "動画を見る" },
    music: { top: ["ホーム", "公開曲", "外部作品", "フォロー中の新着"], library: ["履歴", "再生リスト", "お気に入り"], title: "音楽を聴く" },
    feed: { top: ["ホーム", "スレッド", "コミュニティ"], library: [], title: "フィード" },
    articles: { top: ["ホーム"], library: ["保存した記事", "下書き"], title: "記事を読む" },
  };
  for (const [view, shape] of Object.entries(expected)) {
    f.show(view);
    await settle();
    f.show(view);
    assert.equal(f.document.querySelector(".sidebar .brand h1").textContent, shape.title);
    const nodes = [...f.document.querySelector("#sidebar-context").children];
    const top = nodes.slice(0, shape.top.length).map((node) => node.textContent);
    assert.deepEqual(top, shape.top, `${view} top rows`);
    assert.ok(nodes.slice(0, shape.top.length).every((node) => node.querySelector("svg.sidebar-icon")), `${view} top rows carry an icon`);
    const hasChannels = view === "videos";
    assert.deepEqual(f.headings(), hasChannels ? ["フォロー中›"] : [], `${view} headings`);
    assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-divider").length, hasChannels ? 1 : 0, `${view} dividers`);
    assert.equal(nodes.at(-1).tagName === "HR", false, `${view}: no trailing divider`);
    assert.equal(nodes.filter((node, index) => node.tagName === "HR" && nodes[index + 1]?.tagName === "HR").length, 0, `${view}: no doubled divider`);
    const channels = [...f.document.querySelectorAll("#sidebar-context .sidebar-channel-row")];
    assert.equal(channels.length, hasChannels ? 30 : 0, `${view}: the first page of channels`);
    assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-note").length, 0, `${view}: no channel placeholder`);
    assert.ok(channels.every((node) => node.querySelector(".sidebar-avatar")));
    const rowLabels = nodes.filter((node) => node.classList.contains("sidebar-nav-row")).map((node) => node.textContent);
    for (const item of shape.library) assert.ok(rowLabels.includes(item), `${view}: "${item}" stays reachable as a plain row`);
    assert.ok(!nodes.some((node) => node.textContent.includes("マイページ")), `${view}: no マイページ section`);
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
  // 動画のチャンネルを押すと、その名前でこの画面を絞り込む。人の行は人の画面を開く。
  f.calls.length = 0;
  rows[2].click();
  assert.deepEqual(f.calls.filter(([kind]) => kind === "videoMode" || kind === "searchVideos"), [["videoMode", "home"], ["searchVideos"]]);
  for (const view of ["feed", "music", "articles"]) {
    f.show(view);
    await settle();
    f.show(view);
    assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-channel-row").length, 0, `${view}: no channel rows`);
  }
  f.dom.window.close();
});

test("the フォロー中 (videos only) heading opens its page; music keeps a row for followed new work; signed-out views skip channels", async () => {
  const f = fixture();
  f.show("videos");
  await settle();
  f.show("videos");
  f.calls.length = 0;
  f.document.querySelector("#sidebar-context .sidebar-heading.is-link").click();
  assert.deepEqual(f.calls.at(-1), ["videoMode", "subscriptions"]);
  f.show("music");
  assert.equal(f.document.querySelectorAll("#sidebar-context .sidebar-heading.is-link").length, 0, "music has no heading link");
  f.calls.length = 0;
  [...f.document.querySelectorAll("#sidebar-context .sidebar-nav-row")].find((node) => node.textContent === "フォロー中の新着").click();
  assert.deepEqual(f.calls.at(-1), ["musicMode", "subscriptions"]);
  await settle();
  f.dom.window.close();
  const signedOut = fixture({ registered: false });
  signedOut.show("videos");
  assert.deepEqual(signedOut.headings(), []);
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

test("messages keep conversations in the column with the DM / mail / contacts switch", () => {
  const f = fixture();
  f.show("messages");
  assert.equal(f.document.querySelector(".messages-side").parentElement, f.document.querySelector("#sidebar-context"));
  assert.deepEqual([...f.document.querySelectorAll(".sidebar-switch > button")].map((node) => [node.textContent, node.getAttribute("aria-pressed")]),
    [["DM", "true"], ["メール", "false"], ["連絡先", "false"]]);
  f.shell.classList.add("sidebar-collapsed");
  f.api.placeMessagesSide();
  assert.equal(f.document.querySelector(".messages-side").parentElement, f.document.querySelector(".messages-layout"));
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
