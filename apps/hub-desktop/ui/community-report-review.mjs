const node = (document, tag, text = '', className = '') => { const result = document.createElement(tag); result.textContent = text ?? ''; result.className = className; return result; };
const button = (document, text, action) => { const result = node(document, 'button', text, 'head-action'); result.type = 'button'; result.onclick = action; return result; };
const reasons = { spam: '迷惑投稿', harassment: '嫌がらせ', other: 'その他' };
const statuses = { open: '未対応', resolved: '対応済み', dismissed: '問題なし' };
const errorText = error => String(error?.message ?? error);
const validPage = (data, communityId, offset) => data?.communityId === communityId && Array.isArray(data.reports) && data.reports.length <= 20 && data.reports.every(report => report && typeof report.id === 'string' && report.id) && data.page?.offset === offset && Number.isSafeInteger(offset) && offset >= 0 && typeof data.page.hasMore === 'boolean' && (!data.page.hasMore || (Number.isSafeInteger(data.page.nextOffset) && data.page.nextOffset > offset));

export function communityReportReviewRequest(entry) {
  return entry.name === 'community_reports' && Number.isSafeInteger(entry.reportPage?.offset) && entry.reportPage.offset > 0
    ? { name: 'community_reports_page', ids: [entry.ids[0], String(entry.reportPage.offset)] } : null;
}

export function communityReports(document, { communityId, data, state = {}, invoke, onOpen }) {
  const root = node(document, 'section', '', 'detail-form community-report-review'), list = node(document, 'div', '', 'detail-form'), notice = node(document, 'p', '', 'meta');
  notice.setAttribute('role', 'status');
  let current = validPage(data, communityId, state.offset ?? data?.page?.offset) ? data : null, busy = false;
  if (current) state.offset = current.page.offset;
  else notice.textContent = '通報一覧を確認できませんでした。';
  async function load(offset) {
    if (busy || !Number.isSafeInteger(offset) || offset < 0) return;
    busy = true; render(); notice.textContent = '読み込み中…';
    try {
      const next = await invoke('hub_detail', { name: 'community_reports_page', ids: [communityId, String(offset)] });
      if (!validPage(next, communityId, offset)) throw Error('通報一覧を確認できませんでした。');
      current = next; state.offset = offset; notice.textContent = '';
    } catch (error) { notice.textContent = errorText(error); }
    finally { busy = false; render(); }
  }
  function render() {
    if (!current) { list.replaceChildren(); return; }
    const cards = current.reports.map(report => {
      const title = `${report.reporterName ?? '通報者'}の通報`, card = node(document, 'article', '', 'card detail-form');
      card.append(button(document, title, () => { if (!busy) onOpen('community_report', [communityId, report.id], title); }), node(document, 'p', `${reasons[report.reason] ?? 'その他'} · ${report.createdAt ?? ''}`, 'meta'));
      return card;
    });
    const nav = node(document, 'nav', '', 'detail-form-row'); nav.setAttribute('aria-label', '通報のページ');
    const previous = button(document, '前の20件', () => load(Math.max(0, current.page.offset - 20))), next = button(document, '次の20件', () => load(current.page.nextOffset));
    previous.disabled = busy || current.page.offset === 0; next.disabled = busy || !current.page.hasMore; nav.append(previous, next);
    list.replaceChildren(...(cards.length ? cards : [node(document, 'p', '未対応の通報はありません。', 'meta')]), nav);
    if (busy) list.querySelectorAll('button').forEach(item => { item.disabled = true; });
  }
  root.append(node(document, 'h3', '通報'), list, notice); render(); return root;
}

