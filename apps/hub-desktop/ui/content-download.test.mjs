import test from 'node:test';
import assert from 'node:assert/strict';

import { DOWNLOAD_NONE_NOTICE, musicDownloadAllowed, musicDownloadPageUrl } from './content-download.mjs';

const ID = '11111111-1111-4111-8111-111111111111';

test('only an explicit "anyone" opens the download button', () => {
  assert.equal(musicDownloadAllowed({ downloadPolicy: 'anyone' }), true);
  for (const value of ['none', 'entitled', 'ANYONE', undefined, null]) {
    assert.equal(musicDownloadAllowed({ downloadPolicy: value }), false);
  }
  assert.equal(musicDownloadAllowed(null), false);
});

test('the button opens the Hub work page, never a file URL', () => {
  assert.equal(musicDownloadPageUrl('https://hub.jkamma.com/', ID), `https://hub.jkamma.com/v2/music/works/music%3A${ID}`);
  assert.equal(musicDownloadPageUrl('javascript:alert(1)', ID), null);
  assert.equal(musicDownloadPageUrl('https://hub.jkamma.com', 'not-a-track'), null);
});

test('the none notice says recording cannot be prevented', () => {
  assert.match(DOWNLOAD_NONE_NOTICE, /録画/u);
});
