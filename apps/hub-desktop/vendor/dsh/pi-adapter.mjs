import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "../pi-sidecar/workspace/node_modules/@earendil-works/pi-ai/dist/models.js";

const REQUEST_FIELDS = new Set(["provider", "model", "messages", "tools", "signal", "sessionId", "reasoningEffort", "temperature", "maxTokens", "stop", "system", "purpose"]);
const efforts = (model) => getSupportedThinkingLevels(model).filter((level) => level !== "off");

function requestOptions(model, request, sessionId) {
  const invalid = () => { throw new Error("dsh_request_settings_invalid"); };
  if (!request || typeof request !== "object" || Array.isArray(request) || Reflect.ownKeys(request).some((key) => !REQUEST_FIELDS.has(key))) invalid();
  if (request.provider !== model.provider || request.model !== model.id) throw new Error("model_route_mismatch");
  if (["stop", "system", "purpose"].some((key) => request[key] !== undefined)) throw new Error("dsh_request_settings_unsupported");
  if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) throw new Error("dsh_model_limits_invalid");
  const maxTokens = request.maxTokens === undefined ? model.maxTokens : request.maxTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > model.maxTokens) invalid();
  // Hub's integration range, not a guarantee of every provider's sampling policy.
  if (request.temperature !== undefined && (typeof request.temperature !== "number" || !Number.isFinite(request.temperature)
    || request.temperature < 0 || request.temperature > 2)) invalid();
  if (request.temperature !== undefined && model.compat?.supportsTemperature === false) throw new Error("dsh_request_settings_unsupported");
  if (request.reasoningEffort !== undefined && (typeof request.reasoningEffort !== "string" || !efforts(model).includes(request.reasoningEffort))) invalid();
  if (request.signal !== undefined && !(request.signal instanceof AbortSignal) || request.sessionId !== undefined && typeof request.sessionId !== "string") invalid();
  return { signal: request.signal, maxTokens, sessionId,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.reasoningEffort === undefined ? {} : { reasoning: request.reasoningEffort }) };
}

// SDK responses can contain unset optional object fields. JSON has no such
// fields; omit only those, preserving invalid array entries/numbers so DSH's
// lossless JSON validator still rejects them instead of silently changing data.
function replayValue(value) {
  if (Array.isArray(value)) return value.map(replayValue);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, replayValue(item)]));
  }
  return value;
}

// Keep provider routing and credentials in the same Pi ModelRuntime used by
// Hub's Pi engine. Preserve each native assistant response for exact replay.
export class PiRuntimeAdapter extends LlmAdapter {
  constructor(model, runtime, onMessage, onDelta, sessionId = randomUUID()) {
    super();
    this.model = model;
    this.runtime = runtime;
    this.onMessage = onMessage;
    this.onDelta = onDelta;
    this.toolNames = new Map();
    this.sessionId = sessionId;
  }

  async resolveModel(provider, id) {
    if (provider !== this.model.provider || id !== this.model.id) throw new Error("model_route_mismatch");
    const available = efforts(this.model);
    return { provider, id, name: this.model.name || id, context: { contextWindow: this.model.contextWindow },
      ...(available.length ? { reasoning: { efforts: available.map((id) => ({ id, name: id })) } } : {}) };
  }

  async *stream(request) {
    const options = requestOptions(this.model, request, this.sessionId);
    const messages = request.messages.filter((message) => message.role !== "system").map((message) => {
      if (message.role === "assistant") {
        const native = message.source.replayState?.response?.pi;
        if (!native) throw new Error("dsh_native_replay_unavailable");
        for (const block of native.content) {
          if (block.type === "toolCall") this.toolNames.set(block.id, block.name);
        }
        return native;
      }
      if (message.source.kind === "tool") {
        const result = message.content[0];
        return { role: "toolResult", toolCallId: result.toolCallId, toolName: this.toolNames.get(result.toolCallId),
          content: result.content, isError: result.isError ?? false, timestamp: 0 };
      }
      return { role: "user", content: message.content, timestamp: 0 };
    });
    const systemPrompt = request.messages.filter((message) => message.role === "system")
      .flatMap((message) => message.content.map((block) => block.text ?? "")).join("\n");
    const stream = this.runtime.streamSimple(this.model, { systemPrompt, messages, tools: request.tools }, options);
    const emitted = new Set();
    for await (const event of stream) {
      if (["text_delta", "thinking_delta"].includes(event.type)) this.onDelta?.(event.delta);
      if (event.type === "text_delta") yield { type: "text-delta", index: event.contentIndex, text: event.delta };
      if (event.type === "thinking_delta") yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
      if (event.type.endsWith("_start")) {
        const blockType = { text_start: "text", thinking_start: "reasoning", toolcall_start: "tool-call" }[event.type];
        if (blockType) yield { type: "block-start", index: event.contentIndex, blockType };
      }
      if (event.type === "toolcall_delta") {
        const call = event.partial.content[event.contentIndex];
        yield { type: "tool-call-delta", index: event.contentIndex, id: call.id, name: call.name, argumentsDelta: event.delta };
      }
      if (event.type.endsWith("_end")) {
        let block;
        if (event.type === "text_end") block = { type: "text", text: event.content };
        if (event.type === "thinking_end") block = { type: "reasoning", text: event.content };
        if (event.type === "toolcall_end") {
          const call = event.toolCall;
          this.toolNames.set(call.id, call.name);
          block = { type: "tool-call", id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) };
        }
        if (block) {
          emitted.add(event.contentIndex);
          yield { type: "block-end", index: event.contentIndex, block };
        }
      }
    }
    const answer = await stream.result();
    for (const [index, native] of answer.content.entries()) {
      if (emitted.has(index)) continue;
      const block = native.type === "toolCall"
        ? { type: "tool-call", id: native.id, name: native.name, arguments: JSON.stringify(native.arguments) }
        : native.type === "thinking" ? { type: "reasoning", text: native.thinking }
        : native.type === "text" ? { type: "text", text: native.text } : null;
      if (!block) throw new Error("unsupported_dsh_output_block");
      if (native.type === "toolCall") this.toolNames.set(native.id, native.name);
      yield { type: "block-start", index, blockType: block.type };
      yield { type: "block-end", index, block };
    }
    this.onMessage?.(answer);
    const usage = answer.usage;
    yield { type: "usage", usage: { inputTokens: usage.input, outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite } };
    const kind = { stop: "stop", toolUse: "tool-calls", length: "max-tokens", aborted: "aborted", error: "error" }[answer.stopReason] ?? "error";
    yield { type: "finish", reason: ["error", "aborted"].includes(kind)
      ? { kind, failure: { code: "provider_failure", message: answer.errorMessage || kind } } : { kind },
      replayState: { response: { pi: replayValue(answer) } } };
  }
}
