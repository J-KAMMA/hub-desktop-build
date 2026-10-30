// 順序付きの代替先を順に試す。最初の文字が届く前の失敗だけ次へ回す。
// 文字が1つでも届いたあとは回さない（二重の返答・二重請求を避ける）。
// 会話・キーはここでログにも保存にも出さない。
const FALLBACK_CODES = new Set([
  'byok_rate_limited', 'byok_quota_exceeded', 'byok_timeout', 'byok_unreachable', 'byok_provider_failed',
  'byok_connection_lost', 'byok_model_not_found', 'byok_auth_failed', 'byok_key_missing', 'byok_disabled',
  'byok_busy', 'byok_bad_request', 'byok_store_unavailable', 'byok_endpoint_not_allowed',
  'byok_cli_not_installed', 'byok_cli_not_logged_in', 'byok_cli_failed', 'byok_connection_not_found',
]);
export const REFUSAL_CODE = 'byok_blocked';

/** 'next' | 'stop'。安全基準による拒否は、利用者が許したときだけ次へ回す。 */
export function decide(code, { refusalFallback = false } = {}) {
  if (code === REFUSAL_CODE) return refusalFallback ? 'next' : 'stop';
  return FALLBACK_CODES.has(code) ? 'next' : 'stop';
}

const codeOf = (e) => String(e?.message ?? e ?? '').match(/byok_[a-z_]+/)?.[0] ?? 'byok_provider_failed';

/**
 * start(entry, sink) は1回の試行を始め、取り消し関数を返す（Promise可）。
 * sink: { delta(text), done(cancelled), error(code) }。
 * on: { switch({ref,index,previous,reason}), delta(text, ref), done({cancelled, answeredBy}), error(code, failures) }。
 * 失敗の記録は参照とコードだけで、本文は持たない。
 */
export function runChain({ entries, start, on = {}, refusalFallback = false, firstTokenMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const list = [...entries];
  let index = -1, attempt = 0, tokens = false, over = false, cancel = null;
  const failed = [];
  const report = () => failed.map((f) => ({ ref: f.ref, code: f.code }));
  const finishOnce = (fn) => { if (over) return; over = true; fn(); };

  async function next(reason) {
    index += 1;
    if (index >= list.length) {
      finishOnce(() => on.error?.(failed.length ? failed.at(-1).code : 'byok_connection_not_found', report()));
      return;
    }
    const entry = list[index], mine = ++attempt;
    let timer = null, dead = false;
    const alive = () => !over && !dead && mine === attempt;
    const fail = (code) => {
      if (!alive()) return;
      dead = true; clearTimer(timer);
      try { cancel?.(); } catch { /* ignore */ }
      cancel = null;
      failed.push({ ref: entry, code });
      if (!tokens && decide(code, { refusalFallback }) === 'next') { next(code); return; }
      finishOnce(() => on.error?.(code, report()));
    };
    on.switch?.({ ref: entry, index, previous: index > 0 ? list[index - 1] : null, reason: reason ?? null });
    const sink = {
      delta(text) {
        if (!alive() || typeof text !== 'string' || !text) return;
        tokens = true; clearTimer(timer);
        on.delta?.(text, entry);
      },
      done(cancelled = false) {
        if (!alive()) return;
        clearTimer(timer);
        if (!tokens && !cancelled) { fail('byok_provider_failed'); return; } // 空の返答は失敗扱い
        finishOnce(() => on.done?.({ cancelled, answeredBy: entry }));
      },
      error: fail,
    };
    timer = setTimer(() => fail('byok_timeout'), firstTokenMs);
    try {
      const c = await start(entry, sink);
      if (alive()) cancel = c; else { try { c?.(); } catch { /* ignore */ } }
    } catch (e) { fail(codeOf(e)); }
  }
  next(null);
  return { cancel() { over = true; try { cancel?.(); } catch { /* ignore */ } } };
}

/** byok_chat_start と "byok-chat" イベントを試行に変える。api と cli の参照を扱う。 */
export function createByokStarter({ invoke, listen, parseRef, messages }) {
  return async (ref, sink) => {
    const t = parseRef(ref);
    if (!t) throw new Error('byok_connection_not_found');
    let id = null, buffered = [];
    let off = () => {};
    const handle = (p) => {
      if (p.type === 'delta') sink.delta(p.text);
      else if (p.type === 'done') { try { off(); } catch { /* ignore */ } sink.done(Boolean(p.cancelled)); }
      else if (p.type === 'error') { try { off(); } catch { /* ignore */ } sink.error(String(p.code ?? 'byok_provider_failed')); }
    };
    off = await listen('byok-chat', (e) => {
      const p = e?.payload;
      if (id === null) buffered.push(p); else if (p?.requestId === id) handle(p);
    });
    try {
      id = await invoke('byok_chat_start', { input: { source: t.source, id: t.id, model: t.model, messages } });
    } catch (e) { try { off(); } catch { /* ignore */ } throw e; }
    const queued = buffered; buffered = [];
    for (const p of queued) if (p?.requestId === id) handle(p);
    return () => { invoke('byok_chat_cancel', { requestId: id }).catch(() => {}); try { off(); } catch { /* ignore */ } };
  };
}
