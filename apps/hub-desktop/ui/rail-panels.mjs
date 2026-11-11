// 右列（投稿・通知・メッセージ・コミュニティ・音楽）の中身。
//
// ここはデータを受け取って行を組むだけで、取りに行く先は app.js が既に呼んでいる口
// （hub_feed・notification_snapshot・conversations・communities・music_tracks）に限る。
// 無い情報は作らない：未読数が返らない面には未読の印を出さない。
// 色は CSS（rail-panels.css）の意味トークンだけで決め、ここでは触らない。

const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
  bell: ["M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15ZM10 21h4"],
  post: ["M5 5h14v10H10l-5 4Z"],
  message: ["M4 6h16v12H4Z", "m4 7 8 6 8-6"],
  community: ["M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5M15.5 14.4c2.6-.4 5 1.1 5 4.1", "M9 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"],
  music: ["M9 18V6l10-2v12", "M6.5 15.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM16.5 13.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"],
  heart: ["M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"],
  reply: ["M9 7 4 12l5 5", "M4 12h10a6 6 0 0 1 6 6"],
  repost: ["m17 3 3 3-3 3", "M4 11V9a3 3 0 0 1 3-3h13", "m7 21-3-3 3-3", "M20 13v2a3 3 0 0 1-3 3H4"],
  follow: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0", "M19 8v6M16 11h6"],
  mention: ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"],
  bookmark: ["M7 4h10v16l-5-3.5L7 20Z"],
};
// 通知の種類 → 顔の右下に重ねる小さな記号。種類が分からなければ鈴。
const NOTIFICATION_KIND = { social_reaction: "heart", social_reply: "reply", thread_reply: "reply", social_repost: "repost", followed: "follow", social_bookmark: "bookmark" };
export const railNotificationKind = (item) => item?.context === "mention" ? "mention" : NOTIFICATION_KIND[item?.type] ?? "bell";

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function railIcon(document, name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "ic");
  for (const d of ICONS[name] ?? ICONS.bell) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// app.js の relTime と同じ区切り。テストで時刻を固定できるよう now を受ける。
