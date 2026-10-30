import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {initNativeGitHub} from './research-github.mjs';
const require = createRequire(process.env.HUB_NATIVE_TEST_PACKAGE || new URL('./package.json', import.meta.url));
const {JSDOM} = require('jsdom');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const href = 'https://github.com/example/project';
const empty = status => ({status, repository: null, issues: null, pullRequests: null, commits: null, categoryStatuses: {issues: status, pullRequests: status, commits: status}});
const dto = () => ({status: 'ok', repository: {name: 'example/project', href, description: '<img src=x onerror=alert(1)>', defaultBranch: 'main', stars: 0},
  issues: [{number: 1, title: '<script>literal</script>', href: href + '/issues/1'}], pullRequests: [{number: 2, title: '提案', href: href + '/pull/2'}],
  commits: [{oid: 'a'.repeat(40), title: '40桁', href: href + '/commit/' + 'a'.repeat(40)}, {oid: 'b'.repeat(64), title: '64桁', href: href + '/commit/' + 'b'.repeat(64)}],
  categoryStatuses: {issues: 'ok', pullRequests: 'ok', commits: 'ok'}});
function fixture(t, options = {}) {
  const dom = new JSDOM('<main></main>'); t.after(() => dom.window.close());
  const document = dom.window.document, host = document.querySelector('main'), reads = [], shares = [], opened = [];
  const scope = {origin: 'https://hub.example', key: 'actor', epoch: 1}; let live = true;
  const {asyncContext, ...callbacks} = options;
  const panel = initNativeGitHub({document, host, getContext: asyncContext ? async () => ({...scope}) : () => ({...scope}),
    isCurrent: captured => live && (!captured || ['origin', 'key', 'epoch'].every(key => captured[key] === scope[key])),
    readRepository: async name => { reads.push(name); return dto(); }, onShare: item => { shares.push(item); return true; }, openReference: value => { opened.push(value); }, ...callbacks});
  t.after(() => panel.dispose());
  const input = panel.root.querySelector('input');
  const edit = value => { input.value = value; input.dispatchEvent(new dom.window.Event('input', {bubbles: true})); };
  return {...panel, document, input, edit, scope, reads, shares, opened, setLive(value) { live = value; }, window: dom.window};
}
const shareButtons = f => [...f.root.querySelectorAll('button')].filter(button => button.textContent === '投稿で紹介');

test('original links forward left, modified and middle activation with exact 40/64 references and a live boolean guard', async t => {
  for (const width of [40,64]) for (const [type,options] of [['click',{}],['click',{ctrlKey:true}],['click',{metaKey:true}],['click',{shiftKey:true}],['auxclick',{button:1}]]) {
    const calls=[],f=fixture(t,{openReference:(...args)=>calls.push(args)});await f.open();f.edit('example/project');await f.read();
    const target=href+'/commit/'+(width===40?'a':'b').repeat(width),link=[...f.root.querySelectorAll('a')].find(link=>link.href===target);
    const event=new f.window.MouseEvent(type,{bubbles:true,cancelable:true,...options});link.dispatchEvent(event);await tick();
    assert.equal(event.defaultPrevented,true);assert.equal(calls.length,1);assert.equal(calls[0][0],target);assert.equal(calls[0][1],event);assert.equal(calls[0][2](),true);
    f.setLive(false);assert.equal(calls[0][2](),false);
  }
});

test('right-button auxiliary activation preserves the native context menu without navigation', async t => {
  const f=fixture(t);await f.open();f.edit('example/project');await f.read();
  const link=f.root.querySelector('a'),event=new f.window.MouseEvent('auxclick',{button:2,bubbles:true,cancelable:true});link.dispatchEvent(event);await tick();
  assert.equal(event.defaultPrevented,false);assert.equal(f.opened.length,0);
});

