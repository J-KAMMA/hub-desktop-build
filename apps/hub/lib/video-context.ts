export const VIDEO_PURPOSES = [
  "guide",
  "explanation",
  "live",
  "review",
  "creation",
  "music",
  "other"
] as const;

export type VideoPurpose = (typeof VIDEO_PURPOSES)[number];

export interface VideoContextInput {
  purpose: VideoPurpose;
  topic: string;
  relatedHubpediaSlug?: string;
}

export class InvalidVideoContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVideoContextError";
  }
}

const HUBPEDIA_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requiredTopic(value: unknown): string {
  if (typeof value !== "string") throw new InvalidVideoContextError("topic is required.");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new InvalidVideoContextError("topic is required.");
  if (normalized.length > 80) throw new InvalidVideoContextError("topic is too long.");
  if (/\p{Cc}/u.test(normalized)) throw new InvalidVideoContextError("topic contains invalid characters.");
  return normalized;
}

function optionalHubpediaSlug(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 160 || !HUBPEDIA_SLUG_PATTERN.test(value)) {
    throw new InvalidVideoContextError("relatedHubpediaSlug must be a lowercase Hubpedia slug.");
  }
  return value;
}

export function parseVideoContextInput(input: unknown): VideoContextInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidVideoContextError("JSON body is required.");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.purpose !== "string" || !VIDEO_PURPOSES.includes(record.purpose as VideoPurpose)) {
    throw new InvalidVideoContextError("purpose is invalid.");
  }
  return {
    purpose: record.purpose as VideoPurpose,
    topic: requiredTopic(record.topic),
    relatedHubpediaSlug: optionalHubpediaSlug(record.relatedHubpediaSlug)
  };
}