export function railRelativeTime(value, now = Date.now(), options = {}) {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}日前`;
  if (options.absolute) return new Date(then).toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
  if (days < 30) return `${Math.floor(days / 7)}週間前`;
  if (days < 365) return `${Math.floor(days / 30)}か月前`;
  return `${Math.floor(days / 365)}年前`;
}

export const railCount = (value) => (Number.isSafeInteger(value) && value > 0 ? (value > 99 ? "99+" : String(value)) : "");

// 顔：Hub 自身の画像（"/" 始まり）だけを asset で読む。外の URL や読めない画像は頭字にする。
export function railAvatar(document, { name = "", url = null, icon = null, asset = null } = {}) {
  const node = el(document, "span", "rail-row-avatar");
  node.setAttribute("aria-hidden", "true");
  if (icon) {
    node.classList.add("is-icon");
    node.append(railIcon(document, icon));
    return node;
  }
  const initial = [...String(name || "").trim()][0]?.toUpperCase() || "?";
  const own = typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");
  if (own && typeof asset === "function") {
    const img = el(document, "img");
    img.alt = "";
    img.width = 32; img.height = 32;
    img.setAttribute("loading", "lazy");
    img.addEventListener("error", () => { node.classList.remove("has-image"); node.replaceChildren(document.createTextNode(initial)); }, { once: true });
    asset(img, url);
    node.classList.add("has-image");
    node.append(img);
  } else node.textContent = initial;
  return node;
}

// 1行：顔／記号・名前・時刻・本文1〜2行・未読の点か件数。押すと onOpen。
export function railRow(document, { title, text = "", at = null, relTime = railRelativeTime, avatar = null, unread = false, count = 0, label = "", onOpen = null }) {
  const row = el(document, onOpen ? "button" : "div", "rail-item rail-row");
  if (onOpen) { row.type = "button"; row.onclick = onOpen; }
  if (avatar) row.append(avatar);
  const main = el(document, "span", "rail-row-main");
  const head = el(document, "span", "rail-item-head");
  head.append(el(document, "strong", "", title));
  const when = relTime(at);
  if (when) head.append(el(document, "span", "meta", when));
  main.append(head);
  if (text) main.append(el(document, "span", "rail-item-text", text));
  row.append(main);
  const shown = railCount(count);
  if (shown) {
    const badge = el(document, "span", "rail-row-count", shown);
    badge.setAttribute("aria-label", `未読${shown}件`);
    row.append(badge);
  }
  if (unread || shown) {
    row.classList.add("is-unread");
    if (!shown) row.append(el(document, "span", "rail-row-dot"));
  }
  if (label) row.setAttribute("aria-label", label);
  else if (unread || shown) row.setAttribute("aria-label", `未読 ${title}${when ? ` ${when}` : ""}${text ? ` ${text}` : ""}`);
  return row;
}

export function railHeading(document, text, extra = null) {
  const head = el(document, "div", "rail-section-head");
  head.append(el(document, "h3", "", text));
  if (extra) head.append(extra);
  return head;
}

// 状態：loading は行の形の下地、ほかは見出し・一言・ボタン。
export function railState(document, kind, { title = "", detail = "", actions = [] } = {}) {
  if (kind === "loading") {
    const box = el(document, "div", "rail-skeleton");
    box.setAttribute("role", "status");
    box.setAttribute("aria-label", title || "読み込み中");
    for (let index = 0; index < 4; index += 1) {
      const row = el(document, "div", "rail-skeleton-row");
      row.append(el(document, "span", "rail-skeleton-avatar"), el(document, "span", "rail-skeleton-lines"));
      box.append(row);
    }
    return box;
  }
  const box = el(document, "div", `rail-empty rail-state rail-state--${kind}`);
  if (kind === "error") box.setAttribute("role", "alert");
  if (title) box.append(el(document, "strong", "", title));
  if (detail) box.append(el(document, "p", "", detail));
  if (actions.length) {
    const row = el(document, "div", "rail-empty-actions");
    for (const action of actions) {
      const button = el(document, "button", "", action.label);
      button.type = "button";
      button.onclick = action.onClick;
      row.append(button);
    }
    box.append(row);
  }
  return box;
}

const SIGNED_OUT = {
  notifications: ["接続すると通知が届きます", "いいね・返信・フォローなどがここに並びます。"],
  messages: ["接続すると会話を読めます", "メッセージは端末で暗号を解いてから表示します。"],
};
export function railSignedOut(document, name, connect) {
  const [title, detail] = SIGNED_OUT[name] ?? ["接続すると表示されます", ""];
  return railState(document, "signedOut", { title, detail, actions: connect ? [{ label: "Desktopを接続", onClick: connect }] : [] });
}

// 投稿：人気の公開投稿。押すと右で読む（app.js のプレビュー）。
export function railPostRows(document, posts, { relTime, asset, onOpen }) {
  const items = (Array.isArray(posts) ? posts : []).filter((post) => post?.id).slice(0, 20);
  if (!items.length) return [railState(document, "empty", { title: "公開投稿はまだありません" })];
  return items.map((post) => {
    const name = post.authorName || post.displayName || post.authorHandle || "（名無し）";
    const images = Array.isArray(post.images) ? post.images.length : 0;
    const row = railRow(document, {
      title: name, text: post.body || (images ? "（画像のみ）" : "（本文なし）"), at: post.createdAt, relTime,
      avatar: railAvatar(document, { name, url: post.avatarUrl, asset }),
      onOpen() { onOpen(post, this); },
    });
    // 反応の数と画像の枚数（返る値だけ。0 は出さない）。
    const facts = [[post.replyCount, "返信"], [post.repostCount, "リポスト"], [post.likeCount, "いいね"]]
      .filter(([value]) => Number.isSafeInteger(value) && value > 0).map(([value, label]) => `${label} ${value.toLocaleString("ja-JP")}`);
    if (images) facts.push(`画像 ${images}枚`);
    if (facts.length) row.querySelector(".rail-row-main")?.append(el(document, "span", "rail-row-facts", facts.join(" · ")));
    row.setAttribute("aria-expanded", "false");
    row.title = "右列で投稿を読む";
    return row;
  });
}

// 通知：まとめた行。未読は点、上に「未読 n件」と「すべて既読にする」。
export function railNotificationNodes(document, data, { groups, textOf, relTime, asset, onOpen, onMarkAll, pending = false, canMark = true }) {
  const list = Array.isArray(data?.notifications) ? data.notifications : [];
  if (!list.length) return [railState(document, "empty", { title: "通知はありません" })];
  const actors = new Map((Array.isArray(data.actors) ? data.actors : []).map((actor) => [actor.id, actor]));
  const unread = Number.isSafeInteger(data.unreadCount) ? data.unreadCount : list.filter((item) => !item.isRead).length;
  const markAll = el(document, "button", "rail-head-action", "すべて既読にする");
  markAll.type = "button";
  markAll.disabled = pending || !canMark || unread === 0;
  markAll.onclick = onMarkAll;
  const summary = el(document, "div", "rail-summary");
  summary.append(el(document, "span", "meta", unread ? `未読 ${unread > 99 ? "99+" : unread}件` : "すべて既読です"), markAll);
  const rows = groups(list).slice(0, 30).map((group) => {
    const names = group.actorIds.map((id) => actors.get(id)?.displayName).filter(Boolean);
    const first = actors.get(group.actorIds[0]);
    const others = Math.max(0, group.actorIds.length - 1);
    // 見出しは「誰が」（まとめた行は「ほか n人」）、本文は「何を」。まとめ文（textOf）は読み上げに残す。
    const title = first ? `${first.displayName || first.handle || "Hub"}${others ? ` ほか${others}人` : ""}` : "Hub";
    const row = railRow(document, {
      title, text: group.latest.text || textOf(group, names), at: group.latest.createdAt, relTime,
      unread: !group.isRead,
      label: `${group.isRead ? "" : "未読 "}${title} ${textOf(group, names)}`,
      avatar: first ? railAvatar(document, { name: first.displayName || first.handle, url: first.avatarUrl, asset }) : railAvatar(document, { icon: "bell" }),
      onOpen() { onOpen(group, this); },
    });
    // 元の投稿の本文の頭（ハブが付けたときだけ）。1行で切る。
    const excerpt = group.items.find((item) => typeof item.excerpt === "string" && item.excerpt)?.excerpt;
    if (excerpt) row.querySelector(".rail-row-main")?.append(el(document, "span", "rail-item-quote", excerpt));
    const kind = railNotificationKind(group.latest);
    const avatar = row.querySelector(".rail-row-avatar");
    if (avatar && first) {
      const badge = el(document, "span", `rail-row-kind rail-row-kind--${kind}`);
      badge.append(railIcon(document, kind));
      const wrap = el(document, "span", "rail-row-face");
      avatar.replaceWith(wrap);
      wrap.append(avatar, badge);
    }
    return row;
  });
  return [summary, ...rows];
}

// メッセージ：会話ごとに相手・最後の1行・時刻・未読数。
export function railConversationRows(document, data, { peerOf, relTime, asset, onOpen }) {
  const conversations = Array.isArray(data?.conversations) ? data.conversations : [];
  if (!conversations.length) return [railState(document, "empty", { title: "会話はまだありません" })];
  const profiles = new Map((Array.isArray(data.profiles) ? data.profiles : []).map((profile) => [profile.id, profile]));
  const latest = new Map();
  for (const message of Array.isArray(data.messages) ? data.messages : []) {
    const current = latest.get(message.conversationId);
    if (!current || message.createdAt > current.createdAt) latest.set(message.conversationId, message);
  }
  const at = (conversation) => latest.get(conversation.id)?.createdAt ?? conversation.updatedAt ?? "";
  return [...conversations].sort((a, b) => String(at(b)).localeCompare(String(at(a)))).slice(0, 30).map((conversation) => {
    const peer = peerOf(conversation, profiles, data.currentProfileId) ?? {};
    const message = latest.get(conversation.id);
    const line = message?.previewText || (message?.images?.length ? "（画像）" : message ? "（暗号化されたメッセージ）" : "まだメッセージはありません");
    const unread = conversation.unreadCountByProfileId?.[data.currentProfileId] ?? 0;
    const row = railRow(document, {
      title: peer.displayName || "（名無し）", text: line, at: message?.createdAt, relTime, count: unread,
      avatar: railAvatar(document, { name: peer.displayName || peer.handle, url: peer.avatarUrl, asset }),
      onOpen() { onOpen(conversation, peer, message, this); },
    });
    row.setAttribute("aria-expanded", "false");
    return row;
  });
}

// コミュニティ：参加中を先に、残りを公開コミュニティとして。未読数は API が返さないので出さない。
export function railCommunityNodes(document, data, { asset, onOpen, signedIn = false, connect = null }) {
  const communities = (Array.isArray(data?.communities) ? data.communities : []).filter((item) => item?.id);
  const joinedIds = new Set((Array.isArray(data?.memberships) ? data.memberships : [])
    .filter((item) => item && ["active", "muted"].includes(item.status)).map((item) => item.communityId));
  const row = (item) => {
    const meta = [item.category, Number.isSafeInteger(item.memberCount) ? `${item.memberCount}人` : ""].filter(Boolean).join(" · ");
    const node = railRow(document, {
      title: item.name || "コミュニティ", text: [meta, item.description].filter(Boolean).join("　"),
      avatar: item.imageUrl ? railAvatar(document, { name: item.name, url: item.imageUrl, asset }) : railAvatar(document, { icon: "community" }),
      onOpen() { onOpen(item, this); },
    });
    node.setAttribute("aria-expanded", "false");
    return node;
  };
  const joined = communities.filter((item) => joinedIds.has(item.id)).slice(0, 20);
  const others = communities.filter((item) => !joinedIds.has(item.id)).slice(0, 20);
  const nodes = [];
  if (joined.length) nodes.push(railHeading(document, `参加中 · ${joined.length}`), ...joined.map(row));
  else if (signedIn && others.length) nodes.push(railState(document, "empty", { title: "参加中のコミュニティはありません", detail: "下の一覧から開いて参加できます。" }));
  else if (!signedIn && connect && others.length) nodes.push(railState(document, "signedOut", { title: "接続すると参加中が分かります", detail: "公開コミュニティは接続しなくても読めます。", actions: [{ label: "Desktopを接続", onClick: connect }] }));
  if (others.length) nodes.push(railHeading(document, "公開コミュニティ"), ...others.map(row));
  if (!joined.length && !others.length) return [railState(document, "empty", { title: "公開コミュニティはまだありません" })];
  return nodes;
}

// 再生中のカード。ボタンは中央の再生欄（#music-prev など）を押すだけで、YouTube の再生枠には触れない。
export function railNowPlaying(document, { track, paused, controls }) {
  const card = el(document, "section", "rail-now-playing");
  card.setAttribute("aria-label", "再生中の曲");
  const top = el(document, "div", "rail-now-top");
  top.append(railAvatar(document, { icon: "music" }));
  const text = el(document, "div", "rail-now-text");
  text.append(el(document, "span", "rail-now-state", paused ? "一時停止中" : "再生中"), el(document, "strong", "", track.title || "楽曲"));
  if (track.artist) text.append(el(document, "p", "meta", track.artist));
  top.append(text);
  const row = el(document, "div", "rail-playback-controls");
  for (const control of controls) {
    const button = el(document, "button", control.primary ? "is-primary" : "", control.glyph);
    button.type = "button";
    button.disabled = !!control.disabled;
    if (control.label) button.setAttribute("aria-label", control.label);
    button.onclick = control.onClick;
    row.append(button);
  }
  card.append(top, row);
  return card;
}

// メール：受信箱の1通ごとに送り主・件名・時刻。未読（受信で未開封）は点。本文は右で読む／中央のメールで開く。
export function railMailRows(document, data, { relTime, onOpen }) {
  const items = (Array.isArray(data?.messages) ? data.messages : []).filter((item) => item?.id).slice(0, 30);
  if (!items.length) return [railState(document, "empty", { title: "メールはありません" })];
  return items.map((item) => {
    const inbound = item.direction === "inbound";
    const who = inbound ? item.sender : `宛先: ${item.recipient}`;
    const row = railRow(document, {
      title: who || "（差出人なし）", text: item.subject || "（件名なし）", at: item.createdAt, relTime,
      unread: inbound && !item.readAt, avatar: railAvatar(document, { icon: "message" }),
      onOpen() { onOpen(item, this); },
    });
    row.setAttribute("aria-expanded", "false");
    return row;
  });
}
