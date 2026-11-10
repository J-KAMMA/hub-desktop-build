// 右列の動画。一覧（おすすめ / フォロー中 / 人気）から選ぶと、右列の中で再生する。
// 再生枠は共有の YouTube dock（yt-dock.mjs）が持つ。ここには置き場（slot）だけを置く。
// 右列を閉じる・別の表示へ切り替えると release() で置き場を外し、dock が同じ iframe のまま小窓にする（読み込み直さない）。
// 戻ってきたら show() で、同じ key のまま置き場だけを付け替える。iframe は document.body の dock にあり、ここでは動かさない。
// 読み出しは既にある口だけ：hub_resource（videos。order は recent / popular）、hub_detail（sidebar = フォロー中のチャンネルとタグ）。
// おすすめの材料は Hub の中で本人がしたこと（フォロー中のタグ）だけ。視聴の履歴はサーバーに送らず、順位にも使わない。

import { createVideoCard, createWatchStage, createWatchHeader, rememberWatched, ownFirst } from "./video-home.mjs";
import { filterVideos } from "./yt-unplayable.mjs";
import { createRailSubTabs } from "./rail-subtabs.mjs";
import { interestScore } from "./rail-timeline.mjs";
import * as panels from "./rail-panels.mjs";

export const VIDEO_SORTS = [["recommended", "おすすめ"], ["following", "フォロー中"], ["popular", "人気"]];
export const VIDEO_KEY = "hub.desktop.railVideo.v1";
export const videoOrderFor = (sort) => (sort === "popular" ? "popular" : "recent");

export function normalizeVideoSort(value) { return VIDEO_SORTS.some(([key]) => key === value) ? value : "recommended"; }

// フォロー中のチャンネルの動画だけ。動画の channel は名前なので、名前（大文字小文字を無視）か id で照らす。
export function followingVideos(videos, channels) {
  const names = new Set((Array.isArray(channels) ? channels : []).map((c) => String(c?.name ?? "").toLowerCase()).filter(Boolean));
  const ids = new Set((Array.isArray(channels) ? channels : []).map((c) => c?.id).filter((id) => typeof id === "string"));
  return (Array.isArray(videos) ? videos : []).filter((video) => (video?.channel && names.has(String(video.channel).toLowerCase())) || (typeof video?.channelId === "string" && ids.has(video.channelId)));
}

