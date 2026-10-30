import { test } from "node:test";
import assert from "node:assert/strict";
import { createRailNav } from "./rail-nav.mjs";

test("list -> detail -> back -> forward, per view", async () => {
  const seen = [];
  const nav = createRailNav();
  nav.handle("messages", (entry) => { seen.push(entry.key); return true; });
  assert.equal(nav.can("messages", -1), false);
  nav.visit("messages", "c1", { id: 1 });
  assert.equal(nav.can("messages", -1), true);
  assert.equal(nav.can("messages", 1), false);
  assert.equal(nav.can("posts", -1), false, "views are independent");
  assert.equal(await nav.back("messages"), true);
  assert.deepEqual(seen, ["list"]);
  assert.equal(nav.can("messages", 1), true);
  assert.equal(await nav.forward("messages"), true);
  assert.deepEqual(seen, ["list", "c1"]);
  assert.equal(nav.can("messages", 1), false);
});

test("closing a detail is a back step; a new visit drops forward entries", async () => {
  const nav = createRailNav();
  nav.handle("music", () => true);
  nav.visit("music", "a");
  nav.closed("music");
  assert.equal(nav.can("music", -1), false);
  assert.equal(nav.can("music", 1), true);
  nav.visit("music", "b");
  assert.equal(nav.can("music", 1), false);
  assert.equal(nav.can("music", -1), true);
});

test("visits during navigation are ignored; stale entries are dropped; null keeps position", async () => {
  const nav = createRailNav();
  let mode = true;
  nav.handle("search", (entry) => { nav.visit("search", "ignored"); return entry.key === "x" ? mode : true; });
  nav.visit("search", "x");
  await nav.back("search");
  mode = false;
  assert.equal(await nav.forward("search"), false);
  assert.equal(nav.can("search", 1), false, "entry that can no longer open is removed");
  nav.visit("search", "x"); await nav.back("search");
  mode = null;
  assert.equal(await nav.forward("search"), false);
  assert.equal(nav.can("search", 1), true, "busy handler keeps the entry");
  nav.reset("search");
  assert.equal(nav.can("search", 1), false);
});

test("a custom base entry records the state before the first visit", async () => {
  const seen = [];
  const nav = createRailNav();
  nav.handle("ai", (entry) => { seen.push(entry.key); return true; });
  nav.visit("ai", "run-2", null, { key: "run-1" });
  await nav.back("ai");
  assert.deepEqual(seen, ["run-1"]);
});
