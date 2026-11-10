// 投稿と同じ見た目の「行」（スレッドの投稿・コミュニティの発言・レビュー・コメント）を組み立てる共通の部品。
// 投稿カード（app.js の postCard）と同じクラスで描くので、同じ CSS が効く。サーバーの操作は呼び出し側が渡した関数だけ——ここでは何も作らない。
const make = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

/** jkammaポイント（名前の横の小さな静かな字）。整数以外・負・null は何も出さない。 */
export function pointsBadge(document, points, icon) {
  if (!Number.isInteger(points) || points < 0) return null;
  const node = make(document, "span", "meta post-points");
  node.setAttribute("role", "group"); node.setAttribute("aria-label", "jkammaポイント"); node.title = "jkammaポイント";
  node.innerHTML = icon("star");
  node.append(make(document, "span", "", points.toLocaleString("en-US")));
  return node;
}

import { holdingBadge } from "./community-holding.mjs";
import { roleMark } from "./role-mark.mjs";
import { addBaitRow } from "./outbound-link.mjs";

export function ratingStars(document, rating) {
  const value = Number(rating);
  if (!Number.isFinite(value) || value < 1 || value > 5) return null;
  const whole = Math.round(value);
  const node = make(document, "span", "post-rating", "★".repeat(whole) + "☆".repeat(5 - whole));
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", `評価 5段階中${whole}`);
  return node;
}

/**
 * spec:
 *  authorName, authorHandle, avatarUrl, time (表示文字列), timeTitle, meta: string[] (時刻の横の小さな文字：#12・編集済み…),
 *  rating (1-5), replyTo: {label, onClick} | null, body: string | Node, images: [{url, altText}],
 *  extra: Node[] (本文の下), actions: [{icon, label, count, active, pressed, disabled, onClick}],
 *  menu: [[label, run]], onOpen, hubAsset(img,url), icon(name, filled), paintAvatar(node, name), classes: string[]
 */
export function createPostRow(document, spec) {
  const { authorName, authorHandle, authorPoints = null, authorHolding = null, authorRole = null, avatarUrl, time, timeTitle, meta = [], rating, replyTo, body, images = [], extra = [],
    actions = [], menu = [], onOpen, hubAsset, icon, paintAvatar, classes = [] } = spec;
  const row = make(document, "article", ["post", "post-row", ...classes].join(" "));
  const avatar = make(document, "span", "post-avatar");
  if (avatarUrl && hubAsset) {
    const img = document.createElement("img");
    hubAsset(img, avatarUrl); img.alt = "";
    avatar.classList.add("has-image"); avatar.append(img);
  } else {
    avatar.textContent = (authorName || authorHandle || "?").trim().slice(0, 1).toUpperCase();
    paintAvatar?.(avatar, authorName || authorHandle);
  }
  const content = make(document, "div", "post-content");
  const head = make(document, "div", "post-head");
  const author = make(document, "span", "post-author-link");
  author.append(make(document, "strong", authorHandle ? "post-author" : "", authorName || "（名無し）"));
  if (authorHandle) author.append(make(document, "span", "meta", `@${authorHandle}`));
  const roleBadge = roleMark(document, authorRole);
  if (roleBadge) author.append(roleBadge);
  const points = pointsBadge(document, authorPoints, icon);
  if (points) author.append(points);
  const holding = holdingBadge(document, authorHolding, icon);
  if (holding) author.append(holding);
  head.append(author);
  const when = make(document, "span", "meta when", time ?? "");
  if (timeTitle) when.title = timeTitle;
  head.append(when);
  const stars = ratingStars(document, rating);
  if (stars) head.append(stars);
  for (const bit of meta.filter(Boolean)) head.append(make(document, "span", "meta post-row-meta", bit));

  if (menu.length) {
    const wrap = make(document, "div", "post-more-wrap");
    const button = make(document, "button", "post-more");
    button.type = "button"; button.innerHTML = icon("more");
    button.setAttribute("aria-label", "投稿のその他の操作"); button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false"); button.title = "その他";
    const list = make(document, "div", "post-repost-menu post-more-menu");
    list.setAttribute("role", "menu"); list.hidden = true;
    for (const [label, run] of menu) {
      const item = make(document, "button", "", label);
      item.type = "button"; item.setAttribute("role", "menuitem");
      item.onclick = (event) => { event.stopPropagation(); list.hidden = true; button.setAttribute("aria-expanded", "false"); run(row); };
      list.append(item);
    }
    button.onclick = (event) => {
      event.stopPropagation(); list.hidden = !list.hidden;
      button.setAttribute("aria-expanded", String(!list.hidden));
      if (!list.hidden) list.querySelector("button")?.focus();
    };
    wrap.onclick = (event) => event.stopPropagation();
    wrap.append(button, list); head.append(wrap);
  }
  content.append(head);
  if (replyTo) {
    const line = make(document, "p", "post-reply-to", "返信先 ");
    const link = make(document, "a", "", replyTo.label);
    link.href = "#";
    link.onclick = (event) => { event.preventDefault(); event.stopPropagation(); replyTo.onClick?.(); };
    line.append(link); content.append(line);
  }
  const bodyNode = typeof body === "string" ? make(document, "p", "post-body", body) : body;
  if (bodyNode) content.append(bodyNode);
  if (bodyNode) addBaitRow(document, bodyNode, typeof body === "string" ? body : bodyNode.textContent);
  if (images.length && hubAsset) {
    const grid = make(document, "div", `post-images post-images--${Math.min(4, images.length)}`);
    for (const image of images.slice(0, 4)) {
      const img = document.createElement("img");
      hubAsset(img, image.url); img.alt = image.altText || ""; img.loading = "lazy";
      grid.append(img);
    }
    content.append(grid);
  }
  content.append(...extra);
  if (actions.length) {
    const bar = make(document, "div", "post-actions");
    for (const action of actions) {
      const button = make(document, "button", "post-action");
      button.type = "button";
      button.innerHTML = `${icon(action.icon, action.active === true)}<b class="post-action-count"></b>`;
      button.querySelector(".post-action-count").textContent = action.count ? String(action.count) : "";
      button.setAttribute("aria-label", action.label); button.title = action.label;
      if (action.active) button.classList.add(action.activeClass ?? "is-liked");
      if (action.pressed !== undefined) button.setAttribute("aria-pressed", String(action.pressed));
      button.disabled = action.disabled === true;
      button.onclick = (event) => { event.stopPropagation(); action.onClick?.(event, button); };
      bar.append(button);
    }
    content.append(bar);
  }
  row.append(avatar, content);
  if (onOpen) {
    row.tabIndex = 0; row.title = "開く"; row.onclick = onOpen;
    row.onkeydown = (event) => { if (event.key === "Enter" && event.target === row) onOpen(); };
  }
  row.hubPostEntries = menu;
  return row;
}
