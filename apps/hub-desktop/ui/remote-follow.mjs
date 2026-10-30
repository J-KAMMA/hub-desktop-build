// 他のハブの人を @名前@ハブ でフォローする欄と、他のハブの人（影のプロフィール）の判定。
// 宛先は hub_client の閉じた動詞 follow_remote と読み取り remote_follows だけ。
// ここでは handle の形を軽く確かめるだけで、最終の検査は Rust 側（remote_follow_action）とハブが行う。

const STATE_LABEL = { accepted: 'フォロー中', pending: '承認待ち', rejected: '断られました' };

export function remoteFollowStateLabel(state) {
  return STATE_LABEL[state] ?? '不明';
}

// 影のプロフィールの handle は user@host（長いときは r~ で始まる乱数）。ローカルの handle には @ も ~ も入らない。
export function isRemoteProfile(data) {
  if (data?.isRemote === true) return true;
  const handle = data?.profile?.handle;
  return typeof handle === 'string' && (handle.includes('@') || handle.startsWith('r~'));
}

export function normalizeRemoteHandle(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^@/u, '');
  const at = text.indexOf('@');
  if (at < 1 || at !== text.lastIndexOf('@') || text.length > 320) return null;
  const name = text.slice(0, at);
  const host = text.slice(at + 1);
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(name) || !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/u.test(host) || !host.includes('.')) return null;
  return `@${text}`;
}

export function remoteFollowForm({ document, invoke, friendlyError = (error) => String(error?.message ?? error) }) {
  const root = document.createElement('div');
  root.className = 'detail-form remote-follow';
  const label = document.createElement('p');
  label.className = 'meta';
  label.textContent = '他のハブの人をフォロー（@名前@ハブ）';
  const row = document.createElement('div');
  row.className = 'detail-form-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '@name@hub.example';
  input.maxLength = 320;
  input.setAttribute('aria-label', '他のハブの人をフォロー（@名前@ハブ）');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'head-action';
  button.textContent = 'フォロー';
  const status = document.createElement('p');
  status.className = 'meta';
  status.setAttribute('role', 'status');
  const list = document.createElement('ul');
  list.className = 'remote-follow-list';
  row.append(input, button);
  root.append(label, row, status, list);

  async function refresh() {
    try {
      const result = await invoke('hub_client', { name: 'remote_follows' });
      const follows = Array.isArray(result?.follows) ? result.follows : [];
      list.replaceChildren(...follows.slice(0, 100).map((item) => {
        const li = document.createElement('li');
        li.textContent = `${String(item.displayName ?? item.handle)} @${String(item.handle)} — ${remoteFollowStateLabel(item.state)}`;
        return li;
      }));
    } catch {
      // 一覧は補助。フォロー自体は動く。
    }
  }

  button.onclick = async () => {
    const handle = normalizeRemoteHandle(input.value);
    if (!handle) { status.textContent = 'ユーザー名は @名前@ホスト の形で入力してください。'; return; }
    button.disabled = true;
    status.textContent = '';
    try {
      const result = await invoke('hub_client_action', { action: 'follow_remote', options: { handle } });
      status.textContent = result?.state === 'accepted'
        ? `${result.displayName ?? handle} をフォローしました。`
        : 'フォローを申し込みました（承認待ち）。相手が承認すると投稿が届きます。';
      input.value = '';
      await refresh();
    } catch (error) {
      status.textContent = friendlyError(error);
    } finally {
      button.disabled = false;
    }
  };

  return { root, input, button, status, list, refresh };
}
