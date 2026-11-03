// 動画のホーム（続きを見る・あとで見る・話題ごとの行）と視聴画面の部品。ヒーローは置かない（2026-10-15、デスクトップ仕様 §3.4）。画面の組み立てだけを持ち、通信や遷移は app.js から渡される。
import { youtubeVideoId, createYouTubePlayer, youtubeThumbnailUrl } from './youtube-embed.mjs';
import { filterVideos } from './yt-unplayable.mjs';
import { isAllowedImageUrl, createTextCover } from './media-image.mjs';
import { isNativeVideo, providerLabel, watchOpenLabel } from './native-video.mjs';
import { attachNativeHls } from './native-video-player.mjs';

const WATCHED_MAX = 12;
const ROW_MAX = 8;
const ROW_COUNT_MAX = 4;
const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** YouTube の動画なら動画ID、そうでなければ null。 */
export function videoYouTubeId(video) {
  return video && typeof video.sourceUrl === 'string' ? youtubeVideoId(video.sourceUrl) : null;
}
function playable(video) {
  return Boolean(videoYouTubeId(video)) && video.availabilityStatus !== 'unavailable';
}
export function videoImageUrl(video) {
  if (video?.thumbnailUrl) return video.thumbnailUrl;
  const id = videoYouTubeId(video);
  return id ? youtubeThumbnailUrl(id, 'hqdefault') : null;
}
const time = (video) => { const value = Date.parse(video?.publishedAt ?? ''); return Number.isFinite(value) ? value : 0; };

/** 公開の新しい順で最初の、アプリ内で再生できる動画。無ければ null。 */
export function pickHero(items) {
  return [...items].sort((a, b) => time(b) - time(a)).find(playable) ?? null;
}

/** topic（無ければ category）ごとの行。件数の多い順に最大 maxRows 行。 */
export function groupVideos(items, maxRows = ROW_COUNT_MAX) {
  const groups = new Map();
  for (const video of items) {
    const name = [video.topic, video.category].find((value) => typeof value === 'string' && value.trim());
    if (!name) continue;
    const key = name.trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(video);
  }
  return [...groups].map(([name, videos], index) => ({ name, videos, index }))
    .sort((a, b) => b.videos.length - a.videos.length || a.index - b.index)
    .slice(0, maxRows).map(({ name, videos }) => ({ name, videos }));
}

// 今回の起動で見た動画（メモリのみ。保存しない）。
let watched = [];
export function rememberWatched(video) {
  if (!video || typeof video.id !== 'string') return;
  watched = [video, ...watched.filter((item) => item.id !== video.id)].slice(0, WATCHED_MAX);
}
export function watchedVideos() { return watched; }

// あとで見る（一度だけ読む。取れなければ行を出さない）。
const saved = { items: [], status: 'idle' };
export function savedVideos() { return saved.items; }
export function resetVideoHome() { watched = []; saved.items = []; saved.status = 'idle'; }
export async function loadSavedVideos(invoke, { isCurrent = () => true, changed = () => {} } = {}) {
  if (saved.status !== 'idle') return;
  saved.status = 'loading';
  try {
    const data = await invoke('hub_client', { name: 'video_library' });
    if (!isCurrent()) { saved.status = 'idle'; return; }
    const entries = Array.isArray(data?.savedVideos) ? data.savedVideos : [];
    saved.items = entries.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string').slice(0, ROW_MAX);
    saved.status = 'done';
    changed();
  } catch { saved.status = 'done'; }
}

/** 16:9 の媒体枠。許可されない出どころ・読めない画像は <img> を出さず、題を組んだ表紙にする。 */
export function createVideoThumbnail(document, video, { hubAsset }) {
  const thumb = el(document, 'span', 'video-thumbnail ds-media');
  thumb.style.setProperty('--ratio', '16 / 9');
  const url = videoImageUrl(video);
  const cover = () => { thumb.classList.add('has-cover'); thumb.prepend(createTextCover(document, video?.title || '動画')); };
  if (url && typeof hubAsset === 'function' && isAllowedImageUrl(url)) {
    const img = document.createElement('img');
    hubAsset(img, url);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => { img.remove(); cover(); };
    thumb.append(img);
  } else cover();
  if (video.duration) thumb.append(el(document, 'span', 'video-duration', video.duration));
  return thumb;
}

