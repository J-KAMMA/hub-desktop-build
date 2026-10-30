// Offline acceptance test for the installed CLI, using arguments built by Rust.
// The scripted loopback API never runs a model or uses the operator's credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";

const fixture = JSON.parse(process.argv[2]);
const { program, args, resumeArgs, workspace } = fixture;
assert.equal(resolve(workspace), workspace);
const root = dirname(workspace);
const note = join(workspace, "note.txt");
const outside = join(root, "outside.txt");
await writeFile(note, "fixture old");
await writeFile(outside, "OUTSIDE_MUST_NOT_CHANGE");
await mkdir(join(root, "outside-dir"));
await writeFile(join(root, "outside-dir", "secret.txt"), "OUTSIDE_SECRET");
await symlink(join(root, "outside-dir"), join(workspace, "linked-dir"), process.platform === "win32" ? "junction" : "dir");

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMSPEC)$/i.test(key)));
Object.assign(env, {
  CLAUDE_CONFIG_DIR: join(root, "config"),
  ANTHROPIC_API_KEY: "local-fixture-not-a-secret",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

let phase;
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw || "{}");
    if (!request.url?.startsWith("/v1/messages")) {
      response.writeHead(404).end("{}");
      return;
    }
    if (request.url.includes("count_tokens")) {
      response.setHeader("content-type", "application/json");
      response.end('{"input_tokens":100}');
      return;
    }
    assert.ok(phase, "unexpected request outside a test phase");
    phase.requests += 1;
    phase.tools = body.tools?.map(tool => tool.name).sort();
    if (phase.name === "cancel") {
      phase.pending();
      return; // The test cancels only its own CLI while this request is pending.
    }
    if (phase.name === "unauthenticated") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "fixture authentication rejected" } }));
      return;
    }
    for (const message of body.messages ?? []) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === "tool_result" && block.tool_use_id.startsWith(phase.name + "_")) phase.results.set(block.tool_use_id, block);
      }
    }
    const step = phase.steps[phase.requests - 1];
    const block = step
      ? { type: "tool_use", id: `${phase.name}_${phase.requests - 1}`, name: step[0], input: step[1] }
      : { type: "text", text: "FIXTURE_DONE" };
    const message = {
      id: `msg_${phase.name}_${phase.requests}`, type: "message", role: "assistant", model: body.model,
      content: [block], stop_reason: step ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 5, output_tokens: 20 },
    };
    if (!body.stream) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(message));
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { ...message, content: [], stop_reason: null } });
    event("content_block_start", { index: 0, content_block: step ? { ...block, input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: step ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
    event("message_stop", {});
    response.end();
  } catch (error) {
    if (phase) phase.error = error;
    response.writeHead(500).end("fixture failed");
  }
});
await new Promise(ready => server.listen(0, "127.0.0.1", ready));
env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;

