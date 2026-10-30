import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchGitBrowser} from './research-git-browser.mjs';
const projectId = 'project /日本?#', a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const commit = (oid = a, parentOids = []) => ({oid, parentOids, subject: `件名 ${oid[0]}`, committedAt: '2026-10-03T01:02:03Z'});
const history = (commits = [commit(a), commit(b)]) => ({projectId, commits});
const detail = (oid = a, parentOids = []) => ({projectId, commit: {...commit(oid, parentOids), message: '実際のコミットメッセージ\n本文'}, files: [{path: 'src/file.txt', status: 'M'}], diff: '+変更\n-旧内容', truncated: false});
const setup = () => { const dom = new JSDOM('<main></main>'); return {dom, target: dom.window.document.querySelector('main')}; };
const button = (root, label) => [...root.querySelectorAll('button')].find(item => item.textContent === label);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
function fixture({target = setup().target, oid, prepared, state = {}, ...options} = {}) {
  const reads = [];
  const view = researchGitBrowser(target, {projectId, ...(oid === undefined ? {} : {oid})}, {publicRepository: true, state, prepared, invoke: async (name, args) => { reads.push({name, args}); return args.name === 'research_git_history' ? history() : detail(args.ids[1]); }, ...options});
  return {...view, target, state, reads};
}

test('prepared history is reused, history collapse retains twenty rows and empty repository is explicit', async () => {
  const data = history(Array.from({length: 20}, (_, index) => commit(index.toString(16).padStart(40, '0'))));
  const view = fixture({prepared: data}); await view.ready;
  assert.equal(view.reads.length, 0); assert.equal(view.root.querySelectorAll('li').length, 20);
  const toggle = button(view.root, '履歴をたたむ'); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click(); assert.equal(view.root.querySelector('.research-git-history').hidden, true);
  button(view.root, '最近のコミットを表示').click(); assert.equal(view.reads.length, 0); assert.equal(view.root.querySelectorAll('li').length, 20); view.dispose();
  const empty = fixture({prepared: history([])}); await empty.ready; assert.match(empty.root.textContent, /コミットはまだありません/); empty.dispose();
});

test('prepared detail shows literal metadata, files and diff, clipped full subject, and only explicit callbacks', async () => {
  const payload = detail(a, [b]); payload.commit.subject = '😀'.repeat(120); payload.commit.message = '<script>globalThis.pwned=true</script>';
  payload.files = [{path: '<img src=x onerror=pwned=true>', status: 'R100', oldPath: '<b>旧名</b>'}]; payload.diff = '<svg onload=pwned=true>+差分'; payload.truncated = true; payload.secret = 'MUST_NOT_RENDER';
  const discussion = [], web = [], view = fixture({oid: a, prepared: payload, openDiscussion: (...args) => discussion.push(args), openWeb: value => web.push(value)}); await view.ready;
  assert.deepEqual(view.reads, [{name: 'hub_detail', args: {name: 'research_git_history', ids: [projectId]}}]);
  assert.equal(view.root.querySelectorAll('script,img,svg,b').length, 0); assert.match(view.root.textContent, /<script>/); assert.match(view.root.textContent, /<img/); assert.match(view.root.textContent, /<svg/); assert.doesNotMatch(view.root.textContent, /MUST_NOT_RENDER/);
  const heading = view.root.querySelector('h5'); assert.equal(Array.from(heading.textContent).length, 81); assert.equal(heading.title, payload.commit.subject); assert.equal(heading.getAttribute('aria-label'), payload.commit.subject);
  const children = [...view.root.querySelector('.research-git-selection').children], discuss = button(view.root, 'この変更について議論する');
  assert.ok(children.indexOf(discuss) < children.findIndex(item => item.tagName === 'PRE'));
  assert.match(view.root.textContent, /最初の親コミットとの比較/); assert.match(view.root.textContent, /一部を省略/); assert.deepEqual(discussion, []);
  discuss.click(); assert.deepEqual(discussion, [[projectId, a]]);
  const anchor = [...view.root.querySelectorAll('a')].find(item => item.textContent === 'このコミットのURL');
  assert.equal(anchor.getAttribute('href'), `/v2/research/${encodeURIComponent(projectId)}?commit=${a}#git`); anchor.click(); assert.deepEqual(web, [anchor.getAttribute('href')]); assert.ok(view.reads.every(read => read.name === 'hub_detail')); view.dispose();
});

