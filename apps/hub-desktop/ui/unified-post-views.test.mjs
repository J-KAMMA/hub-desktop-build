import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createUnifiedRow, firstLines, isUnifiedPost, primaryAttachment, renderUnifiedList } from "./unified-row.mjs";
import { citationApa, citationBibtex, leadingTimestamp, renderUnifiedPostDetail, unwrapPost } from "./unified-detail.mjs";

const icon = (name) => `<svg data-i="${name}"></svg>`;
const { document } = new JSDOM("").window;
const base = { id: "p1", kind: "post", status: "published", author: { handle: "mika", displayName: "Mika", avatarUrl: null }, title: null, body: "一\n\n二\n三\n四", bodyFormat: "plain", summary: null,
  licence: null, places: ["timeline"], attachments: [], locked: false, gate: null, counts: { replies: 2, likes: 3, saves: 1 }, viewer: { liked: false, saved: false, vote: null },
  createdAt: "2026-11-07T00:00:00.000Z", publishedAt: "2026-11-07T00:00:00.000Z", editedAt: null, revision: 1, rating: null };
const deps = (extra = {}) => ({ icon, hubAsset: (img, url) => { img.src = url; }, relTime: () => "今", paintAvatar: () => {}, ...extra });

test("a row shows the first three non-empty lines when there is no title, and the title when there is one", () => {
  assert.equal(firstLines(base.body), "一\n二\n三");
  const row = createUnifiedRow(document, base, deps());
  assert.equal(row.querySelector(".uc-row-excerpt").textContent, "一\n二\n三");
  const titled = createUnifiedRow(document, { ...base, kind: "article", title: "題", body: "本文" }, deps());
  assert.equal(titled.querySelector(".uc-row-title").textContent, "題");
  assert.equal(titled.querySelector(".uc-row-excerpt"), null);
});

test("a gated row shows the title, a lock and the condition only", () => {
  const row = createUnifiedRow(document, { ...base, kind: "article", title: "有料", body: null, locked: true, gate: { gateId: "g", description: "GOHO 10枚" },
    attachments: [{ ordinal: 0, type: "image", refId: "i1" }] }, deps());
  assert.equal(row.querySelector(".uc-row-title svg").dataset.i, "lock");
  assert.equal(row.querySelector(".uc-row-gate").textContent, "GOHO 10枚");
  assert.equal(row.querySelector(".uc-row-excerpt"), null);
  assert.equal(row.querySelector(".uc-row-media"), null);
  assert.equal(row.dataset.locked, "true");
});

test("one primary attachment per row, chosen by priority", () => {
  const att = (...types) => types.map((type, ordinal) => ({ ordinal, type, refId: "x1" }));
  assert.equal(primaryAttachment({ ...base, attachments: att("image", "video") }).type, "video");
  assert.equal(primaryAttachment({ ...base, attachments: att("file", "image") }).type, "image");
  assert.equal(primaryAttachment({ ...base, kind: "paper", attachments: att("image") }).type, "paper");
  const row = createUnifiedRow(document, { ...base, attachments: att("image", "image", "poll") }, deps());
  assert.equal(row.querySelectorAll(".uc-row-media, .uc-row-attach").length, 1);
  assert.equal(row.querySelector(".uc-row-more").textContent, "+1");
  assert.ok(row.querySelector("img").src.includes("/api/media/images/x1?variant=thumbnail"));
  const paper = createUnifiedRow(document, { ...base, kind: "paper", title: "論文", licence: "cc-by-nc-4.0", attachments: att("reference") }, deps({ licenceLabel: () => "CC BY-NC" }));
  assert.equal(paper.querySelector(".uc-row-paper").textContent, "CC BY-NC");
});

test("the action row has reply, repost, like, share and save with 44px class targets and counts", () => {
  const row = createUnifiedRow(document, base, deps({ onRepost: () => {}, onReact: async () => ({ counts: { replies: 2, likes: 4, saves: 1 }, viewer: { liked: true, saved: false, vote: null } }) }));
  const labels = [...row.querySelectorAll(".post-action")].map((b) => b.getAttribute("aria-label"));
  assert.deepEqual(labels, ["返信", "リポスト", "いいね", "共有", "保存"]);
  assert.equal(row.querySelector('[aria-label="共有"]').classList.contains("uc-act-right"), true);
  assert.equal(row.querySelector('[aria-label="いいね"] .post-action-count').textContent, "3");
});

