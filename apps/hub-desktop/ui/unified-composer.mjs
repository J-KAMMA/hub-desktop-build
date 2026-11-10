// 統合した作成画面（docs/hub-unified-post/DESIGN.md 5）。本文の欄は1つ、下に添付の棒。
// 種類は添付から導出して欄の上の札でその場で出す。置き場は開いた場所で決まり、選ばせない。
// サーバーへ送るのは create_post_v2 だけ（hub_client.rs の閉じた表）。ここでは何も保存しない。
import { derivePostKind, KIND_BADGE, PAPER_LICENCE_IDS } from "./post-kind.mjs";

export const LICENCE_LABELS = Object.freeze({
  arr: "全権利留保", "cc-by-4.0": "CC BY", "cc-by-sa-4.0": "CC BY-SA", "cc-by-nc-4.0": "CC BY-NC", "cc-by-nc-sa-4.0": "CC BY-NC-SA",
  "cc-by-nd-4.0": "CC BY-ND", "cc-by-nc-nd-4.0": "CC BY-NC-ND", "cc0-1.0": "CC0", "hub-distribution-only": "Hub内のみ",
});
export const EMBED_KINDS = Object.freeze(["hubpedia", "listing", "repo", "game", "book", "ai_endpoint", "ticket", "research_project", "post"]);
export const EMBED_LABELS = Object.freeze({ hubpedia: "Hubpedia", listing: "出品", repo: "コード", game: "ゲーム", book: "本", ai_endpoint: "AI", ticket: "チケット", research_project: "研究", post: "投稿" });
export const MAX_ATTACHMENTS = 200;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PLACE = /^(timeline|thread:[A-Za-z0-9_-]{1,128}|channel:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128})$/;

/** YouTube の URL か素の ID から動画 ID を取り出す。取れなければ null。 */
export function youtubeId(input) {
  const value = String(input ?? "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\.|^m\./, "");
    const found = host === "youtu.be" ? url.pathname.slice(1).split("/")[0]
      : host === "youtube.com" || host === "music.youtube.com" ? (url.searchParams.get("v") || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] || "") : "";
    return /^[A-Za-z0-9_-]{11}$/.test(found) ? found : null;
  } catch { return null; }
}

/**
 * 画面の状態から create_post_v2 の options を作る純粋関数。
 * state: { place, title, body, licence, visibility, gateId, attachments: [{type, refId, meta?}], pollOptions, replyToPostId, quoteOfPostId, rating }
 */
export function buildCreateOptions(state) {
  if (!PLACE.test(state.place ?? "")) throw new Error("place");
  const options = { place: state.place };
  const title = (state.title ?? "").trim();
  if (title) options.title = title.slice(0, 300);
  options.body = state.body ?? "";
  if (state.licence) options.licence = state.licence;
  if (state.visibility === "followers") options.visibility = "followers";
  if (state.replyToPostId) options.replyToPostId = state.replyToPostId;
  if (state.quoteOfPostId) options.quoteOfPostId = state.quoteOfPostId;
  if (state.replyToPostId && state.rating) options.rating = state.rating;
  const attachments = (state.attachments ?? []).map(({ type, refId, meta }) => (meta && Object.keys(meta).length ? { type, refId, meta } : { type, refId }));
  const hasAudio = attachments.some((a) => a.type === "audio");
  // 曲にはゲートを付けない（所有者の決定 4）。
  if (state.gateId && !hasAudio) options.gateId = state.gateId;
  if (attachments.length) options.attachments = attachments.slice(0, MAX_ATTACHMENTS);
  const poll = (state.pollOptions ?? []).map((o) => String(o).trim()).filter(Boolean);
  if (poll.length) options.pollOptions = poll.slice(0, 10);
  return options;
}

/** 欄の上の札に使う種類。返信の中では常に post。 */
export function kindOfState(state) {
  return derivePostKind({
    title: state.title, body: state.body, licence: state.licence, isReply: Boolean(state.replyToPostId),
    gated: Boolean(state.gateId), attachments: state.attachments ?? [],
  });
}