export function communityReportReview(document, { communityId, reportId, data, state = {}, invoke, onReload }) {
  const root = node(document, 'section', '', 'card detail-form community-report-review'), report = data?.report, notice = node(document, 'p', '', 'meta'); notice.setAttribute('role', 'status');
  if (data?.communityId !== communityId || !report || report.id !== reportId) { root.append(node(document, 'p', '通報を確認できませんでした。', 'meta')); return root; }
  const saved = () => state.saved?.id === reportId;
  const validReceipt = (result, id, status) => result?.ok === true && result.report?.id === reportId && result.report?.status === status && result.receipt?.auditId === id && result.receipt?.targetId === reportId && result.receipt?.action === 'resolve_report';
  const status = node(document, 'p', '', 'meta');
  root.append(node(document, 'h3', `${report.reporterName ?? '通報者'}の通報`), status, node(document, 'p', `通報理由: ${reasons[report.reason] ?? 'その他'}`, 'meta'), node(document, 'h4', '対象の投稿'), node(document, 'p', report.messageAuthorName ?? '', 'meta'), node(document, 'p', report.messageBody ?? '', 'detail-p'), node(document, 'p', '通報の状態だけを変更します。投稿の削除やメンバーへの制限は別の操作で行ってください。', 'detail-p'));
  const reload = button(document, '状態を再読込', async () => {
    if (state.busy) return;
    state.busy = true; sync();
    try { await readLatest(); } finally { state.busy = false; sync(); }
  });
  async function readLatest() {
    try {
      if (!onReload) throw Error('再読込を利用できません。');
      await onReload(); state.message = saved() ? '判断は保存済みです。' : '';
    } catch (error) { state.message = `${saved() ? '判断は保存済みです。' : ''}最新の通報を読み込めませんでした: ${errorText(error)}`; }
  }
  const unavailable = !['owner', 'moderator'].includes(data.role) || typeof data.viewerId !== 'string' || !data.viewerId
    ? '通報の判断にはオーナーまたはモデレーターの権限が必要です。'
    : report.messageAuthorId === data.viewerId ? '自分の投稿への通報は判断できません。'
    : report.status !== 'open' ? 'この通報は判断済みです。判断を変更できません。'
    : report.canResolve !== true ? 'この通報を判断する権限がありません。'
    : typeof report.createdAt !== 'string' || !Number.isFinite(Date.parse(report.createdAt)) ? '通報日時を確認できませんでした。状態を再読込してください。'
    : report.messageEditedAt !== null && (typeof report.messageEditedAt !== 'string' || !Number.isFinite(Date.parse(report.messageEditedAt))) ? '投稿の更新日時を確認できませんでした。状態を再読込してください。' : '';
  const repair = node(document, 'div', '', 'detail-form-row');
  root.append(reload, repair);
  async function retryNotification() {
    if (state.busy || !saved() || !state.notificationPending || !state.saved.requestId || !state.saved.options) return;
    const acknowledged = state.saved; state.busy = true; sync();
    try {
      const result = await invoke('hub_action', { action: 'community_report_review', target: communityId, requestId: acknowledged.requestId, options: acknowledged.options });
      if (!validReceipt(result, acknowledged.requestId, acknowledged.status)) throw Error('通知の再試行結果を確認できませんでした。');
      state.notificationPending = result.notificationPending === true; state.message = '判断は保存済みです。';
    } catch (error) { state.message = `判断は保存済みです。通知を再試行できませんでした: ${errorText(error)}`; }
    finally { state.busy = false; sync(); }
  }
  let reason, preview, controls;
  function sync() {
    if (state.sync !== sync) { state.sync?.(); return; }
    status.textContent = `${statuses[saved() ? state.saved.status : report.status] ?? '状態不明'} · ${report.createdAt ?? ''}${report.resolvedAt ? ' · ' + report.resolvedAt : ''}`;
    notice.textContent = (state.message ?? (saved() ? '判断は保存済みです。' : '')) + (saved() && state.notificationPending ? '通知は未完了です。' : '');
    root.querySelectorAll('button,textarea').forEach(field => { field.disabled = Boolean(state.busy || saved()); });
    reload.disabled = Boolean(state.busy);
    repair.replaceChildren();
    if (saved() && state.notificationPending && state.saved.requestId && state.saved.options) { const retry = button(document, '通知を再試行', () => void retryNotification()); retry.disabled = Boolean(state.busy); repair.append(retry); }
    if (preview && (saved() || !state.confirmed)) preview.hidden = true;
  }
  state.sync = sync;
  if (unavailable || saved()) { if (unavailable && !saved()) root.append(node(document, 'p', unavailable, 'meta')); root.append(notice); sync(); return root; }
  reason = node(document, 'textarea'); reason.rows = 3; reason.maxLength = 1000; reason.setAttribute('aria-label', '判断理由'); reason.placeholder = '判断理由を5〜1000文字で入力'; reason.value = state.note ?? '';
  const label = node(document, 'label', '判断理由', 'detail-form'); label.append(reason);
  preview = node(document, 'section', '', 'card detail-form'); preview.setAttribute('aria-label', '通報判断の確認'); preview.hidden = true;
  controls = node(document, 'div', '', 'detail-form-row');
  const invalidate = () => { state.note = reason.value; state.confirmed = null; state.request = null; preview.hidden = true; };
  reason.oninput = invalidate;
  function confirm(decision) {
    if (state.busy || saved()) return;
    const note = reason.value.normalize('NFKC').trim(); state.note = reason.value;
    if (note.length < 5 || note.length > 1000) { state.confirmed = null; preview.hidden = true; state.message = '判断理由は5〜1000文字で入力してください。'; sync(); return; }
    state.confirmed = { decision, note, expectedCreatedAt: report.createdAt, expectedMessageEditedAt: report.messageEditedAt };
    preview.replaceChildren(node(document, 'h4', `${report.messageAuthorName ?? '投稿者'}の投稿への通報を「${decision === 'dismissed' ? '問題なし' : '対応済み'}」にする`), node(document, 'p', report.messageBody ?? '', 'detail-p'), node(document, 'p', note, 'detail-p'), node(document, 'p', '投稿の削除やメンバーへの制限は実行しません。', 'meta'), button(document, '確認して実行', () => void save()));
    preview.hidden = false; state.message = '対象の投稿・判断・理由を確認して実行してください。'; sync();
  }
  async function save() {
    if (state.busy || saved() || !state.confirmed) return;
    const input = state.confirmed;
    if (reason.value.normalize('NFKC').trim() !== input.note || input.expectedCreatedAt !== report.createdAt || input.expectedMessageEditedAt !== report.messageEditedAt) { invalidate(); state.message = '変更した内容をもう一度確認してください。'; sync(); return; }
    const key = JSON.stringify([communityId, reportId, input]);
    if (state.request?.key !== key) state.request = { key, id: crypto.randomUUID() };
    const id = state.request.id; state.busy = true; sync();
    try {
      const result = await invoke('hub_action', { action: 'community_report_review', target: communityId, requestId: id, options: { reportId, ...input } });
      const expectedStatus = input.decision === 'dismissed' ? 'dismissed' : 'resolved';
      if (!validReceipt(result, id, expectedStatus)) throw Error('保存結果を確認できませんでした。同じ内容で再試行してください。');
      state.saved = { id: reportId, status: result.report.status, requestId: id, options: { reportId, ...input } }; state.notificationPending = result.notificationPending === true; state.confirmed = null; state.note = ''; reason.value = ''; state.message = '判断は保存済みです。'; sync();
      await readLatest();
    } catch (error) { state.message = errorText(error); }
    finally { state.busy = false; sync(); }
  }
  controls.append(button(document, '問題なし', () => confirm('dismissed')), button(document, '対応済み', () => confirm('actioned')));
  root.append(label, controls, preview, notice); sync(); return root;
}
