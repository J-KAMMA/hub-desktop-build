// "AIの接続" (BYOK) for one Pi run. The API key never reaches this process: Hub's Rust side
// starts a per-run proxy on 127.0.0.1 that holds the key (docs/hub-harness-swap/PLAN.md,
// decision 3). This process gets only the proxy URL and a one-time run token, takes both out of
// process.env before anything else runs, and sends the token where the provider expects its key.

export const BYOK_PROVIDER = "hub-byok";
const APIS = new Set(["anthropic-messages", "openai-responses", "google-generative-ai", "openai-completions"]);
const BUILTIN = { anthropic: "anthropic", openai: "openai", google: "google" };
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const TOKEN = /^[0-9a-f]{64}$/;

// Reads and removes the run's connection from the environment. Returns null when the run names
// no connection; throws "byok_connection_invalid" for anything malformed (fail closed).
export function takeByokConnection(env = process.env) {
  const raw = env.PI_SIDECAR_BYOK, token = env.PI_SIDECAR_BYOK_TOKEN ?? "";
  delete env.PI_SIDECAR_BYOK;
  delete env.PI_SIDECAR_BYOK_TOKEN;
  if (raw === undefined) return null;
  let descriptor;
  try { descriptor = JSON.parse(raw); } catch { throw new Error("byok_connection_invalid"); }
  const { kind, api, baseUrl, model, proxy } = descriptor ?? {};
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error("byok_connection_invalid"); }
  if (proxy !== true || !APIS.has(api) || typeof model !== "string" || !MODEL.test(model) || model.includes("..")
      || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.search || url.hash
      || typeof token !== "string" || !TOKEN.test(token)) {
    throw new Error("byok_connection_invalid");
  }
  return { kind, api, baseUrl: baseUrl.replace(/\/$/, ""), model, token };
}

// Pi reads "!..." as a shell command and "$NAME" as an environment reference; keep values literal.
export function literalConfigValue(value) {
  const escaped = value.replace(/\$/g, "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

// Registers the connection as this run's only "hub-byok" model, pointed at the run's proxy.
// Known model metadata (context, output limit, reasoning) is copied from Pi's built-in catalog;
// unknown models get conservative limits. Prices are not shown for BYOK, so unknown models carry
// zero cost.
export function registerByok(runtime, connection) {
  const builtin = BUILTIN[connection.kind];
  let known;
  try { known = builtin ? runtime.getModel(builtin, connection.model) : undefined; } catch { known = undefined; }
  const anthropic = connection.api === "anthropic-messages";
  const model = {
    id: connection.model, name: connection.model,
    reasoning: known?.reasoning ?? anthropic,
    input: known?.input ?? ["text"],
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: known?.contextWindow ?? 100000,
    maxTokens: known?.maxTokens ?? (anthropic ? 32000 : 16384),
    ...(known?.compat ? { compat: known.compat } : !known && anthropic ? { compat: { forceAdaptiveThinking: true } } : {}),
  };
  runtime.registerProvider(BYOK_PROVIDER, {
    baseUrl: connection.baseUrl, api: connection.api,
    apiKey: literalConfigValue(connection.token),
    models: [model],
  });
}
