// 画面の型（docs/hub-ui-reference/DESIGN-SYSTEM.md §1、§5）。.app-shell の data-template に入れる。
// 列の幅は desktop-layouts.css が型ごとに一か所で決める（stream 600 · wide 980 · reading 680 · split と settings は 980）。
// ブラウザは本文の幅を持たない専用の型（窓いっぱい）。

export const TEMPLATES = Object.freeze(["stream", "wide", "reading", "split", "settings", "browser"]);

const BY_VIEW = Object.freeze({
  home: "stream", feed: "stream", search: "stream", notifications: "stream", profile: "stream", community: "stream",
  threads: "stream", hubpedia: "stream", research: "stream", contacts: "stream", bookmarks: "stream", lists: "stream",
  articles: "stream", code: "wide",
  videos: "wide", music: "wide", market: "wide", purchased: "wide", games: "wide", books: "wide",
  ranking: "wide", services: "wide", compute: "wide", node: "wide", ai: "wide",
  messages: "split", mail: "split",
  settings: "settings", wallet: "settings", cart: "settings", order: "settings",
  browser: "browser",
});

const BY_DETAIL = Object.freeze({
  article: "reading", hubpedia_article: "reading", book: "reading", book_chapter: "reading",
  ranking_item: "stream", service_item: "stream",
  video: "wide", music_work: "wide", music_artist: "wide", music_album: "wide", listing: "wide", commerce_product: "wide",
});

export function templateFor(view, detailName = "") {
  if (view === "detail") return BY_DETAIL[detailName] ?? "stream";
  return BY_VIEW[view] ?? "stream";
}
