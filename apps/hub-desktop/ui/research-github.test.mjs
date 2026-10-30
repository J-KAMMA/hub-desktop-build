import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { initResearch } from './research.mjs';

function fixture(t, openGitHub) {
  const dom = new JSDOM('<section class="research-index-tools"><input id="research-query"><button id="research-refresh">更新</button><button id="research-create-web">作成</button></section><p id="research-state"></p><main id="research-results"></main>');
  t.after(() => dom.window.close());
  const document = dom.window.document, calls = [];
  const view = initResearch({ document, openGitHub, invoke: async (...args) => { calls.push(args); return { projects: [], hasMore: false }; }, openProject: () => {}, changed: () => {}, friendlyError: error => error.message });
  const button = [...document.querySelectorAll('.research-index-tools button')].find(button => button.textContent === 'GitHubの公開リポジトリを確認');
  return { document, button, view, calls };
}

test('research index exposes a reachable button that opens the integrated GitHub panel without fetching', async t => {
  const opened = [], f = fixture(t, () => opened.push('native-panel'));
  assert.ok(f.button?.isConnected);
  assert.equal(f.button.type, 'button');
  assert.equal(f.button.disabled, false);
  f.button.focus();
  assert.equal(f.document.activeElement, f.button);
  f.button.click();
  assert.deepEqual(opened, ['native-panel']);
  assert.deepEqual(f.calls, []);
  await f.view.load();
  assert.ok(f.button.isConnected);
  assert.equal(f.document.querySelectorAll('.research-index-tools button').length, 3);
});

test('GitHub entry is disabled when the Native panel callback is unavailable', t => {
  const f = fixture(t, undefined);
  assert.equal(f.button.disabled, true);
  assert.doesNotThrow(() => f.button.click());
  assert.deepEqual(f.calls, []);
});
