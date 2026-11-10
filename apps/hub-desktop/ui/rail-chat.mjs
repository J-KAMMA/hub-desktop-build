// 右列のグループ（公開＝コミュニティ、非公開＝グループDM）をチャットの見せ方で出す。
// 新しい書き込みが下に足されていく。スレッドはこれを使わず、投稿として番号付きで読む見せ方のまま。
// 見せ方だけを揃える：公開は hub_detail（community_posts）、非公開は hub_client（conversations）の読み出しで、保存・暗号・モデレーションは混ぜない。
// 書き込み：公開は中央の作成欄と同じ community_post（参加者のみ。未参加は参加ボタン）、非公開は既存のDM送信（dm-controller）だけを通す。
// 送った行はすぐ下に足し（送信中）、失敗したら行の上で再試行する。下書きはグループごとにメモリだけに持つ。
// 更新：開いている間は rail-group-live.mjs が新着を知る（繋がっていればリアルタイム、でなければ定期取得）。
// 取り直しは新しい書き込みだけを下に足し、先に出した行は作り直さない。
// 公開グループは中央と同じ分け方（docs/hub-groups/DESIGN.md「グループの中の分け方」）：チャット（チャンネルのチップ）/ 共有 / メンバー。
// チャンネル＝投稿の種類（kind）。書き込みはそのチャンネルの kind で community_post に送る。非公開（グループDM）は従来のまま。

import { createDmController } from "./dm-controller.mjs";
import { subscribeGroup } from "./rail-group-live.mjs";
import { createChannelColumn, createSharedTab, loadChannels, pickChannel } from "./community-channels.mjs";
import { roleMark } from "./role-mark.mjs";
import { createCommunityContentTabs } from "./community-content.mjs";

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const time = (value) => { const at = Date.parse(value); return Number.isFinite(at) ? at : 0; };
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGES = 4;
const PUBLIC_MAX = 2000;
const PRIVATE_MAX = 280;
const PREWRITE_REJECTED = /^community_post_prewrite_rejected:(400|401|403|404|413|429)(?::|$)/u;

// 公開グループの読み出しを、チャットの行に直す。古い順。
export function publicChatMessages(data) {
  const profiles = data?.profiles && typeof data.profiles === "object" ? data.profiles : {};
  const lookup = (id) => (Array.isArray(profiles) ? profiles.find((p) => p?.id === id) : profiles[id]) ?? null;
  return (Array.isArray(data?.messages) ? data.messages : []).filter((m) => m?.id).map((m) => {
    const who = lookup(m.authorProfileId);
    return {
      id: m.id, at: m.createdAt, own: Boolean(data?.viewerProfileId && m.authorProfileId === data.viewerProfileId),
      name: who?.displayName || who?.handle || "メンバー", avatarUrl: who?.avatarUrl ?? null, role: who?.communityRole ?? null,
      text: typeof m.body === "string" ? m.body : "", images: Array.isArray(m.images) ? m.images : [],
      kind: m.kind && m.kind !== "chat" ? m.kind : "", replyTo: m.replyToMessageId ?? null,
    };
  }).sort((a, b) => time(a.at) - time(b.at) || (a.id < b.id ? -1 : 1));
}

// 非公開グループ（グループDM）の読み出しを、同じ形の行に直す。本文は端末で解いた previewText だけを使う。
export function privateChatMessages(data, conversationId) {
  const profiles = new Map((Array.isArray(data?.profiles) ? data.profiles : []).map((p) => [p.id, p]));
  return (Array.isArray(data?.messages) ? data.messages : []).filter((m) => m?.id && m.conversationId === conversationId).map((m) => {
    const who = profiles.get(m.senderProfileId);
    const images = Array.isArray(m.images) ? m.images : [];
    return {
      id: m.id, at: m.createdAt, own: Boolean(data?.currentProfileId && m.senderProfileId === data.currentProfileId),
      name: who?.displayName || who?.handle || "メンバー", avatarUrl: who?.avatarUrl ?? null,
      text: m.previewText || (images.length ? "" : "（暗号化されたメッセージ。中央の会話で確認できます）"), images, kind: "", replyTo: null,
    };
  }).sort((a, b) => time(a.at) - time(b.at) || (a.id < b.id ? -1 : 1));
}

