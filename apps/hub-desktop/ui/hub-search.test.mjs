import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHubSearch,searchSources} from './hub-search.mjs';
const token = payload => `${payload}.${'a'.repeat(43)}`;
const item = (id,title=id) => ({sourceGroup:'posts',ref:{id},title});
const empty = (command,args) => args.resource === 'search' ? {coreEntities:[]} : {[command === 'music_tracks' ? 'tracks' : {articles:'articles',music:'works',research:'projects',books:'books'}[args.resource]]:[],hasMore:false};
function setup(handler=empty) {
  const calls=[], states=[];
  const search=createHubSearch({invoke:(command,args)=>{calls.push({command,args:structuredClone(args)});return handler(command,args);},changed:state=>states.push(state)});
  return {search,calls,states};
}
test('empty query only executes active filters and every condition is forwarded to Hub alone',async()=>{
  const {search,calls}=setup();
  await search.search(''); await search.search(' ',{filters:{currency:'USD'}}); assert.equal(calls.length,0);
  for(const filters of [{from:'2024-01-01'},{to:'2024-01-01'},{maxPrice:'0'},{language:'zh'},{region:'JP'},{category:'ART'},{type:'images'}]) {
    const before=calls.length; await search.search('',{filters,order:'kind'});
    assert.equal(calls.length,before+1);assert.equal(calls.at(-1).args.resource,'search');
    assert.deepEqual(calls.at(-1).args.searchFilters,search.snapshot().filters);assert.equal(calls.at(-1).args.order,'kind');
    assert.deepEqual(search.snapshot().sources,['hub']);assert.equal(search.snapshot().filtered,true);
  }
  await search.search(' ＨＵＢ '); const last=calls.slice(-6);
  assert.equal(last.length,6);assert.deepEqual(search.snapshot().sources,Object.keys(searchSources));assert.equal(search.snapshot().query,'hub');
  assert.equal(last.filter(call=>'searchFilters' in call.args).length,1);assert.equal(search.snapshot().filtered,false);
});
test('query normalized UTF16/word/control boundaries and invalid options issue no IPC',async()=>{
  const {search,calls}=setup();
  for(const [term,options] of [[42,{}],['x'.repeat(101),{}],['㍿'.repeat(26),{}],['😀'.repeat(51),{}],['a '.repeat(9),{}],['a\0b',{}],['a\u0085b',{}],['q',{filters:{tags:'x'}}],['q',{filters:null}],['q',{order:null}],['q',{order:'other'}],['q',{extra:true}],['q',[]]]) {
    const before=calls.length;await search.search(term,options);assert.equal(calls.length,before);assert.ok(search.snapshot().errors.hub);assert.ok(['recommended','kind'].includes(search.snapshot().order));
    await search.retry('hub');assert.equal(calls.length,before);
  }
  for(const term of ['x'.repeat(100),'㍿'.repeat(25),'😀'.repeat(50),'a\tb\nc d e f g h']) {
    const before=calls.length;await search.search(term);assert.equal(calls.length,before+6);assert.equal(search.snapshot().errors.hub,undefined);
  }
});
test('caller, IPC response and snapshots cannot mutate search scope or retained records',async()=>{
  const response={coreEntities:[item('one')],nextCursor:token('first'),hasMore:true};
  const {search,calls}=setup((_command,args)=>{args.searchFilters.region='attacker';return response;});
  const filters={region:'JP'};await search.search('',{filters});filters.region='us';response.coreEntities[0].ref.id='changed';
  const state=search.snapshot();state.filters.region='xx';state.data.coreEntities[0].ref.id='snapshot';state.sources.push('books');
  assert.equal(search.snapshot().filters.region,'jp');assert.equal(search.snapshot().data.coreEntities[0].ref.id,'one');
  await search.more('hub');assert.equal(calls.at(-1).args.searchFilters.region,'jp');
});
test('real deferred races discard previous conditions, account invalidation and ABA queries',async()=>{
  const waits=[];const {search}=setup((_command,args)=>new Promise((resolve,reject)=>waits.push({args,resolve,reject})));
  const old=search.search('A',{filters:{region:'jp'}}), newer=search.search('A',{filters:{region:'us'},order:'kind'});
  waits[0].reject(Error('stale'));await old;assert.deepEqual(search.snapshot().pending,['hub']);assert.equal(search.snapshot().errors.hub,undefined);
  waits[1].resolve({coreEntities:[item('new')],nextCursor:token('next')});await newer;
  const page=search.more('hub');search.invalidate();const again=search.search('A',{filters:{region:'jp'}});
  waits[2].resolve({coreEntities:[item('page')],nextCursor:token('last')});await page;
  assert.deepEqual(search.snapshot().pending,['hub']);assert.equal(search.snapshot().data.coreEntities,undefined);
  waits[3].resolve({coreEntities:[item('current')]});await again;assert.deepEqual(search.snapshot().data.coreEntities.map(x=>x.ref.id),['current']);
});
test('continuations keep scope, deduplicate overlap and retries retain the failed cursor',async()=>{
  let count=0;const {search,calls}=setup(()=>{
    count++;if(count===1)return {coreEntities:[item('one')],nextCursor:token('first'),hasMore:true};
    if(count===2)throw Error('offline');return {coreEntities:[item('one','updated'),item('two')],nextCursor:null,hasMore:false};
  });
  await search.search('',{filters:{category:'ART'},order:'kind'});await search.more('hub');
  assert.ok(search.snapshot().errors.hub);assert.deepEqual(search.snapshot().more,['hub']);assert.equal(search.snapshot().data.coreEntities.length,1);
  await search.retry('hub');assert.equal(calls.at(-1).args.cursor,token('first'));assert.equal(calls.at(-1).args.order,'kind');assert.equal(calls.at(-1).args.searchFilters.category,'art');
  assert.deepEqual(search.snapshot().data.coreEntities.map(x=>x.ref.id),['one','two']);assert.deepEqual(search.snapshot().more,[]);
});
test('failed first page retries first and condition changes reset cursor and errors',async()=>{
  let failed=true;const {search,calls}=setup((command,args)=>{
    if(args.resource==='search'){if(failed)throw Error('offline');return {coreEntities:[item('first')],nextCursor:token('first')};}return empty(command,args);
  });
  await search.search('one');failed=false;await search.retry('hub');assert.equal(calls.at(-1).args.cursor,null);
  await search.search('one',{filters:{region:'jp'}});assert.equal(calls.at(-1).args.cursor,null);assert.equal(search.snapshot().errors.hub,undefined);
  search.invalidate();assert.deepEqual(search.snapshot().data,{});assert.deepEqual(search.snapshot().more,[]);assert.deepEqual(search.snapshot().pending,[]);
});
test('source first-page retry stays at zero even when Hub included source records',async()=>{
  let failed=true;const {search,calls}=setup((command,args)=>{
    if(args.resource==='search')return {coreEntities:[],articles:[{id:'hub-preview'}]};
    if(args.resource==='articles'){if(failed)throw Error('first unavailable');return {articles:[{id:'first'}],hasMore:false};}
    return empty(command,args);
  });
  await search.search('hub');assert.equal(search.snapshot().data.articles[0].id,'hub-preview');
  failed=false;await search.retry('articles');assert.equal(calls.at(-1).args.offset,0);assert.deepEqual(search.snapshot().data.articles,[{id:'first'}]);
});
test('Hub validates identities, pagination consistency and bounded signed cursor shapes',async()=>{
  const bad=[{coreEntities:[item('one'),item('one')]},{coreEntities:[{sourceGroup:'unknown',ref:{id:'one'}}]},
    {coreEntities:[item('')]},{coreEntities:[item('a\0b')]},{coreEntities:[item('one')],nextCursor:'short'},
    {coreEntities:[item('one')],nextCursor:token('a'.repeat(4053))},{coreEntities:[item('one')],nextCursor:`a.${'a'.repeat(42)}`},
    {coreEntities:[item('one')],nextCursor:token('bad?')},{coreEntities:[item('one')],nextCursor:42},
    {coreEntities:[],hasMore:true,nextCursor:token('next')},{coreEntities:[item('one')],hasMore:true},
    {coreEntities:[item('one')],hasMore:false,nextCursor:token('next')},{coreEntities:[],hasMore:'yes'}];
  for(const body of bad){const {search}=setup(()=>body);await search.search('',{filters:{region:'jp'}});assert.ok(search.snapshot().errors.hub,JSON.stringify(body));assert.equal(search.snapshot().data.coreEntities,undefined);}
  for(const body of [{coreEntities:[]},{coreEntities:[item('one')]},{coreEntities:[item('one')],nextCursor:token('a'.repeat(4052))}]){
    const {search}=setup(()=>body);await search.search('',{filters:{region:'jp'}});assert.equal(search.snapshot().errors.hub,undefined);
  }
});
test('same cursor, no new identity and empty continuation fail without changing previous data',async()=>{
  for(const body of [{coreEntities:[item('two')],nextCursor:token('first')},{coreEntities:[item('one')],nextCursor:token('other')},
    {coreEntities:[],nextCursor:null,hasMore:false},{coreEntities:[item('one')],nextCursor:null}]) {
    let page=0;const {search,calls}=setup(()=>++page===1?{coreEntities:[item('one')],nextCursor:token('first')}:body);
    await search.search('',{filters:{region:'jp'}});await search.more('hub');assert.ok(search.snapshot().errors.hub);
    assert.deepEqual(search.snapshot().data.coreEntities.map(x=>x.ref.id),['one']);assert.deepEqual(search.snapshot().more,['hub']);
    await search.retry('hub');assert.equal(calls.at(-1).args.cursor,token('first'));
  }
});
test('non-Hub offsets count fetched records and duplicate-only/empty continuations cannot loop',async()=>{
  let page=0;const {search,calls}=setup((command,args)=>{
    if(args.resource==='books')return ++page===1?{books:[{id:'no',title:'unrelated'},{id:'yes',title:'hub'}],hasMore:true}:{books:[{id:'next',title:'hub'}],hasMore:false};
    return empty(command,args);
  });
  await search.search('hub');await search.more('books');assert.equal(calls.at(-1).args.offset,2);assert.deepEqual(search.snapshot().data.books.map(x=>x.id),['yes','next']);
  for(const body of [{articles:[{id:'one'}],hasMore:true},{articles:[],hasMore:false},{articles:[{id:'new'},{id:'new'}],hasMore:false}]){
    let page=0;const ctx=setup((command,args)=>args.resource==='articles'?(++page===1?{articles:[{id:'one'}],hasMore:true}:body):empty(command,args));
    await ctx.search.search('hub');await ctx.search.more('articles');assert.ok(ctx.search.snapshot().errors.articles);assert.deepEqual(ctx.search.snapshot().data.articles,[{id:'one'}]);
    await ctx.search.retry('articles');assert.equal(ctx.calls.at(-1).args.offset,1);
  }
});
test('pending duplicate requests and inactive sources issue no extra IPC',async()=>{
  let resolve;const {search,calls}=setup(()=>new Promise(done=>resolve=done));
  const first=search.search('',{filters:{region:'jp'}});await search.retry('hub');await search.more('hub');await search.retry('books');assert.equal(calls.length,1);
  resolve({coreEntities:[]});await first;assert.deepEqual(search.snapshot().pending,[]);
});
