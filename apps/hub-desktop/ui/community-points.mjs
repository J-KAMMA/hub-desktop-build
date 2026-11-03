// コミュニティの会員ポイント（コミュニティのトークン保有量。ハブ側がサーバー検証済みの残高から出した値だけ）。
// 自分の値は常に見える。他の会員の値は、その会員が「ポイントを公開する」を選んだときだけ一覧に出る（既定は非公開）。
// 値が null のときは「—」。ウォレットのアドレスはこの画面に渡ってこないし、渡ってきても描かない。
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[^A-Za-z0-9_:-]/u.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const points = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
const make = (document, tag, label = '', className = '') => { const node = document.createElement(tag); node.textContent = label; node.className = className; return node; };
export const pointsLabel = (value) => (Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString('ja-JP')}点` : '—');

/** 自分の値と設定。ハブの応答は { enabled, points, isPublic }（ポイントの設定が無いコミュニティは enabled:false）。 */
export function parseOwnPoints(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error('points_invalid');
  if (typeof value.enabled !== 'boolean' || typeof value.isPublic !== 'boolean' || !points(value.points ?? null)) throw Error('points_invalid');
  return { enabled: value.enabled, points: value.points ?? null, isPublic: value.isPublic };
}

/** 公開を選んだ会員の順位。アドレスなど他の項目は取り込まない。 */
export function parseRanking(value) {
  const own = parseOwnPoints(value);
  const list = value.members === undefined ? [] : value.members;
  if (!Array.isArray(list) || list.length > 50) throw Error('points_invalid');
  const members = list.map((item) => {
    if (item === null || typeof item !== 'object' || !id(item.profileId) || !text(item.displayName, 200) || !(item.handle === null || text(item.handle, 100)) || !points(item.points ?? null)) throw Error('points_invalid');
    return { profileId: item.profileId, displayName: item.displayName, handle: item.handle ?? '', points: item.points ?? null };
  });
  const next = value.nextCursor ?? null;
  if (next !== null && !(typeof next === 'string' && next.length <= 160 && /^[0-9]{1,16}\.[A-Za-z0-9_:-]{1,100}$/u.test(next))) throw Error('points_invalid');
  return { ...own, members, nextCursor: next };
}

/**
 * 3つの部品（自分の値・公開の切り替え・順位）が1回の読み込みを共有する。
 * 失敗や参加していない場合は何も出さない（ポイントは付け足しの情報で、画面を壊さない）。
 */
export function createCommunityPoints({ document, communityId, invoke, isCurrent = () => true }) {
  const state = { own: null, members: [], nextCursor: null, busy: false, error: '', loaded: false };
  const own = make(document, 'p', '', 'meta community-points-own'); own.hidden = true;
  const toggleRow = make(document, 'label', '', 'detail-form-row community-points-toggle'); toggleRow.hidden = true;
  const checkbox = make(document, 'input'); checkbox.type = 'checkbox'; checkbox.checked = false;
  toggleRow.append(checkbox, make(document, 'span', 'ポイントを公開する'));
  const toggleNote = make(document, 'p', '', 'meta'); toggleNote.setAttribute('role', 'status'); toggleNote.hidden = true;
  const ranking = make(document, 'section', '', 'card community-points-ranking'); ranking.hidden = true;
  ranking.setAttribute('aria-label', 'ポイントを公開しているメンバー');
  const list = make(document, 'ol', '', 'community-points-list');
  const more = make(document, 'button', 'さらに表示', 'head-action'); more.type = 'button'; more.hidden = true;
  ranking.append(make(document, 'h3', 'ポイントの順位'), make(document, 'p', 'ポイントを公開したメンバーだけが並びます。', 'meta'), list, more);

  function paint() {
    const enabled = Boolean(state.own?.enabled);
    own.hidden = !enabled;
    toggleRow.hidden = !state.own;
    toggleRow.hidden = !enabled;
    toggleNote.hidden = !state.error;
    toggleNote.textContent = state.error;
    ranking.hidden = !enabled;
    if (enabled) {
      own.textContent = `あなたのポイント: ${pointsLabel(state.own.points)}`;
      checkbox.checked = state.own.isPublic === true;
      checkbox.disabled = state.busy;
      more.hidden = !state.nextCursor; more.disabled = state.busy;
      list.replaceChildren(...state.members.map((member) => {
        const row = make(document, 'li', '', 'community-points-row'); row.dataset.profileId = member.profileId;
        row.append(make(document, 'span', member.displayName, 'community-points-name'), make(document, 'span', member.handle ? ` @${member.handle} ` : ' ', 'meta'), make(document, 'strong', pointsLabel(member.points)));
        return row;
      }));
      if (!state.members.length) list.replaceChildren(make(document, 'li', state.own.isPublic ? 'まだ公開しているメンバーはいません' : 'ポイントを公開しているメンバーはいません', 'meta'));
    }
  }

  async function load(cursor = null) {
    if (!id(communityId)) return;
    try {
      const raw = cursor
        ? await invoke('hub_detail', { name: 'community_points_list_page', ids: [communityId, cursor] })
        : await invoke('hub_detail', { name: 'community_points_list', ids: [communityId] });
      if (!isCurrent()) return;
      const next = parseRanking(raw);
      state.own = { enabled: next.enabled, points: next.points, isPublic: next.isPublic };
      const seen = new Set(cursor ? state.members.map((member) => member.profileId) : []);
      state.members = [...(cursor ? state.members : []), ...next.members.filter((member) => !seen.has(member.profileId))];
      state.nextCursor = next.nextCursor; state.loaded = true; state.error = '';
    } catch {
      if (!isCurrent()) return;
      if (!cursor) { state.own = null; state.members = []; state.nextCursor = null; }
      else state.error = '読み込めませんでした。';
    }
    paint();
  }

  checkbox.addEventListener('change', async () => {
    if (state.busy || !state.own?.enabled || !isCurrent()) { checkbox.checked = state.own?.isPublic === true; return; }
    const wanted = checkbox.checked; state.busy = true; state.error = ''; paint();
    try {
      const result = await invoke('hub_client_action', { action: 'community_points_public', target: communityId, options: { public: wanted } });
      if (!isCurrent()) return;
      if (result === null || typeof result !== 'object' || result.public !== wanted) throw Error('points_unconfirmed');
      state.busy = false;
      await load();
    } catch {
      if (!isCurrent()) return;
      state.busy = false; state.error = '設定を変えられませんでした。'; checkbox.checked = state.own?.isPublic === true; paint();
    }
  });
  more.addEventListener('click', async () => {
    if (state.busy || !state.nextCursor) return;
    state.busy = true; paint(); const cursor = state.nextCursor;
    try { state.busy = false; await load(cursor); } finally { state.busy = false; paint(); }
  });
  const ready = load();
  return { own, toggle: [toggleRow, toggleNote], ranking, ready, reload: () => load(), state };
}
