import { test } from "node:test";
import assert from "node:assert/strict";
import { toolErrorMessage } from "./tool-errors.mjs";

test("every refusal returns a short specific reason plus the allowed next step", () => {
  for (const code of ["path_not_allowed", "exec_not_permitted", "http_not_permitted", "test_not_permitted", "write_not_permitted",
    "approval_required", "linked_path_not_allowed", "url_not_allowed", "cwd_invalid", "read_before_test_required", "unknown_tool"]) {
    const [first, hint, ...rest] = toolErrorMessage(code).split("\n");
    assert.equal(first, code); assert.equal(rest.length, 0);
    assert.match(hint, /^Refused: /, code);
    assert.match(hint, /Next: |Use |use /, code);
    assert.ok(hint.length <= 320, `${code} hint is ${hint.length} chars`);
  }
});

test("execution refusals never suggest a bypass and keep test claims honest", () => {
  const exec = toolErrorMessage("exec_not_permitted");
  assert.match(exec, /Do not ask a subagent or another tool to run it/);
  assert.match(exec, /not run/);
  assert.match(toolErrorMessage("test_not_permitted"), /do not describe it as passed/);
  assert.match(toolErrorMessage("approval_denied"), /Do not retry it/);
});

test("unknown codes and command reports pass through unchanged", () => {
  assert.equal(toolErrorMessage("command_failed: {\"exitCode\":1}"), "command_failed: {\"exitCode\":1}");
  assert.equal(toolErrorMessage("constructor"), "constructor");
  assert.equal(toolErrorMessage("toString"), "toString");
});