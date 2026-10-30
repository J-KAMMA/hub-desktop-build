import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const bundle = fileURLToPath(new URL("./pi-sidecar.mjs", import.meta.url));

function argumentFragments(args) {
  const escaped = args.indexOf("\\\\");
  const split = escaped < 0 ? 8 : escaped + 1;
  return [args.slice(0, split), args.slice(split)];
}

function completions(response, tool, incomplete, finalText = "PROTOCOL_OK") {
  const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
  })}\n\n`);
  if (tool) {
    const [first, last] = argumentFragments(JSON.stringify(tool.args));
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: `fixture_${tool.name}`, type: "function", function: { name: tool.name, arguments: first } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: last } }] });
  } else chunk({ role: "assistant", content: finalText });
  if (incomplete !== true) {
    // DeepSeek's documented cache fields, without the OpenAI cached_tokens alias.
    chunk({}, typeof incomplete === "string" ? incomplete : tool ? "tool_calls" : "stop", { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 10, total_tokens: 110 });
    response.write("data: [DONE]\n\n");
  }
  response.end();
}

function anthropic(response, tool, finalText = "PROTOCOL_OK") {
  const event = (type, body) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
  event("message_start", { message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 } } });
  event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
  event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Preserve this reasoning." } });
  event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "fixture-reasoning-signature" } });
  event("content_block_stop", { index: 0 });
  event("content_block_start", { index: 1, content_block: tool ? { type: "tool_use", id: `fixture_${tool.name}`, name: tool.name, input: {} } : { type: "text", text: "" } });
  if (tool) {
    for (const part of argumentFragments(JSON.stringify(tool.args))) {
      event("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: part } });
    }
  } else event("content_block_delta", { index: 1, delta: { type: "text_delta", text: finalText } });
  event("content_block_stop", { index: 1 });
  event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
  event("message_stop", {});
  response.end();
}

// Wire fixtures follow the Responses API events, independently of the SDK parser:
// https://developers.openai.com/api/reference/resources/responses/streaming-events
function responses(response, tool, failure, number, finalText = "PROTOCOL_OK") {
  let sequence = 0;
  const event = (type, body) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...body })}\n\n`);
  const envelope = { id: `resp_${number}`, object: "response", created_at: 1, model: "fixture", status: "in_progress", output: [], error: null };
  event("response.created", { response: envelope });
  const reasoning = { id: `rs_${number}`, type: "reasoning", summary: [{ type: "summary_text", text: "Preserve this reasoning." }], encrypted_content: `fixture-encrypted-${number}` };
  event("response.output_item.added", { output_index: 0, item: { ...reasoning, summary: [], encrypted_content: "unfinished-marker" } });
  event("response.reasoning_summary_text.delta", { output_index: 0, item_id: reasoning.id, summary_index: 0, delta: reasoning.summary[0].text });
  event("response.output_item.done", { output_index: 0, item: reasoning });
  const item = tool
    ? { id: `fc_${number}`, call_id: `call_${number}`, type: "function_call", name: tool.name, arguments: JSON.stringify(tool.args), status: "completed" }
    : { id: `msg_${number}`, type: "message", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: finalText, annotations: [] }] };
  event("response.output_item.added", { output_index: 1, item: { ...item, status: "in_progress", ...(tool ? { arguments: "" } : { content: [] }) } });
  if (tool) {
    for (const delta of argumentFragments(item.arguments)) {
      event("response.function_call_arguments.delta", { output_index: 1, item_id: item.id, delta });
    }
    event("response.function_call_arguments.done", { output_index: 1, item_id: item.id, arguments: item.arguments });
  } else {
    event("response.content_part.added", { output_index: 1, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    for (const delta of [finalText.slice(0, 9), finalText.slice(9)]) event("response.output_text.delta", { output_index: 1, item_id: item.id, content_index: 0, delta });
    event("response.output_text.done", { output_index: 1, item_id: item.id, content_index: 0, text: finalText });
    event("response.content_part.done", { output_index: 1, item_id: item.id, content_index: 0, part: item.content[0] });
  }
  event("response.output_item.done", { output_index: 1, item });
  if (failure !== true && failure !== "tool-cut") {
    const status = failure === "failed" ? "failed" : failure ? "incomplete" : "completed";
    event(`response.${status}`, { response: { ...envelope, status, output: [reasoning, item],
      incomplete_details: status === "incomplete" ? { reason: failure } : null,
      error: status === "failed" ? { code: "server_error", message: "fixture failure" } : null,
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 }, output_tokens: 10, total_tokens: 110 },
    } });
  }
  response.end();
}

