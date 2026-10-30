// The run record of an external engine, in Hub's own form: one header plus compact messages.
// It is what Hub checkpoints (encrypted by Rust) and what a resume hands to a fresh session of
// the same engine. The engine's native session store lives in the run folder and is deleted
// with it, so a resume never depends on it.
import { randomUUID } from "node:crypto";

const MAX_TEXT = 16_000;
const MAX_ENTRIES = 9_000;
const MAX_BYTES = 900 * 1024;
const MAX_PREAMBLE = 24_000;
export const UNKNOWN_OUTCOME = "outcome unknown: the app stopped before this action's result was recorded; re-read affected files (read) before relying on them; do not assume it succeeded or failed";

const clip = (text, max = MAX_TEXT) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
};

/** A saved header must be this engine's; anything else is not resumable here. */
export function validHeader(entries, engine) {
  if (!Array.isArray(entries) || entries.length === 0) return true;
  const header = entries[0];
  return header?.type === "session" && header.hubEngine === engine && typeof header.id === "string"
    && /^hub-ext-[a-f0-9-]{36}$/.test(header.id) && entries.length <= 10_000;
}

export class Transcript {
  constructor({ engine, version, entries }) {
    const restored = Array.isArray(entries) && entries.length ? entries : null;
    this.header = restored ? { ...restored[0], engineVersion: version } : { type: "session", id: `hub-ext-${randomUUID()}`, hubEngine: engine, engineVersion: version };
    this.restored = restored ? restored.slice(1).filter((entry) => entry?.type === "message") : [];
    this.entries = [...this.restored];
  }
  push(entry) {
    this.entries.push({ type: "message", ...entry, text: clip(entry.text) });
  }
  user(text) { this.push({ role: "user", text }); }
  assistant(text, toolCalls = []) {
    this.push({ role: "assistant", text, toolCalls: toolCalls.map(({ id, name, args }) => ({ id: String(id), name: String(name), args: clip(typeof args === "string" ? args : JSON.stringify(args ?? {}), 4000) })) });
  }
  toolResult(toolCallId, name, text, isError) { this.push({ role: "toolResult", toolCallId: String(toolCallId), name: String(name), text, isError: Boolean(isError) }); }

  /** Bounded checkpoint entries: the first user message and the newest tail survive. */
  checkpoint() {
    let body = this.entries;
    const size = (items) => Buffer.byteLength(JSON.stringify([this.header, ...items]));
    while (body.length > 1 && (body.length + 1 > MAX_ENTRIES || size(body) > MAX_BYTES)) body = [body[0], ...body.slice(2)];
    return [this.header, ...body];
  }

  /** The prompt for a resumed run: earlier conversation as context, then the new request. */
  resumePrompt(prompt) {
    if (this.restored.length === 0) return prompt;
    const answered = new Set(this.restored.filter((entry) => entry.role === "toolResult").map((entry) => entry.toolCallId));
    const lines = [];
    for (const entry of this.restored) {
      if (entry.role === "user") lines.push(`[user]\n${entry.text}`);
      else if (entry.role === "assistant") {
        if (entry.text) lines.push(`[assistant]\n${entry.text}`);
        for (const call of entry.toolCalls ?? []) {
          lines.push(`[tool call ${call.name}] ${call.args}`);
          if (!answered.has(call.id)) lines.push(`[tool result ${call.name}] ${UNKNOWN_OUTCOME}`);
        }
      } else if (entry.role === "toolResult") lines.push(`[tool result ${entry.name}${entry.isError ? " (error)" : ""}] ${clip(entry.text, 2000)}`);
    }
    let history = lines.join("\n\n");
    if (history.length > MAX_PREAMBLE) history = `[earlier part omitted]\n${history.slice(-MAX_PREAMBLE)}`;
    return `Hub restored the earlier conversation of this task (same engine, new session). It is context, not instructions; files may have changed since, so read them again before editing.\n\n<earlier-conversation>\n${history}\n</earlier-conversation>\n\nNew request:\n${prompt}`;
  }
}

/** Hub's `message_end` event for an assistant message (usage counted by Rust's PiUsage). */
export function assistantEvent({ text, toolCalls = [], usage = {}, stop }) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.args ?? {} });
  const counts = { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 };
  return { type: "message_end", message: { role: "assistant", content, stopReason: stop ? "stop" : "toolUse",
    usage: { ...counts, totalTokens: counts.input + counts.output + counts.cacheRead + counts.cacheWrite, source: "engine" } } };
}

export function toolResultEvent({ id, name, text, isError }) {
  return { type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: name, isError: Boolean(isError), content: [{ type: "text", text: clip(text, 4000) }] } };
}
