const node = (document, tag, text = '', className = '') => { const result = document.createElement(tag); result.textContent = text ?? ''; result.className = className; return result; };
const button = (document, text, action) => { const result = node(document, 'button', text, 'head-action'); result.type = 'button'; result.onclick = action; return result; };
const statuses = { pending: '審査待ち', accepted: '受理済み', rejected: '却下済み', withdrawn: '取り下げ済み' };
const memberships = { active: '参加中', muted: '投稿ミュート中', banned: '参加禁止中', left: '退出済み' };
const errorText = error => String(error?.message ?? error);
const validPage = (data, communityId, offset) => data?.communityId === communityId && Array.isArray(data.appeals) && data.appeals.length <= 20 && data.appeals.every(appeal => appeal && typeof appeal.id === 'string' && appeal.id) && data.page?.offset === offset && Number.isSafeInteger(offset) && offset >= 0 && typeof data.page.hasMore === 'boolean' && (!data.page.hasMore || (Number.isSafeInteger(data.page.nextOffset) && data.page.nextOffset > offset));

export function communityAppealReviewRequest(entry) {
  return entry.name === 'community_appeals' && Number.isSafeInteger(entry.appealPage?.offset) && entry.appealPage.offset > 0
    ? { name: 'community_appeals_page', ids: [entry.ids[0], String(entry.appealPage.offset)] } : null;
}

export function communityAppeals(document, { communityId, data, state = {}, invoke, onOpen }) {
  const root = node(document, 'section', '', 'detail-form community-appeal-review'), list = node(document, 'div', '', 'detail-form'), notice = node(document, 'p', '', 'meta'); notice.setAttribute('role', 'status');
  let current = validPage(data, communityId, state.offset ?? data?.page?.offset) ? data : null, busy = false;
  if (current) state.offset = current.page.offset;
  else state.message = '異議申立て一覧を確認できませんでした。';
  notice.textContent = state.message ?? '';
  async function load(offset) {
    if (busy || !Number.isSafeInteger(offset) || offset < 0) return;
    busy = true; render(); notice.textContent = '読み込み中…';
    try {
      const next = await invoke('hub_detail', { name: 'community_appeals_page', ids: [communityId, String(offset)] });
      if (!validPage(next, communityId, offset)) throw Error('異議申立て一覧を確認できませんでした。');
      current = next; state.offset = offset; state.message = notice.textContent = '';
    } catch (error) { state.message = notice.textContent = errorText(error); }
    finally { busy = false; render(); }
  }
  function render() {
    if (!current) { list.replaceChildren(); return; }
    const cards = current.appeals.map(appeal => {
      const title = `${appeal.displayName ?? '申立人'}の異議申立て`, card = node(document, 'article', '', 'card detail-form');
      card.append(button(document, title, () => { if (!busy) onOpen('community_appeal', [communityId, appeal.id], title); }), node(document, 'p', appeal.createdAt, 'meta')); return card;
    });
    const nav = node(document, 'nav', '', 'detail-form-row'); nav.setAttribute('aria-label', '異議申立てのページ');
    const previous = button(document, '前の20件', () => load(Math.max(0, current.page.offset - 20))), next = button(document, '次の20件', () => load(current.page.nextOffset));
    previous.disabled = busy || current.page.offset === 0; next.disabled = busy || !current.page.hasMore; nav.append(previous, next);
    list.replaceChildren(...(cards.length ? cards : [node(document, 'p', '審査待ちの異議申立てはありません。', 'meta')]), nav);
    if (busy) list.querySelectorAll('button').forEach(item => { item.disabled = true; });
  }
  root.append(node(document, 'h3', '異議申立て'), list, notice); render(); return root;
}

