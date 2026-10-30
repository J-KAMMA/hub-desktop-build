import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMediaPlaylists } from './media-playlists.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const publicId = 'music:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondPublicId = 'music:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stamp = '2026-10-06T00:00:00.000Z';
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
function record(kind, overrides = {}) { return { id: 'p1', title: 'マイリスト', description: '説明', [kind === 'music' ? 'workIds' : 'videoIds']: ['item1', 'item2'], createdAt: stamp, updatedAt: stamp, ...overrides }; }
function fixture(t, { kind = 'video', records = [record(kind)], selectedItem, invoke, mounted = true, ...options } = {}) {
  const dom = new JSDOM('<body></body>'), f = { dom, kind, records: structuredClone(records), viewer: 'viewer1', key: 'account-generation1', current: true, calls: [], opens: [], hook: null };
  f.result = () => ({ viewerId: f.viewer, playlists: structuredClone(f.records) });
  f.backend = async (command, args) => {
    if (command === 'hub_client') return f.result();
    const type = args.action.split('_')[0], key = kind === 'music' ? 'workIds' : 'videoIds', item = f.records.find(item => item.id === args.target);
    if (type === 'create') { const next = record(kind, { id: `created${f.records.length}`, ...args.options, [key]: [] }); f.records.unshift(next); return { viewerId: f.viewer, playlist: structuredClone(next) }; }
    if (type === 'update') { Object.assign(item, args.options); return { viewerId: f.viewer, playlistId: item.id, updated: true }; }
    if (type === 'delete') { f.records = f.records.filter(item => item.id !== args.target); return { viewerId: f.viewer, playlistId: args.target, deleted: true }; }
    if (type === 'set') { item[key] = [...args.options.workIds]; return { viewerId: f.viewer, playlistId: item.id, updated: true }; }
    if (type === 'add') item[key].push(args.options.videoId); else item[key] = item[key].filter(id => id !== args.options.videoId);
    return { viewerId: f.viewer, playlistId: item.id, videoId: args.options.videoId, [type === 'add' ? 'added' : 'removed']: true };
  };
  f.widget = createMediaPlaylists({ document: dom.window.document, kind, selectedItem, getAccount: () => f.key, isCurrent: () => f.current, onOpen: (...args) => f.opens.push(args), invoke: async (...args) => { f.calls.push(structuredClone(args)); return invoke ? invoke(...args) : f.hook ? f.hook(...args) : f.backend(...args); }, ...options });
  if (mounted) dom.window.document.body.append(f.widget.element);
  f.root = f.widget.element; f.text = () => f.root.textContent; f.button = (action, itemId) => [...f.root.querySelectorAll(`button[data-action="${action}"]`)].find(button => !itemId || button.dataset.itemId === itemId); f.actions = () => f.calls.filter(([name]) => name === 'hub_client_action');
  f.set = (name, value) => { const field = f.root.querySelector(`[name="${name}"]`); field.value = value; field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); return field; };
  f.choose = id => { const select = f.root.querySelector('[name="playlist"]'); select.value = id; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  f.wait = async () => { await tick(); const until = Date.now() + 1500; while (f.root.getAttribute('aria-busy') === 'true') { if (Date.now() > until) throw Error('UI did not settle'); await tick(); } };
  f.click = async (action, itemId) => { f.button(action, itemId).click(); await f.wait(); };
  t.after(() => { f.widget.destroy(); dom.window.close(); }); return f;
}

