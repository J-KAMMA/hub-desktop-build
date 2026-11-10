import { TAG_MAX_PER_ITEM, normalizeTag } from "@jkamma/content-tags";
export type MusicProvider = "spotify" | "youtube" | "soundcloud" | "apple" | "amazon" | "bandcamp";

export interface MusicServiceLink {
  provider: MusicProvider;
  label: string;
  url: string;
  embedUrl?: string;
}

export interface MusicWork {
  id: string;
  title: string;
  artist: string;
  album?: string;
  description: string;
  genre: string;
  tags?: string[];
  tagSignals?: import("@/lib/music-tagging").MusicTagSignal[];
  year: number;
  accent: string;
  symbol: string;
  artworkUrl?: string;
  featured?: boolean;
  source?: "sample" | "community";
  submittedBy?: string;
  createdAt?: string;
  services: MusicServiceLink[];
}

export function musicAlbumLabel(work: Pick<MusicWork, "album" | "title">): string {
  return work.album?.normalize("NFKC").trim() || work.title;
}

const MUSIC_TITLE_TRAILING_LABEL = /\s*(?:[-–—|:]\s*)?(?:[\[(【]\s*)?(?:official\s+(?:(?:music|lyric(?:s)?|archive|live|performance|hd|4k)\s+)?video(?:\s+(?:remaster(?:ed)?|4k|hd|uhd|version))*|official\s+audio|lyric(?:s)?\s+video|music\s+video|公式(?:ミュージックビデオ|MV|動画|音源))\s*(?:[\])】])?\s*$/iu;

/** Keep provider metadata searchable while presenting the work's actual title. */
export function musicDisplayTitle(value: string): string {
  const original = value.trim();
  let title = original
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .trim();
  let previous = "";
  while (title && title !== previous) {
    previous = title;
    title = title.replace(MUSIC_TITLE_TRAILING_LABEL, "").trim();
  }
  return title || original;
}

export function musicWorkArtworkUrl(work: Pick<MusicWork, "artworkUrl" | "services">): string | undefined {
  if (work.artworkUrl) return work.artworkUrl;
  const youtube = work.services.find((service) => service.provider === "youtube" && (service.embedUrl || service.url));
  if (!youtube) return undefined;
  try {
    const source = new URL(youtube.embedUrl ?? youtube.url);
    const parts = source.pathname.split("/").filter(Boolean);
    const videoId = source.pathname.includes("/embed/") ? parts.at(-1) : source.searchParams.get("v");
    return videoId && /^[\w-]{11}$/.test(videoId) ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : undefined;
  } catch {
    return undefined;
  }
}

export function hasHubFullPlaybackSource(work: Pick<MusicWork, "services">): boolean {
  return work.services.some((service) => service.provider === "youtube" && Boolean(service.embedUrl));
}

const HUB_ORIGINAL_ID = /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A Hub original: audio published through the Music Worker (id `music:<uuid>`), possibly listed by another Hub. */
export function isHubOriginalWork(work: Pick<MusicWork, "id">): boolean {
  return HUB_ORIGINAL_ID.test(work.id);
}

/** Playable inside Hub: a Hub original (Music Worker audio) or an external work with a YouTube embed. */
export function isPlayableMusicWork(work: Pick<MusicWork, "id" | "services">): boolean {
  return isHubOriginalWork(work) || hasHubFullPlaybackSource(work);
}

export interface MusicPlaylistTrack {
  title: string;
  artist: string;
}

export interface MusicPlaylist {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  durationLabel: string;
  tracks: MusicPlaylistTrack[];
}

export const MUSIC_PROVIDER_LABELS: Record<MusicProvider, string> = {
  spotify: "Spotify",
  youtube: "YouTube Music",
  soundcloud: "SoundCloud",
  apple: "Apple Music",
  amazon: "Amazon Music",
  bandcamp: "Bandcamp",
};

