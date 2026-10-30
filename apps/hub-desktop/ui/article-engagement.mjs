// 記事のいいね・コメント欄（Hub Desktop）。
//
// 読み取りは公開面 /api/articles/{id}/comments と、端末の資格で読む自分のいいね状態。
// 書き込み（いいねの付け外し・コメント投稿）は呼び出し側が渡す関数を通す。固定動詞
// article_like_set / article_like_clear / article_comment_create の先は
// /api/client/articles/{id}/like|comments で、Hub 側が Web と同じ規則を適用する。
// DOM は textContent / createElement だけで組み、innerHTML は使わない。

export function parseLikeState(value) {
  const count = Number(value?.likeCount);
  return { likeCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0, liked: value?.liked === true };
}

export function parseCommentPage(value) {
  const comments = Array.isArray(value?.comments) ? value.comments : [];
  return {
    commentsEnabled: value?.commentsEnabled !== false,
    total: Number.isFinite(Number(value?.total)) ? Number(value.total) : comments.length,
    comments: comments
      .filter((c) => c && typeof c.id === 'string' && typeof c.body === 'string')
      .map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
        name: String(c.author?.displayName || c.author?.handle || 'Hubの書き手'),
        handle: typeof c.author?.handle === 'string' ? c.author.handle : '',
      })),
  };
}

/** 接続中のプロフィールが記事の著者かどうか。ハンドルが両方そろって一致するときだけ true。 */
export function isOwnArticle(profile, authorHandle) {
  const mine = typeof profile?.handle === 'string' ? profile.handle.trim().toLowerCase() : '';
  const theirs = typeof authorHandle === 'string' ? authorHandle.trim().toLowerCase() : '';
  return mine !== '' && mine === theirs;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** いいね数の帯。付けているかは読み取りだけなので「いいね済み」の表示に留める。 */
export function renderLikeSummary(doc, like) {
  const row = el(doc, 'p', 'article-like');
  const mark = el(doc, 'span', like.liked ? 'article-like-mark is-liked' : 'article-like-mark', '♥');
  mark.setAttribute('aria-hidden', 'true');
  const count = el(doc, 'span', 'article-like-count', String(like.likeCount));
  row.setAttribute('aria-label', `いいね ${like.likeCount}件${like.liked ? '（いいね済み）' : ''}`);
  row.append(mark, count, el(doc, 'span', 'meta', 'いいね'));
  return row;
}

export const COMMENT_MAX_LENGTH = 2000;

/** 押すといいねを付け外しするボタン。onSet(希望の状態) は新しい状態 {likeCount, liked} を返す。 */
export function renderLikeButton(doc, like, { onSet }) {
  let state = like;
  const button = el(doc, 'button', 'article-like-button');
  button.type = 'button';
  const mark = el(doc, 'span', 'article-like-mark', '♥');
  mark.setAttribute('aria-hidden', 'true');
  const count = el(doc, 'span', 'article-like-count');
  const label = el(doc, 'span', 'meta', 'いいね');
  const note = el(doc, 'span', 'meta article-like-note');
  note.setAttribute('role', 'status');
  button.append(mark, count, label);
  const paint = () => {
    mark.className = state.liked ? 'article-like-mark is-liked' : 'article-like-mark';
    count.textContent = String(state.likeCount);
    button.setAttribute('aria-pressed', String(state.liked));
    button.setAttribute('aria-label', `いいね ${state.likeCount}件${state.liked ? '（いいね済み・押すと外す）' : '（押すと付ける）'}`);
  };
  paint();
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    note.textContent = '';
    try {
      state = parseLikeState(await onSet(!state.liked));
      paint();
    } catch (error) {
      note.textContent = error?.message || 'いいねを変更できませんでした。';
    } finally {
      button.disabled = false;
    }
  };
  const row = el(doc, 'p', 'article-like');
  row.append(button, note);
  return row;
}

/** コメント入力。onSubmit(本文) が成功したら欄を空にして onPosted(コメント) を呼ぶ。本文は textContent でしか使わない。 */
export function renderCommentForm(doc, { onSubmit, onPosted = () => {}, max = COMMENT_MAX_LENGTH }) {
  const form = el(doc, 'form', 'article-comment-form');
  const field = el(doc, 'textarea', 'article-comment-input');
  field.rows = 3;
  field.maxLength = max;
  field.placeholder = 'コメントを書く';
  field.setAttribute('aria-label', 'コメント');
  const send = el(doc, 'button', 'approve', 'コメントする');
  send.type = 'submit';
  send.disabled = true;
  const count = el(doc, 'span', 'meta', `0 / ${max}`);
  const note = el(doc, 'span', 'meta article-comment-note');
  note.setAttribute('role', 'status');
  const bar = el(doc, 'div', 'article-comment-bar');
  bar.append(send, count, note);
  form.append(field, bar);
  field.oninput = () => {
    count.textContent = `${field.value.length} / ${max}`;
    send.disabled = !field.value.trim();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const body = field.value.trim();
    if (!body || send.disabled) return;
    send.disabled = true;
    field.disabled = true;
    note.textContent = '送信中…';
    try {
      const comment = await onSubmit(body);
      field.value = '';
      count.textContent = `0 / ${max}`;
      note.textContent = 'コメントしました。';
      onPosted(comment);
    } catch (error) {
      note.textContent = error?.message || 'コメントを送れませんでした。';
      send.disabled = !field.value.trim();
    } finally {
      field.disabled = false;
    }
  };
  return form;
}

export function renderCommentList(doc, page, { relTime = () => '', form = null, signedOutNote = '' } = {}) {
  const section = el(doc, 'section', 'article-comments');
  section.append(el(doc, 'h3', 'result-heading', page.total ? `コメント ${page.total}件` : 'コメント'));
  if (!page.commentsEnabled) {
    section.append(el(doc, 'p', 'meta', 'この記事ではコメントを受け付けていません。'));
    return section;
  }
  if (!page.comments.length) {
    section.append(el(doc, 'p', 'meta', 'まだコメントはありません。'));
  }
  for (const comment of page.comments) {
    const item = el(doc, 'article', 'article-comment');
    const head = el(doc, 'p', 'meta');
    const who = el(doc, 'strong', '', comment.name);
    head.append(who);
    const tail = [comment.handle ? `@${comment.handle}` : '', relTime(comment.createdAt)].filter(Boolean).join(' · ');
    if (tail) head.append(doc.createTextNode(` ${tail}`));
    item.append(head, el(doc, 'p', 'article-comment-body', comment.body));
    section.append(item);
  }
  if (form) section.append(form);
  else if (signedOutNote) section.append(el(doc, 'p', 'meta', signedOutNote));
  return section;
}
