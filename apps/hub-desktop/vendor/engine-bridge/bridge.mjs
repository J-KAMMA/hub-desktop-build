// Hub's bridge for type-B external engines (docs/hub-harness-swap/PLAN.md, `hub.engine.v1`).
// Rust starts it like the Pi sidecar — `node bridge.mjs <model> <prompt>` in the workspace —
// and talks the same stdio JSONL (pi_sidecar.rs, protocol 1):
//   Hub -> bridge: session (entries for a resume), tool_result, tool_error
//   bridge -> Hub: hello, tool_call, checkpoint, event (message_end, engine_summary), partial, agent_done
// The bridge owns no permission: every Hub tool call goes to Rust's executor and approvals.
// It runs the engine through the jail in an empty scratch folder; the engine never sees the
// workspace path, the API key or the operator's environment.
import readline from "node:readline";
import { readFileSync, rmSync } from "node:fs";
import { startMcpServer } from "./mcp-server.mjs";
import { hubTools, helloTools, mcpContent, wireArgs } from "./tools.mjs";
import { Transcript, assistantEvent, toolResultEvent, validHeader } from "./transcript.mjs";
import { prepareRunDir } from "./launch.mjs";
import { runOpencode } from "./opencode.mjs";
import { runDsh } from "./dsh.mjs";

const ENGINES = { opencode: runOpencode, "dsh-cli": runDsh };
const engine = process.env.PI_WORK_ENGINE;
const version = process.env.HUB_ENGINE_VERSION ?? "";
const [, , modelArg = "", prompt = ""] = process.argv;
const limits = { toolCalls: Number(process.env.HUB_ENGINE_MAX_TOOL_CALLS ?? 400), seconds: Number(process.env.HUB_ENGINE_MAX_SECONDS ?? 1800), outputChars: 2_000_000 };

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const log = (text) => process.stderr.write(`${String(text).slice(0, 2000)}\n`);
const pending = new Map();
let initialFrame = null;
let initialResolve;
const initialized = new Promise((resolve) => { initialResolve = resolve; });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return log("bad jsonl frame"); }
  if (message?.type === "session" && !initialFrame) { initialFrame = message; initialResolve(message); return; }
  if (message?.type === "tool_result" || message?.type === "tool_error") {
    const wait = pending.get(message.id);
    if (!wait) return log(`late ${message.type} id=${message.id}`);
    pending.delete(message.id);
    wait(message);
  }
}).on("close", () => { initialResolve(null); for (const wait of pending.values()) wait({ type: "tool_error", message: "hub_closed" }); pending.clear(); });

function fail(code) {
  log(code);
  send({ type: "hello", proto: 1, engine, engineVersion: version, supportsSteering: false, activeTools: [], tools: [], model: null });
  send({ type: "event", event: { type: "engine_summary", reason: "failed", error: code } });
  send({ type: "agent_done", ok: false });
  process.exitCode = 1;
}

async function main() {
  const run = ENGINES[engine];
  if (!run) return fail("engine_unknown");
  const frame = await initialized;
  if (!frame) return fail("session_missing");
  const entries = Array.isArray(frame.entries) ? frame.entries : [];
  if (!validHeader(entries, engine)) return fail("pi_session_engine_mismatch");
  let connection;
  try { connection = JSON.parse(process.env.PI_SIDECAR_BYOK ?? ""); } catch { /* checked below */ }
  const token = process.env.PI_SIDECAR_BYOK_TOKEN ?? "";
  if (!connection?.proxy || !connection.baseUrl || !connection.model || !/^[0-9a-f]{64}$/.test(token)) return fail("engine_requires_connection");
  const tools = hubTools(process.env.PI_SIDECAR_CAPS);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const transcript = new Transcript({ engine, version, entries });
  transcript.user(prompt);
  const summary = { engine, version, toolCalls: 0, unknownTools: 0, nativeRefusals: 0, reason: null };
  let child = null;
  let stopped = null;
  const stop = (reason) => { if (!stopped) { stopped = reason; summary.reason = reason; child?.kill(); } };
  let calls = 0;
  let outputChars = 0;
  const mcp = await startMcpServer({
    tools,
    onUnknownTool: () => { summary.unknownTools++; },
    call: async (name, args) => {
      const tool = byName.get(name);
      if (++calls > limits.toolCalls) { stop("limit"); throw new Error("limit_reached: Hub stopped this run (tool-call limit)"); }
      summary.toolCalls = calls;
      const id = `ext_${calls}`;
      // Checkpoint before any side effect: the saved record already holds the request.
      if (tool.sideEffect) send({ type: "checkpoint", entries: transcript.checkpoint() });
      const reply = await new Promise((resolve) => {
        pending.set(id, resolve);
        send({ type: "tool_call", id, name: tool.hub, args: wireArgs(tool, args) });
      });
      if (reply.type === "tool_error") return { content: [{ type: "text", text: String(reply.message ?? "hub tool error").slice(0, 8000) }], isError: true };
      return { content: mcpContent(reply.content) };
    },
  });
  send({ type: "hello", proto: 1, engine, engineVersion: version, supportsSteering: false, activeTools: tools.map((tool) => tool.hub), tools: helloTools(tools), model: modelArg || null });
  send({ type: "event", event: { type: "agent_start" } });
  let paths;
  const timer = setTimeout(() => stop("limit"), limits.seconds * 1000);
  const sink = {
    started: (process) => { child = process; },
    partial: (text) => { outputChars += text.length; if (outputChars > limits.outputChars) stop("limit"); send({ type: "partial", text }); },
    assistant: (message) => {
      transcript.assistant(message.text, message.toolCalls);
      send({ type: "event", event: assistantEvent(message) });
    },
    toolResult: (result) => {
      transcript.toolResult(result.id, result.name, result.text, result.isError);
      send({ type: "event", event: toolResultEvent(result) });
    },
    nativeRefused: () => { summary.nativeRefusals++; },
    log,
  };
  let result = { ok: false, reason: "failed" };
  try {
    paths = prepareRunDir(process.env.HUB_ENGINE_RUN_DIR);
    result = await run({ program: process.env.HUB_ENGINE_PROGRAM, jail: process.env.HUB_ENGINE_JAIL, node: process.execPath, paths,
      prompt: transcript.resumePrompt(prompt), connection, token, mcp, sink });
  } catch (error) {
    log(`engine start failed: ${String(error?.message ?? error)}`);
  } finally {
    clearTimeout(timer);
    await mcp.close();
  }
  try { summary.jail = JSON.parse(readFileSync(paths?.stats ?? "", "utf8")); } catch { summary.jail = null; }
  summary.reason ??= result.reason;
  send({ type: "checkpoint", entries: transcript.checkpoint() });
  send({ type: "event", event: { type: "engine_summary", ...summary } });
  log(`engine-summary ${JSON.stringify(summary)}`);
  if (paths) { try { rmSync(paths.root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Rust removes the run folder */ } }
  send({ type: "agent_done", ok: Boolean(result.ok) && !stopped });
}

main().catch((error) => { log(`bridge failed: ${String(error?.stack ?? error)}`); send({ type: "agent_done", ok: false }); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(), 100));
