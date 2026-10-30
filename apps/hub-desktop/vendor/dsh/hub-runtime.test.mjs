import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { createDshSession } from "./hub-runtime.mjs";
import { PiRuntimeAdapter } from "./pi-adapter.mjs";

test("Pi replay omits unset object fields without hiding invalid JSON values", async () => {
  const model = { provider: "fixture", id: "fixture", contextWindow: 8192, maxTokens: 1024 };
  async function run(extra) {
    const answer = { role: "assistant", content: [{ type: "text", text: "REPLAY_OK", textSignature: undefined }],
      provider: "fixture", model: "fixture", stopReason: "stop", optional: undefined, extra,
      usage: { input: 20, output: 10, cacheRead: 80, cacheWrite: 0 } };
    const runtime = { streamSimple() { const stream = (async function* () {})(); stream.result = async () => answer; return stream; } };
    const session = await createDshSession({ model, tools: [], systemPrompt: "Fixture.", adapter: new PiRuntimeAdapter(model, runtime) });
    try {
      const result = await session.prompt("Return the fixture answer.");
      assert.ok(Object.hasOwn(answer, "optional"), "must not mutate the native SDK response");
      return result.snapshotEvents();
    } finally { await session.dispose(); }
  }
  const events = await run({ retained: "value", unset: undefined });
  const completed = events.findLast(event => event.type === "turn/end").data.reason;
  assert.equal(completed.kind, "completed", JSON.stringify(completed));
  assert.ok(JSON.stringify(events).includes('"retained":"value"'));
  for (const invalid of [NaN, Infinity, -Infinity, -0, 1n, [undefined], Array(1)]) {
    const failed = await run(invalid);
    const reason = failed.findLast(event => event.type === "turn/end").data.reason;
    assert.equal(reason.kind, "error");
    assert.match(reason.error.message, /losslessly JSON-serializable/);
  }
});

test("DSH's real loop dispatches only the supplied Hub tools", async () => {
  let calls = 0, requests = 0;
  const outcomes = [];
  let seed;
  class Fixture extends LlmAdapter {
    async resolveModel() { return { provider: "fixture", id: "fixture", name: "fixture", context: { contextWindow: 8192 } }; }
    async *stream(request) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["hub_read"]);
      if (requests >= 2) assert.ok(JSON.stringify(request.messages).includes("answer=42"), "seed preserves tool results");
      const block = requests++ === 0
        ? { type: "tool-call", id: "read_1", name: "hub_read", arguments: '{"path":"notes.txt"}' }
        : { type: "text", text: "DSH_OK" };
      yield { type: "block-start", index: 0, blockType: block.type };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: block.type === "tool-call" ? "tool-calls" : "stop" } };
    }
  }
  const session = await createDshSession({
    model: { provider: "fixture", id: "fixture", maxTokens: 1024 }, adapter: new Fixture(), systemPrompt: "Use Hub tools.",
    onEvent: (event) => { if (["turn/end", "tool/result"].includes(event.type)) outcomes.push(event); },
    tools: [{ name: "hub_read", description: "Read through Hub", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (_id, args) => { assert.equal(args.path, "notes.txt"); calls++; return { content: [{ type: "text", text: "answer=42" }] }; } }],
  });
  try {
    const native = await session.prompt("Read notes.txt.");
    seed = JSON.parse(JSON.stringify(native.snapshotEvents()));
    assert.equal(calls, 1, JSON.stringify(outcomes));
    assert.equal(requests, 2);
  } finally { await session.dispose(); }
  const resumed = await createDshSession({
    model: { provider: "fixture", id: "fixture", maxTokens: 1024 }, adapter: new Fixture(), systemPrompt: "Use Hub tools.",
    sessionId: "hub-resume", seed,
    tools: [{ name: "hub_read", description: "Read through Hub", parameters: { type: "object", properties: {} },
      execute: async () => { throw new Error("restored tools must not execute again"); } }],
  });
  try {
    await resumed.prompt("Recall the answer.");
    assert.equal(requests, 3);
    assert.equal(calls, 1);
  } finally { await resumed.dispose(); }
  await assert.rejects(createDshSession({
    model: { provider: "fixture", id: "fixture", maxTokens: 1024 }, adapter: new Fixture(), tools: [], systemPrompt: "Use Hub tools.",
    sessionId: "hub-broken", seed: seed.slice(1),
  }), /seq|sequence/i);
});
