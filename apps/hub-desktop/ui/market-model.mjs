// マーケット画面の共通の型と言い回し（2026-11-03）。読み込みはしない：app.js が既存の読み（commerce_catalog / market_tickets）で
// 取った生の行をここで札の形にそろえるだけ。新しい読みも、新しい購入の道も持たない。

export const CATEGORIES = Object.freeze([
  { key: 'all', label: 'すべて' },
  { key: 'digital', label: 'デジタル' },
  { key: 'goods', label: 'グッズ' },
  { key: 'ticket', label: 'チケット' },
  { key: 'game', label: 'ゲーム' },
]);

// commerce_catalog が受ける並べ替えは new / price_asc / price_desc だけ（人気順の読みは無いので出さない）。
export const SORTS = Object.freeze([
  { key: 'new', label: '新着' },
  { key: 'price_asc', label: '価格の安い順' },
  { key: 'price_desc', label: '価格の高い順' },
]);

export const categoryLabel = key => CATEGORIES.find(item => item.key === key)?.label ?? 'すべて';
export const isCategory = key => CATEGORIES.some(item => item.key === key);
export const isSort = key => SORTS.some(item => item.key === key);

export const jpyc = value => `${Number(value).toLocaleString('ja-JP')} JPYC`;
export const yen = value => `¥${Number(value).toLocaleString('ja-JP')}`;

const FULFILLMENT = {
  seller_shipping: '販売者が発送',
  platform_3pl: '委託倉庫から発送',
  pickup: '店頭で受け取り',
  digital: '購入後にダウンロード',
};

/** 商品の種別：デジタル / グッズ（配送・店頭受取）/ チケット。 */
export function kindOf(raw) {
  if (raw?.kind === 'ticket') return 'ticket';
  return raw?.fulfillmentType === 'digital' ? 'digital' : 'goods';
}

export const KIND_LABEL = Object.freeze({ digital: 'デジタル', goods: 'グッズ', ticket: 'チケット' });

/** 税込が確定した商品だけ税込を主に出す（app.js の shopTax と同じ規則）。 */
function taxOf(raw) {
  const tax = raw?.taxIncluded;
  return tax && tax.status === 'determined' && Number.isFinite(tax.priceJpyc) ? tax : null;
}

/** 価格の言い回し。{ main, sub, amount }：main は大きく、sub は小さく。 */
export function priceView(item) {
  if (item.kind === 'ticket') {
    return Number.isFinite(item.priceYen) ? { main: `${yen(item.priceYen)}〜`, sub: '', amount: item.priceYen } : { main: '価格は詳細で確認', sub: '', amount: null };
  }
  const tax = taxOf(item.raw);
  if (tax) return { main: jpyc(tax.priceJpyc), sub: Number.isFinite(item.raw.priceJpyc) ? `税込・本体 ${jpyc(item.raw.priceJpyc)}` : '税込', amount: tax.priceJpyc };
  if (Number.isFinite(item.raw?.priceJpyc)) return { main: jpyc(item.raw.priceJpyc), sub: '税は注文時に確定', amount: item.raw.priceJpyc };
  return { main: '価格は詳細で確認', sub: '', amount: null };
}

export function shippingText(raw) {
  if (raw?.fulfillmentType === 'digital' || raw?.fulfillmentType === 'pickup') return '';
  if (raw?.shippingJpyc == null) return '送料は注文時に確認';
  if (raw.shippingJpyc === 0) return '送料無料';
  const tax = taxOf(raw);
  return tax && Number.isFinite(tax.shippingJpyc) ? `${jpyc(tax.shippingJpyc)}（税込）` : jpyc(raw.shippingJpyc);
}

export function stockText(raw) {
  const stock = raw?.stockQuantity;
  if (stock == null) return '';
  if (stock <= 0) return '在庫なし';
  return stock <= 3 ? `残り${stock}点` : '在庫あり';
}

/** Commerce の商品の行 → 札。id の無い・題の無い行は捨てる。 */
export function normalizeProduct(raw) {
  if (!raw || raw.id === undefined || raw.id === null || typeof raw.title !== 'string' || !raw.title.trim()) return null;
  const images = [raw.imageUrl, ...(Array.isArray(raw.images) ? raw.images.map(entry => (typeof entry === 'string' ? entry : entry?.url)) : [])]
    .filter(url => typeof url === 'string' && url);
  return {
    id: String(raw.id),
    kind: kindOf(raw),
    title: raw.title.trim(),
    description: typeof raw.description === 'string' ? raw.description : '',
    images: [...new Set(images)],
    seller: raw.seller && typeof raw.seller === 'object' ? raw.seller : null,
    sellerName: raw.seller?.publicName || '',
    fulfillment: FULFILLMENT[raw.fulfillmentType] ?? '',
    raw,
  };
}

/** market_tickets のイベント → 札。購入はWebで行うので価格は目安（最安の円）。 */
export function normalizeTicket(event) {
  if (!event || typeof event.title !== 'string' || !event.title.trim()) return null;
  const prices = (Array.isArray(event.ticketTypes) ? event.ticketTypes : [])
    .filter(type => type?.currency === 'JPY' && Number.isFinite(type.priceMinor)).map(type => type.priceMinor);
  const images = [event.imageUrl].filter(url => typeof url === 'string' && url);
  return {
    id: String(event.id ?? event.title),
    kind: 'ticket',
    title: event.title.trim(),
    description: typeof event.summary === 'string' ? event.summary : '',
    images,
    seller: null,
    sellerName: event.organizerName || event.venueName || '',
    venueName: event.venueName || '',
    startsAt: event.startsAt || '',
    priceYen: prices.length ? Math.min(...prices) : null,
    raw: event,
  };
}

export function formatWhen(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** 検索語で札を絞る（題・販売者・会場）。サーバー側の検索が効かない種別（チケット）用。 */
export function matchesQuery(item, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return true;
  return [item.title, item.sellerName, item.venueName, item.description].some(text => String(text ?? '').toLowerCase().includes(needle));
}

/** 種別での絞り込み。カタログはサーバー側で種別を受けないので、読んだ分から選ぶ。 */
export function inCategory(item, category) {
  if (category === 'all') return true;
  if (category === 'digital' || category === 'goods' || category === 'ticket') return item.kind === category;
  return false;
}

/** カートの目安の合計（app.js の shopCartUnit と同じ規則）。確定額はCommerceが出す。 */
export function cartEstimate(lines) {
  let items = 0, shipping = 0, count = 0, unknownShipping = false, taxed = true;
  for (const { product, quantity } of lines) {
    const tax = taxOf(product);
    const unit = tax ? tax.priceJpyc : product.priceJpyc;
    const ship = product.shippingJpyc == null ? null : (tax && Number.isFinite(tax.shippingJpyc) ? tax.shippingJpyc : product.shippingJpyc);
    items += unit * quantity;
    if (ship === null) unknownShipping = true; else shipping += ship;
    if (!tax) taxed = false;
    count += quantity;
  }
  return { count, items, shipping, total: items + shipping, unknownShipping, taxed };
}

export const initialOf = text => [...String(text ?? '').trim()][0]?.toUpperCase() ?? '';
