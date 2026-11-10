// コミュニティの見出しと「概要」（2026-11-10）。
// 見出しが持つのは 名前・人数・参加・説明・条件の錠前 だけ。概要が持つのは ルール・運営・作成日 など、見出しに無いものだけ。
// どちらも渡された値を並べるだけで、通信は呼び出し側の関数（loadRules / loadModerators）に任せる。色は意味のトークン、金は線だけ。
import { roleMark, roleView } from './role-mark.mjs';

const make = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};
const ACTIVE = ['active', 'muted'];

/** 見出しの錠前。条件つき（ゲート）か招待制のときだけ。承認制は概要に書く。 */
export function gateView(community) {
  const text = typeof community?.gate?.description === 'string' ? community.gate.description.trim().slice(0, 120) : '';
  if (text) return { kind: 'gate', label: `条件つき：${text}` };
  if (community?.gate || community?.gated === true) return { kind: 'gate', label: '条件つき' };
  if (community?.visibility === 'private') return { kind: 'private', label: '招待制' };
  return null;
}

/** 参加ボタンの状態。サーバーが返した参加状態だけで決める。 */
export function joinView({ membership, viewerStatus, visibility } = {}) {
  if (membership?.joined === true || ACTIVE.includes(viewerStatus)) return { state: 'joined', label: '参加中' };
  if (membership?.pending === true) return { state: 'pending', label: '承認待ち' };
  return { state: 'none', label: visibility === 'approval' ? '参加を申請' : '参加する' };
}

export const memberCountText = (value) => (Number.isSafeInteger(value) && value > 0 ? value.toLocaleString('en-US') : '0');

/**
 * 見出し。options: { community, join: joinView(), section: 今の面の名前（流れなら空）, icon, asset, aboutOpen, joinOpen, onJoin(), onAbout(), more: Node|null }
 * 置き場：左に顔と名前（Discord・Reddit と同じ）、右端に 参加 → 概要 → ⋯。
 */
export function createCommunityHead(document, { community = {}, join = joinView(), section = '', icon, asset, aboutOpen = false, joinOpen = false, onJoin, onAbout, more = null } = {}) {
  const root = make(document, 'header', 'community-bar community-head');
  if (section) root.classList.add('is-compact');
  const face = make(document, 'span', 'community-head-face');
  face.setAttribute('aria-hidden', 'true');
  if (community.imageUrl && asset) { const img = document.createElement('img'); img.alt = ''; asset(img, community.imageUrl); face.append(img); }
  else face.textContent = [...String(community.name ?? '')][0] ?? '';

  const main = make(document, 'div', 'community-head-main');
  const line = make(document, 'div', 'community-head-line');
  const name = make(document, 'h3', 'community-bar-title community-head-name', community.name ?? 'コミュニティ');
  line.append(name);
  const gate = gateView(community);
  if (gate) {
    const lock = make(document, 'span', 'community-head-gate');
    lock.dataset.gate = gate.kind;
    lock.setAttribute('role', 'img'); lock.setAttribute('aria-label', gate.label); lock.title = gate.label;
    lock.innerHTML = icon('lock');
    line.append(lock);
  }
  const members = make(document, 'span', 'community-head-members');
  members.setAttribute('role', 'img'); members.setAttribute('aria-label', `メンバー ${memberCountText(community.memberCount)}人`); members.title = 'メンバー';
  members.innerHTML = icon('people');
  members.append(make(document, 'span', '', memberCountText(community.memberCount)));
  line.append(members);
  if (section) line.append(make(document, 'span', 'community-head-section', section));
  main.append(line);
  if (!section && community.description) main.append(make(document, 'p', 'community-head-desc', community.description));

  const actions = make(document, 'div', 'community-head-actions');
  const joinButton = make(document, 'button', 'community-head-join');
  joinButton.type = 'button';
  joinButton.dataset.state = join.state;
  joinButton.setAttribute('data-keep-text', '');
  joinButton.setAttribute('aria-expanded', String(joinOpen));
  if (join.state === 'joined') joinButton.innerHTML = icon('check');
  joinButton.append(make(document, 'span', '', join.label));
  joinButton.onclick = () => onJoin?.();
  const aboutButton = make(document, 'button', 'community-head-about');
  aboutButton.type = 'button';
  aboutButton.innerHTML = icon('info');
  aboutButton.title = '概要'; aboutButton.setAttribute('aria-label', '概要（ルール・運営・作成日）');
  aboutButton.setAttribute('aria-expanded', String(aboutOpen));
  aboutButton.onclick = () => onAbout?.();
  actions.append(joinButton, aboutButton);
  if (more) actions.append(more);
  root.append(face, main, actions);
  return {
    root, joinButton, aboutButton,
    setAboutOpen(open) { aboutButton.setAttribute('aria-expanded', String(open)); },
    setJoinOpen(open) { joinButton.setAttribute('aria-expanded', String(open)); },
  };
}

