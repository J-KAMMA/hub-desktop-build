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
// 表示（ライセンスの行と公式の頁への入口）は右列の作品ページ。rail-music.test.mjs で確かめる。
