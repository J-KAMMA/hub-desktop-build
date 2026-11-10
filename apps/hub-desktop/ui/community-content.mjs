// コミュニティとコンテンツのつながり（Hub Desktop）。docs/hub-community-links/DESIGN.md
// - コミュニティ画面の 投稿 / 記事 / 動画 / 音楽
// - 記事・動画・音楽の「〇〇で話す」と、つながったスレッド
// - 作る画面で載せ先を1つ選ぶ選択
// - スレッドの先頭の、もとのコンテンツへのカード
// 説明の文は置かない。短いラベルと記号だけ。ハブの応答は形を確かめてから描く。
export const CONTENT_TABS = Object.freeze([['post', '投稿'], ['article', '記事'], ['video', '動画'], ['music', '音楽']]);
export const THREAD_CONTENT_TYPES = Object.freeze(['article', 'video', 'music']);

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CURSOR = /^[A-Za-z0-9_.:~-]{1,256}$/u;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const make = (document, tag, label = '', className = '') => { const node = document.createElement(tag); if (label) node.textContent = label; if (className) node.className = className; return node; };
const button = (document, label, className, onClick) => { const node = make(document, 'button', label, className); node.type = 'button'; node.onclick = onClick; return node; };

export function parseContentPage(value, type) {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 50) throw Error('community_content_invalid');
  const next = value.nextCursor ?? null;
  if (next !== null && !(typeof next === 'string' && CURSOR.test(next))) throw Error('community_content_invalid');
  const items = value.items.map((item) => {
    if (!object(item) || item.contentType !== type || !ID.test(item.contentId ?? '') || !text(item.title, 400) || !text(item.summary ?? '', 600)) throw Error('community_content_invalid');
    return { contentType: type, contentId: item.contentId, title: item.title, summary: item.summary ?? '',
      authorName: text(item.authorName ?? '', 200) ? item.authorName ?? '' : '', authorHandle: text(item.authorHandle ?? '', 100) ? item.authorHandle ?? '' : '' };
  });
  return { items, nextCursor: next, canModerate: value.canModerate === true };
}

export function parseThreads(value) {
  if (!object(value) || !Array.isArray(value.threads) || value.threads.length > 20) throw Error('community_threads_invalid');
  return value.threads.map((thread) => {
    if (!object(thread) || !ID.test(thread.threadId ?? '') || !ID.test(thread.communityId ?? '') || !text(thread.communityName, 200) || !text(thread.title, 400) || !Number.isSafeInteger(thread.postCount) || thread.postCount < 0) throw Error('community_threads_invalid');
    return { threadId: thread.threadId, communityId: thread.communityId, communityName: thread.communityName, title: thread.title, postCount: thread.postCount };
  });
}

export function parseMine(value) {
  if (!object(value) || !Array.isArray(value.communities) || value.communities.length > 100) throw Error('community_mine_invalid');
  return value.communities.map((community) => {
    if (!object(community) || !ID.test(community.id ?? '') || !text(community.name, 200)) throw Error('community_mine_invalid');
    return { id: community.id, name: community.name };
  });
}

export function parseCard(value) {
  if (!object(value)) throw Error('community_card_invalid');
  const card = value.card;
  if (card === null || card === undefined) return null;
  if (!object(card) || !THREAD_CONTENT_TYPES.includes(card.contentType) || !ID.test(card.contentId ?? '') || !text(card.title, 400) || !text(card.communityName, 200)) throw Error('community_card_invalid');
  return { contentType: card.contentType, contentId: card.contentId, title: card.title, communityName: card.communityName };
}

/** 自分が入っているコミュニティ。ログインしていない・読めないときは空（付け足しの情報で、画面を壊さない）。 */
export async function loadMyCommunities(invoke) {
  try { return parseMine(await invoke('hub_detail', { name: 'community_content_mine', ids: [] })); } catch { return []; }
}

/** 作ったあとに呼ぶ。コンテンツは公開済みなので、失敗は呼び出し側が知らせるだけにする。 */
export async function linkToCommunity(invoke, communityId, contentType, contentId) {
  if (!communityId) return { ok: true, skipped: true };
  try {
    await invoke('hub_client_action', { action: 'community_content_link', target: communityId, options: { contentType, contentId } });
    return { ok: true };
  } catch (error) { return { ok: false, error }; }
}

