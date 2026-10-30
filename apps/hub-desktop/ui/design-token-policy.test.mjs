import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
const dir = new URL('./', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('./design-token-baseline.json', import.meta.url), 'utf8'));
const RAW = /(?:font-size|border-radius)\s*:\s*\d+(?:\.\d+)?px/g;
export function countRaw(css) {
  return (css.replace(/\/\*[\s\S]*?\*\//g, '').match(RAW) || []).length;
}
test('raw font-size / border-radius px counts never grow past the baseline', () => {
  const grew = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    const n = countRaw(readFileSync(new URL(file, dir), 'utf8'));
    const allowed = baseline[file] ?? 0;
    if (n > allowed) grew.push(`${file}: ${n} > ${allowed}`);
  }
  assert.deepEqual(grew, [], 'use tokens (--type-*, --radius-*) instead of raw px; lower the baseline when you remove some');
});
test('components.css uses no raw type or radius px', () => {
  assert.equal(countRaw(readFileSync(new URL('./components.css', dir), 'utf8')), 0);
  assert.equal(baseline['components.css'] ?? 0, 0);
});
