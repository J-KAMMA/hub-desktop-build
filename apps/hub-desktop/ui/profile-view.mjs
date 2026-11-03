// プロフィールの本文（固定の投稿・種類別のタブ・フォロー/フォロワーの一覧・リンク・登録時期）。
// 中身は /api/client/me と /api/client/profiles/{handle} が返す範囲だけ。返らない種類のタブは作らない。
// 記事・動画・音楽・研究・マーケットは、プロフィール応答の `kinds`（その種類が1件でもあるか）でタブを出し、
// 開いたときに1ページだけ読む（本人のプロフィールは常に出し、空なら作る入口を添える）。コードは公開の一覧を先に確かめる。
// 音楽は Hub のカタログに本人が登録した曲だけ（apps/music の作り手をHubのプロフィールへ結び付けない）。
// ウォレットのアドレス・Accountの識別子・メールは受け取っても描かない（profilePeople と profileLinks で落とす）。

const HANDLE = /^[A-Za-z0-9_.-]{1,64}$/;

export function profileJoinedLabel(value) {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return `${date.getFullYear()}年${date.getMonth() + 1}月から利用`;
}

export function profileShareUrl(origin, handle) {
  if (typeof handle !== "string" || !HANDLE.test(handle)) return null;
  try {
    const base = new URL(origin);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    return new URL(`/v2/profile/${encodeURIComponent(handle)}`, base.origin).href;
  } catch { return null; }
}

export function profileLinks(links) {
  if (!Array.isArray(links)) return [];
  const out = [];
  for (const link of links) {
    let url;
    try { url = new URL(String(link?.url ?? "")); } catch { continue; }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) continue;
    const host = url.hostname.replace(/^www\./, "");
    const label = String(link?.label ?? "").trim().slice(0, 80);
    out.push({ url: url.href, host, label: label || host });
    if (out.length === 8) break;
  }
  return out;
}

// 一覧に出す人は id・ハンドル・表示名・顔だけ。ほかの欄は持ち込まない。
export function profilePeople(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p.handle === "string" && HANDLE.test(p.handle)).map((p) => ({
    id: String(p.id ?? ""),
    handle: p.handle,
    displayName: typeof p.displayName === "string" ? p.displayName : "",
    avatarUrl: typeof p.avatarUrl === "string" ? p.avatarUrl : undefined,
  }));
}

export function profileContent(data) {
  const all = Array.isArray(data?.posts) ? data.posts : [];
  const pinned = data?.pinnedPostId ? all.find((post) => post?.id === data.pinnedPostId) ?? null : null;
  // 返信（replyToPostId を持つ投稿）は「返信」のタブへ。「投稿」は返信でないものだけ。
  const isReply = (post) => typeof post?.replyToPostId === "string" && post.replyToPostId !== "";
  const rest = pinned ? all.filter((post) => post !== pinned) : all;
  return {
    pinned,
    posts: rest.filter((post) => !isReply(post)),
    replies: rest.filter(isReply),
    media: all.filter((post) => Array.isArray(post?.images) && post.images.length > 0),
    threads: Array.isArray(data?.threads) ? data.threads : [],
    communities: Array.isArray(data?.communities) ? data.communities : [],
  };
}

// 投稿は空でも出す（空の案内を見せる場所）。ほかは中身がある種類だけ。
export function profileTabs(data) {
  const content = profileContent(data);
  const tabs = [{ key: "posts", label: "投稿", count: content.posts.length + (content.pinned ? 1 : 0) }];
  if (content.replies.length) tabs.push({ key: "replies", label: "返信", count: content.replies.length });
  if (content.media.length) tabs.push({ key: "media", label: "メディア", count: content.media.length });
  if (content.threads.length) tabs.push({ key: "threads", label: "スレッド", count: content.threads.length });
  if (content.communities.length) tabs.push({ key: "communities", label: "コミュニティ", count: content.communities.length });
  return tabs;
}

/**
 * 作ったものの種類。記事・動画・音楽・研究・マーケットは Hub のプロフィール応答の `kinds`（あるかどうか）で
 * タブを出し、開いたときに profile_kind で1ページだけ読む。コードだけは公開の一覧を先に1回確かめる。
 * detail は端末の許可表（hub_client.rs）の名前。
 */
