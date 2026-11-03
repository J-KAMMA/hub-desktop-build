// 内側左列（#sidebar-context）のfixture。sidebar-context.test.mjs と desktop-views-layout.test.mjs が共有する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as media from "./sidebar-media.mjs";
import { musicTreeModel, renderMusicTree } from "./music-tree.mjs";
import { videoTreeModel, renderVideoTree } from "./video-tree.mjs";
import { articleTreeModel, renderArticleTree } from "./article-tree.mjs";
import { gamesTreeModel, renderGamesTree } from "./games-tree.mjs";
import { marketTreeModel, renderMarketTree } from "./market-tree.mjs";
import { researchTreeModel, renderResearchTree } from "./research-tree.mjs";
import { createProfileBody } from "./profile-view.mjs";

const source = readFileSync(new URL("./app.js", import.meta.url), "utf8").split("\r\n").join("\n");
const css = readFileSync(new URL("./sidebar-context.css", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const slice = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
};
const tables = slice("const readingDirectory = new Map(", "const sidebarContext = document.querySelector");
const column = slice("let sidebarCollapsedForEmpty = false;", "\nfunction showView(");
const tick = () => new Promise(setImmediate);
export const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

// Hub の /api/client/sidebar の代わり。1頁目に30件と続き、2頁目に残りを返す。
function hubSidebar(command, args) {
  if (command === "hub_client") return { lists: [{ id: "list-1", name: "友だち", profileIds: ["a", "b"] }] };
  if (command !== "hub_detail") throw new Error(command);
  const [kind, cursor] = args.ids;
  const people = Array.from({ length: 34 }, (_, index) => ({ type: "profile", id: `p${String(index).padStart(2, "0")}`, handle: `h${index}`, name: `${kind}の人 ${index}`, avatarUrl: index === 0 ? "/api/avatars/p0.png" : index === 1 ? "https://evil.example/a.png" : null }));
  if (args.name === "sidebar") return { kind, followedTags: ["UI", "音楽"], channels: people.slice(0, 30), nextCursor: "cDI5" };
  if (args.name === "sidebar_page") { assert.equal(cursor, "cDI5"); return { kind, channels: people.slice(30), nextCursor: null }; }
  throw new Error(args.name);
}

// 本文のプロフィールタブ（投稿・メディア・スレッド）を実際に生成する。
const PROFILE_DATA = {
  profile: { handle: "ada", displayName: "Ada" },
  isCurrentUser: true,
  posts: [
    { id: "p1", body: "one" },
    { id: "p2", body: "two", images: [{ url: "/i" }] },
  ],
  threads: [{ id: "t1", title: "スレッド", postCount: 2 }],
  communities: [],
};
const profileDeps = (document) => ({
  postCard: (post) => { const node = document.createElement("article"); node.className = "post"; node.textContent = post.body ?? post.id; return node; },
  emptyState: (_icon, title, body) => { const node = document.createElement("div"); node.className = "empty-state"; node.textContent = [title, body].filter(Boolean).join(" / "); return node; },
  personCard: (person) => { const node = document.createElement("article"); node.className = "person"; node.textContent = person.displayName; return node; },
});

export function fixture({ projects = [], width = 1280, registered = true } = {}) {
  const dom = new JSDOM(html, { url: "https://sidebar.invalid/" });
  const { document } = dom.window;
  dom.window.Element.prototype.scrollIntoView = function () {};
  const calls = [];
  const state = { currentView: "feed", detailTrail: [] };
  const matchMedia = (query) => ({ matches: [...query.matchAll(/(min|max)-width:\s*(\d+)px/g)].every(([, kind, limit]) => kind === "min" ? width >= Number(limit) : width <= Number(limit)) });
  const railViews = new Set([...document.querySelectorAll(".icon-rail [data-view]")].map((node) => node.dataset.view));
  // 列の項目がアイコンの列にある画面へ移ろうとしたら記録する（同じ行き先の重複）。
  for (const node of document.querySelectorAll("[data-view]")) node.addEventListener("click", () => { if (railViews.has(node.dataset.view)) calls.push(["rail", node.dataset.view]); });
  const profileBody = createProfileBody(document, PROFILE_DATA, profileDeps(document));
  document.querySelector("#profile-posts").replaceChildren(profileBody.root);
  const api = new Function("document", "matchMedia", "state", "calls", "projects", "media", "registered", "hubSidebar", "musicTreeModel", "renderMusicTree", "trees", `
    const { sidebarIcon, channelAvatar, createSidebarRemote } = media;
    const { videoTreeModel, renderVideoTree, articleTreeModel, renderArticleTree, gamesTreeModel, renderGamesTree, researchTreeModel, renderResearchTree, marketTreeModel, renderMarketTree } = trees;
    const marketBrowse = null, marketView = { tree: null, sells: false };
    const hideVideoChannel = () => {}, renderVideoStudio = () => ({}), createNativeVideoApi = () => ({}), viewScroller = () => null;
    const gamesView = { entries: [], tree: null }, gamesPage = { route: () => ({ page: "library" }), go: (target) => calls.push(["games", target.page]) };
    const appendSidebarMine = () => {};
    const nativeSidebar = null, homeAccountEpoch = 1, appsOpen = false, nativeSidebarId = () => 0;
    const detailReturn = { view: "feed" }, detailBack = () => calls.push(["back"]);
    let sidebarCollapsedForRail = false;
    const socialMode = "mixed", socialFilter = "post", socialScope = "recommended", selectSocial = (...args) => calls.push(["social", ...args]);
    const researchWorkspace = { projects: () => projects };
    const shop = { cart: {}, orders: [{ id: "o1", title: "本の注文", status: "paid" }] }, orderStatusText = (status) => status === "paid" ? "支払い済み" : status;
    const videoWatchIndex = -1, videoCategory = "", videoMode = "home";
    const openVideoChannel = (handle) => calls.push(["videoChannel", handle]), setVideoMode = (mode) => calls.push(["videoMode", mode]), searchVideos = () => calls.push(["searchVideos"]);
    const musicTab = "home", musicPlayer = { tracks: [{ artist: "作者A" }] };
    let musicSideMode = null;
    const openMusicSideMode = (mode) => calls.push(["musicMode", mode]), syncMusicSidePanel = () => {};
    const selectFeedTab = (key) => calls.push(["feedTab", key]), feedTabKey = () => "recommended";
    const openDetail = (name, ids) => calls.push(["detail", name, ...ids]);
    const readingLabels = () => [], renderReadingCatalog = () => {}, loadCatalog = () => {};
    const renderVideoChips = () => {}, renderMusicChips = () => {}, renderFeedChips = () => {}, renderReadingChips = () => {}, videoSearchState = null;
    const messagesData = state.messagesData ?? null, activeConversationId = state.activeConversationId ?? null;
    const conversationPeer = (conversation, profiles, selfId) => profiles.get(conversation.participantIds.find((id) => id !== selfId));
    const openConversation = (id) => calls.push(["openConversation", id]), navigateFrom = async (item) => { calls.push(["navigate", item.dataset.view]); };
    const relTime = () => "1時間前";
    const hubAsset = (img, url) => { img.src = "https://hub.invalid" + url; };
    const desktopAccount = { state: registered ? "registered" : "anonymous" };
    const communitiesHost = document.createElement("div"), navCommunities = { setCurrent() {}, refresh: async () => {
      if (state.currentView !== "feed") { communitiesHost.replaceChildren(); communitiesHost.hidden = true; return; }
      // 参加中のコミュニティ3件と「すべて見る」（nav-communities.mjs が描く行と同じ class）。
      communitiesHost.replaceChildren(...["設計", "音楽", "写真", "すべて見る"].map((name, index) => {
        const button = document.createElement("button");
        button.className = "nav-community sidebar-context-item" + (index === 3 ? " nav-community-all" : "");
        button.textContent = name;
        return button;
      }));
      communitiesHost.className = "nav-communities";
      communitiesHost.hidden = false;
    } };
    const invoke = async (command, args) => { calls.push(["invoke", command, args?.name, ...(args?.ids ?? [])]); return hubSidebar(command, args); };
    const sidebarContext = document.querySelector("#sidebar-context");
    const messagesSide = document.querySelector(".messages-side"), messagesLayout = document.querySelector(".messages-layout"), mailListCol = document.querySelector(".mail-list-col"), mailLayoutNode = document.querySelector(".mail-layout");
    ${tables.replace(/\bdetailTrail\b/g, "state.detailTrail")}
    ${column.replace(/\bcurrentView\b/g, "state.currentView").replace(/\bdetailTrail\b/g, "state.detailTrail").replace(/\b(messagesData|activeConversationId)\b/g, "state.$1")}
    return { renderSidebarContext, placeMessagesSide, sidebarRemote };
  `)(document, matchMedia, state, calls, projects, media, registered, hubSidebar, musicTreeModel, renderMusicTree, { videoTreeModel, renderVideoTree, articleTreeModel, renderArticleTree, gamesTreeModel, renderGamesTree, researchTreeModel, renderResearchTree, marketTreeModel, renderMarketTree });
  const shell = document.querySelector(".app-shell");
  const show = (view) => { state.currentView = view; calls.length = 0; api.renderSidebarContext(view); };
  const items = () => [...document.querySelectorAll("#sidebar-context .sidebar-context-item, #sidebar-context .sidebar-switch > button")];
  const labels = () => items().map((node) => node.textContent);
  const headings = () => [...document.querySelectorAll("#sidebar-context .sidebar-heading")].map((node) => node.textContent);
  return { dom, document, shell, calls, state, api, show, items, labels, headings, railViews };
}

export const WITH_CONTENT = ["feed", "notifications", "messages", "videos", "music", "articles", "research", "market", "settings", "purchased", "lists", "bookmarks", "profile"];
export const EMPTY = ["home", "ranking", "services", "node", "compute", "books", "search", "contacts", "hubpedia", "community", "threads"];
export { source, css, html };