test("liking is optimistic and rolls back on failure", async () => {
  let fail = false;
  const row = createUnifiedRow(document, base, deps({ onReact: async () => { if (fail) throw new Error("x"); return null; } }));
  const like = row.querySelector('[aria-label="いいね"]');
  like.click(); assert.equal(like.querySelector(".post-action-count").textContent, "4"); await new Promise((r) => setTimeout(r, 0));
  fail = true; like.click(); assert.equal(like.querySelector(".post-action-count").textContent, "3"); await new Promise((r) => setTimeout(r, 0));
  assert.equal(like.querySelector(".post-action-count").textContent, "4");
});

test("list: adsAllowed follows the server and the shape check separates old posts", () => {
  assert.equal(isUnifiedPost(base), true);
  assert.equal(isUnifiedPost({ id: "old", body: "x", likeCount: 1 }), false);
  const list = renderUnifiedList(document, { items: [base], nextCursor: "c", adsAllowed: false }, deps());
  assert.equal(list.adsAllowed, false); assert.equal(list.nodes.length, 1); assert.equal(list.nextCursor, "c");
});

test("detail: unwrap accepts both shapes; article reader reuses the article classes", () => {
  assert.equal(unwrapPost({ post: base }).post.id, "p1");
  assert.equal(unwrapPost(base).post.id, "p1");
  assert.equal(unwrapPost({ post: { id: "old" } }), null);
  const target = document.createElement("div");
  const made = renderUnifiedPostDetail(document, target, { ...base, kind: "article", title: "題", body: "段落1\n\n段落2", summary: "要約" }, deps());
  assert.ok(made.root.classList.contains("article-reader"));
  assert.equal(target.querySelectorAll(".ud-body .detail-p").length, 2);
  assert.equal(target.querySelector(".article-title").textContent, "題");
});

test("detail: ads are off when the server says so", () => {
  const seen = [];
  const target = document.createElement("div");
  renderUnifiedPostDetail(document, target, { ...base, kind: "paper", title: "P", licence: "cc-by-nc-4.0", adsAllowed: false }, deps({ onAdsAllowed: (v) => seen.push(v) }));
  assert.equal(target.querySelector(".ud").dataset.adsAllowed, "false");
  assert.deepEqual(seen, [false]);
});

