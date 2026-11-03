// マーケットの商品ページ（2026-11-03）：左に絵の組（大きな絵と小さな絵の列）、右に販売者・題・価格・事実・買う箱。下に説明・販売者・同じ販売者の商品。
// 新しい購入の道は作らない。ここが呼べるのは deps の4つだけ：
//   addToCart(item, quantity) … 既存のカート（shop.cart）へ入れる。入れたら true
//   goCheckout(item)          … 既存のカート画面（支払いはその中の既存の道＝Commerce、ウォレットの確認モーダル）を開く
//   openWeb(path)             … Webでしか買えない種別（デジタル・チケット・店頭受取）を既定のブラウザで開く
//   openSeller(seller) / openProfile(handle) / openLegal(url) / openItem(item) / asset(img, url)
// このファイルは invoke も open_external も commerce_* も持たない（テストが固定する）。
import { KIND_LABEL, formatWhen, priceView, shippingText, stockText } from './market-model.mjs';
import { badge, button, el, emptyState, media } from './market-dom.mjs';
import { renderTile } from './market-browse.mjs';

const MAX_QUANTITY = 20;
const WEB_PATH = { digital: '/v2/market/digital', ticket: '/v2/market/tickets', goods: '/v2/market/products' };

export const webPathFor = item => (item.kind === 'goods' && item.raw?.fulfillmentType === 'pickup' ? WEB_PATH.goods : WEB_PATH[item.kind]);
/** カートに入れて買えるのは配送の商品だけ。デジタル・チケット・店頭受取はWebで買う（既存の決まり）。 */
export const buyableInApp = item => item.kind === 'goods' && ['seller_shipping', 'platform_3pl'].includes(item.raw?.fulfillmentType) && (item.raw?.stockQuantity ?? 0) > 0;

function fact(document, list, label, value) {
  if (value === undefined || value === null || value === '') return;
  const row = el(document, 'div', 'mk-fact');
  row.append(el(document, 'dt', 'mk-fact-label', label), el(document, 'dd', 'mk-fact-value', String(value)));
  list.append(row);
}

/** 種別ごとの事実（小さな見出し付き）。 */
export function factsFor(item) {
  const raw = item.raw ?? {};
  if (item.kind === 'digital') {
    return [['ダウンロード', '購入後にダウンロード（Webのマーケットで受け取り）'], ['配送', '不要']];
  }
  if (item.kind === 'ticket') {
    return [['日時・会場', [formatWhen(item.startsAt), item.venueName].filter(Boolean).join(' / ')], ['購入', 'Webのマーケットで手続き']];
  }
  const tax = raw.taxIncluded?.status === 'determined' ? raw.taxIncluded : null;
  return [
    ['配送', item.fulfillment],
    ['送料', shippingText(raw)],
    ['在庫', stockText(raw) && raw.stockQuantity > 3 ? `${stockText(raw)}（${raw.stockQuantity}点）` : stockText(raw)],
    ['消費税', tax ? `${tax.rateBps / 100}%（込み）` : '注文時にCommerceが確定'],
    ...(tax && Number.isFinite(tax.totalForOneJpyc) ? [['お支払い（1点）', `${tax.totalForOneJpyc.toLocaleString('ja-JP')} JPYC（税・送料込み）`]] : []),
  ];
}

/**
 * host に商品ページを出す。show(item, ctx) で開き、refresh(ctx) で買う箱だけ描き直す。
 * ctx：{ inCart, cartQuantity, paymentsEnabled, related: 正規化済みの札[] , busy }
 */
