// 動画・楽曲のポスト欄。コメントはHubのポストとして扱う。
// 一覧は /api/client/{videos|music/works}/{id}/posts（新しい順・20件ずつ）、投稿は video_post_create / music_post_create。
// 各行は呼び出し側から渡される renderPost（タイムラインと同じ postCard）で描く。
const videoKey = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/u.test(value);
const musicKey = value => videoKey(value) || (typeof value === 'string' && /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value));
const KINDS = {
  video: { key: videoKey, label: '動画', noun: '動画', list: 'video_posts', page: 'video_posts_page', create: 'video_post_create', path: id => `/v2/videos/${id}`, error: 'invalid_video' },
  music: { key: musicKey, label: '曲', noun: '曲', list: 'music_posts', page: 'music_posts_page', create: 'music_post_create', path: id => `/v2/music/works/${id}`, error: 'invalid_music' },
};
const cursorOk = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._~:|=-]+$/u.test(value);
const LIMIT = 500;

function page(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.posts) || value.posts.length > 100
    || !(value.nextCursor === null || value.nextCursor === undefined || cursorOk(value.nextCursor))) throw Error('invalid_posts');
  for (const post of value.posts) if (!post || typeof post !== 'object' || Array.isArray(post) || typeof post.id !== 'string' || !post.id) throw Error('invalid_posts');
  return { posts: value.posts, nextCursor: value.nextCursor ?? null };
}

export function createVideoPosts(document, { videoId, ...rest }) {
  return createContentPosts(document, { ...rest, kind: 'video', id: videoId });
}

