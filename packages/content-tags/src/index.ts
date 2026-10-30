/**
 * Shared tag normaliser for every Hub surface (posts, threads, articles, videos, music, market).
 * Pure functions, no dependencies, MIT licensed. Must not import code from apps/*.
 *
 * A tag has a display form (what the author typed, cleaned) and a key (case-folded; the only
 * value used for matching, storage lookups and URLs).
 */

export const TAG_MAX_PER_ITEM = 8;
export const TAG_MAX_LENGTH = 32;

export interface NormalizedTag {
  /** Case-folded matching key. Idempotent: normalizeTag(key).key === key. */
  key: string;
  /** Cleaned form with the author's letter case kept. */
  display: string;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Invisible format characters, except ZWJ (U+200D) which emoji sequences need.
const INVISIBLE_FORMAT = /(?!‍)\p{Cf}/gu;
const SEPARATORS = /[\s,、，]+/u;
const FORBIDDEN_INSIDE = /[#,、，]/u;
const WHITESPACE = /\s/u;
const CONTROL = /\p{Cc}/u;

function stripStrayJoiners(s: string): string {
  // ZWJ stays only between visible characters; doubled or edge ZWJ is noise.
  return s.replace(/‍{2,}/g, "‍").replace(/^‍+|‍+$/g, "");
}

/** Full Unicode case folding approximation: upper then lower maps ss/sigma/etc. consistently. */
function foldCase(s: string): string {
  return s.toUpperCase().toLowerCase().normalize("NFKC");
}

/** Returns the normalised tag, or null when the input is not a valid tag. */
export function normalizeTag(raw: unknown): NormalizedTag | null {
  if (typeof raw !== "string") return null;
  if (LONE_SURROGATE.test(raw)) return null;
  let s = raw.normalize("NFKC").replace(INVISIBLE_FORMAT, "");
  s = s.trim().replace(/^#+/, "").trim();
  s = stripStrayJoiners(s);
  if (!s) return null;
  if (CONTROL.test(s) || WHITESPACE.test(s) || FORBIDDEN_INSIDE.test(s)) return null;
  if (Array.from(s).length > TAG_MAX_LENGTH) return null;
  return { key: foldCase(s), display: s };
}

/** Key only, or null. */
export function tagKey(raw: unknown): string | null {
  return normalizeTag(raw)?.key ?? null;
}

/**
 * Split free text into raw tag candidates. Separators: whitespace, ',', '、', '，'.
 * The middle dot U+30FB is part of a tag. Candidates are not validated here.
 */
export function splitTagInput(text: string): string[] {
  if (typeof text !== "string") return [];
  return text
    .normalize("NFKC")
    .split(SEPARATORS)
    .filter((part) => part.length > 0);
}

/**
 * Normalise a list (or free text) into unique tags: dedupe by key, first display form wins,
 * invalid entries dropped, at most `max` kept (default 8).
 */
export function normalizeTagList(
  input: string | readonly unknown[],
  max: number = TAG_MAX_PER_ITEM,
): NormalizedTag[] {
  const parts: string[] = [];
  if (typeof input === "string") parts.push(...splitTagInput(input));
  else for (const item of input) if (typeof item === "string") parts.push(...splitTagInput(item));
  const seen = new Set<string>();
  const out: NormalizedTag[] = [];
  for (const part of parts) {
    if (out.length >= max) break;
    const tag = normalizeTag(part);
    if (!tag || seen.has(tag.key)) continue;
    seen.add(tag.key);
    out.push(tag);
  }
  return out;
}

/** URL path segment for /v2/tag/[key]. Dots are encoded so "." and ".." never form path segments. */
export function tagSlug(raw: unknown): string | null {
  const key = tagKey(raw);
  if (!key) return null;
  return encodeURIComponent(key).replace(/\./g, "%2E");
}

/** Inverse of tagSlug for a route parameter (encoded or already decoded). Returns the key, or null. */
export function tagKeyFromSlug(slug: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    return null;
  }
  return tagKey(decoded);
}
