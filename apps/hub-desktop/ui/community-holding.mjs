// 保有の表示（2026-11-08）。コミュニティが資産を1つ決め、メンバーが自分の意思で「丸めた保有量」を名前の横に出す。
// 出すのは丸めた表示だけ（2桁・切り捨て・下限は「<0.001」）。住所・正確な残高・法定通貨換算は一切出さない。参加の条件ではない。
// 切替は本人だけ・既定はオフ。資産の設定は管理者だけ。
const make = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

/** 管理者が選べる資産。BTCメインネットが最初。資産IDはサーバーの許可リストでも再検査する。 */
export const HOLDING_ASSETS = [{ id: 'bip122:000000000019d6689c085ae165831e93/native', symbol: 'BTC' }];

/** app.js の icon() が使えない場所（メンバー一覧の部品）用の同じコインの絵。 */
export const coinIcon = () => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.6c0-1 1-1.6 2.5-1.6s2.5.6 2.5 1.6-1 1.4-2.5 1.7-2.5.7-2.5 1.7 1 1.6 2.5 1.6 2.5-.6 2.5-1.6M12 6.8V8M12 16v1.2"/></svg>';

const SHOWN = /^(<)?[0-9]{1,18}(\.[0-9]{1,18})?$/;
const SYMBOL = /^[A-Z0-9]{1,12}$/;

/** サーバーから来た {text, symbol, rank} を検査して表示用に絞る。形が違えば null（何も出さない）。 */
export function holdingView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { text, symbol } = raw;
  if (typeof text !== 'string' || typeof symbol !== 'string' || !SHOWN.test(text) || !SYMBOL.test(symbol)) return null;
  const rank = Number.isInteger(raw.rank) && raw.rank > 0 ? raw.rank : null;
  return { text, symbol, rank };
}

/** 名前の横の小さな静かな字：コインのアイコン＋「0.012 BTC」。オプトインしていない人・読めない人には何も出さない。 */
export function holdingBadge(document, holding, icon) {
  const view = holdingView(holding);
  if (!view) return null;
  const node = make(document, 'span', 'meta post-points post-holding');
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', `保有 ${view.text} ${view.symbol}`);
  node.title = `保有 ${view.text} ${view.symbol}`;
  node.innerHTML = icon('coin');
  node.append(make(document, 'span', '', `${view.text} ${view.symbol}`));
  return node;
}

/** 保有の多い順（オプトインした人だけが先、同じ丸め値は元の順）。 */
export function sortByHolding(members) {
  const key = member => holdingView(member.holding)?.rank ?? Infinity;
  return members.map((member, index) => ({ member, index })).sort((a, b) => key(a.member) - key(b.member) || a.index - b.index).map(item => item.member);
}

/**
 * コミュニティ設定の1行分。管理者は資産を選ぶ（なし／BTC）。参加中のメンバーは「保有を表示」を切り替える。
 * 文章は置かず、アイコンと短い言葉だけ。invoke は hub_detail / hub_client_action。
 */
export function communityHoldingSettings(document, { communityId, canManage, joined, invoke, icon, isCurrent = () => true }) {
  const root = make(document, 'section', 'community-holding card');
  root.setAttribute('aria-label', '保有の表示');
  const head = make(document, 'div', 'community-holding-head');
  const glyph = make(document, 'span', 'community-holding-icon'); glyph.innerHTML = icon('coin');
  head.append(glyph, make(document, 'strong', '', '保有'));
  const body = make(document, 'div', 'community-holding-body');
  const note = make(document, 'p', 'meta'); note.setAttribute('role', 'status');
  root.append(head, body, note);
  let state = null, busy = false;

  const paint = () => {
    body.replaceChildren();
    if (!state) return;
    if (canManage) {
      const select = make(document, 'select', 'community-holding-asset'); select.setAttribute('aria-label', '表示する資産');
      const none = make(document, 'option', '', 'なし'); none.value = '';
      select.append(none);
      for (const asset of HOLDING_ASSETS) { const option = make(document, 'option', '', asset.symbol); option.value = asset.id; select.append(option); }
      select.value = state.requirement?.assetId ?? '';
      select.disabled = busy;
      select.onchange = () => void send({ assetId: select.value === '' ? null : select.value });
      body.append(select);
    } else if (state.requirement) {
      body.append(make(document, 'span', 'chip', state.requirement.symbol));
    }
    if (joined && state.requirement) {
      const label = make(document, 'label', 'community-holding-toggle');
      const input = make(document, 'input'); input.type = 'checkbox'; input.checked = state.optIn === true; input.disabled = busy;
      input.setAttribute('aria-label', '保有を表示');
      input.onchange = () => void send({ optIn: input.checked });
      label.append(input, make(document, 'span', '', '保有を表示'));
      const own = holdingBadge(document, state.optIn ? state.holding : null, icon);
      if (own) label.append(own);
      body.append(label);
    }
    root.hidden = !canManage && !state.requirement;
  };

  const accept = value => {
    const requirement = value?.requirement && typeof value.requirement.assetId === 'string' && SYMBOL.test(value.requirement.symbol ?? '') ? { assetId: value.requirement.assetId, symbol: value.requirement.symbol } : null;
    state = { requirement, optIn: value?.optIn === true, holding: holdingView(value?.holding) };
  };

  async function send(options) {
    if (busy) return;
    busy = true; note.textContent = ''; paint();
    try {
      const result = await invoke('hub_client_action', { action: 'community_holding_set', target: communityId, options });
      if (!isCurrent()) return;
      accept(result);
    } catch (error) {
      if (isCurrent()) note.textContent = error?.message || '保存できませんでした。';
    } finally { busy = false; if (isCurrent()) paint(); }
  }

  const ready = (async () => {
    try { accept(await invoke('hub_detail', { name: 'community_holding', ids: [communityId] })); }
    catch { state = null; root.hidden = true; return; }
    if (isCurrent()) paint();
  })();
  root.hidden = true;
  return { root, ready, dispose() {}, invalidate() {} };
}
