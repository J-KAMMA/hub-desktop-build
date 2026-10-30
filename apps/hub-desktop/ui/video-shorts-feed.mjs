// ショートの縦フィード（Hub Desktop）。1画面に1本、CSS の scroll-snap で送る。
// いま見えている1本（IntersectionObserver で6割以上）だけを共有の YouTube dock で再生し、
// ほかの動画は iframe を作らない・外す。再生は playback-owner を通すので、始めると Hub の曲・右列のブラウザは止まる。
// 再生枠（slot）は CSS で 200×200 以上を保つ。DOM は textContent / createElement だけ。
import { videoYouTubeId, createVideoThumbnail } from './video-home.mjs';
import { createLikeButton, loadEngagement, setVideoLike } from './video-engagement.mjs';

export const VISIBLE_RATIO = 0.6;

/** ↑↓ で移る先の番号。端では動かない。ほかのキーは null。 */
export function nextShortIndex(current, key, length) {
  if (!Number.isInteger(length) || length <= 0) return null;
  const at = Number.isInteger(current) && current >= 0 ? Math.min(current, length - 1) : 0;
  if (key === 'ArrowDown') return Math.min(length - 1, at + 1);
  if (key === 'ArrowUp') return Math.max(0, at - 1);
  return null;
}

/** 入力欄・選択・編集可能な場所では ↑↓ を横取りしない。 */
export function isEditableTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = String(node.tagName).toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return node.isContentEditable === true || node.getAttribute?.('contenteditable') === '' || node.getAttribute?.('contenteditable') === 'true';
}

/** 見えている割合の表から、しきい値以上でいちばん大きい1本。無ければ null。 */
export function pickVisible(ratios, threshold = VISIBLE_RATIO) {
  let best = null, bestRatio = threshold;
  for (const [index, ratio] of ratios) if (ratio >= bestRatio && (best === null || ratio > bestRatio || index < best)) { best = index; bestRatio = ratio; }
  return best;
}