const VISIBILITY = { public: '公開', approval: '承認制' };
/** 概要の事実の行。見出しにあるもの（名前・人数・説明・錠前の中身）は入れない。 */
export function aboutFacts(community = {}, formatDate = (value) => String(value).slice(0, 10)) {
  const facts = [];
  if (community.createdAt && Number.isFinite(Date.parse(community.createdAt))) facts.push({ key: 'created', icon: 'calendar', label: '作成日', text: formatDate(community.createdAt) });
  // 招待制は見出しの錠前が言っている。ここでは公開・承認制だけ。
  if (VISIBILITY[community.visibility] && !(community.visibility === 'private')) facts.push({ key: 'visibility', icon: 'globe', label: '参加の方法', text: VISIBILITY[community.visibility] });
  if (typeof community.category === 'string' && community.category) facts.push({ key: 'category', icon: 'title', label: '分野', text: community.category });
  if (community.governanceMode === 'dao') facts.push({ key: 'governance', icon: 'poll', label: '決め方', text: '投票' });
  return facts;
}

export const moderatorsOf = (members) => (Array.isArray(members) ? members : [])
  .filter((member) => member && roleView(member.role ?? member.communityRole) && (member.status ?? 'active') === 'active')
  .sort((a, b) => Number((b.role ?? b.communityRole) === 'owner') - Number((a.role ?? a.communityRole) === 'owner'))
  .slice(0, 12)
  .map((member) => ({ id: member.id ?? member.profileId ?? '', name: member.displayName || member.handle || 'メンバー', handle: typeof member.handle === 'string' ? member.handle : '', role: member.role ?? member.communityRole }));

/**
 * 概要の面。options: { community, icon, formatDate, loadRules() -> [{title, body}], loadModerators() -> members[], onProfile(handle), isCurrent() }
 * 読めなかった節は出さない（空の箱を置かない）。
 */
export function createCommunityAbout(document, { community = {}, icon, formatDate, loadRules, loadModerators, onProfile, isCurrent = () => true } = {}) {
  const root = make(document, 'section', 'community-about');
  root.setAttribute('aria-label', '概要');
  const heading = (iconHtml, label) => { const h = make(document, 'h4', 'community-about-head'); h.innerHTML = iconHtml; h.append(make(document, 'span', '', label)); return h; };
  const rules = make(document, 'div', 'community-about-rules'); rules.hidden = true;
  const mods = make(document, 'div', 'community-about-mods'); mods.hidden = true;
  const facts = make(document, 'ul', 'community-about-facts');
  for (const fact of aboutFacts(community, formatDate)) {
    const li = make(document, 'li', 'community-about-fact');
    li.dataset.fact = fact.key; li.title = fact.label;
    li.innerHTML = icon(fact.icon);
    const text = make(document, 'span', '', fact.text);
    text.setAttribute('aria-label', `${fact.label} ${fact.text}`);
    li.append(text);
    facts.append(li);
  }
  facts.hidden = !facts.childElementCount;
  root.append(rules, mods, facts);

  const paintRules = (list) => {
    const items = (Array.isArray(list) ? list : []).filter((rule) => rule && typeof rule.title === 'string' && rule.title).slice(0, 20);
    if (!items.length) return;
    const ol = make(document, 'ol', 'community-about-rule-list');
    for (const rule of items) {
      const li = make(document, 'li', 'community-about-rule');
      li.append(make(document, 'b', '', rule.title));
      if (typeof rule.body === 'string' && rule.body) li.append(make(document, 'span', '', rule.body));
      ol.append(li);
    }
    rules.replaceChildren(heading(icon('doc'), 'ルール'), ol);
    rules.hidden = false;
  };
  const paintMods = (members) => {
    const list = moderatorsOf(members);
    if (!list.length) return;
    const ul = make(document, 'ul', 'community-about-mod-list');
    for (const mod of list) {
      const li = make(document, 'li');
      const who = make(document, mod.handle && onProfile ? 'button' : 'span', 'community-about-mod');
      if (who.tagName === 'BUTTON') { who.type = 'button'; who.setAttribute('data-keep-text', ''); who.onclick = () => onProfile(mod.handle); }
      who.append(make(document, 'span', '', mod.name));
      const mark = roleMark(document, mod.role);
      if (mark) who.append(mark);
      li.append(who); ul.append(li);
    }
    const shield = roleMark(document, 'moderator');
    mods.replaceChildren(heading(shield?.innerHTML ?? '', '運営'), ul);
    mods.hidden = false;
  };
  const settle = (load, paint) => (load ? Promise.resolve().then(load).then((value) => { if (isCurrent()) paint(value); }, () => {}) : Promise.resolve());
  const ready = Promise.all([settle(loadRules, paintRules), settle(loadModerators, paintMods)]);
  return { root, ready };
}
