export type ExternalVideoProvider = "YouTube" | "Vimeo" | "Twitch" | "ニコニコ" | "TikTok" | "Dailymotion" | "PeerTube" | "Hub動画";
export type StoredExternalVideoProvider = "youtube" | "vimeo" | "twitch" | "niconico" | "tiktok" | "dailymotion" | "peertube" | "hub";

export interface NormalizedVideoSource {
  provider: ExternalVideoProvider;
  storedProvider: StoredExternalVideoProvider;
  externalVideoId: string;
  sourceUrl: string;
  thumbnailUrl?: string;
}

export class InvalidVideoSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVideoSourceError";
  }
}

const PROVIDER_LABELS: Record<StoredExternalVideoProvider, ExternalVideoProvider> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  twitch: "Twitch",
  niconico: "ニコニコ",
  tiktok: "TikTok",
  dailymotion: "Dailymotion",
  peertube: "PeerTube",
  hub: "Hub動画"
};

export function externalVideoProviderLabel(provider: StoredExternalVideoProvider): ExternalVideoProvider {
  return PROVIDER_LABELS[provider];
}

function requirePathSegment(pathname: string, index: number, pattern: RegExp, message: string): string {
  const value = pathname.split("/").filter(Boolean)[index] ?? "";
  if (!pattern.test(value)) throw new InvalidVideoSourceError(message);
  return value;
}

export function normalizeVideoSource(input: string): NormalizedVideoSource {
  if (typeof input !== "string" || input.length > 2048) {
    throw new InvalidVideoSourceError("sourceUrl is invalid.");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidVideoSourceError("sourceUrl must be a valid URL.");
  }

  if (url.protocol !== "https:") throw new InvalidVideoSourceError("sourceUrl must use HTTPS.");
  if (url.username || url.password) throw new InvalidVideoSourceError("sourceUrl must not contain credentials.");
  if (url.port) throw new InvalidVideoSourceError("sourceUrl must not use a custom port.");

  const host = url.hostname.toLocaleLowerCase("en-US");

  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    let id = "";
    if (url.pathname === "/watch") id = url.searchParams.get("v") ?? "";
    else if (/^\/(shorts|embed)\//.test(url.pathname)) id = requirePathSegment(url.pathname, 1, /^[\w-]{11}$/, "YouTube video ID is invalid.");
    if (!/^[\w-]{11}$/.test(id)) throw new InvalidVideoSourceError("YouTube video ID is invalid.");
    return {
      provider: "YouTube",
      storedProvider: "youtube",
      externalVideoId: id,
      sourceUrl: `https://www.youtube.com/watch?v=${id}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
    };
  }

  if (host === "youtu.be") {
    const id = requirePathSegment(url.pathname, 0, /^[\w-]{11}$/, "YouTube video ID is invalid.");
    return {
      provider: "YouTube",
      storedProvider: "youtube",
      externalVideoId: id,
      sourceUrl: `https://www.youtube.com/watch?v=${id}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
    };
  }

  if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[0] === "video" ? parts[1] ?? "" : parts[0] ?? "";
    if (!/^\d{1,20}$/.test(id)) throw new InvalidVideoSourceError("Vimeo video ID is invalid.");
    return { provider: "Vimeo", storedProvider: "vimeo", externalVideoId: id, sourceUrl: `https://vimeo.com/${id}` };
  }

  if (["twitch.tv", "www.twitch.tv", "m.twitch.tv"].includes(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[0] === "videos" ? parts[1] ?? "" : "";
    if (!/^\d{1,20}$/.test(id)) throw new InvalidVideoSourceError("Twitch video ID is invalid.");
    return { provider: "Twitch", storedProvider: "twitch", externalVideoId: id, sourceUrl: `https://www.twitch.tv/videos/${id}` };
  }

  if (["nicovideo.jp", "www.nicovideo.jp", "sp.nicovideo.jp", "nico.ms"].includes(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[0] === "watch" ? parts[1] ?? "" : host === "nico.ms" ? parts[0] ?? "" : "";
    if (!/^(?:sm|nm|so)\d{1,16}$/.test(id)) throw new InvalidVideoSourceError("ニコニコ動画ID is invalid.");
    return { provider: "ニコニコ", storedProvider: "niconico", externalVideoId: id, sourceUrl: `https://www.nicovideo.jp/watch/${id}` };
  }

  if (host === "www.tiktok.com" || host === "tiktok.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    const username = parts[0] ?? "";
    const id = parts[1] === "video" ? parts[2] ?? "" : "";
    if (!/^@[A-Za-z0-9._-]{2,32}$/.test(username) || !/^\d{8,32}$/.test(id)) {
      throw new InvalidVideoSourceError("TikTok video URL is invalid.");
    }
    return {
      provider: "TikTok",
      storedProvider: "tiktok",
      externalVideoId: id,
      sourceUrl: `https://www.tiktok.com/${username}/video/${id}`
    };
  }

  if (["dailymotion.com", "www.dailymotion.com", "dai.ly"].includes(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = host === "dai.ly" ? parts[0] ?? "" : parts[0] === "video" ? parts[1] ?? "" : "";
    if (!/^[A-Za-z0-9]{5,20}$/.test(id)) throw new InvalidVideoSourceError("Dailymotion video ID is invalid.");
    return {
      provider: "Dailymotion",
      storedProvider: "dailymotion",
      externalVideoId: id,
      sourceUrl: `https://www.dailymotion.com/video/${id}`
    };
  }

  const peerTubeHosts = new Set(["framatube.org", "video.blender.org", "tilvids.com", "diode.zone", "peertube.cpy.re"]);
  if (peerTubeHosts.has(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[0] === "w"
      ? parts[1] ?? ""
      : parts[0] === "videos" && ["watch", "embed"].includes(parts[1] ?? "")
        ? parts[2] ?? ""
        : "";
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new InvalidVideoSourceError("PeerTube video ID is invalid.");
    return {
      provider: "PeerTube",
      storedProvider: "peertube",
      externalVideoId: id,
      sourceUrl: `https://${host}/w/${id}`
    };
  }

  throw new InvalidVideoSourceError("This video provider is not supported.");
}

function validatedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error(`${field} is required.`);
  if (normalized.length > maxLength) throw new Error(`${field} is too long.`);
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${field} contains invalid characters.`);
  return normalized;
}

export function parseExternalVideoInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("JSON body is required.");
  const record = input as Record<string, unknown>;
  const source = normalizeVideoSource(validatedText(record.sourceUrl, "sourceUrl", 2048));
  return {
    source,
    title: validatedText(record.title, "title", 240),
    channel: validatedText(record.channel, "channel", 120),
    category: validatedText(record.category, "category", 80)
  };
}
