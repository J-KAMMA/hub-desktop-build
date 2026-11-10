import test from 'node:test';
import assert from 'node:assert/strict';
import { dataImageToBlobUrl, sniffImageKind } from './blob-image.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
const WEBP = [...Buffer.from('RIFF'), 4, 0, 0, 0, ...Buffer.from('WEBPVP8 ')];

test('valid PNG/JPEG/WebP/GIF data URLs become blob: URLs', () => {
  assert.equal(sniffImageKind(Uint8Array.from(WEBP)), 'webp');
  for (const [kind, bytes] of [['png', PNG], ['jpeg', [0xff, 0xd8, 0xff, 0xe0, 0]], ['webp', WEBP], ['gif', [...Buffer.from('GIF89a'), 0, 0]]]) {
    assert.match(dataImageToBlobUrl(`data:image/${kind};base64,${b64(bytes)}`), /^blob:/);
  }
});

test('mismatched, oversize, malformed and non-image values are refused', () => {
  const png = b64(PNG);
  for (const bad of [undefined, 42, '', 'https://x/a.png', `data:image/svg+xml;base64,${png}`, `data:text/html;base64,${png}`,
    `data:image/jpeg;base64,${png}`, `data:image/png;base64,${b64('not a png at all')}`, `data:image/png;base64,${png}!`,
    `data:image/png,${png}`, `data:image/png;base64,${png.slice(0, -1)}`]) assert.equal(dataImageToBlobUrl(bad), null, String(bad));
  assert.equal(dataImageToBlobUrl(`data:image/png;base64,${b64([...PNG, ...new Array(2000).fill(0)])}`, { maxBytes: 1000 }), null);
});

test('the same data URL maps to one blob URL', () => {
  const v = `data:image/png;base64,${b64([...PNG, 9, 9])}`;
  assert.equal(dataImageToBlobUrl(v), dataImageToBlobUrl(v));
});
