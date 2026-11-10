// AI画面の「中断」と「会話の要約」。表示だけを受け持つ。
// 中断した作業の再実行は、利用者が「再実行」を押したときだけ既存の再開経路（resumeRunId）で始める。
// 承認待ちは承認の操作を持たない：再開すると通常の承認画面として戻る。自動承認はしない。
const text = (value) => typeof value === 'string' ? value : '';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const calls = (value) => (Array.isArray(value) ? value : []).filter(object).map((call) => ({ callId: text(call.callId), name: text(call.name) || 'tool', detail: text(call.detail) }));

/** pi_work_interrupted の戻りを runId で引ける形にする。形の違うものは捨てる。 */
export function normalizeInterrupted(list) {
  const items = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!object(raw) || !text(raw.runId).trim()) continue;
    const approvals = (Array.isArray(raw.pendingApprovals) ? raw.pendingApprovals : []).filter(object)
      .map((a) => ({ id: text(a.id), tool: text(a.tool) || 'tool', summary: text(a.summary) }));
    items.set(raw.runId, { runId: raw.runId, workspace: text(raw.workspace), retry: calls(raw.retryAutomatically), interrupted: calls(raw.interrupted), approvals });
  }
  return items;
}

const ICONS = {
  compact: 'M5 8h14M8 12h8M10.5 16h3',
  pause: 'M8 5v14M16 5v14',
  rerun: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
};
function icon(document, name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'piw-note-icon');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]); svg.append(path);
  return svg;
}

/** 会話を要約したことを示す1行。要約中・要約済み・できなかったときだけ。回数は出さない。 */
export function compactionNote(document, compaction) {
  if (!object(compaction) || !['running', 'done', 'failed'].includes(compaction.phase) || !text(compaction.line).trim()) return null;
  const note = document.createElement('p');
  note.className = 'piw-compaction'; note.dataset.phase = compaction.phase;
  note.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.textContent = compaction.line;
  note.append(icon(document, 'compact'), label);
  return note;
}

/**
 * 中断した作業の小さな一覧。自動で再実行してよい読み取りは再実行の対象に数えるが、
 * 副作用のある呼び出しは「再実行」を押すまで動かさない。承認待ちは名前だけ見せる。
 */
export function interruptedPanel({ document, item, busy = false, onRerun, onDismiss }) {
  if (!object(item)) return null;
  const rows = [
    ...item.interrupted.map((call) => ({ ...call, kind: 'interrupted' })),
    ...item.retry.map((call) => ({ ...call, kind: 'retry' })),
    ...item.approvals.map((call) => ({ name: call.tool, detail: call.summary, kind: 'approval' })),
  ];
  const panel = document.createElement('section');
  panel.className = 'piw-interrupted'; panel.dataset.runId = item.runId;
  panel.setAttribute('aria-label', '中断した作業');
  const head = document.createElement('p');
  head.className = 'piw-interrupted-head';
  const badge = document.createElement('span');
  badge.className = 'piw-badge'; badge.textContent = '中断';
  head.append(icon(document, 'pause'), badge);
  panel.append(head);
  if (rows.length) {
    const list = document.createElement('ul');
    list.className = 'piw-interrupted-list';
    for (const row of rows) {
      const li = document.createElement('li');
      li.dataset.kind = row.kind;
      const name = document.createElement('code'); name.textContent = row.name;
      const detail = document.createElement('span'); detail.className = 'piw-trace-detail'; detail.textContent = row.detail;
      li.append(name, detail);
      if (row.kind === 'approval') { const wait = document.createElement('small'); wait.textContent = '承認待ち'; li.append(wait); }
      list.append(li);
    }
    panel.append(list);
  }
  const bar = document.createElement('div');
  bar.className = 'piw-interrupted-actions';
  const rerun = document.createElement('button');
  rerun.type = 'button'; rerun.className = 'btn btn-secondary piw-interrupted-rerun'; rerun.disabled = Boolean(busy);
  rerun.setAttribute('aria-label', '再実行');
  rerun.append(icon(document, 'rerun'), document.createTextNode('再実行'));
  rerun.onclick = () => { if (!rerun.disabled && typeof onRerun === 'function') onRerun(item); };
  const dismiss = document.createElement('button');
  dismiss.type = 'button'; dismiss.className = 'btn btn-secondary piw-interrupted-dismiss'; dismiss.disabled = Boolean(busy);
  dismiss.textContent = '閉じる'; dismiss.setAttribute('aria-label', '閉じる');
  dismiss.onclick = () => { if (!dismiss.disabled && typeof onDismiss === 'function') onDismiss(item); };
  bar.append(rerun, dismiss);
  panel.append(bar);
  return panel;
}
