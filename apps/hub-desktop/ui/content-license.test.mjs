import assert from 'node:assert/strict';
import test from 'node:test';
import { isContentLicense, licenseDeedUrl, openLicenseLabel } from './content-license.mjs';

const IDS = ['arr', 'cc-by-4.0', 'cc-by-sa-4.0', 'cc-by-nc-4.0', 'cc-by-nc-sa-4.0', 'cc-by-nd-4.0', 'cc-by-nc-nd-4.0', 'cc0-1.0'];

test('knows exactly the 8 license ids', () => {
  for (const id of IDS) assert.equal(isContentLicense(id), true, id);
  for (const id of ['', 'CC-BY-4.0', 'cc-by-4', 'mit', null, undefined, 4, '__proto__', 'constructor']) assert.equal(isContentLicense(id), false, String(id));
});

test('shows a label only for the 7 open licenses', () => {
  assert.equal(openLicenseLabel('arr'), null);
  assert.equal(openLicenseLabel('cc-by-nc-sa-4.0'), 'CC BY-NC-SA 4.0');
  assert.equal(openLicenseLabel('cc0-1.0'), 'CC0 1.0');
  assert.equal(openLicenseLabel('nonsense'), null);
  assert.equal(openLicenseLabel(undefined), null);
});

test('deed links point at creativecommons.org over https and exist for every open license', () => {
  for (const id of IDS.slice(1)) {
    const url = licenseDeedUrl(id);
    assert.ok(url && url.startsWith('https://creativecommons.org/') && url.endsWith('deed.ja'), id);
  }
  assert.equal(licenseDeedUrl('cc-by-4.0'), 'https://creativecommons.org/licenses/by/4.0/deed.ja');
  assert.equal(licenseDeedUrl('cc0-1.0'), 'https://creativecommons.org/publicdomain/zero/1.0/deed.ja');
  assert.equal(licenseDeedUrl('arr'), null);
  assert.equal(licenseDeedUrl('mit'), null);
});

// 表示：Hubの公開曲の詳細にだけ、CCのときに限りライセンスの行と公式の頁への入口を出す。
import { createRequire } from 'node:module';
import { createMusicYoutubeSession } from './music-youtube.mjs';
import { renderMusicWorkHeader } from './music-work-detail.mjs';
const { JSDOM } = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

function header(work, local) {
  const dom = new JSDOM('<main></main>');
  const { document } = dom.window;
  const opened = [];
  const session = createMusicYoutubeSession({ document, bar: document.createElement('div'), hubAsset: () => {} });
  const result = renderMusicWorkHeader({ document, work, session, hubAsset: () => {}, openExternal: url => opened.push(url), local });
  return { root: result.root, opened, close: () => { result.destroy?.(); dom.window.close(); } };
}
const track = { id: 'a1111111-1111-4111-8111-111111111111', title: '曲', artist: '歌い手' };
const local = { play() {}, next() {} };

test('a Hub-published CC track shows the license line and opens the deed', () => {
  const view = header({ ...track, license: 'cc-by-sa-4.0' }, local);
  const line = view.root.querySelector('.mw-license');
  assert.ok(line);
  assert.match(line.textContent, /ライセンス：CC BY-SA 4\.0/);
  line.querySelector('button').click();
  assert.deepEqual(view.opened, ['https://creativecommons.org/licenses/by-sa/4.0/deed.ja']);
  view.close();
});

test('all rights reserved, unknown values and external works show no license line', () => {
  for (const [work, hub] of [[{ ...track, license: 'arr' }, local], [{ ...track, license: 'gpl' }, local], [{ ...track }, local], [{ ...track, license: 'cc0-1.0' }, null]]) {
    const view = header(work, hub);
    assert.equal(view.root.querySelector('.mw-license'), null, JSON.stringify(work));
    view.close();
  }
});
