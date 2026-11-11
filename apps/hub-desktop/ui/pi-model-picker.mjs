const modelId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\u0000-\u001f\u007f-\u009f<>"'`\\]/u.test(value);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
function catalog(value) {
  if (!record(value) || !Array.isArray(value.models) || value.models.length > 4096 || value.models.some(model => !modelId(model))
    || value.default !== undefined && !modelId(value.default)
    || value.ready !== undefined && (!Array.isArray(value.ready) || value.ready.length > 4096 || value.ready.some(model => !modelId(model)))) throw Error('invalid_models');
  const models = [...new Set(value.models)], ready = value.ready === undefined ? null : new Set(value.ready), locations = new Map();
  if (ready && [...ready].some(model => !models.includes(model))) throw Error('invalid_models');
  if (value.locations !== undefined && value.locations !== null) {
    if (!record(value.locations) || Object.keys(value.locations).length > 4096) throw Error('invalid_models');
    for (const [model, location] of Object.entries(value.locations)) {
      if (!modelId(model) || !['local', 'api', 'cli'].includes(location)) throw Error('invalid_models');
      locations.set(model, location);
    }
  }
  return { models, ready, locations, defaultModel: value.default ?? null };
}

// Popover wiring shared by the model and permission chips: click toggles, an outside press or Escape closes.
export function bindPopover(document, { trigger, panel, onOpen, canOpen = () => true }) {
  const set = open => {
    if (open === !panel.hidden || open && !canOpen()) return;
    panel.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
    if (open) onOpen?.();
  };
  const toggle = () => set(panel.hidden);
  const outside = event => { if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) set(false); };
  const escape = event => { if (event.key === 'Escape' && !panel.hidden) { set(false); trigger.focus(); } };
  trigger.addEventListener('click', toggle); document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape);
  return { open: () => set(true), close: () => set(false), isOpen: () => !panel.hidden,
    destroy() { trigger.removeEventListener('click', toggle); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); } };
}

const providerOf = model => model.includes('/') ? model.slice(0, model.indexOf('/')) : 'その他';

