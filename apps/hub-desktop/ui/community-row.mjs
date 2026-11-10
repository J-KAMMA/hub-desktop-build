// コミュニティの流れの「詰めた行」（2026-11-10）。1件を2行で見せる：1行目が題（無ければ本文の先頭）、2行目が 種類・書いた人・時刻。
// 右に小さな絵、その右に 返信の数（目立つ）と いいね。アバターは置かない（行を低くして、1画面に見える件数を増やす）。
// 行そのものが「開く」。ここでは何も送らない——いいね・開く・メニューは呼び出し側の関数。
import { roleMark } from './role-mark.mjs';

const make = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};
export const COMMUNITY_KIND_LABELS = Object.freeze({ chat: '雑談', question: '質問', party: '募集' });
const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const firstLine = (body) => String(body ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 1000 以上は 1.2k の形。行の右の数字を短く保つ。 */
export function compactCount(value) {
  const n = count(value);
  if (n < 1000) return String(n);
  if (n < 10000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.floor(n / 1000)}k`;
}

/** 統一した投稿（posts_place）を行の形へ。kind は置き場 channel:{id}:{kind} から呼び出し側が付けた communityKind。 */
export function rowFromPost(post) {
  const locked = post.locked === true;
  const images = locked ? [] : (post.attachments ?? []).filter((a) => a && a.type === 'image' && !a.locked);
  const image = images[0];
  const src = image ? (image.meta?.url || (ID.test(String(image.refId ?? '')) ? `/api/media/images/${encodeURIComponent(image.refId)}?variant=thumbnail` : null)) : null;
  return {
    id: post.id, source: 'post', kind: post.communityKind ?? '',
    title: post.title || '', text: locked ? '' : firstLine(post.body) || post.summary || '',
    author: { name: post.author?.displayName || post.author?.handle || '', handle: post.author?.handle ?? '', role: post.author?.communityRole ?? null },
    at: post.publishedAt ?? post.createdAt ?? '',
    replies: count(post.counts?.replies), likes: count(post.counts?.likes), liked: post.viewer?.liked === true,
    thumb: src, more: Math.max(0, images.length - 1),
    pinned: Boolean(post.pinnedAt), locked, gate: locked ? post.gate?.description ?? '' : '', held: post.status === 'held', edited: Boolean(post.editedAt),
  };
}

/** 旧い形の発言（community_posts の messages）を行の形へ。返信の数は読み込み済みの子孫の数。 */
export function rowFromMessage(message, profiles = {}, { replies = 0 } = {}) {
  const profile = profiles?.[message.authorProfileId];
  const locked = message.locked === true;
  const image = locked ? null : (message.images ?? [])[0];
  const likes = Array.isArray(message.reactions) ? message.reactions.reduce((sum, item) => sum + count(item?.count), 0) : count(message.likeCount);
  return {
    id: message.id, source: 'message', kind: message.kind ?? '',
    title: '', text: locked ? '' : firstLine(message.body),
    author: { name: profile?.displayName ?? message.botName ?? 'メンバー', handle: profile?.handle ?? '', role: profile?.communityRole ?? null },
    at: message.createdAt ?? '',
    replies: count(replies), likes, liked: message.viewerReacted === true,
    thumb: image?.url ?? null, more: Math.max(0, (message.images ?? []).length - 1),
    pinned: Boolean(message.pinnedAt), locked, gate: '', held: false, edited: Boolean(message.editedAt),
  };
}

/** 旧い形の発言の木：根ごとの子孫の数。親が一覧に無い返信は根として扱う。 */
export function messageThreads(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const byId = new Map(list.map((message) => [message.id, message]));
  const rootOf = (message) => {
    const seen = new Set();
    let at = message;
    while (at.replyToMessageId && byId.has(at.replyToMessageId) && !seen.has(at.id)) { seen.add(at.id); at = byId.get(at.replyToMessageId); }
    return at.id;
  };
  const replies = new Map();
  const roots = [];
  for (const message of list) {
    const root = rootOf(message);
    if (root === message.id) roots.push(message); else replies.set(root, (replies.get(root) ?? 0) + 1);
  }
  return { roots, replies, rootOf: (id) => (byId.has(id) ? rootOf(byId.get(id)) : null) };
}

/**
 * deps: { icon, hubAsset, relTime, onOpen(view), onLike?(view, on) -> Promise<{likes, liked}|void>, onAuthor?(handle), menu?: [[label, run]] }
 */
export function createCommunityRow(document, view, deps) {
  const { icon, relTime } = deps;
  const row = make(document, 'article', 'community-row');
  row.dataset.postId = view.id;
  if (view.kind) row.dataset.kind = view.kind;
  if (view.locked) row.dataset.locked = 'true';
  if (view.pinned) row.dataset.pinned = 'true';

  const main = make(document, 'div', 'community-row-main');
  const title = make(document, 'p', `community-row-title${view.title ? '' : ' is-plain'}`);
  if (view.locked) { const lock = make(document, 'span', 'community-row-lock'); lock.innerHTML = icon('lock'); lock.setAttribute('role', 'img'); lock.setAttribute('aria-label', '鍵つき'); title.append(lock); }
  title.append(make(document, 'span', '', view.title || view.text || (view.locked ? view.gate || '鍵つきの投稿' : '（本文なし）')));
  const meta = make(document, 'div', 'community-row-meta');
  if (view.pinned) { const pin = make(document, 'span', 'community-row-pin'); pin.innerHTML = icon('pin'); pin.setAttribute('role', 'img'); pin.setAttribute('aria-label', '固定'); pin.title = '固定'; meta.append(pin); }
  const kindLabel = COMMUNITY_KIND_LABELS[view.kind];
  if (kindLabel) { const chip = make(document, 'span', 'community-row-kind', kindLabel); chip.dataset.kind = view.kind; meta.append(chip); }
  const author = make(document, 'span', 'community-row-author');
  author.append(make(document, 'span', 'community-row-name', view.author?.name || '（名無し）'));
  const mark = roleMark(document, view.author?.role);
  if (mark) author.append(mark);
  if (view.author?.handle && deps.onAuthor) {
    author.setAttribute('role', 'link'); author.tabIndex = 0;
    author.onclick = (event) => { event.stopPropagation(); deps.onAuthor(view.author.handle); };
  }
  meta.append(author);
  const when = make(document, 'time', 'community-row-time', relTime(view.at));
  if (view.at) { when.dateTime = view.at; when.title = new Date(view.at).toLocaleString('ja-JP'); }
  meta.append(when);
  if (view.held) meta.append(make(document, 'span', 'community-row-flag', '審査中'));
  if (view.edited) meta.append(make(document, 'span', 'community-row-flag', '編集済み'));
  main.append(title, meta);
  row.append(main);

  if (view.thumb && deps.hubAsset && !view.locked) {
    const thumb = make(document, 'span', 'community-row-thumb');
    const img = document.createElement('img');
    img.alt = ''; img.loading = 'lazy'; img.onerror = () => thumb.remove();
    deps.hubAsset(img, view.thumb);
    thumb.append(img);
    if (view.more) thumb.append(make(document, 'span', 'community-row-thumb-more', `+${view.more}`));
    row.append(thumb);
  }

  const stats = make(document, 'div', 'community-row-stats');
  const replies = make(document, 'span', 'community-row-replies');
  replies.innerHTML = icon('reply');
  replies.append(make(document, 'b', '', compactCount(view.replies)));
  replies.setAttribute('role', 'img'); replies.setAttribute('aria-label', `返信 ${view.replies}件`); replies.title = '返信';
  if (!view.replies) replies.dataset.empty = 'true';
  const state = { likes: view.likes, liked: view.liked, pending: false };
  const like = make(document, 'button', 'community-row-like');
  like.type = 'button'; like.title = 'いいね';
  const paint = () => {
    like.innerHTML = icon('heart', state.liked);
    like.append(make(document, 'b', '', state.likes ? compactCount(state.likes) : ''));
    like.setAttribute('aria-pressed', String(state.liked));
    like.setAttribute('aria-label', `いいね ${state.likes}件`);
    like.classList.toggle('is-liked', state.liked);
  };
  paint();
  like.disabled = !deps.onLike || view.locked;
  like.onclick = (event) => {
    event.stopPropagation();
    if (!deps.onLike || state.pending) return;
    const next = !state.liked;
    state.pending = true; state.liked = next; state.likes += next ? 1 : -1; paint();
    Promise.resolve(deps.onLike(view, next)).then((result) => {
      if (Number.isFinite(result?.likes)) state.likes = count(result.likes);
      if (typeof result?.liked === 'boolean') state.liked = result.liked;
    }).catch(() => { state.liked = !next; state.likes += next ? -1 : 1; }).finally(() => { state.pending = false; paint(); });
  };
  stats.append(replies, like);

  const menu = deps.menu ?? [];
  if (menu.length) {
    const wrap = make(document, 'div', 'post-more-wrap community-row-more');
    const button = make(document, 'button', 'post-more');
    button.type = 'button'; button.innerHTML = icon('more');
    button.setAttribute('aria-label', '投稿のその他の操作'); button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); button.title = 'その他';
    const list = make(document, 'div', 'post-repost-menu post-more-menu');
    list.setAttribute('role', 'menu'); list.hidden = true;
    for (const [label, run] of menu) {
      const item = make(document, 'button', '', label);
      item.type = 'button'; item.setAttribute('role', 'menuitem');
      item.onclick = (event) => { event.stopPropagation(); list.hidden = true; button.setAttribute('aria-expanded', 'false'); run(row); };
      list.append(item);
    }
    button.onclick = (event) => { event.stopPropagation(); list.hidden = !list.hidden; button.setAttribute('aria-expanded', String(!list.hidden)); if (!list.hidden) list.querySelector('button')?.focus(); };
    wrap.onclick = (event) => event.stopPropagation();
    wrap.append(button, list);
    stats.append(wrap);
  }
  row.append(stats);

  if (deps.onOpen) {
    row.tabIndex = 0;
    row.onclick = () => deps.onOpen(view);
    row.onkeydown = (event) => { if (event.key === 'Enter' && event.target === row) deps.onOpen(view); };
  }
  row.hubCommunityRow = view;
  return row;
}
