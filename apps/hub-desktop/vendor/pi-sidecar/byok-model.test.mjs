import { test } from "node:test";
import assert from "node:assert/strict";
import { BYOK_PROVIDER, literalConfigValue, registerByok, takeByokConnection } from "./byok-model.mjs";

const TOKEN = "a".repeat(64);
const descriptor = (extra = {}) => JSON.stringify({ kind: "anthropic", api: "anthropic-messages", baseUrl: "http://127.0.0.1:43123", model: "claude-haiku-5-5", proxy: true, ...extra });

test("the connection and run token are taken out of the environment before use", () => {
  const env = { PI_SIDECAR_BYOK: descriptor(), PI_SIDECAR_BYOK_TOKEN: TOKEN, OTHER: "kept" };
  const connection = takeByokConnection(env);
  assert.deepEqual(Object.keys(env), ["OTHER"]);
  assert.equal(connection.token, TOKEN);
  assert.equal(connection.baseUrl, "http://127.0.0.1:43123");
  assert.equal(takeByokConnection({}), null, "no connection named");
});

test("anything but this run's loopback proxy and token fails closed and is still cleared", () => {
  for (const [raw, token] of [
    ["{not json", TOKEN],
    [descriptor({ api: "bash" }), TOKEN],
    [descriptor({ proxy: false }), TOKEN],
    [descriptor({ baseUrl: "https://api.anthropic.com" }), TOKEN],
    [descriptor({ baseUrl: "http://192.168.1.5:8080/v1" }), TOKEN],
    [descriptor({ baseUrl: "http://localhost:43123" }), TOKEN],
    [descriptor({ baseUrl: "http://u:p@127.0.0.1:43123" }), TOKEN],
    [descriptor({ model: "../x" }), TOKEN],
    [descriptor(), ""],
    [descriptor(), "sk-ant-api03-looks-like-a-key"],
  ]) {
    const env = { PI_SIDECAR_BYOK: raw, PI_SIDECAR_BYOK_TOKEN: token };
    assert.throws(() => takeByokConnection(env), /byok_connection_invalid/, raw);
    assert.equal(env.PI_SIDECAR_BYOK_TOKEN, undefined);
  }
});

test("values stay literal for Pi's config resolver", () => {
  assert.equal(literalConfigValue("abc"), "abc");
  assert.equal(literalConfigValue("a$HOME"), "a$$HOME");
  assert.equal(literalConfigValue("!rm"), "$!rm");
});

test("registration points at the proxy with the token and uses built-in metadata when Pi knows the model", () => {
  const registered = [];
  const runtime = {
    getModel: (provider, id) => provider === "anthropic" && id === "claude-known" ? { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } } : undefined,
    registerProvider: (name, config) => registered.push([name, config]),
  };
  const base = { kind: "anthropic", api: "anthropic-messages", baseUrl: "http://127.0.0.1:43123", token: TOKEN };
  registerByok(runtime, { ...base, model: "claude-known" });
  registerByok(runtime, { ...base, model: "claude-unknown" });
  assert.equal(registered[0][0], BYOK_PROVIDER);
  assert.equal(registered[0][1].baseUrl, "http://127.0.0.1:43123");
  assert.equal(registered[0][1].apiKey, TOKEN);
  assert.equal(registered[0][1].models[0].contextWindow, 200000);
  const unknown = registered[1][1].models[0];
  assert.deepEqual([unknown.contextWindow, unknown.maxTokens, unknown.reasoning, unknown.compat], [100000, 32000, true, { forceAdaptiveThinking: true }]);
  assert.deepEqual(unknown.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
