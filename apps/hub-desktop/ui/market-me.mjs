// 「自分」の面（2026-11-03）：カート・ライブラリ・注文を区切り線の行で出す。枠のカードは使わない。
// 数量・削除・配送先の確認・購入手続きは既存の道（app.js の shop.cart / renderCart / #cart-checkout）が持つ。ここは見せ方だけで、
// 押された操作を deps に返す。invoke / open_external / commerce_* は持たない（テストが固定する）。
import { cartEstimate, jpyc, normalizeProduct, priceView, shippingText } from './market-model.mjs';
import { badge, button, el, emptyState, media } from './market-dom.mjs';

const PAGE = 20;

function stepper(document, { value, max, disabled, onChange }) {
  const group = el(document, 'div', 'mk-stepper is-compact');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '数量');
  const minus = button(document, '−', 'mk-step', () => onChange(value - 1));
  minus.setAttribute('aria-label', '1つ減らす');
  const plus = button(document, '＋', 'mk-step', () => onChange(value + 1));
  plus.setAttribute('aria-label', '1つ増やす');
  minus.disabled = disabled || value <= 1;
  plus.disabled = disabled || value >= max;
  group.append(minus, el(document, 'output', 'mk-step-value mk-num', String(value)), plus);
  return group;
}

/**
 * カート。lines：[{ id, product(生の商品または保存した写し), quantity, saved }]
 * deps：setQuantity(id, n) / remove(id) / openItem(id) / checkout() / browse() / lineExtra(line) / locked() / asset
 * options：showTotals（既定 true。既存の #cart-totals を残すなら false）
 */
export function renderCart({ document, host, lines, deps, showTotals = true }) {
  if (!lines.length) {
    host.replaceChildren(emptyState(document, { title: 'カートは空です', body: 'マーケットで商品を追加するとここに出ます。', actionLabel: 'マーケットを見る', onAction: () => deps.browse?.() }));
    return;
  }
  const locked = deps.locked?.() === true;
  const list = el(document, 'ul', 'mk-rows mk-cart-rows');
  for (const line of lines) {
    const item = normalizeProduct(line.product) ?? { id: String(line.id), title: '', images: [], sellerName: '', kind: 'goods', raw: line.product };
    const row = el(document, 'li', 'mk-row');
    row.dataset.id = String(line.id);
    const main = el(document, 'div', 'mk-row-main');
    main.append(media(document, { url: item.images[0], label: item.sellerName || item.title, alt: '', asset: deps.asset, className: 'mk-media mk-row-thumb' }));
    const text = el(document, 'div', 'mk-row-text');
    const title = el(document, 'button', 'mk-row-title', item.title);
    title.type = 'button';
    title.addEventListener('click', () => deps.openItem?.(String(line.id)));
    text.append(title);
    const unit = priceView({ ...item, kind: 'goods' });
    text.append(el(document, 'span', 'mk-row-meta', [item.sellerName, line.saved ? '追加時の価格' : ''].filter(Boolean).join(' · ')));
    text.append(el(document, 'span', 'mk-row-meta', `単価 ${unit.main}${unit.sub.startsWith('税込') ? '（税込）' : ''}`));
    const shipping = shippingText(line.product);
    if (shipping) text.append(el(document, 'span', 'mk-row-meta mk-row-shipping', /JPYC/.test(shipping) ? `送料 ${shipping}` : shipping));
    main.append(text);
    const side = el(document, 'div', 'mk-row-side');
    const max = Math.min(20, line.product.stockQuantity ?? 20);
    side.append(stepper(document, { value: line.quantity, max, disabled: locked, onChange: next => deps.setQuantity(line.id, Math.max(1, Math.min(max, next))) }));
    const amount = Number.isFinite(unit.amount) ? jpyc(unit.amount * line.quantity) : '';
    side.append(el(document, 'strong', 'mk-row-price mk-num', amount));
    const remove = button(document, '削除', 'mk-link', () => deps.remove(line.id));
    remove.disabled = locked;
    side.append(remove);
    main.append(side);
    row.append(main);
    const extra = deps.lineExtra?.(line);
    if (extra) { extra.classList?.add('mk-row-extra'); row.append(extra); }
    list.append(row);
  }
  const nodes = [list];
  if (showTotals) {
    const sum = cartEstimate(lines);
    const totals = el(document, 'dl', 'mk-totals');
    const total = (label, value, className = '') => { const row = el(document, 'div', `mk-total ${className}`.trim()); row.append(el(document, 'dt', '', label), el(document, 'dd', 'mk-num', value)); totals.append(row); };
    total(`小計（${sum.count}点）`, jpyc(sum.items));
    total('送料', sum.unknownShipping ? (sum.shipping ? `${jpyc(sum.shipping)} + 注文時に確認` : '注文時に確認') : sum.shipping ? jpyc(sum.shipping) : '無料');
    total(sum.taxed ? '合計の目安（税込）' : '合計の目安（本体価格）', jpyc(sum.total), 'is-grand');
    nodes.push(totals, el(document, 'p', 'mk-note', '確定額はCommerceが注文時に出します。支払いはウォレットの確認モーダルで承認してから実行されます。'));
    // 購入手続きのボタンは合計の下に1つだけ（Amazon のカート：小計の直下）。合計を既存の面（#cart-summary）が持つときは、その面のボタンが唯一の入口。
    const go = el(document, 'div', 'mk-cart-cta');
    const checkout = button(document, '購入手続きへ', 'mk-btn mk-btn-primary', () => deps.checkout());
    checkout.disabled = locked;
    go.append(checkout);
    nodes.push(go);
  }
  host.replaceChildren(...nodes);
}

