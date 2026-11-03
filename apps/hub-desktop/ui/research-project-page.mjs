// プロジェクトの詳細ページの頭と札（2026-11-02、デザイン規約 §3 の Tabs / Badges）。
// renderResearchProject が組んだ .research-project-detail を壊さず、既にある節（data-research-section）を
// 札ごとに見せ分けるだけ：概要（文書・コードの入口を含む）/ 資料と議論 / 成果と根拠 / その他。新しい読み取りは足さない。
// 節は hidden で隠すだけで DOM から外さない（既存の検査・制御が同じ要素を見続ける）。
import { projectBadges } from './research-rows.mjs';

/** 節の名前 → 札。ここに無い名前は「その他」。先頭（最初の見出しより前）は概要。 */
const TAB_OF_SECTION = {
  概要: 'overview',
  '文書・コード': 'overview',
  '資料・作品・議論': 'documents',
  論文PDF: 'documents',
  研究成果: 'results',
  '主張と根拠': 'results',
};
export const RESEARCH_TABS = Object.freeze([
  { id: 'overview', label: '概要' },
  { id: 'documents', label: '資料と議論' },
  { id: 'results', label: '成果と根拠' },
  { id: 'other', label: 'その他' },
]);

/** root の直下の子を、順に見て札へ振る。見出し・data-research-section を持つ子が新しい節の始まり。 */
export function assignTabs(root) {
  let tab = 'overview';
  const used = new Set(['overview']);
  for (const node of root.children) {
    if (node.classList.contains('research-page-head') || node.classList.contains('page-tabs') || node.classList.contains('research-summary')) continue;
    const section = node.dataset.researchSection;
    if (section) tab = TAB_OF_SECTION[section] ?? 'other';
    node.dataset.researchTab = tab;
    used.add(tab);
  }
  return used;
}

/**
 * root（.research-project-detail）に、状態の札と札の並びを足す。state.tab に選択を覚える（再描画でも保つ）。
 * 返す select(id) は札を付け替える。
 */
export function decorateProjectPage(root, data, state = {}) {
  const document = root.ownerDocument;
  const project = data.project;
  // 説明（先頭の p）は札に関わらず常に見せる。
  const lead = root.firstElementChild;
  if (lead && lead.tagName === 'P' && !lead.classList.contains('meta')) lead.classList.add('research-summary');
  const used = assignTabs(root);

  const head = document.createElement('div');
  head.className = 'research-page-head';
  head.append(...projectBadges(document, project));
  if (project.defaultLicense) {
    const license = document.createElement('span');
    license.className = 'meta';
    license.textContent = project.defaultLicense;
    head.append(license);
  }
  // 従来の「公開 · 進行中 · ライセンス」の 1 行は札に置き換える（要素は残し、見せない）。
  const oldMeta = root.querySelector(':scope > p.meta');
  if (oldMeta) oldMeta.hidden = true;

  const tabs = document.createElement('div');
  tabs.className = 'page-tabs research-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'プロジェクトの内容');
  const shown = RESEARCH_TABS.filter(item => used.has(item.id));
  const buttons = new Map();
  const select = id => {
    const next = buttons.has(id) ? id : 'overview';
    state.tab = next;
    for (const [key, button] of buttons) {
      button.setAttribute('aria-selected', String(key === next));
      button.tabIndex = key === next ? 0 : -1;
    }
    for (const node of root.querySelectorAll(':scope > [data-research-tab]')) node.hidden = node.dataset.researchTab !== next;
    if (oldMeta) oldMeta.hidden = true;
  };
  for (const item of shown) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.dataset.researchTabId = item.id;
    button.textContent = item.label;
    button.onclick = () => select(item.id);
    button.onkeydown = event => {
      const keys = [...buttons.keys()];
      const at = keys.indexOf(item.id);
      const to = event.key === 'ArrowRight' ? keys[(at + 1) % keys.length] : event.key === 'ArrowLeft' ? keys[(at - 1 + keys.length) % keys.length] : null;
      if (!to) return;
      event.preventDefault();
      select(to);
      buttons.get(to).focus();
    };
    buttons.set(item.id, button);
    tabs.append(button);
  }
  // 札は説明の次、中身の前。説明（先頭の p）が無ければ最初に置く。
  const first = root.querySelector(':scope > .research-summary');
  if (first) first.after(head, tabs); else root.prepend(head, tabs);
  // 文書の行（文書・コード の直下のボタン）に行の印を付ける。
  for (const node of root.querySelectorAll(':scope > button')) node.classList.add('research-doc-row');
  select(state.tab);
  return { select };
}
