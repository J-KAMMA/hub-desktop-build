// Native Codex acceptance against a scripted loopback Responses API. No model,
// operator credentials, or existing sessions are used by this fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";

const { program, args, resumeArgs, workspace, runEnvironments, policyOnly = false } = JSON.parse(process.argv[2]);
assert.equal(resolve(workspace), workspace);
const root = dirname(workspace);
const outside = join(root, "outside.txt");
await writeFile(join(workspace, "note.txt"), "fixture old\n");
await writeFile(outside, "OUTSIDE_MUST_NOT_CHANGE\n");
await mkdir(join(root, "outside-dir"));
await symlink(join(root, "outside-dir"), join(workspace, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
const fixtureHome = join(root, "config");
await mkdir(fixtureHome);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMSPEC)$/i.test(key)));
env.CODEX_HOME = fixtureHome;
env.OTEL_SDK_DISABLED = "true";
assert.equal(new Set(Object.values(runEnvironments).map(value => value.TEMP)).size, 3);
const quote = text => `'${text.replaceAll("'", "''")}'`;
const exists = path => access(path).then(() => true, () => false);
let phase;

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/responses", "unexpected API path");
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    const tools = body.tools ?? body.input?.filter(item => item.type === "additional_tools").flatMap(item => item.tools) ?? [];
    assert.ok(phase, "request outside a phase");
    phase.requests += 1;
    phase.tools = tools.map(tool => ({ type: tool.type, name: tool.name }));
    const previous = (body.input ?? []).findLast(item => item.call_id === phase.lastCall && /_call_output$/.test(item.type));
    const running = previous && JSON.stringify(previous.output).match(/Script running with cell ID (\d+)/);
    if (previous && !running) {
      phase.results.set(`${phase.name}_${phase.step}`, previous.output);
      phase.step += 1;
    }
    if (phase.name === "cancel") { phase.pending(); return; }
    const step = phase.steps[phase.step];
    const callId = `${phase.name}_${phase.step}_request${phase.requests}`;
    phase.lastCall = callId;
    const output = running ? { id: `item_${callId}`, type: "function_call", call_id: callId, name: "wait", namespace: "functions",
      arguments: JSON.stringify({ cell_id: running[1], yield_time_ms: 1000, max_tokens: 500 }) } : step ? step(tools, callId) : {
      id: `msg_${callId}`, type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: "FIXTURE_DONE", annotations: [] }],
    };
    response.setHeader("content-type", "text/event-stream");
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const result = { id: `resp_${callId}`, object: "response", model: body.model, output: [output],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
    event("response.created", { response: { ...result, status: "in_progress", output: [] } });
    event("response.output_item.added", { output_index: 0, item: output });
    event("response.output_item.done", { output_index: 0, item: output });
    event("response.completed", { response: { ...result, status: "completed" } });
    response.end();
  } catch (error) {
    if (phase) phase.error = error;
    response.writeHead(500).end("fixture failed");
  }
});
await new Promise(ready => server.listen(0, "127.0.0.1", ready));
const connection = ["-c", 'model_provider="hub_fixture"', "-c",
  `model_providers.hub_fixture={name="Hub fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`];

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

function run(cliArgs) {
  const child = spawn(program, [...cliArgs, ...connection], { cwd: workspace, env: { ...env, ...runEnvironments[phase.name] }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const done = new Promise((fulfill, reject) => {
    let stdout = "", stderr = "";
    const timer = setTimeout(async () => {
      await stop(child);
      reject(new Error(`CLI fixture timed out: ${JSON.stringify({ phase: phase.name, step: phase.step, requests: phase.requests, tools: phase.tools, results: [...phase.results].map(([id, result]) => [id, JSON.stringify(result).slice(-600)]), error: phase.error?.message, stdout: stdout.slice(-1600), stderr: stderr.slice(-1600) })}`));
    }, 120_000);
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      fulfill({ code, signal, stderr, events: stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) });
    });
  });
  child.stdin.end("Offline scripted tool fixture; no model or external API is used.");
  return { child, done };
}