// The completion review runs only while an unchecked change could still be
// checked, so the protocol fixtures advertise hub_exec (never called) to keep
// the bounded review read in the sequence; caps "" covers the skipped review.
async function verify(api, incomplete = false, engine = "dsh", missingFinal, readProfile = "plain", local = false, caps = "exec") {
  const discovered = ["discovered", "cold-discovered"].includes(local);
  const codex = api === "openai-codex-responses";
  const responsesApi = api === "openai-responses" || codex;
  const cwd = await mkdtemp(join(tmpdir(), "hub-pi-provider-"));
  const emptyRead = ["empty", "legacy-empty"].includes(readProfile);
  const before = emptyRead ? "" : readProfile === "large" ? `protocol fixture file\n${"context line\n".repeat(1600)}`
    : readProfile === "escaped" ? "protocol fixture file\r\nconst text = '\\n';\n// 日本語 😀\t\\server\n" : "protocol fixture file";
  const after = readProfile !== "plain" ? "updated protocol fixture\r\nconst text = '\\\\';\n// 日本語 😀\t\\server\n" : "updated protocol fixture";
  const mutation = readProfile === "escaped"
    ? { name: "hub_edit", args: { path: "notes.txt", oldText: before, newText: after } }
    : { name: "hub_write", args: { path: "notes.txt", content: after } };
  const requests = [];
  const server = createServer(async (request, response) => {
    if (local && ["/api/tags", "/api/ps"].includes(request.url)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: local === "cold-discovered" && request.url === "/api/ps"
        ? [] : [{ name: "fixture", context_length: discovered ? 8192 : 4096 }] }));
      return;
    }
    const parts = [];
    for await (const part of request) parts.push(part);
    const bytes = Buffer.concat(parts);
    const body = request.headers["content-encoding"] === "zstd" ? zlib.zstdDecompressSync(bytes) : bytes;
    if (local === "cold-discovered" && request.url === "/api/show") {
      assert.deepEqual(JSON.parse(body), { model: "fixture" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ parameters: "num_ctx 8192", model_info: { "fixture.context_length": 131072 } }));
      return;
    }
    requests.push({ path: request.url, body: JSON.parse(body.toString()), sessionId: request.headers["session-id"] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const tool = incomplete && incomplete !== "tool-cut" ? null : ({
      1: { name: "hub_read", args: { path: "notes.txt" } },
      2: mutation,
      4: { name: "hub_read", args: { path: "notes.txt" } },
    })[requests.length];
    const finalText = missingFinal && (!missingFinal.afterReview || requests.length >= 5) ? missingFinal.text : "PROTOCOL_OK";
    if (api === "anthropic-messages") anthropic(response, tool, finalText);
    else if (responsesApi) responses(response, tool, incomplete, requests.length, finalText);
    else completions(response, tool, incomplete, finalText);
  });
  // Exercise the SDK's ordinary SSE fallback without any external connection.
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}${api === "anthropic-messages" ? "" : "/v1"}`;
    // Synthetic JWT shape only: accepted solely by this local fixture, never a credential.
    const apiKey = codex ? ["fixture", Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url"), "fixture"].join(".") : "local-test-marker";
    const provider = local ? "ollama" : "hub-api-fixture";
    await writeFile(join(cwd, "models.json"), JSON.stringify({ providers: { [provider]: {
      api, baseUrl, apiKey, models: [{ id: discovered ? "configured" : "fixture", name: "fixture", reasoning: false,
        input: ["text"], contextWindow: local ? 4096 : 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bundle, `${provider}/fixture`, "Read notes.txt, change it to updated protocol fixture, and read back the result."], {
        cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_SIDECAR_CAPS: caps, PI_SIDECAR_SESSION: "1", PI_WORK_ENGINE: engine, PI_SIDECAR_RETRY_BASE_MS: "5" },
      });
      let buffer = "", stderr = "", calls = 0, file = before;
      const frames = [];
      const timer = setTimeout(() => { child.kill(); reject(new Error("provider fixture timeout")); }, 25000);
      child.stdout.on("data", (data) => {
        buffer += data;
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const frame = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          frames.push(frame);
          if (frame.type === "tool_call") {
            calls++;
            if (frame.name !== ["hub_read", mutation.name, "hub_read"][calls - 1] || frame.args.path !== "notes.txt") {
              child.kill(); reject(new Error("unexpected fixture tool")); return;
            }
            if (frame.name === "hub_write") file = frame.args.content;
            if (frame.name === "hub_edit") file = after;
            const details = frame.name === "hub_read" ? { content: file, sizeBytes: Buffer.byteLength(file), relativePath: "notes.txt" } : {};
            const text = frame.name === mutation.name ? "write completed"
              : readProfile === "legacy-empty" && file === "" ? JSON.stringify(details) : file;
            child.stdin.write(`${JSON.stringify({ type: "tool_result", id: frame.id, content: [{ type: "text", text }], details })}\n`);
          }
        }
      });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr));
        else resolve({ frames, calls, stderr });
      });
      child.stdin.write(`${JSON.stringify({ type: "session", entries: [],
        ...(missingFinal?.verification ? { verification: { program: "node", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 1000 } } : {}),
      })}\n`);
    });
    if (missingFinal) {
      assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, false, "an empty final response must fail even after earlier text or successful tools");
      assert.equal(result.calls, missingFinal.afterReview ? 3 : 2, "must not execute verification or retry an empty response");
      assert.equal(requests.length, missingFinal.afterReview ? 5 : 3, "an empty response must not trigger another model request");
      assert.match(result.stderr, /final_response_missing/);
      return;
    }
    if (!caps) {
      // No check tool and the last Hub result is the successful write: no review turn.
      assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, true, result.stderr);
      assert.equal(result.calls, 2, "read and write only; no review read-back");
      assert.equal(requests.length, 3, "read, write and the final answer");
      const sent = JSON.stringify(requests.map((request) => request.body));
      assert.ok(!sent.includes("Hub execution evidence"), "no completion review was queued");
      for (const name of ["hub_exec", "hub_test", "hub_pay", "hub_catalog_search", "hub_product_read"]) assert.ok(!sent.includes(name), `${name} is neither offered nor mentioned`);
      return;
    }
    const errors = result.frames.filter(frame => frame.event?.type === "message_end" && frame.event.message?.role === "assistant").map(frame => ({ stop: frame.event.message.stopReason, error: frame.event.message.errorMessage, tools: frame.event.message.content.filter(block => block.type === "toolCall").map(block => ({ id: block.id, name: block.name })) }));
    const terminal = result.frames.findLast(frame => frame.type === "checkpoint")?.entries?.filter(entry => entry.type === "turn/end");
    assert.equal(result.frames.findLast((frame) => frame.type === "agent_done")?.ok, !incomplete, `${result.stderr}\n${JSON.stringify({ errors, terminal, requests: requests.length, calls: result.calls })}`);
    assert.equal(result.calls, incomplete ? 0 : 3);
    if (incomplete) assert.ok(requests.length >= 1 && requests.length <= 1, "a broken stream never executes tools and still fails");
    else assert.equal(requests.length, 5, "read, write, answer, bounded review read and final answer");
    if (discovered) {
      assert.match(result.stderr, /context window=8192 maxTokens=2048/);
      assert.equal(requests[0].body.max_tokens, 2048, "the provider must receive the resolved output budget");
    }
    if (local) {
      for (const request of requests) {
        assert.ok(Number.isSafeInteger(request.body.max_tokens) && request.body.max_tokens > 1 && request.body.max_tokens <= (discovered ? 2048 : 1024));
        assert.equal(Object.hasOwn(request.body, "max_completion_tokens"), false);
      }
    }
    if (incomplete) return;
    const messages = result.frames.filter((frame) => frame.event?.type === "message_end" && frame.event.message.role === "assistant").map((frame) => frame.event.message);
    assert.equal(messages.length, 5);
    for (const message of messages) {
      assert.equal(message.usage.input, 20);
      assert.equal(message.usage.cacheRead, responsesApi ? 60 : 80);
      assert.equal(message.usage.cacheWrite, responsesApi ? 20 : 0);
      assert.equal(message.usage.output, 10);
      assert.equal(message.usage.totalTokens, 110);
    }
    const history = (request) => responsesApi ? request.body.input : request.body.messages;
    if (readProfile !== "plain") {
      if (readProfile === "escaped") {
        const edit = result.frames.find(frame => frame.type === "tool_call" && frame.name === "hub_edit");
        assert.deepEqual(JSON.parse(edit.args.content), { oldText: before, newText: after }, "escaping changed between the provider and the Hub executor");
      }
      const toolText = request => {
        const messages = history(request);
        const output = api === "anthropic-messages"
          ? messages.flatMap(message => Array.isArray(message.content) ? message.content : []).findLast(block => block.type === "tool_result")?.content
          : responsesApi ? messages.findLast(message => message.type === "function_call_output")?.output
          : messages.findLast(message => message.role === "tool")?.content;
        return typeof output === "string" ? output : output?.map(block => block.text).join("\n");
      };
      assert.equal(toolText(requests[1]), emptyRead ? "The file is empty (0 bytes)." : before, "read content was not represented faithfully to the model");
      assert.equal(toolText(requests[4]), after, "read-back text changed before the model received it");
    }
    if (before) assert.ok(JSON.stringify(history(requests[1])).includes("protocol fixture file"));
    if (api === "anthropic-messages") {
      const assistant = requests[1].body.messages.find((message) => message.role === "assistant");
      assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "Preserve this reasoning.", signature: "fixture-reasoning-signature" });
    }
    if (responsesApi) {
      const replay = history(requests[1]);
      assert.deepEqual(replay.find((item) => item.type === "reasoning"), {
        id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Preserve this reasoning." }], encrypted_content: "fixture-encrypted-1",
      });
      const call = replay.find((item) => item.type === "function_call");
      const output = replay.find((item) => item.type === "function_call_output");
      assert.equal(call.call_id, "call_1");
      assert.equal(output.call_id, call.call_id);
      assert.equal(call.name, "hub_read");
      assert.deepEqual(JSON.parse(call.arguments), { path: "notes.txt" });
      assert.equal(history(requests[3]).find((item) => item.id === "msg_3").phase, "final_answer");
      assert.equal(typeof requests[0].body.prompt_cache_key, "string");
      assert.ok(requests[0].body.prompt_cache_key.length > 0);
      for (const request of requests) {
        assert.equal(request.body.store, false);
        assert.equal(request.body.prompt_cache_key, requests[0].body.prompt_cache_key);
        assert.deepEqual(history(request).slice(0, codex ? 1 : 2), history(requests[0]).slice(0, codex ? 1 : 2), "system and initial request stay unchanged");
        if (codex) {
          assert.equal(request.sessionId, request.body.prompt_cache_key);
          assert.equal(request.body.instructions, requests[0].body.instructions);
        }
      }
    }
    const review = history(requests[3]).findLast((message) => message.role === "user");
    const reviewText = typeof review.content === "string" ? review.content : review.content.map((block) => block.text ?? "").join("");
    assert.ok(reviewText.includes('"unreadChangedFiles":["notes.txt"]'));
    assert.ok(JSON.stringify(history(requests[4])).includes("updated protocol fixture"));
    assert.ok(JSON.stringify(messages.at(-1).content).includes("PROTOCOL_OK"));
    for (const request of requests) {
      assert.equal(new URL(request.path, baseUrl).pathname, { "anthropic-messages": "/v1/messages", "openai-completions": "/v1/chat/completions", "openai-responses": "/v1/responses", "openai-codex-responses": "/v1/codex/responses" }[api]);
      assert.deepEqual(request.body.tools, requests[0].body.tools);
      if (local) assert.equal(request.body.reasoning_effort, "none", "Pi/DSH thinking-off must be explicit on Ollama requests");
    }
    return requests[0].body.prompt_cache_key;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(dirname(await realpath(cwd)), await realpath(tmpdir()));
    await rm(cwd, { recursive: true });
  }
}

test("DSH uses Hub tools over the existing Chat Completions provider and keeps cache usage", () => verify("openai-completions", false, "dsh"));
test("DSH replays the native Anthropic tool conversation through Pi", () => verify("anthropic-messages", false, "dsh"));
test("DSH cannot treat an interrupted provider stream as completion", () => verify("openai-completions", true, "dsh"));
for (const engine of ["dsh"]) {
  test(`${engine}: without a check tool the review after a successful write is skipped and unoffered tools are never named`, () => verify("openai-completions", false, engine, undefined, "plain", false, ""));
}
test("an older Runtime's empty-file envelope is identified as an empty file", () => verify("openai-completions", false, "dsh", undefined, "legacy-empty"));

for (const engine of ["dsh"]) {
  test(`${engine}: discovered Ollama uses its confirmed 8k allocation through a large file edit`, () => verify("openai-completions", false, engine, undefined, "large", "discovered"));
  test(`${engine}: cold Ollama uses its explicit 8k setting through a large file edit`, () => verify("openai-completions", false, engine, undefined, "large", "cold-discovered"));
  test(`${engine}: Ollama uses an effective output limit with a 4k context and preserves tool replay`, () => verify("openai-completions", false, engine, undefined, "escaped", true));
  test(`${engine}: Ollama output limit exhaustion is not a successful answer`, () => verify("openai-completions", "length", engine, undefined, "plain", true));
  test(`${engine}: Codex Responses preserves cache affinity within a task and isolates new tasks`, async () => {
    const first = await verify("openai-codex-responses", false, engine, undefined, "escaped");
    const second = await verify("openai-codex-responses", false, engine, undefined, "empty");
    assert.notEqual(first, second, "independent work must not reuse another task's cache routing identity");
  });
  test(`${engine}: Responses keeps encrypted reasoning, tool ids, cache usage and session affinity`, () => verify("openai-responses", false, engine));
  for (const failure of [true, "tool-cut", "max_output_tokens", "content_filter", "failed"]) {
    test(`${engine}: Responses ${failure === true ? "disconnection" : failure} cannot execute tools or report completion`, () => verify("openai-responses", failure, engine));
    test(`${engine}: Codex Responses ${failure === true ? "disconnection" : failure} cannot execute tools or report completion`, () => verify("openai-codex-responses", failure, engine));
  }
  for (const api of ["openai-completions", "anthropic-messages", "openai-responses"]) {
    test(`${engine}: ${api} preserves escaped edit arguments and read text across split streams`, () => verify(api, false, engine, undefined, "escaped"));
    test(`${engine}: ${api} preserves an empty file read before writing`, () => verify(api, false, engine, undefined, "empty"));
    test(`${engine}: ${api} rejects an empty final response before verification`, () => verify(api, false, engine, { text: "", verification: true }));
    test(`${engine}: ${api} rejects whitespace instead of starting a review`, () => verify(api, false, engine, { text: " \n\t" }));
    test(`${engine}: ${api} cannot reuse earlier text when the review returns empty`, () => verify(api, false, engine, { text: "", afterReview: true }));
  }
}

// Thin engine (the only SDK engine since 2026-10-18, owner-approved) over each provider API:
// Pi's native read/write reach Hub only as hub_fs / hub_fs_write, cache usage and reasoning
// survive the tool round trip, and a broken stream never writes or reports success.
async function verifyThin(api, incomplete = false) {
  const responsesApi = api === "openai-responses";
  const cwd = await mkdtemp(join(tmpdir(), "hub-thin-provider-"));
  const before = "protocol fixture file\n", after = "updated protocol fixture\n";
  const requests = [];
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const bytes = Buffer.concat(parts);
    const body = request.headers["content-encoding"] === "zstd" ? zlib.zstdDecompressSync(bytes) : bytes;
    requests.push({ path: request.url, body: JSON.parse(body.toString()) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const tool = incomplete ? null : ({
      1: { name: "read", args: { path: "notes.txt" } },
      2: { name: "write", args: { path: "notes.txt", content: after } },
    })[requests.length];
    if (api === "anthropic-messages") anthropic(response, tool);
    else if (responsesApi) responses(response, tool, incomplete, requests.length);
    else completions(response, tool, incomplete);
  });
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}${api === "anthropic-messages" ? "" : "/v1"}`;
    await writeFile(join(cwd, "models.json"), JSON.stringify({ providers: { "hub-api-fixture": {
      api, baseUrl, apiKey: "local-test-marker", models: [{ id: "fixture", name: "fixture", reasoning: false,
        input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const root = await realpath(cwd);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bundle, "hub-api-fixture/fixture", "Read notes.txt and change it to updated protocol fixture."], {
        cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_SIDECAR_CAPS: "", PI_SIDECAR_SESSION: "1", PI_WORK_ENGINE: "thin", PI_SIDECAR_RETRY_BASE_MS: "5" },
      });
      let buffer = "", stderr = "", file = before;
      const frames = [];
      const timer = setTimeout(() => { child.kill(); reject(new Error("thin provider fixture timeout")); }, 25000);
      child.stdout.on("data", (data) => {
        buffer += data;
        while (buffer.includes("\n")) {
          const frame = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          buffer = buffer.slice(buffer.indexOf("\n") + 1);
          frames.push(frame);
          if (frame.type !== "tool_call") continue;
          const answer = (details) => child.stdin.write(`${JSON.stringify({ type: "tool_result", id: frame.id, content: [{ type: "text", text: "ok" }], details })}\n`);
          if (!["hub_fs", "hub_fs_write"].includes(frame.name)) { child.kill(); reject(new Error(`unexpected tool ${frame.name}`)); return; }
          if (frame.name === "hub_fs_write" && frame.args.op === "write") file = frame.args.content;
          answer(frame.name === "hub_fs" && frame.args.op === "read" ? { content: file } : { exists: true, directory: frame.args.op === "stat" && frame.args.path === root });
        }
      });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve({ frames, stderr, file }) : reject(new Error(stderr)); });
      child.stdin.write(`${JSON.stringify({ type: "session", entries: [] })}\n`);
    });
    const done = result.frames.findLast((frame) => frame.type === "agent_done");
    const writes = result.frames.filter((frame) => frame.type === "tool_call" && frame.name === "hub_fs_write" && frame.args.op === "write");
    if (incomplete) {
      assert.equal(done?.ok, false, "a broken stream is never a successful answer");
      assert.equal(writes.length, 0, "a broken stream never executes tools");
      assert.ok(requests.length >= 1 && requests.length <= 4, "temporary failures retry at most three times");
      return;
    }
    assert.equal(done?.ok, true, result.stderr);
    assert.equal(result.file, after);
    assert.equal(writes.length, 1);
    assert.ok(writes[0].args.path.toLowerCase().startsWith(root.toLowerCase()), "Hub receives the absolute path Pi resolved");
    assert.equal(requests.length, 3, "read, write and the final answer; thin adds no review turn");
    const messages = result.frames.filter((frame) => frame.event?.type === "message_end" && frame.event.message.role === "assistant").map((frame) => frame.event.message);
    assert.equal(messages.length, 3);
    for (const message of messages) {
      assert.equal(message.usage.cacheRead, responsesApi ? 60 : 80);
      assert.equal(message.usage.output, 10);
    }
    const history = (request) => responsesApi ? request.body.input : request.body.messages;
    assert.ok(JSON.stringify(history(requests[1])).includes("protocol fixture file"), "the read text reached the model");
    if (api === "anthropic-messages") {
      const assistant = requests[1].body.messages.find((message) => message.role === "assistant");
      assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "Preserve this reasoning.", signature: "fixture-reasoning-signature" });
    }
    if (responsesApi) {
      const replay = history(requests[1]);
      assert.equal(replay.find((item) => item.type === "reasoning")?.encrypted_content, "fixture-encrypted-1");
      assert.equal(replay.find((item) => item.type === "function_call")?.name, "read");
    }
    for (const request of requests) assert.deepEqual(request.body.tools, requests[0].body.tools, "tool definitions stay byte-stable");
    const header = result.frames.findLast((frame) => frame.type === "checkpoint")?.entries?.[0];
    assert.equal(header?.hubEngine, "thin", "the checkpoint names the engine that wrote it");
    assert.ok(JSON.stringify(messages.at(-1).content).includes("PROTOCOL_OK"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(cwd, { recursive: true });
  }
}

for (const api of ["openai-completions", "anthropic-messages", "openai-responses"]) {
  test(`thin: ${api} reads and writes only through Hub and keeps cache usage and reasoning`, () => verifyThin(api));
}
test("thin: an incomplete Chat Completions stream cannot write or report success", () => verifyThin("openai-completions", true));
test("thin: a disconnected Responses stream cannot write or report success", () => verifyThin("openai-responses", true));
