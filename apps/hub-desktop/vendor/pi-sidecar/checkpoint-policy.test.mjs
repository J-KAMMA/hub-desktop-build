import { test } from "node:test";
import assert from "node:assert/strict";
import { SIDE_EFFECT_TOOLS, THIN_UNKNOWN_OUTCOME_TEXT, UNKNOWN_OUTCOME_TEXT, isSideEffectTool, repairDanglingToolCalls } from "./checkpoint-policy.mjs";

const call = (id, name = "hub_write") => ({ type: "toolCall", id, name, arguments: {} });
const assistant = (id, parentId, calls, stopReason = "toolUse") => ({ type: "message", id, parentId, message: { role: "assistant", content: calls, stopReason } });
const result = (id, parentId, toolCallId) => ({ type: "message", id, parentId, message: { role: "toolResult", toolCallId, toolName: "hub_write", content: [{ type: "text", text: "ok" }], isError: false } });
const user = (id, parentId) => ({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text: "go" }] } });
const header = { type: "session", id: "s" };

test("side-effect set is exactly the mutating Hub tools, thin native writes included", () => {
  assert.deepEqual([...SIDE_EFFECT_TOOLS].sort(), ["hub_edit", "hub_exec", "hub_fs_write", "hub_http", "hub_pay", "hub_test", "hub_write"]);
  for (const name of ["hub_fs", "hub_read", "hub_read_range", "hub_search", "hub_list", "hub_catalog_search", "hub_product_read", "hub_todo", "", undefined, null])
    assert.equal(isSideEffectTool(name), false);
  assert.equal(isSideEffectTool("hub_pay"), true);
});

test("a dangling call gets one unknown-outcome error result directly after its assistant entry", () => {
  const entries = [header, user("u", null), assistant("a", "u", [call("c1")]), user("n", "a")];
  const fixed = repairDanglingToolCalls(entries);
  assert.equal(fixed.length, 5);
  const synthetic = fixed[3].message;
  assert.equal(fixed[3].parentId, "a");
  assert.deepEqual([synthetic.role, synthetic.toolCallId, synthetic.toolName, synthetic.isError], ["toolResult", "c1", "hub_write", true]);
  assert.equal(synthetic.content[0].text, UNKNOWN_OUTCOME_TEXT);
  assert.equal(fixed[4].parentId, fixed[3].id, "the following entry must be relinked under the synthesized result");
  assert.equal(new Set(fixed.map((e) => e.id)).size, fixed.length);
  assert.equal(entries.length, 4, "input is not mutated");
  assert.equal(entries[3].parentId, "a");
});

test("only unanswered calls are closed, in call order, as a linear chain", () => {
  const entries = [header, assistant("a", null, [call("c1"), call("c2", "hub_exec"), call("c3")]), result("r", "a", "c2")];
  const fixed = repairDanglingToolCalls(entries);
  assert.deepEqual(fixed.filter((e) => e.message?.role === "toolResult").map((e) => e.message.toolCallId), ["c1", "c3", "c2"]);
  const synthetic = fixed.filter((e) => e.message?.details?.outcome === "unknown");
  assert.deepEqual(synthetic.map((e) => e.message.toolCallId), ["c1", "c3"]);
  assert.equal(synthetic[0].parentId, "a");
  assert.equal(synthetic[1].parentId, synthetic[0].id);
  assert.equal(fixed.find((e) => e.id === "r").parentId, synthetic[1].id);
});

test("complete, errored, aborted and truncated histories are returned unchanged", () => {
  const complete = [header, assistant("a", null, [call("c1")]), result("r", "a", "c1")];
  assert.equal(repairDanglingToolCalls(complete), complete);
  for (const stopReason of ["error", "aborted", "length"]) {
    const entries = [header, assistant("a", null, [call("c1")], stopReason)];
    assert.equal(repairDanglingToolCalls(entries), entries, stopReason);
  }
  assert.equal(repairDanglingToolCalls(undefined), undefined);
  assert.deepEqual(repairDanglingToolCalls([]), []);
  const odd = [header, null, { type: "message", id: "x", message: { role: "assistant" } }, assistant("a", null, "not-array")];
  assert.equal(repairDanglingToolCalls(odd), odd);
});

test("repair is idempotent and avoids id collisions", () => {
  const entries = [header, assistant("a", null, [call("c1")]), { type: "custom", id: "unk2", parentId: "a" }];
  const once = repairDanglingToolCalls(entries);
  assert.equal(new Set(once.map((e) => e.id)).size, once.length);
  assert.equal(repairDanglingToolCalls(once), once);
});

test("the thin engine's unknown-outcome text names its own read tool", () => {
  const entries = [header, user("u", null), assistant("a", "u", [call("c1", "write")])];
  const fixed = repairDanglingToolCalls(entries, 0, THIN_UNKNOWN_OUTCOME_TEXT);
  assert.equal(fixed[3].message.content[0].text, THIN_UNKNOWN_OUTCOME_TEXT);
  assert.equal(fixed[3].message.toolName, "write");
  assert.ok(!THIN_UNKNOWN_OUTCOME_TEXT.includes("hub_read"));
});