/** コミュニティ画面の 投稿 / 記事 / 動画 / 音楽。新しい順、続きは「もっと」。運営は掲載を外せる。 */
export function createCommunityContentTabs({ document, communityId, invoke, isCurrent = () => true, open = () => {}, describeError = () => '読み込めませんでした。', initial = 'article', type: fixedType = null }) {
  const root = make(document, 'div', '', 'community-content');
  const tabs = make(document, 'div', '', 'chip-row community-content-tabs');
  tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '掲載されたコンテンツ');
  const list = make(document, 'div', '', 'community-content-list');
  const note = make(document, 'p', '', 'meta warning'); note.hidden = true; note.setAttribute('role', 'alert');
  const more = button(document, 'もっと', 'head-action', () => void load(state.cursor)); more.hidden = true;
  // type を渡すと、その種類だけの一覧（上の見出しの行が種類を選ぶ）。渡さなければ従来どおり自前の行で切り替える。
  if (fixedType) root.append(list, note, more); else root.append(tabs, list, note, more);
  const state = { type: CONTENT_TABS.some(([key]) => key === (fixedType ?? initial)) ? (fixedType ?? initial) : 'article', items: [], cursor: null, canModerate: false, epoch: 0, loading: false, disposed: false };
  const live = () => !state.disposed && isCurrent();

  function paintTabs() {
    tabs.replaceChildren(...CONTENT_TABS.map(([key, label]) => {
      const tab = button(document, label, 'chip', () => { if (state.type !== key) { state.type = key; paintTabs(); void load(null); } });
      tab.dataset.type = key; tab.setAttribute('aria-pressed', String(state.type === key));
      return tab;
    }));
  }
  function paintList() {
    list.replaceChildren(...state.items.map((item) => {
      const card = make(document, 'article', '', 'card result-card community-content-item');
      const title = button(document, item.title || '(無題)', 'link-button', () => open(item.contentType, item));
      title.className = 'community-content-title';
      card.append(title);
      if (item.summary) card.append(make(document, 'p', item.summary, 'meta'));
      const by = [item.authorName, item.authorHandle ? `@${item.authorHandle}` : ''].filter(Boolean).join(' ');
      if (by) card.append(make(document, 'p', by, 'meta'));
      if (state.canModerate) {
        const remove = button(document, '×', 'head-action community-content-remove', () => void takeOff(item));
        remove.setAttribute('aria-label', 'コミュニティから外す'); remove.title = '外す';
        card.append(remove);
      }
      return card;
    }));
    more.hidden = !state.cursor; more.disabled = state.loading;
    list.dataset.empty = String(!state.loading && state.items.length === 0 && note.hidden);
    if (!state.loading && state.items.length === 0 && note.hidden) list.append(make(document, 'p', '–', 'meta community-content-empty'));
  }
  async function load(cursor) {
    const mine = ++state.epoch; const type = state.type;
    state.loading = true; note.hidden = true;
    if (!cursor) { state.items = []; state.cursor = null; }
    paintList();
    try {
      const raw = cursor
        ? await invoke('hub_detail', { name: 'community_content_page', ids: [communityId, type, cursor] })
        : await invoke('hub_detail', { name: 'community_content', ids: [communityId, type] });
      if (mine !== state.epoch || !live()) return;
      const page = parseContentPage(raw, type);
      const seen = new Set(state.items.map((item) => item.contentId));
      state.items = [...state.items, ...page.items.filter((item) => !seen.has(item.contentId))];
      state.cursor = page.nextCursor; state.canModerate = page.canModerate;
    } catch (error) {
      if (mine !== state.epoch || !live()) return;
      note.textContent = describeError(error); note.hidden = false;
    } finally {
      if (mine === state.epoch) { state.loading = false; if (live()) paintList(); }
    }
  }
  async function takeOff(item) {
    try {
      await invoke('hub_client_action', { action: 'community_content_unlink', target: communityId, options: { contentType: item.contentType, contentId: item.contentId } });
      if (!live()) return;
      state.items = state.items.filter((entry) => entry.contentId !== item.contentId); paintList();
    } catch (error) { if (live()) { note.textContent = describeError(error); note.hidden = false; } }
  }
  if (!fixedType) paintTabs();
  const ready = load(null);
  return { root, ready, dispose() { state.disposed = true; state.epoch += 1; }, invalidate() { state.epoch += 1; } };
}

