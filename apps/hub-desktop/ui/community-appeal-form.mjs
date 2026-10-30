const node = (document, tag, text = '', className = '') => { const result = document.createElement(tag); result.textContent = text ?? ''; result.className = className; return result; };
const button = (document, text, action) => { const result = node(document, 'button', text, 'head-action'); result.type = 'button'; result.onclick = action; return result; };
const statuses = { pending: '審査待ち', accepted: '受理済み', rejected: '却下済み', withdrawn: '取り下げ済み' };
const errorText = error => String(error?.message ?? error);
const sourceIdentity = sanction => sanction && ['legacy', 'audit'].includes(sanction.kind) && typeof sanction.id === 'string' && sanction.id && typeof sanction.createdAt === 'string' && Number.isFinite(Date.parse(sanction.createdAt)) ? JSON.stringify([sanction.kind, sanction.id, sanction.createdAt]) : null;

export function communityAppealForm(document, { communityId, data, state = {}, invoke, onReload }) {
  const root = node(document, 'section', '', 'detail-form community-appeal-review'), notice = node(document, 'p', '', 'meta'); notice.setAttribute('role', 'status');
  if (data?.communityId !== communityId || !Array.isArray(data.appeals) || !data.appeals.every(appeal => appeal && typeof appeal.id === 'string' && appeal.id) || !data.submission) { root.append(node(document, 'p', '異議申立てを確認できませんでした。', 'meta')); return root; }
  const currentSource = sourceIdentity(data.submission.sanction), resolved = state.saved && data.appeals.find(appeal => appeal.id === state.saved.appeal.id);
  if (state.saved?.sourceIdentity && ['accepted', 'rejected', 'withdrawn'].includes(resolved?.status) && !data.appeals.some(appeal => appeal.status === 'pending') && currentSource && currentSource !== state.saved.sourceIdentity) { state.saved = null; state.request = null; state.confirmed = null; state.confirmedTarget = null; state.note = ''; state.message = ''; }
  const history = node(document, 'section', '', 'detail-form'); history.setAttribute('aria-label', '自分の異議申立て履歴');
  const target = node(document, 'p', '', 'meta'), preview = node(document, 'section', '', 'card detail-form'); preview.hidden = true; preview.setAttribute('aria-label', '異議申立ての確認');
  const reason = node(document, 'textarea'); reason.rows = 4; reason.maxLength = 1000; reason.setAttribute('aria-label', '申立て理由'); reason.placeholder = '申立て理由を20〜1000文字で入力'; reason.value = state.note ?? '';
  const label = node(document, 'label', '申立て理由', 'detail-form'); label.append(reason);
  const unavailable = () => data.appeals.some(appeal => appeal.status === 'pending') ? '審査待ちの異議申立てがあります。追加の申立てはできません。'
    : data.submission.sanction === null ? '現在の異議申立て対象がありません。'
    : !data.submission.sanction || !['legacy', 'audit'].includes(data.submission.sanction.kind) || typeof data.submission.sanction.id !== 'string' || !data.submission.sanction.id || typeof data.submission.sanction.createdAt !== 'string' || !Number.isFinite(Date.parse(data.submission.sanction.createdAt)) || typeof data.submission.sanctionKey !== 'string' || !/^[a-f0-9]{64}$/.test(data.submission.sanctionKey) ? '現在の処分を確認できませんでした。状態を再読込してください。' : '';
  const invalidate = () => { state.note = reason.value; state.confirmed = null; state.confirmedTarget = null; state.request = null; preview.hidden = true; }; reason.oninput = invalidate;
  const confirm = button(document, '申立てを確認', () => {
    if (state.busy || state.saved || unavailable()) return;
    const normalized = reason.value.normalize('NFKC').trim(); state.note = reason.value;
    if (Array.from(normalized).length < 20 || normalized.length > 1000) { state.confirmed = null; preview.hidden = true; state.message = '申立て理由は20〜1000文字で入力してください。'; sync(); return; }
    state.confirmed = { reason: normalized, expectedSanctionKey: data.submission.sanctionKey }; state.confirmedTarget = JSON.stringify(data.submission.sanction);
    preview.replaceChildren(node(document, 'h4', 'この処分について異議を申し立てる'), node(document, 'p', `処分の記録: ${data.submission.sanction.createdAt}`, 'meta'), node(document, 'p', normalized, 'detail-p'), node(document, 'p', '申立ての受理と処分解除は、運営が対象の一致を確認して判断します。', 'detail-p'), button(document, '確認して送信', () => void save()));
    preview.hidden = false; state.message = '対象の処分日時と申立て理由を確認して送信してください。'; sync();
  });
  const reload = button(document, '状態を再読込', async () => {
    if (state.busy) return;
    state.busy = true; sync();
    try { await readLatest(); } finally { state.busy = false; sync(); }
  });
  async function readLatest() {
    try {
      if (!onReload) throw Error('再読込を利用できません。');
      await onReload(); state.message = state.saved ? '申立ては保存済みです。' : '';
    } catch (error) { state.message = `${state.saved ? '申立ては保存済みです。' : ''}最新の申立てを読み込めませんでした: ${errorText(error)}`; }
  }
  function sync() {
    if (state.sync !== sync) { state.sync?.(); return; }
    const appeals = state.saved && !data.appeals.some(appeal => appeal.id === state.saved.appeal.id) ? [state.saved.appeal, ...data.appeals] : data.appeals;
    const cards = appeals.map(appeal => {
      const card = node(document, 'article', '', 'card detail-form'); card.append(node(document, 'h4', statuses[appeal.status] ?? '状態不明'), node(document, 'p', appeal.createdAt ?? '', 'meta'), node(document, 'p', appeal.reason ?? '', 'detail-p'));
      if (appeal.resolvedAt) card.append(node(document, 'p', `判断日時: ${appeal.resolvedAt}`, 'meta'));
      if (appeal.resolutionNote) card.append(node(document, 'p', `判断理由: ${appeal.resolutionNote}`, 'detail-p')); return card;
    });
    history.replaceChildren(node(document, 'h3', '自分の異議申立て'), ...(cards.length ? cards : [node(document, 'p', '異議申立ての履歴はありません。', 'meta')]));
    target.textContent = data.submission.sanction ? `処分の記録: ${data.submission.sanction.createdAt ?? ''}` : '現在の異議申立て対象がありません。';
    notice.textContent = state.message ?? (state.saved ? '申立ては保存済みです。' : unavailable());
    root.querySelectorAll('button,textarea').forEach(field => { field.disabled = Boolean(state.busy || state.saved || unavailable()); }); reload.disabled = Boolean(state.busy);
    if (state.saved || !state.confirmed) preview.hidden = true;
  }
  state.sync = sync;
  async function save() {
    if (state.busy || state.saved || unavailable() || !state.confirmed) return;
    const input = state.confirmed;
    if (reason.value.normalize('NFKC').trim() !== input.reason || input.expectedSanctionKey !== data.submission.sanctionKey || state.confirmedTarget !== JSON.stringify(data.submission.sanction)) { invalidate(); state.message = '変更した内容をもう一度確認してください。'; sync(); return; }
    const key = JSON.stringify([communityId, input]); if (state.request?.key !== key) state.request = { key, id: crypto.randomUUID() };
    const id = state.request.id, source = sourceIdentity(data.submission.sanction); state.busy = true; sync();
    try {
      const result = await invoke('hub_action', { action: 'community_appeal_submit', target: communityId, requestId: id, options: input });
      if (typeof result?.appeal?.id !== 'string' || !result.appeal.id || result.appeal.status !== 'pending' || typeof result.appeal.createdAt !== 'string' || !Number.isFinite(Date.parse(result.appeal.createdAt)) || result.receipt?.auditId !== id || result.receipt?.action !== 'appeal_submitted' || result.receipt?.targetId !== result.appeal.id) throw Error('保存結果を確認できませんでした。同じ内容で再試行してください。');
      state.saved = { sourceIdentity: source, appeal: { id: result.appeal.id, status: result.appeal.status, createdAt: result.appeal.createdAt, reason: input.reason } }; state.confirmed = null; state.confirmedTarget = null; state.note = ''; reason.value = ''; state.message = '申立ては保存済みです。'; sync(); await readLatest();
    } catch (error) { state.message = errorText(error); }
    finally { state.busy = false; sync(); }
  }
  root.append(history, node(document, 'h3', '異議を申し立てる'), target, node(document, 'p', '申立ての受理と処分解除は、運営が対象の一致を確認して判断します。', 'detail-p'), label, confirm, preview, reload, notice); sync(); return root;
}
