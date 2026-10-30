// Independent acceptance for a declared string-only task. Kept outside the
// model workspace and embedded in the Rust test binary before inference.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const vm = require('node:vm');

const profile = 'lines-functional-v1';
const cases = [
  ['', []],
  ['a', ['a']],
  ['a\rb', ['a', 'b']],
  ['a\r\nb\nc\ra', ['a', 'b', 'c']],
  ['\r\n\n\r', []],
  [' a \r\nb\r\n a ', ['a', 'b']],
  [' \n\t\n', []],
  ['日\n日\nA\na', ['日', 'A', 'a']],
  ['z\na\nz\nb', ['z', 'a', 'b']],
  [' a  b \na b\na\tb', ['a  b', 'a b', 'a\tb']],
  ['__proto__\nconstructor\ntoString\n__proto__', ['__proto__', 'constructor', 'toString']],
  ['0\nfalse\nnull\nundefined\n0', ['0', 'false', 'null', 'undefined']],
  ['x.y\n[x]\n\\\n/\nx.y', ['x.y', '[x]', '\\', '/']],
  ['😀\n😀\né\ne\u0301', ['😀', 'é', 'e\u0301']],
  ['a\0b\na\0b\n\ud800', ['a\0b', '\ud800']],
  ['\ufeff\u00a0a\u3000\n\u2003b\t', ['a', 'b']],
  ['a\u2028b\na\u2029b', ['a\u2028b', 'a\u2029b']],
  ['x'.repeat(65537) + '\r' + 'x'.repeat(65537), ['x'.repeat(65537)]],
  [Array.from({ length: 8193 }, (_, i) => ` row${i % 257} `).join('\r\n'),
    Array.from({ length: 257 }, (_, i) => `row${i}`)],
];

// Exhaust short combinations to cover adjacent CR/LF, trim and empty records.
const alphabet = ['a', 'A', '\r', '\n', ' ', '\t', '日'];
for (const a of alphabet) for (const b of alphabet) for (const c of alphabet) {
  const input = a + b + c;
  cases.push([input, [...new Set(input.split('\r').flatMap(line => line.split('\n')).map(line => line.trim()).filter(Boolean))]]);
}

function verifySource(source) {
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports });
  vm.runInContext(source, context, { timeout: 1000 });
  assert.equal(typeof context.module.exports.uniqueLines, 'function', 'CommonJS export');
  const digest = createHash('sha256');
  for (const [index, [input, expected]] of cases.entries()) {
    context.input = input;
    const actual = vm.runInContext('module.exports.uniqueLines(input)', context, { timeout: 1000 });
    assert.ok(Array.isArray(actual), `case ${index}: result must be an array`);
    assert.deepEqual(Array.from(actual), expected, `case ${index}`);
    digest.update(JSON.stringify([input, Array.from(actual)]) + '\n');
  }
  return { profile, cases: cases.length, behaviorHash: digest.digest('hex') };
}

module.exports = { verifySource };
