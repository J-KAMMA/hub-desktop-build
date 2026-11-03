// 研究のプロジェクト一覧の行と、静かな空の状態・骨組み（2026-11-02、デザイン規約 §3 の Row / States / Badges）。
// 行は箱にしない：全幅、下に 1px の線、名前 15/700、概要 15、メタ 13 muted、状態は札（20px・角 4・線のみ）。
// DOM は従来の .research-project-card（button）を保つので、既存の検査と呼び出しはそのまま通る。

const VISIBILITY = { public: '公開', confidential: '機密', restricted: '限定', embargoed: '公開猶予', controlled: '申請制' };
const STATUS = { draft: '準備中', active: '進行中', paused: '中断中', completed: '完了', withdrawn: '撤回済み' };
export const visibilityLabel = value => VISIBILITY[value] ?? '';
export const statusLabel = value => STATUS[value] ?? '';

function el(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** 札（鍵つき・限定・進行中など）。塗りは使わない。空の文字なら null。 */
export function statusBadge(document, text) {
  return text ? el(document, 'span', 'research-badge', text) : null;
}

/** 札の並び。公開は既定なので札にしない（公開でないときだけ「機密」「限定」…を出す）。 */
export function projectBadges(document, project) {
  const items = [];
  if (project?.visibility && project.visibility !== 'public') items.push(statusBadge(document, visibilityLabel(project.visibility)));
  items.push(statusBadge(document, statusLabel(project?.status)));
  return items.filter(Boolean);
}

/** 行のメタ行。件数が数でなければ件数は出さない（「undefined 成果」を出さない）。 */
export function projectMeta(project) {
  const parts = [];
  const count = Number(project?.objectCount);
  if (project?.objectCount != null && Number.isFinite(count)) parts.push(`${count} 成果`);
  if (project?.defaultLicense) parts.push(project.defaultLicense);
  return parts.join(' · ');
}

/**
 * 1 行。onOpen(project) を押したときに呼ぶ。名前の行に札が並び、概要は 2 行まで、メタは 1 行。
 * 返す button は従来どおり research-project-card（検査と検索がそのクラスを見る）。
 */
export function projectRow(document, project, onOpen) {
  const row = el(document, 'button', 'research-project-card research-row');
  row.type = 'button';
  const head = el(document, 'span', 'research-row-head');
  head.append(el(document, 'h3', 'research-row-name', project.title), ...projectBadges(document, project));
  row.append(head, el(document, 'p', 'research-row-body', project.description || '説明はまだありません。'));
  const meta = projectMeta(project);
  if (meta) row.append(el(document, 'span', 'meta research-row-meta', meta));
  row.onclick = () => onOpen?.(project);
  return row;
}

/** 行の並び（箱にしない・間は線）。 */
export function projectRows(document, projects, onOpen) {
  return projects.map(project => projectRow(document, project, onOpen));
}

/**
 * 静かな空の状態：題 20/800、本文 15 muted、押せるものは副ボタン 1 つまで、記号の円は無い。
 * 既存の検査が見る .state-panel / .state-title / .state-body を保つ。
 */
export function researchEmptyState(document, { title, body, action } = {}) {
  const panel = el(document, 'div', 'state-panel research-empty');
  panel.setAttribute('role', 'status');
  panel.append(el(document, 'p', 'state-title', title));
  if (body) panel.append(el(document, 'p', 'state-body', body));
  if (action?.label && typeof action.onClick === 'function') {
    const button = el(document, 'button', 'btn btn-ghost state-action research-empty-action', action.label);
    button.type = 'button';
    button.onclick = () => action.onClick(button);
    panel.append(button);
  }
  return panel;
}

/** 読み込み中は行と同じ形（名前・概要・メタの 3 本）の骨組み。文字も回る印も出さない。 */
export function researchSkeleton(document, count = 4) {
  const group = el(document, 'div', 'ds-skel-group research-skeleton');
  group.setAttribute('role', 'status');
  group.setAttribute('aria-busy', 'true');
  group.setAttribute('aria-live', 'polite');
  group.append(el(document, 'span', 'ds-sr', '読み込んでいます'));
  const n = Math.max(1, Math.min(Math.trunc(Number(count)) || 1, 8));
  for (let i = 0; i < n; i += 1) {
    const row = el(document, 'div', 'research-skel-row');
    row.setAttribute('aria-hidden', 'true');
    row.append(el(document, 'span', 'skeleton-block research-skel-name'), el(document, 'span', 'skeleton-block research-skel-body'), el(document, 'span', 'skeleton-block research-skel-meta'));
    group.append(row);
  }
  return group;
}
