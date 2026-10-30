// Hub 動画のチャンネルページ（Hub Desktop）。
// 読み取りは hub_detail の video_channel（先頭）と video_channel_page（続き。不透明なキーセット）。
// ゲート付き（locked）の動画は鍵の印を出し、再生にも詳細にも進ませない。DOM は textContent / createElement だけ。
import { createVideoCard } from './video-home.mjs';
import { createCoverMedia } from './media-image.mjs';
import { createFollowButton, followerLabel } from './video-engagement.mjs';

const HANDLE = /^[A-Za-z0-9_.-]{1,64}$/u;
const CURSOR = /^[A-Za-z0-9_=-]{1,256}$/u;
export function isChannelHandle(value) { return typeof value === 'string' && HANDLE.test(value); }

export function parseChannelPage(value) {
  const raw = value?.channel;
  const channel = raw && typeof raw.profileId === 'string' && typeof raw.handle === 'string' ? {
    profileId: raw.profileId,
    handle: raw.handle,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : raw.handle,
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : null,
    bio: typeof raw.bio === 'string' ? raw.bio : '',
    followerCount: Number.isFinite(Number(raw.followerCount)) ? Math.max(0, Math.floor(Number(raw.followerCount))) : 0,
    followerCountCapped: raw.followerCountCapped === true,
    viewerFollows: raw.viewerFollows === true,
    isViewer: raw.isViewer === true,
  } : null;
  const videos = (Array.isArray(value?.videos) ? value.videos : [])
    .filter((video) => video && typeof video.id === 'string' && typeof video.title === 'string')
    .map((video) => ({
      id: video.id, title: video.title,
      duration: video.duration ?? null,
      publishedAt: typeof video.publishedAt === 'string' ? video.publishedAt : '',
      href: typeof video.href === 'string' ? video.href : '',
      locked: video.locked === true,
      thumbnailUrl: typeof video.thumbnailUrl === 'string' ? video.thumbnailUrl : undefined,
      isShort: video.isShort === true,
    }));
  const cursor = typeof value?.nextCursor === 'string' && CURSOR.test(value.nextCursor) ? value.nextCursor : null;
  return { channel, videos, nextCursor: cursor };
}

