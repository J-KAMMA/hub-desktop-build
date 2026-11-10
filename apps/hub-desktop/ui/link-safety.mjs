/*
 * 外へ出るリンクの検査（純関数）。
 *
 * Hub 本体（apps/hub/lib/link-safety.mjs）と Hub Desktop（apps/hub-desktop/ui/link-safety.mjs）に
 * 同じ内容を置く。片方だけ直さない。apps/hub/lib/link-safety.test.ts が 2 つの一致を検査する。
 *
 * 目的は「行き先を見せて一度止める」ことだけ。ここは通信しない（リンクのプレビューも取らない）。
 * 下の既知サイト一覧は警告のためだけで、どこかを勧めるためには使わない。
 */

const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700;

function adapt(delta, count, first) {
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / count);
  let k = 0;
  while (delta > (((BASE - TMIN) * TMAX) >> 1)) { delta = Math.floor(delta / (BASE - TMIN)); k += BASE; }
  return k + Math.floor(((BASE - TMIN + 1) * delta) / (delta + SKEW));
}

/** RFC 3492。不正な入力は例外。 */
export function punycodeDecode(input) {
  const out = [];
  let n = 128, i = 0, bias = 72;
  let basic = input.lastIndexOf("-");
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j += 1) {
    if (input.charCodeAt(j) >= 0x80) throw new RangeError("not basic");
    out.push(input.charCodeAt(j));
  }
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) throw new RangeError("bad input");
      const cp = input.charCodeAt(index++);
      const digit = cp - 48 < 10 ? cp - 22 : cp - 65 < 26 ? cp - 65 : cp - 97 < 26 ? cp - 97 : BASE;
      if (digit >= BASE) throw new RangeError("bad digit");
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) throw new RangeError("overflow");
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** `xn--` を含むホスト名を Unicode 表示へ。戻せない部分はそのまま。 */
export function hostToUnicode(host) {
  return host.split(".").map((label) => {
    if (!/^xn--/i.test(label)) return label;
    try { return punycodeDecode(label.slice(4).toLowerCase()); } catch { return label; }
  }).join(".");
}

/** 警告のためだけの一覧。[ラベル, 本物のドメイン[]] */
export const KNOWN_SITES = [
  ["metamask", ["metamask.io"]],
  ["phantom", ["phantom.app", "phantom.com"]],
  ["walletconnect", ["walletconnect.com", "walletconnect.org"]],
  ["ledger", ["ledger.com"]],
  ["trezor", ["trezor.io"]],
  ["trustwallet", ["trustwallet.com"]],
  ["rainbow", ["rainbow.me"]],
  ["uniswap", ["uniswap.org"]],
  ["opensea", ["opensea.io"]],
  ["etherscan", ["etherscan.io"]],
  ["binance", ["binance.com", "binance.us"]],
  ["coinbase", ["coinbase.com"]],
  ["kraken", ["kraken.com"]],
  ["bybit", ["bybit.com"]],
  ["bitflyer", ["bitflyer.com"]],
  ["coincheck", ["coincheck.com"]],
];

const HUB_LABEL = "jkamma";
const HUB_DOMAIN = "jkamma.com";
const SECOND_LEVEL = new Set(["co", "com", "ne", "or", "ac", "go", "ad", "ed", "gr", "lg", "org", "net", "gov", "edu"]);
const CONFUSABLES = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ɡ": "g", "һ": "h", "ԛ": "q", "ԝ": "w", "ӏ": "l",
  "α": "a", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "τ": "t", "υ": "u", "ı": "i", "ł": "l",
};

function registrable(host) {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return { label: labels[0] ?? "", domain: host };
  const second = labels[labels.length - 2];
  const wide = labels.length >= 3 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(second);
  const take = wide ? 3 : 2;
  const used = labels.slice(-take);
  return { label: used[0], domain: used.join(".") };
}

/** 見た目の似た文字を寄せた比較用の形。 */
export function skeleton(label) {
  let s = label.normalize("NFKC").toLowerCase();
  s = Array.from(s, (c) => CONFUSABLES[c] ?? c).join("");
  s = s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[1|]/g, "l").replace(/0/g, "o").replace(/[-_]/g, "");
  return s;
}

