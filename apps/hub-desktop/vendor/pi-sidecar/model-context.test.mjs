import { test } from "node:test";
import assert from "node:assert/strict";
import { localModelContext, localRequestOptions } from "./model-context.mjs";
import { streamSimple } from "./workspace/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";

const model = { provider: "ollama", id: "qwen2.5:7b", baseUrl: "http://localhost:11434/v1", contextWindow: 128000, maxTokens: 8192 };
test("local context follows allocation, not an unspecified SDK catalog default", async () => {
  const bounded = await localModelContext(model, async (url, options) => {
    assert.equal(url.href, "http://localhost:11434/api/ps");
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => ({ models: [{ name: model.id, context_length: 4096 }] }) };
  });
  assert.equal(bounded.contextWindow, 4096);
  assert.equal(bounded.maxTokens, 1024);
  assert.equal(model.contextWindow, 128000);
});
test("missing, invalid, unrelated and unavailable metadata uses a conservative context", async () => {
  for (const size of [undefined, null, 0, -1, 511, 4096.5, 1048577, "8192"]) {
    const bounded = await localModelContext(model, async () => ({ ok: true, json: async () => ({ models: [{ name: model.id, context_length: size }] }) }));
    assert.equal(bounded.contextWindow, 4096);
  }
  assert.equal((await localModelContext(model, async () => { throw new Error("offline"); })).contextWindow, 4096);
  const bounded = await localModelContext({ ...model, contextWindow: 2048 }, async () => ({ ok: true, json: async () => ({ models: [] }) }));
  assert.equal(bounded.contextWindow, 2048);
});
test("discovered fallback follows confirmed allocation while an explicit lower limit stays intact", async () => {
  const discovered = { ...model, contextWindow: 4096, maxTokens: 1024 };
  const metadata = async () => ({ ok: true, json: async () => ({ models: [{ name: model.id, context_length: 8192 }] }) });
  const allocated = await localModelContext(discovered, metadata, true);
  assert.equal(allocated.contextWindow, 8192);
  assert.equal(allocated.maxTokens, 2048, "a discovered 4k output fallback must not cap the confirmed 8k model");
  assert.equal((await localModelContext(discovered, metadata)).contextWindow, 4096);
  assert.equal((await localModelContext({ ...model, contextWindow: 8192, maxTokens: 768 }, metadata)).maxTokens, 768);
  for (const size of [null, 0, 8192.5, "8192", 1048577]) {
    const invalid = async () => ({ ok: true, json: async () => ({ models: [{ name: model.id, context_length: size }] }) });
    assert.equal((await localModelContext(discovered, invalid, true)).contextWindow, 4096);
  }
  assert.equal((await localModelContext(discovered, async () => { throw new Error("cold"); }, true)).contextWindow, 4096);
  const smaller = await localModelContext(discovered, async () => ({ ok: true, json: async () => ({ models: [{ name: model.id, context_length: 512 }] }) }), true);
  assert.equal(smaller.contextWindow, 512);
  assert.equal(smaller.maxTokens, 128);
  const largest = await localModelContext(discovered, async () => ({ ok: true, json: async () => ({ models: [{ name: model.id, context_length: 1048576 }] }) }), true);
  assert.equal(largest.maxTokens, 16384, "large discovered allocations retain the session's bounded output reserve");
});
test("does not probe remote providers, credentials, or non-HTTP endpoints", async () => {
  for (const selected of [{ ...model, provider: "openai" }, ...["https://example.com/v1", "http://user:secret@localhost/v1", "file:///local", "invalid"].map((baseUrl) => ({ ...model, baseUrl }))]) {
    assert.equal(await localModelContext(selected, async () => { assert.fail("unexpected request"); }), selected);
  }
});

test("cold local models use their explicit stored context without loading or changing them", async () => {
  const discovered = { ...model, contextWindow: 4096, maxTokens: 1024 };
  const requests = [];
  const metadata = async (url, options) => {
    requests.push({ url, options });
    if (url.pathname === "/api/ps") return { ok: true, json: async () => ({ models: [] }) };
    assert.equal(url.href, "http://localhost:11434/api/show");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.deepEqual(JSON.parse(options.body), { model: model.id });
    assert.equal(options.signal, requests.at(-2).options.signal, "metadata requests share one deadline");
    return { ok: true, json: async () => ({ parameters: "temperature 1\nnum_ctx    8192\ntop_p 0.95" }) };
  };
  assert.equal((await localModelContext(discovered, metadata, true)).contextWindow, 8192);
  assert.equal(requests.length, 2);
  assert.equal((await localModelContext(discovered, metadata)).contextWindow, 4096, "retain an operator's lower bound");
});

test("cold context rejects malformed settings, duplicates and theoretical training windows", async () => {
  for (const [parameters, expected] of [
    [" num_ctx\t512\r\ntemperature 1", 512], ["num_ctx 1048576", 1048576],
    ...[undefined, null, {}, "", "num_ctx", "num_ctx 0", "num_ctx -8192", "num_ctx 511", "num_ctx 1048577",
      "num_ctx 8192.5", "num_ctx 8e3", 'num_ctx "8192"', "num_ctx 8192 trailing", "num_ctx 8192\nnum_ctx 4096",
      "num_ctx 8192\nnum_ctx invalid", `num_ctx 8192\n${" ".repeat(65536)}`].map((value) => [value, 4096]),
  ]) {
    const bounded = await localModelContext(model, async (url) => ({ ok: true, json: async () => url.pathname === "/api/ps"
      ? { models: [{ name: "other-model", context_length: 8192 }] }
      : { parameters, model_info: { "fixture.context_length": 131072 } },
    }), true);
    assert.equal(bounded.contextWindow, expected);
  }
  for (const metadata of [undefined, { ok: false }, { ok: true, json: async () => { throw new Error("invalid JSON"); } }]) {
    const bounded = await localModelContext(model, async (url) => {
      if (url.pathname === "/api/ps") return { ok: true, json: async () => ({ models: [] }) };
      if (!metadata) throw new Error("offline");
      return metadata;
    });
    assert.equal(bounded.contextWindow, 4096);
  }
});

