import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createChannelColumn, createSharedTab, loadChannels, parseChannels, pickChannel } from './community-channels.mjs';
import {COMMUNITY_ORDERS,TOP_PERIODS,normalizeCommunityOrder,normalizeTopPeriod,orderCommunityMessages} from './community-order.mjs';
import {createCommunityHead,createCommunityAbout,joinView as communityJoinView} from './community-head.mjs';
const headGlobals={createCommunityHead,createCommunityAbout,communityJoinView,icon:()=>'',hubAsset(){}};
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const fn = (name) => { const start = source.indexOf(name), end = source.indexOf('\n}', start) + 2; assert.ok(start >= 0 && end > start); return source.slice(start, end); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(data, entry = { name: 'community', ids: ['c1'] }, { channels, canManage = false, posts = {}, rules = [], members = [] } = {}) {
  const dom = new JSDOM('<main></main>'), document = dom.window.document, opened = [], contentCalls = [], streams = [], invokes = [], live = [], navCalls = [];
  const stub = () => document.createElement('p');
  const invoke = async (name, args) => {
    invokes.push({ name, args });
    if (name === 'hub_detail' && args.name === 'community_channels') return { channels: channels ?? [{ kind: 'chat', name: '雑談' }, { kind: 'question', name: '質問' }, { kind: 'party', name: '募集' }], canManage };
    if (name === 'hub_detail' && args.name.startsWith('community_posts')) return { messages: posts[args.ids[1]] ?? [], profiles: {}, pollOptions: [], nextCursor: null };
    if (name === 'hub_detail' && args.name === 'community_members') return { communityId: 'c1', members, viewerId: 'me', viewerRole: 'member', canManage: false };
    if (name === 'hub_detail' && args.name === 'community_onboarding') return { community: { id: 'c1' }, rules, questions: [] };
    return {};
  };
  const c = vm.createContext({...headGlobals,COMMUNITY_ORDERS,TOP_PERIODS,normalizeCommunityOrder,normalizeTopPeriod,orderCommunityMessages, document, window: dom.window, detailRenderRevision: 1, researchAccountGeneration: 1, currentView: 'detail', detailTrail: [entry], researchEditorOptions: () => ({ invoke }), connectDesktopAccount() {}, renderDetailEntry() {},
    openDetail: (...a) => opened.push(a), communityMembershipControls: () => { const root = document.createElement('div'); const b = document.createElement('button'); b.textContent = '参加する'; root.append(b); return { root, ready: Promise.resolve(), dispose() {}, invalidate() {} }; },
    invoke, friendlyError: String, createCommunityPoints: () => ({ own: Object.assign(stub(), { className: 'points-own' }), toggle: [], ranking: Object.assign(document.createElement('div'), { className: 'points-ranking' }), ready: Promise.resolve() }),
    createCommunityContentTabs: (options) => { contentCalls.push(options); const root = document.createElement('div'); root.className = `content-${options.type}`; return { root, ready: Promise.resolve(), dispose() {}, invalidate() {} }; },
    openCommunityContent() {}, skeletonResult: stub, retryButton: () => document.createElement('button'), emptyState: stub,
    renderCommunityStream: (host, streamData, _entry, ctx) => { streams.push(ctx); host.replaceChildren(Object.assign(document.createElement('div'), { className: `stream-for-${ctx.kind ?? 'all'}`, textContent: String((streamData.messages ?? []).length) })); return { dispose() {} }; },
    communityMemberControls: (_doc, options) => Object.assign(document.createElement('section'), { className: 'member-controls', textContent: String(options.members.length) }),
    createChannelColumn, createSharedTab, loadChannels, parseChannels, pickChannel,
    navCommunities: { setCurrent: (id, items) => navCalls.push({ id, items }) }, subscribeGroup: (options) => { live.push(options); return { stop() { options.stopped = true; } }; }, railChat: { isOpen: false } });
  for (const name of ['function detailSection(title, nodes) {', 'const COMMUNITY_SECTIONS = [', 'function communitySection(entry) {', 'function communitySectionItems(entry) {', 'function selectCommunitySection(entry, key) {', 'function mountCommunityStream(host, entry, holder, ownerCurrent, mode = {}) {', 'function communityPreferenceControls(data,entry) {', 'function renderCommunityDetail(target, data, entry) {']) vm.runInContext(fn(name), c);
  const target = document.querySelector('main');
  entry.data = data;
  const controller = c.renderCommunityDetail(target, data, entry);
  return { dom, document, target, opened, contentCalls, streams, invokes, live, entry, c, controller, invoke, navCalls };
}
const member = { community: { id: 'c1', name: 'ひろば', visibility: 'public', category: '雑談', memberCount: 12, description: '何でも話す場所' }, viewerId: 'me', viewerStatus: 'active', membership: { joined: true, pending: false } };
// 外側の左の列の1本の一覧（チャンネル → 共有 → メンバー）。navCommunities に渡された最後の項目を、1つの入れ物に並べて返す。
const side = (f) => { const host = f.document.createElement('div'); for (const item of f.navCalls.at(-1)?.items ?? []) { if (item.node) host.append(item.node); else { const b = f.document.createElement('button'); b.textContent = item.label; b.dataset.section = item.key; b.setAttribute('aria-current', String(Boolean(item.selected))); host.append(b); } } return host; };
const keys = (f) => Array.from(f.navCalls.at(-1)?.items ?? [], (item) => item.key);

test('the header holds name, members, join, description and (only when gated) a lock; 参加 → 概要 → ⋯ sit at its right end', async (t) => {
  const f = mount(member); t.after(() => f.dom.window.close());
  await f.controller.ready;
  assert.equal(f.target.querySelector('.card'), null);
  assert.equal(f.target.querySelector('.community-sections'), null);
  assert.equal(f.target.querySelectorAll('.community-head').length, 1);
  const head = f.target.querySelector('.community-head');
  assert.equal(head.querySelector('.community-head-name').textContent, 'ひろば');
  assert.equal(head.querySelector('.community-head-members').getAttribute('aria-label'), 'メンバー 12人');
  assert.equal(head.querySelector('.community-head-desc').textContent, '何でも話す場所');
  assert.equal(head.querySelector('.community-head-gate'), null, 'a public community shows no lock');
  assert.equal(f.target.querySelector('h2'), null);
  const direct = [...head.querySelectorAll('.community-head-actions > button, .community-head-actions summary')];
  assert.deepEqual(direct.map((b) => b.getAttribute('aria-label') ?? b.textContent), ['参加中', '概要（ルール・運営・作成日）', 'その他の操作']);
  assert.equal(head.querySelector('.community-head-join').dataset.state, 'joined');
  // ⋯ は管理・ガイド・設定だけ。名前や説明をもう一度出さない。
  const menu = f.target.querySelector('.community-more-list');
  assert.doesNotMatch(menu.textContent, /何でも話す場所|ひろば/);
  assert.deepEqual([...menu.querySelectorAll('.community-more-item')].map((b) => b.textContent), ['自分の異議申立て', 'ガイド', '設定']);
  assert.equal(f.target.querySelector('.points-own'), null);
  const gated = mount({ ...member, community: { ...member.community, gate: { description: 'GOHO を 100 以上' } } }); t.after(() => gated.dom.window.close());
  assert.equal(gated.target.querySelector('.community-head-gate').getAttribute('aria-label'), '条件つき：GOHO を 100 以上');
  const invite = mount({ ...member, community: { ...member.community, visibility: 'private' } }); t.after(() => invite.dom.window.close());
  assert.equal(invite.target.querySelector('.community-head-gate').getAttribute('aria-label'), '招待制');
});

test('参加 opens the join steps right under the header (and starts them for a newcomer); a member only gets the panel with 退出', async (t) => {
  const guest = mount({ ...member, viewerStatus: undefined, membership: { joined: false, pending: false } }); t.after(() => guest.dom.window.close());
  const button = guest.target.querySelector('.community-head-join');
  assert.equal(button.textContent, '参加する'); assert.equal(button.dataset.state, 'none'); assert.equal(button.getAttribute('aria-expanded'), 'false');
  const panel = guest.target.querySelector('.community-head-join-panel');
  assert.equal(panel.hidden, true);
  let started = 0;
  panel.querySelector('button').addEventListener('click', () => { started++; });
  button.click();
  assert.equal(panel.hidden, false); assert.equal(button.getAttribute('aria-expanded'), 'true'); assert.equal(started, 1);
  assert.equal(panel.previousElementSibling, guest.target.querySelector('.community-head'));
  button.click();
  assert.equal(panel.hidden, true); assert.equal(started, 1);
  assert.equal(guest.entry.headPanels.join, false);
  const approval = mount({ ...member, viewerStatus: undefined, membership: { joined: false, pending: true }, community: { ...member.community, visibility: 'approval' } }); t.after(() => approval.dom.window.close());
  assert.equal(approval.target.querySelector('.community-head-join').textContent, '承認待ち');
});

test('概要 opens under the header with rules, moderators and the created date, and never repeats the header', async (t) => {
  const about = { ...member, community: { ...member.community, createdAt: '2026-03-14T09:00:00.000Z' } };
  const f = mount(about, { name: 'community', ids: ['c1'] }, { rules: [{ id: 'r1', title: '場所を書く', body: '集合場所は先頭に', required: 1 }], members: [{ id: 'u1', displayName: 'まとめ役', handle: 'matome', role: 'owner', status: 'active' }, { id: 'u2', displayName: 'ふつう', handle: 'futsu', role: 'member', status: 'active' }] });
  t.after(() => f.dom.window.close());
  await f.controller.ready;
  const button = f.target.querySelector('.community-head-about'), panel = f.target.querySelector('.community-head-about-panel');
  assert.equal(panel.hidden, true); assert.equal(panel.childElementCount, 0, 'nothing is read until it is opened');
  assert.equal(f.invokes.some((call) => call.args?.name === 'community_onboarding'), false);
  button.click();
  await tick(); await tick();
  assert.equal(panel.hidden, false); assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...panel.querySelectorAll('.community-about-rule b')].map((n) => n.textContent), ['場所を書く']);
  assert.deepEqual([...panel.querySelectorAll('.community-about-mod')].map((n) => n.textContent), ['まとめ役']);
  assert.ok(panel.querySelector('.community-about-mod .role-mark-owner'));
  assert.ok(panel.querySelector('[data-fact="created"]'));
  assert.doesNotMatch(panel.textContent, /ひろば|何でも話す場所|12/, 'name, description and member count stay in the header');
  assert.equal(panel.querySelector('button.community-head-join, .community-head-join'), null);
  // 開いたままを覚える（描き直しても開いている）。もう一度押すと閉じる。
  assert.equal(f.entry.headPanels.about, true);
  button.click();
  assert.equal(panel.hidden, true);
});

