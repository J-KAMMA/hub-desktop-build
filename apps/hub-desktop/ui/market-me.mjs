// 「自分」の面（2026-11-03）：カート・購入済み・注文を区切り線の行で出す。枠のカードは使わない。
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
  }
  const go = el(document, 'div', 'mk-cart-cta');
  const checkout = button(document, '購入手続きへ', 'mk-btn mk-btn-primary', () => deps.checkout());
  checkout.disabled = locked;
  go.append(checkout);
  nodes.push(go);
  host.replaceChildren(...nodes);
}

const dateText = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ja-JP'); };

function orderRow(document, receipt, deps, { purchased }) {
  const row = el(document, 'li', 'mk-row');
  row.dataset.id = receipt.id;
  const main = el(document, 'div', 'mk-row-main');
  main.append(media(document, { url: receipt.imageUrl, label: receipt.title, alt: '', asset: deps.asset, className: 'mk-media mk-row-thumb' }));
  const text = el(document, 'div', 'mk-row-text');
  const title = el(document, 'button', 'mk-row-title', receipt.title);
  title.type = 'button';
  title.addEventListener('click', () => deps.openOrder(receipt.id));
  text.append(title);
  text.append(el(document, 'span', 'mk-row-meta', [dateText(receipt.createdAt), receipt.quantity > 1 ? `×${receipt.quantity}` : '', Number.isFinite(receipt.amountJpyc) ? jpyc(receipt.amountJpyc) : ''].filter(Boolean).join(' · ')));
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