test('middle navigation loses authority when actor/input/view changes during the asynchronous scope check', async t => {
  for (const change of [f=>{f.scope.key='other actor';},f=>f.edit('example/other'),f=>f.setLive(false)]) {
    const wait=deferred();let paused=false,f;f=fixture(t,{getContext:()=>paused?wait.promise:Promise.resolve({...f.scope})});
    await f.open();f.edit('example/project');await f.read();const captured={...f.scope};paused=true;
    f.root.querySelector('a').dispatchEvent(new f.window.MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));await tick();
    change(f);paused=false;wait.resolve(captured);await tick();assert.equal(f.opened.length,0);
  }
});

test('removed or rewritten original links reject pending navigation and its captured callback', async t => {
  for(const change of [link=>link.remove(),link=>link.parentElement.remove(),link=>link.href='https://github.com/example/other']){
    const wait=deferred();let paused=false,f;f=fixture(t,{getContext:()=>paused?wait.promise:Promise.resolve({...f.scope})});
    await f.open();f.edit('example/project');await f.read();const link=f.root.querySelector('a'),captured={...f.scope};paused=true;
    link.dispatchEvent(new f.window.MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));await tick();change(link);paused=false;wait.resolve(captured);await tick();assert.equal(f.opened.length,0);
  }
  const calls=[],f=fixture(t,{openReference:(...args)=>calls.push(args)});await f.open();f.edit('example/project');await f.read();
  const link=f.root.querySelector('a');link.click();await tick();assert.equal(calls[0][2](),true);link.remove();assert.equal(calls[0][2](),false);
});

test('open focuses a labelled input; keyboard form submit is explicit, busy, canonical, literal and callback-only', async t => {
  const wait = deferred(), reads = [], f = fixture(t, {readRepository: name => { reads.push(name); return wait.promise; }});
  assert.equal(f.root.hidden, true); assert.equal(reads.length, 0); assert.equal(await f.read(), false);
  await f.open(); assert.equal(f.document.activeElement, f.input); assert.equal(f.root.querySelector('label').htmlFor, f.input.id);
  assert.equal(f.input.type, 'text'); assert.equal(f.input.maxLength, 180); assert.ok(f.document.getElementById(f.input.getAttribute('aria-describedby')));
  f.edit('https://github.com/EXAMPLE/Project');
  f.root.querySelector('form').dispatchEvent(new f.window.Event('submit', {cancelable: true}));
  assert.equal(f.root.getAttribute('aria-busy'), 'true'); assert.equal(f.root.querySelector('[type=submit]').disabled, true);
  assert.equal(await f.read(), false); await tick(); assert.deepEqual(reads, ['example/project']);
  wait.resolve(dto()); await tick(); assert.equal(f.root.getAttribute('aria-busy'), 'false');
  assert.equal(f.root.querySelectorAll('script,img,svg').length, 0); assert.match(f.root.textContent, /<script>literal<\/script>/);
  assert.equal(f.root.querySelectorAll('a').length, 5); assert.equal(shareButtons(f).length, 5);
  for (const link of f.root.querySelectorAll('a')) link.click();
  for (const button of shareButtons(f)) button.click(); await tick();
  assert.deepEqual(f.opened, [href, href + '/issues/1', href + '/pull/2', href + '/commit/' + 'a'.repeat(40), href + '/commit/' + 'b'.repeat(64)]);
  assert.deepEqual(f.shares.map(item => item.href), f.opened); assert.ok(f.shares.every(item => item.isCurrent()));
});