test('the outer left column: under the community row only 共有 and メンバー (guests: no メンバー); the sort is not there; legacy section names map onto them', async (t) => {
  const f = mount(member); t.after(() => f.dom.window.close());
  await f.controller.ready;
  assert.deepEqual(keys(f), ['shared', 'members']);
  assert.equal(f.navCalls.at(-1).items.some((item) => item.selected), false, 'on the stream the community row itself is the current item');
  assert.equal(f.navCalls.at(-1).id, 'c1');
  const rows = side(f);
  assert.deepEqual([...rows.querySelectorAll(':scope > button')].map((b) => b.textContent), ['共有', 'メンバー']);
  assert.equal(rows.querySelector('.community-channel'), null, 'no channel rows');
  assert.equal(f.target.querySelector('.community-channels'), null);
  const guest = mount({ ...member, viewerId: null, viewerStatus: undefined, membership: undefined }); t.after(() => guest.dom.window.close());
  await guest.controller.ready;
  assert.deepEqual(keys(guest), ['shared']);
  assert.deepEqual([...guest.target.querySelectorAll('.community-more-list .community-more-item')].map((b) => b.textContent), ['ガイド']);
  for (const [asked, expect, kind] of [['posts', 'chat'], ['article', 'shared', 'article'], ['video', 'shared', 'video'], ['music', 'shared', 'music'], ['content', 'shared', 'article'], ['members', 'members']]) {
    const g = mount(member, { name: 'community', ids: ['c1'], section: asked }); t.after(() => g.dom.window.close());
    await g.controller.ready;
    assert.equal(g.entry.section, expect, asked);
    assert.equal(g.navCalls.at(-1).items.filter((item) => item.selected).length, expect === 'chat' ? 0 : 1, 'at most one row is selected');
    if (expect !== 'chat') assert.equal(g.navCalls.at(-1).items.find((item) => item.key === expect).selected, true);
    // どの面でも見出しの名前はコミュニティの名前。流れ以外では面の名前を横に添え、説明は出さない。
    assert.equal(g.target.querySelector('.community-head-name').textContent, 'ひろば');
    assert.equal(g.target.querySelector('.community-head-section')?.textContent ?? '', expect === 'chat' ? '' : expect === 'shared' ? '共有' : 'メンバー');
    assert.equal(Boolean(g.target.querySelector('.community-head-desc')), expect === 'chat');
  }
});

