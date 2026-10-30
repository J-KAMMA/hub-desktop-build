// 設定 → AIの接続の下に置く「代替先と用途別の振り分け」。保存するのは参照の順序だけ（キー・会話は扱わない）。
import { settingHeader } from './settings-view.mjs';
import { TASKS, TASK_LABEL, loadRules, saveRules, normalizeRules, cleanChain, MAX_CHAIN } from './ai-routing.mjs';
import { apiRef, cliRef, parseRef } from './byok-chat.mjs';

export function createAiRoutingPanel({ document, invoke, storage }) {
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const element = make('div', undefined, 'card byok-routing');
  element.append(settingHeader(document, {
    label: '代替先と用途別の振り分け',
    desc: '先頭のAIが使えないとき（混雑・時間切れ・残高不足など）、最初の文字が出る前だけ、次のAIに自動で切り替えます。文字が出始めたあとは切り替えません。安全基準による断りは、下で許したときだけ次へ回します。順序はこの端末にだけ保存します。',
    keywords: '代替 フォールバック 振り分け 用途 順序 ルーティング',
  }));
  const state = make('p', '', 'meta'); state.setAttribute('role', 'status');
  const refuse = make('label', undefined, 'check settings-row');
  const refuseBox = make('input'); refuseBox.type = 'checkbox'; refuseBox.setAttribute('role', 'switch');
  refuse.append(refuseBox, make('span', 'AIが安全基準で断ったときも、次のAIに回す'));
  const host = make('div', undefined, 'byok-routing-lists');
  element.append(refuse, host, state);

  let rules = loadRules(storage), options = new Map(); // ref → 表示名
  const persist = () => { state.textContent = saveRules(storage, rules) ? '' : 'この端末に保存できませんでした。'; };
  const nameOf = (ref) => options.get(ref) ?? `${ref}（現在は使えません）`;

  function editor(title, get, set) {
    const box = make('div', undefined, 'byok-routing-list');
    box.append(make('strong', title));
    const ol = make('ol', undefined, 'byok-routing-items');
    const chain = get();
    chain.forEach((ref, i) => {
      const li = make('li', undefined, 'settings-row');
      li.append(make('span', nameOf(ref)));
      const mk = (text, label, fn, off) => { const b = make('button', text, 'btn btn-ghost'); b.type = 'button'; b.setAttribute('aria-label', `${nameOf(ref)}を${label}`); b.disabled = off; b.addEventListener('click', fn); return b; };
      const move = (d) => () => { const c = [...get()]; [c[i], c[i + d]] = [c[i + d], c[i]]; set(c); render(); };
      li.append(mk('↑', '上へ', move(-1), i === 0), mk('↓', '下へ', move(1), i === chain.length - 1),
        mk('外す', '外す', () => { set(get().filter((r) => r !== ref)); render(); }, false));
      ol.append(li);
    });
    if (!chain.length) ol.append(make('li', '未設定', 'meta'));
    const pick = make('select'); pick.setAttribute('aria-label', `${title}に追加するAI`);
    const first = make('option', '追加するAIを選ぶ'); first.value = ''; pick.append(first);
    for (const [ref, name] of options) if (!chain.includes(ref)) { const o = make('option', name); o.value = ref; pick.append(o); }
    pick.disabled = chain.length >= MAX_CHAIN;
    pick.addEventListener('change', () => { if (pick.value) { set(cleanChain([...get(), pick.value])); render(); } });
    box.append(ol, pick);
    return box;
  }

  function render() {
    refuseBox.checked = rules.refusalFallback;
    const nodes = [editor('既定の順序', () => rules.chain, (c) => { rules = normalizeRules({ ...rules, chain: c }); persist(); })];
    for (const task of TASKS) {
      nodes.push(editor(`${TASK_LABEL[task]}（未設定なら既定の順序）`, () => rules.tasks[task] ?? [],
        (c) => { rules = normalizeRules({ ...rules, tasks: { ...rules.tasks, [task]: c } }); persist(); }));
    }
    host.replaceChildren(...nodes);
  }
  refuseBox.addEventListener('change', () => { rules = normalizeRules({ ...rules, refusalFallback: refuseBox.checked }); persist(); });

  async function refresh() {
    rules = loadRules(storage); options = new Map();
    try {
      const data = await invoke('byok_models', {});
      for (const s of Array.isArray(data?.sources) ? data.sources : []) {
        const models = s.kind === 'cli' ? [null, ...(s.models ?? [])] : (s.models ?? []);
        for (const m of models) {
          const ref = s.kind === 'cli' ? cliRef(s.id, m) : apiRef(s.id, m);
          if (parseRef(ref)) options.set(ref, `${s.name}${s.kind === 'cli' ? '（CLI）' : ''} / ${m ?? '既定'}`);
        }
      }
    } catch { state.textContent = '接続の一覧を読み込めませんでした。'; }
    render();
  }
  render();
  return { element, refresh };
}
