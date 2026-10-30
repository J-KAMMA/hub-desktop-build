// 画面の状態表示（Web の components/v2/v2-state.tsx と同じ形、2026-10-29）。
// empty / signedOut / error / loading を 1 つの部品で出す。色は components.css が意味名の変数で決める。
// loading は文字ではなく骨組みの行を出す（Web の SkeletonList と同じ寸法）。
// DOM は既存の .state-panel / .state-icon / .state-title / .state-body / .state-action を保ち、
// 既存の検査と CSS をそのまま使える。

const LEADING_TAG = /^\s*(?:【[^】]*】|\[[^\]]*\]|［[^］]*］|〔[^〕]*〕|\([^)]*\)|（[^）]*）)\s*/u;

function firstLetter(text) {
  for (const char of Array.from(String(text).trim())) {
    if (/[\p{L}\p{N}]/u.test(char)) return char.toUpperCase();
  }
  return null;
}

// 先頭の【見本】・[WIP] のような札は飛ばして、名前の最初の字を取る（Web の displayInitial と同じ）。
export function displayInitial(name, fallback = '?') {
  const full = String(name ?? '').trim();
  let rest = full;
  for (let i = 0; i < 3 && LEADING_TAG.test(rest); i += 1) rest = rest.replace(LEADING_TAG, '');
  return firstLetter(rest) ?? firstLetter(full) ?? fallback;
}

// 1..6。31 倍のハッシュを 6 で割った余り（Web の avatarTint と同じ）。
export function avatarTint(name) {
  let hash = 0;
  for (const char of Array.from(String(name ?? '').trim())) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  return (hash % 6) + 1;
}

export const STATE_KINDS = ['empty', 'signedOut', 'error', 'loading'];
const DEFAULT_ICON = { empty: 'inbox', signedOut: 'lock', error: 'alert', loading: 'clock' };
const DEFAULT_TITLE = { signedOut: 'ログインが必要です', error: '読み込めませんでした', empty: '' };
const DEFAULT_ACTION_LABEL = { signedOut: 'ログイン', error: '再試行' };

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 骨組みの 1 行：顔 40 + 2 行（72px）。
export function skeletonRow(doc) {
  const row = el(doc, 'div', 'ds-skel-row');
  row.setAttribute('aria-hidden', 'true');
  const col = el(doc, 'span', 'ds-skel-col');
  col.append(el(doc, 'span', 'skeleton-block ds-skel-line'), el(doc, 'span', 'skeleton-block ds-skel-line is-half'));
  row.append(el(doc, 'span', 'skeleton-block ds-skel-face'), col);
  return row;
}

// 骨組みの群。「読み込んでいます」を 1 回だけ読み上げる。
export function skeletonList(doc, count = 6, label = '読み込んでいます') {
  const group = el(doc, 'div', 'ds-skel-group');
  group.setAttribute('role', 'status');
  group.setAttribute('aria-busy', 'true');
  group.setAttribute('aria-live', 'polite');
  group.append(el(doc, 'span', 'ds-sr', label));
  const n = Math.max(1, Math.min(Math.trunc(Number(count)) || 1, 12));
  for (let i = 0; i < n; i += 1) group.append(skeletonRow(doc));
  return group;
}

function actionButton(doc, action, primary) {
  const button = el(doc, 'button', `btn ${primary ? 'btn-primary' : 'btn-ghost'} state-action`, action.label);
  button.type = 'button';
  button.onclick = () => { if (typeof action.onClick === 'function') action.onClick(button); };
  return button;
}

// opts: { kind, icon, title, note, action:{label,onClick}, secondaryAction, compact, rows, iconSvg(name) }
export function createState(doc, opts = {}) {
  const kind = STATE_KINDS.includes(opts.kind) ? opts.kind : 'empty';
  const compact = opts.compact ? ' is-compact' : '';
  if (kind === 'loading') {
    const wrap = el(doc, 'div', `ds-state ds-state--loading${compact}`);
    wrap.append(skeletonList(doc, opts.rows ?? 6, opts.title || '読み込んでいます'));
    return wrap;
  }
  const box = el(doc, 'div', `ds-state ds-state--${kind} state-panel empty-state${compact}`);
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const disc = el(doc, 'span', 'ds-state__disc state-icon empty-icon');
  disc.setAttribute('aria-hidden', 'true');
  const name = opts.icon || DEFAULT_ICON[kind];
  if (typeof opts.iconSvg === 'function') disc.innerHTML = opts.iconSvg(name);
  box.append(disc);
  const title = opts.title ?? DEFAULT_TITLE[kind];
  if (title) box.append(el(doc, 'strong', 'state-title', title));
  if (opts.note) box.append(el(doc, 'p', 'state-body', opts.note));
  const primary = opts.action && opts.action.label ? opts.action : null;
  const secondary = opts.secondaryAction && opts.secondaryAction.label ? opts.secondaryAction : null;
  if (primary || secondary) {
    const actions = el(doc, 'div', 'ds-state__actions');
    if (primary) actions.append(actionButton(doc, primary, true));
    if (secondary) actions.append(actionButton(doc, secondary, false));
    box.append(actions);
  }
  return box;
}

// 端のぼかし：横にはみ出したタブ列の、はみ出した側だけに 24px のぼかしを当てる（Web の .ui-tabs と同じ）。
// 印は data-fade-start / data-fade-end。見た目は components.css が --edge-fade で決める。
export function updateEdgeFade(node) {
  const max = node.scrollWidth - node.clientWidth;
  const left = Math.abs(node.scrollLeft);
  const start = max > 1 && left > 1;
  const end = max > 1 && left < max - 1;
  node.toggleAttribute('data-fade-start', start);
  node.toggleAttribute('data-fade-end', end);
}

export function bindEdgeFade(doc, selector = '.page-tabs') {
  const view = doc.defaultView;
  for (const node of doc.querySelectorAll(selector)) {
    const run = () => updateEdgeFade(node);
    node.addEventListener('scroll', run, { passive: true });
    if (view?.ResizeObserver) new view.ResizeObserver(run).observe(node);
    if (view?.MutationObserver) new view.MutationObserver(run).observe(node, { childList: true, subtree: true, characterData: true });
    run();
  }
}
