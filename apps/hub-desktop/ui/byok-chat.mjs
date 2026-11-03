// AIの接続（自分のAPIキー / インストール済みCLI）を、AI画面のモデル選択と会話に載せる。
// キーも会話もここには保存しない。呼び出しはRustが事業者へ直接行い、返答は "byok-chat" イベントで届く。
import { runChain, createByokStarter } from './ai-fallback.mjs';
import { loadRules, resolveChain } from './ai-routing.mjs';
import { privacyLabel } from './ai-provider-privacy.mjs';
import { createWebSearch, withSearchContext } from './ai-web-search.mjs';
import { REFUSAL, parseEvidence, buildPrompt, checkAnswer, renderCitations, cleanQuestion } from './hubpedia-ask.mjs';

export const API_PREFIX = 'byok:';
export const CLI_PREFIX = 'cli:';
export const LAST_MODEL_KEY = 'hub.desktop.ai.lastModel';

const ERRORS = Object.freeze({
  byok_auth_failed: 'APIキーが無効か、権限がありません。設定の「AIの接続」でキーを入れ直してください。',
  byok_rate_limited: 'リクエストが多すぎます。しばらくしてからもう一度お試しください。',
  byok_quota_exceeded: 'AI事業者側の利用枠または残高が足りません。事業者のアカウントを確認してください。',
  byok_model_not_found: 'このモデルは使えません。モデルを選び直してください。',
  byok_bad_request: '事業者に受け付けられませんでした。会話が長すぎるか、モデルが対応していない可能性があります。',
  byok_provider_failed: 'AI事業者側で問題が起きています。しばらくしてからお試しください。',
  byok_unreachable: 'AI事業者へ接続できません。ネットワークと接続先を確認してください。',
  byok_timeout: '応答が時間内に返りませんでした。',
  byok_connection_lost: '通信が途中で切れました。',
  byok_response_too_large: '返答が大きすぎるため止めました。',
  byok_blocked: '事業者の安全基準により、この依頼には答えられませんでした。',
  byok_key_missing: 'この接続にはAPIキーが必要です。設定の「AIの接続」で登録してください。',
  byok_disabled: 'この接続は無効です。設定の「AIの接続」で有効にしてください。',
  byok_endpoint_not_allowed: '接続先は https:// で始まるアドレスにしてください（この端末内のサーバーだけ http:// も使えます）。',
  byok_store_unavailable: 'この端末の資格情報の保管庫を使えません。',
  byok_connection_not_found: '接続が見つかりません。',
  byok_too_many_connections: '接続は20件までです。',
  byok_busy: '同時に実行できる数を超えています。終わるまでお待ちください。',
  byok_invalid_request: '入力内容を確認してください。会話が長すぎる場合は新しい作業を始めてください。',
  byok_cli_not_installed: 'このCLIが見つかりません。',
  byok_cli_not_logged_in: 'CLIにログインしていないようです。ターミナルでCLIを起動してログインしてください。',
  byok_cli_failed: 'CLIの実行に失敗しました。',
  native_window_required: 'この操作はアプリの本体画面からだけ行えます。',
});

export function errorCode(error) {
  const match = /byok_[a-z_]+|native_window_required/.exec(String(error?.message ?? error ?? ''));
  return match ? match[0] : 'byok_provider_failed';
}

export function errorText(error) {
  return ERRORS[errorCode(error)] ?? ERRORS.byok_provider_failed;
}

export const BILLING_NOTE = '利用料金は、AI事業者からご自身のアカウントへ直接請求されます。Hubは料金を扱わず、キーも受け取りません。';
export const CLI_NOTE = 'インストール済みのCLIに、そのログインのまま依頼します。ログイン情報はHubに渡りません。';
export const MEMORY_NOTE = 'この会話はこの画面を閉じるか新規で始めるまで、メモリ上にだけあります。保存しません。';

export const apiRef = (connectionId, model) => `${API_PREFIX}${connectionId}/${model}`;
export const cliRef = (cliId, model) => `${CLI_PREFIX}${cliId}/${model || 'default'}`;

