export function renderBrowserPrivacy({ document, host, button, invoke, refresh, report, tabs }) {
  const element = document.createElement('section');
  element.className = 'browser-tools';
  element.setAttribute('aria-label', 'ブラウザーのプライバシー');
  host.append(element);
  const live = () => element.isConnected && !host.hidden;
  const ranges = new Map([['hour', ['過去1時間', 3600000]], ['day', ['過去24時間', 86400000]], ['all', ['すべて', null]]]);
  let range = 'hour', confirmation = null, pending = false, message = '';
  const line = text => { const node = document.createElement('p'); node.className = 'browser-menu-empty'; node.textContent = text; return node; };
  function site() {
    const rows = typeof tabs === 'function' ? tabs() : tabs;
    const tab = Array.isArray(rows) ? rows.find(row => row?.active === true) : null;
    if (!tab || tab.private !== false || !Number.isSafeInteger(tab.id) || tab.id <= 0) return null;
    try {
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname === 'jkamma.com' || url.hostname.endsWith('.jkamma.com') || url.hostname === 'tauri.localhost' || url.origin === document.location?.origin) return null;
      return { id: tab.id, origin: url.origin };
    } catch { return null; }
  }
  function control(label, run, disabled = false) {
    const node = button(label, () => { if (live() && element.contains(node) && !node.disabled) return run(); }); node.disabled = pending || disabled; return node;
  }
  async function act(command, args, success) {
    if (pending || !live()) return;
    pending = true; confirmation = null; message = ''; render();
    try {
      await invoke(command, args);
      message = success;
      try { await refresh(); } catch { message += ' 表示を更新できませんでした。'; }
    } catch {
      message = '操作を完了できませんでした。対象を確認して、もう一度操作してください。';
      report?.(new Error(message));
    } finally { pending = false; render(); }
  }
  function previewHistory() {
    if (pending || !ranges.has(range)) return;
    const [label, duration] = ranges.get(range);
    confirmation = { type: 'history', range, label, since: duration === null ? null : Date.now() - duration };
    message = ''; render();
  }
  function previewSite() {
    if (pending) return;
    const target = site();
    if (!target) return;
    confirmation = { type: 'site', ...target }; message = ''; render();
  }
  function confirm(expected) {
    if (pending || confirmation !== expected) return;
    if (expected.type === 'history') {
      if (range !== expected.range) return;
      return act('browser_clear_history', { since: expected.since }, '選択した期間の閲覧履歴を削除しました。');
    }
    const current = site();
    if (!current || current.id !== expected.id || current.origin !== expected.origin) {
      confirmation = null; message = '表示中のサイトが変わりました。対象をもう一度確認してください。'; render(); return;
    }
    return act('browser_clear_site_data', { origin: expected.origin }, '選択したサイトのデータを削除しました。');
  }
  function render() {
    element.replaceChildren();
    element.setAttribute('aria-busy', String(pending));
    element.append(line('プライバシー'), control('プライベートタブを開く', () => act('browser_new_private_tab', { url: null }, 'プライベートタブを開きました。')));
    element.append(line('プライベートタブの閲覧履歴とタブの復元情報は保存しません。明示的に保存したブックマークとダウンロードは残ります。通信先や回線の管理者に対する匿名性は保証しません。'));
    const label = document.createElement('label'); label.textContent = '閲覧履歴の期間';
    const select = document.createElement('select'); select.setAttribute('aria-label', '削除する閲覧履歴の期間'); select.disabled = pending;
    for (const [value, [text]] of ranges) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
    select.value = range;
    select.onchange = () => { if (pending) return; range = select.value; confirmation = null; message = ''; render(); };
    label.append(select); element.append(label, control('閲覧履歴の削除を確認', previewHistory));
    const current = site();
    element.append(line(current ? `表示中の通常タブ: ${current.origin}` : 'サイトデータの削除は、通常タブでWebサイトを表示しているときに使えます。'), control('このサイトのデータの削除を確認', previewSite, !current));
    if (confirmation) {
      const expected = confirmation;
      const preview = document.createElement('div'); preview.className = 'browser-permission-request'; preview.setAttribute('aria-label', '削除内容の確認');
      preview.append(line(expected.type === 'history' ? `${expected.label}のブラウザー閲覧履歴を削除します。元に戻せません。ブックマークと保存済みファイルは残ります。` : `${expected.origin} のブラウザー内のサイトデータを削除します。ログアウトやサイト設定のリセットが起こります。同じドメインで共有するCookieを使う関連サイトもログアウトする場合があります。元に戻せません。Hubアプリのアカウント情報は削除しません。`));
      preview.append(control('キャンセル', () => { if (pending || confirmation !== expected) return; confirmation = null; render(); }), control('確認した内容を削除', () => confirm(expected)));
      element.append(preview);
    }
    if (pending || message) { const status = line(pending ? '操作結果を確認しています…' : message); status.setAttribute('role', 'status'); element.append(status); }
  }
  render();
  return { element, update: () => { confirmation = null; render(); } };
}