test('editing input revokes old links and offered scope; late old success/failure never overwrite newer result', async t => {
  const requests = [deferred(), deferred(), deferred()], f = fixture(t, {readRepository: () => requests.shift().promise});
  const first = requests[0], second = requests[1], third = requests[2]; await f.open(); f.edit('example/project'); const one = f.read(); await tick();
  f.edit('example/project'); const two = f.read(); second.resolve(dto()); assert.equal(await two, true);
  const oldLink = f.root.querySelector('a'), oldShare = shareButtons(f)[0]; oldShare.click(); await tick(); const offer = f.shares[0];
  first.resolve(dto()); assert.equal(await one, false); assert.equal(f.root.querySelectorAll('a').length, 5);
  f.edit('example/other'); assert.equal(oldLink.getAttribute('href'), null); assert.equal(offer.isCurrent(), false); oldLink.click(); oldShare.click();
  const three = f.read(); third.reject(Error('private error content')); assert.equal(await three, false);
  assert.equal(f.opened.length, 0); assert.equal(f.shares.length, 1); assert.equal(f.root.querySelectorAll('a').length, 0);
  assert.doesNotMatch(f.root.textContent, /private error content/);
});

test('actor, origin, epoch, view, close, disconnect and dispose reject pending results', async t => {
  for (const change of [f => { f.scope.key = 'other'; }, f => { f.scope.origin = 'https://another.example'; }, f => { f.scope.epoch++; }, f => f.setLive(false), f => f.close(), f => f.root.remove(), f => f.dispose()]) {
    const wait = deferred(), f = fixture(t, {readRepository: () => wait.promise}); await f.open(); f.edit('example/project'); const work = f.read(); await tick(); change(f);
    wait.resolve(dto()); assert.equal(await work, false); assert.equal(f.root.querySelectorAll('a').length, 0);
  }
});

test('sharing retains a scope callback and busy state; late failures do not replace a newly accepted result', async t => {
  const wait = deferred(), offers = [], f = fixture(t, {onShare: offer => { offers.push(offer); return wait.promise; }});
  await f.open(); f.edit('example/project'); await f.read(); const button = shareButtons(f)[0]; button.click(); button.click();
  await tick(); assert.equal(offers.length, 1); assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-busy'), 'true');
  f.edit('example/project'); await f.read(); assert.equal(offers[0].isCurrent(), false);
  wait.reject(Error('private callback cause')); await tick(); assert.match(f.root.textContent, /公開情報を取得しました/);
  assert.doesNotMatch(f.root.textContent, /private callback cause|紹介先を開けません/); assert.equal(f.root.querySelectorAll('a').length, 5);
});

test('account and Hub events clear accepted references; silent scope change also invalidates on activation', async t => {
  for (const event of ['hub-account-changed', 'hub-origin-changed', null]) {
    const f = fixture(t); await f.open(); f.edit('example/project'); await f.read(); const link = f.root.querySelector('a'), share = shareButtons(f)[0];
    if (event) f.window.dispatchEvent(new f.window.Event(event)); else f.scope.key = 'new actor';
    share.click(); link.click(); await tick(); assert.equal(f.root.querySelectorAll('a').length, 0); assert.equal(f.shares.length, 0); assert.equal(f.opened.length, 0);
  }
  const f = fixture(t); await f.open(); f.edit('example/project'); await f.read(); f.scope.epoch++; await f.open(); assert.equal(f.root.querySelectorAll('a').length, 0);
  f.setLive(false); assert.equal(await f.open(), false);
});

test('partial, rate limit and unavailable are distinct without claiming a private repository is public', async t => {
  for (const status of ['partial', 'rate_limited', 'unavailable']) {
    const data = status === 'partial' ? dto() : empty(status);
    if (status === 'partial') { data.status = status; data.issues = null; data.categoryStatuses.issues = 'unavailable'; data.commits = null; data.categoryStatuses.commits = 'rate_limited'; }
    const f = fixture(t, {readRepository: async () => data}); await f.open(); f.edit('example/project'); await f.read();
    assert.match(f.root.textContent, status === 'partial' ? /一部の一覧/ : status === 'rate_limited' ? /取得制限に達し/ : /公開情報を取得できません/);
    assert.equal(f.root.querySelectorAll('a').length, status === 'partial' ? 2 : 0);
    f.root.querySelector('form button[type="button"]').click(); await tick(); assert.deepEqual(f.opened, [href]);
  }
});