function playable(video) {
  return Boolean(videoYouTubeId(video)) && video.availabilityStatus !== 'unavailable';
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createShortsFeed({ document, items, dock, owner = null, hubAsset, signedIn = false, invoke = async () => ({}), onOpenChannel = () => {}, onOpenVideo = () => {}, observerFactory = null }) {
  const window = document.defaultView;
  const feed = el(document, 'div', 'vid-shorts-feed');
  feed.tabIndex = 0;
  feed.setAttribute('role', 'feed');
  feed.setAttribute('aria-label', 'ショート');
  const sections = [];
  const ratios = new Map();
  const engaged = new Set();
  let active = null, playingKey = null, destroyed = false;

  const makeObserver = observerFactory ?? ((callback, options) => (typeof window.IntersectionObserver === 'function' ? new window.IntersectionObserver(callback, options) : null));

  items.forEach((video, index) => {
    const section = el(document, 'section', 'vid-short');
    section.dataset.index = String(index);
    section.setAttribute('aria-label', video.title || 'ショート');
    const stage = el(document, 'div', 'vid-short-stage');
    const poster = createVideoThumbnail(document, video, { hubAsset });
    poster.classList.add('vid-short-poster');
    poster.style.setProperty('--ratio', '9 / 16');
    const slot = el(document, 'div', 'yt-player yt-player-slot vid-short-slot');
    stage.append(poster, slot);
    if (!playable(video)) {
      const open = el(document, 'button', 'video-play vid-short-open', '詳細を開く');
      open.type = 'button';
      open.onclick = () => onOpenVideo(video);
      stage.append(open);
    }
    const info = el(document, 'div', 'vid-short-info');
    info.append(el(document, 'strong', 'vid-short-title', video.title || '動画'));
    const channelName = video.channel || '配信元不明';
    if (video.provider === 'hub' && typeof video.channelHandle === 'string' && video.channelHandle) {
      const link = el(document, 'button', 'vid-short-channel link', channelName);
      link.type = 'button';
      link.onclick = () => onOpenChannel(video.channelHandle);
      info.append(link);
    } else info.append(el(document, 'span', 'meta vid-short-channel', channelName));
    const actions = el(document, 'div', 'vid-short-actions');
    section.append(stage, info, actions);
    section._slot = slot; section._actions = actions;
    sections.push(section);
    feed.append(section);
  });

  function mountLike(index) {
    const video = items[index], section = sections[index];
    if (!video || !section || engaged.has(video.id)) return;
    engaged.add(video.id);
    const paint = (state) => {
      if (destroyed) return;
      section._actions.replaceChildren(createLikeButton(document, { state, signedIn, compact: true, onSet: (liked) => setVideoLike(invoke, video.id, liked) }));
    };
    if (!signedIn) { paint({ likeCount: 0, liked: false }); return; }
    void loadEngagement(invoke, video.id).then((state) => paint(state ?? { likeCount: 0, liked: false }));
  }

  function stopPlaying() {
    if (playingKey === null) return;
    const key = playingKey;
    playingKey = null;
    if (dock.isPlaying(key)) dock.stop();
  }

  function activate(index) {
    if (destroyed || index === active) return;
    active = index;
    const video = items[index];
    if (!video) { stopPlaying(); return; }
    mountLike(index);
    if (!playable(video)) { stopPlaying(); return; }
    const key = `video:${video.id}`;
    // 始める前に Hub の曲・右列のブラウザを止める（dock 自身は止めない）。
    owner?.claim('yt-dock');
    const ok = dock.play({ key, id: videoYouTubeId(video), title: video.title || 'YouTube動画', subtitle: video.channel || '', slot: sections[index]._slot, onOpen: null, autoplay: true });
    playingKey = ok ? key : null;
  }

  const observer = makeObserver((entries) => {
    for (const entry of entries) {
      const index = Number(entry.target?.dataset?.index);
      if (Number.isInteger(index)) ratios.set(index, entry.isIntersecting ? entry.intersectionRatio : 0);
    }
    const next = pickVisible(ratios);
    if (next !== null) activate(next);
  }, { root: feed, threshold: [0, 0.25, 0.5, VISIBLE_RATIO, 0.75, 1] });
  if (observer) for (const section of sections) observer.observe(section);

  // フィード全体が見えなくなったら止める（別の画面へ移ったとき）。
  const outer = makeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry && !entry.isIntersecting) { active = null; ratios.clear(); stopPlaying(); }
  }, { threshold: [0] });
  if (outer) outer.observe(feed);

  const smooth = () => { try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; } catch { return 'auto'; } };
  function goTo(index) {
    if (!sections[index]) return;
    // 1本の高さはフィードの高さと同じ。祖先（本文）まで動かさないよう、フィードだけをスクロールする。
    const top = index * feed.clientHeight;
    if (typeof feed.scrollTo === 'function') feed.scrollTo({ top, behavior: smooth() });
    else feed.scrollTop = top;
  }
  function onKey(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (isEditableTarget(event.target)) return;
    if (event.currentTarget !== feed) {
      // 文書全体で受けるのは、何にも焦点が無いか、フィードの中に焦点があるときだけ。
      const focus = document.activeElement;
      if (focus && focus !== document.body && !feed.contains(focus)) return;
      if (isEditableTarget(focus) || !feed.isConnected || feed.checkVisibility?.() === false) return;
    }
    const next = nextShortIndex(active ?? 0, event.key, sections.length);
    if (next === null) return;
    event.preventDefault();
    if (next !== (active ?? 0) || active === null) goTo(next);
  }
  feed.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onKey);

  return {
    element: feed,
    goTo,
    active: () => active,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect?.();
      outer?.disconnect?.();
      document.removeEventListener('keydown', onKey);
      feed.removeEventListener('keydown', onKey);
      stopPlaying();
    },
  };
}
