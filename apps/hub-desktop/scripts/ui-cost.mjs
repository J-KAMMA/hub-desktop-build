// Hub Desktop UI cost meter (Fitts + Hick). Measurement only; never edits UI.
// Usage: node apps/hub-desktop/scripts/ui-cost.mjs [--probe <view>] [--task <n>]
import {chromium} from 'playwright';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, '../ui');
const repo = path.resolve(here, '../../..');
const origin = 'http://127.0.0.1:9878';
const VW = 1280, VH = 800;
const args = process.argv.slice(2);
const only = args.includes('--task') ? Number(args[args.indexOf('--task') + 1]) : null;

const authors = [['青井 田中', 'aoi', '夕方の港を歩いてきました。風が気持ちよかったです。'], ['風トリオ', 'kaze', '新しい曲の録音が終わりました。来週公開します！'], ['夜ふくろう', 'owl', '今日の作業メモ：配色を見直して、カードの角を少し丸くした。']];
const posts = authors.map(([n, h, b], i) => ({id: 'p' + i, body: b, createdAt: '2026-11-0' + (4 - i) + 'T09:00:00.000Z', authorHandle: h, displayName: n, authorName: n, authorProfileId: 'u' + i, tags: [], likeCount: [12, 48, 7][i], replyCount: [2, 3, 0][i], repostCount: [1, 5, 1][i]}));

