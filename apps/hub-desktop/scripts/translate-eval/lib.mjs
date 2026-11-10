// 翻訳モデル比較の部品: 言語名、モデルごとのプロンプト、chrF、HTML。
// プロンプトは各モデルカード/チャットテンプレートに書かれた形式（2026-11-06 に確認）。

export const LANG_NAMES = {
  ja: 'Japanese', en: 'English', zh: 'Chinese', ko: 'Korean', es: 'Spanish', fr: 'French', de: 'German',
};

// 目的言語の符号を、各モデルが受ける形へ。
const PLAMO_CODE = {ja: 'ja', en: 'en'};
const MADLAD_CODE = {ja: 'ja', en: 'en', zh: 'zh', ko: 'ko', es: 'es', fr: 'fr', de: 'de'};
const GEMMA_CODE = {ja: 'ja', en: 'en', zh: 'zh', ko: 'ko', es: 'es', fr: 'fr', de: 'de'};

/** PLaMo 3 Translate（PFML3）。ja↔en のみ。 */
export function plamoPrompt(text, from, to) {
  if (!(PLAMO_CODE[from] && PLAMO_CODE[to])) return null;
  const clean = text.replaceAll('<|plamo:', '');
  return `<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>${from}<|plamo:msg|>${clean}<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${to}<|plamo:msg|>`;
}
export const PLAMO_STOP = ['<|plamo:tag|>', '<|plamo:bos|>'];

/** MADLAD-400: 先頭に <2xx>。 */
export function madladPrompt(text, _from, to) {
  return MADLAD_CODE[to] ? `<2${MADLAD_CODE[to]}> ${text.trim()}` : null;
}

/** TranslateGemma: チャットテンプレート（chat_template.jinja）を文字列にしたもの。bos は runtime が付ける。 */
export function gemmaPrompt(text, from, to) {
  if (!(GEMMA_CODE[from] && GEMMA_CODE[to])) return null;
  const s = LANG_NAMES[from], t = LANG_NAMES[to], sc = GEMMA_CODE[from], tc = GEMMA_CODE[to];
  return `<start_of_turn>user\nYou are a professional ${s} (${sc}) to ${t} (${tc}) translator. Your goal is to accurately convey the meaning and nuances of the original ${s} text while adhering to ${t} grammar, vocabulary, and cultural sensitivities.\n`
    + `Produce only the ${t} translation, without any additional explanations or commentary. Please translate the following ${s} text into ${t}:\n\n\n${text.trim()}<end_of_turn>\n<start_of_turn>model\n`;
}
export const GEMMA_STOP = ['<end_of_turn>'];

export const PROMPTS = {plamo: plamoPrompt, madlad: madladPrompt, gemma: gemmaPrompt};
export const STOPS = {plamo: PLAMO_STOP, madlad: [], gemma: GEMMA_STOP};

// ---- chrF（Popović 2015）: 文字 n-gram（1〜6）、空白は無視、β=2。語 n-gram は使わない（chrF）。 ----
function ngrams(text, n) {
  const chars = [...text.replace(/\s+/g, '')];
  const map = new Map();
  for (let i = 0; i + n <= chars.length; i += 1) {
    const g = chars.slice(i, i + n).join('');
    map.set(g, (map.get(g) ?? 0) + 1);
  }
  return map;
}
export function chrf(hyp, ref, maxN = 6, beta = 2) {
  let precisionSum = 0, recallSum = 0, counted = 0;
  for (let n = 1; n <= maxN; n += 1) {
    const h = ngrams(hyp, n), r = ngrams(ref, n);
    const hTotal = [...h.values()].reduce((a, b) => a + b, 0), rTotal = [...r.values()].reduce((a, b) => a + b, 0);
    if (hTotal === 0 && rTotal === 0) continue;
    let match = 0;
    for (const [g, c] of h) match += Math.min(c, r.get(g) ?? 0);
    precisionSum += hTotal ? match / hTotal : 0;
    recallSum += rTotal ? match / rTotal : 0;
    counted += 1;
  }
  if (!counted) return 0;
  const p = precisionSum / counted, rc = recallSum / counted;
  if (p + rc === 0) return 0;
  const b2 = beta * beta;
  return (100 * (1 + b2) * p * rc) / (b2 * p + rc);
}

export function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

/** 並べて見るための HTML。results: {modelId: {itemId: {out, ms, chrf}}} */
export function renderHtml(items, results, summary) {
  const ids = Object.keys(results);
  const head = ids.map((m) => `<th>${esc(m)}</th>`).join('');
  const rows = items.map((it) => `<tr><td class="id">${esc(it.id)}<br><small>${esc(it.pair)}</small></td><td>${esc(it.src)}</td><td class="ref">${esc(it.ref)}</td>${ids.map((m) => {
    const r = results[m][it.id];
    return r ? `<td>${esc(r.out)}<br><small>chrF ${r.chrf?.toFixed(1) ?? '-'} / ${Math.round(r.ms)} ms</small></td>` : '<td class="skip">–</td>';
  }).join('')}</tr>`).join('\n');
  const sum = Object.entries(summary).map(([m, byPair]) => `<tr><td>${esc(m)}</td>${Object.entries(byPair).map(([p, v]) => `<td>${esc(p)} ${v.toFixed(1)}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>翻訳モデル比較</title>
<style>:root{color-scheme:light dark}body{font:14px/1.5 system-ui,sans-serif;margin:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #8886;padding:6px;vertical-align:top}.ref{opacity:.8}.id{white-space:nowrap}small{opacity:.7}.skip{opacity:.4;text-align:center}</style>
<h1>翻訳モデル比較</h1><h2>chrF（言語対ごとの平均）</h2><table>${sum}</table>
<h2>文ごと</h2><table><tr><th>id</th><th>原文</th><th>参照訳</th>${head}</tr>${rows}</table>`;
}