/** 読み込み中の骨組み。完成形の札と同じ寸法で n 枚（CLS を出さない）。 */
export function createVideoSkeletons(document, count = 6) {
  return Array.from({ length: count }, () => {
    const card = el(document, 'span', 'vh-card vh-skeleton');
    card.setAttribute('aria-hidden', 'true');
    // 完成形の札と同じ並び：16:9 の枠、その下にチャンネルの丸と2行（題・補足）。
    const frame = el(document, 'span', 'ds-skeleton vh-skeleton-frame');
    const body = el(document, 'span', 'vh-skeleton-body');
    const lines = el(document, 'span', 'vh-skeleton-lines');
    lines.append(el(document, 'span', 'ds-skeleton is-line vh-skeleton-line'), el(document, 'span', 'ds-skeleton is-line vh-skeleton-line is-short'));
    body.append(el(document, 'span', 'ds-skeleton vh-skeleton-avatar'), lines);
    card.append(frame, body);
    return card;
  });
}

function channelName(video) { return video.channel || video.provider || '配信元不明'; }
export function createChannelAvatar(document, video) {
  const avatar = el(document, 'span', 'vh-avatar', Array.from(channelName(video))[0] ?? '?');
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}
function viewsText(video) { return video.viewCount != null ? `${Number(video.viewCount).toLocaleString()} 回視聴` : ''; }
function metaText(video, relTime) {
  return [viewsText(video), video.publishedAt ? relTime(video.publishedAt) : ''].filter(Boolean).join(' · ');
}

/** 動画カード。compact は「次に見る」用の横並び。 */
export function createVideoCard(document, video, { hubAsset, relTime, onOpen, compact = false }) {
  const peerHost = typeof video.peerHost === 'string' ? video.peerHost : '';
  const card = el(document, 'button', `video-card vh-card${compact ? ' video-card-compact' : ''}`);
  card.type = 'button';
  card.setAttribute('aria-label', `${video.title || '動画'}、${channelName(video)}の動画を開く`);
  const copy = el(document, 'span', 'video-card-copy');
  copy.append(el(document, 'strong', '', video.title || '動画'), el(document, 'span', '', channelName(video)), el(document, 'span', '', metaText(video, relTime)));
  if (peerHost) copy.append(el(document, 'span', 'vh-peer-host', peerHost));
  const body = el(document, 'span', 'vh-card-body');
  if (!compact) body.append(createChannelAvatar(document, video));
  body.append(copy);
  card.append(createVideoThumbnail(document, video, { hubAsset }), body);
  card.onclick = () => onOpen(video);
  return card;
}

function createRow(document, title, videos, deps, open) {
  const section = el(document, 'section', 'vh-row vt-shelf');
  section.setAttribute('aria-label', title);
  const grid = el(document, 'div', 'vh-grid vt-grid');
  grid.append(...videos.slice(0, ROW_MAX).map((video) => createVideoCard(document, video, { ...deps, onOpen: open })));
  section.append(el(document, 'h3', 'vh-row-title vt-shelf-title', title), grid);
  return section;
}

/**
 * 動画ホーム：続きを見る、あとで見る、話題ごとの行。
 * items が空ならホームは空にする。
 */
/** 同じ動画の二重表示を避ける鍵。自Hubの id と、YouTube の動画ID（他Hub・外部の同一動画）。 */
export function videoDedupeKeys(video) {
  const keys = [];
  if (typeof video?.id === 'string' && video.id) keys.push('id:' + video.id);
  const youtube = videoYouTubeId(video);
  if (youtube) keys.push('yt:' + youtube);
  return keys;
}