export function createMarketProductPage({ document, host, deps }) {
  let current = null, ctx = {}, imageIndex = 0, quantity = 1, working = false, notice = '';
  const root = el(document, 'article', 'mk-product');
  host.replaceChildren(root);

  function gallery(item) {
    const box = el(document, 'div', 'mk-gallery');
    const main = media(document, { url: item.images[imageIndex], label: item.sellerName || item.title, alt: item.title, asset: deps.asset, className: 'mk-media mk-gallery-main' });
    box.append(main);
    if (item.images.length > 1) {
      const strip = el(document, 'div', 'mk-thumbs');
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', '商品の画像');
      item.images.forEach((url, index) => {
        const thumb = el(document, 'button', 'mk-thumb');
        thumb.type = 'button';
        thumb.setAttribute('aria-label', `画像${index + 1}を表示`);
        thumb.setAttribute('aria-pressed', String(index === imageIndex));
        thumb.append(media(document, { url, label: '', alt: '', asset: deps.asset, className: 'mk-media' }));
        thumb.addEventListener('click', () => { imageIndex = index; render(); });
        strip.append(thumb);
      });
      box.append(strip);
    }
    return box;
  }

  function stepper(max) {
    const group = el(document, 'div', 'mk-stepper');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '数量');
    const minus = button(document, '−', 'mk-step', () => { quantity = Math.max(1, quantity - 1); refresh(); });
    minus.setAttribute('aria-label', '1つ減らす');
    const value = el(document, 'output', 'mk-step-value mk-num', String(quantity));
    const plus = button(document, '＋', 'mk-step', () => { quantity = Math.min(max, quantity + 1); refresh(); });
    plus.setAttribute('aria-label', '1つ増やす');
    minus.disabled = quantity <= 1;
    plus.disabled = quantity >= max;
    group.append(minus, value, plus);
    return group;
  }

  function buyBox(item) {
    const box = el(document, 'section', 'mk-buy');
    box.setAttribute('aria-label', '購入');
    const price = priceView(item);
    const priceLine = el(document, 'p', 'mk-price');
    priceLine.append(el(document, 'strong', 'mk-price-main mk-num', price.main));
    if (price.sub) priceLine.append(el(document, 'span', 'mk-price-sub', price.sub));
    box.append(priceLine);
    const actions = el(document, 'div', 'mk-buy-actions');
    if (buyableInApp(item)) {
      const max = Math.min(MAX_QUANTITY, item.raw.stockQuantity);
      if (quantity > max) quantity = max;
      if (max > 1 && !ctx.inCart) {
        const field = el(document, 'div', 'mk-buy-qty');
        field.append(el(document, 'span', 'mk-buy-qty-label', '数量'), stepper(max));
        box.append(field);
      }
      const add = button(document, ctx.inCart ? 'カートに追加済み' : 'カートに入れる', 'mk-btn', async () => {
        if (working || ctx.inCart) return;
        working = true; refresh();
        try { await deps.addToCart(item, quantity); } finally { working = false; }
        refresh();
      });
      add.disabled = working || Boolean(ctx.inCart);
      const checkout = button(document, '購入手続きへ', 'mk-btn mk-btn-primary', async () => {
        if (working) return;
        working = true; refresh();
        try {
          const ready = ctx.inCart || await deps.addToCart(item, quantity);
          if (ready) deps.goCheckout(item);
        } finally { working = false; }
        refresh();
      });
      checkout.disabled = working;
      actions.append(add, checkout);
      box.append(actions);
      if (ctx.paymentsEnabled === false) box.append(el(document, 'p', 'mk-note', '現在は決済メンテナンス中です。商品とカートの内容は確認できます。'));
      if (ctx.inCart) {
        const open = button(document, 'カートを見る', 'mk-link', () => deps.goCheckout(item));
        box.append(open);
      }
      box.append(el(document, 'p', 'mk-note', '支払いと注文はCommerceが扱います。住所はIdentityで確認し、Hubには保存されません。'));
    } else {
      const label = item.kind === 'ticket' ? 'Webでチケットを買う' : item.kind === 'digital' ? 'Webで購入する' : 'Webで見る';
      const open = button(document, `${label} ↗`, 'mk-btn mk-btn-primary', () => deps.openWeb(webPathFor(item)));
      actions.append(open);
      box.append(actions);
      box.append(el(document, 'p', 'mk-note', item.kind === 'goods' && item.raw?.stockQuantity <= 0 ? '在庫がありません。' : 'この種別の購入はWebのマーケットで行います（Commerceの購入手続き）。'));
    }
    if (notice) box.append(el(document, 'p', 'mk-note', notice));
    return box;
  }

  function sellerCard(item) {
    const seller = item.seller;
    if (!seller && !item.sellerName) return null;
    const section = el(document, 'section', 'mk-seller');
    section.setAttribute('aria-label', '販売者');
    section.append(media(document, { url: seller?.avatarUrl, label: item.sellerName, alt: '', asset: deps.asset, className: 'mk-media mk-seller-avatar' }));
    const text = el(document, 'div', 'mk-seller-text');
    text.append(el(document, 'strong', 'mk-seller-name', item.sellerName || 'Hubの出品'));
    text.append(el(document, 'span', 'mk-seller-note', seller?.id ? 'この販売者の商品を一覧で見られます' : '販売者'));
    section.append(text);
    const actions = el(document, 'div', 'mk-seller-actions');
    if (seller?.id && deps.openSeller) actions.append(button(document, '販売者の商品', 'mk-btn mk-btn-compact', () => deps.openSeller(seller)));
    if (seller?.handle && deps.openProfile) actions.append(button(document, 'プロフィール', 'mk-btn mk-btn-compact', () => deps.openProfile(seller.handle)));
    if (seller?.legalDisplayUrl && deps.openLegal) actions.append(button(document, '販売条件・返品 ↗', 'mk-btn mk-btn-compact', () => deps.openLegal(seller.legalDisplayUrl)));
    section.append(actions);
    return section;
  }

  function render() {
    if (!current) { root.replaceChildren(); return; }
    const item = current;
    const info = el(document, 'div', 'mk-info');
    const head = el(document, 'div', 'mk-info-head');
    head.append(badge(document, KIND_LABEL[item.kind]));
    if (item.sellerName) head.append(el(document, 'span', 'mk-info-seller', item.sellerName));
    info.append(head, el(document, 'h3', 'mk-title', item.title), buyBox(item));
    const facts = el(document, 'dl', 'mk-facts');
    for (const [label, value] of factsFor(item)) fact(document, facts, label, value);
    if (facts.childElementCount) info.append(facts);

    const top = el(document, 'div', 'mk-product-top');
    top.append(gallery(item), info);
    const nodes = [top];
    if (item.description) {
      const about = el(document, 'section', 'mk-about');
      about.append(el(document, 'h4', 'mk-section-title', '商品の説明'), el(document, 'p', 'mk-description', item.description));
      nodes.push(about);
    }
    const seller = sellerCard(item);
    if (seller) nodes.push(seller);
    const related = (ctx.related ?? []).filter(other => other.id !== item.id).slice(0, 6);
    if (related.length) {
      const shelf = el(document, 'section', 'mk-related');
      shelf.append(el(document, 'h4', 'mk-section-title', 'この販売者のほかの商品'));
      const grid = el(document, 'div', 'mk-grid mk-grid-related');
      grid.append(...related.map(other => renderTile(document, other, { onOpen: deps.openItem, asset: deps.asset })));
      shelf.append(grid);
      nodes.push(shelf);
    }
    root.replaceChildren(...nodes);
  }

  function refresh(next) {
    if (next) ctx = { ...ctx, ...next };
    if (!current) return;
    const old = root.querySelector('.mk-buy');
    if (!old) { render(); return; }
    old.replaceWith(buyBox(current));
  }

  return {
    root,
    show(item, nextCtx = {}) { current = item; ctx = nextCtx; imageIndex = 0; quantity = 1; working = false; notice = ''; render(); },
    refresh,
    notify(text) { notice = String(text ?? ''); refresh(); },
    clear() { current = null; render(); },
    current: () => current,
    empty: () => { current = null; root.replaceChildren(emptyState(document, { title: '商品が見つかりません', body: '一覧に戻って探してください。' })); },
  };
}
