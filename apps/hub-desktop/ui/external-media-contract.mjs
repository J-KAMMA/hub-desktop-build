// ../../hub/lib/video-source.ts
var InvalidVideoSourceError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidVideoSourceError";
  }
};
function requirePathSegment(pathname, index, pattern, message) {
  const value = pathname.split("/").filter(Boolean)[index] ?? "";
  if (!pattern.test(value)) throw new InvalidVideoSourceError(message);
  return value;
}
function normalizeVideoSource(input) {
  if (typeof input !== "string" || input.length > 2048) {
    throw new InvalidVideoSourceError("sourceUrl is invalid.");
  }
  let url;
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
    if (!/^(?:sm|nm|so)\d{1,16}$/.test(id)) throw new InvalidVideoSourceError("\u30CB\u30B3\u30CB\u30B3\u52D5\u753BID is invalid.");
    return { provider: "\u30CB\u30B3\u30CB\u30B3", storedProvider: "niconico", externalVideoId: id, sourceUrl: `https://www.nicovideo.jp/watch/${id}` };
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
  const peerTubeHosts = /* @__PURE__ */ new Set(["framatube.org", "video.blender.org", "tilvids.com", "diode.zone", "peertube.cpy.re"]);
  if (peerTubeHosts.has(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[0] === "w" ? parts[1] ?? "" : parts[0] === "videos" && ["watch", "embed"].includes(parts[1] ?? "") ? parts[2] ?? "" : "";
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
function validatedText(value, field, maxLength) {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new Error(`${field} is required.`);
  if (normalized.length > maxLength) throw new Error(`${field} is too long.`);
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${field} contains invalid characters.`);
  return normalized;
}
function parseExternalVideoInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("JSON body is required.");
  const record = input;
  const source = normalizeVideoSource(validatedText(record.sourceUrl, "sourceUrl", 2048));
  return {
    source,
    title: validatedText(record.title, "title", 240),
    channel: validatedText(record.channel, "channel", 120),
    category: validatedText(record.category, "category", 80)
  };
}

// ../../hub/lib/video-context.ts
var VIDEO_PURPOSES = [
  "guide",
  "explanation",
  "live",
  "review",
  "creation",
  "music",
  "other"
];
var InvalidVideoContextError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidVideoContextError";
  }
};
var HUBPEDIA_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function requiredTopic(value) {
  if (typeof value !== "string") throw new InvalidVideoContextError("topic is required.");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw new InvalidVideoContextError("topic is required.");
  if (normalized.length > 80) throw new InvalidVideoContextError("topic is too long.");
  if (/\p{Cc}/u.test(normalized)) throw new InvalidVideoContextError("topic contains invalid characters.");
  return normalized;
}
function optionalHubpediaSlug(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (typeof value !== "string" || value.length > 160 || !HUBPEDIA_SLUG_PATTERN.test(value)) {
    throw new InvalidVideoContextError("relatedHubpediaSlug must be a lowercase Hubpedia slug.");
  }
  return value;
}
function parseVideoContextInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidVideoContextError("JSON body is required.");
  }
  const record = input;
  if (typeof record.purpose !== "string" || !VIDEO_PURPOSES.includes(record.purpose)) {
    throw new InvalidVideoContextError("purpose is invalid.");
  }
  return {
    purpose: record.purpose,
    topic: requiredTopic(record.topic),
    relatedHubpediaSlug: optionalHubpediaSlug(record.relatedHubpediaSlug)
  };
}

// ../../hub/lib/music-source.ts
var InvalidMusicSourceError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidMusicSourceError";
  }
};
function secureUrl(raw) {
  if (!raw || raw.length > 2048) throw new InvalidMusicSourceError("\u914D\u4FE1\u5148URL\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\u3002");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidMusicSourceError("\u914D\u4FE1\u5148URL\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\u3002");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new InvalidMusicSourceError("\u914D\u4FE1\u5148URL\u306B\u306F\u901A\u5E38\u306EHTTPS URL\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
  url.hash = "";
  return url;
}
function normalizeMusicSource(raw) {
  const url = secureUrl(raw.trim());
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "open.spotify.com") {
    const kind = parts[0];
    const id = parts[1];
    if (!kind || !["track", "album", "playlist", "episode", "show"].includes(kind) || !id || !/^[A-Za-z0-9]{10,32}$/.test(id)) throw new InvalidMusicSourceError("Spotify\u306E\u4F5C\u54C1URL\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    const sourceUrl = `https://open.spotify.com/${kind}/${id}`;
    return { provider: "spotify", label: "Spotify", url: sourceUrl, embedUrl: `https://open.spotify.com/embed/${kind}/${id}` };
  }
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    const id = host === "youtu.be" ? parts[0] : url.pathname === "/watch" ? url.searchParams.get("v") : parts[0] === "shorts" ? parts[1] : void 0;
    if (!id || !/^[\w-]{11}$/.test(id)) throw new InvalidMusicSourceError("YouTube\u306E\u52D5\u753BURL\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    return { provider: "youtube", label: host === "music.youtube.com" ? "YouTube Music" : "YouTube", url: `https://www.youtube.com/watch?v=${id}`, embedUrl: `https://www.youtube-nocookie.com/embed/${id}` };
  }
  if (host === "music.apple.com") {
    if (parts.length < 2) throw new InvalidMusicSourceError("Apple Music\u306E\u4F5C\u54C1URL\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    return { provider: "apple", label: "Apple Music", url: url.toString() };
  }
  if (["music.amazon.co.jp", "music.amazon.com", "music.amazon.co.uk", "music.amazon.de"].includes(host)) {
    url.searchParams.delete("tag");
    return { provider: "amazon", label: "Amazon Music", url: url.toString() };
  }
  if (host === "bandcamp.com" || host.endsWith(".bandcamp.com")) {
    if (parts.length === 0) throw new InvalidMusicSourceError("Bandcamp\u306E\u4F5C\u54C1URL\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    return { provider: "bandcamp", label: "Bandcamp", url: url.toString() };
  }
  throw new InvalidMusicSourceError("\u5BFE\u5FDC\u3057\u3066\u3044\u308B\u97F3\u697D\u30B5\u30FC\u30D3\u30B9\u306EURL\u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
}
function text(value, label, max) {
  if (typeof value !== "string") throw new InvalidMusicSourceError(`${label}\u3092\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max || /\p{Cc}/u.test(normalized)) throw new InvalidMusicSourceError(`${label}\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\u3002`);
  return normalized;
}
function parseMusicWorkInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidMusicSourceError("\u5165\u529B\u5185\u5BB9\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\u3002");
  const record = input;
  if (!Array.isArray(record.serviceUrls) || record.serviceUrls.length < 1 || record.serviceUrls.length > 6) throw new InvalidMusicSourceError("\u914D\u4FE1\u5148URL\u30921\u301C6\u4EF6\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
  const services = record.serviceUrls.map((value) => normalizeMusicSource(text(value, "\u914D\u4FE1\u5148URL", 2048)));
  if (new Set(services.map((service) => service.provider)).size !== services.length) throw new InvalidMusicSourceError("\u540C\u3058\u97F3\u697D\u30B5\u30FC\u30D3\u30B9\u306F1\u4F5C\u54C1\u306B\u3064\u304D1\u4EF6\u307E\u3067\u3067\u3059\u3002");
  if (!services.some((service) => service.provider === "youtube" && service.embedUrl)) throw new InvalidMusicSourceError("\u30B5\u30A4\u30C8\u5185\u3067\u518D\u751F\u3067\u304D\u308BYouTube\u307E\u305F\u306FYouTube Music\u306EURL\u304C\u5FC5\u8981\u3067\u3059\u3002");
  const year = Number(record.year);
  if (!Number.isInteger(year) || year < 1e3 || year > (/* @__PURE__ */ new Date()).getFullYear() + 1) throw new InvalidMusicSourceError("\u30EA\u30EA\u30FC\u30B9\u5E74\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\u3002");
  const tags = Array.isArray(record.tags) ? [...new Set(record.tags.map((value) => text(value, "\u30BF\u30B0", 40)))].slice(0, 12) : [];
  return { title: text(record.title, "\u66F2\u540D\u30FB\u4F5C\u54C1\u540D", 180), artist: text(record.artist, "\u30A2\u30FC\u30C6\u30A3\u30B9\u30C8\u540D", 120), description: text(record.description, "\u8AAC\u660E", 500), genre: text(record.genre, "\u30B8\u30E3\u30F3\u30EB", 60), tags, year, services };
}
export {
  VIDEO_PURPOSES,
  normalizeMusicSource,
  normalizeVideoSource,
  parseExternalVideoInput,
  parseMusicWorkInput,
  parseVideoContextInput
};