// 中央の作成欄（community-post-composer.mjs）と同じ規則で、再送しても同じ書き込みになる ID を作る。
async function expectedMessageId(viewerId, communityId, requestId) {
  const bytes = new TextEncoder().encode(JSON.stringify(["hub-community-message-v1", viewerId, communityId, requestId]));
  return "cm-" + [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function scopeParts(scope) {
  try {
    const pair = JSON.parse(scope?.key ?? "null");
    return Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string" ? { origin: pair[0], deviceId: pair[1] } : null;
  } catch { return null; }
}
// 公開グループはチャンネルごとに別の下書き・送信中の行を持つ。
const groupKey = (group, channel = "") => (group.kind === "private" ? `private:${group.id}` : `public:${group.id}:${channel}`);

export function createRailChat({ document, invoke, deps }) {
  const {
    relTime, hubAsset, icon, paintAvatar, friendlyError = String, openCentral,
    getScope = async () => null, getDmScope = getScope, uploadImages, uploadDmImages, processImage,
    isActive = () => true, subscribe = subscribeGroup, realtime = null, openContent = () => {},
  } = deps;
  const win = document.defaultView;
  const gk = () => groupKey(group, channelKind);
  const root = el(document, "section", "rail-chat");
  root.hidden = true;
  root.setAttribute("aria-label", "グループのチャット");
  const head = el(document, "div", "rail-chat-head");
  const back = el(document, "button", "rail-chat-back");
  back.type = "button";
  back.setAttribute("aria-label", "グループの一覧へ戻る");
  back.title = "一覧へ戻る";
  back.innerHTML = icon("back");
  const titleWrap = el(document, "div", "rail-chat-title");
  const title = el(document, "strong", "", "");
  const lock = el(document, "span", "rail-chat-lock");
  lock.setAttribute("role", "img");
  lock.setAttribute("aria-label", "非公開");
  lock.title = "非公開（端から端まで暗号）";
  lock.innerHTML = icon("lock");
  lock.hidden = true;
  const sub = el(document, "span", "meta rail-chat-sub");
  titleWrap.append(el(document, "span", "rail-chat-name"), sub);
  titleWrap.firstChild.append(title, lock);
  const openButton = el(document, "button", "rail-chat-open");
  openButton.type = "button";
  openButton.setAttribute("aria-label", "中央で開く");
  openButton.title = "中央で開く";
  openButton.innerHTML = icon("external");
  head.append(back, titleWrap, openButton);
  const placeOpen = (inMenu) => {
    if (inMenu) { openButton.classList.add("is-item"); openButton.replaceChildren(); openButton.textContent = "中央で開く"; moreList.append(openButton); }
    else { openButton.classList.remove("is-item"); openButton.innerHTML = icon("external"); head.append(openButton); }
  };
  const status = el(document, "p", "meta rail-chat-status");
  status.setAttribute("role", "status");
  const list = el(document, "ol", "rail-chat-list");
  // 公開グループだけ：チャット / 共有 / メンバーの切り替えと、チャンネルのチップ。
  // 細い1本の帯：チャンネルのチップ（#雑談 #質問 #募集 ＋ 共有 メンバー）と ⋯（中央で開く）。
  const nav = el(document, "div", "rail-chat-nav");
  nav.hidden = true;
  const channelsHost = el(document, "div", "rail-chat-channels");
  const more = el(document, "details", "rail-chat-more");
  const moreToggle = el(document, "summary", "rail-chat-more-toggle", "⋯");
  moreToggle.setAttribute("aria-label", "その他の操作"); moreToggle.title = "その他の操作"; moreToggle.setAttribute("data-keep-text", "");
  const moreList = el(document, "div", "rail-chat-more-list");
  more.append(moreToggle, moreList);
  more.addEventListener("keydown", (event) => { if (event.key === "Escape" && more.open) { event.stopPropagation(); more.open = false; moreToggle.focus(); } });
  nav.append(channelsHost, more);
  const pane = el(document, "div", "rail-chat-pane");
  pane.hidden = true;
  let railColumn = null;

  // 書き込み欄
  const foot = el(document, "div", "rail-chat-foot");
  const join = el(document, "button", "rail-chat-join", "参加して書く");
  join.type = "button";
  join.hidden = true;
  const form = el(document, "form", "rail-chat-compose");
  const strip = el(document, "div", "rail-chat-attachments");
  const row = el(document, "div", "rail-chat-compose-row");
  const attach = el(document, "button", "rail-chat-attach");
  attach.type = "button"; attach.setAttribute("aria-label", "画像を付ける"); attach.title = "画像を付ける"; attach.innerHTML = icon("image");
  const fileInput = el(document, "input");
  fileInput.type = "file"; fileInput.accept = IMAGE_TYPES.join(","); fileInput.multiple = true; fileInput.hidden = true;
  const input = el(document, "textarea", "rail-chat-input");
  input.rows = 1; input.placeholder = "メッセージを書く"; input.setAttribute("aria-label", "メッセージ（Enterで送信、Shift+Enterで改行）"); input.autocomplete = "off";
  const send = el(document, "button", "approve rail-chat-send");
  send.type = "submit"; send.setAttribute("aria-label", "送信"); send.title = "送信"; send.disabled = true;
  send.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12V3.5M3.5 8 8 3.5 12.5 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const note = el(document, "p", "meta rail-chat-compose-note");
  note.setAttribute("role", "status");
  row.append(attach, input, send);
  form.append(strip, row, note, fileInput);
  foot.append(join, form);
  root.append(head, nav, status, list, pane, foot);

  let group = null, tab = "chat", channelKind = "chat", channelReady = Promise.resolve(), paneController = null, revision = 0, seen = new Set(), onBack = () => {}, meta = { canPost: false, viewerId: null }, live = null, dm = null, inflight = null, lastDm = {};
  const drafts = new Map();      // groupKey → { text, attachments: [{file, item, url}] }
  const entries = new Map();     // groupKey → 送信中・失敗の行
  const draftOf = () => { const key = gk(); if (!drafts.has(key)) drafts.set(key, { text: "", attachments: [] }); return drafts.get(key); };
  const entriesOf = (key) => { if (!entries.has(key)) entries.set(key, []); return entries.get(key); };
  const limit = () => (group?.kind === "private" ? PRIVATE_MAX : PUBLIC_MAX);
  const scrollToEnd = () => {
    const scroller = root.closest(".rail-view");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    list.lastElementChild?.scrollIntoView?.({ block: "end" });
  };

  function message(message) {
    const item = el(document, "li", `rail-chat-msg${message.own ? " is-own" : ""}`);
    item.dataset.messageId = message.id;
    const avatar = el(document, "span", "rail-chat-avatar");
    avatar.setAttribute("aria-hidden", "true");
    if (message.avatarUrl && hubAsset) {
      const img = document.createElement("img");
      hubAsset(img, message.avatarUrl); img.alt = "";
      avatar.classList.add("has-image"); avatar.append(img);
    } else {
      avatar.textContent = (message.name || "?").trim().slice(0, 1).toUpperCase();
      paintAvatar?.(avatar, message.name);
    }
    const bubble = el(document, "div", "rail-chat-bubble");
    const metaLine = el(document, "div", "rail-chat-meta");
    metaLine.append(el(document, "strong", "", message.own ? "あなた" : message.name), ...[roleMark(document, message.role)].filter(Boolean), el(document, "span", "meta", relTime(message.at)));
    bubble.append(metaLine);
    if (message.kind) bubble.append(el(document, "span", "meta rail-chat-kind", message.kind));
    if (message.text) bubble.append(el(document, "p", "rail-chat-text", message.text));
    const images = message.images.slice(0, 4).filter((image) => image?.url);
    if (images.length && hubAsset) {
      const grid = el(document, "div", "rail-chat-images");
      for (const image of images) { const img = document.createElement("img"); hubAsset(img, image.url); img.alt = image.altText || ""; img.loading = "lazy"; grid.append(img); }
      bubble.append(grid);
    }
    item.append(avatar, bubble);
    return item;
  }

  // ---- 送信中・失敗の行 ----
  const pendingNodes = () => list.querySelectorAll(".rail-chat-msg.is-pending, .rail-chat-msg.is-failed");
  function entryRow(entry) {
    const item = el(document, "li", "rail-chat-msg is-own");
    item.dataset.pendingId = entry.id;
    const bubble = el(document, "div", "rail-chat-bubble");
    if (entry.text) bubble.append(el(document, "p", "rail-chat-text", entry.text));
    if (entry.attachments.length) bubble.append(el(document, "span", "meta", `画像 ${entry.attachments.length} 枚`));
    const state = el(document, "div", "rail-chat-entry-state");
    state.setAttribute("role", "status");
    bubble.append(state);
    item.append(bubble);
    entry.node = item; entry.stateNode = state;
    paintEntry(entry);
    return item;
  }
  function paintEntry(entry) {
    const item = entry.node, state = entry.stateNode;
    if (!item) return;
    item.classList.toggle("is-pending", entry.status === "sending");
    item.classList.toggle("is-failed", entry.status !== "sending");
    item.setAttribute("aria-busy", String(entry.status === "sending"));
    state.replaceChildren();
    if (entry.status === "sending") { state.append(el(document, "span", "meta", "送信中…")); return; }
    state.append(el(document, "span", "meta", entry.message || "送れませんでした"));
    if (entry.central) {
      const open = el(document, "button", "rail-chat-retry", "中央で開く");
      open.type = "button"; open.onclick = () => openCentral(group);
      state.append(" ", open);
    } else {
      const label = entry.status !== "unknown" ? "再試行" : entry.kind === "public" ? "確認して再送" : entry.rechecked ? "同じ送信を再試行" : "結果を確認";
      const retry = el(document, "button", "rail-chat-retry", label);
      retry.type = "button"; retry.onclick = () => void retryEntry(entry);
      state.append(" ", retry);
    }
    if (!(entry.status === "unknown" && group?.kind === "private")) {
      const drop = el(document, "button", "rail-chat-retry", "破棄");
      drop.type = "button"; drop.onclick = () => discardEntry(entry);
      state.append(" ", drop);
    }
  }
  function placeEntry(entry) {
    if (!entry.node) entryRow(entry);
    list.append(entry.node);
    scrollToEnd();
  }
  function releaseEntry(entry) {
    for (const a of entry.attachments) if (a.url) win?.URL?.revokeObjectURL?.(a.url);
    for (const a of entry.attachments) if (a.item?.previewUrl) win?.URL?.revokeObjectURL?.(a.item.previewUrl);
  }
  function removeEntry(entry) {
    const all = entriesOf(entry.groupKey), at = all.indexOf(entry);
    if (at >= 0) all.splice(at, 1);
    entry.node?.remove();
    releaseEntry(entry);
    paintCompose();
  }
  function discardEntry(entry) { removeEntry(entry); }
  const here = (entry) => Boolean(group) && gk() === entry.groupKey;
  function settle(entry) { if (entry.confirmed) { removeEntry(entry); if (here(entry)) void load(); return true; } return false; }
  function fail(entry, status, text, extra = {}) {
    entry.status = status; entry.message = text; Object.assign(entry, extra); paintEntry(entry); paintCompose();
  }

  // ---- 公開グループの送信（中央の作成欄と同じ community_post） ----
  async function runPublic(entry) {
    entry.status = "sending"; paintEntry(entry); paintCompose();
    try {
      const parts = scopeParts(await getScope());
      const viewerId = entry.viewerId ?? meta.viewerId;
      if (!parts || !viewerId) throw new Error("desktop_not_connected");
      entry.viewerId = viewerId;
      const scoped = { expectedDeviceId: parts.deviceId, expectedOrigin: parts.origin, expectedViewerId: viewerId };
      if (!entry.requestId) {
        entry.requestId = globalThis.crypto.randomUUID();
        entry.messageId = await expectedMessageId(viewerId, group.id, entry.requestId);
      }
      if (entry.unsure) {
        // 結果が分からない再送は、先に書き込まれていないか読み直す。あれば確定、なければ同じ requestId で送り直す。
        const data = await invoke("hub_detail", { name: "community_posts", ids: [entry.groupId] });
        if (Array.isArray(data?.messages) && data.messages.some((m) => m?.id === entry.messageId)) { entry.confirmed = true; settle(entry); return; }
      }
      if (entry.attachments.length && !entry.imageIds) {
        if (typeof uploadImages !== "function") throw new Error("post_upload_unavailable");
        entry.imageIds = await uploadImages(entry.attachments.map((a) => a.file), {
          assertCurrent() {}, onProgress() {},
          invoke: (command, args) => invoke(command, { ...args, ...scoped }),
        });
      }
      entry.unsure = true;
      const result = await invoke("hub_client_action", {
        action: "community_post", target: entry.groupId, text: entry.text, requestId: entry.requestId,
        options: { kind: entry.channelKind ?? "chat", replyToMessageId: null, ...(entry.imageIds?.length ? { imageIds: [...entry.imageIds] } : {}), ...scoped },
      });
      if (result?.message?.id !== entry.messageId) throw new Error("post_send_unconfirmed");
      entry.confirmed = true; settle(entry);
    } catch (error) {
      const code = String(error?.message ?? error);
      const certain = PREWRITE_REJECTED.test(code) || !entry.unsure;
      if (certain) entry.unsure = false;
      fail(entry, certain ? "failed" : "unknown", certain ? friendlyError(error) : "送信結果が不明です。結果を確認します。");
    }
  }

  // ---- 非公開グループの送信（既存のDM送信。暗号・事前確認・二重送信防止は dm-controller に任せる） ----
  function ensureDm() {
    if (dm) return dm;
    dm = createDmController({
      invoke, getScope: getDmScope, isCurrent: () => Boolean(group) && !root.hidden,
      getDraft: () => inflight
        ? { text: inflight.text, images: inflight.attachments.map((a) => a.item), revision: inflight.id }
        : { text: "", images: [], revision: 0 },
      uploadFiles: uploadDmImages,
      onState: (value) => { lastDm = value; },
      onSent: () => { if (inflight) inflight.confirmed = true; },
    });
    return dm;
  }
  async function runPrivate(entry) {
    entry.status = "sending"; paintEntry(entry); paintCompose();
    inflight = entry; lastDm = {};
    try {
      const controller = ensureDm();
      let ok;
      if (!(await controller.load(entry.groupId))) throw new Error(lastDm.error ?? "dm_unknown");
      if (entry.dmSent) ok = entry.rechecked ? await controller.retrySame() : await controller.recheck();
      else { entry.dmSent = true; ok = await controller.send(); }
      if (ok || entry.confirmed) { entry.confirmed = true; settle(entry); return; }
      const phase = lastDm.phase, error = String(lastDm.error?.message ?? lastDm.error ?? "");
      if (phase === "unknown" || lastDm.attemptState === "unknown" || lastDm.uncertain) {
        entry.rechecked = Boolean(lastDm.retryAvailable);
        fail(entry, "unknown", "送信結果が不明です。再送せず、結果を確認してください。");
      } else if (error === "dm_e2ee_unavailable") {
        fail(entry, "failed", "暗号化されたグループは、いまは中央の会話から書いてください。", { central: true });
      } else {
        entry.dmSent = false;
        fail(entry, "failed", error ? friendlyError(lastDm.error) : "送れませんでした。");
      }
    } catch (error) {
      fail(entry, entry.dmSent ? "unknown" : "failed", friendlyError(error));
    } finally { if (inflight === entry) inflight = null; }
  }
  const retryEntry = (entry) => (entry.kind === "private" ? runPrivate(entry) : runPublic(entry));

  // ---- 書き込み欄 ----
  const anySending = () => entriesOf(gk()).some((e) => e.status === "sending");
  const privateBlocked = () => group.kind === "private" && entriesOf(gk()).some((e) => e.status === "unknown");
  function paintAttachments() {
    const draft = draftOf();
    strip.replaceChildren(...draft.attachments.map((a, index) => {
      const chip = el(document, "span", "rail-chat-attachment");
      if (a.url) { const img = document.createElement("img"); img.src = a.url; img.alt = ""; chip.append(img); }
      else chip.append(el(document, "span", "meta", a.file.name));
      const remove = el(document, "button", "rail-chat-attachment-remove");
      remove.type = "button"; remove.setAttribute("aria-label", "画像を外す"); remove.title = "画像を外す"; remove.innerHTML = icon("x");
      remove.onclick = () => { const [gone] = draft.attachments.splice(index, 1); if (gone?.url) win?.URL?.revokeObjectURL?.(gone.url); if (gone?.item?.previewUrl) win?.URL?.revokeObjectURL?.(gone.item.previewUrl); paintCompose(); };
      chip.append(remove);
      return chip;
    }));
  }
  function paintCompose() {
    if (!group || (group.kind !== "private" && tab !== "chat")) { foot.hidden = true; return; }
    foot.hidden = false;
    const priv = group.kind === "private";
    const canWrite = priv || meta.canPost === true;
    join.hidden = canWrite;
    form.hidden = !canWrite;
    if (!canWrite) return;
    const draft = draftOf();
    input.maxLength = limit();
    const blocked = anySending() || privateBlocked();
    paintAttachments();
    attach.disabled = draft.attachments.length >= MAX_IMAGES;
    send.disabled = blocked || (!input.value.trim() && !draft.attachments.length);
    if (privateBlocked()) note.textContent = "前の送信の結果を確認してから送れます。";
    else if (note.textContent === "前の送信の結果を確認してから送れます。") note.textContent = "";
  }
  function showDraft() {
    const draft = draftOf();
    input.value = draft.text;
    note.textContent = "";
    fitInput();
    paintCompose();
  }
  function fitInput() {
    input.style.height = "auto";
    if (input.scrollHeight) input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }
  input.addEventListener("input", () => { if (group) draftOf().text = input.value; fitInput(); paintCompose(); });
  // Enter で送る・Shift+Enter で改行。変換中の Enter（確定）では送らない（IME）。DMの欄と同じ。
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!send.disabled) form.requestSubmit ? form.requestSubmit() : submit();
  });
  attach.onclick = () => { if (!attach.disabled) fileInput.click(); };
  fileInput.onchange = () => { const files = [...(fileInput.files ?? [])]; fileInput.value = ""; void addFiles(files); };
  async function addFiles(files) {
    if (!group) return false;
    const draft = draftOf();
    if (draft.attachments.length + files.length > MAX_IMAGES) { note.textContent = `画像は${MAX_IMAGES}枚までです。`; return false; }
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type) || file.size <= 0 || file.size > 5 * 1024 * 1024) { note.textContent = "JPEG・PNG・WebPの5MB以下の画像だけ付けられます。"; return false; }
    }
    const mine = gk();
    for (const file of files) {
      const entry = { file, item: null, url: null };
      try {
        if (group.kind === "private") {
          if (typeof processImage !== "function") { note.textContent = "画像を付けられません。"; return false; }
          entry.item = await processImage(file); entry.url = entry.item?.previewUrl ?? null;
        } else entry.url = win?.URL?.createObjectURL?.(file) ?? null;
      } catch (error) { note.textContent = friendlyError(error); return false; }
      drafts.get(mine)?.attachments.push(entry);
    }
    note.textContent = "";
    if (group && gk() === mine) paintCompose();
    return true;
  }
  function submit() {
    if (!group || send.disabled) return false;
    const draft = draftOf();
    const text = input.value.trim();
    if (!text && !draft.attachments.length) return false;
    const key = gk();
    const entry = {
      id: (entriesOf(key).at(-1)?.id ?? 0) + 1 + Math.floor(Math.random() * 1e6), groupKey: key, groupId: group.id, kind: group.kind === "private" ? "private" : "public", channelKind,
      text, attachments: draft.attachments, status: "sending", message: "", node: null,
    };
    entriesOf(key).push(entry);
    drafts.set(key, { text: "", attachments: [] });
    input.value = ""; note.textContent = ""; fitInput();
    placeEntry(entry); paintCompose();
    void (entry.kind === "private" ? runPrivate(entry) : runPublic(entry));
    return true;
  }
  form.onsubmit = (event) => { event.preventDefault(); submit(); };
  join.onclick = () => { if (group) openCentral(group); };
  openButton.onclick = () => { more.open = false; if (group) openCentral(group); };

  // ---- 読み出し ----
  async function read() {
    if (!group) return [];
    if (group.kind === "private") return privateChatMessages(await invoke("hub_client", { name: "conversations" }), group.id);
    await channelReady;
    const data = await invoke("hub_detail", { name: "community_posts_kind", ids: [group.id, channelKind] });
    meta = { canPost: data?.canPost === true && Boolean(data?.viewerProfileId), viewerId: data?.viewerProfileId ?? null };
    return publicChatMessages(data);
  }

  async function load({ reset = false } = {}) {
    const mine = ++revision;
    if (reset) { seen = new Set(); list.replaceChildren(); }
    status.textContent = reset ? "読み込み中…" : "";
    try {
      const messages = await read();
      if (mine !== revision) return;
      const fresh = messages.filter((m) => !seen.has(m.id));
      const nearEnd = !list.childElementCount || (() => { const s = root.closest(".rail-view"); return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 80; })();
      for (const m of fresh) seen.add(m.id);
      const firstPending = pendingNodes()[0] ?? null;
      for (const node of fresh.map(message)) list.insertBefore(node, firstPending);
      if (reset) for (const entry of entriesOf(gk())) placeEntry(entry);
      status.textContent = messages.length || list.childElementCount ? "" : "まだ書き込みはありません。";
      paintCompose();
      if (reset || (fresh.length && nearEnd)) scrollToEnd();
    } catch (error) {
      if (mine !== revision) return;
      status.textContent = friendlyError(error);
      const retry = el(document, "button", "rail-chat-retry", "再試行");
      retry.type = "button";
      retry.onclick = () => void load({ reset: true });
      status.append(" ", retry);
      paintCompose();
    }
  }

  function stopLive() { live?.stop(); live = null; }
  function startLive() {
    stopLive();
    // 繋がっていればリアルタイム、そうでなければ定期取得（rail-group-live.mjs）。
    live = subscribe({
      win, group, realtime, refresh: () => load(),
      isActive: () => Boolean(group) && !root.hidden && isActive() !== false && win?.document?.visibilityState !== "hidden",
      isFocused: () => win?.document?.hasFocus?.() !== false,
    });
  }

  // ---- 公開グループの 共有 / メンバー ----
  function mountGuides(host, current) {
    const items = el(document, "ol", "rail-chat-list");
    host.append(items);
    let disposed = false;
    const ready = invoke("hub_detail", { name: "community_posts_kind", ids: [group.id, "guide"] }).then((data) => {
      if (disposed || !current()) return;
      const rows = publicChatMessages(data);
      items.replaceChildren(...(rows.length ? rows.map(message) : [el(document, "li", "meta", "まだありません")]));
    }, (error) => { if (!disposed && current()) items.replaceChildren(el(document, "li", "meta", friendlyError(error))); });
    return { ready, dispose() { disposed = true; }, invalidate() { disposed = true; } };
  }
  function mountMembers(host, current) {
    const items = el(document, "ol", "rail-chat-members");
    host.append(items);
    let disposed = false;
    const roles = { owner: "オーナー", moderator: "モデレーター", member: "" };
    const ready = invoke("hub_detail", { name: "community_members", ids: [group.id] }).then((data) => {
      if (disposed || !current()) return;
      const members = Array.isArray(data?.members) ? data.members.filter((m) => m?.id) : [];
      items.replaceChildren(...(members.length ? members.map((m) => {
        const row = el(document, "li", "rail-chat-member");
        const avatar = el(document, "span", "rail-chat-avatar");
        avatar.setAttribute("aria-hidden", "true");
        avatar.textContent = (m.displayName || m.handle || "?").trim().slice(0, 1).toUpperCase();
        paintAvatar?.(avatar, m.displayName || m.handle);
        const who = el(document, "span", "rail-chat-member-name");
        who.append(el(document, "strong", "", m.displayName || m.handle || "メンバー"), el(document, "span", "meta", [m.handle ? `@${m.handle}` : "", roles[m.role] ?? ""].filter(Boolean).join(" · ")));
        row.append(avatar, who);
        return row;
      }) : [el(document, "li", "meta", "メンバーを表示できません")]));
    }, (error) => { if (!disposed && current()) items.replaceChildren(el(document, "li", "meta", friendlyError(error))); });
    return { ready, dispose() { disposed = true; }, invalidate() { disposed = true; } };
  }
  function showTab(next) {
    tab = next;
    const chat = next === "chat";
    if (!chat) railColumn?.setExtra(next);
    status.hidden = !chat; list.hidden = !chat; pane.hidden = chat;
    paneController?.dispose?.(); paneController = null; pane.replaceChildren();
    if (!chat && group) {
      const mine = group, current = () => group === mine && tab === next && !root.hidden;
      if (next === "shared") {
        paneController = createSharedTab({
          document, isCurrent: current,
          createContentTabs: (type) => createCommunityContentTabs({ document, communityId: mine.id, invoke, isCurrent: current, type, open: openContent, describeError: friendlyError }),
          mountGuides: (host) => mountGuides(host, current),
        });
        pane.append(paneController.root);
      } else paneController = mountMembers(pane, current);
    }
    paintCompose();
    if (chat) scrollToEnd();
  }
  function setupPublic(next) {
    nav.hidden = false;
    placeOpen(true);
    channelReady = loadChannels(invoke, next.id).then(({ channels }) => {
      if (group !== next) return;
      const first = pickChannel(channels, channelKind);
      channelKind = first?.kind ?? "chat";
      if (!first) return;
      const column = createChannelColumn({ document, channels, selected: channelKind, horizontal: true,
        extras: [{ key: "shared", label: "共有", onSelect: (key) => { if (group === next) showTab(key); } }, { key: "members", label: "メンバー", onSelect: (key) => { if (group === next) showTab(key); } }],
        onSelect: (kind) => {
          if (group !== next) return;
          if (tab !== "chat") { showTab("chat"); if (kind === channelKind) return; }
          else if (kind === channelKind) return;
          channelKind = kind; showDraft(); void load({ reset: true });
        } });
      railColumn = column;
      channelsHost.replaceChildren(column.root);
    });
  }

  back.onclick = () => onBack();

  return {
    element: root,
    get isOpen() { return !root.hidden; },
    get group() { return group; },
    onBack(fn) { onBack = fn; },
    open(next) {
      group = next;
      meta = { canPost: false, viewerId: null };
      title.textContent = next.title;
      lock.hidden = next.kind !== "private";
      sub.textContent = next.count !== null && next.count !== undefined ? `${next.count.toLocaleString("ja-JP")}人` : "";
      root.hidden = false;
      tab = "chat"; channelKind = "chat"; channelReady = Promise.resolve();
      paneController?.dispose?.(); paneController = null; pane.replaceChildren(); pane.hidden = true;
      channelsHost.replaceChildren(); railColumn = null; more.open = false; status.hidden = false; list.hidden = false;
      nav.hidden = true; placeOpen(false);
      if (next.kind !== "private") setupPublic(next);
      showDraft();
      startLive();
      return load({ reset: true });
    },
    close() {
      stopLive(); dm?.invalidate("view");
      paneController?.dispose?.(); paneController = null; pane.replaceChildren(); pane.hidden = true; nav.hidden = true; channelsHost.replaceChildren(); railColumn = null;
      root.hidden = true; group = null; revision++; seen = new Set(); list.replaceChildren(); status.textContent = ""; paintCompose();
    },
    // 右列の表示・非表示、窓の焦点が変わったときに呼ぶ。止まっていた定期取得を再開する。
    sync() { live?.sync(); },
    refresh: () => (group ? load() : Promise.resolve()),
    // 検査用：入力の操作。
    compose: { input, send, attach, join, form, addFiles, submit, note },
  };
}