const MUSIC_GENRE_LABELS: Record<string, string> = {
  "alternative dance": "オルタナティブ・ダンス",
  "alternative hip hop": "オルタナティブ・ヒップホップ",
  "alternative metal": "オルタナティブ・メタル",
  "alternative r&b": "オルタナティブR&B",
  "alternative rock": "オルタナティブ・ロック",
  "arena rock": "アリーナ・ロック",
  arrocha: "アホーシャ",
  bachata: "バチャータ",
  ballade: "バラード",
  "blue-eyed soul": "ブルー・アイド・ソウル",
  blues: "ブルース",
  "blues rock": "ブルースロック",
  "brazilian bass": "ブラジリアン・ベース",
  "baroque pop": "バロック・ポップ",
  "bubblegum dance": "バブルガム・ダンス",
  "bubblegum music": "バブルガム・ポップ",
  "cloud rap": "クラウド・ラップ",
  "comedy hip hop": "コメディ・ヒップホップ",
  "contemporary worship music": "現代ワーシップ音楽",
  "contemporary r&b": "コンテンポラリーR&B",
  "country music": "カントリー",
  "country pop": "カントリー・ポップ",
  "country rap": "カントリー・ラップ",
  "country rock": "カントリー・ロック",
  "crunk&b": "クランク&B",
  "dance music": "ダンス",
  "dance-pop": "ダンス・ポップ",
  dancehall: "ダンスホール",
  "deep house": "ディープ・ハウス",
  disco: "ディスコ",
  "disco-pop": "ディスコ・ポップ",
  "dream pop": "ドリーム・ポップ",
  "dub music": "ダブ",
  dubstep: "ダブステップ",
  electro: "エレクトロ",
  "electro house": "エレクトロ・ハウス",
  "electro hop": "エレクトロ・ホップ",
  "electro-r&b": "エレクトロR&B",
  "electronic dance music": "EDM",
  "electronic music": "エレクトロニック",
  electropop: "エレクトロポップ",
  "electronic rock": "エレクトロニック・ロック",
  "emo rap": "エモ・ラップ",
  eurodance: "ユーロダンス",
  europop: "ユーロポップ",
  "filmi music": "フィルミ音楽",
  flamenco: "フラメンコ",
  "folk music": "フォーク",
  "folk-pop": "フォーク・ポップ",
  "folk rock": "フォークロック",
  folktronica: "フォークトロニカ",
  "french hip hop": "フレンチ・ヒップホップ",
  funk: "ファンク",
  "funk rock": "ファンク・ロック",
  "future bass": "フューチャー・ベース",
  "future garage": "フューチャー・ガラージ",
  "gangsta rap": "ギャングスタ・ラップ",
  "glam rock": "グラム・ロック",
  grunge: "グランジ",
  "hardcore hip hop": "ハードコア・ヒップホップ",
  "hard rock": "ハードロック",
  "heavy metal": "ヘヴィメタル",
  "hip hop culture": "ヒップホップ",
  "hip hop music": "ヒップホップ",
  "hip hop soul": "ヒップホップ・ソウル",
  "hip house": "ヒップ・ハウス",
  "house music": "ハウス",
  "indie pop": "インディー・ポップ",
  "indie folk": "インディー・フォーク",
  "indie rock": "インディー・ロック",
  "indian pop": "インディアン・ポップ",
  "industrial music": "インダストリアル",
  "italo dance": "イタロ・ダンス",
  jazz: "ジャズ",
  "j-pop": "J-POP",
  "k-pop": "K-POP",
  "latin r&b": "ラテンR&B",
  "latin rock": "ラテン・ロック",
  "latin pop": "ラテン・ポップ",
  "latin trap": "ラテン・トラップ",
  "luk thung": "ルークトゥン",
  mariachi: "マリアッチ",
  moombahton: "ムーンバートン",
  music: "音楽",
  "music of latin america": "ラテン音楽",
  "new wave": "ニュー・ウェイヴ",
  "nu metal": "ニュー・メタル",
  "nu-disco": "ニュー・ディスコ",
  "piano rock": "ピアノ・ロック",
  "political hip hop": "ポリティカル・ヒップホップ",
  "pop music": "ポップ",
  "pop rap": "ポップ・ラップ",
  "pop rock": "ポップロック",
  "pop soul": "ポップ・ソウル",
  "pop-punk": "ポップ・パンク",
  "popular music": "ポップ",
  "post-grunge": "ポスト・グランジ",
  "power pop": "パワー・ポップ",
  "progressive house": "プログレッシブ・ハウス",
  "protest song": "プロテストソング",
  rap: "ラップ",
  "rap rock": "ラップロック",
  reggae: "レゲエ",
  "reggae fusion": "レゲエ・フュージョン",
  reggaeton: "レゲトン",
  "religious art": "宗教音楽",
  "rhythm and blues": "R&B",
  "rock music": "ロック",
  samba: "サンバ",
  sertanejo: "セルタネージョ",
  "short film": "ポップ",
  "soft rock": "ソフトロック",
  soul: "ソウル",
  ska: "スカ",
  "snap music": "スナップ・ミュージック",
  "sophisti-pop": "ソフィスティ・ポップ",
  "synth-pop": "シンセポップ",
  "teen pop": "ティーン・ポップ",
  "thrash metal": "スラッシュメタル",
  "trap music": "トラップ",
  "trip hop": "トリップ・ホップ",
  "tropical house": "トロピカル・ハウス",
  "tropical music": "トロピカル音楽",
  "vocal house": "ボーカル・ハウス",
  "west coast hip hop": "ウェストコースト・ヒップホップ",
};

