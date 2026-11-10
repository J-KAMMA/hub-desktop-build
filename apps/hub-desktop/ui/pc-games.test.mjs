import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createPcGames, normalizeLibrary, DOCK_NOTES } from "./pc-games.mjs";

const { JSDOM } = createRequire(new URL("../../../package.json", import.meta.url))("jsdom");
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

const library = {
  games: [
    { id: "steam:111", source: "steam", name: "Fixture Quest" },
    { id: "epic:FixtureApp", source: "epic", name: "Fixture Racer" },
    { id: "bad", source: "steam", name: "no prefix" },
    { id: "steam:5", source: "steam", name: "" },
  ],
  notes: ["xbox_not_supported"],
};

function setup(overrides = {}) {
  const { document } = new JSDOM("<div id='h'></div><div id='b' hidden></div>").window;
  const calls = [];
  const deps = {
    list: async () => library,
    art: async (id) => (id === "steam:111" ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" : null),
    launch: async (id) => { calls.push(["launch", id]); },
    dockStart: async (id, rect, dpr) => { calls.push(["dockStart", id, rect, dpr]); },
    dockRect: async (rect, dpr) => { calls.push(["dockRect", rect, dpr]); },
    dockStop: async () => { calls.push(["dockStop"]); },
    measure: () => ({ rect: { x: 60, y: 40, w: 800, h: 600 }, dpr: 1.5 }),
    ensureRail: () => calls.push(["ensureRail"]),
    notify: (text) => calls.push(["notify", text]),
    ...overrides,
  };
  const host = document.querySelector("#h");
  const bar = document.querySelector("#b");
  return { document, host, bar, calls, page: createPcGames({ document, host, bar, deps }) };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("library keeps only well-formed rows and says Xbox is not shown", async () => {
  assert.deepEqual(normalizeLibrary(library).games.map((g) => g.id), ["steam:111", "epic:FixtureApp"]);
  assert.deepEqual(normalizeLibrary(null), { games: [], notes: [] });
  const { page, host } = setup();
  await page.load();
  await settle();
  assert.equal(host.querySelectorAll(".pcg-tile").length, 2);
  assert.match(host.querySelector(".pcg-note").textContent, /Xbox/);
  assert.equal(host.querySelector('[data-pcg-id="epic:FixtureApp"] .pcg-source').textContent, "Epic");
  // 絵は Steam だけ読み、読めた行に出る。無い行は頭字のタイル。
  assert.ok(host.querySelector('[data-pcg-id="steam:111"] .pcg-art img'));
  assert.equal(host.querySelector('[data-pcg-id="epic:FixtureApp"] .pcg-letter').textContent, "F");
  assert.equal(host.querySelector('[data-pcg-id="epic:FixtureApp"] .pcg-art img'), null);
});

test("empty and error states stay short", async () => {
  const empty = setup({ list: async () => ({ games: [], notes: [] }) });
  await empty.page.load();
  assert.equal(empty.host.querySelector(".pcg-empty").textContent, "見つかりません");
  const broken = setup({ list: async () => { throw new Error("x"); } });
  await broken.page.load();
  assert.ok(broken.host.querySelector(".pcg-empty"));
  assert.equal(broken.host.querySelector(".pcg-tile"), null);
});

test("every control is an icon with an aria-label, and the page sends only the id", async () => {
  const { page, host, calls } = setup();
  await page.load();
  for (const button of host.querySelectorAll("button")) assert.ok(button.getAttribute("aria-label"), button.outerHTML);
  host.querySelector('[data-pcg-id="steam:111"] [data-pcg-launch]').click();
  await settle();
  assert.deepEqual(calls.at(-1), ["launch", "steam:111"]);
  assert.equal(host.querySelector('[data-pcg-id="steam:111"] [data-pcg-launch]').disabled, false);
});

test("dock opens the rail, measures the centre, and shows the stop control", async () => {
  const { page, host, bar, calls } = setup();
  await page.load();
  host.querySelector('[data-pcg-id="epic:FixtureApp"] [data-pcg-dock]').click();
  await settle();
  assert.deepEqual(calls.filter((c) => c[0] === "ensureRail" || c[0] === "dockStart"), [["ensureRail"], ["dockStart", "epic:FixtureApp", { x: 60, y: 40, w: 800, h: 600 }, 1.5]]);
  assert.equal(bar.hidden, false);
  assert.equal(bar.dataset.state, "searching");
  page.setDock({ state: "docked" });
  const stop = bar.querySelector(".pcg-dock-stop");
  assert.equal(stop.getAttribute("aria-label"), "並べるのをやめる");
  assert.equal(stop.textContent, "並べるのをやめる");
  stop.click();
  await settle();
  assert.equal(bar.hidden, true);
  assert.deepEqual(calls.at(-1), ["dockStop"]);
  // 止めた後に遅れて届いた docked は無視する
  page.setDock({ state: "docked" });
  assert.equal(bar.hidden, true);
});

test("refusal notes show a short message that can be closed", async () => {
  const { page, host, bar } = setup();
  await page.load();
  host.querySelector("[data-pcg-dock]").click();
  await settle();
  for (const note of ["timeout", "exclusive", "refused", "gone"]) {
    page.setDock({ state: "stopped", note });
    assert.equal(bar.querySelector(".pcg-dock-text").textContent, DOCK_NOTES[note]);
    assert.equal(bar.querySelector(".pcg-dock-stop"), null);
    assert.ok(DOCK_NOTES[note].length <= 20);
  }
  bar.querySelector(".pcg-dock-close").click();
  assert.equal(bar.hidden, true);
  // Hub 自身が閉じたときの終了は何も出さない
  host.querySelector("[data-pcg-dock]").click();
  await settle();
  page.setDock({ state: "stopped", note: "hub_closed" });
  assert.equal(bar.hidden, true);
});

test("rect changes reach Rust only while docking", async () => {
  const { page, host, calls } = setup();
  await page.load();
  page.syncRect();
  assert.equal(calls.filter((c) => c[0] === "dockRect").length, 0);
  host.querySelector("[data-pcg-dock]").click();
  await settle();
  page.syncRect();
  assert.deepEqual(calls.filter((c) => c[0] === "dockRect"), [["dockRect", { x: 60, y: 40, w: 800, h: 600 }, 1.5]]);
});

test("a failed dock start clears the bar and tells the user briefly", async () => {
  const { page, host, bar, calls } = setup({ dockStart: async () => { throw new Error("game_not_found"); }, friendlyError: () => "見つかりませんでした" });
  await page.load();
  host.querySelector("[data-pcg-dock]").click();
  await settle();
  assert.equal(bar.hidden, true);
  assert.deepEqual(calls.at(-1), ["notify", "見つかりませんでした"]);
});

test("wiring: the section is mounted in the games body, styled with tokens only, and the rail bar exists", () => {
  const app = read("app.js");
  assert.match(app, /gamesHost: gamesBody/);
  assert.match(app, /pc-game-dock/);
  assert.match(app, /invoke\("game_dock_start", \{ id, rect, dpr, launch: true \}\)/);
  const html = read("index.html");
  assert.match(html, /id="pc-dock-bar"/);
  assert.match(html, /pc-games\.css/);
  const css = read("pc-games.css");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\bwhite\b|\bblack\b/);
  // ゲーム一覧は Hub へ送らない：この部品は hub_* の呼び出しを持たない
  assert.doesNotMatch(read("pc-games.mjs"), /hub_resource|hub_client|fetch\(/);
});
