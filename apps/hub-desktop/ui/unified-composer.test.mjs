import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildCreateOptions, createUnifiedComposer, exceedsOneLine, kindOfState, youtubeId } from "./unified-composer.mjs";

const icon = (name) => `<svg data-i="${name}"></svg>`;
const make = (extra = {}) => {
  const { document } = new JSDOM("").window;
  const calls = [];
  const composer = createUnifiedComposer(document, { icon, place: "timeline", invoke: async (name, args) => { calls.push([name, args]); return { post: { id: "p1", status: "published" } }; }, onPosted: (p) => calls.push(["posted", p]), randomId: (() => { let n = 0; return () => `id${++n}x`; })(), ...extra });
  document.body.append(composer.root);
  return { document, composer, calls };
};
const type = (composer, value) => { composer.body.value = value; composer.body.dispatchEvent(new composer.body.ownerDocument.defaultView.Event("input")); };
const kind = (composer) => composer.root.querySelector(".uc-kind").dataset.kind;

test("the badge follows the derived kind live", () => {
  const { composer } = make();
  assert.equal(kind(composer), "post");
  composer.title.value = "題"; type(composer, "本文");
  assert.equal(kind(composer), "article");
  composer.state.attachments.push({ type: "external_video", refId: "dQw4w9WgXcQ", meta: { provider: "youtube" } }); composer.repaint();
  assert.equal(kind(composer), "video");
  composer.state.attachments.length = 0; composer.state.attachments.push({ type: "audio", refId: "t1" }); composer.repaint();
  assert.equal(kind(composer), "music");
  composer.state.attachments.length = 0; composer.state.attachments.push({ type: "reference", refId: "r1", meta: { doi: "10.1/x" } }); composer.state.licence = "cc-by-4.0"; composer.repaint();
  assert.equal(kind(composer), "paper");
  composer.state.gateId = "g1"; composer.repaint();
  assert.equal(kind(composer), "article");
});

test("the title field appears when the body passes one line or from the menu entry", () => {
  const { composer } = make();
  assert.equal(composer.title.hidden, true);
  type(composer, "一行");
  assert.equal(composer.title.hidden, true);
  type(composer, "一行目\n二行目");
  assert.equal(composer.title.hidden, false);
  type(composer, "");
  assert.equal(composer.title.hidden, true);
  assert.equal(composer.root.querySelector(".uc-tool-title").hidden, false);
  assert.equal(composer.root.querySelector(".uc-tool-title").parentElement.className, "uc-menu");
  assert.equal(composer.root.querySelector(".uc-tool-title").textContent, "題を付ける");
  composer.root.querySelector(".uc-tool-title").click();
  assert.equal(composer.title.hidden, false);
  assert.equal(composer.root.querySelector(".uc-tool-title").textContent, "題を外す");
  assert.equal(exceedsOneLine("x".repeat(81)), true);
});

test("Ctrl+Enter sends create_post_v2 with the opening place and no kind", async () => {
  const { composer, calls, document } = make({ place: "thread:t-1" });
  type(composer, "こんにちは");
  const event = new document.defaultView.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true });
  composer.root.dispatchEvent(event);
  await new Promise((r) => setTimeout(r, 0));
  const [name, args] = calls[0];
  assert.equal(name, "hub_client_action");
  assert.equal(args.action, "create_post_v2");
  assert.deepEqual(args.options, { place: "thread:t-1", body: "こんにちは" });
  assert.equal("kind" in args.options, false);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(args.requestId));
  assert.equal(calls[1][0], "posted");
  assert.equal(composer.body.value, "");
});

test("a failed send keeps the draft and resends with the same requestId", async () => {
  let fail = true; const ids = [];
  const { composer } = make({ invoke: async (_n, args) => { ids.push(args.requestId); if (fail) throw new Error("x"); return { post: { id: "p", status: "held" } }; } });
  type(composer, "あ");
  await composer.submit();
  assert.equal(composer.body.value, "あ");
  fail = false;
  await composer.submit();
  assert.equal(ids[0], ids[1]);
  assert.equal(composer.root.querySelector(".uc-note").textContent, "審査中");
});

test("options: attachments, poll, licence, reply rating; audio never carries a gate", () => {
  const options = buildCreateOptions({ place: "channel:c1:chat", title: " 題 ", body: "b", licence: "cc0-1.0", gateId: "g", replyToPostId: "r1", rating: 4,
    attachments: [{ type: "audio", refId: "a1" }, { type: "poll", refId: "pl" }], pollOptions: ["a", " ", "b"] });
  assert.equal(options.title, "題");
  assert.equal(options.gateId, undefined);
  assert.equal(options.rating, 4);
  assert.deepEqual(options.pollOptions, ["a", "b"]);
  assert.deepEqual(options.attachments, [{ type: "audio", refId: "a1" }, { type: "poll", refId: "pl" }]);
  for (const place of ["profile:abc", "thread:a/b", "channel:c1", "timeline ", "", undefined]) assert.throws(() => buildCreateOptions({ place }), /place/);
  assert.equal(kindOfState({ replyToPostId: "r", title: "t", body: "b" }), "post");
});

