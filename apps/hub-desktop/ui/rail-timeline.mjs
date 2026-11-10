// 右列のタイムライン（スマホ型）。上の切り替え 投稿 / スレッド / グループ、その下の 2つ目の切り替え。
// docs/hub-groups/DESIGN.md の表：
//   投稿     おすすめ / フォロー中 / 人気
//   スレッド おすすめ / 参加中・追跡中 / 人気
//   グループ おすすめ / 参加中 / 人気
// 読み出し：投稿は hub_feed（scope = recommended / following / popular）。スレッドとグループは接続中ならサーバーの順位
// （hub_client の thread_rankings_* / community_rankings_*、docs/hub-groups/DESIGN.md「2. 順位」）をそのまま使う。
// 非公開グループ（グループDM）は hub_client の conversations から「参加中」にだけ足す。
// 未接続のときの おすすめ・人気 だけ、公開の一覧（hub_resource）を端末で並べ替える（rankThreads / rankGroups）。
// おすすめの材料は Hub の中で本人がしたこと（フォロー中の投稿の札・参加しているグループ）だけ。閲覧の履歴や他のサービスの情報は使わない。
// 非公開のグループは おすすめ にも 人気 にも出さない（参加中にだけ出る）。

import { createRailSubTabs } from "./rail-subtabs.mjs";
import { createPostRow } from "./post-row.mjs";
import { threadRowMeta } from "./thread-list-meta.mjs";
import * as panels from "./rail-panels.mjs";

export const TIMELINE_KINDS = [["posts", "投稿"], ["threads", "スレッド"], ["groups", "グループ"]];
export const TIMELINE_SORTS = {
  posts: [["recommended", "おすすめ"], ["following", "フォロー中"], ["popular", "人気"]],
  threads: [["recommended", "おすすめ"], ["mine", "参加中・追跡中"], ["popular", "人気"]],
  groups: [["recommended", "おすすめ"], ["joined", "参加中"], ["popular", "人気"]],
};
export const TIMELINE_KEY = "hub.desktop.railTimeline.v1";
const DAY = 86400000;

export function normalizeTimelineState(raw) {
  const kinds = TIMELINE_KINDS.map(([key]) => key);
  const kind = kinds.includes(raw?.kind) ? raw.kind : "posts";
  const sorts = {};
  for (const key of kinds) {
    const allowed = TIMELINE_SORTS[key].map(([name]) => name);
    sorts[key] = allowed.includes(raw?.sorts?.[key]) ? raw.sorts[key] : "recommended";
  }
  return { kind, sorts };
}

// --- 並べ替え（端末側。サーバーが返した範囲だけを材料にする） ---

const norm = (value) => String(value ?? "").toLowerCase();
const time = (value) => { const at = Date.parse(value); return Number.isFinite(at) ? at : 0; };

