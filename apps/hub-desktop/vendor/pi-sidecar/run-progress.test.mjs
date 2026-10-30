import { test } from "node:test";
import assert from "node:assert/strict";
import { RunProgress } from "./run-progress.mjs";

test("three unchanged failures or 2/3-step cycles stop, regardless of JSON key order", () => {
  for (const width of [1, 2, 3]) {
    const progress = new RunProgress();
    for (let i = 0; i < width * 3; i++) {
      assert.equal(progress.reason, null);
      progress.after("hub_read", i % 2 ? { path: `${i % width}.txt`, summary: "changed" } : { summary: "first", path: `${i % width}.txt` }, false, "file_not_found");
    }
    assert.equal(progress.reason, "repeated_tool_cycle");
  }
});

test("new observations and successful changes keep a long task running", () => {
  const progress = new RunProgress();
  for (let revision = 0; revision < 64; revision++) {
    progress.after("hub_read", { path: "notes.txt" }, true, [{ text: `revision ${revision}` }]);
    progress.after("hub_read", { path: "notes.txt" }, true, [{ text: `revision ${revision}` }]);
    progress.after("hub_edit", { path: "notes.txt" }, true, { changed: true });
    assert.equal(progress.before("hub_read", { path: "notes.txt" }), null);
  }
  assert.ok(progress.history.length <= 9);
});

test("a denied action cannot be resubmitted with a different summary or key order", () => {
  const progress = new RunProgress();
  const args = { program: "node", args: ["test.cjs"], summary: "test" };
  progress.after("hub_exec", args, false, "approval_denied");
  progress.after("hub_read", { path: "notes.txt" }, true, [{ text: "new" }]);
  assert.equal(progress.before("hub_exec", { args: ["test.cjs"], summary: "retry", program: "node" }), "denied_action_repeated");
  assert.equal(new RunProgress().before("hub_exec", args), null);
});

test("changed arguments, changed errors and changed file results are distinct", () => {
  for (const field of ["path", "error", "result"]) {
    const progress = new RunProgress();
    for (let i = 0; i < 40; i++) {
      progress.after("hub_read", { path: field === "path" ? `${i}.txt` : "notes.txt" }, field === "result",
        field === "path" ? "missing" : { text: `${field} ${i}` });
      assert.equal(progress.reason, null);
    }
  }
});

test("distinct denials have a bounded per-run history", () => {
  const progress = new RunProgress();
  for (let i = 0; i < 255; i++) {
    progress.after("hub_exec", { program: "node", args: [`${i}.cjs`] }, false, "approval_denied");
    assert.equal(progress.reason, null);
  }
  progress.after("hub_exec", { program: "node", args: ["255.cjs"] }, false, "approval_denied");
  assert.equal(progress.reason, "too_many_denied_actions");
  assert.equal(progress.denied.size, 256);
  assert.equal(progress.before("hub_read", { path: "notes.txt" }), "too_many_denied_actions");
});

test("advisory fires once when a 1-3 call cycle has repeated twice, before the hard stop", () => {
  for (const width of [1, 2, 3]) {
    const progress = new RunProgress();
    const call = (i) => progress.after(i % width ? "hub_search" : "hub_read", { path: `${i % width}.txt` }, true, [{ text: "same" }]);
    for (let i = 0; i < width * 2 - 1; i++) { call(i); assert.equal(progress.takeAdvisory(), null); }
    call(width * 2 - 1);
    assert.equal(progress.reason, null);
    const advisory = progress.takeAdvisory();
    assert.deepEqual([...advisory.tools].sort(), width === 1 ? ["hub_read"] : ["hub_read", "hub_search"]);
    assert.equal(progress.takeAdvisory(), null);
    for (let i = width * 2; i < width * 3; i++) call(i);
    assert.equal(progress.reason, "repeated_tool_cycle");
    assert.equal(progress.takeAdvisory(), null);
  }
});

test("advisory is once per distinct cycle and a changed result or mutation clears the count", () => {
  const progress = new RunProgress();
  const read = (text) => progress.after("hub_read", { path: "a.txt" }, true, [{ text }]);
  read("v1"); read("v1");
  assert.deepEqual(progress.takeAdvisory(), { tools: ["hub_read"] });
  read("v2");
  assert.equal(progress.takeAdvisory(), null);
  progress.after("hub_edit", { path: "a.txt" }, true, {});
  read("v1"); read("v1"); // same cycle as before: already advised
  assert.equal(progress.takeAdvisory(), null);
  progress.after("hub_search", { query: "q" }, true, [{ text: "r" }]);
  progress.after("hub_search", { query: "q" }, true, [{ text: "r" }]);
  assert.deepEqual(progress.takeAdvisory(), { tools: ["hub_search"] });
});

test("failures repeated twice advise too, and a changing run never does", () => {
  const progress = new RunProgress();
  progress.after("hub_read", { path: "x" }, false, "file_not_found");
  progress.after("hub_read", { path: "x" }, false, "file_not_found");
  assert.deepEqual(progress.takeAdvisory(), { tools: ["hub_read"] });
  const calm = new RunProgress();
  for (let i = 0; i < 30; i++) calm.after("hub_read", { path: `${i}.txt` }, true, [{ text: String(i) }]);
  assert.equal(calm.takeAdvisory(), null);
  assert.equal(calm.reason, null);
});