test('チャット: one stream for the whole community; the type chips only filter it and no channel is fixed', async (t) => {
  const f = mount(member, { name: 'community', ids: ['c1'] }, { posts: { question: [{ id: 'q1' }, { id: 'q2' }] } }); t.after(() => f.controller.dispose?.() ?? f.dom.window.close());
  await f.controller.ready;
  const last = f.streams.at(-1);
  assert.equal(last.kind, undefined); assert.equal(last.chat, true);
  assert.equal(JSON.stringify(f.invokes.filter((call) => call.args?.name?.startsWith('community_posts')).map((call) => [call.args.name, call.args.ids])), JSON.stringify([['community_posts', ['c1']]]));
  assert.equal(f.invokes.some((call) => call.args?.name === 'community_channels'), false, 'channel list is not read');
  assert.equal(f.live.length, 1);
  assert.equal(JSON.stringify(f.live[0].group), JSON.stringify({ kind: 'public', id: 'c1' }));
});

test('共有: kind chips 記事 / 動画 / 音楽 / 共同ページ; the first three use the content list, 共同ページ is the guide post stream', async (t) => {
  const f = mount(member, { name: 'community', ids: ['c1'], section: 'shared' }); t.after(() => f.controller.dispose?.() ?? f.dom.window.close());
  await f.controller.ready;
  assert.deepEqual([...f.target.querySelectorAll('.community-shared-kinds button')].map((b) => b.textContent), ['記事', '動画', '音楽', '共同ページ']);
  assert.equal(f.contentCalls.at(-1).type, 'article');
  f.target.querySelector('.community-shared-kinds [data-kind="video"]').click();
  assert.equal(f.contentCalls.at(-1).type, 'video');
  assert.equal(f.entry.sharedKind, 'video');
  f.target.querySelector('.community-shared-kinds [data-kind="guide"]').click();
  await tick(); await tick();
  assert.equal(f.target.querySelector('.community-shared-body .stream-for-guide') !== null, true);
  assert.equal(f.streams.at(-1).kind, 'guide'); assert.equal(f.streams.at(-1).chat, false);
  assert.equal(f.target.querySelector('.community-channels'), null);
  assert.equal(side(f).querySelector('.community-channel[aria-pressed="true"]'), null, 'no channel is selected while 共有 is open');
});

test('メンバー: points and the member list live here, not in the header', async (t) => {
  const f = mount(member, { name: 'community', ids: ['c1'], section: 'members' }); t.after(() => f.dom.window.close());
  await f.controller.ready;
  assert.ok(f.target.querySelector('.points-own')); assert.ok(f.target.querySelector('.points-ranking'));
  assert.ok(f.target.querySelector('.community-members .member-controls'));
  assert.equal(f.target.querySelector('.card .points-own'), null);
});

test('設定 opens from the ⋯ menu', (t) => {
  const f = mount(member); t.after(() => f.dom.window.close());
  [...f.target.querySelectorAll('.community-more-item')].find((b) => b.textContent === '設定').click();
  assert.equal(f.entry.section, 'settings');
});