test('fallback selection collapses history, focuses detail and follows parent without fetching history again', async () => {
  const {dom, target} = setup(), calls = [], view = fixture({target, prepared: history(), invoke: async (name, args) => { calls.push({name, args}); return detail(args.ids[1], args.ids[1] === a ? [b] : []); }}); await view.ready;
  button(view.root, `件名 a · ${a.slice(0, 12)}`).click(); await tick();
  assert.equal(dom.window.document.activeElement, view.root.querySelector('.research-git-selection')); assert.equal(view.root.querySelector('.research-git-history').hidden, true);
  button(view.root, `親コミットを見る · ${b.slice(0, 12)}`).click(); await tick();
  assert.match(view.root.querySelector('.research-git-selection').textContent, /件名 b/); assert.deepEqual(calls.map(call => call.args), [{name: 'research_git_commit', ids: [projectId, a]}, {name: 'research_git_commit', ids: [projectId, b]}]);
  button(view.root, '最近のコミットを表示').click(); assert.equal(view.root.querySelectorAll('.research-git-history li').length, 2); assert.equal(calls.length, 2); view.dispose();
});

test('external commit navigation retains entry-owned state and performs no internal detail read', async () => {
  const opened = [], state = {title: '未送信研究入力', gitDiscussion: new Map([[a, {draft: '質問の下書き'}]])}, view = fixture({prepared: history(), state, openCommit: (...args) => opened.push(args)}); await view.ready;
  button(view.root, `件名 a · ${a.slice(0, 12)}`).click(); assert.deepEqual(opened, [[projectId, a]]); assert.equal(view.reads.length, 0); assert.equal(state.title, '未送信研究入力'); assert.equal(state.gitDiscussion.get(a).draft, '質問の下書き'); view.dispose();
});

test('failed and mismatched retries retain verified history and require explicit retry', async () => {
  let attempts = 0; const view = fixture({prepared: history(), invoke: async () => { attempts++; if (attempts === 1) throw Error('network'); if (attempts === 2) return {...history(), projectId: 'other'}; return history([commit(c)]); }}); await view.ready;
  const first = button(view.root, '履歴を再読み込み'); first.click(); first.click(); await tick(); assert.equal(attempts, 1); assert.match(view.root.textContent, /読み込めません/); assert.match(view.root.textContent, /件名 a/);
  button(view.root, '履歴を再読み込み').click(); await tick(); assert.match(view.root.textContent, /一致しない/); assert.match(view.root.textContent, /件名 a/);
  button(view.root, '履歴を再読み込み').click(); await tick(); assert.match(view.root.textContent, /件名 c/); assert.doesNotMatch(view.root.textContent, /件名 a/); assert.equal(attempts, 3); view.dispose();
});

test('slow detail responses cannot replace a newer selection, including late failure', async () => {
  const old = deferred(), latest = deferred(), view = fixture({prepared: history(), invoke: (_name, args) => args.ids[1] === a ? old.promise : latest.promise}); await view.ready;
  button(view.root, `件名 a · ${a.slice(0, 12)}`).click(); button(view.root, '最近のコミットを表示').click(); button(view.root, `件名 b · ${b.slice(0, 12)}`).click();
  latest.resolve(detail(b)); await tick(); old.reject(Error('old failure')); await tick();
  const content = view.root.querySelector('.research-git-selection').textContent; assert.match(content, /件名 b/); assert.doesNotMatch(content, /件名 a|読み込めません/); assert.equal(view.state.gitBrowser.details[a], undefined); view.dispose();
});

test('dispose settles ready and blocks delayed DOM/cache updates; invalidate clears only reader scope', async () => {
  const request = deferred(), state = {documentDraft: 'KEEP', gitDiscussion: new Map([[a, {body: 'KEEP QUESTION'}]])}, view = fixture({state, invoke: () => request.promise});
  await tick(); const before = view.root.textContent; view.dispose(); await view.ready; request.resolve(history()); await tick();
  assert.equal(view.root.textContent, before); assert.equal(state.gitBrowser.history, undefined);
  const current = fixture({state, prepared: history()}); await current.ready; const staleButton = button(current.root, `件名 a · ${a.slice(0, 12)}`); current.invalidate(); staleButton.click(); await tick();
  assert.equal(current.reads.length, 0); assert.deepEqual(state.gitBrowser, {}); assert.equal(state.documentDraft, 'KEEP'); assert.equal(state.gitDiscussion.get(a).body, 'KEEP QUESTION'); assert.match(current.root.textContent, /接続が変わりました/);
});

