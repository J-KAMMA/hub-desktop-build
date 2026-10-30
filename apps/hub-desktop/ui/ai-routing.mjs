// 用途別の振り分けと、順序付きの代替先（フォールバック）の保存と解決。
// 保存するのは参照（byok:<id>/<model> など）と順序だけ。キー・会話は含めない。
export const TASKS = Object.freeze(['chat', 'long', 'code', 'fast', 'cheap']);
export const TASK_LABEL = Object.freeze({ chat: '会話', long: '長文', code: 'コード', fast: '速さ優先', cheap: '安さ優先' });
export const ROUTING_KEY = 'hub.desktop.ai.routing';
export const MAX_CHAIN = 12;

const refOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= 460 && !/[\s\u0000-\u001f\u007f-\u009f<>"'`\\]/u.test(v)
  && /^(byok:[^/]+\/.+|cli:[^/]+\/.+|local:.+|pc:.+)$/u.test(v);

export function cleanChain(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) if (refOk(v) && !out.includes(v) && out.length < MAX_CHAIN) out.push(v);
  return out;
}

export function normalizeRules(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tasks = {};
  for (const t of TASKS) { const c = cleanChain(r.tasks?.[t]); if (c.length) tasks[t] = c; }
  return { chain: cleanChain(r.chain), tasks, refusalFallback: r.refusalFallback === true };
}

export function loadRules(storage) {
  try { return normalizeRules(JSON.parse(storage?.getItem(ROUTING_KEY) ?? 'null')); } catch { return normalizeRules(null); }
}
export function saveRules(storage, rules) {
  try { storage?.setItem(ROUTING_KEY, JSON.stringify(normalizeRules(rules))); return true; } catch { return false; }
}

/** 用途の順序（無ければ既定の順序）から、使える参照だけを順に残す。availableは参照の集合。 */
export function resolveChain(rules, task, available) {
  const r = normalizeRules(rules);
  const base = (TASKS.includes(task) && r.tasks[task]) || r.chain;
  const ok = available instanceof Set ? available : new Set(available ?? []);
  return base.filter((ref) => ok.has(ref));
}
