import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("./pi-sidecar.mjs", import.meta.url));
// The run token Hub's proxy would issue; the fixture server plays that proxy.
const KEY = "0123456789abcdef".repeat(4);

function run(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, "hub-byok/fixture-model", "Say OK."], {
      cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_SIDECAR_CAPS: "", PI_SIDECAR_SESSION: "1", PI_WORK_ENGINE: "thin", PI_SIDECAR_RETRY_BASE_MS: "5", ...env },
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("byok fixture timeout")); }, 20000);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("close", () => { clearTimeout(timer); resolve({ stdout, stderr, frames: stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)) }); });
    child.stdin.write(`${JSON.stringify({ type: "session", entries: [] })}\n`);
  });
}

test("a BYOK run sends the key only to the provider and never into frames, checkpoints, logs or files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hub-byok-run-"));
  const seen = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    seen.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    chunk({ role: "assistant", content: "OK" });
    chunk({}, "stop", { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
    response.end("data: [DONE]\n\n");
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const result = await run(cwd, {
      PI_SIDECAR_BYOK: JSON.stringify({ kind: "openai_compatible", api: "openai-completions", baseUrl, model: "fixture-model", proxy: true }),
      PI_SIDECAR_BYOK_TOKEN: KEY,
    });
    assert.equal(result.frames.find((frame) => frame.type === "hello")?.model, "hub-byok/fixture-model", result.stderr);
    assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, true, result.stderr);
    assert.ok(seen.length >= 1 && seen.every((value) => value === `Bearer ${KEY}`), "only the proxy received the run token");
    assert.ok(result.frames.some((frame) => frame.type === "checkpoint"));
    assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY), "no frame, checkpoint or log carries the token");
    for (const name of await readdir(cwd)) assert.ok(!(await readFile(join(cwd, name), "utf8").catch(() => "")).includes(KEY), name);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a connection that is not the run proxy fails closed before any request", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hub-byok-run-"));
  try {
    const result = await run(cwd, {
      PI_SIDECAR_BYOK: JSON.stringify({ kind: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", model: "fixture-model" }),
      PI_SIDECAR_BYOK_TOKEN: "",
    });
    assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, false);
    assert.equal(result.frames.find((frame) => frame.type === "hello")?.model, null);
    assert.match(result.stderr, /byok_connection_invalid/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
