import test from "node:test";
import { addBaitRow, confirmLeave } from './outbound-link.mjs';
import { detectBait } from './bait-warning.mjs';
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { createPostRow, ratingStars } from "./post-row.mjs";
import { threadRowMeta } from "./thread-list-meta.mjs";
import { researchDiscussionReference, researchGitDiscussionReference } from "./research-reference.mjs";

const icon = (name) => `<svg data-i="${name}"></svg>`;

test("a row shows stars next to the time only when a rating is present", () => {
  const { document } = new JSDOM("").window;
  const base = { authorName: "A", time: "1日前", icon };
  assert.equal(createPostRow(document, base).querySelector(".post-rating"), null);
  const row = createPostRow(document, { ...base, rating: 4 });
  assert.equal(row.querySelector(".post-rating").textContent, "★★★★☆");
  assert.equal(row.querySelector(".post-rating").getAttribute("aria-label"), "評価 5段階中4");
  assert.equal(ratingStars(document, 0), null);
  assert.equal(ratingStars(document, 6), null);
});

test("rows are not cards and carry the shared post structure", () => {
  const { document } = new JSDOM("").window;
  const row = createPostRow(document, { authorName: "Mika", authorHandle: "mika", time: "今", body: "本文", icon, menu: [["編集", () => {}]], actions: [{ icon: "heart", label: "いいね", count: 2 }] });
  assert.equal(row.classList.contains("card"), false);
  assert.ok(row.querySelector(".post-avatar") && row.querySelector(".post-content .post-head .post-author-link"));
  assert.equal(row.querySelector(".post-action-count").textContent, "2");
  assert.equal(row.querySelector(".post-more").getAttribute("aria-label"), "投稿のその他の操作");
});

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const cardCode = source.slice(source.indexOf("function threadPostCard("), source.indexOf("function renderThreadDetail("));
const listCode = source.slice(source.indexOf("let threadBoardNames"), source.indexOf("const CATALOGS = {"));
function harness(dom) {
  const context = vm.createContext({
    researchDiscussionReference, researchGitDiscussionReference, createPostRow, threadRowMeta, addBaitRow, detectBait, document: dom.window.document, window: dom.window,
    relTime: () => "1日前", hubAsset: (img, url) => img.setAttribute("src", url), icon, paintAvatar: () => {}, avatarTint: () => 3, friendlyError: String,
    threadBoardKey: "", threadBoardTitle: "", desktopAccount: { state: "none" }, rankThreads: () => [], rankGroups: () => [], groupModels: () => [],
    invoke: async () => ({}), hubOrigin: "https://h.invalid", openHubPath: () => {}, openListPicker: () => {}, openDetail: () => {},
    loadSafetyControls: async () => new Map(), reportForm: () => dom.window.document.createElement("form"),
  });
  vm.runInContext(cardCode + listCode, context);
  return context;
}

