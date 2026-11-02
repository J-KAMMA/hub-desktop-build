import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { railAvatarModel, paintRailAvatar } from './rail-avatar.mjs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./desktop-shell.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const slot = () => new JSDOM('<span id="rail-profile-avatar"></span>').window.document.querySelector('#rail-profile-avatar');
const resolve = (img, url) => { img.src = 'https://hub.example' + url; };

test('rail profile item has an avatar slot, keeps its label, and no longer uses the person glyph', () => {
  const button = html.match(/<button[^>]*icon-nav-item[^>]*data-view="profile"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.match(button, /id="rail-profile-avatar"/);
  assert.match(button, /aria-label="プロフィール"/);
  assert.match(button, /title="プロフィール"/);
  assert.doesNotMatch(button, /<svg/);
});

test('picture on Hub avatar route renders a sized circular image with display name as alt', () => {
  const s = slot();
  paintRailAvatar(s, { displayName: 'Ada', avatarUrl: '/api/avatars/a1' }, resolve);
  const img = s.querySelector('img');
  assert.equal(img.getAttribute('src'), 'https://hub.example/api/avatars/a1');
  assert.equal(img.alt, 'Ada');
  assert.equal(img.getAttribute('width'), '24');
  assert.equal(img.getAttribute('height'), '24');
  assert.equal(img.getAttribute('loading'), 'lazy');
  assert.ok(s.classList.contains('has-image'));
});

test('no picture, signed out, or external URL fall back to the initial', () => {
  for (const [profile, text] of [[{ displayName: 'bob' }, 'B'], [null, '?'], [{ handle: 'x', avatarUrl: 'https://evil.example/a.png' }, 'X'], [{ displayName: 'c', avatarUrl: '//evil.example/a' }, 'C']]) {
    const s = slot();
    paintRailAvatar(s, profile, resolve);
    assert.equal(s.querySelector('img'), null);
    assert.equal(s.textContent, text);
    assert.ok(!s.classList.contains('has-image'));
  }
  assert.equal(railAvatarModel({ avatarUrl: 'javascript:1' }).src, null);
});

test('a broken image drops back to the initial', () => {
  const s = slot();
  paintRailAvatar(s, { displayName: 'Ada', avatarUrl: '/a' }, resolve);
  s.querySelector('img').dispatchEvent(new s.ownerDocument.defaultView.Event('error'));
  assert.equal(s.querySelector('img'), null);
  assert.equal(s.textContent, 'A');
});

test('app paints on summary load and clears on sign-out; CSS ring replaces filled state', () => {
  assert.match(app, /paintRailAvatar\(document\.querySelector\('#rail-profile-avatar'\), null/);
  assert.match(app, /paintRailAvatar\(document\.querySelector\("#rail-profile-avatar"\), me\.profile, hubAsset\)/);
  assert.match(css, /\.rail-avatar[^{]*\{[^}]*width: 24px/);
  assert.match(css, /\.icon-nav-item\.on \.rail-avatar[^{]*\{[^}]*box-shadow/);
});