function installMock() {
  const P = arguments[0];
  window.__invokeLog = [];
  window.__TAURI__ = {event: {listen: async () => () => {}}, core: {invoke: async (name, a = {}) => {
    window.__invokeLog.push(name + ':' + (a && (a.name || a.resource || a.action || a.filter) || ''));
    if (['desktop_account_status', 'poll_desktop_account'].includes(name)) return {state: 'registered', deviceId: 'd', keyThumbprint: 'a'.repeat(43)};
    if (name === 'hub_origin') return 'https://synthetic.invalid';
    if (name === 'desktop_build_mode') return 'development';
    if (name === 'browser_tab_overlay') return null;
    if (name === 'music_tracks') return {tracks: ['夜明けのピアノ', '港の風', 'Neon Rain', '静かな月'].map((t, i) => ({id: 'aaaaaaaa-aaaa-4aaa-8aaa-00000000000' + i, title: t, artist: ['青井', '風トリオ'][i % 2], album: 'Album ' + (i % 2)})), works: []};
    if (name === 'hub_resource') {
      if (a.resource === 'music') return {works: [{id: 'yt-1', title: 'Outside (Official)', artist: 'Out Artist', services: [{provider: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'}]}]};
      return {resources: []};
    }
    if (name === 'hub_client') {
      if (a.name === 'me' || a.name === 'me_summary') return {profile: {id: 'viewer', handle: 'fixture', displayName: 'Fixture'}};
      if (/^community_rankings/.test(a.name || '')) return {groups: [{id: 'g1', name: '港の散歩部', description: '夕方の港を歩く会です。', joined: true, memberCount: 24, visibility: 'public', updatedAt: '2026-11-05T09:00:00.000Z'}, {id: 'g2', name: '作業メモ', description: '制作の記録', joined: true, memberCount: 8, visibility: 'public', updatedAt: '2026-11-04T09:00:00.000Z'}]};
      if (a.name === 'federated_feed') return {items: []};
      if (/notif/i.test(a.name || '')) return {items: [0, 1, 2].map(i => ({id: 'n' + i, kind: 'like', read: false, createdAt: '2026-11-0' + (4 - i) + 'T09:00:00.000Z', actorName: P[i][0], actorHandle: P[i][1], title: P[i][0] + 'さんがいいねしました', body: P[i][2], href: ''})), notifications: [0, 1, 2].map(i => ({id: 'n' + i, kind: 'like', read: false, createdAt: '2026-11-0' + (4 - i) + 'T09:00:00.000Z', title: P[i][0] + 'さんがいいねしました'})), unreadCount: 3};
      return null;
    }
    if (name === 'hub_social_stream') {
      const items = a.filter === 'post' || a.filter === 'all' ? window.__posts.map(p => ({kind: 'post', id: p.id, createdAt: p.createdAt, origin: 'https://synthetic.invalid', payload: p})) : [1, 2, 3].map(i => ({kind: 'thread', id: 't' + i, createdAt: '2026-11-01T00:00:00.000Z', origin: 'https://synthetic.invalid', payload: {id: 't' + i, title: 'テストスレッド ' + i, boardKey: 'board', postCount: 3, threadType: 'discussion', status: 'open', updatedAt: '2026-11-01T00:00:00.000Z'}}));
      return {version: 1, filter: a.filter, scope: a.scope, viewerId: 'v', signedIn: true, items, hasMore: false, nextCursor: null, failures: []};
    }
    if (name === 'hub_detail' && a.name === 'notification_snapshot') return {viewerId: 'viewer', unreadCount: 2, actors: P.map((x, i) => ({id: 'u' + i, displayName: x[0], handle: x[1]})), threadPostDestinations: {}, communityMessageDestinations: {}, notifications: [0, 1, 2].map(i => ({id: 'n' + i, isRead: i === 2, type: ['social_reply', 'followed', 'social_reaction'][i], text: [P[0][0] + 'さんが返信しました', P[1][0] + 'さんがフォローしました', P[2][0] + 'さんがいいねしました'][i], createdAt: '2026-11-0' + (6 - i) + 'T09:00:00.000Z', actorProfileId: 'u' + i, targetType: 'post', targetId: 'p0'}))};
    if (name === 'hub_detail' && a.name === 'dm_snapshot') return {currentProfileId: 'viewer', messageCount: 2, profiles: [{id: 'u0', displayName: P[0][0], handle: P[0][1]}, {id: 'u1', displayName: P[1][0], handle: P[1][1]}], conversations: [0, 1].map(i => ({id: 'c' + i, participantIds: ['viewer', 'u' + i], isE2ee: false, verificationStatus: 'unverified', fingerprint: 'x', unreadCountByProfileId: {viewer: 1 - i}, lastMessageAt: '2026-11-0' + (6 - i) + 'T09:00:00.000Z'})), messages: [0, 1].map(i => ({id: 'm' + i, conversationId: 'c' + i, senderProfileId: 'u' + i, previewText: 'こんにちは' + i, encryptedPayload: 'x', encryptionVersion: 'plaintext-v1', encryptionState: 'sealed', createdAt: '2026-11-0' + (6 - i) + 'T09:00:00.000Z'}))};
    if (name === 'hub_client_action') return {viewerId: 'viewer', conversationId: a.target, unreadCount: 0};
    if (name === 'hub_detail' && a.name === 'community') return {viewerId: 'viewer', viewerStatus: 'active', canManage: false, viewerRole: 'member', membership: {joined: true, pending: false}, community: {id: a.ids[0], name: '港の散歩部', description: '夕方の港を歩く会です。', memberCount: 24, visibility: 'public', category: '趣味'}};
    if (name === 'hub_detail' && a.name === 'community_channels') return {channels: [{kind: 'chat', name: '雑談'}, {kind: 'question', name: '質問'}, {kind: 'party', name: '募集'}], canManage: false};
    if (name === 'hub_detail' && /^community_posts/.test(a.name)) return {messages: [{id: 'cm1', body: 'こんにちは、はじめまして', createdAt: '2026-11-05T09:00:00.000Z', authorProfileId: 'u0', kind: 'chat', communityId: 'g1'}], profiles: {u0: {id: 'u0', displayName: '青井 田中', handle: 'aoi'}}, viewerProfileId: 'viewer', canPost: true, viewerId: 'viewer', viewerStatus: 'active', hasMore: false, nextCursor: null};
    if (name === 'hub_feed') return {posts: window.__posts, signedIn: true, hasMore: false};
    if (['dev_history', 'dev_agents', 'list_games', 'pi_work_list'].includes(name)) return [];
    if (['workspace', 'dev_workspace'].includes(name)) return '';
    return null;
  }}};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function openPage(browser) {
  const page = await browser.newPage({viewport: {width: VW, height: VH}});
  page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 200)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { await route.abort(); return; }
    const p = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try {
      const body = await readFile(path.join(ui, p));
      await route.fulfill({body, contentType: /\.(mjs|js)$/.test(p) ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.svg') ? 'image/svg+xml' : 'text/html'});
    } catch { await route.fulfill({status: 404, body: ''}); }
  });
  await page.addInitScript(p => { window.__posts = p.posts; }, {posts});
  await page.addInitScript(installMock, authors);
  await page.goto(origin);
  await sleep(1800);
  return page;
}

// Visible clickable elements inside a region (null = whole viewport). Returns [{sel,label,box}].
const CLICKABLE = 'button, a[href], [role=button], [role=tab], [role=menuitem], [role=link], input, textarea, select, summary, [tabindex]:not([tabindex="-1"]), [data-view], [data-action]';
async function clickables(page, regionSel) {
  return page.evaluate(([sel, region]) => {
    const root = region ? document.querySelector(region) : document.body;
    if (!root) return [];
    const out = [];
    for (const el of root.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none' || +cs.opacity === 0) continue;
      if (el.disabled) continue;
      out.push({label: (el.getAttribute('aria-label') || el.title || el.textContent || el.id || el.className || '').trim().replace(/\s+/g, ' ').slice(0, 40), box: [r.left, r.top, r.width, r.height]});
    }
    return out;
  }, [CLICKABLE, regionSel]);
}

if (args.includes('--probe')) {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const page = await openPage(browser);
  const region = args[args.indexOf('--probe') + 1];
  const list = await clickables(page, region === 'all' ? null : region);
  for (const c of list) console.log(c.box.map(Math.round).join(','), '|', c.label);
  if (args.includes('--html')) console.log(await page.evaluate(sel => document.querySelector(sel)?.outerHTML.slice(0, 6000), args[args.indexOf('--html') + 1]));
  await browser.close();
  process.exit(0);
}
export {clickables, VW, VH, sleep, repo, only};

// --familiarity: measure where each conventional action sits (region, rank, region size, visible text)
// and its expert step from the centre, then add the first-use familiarity term (ui-familiarity.mjs).
// The expert task model below is untouched; results.json keeps its numbers.
if (args.includes('--familiarity')) {
  const F = await import('./ui-familiarity.mjs');
  const {conventions} = F;
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const regionOrder = ['dialog', 'card', 'rail', 'toolbar', 'sidebar', 'rightRail'];
  const measure = async (page, css) => {
    const loc = page.locator(css).first();
    await loc.waitFor({state: 'visible', timeout: 5000});
    return loc.evaluate((el, [sel, regions, order]) => {
      const visible = c => { const r = c.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.left > innerWidth || r.top > innerHeight) return false; const cs = getComputedStyle(c); return !(cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none' || +cs.opacity === 0 || c.disabled); };
      let region = 'other', root = document.body;
      for (const k of order) { if (!regions[k]) continue; const r = el.closest(regions[k]); if (r) { region = k; root = r; break; } }
      const items = [...root.querySelectorAll(sel)].filter(visible).map(c => [c, c.getBoundingClientRect()]).sort((a, b) => a[1].top - b[1].top || a[1].left - b[1].left);
      const rank = items.findIndex(([c]) => c === el || c.contains(el) || el.contains(c)) + 1;
      const b = el.getBoundingClientRect();
      const text = (el.innerText || el.value || el.placeholder || '').trim();
      return {region, rank, n: items.length, labelVisible: text.length > 0, box: [b.left, b.top, b.width, b.height]};
    }, [CLICKABLE, conventions.regions, regionOrder]);
  };
  const geom = m => { const cx = m.box[0] + m.box[2] / 2, cy = m.box[1] + m.box[3] / 2; const D = Math.hypot(cx - VW / 2, cy - VH / 2); const W = Math.min(m.box[2], m.box[3]); return {distance: Math.round(D), width: Math.round(W), fittsId: +Math.log2(D / W + 1).toFixed(3)}; };
  const rows = [];
  const base = await openPage(browser);
  const regionSize = {};
  for (const [k, sel] of Object.entries(conventions.regions)) if (sel) regionSize[k] = await base.evaluate(([s, c]) => { const r = document.querySelector(s); return r ? [...r.querySelectorAll(c)].filter(x => { const b = x.getBoundingClientRect(); return b.width >= 2 && b.height >= 2 && b.top < innerHeight && getComputedStyle(x).display !== 'none'; }).length : 0; }, [sel, CLICKABLE]);
  for (const a of conventions.actions) {
    let page = base;
    if (a.setup) { page = await openPage(browser); for (const s of a.setup) { await page.locator(s).first().click({timeout: 4000}); await sleep(900); } }
    try {
      const m = await measure(page, a.css);
      const g = geom(m);
      rows.push({id: a.id, ja: a.ja, weight: a.weight, conv: a.conv, el: {region: m.region, rank: m.rank, n: m.n, iconMatch: a.iconMatch, labelVisible: m.labelVisible}, box: m.box.map(Math.round), ...g, hickBits: +Math.log2(m.n + 1).toFixed(3)});
      if (m.region === 'dialog') regionSize.dialog = m.n;
    } catch (e) { rows.push({id: a.id, ja: a.ja, status: 'unreachable', reason: String(e.message || e).split('\n')[0].slice(0, 160)}); }
    if (page !== base) await page.close();
  }
  const geometry = {};
  for (const p of conventions.proposals) if (p.geometryCss) geometry[p.id] = geom(await measure(base, p.geometryCss)); else if (p.geometryBox) geometry[p.id] = geom({box: p.geometryBox});
  await browser.close();
  const ok = rows.filter(r => !r.status);
  const now = F.applyProposals(ok, regionSize);
  const shares = F.FAM.shares;
  const cur = F.totals(now.rows);
  const byId = Object.fromEntries(conventions.proposals.map(p => [p.id, p]));
  const proposals = conventions.proposals.map(p => {
    const before = (p.after || []).map(id => byId[id]);
    const b = F.applyProposals(ok, regionSize, before, geometry);
    const a = F.applyProposals(ok, regionSize, [...before, p], geometry);
    const tb = F.totals(b.rows), ta = F.totals(a.rows);
    const delta = Object.fromEntries(Object.keys(tb).map(k => [k, +(ta[k] - tb[k]).toFixed(2)]));
    return {id: p.id, ja: p.ja, after: p.after || [], delta};
  });
  const out = {viewport: [VW, VH], constants: conventions.constants, meanPractice: +F.meanPractice().toFixed(3), regionSize, rows: now.rows, unreachable: rows.filter(r => r.status), totals: cur, proposals};
  for (const r of now.rows) console.log(r.id.padEnd(14), r.el.region.padEnd(8), 'rank', String(r.el.rank).padStart(2) + '/' + r.el.n, 'expert', r.expert.toFixed(2), 'first', r.firstUse.toFixed(2), 'w', r.weight);
  for (const r of out.unreachable) console.log('UNREACHABLE', r.id, r.reason);
  console.log('totals', JSON.stringify(cur), 'meanPractice', out.meanPractice);
  for (const p of proposals) console.log('proposal', p.id, JSON.stringify(p.delta));
  if (!args.includes('--no-write')) { await writeFile(path.join(repo, 'docs/hub-desktop-ui-cost/familiarity.json'), JSON.stringify(out, null, 2)); console.log('wrote familiarity.json'); }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Cost model. Coefficients and weights below are ASSUMPTIONS, not measurements
// of the owner's behaviour. Geometry (D, W, n) is measured from the real UI.
// ---------------------------------------------------------------------------
const COEF = {base: 0.1, fitts: 0.15, hick: 0.15};
const stepSeconds = s => COEF.base + COEF.fitts * s.fittsId + COEF.hick * s.hickBits;

const FEED = '#view-feed article';
const nav = (view, label) => ({label: label + ' (左端のアイコン列)', css: '.icon-rail [data-view="' + view + '"]'});

const TASKS = [
  {id: 1, name: 'タイムラインで投稿にいいね', weight: 10, setup: [], steps: [
    {label: '1件目の「いいね」', css: FEED + ' [aria-label="いいね"]', region: 'card'},
  ]},
  {id: 2, name: '投稿に返信する', weight: 5, setup: [], steps: [
    {label: '1件目の「返信」', css: FEED + ' [aria-label="返信"]', region: 'card'},
    {label: '返信欄(自動フォーカスなら省略)', css: FEED + ' .post-reply textarea', skipIfFocused: true, typing: true},
    {label: '返信を送る(Ctrl+Enter)', key: 'Control+Enter', afterTyping: '返信テスト'},
  ]},
  {id: 3, name: '新しい投稿を書く', weight: 4, setup: [], steps: [
    {label: '「投稿する」', css: '.icon-rail [aria-label="投稿する"]'},
    {label: '入力欄(自動フォーカスなら省略)', css: '#post-compose-dialog[open] .uc-body', skipIfFocused: true, typing: true},
    {label: 'ポスト(Ctrl+Enter)', key: 'Control+Enter', afterTyping: '投稿テスト'},
  ]},
  {id: 4, name: '通知を開き最新の1件を開く', weight: 6, setup: [], steps: [
    nav('notifications', '通知'),
    {label: '最新の通知(アイコン横の一覧の1行目)', css: '.notif-pop-row', wait: 1200},
  ]},
  {id: 5, name: 'DMを開き直近の会話へ送信', weight: 6, setup: [], steps: [
    nav('messages', 'メッセージ'),
    {label: '直近の会話(自動選択なら省略)', css: '.sidebar button:has-text("青井 田中")', ifMissing: '#thread-input'},
    {label: '入力欄(自動フォーカスなら省略)', css: '#thread-input', skipIfFocused: true, typing: true, wait: 1200},
    {label: '送信(Enter)', key: 'Enter', afterTyping: 'こんにちは'},
  ]},
  {id: 6, name: '検索(上部バー)', weight: 4, setup: [], steps: [
    {label: '検索欄', css: '#toolbar-search-form input', typing: true},
    {label: 'Enterで検索', key: 'Enter', afterTyping: '港'},
  ]},
  {id: 7, name: '参加コミュニティを開きチャンネルに投稿', weight: 3, setup: [], steps: [
    {label: 'サイドバー「コミュニティ」', css: '.sidebar button:has-text("コミュニティ")'},
    {label: '「参加中」(選択済みなら省略)', css: '.sidebar button:has-text("参加中")', skipIfSelected: true},
    {label: 'コミュニティのカード', css: '.community-card', wait: 1500},
    {label: '入力欄(自動フォーカスなら省略)', css: '#view-detail [aria-label^="メッセージ"]', skipIfFocused: true, typing: true},
    {label: '投稿(Enter送信)', key: 'Enter', afterTyping: 'はじめまして'},
  ]},
  {id: 8, name: '音楽を1曲再生', weight: 3, setup: [], steps: [
    nav('music', '音楽'),
    {label: '曲を押して再生', css: '#view-music [aria-label$="を再生"]'},
  ]},
  {id: 9, name: 'ブラウザでWebページを開く', weight: 3, setup: [], steps: [
    {label: 'ブラウザ (右端のアイコン列。左の列からは外した)', css: '.rail-marks [data-rail-view="browser"]'},
    {label: 'アドレス欄(右のブラウザ)', css: '#rb-address', typing: true},
    {label: 'Enterで開く', key: 'Enter', afterTyping: 'example.com'},
  ]},
  {id: 10, name: '投稿を翻訳', weight: 2, setup: [], steps: [
    {label: '1件目の「翻訳」', css: FEED + ' [aria-label="翻訳"]', region: 'card'},
  ]},
  {id: 11, name: '投稿をブックマーク', weight: 2, setup: [], steps: [
    {label: '1件目の「ブックマーク」', css: FEED + ' [aria-label="ブックマーク"]', region: 'card'},
  ]},
  {id: 12, name: '深い画面からタイムラインへ戻る', weight: 5, setup: [
    {css: FEED + ' .post-body'},
  ], steps: [
    {label: '戻る', css: '[aria-label="タイムラインに戻る"]'},
  ]},
];

async function regionCount(loc, region) {
  return loc.evaluate((el, [sel, region]) => {
    let root;
    if (region === 'card') root = el.closest('article') || document.body;
    else {
      root = el.closest('form, nav, aside, header, [role=dialog], main') || document.body;
    }
    let n = 0;
    for (const c of root.querySelectorAll(sel)) {
      const r = c.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      const cs = getComputedStyle(c);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none' || +cs.opacity === 0 || c.disabled) continue;
      n++;
    }
    return n;
  }, [CLICKABLE, region]);
}

async function runTask(browser, task) {
  const page = await openPage(browser);
  const out = {id: task.id, name: task.name, weight: task.weight, steps: [], status: 'ok'};
  try {
    for (const s of task.setup) { await page.locator(s.css).first().click({timeout: 4000}); await sleep(1000); }
    let pointer = [VW / 2, VH / 2];
    const skip = (rec, why) => { rec.skipped = why; rec.seconds = 0; rec.fittsId = 0; rec.hickBits = 0; out.steps.push(rec); };
    for (const s of task.steps) {
      const rec = {label: s.label, typing: !!(s.typing || s.afterTyping), kind: s.key ? 'key' : 'click'};
      if (s.key) {
        if (s.afterTyping) await page.keyboard.type(s.afterTyping);
        await page.keyboard.press(s.key);
        Object.assign(rec, {box: null, distance: 0, width: null, fittsId: 0, n: 0, hickBits: 0});
        rec.seconds = +stepSeconds(rec).toFixed(3);
        out.steps.push(rec); await sleep(700); continue;
      }
      if (s.ifMissing && await page.locator(s.ifMissing).first().isVisible().catch(() => false)) { skip(rec, '既に出ている'); continue; }
      const loc = page.locator(s.css).first(); if (s.afterTyping && s.typeInto) { await page.locator(s.typeInto).first().fill(s.afterTyping); await sleep(250); }
      await loc.waitFor({state: 'visible', timeout: 5000});
      if (s.skipIfSelected && await loc.evaluate(el => el.getAttribute('aria-current') === 'true')) { skip(rec, '選択済み'); continue; }
      if (s.skipIfFocused && await loc.evaluate(el => document.activeElement === el)) { skip(rec, '自動フォーカス済み'); continue; }
      const b = await loc.boundingBox();
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const D = Math.hypot(cx - pointer[0], cy - pointer[1]);
      const W = Math.min(b.width, b.height);
      const n = await regionCount(loc, s.region);
      Object.assign(rec, {box: [b.x, b.y, b.width, b.height].map(Math.round), distance: Math.round(D), width: Math.round(W), fittsId: +Math.log2(D / W + 1).toFixed(3), n, hickBits: +Math.log2(n + 1).toFixed(3)});
      
      rec.seconds = +stepSeconds(rec).toFixed(3);
      await loc.click({timeout: 4000, noWaitAfter: true});
      pointer = [cx, cy];
      if (s.typing) await page.keyboard.type('テスト');
      out.steps.push(rec);
      await sleep(s.wait || 700);
    }
  } catch (e) {
    out.status = 'unreachable';
    out.reason = '[' + (out.steps.length + 1) + '] ' + String(e.message || e).split(String.fromCharCode(10))[0].slice(0, 200);
  }
  await page.close();
  const counted = out.steps.filter(s => !s.skipped);
  out.stepCount = counted.length;
  out.sumFitts = +counted.reduce((a, s) => a + s.fittsId, 0).toFixed(3);
  out.sumHick = +counted.reduce((a, s) => a + s.hickBits, 0).toFixed(3);
  const widths = counted.filter(s => s.width).map(s => s.width);
  out.minTarget = widths.length ? Math.min(...widths) : null;
  out.seconds = +counted.reduce((a, s) => a + s.seconds, 0).toFixed(3);
  out.weighted = +(out.seconds * task.weight).toFixed(3);
  return out;
}

async function main() {
const browser = await chromium.launch({channel: 'msedge', headless: true});
const results = [];
for (const t of TASKS) {
  if (only && t.id !== only) continue;
  const r = await runTask(browser, t);
  results.push(r);
  console.log(r.id, r.name, r.status, r.status === 'ok' ? 'steps=' + r.stepCount + ' fitts=' + r.sumFitts + ' hick=' + r.sumHick + ' min=' + r.minTarget + ' t=' + r.seconds : r.reason);
  if (r.status === 'ok') console.log(r.steps.map(s => '   ' + s.label + ' | ' + (s.skipped || ('D=' + s.distance + ' W=' + s.width + ' n=' + s.n + ' ID=' + s.fittsId))).join(String.fromCharCode(10)));
}
await browser.close();
if (!only) {
  const dir = path.join(repo, 'docs/hub-desktop-ui-cost');
  await mkdir(dir, {recursive: true});
  await writeFile(path.join(dir, 'results.json'), JSON.stringify({viewport: [VW, VH], coefficients: COEF, note: 'coefficients and weights are assumptions', tasks: results}, null, 2));
  console.log('wrote results.json');
}
}
if (!process.env.UICOST_LIB) await main();
