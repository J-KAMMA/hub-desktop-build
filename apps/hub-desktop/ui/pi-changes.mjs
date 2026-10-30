const encoder = new TextEncoder();
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const wellFormed = value => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const control = /[\u0000-\u001f\u007f-\u009f]/;
const reasons = {
  invalid_record: '記録の形式が不正です。', body_limit: '本文の保存上限を超えました。', file_limit: '16ファイルの保存上限を超えました。',
  total_limit: '本文の合計保存上限を超えました。', path_alias: '同じファイルを別表記のパスで操作しました。',
  archive_invalid: '保存記録を検証できませんでした。', save_failed: '変更記録を保存できませんでした。', incomplete: '変更記録が一部不足しています。',
};
const states = { matches: '現在のファイルは保存された変更後と一致しています。', changed: '現在のファイルは保存された変更後から変わっています。', missing: '現在のファイルは見つかりません。', unavailable: '現在のファイルは確認できません。' };
const shape = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function pathAllowed(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && wellFormed(value) && encoder.encode(value).length <= 240 && !/[\\:]/.test(value) && !control.test(value) && value.split('/').every(part => {
    const name = part.toLowerCase();
    return part && !part.startsWith('.') && !/[. ]$/.test(part) && !['node_modules', 'target', 'credentials', 'secrets', 'id_rsa', 'id_ed25519'].includes(name) && !/\.(pem|key|p12|pfx|keystore|sqlite|db)$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(name);
  });
}
function snapshot(run) {
  if (run?.changes == null) return null;
  const value = run.changes;
  if (!uuid(run.id) || !shape(value, ['coverage', 'baseline', 'status', 'reason', 'untrackedCommands', 'items']) || value.coverage !== 'hub_file_tools' || value.baseline !== 'before_first_write' || !['tracked', 'incomplete', 'unavailable'].includes(value.status) || typeof value.untrackedCommands !== 'boolean' || !Array.isArray(value.items) || value.items.length > 16 || (value.status === 'incomplete' ? typeof value.reason !== 'string' || !Object.hasOwn(reasons, value.reason) : value.reason !== null) || value.status === 'unavailable' && value.items.length) throw Error('invalid_summary');
  const ids = new Set(), paths = new Set();
  const items = Array.from(value.items, item => {
    if (!shape(item, ['id', 'path', 'kind', 'beforeSha256', 'afterSha256', 'status']) || !uuid(item.id) || !pathAllowed(item.path) || !['created', 'modified'].includes(item.kind) || (item.kind === 'created' ? item.beforeSha256 !== null : !hash(item.beforeSha256)) || !hash(item.afterSha256) || !['available', 'external_gap'].includes(item.status) || ids.has(item.id) || paths.has(item.path.toLowerCase())) throw Error('invalid_item');
    ids.add(item.id); paths.add(item.path.toLowerCase()); return { ...item };
  });
  return { ...value, runId: run.id, items };
}
async function validateDiff(value, summary, item) {
  if (!shape(value, ['runId', 'changeId', 'path', 'before', 'after', 'beforeSha256', 'afterSha256', 'status', 'currentState', 'coverage', 'baseline']) || value.runId !== summary.runId || value.changeId !== item.id || value.path !== item.path || value.beforeSha256 !== item.beforeSha256 || value.afterSha256 !== item.afterSha256 || value.status !== item.status || value.coverage !== summary.coverage || value.baseline !== summary.baseline || typeof value.currentState !== 'string' || !Object.hasOwn(states, value.currentState)) throw Error('invalid_diff');
  const result = { ...value };
  const bodies = [result.before, result.after].map(text => {
    if (typeof text !== 'string' || text.length > 32768 || !wellFormed(text)) throw Error('invalid_body');
    const bytes = encoder.encode(text); if (bytes.length > 32768) throw Error('body_limit'); return bytes;
  });
  if (bodies[0].length + bodies[1].length > 1048576 || item.kind === 'created' && result.before !== '') throw Error('invalid_body');
  const digest = async bytes => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const hashes = await Promise.all([item.beforeSha256 === null ? null : digest(bodies[0]), digest(bodies[1])]);
  if (hashes[0] !== item.beforeSha256 || hashes[1] !== item.afterSha256) throw Error('hash_mismatch');
  return result;
}

