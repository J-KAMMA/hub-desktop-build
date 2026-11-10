// グループ（コミュニティ）の中の分け方。docs/hub-groups/DESIGN.md 「グループの中の分け方」
// - チャット：左の列のチャンネル（#雑談 #質問 #募集）。チャンネル＝投稿の種類（kind）で、投稿は community_posts のまま。
// - 共有：記事・動画・音楽・共同ページを種類で絞って並べる。
// - メンバー。
// 中央の画面と右列で同じ形にするための、画面に依存しない部品だけをここに置く。説明の文は置かない。
export const GROUP_TABS = Object.freeze([['chat', 'チャット'], ['shared', '共有'], ['members', 'メンバー']]);
export const SHARED_KINDS = Object.freeze([['article', '記事'], ['video', '動画'], ['music', '音楽'], ['guide', '共同ページ']]);
export const CHANNEL_DEFAULTS = Object.freeze([
  Object.freeze({ kind: 'chat', name: '雑談', hidden: false }),
  Object.freeze({ kind: 'question', name: '質問', hidden: false }),
  Object.freeze({ kind: 'party', name: '募集', hidden: false })]);
const KINDS = CHANNEL_DEFAULTS.map((channel) => channel.kind);

const make = (document, tag, label = '', className = '') => { const node = document.createElement(tag); if (label) node.textContent = label; if (className) node.className = className; return node; };
const button = (document, label, className, onClick) => { const node = make(document, 'button', label, className); node.type = 'button'; node.onclick = onClick; return node; };

/** サーバーの応答から、表示できるチャンネルだけを取り出す。形が違えば既定の3つ。 */
export function parseChannels(raw) {
  const list = Array.isArray(raw?.channels) ? raw.channels : null;
  if (!list) return { channels: CHANNEL_DEFAULTS.map((channel) => ({ ...channel })), canManage: false };
  const seen = new Set();
  const channels = [];
  for (const item of list) {
    if (!item || !KINDS.includes(item.kind) || seen.has(item.kind) || typeof item.name !== 'string' || !item.name || item.name.length > 24) continue;
    seen.add(item.kind);
    channels.push({ kind: item.kind, name: item.name, hidden: item.hidden === true });
  }
  if (!channels.length) return { channels: CHANNEL_DEFAULTS.map((channel) => ({ ...channel })), canManage: false };
  return { channels, canManage: raw.canManage === true };
}

/** 読めなければ既定の3つ（チャンネルの設定は付け足しの情報で、チャットを塞がない）。 */
export async function loadChannels(invoke, communityId) {
  try { return parseChannels(await invoke('hub_detail', { name: 'community_channels', ids: [communityId] })); }
  catch { return parseChannels(null); }
}

/** 選べるチャンネル（隠れていないもの）。選択中が無くなっていたら先頭。 */
export const shownChannels = (channels) => channels.filter((channel) => !channel.hidden);
export const pickChannel = (channels, kind) => { const shown = shownChannels(channels); return shown.find((channel) => channel.kind === kind) ?? shown[0] ?? null; };

/** モデレーターが送る変更。サーバーと同じ閉じた形だけ。 */
export const renameUpdate = (kind, name) => ({ kind, name });
export const hiddenUpdate = (kind, hidden) => ({ kind, hidden });
export function moveUpdate(channels, kind, delta) {
  const order = channels.map((channel) => channel.kind);
  const at = order.indexOf(kind), to = at + delta;
  if (at < 0 || to < 0 || to >= order.length) return null;
  [order[at], order[to]] = [order[to], order[at]];
  return { order };
}

/**
 * チャンネルの列。縦（中央の左の列）か横（右列のチップ）。
 * モデレーターには「⋯」で管理の行（名前・上下・隠す・戻す）が開く。変更は onManage(update) が実行して新しい一覧を返す。
 */
