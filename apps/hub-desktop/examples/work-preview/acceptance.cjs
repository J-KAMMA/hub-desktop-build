const { test } = require('node:test');
const assert = require('node:assert/strict');
const { last } = require('./last.cjs');

const object = { title: 'fixture' };
[
  ['empty array', [], null],
  ['one item', [7], 7],
  ['last of several', [1, 2, 3], 3],
  ['zero', [0], 0],
  ['negative zero', [-0], -0],
  ['false', [false], false],
  ['empty string', [''], ''],
  ['null item', [null], null],
  ['undefined item', [undefined], undefined],
  ['NaN item', [NaN], NaN],
  ['sparse final slot', new Array(1), undefined],
  ['object identity', [object], object],
].forEach(([name, input, expected]) => {
  test(name, () => assert.strictEqual(last(Object.freeze(input)), expected));
});

[
  ['null', null], ['undefined', undefined], ['number', 4],
  ['string', 'abc'], ['boolean', false], ['array-like object', { 0: 'x', length: 1 }],
].forEach(([name, input]) => {
  test(`reject ${name}`, () => assert.throws(() => last(input), TypeError));
});