function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

function isHostOrChild(host, domain) { return host === domain || host.endsWith(`.${domain}`); }

function resembles(label, rawLabel, target) {
  const sk = skeleton(label), tk = skeleton(target);
  if (sk === tk) return true;
  if (tk.length >= 5 && sk[0] === tk[0] && editDistanceAtMostOne(sk, tk)) return true;
  if (tk.length >= 5 && rawLabel.split("-").some((part) => skeleton(part) === tk)) return true;
  return false;
}

/**
 * URL 文字列を検査する。http(s) 以外は ok:false。
 * @param {string} raw
 * @param {{ hubHosts?: string[] }} [options] 内部とみなす追加ホスト（自分の Hub のホストなど）
 */
export function inspectLink(raw, options = {}) {
  let url;
  try { url = new URL(raw); } catch { return { ok: false }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false };
  const asciiHost = url.hostname.toLowerCase();
  if (!asciiHost) return { ok: false };
  const unicodeHost = hostToUnicode(asciiHost);
  const userinfo = Boolean(url.username || url.password);
  const extra = (options.hubHosts ?? []).map((h) => h.toLowerCase());
  const internal = !userinfo && (isHostOrChild(asciiHost, HUB_DOMAIN) || extra.includes(asciiHost));
  const reg = registrable(asciiHost);
  const uniReg = registrable(unicodeHost);
  let lookalike = null;
  if (!internal) {
    if (resembles(uniReg.label, uniReg.label, HUB_LABEL)) lookalike = { kind: "hub", target: HUB_DOMAIN };
    else {
      for (const [label, domains] of KNOWN_SITES) {
        if (domains.some((d) => isHostOrChild(asciiHost, d))) { lookalike = null; break; }
        if (resembles(uniReg.label, uniReg.label, label)) { lookalike = { kind: "known", target: domains[0] }; break; }
      }
    }
  }
  return {
    ok: true,
    href: url.toString(),
    internal,
    asciiHost,
    unicodeHost,
    idn: unicodeHost !== asciiHost,
    userinfo,
    registrable: reg.domain,
    lookalike,
    http: url.protocol === "http:",
  };
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`\u0080-\uFFFF]+/gi;
const TRAILING = /[.,!?;:)\]}＞、。！）：；？」』】]+$/u;

/** 本文を文字と URL に分ける。URL 末尾の句読点は文字側へ戻す。 */
export function segmentUrls(text) {
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    const url = match[0].replace(TRAILING, "");
    if (!url || url.length > 2048) continue;
    try { new URL(url); } catch { continue; }
    if (index > cursor) parts.push({ t: "text", v: text.slice(cursor, index) });
    parts.push({ t: "url", v: url });
    cursor = index + url.length;
  }
  if (cursor < text.length) parts.push({ t: "text", v: text.slice(cursor) });
  return parts;
}

/** 確認パネルに出す語。Hub と Desktop で同じ文言を使う。 */
export const LEAVE_LABELS = {
  title: "Hubの外へ移動します",
  open: "開く",
  cancel: "やめる",
  idn: "実際のアドレス（punycode）",
  userinfo: "@ より前は行き先ではありません",
  http: "暗号化されていない接続です",
  lookalikeHub: "Hubのアドレスに似ています。Hubではありません",
  lookalikeKnown: (target) => `${target} に似ています。公式ではない可能性があります`,
};

/** 確認パネルの行（表示用の素の文字列）。 */
export function leaveFacts(info) {
  const facts = [info.unicodeHost];
  if (info.idn) facts.push(`${LEAVE_LABELS.idn}: ${info.asciiHost}`);
  if (info.userinfo) facts.push(LEAVE_LABELS.userinfo);
  if (info.http) facts.push(LEAVE_LABELS.http);
  const warnings = [];
  if (info.lookalike?.kind === "hub") warnings.push(LEAVE_LABELS.lookalikeHub);
  else if (info.lookalike) warnings.push(LEAVE_LABELS.lookalikeKnown(info.lookalike.target));
  return { facts, warnings };
}
