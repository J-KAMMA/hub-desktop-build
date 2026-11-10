// 詳細面（docs/hub-unified-post/DESIGN.md 6）。種類ごとに 投稿＝会話、記事＝読む画面、曲＝プレイヤー＋本文、
// 動画＝プレイヤー＋時刻付きの返信、論文＝要旨・本文・参考文献・ライセンス・版・PDF・引用・取り下げ。
// 広告は adsAllowed が false のとき出さない（NC の論文があるページ）。サーバーへの操作は呼び出し側が渡した関数だけ。
import { KIND_BADGE } from "./post-kind.mjs";
import { pointsBadge } from "./post-row.mjs";
import { createUnifiedRow, firstLines, imageSrc, isUnifiedPost, youtubeThumb } from "./unified-row.mjs";
import { LICENCE_LABELS } from "./unified-composer.mjs";
import { REPLY_DEPTH_CAP, buildReplyTree, renderReplyTree } from "./reply-tree.mjs";
import { roleMark } from "./role-mark.mjs";

const make = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

/** GET posts/{id} は Post をそのまま、または { post } で返す。どちらも受ける。 */
export function unwrapPost(data) {
  if (data && isUnifiedPost(data.post)) return { post: data.post, adsAllowed: data.adsAllowed ?? data.post.adsAllowed };
  if (isUnifiedPost(data)) return { post: data, adsAllowed: data.adsAllowed };
  return null;
}

/** 動画の返信の先頭の時刻（1:23、01:02:03）。秒にして返す。無ければ null。 */
export function leadingTimestamp(body) {
  const m = String(body ?? "").match(/^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?!\d)/);
  if (!m) return null;
  const seconds = (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
  return Number(m[3]) < 60 && Number(m[2]) < 60 ? { seconds, text: m[0].trim() } : null;
}

const year = (post) => String(post.publishedAt ?? post.createdAt ?? "").slice(0, 4) || "n.d.";
export function citationApa(post, url = "") {
  const who = post.author?.displayName || post.author?.handle || "Hub";
  return `${who} (${year(post)}). ${post.title ?? ""}. Hub.${url ? ` ${url}` : ""}`.replace(/\s+/g, " ").trim();
}
export function citationBibtex(post, url = "") {
  const key = `${(post.author?.handle || "hub").replace(/\W/g, "")}${year(post)}${String(post.id).replace(/\W/g, "").slice(0, 6)}`;
  const esc = (s) => String(s ?? "").replace(/[{}\\]/g, "");
  return [`@misc{${key},`, `  author = {${esc(post.author?.displayName || post.author?.handle || "Hub")}},`, `  title = {${esc(post.title)}},`, `  year = {${year(post)}},`,
    ...(url ? [`  url = {${url}},`] : []), `  note = {Hub, revision ${post.revision ?? 1}}`, "}"].join("\n");
}

function refNode(document, a, deps) {
  const li = make(document, "li", "ud-ref");
  const { citation, doi, url } = a.meta ?? {};
  li.append(make(document, "span", "ud-ref-text", citation || doi || url || ""));
  if (doi) {
    const link = make(document, "button", "ud-ref-link", `doi:${doi}`);
    link.type = "button"; link.onclick = () => deps.openExternal?.(`https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, "/")}`);
    li.append(" ", link);
  }
  if (url && /^https:\/\//.test(url)) {
    const link = make(document, "button", "ud-ref-link"); link.type = "button"; link.innerHTML = deps.icon("external"); link.title = url; link.setAttribute("aria-label", "参考文献を開く");
    link.onclick = () => deps.openExternal?.(url);
    li.append(" ", link);
  }
  return li;
}

