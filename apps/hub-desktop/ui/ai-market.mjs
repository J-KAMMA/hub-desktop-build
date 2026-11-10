// AI market (2026-11-04, docs/hub-ai-market/DESIGN.md), slice 1: pure policy for market endpoints in the AI view.
// Nothing here stores a key or a prompt. The Desktop calls a listed endpoint directly; Hub never proxies it.
// Testnet only: every mainnet network id is refused, and so is a quote above the listed maximum.

export const MARKET_REF_PREFIX = 'market:';
export const MARKET_NETWORK = 'eip155:84532';
// Testnets this slice may pay on. Anything else (every mainnet included) is refused.
export const TESTNET_NETWORKS = Object.freeze(['eip155:84532']);
export const FEE_BPS = 100; // 1% Hub fee, same as the marketplace (HUB_MARKETPLACE_FEE_BPS)
export const MAX_PRICE_ATOMIC = 10_000_000;
export const DISCLOSURE_TEXT = 'プロンプトはこの提供者に届きます';
export const DATA_HANDLING_LABEL = '提供者の申告';
export const DISCLOSURE_KEY = 'hub.desktop.ai.market.disclosed';
export const FILTERS = Object.freeze(['cheapest', 'fastest', 'no_retention', 'attested']);
// API market (2026-11-04): AI endpoints are one kind of listing. The AI picker shows kind "ai" only.
export const KINDS = Object.freeze(['ai', 'maps', 'translation', 'weather', 'search', 'conversion', 'compute', 'data', 'other']);
export const KIND_LABEL = Object.freeze({ ai: 'AI', maps: '地図', translation: '翻訳', weather: '天気', search: '検索', conversion: '変換', compute: '計算', data: 'データ', other: 'その他' });
export const FILTER_LABEL = Object.freeze({ cheapest: '安い順', fastest: '速い順（申告）', no_retention: '保存しない', attested: '証明つき' });
// Content from these places is private by definition, whatever the caller forgot to mark.
const PRIVATE_SOURCES = new Set(['personal_node', 'dm', 'mail', 'vault', 'wallet', 'gated', 'account', 'private']);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

function httpsBase(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '::1') return null;
  if (/^(0|10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  return url.href.replace(/\/+$/, '');
}

/** One listing from the Hub API, or null. The shape has no key field; unknown fields are dropped. */
export function normalizeListing(raw) {
  if (!raw || typeof raw !== 'object' || (raw.type !== 'ai.endpoint' && raw.type !== 'api.endpoint')) return null;
  // ai.endpoint is the wire type for kind ai (and for rows from before the API market, which carry no kind).
  const kind = raw.kind === undefined && raw.type === 'ai.endpoint' ? 'ai' : raw.kind;
  if (!KINDS.includes(kind) || (kind === 'ai') !== (raw.type === 'ai.endpoint')) return null;
  const baseUrl = httpsBase(raw.baseUrl);
  const models = Array.isArray(raw.modelIds) ? raw.modelIds.filter((m) => typeof m === 'string' && MODEL.test(m)) : [];
  const price = raw.maxPriceAtomic;
  const dh = raw.dataHandling;
  if (typeof raw.id !== 'string' || !/^[0-9a-f-]{36}$/.test(raw.id) || !baseUrl) return null;
  // Models belong to kind ai only: an AI listing needs one, any other kind must not carry one.
  if (kind === 'ai' ? !models.length : (Array.isArray(raw.modelIds) && raw.modelIds.length > 0)) return null;
  if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE_ATOMIC) return null;
  if (raw.network !== MARKET_NETWORK || typeof raw.sellerAddress !== 'string' || !ADDRESS.test(raw.sellerAddress)) return null;
  // The payee is the seller's splitter (1% Hub fee / rest to the seller, on-chain). It must differ from the seller.
  if (typeof raw.payeeAddress !== 'string' || !ADDRESS.test(raw.payeeAddress) || raw.payeeAddress.toLowerCase() === raw.sellerAddress.toLowerCase()) return null;
  if (!dh || typeof dh.retention !== 'boolean' || typeof dh.training !== 'boolean' || typeof dh.processingRegion !== 'string') return null;
  const providerName = typeof raw.providerName === 'string' ? raw.providerName.slice(0, 80) : '';
  if (!providerName) return null;
  return Object.freeze({
    id: raw.id, kind, providerName, baseUrl, modelIds: Object.freeze(models.slice(0, 20)), network: raw.network,
    maxPriceAtomic: price,
    // Display fields for the API market view. A per-call price above the maximum (or missing, on old rows) shows as the maximum.
    priceAtomic: Number.isSafeInteger(raw.priceAtomic) && raw.priceAtomic >= 1 && raw.priceAtomic <= price ? raw.priceAtomic : price,
    purpose: typeof raw.purpose === 'string' ? raw.purpose.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
    openapiUrl: typeof raw.openapiUrl === 'string' && /^https:\/\/[^\s]{1,1016}$/u.test(raw.openapiUrl) ? raw.openapiUrl : null,
    createdAt: typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : null,
    declaredLatencyMs: Number.isSafeInteger(raw.declaredLatencyMs) && raw.declaredLatencyMs > 0 ? raw.declaredLatencyMs : null,
    dataHandling: Object.freeze({ retention: dh.retention, training: dh.training, processingRegion: dh.processingRegion.slice(0, 40) }),
    // Attestation is not verified anywhere yet, so a listing's own flag is never trusted here.
    attested: false,
    sellerAddress: raw.sellerAddress.toLowerCase(),
    payeeAddress: raw.payeeAddress.toLowerCase(),
  });
}