test('private/unknown repositories do not read; privacy, login and project scope cannot restore old caches', async () => {
  const state = {documentDraft: 'KEEP', gitDiscussion: new Map()}, known = fixture({state, prepared: history()}); await known.ready; known.dispose();
  let writes = 0;
  for (const publicRepository of [false, undefined]) { const {target} = setup(), view = researchGitBrowser(target, {projectId}, {state, publicRepository, invoke: async () => { writes++; return history(); }}); await view.ready; assert.match(view.root.textContent, /公開範囲を確認できない/); assert.equal(state.gitBrowser.history, undefined); view.dispose(); }
  assert.equal(writes, 0); assert.equal(state.documentDraft, 'KEEP');
  const loggedOut = fixture({state, oid: a, prepared: detail(), signedIn: false, openDiscussion: () => { writes++; }}); await loggedOut.ready; assert.equal(button(loggedOut.root, 'この変更について議論する').disabled, true); assert.match(loggedOut.root.textContent, /ログインしてください/); loggedOut.dispose();
  const loggedIn = fixture({state, oid: b, prepared: detail(b), signedIn: true}); await loggedIn.ready; assert.equal(state.gitBrowser.details[a], undefined); loggedIn.dispose();
  const {target} = setup(), other = researchGitBrowser(target, {projectId: 'other'}, {state, publicRepository: false}); await other.ready; assert.equal(state.gitBrowser.details[b], undefined); assert.equal(state.documentDraft, 'KEEP'); other.dispose();
});

test('invalid initial OID never silently falls back; prepared mismatch is not exposed or read again', async () => {
  for (const oid of [a.toUpperCase(), a + '\n', 'invalid']) { const view = fixture({oid}); await view.ready; assert.equal(view.reads.length, 1); assert.equal(view.reads[0].args.name, 'research_git_history'); assert.match(view.root.textContent, /40桁または64桁/); view.dispose(); }
  const wrong = fixture({prepared: {...history(), projectId: 'other'}, publicRepository: undefined}); await wrong.ready; assert.equal(wrong.reads.length, 0); assert.match(wrong.root.textContent, /一致しない/); assert.doesNotMatch(wrong.root.textContent, /件名 a/); wrong.dispose();
});

test('history response limits reject oversized, duplicate, malformed metadata and nonmatching parents', async () => {
  const malformed = [history(Array.from({length: 21}, (_, index) => commit(index.toString(16).padStart(40, '0')))), history([commit(a), commit(a)]), history([{...commit(a), oid: a + '\n'}]), history([{...commit(a), parentOids: ['b'.repeat(64)]}]), history([{...commit(a), parentOids: Array(101).fill(b)}]), history([{...commit(a), committedAt: 'not-a-date'}]), history([{...commit(a), subject: 'x'.repeat(4097)}]), {...history(), ignored: 'x'.repeat(512 * 1024)}];
  for (const prepared of malformed) { const view = fixture({prepared, publicRepository: undefined}); await view.ready; assert.match(view.root.textContent, /一致しない/); assert.equal(view.reads.length, 0); view.dispose(); }
});

test('detail limits cover UTF16, UTF8 bytes, files, paths, statuses, total size and exact target', async () => {
  const invalid = [ {...detail(), projectId: 'other'}, detail(b), {...detail(), commit: {...detail().commit, message: 'x'.repeat(65537)}}, {...detail(), commit: {...detail().commit, message: '日'.repeat(22000)}}, {...detail(), files: Array(101).fill({path: 'a', status: 'A'})}, {...detail(), files: [{path: 'x'.repeat(8193), status: 'A'}]}, {...detail(), files: [{path: 'a\0b', status: 'A'}]}, {...detail(), files: [{path: 'a', oldPath: '', status: 'R100'}]}, {...detail(), files: [{path: 'a', status: 'R101'}]}, {...detail(), diff: 'x'.repeat(100001)}, {...detail(), truncated: 'yes'}, {...detail(), ignored: 'x'.repeat(512 * 1024)} ];
  for (const prepared of invalid) { const view = fixture({oid: a, prepared, publicRepository: undefined}); await view.ready; assert.match(view.root.textContent, /一致しない/); assert.equal(view.reads.length, 0); assert.equal(view.root.querySelector('pre'), null); view.dispose(); }
  const oid = 'd'.repeat(64), prepared = detail(oid, ['e'.repeat(64)]); prepared.diff = 'x'.repeat(100000); prepared.commit.message = '😀'.repeat(16384);
  const view = fixture({oid, prepared}); await view.ready; assert.equal(view.root.querySelectorAll('pre')[1].textContent.length, 100000); assert.equal(view.root.querySelectorAll('pre')[0].textContent, prepared.commit.message); view.dispose();
});

