import test from 'node:test';
import assert from 'node:assert/strict';
import { hubPathTarget, notificationTarget } from './notification-targets.mjs';
const p = `rp_${'a'.repeat(32)}`, proposal = '00000000-0000-4000-8000-000000000001';
const item = (targetType, targetId) => ({ targetType, targetId, id: 'notification-id', isRead: false });

test('actual thread destination retains reply ID and post number rather than only thread', () => {
  const result = notificationTarget(item('thread_post', 'post-51'), new Map(), { 'post-51': '/threads/thread-1?replies=post-51#post-51' });
  assert.deepEqual(result, { kind: 'detail', name: 'thread', ids: ['thread-1'], title: 'スレッド', state: { showReplies: true, replyPostId: 'post-51', postNo: 51 } });
  assert.deepEqual(hubPathTarget('/v2/threads/thread-1?page=2#post-51').state, { page: 2, postNo: 51 });
  // The native ID contract permits numeric IDs; thread replies is an ID, not a boolean.
  assert.equal(notificationTarget(item('thread_post', '1'), new Map(), { 1: '/threads/thread-1?replies=1#post-2' }).state.replyPostId, '1');
});

test('community message destination retains exact message and checks matching anchor', () => {
  const result = notificationTarget(item('community_message', 'm1'), new Map(), {}, { m1: '/community?community=c1&channel=ch1&message=m1#m1' });
  assert.deepEqual(result, { kind: 'detail', name: 'channel_messages', ids: ['c1', 'ch1'], title: 'チャンネル', state: { messageId: 'm1' } });
  assert.deepEqual(hubPathTarget('/v2/community?message=m1&channel=ch1&community=c1'), result);
  for (const path of ['/community?community=c1&channel=ch1&message=m1#other', '/community?community=c1&message=m1#m1', '/community?community=c1&channel=ch1&message=other#other']) {
    assert.equal(notificationTarget(item('community_message', 'm1'), new Map(), {}, { m1: path }), null);
  }
});

test('scheduled community message IDs match the existing case-insensitive scheduled UUID grammar only', () => {
  for (const message of [`scheduled:${proposal}`, `SCHEDULED:${proposal.toUpperCase()}`, 'm'.repeat(80)]) {
    const path = `/community?community=c1&channel=ch1&message=${encodeURIComponent(message)}#${encodeURIComponent(message)}`;
    assert.equal(hubPathTarget(path).state.messageId, message);
    assert.equal(notificationTarget(item('community_message', message), new Map(), {}, { [message]: path }).state.messageId, message);
  }
  for (const message of ['m'.repeat(81), 'm\n', 'm\u2028', `ſcheduled:${proposal}`, `unknown:${proposal}`, `scheduled:${proposal}/evil`, `scheduled:${proposal}%2f`, `scheduled:${proposal}\n`, `scheduled:${proposal}\u2028`, 'scheduled:not-a-uuid', `scheduled:${proposal.slice(0,-1)}`]) {
    const path = `/community?community=c1&channel=ch1&message=${encodeURIComponent(message)}#${encodeURIComponent(message)}`;
    assert.equal(hubPathTarget(path), null);
    assert.equal(notificationTarget(item('community_message', message), new Map(), {}, { [message]: path }), null);
  }
  assert.equal(notificationTarget(item('thread', `scheduled:${proposal}`)), null);
  assert.equal(notificationTarget(item('profile', `scheduled:${proposal}`)), null);
});

test('post reply expansion and actual Web reply orders are explicit state', () => {
  assert.deepEqual(hubPathTarget('/v2/posts/p1?replies=1').state, { showReplies: true });
  for (const order of ['recommended', 'latest', 'oldest']) assert.deepEqual(hubPathTarget(`/posts/p1?replies=${order}`).state, { showReplies: true, replyOrder: order });
  assert.equal(hubPathTarget('/posts/p1?replies=other'), null);
  assert.equal(hubPathTarget('/posts/p1?replies=1&replies=latest'), null);
  assert.deepEqual(notificationTarget(item('social_post', 'p1')), { kind: 'detail', name: 'post', ids: ['p1'], title: '投稿' });
});

