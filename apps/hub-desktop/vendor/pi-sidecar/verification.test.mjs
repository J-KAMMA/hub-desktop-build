import { test } from "node:test";
import assert from "node:assert/strict";
import { compactVerificationFailure, hasFinalAnswer, MAX_VERIFY_ROUNDS, verifyWork } from "./verification.mjs";

test("a final answer needs visible text, a normal stop and no outstanding tool call", () => {
  const answer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "完了" }] };
  assert.equal(hasFinalAnswer(answer), true);
  for (const message of [undefined, {}, { ...answer, role: "user" }, { ...answer, stopReason: "length" },
    ...[undefined, [], [null], [{ type: "text", text: 3 }], [{ type: "text", text: " \n\t" }],
      [{ type: "thinking", thinking: "completed" }], [...answer.content, { type: "toolCall", name: "hub_read" }],
    ].map((content) => ({ ...answer, content })),
  ]) assert.equal(hasFinalAnswer(message), false);
});

test("executes required verification after a finished response, then repairs once", async () => {
  const calls = [];
  let attempts = 0;
  const ok = await verifyWork({ prompt: "Keep the CommonJS interface", complete: () => true,
    check: async () => { calls.push("check"); if (!attempts++) throw new Error("command_failed: assertion"); return { details: { exitCode: 0, timedOut: false } }; },
    repair: async (text) => { assert.match(text, /Keep the CommonJS interface/); assert.match(text, /without changing or weakening/); calls.push("repair"); },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ["check", "repair", "check"]);
});

test("denied, unavailable and incomplete runs never repair or report success", async () => {
  for (const error of ["approval_denied\nDo not retry", "exec_not_permitted", "spawn_failed"]) {
    assert.equal(await verifyWork({ prompt: "x", complete: () => true, check: async () => { throw new Error(error); }, repair: async () => assert.fail("must not repair") }), false);
  }
  assert.equal(await verifyWork({ complete: () => false, check: async () => assert.fail("must not execute"), repair: async () => assert.fail("must not repair") }), false);
});

test("bounds automatic rounds at five and requires an actual successful exit", async () => {
  let attempts = 0, repairs = 0;
  const reports = [];
  assert.equal(await verifyWork({ prompt: "x", complete: () => true, report: (r) => reports.push(r), check: async () => { attempts++; throw new Error("command_failed: still broken"); }, repair: async () => { repairs++; } }), false);
  assert.equal(attempts, MAX_VERIFY_ROUNDS); assert.equal(MAX_VERIFY_ROUNDS, 5); assert.equal(repairs, 4);
  assert.deepEqual(reports.filter((r) => r.status === "failed").map((r) => `${r.round}/${r.rounds}`), ["1/5", "2/5", "3/5", "4/5", "5/5"]);
  attempts = 0;
  assert.equal(await verifyWork({ prompt: "x", rounds: 99, complete: () => true, check: async () => { attempts++; throw new Error("command_failed: x"); }, repair: async () => {} }), false);
  assert.equal(attempts, 5, "a caller cannot raise the cap");
  for (const details of [{}, { exitCode: 1, timedOut: false }, { exitCode: 0, timedOut: true }]) {
    assert.equal(await verifyWork({ complete: () => true, check: async () => ({ details }), repair: async () => assert.fail("not a valid result") }), false);
  }
});

test("a model's claim of a pass is not a verification record", async () => {
  // complete() true with a final text claiming success still requires Hub's own exit record.
  let repaired = 0;
  const ok = await verifyWork({ prompt: "x", complete: () => true, repair: async () => { repaired++; },
    check: async () => { throw new Error('command_failed: {"exitCode":1,"timedOut":false,"stdout":"All tests passed (model said so)","stderr":"FAILED test_a.py::test_one - AssertionError"}'); } });
  assert.equal(ok, false); assert.equal(repaired, 4);
});

test("repair feedback is a compact pass/fail line plus the first failing lines", async () => {
  const noise = Array.from({ length: 500 }, (_, i) => `collected line ${i} ok`).join("\n");
  const failing = Array.from({ length: 80 }, (_, i) => `FAILED test_x.py::test_${i} - AssertionError: expected ${i}`).join("\n");
  const message = `command_failed: ${JSON.stringify({ exitCode: 1, timedOut: false, stdout: `${noise}\n${failing}`, stderr: "" })}`;
  const summary = compactVerificationFailure(message);
  assert.match(summary, /^Verification FAILED \(exit code 1\)\nFirst failing lines \(30 of 80\):\n/);
  assert.ok(summary.includes("test_0 ") && summary.includes("test_29 ") && !summary.includes("test_30 "));
  assert.ok(!summary.includes("collected line"));
  assert.ok(summary.length < 3000, `compact summary was ${summary.length} chars`);
  assert.match(compactVerificationFailure(`command_failed: ${JSON.stringify({ exitCode: null, timedOut: true, stdout: "a\nb", stderr: "" })}`), /^Verification FAILED \(timed out\)\nFirst output lines \(2 of 2\):\na\nb$/);
  assert.match(compactVerificationFailure("command_failed: " + "x".repeat(5000)), /x…$/);
  let feedback = "";
  await verifyWork({ prompt: "keep it", complete: () => true, rounds: 2, check: async () => { throw new Error(message); }, repair: async (text) => { feedback = text; } });
  assert.match(feedback, /round 1 of 2/);
  assert.match(feedback, /do not count as verification/);
  assert.ok(feedback.length < 4000);
});