const stopped = new Map();
function stop(child) {
  if (!stopped.has(child.pid)) stopped.set(child.pid, new Promise((fulfill, reject) => {
    if (process.platform !== "win32") { child.kill(); fulfill(); return; }
    const killer = spawn(join(env.SystemRoot ?? env.SYSTEMROOT, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", reject);
    killer.on("close", fulfill);
  }));
  return stopped.get(child.pid);
}

function run(cliArgs, onEvent) {
  const child = spawn(program, cliArgs, { cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const done = new Promise((fulfill, reject) => {
    let stdout = "", stderr = "", pendingLine = "";
    const timer = setTimeout(() => {
      void stop(child);
      reject(new Error(`CLI fixture timed out: ${JSON.stringify({ phase: phase.name, requests: phase.requests, results: phase.results?.size, serverError: phase.error?.message, stdout: stdout.slice(-2400), stderr: stderr.slice(-1200) })}`));
    }, 45_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", value => {
      stdout += value;
      pendingLine += value;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop();
      for (const line of lines.filter(Boolean)) onEvent?.(JSON.parse(line), child);
    });
    child.stderr.on("data", value => { stderr += value; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const events = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      fulfill({ code, signal, events, stderr });
    });
  });
  child.stdin.end("Follow the offline fixture. The local scripted API tests tool boundaries; no model is running.");
  return { child, done };
}

const boundarySteps = (oldText, newText, prefix) => [
  ["Read", { file_path: note }],
  ["Edit", { file_path: note, old_string: oldText, new_string: newText }],
  ["Read", { file_path: outside }],
  ["Write", { file_path: outside, content: "ESCAPED" }],
  ["Write", { file_path: join(root, `${prefix}-outside-new.txt`), content: "ESCAPED" }],
  ["Write", { file_path: `../${prefix}-relative-new.txt`, content: "ESCAPED" }],
  ["Read", { file_path: join(workspace, "linked-dir", "secret.txt") }],
  ["Write", { file_path: join(workspace, "linked-dir", `${prefix}-created.txt`), content: "ESCAPED" }],
  ["Write", { file_path: join(workspace, ".claude", "settings.json"), content: '{"fixture":true}' }],
  ["Glob", { pattern: "*", path: root }],
  ["Grep", { pattern: "OUTSIDE_SECRET", path: join(root, "outside-dir"), output_mode: "content" }],
  ["Bash", { command: "echo not-permitted" }],
];

async function checkBoundary(name, cliArgs, oldText, newText) {
  phase = { name, steps: boundarySteps(oldText, newText, name), requests: 0, results: new Map() };
  const result = await run(cliArgs).done;
  assert.ifError(phase.error);
  assert.equal(result.code, 0, result.stderr);
  const terminal = result.events.findLast(event => event.type === "result");
  assert.equal(terminal?.is_error, false, JSON.stringify(terminal));
  assert.equal(terminal?.result, "FIXTURE_DONE");
  assert.deepEqual(phase.tools, ["Edit", "Glob", "Grep", "Read", "Write"]);
  assert.equal(phase.results.size, phase.steps.length);
  for (let index = 0; index < phase.steps.length; index += 1) {
    assert.equal(phase.results.get(`${name}_${index}`)?.is_error ?? false, index >= 2, `${name} tool ${index}`);
  }
  assert.equal(await readFile(note, "utf8"), newText);
  assert.equal(await readFile(outside, "utf8"), "OUTSIDE_MUST_NOT_CHANGE");
  for (const file of [join(root, `${name}-outside-new.txt`), join(root, `${name}-relative-new.txt`), join(root, "outside-dir", `${name}-created.txt`), join(workspace, ".claude", "settings.json")]) {
    assert.equal(await access(file).then(() => true, () => false), false, file);
  }
  assert.match(terminal.session_id, /^[a-z0-9-]+$/i);
  assert.equal(terminal.usage.input_tokens, 100 * phase.requests);
  assert.equal(terminal.usage.cache_read_input_tokens, 40 * phase.requests);
  assert.equal(terminal.usage.cache_creation_input_tokens, 5 * phase.requests);
  assert.equal(terminal.usage.output_tokens, 20 * phase.requests);
  return { name, requests: phase.requests, toolResults: phase.results.size, session: terminal.session_id,
    usageEvent: { type: terminal.type, usage: terminal.usage } };
}

try {
  const initial = await checkBoundary("initial", args, "fixture old", "fixture new");
  assert.equal(resumeArgs.filter(value => value === "fixture-session").length, 1);
  const resumedArgs = resumeArgs.map(value => value === "fixture-session" ? initial.session : value);
  const resumed = await checkBoundary("resumed", resumedArgs, "fixture new", "fixture resumed");
  assert.equal(resumed.session, initial.session);

  let pending;
  const requestStarted = new Promise(ready => { pending = ready; });
  phase = { name: "cancel", requests: 0, pending };
  const cancelled = run(args);
  await Promise.race([requestStarted, cancelled.done.then(() => { throw new Error("CLI exited before cancellation"); })]);
  await stop(cancelled.child);
  const cancelledResult = await cancelled.done;
  assert.notEqual(cancelledResult.code, 0);
  assert.equal(cancelledResult.events.some(event => event.type === "result" && !event.is_error), false);
  server.closeAllConnections();

  phase = { name: "unauthenticated", requests: 0 };
  let authenticationEvent;
  const rejected = await run(args, (event, child) => {
    if (event.type === "system" && event.subtype === "api_retry" && event.error_status === 401) {
      authenticationEvent = event;
      void stop(child); // Rust also verifies its production stop decision for this event.
    }
  }).done;
  assert.ok(authenticationEvent);
  assert.notEqual(rejected.code, 0);
  assert.ok(phase.requests > 0);
  assert.equal(rejected.events.some(event => event.type === "result" && !event.is_error), false);
  console.log(JSON.stringify({ status: "passed", initialToolResults: initial.toolResults, resumedToolResults: resumed.toolResults,
    usageReports: [initial, resumed].map(run => ({ requests: run.requests, event: run.usageEvent })),
    cancel: "passed", authenticationEvent, inference: "local scripted API only" }));
} finally {
  await Promise.all(stopped.values());
  server.closeAllConnections();
  await new Promise(closed => server.close(closed));
}
