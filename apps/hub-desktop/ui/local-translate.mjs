// 端末内翻訳（日本語↔英語は PLaMo 3 Translate、それ以外は TranslateGemma 4B）。docs/hub-desktop-translate/DESIGN.md。
// 本文は端末の外へ出ない。公開項目だけ、先に Hub の保存済み翻訳を引き（cacheOnly）、無ければ端末で訳す。
// 共有（既定オフ）を選んだ人の公開項目だけ、既存の Personal Node 経路へ渡す。結果はメモリに項目+版ごとに持つ。

export const PUBLIC_TARGETS = ['social_post', 'thread_post', 'community_message'];
/** Hub の共有翻訳には、どのモデルで訳したかの記録が手元に無いので、共有であることを表示する。 */
export const HUB_LABEL = '機械翻訳・共有された翻訳';

const MESSAGES = {
  translate_licence_required: '設定で翻訳の内容を確認してください',
  translate_model_missing: '翻訳モデルが入っていません',
  translate_runtime_missing: 'llama-server が見つかりません（設定で場所を指定）',
  translate_same_language: '訳す必要がありません',
  translate_local_model_changed: '登録したモデルのファイルが変わっています。設定で選び直してください',
  translate_gguf_invalid: 'GGUF ファイルではありません',
  translate_text_too_long: '長すぎて訳せません',
  translate_lang_unsupported: 'この言語には対応していません',
  translate_timeout: '時間がかかりすぎました',
  translate_empty: '訳せませんでした',
  translate_api_failed: 'API で訳せませんでした',
};
/** 提供元（API）の符号 → 短い理由。キーや本文は含まない。 */
const API_MESSAGES = {
  byok_auth_failed: 'API キーが通りません',
  byok_quota_exceeded: 'API の利用枠を超えています',
  byok_rate_limited: 'API が混み合っています',
  byok_model_not_found: 'API のモデルが見つかりません',
  byok_timeout: 'API の応答が遅すぎました',
  byok_unreachable: 'API に届きません',
  byok_key_missing: 'API キーがありません',
  byok_disabled: 'API の接続が無効です',
  byok_connection_not_found: 'API の接続が見つかりません',
};
export function apiReason(code) { return API_MESSAGES[code] ?? 'API で訳せませんでした'; }
/** Rust のエラー符号は `translate_x` か `translate_x:パラメータ`。 */
export function parseError(error) {
  const raw = String(error?.message ?? error ?? '');
  const i = raw.indexOf(':');
  return i < 0 ? {code: raw, param: ''} : {code: raw.slice(0, i), param: raw.slice(i + 1)};
}
export function errorMessage(error) {
  const {code, param} = parseError(error);
  return code === 'translate_api_failed' ? `${apiReason(param)}。端末のモデルも使えません` : (MESSAGES[code] ?? '翻訳できませんでした');
}

const MODEL_NAMES = {plamo: 'PLaMo 3 Translate（日本語と英語）', gemma: 'TranslateGemma 4B（その他の言語）'};
/** 共有してよい族。PLaMo の出力は、Hub に「機械翻訳」の表示が出るまで共有しない（PLaMo Community License 第5条）。自前の GGUF も共有しない。 */
export const SHAREABLE_MODELS = new Set(['translategemma-4b']);
const fmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/** 言語の正規化は Rust 側。ここでは UI 言語をそのまま渡す。 */
export function createLocalTranslator({invoke, getLocale, getHubBase, isSharingEnabled = () => false, shareSink = null, isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false}) {
  const memory = new Map();
  const key = (item, to) => `${item.id}\u0000${item.revision ?? ''}\u0000${to}`;
  let generation = 0;

  async function translate(item) {
    const to = getLocale();
    const k = key(item, to);
    if (memory.has(k)) return memory.get(k);
    const mine = ++generation;
    const publicTarget = item.isPublic === true && PUBLIC_TARGETS.includes(item.type);
    let result = null;
    if (publicTarget) {
      try {
        const hit = await invoke('local_translate_cached', {base: await getHubBase(), targetType: item.type, targetId: item.id, locale: to});
        if (hit) result = {text: hit, source: 'hub', label: HUB_LABEL};
      } catch { /* Hub に届かなくても端末で訳せる */ }
    }
    if (!result) {
      // 2 段目（利用者の API）と 3 段目（端末）の選択は Rust。public は項目の公開状態、offline は画面から見た接続状態。
      const run = await invoke('local_translate_run', {request: {text: item.text, from: item.sourceLang || null, to, size: item.size || null, public: item.isPublic === true, offline: isOffline() === true}});
      const text = run.text;
      const viaApi = run.via === 'api';
      result = {text, source: viaApi ? 'api' : 'device', modelId: run.modelId, family: run.family, label: run.label || '機械翻訳', fallback: run.fallback || null};
      // API の訳は共有しない（提供元の規約の確認と Hub 側の表示が要る。DESIGN.md）。
      if (!viaApi && publicTarget && isSharingEnabled() && shareSink && item.sourceLang && SHAREABLE_MODELS.has(run.modelId)) {
        try {
          const payload = await invoke('local_translate_share_payload', {
            sharedOptIn: true, itemIsPublic: true, targetType: item.type, targetId: item.id,
            sourceText: item.text, sourceLang: item.sourceLang, targetLang: to, translated: text, modelId: run.modelId,
          });
          await shareSink(payload);
        } catch { /* 共有の失敗で翻訳は止めない */ }
      }
    }
    if (mine !== generation) throw new Error('cancelled');
    memory.set(k, result);
    return result;
  }
  async function cancel() {
    generation += 1;
    try { await invoke('local_translate_stop', {}); } catch { /* 起動前でも良い */ }
  }
  /** 必要なモデルの名前と大きさ（取得の案内用）。 */
  async function modelInfoOf(modelId) {
    const status = await invoke('local_translate_status', {});
    const m = status.models.find((x) => x.id === modelId);
    return m ? {id: m.id, family: m.family, bytes: m.bytes, label: MODEL_NAMES[m.family] ?? m.id, size: fmtSize(m.bytes)} : null;
  }
  async function download(modelId) {
    try { await invoke('local_translate_download', {size: modelId}); return {started: true}; }
    catch (error) { return {started: false, code: parseError(error).code}; }
  }
  async function waitDownloaded(modelId, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
    for (;;) {
      const p = (await invoke('local_translate_status', {})).progress;
      if (p.size === modelId && p.state === 'done') return true;
      if (p.state === 'failed' || p.state === 'cancelled') return false;
      await wait(1000);
    }
  }
  return {translate, cancel, download, waitDownloaded, modelInfo: (id) => modelInfoOf(id), cached: (item) => memory.get(key(item, getLocale())) ?? null, size: () => memory.size};
}

const ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.4 5.2 6.6M12 5c-.7 3.2-3.2 6-7 7.4M13 20l4-9 4 9M14.4 17h5.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * 項目の本文要素の隣に「翻訳」ボタンを付ける。押すと本文をその場で訳文に置き換え、もう一度押すと原文へ戻る。
 * 実行中に押すと取り消す。状態は短い 1 行（aria-live）。
 */
export function attachTranslateAction({doc = document, host, body, item, translator, getText = () => body.textContent, show = (text) => { body.textContent = text; }, restore = (text) => { body.textContent = text; }}) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'local-translate-btn';
  button.setAttribute('aria-label', '翻訳');
  button.title = '翻訳';
  button.innerHTML = ICON;
  const status = doc.createElement('span');
  status.className = 'local-translate-status';
  status.setAttribute('aria-live', 'polite');
  // 訳文には必ず「機械翻訳・<モデル名>」を見える形で付ける（PLaMo の出力の明示、Gemma の方針、だます使い方の防止）。
  const label = doc.createElement('span');
  label.className = 'local-translate-label';
  label.hidden = true;
  host.append(button, status, label);
  let original = null, busy = false, offer = null;
  async function offerDownload(modelId) {
    const info = await translator.modelInfo(modelId).catch(() => null);
    set('error', info ? `${info.label}が要ります（${info.size}）` : errorMessage('translate_model_missing'));
    if (!info || offer) return;
    offer = doc.createElement('button');
    offer.type = 'button'; offer.className = 'local-translate-get'; offer.textContent = '取得';
    offer.addEventListener('click', async () => {
      offer.disabled = true;
      const r = await translator.download(modelId);
      if (!r.started) { set('error', r.code === 'translate_licence_required' ? '設定で内容を確認してから取得してください' : '取得を始められません'); offer.disabled = false; return; }
      set('busy', '取得中…');
      const ok = await translator.waitDownloaded(modelId);
      offer.remove(); offer = null;
      set(ok ? 'idle' : 'error', ok ? '入りました。もう一度押してください' : '取得できませんでした');
    });
    status.after(offer);
  }
  const set = (state, text = '') => { button.dataset.state = state; status.textContent = text; };
  set('idle');
  button.addEventListener('click', async () => {
    if (busy) { busy = false; await translator.cancel(); set('idle', '取り消しました'); return; }
    if (original !== null) { restore(original); original = null; label.hidden = true; label.textContent = ''; set('idle'); return; }
    busy = true; set('busy', '翻訳中…（もう一度押すと取り消し）');
    try {
      const {text, source, label: shown, fallback} = await translator.translate({...item, text: getText()});
      if (!busy) return;
      original = getText(); show(text);
      label.textContent = shown || '機械翻訳'; label.hidden = false;
      const where = source === 'hub' ? '共有された翻訳' : source === 'api' ? 'API' : 'この端末';
      const note = fallback ? `（${apiReason(fallback)}。端末で訳しました）` : '';
      set('done', `翻訳済み（${where}）${note}。もう一度押すと原文`);
    } catch (error) {
      if (!busy) return;
      const {code, param} = parseError(error);
      if (code === 'translate_model_missing' && param) await offerDownload(param);
      else set('error', errorMessage(error));
    } finally { busy = false; }
  });
  return () => { button.remove(); status.remove(); label.remove(); offer?.remove(); };
}
