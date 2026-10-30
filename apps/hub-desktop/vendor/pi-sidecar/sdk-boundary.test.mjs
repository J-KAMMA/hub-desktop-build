import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("./pi-sidecar.mjs", import.meta.url));
// The thin engine's tools: Pi's native read/edit/write/ls, which do their IO only through
// Hub (hub_fs / hub_fs_write), plus hub_search. No bash without exec, no grep/find.
const HUB_TOOLS = new Set(["read", "edit", "write", "ls", "hub_search"]);

// Pi 1.x ships built-in extensions (codemode, tool_search, MCP, llama.cpp) and project
// settings/MCP files. None may load or add tools inside Hub's SDK session.
test("the SDK session offers only Hub tools even with project Pi settings, MCP and extensions present", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hub-sdk-boundary-"));
  try {
    await writeFile(join(cwd, "notes.txt"), "answer=41\n");
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["+codemode", "+bash"], extensions: ["builtin:mcp"] }));
    await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { trap: { command: "node", args: ["-e", "require('fs').writeFileSync('mcp-started','x')"] } } }));
    await writeFile(join(cwd, ".pi", "extensions", "trap.ts"), "import{writeFileSync}from'node:fs';export default()=>writeFileSync('extension-executed','x');");
    await writeFile(join(cwd, "mcp.json"), JSON.stringify({ mcpServers: { trap: { command: "node", args: ["-e", "1"] } } }));
    const frames = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bundle], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PI_SIDECAR_SESSION: "1", PI_WORK_ENGINE: "thin", PI_POC_SCENARIO: "review", PI_SIDECAR_CWD: cwd, PI_SIDECAR_CAPS: "" } });
      let out = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 20000);
      let seen = 0;
      child.stdout.on("data", (data) => {
        out += data;
        const lines = out.split("\n").slice(0, -1);
        for (const line of lines.slice(seen)) {
          const frame = JSON.parse(line);
          if (frame.type === "tool_call") child.stdin.write(`${JSON.stringify({ type: "tool_error", id: frame.id, message: "fixture_refused" })}\n`);
          if (frame.type === "agent_done") child.stdin.end();
        }
        seen = lines.length;
      });
      child.on("close", () => { clearTimeout(timer); resolve(out.split("\n").filter(Boolean).map((line) => JSON.parse(line))); });
      child.stdin.write(`${JSON.stringify({ type: "session", entries: [] })}\n`);
    });
    const hello = frames.find((frame) => frame.type === "hello");
    assert.ok(hello, "hello frame");
    assert.deepEqual(hello.activeTools.filter((name) => !HUB_TOOLS.has(name)), [], `unexpected tools: ${hello.activeTools}`);
    for (const name of ["codemode", "tool_search", "bash", "grep", "find", "mcp"]) assert.ok(!hello.activeTools.includes(name), name);
    // Whatever the fixture asked for, nothing touched the disk except through Hub (which refused).
    assert.ok(frames.filter((frame) => frame.type === "tool_call").every((frame) => ["hub_fs", "hub_fs_write", "hub_search"].includes(frame.name)));
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(join(cwd, "extension-executed")) && !existsSync(join(cwd, "mcp-started")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
