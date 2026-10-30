// 動画のいいねとチャンネルのフォロー（Hub Desktop）。
// いいね・フォローは Hub が持つ。読み取りは hub_detail の video_engagement、付け外しは固定動詞
// like_video / unlike_video と follow / unfollow（本文は Rust が組む）。未接続ならボタンは押せない。
// DOM は textContent / createElement だけで組む。

export function parseEngagement(value) {
  const count = Number(value?.likeCount);
  return { likeCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0, liked: value?.likedByViewer === true };
}

const VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/u;
export function isEngagementId(id) { return typeof id === 'string' && VIDEO_ID.test(id); }

/** 読み取り。取れなければ null（呼び出し側はボタンを出さない）。 */
export async function loadEngagement(invoke, videoId) {
  if (!isEngagementId(videoId)) return null;
  try { return parseEngagement(await invoke('hub_detail', { name: 'video_engagement', ids: [videoId] })); } catch { return null; }
}

/** 付け外し。サーバーが返した状態を採る（楽観的には変えない）。 */
export async function setVideoLike(invoke, videoId, liked) {
  if (!isEngagementId(videoId)) throw new Error('動画の指定が正しくありません');
  return parseEngagement(await invoke('hub_client_action', { action: liked ? 'like_video' : 'unlike_video', target: videoId }));
}

/** 1000+ のように上限で切れた数の表示。 */
export function followerLabel(count, capped) {
  const n = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.floor(Number(count)) : 0;
  return `フォロワー ${n.toLocaleString('en-US')}${capped ? '+' : ''}`;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * いいねのボタン。label は「いいね」。signedIn が偽なら disabled にして理由を添える。
 * onSet(希望の状態) は新しい状態 {likeCount, liked} を返す。
 */
export function createLikeButton(doc, { state, signedIn, onSet, compact = false }) {
  let current = { likeCount: state?.likeCount ?? 0, liked: state?.liked === true };
  const wrap = el(doc, 'span', `vid-like${compact ? ' is-compact' : ''}`);
  const button = el(doc, 'button', 'vid-like-button head-action');
  button.type = 'button';
  const mark = el(doc, 'span', 'vid-like-mark', '♥');
  mark.setAttribute('aria-hidden', 'true');
  const count = el(doc, 'span', 'vid-like-count');
  const label = el(doc, 'span', 'vid-like-label', 'いいね');
  const note = el(doc, 'span', 'meta vid-like-note');
  note.setAttribute('role', 'status');
  button.append(mark, count, label);
  const paint = () => {
    button.classList.toggle('is-liked', current.liked);
    count.textContent = String(current.likeCount);
    button.setAttribute('aria-pressed', String(current.liked));
    button.setAttribute('aria-label', `いいね ${current.likeCount}件${current.liked ? '（いいね済み・押すと外す）' : ''}`);
  };
  paint();
  if (!signedIn) {
    button.disabled = true;
    note.textContent = 'いいねするにはDesktopを接続してください。';
    button.title = note.textContent;
  }
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    note.textContent = '';
    try {
      const next = await onSet(!current.liked);
      current = { likeCount: next.likeCount, liked: next.liked };
      paint();
    } catch (error) {
      note.textContent = error?.message || 'いいねを変更できませんでした。';
    } finally {
      button.disabled = false;
    }
  };
  wrap.append(button);
  wrap.append(note);
  wrap.state = () => ({ ...current });
  return wrap;
}

/**
 * フォローのボタン。isViewer（自分のチャンネル）なら null を返し、何も出さない。
 * onSet(希望の状態) は新しい following を返す。未接続は disabled。
 */
export function createFollowButton(doc, { following, signedIn, isViewer = false, onSet }) {
  if (isViewer) return null;
  let on = following === true;
  const wrap = el(doc, 'span', 'vid-follow');
  const button = el(doc, 'button', 'vid-follow-button');
  button.type = 'button';
  const note = el(doc, 'span', 'meta vid-follow-note');
  note.setAttribute('role', 'status');
  const paint = () => {
    button.className = `vid-follow-button ${on ? 'deny' : 'approve'}`;
    button.textContent = on ? 'フォロー中' : 'フォローする';
    button.setAttribute('aria-pressed', String(on));
  };
  paint();
  if (!signedIn) {
    button.disabled = true;
    note.textContent = 'フォローするにはDesktopを接続してください。';
    button.title = note.textContent;
  }
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    note.textContent = '';
    try { on = (await onSet(!on)) === true; paint(); }
    catch (error) { note.textContent = error?.message || 'フォローを変更できませんでした。'; }
    finally { button.disabled = false; }
  };
  wrap.append(button, note);
  wrap.following = () => on;
  return wrap;
}