export function normalizeListings(body) {
  const list = Array.isArray(body?.listings) ? body.listings : [];
  return list.map(normalizeListing).filter(Boolean);
}

export const marketRef = (listing, model) => `${MARKET_REF_PREFIX}${listing.id}/${model}`;
export function parseMarketRef(ref) {
  const match = typeof ref === 'string' ? /^market:([0-9a-f-]{36})\/(.+)$/u.exec(ref) : null;
  return match && MODEL.test(match[2]) ? { id: match[1], model: match[2] } : null;
}

/** Filters (all that are given must hold) and one sort. cheapest sorts by max price; fastest by declared latency, undeclared last. */
export function selectListings(listings, { filters = [], sort = null, kind = null } = {}) {
  const active = new Set(filters.filter((f) => FILTERS.includes(f)));
  let out = listings.filter((l) => (kind === null || l.kind === kind) && (!active.has('no_retention') || l.dataHandling.retention === false) && (!active.has('attested') || l.attested === true));
  const key = sort ?? (active.has('cheapest') ? 'cheapest' : active.has('fastest') ? 'fastest' : null);
  if (key === 'cheapest') out = [...out].sort((a, b) => a.maxPriceAtomic - b.maxPriceAtomic || a.id.localeCompare(b.id));
  if (key === 'fastest') out = [...out].sort((a, b) => (a.declaredLatencyMs ?? Infinity) - (b.declaredLatencyMs ?? Infinity) || a.id.localeCompare(b.id));
  return out;
}

/** Picker rows next to the BYOK and local models: one per listed model. */
export function pickerRows(listings, options) {
  // Only AI listings can be a model: other kinds never reach the picker.
  return selectListings(listings, { ...options, kind: 'ai' }).flatMap((l) => l.modelIds.map((model) => ({
    ref: marketRef(l, model), listing: l, label: model, group: `市場 · ${l.providerName}`,
    detail: [formatPrice(l.maxPriceAtomic), l.declaredLatencyMs ? `${l.declaredLatencyMs}ms（申告）` : null,
      `${DATA_HANDLING_LABEL}: ${l.dataHandling.retention ? '保存あり' : '保存なし'}`, l.attested ? '証明つき' : null].filter(Boolean).join(' · '),
  })));
}

