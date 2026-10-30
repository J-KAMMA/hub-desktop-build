const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const position = value => Number.isSafeInteger(value) && value >= 0;

export function createThreadStateControls(document, { thread, viewer, invoke, onRefresh = () => {}, isCurrent = () => true, readThrough = thread?.postCount }) {
  const root = document.createElement('section'); root.className = 'card detail-form'; root.setAttribute('aria-label', 'スレッドの既読・受付状態');
  const note = document.createElement('p'); note.className = 'meta'; note.setAttribute('role', 'status');
  if (!identifier(thread?.id) || !position(thread.postCount) || !['open', 'closed', 'archived'].includes(thread.status ?? 'open')) { note.textContent = 'スレッドの状態を確認できませんでした。'; root.append(note); return root; }
  if (!viewer || typeof viewer.id !== 'string' || !viewer.id || !position(viewer.lastReadPostNo)) { note.textContent = '既読の保存と受付状態の変更にはHubへの接続が必要です。'; root.append(note); return root; }
  let confirmedRead = viewer.lastReadPostNo, status = thread.status ?? 'open', busy = false;
  const title = document.createElement('p'); title.className = 'meta';
  const actions = document.createElement('div'); actions.className = 'actions';
  const button = label => { const item = document.createElement('button'); item.type = 'button'; item.className = 'head-action'; item.textContent = label; return item; };
  const read = button('ここまで既読にする'); actions.append(read);
  const close = button('受付を終了'), reopen = button('受付を再開');
  if (viewer.canManageStatus === true) actions.append(close, reopen);
  root.append(title, actions, note);
  const validRead = position(readThrough) && readThrough <= thread.postCount;
  function render() {
    title.textContent = `既読 ${confirmedRead} / ${thread.postCount} 投稿 · ${status === 'open' ? '返信受付中' : status === 'closed' ? '返信受付終了' : '過去ログ'}`;
    read.disabled = busy || !validRead || readThrough <= confirmedRead;
    close.disabled = busy || status !== 'open'; reopen.disabled = busy || status === 'open';
  }
  async function update(kind, next) {
    if (busy || !isCurrent() || kind === 'read' && (!validRead || readThrough <= confirmedRead) || kind === 'status' && (viewer.canManageStatus !== true || status === next)) return;
    busy = true; note.textContent = '保存中…'; render();
    try {
      const result = await invoke('hub_client_action', { action: kind === 'read' ? 'thread_read' : 'thread_status', target: thread.id, options: kind === 'read' ? { lastReadPostNo: readThrough } : { status: next } });
      if (!isCurrent()) return;
      if (kind === 'read') {
        const saved = result?.tracking;
        if (saved?.threadId !== thread.id || !position(saved.lastReadPostNo) || saved.lastReadPostNo < Math.max(confirmedRead, readThrough) || saved.lastReadPostNo > Math.max(thread.postCount, confirmedRead)) throw Error('保存結果を確認できませんでした。再試行してください。');
        confirmedRead = saved.lastReadPostNo;
      } else {
        if (result?.thread?.id !== thread.id || result.thread.status !== next) throw Error('保存結果を確認できませんでした。再試行してください。');
        status = next;
      }
      note.textContent = '保存しました。';
      try { await onRefresh(); } catch { if (isCurrent()) note.textContent = '保存しました。再表示できなかったため、スレッドを開き直してください。'; }
    } catch { if (isCurrent()) note.textContent = '保存結果を確認できませんでした。状態を確認して再試行してください。'; }
    finally { busy = false; if (isCurrent()) render(); }
  }
  read.onclick = () => update('read'); close.onclick = () => update('status', 'closed'); reopen.onclick = () => update('status', 'open');
  render(); return root;
}