/** 続きを見る・あとで見る・ショートの棚に出た動画を、話題の行と他Hubの行から外す。同じ行内の重複も落とす。 */
export function dedupeHomeSections({ groups, peerVideos, taken = [] }) {
  const seenIds = new Set();
  const seenYoutube = new Set();
  for (const video of taken) for (const key of videoDedupeKeys(video)) (key.startsWith('yt:') ? seenYoutube : seenIds).add(key);
  const fresh = (video, byYoutube) => {
    const [idKey, youtubeKey] = videoDedupeKeys(video);
    if (idKey && seenIds.has(idKey)) return false;
    if (byYoutube && youtubeKey && seenYoutube.has(youtubeKey)) return false;
    if (idKey) seenIds.add(idKey);
    return true;
  };
  const keptGroups = [];
  for (const group of groups) {
    const videos = group.videos.filter((video) => fresh(video, false));
    if (videos.length) keptGroups.push({ ...group, videos });
  }
  // 話題の行に出た動画のYouTube IDも、他Hubの行では「出た」ものとして扱う。
  for (const group of keptGroups) for (const video of group.videos) for (const key of videoDedupeKeys(video)) if (key.startsWith('yt:')) seenYoutube.add(key);
  return { groups: keptGroups, peerVideos: peerVideos.filter((video) => fresh(video, true)) };
}

/** Hub の自作動画を先に、残りは元の順のまま（安定）。 */
export function ownFirst(items) {
  return [...items.filter(isNativeVideo), ...items.filter((video) => !isNativeVideo(video))];
}

export function renderVideoHome(host, { items, deps, onOpenSaved = deps.onOpen, peerVideos = [], taken = [] }) {
  const { document } = deps;
  const nodes = [];
  items = filterVideos(items); peerVideos = filterVideos(peerVideos); taken = filterVideos(taken);
  // 自作動画（Hub動画）は他の何よりも先に並べ、話題の行には重ねて出さない。
  const own = items.filter(isNativeVideo);
  if (own.length) {
    nodes.push(createRow(document, '自作の動画', own, deps, deps.onOpen));
    items = items.filter((video) => !isNativeVideo(video));
    taken = [...taken, ...own];
  }
  const history = filterVideos(watchedVideos()), savedList = filterVideos(savedVideos());
  if (history.length) nodes.push(createRow(document, '続きを見る', history, deps, deps.onOpen));
  if (savedList.length) nodes.push(createRow(document, 'あとで見る', savedList, deps, onOpenSaved));
  const deduped = dedupeHomeSections({ groups: groupVideos(items), peerVideos, taken: [...history, ...savedList, ...taken] });
  for (const group of deduped.groups) nodes.push(createRow(document, group.name, group.videos, deps, deps.onOpen));
  // 接続した他のHubの動画（YouTubeの参照だけ）。出典のHubを各カードに表示する。
  if (deduped.peerVideos.length) nodes.push(createRow(document, 'ほかのHubの動画', deduped.peerVideos, deps, deps.onOpen));
  host.replaceChildren(...nodes);
  host.hidden = nodes.length === 0;
}

// ---- 視聴画面 ----

let activeStage = null;
/** いま動いているプレーヤーを止める（iframe を DOM から外す）。画面を離れるときに呼ぶ。 */
export function stopVideoPlayer() { activeStage?.stop(); }

