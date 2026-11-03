import { pendingActionsOf, piWorkStatusLabel } from './pi-work.mjs';

const text = (value) => typeof value === 'string' ? value : '';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const labels = { running: '実行中', done: '返答終了', failed: '失敗', cancelled: '中断' };
function workspace(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return { key: 'unknown:', path: '作業フォルダ不明', name: '作業フォルダ不明' };
  try { encodeURIComponent(value); } catch { return { key: 'unknown:', path: '作業フォルダ不明', name: '作業フォルダ不明' }; }
  // Windows の正規化パスは `\\?\C:\…`（UNC は `\\?\UNC\server\…`）で記録されることがある。同じフォルダを2つに分けない。
  const verbatim = /^[\\/]{2}\?[\\/]/.test(value) ? value.slice(4).replace(/^UNC[\\/]/i, '\\\\') : value;
  const windows = /^[a-z]:/i.test(verbatim) || /^[\\/]{2}/.test(verbatim);
  const slashes = windows ? verbatim.replace(/\\/g, '/') : verbatim;
  const normalized = windows && /^[a-z]:\/$/i.test(slashes) ? slashes : slashes.replace(/\/+$/g, '') || '/';
  const key = `${windows ? 'windows' : 'posix'}:${windows ? normalized.toLowerCase() : normalized}`;
  const name = normalized.split('/').filter(Boolean).at(-1) || value;
  return { key, path: verbatim, name };
}
function status(entry) {
  const { kind, run } = entry;
  const label = kind === 'hub' ? text(piWorkStatusLabel(text(run.status) || null, run.verification)) || '不明' : Object.hasOwn(labels, text(run.status)) ? labels[run.status] : '不明';
  const count = kind === 'hub' ? pendingActionsOf(run).length : 0;
  return { label: kind === 'hub' ? `${label}${count ? ` · 承認待ち ${count}件` : ''}` : ['CLI', label, text(run.agent)].filter(Boolean).join(' · '), priority: count ? 0 : run.status === 'running' ? 1 : 2 };
}
function date(value) {
  const started = new Date(Number.isFinite(value) ? value : NaN);
  return Number.isNaN(started.getTime()) ? null : started;
}
// Dot tone: running -> action, approval -> warning, done/verified -> positive, failed -> danger, cancelled/unknown -> muted.
function tone(entry) {
  if (entry.kind === 'hub' && pendingActionsOf(entry.run).length) return 'approval';
  return { running: 'running', done: 'done', failed: 'failed' }[text(entry.run.status)] ?? 'muted';
}
function when(started, now) {
  if (!started) return '';
  const day = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = now.getTime() - started.getTime(), days = Math.round((day(now) - day(started)) / 864e5);
  if (diff >= -6e4 && diff < 3e5) return '今';
  if (days === 0) return `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`;
  return days === 1 ? '昨日' : `${started.getMonth() + 1}/${started.getDate()}`;
}
const VISIBLE_ROWS = 5;