test('malformed source, URLs, bounded metadata, list sizes, identifiers and status combinations fail closed', async t => {
  const mutations = [
    data => { data.repository.name = 'other/project'; }, data => { data.repository.href = 'https://github.com/example/other'; },
    data => { data.repository.private = true; }, data => { data.repository.description = 'x'.repeat(1001); }, data => { data.repository.defaultBranch = 'x'.repeat(129); },
    data => { data.repository.stars = -1; }, data => { data.repository.stars = Number.MAX_SAFE_INTEGER + 1; },
    data => { data.issues[0].number = 0; }, data => { data.issues[0].number = Number.MAX_SAFE_INTEGER + 1; },
    data => { data.issues[0].href += '?token=secret'; }, data => { data.pullRequests[0].href = href + '/issues/2'; },
    data => { data.issues[0].title = 'x'.repeat(301); }, data => { data.issues[0].title = 'x\u0085'; }, data => { data.issues[0].title = ''; },
    data => { data.commits[0].oid = 'a'.repeat(41); }, data => { data.commits[0].oid = 'A'.repeat(40); }, data => { data.commits[0].href = 'javascript:alert(1)'; },
    data => { data.issues = Array.from({length: 21}, () => data.issues[0]); }, data => { data.commits = Array.from({length: 6}, () => data.commits[0]); },
    data => { data.issues.push({...data.issues[0]}); }, data => { data.categoryStatuses.issues = 'unavailable'; }, data => { data.status = 'partial'; },
    data => { data.ignored = 'x'.repeat(512 * 1024); },
  ];
  for (const mutate of mutations) {
    const data = dto(); mutate(data); const f = fixture(t, {readRepository: async () => data}); await f.open(); f.edit('example/project');
    assert.equal(await f.read(), false); assert.equal(f.root.querySelectorAll('a').length, 0); assert.match(f.root.textContent, /表示対象と一致しないか/);
  }
});

test('limits are inclusive, response mutation cannot rewrite references, invalid input never reads', async t => {
  const data = dto(); data.repository.stars = Number.MAX_SAFE_INTEGER; data.repository.description = 'x'.repeat(1000); data.repository.defaultBranch = 'x'.repeat(128);
  data.issues = Array.from({length: 20}, (_, index) => ({number: index + 1, title: 'x'.repeat(300), href: href + '/issues/' + (index + 1)}));
  data.commits = Array.from({length: 5}, (_, index) => ({oid: index.toString(16).padStart(40, '0'), title: 'commit', href: href + '/commit/' + index.toString(16).padStart(40, '0')}));
  const f = fixture(t, {readRepository: async () => data}); await f.open(); f.edit('example/project'); assert.equal(await f.read(), true);
  data.repository.href = 'https://evil.example'; data.issues[0].href = 'javascript:alert(1)'; shareButtons(f)[1].click(); await tick(); assert.equal(f.shares[0].href, href + '/issues/1');
  for (const input of ['https://evil.example/example/project', 'example/project/../other', 'example/project?x=1', 'x'.repeat(181), 'example/project\u0085']) {
    f.edit(input); assert.equal(await f.read(), false); assert.equal(f.root.querySelectorAll('a').length, 0);
  }
});

test('async context supports public read, references and sharing while offered isCurrent remains a synchronous boolean', async t => {
  const f = fixture(t, {asyncContext: true}); assert.equal(await f.open(), true); f.edit('example/project'); assert.equal(await f.read(), true);
  f.root.querySelector('a').click(); shareButtons(f)[0].click(); await tick();
  assert.deepEqual(f.reads, ['example/project']); assert.deepEqual(f.opened, [href]); assert.equal(f.shares.length, 1);
  assert.equal(typeof f.shares[0].isCurrent(), 'boolean'); assert.equal(f.shares[0].isCurrent(), true);
  f.scope.key = 'another actor'; assert.equal(f.shares[0].isCurrent(), false);
});