export function createPiChanges({ document, run, invoke, isCurrent = () => true }) {
  const element = document.createElement('section'); element.className = 'piw-changes'; element.setAttribute('aria-label', 'Piの変更ファイル');
  const make = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const heading = make('h4', 'piw-changes-title', '変更したファイル'); element.append(heading);
  const note = make('p', 'piw-meta', '対象は成功したHubファイルツールの変更です。比較元はこの実行の最初の書込み直前です。コマンドによる変更は追跡しません。'); element.append(note);
  let destroyed = false, revision = 0; const listeners = [], pending = new Set();
  const current = () => !destroyed && isCurrent();
  const destroy = () => { if (destroyed) return; destroyed = true; revision++; for (const [button, listener] of listeners) button.removeEventListener('click', listener); element.replaceChildren(); element.remove(); };
  let summary;
  try { summary = snapshot(run); } catch { note.textContent = '変更記録の形式を確認できませんでした。'; note.setAttribute('role', 'alert'); return { element, destroy }; }
  if (!summary || summary.status === 'unavailable') { element.append(make('p', 'piw-meta', 'この実行の変更記録は利用できません。旧記録には変更本文がありません。')); return { element, destroy }; }
  heading.textContent = `変更したファイル ${summary.items.length}件`;
  if (summary.status === 'incomplete') element.append(make('p', 'piw-meta', `変更記録は不完全です。${reasons[summary.reason]}`));
  if (summary.untrackedCommands) element.append(make('p', 'piw-meta', 'この実行にはコマンドの実行が含まれています。その変更は未追跡です。'));
  if (!summary.items.length) { element.append(make('p', 'piw-meta', '記録された変更ファイルはありません。')); return { element, destroy }; }
  const list = make('div', 'piw-change-list'), diff = make('div', 'piw-change-diff'); diff.setAttribute('aria-live', 'polite'); element.append(list, diff);
  function display(result, item) {
    const before = result.before === '' ? [] : result.before.split('\n'), after = result.after === '' ? [] : result.after.split('\n');
    let prefix = 0, suffix = 0; const common = Math.min(before.length, after.length);
    while (prefix < common && before[prefix] === after[prefix]) prefix++;
    while (suffix < common - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
    const start = Math.max(0, prefix - 3), trailing = Math.max(0, suffix - 3);
    diff.replaceChildren(make('h4', 'piw-meta', item.path), make('p', 'piw-meta', `${states[result.currentState]} 以下は保存された変更前・変更後の比較です。`));
    if (result.status === 'external_gap') diff.append(make('p', 'piw-meta', '途中で外部の変更が入り、書込みの連続性を確認できません。'));
    if (result.before === result.after) diff.append(make('p', 'piw-meta', '保存された変更前と変更後の本文は同一です。'));
    diff.append(make('p', 'piw-meta', `未変更行を省略: 先頭 ${start} 行 / 末尾 ${trailing} 行。変更箇所の前後を最大3行表示します。`));
    for (const [label, lines, className, created] of [['変更前', before, 'piw-change-before', item.kind === 'created'], ['変更後', after, 'piw-change-after', false]]) {
      const section = make('section', className); section.append(make('h5', 'piw-meta', label));
      const content = created ? '新規ファイル（変更前なし）' : !lines.length ? '空ファイル' : lines.slice(start, lines.length - trailing).map((line, index) => `${start + index + 1} | ${line}`).join('\n');
      section.append(make('pre', 'dev-output', content)); diff.append(section);
    }
  }
  for (const item of summary.items) {
    const row = make('div', 'piw-meta piw-change-row'), button = make('button', 'head-action', item.path); button.type = 'button'; button.setAttribute('aria-label', `${item.path}の保存された差分を表示`);
    row.append(button, make('span', 'piw-meta', ` ${item.kind === 'created' ? '作成' : '変更'}${item.status === 'external_gap' ? ' · 外部変更あり' : ''}`)); list.append(row);
    const listener = async () => {
      if (!current() || pending.has(item.id)) return;
      const request = ++revision; pending.add(item.id); button.disabled = true; diff.replaceChildren(make('p', 'piw-meta', '差分を取得中…')); diff.setAttribute('aria-busy', 'true');
      try {
        const raw = await invoke('pi_work_diff', { runId: summary.runId, changeId: item.id });
        if (!current() || request !== revision) return;
        const result = await validateDiff(raw, summary, item);
        if (current() && request === revision) display(result, item);
      } catch {
        if (current() && request === revision) { const error = make('p', 'piw-meta', '差分を確認できませんでした。ファイルのボタンから再試行してください。'); error.setAttribute('role', 'alert'); diff.replaceChildren(error); }
      } finally {
        pending.delete(item.id); if (!destroyed) button.disabled = false;
        if (current() && request === revision) diff.setAttribute('aria-busy', 'false');
      }
    };
    button.addEventListener('click', listener); listeners.push([button, listener]);
  }
  return { element, destroy };
}

export {snapshot as validatePiChangeSnapshot, validateDiff as validatePiChangeDiff};