// おすすめ：自作動画を先に、そのあと フォロー中のタグに近いもの（題・話題・分類）、残りはサーバーの並び（新しい順）のまま。
export function recommendVideos(videos, followedTags = []) {
  const items = filterVideos(Array.isArray(videos) ? videos : []);
  const score = (video) => interestScore(`${video.title ?? ""} ${video.topic ?? ""} ${video.category ?? ""}`, followedTags.map((t) => String(t).replace(/^#/, "").toLowerCase()));
  const order = new Map(items.map((video, index) => [video, index]));
  const ranked = [...items].sort((a, b) => score(b) - score(a) || order.get(a) - order.get(b));
  return ownFirst(ranked);
}

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// deps: hubAsset, relTime, icon, dock, openExternal(url), nativePlay(id), openCentral(video), signedIn(), connect(), friendlyError, storage, observe(cb), onReopen(video)
export function createRailVideo({ document, invoke, deps }) {
  const { hubAsset, relTime, icon, dock, openExternal, nativePlay, openCentral, signedIn, connect, friendlyError = String, storage = null, onReopen = () => {} } = deps;
  let sort = (() => { try { return normalizeVideoSort(JSON.parse(storage?.getItem(VIDEO_KEY) ?? "null")?.sort); } catch { return "recommended"; } })();
  const save = () => { try { storage?.setItem(VIDEO_KEY, JSON.stringify({ sort })); } catch { /* 保存できなくても動く */ } };

  const root = el(document, "div", "rail-video-root");
  const listView = el(document, "div", "rail-video-listview");
  const sortHost = el(document, "div", "rail-video-sorts");
  const status = el(document, "p", "meta rail-video-status");
  status.setAttribute("role", "status");
  const list = el(document, "div", "rail-video-list");
  const sentinel = el(document, "div", "rail-video-sentinel");
  sentinel.setAttribute("aria-hidden", "true");
  const more = el(document, "button", "rail-video-more", "続きを表示");
  more.type = "button";
  more.hidden = true;
  listView.append(sortHost, status, list, sentinel, more);
  const watchView = el(document, "div", "rail-video-watch");
  watchView.hidden = true;
  root.append(listView, watchView);

  let revision = 0, io = null, sidebar = null;
  const feeds = new Map();
  let watch = null; // { video, stage, released }

  const feedFor = () => { if (!feeds.has(sort)) feeds.set(sort, { raw: [], offset: 0, hasMore: false, loaded: false, loading: false }); return feeds.get(sort); };

  function paintSorts() {
    const tabs = createRailSubTabs(document, { label: "動画の並び", tabs: VIDEO_SORTS, selected: sort, className: "rail-subtabs--chips", onSelect: (next) => { sort = next; save(); void load(); } });
    sortHost.replaceChildren(tabs.element);
  }

  async function readSidebar() {
    if (sidebar || !signedIn()) return sidebar ?? { channels: [], followedTags: [] };
    try {
      const data = await invoke("hub_detail", { name: "sidebar", ids: ["videos"] });
      sidebar = {
        channels: Array.isArray(data?.channels) ? data.channels.filter((c) => c && typeof c.name === "string") : [],
        followedTags: Array.isArray(data?.followedTags) ? data.followedTags.filter((t) => typeof t === "string").slice(0, 100) : [],
      };
    } catch { sidebar = { channels: [], followedTags: [] }; }
    return sidebar;
  }

  function visibleItems(feed) {
    if (sort === "following") return followingVideos(filterVideos(feed.raw), sidebar?.channels ?? []);
    if (sort === "popular") return filterVideos(feed.raw);
    return recommendVideos(feed.raw, sidebar?.followedTags ?? []);
  }

  function emptyBox() {
    if (sort === "following" && !signedIn()) return panels.railState(document, "signedOut", { title: "接続すると表示されます", detail: "フォローしているチャンネルの動画がここに並びます。", actions: [{ label: "Desktopを接続", onClick: () => connect() }] });
    return panels.railState(document, "empty", { title: "まだありません", detail: sort === "following" ? "チャンネルをフォローすると、ここに動画が並びます。" : "新しい動画が届くとここに並びます。" });
  }

  function paint(feed) {
    const items = visibleItems(feed);
    list.replaceChildren(...(items.length ? items.map((video) => createVideoCard(document, video, { hubAsset, relTime, onOpen: openWatch })) : [emptyBox()]));
    more.hidden = !feed.hasMore || io !== null;
  }

  async function fetchPage(feed, mine) {
    if (sort === "following" && !signedIn()) { feed.loaded = true; feed.loading = false; paint(feed); return; }
    if (sort !== "popular") await readSidebar();
    const data = await invoke("hub_resource", { resource: "videos", query: "", offset: feed.offset, category: "", order: videoOrderFor(sort) });
    if (mine !== revision) return;
    const videos = Array.isArray(data?.videos) ? data.videos : [];
    const known = new Set(feed.raw.map((v) => v.id));
    feed.raw = [...feed.raw, ...videos.filter((v) => v && !known.has(v.id))];
    feed.offset += videos.length;
    feed.hasMore = videos.length > 0 && (data?.hasMore ?? (Number.isSafeInteger(data?.total) ? feed.offset < data.total : false));
    feed.loaded = true; feed.loading = false;
    paint(feed);
    status.textContent = "";
  }

  async function load({ force = false } = {}) {
    const mine = ++revision;
    if (force) { feeds.delete(sort); sidebar = null; }
    const feed = feedFor();
    if (feed.loaded) { if (!list.childElementCount) paint(feed); more.hidden = !feed.hasMore || io !== null; return; }
    status.textContent = "";
    list.replaceChildren(panels.railState(document, "loading", {}));
    more.hidden = true;
    feed.loading = true;
    try { await fetchPage(feed, mine); }
    catch (error) {
      if (mine !== revision) return;
      feed.loading = false;
      list.replaceChildren(panels.railState(document, "error", { title: "読み込めませんでした", detail: friendlyError(error), actions: [{ label: "再読み込み", onClick: () => void load({ force: true }) }] }));
    }
  }

  async function loadMore() {
    const feed = feedFor();
    if (feed.loading || !feed.hasMore || !feed.loaded) return;
    feed.loading = true;
    status.textContent = "読み込み中…";
    const mine = revision;
    try { await fetchPage(feed, mine); } catch (error) { feed.loading = false; if (mine === revision) status.textContent = friendlyError(error); }
  }
  more.onclick = () => void loadMore();
  if (typeof deps.observe === "function") { io = deps.observe(() => void loadMore()) ?? null; io?.observe(sentinel); }

  // --- 再生（右列の中） ---
  function mountWatch(video, { autoplay = true } = {}) {
    const stage = createWatchStage(document, video, {
      hubAsset, onOpenExternal: openExternal, nativePlay, dock, autoplay,
      onReopen: () => onReopen(video),
    });
    const bar = el(document, "div", "rail-video-watch-bar");
    const back = el(document, "button", "rail-video-back");
    back.type = "button";
    back.setAttribute("aria-label", "動画の一覧へ戻る");
    back.title = "一覧へ戻る";
    back.innerHTML = icon("back");
    back.onclick = () => closeWatch();
    const central = el(document, "button", "rail-video-central", "中央で開く");
    central.type = "button";
    central.onclick = () => openCentral(video);
    bar.append(back, central);
    const head = createWatchHeader(document, video, { relTime });
    watch = { video, stage, released: false };
    const meta = el(document, "div", "rail-video-watch-meta");
    meta.append(head.title, head.bar, head.desc);
    watchView.replaceChildren(bar, stage.element, meta);
    listView.hidden = true;
    watchView.hidden = false;
    dock?.layout?.();
  }

  function openWatch(video, { silent = false } = {}) {
    rememberWatched(video);
    mountWatch(video, { autoplay: true });
    if (!silent) onChange?.({ type: "watch", video });
  }

  // 一覧へ戻る。再生中なら小窓に渡す（iframe はそのまま）。
  function closeWatch({ silent = false } = {}) {
    if (watch && !watch.released) watch.stage.stop();
    watch = null;
    watchView.replaceChildren();
    watchView.hidden = true;
    listView.hidden = false;
    dock?.layout?.();
    if (!silent) onChange?.({ type: "list" });
  }

  let onChange = null;
  paintSorts();

  return {
    element: root,
    get watching() { return watch?.video ?? null; },
    onChange(fn) { onChange = fn; },
    load, refresh: () => load({ force: true }),
    openWatch, closeWatch,
    // 右列を閉じた／別の表示へ切り替えた。置き場を外すと dock が小窓にする。
    release() {
      if (!watch || watch.released) return;
      watch.released = true;
      watch.stage.stop();
      dock?.layout?.();
    },
    // 右列の動画が見えた。再生中だった動画があれば、同じ key のまま置き場だけを付け替える（読み込み直さない）。
    show() {
      if (watch?.released) mountWatch(watch.video, { autoplay: false });
    },
    reset() { feeds.clear(); sidebar = null; revision++; list.replaceChildren(); if (watch) { watch.stage.stop(); watch = null; watchView.replaceChildren(); watchView.hidden = true; listView.hidden = false; } },
    destroy() { io?.disconnect?.(); },
  };
}
