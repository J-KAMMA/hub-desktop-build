import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createMarketGames } from "./market-games.mjs";
import { createGamesPage } from "./games-page.mjs";
import { gamesTreeModel, renderGamesTree } from "./games-tree.mjs";

const { JSDOM } = createRequire(new URL("../../../package.json", import.meta.url))("jsdom");
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const fresh = () => { const { document } = new JSDOM("<div id='h'></div>").window; return { document, host: document.querySelector("#h") }; };
const games = [
  { slug: "alpha", title: "Alpha", summary: "sword", imageUrl: "", platforms: ["PC"], releaseDate: "2026-10-18", price: "" },
  { slug: "beta", title: "Beta", summary: "", imageUrl: "", platforms: [], releaseDate: null, price: "" },
];

test("market game category lists the store games, opens an in-app detail, and buys on the Web market product page", () => {
  const { document, host } = fresh();
  const opened = [];
  const page = createMarketGames({ document, host, deps: { asset() {}, openWeb: (g) => opened.push(g.slug), reloadStore() {} } });
  page.setStore({ status: "loading" });
  assert.ok(host.querySelector(".games-skeleton"));
  page.setStore({ status: "ready", games });
  assert.equal(host.querySelectorAll(".games-capsule").length, 2);
  host.querySelector('[data-game-slug="beta"]').click();
  assert.equal(page.slug(), "beta");
  assert.ok(host.querySelector(".games-detail"));
  const buy = host.querySelector(".games-actions .btn");
  assert.equal(buy.textContent, "マーケットで開く");
  buy.click();
  assert.deepEqual(opened, ["beta"]);
  host.querySelector(".games-back").click();
  assert.equal(page.slug(), null);
  assert.equal(host.querySelectorAll(".games-capsule").length, 2);
  page.setQuery("alp");
  assert.equal(host.querySelectorAll(".games-capsule").length, 1);
  page.setStore({ status: "error", message: "x" });
  assert.match(host.textContent, /読み込めませんでした/);
});

test("the games view keeps the library only: no store routes, and the store root is not a body route", () => {
  const { document, host } = fresh();
  const page = createGamesPage({ document, host, deps: { asset() {}, launch() {}, remove() {}, add() {} } });
  assert.equal(page.setStore, undefined);
  page.setLocal([{ id: 1, title: "Local", executablePath: "C:/a.exe" }]);
  page.go({ page: "store" });
  assert.deepEqual(page.route(), { page: "library" });
  assert.match(host.textContent, /Local/);
  page.go({ page: "store-game", slug: "alpha" });
  assert.deepEqual(page.route(), { page: "library" });
  page.go({ page: "game", id: "1" });
  assert.ok(host.querySelector('.games-detail[data-kind="local"]'));
});

test("the tree's ストア row is an entry that hands off to the market, never to the games body", () => {
  const { document, host } = fresh();
  const gone = [];
  renderGamesTree({ document, host, model: gamesTreeModel({ installed: [] }), route: { page: "library" }, onGo: (r) => gone.push(r.page) });
  [...host.querySelectorAll("button")].find((b) => b.textContent === "ストア").click();
  assert.deepEqual(gone, ["store"]);
  const app = read("app.js");
  assert.match(app, /target\.page === "store" \? openMarketGames\(\) : gamesPage\.go\(target\)/);
  assert.match(app, /function openMarketGames\(\) \{[\s\S]*?data-view="market"[\s\S]*?data-shop-tab="games"/);
});

test("the market has a ゲーム tab and panel; games stay on the existing read; the buy path is the Web market", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.match(html, /data-shop-tab="games"[^>]*>ゲーム</);
  assert.match(html, /id="market-games"[\s\S]*id="market-games-main"/);
  assert.ok(app.includes('tab.dataset.shopTab === "games") marketBrowse?.setCategory("game")'));
  assert.match(app, /resource: "games_store"/);
  assert.match(app, /\/v2\/market\/games\/\$\{encodeURIComponent\(entry\.slug\)\}/);
  assert.doesNotMatch(app, /\/v2\/games\//);
  const rust = read("../src-tauri/src/hub_client.rs");
  assert.match(rust, /"games_store" => Some\("\/api\/games\/store"\)/);
});
