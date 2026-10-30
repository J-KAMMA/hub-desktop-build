// Discover installed Ollama models without changing its server or Pi config.
export async function addLocalModels(runtime, fetcher = fetch) {
  const known = runtime.getModels("ollama");
  let base;
  try { base = new URL(known[0]?.baseUrl ?? "http://127.0.0.1:11434/v1"); } catch { return; }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) return;
  try {
    const response = await fetcher(new URL("/api/tags", base), { signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!response.ok) return;
    const body = await response.json();
    if (!Array.isArray(body.models)) return;
    const ids = new Set(known.map((model) => model.id));
    const extra = body.models.slice(0, 1000).flatMap((entry) => {
      const id = entry.name ?? entry.model;
      if (typeof id !== "string" || id.length > 160 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id) || ids.has(id)) return [];
      ids.add(id);
      return [{ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }];
    });
    if (extra.length) runtime.registerProvider("ollama", {
      ...(!known.length ? { baseUrl: base.href.replace(/\/$/, ""), api: "openai-completions", apiKey: "ollama" } : {}),
      models: [...known, ...extra],
    });
    return extra.map((model) => model.id);
  } catch { /* An unavailable server must not hide configured API models. */ }
}

export function modelLocation(model) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(model.baseUrl).hostname) ? "local" : "api";
  } catch { return "api"; }
}
