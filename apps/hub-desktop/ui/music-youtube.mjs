// 音楽作品をHubの中で再生する唯一の経路：YouTube の埋め込み。
// Spotify・Apple Music などは再生せず、提供元のリンクとして開くだけ。
import { youtubeVideoId, createYouTubePlayer, youtubeThumbnailUrl } from './youtube-embed.mjs';
import { isAllowedImageUrl, squareArtworkUrl } from './media-image.mjs';

const PROVIDER_LABELS = {
  spotify: 'Spotify', youtube: 'YouTube', apple: 'Apple Music', amazon: 'Amazon Music', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp',
};

const httpUrl = value => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null; } catch { return null; }
};

/** 作品の中から YouTube で再生できる提供元を探す。なければ null。 */
export function youtubeSource(work) {
  const services = Array.isArray(work?.services) ? work.services : [];
  for (const service of services) {
    if (!service || typeof service !== 'object') continue;
    const id = youtubeVideoId(service.embedUrl) ?? youtubeVideoId(service.url);
    if (id) return { id, service };
  }
  return null;
}

/** 「〇〇で開く」のリンク。アプリ内で再生する YouTube 提供元は含めない。 */
export function openLinks(work, playable = youtubeSource(work)) {
  const services = Array.isArray(work?.services) ? work.services : [];
  const links = [];
  for (const service of services.slice(0, 12)) {
    if (!service || typeof service !== 'object' || service === playable?.service) continue;
    const url = httpUrl(service.url);
    if (!url) continue;
    const name = PROVIDER_LABELS[service.provider] ?? (typeof service.label === 'string' && service.label.trim() ? service.label.trim().slice(0, 40) : '提供元');
    links.push({ url, label: `${name}で開く` });
  }
  return links.slice(0, 6);
}

/** 画像の元URL。作品の画像、なければ YouTube のサムネイル。 */
export function workArtworkUrl(work) {
  if (typeof work?.artworkUrl === 'string' && work.artworkUrl) return squareArtworkUrl(work.artworkUrl);
  const source = youtubeSource(work);
  return source ? youtubeThumbnailUrl(source.id, 'mqdefault') : null;
}

/** 画像が読めなかったときは頭文字の面を残す。 */
export function createArtwork(document, work, { hubAsset, className = 'mw-art' } = {}) {
  const art = document.createElement('span');
  art.className = className;
  art.setAttribute('aria-hidden', 'true');
  const letter = document.createElement('span');
  letter.className = 'mw-art-letter';
  letter.textContent = (String(work?.title ?? '').trim().slice(0, 1) || '♪').toUpperCase();
  art.append(letter);
  const url = workArtworkUrl(work);
  if (url && typeof hubAsset === 'function' && isAllowedImageUrl(url)) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    hubAsset(img, url);
    art.append(img);
  }
  return art;
}

/**
 * YouTube の埋め込みを1本だけ持つ。再生は「再生」を押したときだけ始まり、
 * 閉じる・音楽の画面を離れる・別の作品を開くと iframe ごと消える。
 */
export function createMusicYoutubeSession({ document, bar, hubAsset, onPlayed = () => {}, dock = null, onOpenWork = null }) {
  let current = null; // { work, workId, id, player, panel }
  let autoplayFor = null;
  const listeners = new Set();
  const notify = () => { for (const fn of [...listeners]) { try { fn(current?.workId ?? null); } catch { listeners.delete(fn); } } };

  function paintBar() {
    bar.replaceChildren();
    // dock があれば再生中の表示は小窓が受け持つ。下の帯は出さない。
    if (!current || dock) { bar.hidden = true; return; }
    const art = createArtwork(document, current.work, { hubAsset, className: 'mw-art mw-art-bar' });
    const text = document.createElement('span');
    text.className = 'yt-now-text';
    const title = document.createElement('strong');
    title.textContent = current.work.title || '音楽作品';
    const artist = document.createElement('span');
    artist.className = 'meta';
    artist.textContent = [current.work.artist, 'YouTubeで再生中'].filter(Boolean).join(' · ');
    text.append(title, artist);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'yt-now-close';
    close.textContent = '閉じる';
    close.setAttribute('aria-label', `${current.work.title || '音楽作品'}の再生を閉じる`);
    close.onclick = () => stop();
    bar.append(art, text, close);
    bar.hidden = false;
  }

  function stop() {
    if (!current) return false;
    const { player, panel, key } = current;
    current = null;
    if (dock) { if (dock.isPlaying(key)) dock.stop(); }
    else player.querySelector('iframe')?.setAttribute('src', 'about:blank');
    player.remove();
    if (panel) { panel.replaceChildren(); panel.hidden = true; }
    paintBar();
    notify();
    return true;
  }

  function play({ work, panel }) {
    const source = youtubeSource(work);
    if (!source || !panel) return false;
    stop();
    const key = `music:${work.id ?? source.id}`;
    let player;
    if (dock) {
      // 再生枠は共有の dock が持つ。ここには置き場だけを置き、音楽の画面を離れたら小窓になる。
      player = document.createElement('div'); player.className = 'yt-player yt-player-slot';
      panel.replaceChildren(player); panel.hidden = false;
      if (!dock.play({ key, id: source.id, title: work.title || '音楽作品', subtitle: work.artist || '', slot: player, onOpen: typeof onOpenWork === 'function' ? () => onOpenWork(work) : null })) { panel.replaceChildren(); panel.hidden = true; return false; }
    } else {
      player = createYouTubePlayer(document, { id: source.id, title: `${work.title || '音楽作品'}（YouTube）`, autoplay: true });
      if (!player) return false;
      panel.replaceChildren(player);
      panel.hidden = false;
    }
    current = { work, workId: work.id ?? null, id: source.id, player, panel, key };
    paintBar();
    try { onPlayed(work); } catch { /* 履歴は再生を妨げない */ }
    notify();
    return true;
  }

  dock?.subscribe(() => { if (current && !dock.isPlaying(current.key)) { const { panel } = current; current = null; if (panel) { panel.replaceChildren(); panel.hidden = true; } paintBar(); notify(); } });

  /** 小窓で再生中の作品の画面に戻ったら、置き場を付け直して大きな枠に戻す（iframe はそのまま）。 */
  function reattach({ work, panel }) {
    if (!dock || !current || !panel || current.workId !== (work?.id ?? null) || !dock.isPlaying(current.key)) return false;
    const slot = document.createElement('div'); slot.className = 'yt-player yt-player-slot';
    panel.replaceChildren(slot); panel.hidden = false;
    current.player = slot; current.panel = panel;
    dock.play({ key: current.key, id: current.id, title: work.title || '音楽作品', subtitle: work.artist || '', slot, onOpen: typeof onOpenWork === 'function' ? () => onOpenWork(work) : null });
    paintBar();
    return true;
  }

  return {
    play, stop, reattach,
    isPlaying: workId => current !== null && current.workId === workId,
    active: () => current?.workId ?? null,
    /** 音楽の画面を離れた・埋め込みの置き場が消えたなら止める。 */
    sync(inMusicContext) {
      if (!current || (inMusicContext && current.player.isConnected)) return;
      // dock があれば止めずに小窓へ。無ければ従来どおり止める。
      if (dock) dock.release(current.player);
      else stop();
    },
    /** 一覧のカードの再生ボタンから詳細を開くとき、その作品だけ一度だけ再生を始める。 */
    requestAutoplay(workId) { autoplayFor = workId; },
    consumeAutoplay(workId) { const hit = autoplayFor !== null && autoplayFor === workId; autoplayFor = null; return hit; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
