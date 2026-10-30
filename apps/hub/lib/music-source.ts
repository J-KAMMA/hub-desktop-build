import { normalizeTagList } from "@jkamma/content-tags";
import type { MusicProvider, MusicServiceLink } from "@/lib/music-catalog";

export class InvalidMusicSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMusicSourceError";
  }
}

export interface NormalizedMusicSource extends MusicServiceLink {
  provider: MusicProvider;
}

function secureUrl(raw: string): URL {
  if (!raw || raw.length > 2048) throw new InvalidMusicSourceError("配信先URLが正しくありません。");
  let url: URL;
  try { url = new URL(raw); } catch { throw new InvalidMusicSourceError("配信先URLが正しくありません。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new InvalidMusicSourceError("配信先URLには通常のHTTPS URLを指定してください。");
  url.hash = "";
  return url;
}

export function normalizeMusicSource(raw: string): NormalizedMusicSource {
  const url = secureUrl(raw.trim());
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  /* 外部の曲は YouTube / YouTube Music だけを受け付ける。Hub 内で再生できるのはここだけで、ほかの配信先は登録しない（2026-10-28）。 */
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    const id = host === "youtu.be" ? parts[0] : url.pathname === "/watch" ? url.searchParams.get("v") : parts[0] === "shorts" ? parts[1] : undefined;
    if (!id || !/^[\w-]{11}$/.test(id)) throw new InvalidMusicSourceError("YouTubeの動画URLを指定してください。");
    return { provider: "youtube", label: host === "music.youtube.com" ? "YouTube Music" : "YouTube", url: `https://www.youtube.com/watch?v=${id}`, embedUrl: `https://www.youtube-nocookie.com/embed/${id}` };
  }

  throw new InvalidMusicSourceError("YouTubeまたはYouTube MusicのURLを指定してください。");
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new InvalidMusicSourceError(`${label}を入力してください。`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max || /\p{Cc}/u.test(normalized)) throw new InvalidMusicSourceError(`${label}が正しくありません。`);
  return normalized;
}

export function parseMusicWorkInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidMusicSourceError("入力内容が正しくありません。");
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.serviceUrls) || record.serviceUrls.length < 1 || record.serviceUrls.length > 6) throw new InvalidMusicSourceError("配信先URLを1〜6件指定してください。");
  const services = record.serviceUrls.map((value) => normalizeMusicSource(text(value, "配信先URL", 2048)));
  if (new Set(services.map((service) => service.provider)).size !== services.length) throw new InvalidMusicSourceError("同じ音楽サービスは1作品につき1件までです。");
  if (!services.some((service) => service.provider === "youtube" && service.embedUrl)) throw new InvalidMusicSourceError("サイト内で再生できるYouTubeまたはYouTube MusicのURLが必要です。");
  const year = Number(record.year);
  if (!Number.isInteger(year) || year < 1000 || year > new Date().getFullYear() + 1) throw new InvalidMusicSourceError("リリース年が正しくありません。");
  const tags = Array.isArray(record.tags)
    ? normalizeTagList(record.tags).map((tag) => tag.display)
    : [];
  return { title: text(record.title, "曲名・作品名", 180), artist: text(record.artist, "アーティスト名", 120), description: text(record.description, "説明", 500), genre: text(record.genre, "ジャンル", 60), tags, year, services };
}