export function createChannelColumn({ document, channels, canManage = false, selected, onSelect, onManage = null, horizontal = false, sidebar = false, extras = [], prompt = (text, value) => globalThis.prompt?.(text, value) }) {
  const root = make(document, 'nav', '', `community-channels${horizontal ? ' is-horizontal' : ''}${sidebar ? ' is-sidebar' : ''}`);
  root.setAttribute('aria-label', 'チャンネル');
  const state = { channels, selected, extra: null, managing: false, busy: false, note: '' };
  const list = make(document, 'div', '', 'community-channel-list');
  list.setAttribute('role', 'group');
  const manage = canManage && onManage ? button(document, '⋯', `community-channel-manage${sidebar ? ' sidebar-context-item' : ''}`, () => { state.managing = !state.managing; paint(); }) : null;
  if (manage) { manage.setAttribute('aria-label', 'チャンネルを整える'); manage.title = 'チャンネルを整える'; manage.setAttribute('data-keep-text', ''); }
  const note = make(document, 'p', '', 'meta warning'); note.setAttribute('role', 'status');
  root.append(list, note);
  if (manage) root.append(manage);

  async function apply(update) {
    if (state.busy || !update) return;
    state.busy = true; state.note = ''; paint();
    try {
      const next = await onManage(update);
      if (next?.channels) {
        state.channels = next.channels;
        if (!pickChannel(state.channels, state.selected)) state.selected = null;
        const picked = pickChannel(state.channels, state.selected);
        if (picked && picked.kind !== state.selected) { state.selected = picked.kind; onSelect?.(picked.kind); }
      }
    } catch (error) { state.note = typeof error?.message === 'string' ? error.message : '変更できませんでした。'; }
    finally { state.busy = false; paint(); }
  }
  function paint() {
    const rows = [];
    for (const channel of state.managing ? state.channels : shownChannels(state.channels)) {
      const row = make(document, 'div', '', `community-channel-row${channel.hidden ? ' is-hidden' : ''}`);
      row.dataset.kind = channel.kind;
      const pick = button(document, `#${channel.name}`, `community-channel${sidebar ? ' sidebar-context-item' : ''}`, () => { if ((state.selected !== channel.kind || state.extra) && !channel.hidden) { state.selected = channel.kind; state.extra = null; paint(); onSelect?.(channel.kind); } });
      pick.dataset.kind = channel.kind;
      pick.setAttribute('aria-pressed', String(state.selected === channel.kind));
      pick.setAttribute('data-keep-text', '');
      if (state.selected === channel.kind) pick.setAttribute('aria-current', 'true');
      pick.disabled = channel.hidden;
      row.append(pick);
      if (state.managing) {
        const at = state.channels.indexOf(channel);
        const tools = make(document, 'span', '', 'community-channel-tools');
        const tool = (label, text, run, disabled = false) => { const b = button(document, text, 'community-channel-tool', run); b.setAttribute('data-keep-text', ''); b.setAttribute('aria-label', label); b.title = label; b.disabled = disabled || state.busy; return b; };
        tools.append(
          tool('名前を変える', '✎', () => { const name = prompt('チャンネルの名前（24文字まで）', channel.name)?.trim(); if (name && name !== channel.name) void apply(renameUpdate(channel.kind, name)); }),
          tool('上へ', '↑', () => void apply(moveUpdate(state.channels, channel.kind, -1)), at === 0),
          tool('下へ', '↓', () => void apply(moveUpdate(state.channels, channel.kind, 1)), at === state.channels.length - 1),
          tool(channel.hidden ? '戻す' : '隠す', channel.hidden ? '＋' : '×', () => void apply(hiddenUpdate(channel.kind, !channel.hidden))));
        row.append(tools);
      }
      rows.push(row);
    }
    // チャンネルの並びの後ろに続けて置く切り替え（右列の 共有 / メンバー）。選ぶとチャンネルの選択は外れる。
    for (const extra of extras) {
      const row = make(document, 'div', '', 'community-channel-row');
      const pick = button(document, extra.label, 'community-channel is-extra', () => { if (state.extra !== extra.key) { state.extra = extra.key; state.selected = null; paint(); extra.onSelect?.(extra.key); } });
      pick.dataset.extra = extra.key;
      pick.setAttribute('aria-pressed', String(state.extra === extra.key));
      pick.setAttribute('data-keep-text', '');
      row.append(pick);
      rows.push(row);
    }
    list.replaceChildren(...rows);
    note.textContent = state.note; note.hidden = !state.note;
    if (manage) manage.setAttribute('aria-pressed', String(state.managing));
  }
  paint();
  return {
    root,
    get selected() { return state.selected; },
    get channels() { return state.channels; },
    set(kind) { state.selected = kind; state.extra = null; paint(); },
    setExtra(key) { state.extra = key; state.selected = null; paint(); },
  };
}

/**
 * 共有。種類（記事 / 動画 / 音楽 / 共同ページ）のチップで絞る。
 * 記事・動画・音楽は createContentTabs（community-content.mjs）、共同ページは mountGuides(host) が描く（投稿の kind=guide）。
 */
export function createSharedTab({ document, createContentTabs, mountGuides, initial = 'article', onKind = () => {}, isCurrent = () => true }) {
  const root = make(document, 'div', '', 'community-shared');
  const chips = make(document, 'div', '', 'chip-row community-shared-kinds');
  chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', '共有の種類');
  const body = make(document, 'div', '', 'community-shared-body');
  root.append(chips, body);
  const state = { kind: SHARED_KINDS.some(([key]) => key === initial) ? initial : 'article', controller: null, disposed: false };
  const pending = [];
  function paint() {
    for (const chip of chips.children) chip.setAttribute('aria-pressed', String(chip.dataset.kind === state.kind));
  }
  function show() {
    state.controller?.dispose?.(); state.controller = null;
    body.replaceChildren();
    if (state.kind === 'guide') {
      const host = make(document, 'div', '', 'community-stream community-guides');
      body.append(host);
      const mounted = mountGuides(host);
      state.controller = { dispose() { mounted?.dispose?.(); }, invalidate() { mounted?.invalidate?.(); } };
      if (mounted?.ready) pending.push(mounted.ready);
    } else {
      const tabs = createContentTabs(state.kind);
      body.append(tabs.root);
      state.controller = tabs;
      if (tabs.ready) pending.push(tabs.ready);
    }
    paint();
  }
  for (const [key, label] of SHARED_KINDS) {
    const chip = button(document, label, 'chip', () => { if (state.kind !== key && isCurrent() && !state.disposed) { state.kind = key; onKind(key); show(); } });
    chip.dataset.kind = key;
    chips.append(chip);
  }
  show();
  return {
    root,
    get kind() { return state.kind; },
    get ready() { return Promise.all(pending); },
    dispose() { state.disposed = true; state.controller?.dispose?.(); },
    invalidate() { state.controller?.invalidate?.(); },
  };
}
