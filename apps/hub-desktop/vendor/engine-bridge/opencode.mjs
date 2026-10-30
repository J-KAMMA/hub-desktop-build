// OpenCode 1.19.3 (`opencode run --format json`) as a Hub engine. Its own tools are all off;
// the only tools are Hub's, from the bridge's MCP server named "hub" (seen as `hub_<name>`).
// Project, Claude Code, plugin, skill, LSP, formatter, snapshot, share, title and update
// features are off, and the config comes only from this run (OPENCODE_CONFIG_CONTENT).
import readline from "node:readline";
import { engineEnv, launchJailed } from "./launch.mjs";

const PROVIDERS = {
  "anthropic-messages": { npm: "@ai-sdk/anthropic", path: "/v1" },
  "openai-responses": { npm: "@ai-sdk/openai", path: "" },
  "openai-completions": { npm: "@ai-sdk/openai-compatible", path: "" },
  "google-generative-ai": { npm: "@ai-sdk/google", path: "" },
};

export function opencodeConfig({ connection, token, mcp }) {
  const provider = PROVIDERS[connection.api];
  if (!provider) throw new Error("engine_connection_unsupported");
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false, share: "disabled", snapshot: false, lsp: false, formatter: false, instructions: [], plugin: [],
    model: `hub/${connection.model}`,
    small_model: `hub/${connection.model}`,
    provider: { hub: { npm: provider.npm, name: "Hub", options: { baseURL: `${connection.baseUrl}${provider.path}`, apiKey: token },
      models: { [connection.model]: { name: connection.model, tool_call: true, limit: { context: 200000, output: 32000 } } } } },
    mcp: { hub: { type: "remote", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` }, enabled: true, oauth: false } },
    tools: { "*": false, "hub_*": true },
    permission: { "*": "deny", "hub_*": "allow" },
    agent: { build: { tools: { "*": false, "hub_*": true } }, plan: { disable: true }, general: { disable: true }, explore: { disable: true }, title: { disable: true } },
  };
}

export function opencodeEnv(paths, config) {
  return engineEnv(paths, {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  });
}

const HUB_TOOL = /^hub_[a-z]+$/;

/** One `opencode run`. `sink` receives normalized engine events; resolves {ok, reason}. */
export function runOpencode({ program, jail, paths, prompt, connection, token, mcp, sink }) {
  const child = launchJailed({ jail, program, args: ["run", "--format", "json"], paths, env: opencodeEnv(paths, opencodeConfig({ connection, token, mcp })) });
  child.stdin.end(prompt);
  sink.started(child);
  let step = { text: "", toolCalls: [], results: [] };
  let lastReason = null;
  let error = null;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const part = event.part ?? {};
    if (event.type === "text" && typeof part.text === "string") {
      step.text += part.text;
      sink.partial(part.text);
    } else if (event.type === "tool_use") {
      const state = part.state ?? {};
      const call = { id: part.callID ?? `oc_${step.toolCalls.length}`, name: String(part.tool ?? ""), args: state.input ?? {} };
      step.toolCalls.push(call);
      const isError = state.status === "error";
      if (!HUB_TOOL.test(call.name) && isError) sink.nativeRefused(call.name);
      step.results.push({ id: call.id, name: call.name, text: isError ? String(state.error ?? "error") : String(state.output ?? ""), isError });
    } else if (event.type === "step_finish") {
      const tokens = part.tokens ?? {};
      lastReason = part.reason ?? null;
      sink.assistant({ text: step.text, toolCalls: step.toolCalls, stop: lastReason === "stop",
        usage: { input: tokens.input ?? 0, output: (tokens.output ?? 0) + (tokens.reasoning ?? 0), cacheRead: tokens.cache?.read ?? 0, cacheWrite: tokens.cache?.write ?? 0 } });
      for (const result of step.results) sink.toolResult(result);
      step = { text: "", toolCalls: [], results: [] };
    } else if (event.type === "error") {
      error = String(event.error?.data?.message ?? event.error?.name ?? "engine_error").slice(0, 500);
      sink.log(`opencode error: ${error}`);
    }
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => sink.log(`opencode: ${line.slice(0, 500)}`));
  return new Promise((resolve) => child.on("exit", (code) => {
    resolve({ ok: code === 0 && lastReason === "stop" && !error, reason: error ? "failed" : code === 0 ? (lastReason === "stop" ? "completed" : "incomplete") : "failed", code });
  }));
}