const dateText = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ja-JP'); };

function orderRow(document, receipt, deps, { purchased }) {
  const row = el(document, 'li', 'mk-row mk-order');
  row.dataset.id = receipt.id;
  // Amazon の注文履歴：行の頭に注文日と合計の帯（小さな見出しと値）。注文番号は出さない（詳細の画面が持つ）。
  const head = el(document, 'dl', 'mk-order-head');
  const cell = (label, value) => { if (!value) return; const pair = el(document, 'div', 'mk-order-cell'); pair.append(el(document, 'dt', '', label), el(document, 'dd', 'mk-num', value)); head.append(pair); };
  cell('注文日', dateText(receipt.createdAt));
  cell('合計', Number.isFinite(receipt.amountJpyc) ? jpyc(receipt.amountJpyc) : '');
  if (head.childElementCount) row.append(head);
  const main = el(document, 'div', 'mk-row-main');
  main.append(media(document, { url: receipt.imageUrl, label: receipt.title, alt: '', asset: deps.asset, className: 'mk-media mk-row-thumb' }));
  const text = el(document, 'div', 'mk-row-text');
  const title = el(document, 'button', 'mk-row-title', receipt.title);
  title.type = 'button';
  title.addEventListener('click', () => deps.openOrder(receipt.id));
  text.append(title);
  if (receipt.quantity > 1) text.append(el(document, 'span', 'mk-row-meta', `数量 ×${receipt.quantity}`));
  const status = el(document, 'span', 'mk-row-status');
  status.append(badge(document, deps.statusText(receipt.status)));
  if (receipt.fulfillmentStatus) status.append(badge(document, deps.fulfillmentText?.(receipt.fulfillmentStatus) ?? receipt.fulfillmentStatus));
  if (receipt.trackingNumber) status.append(el(document, 'span', 'mk-row-meta mk-num', receipt.trackingNumber));
  text.append(status);
  main.append(text);
  const side = el(document, 'div', 'mk-row-side');
  if (purchased && receipt.fulfillmentType === 'digital') side.append(button(document, 'ダウンロード（Webで開く） ↗', 'mk-btn mk-btn-compact', () => deps.openWeb('/v2/market/digital')));
  side.append(button(document, purchased ? '詳細・受取・返品' : '詳細', 'mk-btn mk-btn-compact', () => deps.openOrder(receipt.id)));
  if (!purchased && deps.refresh) side.append(button(document, '状態を更新', 'mk-link', () => deps.refresh(receipt)));
  main.append(side);
  row.append(main);
  return row;
}

