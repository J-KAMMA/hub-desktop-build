import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackOwner } from './playback-owner.mjs';

test('claim pauses every other owner but not the claimer', () => {
  const o = createPlaybackOwner(), log = [];
  o.register('a', () => log.push('a')); o.register('b', () => log.push('b')); o.register('c', () => log.push('c'));
  o.claim('b');
  assert.deepEqual(log, ['a', 'c']);
  assert.equal(o.current(), 'b');
});

test('a throwing pause does not stop the others', () => {
  const o = createPlaybackOwner(), log = [];
  o.register('a', () => { throw new Error('x'); }); o.register('b', () => log.push('b'));
  assert.doesNotThrow(() => o.claim('c'));
  assert.deepEqual(log, ['b']);
});

test('unregister removes only its own registration', () => {
  const o = createPlaybackOwner(), log = [];
  const off = o.register('a', () => log.push('old'));
  o.register('a', () => log.push('new'));
  off(); o.claim('z');
  assert.deepEqual(log, ['new']);
  const off2 = o.register('b', () => log.push('b')); off2(); o.claim('z');
  assert.deepEqual(log, ['new', 'new']);
});
