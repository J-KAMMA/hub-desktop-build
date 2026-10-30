// 内側左列の下段「あなたのもの」（sidebar-mine.mjs、2026-10-29）の描画の状態と先頭固定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createSidebarMine, createMinePins, orderWithPins, MINE_SECTIONS, MINE_LIMIT, PIN_KEY } from "./sidebar-mine.mjs";

const tick = () => new Promise(setImmediate);
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const memory = () => { const map = new Map(); return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) }; };
const many = (n, prefix = "t") => ({ items: Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, label: `${prefix}${i}` })) });

function build({ registered = true, sources, storage = memory(), profile = "p1" } = {}) {
  const dom = new JSDOM("<!doctype html><div id='host'></div>");
  const { document } = dom.window;
  const calls = [];
  let state = { registered };
  const host = document.querySelector("#host");
  const mine = createSidebarMine({
    document, storage, profile: () => profile, epoch: () => 1, registered: () => state.registered,
    changed: () => paint(),
    sources,
    actions: { open: (k, i) => calls.push(["open", k, i.id]), seeAll: (k) => calls.push(["all", k]), empty: (k) => calls.push(["empty", k]), signIn: () => calls.push(["signIn"]) },
  });
  let view = "feed";
  const paint = () => { const node = mine.render(view); host.replaceChildren(...(node ? [node] : [])); };
  const show = (v) => { view = v; paint(); };
  return { document, host, mine, calls, show, storage, setRegistered: (v) => { state.registered = v; } };
}

test("signed out shows one signedOut state and no account sections", () => {
  const f = build({ registered: false, sources: { "feed.tags": () => many(2), "feed.lists": () => many(1) } });
  f.show("feed");
  assert.equal(f.host.querySelectorAll(".ds-state--signedOut").length, 1);
  assert.equal(f.host.querySelectorAll(".sidebar-mine-section").length, 0);
  f.host.querySelector(".state-action").click();
  assert.deepEqual(f.calls, [["signIn"]]);
});

test("loading shows skeleton rows, then rows capped at the limit with すべて見る", async () => {
  const f = build({ sources: { "feed.tags": async () => many(10), "feed.lists": async () => many(2, "l") } });
  f.show("feed");
  assert.ok(f.host.querySelector(".ds-state--loading"));
  await settle();
  const tags = f.host.querySelector('[data-mine-section="feed.tags"]');
  assert.equal(tags.querySelector(".sidebar-mine-heading").textContent, "フォロー中のタグ");
  assert.equal(tags.querySelectorAll(".sidebar-mine-row").length, MINE_LIMIT);
  assert.equal(tags.querySelector(".sidebar-mine-all").textContent, "すべて見る");
  assert.equal(tags.querySelector(".sidebar-mine-face").textContent, "#");
  assert.ok(MINE_LIMIT >= 5 && MINE_LIMIT <= 8);
  tags.querySelector(".sidebar-mine-row").click();
  tags.querySelector(".sidebar-mine-all").click();
  assert.deepEqual(f.calls, [["open", "feed.tags", "t0"], ["all", "feed.tags"]]);
});

test("empty section is one muted line and one action", async () => {
  const f = build({ sources: { "feed.tags": async () => ({ items: [] }), "feed.lists": async () => many(1, "l") } });
  f.show("feed");
  await settle();
  const box = f.host.querySelector('[data-mine-section="feed.tags"]');
  assert.equal(box.querySelectorAll(".sidebar-mine-note").length, 1);
  assert.equal(box.querySelectorAll("button").length, 1);
  box.querySelector(".sidebar-mine-action").click();
  assert.deepEqual(f.calls, [["empty", "feed.tags"]]);
});

test("a failed read shows one line and retry reloads", async () => {
  let fail = true;
  const f = build({ sources: { "feed.tags": async () => { if (fail) throw new Error("x"); return many(1); }, "feed.lists": () => many(1, "l") } });
  f.show("feed");
  await settle();
  const box = f.host.querySelector('[data-mine-section="feed.tags"]');
  assert.match(box.textContent, /読み込めませんでした/);
  fail = false;
  box.querySelector(".sidebar-mine-action").click();
  await settle();
  assert.equal(f.host.querySelectorAll('[data-mine-section="feed.tags"] .sidebar-mine-row').length, 1);
});