export const isPurchased = receipt => ['paid', 'partially_refunded'].includes(receipt?.status);

/** 購入済み：支払いが済んだ注文を、買った品として並べる。 */
export function renderPurchased({ document, host, receipts, deps }) {
  const items = receipts.filter(deps.isPurchased ?? isPurchased);
  if (!items.length) {
    host.replaceChildren(emptyState(document, { title: '購入済みの商品はまだありません', body: '支払いが済んだ注文がここに並びます。', actionLabel: 'マーケットを見る', onAction: () => deps.browse?.() }));
    return;
  }
  const list = el(document, 'ul', 'mk-rows');
  list.append(...items.slice(0, PAGE).map(receipt => orderRow(document, receipt, deps, { purchased: true })));
  const nodes = [list];
  if (items.length > PAGE) nodes.push(el(document, 'p', 'mk-note', `新しい${PAGE}件を表示しています。残りは「注文」で見られます。`));
  host.replaceChildren(...nodes);
}

export const ORDER_FILTERS = Object.freeze([
  { key: 'all', label: 'すべて' }, { key: 'attention', label: '対応が必要' }, { key: 'open', label: '進行中' }, { key: 'done', label: '完了' },
]);

/** 注文：絞り込みのチップ・行・「続きを表示」。状態の分け方は deps.bucketOf(receipt) -> attention | open | done。 */
export function createOrdersList({ document, host, deps }) {
  const state = { filter: 'all', visible: PAGE, receipts: [] };
  const root = el(document, 'div', 'mk-orders');
  host.replaceChildren(root);
  function render() {
    const chips = el(document, 'div', 'mk-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', '注文の絞り込み');
    for (const { key, label } of ORDER_FILTERS) {
      const chip = button(document, label, `mk-chip${state.filter === key ? ' on' : ''}`, () => { state.filter = key; state.visible = PAGE; render(); });
      chip.setAttribute('aria-pressed', String(state.filter === key));
      chip.dataset.filter = key;
      chips.append(chip);
    }
    const shown = state.receipts.filter(receipt => state.filter === 'all' || deps.bucketOf(receipt) === state.filter);
    const nodes = [chips];
    if (!state.receipts.length) nodes.push(emptyState(document, { title: 'この端末からの注文はまだありません', body: 'マーケットで購入すると、ここに注文が並びます。', actionLabel: 'マーケットを見る', onAction: () => deps.browse?.() }));
    else if (!shown.length) nodes.push(emptyState(document, { title: 'この条件の注文はありません', body: '絞り込みを変えてください。' }));
    else {
      const list = el(document, 'ul', 'mk-rows');
      list.append(...shown.slice(0, state.visible).map(receipt => orderRow(document, receipt, deps, { purchased: false })));
      nodes.push(list);
      if (shown.length > state.visible) {
        const row = el(document, 'div', 'mk-more');
        row.append(button(document, `続きを表示（残り${shown.length - state.visible}件）`, 'mk-btn', () => { state.visible += PAGE; render(); }));
        nodes.push(row);
      }
    }
    root.replaceChildren(...nodes);
  }
  return { root, set(receipts) { state.receipts = Array.isArray(receipts) ? receipts : []; render(); }, render, filter: () => state.filter };
}

