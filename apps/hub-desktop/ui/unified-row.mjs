// 一覧の行（docs/hub-unified-post/DESIGN.md 6）。タイムライン、プロフィール、検索、コミュニティ、スレッド一覧、ブックマークで同じ部品。
// アイコン、名前、時刻、置き場の名前。題があれば題、なければ本文の先頭3行。主な添付は1つ。返信・いいね・保存の数。
// ゲート付きは題と錠前と条件だけで、抜粋は出さない。操作はすべて呼び出し側が渡した関数（ここでは何も送らない）。
import { createPostRow } from "./post-row.mjs";
import { KIND_BADGE } from "./post-kind.mjs";

const make = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 新しい形の投稿か（旧表の投稿と見分ける）。 */
export const isUnifiedPost = (post) => Boolean(post && typeof post === "object" && typeof post.kind === "string"
  && post.counts && typeof post.counts === "object" && Array.isArray(post.attachments) && Array.isArray(post.places));

/** 本文の先頭3行（空行は飛ばす）。 */
export const firstLines = (body, n = 3) => String(body ?? "").split(/\r?\n/).filter((line) => line.trim()).slice(0, n).join("\n");

export const imageSrc = (refId, variant = "thumbnail") => (ID.test(String(refId ?? "")) ? `/api/media/images/${encodeURIComponent(refId)}?variant=${variant === "full" ? "full" : "thumbnail"}` : null);
export const youtubeThumb = (id) => (/^[A-Za-z0-9_-]{11}$/.test(String(id ?? "")) ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null);

export function placeName(post, names = {}) {
  const place = (post.places ?? []).find((p) => p !== "timeline");
  if (!place) return "";
  if (names[place]) return names[place];
  // コミュニティの投稿は「チャンネル」とは呼ばない。種類（雑談・質問・募集）を出す。
  if (place.startsWith("channel:")) return { chat: "雑談", question: "質問", party: "募集" }[place.split(":")[2]] ?? "コミュニティ";
  return place.startsWith("thread:") ? "スレッド" : "";
}

/** 行に出す主な添付を1つ選ぶ。 */
export function primaryAttachment(post) {
  const list = (post.attachments ?? []).filter((a) => !a.locked);
  if (post.kind === "paper") return { type: "paper" };
  const pick = (type) => list.find((a) => a.type === type);
  return pick("video") ?? pick("external_video") ?? pick("audio") ?? pick("image") ?? pick("file") ?? pick("poll") ?? pick("embed") ?? pick("link") ?? pick("reference") ?? null;
}

export function attachmentNode(document, post, a, deps) {
  const { icon, hubAsset } = deps;
  const chip = (iconName, label, className) => {
    const node = make(document, "div", `uc-row-attach ${className ?? ""}`);
    node.innerHTML = icon(iconName);
    if (label) node.append(make(document, "span", "", label));
    return node;
  };
  const count = (type) => (post.attachments ?? []).filter((x) => x.type === type).length;
  switch (a.type) {
    case "paper": {
      const node = chip("paper", deps.licenceLabel?.(post.licence) ?? post.licence ?? "", "uc-row-paper");
      node.title = deps.licenceLabel?.(post.licence) ?? "";
      return node;
    }
    case "video":
    case "external_video": {
      const node = make(document, "div", "uc-row-media uc-row-video");
      const url = a.type === "external_video" ? youtubeThumb(a.refId) : null;
      if (url) { const img = document.createElement("img"); img.src = url; img.alt = ""; img.loading = "lazy"; img.onerror = () => img.remove(); node.append(img); }
      const play = make(document, "span", "uc-row-play"); play.innerHTML = icon("video"); node.append(play);
      return node;
    }
    case "audio": return chip("music", "", "uc-row-audio");
    case "image": {
      const src = a.meta?.url || imageSrc(a.refId);
      if (!src || !hubAsset) return chip("image", "");
      const node = make(document, "div", "uc-row-media uc-row-image");
      const img = document.createElement("img"); hubAsset(img, src); img.alt = a.meta?.alt || ""; img.loading = "lazy"; node.append(img);
      if (count("image") > 1) node.append(make(document, "span", "uc-row-more", `+${count("image") - 1}`));
      return node;
    }
    case "file": return chip("doc", String(count("file")), "uc-row-file");
    case "poll": return chip("poll", "", "uc-row-poll");
    case "embed": return chip("embed", "", "uc-row-embed");
    case "reference": return chip("quote", String(count("reference")), "uc-row-ref");
    default: return chip("external", a.meta?.title || "", "uc-row-link");
  }
}

/**
 * deps: { icon, hubAsset, relTime, paintAvatar, licenceLabel?, placeNames?, onOpen(post), onAuthor?(handle), onReply?(post),
 *   onRepost?(post), onShare?(post), onReact?(post, {action, on}) -> Promise<{counts, viewer}>, attachTranslate?(host, body, post), menu?(post) -> [[label, run]] }
 */