test("youtube ids come from the allowed hosts only", () => {
  assert.equal(youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://evil.example/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(youtubeId("not a url"), null);
});

test("the bar is icon-only with names in aria-label and tooltip; the rest live in the menu", () => {
  const { composer } = make({ loadGates: async () => [{ id: "g1", description: "条件" }] });
  const buttons = [...composer.root.querySelectorAll(".uc-bar > .uc-tool, .uc-bar .uc-more > .uc-tool")];
  assert.deepEqual(buttons.map((b) => b.getAttribute("aria-label")), ["画像", "動画・音声", "リンク", "投票", "その他"]);
  assert.deepEqual(buttons.map((b) => b.title), ["画像", "動画・音声", "リンク", "投票", "その他"]);
  assert.deepEqual(buttons.map((b) => b.textContent), ["", "", "", "", ""]);
  const menu = [...composer.root.querySelectorAll(".uc-menu:not(.uc-vis-menu) .uc-menu-item")].map((b) => b.textContent);
  assert.deepEqual(menu, ["題を付ける", "ファイル", "参考文献", "ライセンス", "ゲート", "参照"]);
  assert.equal(composer.root.querySelector(".uc-menu").hidden, true);
  composer.root.querySelector(".uc-tool-more").click();
  assert.equal(composer.root.querySelector(".uc-menu").hidden, false);
  composer.state.attachments.push({ type: "audio", refId: "a1" }); composer.repaint();
  assert.equal(composer.root.querySelector(".uc-tool-gate").disabled, true);
});

test("the default view has no title link, no visibility word and a plain 投稿 button at the row's end", () => {
  const { composer } = make();
  assert.equal(composer.root.querySelector(".uc-visibility").textContent, "");
  assert.equal(composer.root.querySelector(".uc-kind").hidden, true);
  assert.equal(composer.root.querySelector(".uc-foot").lastElementChild.textContent, "投稿");
  assert.equal(composer.root.querySelector(".uc-send").disabled, true);
  type(composer, "a");
  assert.equal(composer.root.querySelector(".uc-send").disabled, false);
});

test("the destination caption shows only off the timeline; visibility is an icon menu that names itself only when changed", () => {
  const { composer } = make({ place: "thread:t1", placeLabel: "雑談" });
  assert.equal(composer.root.querySelector(".uc-place").textContent, "雑談へ");
  assert.equal(composer.root.querySelector(".uc-top").hidden, false);
  assert.equal(make().composer.root.querySelector(".uc-top").hidden, true);
  const visibility = composer.root.querySelector(".uc-visibility");
  assert.equal(visibility.tagName, "BUTTON");
  assert.equal(visibility.textContent, "");
  assert.match(visibility.innerHTML, /globe/);
  assert.equal(composer.root.querySelector(".uc-vis-menu").hidden, true);
  visibility.click();
  assert.equal(composer.root.querySelector(".uc-vis-menu").hidden, false);
  composer.root.querySelector(".uc-vis-followers").click();
  assert.equal(composer.state.visibility, "followers");
  assert.equal(composer.root.querySelector(".uc-vis-menu").hidden, true);
  assert.equal(visibility.textContent, "フォロワーのみ");
  assert.match(visibility.innerHTML, /people/);
  composer.root.querySelector(".uc-vis-public").click();
  assert.equal(composer.state.visibility, "public");
  assert.equal(visibility.textContent, "");
});

test("the inline variant folds to one line until focused or filled; the panel is always open", () => {
  const inline = make({ variant: "inline" }).composer;
  assert.equal(inline.root.dataset.variant, "inline");
  assert.equal(inline.root.dataset.expanded, "false");
  inline.body.dispatchEvent(new inline.body.ownerDocument.defaultView.Event("focus"));
  assert.equal(inline.root.dataset.expanded, "true");
  inline.collapse();
  assert.equal(inline.root.dataset.expanded, "false");
  type(inline, "x");
  assert.equal(inline.root.dataset.expanded, "true");
  assert.equal(make().composer.root.dataset.expanded, "true");
  assert.equal(make().composer.root.dataset.variant, "panel");
});

test("the character ring appears only near the limit and blocks sending past it", () => {
  const { composer } = make({ charLimit: 100 });
  const count = composer.root.querySelector(".uc-count");
  type(composer, "x".repeat(50));
  assert.equal(count.hidden, true);
  type(composer, "x".repeat(95));
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, "5");
  assert.equal(composer.root.querySelector(".uc-send").disabled, false);
  type(composer, "x".repeat(103));
  assert.equal(count.textContent, "-3");
  assert.equal(count.dataset.over, "true");
  assert.equal(composer.root.querySelector(".uc-send").disabled, true);
});

