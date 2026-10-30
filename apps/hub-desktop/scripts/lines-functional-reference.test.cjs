const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Script } = require('node:vm');
const { verifySource } = require('./lines-functional-reference.cjs');

const correct = 'exports.uniqueLines = text => [...new Set(text.split(/[\\r\\n]+/).map(line => line.trim()).filter(Boolean))];';
test('accepts different implementations with identical correct behavior', () => {
  const result = verifySource(correct);
  assert.equal(result.profile, 'lines-functional-v1');
  assert.equal(result.cases, 362);
  assert.deepEqual(verifySource(correct.replace('exports.uniqueLines = ', 'module.exports = { uniqueLines: ').replace('))];', '))] };')), result);
  assert.deepEqual(verifySource("exports.uniqueLines = text => { const lines = text.replaceAll('\\r', '\\n').split('\\n').map(s => s.trim()).filter(s => s.length); return lines.filter((s, i) => lines.indexOf(s) === i); };"), result);
});

for (const [name, source] of [
  ['the previous cached result misses lone CR', correct.replace('/[\\r\\n]+/', '/\\r\\n|\\n/')],
  ['empty input', "exports.uniqueLines = text => text.split(/[\\r\\n]+/);"],
  ['sorting changes order', correct.replace('))];', '))].sort();')],
  ['case folding', correct.replace('line.trim()', 'line.trim().toLowerCase()')],
  ['internal whitespace', correct.replace('line.trim()', "line.trim().replace(/\\s+/g, ' ')")],
  ['Unicode normalization', correct.replace('line.trim()', 'line.trim().normalize()')],
  ['Unicode line separators are content', correct.replace('/[\\r\\n]+/', '/[\\r\\n\\u2028\\u2029]+/')],
  ['truncation', correct.replace('text.split', 'text.slice(0, 65536).split')],
  ['state leaking between calls', 'const seen = new Set(); exports.uniqueLines = text => text.split(/[\\r\\n]+/).map(s => s.trim()).filter(s => s && !seen.has(s) && seen.add(s));'],
  ['non-array result', 'exports.uniqueLines = text => text;'],
  ['execution timeout', 'exports.uniqueLines = text => { while (true) {} };'],
]) test(`rejects ${name}`, () => {
  new Script(source);
  assert.throws(() => verifySource(source), /case|array|timed out/);
});