test("an active allocation wins without querying stored settings", async () => {
  for (const [context_length, expected] of [[512, 512], [8192, 8192], [null, 4096]]) {
    let requests = 0;
    const bounded = await localModelContext(model, async (url) => {
      requests++;
      assert.equal(url.pathname, "/api/ps");
      return { ok: true, json: async () => ({ models: [{ name: model.id, context_length }] }) };
    });
    assert.equal(bounded.contextWindow, expected);
    assert.equal(requests, 1);
  }
});

test("real SDK sends an effective bounded Ollama output limit at small context sizes", async () => {
  const base = { ...model, api: "openai-completions", reasoning: false, input: ["text"],
    contextWindow: 4096, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  for (const [selected, content, cap, expected] of [
    [base, "OK", undefined, 1024],
    [base, "x".repeat(12000), undefined, 411], // Pi 1.x: 3.5 chars per token
    [base, "x".repeat(16000), undefined, 1],
    [base, "OK", 8, 8],
    [{ ...base, contextWindow: 512, maxTokens: 128 }, "OK", undefined, 128],
  ]) {
    const context = { messages: [{ role: "user", content, timestamp: 0 }] };
    const original = { apiKey: "local-fixture", ...(cap ? { maxTokens: cap } : {}), onPayload: (payload) => ({ ...payload, fixture: true }) };
    const options = localRequestOptions(selected, context, original);
    let wire;
    const answer = await streamSimple(selected, context, { ...options, onPayload: async (payload, resolved) => {
      wire = await options.onPayload(payload, resolved);
      throw new Error("fixture intercepted before network");
    } }).result();
    assert.match(answer.errorMessage, /fixture intercepted before network/);
    assert.equal(wire.max_tokens, expected);
    assert.equal(wire.reasoning_effort, "none", "SDK thinking-off must reach Ollama instead of its thinking-on default");
    assert.equal(Object.hasOwn(wire, "max_completion_tokens"), false);
    assert.equal(wire.fixture, true);
    assert.equal(wire.messages.at(-1).content, content);
    assert.equal(original.maxTokens, cap);
  }
});

test("local request bounds include tools and previous usage and preserve request options", async () => {
  const selected = { ...model, api: "openai-completions", contextWindow: 4096, maxTokens: 1024 };
  const context = { systemPrompt: "x".repeat(4000), messages: [], tools: [{ name: "fixture", description: "y".repeat(8000), parameters: {} }] };
  const options = localRequestOptions(selected, context, { sessionId: "same-session", cacheRetention: "long" });
  const request = { max_completion_tokens: 1, messages: [], tools: context.tools };
  const bounded = await options.onPayload(request, selected);
  assert.ok(bounded.max_tokens > 1 && bounded.max_tokens < 1024);
  assert.equal(bounded.tools, context.tools);
  assert.equal(request.max_completion_tokens, 1);
  assert.equal(options.sessionId, "same-session");
  assert.equal(options.cacheRetention, "long");
  const history = { messages: [{ role: "assistant", content: [], timestamp: 1, stopReason: "stop",
    usage: { input: 2800, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 3000 } }] };
  assert.equal((await localRequestOptions(selected, history).onPayload({}, selected)).max_tokens, 840);
  history.messages[0].usage = { input: 3121, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3122 };
  assert.equal((await localRequestOptions(selected, history).onPayload({}, selected)).max_tokens, 718);
});

test("Ollama thinking-off retains explicit reasoning controls and other model modes", async () => {
  const selected = { ...model, api: "openai-completions", reasoning: false, contextWindow: 4096, maxTokens: 1024 };
  for (const body of [{ reasoning_effort: "high" }, { reasoning: { effort: "low" } }, { think: true }]) {
    const options = localRequestOptions(selected, { messages: [] }, { onPayload: () => body });
    assert.deepEqual(await options.onPayload({}, selected), { ...body, max_tokens: 1024 });
  }
  for (const [resolved, input] of [[{ ...selected, reasoning: true }, {}], [selected, { reasoning: "high" }]]) {
    const options = localRequestOptions(resolved, { messages: [] }, input);
    assert.equal((await options.onPayload({}, resolved)).reasoning_effort, undefined);
  }
});

test("local request overrides do not affect other routes or accept invalid bounds", async () => {
  const selected = { ...model, api: "openai-completions", contextWindow: 4096, maxTokens: 1024 };
  const options = { sessionId: "unchanged" };
  for (const route of [{ ...selected, provider: "api" }, { ...selected, api: "openai-responses" },
    ...["https://example.com/v1", "http://user:secret@localhost/v1", "file:///x", "invalid"].map((baseUrl) => ({ ...selected, baseUrl }))]) {
    assert.equal(localRequestOptions(route, { messages: [] }, options), options);
  }
  for (const value of [0, -1, 0.5, NaN, Infinity, "1024", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => localRequestOptions({ ...selected, maxTokens: value }, { messages: [] }), /invalid_local_token_limit/);
    assert.throws(() => localRequestOptions(selected, { messages: [] }, { maxTokens: value }), /invalid_local_token_limit/);
  }
  const badHook = localRequestOptions(selected, { messages: [] }, { onPayload: () => [] });
  await assert.rejects(() => badHook.onPayload({}, selected), /invalid_local_request/);
});
