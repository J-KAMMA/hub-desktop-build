// 設定 → AIの接続。APIキーの接続と、インストール済みCLIの有効・無効。
// キーは入力欄から Rust へ一度渡すだけで、保存後は画面にもブラウザの保管領域にも残らない。
import { confirmInline, settingHeader } from './settings-view.mjs';
import { errorText } from './byok-chat.mjs';
import { createRemoteAiCard } from './remote-ai-host.mjs';
import { createAiRoutingPanel } from './ai-routing-panel.mjs';
import { privacyLabel } from './ai-provider-privacy.mjs';

export const PROVIDERS = Object.freeze([
  { kind: 'anthropic', label: 'Anthropic（Claude）', custom: false, modelHint: 'claude-sonnet-4-5 など' },
  { kind: 'openai', label: 'OpenAI', custom: false, modelHint: 'gpt-5 など' },
  { kind: 'google', label: 'Google（Gemini）', custom: false, modelHint: 'gemini-2.5-pro など' },
  { kind: 'openai_compatible', label: 'OpenAI互換（OpenRouter・自前のサーバーなど）', custom: true, modelHint: '接続先のモデル名' },
]);
export const providerLabel = (kind) => PROVIDERS.find((p) => p.kind === kind)?.label ?? kind;

export const CLI_STATE_TEXT = Object.freeze({
  not_installed: '未インストール',
  logged_in: 'ログイン済み',
  not_logged_in: '未ログイン',
  unknown: 'ログイン状態を確認できません',
});

/** 「保存済み ••••1234」。末尾4文字が無ければ「保存済み」だけ。キー本体は受け取らない。 */
export function keyStatus(connection) {
  if (!connection?.hasKey) return 'キー未登録';
  return connection.keyHint ? `保存済み ••••${connection.keyHint}` : '保存済み';
}

/** 保存前の入力検査（Rust側でも同じ規則で検査する）。 */
export function validateForm({ kind, name, baseUrl, apiKey, editing }) {
  const provider = PROVIDERS.find((p) => p.kind === kind);
  if (!provider) return '種類を選んでください。';
  if (!name.trim() || name.trim().length > 60) return '表示名を60文字以内で入力してください。';
  if (provider.custom) {
    let url = null;
    try { url = new URL(baseUrl.trim()); } catch { return '接続先のアドレスを入力してください。'; }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return '接続先は https:// で始めてください（この端末内のサーバーだけ http:// も使えます）。';
    if (url.username || url.password || url.search || url.hash) return '接続先にパスワード・クエリは含めないでください。';
    if (!apiKey.trim() && !editing && !local) return 'APIキーを入力してください。';
  } else if (!apiKey.trim() && !editing) return 'APIキーを入力してください。';
  if (apiKey.trim() && (/\s/.test(apiKey.trim()) || apiKey.trim().length > 512)) return 'APIキーに空白や改行は含められません。';
  return '';
}