/** 1つのチャンネルの読み込み状態。more() は同時に1本、別のチャンネルへ移ったら捨てる。 */
export function createChannelState({ invoke, handle, changed = () => {} }) {
  const state = { handle, channel: null, videos: [], nextCursor: null, status: 'idle', error: null, loadingMore: false, moreError: false };
  let revision = 0;
  const snapshot = () => ({ ...state, videos: [...state.videos] });
  const notify = () => changed(snapshot());
  const fail = (error) => (/not_found|404/u.test(String(error?.message ?? error)) ? 'not_found' : 'error');
  return {
    snapshot,
    async load() {
      if (!isChannelHandle(handle)) { state.status = 'not_found'; notify(); return; }
      const mine = ++revision;
      state.status = 'loading'; state.error = null; notify();
      try {
        const page = parseChannelPage(await invoke('hub_detail', { name: 'video_channel', ids: [handle] }));
        if (mine !== revision) return;
        if (!page.channel) { state.status = 'not_found'; notify(); return; }
        Object.assign(state, { channel: page.channel, videos: page.videos, nextCursor: page.nextCursor, status: 'ready', loadingMore: false, moreError: false });
      } catch (error) {
        if (mine !== revision) return;
        state.status = fail(error); state.error = error;
      }
      notify();
    },
    async more() {
      if (state.status !== 'ready' || !state.nextCursor || state.loadingMore) return;
      const mine = revision, cursor = state.nextCursor;
      state.loadingMore = true; state.moreError = false; notify();
      try {
        const page = parseChannelPage(await invoke('hub_detail', { name: 'video_channel_page', ids: [handle, cursor] }));
        if (mine !== revision) return;
        const seen = new Set(state.videos.map((video) => video.id));
        state.videos = [...state.videos, ...page.videos.filter((video) => !seen.has(video.id))];
        // 同じキーが返ったら止める（終わらないページ送りを避ける）。
        state.nextCursor = page.nextCursor && page.nextCursor !== cursor ? page.nextCursor : null;
      } catch { if (mine === revision) state.moreError = true; }
      if (mine !== revision) return;
      state.loadingMore = false; notify();
    },
    setFollowing(value) { if (state.channel) { state.channel = { ...state.channel, viewerFollows: value === true }; notify(); } },
    dispose() { revision++; },
  };
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 見出し（アイコン・名前・@ハンドル・紹介・フォロワー数・フォロー）。 */
export function createChannelHeader(doc, channel, { hubAsset, signedIn, onFollow }) {
  const head = el(doc, 'header', 'vid-channel-head');
  const avatar = createCoverMedia(doc, { url: channel.avatarUrl, title: Array.from(channel.displayName)[0] ?? '?', hubAsset, ratio: '1 / 1', className: 'vid-channel-avatar' });
  const copy = el(doc, 'div', 'vid-channel-copy');
  copy.append(el(doc, 'h2', 'vid-channel-name', channel.displayName), el(doc, 'p', 'meta vid-channel-handle', `@${channel.handle}`));
  copy.append(el(doc, 'p', 'meta vid-channel-followers', followerLabel(channel.followerCount, channel.followerCountCapped)));
  if (channel.bio) copy.append(el(doc, 'p', 'vid-channel-bio', channel.bio));
  const follow = createFollowButton(doc, { following: channel.viewerFollows, signedIn, isViewer: channel.isViewer, onSet: onFollow });
  if (follow) copy.append(follow);
  head.append(avatar, copy);
  return head;
}

/** チャンネルページ全体。state は createChannelState().snapshot()。 */
export function renderChannelPage(doc, state, { hubAsset, relTime, signedIn, onOpenVideo, onLocked, onFollow, onMore, onRetry }) {
  const root = el(doc, 'div', 'vid-channel');
  root.setAttribute('aria-busy', String(state.status === 'loading'));
  if (state.status === 'loading' || state.status === 'idle') { root.append(el(doc, 'p', 'meta', 'チャンネルを読み込んでいます…')); return root; }
  if (state.status === 'not_found') { root.append(el(doc, 'p', 'meta', 'このチャンネルは見つかりませんでした。')); return root; }
  if (state.status === 'error') {
    root.append(el(doc, 'p', 'warning', 'チャンネルを読み込めませんでした。'));
    const retry = el(doc, 'button', 'head-action', '再読み込み'); retry.type = 'button'; retry.onclick = () => onRetry?.();
    root.append(retry);
    return root;
  }
  const { channel } = state;
  root.append(createChannelHeader(doc, channel, { hubAsset, signedIn, onFollow }));
  const grid = el(doc, 'div', 'vh-grid vid-channel-grid');
  for (const item of state.videos) {
    const video = { id: item.id, title: item.title, duration: item.duration, publishedAt: item.publishedAt, thumbnailUrl: item.locked ? undefined : item.thumbnailUrl,
      channel: channel.displayName, provider: 'hub', channelHandle: channel.handle };
    const card = createVideoCard(doc, video, { hubAsset, relTime, onOpen: () => (item.locked ? onLocked?.(item) : onOpenVideo(item)) });
    if (item.locked) {
      card.classList.add('is-locked');
      card.setAttribute('aria-label', `${item.title}（ゲート付き。条件を満たすと視聴できます）`);
      card.querySelector('.video-thumbnail')?.append(el(doc, 'span', 'vid-lock', '🔒 ゲート付き'));
    }
    grid.append(card);
  }
  if (!state.videos.length) root.append(el(doc, 'p', 'meta', '公開されている動画はまだありません。'));
  else root.append(grid);
  if (state.nextCursor) {
    const more = el(doc, 'button', 'head-action vid-channel-more', state.loadingMore ? '読み込み中…' : 'もっと見る');
    more.type = 'button'; more.disabled = state.loadingMore; more.onclick = () => onMore?.();
    root.append(more);
    if (state.moreError) root.append(el(doc, 'p', 'warning', '続きを読み込めませんでした。もう一度お試しください。'));
  }
  return root;
}