test("counts show in the heading for drafts and the cart", async () => {
  const f = build({ sources: { "articles.writers": () => many(1), "articles.tags": () => many(1), "articles.drafts": async () => many(3, "d"), "articles.saved": () => many(1) } });
  f.show("articles");
  await settle();
  assert.equal(f.host.querySelector('[data-mine-section="articles.drafts"] .sidebar-mine-count').textContent, "3");
  const m = build({ registered: false, sources: { "market.cart": () => ({ items: [{ id: "a", label: "本", meta: "×2" }], count: 2 }) } });
  m.show("market");
  assert.equal(m.host.querySelectorAll(".ds-state--signedOut").length, 0, "the cart is local");
  assert.equal(m.host.querySelector(".sidebar-mine-count").textContent, "2");
  assert.equal(m.host.querySelector(".sidebar-mine-meta").textContent, "×2");
});

test("pinning puts a row first, survives re-render and is kept per profile", async () => {
  const storage = memory();
  const f = build({ storage, profile: "p1", sources: { "feed.tags": async () => many(10), "feed.lists": () => many(1, "l") } });
  f.show("feed");
  await settle();
  const rows = () => [...f.host.querySelectorAll('[data-mine-section="feed.tags"] .sidebar-mine-row .sidebar-mine-label')].map((n) => n.textContent);
  assert.deepEqual(rows().slice(0, 2), ["t0", "t1"]);
  const pin = f.host.querySelectorAll('[data-mine-section="feed.tags"] .sidebar-mine-pin')[8 - 3];
  assert.ok(pin);
  f.mine.pins.toggle("feed.tags", "t9");
  f.show("feed");
  assert.equal(rows()[0], "t9", "a pinned row beyond the limit still shows first");
  assert.equal(rows().length, MINE_LIMIT);
  const button = f.host.querySelector('[data-mine-section="feed.tags"] .sidebar-mine-pin');
  assert.equal(button.getAttribute("aria-pressed"), "true");
  button.click();
  assert.notEqual(rows()[0], "t9", "pressing the pin button unpins");
  // 別のプロフィールには効かない。
  f.mine.pins.toggle("feed.tags", "t5");
  assert.deepEqual(createMinePins({ storage, profile: () => "p2" }).ids("feed.tags"), []);
  assert.deepEqual(createMinePins({ storage, profile: () => "p1" }).ids("feed.tags"), ["t5"]);
  assert.ok(storage.map.has(PIN_KEY));
});

test("orderWithPins and broken storage", () => {
  assert.deepEqual(orderWithPins([{ id: "a" }, { id: "b" }, { id: "c" }], ["c"], 2).map((i) => i.id), ["c", "a"]);
  const bad = { getItem: () => "not json", setItem: () => { throw new Error("full"); } };
  const pins = createMinePins({ storage: bad, profile: () => "p" });
  assert.deepEqual(pins.ids("x"), []);
  assert.doesNotThrow(() => pins.toggle("x", "1"));
});

test("a view without any source renders nothing; sections follow the owner's list", () => {
  const f = build({ sources: {} });
  f.show("games");
  assert.equal(f.host.children.length, 0);
  const titles = (view) => MINE_SECTIONS[view].map((s) => s.title);
  assert.deepEqual(titles("feed"), ["フォロー中のタグ", "リスト"]);
  assert.deepEqual(titles("articles"), ["フォロー中の書き手", "フォロー中のタグ", "下書き", "保存した記事"]);
  assert.deepEqual(titles("videos"), ["フォロー中のタグ", "登録チャンネル", "あとで見る"]);
  assert.deepEqual(titles("music"), ["フォロー中のタグ", "プレイリスト", "お気に入り", "最近聴いた曲"]);
  assert.deepEqual(titles("games"), ["ライブラリ"]);
  assert.deepEqual(titles("research"), ["自分のプロジェクト"]);
  assert.ok(![...Object.values(MINE_SECTIONS)].flat().some((s) => /購入|買う|checkout/i.test(s.title + s.empty.action)), "music and others carry no purchase controls");
});

test("wiring and styles: column hooks, no raw colors, 36px rows from tokens", () => {
  const css = readFileSync(new URL("./sidebar-mine.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|(?<![-\w])(white|black)(?![-\w])/i);
  assert.match(css, /height: var\(--tap-height\)/);
  assert.match(css, /width: var\(--avatar-24\)/);
  assert.match(html, /sidebar-mine\.css/);
  assert.match(app, /appendSidebarMine\(view\);/);
  assert.match(app, /\.sidebar-context-item, \.messages-side, \.sidebar-mine/);
});