test('history prepared after returning from a detail retains its cache without confusing response shapes', async () => {
  const state = {}, selected = fixture({state, oid: a, prepared: detail()}); await selected.ready; selected.dispose();
  const returned = fixture({state, prepared: history()}); await returned.ready; assert.equal(returned.reads.length, 0); assert.match(returned.root.textContent, /履歴からコミットを選択/); assert.equal(state.gitBrowser.details[a].commit.oid, a); returned.dispose();
});

test('invalid prepared response requires one explicit public read and retains no content on 404', async () => {
  for (const selected of [undefined, a]) {
    let attempts = 0;
    const view = fixture({oid: selected, publicRepository: undefined, prepared: selected ? detail(b) : {...history(), projectId: 'other'}, invoke: async (_name, args) => {
      attempts++; assert.deepEqual(args, {name: selected ? 'research_git_commit' : 'research_git_history', ids: selected ? [projectId, selected] : [projectId]});
      if (attempts === 1) throw Error('404'); return selected ? detail(a) : history();
    }}); await view.ready;
    assert.equal(attempts, 0); assert.equal(view.root.querySelector('pre'), null); assert.doesNotMatch(view.root.textContent, /件名 a|件名 b/);
    const retry = button(view.root, '公開範囲を再確認して読み込み'); retry.click(); retry.click(); await tick();
    assert.equal(attempts, 1); assert.match(view.root.textContent, /読み込めません/); assert.equal(view.root.querySelector('pre'), null);
    retry.click(); await tick(); assert.equal(attempts, 2); assert.match(view.root.textContent, /件名 a/); assert.equal(button(view.root, '公開範囲を再確認して読み込み'), undefined); view.dispose();
  }
  const view = fixture({prepared: {...history(), projectId: 'other'}, publicRepository: true}); await view.ready;
  assert.equal(view.reads.length, 0); assert.doesNotMatch(view.root.textContent, /件名 a/); view.dispose();
});

test('authorization loss on history or detail retry removes every public cache and preserves discussion UUID pins', async () => {
  const errors = ['見つかりませんでした', 'このアカウントは停止されているか、権限がありません', 'ハブが 401 を返しています', 'desktop_not_connected'];
  for (const message of errors) for (const channel of ['history', 'detail']) {
    const pin = {requestId: 'same-uuid', review: {body: 'KEEP QUESTION'}}, map = new Map([[a, pin]]), state = {title: 'KEEP DOCUMENT', gitDiscussion: map};
    let denied = false, reads = 0;
    const view = fixture({oid: a, prepared: detail(), state, invoke: async (_name, args) => { reads++; if (denied) throw message; return args.name === 'research_git_history' ? history() : detail(a); }}); await view.ready;
    assert.ok(state.gitBrowser.history); assert.ok(state.gitBrowser.details[a]); denied = true;
    if (channel === 'history') button(view.root, '最近のコミットを表示').click();
    button(view.root, channel === 'history' ? '履歴を再読み込み' : 'このコミットを再読み込み').click(); await tick();
    assert.equal(view.root.querySelector('pre'), null); assert.doesNotMatch(view.root.textContent, /実際のコミット|件名 a|src\/file/); assert.match(view.root.textContent, /以前の表示を消しました/);
    assert.equal(state.gitBrowser.history, undefined); assert.deepEqual(state.gitBrowser.details, {}); assert.equal(state.gitBrowser.blocked, true);
    assert.equal(state.title, 'KEEP DOCUMENT'); assert.equal(state.gitDiscussion, map); assert.equal(map.get(a), pin); assert.equal(pin.requestId, 'same-uuid');
    const before = reads; view.dispose();
    const rerender = fixture({oid: a, prepared: detail(), state, invoke: async () => { reads++; return detail(); }}); await rerender.ready;
    assert.equal(reads, before); assert.equal(rerender.root.querySelector('pre'), null); assert.equal(state.gitBrowser.blocked, true);
    const retry = button(rerender.root, '公開範囲を再確認して読み込み'); retry.click(); retry.click(); await tick();
    assert.equal(reads, before + 1); assert.match(rerender.root.textContent, /実際のコミット/); assert.equal(state.gitBrowser.blocked, undefined); assert.equal(map.get(a).requestId, 'same-uuid'); rerender.dispose();
  }
});

