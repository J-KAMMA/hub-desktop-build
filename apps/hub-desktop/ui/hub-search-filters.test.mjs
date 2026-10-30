import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {normalizeHubSearchFilters as normalize, hasHubSearchFilters, HUB_SEARCH_LANGUAGES, HUB_SEARCH_TYPES} from './hub-search-filters.mjs';
const require = createRequire(new URL('../../../package.json',import.meta.url));
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../../hub/lib/search-filters.ts',import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
const web = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('defaults, aliases and all conditions match the independent Web contract', () => {
  for (const input of [{}, {currency:'eur'}, {maxPrice:'0'}, {maxPrice:'00012.50',currency:'usd'},
    {from:'2024-02-29',to:'2024-03-01',maxPrice:'001',currency:'jpy',language:' ZH ',region:' ＪＰ　東 京 ',category:' ＡＲＴ  Film ',type:' VIDEOS '},
    ...HUB_SEARCH_LANGUAGES.map(language=>({language})), ...HUB_SEARCH_TYPES.map(type=>({type})),
    {language:'ALL',type:'ANY'}, {maxPrice:'9007199254740991'}, {maxPrice:'90071992547409.91',currency:'EUR'},
    {region:'😀'.repeat(40)}, {category:'㍿'.repeat(20)}, {maxPrice:'0'.repeat(32)}]) {
    const expected = web.parseHubSearchFilters(input);
    assert.equal(expected.ok,true,JSON.stringify(input)); assert.deepEqual(normalize(input),expected.filters);
    assert.equal(hasHubSearchFilters(normalize(input)),web.hasHubSearchFilters(expected.filters));
  }
  const input={region:' ＪＰ '}, first=normalize(input); first.region='changed';
  assert.equal(input.region,' ＪＰ '); assert.equal(normalize(input).region,'jp');
  assert.equal(hasHubSearchFilters(normalize({maxPrice:'0'})),true);
  assert.equal(hasHubSearchFilters(normalize({currency:'USD'})),false);
});
test('invalid calendar, money widths and metadata lengths never broaden the Web scope', () => {
  for (const input of [{from:'0000-01-01'},{from:'2023-02-29'},{to:'2024-02-30'},{from:'2024-2-01'},
    {from:'2024-03-01',to:'2024-02-29'},{maxPrice:'1.0'},{maxPrice:'1.001',currency:'USD'},
    {maxPrice:'9007199254740992'},{maxPrice:'90071992547409.92',currency:'USD'},
    {maxPrice:'0'.repeat(33)},{maxPrice:'-1'},{maxPrice:'1e2'},{maxPrice:'NaN'}, {currency:'GBP'},
    {language:'zz'},{type:'music'},{region:'x'.repeat(81)},{category:'😀'.repeat(41)},
    {category:'㍿'.repeat(21)},{region:'a\nb'},{category:'a\u0085b'}]) {
    assert.equal(web.parseHubSearchFilters(input).ok,false,JSON.stringify(input));
    assert.throws(()=>normalize(input),TypeError);
  }
});
test('Desktop IPC rejects unknown keys and wrong value/container types', () => {
  for (const input of [null,[],42,'',new Date(),{tags:'art'},{minPrice:'0'},{[Symbol('key')]:'x'},
    ...['from','to','maxPrice','currency','language','region','category','type'].flatMap(key=>[null,1,true,[],{}].map(value=>({[key]:value})))]) assert.throws(()=>normalize(input),TypeError);
  assert.deepEqual(normalize(Object.create(null)),normalize());
  assert.deepEqual(normalize({region:undefined}),normalize());
});
