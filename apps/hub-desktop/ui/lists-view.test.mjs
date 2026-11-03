import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { listRowsError, listRowsSkeleton, renderListsRows } from "./lists-view.mjs";

// リストの画面（2026-11-02）：区切り線の行・空の状態・静かなエラー。枠つきのカードにしない。
const dom = () => new JSDOM("<div id=t></div>").window;
const emptyState = (document) => (title) => { const box = document.createElement("div"); box.className = "empty-state"; box.append(Object.assign(document.createElement("strong"), { textContent: title })); return box; };

test("lists render as divider rows: name, muted member count, optional one-line description; a row opens its list", () => {
  const { document } = dom(), target = document.querySelector("#t"), opened = [];
  renderListsRows(document, target, { lists: [
    { id: "a", name: "アプリ検証リスト", profileIds: ["1", "2", "3"], description: "検証に使う人たち" },
    { id: "b", name: "空の説明", profileIds: [], description: "   " },
  ] }, { onOpen: (list) => opened.push(list.id), onCreate() {}, emptyState: emptyState(document) });
  const rows = [...target.querySelectorAll(".list-rows > .list-row")];
  assert.equal(rows.length, 2);
  assert.equal(target.querySelector(".card, .result-card"), null, "no boxed cards");
  assert.equal(rows[0].querySelector(".list-row-name").textContent, "アプリ検証リスト");
  assert.equal(rows[0].querySelector(".list-row-count").textContent, "3人");
  assert.equal(rows[0].querySelector(".list-row-description").textContent, "検証に使う人たち");
  assert.equal(rows[1].querySelector(".list-row-description"), null, "no description line when blank");
  rows[0].click();
  assert.deepEqual(opened, ["a"]);
});

test("no lists: 「リストはまだありません」 with a 「リストを作る」 action", () => {
  const { document } = dom(), target = document.querySelector("#t");
  let created = 0;
  renderListsRows(document, target, { lists: [] }, { onOpen() {}, onCreate: () => created++, emptyState: emptyState(document) });
  assert.equal(target.querySelector("strong").textContent, "リストはまだありません");
  const create = target.querySelector("button");
  assert.equal(create.textContent, "リストを作る");
  create.click();
  assert.equal(created, 1);
});

test("a load failure is one quiet inline line with 再試行, and the skeleton is divider rows, not cards", () => {
  const { document } = dom(), target = document.querySelector("#t");
  target.replaceChildren(listRowsSkeleton(document));
  assert.equal(target.querySelectorAll(".list-rows > .list-row-skeleton").length, 3);
  assert.equal(target.querySelector(".card, .skeleton-post"), null);
  let retried = 0;
  target.replaceChildren(listRowsError(document, () => retried++));
  assert.equal(target.querySelector(".list-row-skeleton"), null, "the skeleton is gone");
  assert.equal(target.querySelector("[role=alert] span").textContent, "読み込めませんでした");
  target.querySelector("button").click();
  assert.equal(retried, 1);
});

test("loadCatalog gives the lists view a deadline and the inline error instead of waiting for ever", () => {
  const source = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(source, /lists: \{ client: "lists", render: renderListsView \}/);
  assert.match(source, /view === "lists" \? LIST_ROWS_DEADLINE_MS/);
  assert.match(source, /if \(view === "lists"\) target\.replaceChildren\(listRowsSkeleton\(\)\)/);
  assert.match(source, /view === "lists" && !accountNeeded\(error\)/);
  const css = readFileSync(new URL("./desktop-views.css", import.meta.url), "utf8");
  assert.match(css, /\.list-rows \.list-row:not\(#_\) \{[^}]*border-bottom: 1px solid var\(--divider\)/);
});