export function musicGenreLabel(genre: string): string {
  const normalized = genre.normalize("NFKC").trim();
  return MUSIC_GENRE_LABELS[normalized.toLocaleLowerCase("en-US")] ?? normalized;
}

export function musicGenreCategoryLabel(genre: string): string {
  const label = musicGenreLabel(genre);
  const normalized = label.toLocaleLowerCase("ja-JP");
  if (label === "日本語ラップ") return "ヒップホップ・ラップ";
  if (/^(?:音楽|music)$/iu.test(label)) return "未分類";
  if (/^j-?pop$/iu.test(label)) return "J-POP";
  if (/^k-?pop$/iu.test(label)) return "K-POP";
  if (/(?:ヒップホップ|ラップ|hip hop|rap)/iu.test(normalized)) return "ヒップホップ・ラップ";
  if (/(?:r&b|ソウル|ファンク|ゴスペル|rhythm and blues|funk|gospel)/iu.test(normalized)) return "R&B・ソウル";
  if (/(?:メタル|metal)/iu.test(normalized)) return "メタル";
  if (/(?:ロック|グランジ|パンク|ニュー・ウェイヴ|rock|grunge|punk|new wave)/iu.test(normalized)) return "ロック";
  if (/(?:ポップ|pop)/iu.test(normalized)) return "ポップ";
  if (/(?:edm|エレクトロ|ハウス|ダンス|ディスコ|ダブステップ|ガラージ|house|dance|electro|disco|dubstep|garage)/iu.test(normalized)) return "EDM・ダンス";
  if (/(?:レゲエ|ダンスホール|ダブ|スカ|reggae|dancehall|dub|ska)/iu.test(normalized)) return "レゲエ";
  if (/(?:ラテン|レゲトン|バチャータ|マリアッチ|フラメンコ|サンバ|セルタネージョ|アホーシャ)/iu.test(normalized)) return "ラテン";
  if (/(?:カントリー|country)/iu.test(normalized)) return "カントリー";
  if (/(?:フォーク|folk)/iu.test(normalized)) return "フォーク";
  if (/(?:ジャズ|ブルース|jazz|blues)/iu.test(normalized)) return "ジャズ・ブルース";
  if (/(?:クラシック|オーケストラ|室内楽|ピアノ|classical|orchestra|chamber music)/iu.test(normalized)) return "クラシック";
  if (/(?:アンビエント|チルアウト|ローファイ|ニューエイジ|ambient|chillout|lo-?fi|new age)/iu.test(normalized)) return "アンビエント・チル";
  if (/(?:ワールド|アフロビート|アフロポップ|world|afrobeat|afropop)/iu.test(normalized)) return "ワールド";
  if (/(?:サウンドトラック|劇伴|映画音楽|ゲーム音楽|soundtrack|film score|game music)/iu.test(normalized)) return "サウンドトラック";
  return "その他";
}

/** Display a track genre from the broad category to the more specific genre. */
export function musicGenrePathLabel(genre: string): string {
  const subgenre = musicGenreLabel(genre);
  const category = musicGenreCategoryLabel(subgenre);
  return category === subgenre ? category : `${category} ＞ ${subgenre}`;
}

const CANONICAL_MUSIC_ACCENTS = ["#c7dcf2", "#e7b6b6", "#d8c4ed", "#d7f238", "#efd3a9", "#bfe1cf"];