/** 記事・動画・音楽の下。つながったスレッド（件数とリンク）と、自分のコミュニティで話す入口。 */
export function createCommunityTalk({ document, contentType, contentId, invoke, isCurrent = () => true, openThread = () => {}, describeError = () => '開けませんでした。' }) {
  const root = make(document, 'section', '', 'community-talk'); root.hidden = true; root.setAttribute('aria-label', 'コミュニティで話す');
  const actions = make(document, 'div', '', 'actions community-talk-actions');
  const threads = make(document, 'div', '', 'chip-row community-talk-threads');
  const note = make(document, 'p', '', 'meta warning'); note.hidden = true; note.setAttribute('role', 'alert');
  root.append(actions, threads, note);
  let disposed = false, busy = false;
  const live = () => !disposed && isCurrent();
  async function talk(community) {
    if (busy) return; busy = true; note.hidden = true;
    try {
      const result = await invoke('hub_client_action', { action: 'community_content_thread_open', target: community.id, options: { contentType, contentId } });
      if (!live()) return;
      const threadId = result?.threadId;
      if (typeof threadId !== 'string' || !ID.test(threadId)) throw Error('community_thread_invalid');
      openThread(threadId, community);
    } catch (error) { if (live()) { note.textContent = describeError(error); note.hidden = false; } } finally { busy = false; }
  }
  const ready = (async () => {
    const [mine, linked] = await Promise.all([
      loadMyCommunities(invoke),
      invoke('hub_detail', { name: 'community_content_threads', ids: [contentType, contentId] }).then(parseThreads, () => []),
    ]);
    if (!live()) return;
    actions.replaceChildren(...mine.map((community) => button(document, `${community.name}で話す`, 'head-action community-talk-button', () => void talk(community))));
    threads.replaceChildren(...linked.map((thread) => {
      const chip = button(document, `${thread.communityName} ${thread.postCount}`, 'chip community-talk-thread', () => openThread(thread.threadId, { id: thread.communityId, name: thread.communityName }));
      chip.title = thread.title; chip.dataset.threadId = thread.threadId;
      return chip;
    }));
    root.hidden = mine.length === 0 && linked.length === 0;
  })();
  return { root, ready, dispose() { disposed = true; }, invalidate() { disposed = true; } };
}

/** 作る画面に置く選択。入っているコミュニティが無ければ非表示。value() が空なら載せない。 */
export function createCommunityPicker({ document, invoke, isCurrent = () => true }) {
  const root = make(document, 'label', '', 'detail-form-row community-picker'); root.hidden = true;
  const select = make(document, 'select'); select.setAttribute('aria-label', 'コミュニティに載せる');
  root.append(make(document, 'span', '◎', 'community-picker-glyph'), select);
  const none = make(document, 'option', 'コミュニティに載せない'); none.value = '';
  select.append(none);
  let disposed = false, epoch = 0;
  const load = () => {
    const mine = ++epoch;
    return loadMyCommunities(invoke).then((communities) => {
      if (disposed || mine !== epoch || !isCurrent()) return;
      select.replaceChildren(none);
      for (const community of communities) { const option = make(document, 'option', community.name); option.value = community.id; select.append(option); }
      select.value = '';
      root.hidden = communities.length === 0;
    });
  };
  const picker = { root, ready: load(), value: () => select.value, reset() { select.value = ''; }, refresh() { picker.ready = load(); return picker.ready; }, dispose() { disposed = true; } };
  return picker;
}

/** スレッドの先頭。コンテンツから開かれたスレッドだけに出る。通常のスレッドでは何も出ない。 */
export function createThreadContentCard({ document, threadId, invoke, isCurrent = () => true, openContent = () => {} }) {
  const root = make(document, 'div', '', 'community-thread-card'); root.hidden = true;
  let disposed = false;
  const ready = invoke('hub_detail', { name: 'thread_content_card', ids: [threadId] }).then(parseCard).then((card) => {
    if (disposed || !isCurrent() || !card) return;
    const kinds = { article: '記事', video: '動画', music: '音楽' };
    const open = button(document, card.title, 'link-button community-thread-card-title', () => openContent(card.contentType, card));
    root.append(make(document, 'p', `${kinds[card.contentType]}・${card.communityName}`, 'meta'), open);
    root.hidden = false;
  }, () => {});
  return { root, ready, dispose() { disposed = true; } };
}
