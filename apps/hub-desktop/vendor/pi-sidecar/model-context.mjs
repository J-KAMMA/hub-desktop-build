import { estimateContextTokens, estimateTextTokens } from "./workspace/node_modules/@earendil-works/pi-ai/dist/utils/estimate.js";

// Pi 1.x estimates messages only. Before any usage is reported the request still carries the
// system prompt and every tool declaration, so count them here or a small Ollama window overflows.
function estimateRequestTokens(context) {
  const estimate = estimateContextTokens(context);
  if (estimate.lastUsageIndex !== null || context.messages?.some((message) => message.role === "system")) return estimate.tokens;
  const tools = Array.isArray(context.tools) && context.tools.length ? estimateTextTokens(JSON.stringify(context.tools)) : 0;
  return estimate.tokens + (context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + tools;
}

function localOllamaUrl(model) {
  if (model.provider !== "ollama") return;
  try {
    const base = new URL(model.baseUrl);
    if (["http:", "https:"].includes(base.protocol) && !base.username && !base.password &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) return base;
  } catch { /* Not a local Ollama endpoint. */ }
}

// Ollama's OpenAI-compatible API does not set num_ctx. SDK catalog defaults
// must not postpone compaction beyond the local server's allocated context.
export async function localModelContext(model, fetcher = fetch, discovered = false) {
  const base = localOllamaUrl(model);
  if (!base) return model;
  let allocated = 4096; // Conservative fallback when no usable metadata exists.
  const validContext = (size) => Number.isSafeInteger(size) && size >= 512 && size <= 1048576;
  try {
    const options = { signal: AbortSignal.timeout(1500), redirect: "error" };
    const response = await fetcher(new URL("/api/ps", base), options);
    if (response.ok) {
      const { models } = await response.json();
      const active = models?.find((entry) => [model.id, `${model.id}:latest`].includes(entry.name ?? entry.model));
      const size = active?.context_length;
      if (validContext(size)) allocated = size;
      else if (!active && Array.isArray(models)) {
        // A cold model can still declare num_ctx in its Modelfile. Read that
        // setting only; model_info's training window is not an allocation.
        const details = await fetcher(new URL("/api/show", base), {
          ...options, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: model.id }),
        });
        if (details.ok) {
          const { parameters } = await details.json();
          const declarations = typeof parameters === "string" && parameters.length <= 65536
            ? parameters.split(/\r?\n/).filter((line) => /^[ \t]*num_ctx(?:[ \t]|$)/.test(line)) : [];
          const configured = declarations.length === 1
            ? Number(/^[ \t]*num_ctx[ \t]+([0-9]+)[ \t]*$/.exec(declarations[0])?.[1]) : NaN;
          if (validContext(configured)) allocated = configured;
        }
      }
    }
  } catch { /* Keep the conservative bound; do not change server settings. */ }
  // Discovery's 4k value is a cold-start fallback, not an operator-set limit.
  const declared = !discovered && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : allocated;
  const contextWindow = Math.min(declared, allocated);
  // Discovery's output limit is also a fallback. Match the session's output
  // reserve (quarter-window, at most 16k); retain explicitly configured caps.
  return { ...model, contextWindow, maxTokens: Math.min(discovered ? 16384 : model.maxTokens || contextWindow, Math.floor(contextWindow / 4)) };
}

// Ollama 0.33.2 reads max_tokens, not max_completion_tokens. Pi's fixed
// 4096-token safety margin otherwise leaves only one output token at 4k.
// Scale that margin to the local allocation, retaining the SDK's estimator
// and native request/response path. This does not change server settings.
export function localRequestOptions(model, context, options = {}) {
  if (model.api !== "openai-completions" || !localOllamaUrl(model)) return options;
  const limits = [model.contextWindow, model.maxTokens, options.maxTokens ?? model.maxTokens];
  if (!limits.every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("invalid_local_token_limit");
  // Compaction already reserves a quarter-window for output. Keep a smaller
  // estimation margin here so a 3k prompt in a 4k allocation can still answer.
  const reserve = Math.min(4096, Math.floor(model.contextWindow / 16));
  const available = Math.max(1, model.contextWindow - estimateRequestTokens(context) - reserve);
  const maxTokens = Math.min(model.maxTokens, options.maxTokens ?? model.maxTokens, available);
  return { ...options, onPayload: async (payload, selected) => {
    const request = await options.onPayload?.(payload, selected) ?? payload;
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid_local_request");
    const { max_completion_tokens: _unused, ...body } = request;
    // Pi forces thinking off for non-reasoning models, but omitting the wire
    // field leaves Ollama's thinking-capable models on by default. Honour that
    // mode explicitly; retain caller/provider overrides and reasoning models.
    const thinkingOff = model.reasoning === false && !options.reasoning
      && body.reasoning_effort === undefined && body.reasoning === undefined && body.think === undefined;
    return { ...body, ...(thinkingOff ? { reasoning_effort: "none" } : {}), max_tokens: maxTokens };
  } };
}
