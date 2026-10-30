import { test } from "node:test";
import assert from "node:assert/strict";
import { addLocalModels, modelLocation } from "./local-models.mjs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

test("local discovery adds installed models, preserving configured models and auth", async () => {
  const known = [{ id: "qwen:3b", baseUrl: "http://localhost:11434/v1", contextWindow: 8192 }];
  let registration;
  const discovered = await addLocalModels({ getModels: () => known, registerProvider: (id, config) => { registration = { id, config }; } }, async (url, options) => {
    assert.equal(url.href, "http://localhost:11434/api/tags");
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => ({ models: [{ name: "qwen:3b" }, { name: "new:7b" }, { name: "new:7b" }, { name: "--bad" }, { name: "bad\nname" }] }) };
  });
  assert.deepEqual(registration.config.models.map((m) => m.id), ["qwen:3b", "new:7b"]);
  assert.equal(registration.config.models[0], known[0]);
  assert.equal(registration.config.apiKey, undefined);
  assert.deepEqual(discovered, ["new:7b"]);
});

test("empty Pi configuration can discover local Ollama without writing config", async () => {
  let registration;
  await addLocalModels({ getModels: () => [], registerProvider: (_, config) => { registration = config; } }, async () => ({ ok: true, json: async () => ({ models: [{ name: "local:latest" }] }) }));
  assert.equal(registration.api, "openai-completions");
  assert.equal(registration.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(registration.models[0].contextWindow, 4096);
});

test("real SDK resolves an unconfigured local model through discovery", async () => {
  const { ModelRuntime } = await import("./workspace/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js");
  const root = await mkdtemp(join(tmpdir(), "hub-local-models-test-"));
  try {
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
    assert.equal(runtime.getModel("ollama", "fixture:latest"), undefined);
    await addLocalModels(runtime, async () => ({ ok: true, json: async () => ({ models: [{ name: "fixture:latest" }] }) }));
    const model = runtime.getModel("ollama", "fixture:latest");
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(model.contextWindow, 4096);
  } finally {
    assert.equal(dirname(await realpath(root)), await realpath(tmpdir()));
    await rm(root, { recursive: true });
  }
});

test("remote or credentialed endpoints are not probed; failed discovery leaves models intact", async () => {
  for (const baseUrl of ["https://example.com/v1", "http://user:pass@localhost/v1", "file:///config"]) {
    await addLocalModels({ getModels: () => [{ baseUrl }], registerProvider: () => assert.fail("registered") }, async () => assert.fail("request"));
  }
  for (const body of [{}, { models: null }, { models: {} }, { models: [{ name: "x".repeat(161) }] }]) {
    await addLocalModels({ getModels: () => [], registerProvider: () => assert.fail("registered") }, async () => ({ ok: true, json: async () => body }));
  }
  await addLocalModels({ getModels: () => [], registerProvider: () => assert.fail("registered") }, async () => { throw new Error("offline"); });
  assert.equal(modelLocation({ baseUrl: "http://[::1]:1234/v1" }), "local");
  assert.equal(modelLocation({ baseUrl: "https://api.example.com" }), "api");
});