test('selected document and old fixed revision preserve safe integer strings', () => {
  assert.deepEqual(hubPathTarget(`/v2/research/${p}?document=doc.v1`), { kind: 'detail', name: 'research_document', ids: [p, 'doc.v1'], title: '文書' });
  assert.deepEqual(hubPathTarget(`/research/${p}?version=9007199254740991&document=doc.v1`), { kind: 'detail', name: 'research_revision', ids: [p, 'doc.v1', '9007199254740991'], title: '文書 · v9007199254740991' });
  assert.equal(hubPathTarget(`/research/${p}?document=${'d'.repeat(100)}&version=1`).ids[1].length, 100);
  for (const suffix of ['version=1', 'document=doc&version=0', 'document=doc&version=01', 'document=doc&version=1.0', 'document=doc&version=9007199254740992', 'document=doc&version=1&version=2', 'document=doc&unexpected=true', `document=${'d'.repeat(101)}`]) assert.equal(hubPathTarget(`/research/${p}?${suffix}`), null);
});

test('actual Git proposal, commit, comparison and history selectors remain closed', () => {
  assert.deepEqual(hubPathTarget(`/v2/research/${p}?gitProposal=${proposal}#git`), { kind: 'detail', name: 'research_git_proposal', ids: [p, proposal], title: 'Git提案のレビュー' });
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.deepEqual(hubPathTarget(`/v2/research/${p}?commit=${b}&base=${a}#git`).ids, [p, b, a]);
  assert.equal(hubPathTarget(`/v2/research/${p}?commit=${a}#git`).name, 'research_git_commit');
  assert.equal(hubPathTarget(`/v2/research/${p}#git`).name, 'research_git_history');
  for (const suffix of [`?gitProposal=${proposal}`, `?gitProposal=${proposal}&document=doc#git`, `?gitProposal=${proposal}&gitProposal=${proposal}#git`, `?commit=${a}&base=${'a'.repeat(64)}#git`, '?base=bad#git', '?document=doc#git', '?proposal=unknown']) assert.equal(hubPathTarget(`/v2/research/${p}${suffix}`), null);
});

test('legacy dedupe suffix is discarded only after its own closed boundary validation', () => {
  assert.equal(hubPathTarget('/community?community=c1#event=membership%3Ac1').name, 'community');
  assert.deepEqual(hubPathTarget('/threads/t1#post-2#event=reply%3A2').state, { postNo: 2 });
  for (const path of ['/community#event=', '/community#event=a#event=b', '/community#event=%00', '/community#event=%zz', `/community#event=${'a'.repeat(161)}`, '/community?unsafe=1#event=known']) assert.equal(hubPathTarget(path), null);
});

test('unsafe URL, normalized traversal, malformed encoding and control inputs are rejected', () => {
  for (const path of [null, {}, 'https://hub.example/posts/p1', '//evil.example/posts/p1', '/posts/p1\\evil', '/posts/../p1', '/posts/%2e%2e', '/posts/%252e%252e', '/posts/%2fadmin', '/posts/p1%3fadmin', '/posts/%ff', '/posts/%ud800', '/posts/p1\n', '/posts/p1\r', '/posts/p1\0', '/posts/p1\u0085', '/posts/p1\ud800', '/posts/p1/extra', '/posts//p1', '/constructor', '/toString/id', `/posts/${'a'.repeat(2048)}`]) assert.equal(hubPathTarget(path), null, String(path));
});

test('query duplicates, empty/unknown fields and malformed decoded values never disappear', () => {
  for (const suffix of ['community=c1&community=c2', 'community=c1&%63ommunity=c2', 'community=c1&unknown=x', 'community=c1&channel=', 'community=c1&&channel=ch1', 'community=c1&channel=ch1&', 'community=c1&channel', 'community=c1&channel=%00', 'community=c1&channel=%ff', 'community=c1&channel=a+b', 'community=c1&channel=a%2Fb']) assert.equal(hubPathTarget(`/community?${suffix}`), null);
  assert.equal(hubPathTarget('/community?'), null);
  assert.equal(hubPathTarget('/community#'), null);
});

