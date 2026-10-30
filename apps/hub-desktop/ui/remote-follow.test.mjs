import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {isRemoteProfile, normalizeRemoteHandle, remoteFollowForm, remoteFollowStateLabel} from './remote-follow.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('normalizeRemoteHandle accepts only name@host and returns the @name@host form', () => {
  assert.equal(normalizeRemoteHandle(' @bob@hub.example '), '@bob@hub.example');
  assert.equal(normalizeRemoteHandle('bob@127.0.0.1:3030'), '@bob@127.0.0.1:3030');
  for (const bad of ['', 'bob', '@bob@', '@@hub.example', 'bob@hub', 'bob@hub.example/x', 'b ob@hub.example', 'a@b@hub.example', null, 1]) {
    assert.equal(normalizeRemoteHandle(bad), null, String(bad));
  }
});

test('isRemoteProfile recognises shadow profiles by flag, user@host or random r~ handle, not local handles', () => {
  assert.equal(isRemoteProfile({ isRemote: true, profile: { handle: 'x' } }), true);
  assert.equal(isRemoteProfile({ profile: { handle: 'bob@hub.example' } }), true);
  assert.equal(isRemoteProfile({ profile: { handle: 'r~0123456789abcdef01234567' } }), true);
  assert.equal(isRemoteProfile({ profile: { handle: 'alice' } }), false);
  assert.equal(isRemoteProfile({}), false);
});

test('state labels show pending and accepted', () => {
  assert.equal(remoteFollowStateLabel('pending'), '承認待ち');
  assert.equal(remoteFollowStateLabel('accepted'), 'フォロー中');
});

test('the form sends only the closed follow_remote verb, shows pending, and lists follows with their state', async () => {
  const dom = new JSDOM('');
  const calls = [];
  const form = remoteFollowForm({
    document: dom.window.document,
    invoke: async (name, args) => {
      calls.push({ name, args: structuredClone(args) });
      if (name === 'hub_client') return { follows: [{ displayName: 'Bob', handle: 'bob@hub.example', state: 'pending' }] };
      return { state: 'pending', displayName: 'Bob', handle: 'bob@hub.example' };
    },
  });
  dom.window.document.body.append(form.root);

  form.input.value = 'nonsense';
  form.button.click();
  await tick();
  assert.equal(calls.length, 0);
  assert.match(form.status.textContent, /@名前@ホスト/);

  form.input.value = 'bob@hub.example';
  form.button.click();
  await tick();
  await tick();
  assert.deepEqual(calls[0], { name: 'hub_client_action', args: { action: 'follow_remote', options: { handle: '@bob@hub.example' } } });
  assert.deepEqual(calls[1], { name: 'hub_client', args: { name: 'remote_follows' } });
  assert.match(form.status.textContent, /承認待ち/);
  assert.match(form.list.textContent, /Bob @bob@hub\.example — 承認待ち/);
  dom.window.close();
});

test('the profile detail hides the message button for remote profiles and offers the follow form on the own profile', () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /if \(isRemoteProfile\(data\)\) \{[\s\S]{0,400}actions\.append\(follow, note\);[\s\S]{0,60}\} else \{\s*actions\.append\(follow, dm\);/);
  assert.match(source, /remoteFollowForm\(\{ document, invoke, friendlyError \}\)/);
});
