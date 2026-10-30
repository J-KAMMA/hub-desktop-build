import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("./pi-sidecar.mjs", import.meta.url));

// SWE-bench django-11400 stalled after three parallel hub_read calls: the peer wrote a
// large tool_result while the sidecar was blocked in a synchronous stdout write of an
// event that echoed an earlier result. Here the peer stops reading stdout while it writes
// two large answers and never answers the third.
test("parallel reads finish with a blocking peer, and an unanswered call times out as a tool error", async () => {
  const frames = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_POC_SCENARIO: "parallel", PI_WORK_ENGINE: "thin", PI_SIDECAR_SESSION: "1", PI_SIDECAR_TOOL_TIMEOUT_MS: "800" } });
    const timer = setTimeout(() => { child.kill(); reject(new Error("sidecar stalled")); }, 20000);
    const seen = [];
    let buffer = "", calls = [];
    child.stderr.resume();
    child.stdout.on("data", (data) => {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        seen.push(line);
        const frame = JSON.parse(line);
        // Thin: each native read is an access check (answered at once), then the read.
        if (frame.type === "tool_call" && frame.args.op === "access") child.stdin.write(`${JSON.stringify({ type: "tool_result", id: frame.id, content: [{ type: "text", text: "ok" }], details: {} })}\n`);
        else if (frame.type === "tool_call") calls.push(frame);
        if (calls.length === 3) {
          const answered = calls.slice(0, 2);
          calls = [];
          child.stdout.pause(); // a single-threaded peer: no reading while it writes
          let pending = answered.length;
          for (const call of answered) {
            // Below Pi's 50 KB read cap, but two together exceed a pipe buffer.
            const content = `${basename(call.args.path)} ${"x".repeat(45_000)}`;
            child.stdin.write(`${JSON.stringify({ type: "tool_result", id: call.id, content: [{ type: "text", text: content }], details: { content, sizeBytes: content.length } })}\n`,
              () => { if (--pending === 0) child.stdout.resume(); });
          }
        }
        if (frame.type === "agent_done") child.stdin.end();
      }
    });
    child.on("close", () => { clearTimeout(timer); resolve(seen); });
    child.stdin.write(`${JSON.stringify({ type: "session", entries: [] })}\n`);
  });
  const parsed = frames.map((line) => JSON.parse(line));
  const calls = parsed.filter((frame) => frame.type === "tool_call" && frame.args.op === "read");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((frame) => frame.name === "hub_fs"), "thin reads reach Hub only as hub_fs");
  assert.deepEqual(parsed.filter((frame) => frame.type === "cancel").map((frame) => frame.id), [calls[2].id], "the timed-out call is cancelled at Hub");
  const final = parsed.filter((frame) => frame.type === "event" && frame.event.type === "message_end" && frame.event.message?.role === "assistant").at(-1);
  const text = final.event.message.content.map((block) => block.text ?? "").join("");
  assert.match(text, /read:ok:a\.py x+\|read:ok:b\.py x+\|read:error:tool_call_timeout/);
  for (const line of frames.filter((line) => line.startsWith('{"type":"event"'))) {
    assert.ok(line.length < 8192, `event frames do not echo tool results (${line.slice(0, 80)}… ${line.length} chars)`);
  }
  assert.equal(parsed.at(-1).type, "agent_done");
});
