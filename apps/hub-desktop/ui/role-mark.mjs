// 運営の印（2026-11-09）。そのコミュニティの owner / moderator を名前の横に出す。
// 印の出どころは、サーバーが自分の役職の表から返した role だけ。名前・本文の文字（「✓」「運営」など）は一切見ない。
// 線の絵だけ（面にしない）。色は意味のトークン。
const ROLES = Object.freeze({
  owner: { label: '運営', title: 'このコミュニティの運営（オーナー）です。' },
  moderator: { label: 'モデレーター', title: 'このコミュニティのモデレーターです。' },
});
const SHIELD = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2 5 5.8v5.6c0 4.2 2.8 7.6 7 9.4 4.2-1.8 7-5.2 7-9.4V5.8z"/><path d="m9 12 2.2 2.2L15.2 10"/></svg>';

/** 受け付けるのは文字列の "owner" か "moderator" だけ。それ以外（"member"、名前、ほかの形）は null。 */
export function roleView(raw) {
  return typeof raw === 'string' && Object.hasOwn(ROLES, raw) ? { role: raw, ...ROLES[raw] } : null;
}

/** 名前の横の印。役職が無ければ null（何も出さない）。 */
export function roleMark(document, raw) {
  const view = roleView(raw);
  if (!view) return null;
  const node = document.createElement('span');
  node.className = `role-mark role-mark-${view.role}`;
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', view.label);
  node.title = view.title;
  node.innerHTML = SHIELD;
  return node;
}