test("one picker adds a video, a track or YouTube; the link tool takes https only", () => {
  const { composer } = make();
  composer.root.querySelector(".uc-tool-media").click();
  const select = composer.root.querySelector(".uc-panel select"), field = composer.root.querySelector(".uc-panel input");
  field.value = "https://youtu.be/dQw4w9WgXcQ";
  composer.root.querySelector(".uc-panel .uc-tool").click();
  select.value = "audio"; select.dispatchEvent(new composer.root.ownerDocument.defaultView.Event("change"));
  assert.equal(composer.state.attachments[0].type, "external_video");
  composer.root.querySelector(".uc-tool-media").click();
  composer.root.querySelector(".uc-panel select").value = "audio";
  composer.root.querySelector(".uc-panel input").value = "track-1";
  composer.root.querySelector(".uc-panel .uc-tool").click();
  assert.deepEqual(composer.state.attachments[1], { type: "audio", refId: "track-1" });
  composer.root.querySelector(".uc-tool-link").click();
  const url = composer.root.querySelector(".uc-panel input");
  url.value = "http://example.com"; composer.root.querySelector(".uc-panel .uc-tool").click();
  assert.equal(composer.state.attachments.length, 2);
  composer.root.querySelector(".uc-panel input").value = "https://example.com/x"; composer.root.querySelector(".uc-panel .uc-tool").click();
  assert.deepEqual(composer.state.attachments[2], { type: "link", refId: "https://example.com/x", meta: { title: "example.com" } });
});

test("the timeline has no inline composer; the rail button and shortcut open the compose dialog (owner 2026-11-11)", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /\.before\(feedInlineComposer\.root\)/);
  assert.doesNotMatch(app, /feedInlineComposer\.focus\(\)/);
  const open = app.slice(app.indexOf("function openPostComposer("), app.indexOf("function openPostComposer(") + 1200);
  assert.doesNotMatch(open, /currentView === "feed"/, "on the timeline the button opens the dialog like anywhere else");
  assert.match(open, /communityUnified/, "an open community still focuses its own composer");
});

const CHOICES = [
  { value: "channel:c1:chat", label: "雑談", icon: "bubble" },
  { value: "channel:c1:question", label: "質問", icon: "search" },
  { value: "channel:c1:party", label: "募集", icon: "people" },
];

test("a community composer defaults to 雑談, lets the row choose 質問 or 募集, and sends that channel place", async () => {
  const { composer, calls } = make({ place: "channel:c1:chat", placeChoices: CHOICES, variant: "inline" });
  const pick = composer.root.querySelector(".uc-place-pick");
  assert.equal(pick.textContent, "雑談");
  assert.equal(composer.state.place, "channel:c1:chat");
  // The visibility menu and the place chip give way to the choice; nothing but the type is asked.
  assert.equal(composer.root.querySelector(".uc-vis").hidden, true);
  assert.equal(composer.root.querySelector(".uc-top").hidden, true);
  pick.click();
  const items = [...composer.root.querySelectorAll(".uc-place-item")];
  assert.deepEqual(items.map((i) => i.textContent), ["雑談", "質問", "募集"]);
  items[1].click();
  assert.equal(pick.textContent, "質問");
  assert.equal(composer.root.querySelector(".uc-place-menu").hidden, true);
  type(composer, "どう思う？");
  await composer.submit();
  assert.equal(calls[0][1].action, "create_post_v2");
  assert.deepEqual(calls[0][1].options, { place: "channel:c1:question", body: "どう思う？" });
  assert.equal("visibility" in calls[0][1].options, false);
  // A place that is not a channel of this form is dropped from the choices, so a hostile list cannot bend the path.
  const bent = make({ place: "channel:c1:chat", placeChoices: [{ value: "../x", label: "x" }, ...CHOICES] });
  assert.equal(bent.composer.root.querySelectorAll(".uc-place-item").length, 3);
});

test("app.js uses the unified composer in the open community and keeps the old one only for shared pages", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /const unified=ctx\.chat===true&&!ctx\.kind&&!threadId&&data\.canPost===true/);
  assert.match(app, /place: `channel:\$\{communityId\}:chat`[\s\S]{0,200}variant: "inline"/);
  assert.match(app, /held\?\.composer\.root\.isConnected[\s\S]{0,200}held\.composer\.focus\(\)/);
  assert.match(app, /const unifiedHolder=unified\?communityUnifiedComposer/);
});