// 興味の語：フォロー中のタグ、フォロー中の投稿の札、参加しているグループの名前・分類。英数字は2文字未満を捨てる（漢字・かなは1文字でも語になる）。
export function interestTerms({ followingPosts = [], followedTags = [], joinedGroups = [] } = {}) {
  const terms = new Set();
  const add = (value) => { const text = norm(value).trim(); if (text.length <= 40 && (text.length >= 2 || /[぀-ヿ㐀-鿿]/u.test(text))) terms.add(text); };
  for (const tag of followedTags) add(String(tag).replace(/^#/, ""));
  for (const post of followingPosts) for (const tag of Array.isArray(post?.tags) ? post.tags : []) add(typeof tag === "string" ? tag.replace(/^#/, "") : tag?.name);
  for (const group of joinedGroups) { add(group?.name ?? group?.title); add(group?.category); }
  return [...terms];
}
export const interestScore = (text, terms) => { const haystack = norm(text); return terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0); };

export const isPublicGroup = (item) => item?.visibility === "public";

export function threadIsMine(thread, viewerId) {
  return Boolean(viewerId && thread?.authorProfileId === viewerId) || thread?.viewerFollowing === true || thread?.viewerTracking === true || thread?.tracked === true;
}

// threads: [{id,title,boardKey,postCount,updatedAt,...}]
export function rankThreads(threads, sort, { terms = [], viewerId = null, now = Date.now() } = {}) {
  const items = (Array.isArray(threads) ? threads : []).filter((item) => item?.id);
  const byRecent = (a, b) => time(b.updatedAt) - time(a.updatedAt);
  if (sort === "mine") return items.filter((item) => threadIsMine(item, viewerId)).sort(byRecent);
  const open = items.filter((item) => item.status !== "closed");
  if (sort === "popular") {
    // 「今書き込みの多い」：返信の数を、最後の書き込みからの経過で割る。サーバーが期間ごとの数を返さないための代用。
    const hot = (item) => Math.max(0, (item.postCount ?? 0) - 1) / (1 + Math.max(0, now - time(item.updatedAt)) / DAY);
    return open.sort((a, b) => hot(b) - hot(a) || byRecent(a, b));
  }
  const score = (item) => interestScore(`${item.title ?? ""} ${item.boardKey ?? ""}`, terms);
  return open.sort((a, b) => score(b) - score(a) || byRecent(a, b));
}

// 公開グループ（コミュニティ）と非公開グループ（グループDM）を同じ形にする。
export function groupModels({ communities = [], memberships = [], conversations = null } = {}) {
  const joinedIds = new Set((Array.isArray(memberships) ? memberships : []).filter((m) => m && ["active", "muted"].includes(m.status)).map((m) => m.communityId));
  const publics = (Array.isArray(communities) ? communities : []).filter((item) => item?.id).map((item) => ({
    key: `public:${item.id}`, kind: "public", id: item.id, title: item.name || "グループ", text: item.description || "",
    at: item.lastMessageAt ?? item.lastActivityAt ?? item.updatedAt ?? "", count: Number.isSafeInteger(item.memberCount) ? item.memberCount : null,
    activity: Number.isSafeInteger(item.recentMessageCount) ? item.recentMessageCount : null,
    category: item.category ?? "", imageUrl: item.imageUrl ?? null, joined: joinedIds.has(item.id), visibility: item.visibility ?? "",
    unread: 0, raw: item,
  }));
  const privates = [];
  if (conversations && Array.isArray(conversations.conversations)) {
    const profiles = new Map((Array.isArray(conversations.profiles) ? conversations.profiles : []).map((p) => [p.id, p]));
    const self = conversations.currentProfileId;
    for (const conversation of conversations.conversations) {
      if (!conversation?.id || !Array.isArray(conversation.participantIds) || conversation.participantIds.length <= 2) continue;
      const others = conversation.participantIds.filter((id) => id !== self).map((id) => profiles.get(id)?.displayName || profiles.get(id)?.handle || "メンバー");
      const title = others.length > 3 ? `${others.slice(0, 3).join("、")} ほか${others.length - 3}人` : others.join("、") || "グループ";
      privates.push({
        key: `private:${conversation.id}`, kind: "private", id: conversation.id, title, text: "", at: conversation.lastMessageAt ?? "",
        count: conversation.participantIds.length, activity: null, category: "", imageUrl: null, joined: true, visibility: "private",
        unread: conversation.unreadCountByProfileId?.[self] ?? 0, raw: conversation,
      });
    }
  }
  return [...publics, ...privates];
}

// サーバーの順位（community-rankings）の1件を、グループ行の形にする。本文は無い（最後の書き込みの id と時刻だけ）。
export function serverGroupModel(item) {
  return {
    key: `public:${item.id}`, kind: "public", id: item.id, title: item.name || "グループ", text: "", at: item.lastMessageAt ?? "",
    count: null, activity: null, category: item.category ?? "", imageUrl: item.imageUrl ?? null, joined: item.joined === true,
    visibility: item.visibility ?? "", unread: 0, raw: item,
  };
}

export function rankGroups(models, sort, { terms = [] } = {}) {
  const items = Array.isArray(models) ? models : [];
  const byRecent = (a, b) => time(b.at) - time(a.at);
  if (sort === "joined") return items.filter((item) => item.joined).sort(byRecent);
  // おすすめ・人気には公開で、まだ入っていないものだけ。非公開は絶対に混ぜない。
  const open = items.filter((item) => item.kind === "public" && isPublicGroup(item) && !item.joined);
  if (sort === "popular") {
    // 「今動きの多い」：サーバーが直近の書き込み数（recentMessageCount）を返すならそれ、返さなければ人数で代用。
    const measured = open.some((item) => item.activity !== null);
    const heat = (item) => measured ? item.activity ?? 0 : item.count ?? 0;
    return open.sort((a, b) => heat(b) - heat(a) || byRecent(a, b));
  }
  const score = (item) => interestScore(`${item.title} ${item.category} ${item.text}`, terms);
  return open.sort((a, b) => score(b) - score(a) || (b.count ?? 0) - (a.count ?? 0));
}

// --- 引っ張って更新（スマホの作法の代わり）：先頭で上へ強く送る／引き下げると更新 ---
export function attachPullRefresh(target, { scroller = () => target, onRefresh, threshold = 90 }) {
  let pull = 0, start = null, wheelSum = 0, wheelAt = 0;
  const atTop = () => (scroller()?.scrollTop ?? 0) <= 0;
  const fire = () => { pull = 0; wheelSum = 0; start = null; onRefresh(); };
  const onWheel = (event) => {
    if (!atTop() || event.deltaY >= 0) { wheelSum = 0; return; }
    const now = Date.now();
    if (now - wheelAt > 600) wheelSum = 0;
    wheelAt = now; wheelSum += event.deltaY;
    if (wheelSum <= -threshold * 1.5) fire();
  };
  const onStart = (event) => { start = atTop() ? event.touches?.[0]?.clientY ?? null : null; pull = 0; };
  const onMove = (event) => { if (start === null) return; pull = (event.touches?.[0]?.clientY ?? start) - start; };
  const onEnd = () => { if (start !== null && pull >= threshold) fire(); start = null; pull = 0; };
  target.addEventListener("wheel", onWheel, { passive: true });
  target.addEventListener("touchstart", onStart, { passive: true });
  target.addEventListener("touchmove", onMove, { passive: true });
  target.addEventListener("touchend", onEnd);
  return () => {
    target.removeEventListener("wheel", onWheel); target.removeEventListener("touchstart", onStart);
    target.removeEventListener("touchmove", onMove); target.removeEventListener("touchend", onEnd);
  };
}

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// deps: relTime, hubAsset, icon, paintAvatar, renderPost(post, {onOpen}), signedIn(), connect(), viewerId(), friendlyError(error),
//       openPost(post,row), openThread(thread,row), openGroup(group,row), compose(kind), storage, observe(callback)->{observe,disconnect}
export function createRailTimeline({ document, invoke, deps, now = () => Date.now() }) {
  const { relTime, hubAsset, icon, paintAvatar, renderPost, signedIn, connect, viewerId, friendlyError = String, storage = null } = deps;
  const state = normalizeTimelineState((() => { try { return JSON.parse(storage?.getItem(TIMELINE_KEY) ?? "null"); } catch { return null; } })());
  const save = () => { try { storage?.setItem(TIMELINE_KEY, JSON.stringify(state)); } catch { /* 保存できなくても動く */ } };

  const root = el(document, "div", "rail-tl");
  const kinds = createRailSubTabs(document, { label: "タイムラインの種類", tabs: TIMELINE_KINDS, selected: state.kind, onSelect: (kind) => selectKind(kind) });
  const sortHost = el(document, "div", "rail-tl-sorts");
  const status = el(document, "p", "meta rail-tl-status");
  status.setAttribute("role", "status");
  const list = el(document, "div", "rail-tl-list");
  const sentinel = el(document, "div", "rail-tl-sentinel");
  sentinel.setAttribute("aria-hidden", "true");
  const more = el(document, "button", "rail-tl-more", "続きを表示");
  more.type = "button";
  more.hidden = true;
  const compose = el(document, "button", "rail-tl-compose");
  compose.type = "button";
  compose.innerHTML = icon("compose");
  root.append(kinds.element, sortHost, status, list, sentinel, more, compose);

  let revision = 0, paintedKey = null;
  const feeds = new Map();
  let groupSource = null, followingPosts = [], followedTags = [], termsLoaded = false;
  const currentTerms = () => interestTerms({ followingPosts, followedTags, joinedGroups: (groupSource ?? []).filter((g) => g.joined && g.kind === "public").map((g) => g.raw) });
  let io = null;

  const keyOf = () => `${state.kind}:${state.sorts[state.kind]}`;
  const feedFor = () => {
    const key = keyOf();
    if (!feeds.has(key)) feeds.set(key, { items: [], raw: [], offset: 0, cursor: null, hasMore: false, loading: false, loaded: false });
    return feeds.get(key);
  };

  function paintSorts() {
    const sorts = createRailSubTabs(document, {
      label: "並び", tabs: TIMELINE_SORTS[state.kind], selected: state.sorts[state.kind], className: "rail-subtabs--chips",
      onSelect: (sort) => { state.sorts[state.kind] = sort; save(); void load(); },
    });
    sortHost.replaceChildren(sorts.element);
    compose.hidden = state.kind === "groups";
    const label = state.kind === "threads" ? "スレッドを立てる" : "投稿する";
    compose.setAttribute("aria-label", label);
    compose.title = label;
  }
  const rankingName = (kind, sort) => `${kind === "threads" ? "thread" : "community"}_rankings_${sort}`;
  // サーバーの順位は接続していないと読めない。未接続の おすすめ・人気 は公開の一覧を端末で並べる。
  const serverRanked = (kind, sort) => signedIn() && (kind === "threads" || kind === "groups") && Boolean(TIMELINE_SORTS[kind].some(([name]) => name === sort));
  function selectKind(kind) { state.kind = kind; save(); paintSorts(); void load(); }

  function threadCard(thread) {
    // 一覧と同じ行：題（最大2行）、その下に 種類・返信数・解決済み・最後の動き。
    const row = el(document, "article", "thread-row thread-list-card rail-tl-card");
    row.tabIndex = 0;
    row.setAttribute("role", "link");
    row.setAttribute("aria-expanded", "false");
    row.append(el(document, "div", "thread-row-title", thread.title || "スレッド"), threadRowMeta(document, thread, { relTime, icon }));
    const open = () => deps.openThread(thread, row);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => { if (event.target === row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); } });
    return row;
  }

  function groupCard(group) {
    const meta = [group.category, group.count !== null ? `${group.count.toLocaleString("ja-JP")}人` : ""].filter(Boolean).join(" · ");
    let row = null;
    row = createPostRow(document, {
      authorName: group.title, time: group.at ? relTime(group.at) : "", body: [meta, group.text].filter(Boolean).join("　") || "—",
      avatarUrl: group.imageUrl ?? undefined, onOpen: () => deps.openGroup(group, row), icon, paintAvatar, hubAsset,
      classes: ["rail-tl-card", `rail-tl-group--${group.kind}`],
    });
    // 非公開には鍵の印だけを付ける（見せ方を揃え、中身の扱いは混ぜない）。
    if (group.kind === "private" || group.visibility === "private") {
      const lock = el(document, "span", "rail-tl-lock");
      lock.setAttribute("role", "img");
      lock.setAttribute("aria-label", "非公開");
      lock.title = "非公開";
      lock.innerHTML = icon("lock");
      row.querySelector(".post-author-link")?.append(lock);
    }
    if (group.unread > 0) row.querySelector(".post-head")?.append(el(document, "span", "rail-row-count", panels.railCount(group.unread)));
    row.setAttribute("aria-expanded", "false");
    return row;
  }

  function postCard(post) {
    let node = null;
    node = renderPost(post, { onOpen: () => deps.openPost(post, node) });
    return node;
  }

  const stateBox = (kind, args) => panels.railState(document, kind, args);

  function emptyBox(feed) {
    const key = keyOf();
    // おすすめの材料（フォロー・参加）が無い：アイコンと短い言葉だけ。
    if (feed?.noSignals) {
      const box = stateBox("empty", { title: state.kind === "threads" ? "フォローや参加で表示" : "参加やフォローで表示" });
      const mark = el(document, "span", "rail-state-icon");
      mark.setAttribute("aria-hidden", "true");
      mark.innerHTML = icon("userplus");
      box.prepend(mark);
      return box;
    }
    if (["posts:following", "threads:mine", "groups:joined"].includes(key) && !signedIn()) {
      return stateBox("signedOut", { title: "接続すると表示されます", detail: "フォロー・参加・追跡はHubのアカウントに結び付きます。", actions: [{ label: "Desktopを接続", onClick: () => connect() }] });
    }
    // 説明の文は置かない（記号と短い言葉だけ）。
    return stateBox("empty", { title: "まだありません" });
  }

  function renderItems(feed, { append = false, from = 0 } = {}) {
    paintedKey = keyOf();
    const make = state.kind === "posts" ? postCard : state.kind === "threads" ? threadCard : groupCard;
    // 投稿は足していく（返信欄などの途中の状態を壊さない）。スレッド・グループは並べ替えるので描き直す。
    if (append) { list.append(...feed.items.slice(from).map(make)); return; }
    list.replaceChildren(...(feed.items.length ? feed.items.map(make) : [emptyBox(feed)]));
  }

  async function ensureTerms() {
    if (termsLoaded) return;
    termsLoaded = true;
    if (!signedIn()) return;
    // フォロー中のタグ（Hub の /api/client/sidebar）と、フォロー中の人の投稿の札。どちらも本人が Hub の中でしたことだけ。
    const [posts, sidebar] = await Promise.allSettled([invoke("hub_feed", { scope: "following", limit: 20 }), invoke("hub_detail", { name: "sidebar", ids: ["feed"] })]);
    followingPosts = posts.status === "fulfilled" && Array.isArray(posts.value?.posts) ? posts.value.posts : [];
    followedTags = sidebar.status === "fulfilled" && Array.isArray(sidebar.value?.followedTags) ? sidebar.value.followedTags.filter((tag) => typeof tag === "string").slice(0, 100) : [];
  }

  async function fetchGroups() {
    const [communities, conversations] = await Promise.allSettled([
      invoke("hub_resource", { resource: "communities", query: "" }),
      signedIn() ? invoke("hub_client", { name: "conversations" }) : Promise.resolve(null),
    ]);
    if (communities.status === "rejected" && conversations.status === "rejected") throw communities.reason;
    groupSource = groupModels({
      communities: communities.status === "fulfilled" ? communities.value?.communities : [],
      memberships: communities.status === "fulfilled" ? communities.value?.memberships : [],
      conversations: conversations.status === "fulfilled" ? conversations.value : null,
    });
  }

  async function fetchPrivateGroups() {
    try {
      const data = await invoke("hub_client", { name: "conversations" });
      return groupModels({ conversations: data }).filter((item) => item.kind === "private");
    } catch { return []; }
  }

  async function fetchPage(feed, mine, { first = false } = {}) {
    const kind = state.kind, sort = state.sorts[kind];
    if (kind === "posts") {
      const data = await invoke("hub_feed", { scope: sort, limit: 20, offset: feed.offset, cursor: feed.cursor });
      if (mine !== revision) return;
      const known = new Set(feed.items.map((post) => post.id));
      const posts = Array.isArray(data?.posts) ? data.posts : [];
      const fresh = posts.filter((post) => post?.id && !known.has(post.id));
      const from = feed.items.length;
      feed.items = [...feed.items, ...fresh];
      feed.offset = data?.nextOffset ?? feed.offset + posts.length;
      feed.cursor = data?.nextCursor ?? null;
      feed.hasMore = data?.hasMore === true && fresh.length > 0;
      feed.loaded = true; feed.loading = false;
      if (first) renderItems(feed); else renderItems(feed, { append: true, from });
    } else if (kind === "threads") {
      if (serverRanked("threads", sort)) {
        const data = await invoke("hub_client", { name: rankingName("threads", sort), cursor: feed.cursor ?? undefined });
        if (mine !== revision) return;
        const known = new Set(feed.items.map((item) => item.id));
        const threads = (Array.isArray(data?.threads) ? data.threads : []).filter((item) => item?.id && !known.has(item.id));
        const from = feed.items.length;
        feed.items = [...feed.items, ...threads];
        feed.cursor = typeof data?.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
        feed.hasMore = feed.cursor !== null;
        feed.noSignals = data?.noSignals === true && feed.items.length === 0;
        feed.loaded = true; feed.loading = false;
        if (first) renderItems(feed); else renderItems(feed, { append: true, from });
        more.hidden = !feed.hasMore || io !== null;
        status.textContent = "";
        return;
      }
      const needAccount = sort === "mine" && !signedIn();
      if (!needAccount) await ensureTerms();
      const data = needAccount ? { threads: [] } : await invoke("hub_resource", { resource: "threads", query: "", offset: feed.offset });
      if (mine !== revision) return;
      const raw = Array.isArray(data?.threads) ? data.threads : [];
      const known = new Set(feed.raw.map((item) => item.id));
      feed.raw = [...feed.raw, ...raw.filter((item) => item?.id && !known.has(item.id))];
      feed.offset += raw.length;
      feed.hasMore = raw.length > 0 && (data?.hasMore ?? (Number.isSafeInteger(data?.total) ? feed.offset < data.total : false));
      feed.items = rankThreads(feed.raw, sort, { terms: currentTerms(), viewerId: viewerId(), now: now() });
      feed.loaded = true; feed.loading = false;
      renderItems(feed);
    } else {
      if (serverRanked("groups", sort)) {
        const data = await invoke("hub_client", { name: rankingName("groups", sort), cursor: feed.cursor ?? undefined });
        // 参加中には、サーバーの順位に出ない非公開グループ（3人以上のDM）を最初のページで足す。
        const privates = sort === "joined" && first ? await fetchPrivateGroups() : [];
        if (mine !== revision) return;
        const known = new Set(feed.items.map((item) => item.key));
        const fresh = (Array.isArray(data?.groups) ? data.groups : []).filter((item) => item?.id).map(serverGroupModel).filter((item) => !known.has(item.key));
        const from = feed.items.length;
        feed.items = sort === "joined" && first ? [...fresh, ...privates].sort((a, b) => time(b.at) - time(a.at)) : [...feed.items, ...fresh];
        feed.cursor = typeof data?.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
        feed.hasMore = feed.cursor !== null;
        feed.noSignals = data?.noSignals === true && feed.items.length === 0;
        feed.loaded = true; feed.loading = false;
        if (first || sort === "joined") renderItems(feed); else renderItems(feed, { append: true, from });
        more.hidden = !feed.hasMore || io !== null;
        status.textContent = "";
        return;
      }
      if (!groupSource) await fetchGroups();
      if (sort !== "popular") await ensureTerms();
      if (mine !== revision) return;
      feed.items = rankGroups(groupSource, sort, { terms: currentTerms() });
      feed.hasMore = false; feed.loaded = true; feed.loading = false;
      renderItems(feed);
    }
    more.hidden = !feed.hasMore || io !== null;
    status.textContent = "";
  }

  async function load({ force = false } = {}) {
    const mine = ++revision;
    if (force) { feeds.delete(keyOf()); termsLoaded = false; followingPosts = []; followedTags = []; if (state.kind === "groups") groupSource = null; }
    const feed = feedFor();
    if (feed.loaded) {
      status.textContent = "";
      if (paintedKey !== keyOf() || !list.childElementCount) renderItems(feed);
      more.hidden = !feed.hasMore || io !== null;
      return;
    }
    status.textContent = "";
    list.replaceChildren(stateBox("loading", {}));
    more.hidden = true;
    feed.loading = true;
    try { await fetchPage(feed, mine, { first: true }); }
    catch (error) {
      if (mine !== revision) return;
      feed.loading = false;
      list.replaceChildren(stateBox("error", { title: "読み込めませんでした", detail: friendlyError(error), actions: [{ label: "再読み込み", onClick: () => void load({ force: true }) }] }));
    }
  }

  async function loadMore() {
    const feed = feedFor();
    if (feed.loading || !feed.hasMore || !feed.loaded) return;
    feed.loading = true;
    status.textContent = "読み込み中…";
    const mine = revision;
    try { await fetchPage(feed, mine); }
    catch (error) { feed.loading = false; if (mine === revision) status.textContent = friendlyError(error); }
  }
  more.onclick = () => void loadMore();
  compose.onclick = () => deps.compose(state.kind);

  // 無限スクロール：末尾の見張りが見えたら続きを読む。IntersectionObserver が無ければ「続きを表示」を使う。
  if (typeof deps.observe === "function") {
    io = deps.observe(() => void loadMore()) ?? null;
    io?.observe(sentinel);
  }
  const detach = attachPullRefresh(root, { scroller: () => root.closest(".rail-view") ?? root, onRefresh: () => void load({ force: true }) });
  paintSorts();

  return {
    element: root, load, loadMore,
    refresh: () => load({ force: true }),
    get state() { return state; },
    select(kind) { kinds.set(kind); selectKind(kind); },
    reset() { paintedKey = null; feeds.clear(); groupSource = null; termsLoaded = false; followingPosts = []; followedTags = []; revision++; },
    destroy() { detach(); io?.disconnect?.(); },
  };
}