function fallbackMusicPresentation(work: Pick<MusicWork, "id" | "title" | "artist">) {
  let hash = 0;
  for (const char of work.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return {
    accent: CANONICAL_MUSIC_ACCENTS[hash % CANONICAL_MUSIC_ACCENTS.length],
    symbol: `${work.artist[0] ?? "M"}${work.title[0] ?? "♪"}`.toLocaleUpperCase("ja-JP"),
  };
}

/** Static catalog entries and later D1 submissions share this exact presentation/playback shape. */
export function canonicalizeMusicWork(work: MusicWork): MusicWork {
  const fallback = fallbackMusicPresentation(work);
  const services = [...new Map(work.services.map((service) => [service.provider, {
    ...service,
    label: MUSIC_PROVIDER_LABELS[service.provider],
  }])).values()];
  const genre = musicGenreLabel(work.genre);
  const category = musicGenreCategoryLabel(genre);
  const decade = Number.isFinite(work.year) ? `${Math.floor(work.year / 10) * 10}年代` : "";
  // One normaliser for every surface: 8 tags of 32 characters, deduplicated by key (display form kept).
  const seenTagKeys = new Set<string>();
  const tags: string[] = [];
  for (const raw of [...(work.tags ?? []), category, genre, decade]) {
    const tag = normalizeTag(raw);
    if (!tag || seenTagKeys.has(tag.key)) continue;
    seenTagKeys.add(tag.key);
    tags.push(tag.display);
    if (tags.length >= TAG_MAX_PER_ITEM) break;
  }
  const normalized = {
    ...work,
    genre,
    tags,
    accent: work.accent || fallback.accent,
    symbol: work.symbol || fallback.symbol,
    source: work.source ?? "sample" as const,
    services,
  };
  return { ...normalized, artworkUrl: musicWorkArtworkUrl(normalized) };
}

export function canonicalizeMusicWorks(works: MusicWork[]): MusicWork[] {
  const unique = new Map<string, MusicWork>();
  const seenWorks = new Set<string>();
  works.forEach((work) => {
    const normalized = canonicalizeMusicWork(work);
    const workKey = `${normalized.artist.normalize("NFKC").trim()}\u0000${normalized.title.normalize("NFKC").trim()}`.toLocaleLowerCase("ja-JP");
    if (unique.has(normalized.id) || seenWorks.has(workKey)) return;
    unique.set(normalized.id, normalized);
    seenWorks.add(workKey);
  });
  return [...unique.values()];
}

export const FEATURED_MUSIC_PLAYLIST: MusicPlaylist = {
  id: "tokyo-midnight",
  title: "東京、午前0時。",
  subtitle: "JKamma Selects · Night Drive",
  description: "現代の東京から80年代のネオンへ。静かな夜のドライブをイメージした、曲順で聴く18曲です。",
  durationLabel: "約90分",
  tracks: [
    { title: "Sparkle", artist: "iri" },
    { title: "NEW ERA", artist: "Nulbarich" },
    { title: "STAY TUNE", artist: "Suchmos" },
    { title: "LOOP", artist: "SIRUP" },
    { title: "DOCUMENT", artist: "TENDRE" },
    { title: "MOON", artist: "LUCKY TAPES" },
    { title: "Ride on Wave", artist: "Yogee New Waves" },
    { title: "踊り子", artist: "Vaundy" },
    { title: "きらり", artist: "藤井 風" },
    { title: "Plastic Love", artist: "竹内まりや" },
    { title: "Telephone Number", artist: "大橋純子" },
    { title: "フライディ・チャイナタウン", artist: "泰葉" },
    { title: "Remember Summer Days", artist: "杏里" },
    { title: "Midnight Pretenders", artist: "亜蘭知子" },
    { title: "真夜中のドア〜Stay With Me", artist: "松原みき" },
    { title: "4:00 A.M.", artist: "大貫妙子" },
    { title: "ナイトクルージング", artist: "Fishmans" },
    { title: "恋人へ", artist: "Lamp" },
  ],
};

export const MUSIC_WORKS: MusicWork[] = ([
  {
    id: "never-gonna-give-you-up",
    title: "Never Gonna Give You Up",
    artist: "Rick Astley",
    description: "YouTube Music共有URLをHub内プレイヤーへ変換し、ほかの公式配信先と統合するデモ作品です。",
    genre: "ポップ",
    year: 1987,
    accent: "#e7a2a2",
    symbol: "RA",
    artworkUrl: "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e0215ebbedaacef61af244262a8",
    featured: true,
    services: [
      { provider: "youtube", label: "YouTube Music（モック）", url: "https://music.youtube.com/watch?v=dQw4w9WgXcQ", embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" },
    ],
  },
  {
    id: "cut-to-the-feeling",
    title: "Cut To The Feeling",
    artist: "Carly Rae Jepsen",
    description: "サービスごとにプレイヤーまたは公式ページを選べる表示例です。",
    genre: "ダンス・ポップ",
    year: 2017,
    accent: "#b9d9f2",
    symbol: "CR",
    artworkUrl: "https://image-cdn-fa.spotifycdn.com/image/ab67616d00001e027359994525d219f64872d3b1",
    services: [
      { provider: "youtube", label: "YouTube", url: "https://www.youtube.com/results?search_query=Cut+To+The+Feeling+Carly+Rae+Jepsen" },
    ],
  },
  {
    id: "removed-soundcloud-example",
    title: "Flickermood",
    artist: "Forss",
    description: "SoundCloud公式ウィジェットを利用した音声プレイヤーの表示例です。",
    genre: "エレクトロニック",
    year: 2012,
    accent: "#dfc9ef",
    symbol: "FO",
    services: [
      { provider: "youtube", label: "YouTube", url: "https://www.youtube.com/results?search_query=Forss+Flickermood" },
    ],
  },
  {
    id: "public-playlist",
    title: "公共を考えるプレイリスト",
    artist: "JKamma Selects",
    description: "記事やスレッドと一緒に共有する選曲ページのサンプルです。",
    genre: "プレイリスト",
    year: 2026,
    accent: "#d7f238",
    symbol: "JK",
    featured: true,
    services: [
      { provider: "youtube", label: "YouTubeで探す", url: "https://www.youtube.com/results?search_query=public+systems+playlist" },
    ],
  },
  {
    id: "ytmusic-twinkle-snow-powdery-snow",
    title: "Twinkle Snow Powdery Snow",
    artist: "Perfume",
    description: "YouTube Musicの公式ミュージックビデオをHub内で再生するモック登録です。",
    genre: "テクノポップ",
    year: 2006,
    accent: "#cdddf7",
    symbol: "PF",
    services: [
      { provider: "youtube", label: "YouTube Music", url: "https://music.youtube.com/watch?v=Dk3jWsARsX4", embedUrl: "https://www.youtube-nocookie.com/embed/Dk3jWsARsX4" },
    ],
  },
  {
    id: "ytmusic-tsumetai-gift",
    title: "冷たいギフト",
    artist: "ゆらゆら帝国",
    description: "YouTube Musicで公式公開されているミュージックビデオのモック登録です。",
    genre: "ロック",
    year: 2005,
    accent: "#b9c9c1",
    symbol: "ゆ",
    services: [
      { provider: "youtube", label: "YouTube Music", url: "https://music.youtube.com/watch?v=widlYg-g04A", embedUrl: "https://www.youtube-nocookie.com/embed/widlYg-g04A" },
    ],
  },
  {
    id: "ytmusic-jun-toumei-shounen",
    title: "準透明少年",
    artist: "ヨルシカ",
    description: "YouTube Musicの公式動画を統合プレイリストで扱うためのモック登録です。",
    genre: "ロック",
    year: 2018,
    accent: "#a9d7df",
    symbol: "ヨ",
    services: [
      { provider: "youtube", label: "YouTube Music", url: "https://music.youtube.com/watch?v=9ypEFXTakV8", embedUrl: "https://www.youtube-nocookie.com/embed/9ypEFXTakV8" },
    ],
  },
  {
    id: "ytmusic-tousou",
    title: "TOUSOU",
    artist: "花冷え。",
    description: "YouTube Musicの公式動画をHub内でフル再生するモック登録です。",
    genre: "メタル",
    year: 2023,
    accent: "#f1a9c6",
    symbol: "花",
    services: [
      { provider: "youtube", label: "YouTube Music", url: "https://music.youtube.com/watch?v=B9cC2_V7JwE", embedUrl: "https://www.youtube-nocookie.com/embed/B9cC2_V7JwE" },
    ],
  },
  {
    id: "bon-jovi-livin-on-a-prayer",
    title: "Livin' On A Prayer",
    artist: "Bon Jovi",
    description: "BonJoviVEVO公式ミュージックビデオをHub内で再生します。",
    genre: "ロック",
    year: 1986,
    accent: "#c9a78f",
    symbol: "BJ",
    services: [
      { provider: "youtube", label: "YouTube Music", url: "https://www.youtube.com/watch?v=lDK9QqIzhwk", embedUrl: "https://www.youtube-nocookie.com/embed/lDK9QqIzhwk" },
    ],
  },
  {
    id: "tokona-x-shirazaa-itte-kikaseya-show",
    title: "知らざあ言って聞かせやSHOW",
    artist: "TOKONA-X",
    description: "TOKONA-Xの代表曲をYouTubeの公開音源でHub内再生します。",
    genre: "ヒップホップ",
    year: 2003,
    accent: "#b8b2a8",
    symbol: "TX",
    services: [
      { provider: "youtube", label: "YouTube", url: "https://www.youtube.com/watch?v=3s-SdxS-iFc", embedUrl: "https://www.youtube-nocookie.com/embed/3s-SdxS-iFc" },
    ],
  },
] satisfies MusicWork[]).filter((work) => work.id !== "removed-soundcloud-example");