export function communityAppealReview(document, { communityId, appealId, data, state = {}, invoke, onReload }) {
  const root = node(document, 'section', '', 'card detail-form community-appeal-review'), appeal = data?.appeal, notice = node(document, 'p', '', 'meta'); notice.setAttribute('role', 'status');
  if (data?.communityId !== communityId || !appeal || appeal.id !== appealId) { root.append(node(document, 'p', '異議申立てを確認できませんでした。', 'meta')); return root; }
  const saved = () => state.saved?.id === appealId;
  const effect = decision => decision === 'accepted' && appeal.canUnmute === true ? 'unmuted' : 'unchanged';
  const impact = decision => effect(decision) === 'unmuted' ? '現在の投稿ミュートを解除します。' : '参加状態は変更しません。';
  const status = node(document, 'p', '', 'meta'), membership = node(document, 'p', '', 'meta');
  root.append(node(document, 'h3', `${appeal.displayName ?? '申立人'}の異議申立て`), status, membership, node(document, 'h4', '異議申立ての理由'), node(document, 'p', appeal.reason ?? '', 'detail-p'), node(document, 'p', '受理は異議申立ての審査結果です。' + impact('accepted'), 'detail-p'));
  if (appeal.canUnmute !== true && appeal.restrictionReason) root.append(node(document, 'p', appeal.restrictionReason, 'detail-p'));
  if (appeal.resolutionNote) root.append(node(document, 'h4', '保存された判断理由'), node(document, 'p', appeal.resolutionNote, 'detail-p'));
  const reload = button(document, '状態を再読込', async () => {
    if (state.busy) return;
    state.busy = true; sync();
    try { await readLatest(); } finally { state.busy = false; sync(); }
  });
  async function readLatest() {
    try {
      if (!onReload) throw Error('再読込を利用できません。');
      await onReload(); state.message = saved() ? '判断は保存済みです。' : '';
    } catch (error) { state.message = `${saved() ? '判断は保存済みです。' : ''}最新の異議申立てを読み込めませんでした: ${errorText(error)}`; }
  }
  const unavailable = !['owner', 'moderator'].includes(data.role) || typeof data.viewerId !== 'string' || !data.viewerId
    ? '異議申立ての判断にはオーナーまたはモデレーターの権限が必要です。'
    : typeof appeal.profileId !== 'string' || !appeal.profileId ? '申立人を確認できませんでした。状態を再読込してください。'
    : appeal.profileId === data.viewerId ? '自分の異議申立ては判断できません。'
    : appeal.status !== 'pending' ? 'この異議申立ては審査待ちではありません。判断を変更できません。'
    : appeal.canResolve !== true ? 'この異議申立てを判断する権限がありません。'
    : typeof appeal.createdAt !== 'string' || !Number.isFinite(Date.parse(appeal.createdAt)) ? '申立て日時を確認できませんでした。状態を再読込してください。'
    : typeof appeal.canUnmute !== 'boolean' || typeof appeal.sanctionKey !== 'string' || !/^[a-f0-9]{64}$/.test(appeal.sanctionKey) ? '制限の状態を確認できませんでした。状態を再読込してください。' : '';
  root.append(reload);
  let reason, preview;
  function sync() {
    if (state.sync !== sync) { state.sync?.(); return; }
    status.textContent = `${statuses[saved() ? state.saved.status : appeal.status] ?? '状態不明'} · ${appeal.createdAt ?? ''}${appeal.resolvedAt ? ' · ' + appeal.resolvedAt : ''}`;
    membership.textContent = saved() && state.saved.membershipEffect === 'unmuted' ? '投稿ミュートを解除しました。' : `参加状態: ${memberships[appeal.membershipStatus] ?? '状態不明'}`;
    notice.textContent = state.message ?? (saved() ? '判断は保存済みです。' : '');
    root.querySelectorAll('button,textarea').forEach(field => { field.disabled = Boolean(state.busy || saved()); }); reload.disabled = Boolean(state.busy);
    if (preview && (saved() || !state.confirmed)) preview.hidden = true;
  }
  state.sync = sync;
  if (unavailable || saved()) { if (unavailable && !saved()) root.append(node(document, 'p', unavailable, 'meta')); root.append(notice); sync(); return root; }
  reason = node(document, 'textarea'); reason.rows = 3; reason.maxLength = 1000; reason.setAttribute('aria-label', '判断理由'); reason.placeholder = '判断理由を5〜1000文字で入力'; reason.value = state.note ?? '';
  const label = node(document, 'label', '判断理由', 'detail-form'); label.append(reason);
  preview = node(document, 'section', '', 'card detail-form'); preview.setAttribute('aria-label', '異議申立て判断の確認'); preview.hidden = true;
  const controls = node(document, 'div', '', 'detail-form-row');
  const invalidate = () => { state.note = reason.value; state.confirmed = null; state.confirmedEffect = null; state.request = null; preview.hidden = true; }; reason.oninput = invalidate;
  function confirm(decision) {
    if (state.busy || saved()) return;
    const note = reason.value.normalize('NFKC').trim(); state.note = reason.value;
    if (note.length < 5 || note.length > 1000) { state.confirmed = null; preview.hidden = true; state.message = '判断理由は5〜1000文字で入力してください。'; sync(); return; }
    state.confirmed = { decision, note, expectedCreatedAt: appeal.createdAt, expectedSanctionKey: appeal.sanctionKey }; state.confirmedEffect = effect(decision);
    preview.replaceChildren(node(document, 'h4', `${appeal.displayName ?? '申立人'}の異議申立てを${decision === 'accepted' ? '受理' : '却下'}`), node(document, 'p', appeal.reason ?? '', 'detail-p'), node(document, 'p', note, 'detail-p'), node(document, 'p', impact(decision), 'detail-p'), button(document, '確認して実行', () => void save()));
    if (effect(decision) === 'unchanged' && appeal.restrictionReason) preview.insertBefore(node(document, 'p', appeal.restrictionReason, 'detail-p'), preview.lastChild);
    preview.hidden = false; state.message = '対象・申立て理由・判断理由・参加状態への影響を確認して実行してください。'; sync();
  }
  async function save() {
    if (state.busy || saved() || !state.confirmed) return;
    const input = state.confirmed, expectedEffect = state.confirmedEffect;
    if (reason.value.normalize('NFKC').trim() !== input.note || input.expectedCreatedAt !== appeal.createdAt || input.expectedSanctionKey !== appeal.sanctionKey || expectedEffect !== effect(input.decision)) { invalidate(); state.message = '変更した内容をもう一度確認してください。'; sync(); return; }
    const key = JSON.stringify([communityId, appealId, input, expectedEffect]); if (state.request?.key !== key) state.request = { key, id: crypto.randomUUID() };
    const id = state.request.id; state.busy = true; sync();
    try {
      const result = await invoke('hub_action', { action: 'community_appeal_review', target: communityId, requestId: id, options: { appealId, ...input } });
      if (result?.ok !== true || result.appeal?.id !== appealId || result.appeal?.status !== input.decision || result.receipt?.auditId !== id || result.receipt?.targetId !== appealId || result.receipt?.action !== 'resolve_appeal' || result.receipt?.membershipEffect !== expectedEffect) throw Error('保存結果を確認できませんでした。同じ内容で再試行してください。');
      state.saved = { id: appealId, status: result.appeal.status, membershipEffect: result.receipt.membershipEffect }; state.confirmed = null; state.confirmedEffect = null; state.note = ''; reason.value = ''; state.message = '判断は保存済みです。'; sync(); await readLatest();
    } catch (error) { state.message = errorText(error); }
    finally { state.busy = false; sync(); }
  }
  controls.append(button(document, '受理', () => confirm('accepted')), button(document, '却下', () => confirm('rejected')));
  root.append(label, controls, preview, notice); sync(); return root;
}
