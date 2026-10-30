import { getSupportedThinkingLevels } from "./workspace/node_modules/@earendil-works/pi-ai/dist/models.js";

const fields = ["temperature", "maxTokens", "reasoning"];
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const fail = (code) => { throw new Error(`comparison_generation_${code}`); };

// Only comparison sessions supply this closed DTO. Normal sessions omit it.
export function validateGeneration(input, model) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Reflect.ownKeys(input).length !== fields.length
    || fields.some(key => !Object.hasOwn(input, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), "value"))) fail("invalid");
  const { temperature, maxTokens, reasoning } = input;
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2
    || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192 || !levels.has(reasoning)) fail("invalid");
  // Reject URL-parser aliases, alternate ports, credentials, queries and fragments.
  if (!model || model.provider !== "ollama" || typeof model.baseUrl !== "string"
    || /[\u0000-\u0020\u007f]/.test(model.baseUrl)
    || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):11434(?:\/[^\\?#]*)?$/.test(model.baseUrl)) fail("unsupported");
  let base;
  try { base = new URL(model.baseUrl); } catch { fail("unsupported"); }
  if (base.protocol !== "http:" || base.port !== "11434" || base.username || base.password || base.search || base.hash
    || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
    || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < maxTokens
    || model.compat?.supportsTemperature === false || !getSupportedThinkingLevels(model).includes(reasoning)) fail("unsupported");
  // DSH's durable JSON request header cannot represent negative zero.
  return Object.freeze({ temperature: temperature === 0 ? 0 : temperature, maxTokens, reasoning });
}

// Applied at ModelRuntime entry; retain abort/session/header/payload options.
export function generationOptions(model, options, generation) {
  if (generation === undefined) return options;
  const checked = validateGeneration(generation, model);
  return { ...options, temperature: checked.temperature, maxTokens: checked.maxTokens,
    reasoning: checked.reasoning === "off" ? undefined : checked.reasoning };
}