test('identifier and number boundaries do not use dollar-only regex acceptance', () => {
  assert.equal(hubPathTarget(`/threads/${'t'.repeat(128)}#post-9007199254740991`).state.postNo, Number.MAX_SAFE_INTEGER);
  for (const id of ['t'.repeat(129), 't%0A', 't%0D', 't%E2%80%A8', 't%C2%85']) assert.equal(hubPathTarget(`/threads/${id}`), null);
  for (const hash of ['post-0', 'post-01', 'post-9007199254740992', 'post-1%0A']) assert.equal(hubPathTarget(`/threads/t1#${hash}`), null);
  assert.equal(hubPathTarget(`/profile/${'h'.repeat(64)}`).name, 'profile');
  assert.equal(hubPathTarget(`/profile/${'h'.repeat(65)}`), null);
  assert.equal(hubPathTarget('/tag/%E6%97%A5%E6%9C%AC%E8%AA%9E').ids[0], '日本語');
});

test('missing mappings keep entry fallbacks; present mismatched or unsafe mappings fail closed', () => {
  assert.deepEqual(notificationTarget(item('thread_post', 'p1')), { kind: 'view', view: 'threads' });
  assert.deepEqual(notificationTarget(item('community_message', 'm1')), { kind: 'view', view: 'community' });
  for (const path of ['/threads/t1?replies=other#post-1', '/posts/p1', 'https://evil.example/threads/t1?replies=p1#post-1', null]) assert.equal(notificationTarget(item('thread_post', 'p1'), new Map(), { p1: path }), null);
  const inherited = Object.create({ p1: '/threads/t1?replies=p1#post-1' });
  assert.deepEqual(notificationTarget(item('thread_post', 'p1'), new Map(), inherited), { kind: 'view', view: 'threads' });
  let getters = 0; const gettersMap = {}; Object.defineProperty(gettersMap, 'p1', { get() { getters++; throw Error('not data'); } });
  assert.deepEqual(notificationTarget(item('thread_post', 'p1'), new Map(), gettersMap), { kind: 'view', view: 'threads' }); assert.equal(getters, 0);
});

test('profiles, conversation and catalog destinations use only existing local descriptors', () => {
  const profiles = new Map([['viewer', { handle: 'name.test' }]]);
  assert.deepEqual(notificationTarget(item('profile', 'viewer'), profiles), { kind: 'detail', name: 'profile', ids: ['name.test'], title: '@name.test' });
  assert.deepEqual(notificationTarget(item('profile', 'absent'), profiles), { kind: 'view', view: 'community' });
  assert.deepEqual(notificationTarget(item('profile', 'viewer'), new Map([['viewer', { handle: '..' }]])), { kind: 'view', view: 'community' });
  assert.deepEqual(hubPathTarget('/messages?conversation=c1'), { kind: 'conversation', id: 'c1' });
  assert.deepEqual(hubPathTarget('/v2/messages?channel=email'), { kind: 'view', view: 'mail' });
  assert.equal(hubPathTarget('/vault?content=v1'), null);
  assert.equal(hubPathTarget('/messages?conversation=c1&channel=email'), null);
  for (const [path, name] of [['/articles/a1', 'article'], ['/books/b1', 'book'], ['/hubpedia/h1', 'hubpedia_article'], ['/market/m1', 'listing'], ['/videos/v1', 'video']]) assert.equal(hubPathTarget(path).name, name);
  assert.equal(notificationTarget(item('unknown', 'id')), null);
});

test('community sections retain UI selection without creating new native commands', () => {
  for (const section of ['members', 'guides', 'governance', 'tokens', 'settings']) assert.deepEqual(hubPathTarget(`/v2/community?community=c1&section=${section}`).state, { section });
  for (const path of ['/community?community=c1&section=unknown', '/community?community=c1&section=governance&channel=ch1', '/community/c1?community=c2', '/community?channel=ch1']) assert.equal(hubPathTarget(path), null);
});

test('results are new immutable-input descriptors and cannot contaminate later parses', () => {
  const notification = item('thread_post', 'p1'), maps = { p1: '/threads/t1?replies=p1#post-2' };
  const first = notificationTarget(notification, new Map(), maps); first.ids[0] = 'tampered'; first.state.postNo = 999;
  assert.equal(notificationTarget(notification, new Map(), maps).ids[0], 't1');
  assert.equal(notificationTarget(notification, new Map(), maps).state.postNo, 2);
  assert.equal(maps.p1, '/threads/t1?replies=p1#post-2'); assert.equal(notification.targetId, 'p1');
});
