import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const start=source.indexOf('  // Hub連携はアドレスとチェーンの組で扱い、端末のリンクも残す。');
const end=source.indexOf('  walletHistoryController=createWalletHistory',start);
assert.ok(start>0&&end>start);
const mount=new Function('deps',`
  const {document,target,data,invoke,isCurrent,showNotice,loadCatalog}=deps;
  const accounts=Array.isArray(data.accounts)?data.accounts:[],links=Array.isArray(data.links)?data.links:[];
  const walletText=(tag,cls,text)=>{const node=document.createElement(tag);node.className=cls;node.textContent=text;return node;};
  const friendlyError=error=>error.message??String(error);
  let researchAccountGeneration=0,desktopAccount={id:'viewer'},currentView='wallet';
  ${source.slice(start,end)}
  return {account:()=>{researchAccountGeneration++;desktopAccount={id:'other'};},accountABA:()=>{researchAccountGeneration++;},replaceAccount:()=>{desktopAccount={id:'viewer'};},view:value=>{currentView=value;}};
`);
const address='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40);
const link=(chainId=1,addr=address)=>({address:addr,chainId,network:chainId===1?'Ethereum':'Polygon',visibility:'private'});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function setup(data={links:[link()]},handler=async()=>({unlinked:true})) {
  const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),calls=[],notices=[],reloads=[];
  let active=true;
  const life=mount({document:dom.window.document,target,data,invoke:async(command,args)=>{calls.push({command,args:structuredClone(args)});return handler(command,args);},isCurrent:()=>active,showNotice:message=>notices.push(message),loadCatalog:async view=>{reloads.push(view);}});
  const buttons=()=>[...target.querySelectorAll('button')];
  const button=text=>buttons().find(item=>item.textContent===text);
  return {dom,target,calls,notices,reloads,life,button,select:index=>target.querySelectorAll('[data-wallet-unlink]')[index??0].click(),invalidate:()=>active=false};
}
test('same address separate chains, current device and account-only rows are preserved safely',()=>{
  const data={accounts:[{address,namespace:'eip155',networks:['1','137']},{address:other,namespace:'<img src=x>',verificationStatus:'watch_only'}],links:[link(),link(137),link(137)]};
  const ctx=setup(data);assert.equal(ctx.target.querySelectorAll('.wallet-list-row').length,3);assert.equal(ctx.target.querySelectorAll('[data-wallet-unlink]').length,2);
  assert.match(ctx.target.textContent,/Chain ID 1/);assert.match(ctx.target.textContent,/Chain ID 137/);assert.match(ctx.target.textContent,/閲覧のみ/);assert.equal(ctx.target.querySelector('img'),null);
  assert.equal(ctx.target.querySelector(`[data-wallet-address="${address}"][data-wallet-chain-id="137"]`).dataset.walletUnlink,`${address}:137`);
  ctx.select(1);assert.match(ctx.target.querySelector('.wallet-action-panel').textContent,/Polygon · Chain ID 137/);assert.equal(ctx.calls.length,0);
  ctx.button('取消').click();assert.equal(ctx.target.querySelector('.wallet-action-panel').hidden,true);assert.equal(ctx.calls.length,0);ctx.dom.window.close();
});
test('only explicit confirmation writes and success requires an absent link on reload',async()=>{
  const ctx=setup({links:[link(),link(137)]},async command=>command==='hub_client_action'?{unlinked:true}:{links:[link()]});
  ctx.select(1);assert.equal(ctx.calls.length,0);ctx.button('確認して連携を解除').click();await turn();
  assert.deepEqual(ctx.calls,[{command:'hub_client_action',args:{action:'wallet_unlink',options:{address,chainId:137}}},{command:'hub_client',args:{name:'wallet'}}]);
  assert.equal(ctx.notices.length,1);assert.deepEqual(ctx.reloads,['wallet']);ctx.dom.window.close();
});
test('pending confirmation locks double submit and switching to another target',async()=>{
  let resolve;const ctx=setup({links:[link(),link(137)]},command=>command==='hub_client_action'?new Promise(done=>resolve=done):Promise.resolve({links:[]}));
  ctx.select();const confirm=ctx.button('確認して連携を解除');confirm.click();confirm.onclick();ctx.select(1);
  assert.equal(ctx.calls.length,1);assert.ok(confirm.disabled);assert.ok(ctx.button('取消').disabled);assert.ok([...ctx.target.querySelectorAll('[data-wallet-unlink]')].every(button=>button.disabled));
  resolve({unlinked:true});await turn();assert.equal(ctx.calls[0].args.options.chainId,1);assert.equal(ctx.notices.length,1);ctx.dom.window.close();
});
test('failed write retains every row and preview, then rechecks without replay',async()=>{
  let healthy=false;const ctx=setup({links:[link()]},async command=>{
    if(command==='hub_client_action'){if(!healthy)throw Error('offline');return {unlinked:true};}
    return {links:[link()]};
  });
  ctx.select();ctx.button('確認して連携を解除').click();await turn();assert.equal(ctx.target.querySelectorAll('.wallet-list-row').length,1);
  assert.equal(ctx.target.querySelector('.wallet-action-panel').hidden,false);assert.ok(ctx.button('確認して連携を解除').disabled);assert.match(ctx.target.textContent,/offline/);
  ctx.button('確認して連携を解除').onclick();assert.equal(ctx.calls.length,1);
  ctx.button('連携状態を再確認').click();await turn();assert.equal(ctx.calls.length,2);assert.equal(ctx.calls[1].command,'hub_client');assert.equal(ctx.notices.length,0);
  assert.equal(ctx.button('確認して連携を解除').disabled,false);healthy=true;ctx.button('確認して連携を解除').click();await turn();assert.equal(ctx.notices.length,0);assert.ok(ctx.button('確認して連携を解除').disabled);ctx.dom.window.close();
});
test('invalid acknowledgements never report success or trigger unchecked reload',async()=>{
  for(const ack of [null,{}, {unlinked:'true'}, {unlinked:1}]) {
    const ctx=setup({links:[link()]},async()=>ack);ctx.select();ctx.button('確認して連携を解除').click();await turn();
    assert.equal(ctx.calls.length,1);assert.equal(ctx.notices.length,0);assert.equal(ctx.reloads.length,0);assert.ok(ctx.button('確認して連携を解除').disabled);ctx.dom.window.close();
  }
});
test('invalid fresh links and still-present target retain the rows without success',async()=>{
  for(const fresh of [{}, {links:null},{links:[link()]},{links:[{...link(),chainId:'1'}]},{links:[{...link(),address:[address]}]}]){
    const ctx=setup({links:[link()]},async command=>command==='hub_client_action'?{unlinked:true}:fresh);
    ctx.select();ctx.button('確認して連携を解除').click();await turn();assert.equal(ctx.notices.length,0);assert.equal(ctx.reloads.length,0);assert.equal(ctx.target.querySelectorAll('.wallet-list-row').length,1);assert.ok(ctx.button('確認して連携を解除').disabled);ctx.dom.window.close();
  }
});
test('an idempotent false acknowledgement still requires verified absence',async()=>{
  const ctx=setup({links:[link()]},async command=>command==='hub_client_action'?{unlinked:false}:{links:[]});
  ctx.select();ctx.button('確認して連携を解除').click();await turn();assert.equal(ctx.calls.length,2);assert.equal(ctx.notices.length,1);ctx.dom.window.close();
});
test('unknown mutation result can recover from a read but never automatically replay',async()=>{
  const ctx=setup({links:[link()]},async command=>{if(command==='hub_client_action')throw Error('unknown');return {links:[]};});
  ctx.select();ctx.button('確認して連携を解除').click();await turn();ctx.button('連携状態を再確認').click();await turn();
  assert.equal(ctx.calls.filter(call=>call.command==='hub_client_action').length,1);assert.equal(ctx.notices.length,1);ctx.dom.window.close();
});
test('account, generation, catalog, detached DOM and view changes prevent writes',async()=>{
  for(const invalidate of [ctx=>ctx.life.account(),ctx=>ctx.life.accountABA(),ctx=>ctx.life.replaceAccount(),ctx=>ctx.invalidate(),ctx=>ctx.life.view('feed'),ctx=>ctx.target.remove()]){
    const ctx=setup();ctx.select();invalidate(ctx);ctx.button('確認して連携を解除').onclick();await turn();assert.equal(ctx.calls.length,0);ctx.dom.window.close();
  }
});
test('late write and reload responses cannot cross account or view generations',async()=>{
  for(const phase of ['write','read'])for(const invalidate of [ctx=>ctx.life.account(),ctx=>ctx.life.accountABA(),ctx=>ctx.invalidate(),ctx=>ctx.life.view('feed')]){
    let resolve;const ctx=setup({links:[link()]},async command=>{
      if((phase==='write'&&command==='hub_client_action')||(phase==='read'&&command==='hub_client'))return new Promise(done=>resolve=done);
      return {unlinked:true};
    });
    ctx.select();ctx.button('確認して連携を解除').click();await turn();invalidate(ctx);resolve(phase==='write'?{unlinked:true}:{links:[]});await turn();
    assert.equal(ctx.calls.length,phase==='write'?1:2);assert.equal(ctx.notices.length,0);assert.equal(ctx.reloads.length,0);ctx.dom.window.close();
  }
});
test('malformed links or unavailable Hub expose no unlink write control',()=>{
  for(const data of [{links:[{...link(),chainId:0}]},{links:[{...link(),chainId:1.5}]},{links:[{...link(),chainId:Number.MAX_SAFE_INTEGER+1}]},{links:[{...link(),address:[address]}]},
    {links:[{...link(),network:'x'.repeat(81)}]},{links:[{...link(),network:'bad\nnetwork'}]},{links:[link()],hubUnavailable:true}]) {
    const ctx=setup(data);assert.equal(ctx.target.querySelectorAll('[data-wallet-unlink]').length,0);assert.equal(ctx.calls.length,0);ctx.dom.window.close();
  }
});