export function createUnifiedRow(document, post, deps) {
  const { icon, relTime } = deps;
  const kindSpec = KIND_BADGE[post.kind] ?? KIND_BADGE.post;
  const author = post.author ?? null;
  const state = { liked: post.viewer?.liked === true, saved: post.viewer?.saved === true, counts: { ...post.counts }, pending: false };
  const locked = post.locked === true;

  const body = make(document, "div", "uc-row-body");
  if (locked) {
    const head = make(document, "p", "uc-row-title uc-row-locked");
    head.innerHTML = icon("lock");
    head.append(make(document, "span", "", post.title || kindSpec.label));
    body.append(head);
    if (post.gate?.description) body.append(make(document, "p", "uc-row-gate", post.gate.description));
  } else {
    if (post.title) body.append(make(document, "p", "uc-row-title", post.title));
    const text = post.title ? "" : firstLines(post.body);
    if (text) body.append(make(document, "p", "post-body uc-row-excerpt", text));
    else if (!post.title && post.summary) body.append(make(document, "p", "post-body uc-row-excerpt", post.summary));
    const primary = primaryAttachment(post);
    if (primary) body.append(attachmentNode(document, post, primary, deps));
  }

  const meta = [];
  const place = placeName(post, deps.placeNames);
  if (place) meta.push(place);
  if (post.status === "held") meta.push("審査中");
  if (post.kind !== "post") meta.push(kindSpec.label);
  if (post.editedAt) meta.push("編集済み");

  const react = (action, key) => {
    if (!deps.onReact || state.pending) return;
    const next = !state[key];
    state.pending = true;
    state[key] = next;
    state.counts[action === "like" ? "likes" : "saves"] += next ? 1 : -1;
    paint();
    Promise.resolve(deps.onReact(post, { action, on: next })).then((result) => {
      if (result?.counts) state.counts = { ...result.counts };
      if (result?.viewer) { state.liked = result.viewer.liked === true; state.saved = result.viewer.saved === true; }
    }).catch(() => {
      state[key] = !next; state.counts[action === "like" ? "likes" : "saves"] += next ? -1 : 1;
    }).finally(() => { state.pending = false; paint(); });
  };

  const actions = [
    { icon: "reply", label: "返信", count: state.counts.replies, onClick: () => deps.onReply?.(post) },
    { icon: "repost", label: "リポスト", onClick: () => deps.onRepost?.(post), disabled: !deps.onRepost },
    { icon: "heart", label: "いいね", count: state.counts.likes, active: state.liked, pressed: state.liked, onClick: () => react("like", "liked") },
    { icon: "share", label: "共有", onClick: () => deps.onShare?.(post) },
    { icon: "bookmark", label: "保存", count: state.counts.saves, active: state.saved, pressed: state.saved, activeClass: "is-saved", onClick: () => react("save", "saved") },
  ];
  const row = createPostRow(document, {
    authorName: author?.displayName || author?.handle || "", authorHandle: author?.handle ?? null, authorPoints: author?.badgePoints ?? null, authorRole: author?.communityRole ?? null, avatarUrl: author?.avatarUrl ?? null,
    time: relTime(post.publishedAt ?? post.createdAt), timeTitle: post.createdAt ? new Date(post.createdAt).toLocaleString("ja-JP") : "",
    meta, rating: post.rating ?? null, body, actions, menu: deps.menu?.(post) ?? [],
    onOpen: () => deps.onOpen?.(post), hubAsset: deps.hubAsset, icon, paintAvatar: deps.paintAvatar, classes: ["uc-row", `uc-row-${post.kind}`],
  });
  row.dataset.postId = post.id;
  row.dataset.kind = post.kind;
  if (locked) row.dataset.locked = "true";
  const authorLink = row.querySelector(".post-author-link");
  if (author?.handle && authorLink && deps.onAuthor) {
    authorLink.setAttribute("role", "link"); authorLink.tabIndex = 0;
    authorLink.onclick = (event) => { event.stopPropagation(); deps.onAuthor(author.handle); };
  }
  const bar = row.querySelector(".post-actions");
  const buttons = [...(bar?.querySelectorAll(".post-action") ?? [])];
  const [replyButton, , likeButton, shareButton, saveButton] = buttons;
  shareButton?.classList.add("uc-act-right");
  if (!locked && deps.attachTranslate && post.body) {
    const host = make(document, "span", "local-translate-host");
    host.onclick = (event) => event.stopPropagation();
    bar.insertBefore(host, shareButton ?? null);
    deps.attachTranslate(host, body.querySelector(".uc-row-excerpt") ?? body, post);
  }
  function paint() {
    const set = (button, count, active, name) => {
      if (!button) return;
      button.querySelector(".post-action-count").textContent = count ? String(count) : "";
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle(name, active);
      const svg = button.querySelector("svg");
      if (svg) { if (active) { svg.setAttribute("fill", "currentColor"); svg.setAttribute("stroke", "none"); } else { svg.removeAttribute("fill"); svg.removeAttribute("stroke"); } }
    };
    set(likeButton, state.counts.likes, state.liked, "is-liked");
    set(saveButton, state.counts.saves, state.saved, "is-saved");
    replyButton?.querySelector(".post-action-count") && (replyButton.querySelector(".post-action-count").textContent = state.counts.replies ? String(state.counts.replies) : "");
  }
  row.hubUnifiedPost = post;
  return row;
}

/** 一覧を描く。論文のNCが1件でもあれば adsAllowed=false（サーバーの値を優先）。 */
export function renderUnifiedList(document, response, deps) {
  const items = Array.isArray(response?.items) ? response.items : [];
  const nodes = items.map((post) => createUnifiedRow(document, post, deps));
  return { nodes, adsAllowed: response?.adsAllowed !== false, nextCursor: response?.nextCursor ?? null };
}