function bylineNode(document, post, deps) {
  const node = make(document, "div", "article-byline ud-byline");
  const avatar = make(document, "span", "article-author-avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = [...(post.author?.displayName || post.author?.handle || "?")][0] ?? "";
  const text = make(document, "div", "article-byline-text");
  const who = make(document, post.author?.handle ? "button" : "span", "article-author-name", post.author?.displayName || post.author?.handle || "Hubの書き手");
  if (post.author?.handle && deps.onAuthor) { who.type = "button"; who.onclick = () => deps.onAuthor(post.author.handle); }
  const facts = make(document, "div", "article-byline-facts");
  const bits = [post.author?.handle ? `@${post.author.handle}` : "", deps.relTime(post.publishedAt ?? post.createdAt, { absolute: true }),
    post.kind === "article" || post.kind === "paper" ? deps.readingLabel?.(post.body ?? "") ?? "" : ""].filter(Boolean);
  facts.append(make(document, "span", "meta", bits.join(" · ")));
  const role = roleMark(document, post.author?.communityRole ?? null);
  if (role) facts.append(role);
  const points = pointsBadge(document, post.author?.badgePoints ?? null, deps.icon);
  if (points) facts.append(points);
  const spec = KIND_BADGE[post.kind] ?? KIND_BADGE.post;
  const badge = make(document, "span", "uc-kind"); badge.dataset.kind = post.kind; badge.innerHTML = `${deps.icon(spec.icon)}<span>${spec.label}</span>`;
  facts.append(badge);
  if (post.licence) { const lic = make(document, "span", "uc-kind ud-licence"); lic.innerHTML = `${deps.icon("licence")}<span>${LICENCE_LABELS[post.licence] ?? post.licence}</span>`; facts.append(lic); }
  text.append(who, facts);
  node.append(avatar, text);
  return node;
}

function bodyNodes(document, post, deps) {
  const wrap = make(document, "div", "article-reader-body detail-body ud-body");
  if (post.bodyFormat === "latex") { wrap.append(make(document, "pre", "ud-latex", post.body ?? "")); return wrap; }
  if (deps.renderBody) { wrap.append(...deps.renderBody(post.body ?? "", post.bodyFormat)); return wrap; }
  for (const part of String(post.body ?? "").split(/\n{2,}/)) if (part.trim()) wrap.append(make(document, "p", "detail-p", part));
  return wrap;
}

function lockedNode(document, post, deps) {
  const node = make(document, "div", "ud-locked");
  node.innerHTML = deps.icon("lock");
  node.append(make(document, "span", "", post.gate?.description ?? ""));
  return node;
}

function attachmentsNode(document, post, deps) {
  const list = post.attachments ?? [];
  const box = make(document, "div", "ud-attachments");
  const images = list.filter((a) => a.type === "image" && !a.locked);
  if (images.length) {
    const grid = make(document, "div", `post-images post-images--${Math.min(4, images.length)}`);
    for (const a of images.slice(0, 4)) { const img = document.createElement("img"); deps.hubAsset(img, a.meta?.url || imageSrc(a.refId, "full")); img.alt = a.meta?.alt || ""; img.loading = "lazy"; grid.append(img); }
    box.append(grid);
  }
  for (const a of list) {
    if (a.locked) { const lock = make(document, "div", "ud-locked"); lock.innerHTML = deps.icon("lock"); lock.append(make(document, "span", "", a.gate?.description ?? "")); box.append(lock); continue; }
    if (a.type === "file") {
      const button = make(document, "button", "ud-file"); button.type = "button"; button.innerHTML = deps.icon("doc");
      button.append(make(document, "span", "", a.meta?.name || "ファイル")); button.onclick = () => deps.onOpenFile?.(a.refId, post);
      box.append(button);
    } else if (a.type === "link") {
      const button = make(document, "button", "ud-file"); button.type = "button"; button.innerHTML = deps.icon("external");
      button.append(make(document, "span", "", a.meta?.title || a.refId)); button.onclick = () => deps.openExternal?.(a.refId);
      box.append(button);
    } else if (a.type === "embed") {
      const button = make(document, "button", "ud-file"); button.type = "button"; button.innerHTML = deps.icon("embed");
      button.append(make(document, "span", "", a.meta?.embedKind ?? "")); button.onclick = () => deps.onOpenEmbed?.(a.meta?.embedKind, a.refId);
      box.append(button);
    } else if (a.type === "poll") {
      box.append(deps.renderPoll ? deps.renderPoll(post, a) : make(document, "div", "ud-file", ""));
    }
  }
  return box;
}

function playerNode(document, post, deps) {
  const list = (post.attachments ?? []).filter((a) => !a.locked);
  const video = list.find((a) => a.type === "video");
  const external = list.find((a) => a.type === "external_video");
  const audio = list.find((a) => a.type === "audio");
  const frame = make(document, "div", "ud-player");
  if (external) {
    if (deps.renderYoutube) frame.append(deps.renderYoutube(external.refId));
    else {
      const url = youtubeThumb(external.refId);
      if (url) { const img = document.createElement("img"); img.src = url; img.alt = ""; img.onerror = () => img.remove(); frame.append(img); }
      const open = make(document, "button", "ud-play"); open.type = "button"; open.innerHTML = deps.icon("video"); open.setAttribute("aria-label", "再生"); open.title = "再生";
      open.onclick = () => deps.openExternal?.(`https://www.youtube.com/watch?v=${external.refId}`);
      frame.append(open);
    }
    frame.dataset.provider = "youtube";
  } else if (video) {
    frame.append(deps.renderVideoPlayer ? deps.renderVideoPlayer(video.refId, post) : (() => { const b = make(document, "button", "ud-play"); b.type = "button"; b.innerHTML = deps.icon("video"); b.setAttribute("aria-label", "再生"); b.title = "再生"; b.onclick = () => deps.onPlayVideo?.(video.refId, post); return b; })());
  } else if (audio) {
    frame.classList.add("ud-player-audio");
    frame.append(deps.renderMusicPlayer ? deps.renderMusicPlayer(audio.refId, post) : (() => { const b = make(document, "button", "ud-play"); b.type = "button"; b.innerHTML = deps.icon("music"); b.setAttribute("aria-label", "再生"); b.title = "再生"; b.onclick = () => deps.onPlayAudio?.(audio.refId, post); return b; })());
  } else return null;
  return frame;
}

function actionBar(document, post, deps, onReplyClick) {
  const state = { liked: post.viewer?.liked === true, saved: post.viewer?.saved === true, counts: { ...post.counts } };
  const bar = make(document, "div", "post-actions ud-actions");
  bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "操作");
  const button = (name, label, onClick) => {
    const b = make(document, "button", "post-action"); b.type = "button"; b.innerHTML = `${deps.icon(name)}<b class="post-action-count"></b>`; b.title = label; b.setAttribute("aria-label", label); b.onclick = onClick; return b;
  };
  const reply = button("reply", "返信", onReplyClick);
  const like = button("heart", "いいね", () => toggle("like", "liked", "likes"));
  const share = button("share", "共有", () => deps.onShare?.(post));
  const save = button("bookmark", "保存", () => toggle("save", "saved", "saves"));
  share.classList.add("uc-act-right");
  const flag = button("flag", "通報", () => deps.onReport?.(post));
  bar.append(like, reply, share, save);
  if (deps.onReport && post.author) bar.append(flag);
  let pending = false;
  function paint() {
    const set = (b, count, active, cls) => {
      b.querySelector(".post-action-count").textContent = count ? String(count) : "";
      b.setAttribute("aria-pressed", String(Boolean(active))); if (cls) b.classList.toggle(cls, Boolean(active));
    };
    set(like, state.counts.likes, state.liked, "is-liked"); set(save, state.counts.saves, state.saved, "is-saved"); set(reply, state.counts.replies);
  }
  function toggle(action, key, countKey) {
    if (!deps.onReact || pending) return;
    pending = true; const next = !state[key]; state[key] = next; state.counts[countKey] += next ? 1 : -1; paint();
    Promise.resolve(deps.onReact(post, { action, on: next })).then((r) => { if (r?.counts) state.counts = { ...r.counts }; if (r?.viewer) { state.liked = r.viewer.liked === true; state.saved = r.viewer.saved === true; } })
      .catch(() => { state[key] = !next; state.counts[countKey] += next ? -1 : 1; }).finally(() => { pending = false; paint(); });
  }
  paint();
  return bar;
}

