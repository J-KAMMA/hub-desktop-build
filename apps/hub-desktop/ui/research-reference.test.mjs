
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {researchDiscussionReference as reference,researchGitDiscussionReference as gitReference} from './research-reference.mjs';
const href='/v2/research/rp_1?document=doc_1&version=1';
const suffix=value=>`Discussion\nsha256:${'a'.repeat(64)}\n${value}`;
test('canonical references preserve opaque IDs and the pinned safe integer version',()=>{
  assert.deepEqual(reference(suffix(href)),{href,version:1});
  const unicode='/v2/research/%E7%A0%94%E7%A9%B6?document=code%3Fname%25&version=9007199254740991';
  assert.deepEqual(reference(suffix(unicode)),{href:unicode,version:Number.MAX_SAFE_INTEGER});
  const boundary=`/v2/research/${'a'.repeat(240)}?document=${'b'.repeat(240)}&version=1`;
  assert.deepEqual(reference(suffix(boundary)),{href:boundary,version:1});
});
for(const value of [
  'https://hub.jkamma.com'+href,'//evil.test'+href,'/v2/research/..?document=d&version=1',
  '/v2/research/%2E%2E?document=d&version=1','/v2/research/a%2Fb?document=d&version=1',
  '/v2/research/a%5Cb?document=d&version=1','/v2/research/%00?document=d&version=1',
  '/v2/research/%20?document=d&version=1','/v2/research/%7F?document=d&version=1',
  '/v2/research/%C2%80?document=d&version=1','/v2/research/%zz?document=d&version=1',
  '/v2/research/%61?document=d&version=1','/v2/research/%e7%a0%94?document=d&version=1',
  href+'&document=x',href+'&other=x',href+'#x',href.replace('document=doc_1&version=1','version=1&document=doc_1'),
  ...['0','01','9007199254740992','1.1','1e2'].map(n=>href.replace('version=1',`version=${n}`)),
  `/v2/research/${'a'.repeat(241)}?document=d&version=1`,
  '/v2/research/rp?document=a%2Fb&version=1',
  `/v2/research/${encodeURIComponent('研'.repeat(240))}?document=d&version=1`,
])test(`unsafe or noncanonical reference is rejected: ${value.slice(0,100)}`,()=>assert.equal(reference(suffix(value)),null));
test('exact hash, final line, string type, and UTF16 body width are required',()=>{
  for(const value of [href,suffix(href).replace('a'.repeat(64),'abc'),suffix(href).replace('sha256:a','sha256:A'),suffix(href)+'\nextra',suffix(href)+'\n',null,42,{}])assert.equal(reference(value),null);
  const end=suffix(href),body='😀'.repeat(Math.floor((4000-end.length)/2))+'x'.repeat((4000-end.length)%2)+end;
  assert.equal(body.length,4000);assert.deepEqual(reference(body),{href,version:1});assert.equal(reference('x'+body),null);
});

test('Git reference requires the same complete hash, canonical project, exact final line and body limit',()=>{
  const p='rp_'+'a'.repeat(32),oid='b'.repeat(40),href=`/v2/research/${p}?commit=${oid}#git`,body=`A question\n\n参照Git: Project / Fix\n${oid}\n${href}`;
  assert.deepEqual(gitReference(body),{href,oid});assert.equal(gitReference(body.replaceAll(oid,'c'.repeat(64))).oid,'c'.repeat(64));
  for(const invalid of [null,42,body+'\n',body+'\nextra',body.replace(href,'https://hub.jkamma.com'+href),body.replace(`commit=${oid}`,`commit=${'d'.repeat(40)}`),body.replace('#git','#other'),body.replace(p,'..'),body.replace(p,'%72'+p.slice(1)),body.replaceAll(oid,oid.toUpperCase()),'x'.repeat(4000)+body])assert.equal(gitReference(invalid),null);
});

test('native fixed commit navigation stays inside the application',async()=>{
  const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
  const start=source.indexOf('async function openHubPath('),end=source.indexOf('\n}',start)+2;
  assert.ok(start>=0&&end>start);
  const detailStart=source.indexOf('function detailForHubPath(path) {'),detailEnd=source.indexOf('\n}',detailStart)+2;
  const detail=new Function(`return (${source.slice(detailStart,detailEnd)});`)(),calls=[];
  const open=new Function('invoke','openDetail','detailForHubPath','navigateFrom','showNotice','friendlyError',`return (${source.slice(start,end)});`)(async()=>assert.fail('No external browser'),(...args)=>calls.push(args),detail,()=>{},()=>{},String);
  const p='rp_'+'a'.repeat(32),oid='b'.repeat(40),href=`/v2/research/${p}?commit=${oid}#git`;
  await open(href);assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),['research_git_commit',[p,oid]]);assert.equal(calls[0][2].title,'コードの変更');assert.equal(typeof calls[0][2].isCurrent,'function');assert.equal(calls[0][2].isCurrent(),true);
  for(const invalid of [href+'\n',href+'&other=x',href.replace('#git','#other'),href.replace(oid,oid.toUpperCase()),'https://evil.test'+href]){calls.length=0;await open(invalid);assert.equal(calls.length,0);}
});