/** 視聴画面の再生枠。YouTube は埋め込み、それ以外はサムネイルと「提供元で開く」。 */
export function createWatchStage(document, video, { hubAsset, onOpenExternal, autoplay = true, dock = null, onReopen = null, nativePlay = null, nativeDeps = {} }) {
  const stage = el(document, 'div', 'vh-stage');
  const id = videoYouTubeId(video);
  const state = { stop() {} };
  const external = () => {
    const preview = el(document, 'div', 'video-player-preview');
    preview.append(createVideoThumbnail(document, video, { hubAsset }));
    const button = el(document, 'button', 'video-play', watchOpenLabel(video));
    button.type = 'button';
    button.disabled = !video.sourceUrl || video.availabilityStatus === 'unavailable';
    button.onclick = () => onOpenExternal(video.sourceUrl);
    preview.append(button);
    stage.replaceChildren(preview);
  };
  if (nativePlay && isNativeVideo(video) && video.id && video.availabilityStatus !== 'unavailable') {
    // 自作動画は同梱の hls.js で窓の中で鳴らす。始められなければ従来どおり「Hubで再生」へ戻す。
    const player = document.createElement('video');
    player.className = 'vh-native-player';
    player.controls = true;
    player.playsInline = true;
    player.preload = 'metadata';
    stage.replaceChildren(player);
    let playback = null;
    let stopped = false;
    state.stop = () => { stopped = true; playback?.destroy(); playback = null; player.pause?.(); };
    attachNativeHls(player, { ...nativeDeps, play: () => nativePlay(video.id), onError: () => { if (!stopped) { state.stop(); external(); } } })
      .then((attached) => { if (stopped) attached.destroy(); else { playback = attached; if (autoplay) void player.play?.()?.catch?.(() => {}); } })
      .catch(() => { if (!stopped) { stopped = true; external(); } });
  } else if (!id || video.availabilityStatus === 'unavailable') external();
  else {
    const key = `video:${video.id ?? id}`;
    let unsubscribe = null;
    const poster = () => {
      const node = el(document, 'div', 'video-player-preview');
      node.append(createVideoThumbnail(document, video, { hubAsset }));
      const resume = el(document, 'button', 'video-play', '▶ 再生');
      resume.type = 'button';
      resume.onclick = () => start(true);
      node.append(resume);
      stage.replaceChildren(node);
    };
    const start = (play) => {
      if (dock) {
        // 再生枠は共有の dock に持たせる。ここには置き場だけを置き、画面を離れたら小窓になる。
        const slot = el(document, 'div', 'yt-player yt-player-slot');
        stage.replaceChildren(slot);
        if (!dock.play({ key, id, title: video.title || 'YouTube動画', subtitle: channelName(video), slot, onOpen: onReopen, autoplay: play })) { external(); return; }
        unsubscribe?.();
        unsubscribe = dock.subscribe(() => { if (!dock.isPlaying(key) && slot.isConnected) { unsubscribe?.(); unsubscribe = null; poster(); } });
        return;
      }
      const player = createYouTubePlayer(document, { id, title: video.title || 'YouTube動画', autoplay: play });
      if (!player) { external(); return; }
      stage.replaceChildren(player);
    };
    state.stop = () => {
      if (dock) { const slot = stage.querySelector('.yt-player-slot'); if (slot) dock.release(slot); return; }
      if (!stage.querySelector('.yt-player')) return;
      const frame = stage.querySelector('iframe');
      if (frame) frame.src = 'about:blank';
      const poster = el(document, 'div', 'video-player-preview');
      poster.append(createVideoThumbnail(document, video, { hubAsset }));
      const resume = el(document, 'button', 'video-play', '▶ 再生');
      resume.type = 'button';
      resume.onclick = () => start(true);
      poster.append(resume);
      stage.replaceChildren(poster);
    };
    start(autoplay);
  }
  activeStage = { stop: state.stop, element: stage };
  return { element: stage, stop: state.stop };
}

/** タイトル行・チャンネルと操作の行・説明欄。actions に既存の操作ボタンを足す。 */
export function createWatchHeader(document, video, { relTime }) {
  const title = el(document, 'h2', 'vh-watch-title', video.title || '動画');
  const bar = el(document, 'div', 'vh-watch-bar');
  const channel = el(document, 'div', 'vh-watch-channel');
  channel.append(createChannelAvatar(document, video), el(document, 'strong', '', channelName(video)));
  const actions = el(document, 'div', 'vh-watch-actions');
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', '動画の操作');
  bar.append(channel, actions);
  const details = [viewsText(video), video.publishedAt ? relTime(video.publishedAt) : '', video.topic, video.category !== video.topic ? video.category : '', providerLabel(video.provider)]
    .filter((value) => typeof value === 'string' && value);
  const desc = el(document, 'div', 'vh-watch-desc', details.join(' · '));
  desc.hidden = details.length === 0;
  return { title, bar, actions, desc };
}

/** 「次に見る」。現在の動画を除いた一覧から、同じ分類・チャンネルを先頭に最大12件。 */
export function createRelatedList(document, video, items, deps) {
  const rank = (item) => Number(item.category === video.category) + Number(item.channel === video.channel);
  const others = filterVideos(items).filter((item) => item.id !== video.id).sort((a, b) => rank(b) - rank(a)).slice(0, 12);
  const nodes = [el(document, 'h3', '', '次に見る'), ...others.map((item) => createVideoCard(document, item, { ...deps, compact: true }))];
  if (!others.length) nodes.push(el(document, 'p', 'meta', '次に見る動画はまだありません。'));
  return nodes;
}
