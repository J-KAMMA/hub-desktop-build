// "AIの接続" for AI work (Pi). The window only ever sees connection ids, names and default
// models from `pi_work_connections`; Rust reads the key at start and hands it to that run's
// sidecar. The run's model value is `byok:<id>/<model>` (empty model: the connection's default).

const ID = /^[0-9a-f-]{36}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;

export const CONNECTION_NOTE = '利用料金はAI事業者からご自身のアカウントへ直接請求されます。キーはこのPCの資格情報ストアから、この作業の間だけ読み出します。';

/** Only well-formed entries from the backend list; the default model is display data. */
export function connectionChoices(list) {
  return (Array.isArray(list) ? list : []).flatMap((entry) => {
    if (!entry || typeof entry.id !== 'string' || !ID.test(entry.id) || typeof entry.name !== 'string' || !entry.name.trim()) return [];
    const defaultModel = typeof entry.defaultModel === 'string' && MODEL.test(entry.defaultModel) ? entry.defaultModel : '';
    return [{ id: entry.id, name: entry.name.trim().slice(0, 60), defaultModel }];
  });
}

/** The model value for pi_work_start, or null when no connection is chosen. Throws for input Rust would refuse anyway. */
export function connectionModelRef(connectionId, model) {
  const id = String(connectionId ?? '').trim();
  if (!id) return null;
  if (!ID.test(id)) throw new Error('AIの接続を選び直してください');
  const chosen = String(model ?? '').trim();
  if (chosen && (!MODEL.test(chosen) || chosen.includes('..'))) throw new Error('モデル名に使えない文字があります');
  return `byok:${id}/${chosen}`;
}

/** Fills the connection picker. Keeps the current choice when it is still listed. */
export function renderConnectionPicker({ select, modelInput, note }, choices) {
  const previous = select.value;
  const doc = select.ownerDocument;
  const none = doc.createElement('option');
  none.value = ''; none.textContent = '使わない（上のモデル欄）';
  const options = [none, ...choices.map((choice) => {
    const option = doc.createElement('option');
    option.value = choice.id; option.textContent = choice.name;
    option.dataset.defaultModel = choice.defaultModel;
    return option;
  })];
  select.replaceChildren(...options);
  select.value = choices.some((choice) => choice.id === previous) ? previous : '';
  syncConnectionModel({ select, modelInput, note });
}

/** The model field shows the connection's default model as its placeholder. */
export function syncConnectionModel({ select, modelInput, note }) {
  const option = select.selectedOptions?.[0];
  const chosen = Boolean(select.value);
  modelInput.disabled = !chosen;
  modelInput.placeholder = chosen ? (option?.dataset.defaultModel || 'モデル名（必須）') : '';
  if (!chosen) modelInput.value = '';
  if (note) note.hidden = !chosen;
}
