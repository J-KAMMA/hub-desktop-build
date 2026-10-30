// 接続した他のHubの公開音楽（hub.catalog.v1 kind "music"）を、音楽ホームの棚に並べて鳴らす。
// 一覧はRust(hub_network_read)で検証済み。ここでは表示用の形に直し、再生の入口を作るだけ。
// YouTube は共有の再生枠、Worker の公開曲は Rust(hub_network_audio) が取った生バイトを blob: で <audio> に載せる。

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const AUDIO_PATH = /^\/music\/api\/tracks\/[A-Za-z0-9_-]{1,128}\/audio$/;
const LIMIT = 100;

/** hub-network の load('music') が返す項目（origin 付き）を棚用の項目へ。自分のHubと不正な項目は落とす。 */
export function peerMusicEntries(items, { ownOrigin = '' } = {}) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const entries = [];
  for (const item of items) {
    if (entries.length >= LIMIT) break;
    const media = item?.media;
    if (!item || typeof item.origin !== 'string' || typeof item.id !== 'string' || typeof item.title !== 'string' || !item.title || !media || typeof media !== 'object') continue;
    if (item.origin === ownOrigin) continue; // 自分のHubの曲は既存の棚にある
    let host;
    try { host = new URL(item.origin).host; } catch { continue; }
    const youtubeId = typeof media.youtubeId === 'string' && YOUTUBE_ID.test(media.youtubeId) ? media.youtubeId : null;
    const audioPath = typeof media.audioPath === 'string' && AUDIO_PATH.test(media.audioPath) ? media.audioPath : null;
    if (!youtubeId && !audioPath) continue;
    const key = `${item.origin}\n${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      key, origin: item.origin, host, id: item.id, title: item.title,
      artist: typeof media.artist === 'string' ? media.artist : '',
      summary: typeof item.summary === 'string' ? item.summary : '',
      youtubeId, audioPath,
    });
  }
  return entries;
}

/** 共有の YouTube 経路（createMusicYoutubeSession）に渡す最小の作品。 */
export function peerYoutubeWork(entry) {
  return {
    id: `peer:${entry.origin}:${entry.id}`, title: entry.title, artist: entry.artist, description: entry.summary,
    services: [{ provider: 'youtube', label: 'YouTube', url: `https://www.youtube.com/watch?v=${entry.youtubeId}` }],
  };
}

/** カードの絵に使う、頭文字かサムネイルのための作品形。 */
export function peerArtworkWork(entry) {
  return entry.youtubeId ? peerYoutubeWork(entry) : { title: entry.title, services: [] };
}

/** 他HubのWorker公開曲の音声を、既存の <audio> に blob: で載せる。 */
export function createPeerAudio({ invoke, audio, URLApi = URL, onTrack = () => {}, onError = () => {} }) {
  let objectUrl = null;
  let turn = 0;
  const release = () => { if (objectUrl) { URLApi.revokeObjectURL(objectUrl); objectUrl = null; } };
  return {
    async play(entry) {
      if (!entry?.audioPath) return false;
      const mine = ++turn;
      try {
        const bytes = await invoke('hub_network_audio', { origin: entry.origin, path: entry.audioPath });
        if (mine !== turn) return false;
        const next = URLApi.createObjectURL(new Blob([bytes]));
        release();
        objectUrl = next;
        audio.pause();
        audio.src = next;
        audio.load();
        onTrack(entry);
        await audio.play();
        return mine === turn;
      } catch (error) {
        if (mine === turn) onError(error);
        return false;
      }
    },
    cancel() { turn++; },
    destroy() { turn++; release(); },
  };
}
