// Pi and thin (2026-10-18) pure policy for "checkpoint before side effects". The sidecar saves
// a checkpoint right before it sends a side-effecting tool_call frame, so the
// saved conversation already contains the assistant message that asked for
// the action. If the app dies before the result is recorded, the restored
// history ends with a toolCall that has no toolResult; repairDanglingToolCalls
// closes it with an explicit error so the model never assumes the outcome.

// Hub tools whose execution can change files, run commands, send requests or
// propose a purchase. Reads, searches, listings and the state-only todo are not.
// `hub_fs_write` is the thin engine's native write/edit/mkdir (2026-10-18); its `hub_fs` reads are not.
export const SIDE_EFFECT_TOOLS = Object.freeze(new Set(["hub_write", "hub_edit", "hub_exec", "hub_test", "hub_http", "hub_pay", "hub_fs_write"]));
export const isSideEffectTool = (name) => typeof name === "string" && SIDE_EFFECT_TOOLS.has(name);

export const UNKNOWN_OUTCOME_TEXT = "outcome unknown: the app stopped before this action's result was recorded; re-read affected files (hub_read) before relying on them; do not assume it succeeded or failed";
// The thin engine has no hub_read; its model reads with Pi's native `read`.
export const THIN_UNKNOWN_OUTCOME_TEXT = "outcome unknown: the app stopped before this action's result was recorded; re-read affected files (read) before relying on them; do not assume it succeeded or failed";

// Calls in a message that never ran (provider error, abort) or were failed by the
// loop itself (length) are not dangling; transform-messages drops or the loop closed them.
const executed = (message) => !["error", "aborted", "length"].includes(message.stopReason);

/**
 * Returns entries with a synthesized error toolResult entry directly after every
 * assistant message entry whose toolCall has no toolResult anywhere in the tree.
 * The original array and entries are not mutated; the input is returned when
 * nothing is dangling. The entry after the assistant (its former child) is relinked
 * under the last synthesized entry so the chain stays linear.
 */
export function repairDanglingToolCalls(entries, now = Date.now(), text = UNKNOWN_OUTCOME_TEXT) {
  if (!Array.isArray(entries)) return entries;
  const answered = new Set(), used = new Set();
  for (const entry of entries) {
    if (typeof entry?.id === "string") used.add(entry.id);
    if (entry?.type === "message" && entry.message?.role === "toolResult") answered.add(entry.message.toolCallId);
  }
  const fresh = (base) => { let id = base, n = 0; while (used.has(id)) id = `${base}${++n}`; used.add(id); return id; };
  const out = [], tails = new Map(), synthesized = new Set(); // assistant entry id -> last synthesized id
  let repaired = false;
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : undefined;
    out.push(entry);
    if (message?.role !== "assistant" || !Array.isArray(message.content) || !executed(message)) continue;
    let tail = entry.id;
    for (const call of message.content) {
      if (call?.type !== "toolCall" || typeof call.id !== "string" || answered.has(call.id)) continue;
      answered.add(call.id);
      const id = fresh(`unk${out.length}`);
      synthesized.add(id);
      out.push({ type: "message", id, parentId: tail, timestamp: new Date(now).toISOString(), message: {
        role: "toolResult", toolCallId: call.id, toolName: String(call.name ?? "unknown"), isError: true, timestamp: now,
        content: [{ type: "text", text }], details: { outcome: "unknown" },
      } });
      tail = id; repaired = true;
    }
    if (tail !== entry.id) tails.set(entry.id, tail);
  }
  if (!repaired) return entries;
  return out.map((entry) => !synthesized.has(entry.id) && tails.has(entry?.parentId) ? { ...entry, parentId: tails.get(entry.parentId) } : entry);
}
