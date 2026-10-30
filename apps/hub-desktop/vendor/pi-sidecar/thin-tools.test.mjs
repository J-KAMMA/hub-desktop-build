import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { thinShell } from "./thin-shell.mjs";

const bundle = fileURLToPath(new URL("./pi-sidecar.mjs", import.meta.url));
const MARKER = "sk-thin-marker-0123456789abcdef";

// Plays Hub for one thin sidecar run: refuses paths outside cwd, keeps "files" in memory and
// answers commands; it performs nothing on disk itself. `entries` is the session seed.
function runThin({ cwd, files, entries = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_POC_SCENARIO: "thin", PI_WORK_ENGINE: "thin", PI_SIDECAR_SESSION: "1", PI_SIDECAR_CWD: cwd,
        PI_SIDECAR_CAPS: "exec", PI_SIDECAR_THIN_SHELL: "/bin/sh", THIN_TEST_KEY: MARKER } });
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 20000);
    let buffer = "";
    const seen = [];
    child.stderr.resume();
    const answer = (frame, body) => child.stdin.write(`${JSON.stringify({ id: frame.id, ...body })}\n`);
    child.stdout.on("data", (data) => {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        seen.push(line);
        const frame = JSON.parse(line);
        if (frame.type === "agent_done") child.stdin.end();
        if (frame.type !== "tool_call") continue;
        const { name, args } = frame;
        if (name === "hub_exec") { answer(frame, { type: "tool_result", content: [{ type: "text", text: "{}" }], details: { exitCode: 0, timedOut: false, stdout: "thin\n", stderr: "" } }); continue; }
        const inside = typeof args.path === "string" && isAbsolute(args.path) && args.path.toLowerCase().startsWith(cwd.toLowerCase());
        if (!inside) { answer(frame, { type: "tool_error", message: "path_not_allowed" }); continue; }
        const rel = args.path.slice(cwd.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
        const ok = (details) => answer(frame, { type: "tool_result", content: [{ type: "text", text: "ok" }], details });
        if (name === "hub_fs_write") { if (args.op === "write") files.set(rel, args.content); ok({ path: rel }); continue; }
        if (args.op === "read") { files.has(rel) ? ok({ content: files.get(rel) }) : answer(frame, { type: "tool_error", message: "path_unavailable" }); continue; }
        if (args.op === "access" || args.op === "stat") { ok({ exists: true, directory: rel === "" || rel === "sub" }); continue; }
        if (args.op === "exists") { ok({ exists: rel === "" || files.has(rel) || rel === "sub" }); continue; }
        if (args.op === "readdir") { ok({ entries: rel === "" ? ["sub"] : [] }); continue; }
        answer(frame, { type: "tool_error", message: "invalid_action" });
      }
    });
    child.on("close", () => { clearTimeout(timer); resolve(seen.map((line) => JSON.parse(line))); });
    child.stdin.write(`${JSON.stringify({ type: "session", entries })}\n`);
  });
}

const finalText = (frames) => frames
  .filter((frame) => frame.type === "event" && frame.event.type === "message_end" && frame.event.message?.role === "assistant")
  .at(-1).event.message.content.map((block) => block.text ?? "").join("");

