import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RESEARCH_GIT_CHANGE_BYTES,createResearchGitChangePackage,parseResearchGitChangePackage,parseResearchGitChangeTarget,readResearchGitChangeFile} from './research-git-change-package.mjs';
const projectId=`rp_${'a'.repeat(32)}`;
const input=()=>({protocol:'hub.research-git-change.v1',target:{origin:'https://original.example',projectId},baseOid:'1'.repeat(40),headOid:'2'.repeat(40),title:'変更 🧪',summary:'比較対象の理由'});
// Independent Node digest anchors the complete ordered protocol object.
function signed(value=input()){
  const body={protocol:value.protocol,target:{origin:value.target.origin,projectId:value.target.projectId},baseOid:value.baseOid,headOid:value.headOid,title:value.title,summary:value.summary};
  return {...body,contentHash:`sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`};
}
const file=(body,size)=>{const bytes=typeof body==='string'?new TextEncoder().encode(body):body;return {size:size??bytes.byteLength,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};};
test('canonical digest agrees with Node, preserving Unicode and ignoring key/file whitespace order',async()=>{
  const p=signed();assert.deepEqual(await createResearchGitChangePackage(input()),p);
  assert.deepEqual(await parseResearchGitChangePackage({summary:p.summary,contentHash:p.contentHash,title:p.title,headOid:p.headOid,target:{projectId,origin:p.target.origin},baseOid:p.baseOid,protocol:p.protocol}),p);
  assert.deepEqual(Object.keys(await parseResearchGitChangePackage(p)),['protocol','target','baseOid','headOid','title','summary','contentHash']);
  assert.deepEqual(await readResearchGitChangeFile(file(JSON.stringify(p,null,2))),p);
});
test('all logical contents are hash-bound and digest syntax is closed',async()=>{
  const p=signed();for(const patch of [{baseOid:'3'.repeat(40)},{headOid:'4'.repeat(40)},{title:'Other title'},{summary:'Other reason'},{target:{...p.target,projectId:`rp_${'b'.repeat(32)}`}},{target:{...p.target,origin:'https://other.example'}}])await assert.rejects(parseResearchGitChangePackage({...p,...patch}));
  for(const contentHash of ['sha256:'+'0'.repeat(64),p.contentHash.toUpperCase(),p.contentHash+'\n',p.contentHash.slice(0,-1),null])await assert.rejects(parseResearchGitChangePackage({...p,contentHash}));
});
test('closed schemas reject extra enumerable, symbol and hidden keys, arrays and inherited fields',async()=>{
  const p=signed();for(const value of [null,[],{},'json',{...p,author:'foreign'},{...p,target:{...p.target,author:'foreign'}},{...p,target:[]},Object.create(p),{...p,[Symbol('extra')]:true},Object.defineProperty({...p},'secret',{value:true})])await assert.rejects(parseResearchGitChangePackage(value));
  for(const key of Object.keys(p)){const value={...p};delete value[key];await assert.rejects(parseResearchGitChangePackage(value));}
  await assert.rejects(createResearchGitChangePackage(p));await assert.rejects(parseResearchGitChangePackage({...p,protocol:'wrong'}));
});
test('both complete OID widths work; equal, mixed, uppercase and malformed OIDs fail',async()=>{
  const value={...input(),baseOid:'a'.repeat(64),headOid:'b'.repeat(64)};assert.deepEqual(await createResearchGitChangePackage(value),signed(value));
  for(const patch of [{headOid:value.baseOid},{headOid:'b'.repeat(40)},{baseOid:'A'.repeat(64)},{baseOid:'a'.repeat(63)},{baseOid:'a'.repeat(65)},{baseOid:'a'.repeat(64)+'\n'},{baseOid:'z'.repeat(64)},{baseOid:10}])await assert.rejects(createResearchGitChangePackage({...value,...patch}));
});
test('UTF16 limits allow paired astral text and refuse NUL, unpaired surrogates, whitespace and huge input',async()=>{
  const value={...input(),title:'😀'.repeat(120),summary:'😀'.repeat(250)};assert.deepEqual(await createResearchGitChangePackage(value),signed(value));
  for(const patch of [{title:value.title+'x'},{summary:value.summary+'x'},{title:''},{summary:'\t \n'},{title:' title'},{summary:'reason\n'},{title:'bad\0text'},{summary:'bad\ud800text'},{title:'\udc00'},{summary:'\ud800\ud800'},{title:'x'.repeat(100000)}])await assert.rejects(createResearchGitChangePackage({...value,...patch}));
  const controls={...input(),title:'x\u0001x',summary:'e\u0301😀'};assert.deepEqual(await createResearchGitChangePackage(controls),signed(controls));
});
test('stored origins are exact and IDs lowercase complete; HTTP is loopback only',async()=>{
  for(const origin of ['https://original.example','http://localhost:3020','http://127.0.0.1:3020','http://[::1]:3020'])assert.equal((await createResearchGitChangePackage({...input(),target:{origin,projectId}})).target.origin,origin);
  for(const origin of ['http://original.example','https://user:pass@original.example','https://original.example/','https://ORIGINAL.example','https://original.example:443',' https://original.example','https://original.example/?q=1','https://original.example/#git','https://original.example/path','ftp://original.example','https://'+'a'.repeat(513)])await assert.rejects(createResearchGitChangePackage({...input(),target:{origin,projectId}}));
  for(const id of [projectId+'\n',projectId.toUpperCase(),'rp_'+'a'.repeat(31),'rp_'+'a'.repeat(33),'../project'])await assert.rejects(createResearchGitChangePackage({...input(),target:{origin:input().target.origin,projectId:id}}));
});
test('target URLs normalize origins and refuse altered paths, escaping, queries, auth and fragments',()=>{
  const url=`https://original.example/v2/research/${projectId}`,target={origin:'https://original.example',projectId};assert.deepEqual(parseResearchGitChangeTarget(url),target);assert.deepEqual(parseResearchGitChangeTarget(`HTTPS://ORIGINAL.example:443/v2/research/${projectId}#git`),target);assert.deepEqual(parseResearchGitChangeTarget(`http://[::1]:3020/v2/research/${projectId}#git`),{origin:'http://[::1]:3020',projectId});
  for(const value of [url+'/',url+'?',url+'?x=1',url+'#',url+'#other',url+'#GIT',url+'\n',' '+url,url.replace('/v2/','/V2/'),url.replace('/v2/','/v2/./'),url.replace('/v2/','/other/../v2/'),url.replace('rp_','%72p_'),url.replace(projectId,projectId.toUpperCase()),url.replace('://','://user:pass@'),url.replace('/v2/','\\v2/'),url.replace('https:','http:'),`/v2/research/${projectId}`,url.replace('/v2/','/v2/\n')])assert.throws(()=>parseResearchGitChangeTarget(value));
});
test('file cap measures both declared and actual UTF8 bytes at exactly 8192',async()=>{
  assert.equal(RESEARCH_GIT_CHANGE_BYTES,8192);const p=signed(),json=JSON.stringify(p),bytes=new TextEncoder().encode(json).byteLength;assert.deepEqual(await readResearchGitChangeFile(file(json+' '.repeat(8192-bytes))),p);
  let reads=0;for(const size of [8193,-1,Infinity,NaN,1.5])await assert.rejects(readResearchGitChangeFile({size,arrayBuffer:async()=>{reads++;return new ArrayBuffer(0);}}));assert.equal(reads,0);
  await assert.rejects(readResearchGitChangeFile(file(json+' '.repeat(8193-bytes),1)),/8KiB/);await assert.rejects(readResearchGitChangeFile(file('界'.repeat(3000),3000)),/8KiB/);
});
test('fatal UTF8 refuses invalid encodings, partial sequences and invalid JSON text',async()=>{
  for(const bytes of [new Uint8Array([255]),new Uint8Array([0xc0,0xaf]),new Uint8Array([0xed,0xa0,0x80]),new Uint8Array([0xe3,0x81])])await assert.rejects(readResearchGitChangeFile(file(bytes)));
  for(const body of ['', '{',JSON.stringify({...signed(),title:'\ud800'}),JSON.stringify({...signed(),summary:'\0'}),'x'.repeat(8192)])await assert.rejects(readResearchGitChangeFile(file(body)));
});