export const PROFILE_WORK_KINDS = [
  { key: "articles", label: "記事", detail: "profile_kind", create: "記事を書く" },
  { key: "videos", label: "動画", detail: "profile_kind", create: "動画を投稿する" },
  { key: "music", label: "音楽", detail: "profile_kind", create: "曲を登録する" },
  { key: "research", label: "研究", detail: "profile_kind", create: "プロジェクトを作る" },
  { key: "market", label: "マーケット", detail: "profile_kind", create: "出品する" },
  { key: "code", label: "コード", detail: "profile_code", create: "" },
];
// タブの並び：投稿・返信・記事・動画・音楽・研究・マーケット、そのあとにその他。
export const PROFILE_TAB_ORDER = ["posts", "replies", "articles", "videos", "music", "research", "market", "media", "threads", "code", "communities"];
const KIND_KEYS = PROFILE_WORK_KINDS.filter((kind) => kind.detail === "profile_kind").map((kind) => kind.key);
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const MARKET_SOURCES = new Set(["listing", "game", "product", "classified", "work"]);
const RESEARCH_STATUS = { draft: "下書き", active: "進行中", paused: "一時停止", completed: "完了" };

/** 一覧の応答を描ける形へ。題名の無い行・形の崩れた行は落とす。raw は各画面の行表示にそのまま渡す元の行。 */
export function profileWorkPage(kind, payload) {
  const list = kind === "code" ? payload?.repositories : KIND_KEYS.includes(kind) ? payload?.items : null;
  const items = [];
  for (const row of Array.isArray(list) ? list : []) {
    if (!row || typeof row !== "object") continue;
    if (kind === "code") {
      if (typeof row.owner !== "string" || !HANDLE.test(row.owner) || typeof row.name !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(row.name)) continue;
      items.push({ kind, id: String(row.id ?? row.name), title: row.name, meta: typeof row.description === "string" ? row.description : "", owner: row.owner, name: row.name });
      continue;
    }
    if (typeof row.id !== "string" || !row.id || typeof row.title !== "string" || !row.title.trim()) continue;
    if (kind === "market" && (!MARKET_SOURCES.has(row.source) || (row.source === "game" && !(typeof row.slug === "string" && row.slug)))) continue;
    const meta = row.locked === true ? "閲覧条件つき"
      : kind === "videos" ? (typeof row.duration === "string" ? row.duration : "")
      : kind === "music" ? (typeof row.artist === "string" ? row.artist : "")
      : kind === "research" ? (RESEARCH_STATUS[row.status] ?? "")
      : kind === "market" ? [typeof row.priceLabel === "string" ? row.priceLabel : "", typeof row.providerLabel === "string" ? row.providerLabel : ""].filter(Boolean).join(" · ")
      : (typeof row.summary === "string" ? row.summary : "");
    items.push({ kind, id: row.id, title: row.title, meta, raw: row });
  }
  const next = typeof payload?.nextCursor === "string" && CURSOR.test(payload.nextCursor) ? payload.nextCursor : null;
  return { items, nextCursor: next };
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function count(value) {
  return value != null && value !== "" && Number.isFinite(Number(value)) ?Number(value).toLocaleString("ja-JP") : "—";
}

/**
 * 件数（投稿・フォロワー・フォロー中）。一覧があれば押すと開く。
 * deps.onConnections(kind) が無い、または一覧が無いときはただの数字。
 */
export function renderProfileStats(doc, data, deps = {}) {
  const wrap = el(doc, "div", "profile-stats");
  const followers = Array.isArray(data?.followers);
  const following = Array.isArray(data?.followingProfiles);
  const entries = [
    ...(deps.omitPosts ? [] : [["posts", data?.postCount, "投稿", false]]),
    ["followers", data?.followerCount, "フォロワー", followers],
    ["following", data?.followingCount, "フォロー中", following],
  ];
  for (const [kind, value, label, openable] of entries) {
    const item = el(doc, openable && deps.onConnections ? "button" : "span", "profile-stat");
    if (item.tagName === "BUTTON") {
      item.type = "button";
      item.dataset.connections = kind;
      item.onclick = () => deps.onConnections(kind);
    }
    item.append(el(doc, "b", null, count(value)), el(doc, "span", null, label));
    wrap.append(item);
  }
  return wrap;
}

/** リンクと登録時期の行。リンクは deps.openUrl で開く（アプリ内のブラウザ）。 */
export function renderProfileFacts(doc, data, deps = {}) {
  const row = el(doc, "div", "profile-facts");
  for (const link of profileLinks(data?.externalLinks)) {
    const button = el(doc, "button", "profile-fact profile-link");
    button.type = "button";
    button.title = link.url;
    button.append(el(doc, "span", "profile-fact-icon", "↗"), el(doc, "span", null, link.label));
    button.onclick = () => deps.openUrl?.(link.url);
    row.append(button);
  }
  const joined = profileJoinedLabel(data?.profile?.joinedAt);
  if (joined) {
    const item = el(doc, "span", "profile-fact profile-joined");
    item.append(el(doc, "span", "profile-fact-icon", "◷"), el(doc, "span", null, joined));
    row.append(item);
  }
  return row;
}

const SHORTCUTS = [["ブックマーク", "onBookmarks", "profile-bookmarks"], ["リスト", "onLists", "profile-lists"], ["チャンネルを管理", "onManageChannel", "profile-studio"]];
function profileShortcutButtons(doc, deps, base) {
  const out = [];
  for (const [label, key, cls] of SHORTCUTS) {
    if (typeof deps[key] !== "function") continue;
    const button = el(doc, "button", `${base} ${cls}`, label);
    button.type = "button";
    button.onclick = () => deps[key]();
    out.push(button);
  }
  return out;
}

/** 本人だけの入口（ブックマーク・リスト・チャンネル管理）。ヘッダーの下に静かな行で並べる。他人には何も出さない。 */
export function renderProfileShortcuts(doc, data, deps = {}) {
  const row = el(doc, "div", "profile-shortcuts");
  if (data?.isCurrentUser) row.append(...profileShortcutButtons(doc, deps, "btn btn-ghost profile-shortcut"));
  return row;
}

/** 自分なら「プロフィールを編集」とリンクのコピー。他人ならリンクのコピーだけ（フォローとメッセージは呼び出し側）。 */
export function renderProfileActions(doc, data, deps = {}) {
  const row = el(doc, "div", "profile-actions");
  const handle = data?.profile?.handle;
  const separate = deps.shortcutsSeparate === true;
  if (data?.isCurrentUser && handle && deps.onEdit) {
    const edit = el(doc, "button", "ds-btn is-lg profile-edit", "プロフィールを編集");
    edit.type = "button";
    edit.onclick = () => deps.onEdit(handle);
    row.append(edit);
  }
  // 本人だけの入口（2026-10-18：内側の列の「マイページ」を外したので、ここから開く）。
  if (data?.isCurrentUser && !separate) row.append(...profileShortcutButtons(doc, deps, "ds-btn is-lg"));
  const url = profileShareUrl(deps.origin, handle);
  if (url && deps.copyText) {
    const share = el(doc, "button", "ds-btn is-lg profile-share", "リンクをコピー");
    share.type = "button";
    share.onclick = async () => {
      share.disabled = true;
      try { await deps.copyText(url); share.textContent = "コピーしました"; }
      catch { share.textContent = "コピーできませんでした"; }
      setTimeout(() => { share.textContent = "リンクをコピー"; share.disabled = false; }, 1600);
    };
    row.append(share);
  }
  return row;
}

/**
 * タブと本文。deps:
 *   postCard(post) / emptyState(icon, title, body) / personCard(person)
 *   openThread(thread) / openCommunity(community) / openProfile(handle)
 *   loadWorks(detail, ids) → 応答 / openWork(item)（無ければ種類別のタブは作らない）
 *   workRow(item) → 各画面と同じ行（無ければ簡素な行） / createWork(kind)（本人の空のタブに添える作る入口）
 * 戻り値の showConnections(kind) でフォロワー・フォロー中の一覧へ切り替える。
 */
export function createProfileBody(doc, data, deps) {
  const root = el(doc, "div", "profile-body");
  const tablist = el(doc, "div", "profile-tabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "プロフィールの中身");
  const panel = el(doc, "div", "profile-panel");
  panel.setAttribute("role", "tabpanel");
  root.append(tablist, panel);
  const content = profileContent(data);
  const handle = typeof data?.profile?.handle === "string" && HANDLE.test(data.profile.handle) ? data.profile.handle : null;
  const self = Boolean(data?.isCurrentUser);
  // 種類別のタブ：サーバーが「ある」と返した種類。本人は常に全部（空なら作る入口を出す）。読む道具が無ければ作らない。
  const canLoad = Boolean(handle) && typeof deps.loadWorks === "function";
  const present = new Set(Array.isArray(data?.kinds) ? data.kinds.filter((key) => KIND_KEYS.includes(key)) : []);
  if (self) for (const key of KIND_KEYS) present.add(key);
  const tabs = [...profileTabs(data)];
  if (canLoad) for (const kind of PROFILE_WORK_KINDS) if (present.has(kind.key)) tabs.push({ key: kind.key, label: kind.label });
  const byOrder = (a, b) => PROFILE_TAB_ORDER.indexOf(a.key) - PROFILE_TAB_ORDER.indexOf(b.key);
  tabs.sort(byOrder);
  const buttons = new Map();
  const empty = (title, body) => deps.emptyState("user", title, body);

  const card = (title, meta, onOpen) => {
    const node = el(doc, "button", "profile-row");
    node.type = "button";
    node.append(el(doc, "strong", null, title));
    if (meta) node.append(el(doc, "span", "meta", meta));
    node.onclick = onOpen;
    return node;
  };
  const renderers = {
    posts() {
      const nodes = [];
      if (content.pinned) {
        const pinned = el(doc, "div", "profile-pinned");
        pinned.append(el(doc, "p", "profile-pinned-label", "固定された投稿"), deps.postCard(content.pinned));
        nodes.push(pinned);
      }
      nodes.push(...content.posts.map((post) => deps.postCard(post)));
      return nodes.length ? nodes : [empty("まだ投稿がありません", self ? "投稿すると、ここに並びます。" : "")];
    },
    replies() { return content.replies.map((post) => deps.postCard(post)); },
    media() { return content.media.map((post) => deps.postCard(post)); },
    threads() {
      return content.threads.slice(0, 100).map((thread) => card(String(thread.title ?? ""), `${count(thread.postCount ?? 0)} 件の書き込み`, () => deps.openThread?.(thread)));
    },
    communities() {
      return content.communities.slice(0, 100).map((community) => card(String(community.name ?? ""), "", () => deps.openCommunity?.(community)));
    },
  };
  // 記事・動画・音楽・研究・マーケット・コード。開いたときに1ページだけ読み、続きは「さらに表示」（サーバーのカーソル）。
  const works = new Map();
  const workState = (kind) => {
    if (!works.has(kind)) works.set(kind, { detail: PROFILE_WORK_KINDS.find((entry) => entry.key === kind)?.detail ?? "profile_kind", items: [], nextCursor: null, loading: false, error: false, loaded: false });
    return works.get(kind);
  };
  const repaint = (kind) => { if (panel.dataset.tab === kind) panel.replaceChildren(...workNodes(kind)); };
  const workNodes = (kind) => {
    const state = workState(kind);
    const nodes = state.items.map((item) => deps.workRow?.(item) ?? card(item.title, item.meta, () => deps.openWork?.(item)));
    if (!nodes.length && state.loading) nodes.push(el(doc, "p", "meta profile-works-loading", "読み込み中…"));
    else if (!nodes.length && state.loaded && !state.error) {
      const entry = PROFILE_WORK_KINDS.find((item) => item.key === kind);
      nodes.push(empty(`まだ${entry?.label ?? ""}がありません`, self && entry?.create ? "最初の1つを作ると、ここに並びます。" : ""));
      if (self && entry?.create && typeof deps.createWork === "function") {
        const create = el(doc, "button", "head-action profile-works-create", entry.create);
        create.type = "button";
        create.onclick = () => deps.createWork(kind);
        nodes.push(create);
      }
    }
    if (state.error) {
      nodes.push(el(doc, "p", "meta profile-works-error", "読み込めませんでした。もう一度お試しください。"));
      if (!state.items.length) {
        const retry = el(doc, "button", "head-action profile-works-retry", "もう一度読み込む");
        retry.type = "button";
        retry.onclick = () => void loadWork(kind, null);
        nodes.push(retry);
      }
    }
    if (state.nextCursor) {
      const more = el(doc, "button", "head-action profile-works-more", state.loading ? "読み込み中…" : "さらに表示");
      more.type = "button";
      more.disabled = state.loading;
      more.onclick = () => void loadWork(kind, state.nextCursor);
      nodes.push(more);
    }
    return nodes;
  };
  const loadWork = async (kind, cursor) => {
    const state = workState(kind);
    if (state.loading || !canLoad) return;
    state.loading = true; state.error = false;
    repaint(kind);
    try {
      const name = cursor ? `${state.detail}_page` : state.detail;
      const ids = kind === "code" ? [handle, ...(cursor ? [cursor] : [])] : [handle, kind, ...(cursor ? [cursor] : [])];
      const page = profileWorkPage(kind, await deps.loadWorks(name, ids));
      state.items.push(...page.items);
      state.nextCursor = page.nextCursor;
      state.loaded = true;
    } catch { state.error = true; }
    state.loading = false;
    repaint(kind);
  };
  for (const kind of PROFILE_WORK_KINDS) renderers[kind.key] = () => workNodes(kind.key);
  const select = (key) => {
    for (const [name, button] of buttons) {
      const on = name === key;
      button.setAttribute("aria-selected", on ? "true" : "false");
      button.tabIndex = on ? 0 : -1;
      button.classList.toggle("on", on);
    }
    panel.dataset.tab = key;
    // 種類別のタブは初めて開いたときに1ページ読む（コードは先に読み済み）。
    if (KIND_KEYS.includes(key)) { const state = workState(key); if (!state.loaded && !state.loading && !state.error) void loadWork(key, null); }
    panel.replaceChildren(...renderers[key]());
  };
  const addTab = (tab, before = null) => {
    const button = el(doc, "button", "profile-tab");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    button.tabIndex = -1;
    button.dataset.tab = tab.key;
    button.append(doc.createTextNode(tab.label));
    if (tab.key !== "posts" && tab.count !== undefined) button.append(el(doc, "span", "profile-tab-count", count(tab.count)));
    button.onclick = () => select(tab.key);
    button.onkeydown = (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const keys = tabs.map((t) => t.key);
      const next = keys[(keys.indexOf(tab.key) + (event.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length];
      select(next);
      buttons.get(next)?.focus();
    };
    buttons.set(tab.key, button);
    tablist.insertBefore(button, before);
  };
  for (const tab of tabs) addTab(tab);
  select("posts");
  // コードだけは公開の一覧を先に1回確かめ、1件以上返ったときだけタブを足す。順は PROFILE_TAB_ORDER で固定（届いた順にしない）。
  const code = PROFILE_WORK_KINDS.find((kind) => kind.key === "code");
  const ready = canLoad
    ? (async () => {
      let page;
      try { page = profileWorkPage("code", await deps.loadWorks(code.detail, [handle])); } catch { return; }
      if (!page.items.length) return;
      Object.assign(workState("code"), { items: page.items, nextCursor: page.nextCursor, loaded: true });
      tabs.push({ key: "code", label: code.label });
      tabs.sort(byOrder);
      const after = tabs[tabs.findIndex((t) => t.key === "code") + 1];
      addTab({ key: "code", label: code.label }, after ? buttons.get(after.key) ?? null : null);
    })()
    : Promise.resolve();

  const showConnections = (kind) => {
    const people = profilePeople(kind === "followers" ? data?.followers : data?.followingProfiles);
    const total = Number(kind === "followers" ? data?.followerCount : data?.followingCount);
    for (const button of buttons.values()) { button.setAttribute("aria-selected", "false"); button.classList.remove("on"); }
    panel.dataset.tab = kind;
    const head = el(doc, "div", "profile-connections-head");
    const back = el(doc, "button", "head-action", "戻る");
    back.type = "button";
    back.onclick = () => select("posts");
    head.append(back, el(doc, "h3", null, kind === "followers" ? "フォロワー" : "フォロー中"));
    const nodes = [head];
    if (!people.length) {
      nodes.push(empty(kind === "followers" ? "フォロワーはまだいません" : "まだ誰もフォローしていません"));
    } else {
      for (const person of people) {
        const node = deps.personCard(person);
        node.onclick = () => deps.openProfile?.(person.handle);
        node.onkeydown = (event) => { if (event.key === "Enter") deps.openProfile?.(person.handle); };
        nodes.push(node);
      }
      if (Number.isFinite(total) && total > people.length) nodes.push(el(doc, "p", "meta profile-connections-more", `新しい順に${people.length}人まで表示しています。`));
    }
    panel.replaceChildren(...nodes);
    back.focus?.();
  };
  return { root, select, showConnections, ready };
}
