import {communityJoinControls} from './community-join.mjs';
import {holdingBadge, sortByHolding, coinIcon} from './community-holding.mjs';
import {roleMark} from './role-mark.mjs';
const make = (document, tag, text, className = '') => { const node = document.createElement(tag); node.textContent = text ?? ''; node.className = className; return node; };
const field = (document, label, type = 'text', limit = 200) => { const node = document.createElement(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') node.type = type; node.maxLength = limit; node.placeholder = label; node.setAttribute('aria-label', label); return node; };
const button = (document, label, fn) => { const node = make(document, 'button', label, 'head-action'); node.type = 'button'; node.onclick = fn; return node; };
const status = document => { const node = make(document, 'p', '', 'meta'); node.setAttribute('role', 'status'); return node; };
const errorText = error => error?.message || String(error);
const folded = (document, title) => { const node = make(document, 'details', '', 'card detail-form'); node.append(make(document, 'summary', title)); return node; };
// ＋ メニューから開く入力欄。常には見せない（開くまで hidden）。閉じるは記号のボタン。
const panel = (document, title) => { const node = make(document, 'section', '', 'card detail-form community-composer-panel'); node.hidden = true; const close = make(document, 'button', '✕', 'head-action community-composer-panel-close'); close.type = 'button'; close.setAttribute('aria-label', title + 'を閉じる'); close.title = '閉じる'; close.setAttribute('data-keep-text', ''); close.onclick = () => { node.hidden = true; }; node.append(close); return node; };
const lock = (node, disabled) => node.querySelectorAll('input,textarea,select,button').forEach(control => { control.disabled = disabled; });

export function communityMemberControls(document, { communityId, members, viewerId, viewerRole, canManage, invoke, refresh, state = {}, holdingAsset = null, confirm = text => window.confirm(text) }) {
  const root = make(document, 'section', '', 'detail-form community-member-controls');
  const query = field(document, 'メンバーを検索', 'search', 100), list = make(document, 'div'), count = status(document);
  state.targets ??= new Map(); state.page ??= 0; query.value = state.query ?? '';
  const reload = async target => {
    target.message = '変更は保存済みです。メンバー一覧を更新中…'; target.reloadFailed = false; render();
    try { await refresh(); target.message = '変更は保存済みです。'; }
    catch (error) { target.reloadFailed = true; target.message = `変更は保存済みです。一覧の再読込に失敗しました: ${errorText(error)}`; }
  };
  const render = () => {
    const value = query.value.normalize('NFKC').trim().toLocaleLowerCase();
    const matched = members.filter(member => `${member.displayName} ${member.handle}`.normalize('NFKC').toLocaleLowerCase().includes(value));
    const found = state.byHolding ? sortByHolding(matched) : matched;
    const pages = Math.max(1, Math.ceil(found.length / 20)); state.page = Math.max(0, Math.min(state.page, pages - 1));
    list.replaceChildren(...found.slice(state.page * 20, (state.page + 1) * 20).map(original => {
      if (!state.targets.has(original.id)) state.targets.set(original.id, { note: '', ids: new Map(), busy: false, saved: false });
      const target = state.targets.get(original.id), member = { ...original, ...target.result };
      const card = make(document, 'article', '', 'member-row');
      card.append(make(document, 'span', [...(member.displayName || '?')][0], 'member-avatar'));
      const title = make(document, 'h3', member.displayName), mark = holdingBadge(document, original.holding, coinIcon);
      if (mark) title.append(' ', mark);
      const official = roleMark(document, member.role);
      if (official) title.append(' ', official);
      card.append(title, make(document, 'p', `@${member.handle} · ${{owner:'オーナー',moderator:'モデレーター',member:'メンバー'}[member.role] ?? 'メンバー'}${member.status === 'muted' ? ' · ミュート中' : member.status === 'banned' ? ' · 参加禁止中' : ''}`, 'meta'));
      if (member.bio) card.append(make(document, 'p', member.bio, 'meta member-bio'));
      if (target.saved) {
        const note = status(document); note.textContent = target.message; card.append(note);
        if (target.reloadFailed) card.append(button(document, 'メンバー一覧を再読込', async () => {
          if (target.busy) return;
          target.busy = true;
          try { await reload(target); } finally { target.busy = false; if (state.targets.get(original.id) === target) render(); }
        }));
      } else if (canManage && member.status !== 'banned' && member.id !== viewerId && member.role !== 'owner' && (viewerRole === 'owner' || member.role === 'member')) {
        const controls = folded(document, 'メンバーを管理'), reason = field(document, '管理操作の理由（任意）', 'text', 500), note = status(document);
        reason.value = target.note; reason.oninput = () => { target.note = reason.value; }; note.textContent = target.message ?? '';
        const operations = [[member.status === 'muted' ? 'unmute' : 'mute', member.status === 'muted' ? 'ミュート解除' : 'ミュート'], ['ban', '参加を禁止']];
        if (viewerRole === 'owner') operations.unshift([member.role === 'moderator' ? 'demote' : 'promote', member.role === 'moderator' ? 'モデレーターを解除' : 'モデレーターにする']);
        const actions = operations.map(([operation, label]) => button(document, label, async () => {
          if (target.busy || target.saved) return;
          target.note = reason.value;
          const normalizedNote = target.note.normalize('NFKC').trim();
          if (!confirm(`「${member.displayName}（@${member.handle}）」に「${label}」を実行しますか？\n理由: ${normalizedNote || 'なし'}`)) return;
          const key = JSON.stringify([operation, normalizedNote]);
          if (!target.ids.has(key)) target.ids.set(key, crypto.randomUUID());
          const requestId = target.ids.get(key);
          target.busy = true; lock(controls, true); target.message = note.textContent = '更新中…';
          try {
            const result = await invoke('hub_client_action', { action: `community_member_${operation}`, target: communityId, requestId, options: { profileId: member.id, note: normalizedNote } });
            const updated = result?.member, receipt = updated?.receipt;
            if (updated?.profileId !== member.id || receipt?.auditId !== requestId || receipt?.targetId !== member.id || receipt?.action !== `member_${operation}`) throw new Error('結果を確認できませんでした。メンバー一覧を更新して確認してください。');
            target.saved = true; target.result = { role: updated.role, status: updated.status };
            await reload(target);
          } catch (error) { target.message = errorText(error); }
          finally { target.busy = false; if (state.targets.get(member.id) === target) render(); }
        }));
        controls.append(reason, ...actions, note); lock(controls, target.busy); card.append(controls);
      }
      return card;
    }));
    if (!found.length) list.append(make(document, 'p', '該当するメンバーはいません', 'meta'));
    count.textContent = `${found.length}人 · ${state.page + 1} / ${pages}ページ`;
    previous.disabled = state.page === 0; next.disabled = state.page + 1 >= pages; pager.hidden = pages === 1;
  };
  const previous = button(document, '前の20人', () => { state.page--; render(); }), next = button(document, '次の20人', () => { state.page++; render(); });
  const pager = make(document, 'div', '', 'detail-form-row'); pager.append(previous, next);
  query.oninput = () => { state.query = query.value; state.page = 0; render(); };
  // 保有の多い順（オプトインした人だけが先）。資産のあるコミュニティにだけ出す。
  const sorter = holdingAsset ? make(document, 'button', '', 'head-action community-holding-sort') : null;
  if (sorter) { sorter.type = 'button'; sorter.innerHTML = coinIcon(); sorter.title = '保有の多い順'; sorter.setAttribute('aria-label', '保有の多い順'); sorter.setAttribute('aria-pressed', String(Boolean(state.byHolding))); sorter.onclick = () => { state.byHolding = !state.byHolding; state.page = 0; sorter.setAttribute('aria-pressed', String(state.byHolding)); render(); }; }
  root.append(...[query, sorter, count, list, pager].filter(Boolean)); render(); return root;
}

export function communityPollCard(document, { options, canVote, invoke, communityId, refresh, now = Date.now() }) {
  const root = make(document, 'section', '', 'detail-form'); root.setAttribute('aria-label', 'アンケート');
  const closesAt = options[0]?.closesAt, closed = closesAt && (!Number.isFinite(Date.parse(closesAt)) || Date.parse(closesAt) <= now);
  const total = options.reduce((sum, option) => sum + (Number(option.voteCount) || 0), 0), note = status(document);
  let busy = false;
  const buttons = options.map(option => {
    const item = button(document, `${option.label} · ${Number(option.voteCount) || 0}票${option.voted ? ' · 投票済み' : ''}`, async () => {
      if (busy || closed || !canVote) return;
      busy = true; lock(root, true); note.textContent = '投票中…';
      try {
        const result = await invoke('hub_client_action', { action: 'community_poll_vote', target: communityId, options: { optionId: option.optionId } });
        if (result.voted !== true) throw new Error('投票結果を確認できませんでした。');
        await refresh();
      } catch (error) { note.textContent = errorText(error); }
      finally { busy = false; lock(root, false); buttons.forEach(button => { button.disabled = Boolean(closed || !canVote); }); }
    });
    item.disabled = Boolean(closed || !canVote); item.setAttribute('aria-pressed', String(Boolean(option.voted))); return item;
  });
  root.append(...buttons, make(document, 'p', `${total}票${closed ? ' · 受付終了' : ''}${closesAt && !closed ? ' · 締切 ' + new Date(closesAt).toLocaleString('ja-JP') : ''}`, 'meta'), note); return root;
}

export function communityComposerTools(document, { communityId, invoke, refresh, textarea, kind, hasImages }) {
  const root = make(document, 'section', '', 'detail-form');
  const poll = panel(document, 'アンケート'), pollForm = make(document, 'form', '', 'detail-form');
  const question = field(document, 'アンケートの質問', 'text', 200), choices = field(document, '選択肢（1行に1つ、2〜10件）', 'textarea', 1010), hours = field(document, '締切までの時間', 'number');
  hours.min = '1'; hours.max = '720'; hours.value = '72'; const pollState = status(document); let pollBusy = false, request = null;
  const create = button(document, 'アンケートを作成', async () => {
    if (pollBusy) return;
    const labels = [...new Set(choices.value.split(/\r?\n/).map(value => value.normalize('NFKC').trim()).filter(Boolean))];
    if (!question.value.trim() || labels.length < 2 || labels.length > 10 || labels.some(label => label.length > 100) || !Number.isInteger(hours.valueAsNumber) || hours.valueAsNumber < 1 || hours.valueAsNumber > 720) { pollState.textContent = '質問、2〜10件の選択肢、1〜720時間の締切を入力してください。'; return; }
    const payload = { question: question.value.trim(), choices: labels, closesInHours: hours.valueAsNumber };
    const key = JSON.stringify(payload); if (request?.key !== key) request = { key, id: crypto.randomUUID() };
    pollBusy = true; lock(poll, true); pollState.textContent = '作成中…';
    try {
      const result = await invoke('hub_client_action', { action: 'community_poll_create', target: communityId, requestId: request.id, options: payload });
      if (!result.message?.id) throw new Error('作成結果を確認できませんでした。入力は保持しています。');
      question.value = ''; choices.value = ''; request = null; pollState.textContent = '作成しました'; await refresh();
    } catch (error) { pollState.textContent = errorText(error); }
    finally { pollBusy = false; lock(poll, false); }
  });
  pollForm.onsubmit = event => { event.preventDefault(); create.click(); }; pollForm.append(question, choices, hours, create, pollState); poll.append(pollForm);
  const schedule = panel(document, '予約投稿'), scheduleForm = make(document, 'form', '', 'detail-form'), date = field(document, '公開日時', 'datetime-local'), scheduledState = status(document); let scheduling = false, scheduleRequest = null;
  const save = button(document, '予約を確認', async () => {
    if (scheduling) return;
    const time = new Date(date.value), content = textarea.value.trim(), messageKind = kind.value;
    if (!content || hasImages() || !Number.isFinite(time.getTime()) || time.getTime() < Date.now() + 60000) { scheduledState.textContent = '本文と1分後以降の日時を入力してください。画像付きの予約には対応していません。'; return; }
    const scheduleKey = JSON.stringify([content, messageKind, time.toISOString()]); if (scheduleRequest?.key !== scheduleKey) scheduleRequest = { key: scheduleKey, id: crypto.randomUUID() };
    const preview = make(document, 'div', '', 'card'); preview.append(make(document, 'p', `公開日時: ${time.toLocaleString('ja-JP')}`, 'meta'), make(document, 'p', content, 'detail-p'));
    const submit = button(document, 'この内容で予約する', async () => {
      if (scheduling) return;
      scheduling = true; lock(schedule, true); scheduledState.textContent = '予約中…';
      try {
        const result = await invoke('hub_client_action', { action: 'community_message_schedule', target: communityId, text: content, requestId: scheduleRequest.id, options: { kind: messageKind, scheduledAt: time.toISOString() } });
        if (result.scheduled !== true) throw new Error('予約結果を確認できませんでした。入力は保持しています。');
        if (textarea.value.trim() === content) { textarea.value = ''; textarea.dispatchEvent(new document.defaultView.Event('input')); }
        scheduledState.textContent = '予約しました'; scheduleRequest = null; preview.remove();
      } catch (error) { scheduledState.textContent = errorText(error); }
      finally { scheduling = false; lock(schedule, false); }
    });
    preview.append(submit, button(document, '戻る', () => preview.remove())); schedule.querySelector('.card')?.remove(); schedule.append(preview);
  });
  scheduleForm.onsubmit = event => { event.preventDefault(); save.click(); }; scheduleForm.append(date, save, scheduledState); schedule.append(scheduleForm);
  // 開くのは片方だけ。開いたら最初の欄へ。
  root.openPanel = which => { const open = which === 'schedule' ? schedule : poll, other = open === poll ? schedule : poll; other.hidden = true; open.hidden = !open.hidden; if (!open.hidden) open.querySelector('input,textarea')?.focus?.(); };
  root.append(poll, schedule); return root;
}

export function communityMembershipControls(document,options){return communityJoinControls(document,options);}