test('initial closed GET, private viewer snapshot, clear empty state and no automatic writes', async t => {
  const f = fixture(t, { records: [] }); await f.widget.ready;
  assert.deepEqual(f.calls, [['hub_client', { name: 'video_playlists' }]]); assert.match(f.text(), /一覧は最大100件.*プレイリストはまだありません/); assert.equal(f.actions().length, 0);
  assert.ok([...f.root.querySelectorAll('button')].every(button => button.type === 'button'));
});
test('music playback is optional and never appears in video or callback-free widgets', async t => {
  const missing = fixture(t, {kind:'music',records:[record('music',{workIds:[publicId]})]});await missing.widget.ready;assert.equal(missing.button('play-first'),undefined);
  const video = fixture(t, {onPlay:()=>{throw Error('video must not play music');}});await video.widget.ready;assert.equal(video.button('play-first'),undefined);
});
test('playlist starts from first or selected public track using the entire saved order, omitting external works explicitly', async t => {
  const plays=[],guards=[],f=fixture(t,{kind:'music',records:[record('music',{workIds:['external1',secondPublicId,'external2',publicId]})],onPlay:(request,scope)=>{plays.push(structuredClone(request));guards.push(scope.isCurrent);assert.equal(scope.isCurrent(),true);return true;}});await f.widget.ready;
  assert.match(f.text(),/Hub公開曲 2曲.*外部作品 2件/);assert.equal(f.button('play-item','external1'),undefined);await f.click('play-first');await f.click('play-item',publicId);
  assert.deepEqual(plays,[{workIds:[secondPublicId,publicId],startId:secondPublicId,playlistId:'p1'},{workIds:[secondPublicId,publicId],startId:publicId,playlistId:'p1'}]);assert.ok(guards.every(current=>current()===false));assert.equal(f.calls.length,1);assert.equal(f.actions().length,0);assert.match(f.text(),/再生を要求しました/);
});
test('unsaved order cannot play; explicit saved order becomes the playback order, while metadata drafts survive', async t => {
  const plays=[],f=fixture(t,{kind:'music',records:[record('music',{workIds:[publicId,secondPublicId]})],onPlay:request=>plays.push(structuredClone(request))});await f.widget.ready;f.set('edit-title','名前の草稿');await f.click('up',secondPublicId);
  assert.equal(f.button('play-first').disabled,true);assert.equal(f.button('play-item',secondPublicId).disabled,true);f.button('play-first').dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true}));assert.equal(plays.length,0);
  await f.click('save-order');await f.click('play-first');assert.deepEqual(plays[0].workIds,[secondPublicId,publicId]);assert.equal(f.root.querySelector('[name="edit-title"]').value,'名前の草稿');assert.equal(f.actions().length,1);
});
test('pending async play locks all actions, suppresses duplicate clicks, and retires its callback scope after settlement', async t => {
  const gate=deferred();let calls=0,scope;const f=fixture(t,{kind:'music',records:[record('music',{workIds:[publicId]})],onPlay:(request,next)=>{calls++;scope=next;return gate.promise;}});await f.widget.ready;f.button('play-first').click();f.button('play-first').dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true}));
  assert.equal(calls,1);assert.equal(scope.isCurrent(),true);assert.equal(f.root.getAttribute('aria-busy'),'true');assert.equal(f.root.querySelector('[name="playlist"]').disabled,true);assert.equal(f.button('reload').disabled,true);assert.equal(f.button('update').disabled,true);
  gate.resolve(true);await f.wait();assert.equal(scope.isCurrent(),false);assert.equal(f.button('play-first').disabled,false);assert.equal(f.calls.length,1);
});
test('play scope rejects late account/view/selection/disposal commits and does not display a stale success', async t => {
  for(const change of ['account','view','playlist','dispose']){const gate=deferred();let scope;const f=fixture(t,{kind:'music',records:[record('music',{workIds:[publicId]}),record('music',{id:'p2',workIds:[secondPublicId]})],onPlay:(request,next)=>{scope=next;return gate.promise;}});await f.widget.ready;f.button('play-first').click();
    if(change==='account'){f.key='other';f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));}else if(change==='view')f.current=false;else if(change==='playlist')f.choose('p2');else f.widget.destroy();
    assert.equal(scope.isCurrent(),false);gate.resolve(true);await tick();assert.doesNotMatch(f.text(),/再生を要求しました/);assert.equal(f.actions().length,0);assert.equal(f.calls.length,1);
  }
});
test('failed playback keeps saved list and unsaved metadata, and an explicit false result is not announced as accepted', async t => {
  for(const result of [false,Error('private playback failure')]){const f=fixture(t,{kind:'music',records:[record('music',{workIds:[publicId]})],onPlay:()=>{if(result instanceof Error)throw result;return result;}});await f.widget.ready;f.set('edit-title','草稿');await f.click('play-first');
    assert.match(f.text(),/再生.*確認できません|再生を開始できません/);assert.equal(f.root.querySelector('[name="edit-title"]').value,'草稿');assert.equal(f.root.querySelectorAll('li').length,1);assert.equal(f.button('play-first').disabled,false);assert.doesNotMatch(f.text(),/private playback/);assert.equal(f.actions().length,0);
  }
});
test('empty/all-external lists disable playback, malformed public IDs fail closed, and paging never truncates a 200-track queue', async t => {
  for(const workIds of [[],['external1'],[publicId+'\n'],['music:../../track']]){const f=fixture(t,{kind:'music',records:[record('music',{workIds})],onPlay:()=>{throw Error('should not play');}});await f.widget.ready;assert.ok(!f.button('play-first')||f.button('play-first').disabled);assert.equal(f.calls.length,1);}
  const workIds=Array.from({length:200},(_,i)=>`music:00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);let first;
  const f=fixture(t,{kind:'music',records:[record('music',{workIds})],onPlay:request=>{first=structuredClone(request);request.workIds.length=0;}});await f.widget.ready;assert.equal(f.root.querySelectorAll('li').length,50);await f.click('play-first');assert.deepEqual(first.workIds,workIds);assert.equal(first.startId,workIds[0]);assert.equal(f.root.querySelectorAll('li').length,50);await f.click('more');assert.equal(f.root.querySelectorAll('li').length,100);
});

test('create canonical NFKC metadata then GET confirms server state, selection changes only after confirmation', async t => {
  const f = fixture(t); await f.widget.ready; f.set('create-title', '  Ａ　Ｂ  '); f.set('create-description', '行1\n 行2'); await f.click('create');
  assert.deepEqual(f.actions()[0], ['hub_client_action', { action: 'create_video_playlist', options: { title: 'A B', description: '行1 行2' } }]);
  assert.equal(f.calls.at(-1)[0], 'hub_client'); assert.match(f.text(), /作成を確認しました/); assert.equal(f.root.querySelector('[name="playlist"]').value, 'created1'); assert.equal(f.root.querySelector('[name="create-title"]').value, '');
});

test('name/description drafts survive playlist changes and refresh; valid update is confirmed by GET', async t => {
  const f = fixture(t, { kind: 'music', records: [record('music'), record('music', { id: 'p2', title: '別のリスト' })] }); await f.widget.ready;
  f.set('edit-title', '新しい名前'); f.set('edit-description', '新しい説明'); f.choose('p2'); f.choose('p1'); assert.equal(f.root.querySelector('[name="edit-title"]').value, '新しい名前');
  await f.click('reload'); assert.equal(f.root.querySelector('[name="edit-description"]').value, '新しい説明'); await f.click('update');
  assert.deepEqual(f.actions()[0], ['hub_client_action', { action: 'update_music_playlist', target: 'p1', options: { title: '新しい名前', description: '新しい説明' } }]); assert.match(f.text(), /保存を確認しました/);
});

test('invalid metadata keeps raw drafts and never writes; exact 80/500 limits accepted', async t => {
  const f = fixture(t); await f.widget.ready;
  for (const [title, description] of [[' ', ''], ['x'.repeat(81), ''], ['ok', 'x'.repeat(501)], ['ok\u0000', '']]) {
    f.set('create-title', title); f.set('create-description', description); await f.click('create'); assert.equal(f.actions().length, 0); assert.equal(f.root.querySelector('[name="create-title"]').value, title); assert.match(f.text(), /80文字.*500文字/);
  }
  f.set('create-title', 'x'.repeat(80)); f.set('create-description', 'y'.repeat(500)); await f.click('create'); assert.equal(f.actions().length, 1);
});

test('delete has a target-specific explicit confirmation, cancellation and no source-content deletion API', async t => {
  const f = fixture(t); await f.widget.ready; await f.click('delete-preview'); assert.equal(f.actions().length, 0); assert.match(f.text(), /動画・音源自体は削除しません/);
  await f.click('delete-cancel'); assert.equal(f.button('delete-confirm'), undefined); await f.click('delete-preview'); await f.click('delete-confirm');
  assert.deepEqual(f.actions(), [['hub_client_action', { action: 'delete_video_playlist', options: {}, target: 'p1' }]]); assert.match(f.text(), /削除を確認しました.*まだありません/);
});

test('video selected content add/remove uses IDs only and onOpen is injected for every existing item', async t => {
  const selectedItem = { id: 'video3', title: '<img src=x onerror=evil()>' }, f = fixture(t, { selectedItem }); await f.widget.ready;
  await f.click('add'); assert.deepEqual(f.actions()[0][1], { action: 'add_video_playlist_item', target: 'p1', options: { videoId: 'video3' } }); assert.equal(f.button('add').disabled, true); assert.match(f.text(), /追加済み/); assert.equal(f.root.querySelectorAll('img').length, 0);
  await f.click('open', 'video3'); await f.click('open', 'item1'); assert.deepEqual(f.opens, [[{ id: 'video3', title: selectedItem.title }, 'video'], [{ id: 'item1', title: '' }, 'video']]);
  await f.click('remove', 'video3'); assert.deepEqual(f.actions()[1][1], { action: 'remove_video_playlist_item', target: 'p1', options: { videoId: 'video3' } }); assert.equal(f.button('add').disabled, false);
});

test('music public track IDs survive add/remove and use only closed full-list write contract', async t => {
  const f = fixture(t, { kind: 'music', selectedItem: { id: publicId, title: '公開曲' } }); await f.widget.ready; await f.click('add');
  assert.deepEqual(f.actions()[0][1], { action: 'set_music_playlist_items', target: 'p1', options: { workIds: ['item1', 'item2', publicId] } }); await f.click('open', publicId); assert.equal(f.opens[0][0].id, publicId);
  await f.click('remove', publicId); assert.deepEqual(f.actions()[1][1].options, { workIds: ['item1', 'item2'] });
});

test('music arrows stage order without RPC; explicit save confirms exact order and cancellation restores', async t => {
  const f = fixture(t, { kind: 'music', selectedItem: { id: 'item3', title: '次の曲' } }); await f.widget.ready;
  assert.equal(f.button('up', 'item1').disabled, true); assert.equal(f.button('down', 'item2').disabled, true);
  await f.click('up', 'item2'); assert.equal(f.actions().length, 0); assert.match(f.text(), /まだ保存していません/); assert.equal(f.button('add').disabled, true); assert.equal(f.button('remove', 'item2').disabled, true);
  await f.click('cancel-order'); assert.equal(f.button('save-order').disabled, true); await f.click('up', 'item2'); await f.click('save-order');
  assert.deepEqual(f.actions()[0][1], { action: 'set_music_playlist_items', target: 'p1', options: { workIds: ['item2', 'item1'] } }); assert.equal(f.button('save-order').disabled, true); assert.match(f.text(), /保存を確認しました/);
});

test('200 music items disables add, video items above 200 remain valid and render in 50 item pages', async t => {
  const itemIds = Array.from({ length: 251 }, (_, i) => `item${i}`);
  const f = fixture(t, { records: [record('video', { videoIds: itemIds })] }); await f.widget.ready; assert.equal(f.root.querySelectorAll('li').length, 50); await f.click('more'); assert.equal(f.root.querySelectorAll('li').length, 100); assert.match(f.text(), /251項目/);
  const music = fixture(t, { kind: 'music', records: [record('music', { workIds: itemIds.slice(0, 200) })], selectedItem: { id: 'extra', title: '追加曲' } }); await music.widget.ready; assert.equal(music.button('add').disabled, true); assert.match(music.text(), /200項目まで/);
});

test('invalid list response shapes, IDs, limits and owner fields disable writes rather than imply empty', async t => {
  const base = { viewerId: 'viewer1', playlists: [record('music')] };
  for (const response of [null, { ...base, viewerId: '../viewer' }, { ...base, extra: true }, { ...base, playlists: [base.playlists[0], base.playlists[0]] }, { ...base, playlists: Array(101).fill(base.playlists[0]) }, { ...base, playlists: Array(1) }, { ...base, playlists: [{ ...base.playlists[0], id: '../id' }] }, { ...base, playlists: [{ ...base.playlists[0], owner: 'other' }] }, { ...base, playlists: [{ ...base.playlists[0], workIds: ['x', 'x'] }] }, { ...base, playlists: [{ ...base.playlists[0], workIds: ['../track'] }] }, { ...base, playlists: [{ ...base.playlists[0], workIds: Array.from({ length: 201 }, (_, i) => `item${i}`) }] }, { ...base, playlists: [{ ...base.playlists[0], title: 'x'.repeat(81) }] }, { ...base, playlists: [{ ...base.playlists[0], updatedAt: 'never' }] }]) {
    const f = fixture(t, { kind: 'music', invoke: () => response }); await f.widget.ready; assert.match(f.text(), /一覧を取得・確認できません/); assert.equal(f.button('create').disabled, true); assert.doesNotMatch(f.text(), /プレイリストはまだありません/); assert.equal(f.actions().length, 0);
  }
});

test('2 MiB UTF8 response boundary rejects oversized JSON including multibyte content', async t => {
  const large = { viewerId: 'viewer1', playlists: Array.from({ length: 100 }, (_, i) => record('video', { id: `p${i}`, videoIds: Array.from({ length: 400 }, (_, j) => `item_${j}_${'x'.repeat(110)}`) })) };
  const f = fixture(t, { invoke: () => large }); await f.widget.ready; assert.match(f.text(), /一覧を取得・確認できません/); assert.equal(f.root.querySelectorAll('li').length, 0);
  const multibyte = { viewerId: 'viewer1', playlists: Array.from({ length: 100 }, (_, i) => record('video', { id: `p${i}`, description: 'あ'.repeat(500), videoIds: Array.from({ length: 155 }, (_, j) => `item${j}_${'x'.repeat(120)}`) })) };
  assert.ok(JSON.stringify(multibyte).length < 2097152); assert.ok(new TextEncoder().encode(JSON.stringify(multibyte)).length > 2097152);
  const utf8 = fixture(t, { invoke: () => multibyte }); await utf8.widget.ready; assert.match(utf8.text(), /一覧を取得・確認できません/); assert.equal(utf8.root.querySelectorAll('li').length, 0);
});

test('known rejected writes preserve drafts and allow explicit correction; unknown outcome requires GET first', async t => {
  for (const message of ['playlist_rejected:400:プレイリストを保存できませんでした。', 'playlist_rejected:403:プレイリストを保存できませんでした。', 'playlist_rejected:404:プレイリストを保存できませんでした。', 'playlist_rejected:409:プレイリストを保存できませんでした。', 'playlist_rejected:413:プレイリストを保存できませんでした。', 'playlist_rejected:429:プレイリストを保存できませんでした。']) {
    const f = fixture(t); await f.widget.ready; f.set('edit-title', '下書き'); f.hook = (command, args) => { if (command === 'hub_client_action') throw Error(message); return f.backend(command, args); }; await f.click('update'); assert.match(f.text(), /保存が拒否されました/); assert.equal(f.button('update').disabled, false); assert.equal(f.root.querySelector('[name="edit-title"]').value, '下書き'); assert.equal(f.calls.length, 2);
  }
  const f = fixture(t); await f.widget.ready; f.set('edit-title', '下書き'); f.hook = (command, args) => { if (command === 'hub_client_action') throw 'playlist_rejected:500:プレイリストを保存できませんでした。'; return f.backend(command, args); }; await f.click('update'); assert.equal(f.button('update').disabled, true); await f.click('reload'); assert.equal(f.button('update').disabled, false); assert.equal(f.root.querySelector('[name="edit-title"]').value, '下書き'); assert.match(f.text(), /希望した保存結果とは一致していません/);
});

test('unknown create cannot auto-resend or claim success from same metadata; explicit existing-list choice unlocks', async t => {
  const f = fixture(t, { records: [] }); await f.widget.ready; f.set('create-title', '新しいリスト'); f.set('create-description', '説明');
  f.hook = async (command, args) => { const result = await f.backend(command, args); if (command === 'hub_client_action') throw Error('transport private error'); return result; };
  await f.click('create'); assert.equal(f.actions().length, 1); assert.equal(f.button('create').disabled, true); assert.equal(f.root.querySelector('[name="create-title"]').value, '新しいリスト'); assert.doesNotMatch(f.text(), /transport private/);
  await f.click('reload'); assert.equal(f.actions().length, 1); assert.match(f.text(), /同じ内容のリストが見つかりました.*成功したとは断定できません/); assert.equal(f.button('create').disabled, true); await f.click('use-existing'); assert.equal(f.button('create').disabled, false); assert.match(f.text(), /成否は確認できていません/);
});

test('unknown create missing from new GET requires explicit duplication warning acknowledgement before retry', async t => {
  const f = fixture(t, { records: [] }); await f.widget.ready; f.set('create-title', '下書き'); f.hook = (command, args) => { if (command === 'hub_client_action') throw Error('timeout'); return f.backend(command, args); };
  await f.click('create'); assert.equal(f.button('new-create'), undefined); await f.click('reload'); assert.match(f.text(), /重複する可能性/); assert.equal(f.button('create').disabled, true); await f.click('new-create'); assert.equal(f.actions().length, 1); assert.equal(f.button('create').disabled, false); assert.equal(f.root.querySelector('[name="create-title"]').value, '下書き');
});

test('invalid action identity/shape and valid acknowledgement without desired GET cannot falsely confirm', async t => {
  for (const response of [{ viewerId: 'other', playlistId: 'p1', updated: true }, { viewerId: 'viewer1', playlistId: 'other', updated: true }, { viewerId: 'viewer1', playlistId: 'p1', updated: false }, { viewerId: 'viewer1', playlistId: 'p1', updated: true, owner: 'other' }, { viewerId: 'viewer1', playlistId: 'p1', updated: true }]) {
    const f = fixture(t); await f.widget.ready; f.set('edit-title', '希望した名前'); f.hook = (command, args) => command === 'hub_client_action' ? response : f.backend(command, args); await f.click('update'); assert.match(f.text(), /保存結果を確認できません/); assert.doesNotMatch(f.text(), /保存を確認しました/); assert.equal(f.root.querySelector('[name="edit-title"]').value, '希望した名前'); assert.equal(f.button('update').disabled, true);
  }
});

test('read error and different viewer preserve old validated snapshot but cannot enable any mutations', async t => {
  const f = fixture(t); await f.widget.ready; f.set('edit-title', '草稿'); f.hook = () => { throw Error('private read failed'); }; await f.click('reload'); assert.match(f.text(), /一覧を取得・確認できません.*入力/); assert.equal(f.button('update').disabled, true); assert.equal(f.root.querySelector('[name="edit-title"]').value, '草稿');
  f.hook = () => ({ viewerId: 'viewer2', playlists: [record('video', { title: '他人のリスト' })] }); await f.click('reload'); assert.doesNotMatch(f.text(), /他人のリスト/); assert.equal(f.button('create').disabled, true);
});

test('order drafts survive failed save and external item changes require cancellation before another overwrite', async t => {
  const f = fixture(t, { kind: 'music' }); await f.widget.ready; await f.click('up', 'item2'); f.hook = (command, args) => { if (command === 'hub_client_action') throw Error('timeout'); return f.backend(command, args); }; await f.click('save-order'); assert.match(f.text(), /まだ保存していません/);
  f.records[0].workIds = ['item1', 'item2', 'external']; await f.click('reload'); assert.match(f.text(), /別の変更で曲一覧が変わっています/); assert.equal(f.button('save-order').disabled, true); await f.click('cancel-order'); assert.equal(f.root.querySelectorAll('li').length, 3);
});

test('duplicate write/read clicks are suppressed while server outcome remains pending', async t => {
  const gate = deferred(), f = fixture(t); await f.widget.ready; f.set('edit-title', '保存'); f.hook = (command, args) => command === 'hub_client_action' ? gate.promise : f.backend(command, args);
  f.button('update').click(); f.button('update').dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); f.button('reload').click(); assert.equal(f.actions().length, 1); assert.equal(f.calls.length, 2); gate.reject(Error('timeout')); await f.wait(); assert.equal(f.button('reload').disabled, false);
});

test('account event invalidates private data and drafts immediately; changed generation suppresses writes/late reads', async t => {
  const f = fixture(t); await f.widget.ready; f.set('create-title', '私有草稿'); f.set('edit-title', '編集草稿'); const gate = deferred(); f.hook = () => gate.promise; f.button('reload').click(); f.key = 'generation2'; f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));
  assert.doesNotMatch(f.text(), /マイリスト|編集草稿/); assert.equal(f.root.querySelector('[name="create-title"]').value, ''); gate.resolve({ viewerId: 'other', playlists: [record('video', { title: '別アカウント' })] }); await tick(); assert.doesNotMatch(f.text(), /別アカウント/); assert.equal(f.button('create').disabled, true);
  const changed = fixture(t); await changed.widget.ready; changed.key = 'generation2'; const staleButton = changed.button('update'); staleButton.click(); assert.equal(changed.actions().length, 0); assert.match(changed.text(), /アカウントが変わりました/);
});

test('view change/destroy/unmounted root prevents late rendering, detached controls cannot write', async t => {
  for (const destroy of [false, true]) {
    const gate = deferred(), f = fixture(t, { invoke: () => gate.promise }); await tick(); const create = f.button('create'); if (destroy) f.widget.destroy(); else f.current = false;
    gate.resolve({ viewerId: 'viewer1', playlists: [record('video', { title: '遅い私有リスト' })] }); await f.widget.ready; assert.doesNotMatch(f.text(), /遅い私有リスト/); create.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(f.actions().length, 0); if (destroy) { assert.equal(f.root.isConnected, false); assert.equal(f.text(), ''); f.widget.destroy(); }
  }
  for (const options of [{ mounted: false }, { getAccount: () => null }, { kind: 'unknown' }]) { const f = fixture(t, options); await f.widget.ready; assert.equal(f.calls.length, 0); }
});

test('snapshots do not retain caller arrays; unsafe selected IDs disable only their addition and texts stay safe', async t => {
  const raw = { viewerId: 'viewer1', playlists: [record('video', { title: '<script>bad()</script>' })] }, f = fixture(t, { invoke: () => raw }); await f.widget.ready; raw.playlists[0].videoIds.push('evil'); raw.playlists[0].title = 'MUTATED'; await f.click('delete-preview'); assert.doesNotMatch(f.text(), /evil|MUTATED/); assert.equal(f.root.querySelectorAll('script').length, 0); assert.equal(f.root.querySelectorAll('li').length, 2);
  const bad = fixture(t, { selectedItem: { id: '../path', title: 'bad' } }); await bad.widget.ready; assert.equal(bad.button('add'), undefined); assert.equal(bad.button('create').disabled, false);
});

test('late write acknowledgements after account change/destroy cannot issue follow-up reads or disclose prior state', async t => {
  for (const destroy of [false, true]) {
    const f = fixture(t), gate = deferred(); await f.widget.ready; f.set('edit-title', '保存草稿'); f.hook = () => gate.promise; f.button('update').click();
    if (destroy) f.widget.destroy(); else { f.key = 'account2'; f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed')); }
    gate.resolve({ viewerId: 'viewer1', playlistId: 'p1', updated: true }); await tick(); await tick();
    assert.equal(f.calls.length, 2); assert.doesNotMatch(f.text(), /マイリスト|保存草稿|保存を確認しました/); assert.equal(f.actions().length, 1);
  }
});

test('duplicate refresh clicks send one GET and current snapshot is preserved on failure', async t => {
  const f = fixture(t), gate = deferred(); await f.widget.ready; f.hook = () => gate.promise;
  f.button('reload').click(); f.button('reload').dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(f.calls.length, 2);
  gate.reject(Error('network')); await f.wait(); assert.match(f.text(), /取得・確認できません/); assert.equal(f.root.querySelectorAll('li').length, 2);
});

test('IDs with terminal newline/control are rejected in viewer, playlist, item and selected-item positions', async t => {
  for (const suffix of ['\n', '\r', '\r\n', '\u0085']) {
    for (const kind of ['video', 'music']) {
      const key = kind === 'music' ? 'workIds' : 'videoIds', item = kind === 'music' ? publicId : 'video1';
      for (const response of [{ viewerId: `viewer1${suffix}`, playlists: [record(kind)] }, { viewerId: 'viewer1', playlists: [record(kind, { id: `p1${suffix}` })] }, { viewerId: 'viewer1', playlists: [record(kind, { [key]: [`${item}${suffix}`] })] }]) {
        const f = fixture(t, { kind, invoke: () => response }); await f.widget.ready; assert.match(f.text(), /一覧を取得・確認できません/); assert.equal(f.button('create').disabled, true); assert.equal(f.actions().length, 0);
      }
      const f = fixture(t, { kind, selectedItem: { id: `${item}${suffix}`, title: '不正な選択' } }); await f.widget.ready; assert.equal(f.button('add'), undefined); assert.equal(f.actions().length, 0);
    }
  }
  const f = fixture(t, { selectedItem: { id: 'x'.repeat(128), title: '正しい上限' } }); await f.widget.ready; assert.equal(f.button('add').disabled, false);
});

const memoryScope = { key: JSON.stringify(['https://hub.example', 'device1']), generation: 1 };
const scoped = (t, options = {}) => fixture(t, { getScope: async () => memoryScope, ...options });

test('same-scope recreation keeps selected playlist, all raw drafts, saved-order draft and expanded item page', async t => {
  const state = {}, ids = Array.from({ length: 101 }, (_, index) => `item${index}`);
  const records = [record('music', { id: 'p1', workIds: [publicId] }), record('music', { id: 'p2', workIds: ids })];
  const first = scoped(t, { kind: 'music', records, state, onPlay: () => true }); await first.widget.ready;
  first.choose('p2'); first.set('edit-title', '未保存の名前'); first.set('edit-description', '未保存\n説明'); first.set('create-title', '作成草稿');
  await first.click('more'); await first.click('up', 'item1'); await first.click('open', 'item0');
  const captured = first.widget.capture(); assert.equal(captured.selectedId, 'p2'); assert.equal(captured.limit, 100);
  captured.drafts[1][1].title = 'caller mutation'; assert.equal(state.checkpoint.drafts[1][1].title, '未保存の名前');
  first.current = false; first.widget.destroy();
  const next = scoped(t, { kind: 'music', records, state, onPlay: () => true }); await next.widget.ready;
  assert.equal(next.root.querySelector('[name="playlist"]').value, 'p2');
  assert.equal(next.root.querySelector('[name="edit-title"]').value, '未保存の名前');
  assert.equal(next.root.querySelector('[name="edit-description"]').value, '未保存\n説明');
  assert.equal(next.root.querySelector('[name="create-title"]').value, '作成草稿');
  assert.equal(next.root.querySelectorAll('li').length, 100);
  assert.deepEqual([...next.root.querySelectorAll('li p')].slice(0, 2).map(node => node.textContent), ['item1', 'item0']);
  assert.equal(next.button('play-first').disabled, true); assert.equal(next.actions().length, 0);
});

test('pending create is checkpointed before IPC and remains unknown after disposal and fresh same-scope GET', async t => {
  const state = {}, gate = deferred(), first = scoped(t, { state }); await first.widget.ready;
  first.set('create-title', '結果不明の新規リスト'); first.hook = async (command, args) => command === 'hub_client_action' ? gate.promise : first.backend(command, args);
  first.button('create').click(); await tick();
  assert.equal(first.actions().length, 1); assert.equal(state.checkpoint.intent.values.title, '結果不明の新規リスト');
  first.widget.destroy(); const frozen = structuredClone(state.checkpoint);
  const next = scoped(t, { state }); await next.widget.ready;
  gate.resolve({ viewerId: 'viewer1', playlist: record('video', { id: 'late-created', title: '結果不明の新規リスト', videoIds: [] }) }); await tick();
  assert.equal(state.checkpoint.intent.createdId, null); assert.equal(frozen.intent.createdId, null);
  assert.equal(next.actions().length, 0); assert.equal(next.button('create').disabled, true); assert.match(next.text(), /作成結果が不明/);
  await next.click('reload'); assert.ok(next.button('new-create')); assert.equal(next.actions().length, 0);
});

test('a saved update is reconciled readonly on return and keeps the confirmed status without another mutation', async t => {
  const state = {}, gate = deferred(), first = scoped(t, { state }); await first.widget.ready;
  first.set('edit-title', '変更した名前'); first.hook = async (command, args) => { if (command === 'hub_client_action') { await first.backend(command, args); return gate.promise; } return first.backend(command, args); };
  first.button('update').click(); await tick(); first.widget.destroy();
  const next = scoped(t, { state, records: first.records }); await next.widget.ready;
  assert.equal(next.actions().length, 0); assert.equal(next.root.querySelector('[name="edit-title"]').value, '変更した名前'); assert.match(next.text(), /現在の一覧が希望した状態と一致/);
  assert.equal(state.checkpoint.intent, null);
  gate.reject(Error('lost ack')); await tick(); assert.equal(state.checkpoint.intent, null);
});

test('origin, device, generation, account epoch and fresh viewer mismatch cannot restore a prior private draft', async t => {
  for (const change of ['origin', 'device', 'generation', 'account', 'viewer']) {
    const state = {}, first = scoped(t, { state }); await first.widget.ready; first.set('edit-title', 'PRIVATE_OLD_DRAFT'); first.widget.destroy();
    const scope = change === 'origin' ? { ...memoryScope, key: JSON.stringify(['https://other.example', 'device1']) } : change === 'device' ? { ...memoryScope, key: JSON.stringify(['https://hub.example', 'device2']) } : change === 'generation' ? { ...memoryScope, generation: 2 } : memoryScope;
    const next = scoped(t, { state, getScope: async () => scope, ...(change === 'account' ? { getAccount: () => 'account2' } : {}), ...(change === 'viewer' ? { invoke: async () => ({ viewerId: 'viewer2', playlists: [record('video')] }) } : {}) }); await next.widget.ready;
    assert.doesNotMatch(next.text(), /PRIVATE_OLD_DRAFT/); assert.notEqual(next.root.querySelector('[name="edit-title"]')?.value, 'PRIVATE_OLD_DRAFT'); assert.equal(next.actions().length, 0);
    if (change === 'viewer') { assert.equal(next.root.querySelectorAll('li').length, 0); assert.equal(state.checkpoint, undefined); assert.equal(next.button('create').disabled, true); }
  }
});

test('fresh scope change before dispatch or after receipt clears memory and cannot write or adopt stale results', async t => {
  for (const after of [false, true]) {
    const state = {}; let scope = memoryScope;
    const f = scoped(t, { state, getScope: async () => scope }); await f.widget.ready; f.set('edit-title', 'PRIVATE_PENDING');
    if (after) f.hook = async (command, args) => { const result = await f.backend(command, args); scope = { ...memoryScope, generation: 2 }; return result; };
    else scope = { ...memoryScope, generation: 2 };
    f.button('update').click(); await tick(); await tick();
    assert.equal(f.actions().length, after ? 1 : 0); assert.equal(state.checkpoint, undefined); assert.equal(f.root.querySelectorAll('li').length, 0); assert.doesNotMatch(f.text(), /保存を確認しました/);
  }
});

test('malformed memory is discarded, restore does not issue mutations, and scope-read failure remains retryable', async t => {
  const state = {}, first = scoped(t, { state }); await first.widget.ready; first.set('edit-title', 'kept'); first.widget.destroy();
  const original = structuredClone(state.checkpoint);
  for (const mutate of [value => value.limit = -1, value => value.intent = { type: 'delete', target: '../bad' }, value => value.drafts[0][1].items = ['bad\n'], value => value.viewerId = 'viewer\n', value => value.extra = 'unknown']) {
    const memory = { checkpoint: structuredClone(original) }; mutate(memory.checkpoint);
    const f = scoped(t, { state: memory }); await f.widget.ready; assert.equal(f.actions().length, 0); assert.equal(f.root.querySelector('[name="edit-title"]').value, 'マイリスト');
  }
  let fail = true; const f = scoped(t, { state: { checkpoint: original }, getScope: async () => { if (fail) throw Error('offline'); return memoryScope; } }); await f.widget.ready;
  assert.equal(f.calls.length, 0); assert.equal(f.button('create').disabled, true); fail = false; await f.click('reload'); assert.equal(f.calls.length, 1); assert.equal(f.button('create').disabled, false); assert.equal(f.root.querySelector('[name="edit-title"]').value, 'kept');
});

test('origin event clears visible private drafts and any checkpoint before another old control can act', async t => {
  const state = {}, f = scoped(t, { state }); await f.widget.ready; f.set('edit-title', 'PRIVATE_OLD'); const old = f.button('update');
  f.dom.window.dispatchEvent(new f.dom.window.Event('hub-origin-changed'));
  assert.equal(state.checkpoint, undefined); assert.equal(f.root.querySelectorAll('li').length, 0); assert.equal(f.root.querySelector('[name="edit-title"]'), null);
  old.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(f.actions().length, 0);
});