/** "byok:<id>/<model>" or "cli:<id>/<model|default>" → {source, id, model}. Anything else is not ours. */
export function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  for (const [prefix, source] of [[API_PREFIX, 'api'], [CLI_PREFIX, 'cli']]) {
    if (!ref.startsWith(prefix)) continue;
    const rest = ref.slice(prefix.length), slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    const id = rest.slice(0, slash), model = rest.slice(slash + 1);
    return { source, id, model: source === 'cli' && model === 'default' ? null : model };
  }
  return null;
}

const modelOk = (value) => typeof value === 'string' && value.length > 0 && value.length <= 400 && !/[\s\u0000-\u001f\u007f-\u009f<>"'`\\]/u.test(value);

/** Adds enabled API connections and CLIs to the Pi model catalog. Pure: returns a new catalog. */
export function mergeCatalog(base, sources) {
  const models = [...(base?.models ?? [])], ready = base?.ready ? [...base.ready] : null;
  const locations = { ...(base?.locations ?? {}) }, groups = {}, providers = {};
  for (const source of Array.isArray(sources) ? sources : []) {
    const entries = source.kind === 'cli'
      ? [cliRef(source.id, null), ...(source.models ?? []).map((model) => cliRef(source.id, model))]
      : (source.models ?? []).map((model) => apiRef(source.id, model));
    for (const ref of entries) {
      if (!modelOk(ref) || models.includes(ref)) continue;
      models.push(ref);
      if (ready) ready.push(ref);
      locations[ref] = source.kind === 'cli' ? 'cli' : 'api';
      groups[ref] = source.kind === 'cli' ? `${source.name}（CLI）` : source.name;
      providers[ref] = source.kind === 'cli' ? 'cli' : (source.provider ?? 'openai_compatible');
    }
  }
  const catalog = { ...base, models };
  if (ready) catalog.ready = ready;
  if (Object.keys(locations).length) catalog.locations = locations;
  return { catalog, groups, providers };
}

/** Wraps the invoke given to the model picker so `pi_work_models` also lists AI connections. */
export function createConnectionModels({ invoke, storage = null }) {
  let groups = {}, providers = {};
  const wrapped = async (command, args) => {
    const body = await invoke(command, args);
    if (command !== 'pi_work_models') return body;
    let sources = [];
    try { sources = (await invoke('byok_models', {}))?.sources ?? []; } catch { /* picker still works without connections */ }
    const merged = mergeCatalog(body, sources);
    groups = merged.groups; providers = merged.providers;
    return merged.catalog;
  };
  const remember = (ref) => { try { if (parseRef(ref)) storage?.setItem(LAST_MODEL_KEY, ref); else storage?.removeItem(LAST_MODEL_KEY); } catch { /* optional */ } };
  const remembered = () => { try { return storage?.getItem(LAST_MODEL_KEY) ?? null; } catch { return null; } };
  return { invoke: wrapped, groupOf: (ref) => groups[ref] ?? null, remember, remembered, known: (ref) => Object.hasOwn(groups, ref),
    refs: () => Object.keys(groups), privacyOf: (ref) => (Object.hasOwn(providers, ref) ? privacyLabel(providers[ref]) : null) };
}

/** One in-memory conversation shown in place of the timeline while an AI connection is chosen. */
export function createConnectionChat({ document, invoke, listen, host, timeline, onChange = () => {}, routing = null }) {
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const panel = make('div', undefined, 'byok-chat');
  panel.hidden = true;
  const note = make('p', '', 'byok-note meta');
  const list = make('div', undefined, 'byok-messages');
  list.setAttribute('aria-live', 'polite');
  const status = make('p', '', 'byok-status meta');
  status.setAttribute('role', 'status');
  const stop = make('button', '停止', 'deny byok-stop');
  stop.type = 'button'; stop.hidden = true;
  panel.append(note, list, status, stop);
  host.append(panel);

  let history = [], current = null, early = [], unlisten = null, searching = false;
  const webSearch = createWebSearch({ document, invoke });
  const busy = () => current !== null || searching;

  function show(on) {
    panel.hidden = !on;
    if (timeline) timeline.hidden = on;
    host.closest('.piw-shell')?.classList.toggle('is-byok', on);
    onChange(on);
  }
  function bubble(role, text) {
    const node = make('div', text, role === 'user' ? 'byok-msg byok-user' : 'byok-msg byok-assistant');
    list.append(node);
    list.scrollTop = list.scrollHeight;
    return node;
  }
  function finish(message, ok) {
    const assistant = current?.node;
    if (ok && assistant?.textContent) history.push({ role: 'assistant', content: assistant.textContent });
    else if (!ok && history.at(-1)?.role === 'user' && !assistant?.textContent) history.pop();
    current = null; stop.hidden = true;
    status.textContent = message;
    if (!ok) assistant?.classList.add('is-failed');
    onChange(true);
  }
  function handle(payload) {
    if (!current || payload?.requestId !== current.id) return;
    if (payload.type === 'delta' && typeof payload.text === 'string') {
      current.node.textContent += payload.text;
      list.scrollTop = list.scrollHeight;
    } else if (payload.type === 'done') {
      finish(payload.cancelled ? '停止しました。' : '', true);
    } else if (payload.type === 'error') {
      finish(errorText(payload.code), false);
    }
  }
  function route(payload) {
    if (current && current.id === null) early.push(payload); else handle(payload);
  }
  async function ensureListener() {
    if (unlisten || !listen) return;
    unlisten = await listen('byok-chat', (event) => route(event.payload));
  }

  stop.addEventListener('click', async () => {
    if (current?.run && current.grounded) { const n = current.node; current.run.cancel(); current = null; stop.hidden = true; n.textContent = '停止しました。'; status.textContent = ''; onChange(true); return; }
    if (current?.run) { current.run.cancel(); finish('停止しました。', true); return; }
    if (!current?.id) return;
    stop.disabled = true;
    try { await invoke('byok_chat_cancel', { requestId: current.id }); } catch { /* the stream ends on its own */ }
    stop.disabled = false;
  });

  return {
    handles: (ref) => parseRef(ref) !== null,
    isBusy: busy,
    isShown: () => !panel.hidden,
    hide() { if (!busy()) show(false); },
    reset() {
      if (busy()) return false;
      history = []; list.replaceChildren(); status.textContent = ''; webSearch.reset();
      show(false);
      return true;
    },
    /** Returns true when the message was accepted (the composer may clear its draft). */
    async send(text, ref, label = '') {
      const target = parseRef(ref), content = String(text ?? '').trim();
      if (!target || !content || busy()) return false;
      searching = true;
      try { await ensureListener(); } finally { searching = false; }
      note.textContent = `${target.source === 'cli' ? CLI_NOTE : BILLING_NOTE} ${MEMORY_NOTE}`;
      show(true);
      history.push({ role: 'user', content });
      bubble('user', content);
      const node = bubble('assistant', '');
      // 「Web検索」が入のときだけ、承認を通した検索結果を今回の質問に添える（履歴と画面には元の質問だけ残す）。
      let outgoing = history;
      if (webSearch.enabled()) {
        searching = true; stop.hidden = true;
        status.textContent = '検索の承認を待っています…';
        const found = await webSearch.run(content);
        searching = false;
        status.textContent = found.note;
        if (found.results.length) outgoing = history.map((m, i) => (i === history.length - 1 ? { ...m, content: withSearchContext(m.content, found.results) } : m));
      }
      // 代替先の順序が設定されていれば、選んだモデルを先頭に、残りを順に試す。
      const rules = routing ? loadRules(routing.storage) : null;
      const rest = rules ? resolveChain(rules, routing.getTask?.() ?? 'chat', routing.available?.() ?? []).filter((r) => r !== ref) : [];
      if (rest.length) {
        const nameOf = (r) => routing.nameOf?.(r) ?? r;
        const answered = make('p', '', 'byok-answered meta');
        const mine = { id: 'chain', node, label, run: null };
        current = mine;
        early = [];
        stop.hidden = false; stop.disabled = false;
        status.textContent = `${label || target.model || '既定のモデル'} に問い合わせています…`;
        onChange(true);
        const snapshot = outgoing.map((m) => ({ ...m }));
        let switched = false;
        mine.run = runChain({
          entries: [ref, ...rest], refusalFallback: rules.refusalFallback,
          start: (entry, sink) => (routing.start ? routing.start(entry, sink, snapshot) : createByokStarter({ invoke, listen, parseRef, messages: snapshot })(entry, sink)),
          on: {
            switch: ({ ref: entry, previous }) => { if (previous) { switched = true; status.textContent = `${nameOf(previous)} が使えなかったため、${nameOf(entry)} で答えます…`; } },
            delta: (text) => { if (current !== mine) return; node.textContent += text; list.scrollTop = list.scrollHeight; },
            done: ({ cancelled, answeredBy }) => {
              if (current !== mine) return;
              answered.textContent = `回答: ${nameOf(answeredBy)}${switched ? '（代替先に切り替えました）' : ''}`;
              list.append(answered);
              finish(cancelled ? '停止しました。' : '', true);
            },
            error: (code) => { if (current === mine) finish(errorText(code), false); },
          },
        });
        return true;
      }
      current = { id: null, node, label };
      early = [];
      stop.hidden = false; stop.disabled = false;
      status.textContent = `${label || target.model || '既定のモデル'} に問い合わせています…`;
      onChange(true);
      try {
        current.id = await invoke('byok_chat_start', { input: { source: target.source, id: target.id, model: target.model, messages: outgoing } });
      } catch (error) {
        finish(errorText(error), false);
        return true;
      }
      const queued = early; early = [];
      for (const payload of queued) handle(payload);
      return true;
    },
    /**
     * 「ハブペディアに聞く」。retrieve(question) は Hub の取得APIの応答（版1）を返す。資料が空ならモデルを呼ばない。
     * モデルには質問と番号つき資料だけを送り、後検査を通った文だけを出す。この会話の履歴には残さない。
     */
    async askHubpedia(text, ref, label = '', { retrieve, openLink = () => {} } = {}) {
      const target = parseRef(ref), question = cleanQuestion(text);
      if (!target || !question || busy() || typeof retrieve !== 'function') return false;
      note.textContent = `${target.source === 'cli' ? CLI_NOTE : BILLING_NOTE} 質問の語句だけがHubに送られ、質問と資料は選んだAIへ送られます。${MEMORY_NOTE}`;
      show(true);
      bubble('user', question);
      const node = bubble('assistant', 'ハブペディアを調べています…');
      const mine = { id: 'chain', node, label, run: null, grounded: true };
      current = mine; early = [];
      stop.hidden = false; stop.disabled = true;
      status.textContent = '';
      onChange(true);
      const conclude = (message) => { if (current !== mine) return; current = null; stop.hidden = true; status.textContent = message; onChange(true); };
      const showResult = (result) => {
        node.textContent = result.answer;
        if (!result.grounded) node.classList.add('is-ungrounded');
        else node.parentNode?.insertBefore(renderCitations(document, result, openLink), node.nextSibling);
        list.scrollTop = list.scrollHeight;
      };
      let items = [];
      try { items = parseEvidence(await retrieve(question)); } catch { items = []; }
      if (current !== mine) return true;
      if (!items.length) { showResult({ answer: REFUSAL, citations: [], grounded: false }); conclude(''); return true; }
      const rules = routing ? loadRules(routing.storage) : null;
      const rest = rules ? resolveChain(rules, routing.getTask?.() ?? 'chat', routing.available?.() ?? []).filter((r) => r !== ref) : [];
      const nameOf = (r) => routing?.nameOf?.(r) ?? r;
      const messages = [{ role: 'user', content: buildPrompt(question, items) }];
      let output = '';
      stop.disabled = false;
      status.textContent = `${label || target.model || '既定のモデル'} に問い合わせています…`;
      mine.run = runChain({
        entries: [ref, ...rest], refusalFallback: rules?.refusalFallback === true,
        start: (entry, sink) => (routing?.start ? routing.start(entry, sink, messages) : createByokStarter({ invoke, listen, parseRef, messages })(entry, sink)),
        on: {
          switch: ({ ref: entry, previous }) => { if (previous) { output = ''; status.textContent = `${nameOf(previous)} が使えなかったため、${nameOf(entry)} で答えます…`; } },
          delta: (chunk) => { if (current === mine) output += chunk; },
          done: ({ cancelled, answeredBy }) => {
            if (current !== mine) return;
            if (cancelled) { node.textContent = '停止しました。'; conclude(''); return; }
            showResult(checkAnswer(output, items));
            conclude(`回答: ${nameOf(answeredBy)}（資料は${items.length}件）`);
          },
          error: (code) => { if (current === mine) { node.textContent = ''; node.classList.add('is-failed'); conclude(errorText(code)); } },
        },
      });
      return true;
    },
    destroy() { try { unlisten?.(); } catch { /* ignore */ } unlisten = null; },
  };
}