export function formatPrice(atomic) {
  const text = (atomic / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
  return `上限 ${text} USDC（テスト用）`;
}

/* ---- disclosure: shown before first use of each endpoint ---- */
function readSeen(storage) {
  try { const v = JSON.parse(storage?.getItem(DISCLOSURE_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
export const needsDisclosure = (storage, listingId) => !readSeen(storage).includes(listingId);
export function acknowledgeDisclosure(storage, listingId) {
  const seen = readSeen(storage);
  if (!seen.includes(listingId)) seen.push(listingId);
  try { storage?.setItem(DISCLOSURE_KEY, JSON.stringify(seen.slice(-200))); return true; } catch { return false; }
}
/** Resolves true only when the user agreed. Without a prior acknowledgement, `ask` must be answered first. */
export async function ensureDisclosure(storage, listing, ask) {
  if (!needsDisclosure(storage, listing.id)) return true;
  if ((await ask({ message: DISCLOSURE_TEXT, providerName: listing.providerName, baseUrl: listing.baseUrl })) !== true) return false;
  acknowledgeDisclosure(storage, listing.id);
  return true;
}

/* ---- private data ---- */
export const isPrivateContent = (content) => content?.private === true || PRIVATE_SOURCES.has(content?.source);
// Attestation verification does not exist in this slice, so this is false for every listing.
export const attestationVerified = () => false;
/** Private content goes to a market endpoint only when attestation was verified. In this slice: never. */
export function marketAllowsContent(listing, content) {
  if (!isPrivateContent(content)) return { ok: true };
  return listing?.attested === true && attestationVerified(listing) ? { ok: true } : { ok: false, code: 'market_private_blocked' };
}

/* ---- x402 quote policy (testnet only) ---- */
export function splitAmount(amountAtomic) {
  if (!Number.isSafeInteger(amountAtomic) || amountAtomic < 0) throw new Error('market_amount_invalid');
  const fee = Math.floor(amountAtomic * FEE_BPS / 10_000);
  return { feeAtomic: fee, sellerAtomic: amountAtomic - fee };
}

const fail = (code) => ({ ok: false, code });

/**
 * Judges the endpoint's 402 quote against the listing. Pure: it signs and sends nothing.
 * Refuses a non-testnet network, an amount over the listed maximum, a payee other than the listed
 * seller, an unknown scheme, and anything it cannot read. On success it returns what the wallet
 * confirmation must show (maximum charge, payee, split).
 * The payee is the seller's AiEndpointSplitterV1: x402 `exact` pays that one address and the contract splits 1% / 99% on-chain.
 * Testnet only; mainnet needs an external audit and a separate owner instruction.
 */
export function evaluateQuote(quote, listing) {
  const accepts = Array.isArray(quote?.accepts) ? quote.accepts : [];
  const offer = accepts.find((a) => a && typeof a === 'object' && a.scheme === 'exact' && TESTNET_NETWORKS.includes(a.network)) ?? null;
  if (!offer) {
    if (accepts.some((a) => a && typeof a.network === 'string' && a.network.startsWith('eip155:') && !TESTNET_NETWORKS.includes(a.network))) return fail('market_network_not_testnet');
    return fail('market_quote_unsupported');
  }
  if (offer.network !== listing.network) return fail('market_network_mismatch');
  if (typeof offer.amount !== 'string' || !/^\d{1,18}$/.test(offer.amount)) return fail('market_quote_invalid');
  const amount = Number(offer.amount);
  if (!Number.isSafeInteger(amount) || amount < 1) return fail('market_quote_invalid');
  if (amount > listing.maxPriceAtomic) return fail('market_over_listed_max');
  if (typeof offer.payTo !== 'string' || offer.payTo.toLowerCase() !== listing.payeeAddress) return fail('market_payee_mismatch');
  if (typeof offer.asset !== 'string' || !ADDRESS.test(offer.asset)) return fail('market_quote_invalid');
  return {
    ok: true,
    confirmation: { network: offer.network, asset: offer.asset.toLowerCase(), maxChargeAtomic: amount, payee: listing.payeeAddress, seller: listing.sellerAddress, providerName: listing.providerName, ...splitAmount(amount) },
  };
}

/**
 * Evaluate, then require the user's explicit confirmation in the wallet UI. `confirm` shows the
 * confirmation object and must resolve exactly `true`. Returns the confirmed plan; signing is not done here.
 */
export async function prepareMarketPayment(quote, listing, confirm) {
  const verdict = evaluateQuote(quote, listing);
  if (!verdict.ok) return verdict;
  if ((await confirm(verdict.confirmation)) !== true) return fail('market_user_rejected');
  return { ok: true, confirmation: verdict.confirmation };
}

export const MARKET_ERRORS = Object.freeze({
  market_private_blocked: '秘密の内容は市場の窓口へ送れません。',
  market_network_not_testnet: 'テスト用ネットワーク以外では支払えません。',
  market_over_listed_max: '請求額が出品の上限を超えているため、支払いませんでした。',
  market_payee_mismatch: '支払い先が出品と一致しないため、支払いませんでした。',
  market_quote_invalid: '請求の内容を確認できなかったため、支払いませんでした。',
  market_quote_unsupported: '対応していない支払い方式です。',
  market_payment_rejected: '提供者が支払いを受け付けませんでした。',
  market_listing_invalid: '出品の内容が正しくありません。',
  market_endpoint_not_allowed: 'この窓口には接続できません（https のみ）。',
  wallet_user_rejected: '支払いをやめました。',
});
export const marketErrorText = (error) => {
  const text = String(error?.message ?? error ?? '');
  const code = Object.keys(MARKET_ERRORS).find((key) => text.includes(key));
  return code ? MARKET_ERRORS[code] : '市場の窓口から答えを得られませんでした。';
};
/** The listing fields the native call needs. No key, no prompt. */
export const nativeListing = (l) => ({ providerName: l.providerName, baseUrl: l.baseUrl, network: l.network, maxPriceAtomic: l.maxPriceAtomic, payeeAddress: l.payeeAddress, sellerAddress: l.sellerAddress });

/* ---- picker wiring ---- */
/** State for the picker: current listings, active filters, and the disclosure gate. getListings() returns normalized listings. */
export function createMarketController({ storage, getListings, ask }) {
  let active = [];
  let kind = null;
  return {
    kindLabels: KIND_LABEL,
    kind: () => kind,
    setKind(next) { kind = next === null || KINDS.includes(next) ? next : kind; },
    /** The market list: every kind (or the chosen one), each with its kind label. The AI picker uses rows() and stays on kind ai. */
    listings: () => selectListings(getListings(), { filters: active, kind }).map((l) => ({ listing: l, kindLabel: KIND_LABEL[l.kind] })),
    filterLabels: FILTER_LABEL,
    filters: () => [...active],
    toggle(key) { if (FILTERS.includes(key)) active = active.includes(key) ? active.filter((k) => k !== key) : [...active, key]; },
    rows(query = "") {
      const q = String(query).trim().toLowerCase();
      return pickerRows(getListings(), { filters: active }).filter((r) => !q || r.ref.toLowerCase().includes(q) || r.group.toLowerCase().includes(q));
    },
    confirmUse: (listing) => ensureDisclosure(storage, listing, ask),
  };
}

/** A small modal: the disclosure text, the provider and its host, and two buttons. Resolves true only on agree. */
export function showDisclosure(document, { message, providerName, baseUrl }) {
  return new Promise((resolve) => {
    const make = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
    const overlay = make("div", "ai-market-disclosure"); overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", "市場の窓口");
    let host = ""; try { host = new URL(baseUrl).host; } catch { host = ""; }
    const done = (value) => { overlay.remove(); resolve(value); };
    const agree = make("button", "", "了解して使う"), cancel = make("button", "", "やめる");
    agree.type = cancel.type = "button"; agree.onclick = () => done(true); cancel.onclick = () => done(false);
    overlay.append(make("p", "ai-market-disclosure__message", message), make("p", "meta", providerName + "（" + host + "）は他社の窓口です。内容と支払いは、この端末から直接その提供者へ送られます。"), agree, cancel);
    document.body.append(overlay); agree.focus();
  });
}
