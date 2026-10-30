import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { startMcpServer } from "./mcp-server.mjs";
import { hubTools, helloTools, mcpContent, wireArgs } from "./tools.mjs";
import { Transcript, UNKNOWN_OUTCOME, assistantEvent, validHeader } from "./transcript.mjs";
import { engineEnv, prepareRunDir, DEAD_END_PROXY } from "./launch.mjs";
import { opencodeConfig, opencodeEnv } from "./opencode.mjs";
import { dshPatch, dshEnv } from "./dsh.mjs";

const connection = { kind: "anthropic", api: "anthropic-messages", baseUrl: "http://127.0.0.1:5555", model: "claude-haiku-5-5", proxy: true };
const token = "a".repeat(64);
const mcp = { url: "http://127.0.0.1:6666/mcp", token: "b".repeat(64) };

async function rpc(server, body, auth = server.token) {
  const response = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

test("the MCP server needs the run token, lists only Hub tools and refuses unknown names", async () => {
  const seen = [];
  let unknown = 0;
  const server = await startMcpServer({ tools: hubTools(""), call: async (name, args) => { seen.push([name, args]); return { content: [{ type: "text", text: "ok" }] }; }, onUnknownTool: () => unknown++ });
  try {
    assert.equal((await rpc(server, { jsonrpc: "2.0", id: 1, method: "tools/list" }, null)).status, 401);
    assert.equal((await rpc(server, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "c".repeat(64))).status, 401);
    const init = await rpc(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.equal((await rpc(server, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const list = await rpc(server, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(list.body.result.tools.map((tool) => tool.name), ["search", "read", "list", "write", "edit"]);
    const call = await rpc(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read", arguments: { path: "a.txt" } } });
    assert.equal(call.body.result.content[0].text, "ok");
    const bad = await rpc(server, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bash", arguments: { command: "whoami" } } });
    assert.equal(bad.body.result.isError, true);
    assert.equal(unknown, 1);
    assert.deepEqual(seen, [["read", { path: "a.txt" }]]);
  } finally { await server.close(); }
});

test("gated tools appear only with their capability; edit keeps the executor's wire form", () => {
  assert.deepEqual(hubTools("exec,http").map((tool) => tool.hub), ["hub_search", "hub_read", "hub_list", "hub_write", "hub_edit", "hub_exec", "hub_http"]);
  assert.ok(!hubTools("").some((tool) => ["hub_exec", "hub_http", "hub_test", "hub_pay"].includes(tool.hub)));
  const edit = hubTools("").find((tool) => tool.name === "edit");
  assert.deepEqual(wireArgs(edit, { path: "a", oldText: "1", newText: "2" }), { path: "a", content: JSON.stringify({ oldText: "1", newText: "2" }), summary: "" });
  assert.deepEqual(helloTools(hubTools("")).map((tool) => tool.name), ["hub_search", "hub_read", "hub_list", "hub_write", "hub_edit"]);
  assert.deepEqual(mcpContent([{ type: "image", data: "x" }]), [{ type: "text", text: "[image content omitted]" }]);
});

test("a resume restores only this engine's record and closes calls without a result as unknown", () => {
  const first = new Transcript({ engine: "opencode", version: "1.19.3", entries: [] });
  first.user("fix it");
  first.assistant("", [{ id: "c1", name: "hub_write", args: { path: "a" } }]);
  const saved = first.checkpoint();
  assert.equal(saved[0].hubEngine, "opencode");
  assert.ok(validHeader(saved, "opencode"));
  assert.ok(!validHeader(saved, "dsh-cli"), "another engine's record is refused");
  assert.ok(!validHeader([{ type: "session", id: "x", hubEngine: "opencode" }], "opencode"));
  const resumed = new Transcript({ engine: "opencode", version: "1.19.3", entries: saved });
  const text = resumed.resumePrompt("continue");
  assert.match(text, /\[user\]\nfix it/);
  assert.ok(text.includes(UNKNOWN_OUTCOME));
  assert.ok(text.endsWith("New request:\ncontinue"));
  assert.equal(resumed.checkpoint()[0].id, saved[0].id, "the session id carries over");
  const big = new Transcript({ engine: "opencode", version: "1", entries: [] });
  for (let i = 0; i < 400; i++) big.user("x".repeat(15_000));
  assert.ok(Buffer.byteLength(JSON.stringify(big.checkpoint())) <= 1024 * 1024);
  assert.equal(big.checkpoint()[1].text.length, 15_000, "the first request survives trimming");
  assert.equal(assistantEvent({ text: "done", stop: true, usage: { input: 3, output: 2 } }).message.usage.totalTokens, 5);
});

test("engine configs switch off every native tool and carry the run token, never a key", () => {
  const config = opencodeConfig({ connection, token, mcp });
  assert.deepEqual(config.tools, { "*": false, "hub_*": true });
  assert.equal(config.permission["*"], "deny");
  assert.equal(config.provider.hub.options.baseURL, "http://127.0.0.1:5555/v1");
  assert.equal(config.provider.hub.options.apiKey, token);
  assert.equal(config.share, "disabled");
  assert.equal(config.autoupdate, false);
  assert.throws(() => opencodeConfig({ connection: { ...connection, api: "bogus" }, token, mcp }), /engine_connection_unsupported/);
  const patch = dshPatch({ connection, mcp });
  for (const id of ["tool-fs", "terminal-pwsh", "persistent-pwsh", "session-log-deepseek", "llm-deepseek", "mcp-resources", "tool-working-directory"]) {
    assert.match(patch, new RegExp(`- id: ${id}\\n  disabled: true`));
  }
  assert.match(patch, /apiKeyEnv: HUB_ENGINE_MODEL_TOKEN/);
});

test("the engine environment holds nothing from the operator's environment", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-bridge-"));
  const saved = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "sk-ant-PLANTED-MARKER";
  process.env.HUB_SECRET_MARKER = "PLANTED";
  try {
    const paths = prepareRunDir(root);
    for (const env of [engineEnv(paths), opencodeEnv(paths, opencodeConfig({ connection, token, mcp })), dshEnv(paths, token)]) {
      const text = JSON.stringify(env);
      assert.ok(!text.includes("PLANTED"), "no operator variable is copied");
      assert.equal(env.USERPROFILE, paths.home);
      assert.equal(env.HTTPS_PROXY, DEAD_END_PROXY);
      assert.ok(!Object.keys(env).some((key) => /API_KEY$/.test(key)));
      assert.ok(Object.values(env).every((value) => value !== saved.USERPROFILE && value !== saved.APPDATA), "the operator's own profile folders are not the engine's");
    }
  } finally {
    delete process.env.ANTHROPIC_API_KEY; delete process.env.HUB_SECRET_MARKER;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bridge fails closed without a connection or with another engine's record", async () => {
  const run = (env, entries) => new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("./bridge.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "hub-byok/m", "hi"],
      { env: { ...process.env, PI_WORK_ENGINE: "opencode", PI_SIDECAR_BYOK: "", PI_SIDECAR_BYOK_TOKEN: "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const frames = [];
    readline.createInterface({ input: child.stdout }).on("line", (line) => frames.push(JSON.parse(line)));
    child.stdin.write(`${JSON.stringify({ type: "session", entries })}\n`);
    child.on("exit", () => resolve(frames));
  });
  const missing = await run({}, []);
  assert.deepEqual(missing.at(-1), { type: "agent_done", ok: false });
  assert.equal(missing.find((frame) => frame.type === "event").event.error, "engine_requires_connection");
  const mismatch = await run({ PI_SIDECAR_BYOK: JSON.stringify(connection), PI_SIDECAR_BYOK_TOKEN: token }, [{ type: "session", id: "s", hubEngine: "thin" }]);
  assert.equal(mismatch.find((frame) => frame.type === "event").event.error, "pi_session_engine_mismatch");
});