export function createContentPosts(document, { kind = 'video', id: contentId, invoke, renderPost, isCurrent = () => true, state = {} }) {
  const spec = KINDS[kind];
  if (!spec) throw Error('invalid_kind');
  if (!spec.key(contentId)) throw Error(spec.error);
  if (typeof renderPost !== 'function') throw Error('invalid_renderer');
  const element = document.createElement('section');
  element.className = 'detail-section video-posts';
  element.setAttribute('aria-label', kind === 'music' ? '曲のポスト' : '動画のポスト');
  const heading = document.createElement('h3');
  heading.textContent = 'ポスト';
  const note = document.createElement('p');
  note.className = 'meta';
  note.textContent = kind === 'music' ? 'この曲についてのHubのポストです。リポストすると曲へのリンクが付きます。' : 'この動画についてのHubのポストです。リポストすると動画へのリンクが付きます。';
  const status = document.createElement('p');
  status.className = 'meta';
  status.setAttribute('role', 'status');
  const form = document.createElement('form');
  form.className = 'detail-form video-posts-composer';
  const input = document.createElement('textarea');
  input.rows = 3;
  input.maxLength = LIMIT;
  input.setAttribute('aria-label', kind === 'music' ? '曲についてのポスト' : '動画についてのポスト');
  input.value = typeof state.body === 'string' ? state.body : '';
  input.placeholder = kind === 'music' ? 'この曲について書く' : 'この動画について書く';
  const count = document.createElement('span');
  count.className = 'meta';
  const button = (text, action) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'head-action';
    node.textContent = text;
    node.onclick = action;
    return node;
  };
  const send = button('ポストする', null);
  send.type = 'submit';
  send.classList.add('video-posts-send');
  const repost = button('リポスト', () => submit(true));
  const refresh = button('更新', () => reload());
  const list = document.createElement('div');
  list.className = 'video-posts-list';
  const more = button('もっと見る', () => loadMore());
  let posts = [], nextCursor = null, loaded = false, pending = false, disposed = false, generation = 0;
  const current = () => !disposed && isCurrent();
  const usable = () => current() && element.isConnected && !element.closest('[hidden]');
  const active = turn => current() && turn === generation;
  const length = () => input.value.length;
  function paint() {
    element.setAttribute('aria-busy', String(pending));
    input.disabled = pending;
    refresh.disabled = pending;
    count.textContent = `${length()} / ${LIMIT}`;
    send.disabled = pending || !input.value.trim() || length() > LIMIT;
    repost.disabled = pending || !!input.value.trim();
    more.hidden = !loaded || !nextCursor;
    more.disabled = pending;
  }
  function paintList() {
    list.replaceChildren();
    if (loaded && !posts.length) {
      const empty = document.createElement('p');
      empty.className = 'meta';
      empty.textContent = 'まだポストはありません。';
      list.append(empty);
    }
    for (const post of posts) {
      try {
        const card = renderPost(post);
        // この画面の作品へのリンクは繰り返さない。
        for (const link of card.querySelectorAll?.('a[href]') ?? []) {
          try { if (decodeURIComponent(new URL(link.getAttribute('href'), 'http://x').pathname) === spec.path(contentId)) { link.hidden = true; const before = link.previousSibling; if (before?.nodeType === 3) before.data = before.data.replace(/\s+$/u, ''); } } catch { /* 読めないリンクはそのまま */ }
        }
        list.append(card);
      } catch { /* 1件の描画失敗で一覧全体を落とさない */ }
    }
  }
  input.oninput = () => {
    if (!usable() || pending) return;
    state.body = input.value;
    paint();
  };
  form.onsubmit = event => {
    event.preventDefault();
    return submit(false);
  };
  form.append(input, count, send, repost);
  // 件数と「更新」は1行にまとめる。
  const bar = document.createElement('div');
  bar.className = 'video-posts-bar';
  bar.append(status, refresh);
  element.append(heading, note, form, bar, list, more);
  async function reload() {
    if (!current() || pending) return;
    const turn = ++generation;
    pending = true;
    status.textContent = 'ポストを読み込んでいます…';
    paint();
    try {
      const value = page(await invoke('hub_detail', { name: spec.list, ids: [contentId] }));
      if (!active(turn)) return;
      posts = value.posts;
      nextCursor = value.nextCursor;
      loaded = true;
      status.textContent = posts.length ? `${posts.length} 件のポスト` : '';
      paintList();
    } catch {
      if (active(turn)) status.textContent = 'ポストを取得できませんでした。表示中のポストと下書きを保持しています。';
    } finally {
      if (active(turn)) { pending = false; paint(); }
    }
  }
  async function loadMore() {
    if (!usable() || pending || !nextCursor) return;
    const turn = ++generation, cursor = nextCursor;
    pending = true;
    status.textContent = '続きを読み込んでいます…';
    paint();
    try {
      const value = page(await invoke('hub_detail', { name: spec.page, ids: [contentId, cursor] }));
      if (!active(turn)) return;
      if (value.nextCursor === cursor) throw Error('invalid_posts');
      const seen = new Set(posts.map(post => post.id));
      posts = [...posts, ...value.posts.filter(post => !seen.has(post.id))];
      nextCursor = value.nextCursor;
      status.textContent = `${posts.length} 件のポスト`;
      paintList();
    } catch {
      if (active(turn)) status.textContent = '続きを取得できませんでした。もう一度お試しください。';
    } finally {
      if (active(turn)) { pending = false; paint(); }
    }
  }
  async function submit(asRepost) {
    if (!usable() || pending) return;
    const body = asRepost ? '' : input.value.trim();
    if (asRepost ? !!input.value.trim() : (!body || body.length > LIMIT)) return;
    const turn = ++generation;
    pending = true;
    status.textContent = asRepost ? 'リポストしています…' : '投稿しています…';
    paint();
    try {
      const value = await invoke('hub_client_action', { action: spec.create, target: contentId, options: { body } });
      if (!active(turn) || !usable()) return;
      const post = value?.post;
      if (!post || typeof post !== 'object' || typeof post.id !== 'string' || !post.id) throw Error('unconfirmed');
      posts = [post, ...posts.filter(item => item.id !== post.id)];
      state.body = '';
      input.value = '';
      status.textContent = asRepost ? 'リポストしました。' : 'ポストしました。';
      paintList();
    } catch {
      if (active(turn)) status.textContent = '投稿の結果を確認できませんでした。更新して確認してから、もう一度お試しください。';
    } finally {
      if (active(turn)) { pending = false; paint(); }
    }
  }
  const invalidate = () => {
    disposed = true;
    generation++;
    posts = [];
    nextCursor = null;
    state.body = '';
    element.replaceChildren();
  };
  document.defaultView?.addEventListener('hub-account-changed', invalidate);
  paint();
  const ready = reload();
  return {
    element, ready, reload,
    destroy() {
      disposed = true;
      generation++;
      document.defaultView?.removeEventListener('hub-account-changed', invalidate);
      element.remove();
    },
  };
}