// The thin engine runs Pi's native tools, but none of them touch the disk or spawn a
// process themselves: every operation reaches Hub as hub_fs / hub_fs_write / hub_exec
// with the absolute path Pi resolved, and Hub (agent_native.rs) decides. The test plays
// Hub: it refuses the escape, accepts the rest, and performs nothing on disk itself.
test("thin engine: native tools route every file and shell operation through Hub", async () => {
  const parent = await mkdtemp(join(tmpdir(), "hub-thin-"));
  const cwd = join(parent, "ws");
  await mkdir(cwd);
  await writeFile(join(parent, "outside.txt"), "OUTSIDE-SECRET");
  const files = new Map();
  try {
    const parsed = await runThin({ cwd, files });
    const hello = parsed.find((frame) => frame.type === "hello");
    assert.deepEqual([...hello.activeTools].sort(), ["bash", "edit", "hub_search", "ls", "read", "write"]);
    const calls = parsed.filter((frame) => frame.type === "tool_call");
    assert.ok(calls.length >= 5);
    assert.ok(calls.every((call) => ["hub_fs", "hub_fs_write", "hub_exec"].includes(call.name)), calls.map((call) => call.name).join());
    const escape = calls.find((call) => call.name === "hub_fs" && call.args.path.endsWith("outside.txt"));
    assert.ok(escape && isAbsolute(escape.args.path), "Pi's resolved path goes to Hub, which refuses it");
    const exec = calls.find((call) => call.name === "hub_exec");
    assert.deepEqual(exec.args, { program: "/bin/sh", args: ["-c", "echo thin"] });
    assert.equal(files.get("sub/new.txt"), "hello thin\n", "edit = Hub read + Hub write");
    assert.ok(!existsSync(join(cwd, "sub")), "the sidecar wrote nothing itself");
    const text = parsed.map((frame) => JSON.stringify(frame)).join("\n");
    assert.ok(!text.includes("OUTSIDE-SECRET"), "the outside file was never read");
    assert.ok(!text.includes(MARKER), "the engine environment never reaches Hub's command or any frame");
    assert.match(finalText(parsed), /thin done read:error,write:ok,edit:ok,bash:ok,ls:ok/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// Resume (2026-10-18): every checkpoint names the thin engine in its header, one is saved right
// before each native write or command (already holding the request), and a seed that ends on an
// unanswered write resumes with an explicit unknown outcome instead of re-running or trusting it.
test("thin engine: checkpoints before side effects and resumes a crashed write as an unknown outcome", async () => {
  const parent = await mkdtemp(join(tmpdir(), "hub-thin-resume-"));
  const cwd = join(parent, "ws");
  await mkdir(cwd);
  try {
    const first = await runThin({ cwd, files: new Map() });
    const checkpoints = first.filter((frame) => frame.type === "checkpoint");
    assert.ok(checkpoints.length > 0);
    assert.ok(checkpoints.every((frame) => frame.entries?.[0]?.type === "session" && frame.entries[0].hubEngine === "thin"));
    const firstWrite = first.findIndex((frame) => frame.type === "tool_call" && frame.name === "hub_fs_write");
    const before = first.slice(0, firstWrite).findLast((frame) => frame.type === "checkpoint");
    assert.ok(before, "a checkpoint precedes the first native write");
    const requested = before.entries.findLast((entry) => entry.message?.role === "assistant");
    assert.equal(requested.message.content.find((block) => block.type === "toolCall")?.name, "write", "it already holds the write request");
    assert.ok(!JSON.stringify(checkpoints).includes(MARKER));

    // Crash right after that checkpoint: the write's result was never recorded.
    const files = new Map();
    const resumed = await runThin({ cwd, files, entries: before.entries });
    const text = finalText(resumed);
    assert.match(text, /thin done read:error,write:error,edit:error,bash:ok,ls:ok/);
    assert.match(text, /outcome unknown: the app stopped/);
    assert.ok(!files.has("sub/new.txt"), "the interrupted write was not re-executed");
    const saved = resumed.filter((frame) => frame.type === "checkpoint").at(-1).entries;
    assert.equal(saved[0].hubEngine, "thin");
    const unknown = saved.find((entry) => entry.message?.details?.outcome === "unknown");
    assert.equal(unknown.message.toolName, "write");
    assert.ok(!JSON.stringify(unknown).includes("hub_read"), "the thin model is pointed at its own read tool");

    // A completed thin conversation resumes as is: no earlier tool runs again.
    const last = checkpoints.at(-1).entries;
    const again = await runThin({ cwd, files: new Map(), entries: last });
    assert.equal(again.filter((frame) => frame.type === "tool_call").length, 0);
    assert.match(finalText(again), /thin done read:error,write:ok,edit:ok,bash:ok,ls:ok/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("bash is offered only with a known shell", () => {
  assert.equal(thinShell({ PI_SIDECAR_THIN_SHELL: "/x/sh" }), "/x/sh");
  assert.equal(thinShell({}, "win32", () => false), null);
  assert.equal(thinShell({}, "win32", (path) => path.startsWith("C:\\Program Files\\Git")), "C:\\Program Files\\Git\\bin\\bash.exe");
});