// groupBy: 'date' は会話の一覧の型（今日 / 過去7日 / それ以前）。既定の 'folder' は作業フォルダごと。
const DATE_GROUPS = [['today', '今日'], ['week', '過去7日'], ['older', 'それ以前']];
function dateBucket(started, now) {
  if (!started) return 'older';
  const day = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(started)) / 864e5);
  return days <= 0 ? 'today' : days <= 7 ? 'week' : 'older';
}
export function renderPiWorkHistory({ document, entries, query = '', selectedId = null, busy = false, onSelect, onDelete = null, openGroups = new Map(), now = new Date(), groupBy = 'folder' }) {
  const all = (Array.isArray(entries) ? entries : []).filter((entry) => object(entry) && ['hub', 'cli'].includes(entry.kind) && object(entry.run) && text(entry.run.id).trim().length > 0);
  const search = text(query).trim().toLocaleLowerCase();
  const groups = new Map();
  for (const [index, entry] of all.entries()) {
    const run = entry.run, place = workspace(run.workspace), state = status(entry);
    if (search && ![run.prompt, run.workspace, run.model, run.agent, run.status, state.label].some((value) => text(value).toLocaleLowerCase().includes(search))) continue;
    const started = date(run.startedAtMs);
    const bucket = groupBy === 'date' ? dateBucket(started, now) : null;
    const target = bucket ? { key: `date:${bucket}`, path: DATE_GROUPS.find(([key]) => key === bucket)[1], name: DATE_GROUPS.find(([key]) => key === bucket)[1], order: DATE_GROUPS.findIndex(([key]) => key === bucket) } : place;
    if (!groups.has(target.key)) groups.set(target.key, { ...target, rows: [] });
    groups.get(target.key).rows.push({ entry, state, index, started, folder: place.path });
  }
  if (groupBy === 'date') {
    const ordered = [...groups.entries()].sort((a, b) => a[1].order - b[1].order);
    groups.clear();
    for (const [key, value] of ordered) groups.set(key, value);
  }
  const nodes = [];
  // 同じ名前のフォルダが複数あるときは、親フォルダ名を添えて見分けられるようにする。
  const nameCount = new Map();
  for (const group of groups.values()) nameCount.set(group.name, (nameCount.get(group.name) ?? 0) + 1);
  const parentOf = path => { const parts = text(path).split(/[\\/]+/).filter(Boolean); return parts.length > 1 ? parts.at(-2) : ''; };
  for (const group of groups.values()) {
    const details = document.createElement('details');
    details.className = 'piw-history-project';
    details.dataset.workspaceKey = group.key;
    const selected = selectedId !== null && group.rows.some(({ entry }) => entry.kind === 'hub' && entry.run.id === selectedId);
    const attention = group.rows.some(({ state }) => state.priority < 2);
    details.open = Boolean(search) || (openGroups.has(group.key) ? Boolean(openGroups.get(group.key)) : selected || attention || nodes.length === 0 || (groupBy === 'date' && group.key !== 'date:older'));
    const heading = document.createElement('summary');
    heading.className = 'piw-history-project-head'; heading.title = group.path;
    const name = document.createElement('span');
    name.className = 'piw-history-project-name'; name.textContent = group.name;
    const count = document.createElement('span');
    count.className = 'piw-history-count'; count.textContent = String(group.rows.length);
    heading.append(name);
    if (nameCount.get(group.name) > 1 && parentOf(group.path)) {
      const parent = document.createElement('span');
      parent.className = 'piw-history-project-parent'; parent.textContent = parentOf(group.path);
      heading.append(parent);
    }
    heading.append(count); details.append(heading);
    let lastOpen = details.open;
    details.addEventListener('toggle', () => { if (!search && details.open !== lastOpen) openGroups.set(group.key, details.open); lastOpen = details.open; });
    const ordered = [...group.rows].sort((a, b) => a.state.priority - b.state.priority || (b.started?.getTime() ?? -Infinity) - (a.started?.getTime() ?? -Infinity) || a.index - b.index);
    const moreKey = `more:${group.key}`;
    const forced = Boolean(search) || ordered.slice(VISIBLE_ROWS).some(({ entry }) => entry.kind === 'hub' && entry.run.id === selectedId);
    const rows = [];
    for (const { entry, state, started, folder } of ordered) {
      const run = entry.run, button = document.createElement('button');
      button.type = 'button'; button.className = 'piw-history-item'; button.disabled = Boolean(busy);
      button.dataset.kind = entry.kind; button.dataset.runId = text(run.id);
      const prompt = text(run.prompt).trim().replace(/\s+/g, ' ') || '無題の実行';
      button.title = [text(run.prompt) || '無題の実行', groupBy === 'date' ? folder : '', state.label, started ? started.toLocaleString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '日時不明', text(run.model)].filter(Boolean).join('\n');
      if (entry.kind === 'hub' && selectedId !== null && run.id === selectedId) button.setAttribute('aria-current', 'true');
      const dot = document.createElement('span');
      dot.className = 'piw-history-dot'; dot.dataset.tone = tone(entry); dot.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'piw-history-title'; title.textContent = prompt;
      const time = document.createElement('span');
      time.className = 'piw-history-time'; time.textContent = when(started, now);
      button.append(dot, title, time);
      button.onclick = () => { if (!button.disabled && typeof onSelect === 'function') onSelect(entry); };
      rows.push(button); details.append(button);
      // 選んでいる作業の下にだけ出す。1回目で確認に変わり、2回目で消す。実行中は消せない。
      if (typeof onDelete === 'function' && entry.kind === 'hub' && selectedId !== null && run.id === selectedId && text(run.status) !== 'running' && !pendingActionsOf(run).length) {
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'piw-history-delete'; remove.disabled = Boolean(busy);
        remove.textContent = 'この作業記録を削除';
        let armed = false;
        remove.onclick = () => {
          if (remove.disabled) return;
          if (!armed) { armed = true; remove.textContent = '本当に削除する'; remove.dataset.armed = 'true'; return; }
          remove.disabled = true; onDelete(entry);
        };
        details.append(remove);
      }
    }
    if (rows.length > VISIBLE_ROWS && !forced) {
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'piw-history-more';
      const apply = () => {
        const open = Boolean(openGroups.get(moreKey));
        rows.forEach((row, i) => { row.hidden = !open && i >= VISIBLE_ROWS; });
        more.textContent = open ? 'たたむ' : `残り ${rows.length - VISIBLE_ROWS} 件を表示`; more.setAttribute('aria-expanded', String(open));
      };
      more.onclick = () => { openGroups.set(moreKey, !openGroups.get(moreKey)); apply(); };
      apply(); details.append(more);
    }
    nodes.push(details);
  }
  if (!nodes.length) {
    const empty = document.createElement('p'); empty.className = 'meta'; empty.textContent = all.length ? '該当する作業はありません' : '作業履歴はまだありません'; nodes.push(empty);
  }
  return nodes;
}
