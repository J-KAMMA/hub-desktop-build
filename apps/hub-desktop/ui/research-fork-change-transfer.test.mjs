import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createResearchForkChangeTransfer} from './research-fork-change-transfer.mjs';
import {researchForkDigest,RESEARCH_CHANGE_BYTES} from './research-change-package.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const projectId='rp_'+'b'.repeat(32),originalProject='rp_'+'a'.repeat(32),origin='https://fork.example',key=JSON.stringify([origin,'device-one']);
const body='  fork body\r\n😀\0 <script>literal</script>  ',contentHash=await researchForkDigest(body),baseHash=await researchForkDigest('original base');
const settled=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function packet(values={}){const proposed=values.body??' imported\r\n😀\0 ';return{protocol:'hub.research-change.v1',target:{origin,projectId,documentId:'doc.fork',baseVersion:5,baseHash:contentHash},body:proposed,summary:'変更理由',contentHash:await researchForkDigest(proposed),...values};}
const fileOf=value=>new File([JSON.stringify(value)],'change.json',{type:'application/json'});
function fixture(options={}){
  const dom=new JSDOM('<main></main>'),document=dom.window.document,data={document:{projectId,id:'doc.fork',head:8},revision:{version:5,body,contentHash},signedIn:true,canEdit:true,...options.data};
  const context={viewerId:'viewer-one',projectId,documentId:'doc.fork',version:5,body,contentHash,source:{origin:'https://original.example',projectId:originalProject,documentId:'doc.original',baseVersion:2,baseHash}};
  let scope={key,generation:1},current=true;const calls=[],imported=[],opened=[],peers=[];
  const createP2P=options.peer===false?undefined:(target,args)=>{const item={args,disposed:0};peers.push(item);const node=document.createElement('section');target.append(node);return{root:node,ready:Promise.resolve(),dispose(){item.disposed++;node.remove();}};};
  const widget=createResearchForkChangeTransfer({document,data,invoke:async(command,args)=>{calls.push({command,args:structuredClone(args)});return options.invoke?options.invoke(command,args,context):command==='hub_detail'?structuredClone(context):{saved:true,contentHash:args.packet.contentHash};},getScope:async()=>options.getScope?options.getScope(scope):scope,isCurrent:()=>current,onImport:options.importer===false?undefined:async value=>{imported.push(value);return options.onImport?options.onImport(value):true;},onOpen:async url=>{opened.push(url);},createP2P});
  document.querySelector('main').append(widget.element);widget.element.open=true;for(const node of widget.element.querySelectorAll('details'))node.open=true;
  const button=name=>widget.element.querySelector(`[data-research-change-action="${name}"]`),summary=widget.element.querySelector('[aria-label="原本への変更の理由"]'),file=widget.element.querySelector('input[type="file"]');
  const click=async name=>{button(name).click();await settled();};
  const edit=value=>{summary.value=value;summary.dispatchEvent(new dom.window.Event('input'));};
  const choose=async value=>{Object.defineProperty(file,'files',{configurable:true,value:[value]});file.dispatchEvent(new dom.window.Event('change'));await settled();};
  return{dom,data,context,widget,calls,imported,opened,peers,button,summary,file,click,edit,choose,setScope:value=>{scope=value;},setCurrent:value=>{current=value;},status:()=>widget.element.querySelector('[role="status"]').textContent,saves:()=>calls.filter(value=>value.command==='research_change_save')};
}
async function ready(options){const f=fixture(options);await f.widget.ready;return f;}
async function prepare(f){f.edit('  理由😀\u0085\ufeff');await f.click('prepare');}