test('authorization loss cancels a concurrent read, and denied rechecks cannot restore previously public text', async () => {
  const pending = deferred(); let phase = 'initial', reads = 0;
  const view = fixture({oid: a, prepared: detail(), invoke: async (_name, args) => {
    reads++;
    if (phase === 'initial') return history();
    if (args.name === 'research_git_history') return pending.promise;
    if (phase !== 'recovered') throw Error('見つかりませんでした');
    return detail(a);
  }}); await view.ready; phase = 'revoked';
  button(view.root, '最近のコミットを表示').click(); button(view.root, '履歴を再読み込み').click(); button(view.root, 'このコミットを再読み込み').click(); await tick();
  assert.equal(view.root.querySelector('pre'), null); assert.equal(view.state.gitBrowser.history, undefined);
  pending.resolve(history()); await tick(); assert.equal(view.state.gitBrowser.history, undefined); assert.equal(view.root.querySelector('pre'), null);
  button(view.root, '公開範囲を再確認して読み込み').click(); await tick(); assert.equal(view.root.querySelector('pre'), null); assert.equal(view.state.gitBrowser.blocked, true);
  const before = reads; phase = 'recovered'; button(view.root, '公開範囲を再確認して読み込み').click(); await tick();
  assert.equal(reads, before + 1); assert.match(view.root.textContent, /実際のコミット/); assert.equal(view.state.gitBrowser.blocked, undefined); view.dispose();
});

test('network and 503 failures retain verified content with an explicit previous-data notice', async () => {
  for (const message of ['network', 'ハブが 503 を返しています']) {
    let failed = false; const view = fixture({oid: a, prepared: detail(), invoke: async (_name, args) => { if (failed) throw Error(message); return args.name === 'research_git_history' ? history() : detail(); }}); await view.ready;
    failed = true; button(view.root, 'このコミットを再読み込み').click(); await tick(); assert.match(view.root.textContent, /前回取得したコミットを表示しています/); assert.match(view.root.textContent, /実際のコミット/); assert.equal(view.state.gitBrowser.blocked, undefined);
    button(view.root, '最近のコミットを表示').click(); button(view.root, '履歴を再読み込み').click(); await tick(); assert.match(view.root.textContent, /前回取得した履歴を表示しています/); assert.ok(view.state.gitBrowser.history); view.dispose();
  }
});

const shareProjectId='rp_'+'d'.repeat(32);
function shareDetail(oid=a,base){return {...detail(oid),projectId:shareProjectId,...(base===undefined?{}:{baseOid:base})};}
function gitShareFixture(t,{oid=a,base,prepared=shareDetail(oid,base),state={},invoke,onShare,cacheOnly=false}={}){
 const {dom,target}=setup(),f={dom,target,state,current:true,shares:[],reads:[],accepted:[]};
 const view=researchGitBrowser(target,{projectId:shareProjectId,oid,base},{publicRepository:true,signedIn:true,state,prepared:cacheOnly?undefined:prepared,isCurrent:()=>f.current,
  shareContent:async value=>{f.shares.push(value);return onShare?onShare(value):true;},
  invoke:async(name,args)=>{f.reads.push({name,args});return invoke?invoke(name,args):args.name==='research_git_history'?{projectId:shareProjectId,commits:[...new Set([oid,oid.length===40?a:'e'.repeat(64),oid.length===40?b:'f'.repeat(64)])].map(value=>commit(value))}:shareDetail(args.ids[1],args.name==='research_git_compare'?args.ids[2]:undefined);}});
 Object.assign(f,view);t.after(()=>{view.dispose();dom.window.close();});return f;
}