test('actor or origin changes while an async activation context is pending prevent read, navigation and share callbacks', async t => {
  for (const field of ['key', 'origin']) for (const action of ['open', 'read', 'reference', 'share']) {
    const wait = deferred(); let paused = false, f;
    f = fixture(t, {getContext: () => paused ? wait.promise : Promise.resolve({...f.scope})});
    await f.open(); f.edit('example/project'); await f.read(); const snapshot = {...f.scope}; paused = true;
    let work;
    if (action === 'open') work = f.open();
    else if (action === 'read') work = f.read();
    else if (action === 'reference') f.root.querySelector('a').click();
    else shareButtons(f)[0].click();
    await tick(); f.scope[field] = field === 'origin' ? 'https://another.example' : 'another actor'; paused = false; wait.resolve(snapshot);
    if (work) assert.equal(await work, false); await tick();
    assert.equal(f.reads.length, 1); assert.equal(f.opened.length, 0); assert.equal(f.shares.length, 0); assert.equal(f.root.querySelectorAll('a').length, 0);
  }
});

test('async post-read context changes reject results and Promise-valued isCurrent never authorizes work', async t => {
  for (const field of ['key', 'origin']) {
    const wait = deferred(); let paused = false, f;
    f = fixture(t, {getContext: () => paused ? wait.promise : Promise.resolve({...f.scope}), readRepository: async () => { paused = true; return dto(); }});
    await f.open(); f.edit('example/project'); const work = f.read(); await tick(); const snapshot = {...f.scope};
    f.scope[field] = field === 'origin' ? 'https://another.example' : 'another actor'; paused = false; wait.resolve(snapshot);
    assert.equal(await work, false); assert.equal(f.root.querySelectorAll('a').length, 0);
  }
  const f = fixture(t, {asyncContext: true, isCurrent: () => Promise.resolve(true)});
  assert.equal(await f.open(), false); f.edit('example/project'); assert.equal(await f.read(), false); assert.equal(f.reads.length, 0);
});

test('async context accepts a plain object epoch by identity and keeps a boolean share guard', async t => {
  for (const epoch of [{}, Object.create(null)]) {
    const f = fixture(t, {asyncContext: true}); f.scope.epoch = epoch;
    assert.equal(await f.open(), true); f.edit('example/project'); assert.equal(await f.read(), true);
    shareButtons(f)[0].click(); f.root.querySelector('a').click(); await tick();
    assert.equal(f.shares.length, 1); assert.deepEqual(f.opened, [href]); assert.equal(f.shares[0].isCurrent(), true);
    f.scope.epoch = {}; assert.equal(f.shares[0].isCurrent(), false);
  }
});

test('object epoch, actor/root key and origin replacement during async context checks revoke the old generation', async t => {
  for (const change of [f => { f.scope.epoch = {}; }, f => { f.scope.key = 'another actor'; }, f => { f.scope.key = 'another root key'; }, f => { f.scope.origin = 'https://another.example'; }]) {
    const wait = deferred(); let paused = false, f;
    f = fixture(t, {getContext: () => paused ? wait.promise : Promise.resolve({...f.scope})}); f.scope.epoch = {};
    await f.open(); f.edit('example/project'); await f.read(); const oldEpoch = f.scope.epoch, captured = {...f.scope};
    const share = shareButtons(f)[0]; share.click(); await tick(); assert.equal(f.shares[0].isCurrent(), true);
    paused = true; const work = f.read(); await tick(); change(f); paused = false; wait.resolve(captured);
    assert.equal(await work, false); assert.equal(f.shares[0].isCurrent(), false); assert.equal(f.root.querySelectorAll('a').length, 0);
    assert.equal(f.reads.length, 1); if (f.scope.epoch !== oldEpoch) assert.notEqual(f.scope.epoch, captured.epoch);
  }
});

test('epoch validation rejects invalid primitives, arrays, Promise and non-token objects before reads', async t => {
  for (const epoch of [null, undefined, false, true, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, [], Promise.resolve({}), new Date(), {then() {}}]) {
    const f = fixture(t, {asyncContext: true}); f.scope.epoch = epoch;
    assert.equal(await f.open(), false); f.edit('example/project'); assert.equal(await f.read(), false); assert.equal(f.reads.length, 0);
  }
});