/** Webでしかできないこと（販売者の登録・本人確認など）を、再実装せず「Webで開く」の行として出す。 */
export function renderWebRows({ document, host, rows, openWeb }) {
  const list = el(document, 'ul', 'mk-rows mk-web-rows');
  for (const row of rows) {
    const item = el(document, 'li', 'mk-row mk-web-row');
    const text = el(document, 'div', 'mk-row-text');
    text.append(el(document, 'strong', 'mk-row-title-plain', row.label), el(document, 'span', 'mk-row-meta', row.note));
    const open = button(document, 'Webで開く ↗', 'mk-btn mk-btn-compact', () => openWeb(row.path));
    open.setAttribute('aria-label', `${row.label}をWebで開く`);
    item.append(text, open);
    list.append(item);
  }
  host.replaceChildren(list);
}

/** 既存の Web 行（app.js が既に開いている道）。新しい経路は足さない。 */
export const WEB_ROWS = Object.freeze([
  { label: '出品の登録・販売者設定', note: '商品の登録と販売者の設定はWebのマーケットで行います。', path: '/v2/market/products/sell' },
  { label: '本人確認（KYC/KYB）', note: '販売者の本人確認はWeb版Hubで行います。この端末には書類を保存しません。', path: '/v2/market/products/sell' },
  { label: 'デジタル商品の受け取り', note: '購入したデジタル商品のダウンロードはWebのマーケットから。', path: '/v2/market/digital' },
]);

// ---------- ライブラリ（2026-11-04、所有者の決定：「購入済み」を「ライブラリ」へ） ----------
// 買った物を種別のタブで1か所に集める。配置は Steam のライブラリ / Apple Books のライブラリ（左に種別の列、右に一覧）。
// この端末で読めるものだけを並べる：デジタルは Commerce の注文（shop.orders、端末の資格情報で確かめた写し）。ゲームはWebのゲームのライブラリの行にする。
// チケット（入場・同行者への分配・定価の出品）と限定の中身は Hub D1 の本人だけの一覧で、この端末にはまだ読む道が無い。再実装せず Web のライブラリの行にする。
// API（支払いチャネルの残高と閉じる操作）は端末側の読み元がまだ無いので、タブを出さない（偽の一覧は作らない）。
// グッズはライブラリに入れない。「注文」への行を1つだけ置く。
export const LIBRARY_KINDS = Object.freeze([
  { key: 'all', label: 'すべて' }, { key: 'games', label: 'ゲーム' }, { key: 'digital', label: 'デジタル' }, { key: 'tickets', label: 'チケット' }, { key: 'gated', label: '限定の中身' },
]);

export const LIBRARY_WEB_ROWS = Object.freeze({
  games: { label: '購入したゲーム', note: '無料で追加したゲームと購入を確認したゲームは、Webのゲームのライブラリに並びます。', path: '/v2/games/library' },
  tickets: { label: 'チケット', note: '入場画面・同行者への分配・定価での出品は、Webのライブラリで行います。', path: '/v2/market/purchased?kind=tickets' },
  gated: { label: '限定の中身', note: '開けた限定の投稿・記事はWebのライブラリに並びます。開くたびに、いまの条件で確かめます。', path: '/v2/market/purchased?kind=gated' },
});

const libraryTime = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
};
export const isDigitalPurchase = receipt => isPurchased(receipt) && receipt?.fulfillmentType === 'digital';

function libraryWebRow(document, row, openWeb) {
  const item = el(document, 'li', 'mk-row mk-web-row mk-lib-web');
  const text = el(document, 'div', 'mk-row-text');
  text.append(el(document, 'strong', 'mk-row-title-plain', row.label), el(document, 'span', 'mk-row-meta', row.note));
  const open = button(document, 'Webで開く ↗', 'mk-btn mk-btn-compact', () => openWeb?.(row.path));
  open.setAttribute('aria-label', `${row.label}をWebで開く`);
  item.append(text, open);
  return item;
}

/**
 * ライブラリ。deps：orderRow と同じ（statusText / openOrder / openWeb / asset）に加えて openOrders() / browse()。
 * set({ receipts }) で中身を差し替える。kind を替えても読み直さない。
 */