/** 本文が1行を超えるか。 */
export const exceedsOneLine = (body) => /\n/.test(body ?? "") || (body ?? "").length > 80;

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * deps: { icon, invoke, place, placeLabel?, placeIcon?, placeChoices?: [{ value: place, label, icon }] (コミュニティの種類：雑談・質問・募集。先頭が既定), replyToPostId?, quoteOfPostId?, variant?: "inline"|"panel", avatar?(), charLimit?,
 *   prepareImage(file), uploadImage(prepared) -> imageId, loadGates?() -> [{id, description}],
 *   onPosted(post), describeError?, randomId? }
 */
export function createUnifiedComposer(document, deps) {
  const { icon, invoke } = deps;
  const randomId = deps.randomId ?? (() => globalThis.crypto.randomUUID());
  const state = { place: deps.place, title: "", body: "", licence: null, visibility: "public", gateId: null, attachments: [], pollOptions: [],
    replyToPostId: deps.replyToPostId ?? null, quoteOfPostId: deps.quoteOfPostId ?? null, rating: null };
  const choices = Array.isArray(deps.placeChoices) && deps.placeChoices.length ? deps.placeChoices.filter((c) => PLACE.test(c?.value ?? "")) : [];
  if (choices.length) state.place = choices.find((c) => c.value === deps.place)?.value ?? choices[0].value;
  let expanded = false, titleForced = false, busy = false, requestId = randomId(), requestKey = "", gates = null;

  const root = el(document, "form", "uc");
  root.noValidate = true;
  // inline = タイムライン先頭に置く1行→展開。panel = 他の画面で開く幅広の面。
  const variant = deps.variant === "inline" ? "inline" : "panel";
  root.dataset.variant = variant;
  // 流れの下に置く欄（種類の選びがあるとき）の小さな面は上へ開く。
  if (choices.length) root.dataset.menu = "up";
  const avatar = deps.avatar?.() ?? el(document, "span", "post-avatar");
  avatar.classList.add("uc-avatar");
  avatar.setAttribute("aria-hidden", "true");
  const main = el(document, "div", "uc-main");
  const badge = el(document, "span", "uc-kind");
  badge.setAttribute("role", "status");
  // 札は自動で決まる印（押せない）。普通の投稿のときは出さず、種類が変わったときだけ出る。
  badge.title = "種類は内容から自動で決まります";
  // 置き場は開いた場所で決まる。返信と、タイムライン以外の置き場のときだけ小さく示す。
  const placeChip = el(document, "span", "uc-place", deps.replyToPostId ? "返信" : `${deps.placeLabel ?? "タイムライン"}へ`);
  const top = el(document, "div", "uc-top");
  top.append(placeChip);
  top.hidden = choices.length > 0 || !(deps.replyToPostId || (deps.place && deps.place !== "timeline"));

  const title = el(document, "input", "uc-title");
  title.type = "text"; title.maxLength = 300; title.placeholder = "題"; title.hidden = true;
  title.setAttribute("aria-label", "題");
  const body = el(document, "textarea", "uc-body");
  body.rows = 1; body.maxLength = 200000; body.placeholder = deps.placeholder ?? "いまどうしてる？";
  body.setAttribute("aria-label", "本文");
  // 自動で伸びる。伸びた高さを覚えず、毎回 auto から測る。
  const grow = () => { body.style.height = "auto"; const h = body.scrollHeight; if (h) body.style.height = `${h}px`; };

  const chips = el(document, "div", "uc-chips");
  const panel = el(document, "div", "uc-panel");
  panel.hidden = true;
  const bar = el(document, "div", "uc-bar");
  bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "添付");
  const note = el(document, "span", "uc-note");
  note.setAttribute("aria-live", "polite");
  const send = el(document, "button", "uc-send approve", "投稿");
  send.type = "submit";
  // 字数の輪。上限に近いときだけ出る。
  const count = el(document, "span", "uc-count");
  count.hidden = true; count.setAttribute("role", "status");
  // 公開の範囲：既定のまま使う人が大半なので、字は付けず記号だけ。既定と違うときだけ字が付く。
  const visibilityWrap = el(document, "div", "uc-vis");
  const visibility = el(document, "button", "uc-tool uc-visibility");
  visibility.type = "button"; visibility.setAttribute("aria-haspopup", "menu"); visibility.setAttribute("aria-expanded", "false");
  const visibilityMenu = el(document, "div", "uc-menu uc-vis-menu");
  visibilityMenu.setAttribute("role", "menu"); visibilityMenu.hidden = true;
  const VISIBILITY = [["public", "globe", "公開"], ["followers", "people", "フォロワーのみ"]];
  const closeVisibility = () => { visibilityMenu.hidden = true; visibility.setAttribute("aria-expanded", "false"); };
  for (const [value, iconName, label] of VISIBILITY) {
    const item = el(document, "button", `uc-menu-item uc-vis-${value}`);
    item.type = "button"; item.setAttribute("role", "menuitemradio"); item.innerHTML = icon(iconName); item.append(el(document, "span", "uc-tool-text", label));
    item.onclick = () => { state.visibility = value; closeVisibility(); repaint(); visibility.focus(); };
    visibilityMenu.append(item);
  }
  visibility.onclick = () => { closeMenu(); visibilityMenu.hidden = !visibilityMenu.hidden; visibility.setAttribute("aria-expanded", String(!visibilityMenu.hidden)); if (!visibilityMenu.hidden) visibilityMenu.querySelector("button")?.focus(); };
  visibilityWrap.append(visibility, visibilityMenu);
  visibilityWrap.hidden = choices.length > 0;
  // 置き場の選び（コミュニティの種類）。小さな記号＋名前の1つの釦から開く。既定は先頭。
  const placeWrap = el(document, "div", "uc-place-wrap");
  const placePick = el(document, "button", "uc-tool uc-place-pick");
  placePick.type = "button"; placePick.setAttribute("aria-haspopup", "menu"); placePick.setAttribute("aria-expanded", "false");
  const placeMenu = el(document, "div", "uc-menu uc-place-menu");
  placeMenu.setAttribute("role", "menu"); placeMenu.hidden = true;
  const closePlaceMenu = () => { placeMenu.hidden = true; placePick.setAttribute("aria-expanded", "false"); };
  for (const choice of choices) {
    const item = el(document, "button", "uc-menu-item uc-place-item");
    item.type = "button"; item.dataset.place = choice.value; item.setAttribute("role", "menuitemradio");
    item.innerHTML = icon(choice.icon ?? "bubble"); item.append(el(document, "span", "uc-tool-text", choice.label));
    item.onclick = () => { state.place = choice.value; closePlaceMenu(); repaint(); placePick.focus(); };
    placeMenu.append(item);
  }
  placePick.onclick = () => { closeMenu(); closeVisibility(); placeMenu.hidden = !placeMenu.hidden; placePick.setAttribute("aria-expanded", String(!placeMenu.hidden)); if (!placeMenu.hidden) placeMenu.querySelector("button")?.focus(); };
  placeWrap.append(placePick, placeMenu);
  placeWrap.hidden = choices.length === 0;

  const tools = {};
  // 目に見える選択肢は4つ＋「その他」。字を添えて、記号だけの手がかりに頼らない。
  const MENU_KEYS = new Set(["title", "file", "reference", "licence", "gate", "embed"]);
  const addTool = (key, iconName, label, onClick, inMenu = MENU_KEYS.has(key)) => {
    const button = el(document, "button", inMenu ? `uc-menu-item uc-tool-${key}` : `uc-tool uc-tool-${key}`);
    button.type = "button"; button.innerHTML = icon(iconName);
    // 並びの手がかりは記号と置き場。字は持たず、読み上げと吹き出しにだけ名前を渡す。
    if (inMenu) button.append(el(document, "span", "uc-tool-text", label)); else { button.title = label; button.setAttribute("aria-label", label); }
    button.onclick = (event) => { closeMenu(); onClick(event); };
    tools[key] = button; (inMenu ? menu : bar).append(button); return button;
  };
  const moreWrap = el(document, "div", "uc-more");
  const moreButton = el(document, "button", "uc-tool uc-tool-more");
  moreButton.type = "button"; moreButton.innerHTML = icon("more"); moreButton.title = "その他"; moreButton.setAttribute("aria-label", "その他");
  moreButton.setAttribute("aria-haspopup", "menu"); moreButton.setAttribute("aria-expanded", "false");
  const menu = el(document, "div", "uc-menu");
  menu.setAttribute("role", "menu"); menu.hidden = true;
  const closeMenu = () => { menu.hidden = true; moreButton.setAttribute("aria-expanded", "false"); };
  moreButton.onclick = () => { closeVisibility(); menu.hidden = !menu.hidden; moreButton.setAttribute("aria-expanded", String(!menu.hidden)); if (!menu.hidden) menu.querySelector("button:not(:disabled)")?.focus(); };
  moreWrap.append(moreButton, menu);

  const setNote = (text, tone) => { note.textContent = text; note.dataset.tone = tone ?? ""; };
  const closePanel = () => { panel.hidden = true; panel.replaceChildren(); };
  const openPanel = (...nodes) => { panel.replaceChildren(...nodes); panel.hidden = false; nodes[0]?.querySelector?.("input,select,textarea")?.focus(); };
  const add = (attachment) => {
    if (state.attachments.length >= MAX_ATTACHMENTS) return setNote("添付が多すぎます", "error");
    state.attachments.push(attachment); repaint();
  };
  const okButton = (label) => {
    const ok = el(document, "button", "uc-tool"); ok.type = "button"; ok.innerHTML = icon("check"); ok.title = "付ける"; ok.setAttribute("aria-label", `${label}を付ける`);
    return ok;
  };
  const input = (type, hint, label, max = 128) => {
    const node = el(document, "input", "uc-input"); node.type = type; node.placeholder = hint; node.setAttribute("aria-label", label); node.maxLength = max; return node;
  };

  function chipLabel(a) {
    return { image: "画像", file: "ファイル", audio: "音", video: "動画", external_video: "YouTube", poll: "投票", reference: a.meta?.citation || a.meta?.doi || a.meta?.url || "参考文献",
      link: a.meta?.title || "リンク", embed: EMBED_LABELS[a.meta?.embedKind] ?? "参照" }[a.type] ?? a.type;
  }
  const chipIcon = { image: "image", file: "doc", audio: "music", video: "video", external_video: "external", poll: "poll", reference: "quote", link: "external", embed: "embed" };
  const chip = (type, iconName, label, remove) => {
    const node = el(document, "span", `uc-chip uc-chip-${type}`);
    node.innerHTML = icon(iconName);
    const x = el(document, "button", "uc-chip-remove");
    x.type = "button"; x.innerHTML = icon("x"); x.title = "外す"; x.setAttribute("aria-label", `${label}を外す`); x.onclick = remove;
    node.append(el(document, "span", "uc-chip-label", label), x);
    return node;
  };
  function paintChips() {
    const nodes = state.attachments.map((a, index) => chip(a.type, chipIcon[a.type] ?? "doc", chipLabel(a), () => {
      state.attachments.splice(index, 1);
      if (!state.attachments.some((x) => x.type === "poll")) state.pollOptions = [];
      repaint();
    }));
    if (state.licence) nodes.push(chip("licence", "licence", LICENCE_LABELS[state.licence] ?? state.licence, () => { state.licence = null; repaint(); }));
    if (state.gateId) nodes.push(chip("gate", "lock", "ゲート", () => { state.gateId = null; repaint(); }));
    chips.replaceChildren(...nodes); chips.hidden = nodes.length === 0;
  }

  function repaint() {
    state.title = title.value; state.body = body.value;
    const kind = kindOfState(state);
    const spec = KIND_BADGE[kind];
    badge.dataset.kind = kind;
    badge.innerHTML = `${icon(spec.icon)}<span>${spec.label}</span>`;
    badge.title = spec.label;
    badge.hidden = kind === "post";
    // 題は本文が1行を超えたら自動で出る。それまでは「その他」の中の「題」から。外す操作も同じ場所。
    const showTitle = titleForced || exceedsOneLine(state.body) || Boolean(state.title.trim());
    title.hidden = !showTitle;
    tools.title.querySelector(".uc-tool-text").textContent = showTitle ? "題を外す" : "題を付ける";
    tools.title.disabled = showTitle && !titleForced;
    const hasAudio = state.attachments.some((a) => a.type === "audio");
    if (hasAudio && state.gateId) state.gateId = null;
    tools.gate.disabled = hasAudio;
    tools.gate.hidden = !deps.loadGates;
    tools.gate.title = tools.gate.disabled ? "曲にはゲートを付けられません" : "";
    tools.poll.disabled = state.attachments.some((a) => a.type === "poll");
    if (choices.length) {
      state.visibility = "public";
      const chosen = choices.find((c) => c.value === state.place) ?? choices[0];
      placePick.innerHTML = icon(chosen.icon ?? "bubble");
      placePick.append(el(document, "span", "uc-tool-text", chosen.label));
      placePick.title = `種類：${chosen.label}`; placePick.setAttribute("aria-label", placePick.title);
      for (const item of placeMenu.children) item.setAttribute("aria-checked", String(item.dataset.place === state.place));
    }
    const followersOnly = state.visibility === "followers";
    visibility.innerHTML = icon(followersOnly ? "people" : "globe");
    visibility.classList.toggle("uc-visibility-changed", followersOnly);
    if (followersOnly) visibility.append(el(document, "span", "uc-tool-text", "フォロワーのみ"));
    visibility.title = followersOnly ? "公開の範囲：フォロワーのみ" : "公開の範囲：公開";
    visibility.setAttribute("aria-label", visibility.title);
    for (const item of visibilityMenu.children) item.setAttribute("aria-checked", String(item.classList.contains(`uc-vis-${state.visibility}`)));
    // 字数：上限（deps.charLimit）の手前でだけ出す。輪が満ちていく。
    const limit = deps.charLimit ?? body.maxLength, used = [...state.body].length;
    const near = limit > 0 && used >= limit - Math.min(60, Math.ceil(limit * 0.12));
    count.hidden = !near;
    if (near) {
      const left = limit - used;
      count.dataset.over = String(left < 0);
      count.textContent = String(left);
      count.setAttribute("aria-label", left < 0 ? `${-left}字超えています` : `あと${left}字`);
    }
    grow();
    root.dataset.expanded = String(variant === "panel" || expanded || state.body !== "" || state.attachments.length > 0 || !panel.hidden);
    send.disabled = busy || (!state.body.trim() && state.attachments.length === 0) || (limit > 0 && used > limit);
    paintChips();
  }

  // 添付の棒
  const imageInput = el(document, "input"); imageInput.type = "file"; imageInput.accept = "image/jpeg,image/png,image/webp"; imageInput.multiple = true; imageInput.hidden = true;
  addTool("image", "image", "画像", () => imageInput.click());
  imageInput.onchange = async () => {
    const files = [...imageInput.files]; imageInput.value = "";
    for (const file of files) {
      if (state.attachments.filter((a) => a.type === "image").length >= 4) { setNote("画像は4枚まで", "error"); break; }
      try {
        setNote("画像を処理しています…");
        const refId = await deps.uploadImage(await deps.prepareImage(file));
        add({ type: "image", refId, meta: { alt: "" } }); setNote("");
      } catch (error) { setNote(String(error?.message ?? error), "error"); }
    }
  };
  const idPanel = (type, iconName, label, hint) => () => {
    const row = el(document, "div", "uc-panel-row");
    const field = input("text", hint, label);
    const ok = okButton(label);
    const run = () => { const value = field.value.trim(); if (!ID.test(value)) { field.setAttribute("aria-invalid", "true"); return; } add({ type, refId: value }); closePanel(); };
    ok.onclick = run; field.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } };
    const mark = el(document, "span", "uc-panel-icon"); mark.innerHTML = icon(iconName);
    row.append(mark, field, ok); openPanel(row);
  };
  // 動画・音声は1つの入口。種類を選んで、YouTube の URL か ID を入れる。
  addTool("media", "video", "動画・音声", () => {
    const row = el(document, "div", "uc-panel-row");
    const kind = el(document, "select", "uc-input uc-kind-select"); kind.setAttribute("aria-label", "種類");
    for (const [value, text] of [["external_video", "YouTube"], ["video", "動画ID"], ["audio", "曲ID"]]) kind.append(Object.assign(el(document, "option", "", text), { value }));
    const field = input("text", "https://youtu.be/…", "URL または ID", 300);
    kind.onchange = () => { field.placeholder = kind.value === "external_video" ? "https://youtu.be/…" : kind.value === "video" ? "動画ID" : "曲ID"; field.removeAttribute("aria-invalid"); };
    const ok = okButton("動画・音声");
    const run = () => {
      if (kind.value === "external_video") {
        const id = youtubeId(field.value); if (!id) { field.setAttribute("aria-invalid", "true"); return; }
        add({ type: "external_video", refId: id, meta: { provider: "youtube" } }); closePanel(); return;
      }
      const value = field.value.trim(); if (!ID.test(value)) { field.setAttribute("aria-invalid", "true"); return; }
      add({ type: kind.value, refId: value }); closePanel();
    };
    ok.onclick = run; field.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } };
    row.append(kind, field, ok); openPanel(row); field.focus();
  });
  addTool("link", "external", "リンク", () => {
    const row = el(document, "div", "uc-panel-row");
    const field = input("url", "https://…", "リンクの URL", 1000);
    const ok = okButton("リンク");
    const run = () => {
      let url = null; try { url = new URL(field.value.trim()); } catch { /* 下で弾く */ }
      if (!url || url.protocol !== "https:") { field.setAttribute("aria-invalid", "true"); return; }
      add({ type: "link", refId: url.href, meta: { title: url.hostname } }); closePanel();
    };
    ok.onclick = run; field.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } };
    const mark = el(document, "span", "uc-panel-icon"); mark.innerHTML = icon("external");
    row.append(mark, field, ok); openPanel(row);
  });
  addTool("poll", "poll", "投票", () => {
    const col = el(document, "div", "uc-panel-col");
    const fields = [];
    const controls = el(document, "div", "uc-panel-row");
    const addOption = () => {
      if (fields.length >= 10) return;
      const field = input("text", String(fields.length + 1), `選択肢${fields.length + 1}`, 200);
      fields.push(field); col.insertBefore(field, controls);
    };
    const more = el(document, "button", "uc-tool"); more.type = "button"; more.innerHTML = icon("compose"); more.title = "選択肢を足す"; more.setAttribute("aria-label", "選択肢を足す"); more.onclick = addOption;
    const ok = okButton("投票");
    ok.onclick = () => {
      const values = fields.map((f) => f.value.trim()).filter(Boolean);
      if (values.length < 2) { fields.find((f) => !f.value.trim())?.setAttribute("aria-invalid", "true"); return; }
      state.pollOptions = values; add({ type: "poll", refId: `poll_${randomId().replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}` }); closePanel();
    };
    controls.append(more, ok); col.append(controls); addOption(); addOption(); openPanel(col);
  });
  addTool("title", "title", "題を付ける", () => { titleForced = !titleForced; repaint(); if (!title.hidden) title.focus(); else body.focus(); });
  addTool("file", "doc", "ファイル", idPanel("file", "doc", "ファイル", "ファイルID"), true);
  addTool("reference", "quote", "参考文献", () => {
    const col = el(document, "div", "uc-panel-col");
    const fields = [["citation", "書誌", "text"], ["doi", "DOI", "text"], ["url", "URL", "url"]].map(([key, label, type]) => {
      const field = input(type, label, label, 1000); field.dataset.key = key; return field;
    });
    const ok = okButton("参考文献");
    ok.onclick = () => {
      const meta = {}; for (const field of fields) if (field.value.trim()) meta[field.dataset.key] = field.value.trim();
      if (!Object.keys(meta).length) { fields[0].setAttribute("aria-invalid", "true"); return; }
      if (meta.url && !/^https:\/\//.test(meta.url)) { fields[2].setAttribute("aria-invalid", "true"); return; }
      add({ type: "reference", refId: `ref_${randomId().replace(/[^A-Za-z0-9]/g, "").slice(0, 24)}`, meta }); closePanel(); tools.reference.focus();
    };
    col.append(...fields, ok); openPanel(col);
  });
  const selectPanel = (label, options, current, onPick) => {
    const row = el(document, "div", "uc-panel-row");
    const select = el(document, "select", "uc-input"); select.setAttribute("aria-label", label);
    for (const [value, text] of options) select.append(Object.assign(el(document, "option", "", text), { value }));
    select.value = current ?? "";
    select.onchange = () => onPick(select.value);
    row.append(select); openPanel(row);
  };
  addTool("licence", "licence", "ライセンス", () => selectPanel("ライセンス",
    [["", "なし"], ...PAPER_LICENCE_IDS.map((id) => [id, LICENCE_LABELS[id] ?? id])], state.licence,
    (value) => { state.licence = value || null; repaint(); closePanel(); tools.licence.focus(); }));
  addTool("gate", "lock", "ゲート", async () => {
    if (!deps.loadGates) return;
    try { gates ??= await deps.loadGates(); } catch { setNote("ゲートを読み込めません", "error"); return; }
    selectPanel("ゲート", [["", "なし"], ...gates.filter((g) => ID.test(g.id ?? "")).map((g) => [g.id, g.description || g.id])], state.gateId,
      (value) => { state.gateId = value || null; repaint(); closePanel(); tools.gate.focus(); });
  });
  addTool("embed", "embed", "参照", () => {
    const row = el(document, "div", "uc-panel-row");
    const select = el(document, "select", "uc-input"); select.setAttribute("aria-label", "参照の種類");
    for (const kind of EMBED_KINDS) select.append(Object.assign(el(document, "option", "", EMBED_LABELS[kind]), { value: kind }));
    const field = input("text", "ID", "参照先のID");
    const ok = okButton("参照");
    const run = () => { const value = field.value.trim(); if (!ID.test(value)) { field.setAttribute("aria-invalid", "true"); return; } add({ type: "embed", refId: value, meta: { embedKind: select.value } }); closePanel(); };
    ok.onclick = run; field.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } };
    row.append(select, field, ok); openPanel(row);
  });
  bar.append(moreWrap);

  const foot = el(document, "div", "uc-foot");
  foot.append(bar, note, count, placeWrap, visibilityWrap, send);
  main.append(badge, top, title, body, chips, panel, foot, imageInput);
  root.append(avatar, main);
  root.addEventListener("click", (event) => {
    if (!menu.hidden && !moreWrap.contains(event.target)) closeMenu();
    if (!visibilityMenu.hidden && !visibilityWrap.contains(event.target)) closeVisibility();
    if (!placeMenu.hidden && !placeWrap.contains(event.target)) closePlaceMenu();
  });
  body.addEventListener("focus", () => { expanded = true; repaint(); });
  // 空のまま外へ出たら1行へ戻る。中身があるうちは開いたまま。
  root.addEventListener("focusout", (event) => { if (variant === "inline" && !root.contains(event.relatedTarget) && event.relatedTarget !== null) { expanded = false; repaint(); } });
  body.addEventListener("input", repaint); title.addEventListener("input", repaint);
  root.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); }
    else if (event.key === "Escape" && (!menu.hidden || !visibilityMenu.hidden || !placeMenu.hidden || !panel.hidden)) {
      // 開いている小さな面を先に閉じる。ダイアログ自体は次の Esc で閉じる。
      event.preventDefault(); event.stopPropagation();
      if (!placeMenu.hidden) { closePlaceMenu(); placePick.focus(); } else if (!visibilityMenu.hidden) { closeVisibility(); visibility.focus(); } else if (!menu.hidden) { closeMenu(); moreButton.focus(); } else closePanel();
    }
  });
  root.addEventListener("submit", (event) => { event.preventDefault(); void submit(); });

  async function submit() {
    repaint();
    if (busy || send.disabled) return null;
    let options;
    try { options = buildCreateOptions(state); } catch { setNote("置き場を確かめられません", "error"); return null; }
    // 同じ中身の再送は同じ requestId（冪等）。中身が変われば別の requestId。
    const key = JSON.stringify(options);
    if (key !== requestKey) { requestKey = key; requestId = randomId(); }
    busy = true; send.disabled = true; setNote("送っています…");
    try {
      const result = await invoke("hub_client_action", { action: "create_post_v2", requestId, options });
      const post = result?.post ?? null;
      reset();
      setNote(post?.status === "held" ? "審査中" : "", post?.status === "held" ? "held" : "");
      deps.onPosted?.(post);
      return post;
    } catch (error) {
      setNote(deps.describeError ? deps.describeError(error) : String(error?.message ?? error), "error");
      return null;
    } finally { busy = false; repaint(); }
  }
  function reset() {
    Object.assign(state, { title: "", body: "", licence: null, visibility: "public", gateId: null, attachments: [], pollOptions: [], rating: null });
    title.value = ""; body.value = ""; titleForced = false; requestKey = ""; requestId = randomId(); closePanel(); repaint();
  }
  repaint();
  return { root, state, body, title, submit, reset, repaint, focus: () => { body.focus(); }, collapse: () => { expanded = false; repaint(); } };
}