test('verified public Git commit and ordered comparison share only their exact 40/64 OID page reference',async t=>{
 for(const [oid,base]of [[a,undefined],['e'.repeat(64),undefined],[b,a],['e'.repeat(64),'f'.repeat(64)]]){
  const f=gitShareFixture(t,{oid,base});await f.ready;const share=button(f.root,'投稿で紹介');assert.ok(share);assert.equal(share.disabled,false);assert.deepEqual(f.shares,[]);share.click();await tick();
  assert.equal(f.shares.length,1);assert.equal(f.shares[0].href,`/v2/research/${shareProjectId}?commit=${oid}${base?`&base=${base}`:''}#git`);assert.deepEqual(Object.keys(f.shares[0]).sort(),['href','isCurrent','title']);assert.equal(f.shares[0].isCurrent(),true);
  assert.equal(f.shares[0].title.includes('コミットメッセージ'),false);assert.equal(f.shares[0].href.includes('変更'),false);assert.ok(f.reads.every(read=>read.name==='hub_detail'));
 }
});

test('pending and failed public rechecks disable Git sharing while privacy or access loss removes it',async t=>{
 for(const error of ['network','ハブが 503 を返しています','見つかりませんでした','ハブが 401 を返しています']){
  let pending;const f=gitShareFixture(t,{invoke:async(_,args)=>args.name==='research_git_history'?{projectId:shareProjectId,commits:[commit(a)]}:new Promise((_resolve,reject)=>pending=reject)});await f.ready;
  button(f.root,'このコミットを再読み込み').click();await tick();assert.equal(button(f.root,'投稿で紹介').disabled,true);button(f.root,'投稿で紹介').click();assert.deepEqual(f.shares,[]);
  pending(Error(error));await tick();const share=button(f.root,'投稿で紹介');assert.ok(!share||share.disabled);share?.click();assert.deepEqual(f.shares,[]);
 }
 const {dom,target}=setup();t.after(()=>dom.window.close());const hidden=researchGitBrowser(target,{projectId:shareProjectId,oid:a},{publicRepository:false,prepared:shareDetail(),shareContent:()=>assert.fail('Private data must not share')});await hidden.ready;assert.equal(button(hidden.root,'投稿で紹介'),undefined);hidden.dispose();
});

test('cached Git detail from an earlier mount cannot authorize sharing until a fresh public read',async t=>{
 const state={},first=gitShareFixture(t,{state});await first.ready;first.dispose();
 const next=gitShareFixture(t,{state,cacheOnly:true});await next.ready;assert.equal(button(next.root,'投稿で紹介'),undefined);button(next.root,'このコミットを再読み込み').click();await tick();assert.equal(button(next.root,'投稿で紹介').disabled,false);
});

test('slow Git sharing and saved controls cannot act after view, selection, read generation or source DOM changes',async t=>{
 for(const boundary of ['view','selection','baseline','reload','detach','delete','invalidate']){
  const pending=deferred(),f=gitShareFixture(t,{onShare:async value=>{await pending.promise;if(value.isCurrent())f.accepted.push(value.href);return value.isCurrent();}});await f.ready;
  const old=button(f.root,'投稿で紹介');old.click();old.click();assert.equal(f.shares.length,1);const source=f.shares[0];assert.equal(source.isCurrent(),true);
  if(boundary==='view')f.current=false;
  else if(boundary==='selection'){button(f.root,'最近のコミットを表示').click();button(f.root,`件名 b · ${b.slice(0,12)}`).click();await tick();}
  else if(boundary==='baseline'){button(f.root,'このコミットを比較の基準にする').click();await tick();}
  else if(boundary==='reload'){button(f.root,'このコミットを再読み込み').click();await tick();}
  else if(boundary==='detach')f.root.remove();
  else if(boundary==='delete')old.remove();
  else f.invalidate();
  assert.equal(source.isCurrent(),false,boundary);old.click();assert.equal(f.shares.length,1);pending.resolve();await tick();assert.deepEqual(f.accepted,[],boundary);
 }
});

test('malformed or mismatched Git selections never provide a share operation',async t=>{
 for(const [oid,base,prepared]of [[a,undefined,shareDetail(b)],[a,'b'.repeat(64),shareDetail(a,'b'.repeat(64))],[a.toUpperCase(),undefined,shareDetail()],[a+'\n',undefined,shareDetail()]]){
  const f=gitShareFixture(t,{oid,base,prepared});await f.ready;assert.equal(button(f.root,'投稿で紹介'),undefined);assert.deepEqual(f.shares,[]);
 }
});