function withdrawnNode(document, post, deps) {
  const node = make(document, "div", "ud-withdrawn");
  node.setAttribute("role", "status");
  node.innerHTML = deps.icon("alert");
  node.append(make(document, "span", "", "取り下げ済み"));
  return node;
}

/**
 * target に描く。data は GET posts/{id}。deps は row の deps に加えて
 * { loadReplies(post) -> {items}, loadRevisions(post) -> {items}, composer?(post) -> Node, postUrl?(post), renderBody?, renderYoutube?, renderVideoPlayer?, renderMusicPlayer?,
 *   onSeek?(seconds), onOpenFile?, openExternal?, onReport?, onAdsAllowed?(boolean), readingLabel?(body), isCurrent?() }
 */
export function renderUnifiedPostDetail(document, target, data, deps) {
  const unwrapped = unwrapPost(data);
  if (!unwrapped) return null;
  const { post } = unwrapped;
  const adsAllowed = unwrapped.adsAllowed !== false;
  const kind = post.kind;
  const root = make(document, "article", `ud ud-${kind}${kind === "article" || kind === "paper" ? " article-reader" : ""}`);
  root.dataset.kind = kind; root.dataset.postId = post.id; root.dataset.adsAllowed = String(adsAllowed);
  if (post.status === "withdrawn") root.dataset.status = "withdrawn";
  deps.onAdsAllowed?.(adsAllowed);

  const locked = post.locked === true;
  if (post.title) root.append(make(document, "h1", `article-title ud-title`, post.title));
  if (post.status === "withdrawn") root.append(withdrawnNode(document, post, deps));
  if (post.status === "held") { const held = make(document, "div", "ud-held"); held.innerHTML = deps.icon("clock"); held.append(make(document, "span", "", "審査中")); root.append(held); }
  if ((kind === "article" || kind === "paper") && post.summary && !locked) root.append(make(document, "p", kind === "paper" ? "ud-abstract" : "article-lead", post.summary));
  root.append(bylineNode(document, post, deps));

  if (locked) root.append(lockedNode(document, post, deps));
  else {
    if (kind === "video" || kind === "music") { const player = playerNode(document, post, deps); if (player) root.append(player); }
    if (post.body) root.append(bodyNodes(document, post, deps));
    root.append(attachmentsNode(document, post, deps));
    if (kind === "paper") {
      const refs = (post.attachments ?? []).filter((a) => a.type === "reference" && !a.locked);
      if (refs.length) {
        const section = make(document, "section", "ud-section ud-references");
        const head = make(document, "h2", "ud-heading"); head.innerHTML = deps.icon("quote"); head.append(make(document, "span", "", String(refs.length)));
        head.title = "参考文献"; head.setAttribute("aria-label", `参考文献 ${refs.length}件`);
        const ol = make(document, "ol", "ud-ref-list"); for (const a of refs) ol.append(refNode(document, a, deps));
        section.append(head, ol); root.append(section);
      }
      const cite = make(document, "section", "ud-section ud-cite");
      const url = deps.postUrl?.(post) ?? "";
      for (const [label, text] of [["APA", citationApa(post, url)], ["BibTeX", citationBibtex(post, url)]]) {
        const b = make(document, "button", "ud-cite-button", label); b.type = "button"; b.title = `${label}でコピー`; b.setAttribute("aria-label", `${label}の引用をコピー`);
        b.onclick = () => { Promise.resolve(deps.copyText?.(text)).then(() => { b.dataset.done = "true"; }).catch(() => {}); };
        cite.append(b);
      }
      root.append(cite);
      const revisions = make(document, "section", "ud-section ud-revisions");
      root.append(revisions);
      if (deps.loadRevisions) {
        Promise.resolve(deps.loadRevisions(post)).then((result) => {
          const items = Array.isArray(result?.items) ? result.items : [];
          if (!items.length || deps.isCurrent?.() === false) return;
          const head = make(document, "h2", "ud-heading"); head.innerHTML = deps.icon("clock"); head.append(make(document, "span", "", String(items.length))); head.title = "版"; head.setAttribute("aria-label", `版 ${items.length}件`);
          const ul = make(document, "ul", "ud-rev-list");
          for (const item of items) {
            const li = make(document, "li", "ud-rev");
            li.append(make(document, "b", "", `v${item.revision}`), make(document, "span", "meta", deps.relTime(item.createdAt, { absolute: true })));
            if (item.licence) li.append(make(document, "span", "meta", LICENCE_LABELS[item.licence] ?? item.licence));
            ul.append(li);
          }
          revisions.replaceChildren(head, ul);
        }).catch(() => {});
      }
    }
  }

  const replies = make(document, "section", "ud-replies");
  const composerHost = make(document, "div", "ud-composer");
  root.append(actionBar(document, post, deps, () => composerHost.querySelector("textarea")?.focus()), composerHost, replies);
  if (deps.composer && post.status !== "withdrawn" && !locked) composerHost.append(deps.composer(post));

  // 返信は木で並べる：親子で入れ子、左の線で畳む、深さは REPLY_DEPTH_CAP まで（その下は「続き」でその返信の詳細へ）。
  const collapsed = deps.collapsedReplies ?? new Set();
  const replyRow = (reply) => {
    const row = createUnifiedRow(document, reply, { ...deps, onOpen: (r) => deps.onOpen?.(r) });
    const stamp = kind === "video" ? leadingTimestamp(reply.body) : null;
    if (stamp && deps.onSeek) {
      const chip = make(document, "button", "ud-stamp", stamp.text); chip.type = "button"; chip.title = "ここから再生"; chip.setAttribute("aria-label", `${stamp.text} から再生`);
      chip.onclick = (event) => { event.stopPropagation(); deps.onSeek(stamp.seconds); };
      row.querySelector(".post-head")?.append(chip);
    }
    return row;
  };
  const paintReplies = (items) => {
    const tree = buildReplyTree(items, post.id);
    replies.dataset.count = String(items.length);
    replies.replaceChildren(...(tree.length ? [renderReplyTree(document, tree, {
      renderItem: replyRow, collapsed, maxDepth: deps.replyDepth ?? REPLY_DEPTH_CAP,
      onContinue: (reply) => deps.onOpen?.(reply),
      pendingCount: (reply) => reply.counts?.replies ?? 0,
      loadChildren: (reply) => Promise.resolve(deps.loadReplies(reply)).then((result) => (Array.isArray(result?.items) ? result.items.filter(isUnifiedPost) : [])),
    })] : []));
  };
  if (!locked && deps.loadReplies) {
    Promise.resolve(deps.loadReplies(post)).then((result) => {
      if (deps.isCurrent?.() === false) return;
      const items = Array.isArray(result?.items) ? result.items.filter(isUnifiedPost) : [];
      if (kind === "video") items.sort((a, b) => (leadingTimestamp(a.body)?.seconds ?? Infinity) - (leadingTimestamp(b.body)?.seconds ?? Infinity));
      paintReplies(items);
      if (result?.adsAllowed === false) { root.dataset.adsAllowed = "false"; deps.onAdsAllowed?.(false); }
    }).catch(() => {});
  }
  target.replaceChildren(root);
  return { root, post, adsAllowed };
}

export { firstLines };
