// Scripted OpenAI-compatible chat-completions model for the external-engine conformance and
// escape suite (docs/hub-harness-swap/PLAN.md, "抜け道試験"). It listens on 127.0.0.1 only,
// streams SSE like a real provider, and records every request body so the suite can check what
// the engine sent (instruction-file markers, keys, offered tool names).
//
// A scenario is a list of steps. Step i answers the request that already carries i tool results
// since the last user message; a step is {tool, args} (tool: exact name, or {suffix} to pick the
// offered tool whose name ends with it), {text} for a final answer, or {stall: ms} to hold the
// stream open (cancel test).
import { createServer } from "node:http";

export function pickTool(tools, want) {
  if (typeof want === "string") return want;
  const names = (tools ?? []).map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean);
  return names.find((name) => name === want.suffix || name.endsWith(`_${want.suffix}`) || name.endsWith(`__${want.suffix}`))
    ?? want.fallback ?? want.suffix;
}

function stepIndex(messages) {
  let count = 0;
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") break;
    if (message.role === "tool") count++;
  }
  return count;
}

const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({
  id: "fake", object: "chat.completion.chunk", created: 1, model: "fake-model",
  choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;

export async function startFakeModel({ scenario, onRequest } = {}) {
  const requests = [];
  let calls = 0;
  const server = createServer((req, res) => {
    const parts = [];
    req.on("data", (part) => parts.push(part));
    req.on("end", async () => {
      const raw = Buffer.concat(parts).toString("utf8");
      let body = {};
      try { body = JSON.parse(raw); } catch { /* recorded raw */ }
      requests.push({ path: req.url, headers: req.headers, raw });
      await onRequest?.({ body, raw, headers: req.headers });
      if (req.method !== "POST" || !/\/chat\/completions$/.test(req.url ?? "")) {
        res.writeHead(404).end();
        return;
      }
      const steps = typeof scenario === "function" ? scenario(body) : scenario;
      const index = stepIndex(body.messages);
      const step = steps[Math.min(index, steps.length - 1)] ?? { text: "done" };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(chunk({ role: "assistant", content: "" }));
      if (step.stall) {
        const timer = setTimeout(() => res.end(), step.stall);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      const usage = { prompt_tokens: 100 + index, completion_tokens: 10, total_tokens: 110 + index };
      if (step.tool) {
        const name = pickTool(body.tools, step.tool);
        res.write(chunk({ tool_calls: [{ index: 0, id: `call_${++calls}`, type: "function",
          function: { name, arguments: JSON.stringify(step.args ?? {}) } }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ content: step.text ?? "done" }));
        res.write(chunk({}, "stop"));
      }
      res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