test("thread posts render as post rows with the post action row and … menu", () => {
  const dom = new JSDOM("");
  try {
    const c = harness(dom);
    c.post = { id: "p-2", no: 2, displayName: "Reader", body: "Body", createdAt: "2026-07-01", authorHandle: "aoi", authorProfileId: "u2", replyTargetNo: 1, voteSummary: { up: 3, down: 0 }, images: [{ url: "/i/1", altText: "A" }] };
    c.context = { viewer: { id: "me" }, quote: () => {} };
    let jumped = 0; c.jump = (n) => { jumped = n; };
    const row = vm.runInContext("threadPostCard(post,context,()=>{},jump)", c);
    assert.ok(row.classList.contains("post") && row.classList.contains("thread-post") && !row.classList.contains("card"));
    assert.equal(row.querySelector(".post-avatar").textContent, "R");
    assert.match(row.querySelector(".post-head").textContent, /Reader@aoi1日前#2/);
    row.querySelector(".post-reply-to a").click();
    assert.equal(jumped, 1);
    assert.equal(row.querySelector('img[alt="A"]') !== null, true);
    assert.deepEqual([...row.querySelectorAll(".post-action")].map((b) => b.getAttribute("aria-label")), ["いいね", "返信", "共有"]);
    assert.deepEqual([...row.querySelectorAll(".post-more-menu [role=menuitem]")].map((b) => b.textContent), ["リストに追加", "ミュート", "ブロック", "低評価", "報告"]);
  } finally { dom.window.close(); }
});

test("own thread posts get 編集/削除 and no vote; hidden posts have no actions or images", () => {
  const dom = new JSDOM("");
  try {
    const c = harness(dom);
    c.post = { id: "p-1", no: 1, displayName: "Reader", body: "Body", createdAt: "2026-07-01", authorProfileId: null, viewerIsAuthor: true, images: [{ url: "/api/images/i-1", altText: "Attachment" }] };
    c.context = { viewer: { id: "me" } };
    let row = vm.runInContext("threadPostCard(post,context,()=>{})", c);
    assert.deepEqual([...row.querySelectorAll(".post-more-menu [role=menuitem]")].map((b) => b.textContent), ["編集", "削除"]);
    assert.equal(row.querySelector('[aria-label="いいね"]'), null);
    assert.equal(row.querySelector("img").alt, "Attachment");
    c.post.viewerBlocked = true;
    row = vm.runInContext("threadPostCard(post,context,()=>{})", c);
    assert.equal(row.querySelector("img"), null);
    assert.equal(row.querySelector("button"), null);
    assert.match(row.textContent, /表示できません/);
  } finally { dom.window.close(); }
});

test("the thread list card is a divider row: title, type, replies and relative time", () => {
  const dom = new JSDOM("");
  try {
    const c = harness(dom);
    c.t = { id: "t1", title: "作業場所", boardKey: "cat03-board02", threadType: "question", postCount: 14, solvedAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", pinned: true, tags: ["雑談"] };
    const card = vm.runInContext("threadListCard(t)", c);
    assert.ok(card.classList.contains("thread-row") && !card.classList.contains("card"));
    assert.equal(card.querySelector(".thread-row-title").textContent, "作業場所");
    const meta = card.querySelector(".thread-row-meta").textContent;
    assert.equal(meta, "質問13解決済みピン留め1日前");
    assert.doesNotMatch(meta, /cat03-board02|掲示板/);
    assert.equal(card.querySelector(".thread-row-tag"), null);
    assert.equal(card.querySelector(".post-avatar"), null);
  } finally { dom.window.close(); }
});

test("the community list card is a plain row card: icon, name, 1-line description, members and last activity", () => {
  const dom = new JSDOM("");
  try {
    const c = harness(dom);
    c.g = { id: "g1", name: "写真部", description: "毎週撮った写真を見せ合う部です。", category: "趣味", memberCount: 1200, visibility: "private", lastMessageAt: "2026-11-05T00:00:00Z", viewerJoined: true };
    const card = vm.runInContext("communityListCard(g)", c);
    assert.ok(card.classList.contains("community-card"));
    assert.equal(card.querySelector(".community-card-icon").textContent, "写");
    assert.ok(card.querySelector(".community-card-lock"));
    assert.equal(card.querySelector(".community-card-name").textContent, "写真部");
    assert.equal(card.querySelector(".community-card-desc").textContent, "毎週撮った写真を見せ合う部です。");
    assert.equal(card.querySelector(".community-card-meta").textContent, "1,2001日前");
    assert.ok(card.querySelector(".community-card-meta svg"));
    assert.equal(card.querySelector(".community-card-badge").textContent, "参加中");
    assert.equal(card.tabIndex, 0);
    c.h = { id: "g2", name: "Go部" };
    const bare = vm.runInContext("communityListCard(h)", c);
    assert.equal(bare.querySelector(".community-card-badge"), null);
    assert.equal(bare.querySelector(".community-card-icon").textContent, "G");
    // 入っていないカードだけに「参加する」。入っているカードには出さない。
    assert.equal(card.querySelector(".community-card-join"), null);
    assert.equal(bare.querySelector(".community-card-join").textContent, "参加を申請");
    c.p = { id: "g3", name: "公開部", visibility: "public" };
    assert.equal(vm.runInContext("communityListCard(p)", c).querySelector(".community-card-join").textContent, "参加する");
  } finally { dom.window.close(); }
});