test('export respects old displayed version and creates exact immutable Web packet without saving',async()=>{
  const f=await ready();assert.deepEqual(f.calls[0].args,{name:'research_change_context',ids:[projectId,'doc.fork','5','device-one',origin]});await prepare(f);assert.equal(f.saves().length,0);assert.match(f.widget.element.textContent,/非公開の内容/u);assert.match(f.widget.element.textContent,/本人や出自の証明ではありません/u);assert.equal(f.widget.element.querySelector('script,img'),null);assert.equal(f.button('save').disabled,false);
  await f.click('save');const args=f.saves()[0].args;assert.deepEqual(Object.keys(args),['projectId','documentId','version','expectedViewerId','expectedDeviceId','expectedOrigin','packet']);assert.equal(args.version,5);assert.equal(args.expectedOrigin,origin);assert.equal(args.expectedViewerId,'viewer-one');assert.equal(args.packet.body,body);assert.equal(args.packet.summary,'理由😀\u0085');assert.deepEqual(args.packet.target,f.context.source);assert.equal(args.packet.contentHash,contentHash);
  assert.deepEqual(f.calls[1].args.ids,[projectId,'doc.fork','5','device-one',origin,'viewer-one']);assert.match(f.status(),/ファイルを保存しました/u);assert.equal(f.calls.some(value=>value.command==='hub_client_action'),false);
});
test('save cancellation retains prepared content and never claims saved; malformed ACK is unknown with no automatic retry',async()=>{
  for(const reply of [{cancelled:true},{saved:true,contentHash:'sha256:'+'0'.repeat(64)},{saved:true,contentHash,filename:'/private/path'},{cancelled:true,saved:true}]){const f=await ready({invoke:(command,_args,context)=>command==='hub_detail'?structuredClone(context):reply});await prepare(f);await f.click('save');assert.equal(f.saves().length,1);assert.equal(f.button('save').hidden,false);if(reply.cancelled===true&&Object.keys(reply).length===1)assert.match(f.status(),/取り消しました/u);else assert.match(f.status(),/保存結果を確認できません/u);}
});
test('normal original 404 hides export only, signed-in import remains usable without export viewer pin',async()=>{
  const f=await ready({invoke:()=>{throw Error('research_change_not_found');}});assert.equal(await f.widget.ready,true);assert.equal(f.button('prepare').closest('details').hidden,true);assert.equal(f.file.disabled,false);await f.choose(fileOf(await packet()));assert.equal(f.button('apply').disabled,false);assert.equal(f.imported.length,0);await f.click('apply');assert.equal(f.imported.length,1);assert.match(f.status(),/保存・投稿はまだ/u);assert.equal(f.calls.length,1);
});
test('signed-in readonly viewer can stage/import; guest has no export or import authority',async()=>{
  const readonly=await ready({data:{document:{projectId,id:'doc.fork'},revision:{version:5,body,contentHash},signedIn:true,canEdit:false}});assert.equal(readonly.calls.length,0);await readonly.choose(fileOf(await packet()));await readonly.click('apply');assert.equal(readonly.imported.length,1);
  const guest=await ready({data:{signedIn:false}});assert.equal(guest.calls.length,0);assert.equal(guest.widget.element.hidden,true);assert.equal(guest.file.disabled,true);
});
test('only explicit import applies staged packet, false/undefined/throw callbacks preserve preview and never POST',async()=>{
  for(const result of [false,undefined,'true','throw']){const f=await ready({onImport:()=>{if(result==='throw')throw Error('locked');return result;}});const value=await packet();await f.choose(fileOf(value));assert.equal(f.imported.length,0);await f.click('apply');assert.deepEqual(f.imported,[value]);assert.doesNotMatch(f.status(),/取り込みました/u);assert.equal(f.button('apply').disabled,false);assert.equal(f.calls.some(value=>value.command==='hub_client_action'),false);}
});
test('wrong origin/project/document/base version/hash stages readonly with explicit safe original open and zero draft changes',async()=>{
  const value=await packet();for(const target of [{origin:'https://other.example'},{projectId:originalProject},{documentId:'other.doc'},{baseVersion:4},{baseHash}]){const f=await ready();const changed={...value,target:{...value.target,...target}};await f.choose(fileOf(changed));assert.equal(f.button('apply').disabled,true);assert.equal(f.imported.length,0);assert.match(f.status(),/自動では文書や版を変更しません/u);await f.click('importOpen');assert.deepEqual(f.opened,[`${changed.target.origin}/v2/research/${changed.target.projectId}?document=${encodeURIComponent(changed.target.documentId)}&version=${changed.target.baseVersion}`]);}
});
test('actual file byte/UTF8/hash/type failures do not stage or apply data',async()=>{
  const f=await ready(),value=await packet();let read=0;for(const file of [{size:500001,arrayBuffer:async()=>{read++;return new ArrayBuffer(0);}},{size:1,arrayBuffer:async()=>new ArrayBuffer(500001)},{size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer},fileOf({...value,body:'tampered'}),fileOf({...value,author:'not-authority'})]){await f.choose(file);assert.equal(f.button('apply').hidden,true);assert.equal(f.imported.length,0);assert.match(f.status(),/読み込めません/u);}assert.equal(read,0);
});
test('out-of-order file reads keep only latest staged packet',async()=>{
  const f=await ready(),gate=deferred(),old=await packet({body:'old'}),latest=await packet({body:'latest'});await f.choose({size:1,arrayBuffer:()=>gate.promise});await f.choose(fileOf(latest));gate.resolve(new TextEncoder().encode(JSON.stringify(old)).buffer);await settled();await f.click('apply');assert.equal(f.imported.length,1);assert.equal(f.imported[0].body,'latest');
});
test('fresh context mapping mismatch destroys prepared file/peer and does not invoke OS save',async()=>{
  const f=await ready();await prepare(f);await f.click('sendPeer');assert.equal(f.peers.length,1);f.context.source={...f.context.source,baseVersion:3};await f.click('save');assert.equal(f.saves().length,0);assert.equal(f.button('save').hidden,true);assert.equal(f.peers[0].disposed,1);assert.equal(f.peers[0].args.isCurrent(),false);assert.match(f.status(),/準備し直して/u);
});
test('wrong fresh viewer, scope origin/device/generation and mutable displayed data cannot save prepared bytes',async()=>{
  for(const kind of ['viewer','origin','device','generation','body','permission']){const f=await ready();await prepare(f);if(kind==='viewer')f.context.viewerId='other-viewer';if(kind==='origin')f.setScope({key:JSON.stringify(['https://other.example','device-one']),generation:1});if(kind==='device')f.setScope({key:JSON.stringify([origin,'device-two']),generation:1});if(kind==='generation')f.setScope({key,generation:2});if(kind==='body')f.data.revision.body='new';if(kind==='permission')f.data.canEdit=false;await f.click('save');assert.equal(f.saves().length,0);assert.equal(f.widget.element.querySelector('pre'),null);}
});
test('context response mismatches or extra fields fail closed and do not expose export controls as ready',async()=>{
  for(const patch of [{version:6},{body:'wrong'},{contentHash:'sha256:'+'0'.repeat(64)},{source:null},{author:'forbidden'}]){const f=await ready({invoke:(_command,_args,context)=>({...structuredClone(context),...patch})});assert.equal(f.button('prepare').disabled,true);assert.equal(f.saves().length,0);assert.match(f.status(),/対応を取得できません/u);}
});
test('summary edit during delayed preparation discards old prepared result and preserves new summary',async()=>{
  let next=null;const f=await ready({getScope:scope=>{if(!next)return scope;const gate=next;next=null;return gate.promise;}});const gate=next=deferred();f.edit('old');f.button('prepare').click();await settled();f.edit('new');gate.resolve({key,generation:1});await settled();assert.equal(f.button('save').hidden,true);assert.equal(f.summary.value,'new');assert.equal(f.saves().length,0);
});
test('double save clicks issue one RPC and late save ACK after view/account/destroy is discarded',async()=>{
  for(const kind of ['view','account','destroy']){const gate=deferred();const f=await ready({invoke:(command,_args,context)=>command==='hub_detail'?structuredClone(context):gate.promise});await prepare(f);f.button('save').click();f.button('save').click();await settled();assert.equal(f.saves().length,1);if(kind==='view')f.setCurrent(false);if(kind==='account')f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));if(kind==='destroy')f.widget.destroy();gate.resolve({saved:true,contentHash});await settled();if(kind!=='destroy')assert.doesNotMatch(f.status(),/ファイルを保存しました/u);assert.equal(f.saves().length,1);}
});
test('late import acceptance after scope change never reports success; stale staged file cannot call import',async()=>{
  const gate=deferred();const f=await ready({onImport:()=>gate.promise});await f.choose(fileOf(await packet()));f.button('apply').click();await settled();f.setScope({key,generation:2});gate.resolve(true);await settled();assert.doesNotMatch(f.status(),/取り込みました/u);
  const other=await ready();await other.choose(fileOf(await packet()));other.setScope(null);await other.click('apply');assert.equal(other.imported.length,0);
});
test('existing P2P ABI receives bounded prepared File; explicit receive only stages and closed callbacks are stale',async()=>{
  const f=await ready();await prepare(f);await f.click('sendPeer');assert.equal(f.peers.length,1);const sent=f.peers[0].args;assert.equal(sent.sendFile.name,'hub-research-change.json');assert.ok(sent.sendFile.size<=RESEARCH_CHANGE_BYTES);assert.equal(sent.maxFileBytes,500000);assert.equal(sent.receivedFileType,'application/json');assert.equal(sent.isCurrent(),true);assert.equal(f.saves().length,0);
  await f.click('closePeer');assert.equal(f.peers[0].disposed,1);assert.equal(sent.isCurrent(),false);assert.equal(await sent.onReceiveFile(fileOf(await packet())),false);assert.equal(f.imported.length,0);
  await f.click('receivePeer');const receive=f.peers[1].args;assert.equal(Object.hasOwn(receive,'sendFile'),false);assert.equal(await receive.onReceiveFile(fileOf(await packet())),true);assert.equal(f.imported.length,0);await f.click('apply');assert.equal(f.imported.length,1);f.widget.destroy();assert.equal(receive.isCurrent(),false);assert.equal(f.peers[1].disposed,1);
});