test("detail: paper shows references, citation buttons, revisions and the withdrawn state", async () => {
  const target = document.createElement("div");
  const paper = { ...base, kind: "paper", status: "withdrawn", title: "論文", summary: "要旨", body: "本文", licence: "cc-by-4.0", revision: 3,
    attachments: [{ ordinal: 0, type: "reference", refId: "r1", meta: { citation: "A. B. 2020", doi: "10.1/x" } }, { ordinal: 1, type: "file", refId: "f1", meta: { name: "paper.pdf" } }] };
  renderUnifiedPostDetail(document, target, paper, deps({ loadRevisions: async () => ({ items: [{ revision: 1, createdAt: "2026-11-01T00:00:00Z", licence: "cc-by-4.0" }, { revision: 2, createdAt: "2026-11-02T00:00:00Z" }] }), copyText: async () => {} }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(target.querySelector(".ud-abstract").textContent, "要旨");
  assert.equal(target.querySelectorAll(".ud-ref").length, 1);
  assert.equal(target.querySelector(".ud-withdrawn").textContent, "取り下げ済み");
  assert.equal(target.querySelectorAll(".ud-rev").length, 2);
  assert.deepEqual([...target.querySelectorAll(".ud-cite-button")].map((b) => b.textContent), ["APA", "BibTeX"]);
  assert.equal(target.querySelector(".ud-file span").textContent, "paper.pdf");
  assert.match(citationBibtex(paper, "https://hub/x"), /@misc\{mika2026p1/);
  assert.match(citationApa(paper), /^Mika \(2026\)\. 論文\. Hub\.$/);
  assert.equal(target.querySelector(".ud-composer").children.length, 0, "no replies composer on a withdrawn paper");
});

test("detail: a gated paper-like post shows only the lock and condition, never the body", () => {
  const target = document.createElement("div");
  renderUnifiedPostDetail(document, target, { ...base, kind: "article", title: "有料", body: null, locked: true, gate: { gateId: "g", description: "条件" } }, deps());
  assert.equal(target.querySelector(".ud-locked").textContent, "条件");
  assert.equal(target.querySelector(".ud-body"), null);
});

test("detail: video replies with leading timestamps sort by time and seek", async () => {
  assert.deepEqual(leadingTimestamp("1:05 ここ"), { seconds: 65, text: "1:05" });
  assert.equal(leadingTimestamp("1:75 x"), null);
  assert.equal(leadingTimestamp("あ 1:05"), null);
  assert.equal(leadingTimestamp("1:02:03")?.seconds, 3723);
  const seeks = [];
  const reply = (id, body) => ({ ...base, id, body, replyToPostId: "v1" });
  const target = document.createElement("div");
  renderUnifiedPostDetail(document, target, { ...base, id: "v1", kind: "video", attachments: [{ ordinal: 0, type: "external_video", refId: "dQw4w9WgXcQ", meta: { provider: "youtube" } }] },
    deps({ onSeek: (s) => seeks.push(s), loadReplies: async () => ({ items: [reply("a", "2:00 後"), reply("b", "0:10 先"), reply("c", "時刻なし")] }) }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...target.querySelectorAll(".ud-replies .post-row")].map((r) => r.dataset.postId), ["b", "a", "c"]);
  target.querySelector(".ud-stamp").click();
  assert.deepEqual(seeks, [10]);
  assert.ok(target.querySelector(".ud-player"));
});

test("detail: a music post shows the player and the body", () => {
  const target = document.createElement("div");
  renderUnifiedPostDetail(document, target, { ...base, kind: "music", body: "解説", attachments: [{ ordinal: 0, type: "audio", refId: "t1" }] }, deps({ onPlayAudio: () => {} }));
  assert.ok(target.querySelector(".ud-player-audio .ud-play"));
  assert.ok(target.querySelector(".ud-body"));
});

test("the new css uses semantic tokens only", () => {
  const css = readFileSync(new URL("./unified-post.css", import.meta.url), "utf8");
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|:\s*(?:white|black)\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), false);
  assert.equal(/(?:font-size|border-radius)\s*:\s*\d+(?:\.\d+)?px/.test(css), false);
  assert.equal(/:focus[^{]*\{[^}]*box-shadow/.test(css), false);
});

test("jkammaポイント sits next to the author name as quiet meta, and only when the value is an integer", () => {
  const withPoints = (badgePoints) => createUnifiedRow(document, { ...base, author: { ...base.author, badgePoints } }, deps());
  const node = withPoints(1234567).querySelector(".post-author-link .post-points");
  assert.equal(node.getAttribute("aria-label"), "jkammaポイント");
  assert.equal(node.textContent, "1,234,567");
  assert.equal(node.querySelector("svg").dataset.i, "star");
  assert.ok(node.classList.contains("meta"));
  assert.equal(withPoints(0).querySelector(".post-points").textContent, "0");
  for (const value of [null, undefined, "12", 1.5, -1]) assert.equal(withPoints(value).querySelector(".post-points"), null);
  assert.equal(createUnifiedRow(document, { ...base, author: { ...base.author, badgeTier: "gold" } }, deps()).querySelector(".post-points"), null);
});

test("the post detail byline shows the points too and nothing when null", () => {
  const html = (badgePoints) => {
    const host = document.createElement("div");
    renderUnifiedPostDetail(document, host, { post: { ...base, author: { ...base.author, badgePoints } } }, { ...deps(), isCurrent: () => true, loadReplies: async () => ({ items: [] }), loadRevisions: async () => ({ items: [] }), onAdsAllowed() {} });
    return host;
  };
  assert.equal(html(9800).querySelector(".ud-byline .post-points")?.textContent, "9,800");
  assert.equal(html(null).querySelector(".ud-byline .post-points"), null);
});
