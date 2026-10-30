import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {RESEARCH_CHANGE_BYTES,parseResearchChangePackage,readResearchChangeFile,researchForkDigest} from './research-change-package.mjs';
const {buildSync}=createRequire(new URL('../../../package.json',import.meta.url))('esbuild');
// The existing pure Web parser is the reference; its network helpers are not called.
const reference=await import('data:text/javascript;base64,'+Buffer.from(buildSync({entryPoints:[fileURLToPath(new URL('../../hub/lib/research-change-package.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'}).outputFiles[0].text).toString('base64'));
const projectId='rp_'+'a'.repeat(32),baseHash=await researchForkDigest('base');
const packet=async values=>({protocol:'hub.research-change.v1',target:{origin:'https://original.example',projectId,documentId:'doc.v1',baseVersion:2,baseHash},body:'  proposed\r\nbody😀\0  ',summary:'理由',contentHash:await researchForkDigest(values?.body??'  proposed\r\nbody😀\0  '),...values});

test('actual Web parser parity preserves body whitespace CRLF NUL Unicode and canonical target',async()=>{
  for(const body of ['  proposed\r\nbody😀\0  ','\0','😀'.repeat(50000)]){const value=await packet({body});assert.deepEqual(await parseResearchChangePackage(value),await reference.parseResearchChangePackage(value));assert.equal((await parseResearchChangePackage(value)).body,body);}
  const value=await packet({summary:'\u0085reason\u0085'});assert.deepEqual(await parseResearchChangePackage(value),await reference.parseResearchChangePackage(value));
});
test('summary uses ECMAScript trim and rejects whitespace/NEL changes consistently with Web',async()=>{
  for(const summary of [' reason ','\ufeffreason','reason\ufeff','',' '.repeat(500),'x'.repeat(501)]){const value=await packet({summary});await assert.rejects(parseResearchChangePackage(value));await assert.rejects(reference.parseResearchChangePackage(value));}
  const value=await packet({summary:'x'.repeat(500),target:{origin:'http://127.0.0.1:3020',projectId,documentId:'.'.repeat(100),baseVersion:Number.MAX_SAFE_INTEGER,baseHash}});assert.deepEqual(await parseResearchChangePackage(value),await reference.parseResearchChangePackage(value));
});
test('malformed, unknown authority fields, target/type/hash/UTF16 bounds reject against the Web contract',async()=>{
  const value=await packet();
  const cases=[{...value,author:'not-authority'},{...value,body:value.body+'tampered'},{...value,body:'\ud800'},{...value,body:'x'.repeat(100001)},...[
    {origin:'https://user:pass@original.example'},{origin:'https://original.example/'},{origin:'http://remote.example'},{origin:'https://original.example?x=1'},
    {projectId:projectId+'\n'},{documentId:'../doc'},{documentId:'d'.repeat(101)},{documentId:'d\n'},{documentId:'d\r'},{documentId:'d\u2028'},{baseVersion:0},{baseVersion:'2'},{baseVersion:Number.MAX_SAFE_INTEGER+1},{baseHash:baseHash+'\n'},
  ].map(target=>({...value,target:{...value.target,...target}}))];
  for(const input of cases){await assert.rejects(parseResearchChangePackage(input));await assert.rejects(reference.parseResearchChangePackage(input));}
  await assert.rejects(parseResearchChangePackage({...value,[Symbol('authority')]:true}));
});
test('exact 500000 serialized UTF8 bytes including NUL expansion accepts, one extra byte rejects',async()=>{
  const seed=await packet(),escaped='\0'.repeat(80000),overhead=new TextEncoder().encode(JSON.stringify({...seed,body:''})).byteLength;
  const body=escaped+'x'.repeat(RESEARCH_CHANGE_BYTES-overhead-escaped.length*6),value=await packet({body});assert.equal(new TextEncoder().encode(JSON.stringify(value)).byteLength,500000);
  assert.equal((await parseResearchChangePackage(value)).body,body);assert.deepEqual(await parseResearchChangePackage(value),await reference.parseResearchChangePackage(value));
  const over=await packet({body:body+'x'});await assert.rejects(parseResearchChangePackage(over));await assert.rejects(reference.parseResearchChangePackage(over));
});
test('file reads bound declared and actual bytes and use fatal UTF8 before packet validation',async()=>{
  let read=0;await assert.rejects(readResearchChangeFile({size:500001,arrayBuffer:async()=>{read++;return new ArrayBuffer(0);}}));assert.equal(read,0);
  await assert.rejects(readResearchChangeFile({size:1,arrayBuffer:async()=>new ArrayBuffer(500001)}));
  await assert.rejects(readResearchChangeFile({size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer}));
  await assert.rejects(readResearchChangeFile({size:1,arrayBuffer:async()=>new Uint8Array([0])}));
  const value=await packet(),bytes=new TextEncoder().encode(JSON.stringify(value));assert.deepEqual(await readResearchChangeFile({size:bytes.length,arrayBuffer:async()=>bytes.buffer}),value);
});
