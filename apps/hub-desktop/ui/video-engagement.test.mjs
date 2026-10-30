import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseEngagement, loadEngagement, setVideoLike, followerLabel, createLikeButton, createFollowButton, isEngagementId } from './video-engagement.mjs';

const doc = () => new JSDOM('<main></main>').window.document;

test('parseEngagement is defensive about counts and the viewer flag', () => {
  assert.deepEqual(parseEngagement({ likeCount: 12, likedByViewer: true }), { likeCount: 12, liked: true });
  assert.deepEqual(parseEngagement({ likeCount: -3, likedByViewer: 'yes' }), { likeCount: 0, liked: false });
  assert.deepEqual(parseEngagement({ likeCount: 2.9 }), { likeCount: 2, liked: false });
  assert.deepEqual(parseEngagement(null), { likeCount: 0, liked: false });
});

test('loadEngagement reads video_engagement and returns null on failure or a bad id', async () => {
  const seen = [];
  const state = await loadEngagement(async (name, args) => { seen.push([name, args]); return { likeCount: 5, likedByViewer: false }; }, 'vid_1');
  assert.deepEqual(state, { likeCount: 5, liked: false });
  assert.deepEqual(seen, [['hub_detail', { name: 'video_engagement', ids: ['vid_1'] }]]);
  assert.equal(await loadEngagement(async () => { throw new Error('x'); }, 'vid_1'), null);
  assert.equal(await loadEngagement(async () => ({}), '../x'), null);
  assert.equal(isEngagementId('a/b'), false);
});

test('setVideoLike uses the fixed like_video / unlike_video verbs and trusts the server answer', async () => {
  const seen = [];
  const invoke = async (name, args) => { seen.push([name, args]); return { likeCount: 9, likedByViewer: args.action === 'like_video' }; };
  assert.deepEqual(await setVideoLike(invoke, 'v1', true), { likeCount: 9, liked: true });
  assert.deepEqual(await setVideoLike(invoke, 'v1', false), { likeCount: 9, liked: false });
  assert.deepEqual(seen.map(([, a]) => [a.action, a.target, 'options' in a]), [['like_video', 'v1', false], ['unlike_video', 'v1', false]]);
  await assert.rejects(() => setVideoLike(invoke, '../x', true));
});

test('followerLabel shows a plus when the count is capped', () => {
  assert.equal(followerLabel(1000, true), 'フォロワー 1,000+');
  assert.equal(followerLabel(42, false), 'フォロワー 42');
  assert.equal(followerLabel(undefined, false), 'フォロワー 0');
});

test('like button toggles with the server state, labelled いいね and never スキ', async () => {
  const document = doc();
  const asked = [];
  const wrap = createLikeButton(document, { state: { likeCount: 3, liked: false }, signedIn: true, onSet: async (want) => { asked.push(want); return { likeCount: want ? 4 : 3, liked: want }; } });
  const button = wrap.querySelector('button');
  assert.match(wrap.textContent, /いいね/);
  assert.doesNotMatch(wrap.textContent, /スキ/);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, [true]);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.querySelector('.vid-like-count').textContent, '4');
  assert.equal(button.disabled, false);
});

test('like button keeps its state and shows the reason when the change fails', async () => {
  const document = doc();
  const wrap = createLikeButton(document, { state: { likeCount: 3, liked: false }, signedIn: true, onSet: async () => { throw new Error('接続できません'); } });
  wrap.querySelector('button').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wrap.querySelector('button').getAttribute('aria-pressed'), 'false');
  assert.equal(wrap.querySelector('.vid-like-note').textContent, '接続できません');
});

test('signed out: like and follow are disabled with a hint and never call out', () => {
  const document = doc();
  let calls = 0;
  const like = createLikeButton(document, { state: { likeCount: 1, liked: false }, signedIn: false, onSet: async () => { calls++; return { likeCount: 2, liked: true }; } });
  assert.equal(like.querySelector('button').disabled, true);
  assert.match(like.querySelector('.vid-like-note').textContent, /接続/);
  like.querySelector('button').click();
  const follow = createFollowButton(document, { following: false, signedIn: false, onSet: async () => { calls++; return true; } });
  assert.equal(follow.querySelector('button').disabled, true);
  follow.querySelector('button').click();
  assert.equal(calls, 0);
});

test('follow button flips, and is absent on your own channel', async () => {
  const document = doc();
  assert.equal(createFollowButton(document, { following: false, signedIn: true, isViewer: true, onSet: async () => true }), null);
  const asked = [];
  const wrap = createFollowButton(document, { following: false, signedIn: true, onSet: async (want) => { asked.push(want); return want; } });
  const button = wrap.querySelector('button');
  assert.equal(button.textContent, 'フォローする');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, [true]);
  assert.equal(button.textContent, 'フォロー中');
  assert.equal(wrap.following(), true);
});