export function createLibrary({ document, host, deps, kind = 'all' }) {
  const state = { kind: LIBRARY_KINDS.some(k => k.key === kind) ? kind : 'all', receipts: [] };
  const root = el(document, 'div', 'mk-library');
  host.replaceChildren(root);
  const digitalItems = () => state.receipts.filter(isDigitalPurchase);
  const counts = () => ({ digital: digitalItems().length });

  function kindsColumn() {
    const nav = el(document, 'nav', 'mk-lib-kinds');
    nav.setAttribute('aria-label', 'ライブラリの種別');
    const list = el(document, 'ul', 'mk-lib-kind-list');
    const known = counts();
    for (const { key, label } of LIBRARY_KINDS) {
      const li = el(document, 'li');
      const item = button(document, '', `mk-lib-kind${state.kind === key ? ' on' : ''}`, () => { state.kind = key; render(); });
      item.dataset.kind = key;
      item.append(el(document, 'span', 'mk-lib-kind-label', label));
      if (Number.isFinite(known[key]) && known[key] > 0) item.append(el(document, 'span', 'mk-lib-kind-count mk-num', String(known[key])));
      if (state.kind === key) item.setAttribute('aria-current', 'page');
      li.append(item);
      list.append(li);
    }
    nav.append(list);
    // グッズは届けた証明が配送の追跡なので、ライブラリではなく注文が持つ。行は1つだけ。
    const goods = button(document, 'グッズの注文を見る', 'mk-lib-goods mk-link', () => deps.openOrders?.());
    goods.dataset.kind = 'goods';
    nav.append(goods);
    return nav;
  }

  function listFor(kind) {
    const rows = [];
    if (kind === 'all' || kind === 'digital') for (const receipt of digitalItems()) rows.push({ time: libraryTime(receipt.createdAt), node: orderRow(document, receipt, deps, { purchased: true }) });
    rows.sort((a, b) => b.time - a.time);
    const web = kind === 'all' ? [LIBRARY_WEB_ROWS.tickets, LIBRARY_WEB_ROWS.gated] : LIBRARY_WEB_ROWS[kind] ? [LIBRARY_WEB_ROWS[kind]] : [];
    const nodes = [];
    if (rows.length) {
      const list = el(document, 'ul', 'mk-rows mk-lib-rows');
      list.append(...rows.slice(0, PAGE).map(row => row.node));
      nodes.push(list);
      if (rows.length > PAGE) nodes.push(el(document, 'p', 'mk-note', `新しい${PAGE}件を表示しています。デジタルの残りは「注文」で見られます。`));
    } else if (kind === 'all' || kind === 'digital') {
      const empty = { all: ['ライブラリはまだ空です', 'デジタル商品を買うとここに並びます。'], digital: ['購入したデジタル商品はまだありません', '支払いが済んだデジタル商品の注文がここに並びます。'] }[kind];
      nodes.push(emptyState(document, { title: empty[0], body: empty[1], actionLabel: 'マーケットを見る', onAction: () => deps.browse?.() }));
    }
    if (web.length) {
      const list = el(document, 'ul', 'mk-rows mk-web-rows');
      list.append(...web.map(row => libraryWebRow(document, row, deps.openWeb)));
      nodes.push(list);
    }
    return nodes;
  }

  function render() {
    const section = el(document, 'section', 'mk-lib-list');
    section.setAttribute('aria-label', LIBRARY_KINDS.find(k => k.key === state.kind)?.label ?? 'ライブラリ');
    section.append(...listFor(state.kind));
    root.replaceChildren(kindsColumn(), section);
  }
  render();
  return {
    root,
    set({ receipts } = {}) {
      if (Array.isArray(receipts)) state.receipts = receipts;
      render();
    },
    select(next) { if (LIBRARY_KINDS.some(k => k.key === next)) { state.kind = next; render(); } },
    kind: () => state.kind,
  };
}
