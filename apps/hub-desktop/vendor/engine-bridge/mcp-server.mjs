// Hub's tools as a Streamable HTTP MCP server for one external-engine run
// (docs/hub-harness-swap/PLAN.md, type B). Loopback only, one random bearer token per run,
// JSON responses only (no server-initiated stream), bounded request size. Every `tools/call`
// goes to `call(name, args)`, which forwards it to Hub's Rust executor; this file decides
// nothing about permissions.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

const MAX_BODY = 8 * 1024 * 1024;
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function sameToken(presented, token) {
  const a = Buffer.from(String(presented ?? ""));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startMcpServer({ tools, call, onUnknownTool }) {
  const token = randomBytes(32).toString("hex");
  const names = new Set(tools.map((tool) => tool.name));
  const listed = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  async function handle(message) {
    const { id, method, params } = message ?? {};
    if (typeof method !== "string") return id === undefined ? null : { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
    if (id === undefined || id === null) return null; // notification
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return ok({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "hub", version: "1.0.0" },
          instructions: "Hub tools. Paths are relative to the workspace root." });
      }
      case "ping": return ok({});
      case "tools/list": return ok({ tools: listed });
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string" || !names.has(name)) {
          onUnknownTool?.(String(name));
          return ok({ content: [{ type: "text", text: `unknown_tool: ${String(name).slice(0, 80)} is not a Hub tool` }], isError: true });
        }
        try {
          const result = await call(name, params?.arguments ?? {});
          return ok({ content: result.content, ...(result.isError ? { isError: true } : {}) });
        } catch (error) {
          return ok({ content: [{ type: "text", text: String(error?.message ?? error).slice(0, 4000) }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  }
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    if (!req.socket.remoteAddress?.match(/^(127\.|::1$|::ffff:127\.)/) || !sameToken(auth.replace(/^Bearer /, ""), token)) {
      res.writeHead(401).end();
      req.resume();
      return;
    }
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); req.resume(); return; }
    const parts = [];
    let size = 0;
    req.on("data", (part) => {
      size += part.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      parts.push(part);
    });
    req.on("end", async () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch {
        res.writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }
      const batch = Array.isArray(body);
      const replies = (await Promise.all((batch ? body : [body]).map(handle))).filter(Boolean);
      if (replies.length === 0) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(batch ? replies : replies[0]));
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    token,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
