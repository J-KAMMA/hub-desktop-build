import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGuidance, commerceNeeded, createReviewGate, workspaceMayHaveAgentsFile } from "./run-guidance.mjs";

const fileTools = ["hub_read", "hub_search", "hub_list", "hub_write", "hub_edit"];

test("guidance never names a verification tool the run does not offer", () => {
  const text = buildGuidance(fileTools);
  assert.doesNotMatch(text, /hub_exec|hub_test|hub_http|hub_pay|hub_catalog/);
  assert.match(text, /no command or test tool/);
  assert.match(text, /report it as unverified/);
  assert.match(text, /read_before_write_required/);
});

test("guidance names exactly the verification tools that are offered", () => {
  const exec = buildGuidance([...fileTools, "hub_exec"]);
  assert.match(exec, /use hub_exec to check/);
  assert.doesNotMatch(exec, /hub_test/);
  assert.doesNotMatch(exec, /no command or test tool/);
  const test = buildGuidance([...fileTools, "hub_test"]);
  assert.match(test, /use hub_test to check/);
  assert.doesNotMatch(test, /hub_exec/);
  assert.match(buildGuidance([...fileTools, "hub_exec", "hub_test"]), /use hub_exec or hub_test to check/);
});

test("coding prompts do not get the marketplace tools", () => {
  for (const prompt of [
    "Fix the failing tests in book_store.py; the total is the product of price and quantity.",
    "Sort the records in insertion order and report the minimum.",
    "Go to the store and buy some more, 99 bottles of beer on the wall.",
    "Calculate the price of any conceivable shopping basket containing only books of the series.",
    "git checkout the feature branch, then fix the failing tests.",
    "書籍の合計金額を計算する関数を直してください",
    "",
  ]) assert.equal(commerceNeeded({ prompt }), false, prompt);
});

test("marketplace purpose, an explicit capability or an earlier commerce call offers them", () => {
  for (const prompt of ["Buy a USB-C cable from the Hub marketplace", "マーケットで充電器を探して購入したい", "Search the marketplace for stickers"])
    assert.equal(commerceNeeded({ prompt }), true, prompt);
  assert.equal(commerceNeeded({ caps: new Set(["commerce"]), prompt: "fix the build" }), true);
  const earlier = [{ type: "session" }, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "hub_catalog_search", arguments: {} }] } }];
  assert.equal(commerceNeeded({ prompt: "continue", entries: earlier }), true);
  const askedBefore = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "購入したい商品を探して" }] } }];
  assert.equal(commerceNeeded({ prompt: "continue", entries: askedBefore }), true);
  const toolText = [{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "buy now marketplace" }] } }];
  assert.equal(commerceNeeded({ prompt: "continue", entries: toolText }), false, "tool output is not the operator's request");
  assert.equal(commerceNeeded({ prompt: "continue", entries: "not an array" }), false);
});

test("review is skipped right after a successful write when nothing can check it", () => {
  const gate = createReviewGate();
  gate.record("hub_read", true);
  gate.record("hub_write", true);
  gate.record("hub_finish", true);
  assert.equal(gate.shouldReview({ verifyTools: false }), false);
  assert.equal(gate.shouldReview({ verifyTools: true }), true, "an unchecked change keeps the review when a check exists");
});

test("review is skipped when every change was followed by a successful check", () => {
  const gate = createReviewGate();
  gate.record("hub_edit", true);
  gate.record("hub_exec", true);
  assert.equal(gate.shouldReview({ verifyTools: true }), false);
  gate.record("hub_edit", true);
  assert.equal(gate.shouldReview({ verifyTools: true }), true, "a later change is unchecked");
  gate.record("hub_test", false);
  assert.equal(gate.shouldReview({ verifyTools: true }), true, "a failed check checks nothing");
});

test("review stays when nothing changed, or the last write failed or was followed by other work", () => {
  assert.equal(createReviewGate().shouldReview({ verifyTools: false }), true, "a claimed but missing edit is still caught");
  const failed = createReviewGate();
  failed.record("hub_write", true);
  failed.record("hub_edit", false);
  assert.equal(failed.shouldReview({ verifyTools: false }), true);
  const later = createReviewGate();
  later.record("hub_write", true);
  later.record("hub_search", true);
  assert.equal(later.shouldReview({ verifyTools: false }), true);
  const todo = createReviewGate();
  todo.record("hub_write", true);
  todo.record("hub_todo", true);
  assert.equal(todo.shouldReview({ verifyTools: false }), false, "state-only tools do not count as work");
});

test("the AGENTS.md instruction appears only when the workspace may hold one", () => {
  assert.match(buildGuidance(fileTools), /Read applicable AGENTS.md/);
  assert.doesNotMatch(buildGuidance(fileTools, { agentsFiles: false }), /AGENTS/);
  assert.equal(workspaceMayHaveAgentsFile({ files: ["a.py", "README.md"], truncated: false, skippedEntries: 3 }), false);
  assert.equal(workspaceMayHaveAgentsFile({ files: ["src/AGENTS.md"], truncated: false }), true);
  assert.equal(workspaceMayHaveAgentsFile({ files: ["a.py"], truncated: true }), true, "an incomplete map keeps it");
  for (const unknown of [undefined, null, { unavailable: true, files: [] }, { files: "x" }]) assert.equal(workspaceMayHaveAgentsFile(unknown), true);
});
