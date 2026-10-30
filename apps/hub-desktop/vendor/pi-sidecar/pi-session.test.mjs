import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const bundle = fileURLToPath(new URL("./pi-sidecar.mjs", import.meta.url));
// Plays Hub for the thin engine: native reads arrive as hub_fs, writes as hub_fs_write.
function reply(frame) {
  const body = frame.name === "hub_fs" && frame.args.op === "read" ? `answer 41\n${"0 ".repeat(7000)}` : "updated";
  return { content: [{ type: "text", text: body }], details: frame.name === "hub_fs" ? { content: body, exists: true } : {} };
}
function run(cwd, entries, scenario = "compaction") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], {
      cwd, windowsHide: true,
      env: { ...process.env, PI_WORK_ENGINE: "thin", PI_SIDECAR_MODEL: "", PI_POC_SCENARIO: scenario, PI_SIDECAR_SESSION: "1",
        PI_SIDECAR_PROMPT: "Fix notes.txt. Run node verify.cjs; do not edit the test.",
        PI_SIDECAR_CWD: cwd, PI_CODING_AGENT_DIR: join(cwd, "agent-dir") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("sidecar timeout")); }, 15000);
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr));
      const frames = output.trim().split("\n").map((line) => JSON.parse(line));
      frames.stderr = stderr;
      resolve(frames);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.type === "tool_call") child.stdin.write(`${JSON.stringify({ type: "tool_result", id: frame.id,
        ...reply(frame) })}\n`);
      if (frame.type === "agent_done") child.stdin.end();
    });
    child.stdin.write(`${JSON.stringify({ type: "session", entries })}\n`);
  });
}

test("SDK compacts long context, and the checkpoint restores the same summary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hub-pi-compaction-"));
  const timestamp = new Date().toISOString();
  const usage = { input: 7200, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 7201,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const entries = [
    { type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", cwd, timestamp },
    { type: "message", id: "aaaa0001", parentId: null, timestamp,
      message: { role: "user", content: [{ type: "text", text: "discarded-fixture-body ".repeat(1400) }], timestamp: Date.now() } },
    { type: "message", id: "aaaa0002", parentId: "aaaa0001", timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "COMPACTION-KEPT-42" }],
        api: "stub", provider: "stub", model: "stub-1", usage, stopReason: "stop", timestamp: Date.now() } },
    { type: "message", id: "aaaa0003", parentId: "aaaa0002", timestamp,
      message: { role: "user", content: [{ type: "text", text: "recent context ".repeat(700) }], timestamp: Date.now() } },
    { type: "message", id: "aaaa0004", parentId: "aaaa0003", timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "Continue from COMPACTION-KEPT-42" }],
        api: "stub", provider: "stub", model: "stub-1", usage, stopReason: "stop", timestamp: Date.now() } },
  ];
  try {
    const first = await run(cwd, entries);
    assert.equal(first.find((frame) => frame.type === "agent_done")?.ok, true,
      first.stderr + JSON.stringify(first.filter((frame) => frame.event?.type?.startsWith("compaction"))));
    assert.ok(first.some((frame) => frame.event?.type === "compaction_end" && frame.event.result));
    const saved = first.findLast((frame) => frame.type === "checkpoint").entries;
    assert.ok(saved.some((entry) => entry.type === "compaction" && entry.summary.includes("COMPACTION-KEPT-42")));
    assert.ok(!JSON.stringify(saved).includes("discarded-fixture-body"));
    const second = await run(cwd, saved);
    assert.equal(second.find((frame) => frame.type === "agent_done")?.ok, true);
    assert.ok(!second.some((frame) => frame.event?.type === "compaction_start"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const scenario of ["compaction-task", "compaction-midtask"]) test(`SDK ${scenario} preserves the request and write evidence with an async stream and incorrect summary`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hub-pi-task-compaction-"));
  try {
    const frames = await run(cwd, undefined, scenario);
    assert.equal(frames.find((frame) => frame.type === "agent_done")?.ok, true, frames.stderr);
    assert.equal(frames.filter((frame) => frame.event?.type === "compaction_end" && frame.event.result).length, 1);
    const summaryUsage = frames.filter((frame) => frame.event?.type === "compaction_usage");
    assert.ok(summaryUsage.length > 0);
    assert.ok(summaryUsage.every((frame) => frame.event.usage.input === 17 && frame.event.usage.output === 3));
    const anchor = frames.find((frame) => frame.event?.type === "fixture_task_anchor")?.event;
    assert.deepEqual(anchor, { type: "fixture_task_anchor", present: true, requestKept: true, evidenceKept: true });
    const saved = frames.findLast((frame) => frame.type === "checkpoint").entries;
    assert.ok(saved.some((entry) => entry.type === "compaction" && entry.summary.includes("The edit failed")));
    assert.ok(saved.some((entry) => entry.message?.role === "user"
      && JSON.stringify(entry.message.content).includes("Current request preserved after compaction")));
    // Thin: the native read and edit reach Hub only as hub_fs / hub_fs_write.
    assert.deepEqual(frames.filter((frame) => frame.type === "tool_call").map((frame) => frame.name === "hub_fs" ? `hub_fs:${frame.args.op}` : frame.name),
      ["hub_fs:access", "hub_fs:read", "hub_fs:access", "hub_fs:read", "hub_fs_write"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
