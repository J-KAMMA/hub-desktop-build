import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  gamePlatformBadge, formatGameReleaseDate, normalizeStoreGames, filterStoreGames,
  renderStoreGames, renderStoreLoading, renderStoreError,
} from "./games-view.mjs";

const { JSDOM } = createRequire(new URL("../../../package.json", import.meta.url))("jsdom");
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const fresh = () => { const { document } = new JSDOM("<div id='t'></div>").window; return { document, target: document.querySelector("#t") }; };

test("platform badge and release date follow the Web store rules", () => {
  assert.equal(gamePlatformBadge("PlayStation 5"), "PS5");
  assert.equal(gamePlatformBadge("Xbox Series X|S"), "Xbox Series");
  assert.equal(gamePlatformBadge("A very long platform name"), "A very long pla…");
  assert.equal(formatGameReleaseDate("2026-10-18"), "2026年10月18日");
  assert.equal(formatGameReleaseDate("2026-02-31"), null);
  assert.equal(formatGameReleaseDate(null), null);
});

test("normalize drops rows without slug or title and filters by text", () => {
  const games = normalizeStoreGames({ games: [{ slug: "a", title: "Alpha", summary: "sword", platforms: ["PC"] }, { title: "no slug" }, null] });
  assert.equal(games.length, 1);
  assert.equal(games[0].price, "");
  assert.equal(filterStoreGames(games, "ALP").length, 1);
  assert.equal(filterStoreGames(games, "zzz").length, 0);
  assert.deepEqual(normalizeStoreGames(undefined), []);
});

test("store renders one featured capsule, a grid, and opens the game on click", () => {
  const { document, target } = fresh();
  const opened = [];
  const games = normalizeStoreGames({ games: [
    { slug: "a", title: "Alpha", summary: "first", platforms: ["PC", "Nintendo Switch"], releaseDate: "2026-10-18", priceLabel: "無料" },
    { slug: "b", title: "Beta", summary: "", platforms: ["iOS"] },
  ] });
  renderStoreGames(document, target, games, { asset: (img, url) => { img.src = url; }, open: (g) => opened.push(g.slug), retry() {} });
  assert.equal(target.querySelectorAll(".games-featured").length, 1);
  assert.equal(target.querySelectorAll(".games-grid .games-capsule").length, 1);
  assert.match(target.querySelector(".games-featured").textContent, /Alpha.*first.*Switch.*2026年10月18日 ・ 無料/);
  target.querySelector('[data-game-slug="b"]').click();
  assert.deepEqual(opened, ["b"]);
});

test("empty and error states use state-panel with a secondary retry button", () => {
  const { document, target } = fresh();
  let retried = 0;
  renderStoreGames(document, target, [], { asset() {}, open() {}, retry: () => { retried += 1; } });
  assert.match(target.querySelector(".state-panel .state-title").textContent, /見つかりません/);
  target.querySelector(".btn.btn-secondary").click();
  renderStoreError(document, target, "ハブへ接続できません", () => { retried += 1; });
  assert.match(target.querySelector(".state-body").textContent, /ハブへ接続できません/);
  target.querySelector(".btn.btn-secondary").click();
  assert.equal(retried, 2);
  renderStoreLoading(document, target);
  assert.equal(target.querySelectorAll(".games-skeleton-card").length, 4);
});

test("the games entry (すべて・クイック切替え) opens the market games tab, and no local launcher remains", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.match(html, /<button class="nav-item" data-view="games"/);
  assert.doesNotMatch(html, /id="view-games"|id="games-dialog"|id="game-add"|id="game-state"/);
  assert.match(app, /if \(view === "games"\) \{ openMarketGames\(\); return; \}/);
  assert.match(app, /\.nav-item\[data-view="\$\{view\}"\]/);
  assert.doesNotMatch(app, /launch_game|remove_game|pick_game_executable|rename_game|loadGamesView/);
  assert.doesNotMatch(read("games-view.css"), /:\s*#[0-9a-fA-F]{3,8}\b|(?:font-size|border-radius)\s*:\s*\d+px/);
});