const patch = text => (tools, callId) => {
  if (tools.some(tool => tool.name === "functions" && tool.tools?.some(child => child.name === "exec"))) return {
    id: `item_${callId}`, type: "custom_tool_call", call_id: callId, name: "exec", namespace: "functions",
    input: `text(await tools.apply_patch(${JSON.stringify(text)}));`,
  };
  assert.ok(tools.some(tool => tool.name === "apply_patch" && tool.type === "custom"), JSON.stringify(tools.map(tool => ({ name: tool.name, type: tool.type }))));
  return { id: `item_${callId}`, type: "custom_tool_call", call_id: callId, name: "apply_patch", input: text };
};
const shell = command => (tools, callId) => {
  if (tools.some(tool => tool.name === "functions" && tool.tools?.some(child => child.name === "exec"))) return {
    id: `item_${callId}`, type: "custom_tool_call", call_id: callId, name: "exec", namespace: "functions",
    input: `let r = await tools.exec_command(${JSON.stringify({ cmd: command, workdir: workspace, yield_time_ms: 1000, max_output_tokens: 300 })}); while(r.session_id) r = await tools.write_stdin({session_id:r.session_id,chars:"",yield_time_ms:1000,max_output_tokens:300}); text(r);`,
  };
  const name = tools.find(tool => ["exec_command", "shell_command"].includes(tool.name))?.name;
  assert.ok(name, "native shell tool missing");
  const arguments_ = name === "exec_command" ? { cmd: command, workdir: workspace, yield_time_ms: 1000, max_output_tokens: 300 } : { command, workdir: workspace, timeout_ms: 10000 };
  return { id: `item_${callId}`, type: "function_call", call_id: callId, name, arguments: JSON.stringify(arguments_) };
};

async function checkBoundary(name, cliArgs, oldText, newText) {
  phase = { name, requests: 0, step: 0, results: new Map(), steps: [
    shell(`Set-Content -LiteralPath ${quote(join(workspace, `${name}-inside.txt`))} -Value 'INSIDE_OK'`),
    patch(`*** Begin Patch\n*** Update File: note.txt\n@@\n-${oldText}\n+${newText}\n*** End Patch`),
    patch(`*** Begin Patch\n*** Update File: ${outside.replaceAll("\\", "/")}\n@@\n-OUTSIDE_MUST_NOT_CHANGE\n+ESCAPED\n*** End Patch`),
    shell(`Set-Content -LiteralPath ${quote(outside)} -Value 'ESCAPED'`),
    shell(`Set-Content -LiteralPath '../${name}-relative.txt' -Value 'ESCAPED'`),
    shell(`Set-Content -LiteralPath ${quote(join(workspace, "linked-dir", `${name}-linked.txt`))} -Value 'ESCAPED'`),
  ] };
  if (policyOnly) phase.steps = [];
  const result = await run(cliArgs).done;
  assert.ifError(phase.error);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(phase.results.size, phase.steps.length, JSON.stringify({ results: [...phase.results], events: result.events }));
  const records = (await Promise.all((await readdir(join(fixtureHome, "sessions"), { recursive: true }))
    .filter(path => path.endsWith(".jsonl"))
    .map(async path => (await readFile(join(fixtureHome, "sessions", path), "utf8")).trim().split("\n").map(line => JSON.parse(line))))).flat();
  const contexts = records.filter(record => record.type === "turn_context");
  assert.equal(contexts.length, name === "start" ? 1 : 2);
  for (const { payload } of contexts) {
    assert.equal(payload.sandbox_policy.type, "workspace-write");
    assert.equal(payload.sandbox_policy.network_access, false);
    assert.equal(resolve(payload.cwd), workspace);
    assert.deepEqual(payload.sandbox_policy.writable_roots ?? [], []);
  }
  if (!policyOnly) {
    assert.equal((await readFile(join(workspace, "note.txt"), "utf8")).trim(), newText, JSON.stringify({ stderr: result.stderr, results: [...phase.results] }));
    assert.equal((await readFile(join(workspace, `${name}-inside.txt`), "utf8")).trim(), "INSIDE_OK", JSON.stringify([...phase.results]));
    assert.equal((await readFile(outside, "utf8")).trim(), "OUTSIDE_MUST_NOT_CHANGE", JSON.stringify([...phase.results]));
    assert.equal(await exists(join(root, `${name}-relative.txt`)), false);
    assert.equal(await exists(join(root, "outside-dir", `${name}-linked.txt`)), false);
    for (const index of [2, 3, 4, 5]) {
      assert.match(JSON.stringify(phase.results.get(`${name}_${index}`)), /rejected|denied|アクセス.*拒否/i, "a failed tool dispatch is not a proven boundary denial");
    }
  }
  return { session: result.events.find(event => event.type === "thread.started")?.thread_id, requests: phase.requests, tools: phase.tools };
}

try {
  const start = await checkBoundary("start", args, "fixture old", "fixture first");
  assert.ok(start.session, "native continuation handle missing");
  const resume = await checkBoundary("resume", resumeArgs.map(arg => arg === "fixture-session" ? start.session : arg), "fixture first", "fixture resumed");
  let ready;
  const pending = new Promise(resolve => { ready = resolve; });
  phase = { name: "cancel", requests: 0, results: new Map(), pending: ready };
  const cancelled = run(args);
  await Promise.race([pending, cancelled.done.then(result => { throw new Error(JSON.stringify(result)); })]);
  await stop(cancelled.child);
  await cancelled.done;
  process.stdout.write(JSON.stringify({ scope: policyOnly ? "native policy and transport only" : "native file boundary", start, resume, cancellation: "passed", root }));
} finally {
  server.closeAllConnections();
  server.close();
}
