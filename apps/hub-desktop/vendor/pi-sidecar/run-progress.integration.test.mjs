import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("./pi-sidecar.mjs", import.meta.url));
async function fixture(scenario, fn, engine = "thin") {
  const cwd = await mkdtemp(join(tmpdir(), "hub-pi-progress-"));
  try { await fn((entries = []) => run(cwd, scenario, entries, engine)); }
  finally {
    assert.equal(dirname(await realpath(cwd)), await realpath(tmpdir()));
    await rm(cwd, { recursive: true });
  }
}

function run(cwd, scenario, entries, engine) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], {
      cwd, windowsHide: true,
      env: { ...process.env, PI_SIDECAR_MODEL: "", PI_POC_SCENARIO: scenario, PI_SIDECAR_SESSION: "1",
        PI_WORK_ENGINE: engine,
        PI_SIDECAR_CWD: cwd, PI_CODING_AGENT_DIR: join(cwd, "agent-dir") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "", stderr = "", calls = 0;
    const frames = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error("sidecar timeout")); }, 20000);
    child.stdout.on("data", (data) => {
      buffer += data;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        frames.push(frame);
        if (frame.type === "tool_call") {
          calls++;
          const reply = scenario === "prefix"
            ? { type: "tool_result", id: frame.id, content: [{ type: "text", text: `revision-${entries.length}-${calls}` }] }
            : { type: "tool_error", id: frame.id, message: scenario === "deny-repeat" ? "approval_denied" : "file_unavailable" };
          child.stdin.write(`${JSON.stringify(reply)}\n`);
        }
      }
    });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr));
      else resolve({ frames, calls, stderr });
    });
    child.stdin.write(`${JSON.stringify({ type: "session", entries })}\n`);
  });
}

test("DSH stops repeated failure, saves context and cannot report completion", () => fixture("repeat", async (run) => {
  const result = await run();
  assert.equal(result.calls, 3, result.stderr);
  assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, false, result.stderr);
}, "dsh"));

test("DSH refuses a denied retry before sending a second Hub request", () => fixture("deny-repeat", async (run) => {
  const result = await run();
  assert.equal(result.calls, 1, result.stderr);
  assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, false, result.stderr);
}, "dsh"));

// The standard engine was deleted (2026-10-18, owner-approved): the sidecar refuses it.
test("the sidecar refuses the deleted standard engine before any model request or Hub call", () => fixture("read", async (run) => {
  const result = await run();
  assert.equal(result.calls, 0);
  assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, false);
  assert.equal(result.frames.some((frame) => frame.type === "checkpoint"), false);
  assert.match(result.stderr, /standard_engine_retired/);
}, "pi"));

test("64 progressing thin steps preserve SDK prompt/tools/session and chronological prefixes across resume", () => fixture("prefix", async (run) => {
  const first = await run();
  const saved = first.frames.findLast((frame) => frame.type === "checkpoint").entries;
  assert.equal(saved[0].hubEngine, "thin");
  const second = await run(saved);
  for (const result of [first, second]) {
    // Each native read is two Hub calls (access, then read).
    assert.equal(result.calls, 64);
    assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, true, result.stderr);
    assert.doesNotMatch(result.stderr, /MaxListenersExceededWarning|run stopped/);
  }
  const probes = [...first.frames, ...second.frames].filter((frame) => frame.event?.type === "fixture_prefix").map((frame) => frame.event);
  assert.equal(probes.length, 66);
  for (let i = 1; i < probes.length; i++) {
    const previous = probes[i - 1], current = probes[i];
    assert.equal(current.system, probes[0].system, "system prompt changed");
    assert.equal(current.tools, probes[0].tools, "tool definitions changed");
    assert.equal(current.session, probes[0].session, "session identity changed");
    assert.equal(current.prefixes[previous.messages - 1], previous.prefixes.at(-1), `history prefix changed at ${i}`);
  }
}));

test("DSH preserves provider session affinity and chronological prefixes for 64 steps across resume", () => fixture("prefix", async (run) => {
  const first = await run();
  const saved = first.frames.findLast((frame) => frame.type === "checkpoint").entries;
  assert.equal(saved[0].type, "dsh-session");
  const second = await run(saved);
  for (const result of [first, second]) {
    assert.equal(result.calls, 32);
    assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, true, result.stderr);
  }
  const probes = [...first.frames, ...second.frames].filter((frame) => frame.event?.type === "fixture_prefix").map((frame) => frame.event);
  assert.equal(probes.length, 68, "64 tools, two final responses and two completion reviews");
  for (let i = 1; i < probes.length; i++) {
    const previous = probes[i - 1], current = probes[i];
    assert.equal(current.system, probes[0].system);
    assert.equal(current.tools, probes[0].tools);
    assert.equal(current.session, probes[0].session);
    assert.equal(current.prefixes[previous.messages - 1], previous.prefixes.at(-1), `history prefix changed at ${i}`);
  }
}, "dsh"));
