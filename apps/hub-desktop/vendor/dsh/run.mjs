import { createDshSession } from "./hub-runtime.mjs";
import { PiRuntimeAdapter } from "./pi-adapter.mjs";
import { randomUUID } from "node:crypto";
import { hasFinalAnswer, verifyWork } from "../pi-sidecar/verification.mjs";

export async function runDsh({ model, runtime, tools, systemPrompt, prompt, review, verify, send, progress, entries, generation }) {
  const header = entries?.length ? entries[0] : { type: "dsh-session", version: 1, id: `hub-${randomUUID()}` };
  if (header.type !== "dsh-session" || header.version !== 1 || typeof header.id !== "string" || !/^hub-[a-zA-Z0-9-]{1,80}$/.test(header.id)) {
    throw new Error("dsh_session_invalid");
  }
  let reason, session, lastMessage;
  const adapter = new PiRuntimeAdapter(model, runtime, (message) => {
    lastMessage = message;
    send({ type: "event", event: { type: "message_end", message } });
  }, (text) => send({ type: "partial", text }), header.id);
  session = await createDshSession({ model, adapter, tools, systemPrompt, generation,
    sessionId: header.id, seed: entries?.length ? entries.slice(1) : undefined,
    onEvent: (event, nativeSession) => {
    if (event.type === "turn/end") {
      reason = event.data.reason;
      // Only balanced turns can seed a new agent. The SDK validates sequence,
      // message replay state and pending tools again before accepting the seed.
      const saved = [header, ...nativeSession.snapshotEvents()];
      send({ type: "checkpoint", entries: saved.length <= 10000 && Buffer.byteLength(JSON.stringify(saved)) <= 1024 * 1024 ? saved : null });
    }
    if (event.type === "tool/result" && progress.reason) session.abort();
  } });
  try {
    send({ type: "event", event: { type: "agent_start" } });
    await session.prompt(prompt);
    const complete = () => !progress.reason && reason?.kind === "completed" && hasFinalAnswer(lastMessage);
    // review() answers null when Hub's own results make the review redundant.
    const reviewText = review && !verify && complete() ? review() : null;
    if (reviewText) {
      send({ type: "event", event: { type: "agent_start" } });
      await session.prompt(reviewText);
    }
    const ok = verify ? await verifyWork({ check: verify, repair: (feedback) => session.prompt(feedback), complete, prompt }) : complete();
    if (lastMessage?.stopReason === "stop" && !hasFinalAnswer(lastMessage)) throw new Error("final_response_missing: model ended without a final text answer");
    return ok;
  } finally { await session.dispose(); }
}
