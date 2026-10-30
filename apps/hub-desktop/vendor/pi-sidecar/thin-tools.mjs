// Thin engine: Pi's own native tools (read, edit, write, ls and, with exec, bash) with
// Pi's schemas, prompt snippets and output formatting, but no IO of their own. Every
// filesystem operation they make becomes a Hub tool call (`hub_fs` / `hub_fs_write`) and
// every shell command an ordinary `hub_exec`, so Hub's executor (agent_native.rs,
// agent_exec.rs) enforces the workspace boundary, approvals, revisions and limits. Pi's
// grep and find are left out: they spawn ripgrep/fd, which Pi downloads when missing.
import { createBashToolDefinition, createEditToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { thinShell } from "./thin-shell.mjs";

// "command_failed: {json}" from hub_exec -> the report, or null.
function commandReport(message) {
  const text = String(message ?? "");
  const at = text.indexOf("command_failed: ");
  if (at < 0) return null;
  const body = text.slice(at + "command_failed: ".length).split("\n")[0];
  try { const report = JSON.parse(body); return report && typeof report === "object" ? report : null; } catch { return null; }
}

export function createThinTools({ cwd, callHub, caps = new Set(), extra = [], shell = thinShell() }) {
  const read = (op, path) => callHub("hub_fs", { op, path }, { track: false });
  const write = (op, path, content) => callHub("hub_fs_write", op === "write" ? { op, path, content } : { op, path }, { fromModel: true });
  const readFile = async (path) => Buffer.from((await read("read", path)).details?.content ?? "", "utf8");
  const access = async (path) => { await read("access", path); };
  const writeFile = async (path, content) => { await write("write", path, String(content)); };
  const tools = [
    createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType: async () => null } }),
    createEditToolDefinition(cwd, { operations: { readFile, writeFile, access } }),
    createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: async (dir) => { await write("mkdir", dir); } } }),
    createLsToolDefinition(cwd, { operations: {
      exists: async (path) => (await read("exists", path)).details?.exists === true,
      stat: async (path) => { const details = (await read("stat", path)).details ?? {}; return { isDirectory: () => details.directory === true }; },
      readdir: async (path) => (await read("readdir", path)).details?.entries ?? [],
    } }),
  ];
  if (caps.has("exec") && shell) {
    tools.push(createBashToolDefinition(cwd, { exposeSessionEnvironment: false, operations: {
      // Hub runs the command (argv: shell, "-c", command) after its own approval, in the
      // workspace with its curated environment; Pi's env and cwd are not passed through.
      exec: async (command, _cwd, { onData, signal, timeout }) => {
        const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? Math.min(600_000, Math.round(timeout * 1000)) : undefined;
        const args = { program: shell, args: ["-c", command], ...(timeoutMs ? { timeoutMs } : {}) };
        let report;
        try {
          report = (await callHub("hub_exec", args, { signal, fromModel: true })).details ?? {};
        } catch (error) {
          report = commandReport(error?.message);
          if (!report) throw error;
        }
        const output = [report.stdout, report.stderr].filter((part) => typeof part === "string" && part).join("\n");
        if (output) onData(Buffer.from(output, "utf8"));
        if (report.timedOut === true) throw new Error(`timeout:${timeout ?? Math.round((timeoutMs ?? 120_000) / 1000)}`);
        return { exitCode: typeof report.exitCode === "number" ? report.exitCode : null };
      },
    } }));
  }
  return [...tools, ...extra];
}