const copyButtons = f => [...f.root.querySelectorAll('button')].filter(button => button.textContent === 'URLをコピー');
test('copy is optional and explicit; every reference copies only its captured canonical public URL', async t => {
  const absent = fixture(t); await absent.open(); absent.edit('example/project'); await absent.read(); assert.equal(copyButtons(absent).length, 0);
  const copied = [], f = fixture(t, {asyncContext: true, copyReference: value => { copied.push(value); }});
  await f.open(); f.edit('example/project'); await f.read(); assert.equal(copied.length, 0); assert.equal(copyButtons(f).length, 5);
  f.root.querySelector('a').href = 'https://evil.example/';
  for (const button of copyButtons(f)) button.click(); await tick();
  assert.deepEqual(copied, [href, href + '/issues/1', href + '/pull/2', href + '/commit/' + 'a'.repeat(40), href + '/commit/' + 'b'.repeat(64)]);
  assert.equal(f.shares.length, 0); assert.equal(f.opened.length, 0); assert.match(f.root.textContent, /URLをコピーしました。/);
});

test('copy blocks double clicks during async work and reports fixed generic failures', async t => {
  const wait = deferred(), copied = []; let fail = false;
  const f = fixture(t, {copyReference: value => { copied.push(value); if (fail) throw Error('sensitive clipboard cause'); return wait.promise; }});
  await f.open(); f.edit('example/project'); await f.read(); const button = copyButtons(f)[0]; button.click(); button.click(); await tick();
  assert.deepEqual(copied, [href]); assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-busy'), 'true');
  wait.resolve(); await tick(); assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-busy'), 'false');
  fail = true; button.click(); await tick(); assert.match(f.root.textContent, /URLをコピーできませんでした。/); assert.doesNotMatch(f.root.textContent, /sensitive clipboard cause/);
});

test('stale actor, origin, generation, input or view during async copy authorization prevent clipboard writes', async t => {
  for (const change of [f => { f.scope.key = 'another actor'; }, f => { f.scope.origin = 'https://another.example'; }, f => { f.scope.epoch = {}; },
    f => f.edit('example/other'), f => f.setLive(false), f => f.close(), f => f.root.remove(), f => f.dispose()]) {
    const wait = deferred(), copied = []; let paused = false, f;
    f = fixture(t, {getContext: () => paused ? wait.promise : Promise.resolve({...f.scope}), copyReference: value => { copied.push(value); }});
    f.scope.epoch = {}; await f.open(); f.edit('example/project'); await f.read(); const captured = {...f.scope};
    paused = true; const button = copyButtons(f)[0]; button.click(); button.click(); await tick(); change(f); paused = false; wait.resolve(captured); await tick();
    assert.equal(copied.length, 0); assert.doesNotMatch(f.root.textContent, /URLをコピーしました。/);
  }
});

test('late copy completion or failure cannot change a newer result or revive an old action', async t => {
  for (const fails of [false, true]) {
    const wait = deferred(), copied = [], f = fixture(t, {copyReference: value => { copied.push(value); return wait.promise; }});
    await f.open(); f.edit('example/project'); await f.read(); const old = copyButtons(f)[0]; old.click(); await tick(); assert.deepEqual(copied, [href]);
    f.edit('example/project'); await f.read(); old.click(); assert.equal(copied.length, 1);
    if (fails) wait.reject(Error('sensitive late clipboard cause')); else wait.resolve(); await tick();
    assert.match(f.root.textContent, /公開情報を取得しました。/); assert.doesNotMatch(f.root.textContent, /URLをコピーしました。|URLをコピーできませんでした。|sensitive/);
    assert.equal(old.disabled, true); assert.equal(copyButtons(f).length, 5);
  }
});
