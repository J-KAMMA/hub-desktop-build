// DeepSeek Harness CLI (commit 687f282e build, profile `sdk-minimal`) as a Hub engine, over its
// SDK JSON-RPC stdio protocol. The Hub patch switches off every tool dsh brings (file, shell,
// working directory, MCP resources), its DeepSeek adapter and uploaders, and adds only the run's
// model route (through Hub's proxy) and Hub's MCP server.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { engineEnv, launchJailed } from "./launch.mjs";

const y = (value) => JSON.stringify(String(value));
const APIS = new Set(["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai"]);

export function dshPatch({ connection, mcp }) {
  if (!APIS.has(connection.api)) throw new Error("engine_connection_unsupported");
  const off = ["llm-deepseek", "session-log-deepseek", "plugin-package-inventory-deepseek", "deepseek-llm-api-extensions",
    "tool-fs", "tool-working-directory", "terminal-pwsh", "persistent-pwsh", "terminal-bash", "persistent-bash", "pty", "mcp-resources"];
  return `# Hub run patch (vendor/engine-bridge/dsh.mjs)\n${off.map((id) => `- id: ${id}\n  disabled: true\n`).join("")}- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          hub:
            apiKeyEnv: HUB_ENGINE_MODEL_TOKEN
            api: ${y(connection.api)}
            baseURL: ${y(connection.baseUrl)}
            defaultContextWindow: 200000
            defaultMaxTokens: 32000
            models:
              - id: ${y(connection.model)}
    - id: mcp-hub
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: hub
        transport: streamable-http
        url: ${y(mcp.url)}
        headers:
          Authorization: ${y(`Bearer ${mcp.token}`)}
        toolCallTimeoutMs: 900000
        failOnStartupError: true
        reconnect:
          enabled: false
`;
}

export function dshEnv(paths, token) {
  return engineEnv(paths, { DSH_HOME: paths.engine, DSH_TELEMETRY_MODE: "DISABLED", DSH_TELEMETRY_DISABLED: "1", HUB_ENGINE_MODEL_TOKEN: token });
}

const HUB_TOOL = /^mcp__hub__[a-z]+$/;

export function runDsh({ program, jail, node, paths, prompt, connection, token, mcp, sink }) {
  const patch = join(paths.engine, "hub.patch.yml");
  writeFileSync(patch, dshPatch({ connection, mcp }));
  const child = launchJailed({ jail, program: node, args: [program, "--profile", "sdk-minimal", "--patch", patch], paths, env: dshEnv(paths, token) });
  sink.started(child);
  let nextId = 1;
  const waits = new Map();
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    waits.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const sessionId = `hub-${randomUUID()}`;
  const names = new Map();
  let finished, turnReason = null;
  const idle = new Promise((resolve) => { finished = resolve; });
  let prompted = false;
  let idleAfterTurn = false;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && waits.has(message.id)) {
      const wait = waits.get(message.id);
      waits.delete(message.id);
      if (message.error) wait.reject(new Error(String(message.error.message ?? "rpc_error").slice(0, 500)));
      else wait.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (params.sessionId !== undefined && params.sessionId !== sessionId) return;
    if (message.method === "session.status" && params.status === "idle" && turnReason) {
      idleAfterTurn = true;
      if (prompted) finished();
    }
    if (message.method !== "session.event") return;
    const event = params.event ?? {};
    const data = event.data ?? {};
    if (event.type === "assistant/message") {
      const blocks = Array.isArray(data.message?.content) ? data.message.content : [];
      const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
      const toolCalls = blocks.filter((block) => block.type === "tool-call").map((block) => {
        let args = block.arguments;
        try { args = JSON.parse(block.arguments); } catch { /* keep text */ }
        names.set(block.id, block.name);
        return { id: block.id, name: block.name, args };
      });
      const usage = data.usage ?? {};
      if (text) sink.partial(text);
      sink.assistant({ text, toolCalls, stop: toolCalls.length === 0,
        usage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0 } });
    } else if (event.type === "tool/result") {
      const result = data.message ?? {};
      const name = names.get(result.toolCallId) ?? "unknown";
      const text = (Array.isArray(result.content) ? result.content : []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (!HUB_TOOL.test(name) && result.isError) sink.nativeRefused(name);
      sink.toolResult({ id: result.toolCallId, name, text, isError: result.isError });
    } else if (event.type === "turn/end") {
      turnReason = data.reason?.kind ?? null;
    }
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => sink.log(`dsh: ${line.slice(0, 500)}`));
  const exited = new Promise((resolve) => child.on("exit", (code) => {
    for (const wait of waits.values()) wait.reject(new Error("engine_exited"));
    finished();
    resolve(code);
  }));
  return (async () => {
    try {
      await rpc("initialize", { cwd: paths.scratch, provider: "hub", model: connection.model });
      await rpc("session/prompt", { sessionId, contentBlocks: [{ type: "text", text: prompt }] });
      prompted = true;
      if (idleAfterTurn) finished();
      await idle;
      await Promise.race([rpc("shutdown", null), new Promise((resolve) => setTimeout(resolve, 5000))]).catch(() => {});
    } catch (error) {
      sink.log(`dsh failed: ${String(error?.message ?? error).slice(0, 500)}`);
    }
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    const code = await exited;
    clearTimeout(timer);
    return { ok: turnReason === "completed", reason: turnReason === "completed" ? "completed" : turnReason ?? "failed", code };
  })();
}
