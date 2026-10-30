// 接続した他のHubの公開動画（hub.catalog.v1 kind "video"）を、動画ホームの行に並べる。
// 動画は外部プラットフォームへの参照だけ。YouTube の項目だけが再生でき、バイトは取らない。
// 一覧はRust(hub_network_read)で検証済み。ここでは表示用の形に直す。

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const LIMIT = 100;

/** hub-network の load('video') が返す項目（origin 付き）を、視聴画面に渡せる動画の形へ。自分のHub・YouTube以外・不正な項目は落とす。 */
export function peerVideoEntries(items, { ownOrigin = '' } = {}) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const videos = [];
  for (const item of items) {
    if (videos.length >= LIMIT) break;
    const media = item?.media;
    if (!item || typeof item.origin !== 'string' || typeof item.id !== 'string' || typeof item.title !== 'string' || !item.title || !media || typeof media !== 'object') continue;
    if (item.origin === ownOrigin) continue;
    if (typeof media.youtubeId !== 'string' || !YOUTUBE_ID.test(media.youtubeId)) continue;
    let host;
    try { host = new URL(item.origin).host; } catch { continue; }
    const key = `peer:${host}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push({
      id: key, title: item.title, channel: typeof media.channel === 'string' ? media.channel : '',
      sourceUrl: `https://www.youtube.com/watch?v=${media.youtubeId}`, provider: 'youtube',
      duration: typeof media.duration === 'string' ? media.duration : undefined,
      publishedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
      description: typeof item.summary === 'string' ? item.summary : '',
      peerHost: host, peerOrigin: item.origin,
    });
  }
  return videos;
}

/** 他Hubの動画か。保存・プレイリスト・共有・コメントなどは元のHubのものなので付けない。 */
export function isPeerVideo(video) {
  return Boolean(video) && typeof video.peerHost === 'string' && typeof video.id === 'string' && video.id.startsWith('peer:');
}