export function createPiModelPicker(document, { input, list, refreshButton, status, invoke, ui = null, groupOf = () => null, privacyOf = () => null, market = null, isCurrent = () => true, getContext = () => ({ engine: 'pi', key: 'pi' }) }) {
  let pending = null, destroyed = false, generation = 0, shown = null;
  const popover = ui ? bindPopover(document, { trigger: ui.chip, panel: ui.popover, onOpen: () => { ui.search.value = ''; renderOptions(); ui.search.focus(); } }) : null;
  const syncChip = () => { if (ui) ui.chipLabel.textContent = input.value.trim() || shown?.defaultModel || '既定のモデル'; };
  const pick = model => {
    input.value = model; input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
    syncChip(); renderOptions(); popover.close(); ui.chip.focus();
  };
  // AI market (docs/hub-ai-market/DESIGN.md): listed endpoints next to the BYOK and local models, with filters.
  // Picking one first shows the disclosure; nothing is selected unless the user agrees.
  function marketNodes(query) {
    const rows = market.rows(query), active = market.filters();
    const wrap = document.createElement("div"); wrap.className = "piw-model-group"; wrap.setAttribute("role", "group"); wrap.setAttribute("aria-label", "市場");
    const heading = document.createElement("p"); heading.className = "piw-model-group-name"; heading.textContent = "市場（他社の窓口）";
    const bar = document.createElement("div"); bar.className = "piw-model-filters";
    for (const [key, label] of Object.entries(market.filterLabels)) {
      const button = document.createElement("button"); button.type = "button"; button.className = "piw-model-filter"; button.textContent = label;
      button.setAttribute("aria-pressed", String(active.includes(key))); button.dataset.filter = key;
      button.onclick = () => { market.toggle(key); renderOptions(); }; bar.append(button);
    }
    wrap.append(heading, bar);
    for (const entry of rows) {
      const node = document.createElement("button"); node.type = "button"; node.className = "piw-model-option"; node.setAttribute("role", "option");
      node.setAttribute("aria-selected", String(input.value.trim() === entry.ref)); node.dataset.model = entry.ref; node.title = entry.ref;
      const name = document.createElement("span"); name.textContent = entry.label; const small = document.createElement("small"); small.textContent = entry.group + " · " + entry.detail;
      node.append(name, small);
      node.onclick = async () => { if (await market.confirmUse(entry.listing) === true) pick(entry.ref); };
      wrap.append(node);
    }
    return [wrap];
  }
  function renderOptions() {
    if (!ui) return;
    const query = ui.search.value.trim().toLowerCase(), groups = new Map(), nodes = [];
    const row = (model, label, detail) => {
      const node = document.createElement('button'); node.type = 'button'; node.className = 'piw-model-option'; node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', String(input.value.trim() === model)); node.dataset.model = model; node.title = model || label;
      const name = document.createElement('span'); name.textContent = label; node.append(name);
      if (detail) { const small = document.createElement('small'); small.textContent = detail; node.append(small); node.title = `${model || label}\n${detail}`; }
      node.onclick = () => pick(model); return node;
    };
    if (!query) nodes.push(row('', shown?.defaultModel ? `既定（${shown.defaultModel}）` : '既定のモデル', ''));
    for (const model of shown?.ordered ?? []) if (!query || model.toLowerCase().includes(query)) {
      const key = groupOf(model) ?? providerOf(model); if (!groups.has(key)) groups.set(key, []);
      const place = shown.locations.get(model), where = place === 'local' ? 'ローカル' : place === 'api' ? 'API' : place === 'cli' ? 'CLI' : '場所未確認';
      groups.get(key).push(row(model, model.endsWith('/default') ? '既定' : model.includes('/') ? model.slice(model.indexOf('/') + 1) : model, [where, shown.ready === null ? '認証状態未確認' : shown.ready.has(model) ? '利用可能' : '要認証', privacyOf(model)].filter(Boolean).join(' · ')));
    }
    for (const [name, rows] of groups) {
      const group = document.createElement('div'); group.className = 'piw-model-group'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', name);
      const heading = document.createElement('p'); heading.className = 'piw-model-group-name'; heading.textContent = name; group.append(heading, ...rows); nodes.push(group);
    }
    if (market) nodes.push(...marketNodes(query));
    if (query && !groups.size && !market?.rows(query).length) { const none = document.createElement('p'); none.className = 'meta'; none.textContent = '該当するモデルはありません'; nodes.push(none); }
    ui.options.replaceChildren(...nodes);
  }
  if (ui) { ui.search.addEventListener('input', renderOptions); input.addEventListener('input', syncChip); syncChip(); }
  const initialPlaceholder = input.placeholder, initialTitle = input.title;
  const context = () => {
    const value = getContext();
    if (!record(value) || !['pi', 'dsh'].includes(value.engine) || typeof value.key !== 'string' || value.key.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.key)) throw Error('invalid_context');
    return { engine: value.engine, key: value.key };
  };
  const sameContext = captured => { try { const next = context(); return next.engine === captured.engine && next.key === captured.key; } catch { return false; } };
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  function otherEngine() {
    generation++; list.replaceChildren(); input.placeholder = initialPlaceholder; input.title = initialTitle;
    refreshButton.disabled = true; status.textContent = 'この実行のモデルは自由入力で指定してください。Piのモデル候補は表示しません。';
  }
  function apply(body) {
    const ordered = [...body.models].sort((left, right) => Number(body.ready?.has(right)) - Number(body.ready?.has(left)) || left.localeCompare(right));
    const option = (model, manual = false) => {
      const node = document.createElement('option'); node.value = model;
      const place = body.locations.get(model), location = place === 'local' ? 'ローカル' : place === 'api' ? 'API' : place === 'cli' ? 'CLI' : '場所未確認';
      const availability = manual || body.ready === null ? '認証状態未確認' : body.ready.has(model) ? '利用可能' : '要認証';
      node.label = `${model} · ${location} · ${availability}`; node.textContent = node.label; return node;
    };
    const nodes = ordered.map(model => option(model));
    // Datalist replacement never assigns input.value: current typing and resumed models survive.
    if (modelId(input.value) && !body.models.includes(input.value)) nodes.push(option(input.value, true));
    list.replaceChildren(...nodes);
    shown = { ordered, locations: body.locations, ready: body.ready, defaultModel: body.defaultModel }; syncChip(); renderOptions();
    input.placeholder = body.defaultModel ? `既定: ${body.defaultModel}` : initialPlaceholder;
    input.title = body.defaultModel ? `空欄なら ${body.defaultModel} を使用` : '空欄なら既定のモデルを使用';
    status.textContent = `${body.models.length}件のモデル${body.ready === null ? ' · 認証状態未確認' : ` · 利用可能 ${body.ready.size}件`}${body.defaultModel ? ` · 既定: ${body.defaultModel}` : ''}${body.models.length ? '' : ' · モデル名は自由入力できます。'}`;
  }
  function refresh(force = true) {
    if (destroyed || !isCurrent()) return Promise.resolve();
    let captured;
    try { captured = context(); } catch { status.textContent = 'モデルの実行環境を確認できません。'; return Promise.resolve(); }
    if (captured.engine !== 'pi') { otherEngine(); return Promise.resolve(); }
    if (pending) return pending;
    const turn = ++generation;
    refreshButton.disabled = true; status.textContent = 'モデルを再検出しています…'; list.setAttribute('aria-busy', 'true');
    pending = Promise.resolve().then(() => !destroyed && isCurrent() && sameContext(captured) ? invoke('pi_work_models', { refresh: force === true }) : undefined).then(value => {
      if (destroyed || turn !== generation || !isCurrent() || !sameContext(captured)) return;
      apply(catalog(value));
    }).catch(() => {
      if (!destroyed && turn === generation && isCurrent() && sameContext(captured)) status.textContent = 'モデルを再検出できませんでした。一覧と入力を保持しています。更新して再試行してください。';
    }).finally(() => {
      pending = null;
      if (destroyed) return;
      list.setAttribute('aria-busy', 'false');
      let next;
      try { next = context(); } catch { list.replaceChildren(); status.textContent = 'モデルの実行環境を確認できません。'; refreshButton.disabled = false; return; }
      if (next.engine !== 'pi') { otherEngine(); return; }
      refreshButton.disabled = false;
      if (turn !== generation || !isCurrent() || !sameContext(captured)) {
        list.replaceChildren(); input.placeholder = initialPlaceholder; input.title = initialTitle; status.textContent = 'モデル一覧を再検出してください。';
      }
    });
    return pending;
  }
  const clicked = () => { void refresh(true); };
  refreshButton.addEventListener('click', clicked);
  const ready = refresh(false);
  return { refresh, ready, sync: syncChip, destroy() { if (destroyed) return; destroyed = true; popover?.destroy(); generation++; refreshButton.removeEventListener('click', clicked); list.setAttribute('aria-busy', 'false'); refreshButton.disabled = false; } };
}