export function createAiConnectionsPanel({ document, invoke, listen = null, storage = null }) {
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const element = make('div', undefined, 'byok-settings');
  const notice = make('p', '', 'meta'); notice.setAttribute('role', 'status');

  // --- APIキーの接続 ---
  const apiCard = make('div', undefined, 'card');
  apiCard.append(
    settingHeader(document, { label: '自分のAPIキー', desc: 'お持ちのAPIキーでAIを使います。キーはこの端末のWindows資格情報マネージャーにだけ保存し、Hubには送りません。保存後は画面に出ません。料金はAI会社からあなたへ直接請求されます。', keywords: 'APIキー キー OpenAI Anthropic Claude Gemini 接続 モデル 資格情報' }),
  );
  const list = make('div', undefined, 'byok-list');
  const confirmHost = make('div');
  const form = make('form', undefined, 'byok-form'); form.hidden = true; form.noValidate = true;
  const field = (labelText, input) => { const label = make('label', undefined, 'settings-field'); label.append(make('span', labelText), input); return label; };
  const kind = make('select'); for (const p of PROVIDERS) { const o = make('option', p.label); o.value = p.kind; kind.append(o); }
  const name = make('input'); name.type = 'text'; name.maxLength = 60; name.autocomplete = 'off';
  const base = make('input'); base.type = 'url'; base.placeholder = 'https://openrouter.ai/api/v1'; base.maxLength = 512; base.autocomplete = 'off'; base.spellcheck = false;
  const key = make('input'); key.type = 'password'; key.autocomplete = 'new-password'; key.spellcheck = false; key.maxLength = 512;
  const model = make('input'); model.type = 'text'; model.maxLength = 200; model.autocomplete = 'off'; model.spellcheck = false;
  const baseField = field('接続先のアドレス（OpenAI互換のみ）', base);
  const keyField = field('APIキー', key);
  const modelField = field('既定のモデル（任意）', model);
  const formState = make('p', '', 'meta'); formState.setAttribute('role', 'status');
  const save = make('button', '保存', 'btn btn-secondary'); save.type = 'submit';
  const cancel = make('button', 'キャンセル', 'btn btn-secondary'); cancel.type = 'button';
  const actions = make('div', undefined, 'actions'); actions.append(save, cancel);
  form.append(field('種類', kind), field('表示名', name), baseField, keyField, modelField, formState, actions);
  const add = make('button', '＋ 接続を追加', 'btn btn-secondary'); add.type = 'button';
  const addRow = make('div', undefined, 'actions'); addRow.append(add);
  apiCard.append(list, confirmHost, form, addRow);

  // --- CLI ---
  const cliCard = make('div', undefined, 'card');
  cliCard.append(
    settingHeader(document, { label: 'このPCのAIツール', desc: 'Claude Code・Codex・Gemini CLIを、入れてあるログインのまま使います。ログイン情報はツール自身が持ち、Hubは読み取りも送信もしません。ファイルを書き換えない設定で、専用の空のフォルダから動かします。', keywords: 'CLI Claude Code Codex Gemini コマンド ログイン' }),
  );
  const cliList = make('div', undefined, 'byok-list');
  cliCard.append(cliList);

  const routing = createAiRoutingPanel({ document, invoke, storage });
  element.append(apiCard, cliCard, routing.element);
  // スマホから使う: この節を開いて操作するまで、通信も待ち受けもしない。
  if (listen) element.append(createRemoteAiCard({ document, invoke, listen }).element);
  element.append(notice);

  let editingId = null, connections = [];
  const syncForm = () => {
    const provider = PROVIDERS.find((p) => p.kind === kind.value);
    baseField.hidden = !provider.custom;
    model.placeholder = provider.modelHint;
  };
  kind.addEventListener('change', syncForm);
  function closeForm() {
    form.hidden = true; addRow.hidden = false; editingId = null; key.value = ''; formState.textContent = '';
  }
  function openForm(connection) {
    editingId = connection?.id ?? null;
    kind.value = connection?.kind ?? 'anthropic'; kind.disabled = Boolean(connection);
    name.value = connection?.name ?? ''; base.value = connection?.baseUrl ?? ''; model.value = connection?.defaultModel ?? '';
    key.value = '';
    key.placeholder = connection ? `${keyStatus(connection)}（空欄なら今のキーを使います）` : '';
    syncForm();
    form.hidden = false; addRow.hidden = true; formState.textContent = '';
    name.focus();
  }
  add.addEventListener('click', () => openForm(null));
  cancel.addEventListener('click', closeForm);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const problem = validateForm({ kind: kind.value, name: name.value, baseUrl: base.value, apiKey: key.value, editing: Boolean(editingId) });
    if (problem) { formState.textContent = problem; return; }
    save.disabled = true;
    const provider = PROVIDERS.find((p) => p.kind === kind.value);
    try {
      await invoke('byok_save', { input: {
        id: editingId, kind: kind.value, name: name.value.trim(),
        baseUrl: provider.custom ? base.value.trim() : null,
        defaultModel: model.value.trim() || null,
        apiKey: key.value.trim() || null,
      } });
      key.value = '';
      closeForm();
      notice.textContent = '保存しました。';
      await refresh();
    } catch (error) {
      key.value = '';
      formState.textContent = errorText(error);
    } finally { save.disabled = false; }
  });

  /** 「スマホから使える」。既定はオフ。オフにすると、実行中のスマホの依頼も止まる。 */
  function remoteSwitch(source, id, label, allowed, usable) {
    const wrap = make('label', undefined, 'check settings-row byok-remote');
    const box = make('input'); box.type = 'checkbox'; box.checked = Boolean(allowed) && usable; box.disabled = !usable; box.setAttribute('role', 'switch');
    box.setAttribute('aria-label', `${label}をスマホから使える`);
    wrap.append(box, make('span', 'スマホから使える'));
    box.addEventListener('change', async () => {
      box.disabled = true;
      try { await invoke('byok_remote_set', { source, id, allowed: box.checked }); notice.textContent = ''; }
      catch (error) { box.checked = !box.checked; notice.textContent = errorText(error); }
      finally { box.disabled = false; }
    });
    return { wrap, box };
  }

  function row(connection) {
    const item = make('div', undefined, 'byok-row');
    const head = make('div', undefined, 'byok-row-head');
    const label = make('label', undefined, 'check settings-row');
    const toggle = make('input'); toggle.type = 'checkbox'; toggle.checked = connection.enabled; toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', `${connection.name}を使う`);
    label.append(toggle, make('strong', connection.name));
    head.append(label, make('span', providerLabel(connection.kind), 'meta'));
    const detail = make('p', undefined, 'meta');
    detail.textContent = [keyStatus(connection), connection.defaultModel ? `既定: ${connection.defaultModel}` : null, connection.baseUrl].filter(Boolean).join(' · ');
    const result = make('p', '', 'meta'); result.setAttribute('role', 'status');
    const privacy = make('p', privacyLabel(connection.kind, { baseUrl: connection.baseUrl }), 'meta byok-privacy');
    const test = make('button', '接続を試す', 'btn btn-secondary'); test.type = 'button';
    const edit = make('button', '編集', 'btn btn-secondary'); edit.type = 'button';
    const remove = make('button', '削除', 'deny btn btn-ghost'); remove.type = 'button';
    const buttons = make('div', undefined, 'actions'); buttons.append(test, edit, remove);
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try { await invoke('byok_set_enabled', { id: connection.id, enabled: toggle.checked }); notice.textContent = ''; }
      catch (error) { toggle.checked = !toggle.checked; notice.textContent = errorText(error); }
      finally { toggle.disabled = false; }
    });
    test.addEventListener('click', async () => {
      test.disabled = true; result.textContent = '確認しています…';
      try {
        const outcome = await invoke('byok_test', { id: connection.id });
        result.textContent = outcome?.ok ? (outcome.modelCount ? `接続できました（モデル ${outcome.modelCount}件）。` : '接続できました。') : errorText(outcome?.code);
      } catch (error) { result.textContent = errorText(error); }
      finally { test.disabled = false; }
    });
    edit.addEventListener('click', () => openForm(connection));
    remove.addEventListener('click', () => confirmInline(document, confirmHost, {
      message: `「${connection.name}」を削除します。保存したAPIキーもこの端末から消えます。`, yes: '削除する',
      onYes: async () => { try { await invoke('byok_remove', { id: connection.id }); await refresh(); } catch (error) { notice.textContent = errorText(error); } },
    }));
    const phone = remoteSwitch('api', connection.id, connection.name, connection.remoteAllowed, connection.enabled);
    toggle.addEventListener('change', () => { phone.box.disabled = !toggle.checked; if (!toggle.checked) phone.box.checked = false; });
    item.append(head, detail, privacy, phone.wrap, result, buttons);
    return item;
  }

  function cliRow(info) {
    const item = make('div', undefined, 'byok-row');
    const head = make('div', undefined, 'byok-row-head');
    const label = make('label', undefined, 'check settings-row');
    const toggle = make('input'); toggle.type = 'checkbox'; toggle.checked = info.enabled && info.state !== 'not_installed';
    toggle.disabled = info.state === 'not_installed'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', `${info.label}を使う`);
    label.append(toggle, make('strong', info.label));
    head.append(label, make('span', CLI_STATE_TEXT[info.state] ?? CLI_STATE_TEXT.unknown, `meta byok-state is-${info.state}`));
    const models = make('input'); models.type = 'text'; models.maxLength = 64; models.autocomplete = 'off'; models.spellcheck = false;
    models.value = info.defaultModel ?? ''; models.placeholder = 'CLIの既定'; models.disabled = info.state === 'not_installed';
    const datalist = make('datalist'); datalist.id = `byok-cli-models-${info.id}`; models.setAttribute('list', datalist.id);
    for (const m of info.suggestedModels ?? []) { const o = make('option'); o.value = m; datalist.append(o); }
    const modelLabel = make('label', undefined, 'settings-field'); modelLabel.append(make('span', '既定のモデル（任意）'), models, datalist);
    const state = make('p', '', 'meta'); state.setAttribute('role', 'status');
    const persist = async () => {
      state.textContent = '';
      try { await invoke('byok_cli_set', { id: info.id, enabled: toggle.checked, defaultModel: models.value.trim() || null }); }
      catch (error) { state.textContent = errorText(error); }
    };
    const usable = info.enabled && info.state !== 'not_installed';
    const phone = remoteSwitch('cli', info.id, info.label, info.remoteAllowed, usable);
    if (info.state === 'logged_in' || info.state === 'unknown') phone.wrap.append(make('span', 'CLIはファイルを書き換えない設定で、専用の空のフォルダから動きます。', 'meta'));
    toggle.addEventListener('change', () => { phone.box.disabled = !toggle.checked; if (!toggle.checked) phone.box.checked = false; });
    toggle.addEventListener('change', persist);
    models.addEventListener('change', persist);
    item.append(head, modelLabel, phone.wrap, state);
    if (info.state === 'not_logged_in') item.append(make('p', 'ターミナルでこのCLIを起動してログインすると、使えるようになります。', 'meta'));
    if (info.state === 'not_installed') item.append(make('p', 'このPCでは見つかりませんでした。', 'meta'));
    return item;
  }

  async function refresh() {
    try {
      const data = await invoke('byok_list', {});
      connections = Array.isArray(data?.connections) ? data.connections : [];
      list.replaceChildren(...(connections.length ? connections.map(row) : [make('p', 'まだ接続がありません。', 'meta')]));
      cliList.replaceChildren(...(Array.isArray(data?.cli) ? data.cli.map(cliRow) : []));
    } catch (error) {
      list.replaceChildren(make('p', errorText(error), 'meta'));
    }
    await routing.refresh();
  }
  syncForm();
  return { element, refresh };
}
