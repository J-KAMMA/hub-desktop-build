import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createWalletTipSettings} from './wallet-tip-settings.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const address='0x'+'12'.repeat(20),origin='https://hub.example',key=JSON.stringify([origin,'device-one']);
const row=(values={})=>({address,chainId:137,network:'Polygon',symbol:'POL',tipsEnabled:false,minimumAmount:'0',visibility:'private',...values});
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(options={}){
  const dom=new JSDOM('<main></main>'),document=dom.window.document;let scope={key,generation:1},current=true,viewerId='viewer-one',scopeReads=0,rows=(options.rows??[row()]).map(value=>({...value}));const calls=[];
  const settings=()=>({viewerId,links:rows.map(value=>({...value}))});
  const receipt=selected=>({viewerId,address:selected.address,chainId:selected.chainId,tipsEnabled:selected.tipsEnabled,minimumAmount:selected.minimumAmount,visibility:selected.visibility,symbol:selected.symbol});
  const update=args=>{const selected=rows.find(value=>value.chainId===args.options.chainId&&value.address.toLowerCase()===args.options.address.toLowerCase());if(Object.hasOwn(args.options,'enabled')){selected.tipsEnabled=args.options.enabled;selected.visibility=args.options.enabled?'public':'private';}if(Object.hasOwn(args.options,'minimumAmount'))selected.minimumAmount=args.options.minimumAmount;return receipt(selected);};
  const widget=createWalletTipSettings({document,getScope:async()=>{scopeReads++;return scope;},isCurrent:()=>current,invoke:async(command,args)=>{calls.push({command,args:structuredClone(args)});return options.invoke?options.invoke(command,args,{settings,update,receipt,rows}):command==='hub_detail'?settings():update(args);}});
  document.querySelector('main').append(widget.element);widget.element.open=true;
  const button=name=>widget.element.querySelector(`[data-tip-settings-action="${name}"]`),input=name=>widget.element.querySelector(`[name="${name}"]`);
  const click=async name=>{button(name).click();await settle();};
  const minimum=value=>{input('walletTipMinimum').value=value;input('walletTipMinimum').dispatchEvent(new dom.window.Event('input'));};
  const enable=value=>{input('walletTipEnabled').checked=value;input('walletTipEnabled').dispatchEvent(new dom.window.Event('change'));};
  const select=chainId=>{input('walletTipAddress').value=chainId+':'+address;input('walletTipAddress').dispatchEvent(new dom.window.Event('change'));};
  return{dom,widget,calls,button,input,click,minimum,enable,select,settings,rows,setScope:value=>{scope=value;},setCurrent:value=>{current=value;},setViewer:value=>{viewerId=value;},scopeReads:()=>scopeReads,state:()=>widget.element.querySelector('[role="status"]').textContent,writes:()=>calls.filter(value=>value.command==='hub_client_action')};
}
async function ready(options){const f=fixture(options);await f.widget.ready;return f;}
const enableAndConfirm=async f=>{f.enable(true);await f.click('enable');await f.click('confirm');};

test('scoped own GET is closed and same address on different chains remains independently selectable',async()=>{
  const f=await ready({rows:[row(),row({chainId:1,network:'Ethereum',symbol:'ETH'})]});assert.deepEqual(f.calls[0],{command:'hub_detail',args:{name:'wallet_tip_settings',ids:['device-one',origin]}});assert.equal(f.input('walletTipAddress').options.length,2);
  f.select(1);f.minimum('0.5');await f.click('minimum');await f.click('confirm');assert.equal(f.writes()[0].args.options.chainId,1);assert.equal(f.rows[0].minimumAmount,'0');assert.equal(f.rows[1].minimumAmount,'0.5');assert.equal(f.widget.element.querySelector('summary').textContent,'チップの受取設定');
});
test('enabling previews public address/profile relationship; cancel makes zero IPC or scope reads',async()=>{
  const f=await ready();const before=f.calls.length,scopes=f.scopeReads();f.enable(true);await f.click('enable');assert.match(f.widget.element.textContent,/公開アドレスとHubプロフィールの関連が公開/u);assert.match(f.widget.element.textContent,new RegExp(address));assert.equal(f.writes().length,0);await f.click('cancel');assert.equal(f.calls.length,before);assert.equal(f.scopeReads(),scopes);assert.equal(f.button('confirm').hidden,true);assert.equal(f.input('walletTipEnabled').checked,true);
});
test('confirmed enable sends immutable publish consent and confirms only after fresh selected row',async()=>{
  const f=await ready();await enableAndConfirm(f);assert.deepEqual(f.writes()[0].args,{action:'tip_settings',options:{address,chainId:137,enabled:true,publishAddress:true,expectedViewerId:'viewer-one',expectedDeviceId:'device-one',expectedOrigin:origin}});assert.equal(f.calls.filter(value=>value.command==='hub_detail').length,2);assert.match(f.state(),/希望した受取設定を確認/u);assert.equal(f.input('walletTipEnabled').checked,true);
});
test('stop explicitly explains private visibility and omits publish consent and minimum',async()=>{
  const f=await ready({rows:[row({tipsEnabled:true,visibility:'public'})]});f.enable(false);await f.click('enable');assert.match(f.widget.element.textContent,/関連を非公開/u);assert.match(f.widget.element.textContent,/記録は消えません/u);await f.click('confirm');assert.deepEqual(f.writes()[0].args.options,{address,chainId:137,enabled:false,expectedViewerId:'viewer-one',expectedDeviceId:'device-one',expectedOrigin:origin});assert.equal(f.rows[0].visibility,'private');
});
test('minimum only sends canonical decimal without enabled/null/consent and never publishes',async()=>{
  const f=await ready();f.enable(true);f.minimum('000.100000000000000000');await f.click('minimum');assert.match(f.widget.element.textContent,/公開設定は変更しません/u);await f.click('confirm');const options=f.writes()[0].args.options;
  assert.deepEqual(options,{address,chainId:137,minimumAmount:'0.1',expectedViewerId:'viewer-one',expectedDeviceId:'device-one',expectedOrigin:origin});assert.equal(f.rows[0].tipsEnabled,false);assert.equal(f.rows[0].visibility,'private');assert.equal(f.input('walletTipEnabled').checked,true);
});
test('zero and full uint256 wei boundary are accepted; overflow, fraction19, signs, controls and Unicode reject without cutting draft',async()=>{
  const f=await ready({rows:[row({minimumAmount:'1'})]});f.minimum('0');await f.click('minimum');await f.click('confirm');assert.equal(f.writes()[0].args.options.minimumAmount,'0');
  const maximum=(1n<<256n)-1n,decimal=wei=>`${wei/10n**18n}.${(wei%10n**18n).toString().padStart(18,'0')}`;
  f.minimum(decimal(maximum));await f.click('minimum');assert.equal(f.button('confirm').disabled,false);await f.click('confirm');assert.equal(f.rows[0].minimumAmount,decimal(maximum));
  for(const value of [decimal(maximum+1n),'0.'+'1'.repeat(19),'-1','+1','1e3','1\t','1\0','\ud800','1'.repeat(101)]){f.minimum(value);await f.click('minimum');assert.equal(f.button('confirm').hidden,true);assert.equal(f.input('walletTipMinimum').value,value);assert.equal(f.writes().length,2);}
});
test('inflight clicks issue one PATCH and draft mutations cannot change the captured desired options',async()=>{
  const pending=deferred();const f=await ready({invoke:(command,args,api)=>command==='hub_detail'?api.settings():pending.promise});f.minimum('1');await f.click('minimum');await f.click('confirm');await f.click('confirm');assert.equal(f.writes().length,1);assert.equal(f.input('walletTipMinimum').disabled,true);f.minimum('2');pending.resolve({viewerId:'viewer-one',...row(),network:undefined});await settle();assert.equal(f.writes()[0].args.options.minimumAmount,'1');assert.equal(f.input('walletTipMinimum').value,'2');assert.match(f.state(),/不明/u);
});
test('lost accepted reply resolves via GET without another mutation',async()=>{
  const f=await ready({invoke:(command,args,api)=>{if(command==='hub_detail')return api.settings();api.update(args);throw Error('wallet_tip_unknown');}});await enableAndConfirm(f);assert.equal(f.writes().length,1);assert.equal(f.button('retry').disabled,true);await f.click('reload');assert.equal(f.writes().length,1);assert.match(f.state(),/希望した受取設定を確認/u);assert.equal(f.button('retry').hidden,true);
});
test('unknown mismatch permits only explicit same desired retry after valid own GET, never flip',async()=>{
  let write=0;const f=await ready({invoke:(command,args,api)=>{if(command==='hub_detail')return api.settings();if(++write===1)throw Error('transport');return api.update(args);}});await enableAndConfirm(f);await f.click('retry');assert.equal(write,1);assert.equal(f.input('walletTipAddress').disabled,true);await f.click('reload');assert.equal(f.button('retry').disabled,false);assert.equal(write,1);await f.click('retry');assert.equal(write,2);assert.deepEqual(f.writes()[0].args,f.writes()[1].args);assert.deepEqual(f.writes().map(value=>value.args.options.enabled),[true,true]);
});
test('mismatched ACK or GET is not success and preserves desired draft',async()=>{
  for(const mode of ['viewer','chain','chain-type','address','symbol','extra','get-mismatch','minimum-published']){
    const f=await ready({invoke:(command,args,api)=>{if(command==='hub_detail')return api.settings();const ack=api.receipt(api.rows[0]);if(mode==='viewer')return{...ack,viewerId:'other'};if(mode==='chain')return{...ack,chainId:1};if(mode==='chain-type')return{...ack,chainId:'137'};if(mode==='address')return{...ack,address:'0x'+'34'.repeat(20)};if(mode==='symbol')return{...ack,symbol:'ETH'};if(mode==='extra')return{...ack,secret:'forbidden'};if(mode==='get-mismatch')return{...ack,tipsEnabled:true,visibility:'public'};return{...ack,minimumAmount:'2',tipsEnabled:true,visibility:'public'};}});
    if(mode==='minimum-published'){f.minimum('2');await f.click('minimum');await f.click('confirm');assert.equal(Object.hasOwn(f.writes()[0].args.options,'enabled'),false);}else await enableAndConfirm(f);
    assert.match(f.state(),/不明/u);assert.equal(f.button('retry').hidden,false);assert.equal(f.writes().length,1);
  }
});
test('wrong viewer on fresh read invalidates controls and cannot unlock unknown retry',async()=>{
  const f=await ready({invoke:(command,_args,api)=>{if(command==='hub_detail')return api.settings();throw Error('unknown');}});await enableAndConfirm(f);f.setViewer('other');await f.click('reload');assert.equal(f.button('retry').disabled,true);assert.equal(f.input('walletTipMinimum').value,'');await f.click('retry');assert.equal(f.writes().length,1);assert.match(f.state(),/本人情報が変わり/u);
});
test('known reject/conflict requires fresh own state and explicit return to draft; unlisted/newline errors remain unknown',async()=>{
  for(const code of ['wallet_tip_rejected:400','wallet_tip_rejected:403','wallet_tip_rejected:413','wallet_tip_rejected:429','wallet_tip_conflict']){
    const f=await ready({invoke:(command,_args,api)=>{if(command==='hub_detail')return api.settings();throw Error(code);}});await enableAndConfirm(f);assert.equal(f.button('review').hidden,false);assert.equal(f.button('review').disabled,true);await f.click('reload');await f.click('review');assert.equal(f.button('review').hidden,true);assert.equal(f.input('walletTipEnabled').checked,true);assert.equal(f.writes().length,1);
  }
  for(const code of ['wallet_tip_rejected:404','wallet_tip_rejected:400\n']){const f=await ready({invoke:(command,_args,api)=>{if(command==='hub_detail')return api.settings();throw Error(code);}});await enableAndConfirm(f);assert.equal(f.button('review').hidden,true);assert.match(f.state(),/不明/u);}
});
test('scope origin/device/generation change before confirmation sends zero writes',async()=>{
  for(const scope of [{key,generation:2},{key:JSON.stringify(['https://other.example','device-one']),generation:1},{key:JSON.stringify([origin,'device-two']),generation:1},null]){const f=await ready();f.enable(true);await f.click('enable');f.setScope(scope);await f.click('confirm');assert.equal(f.writes().length,0);assert.equal(f.button('confirm').disabled,true);}
});
test('late response after account event/view/disposal/scope change performs no following GET or success update',async()=>{
  for(const mode of ['account','view','destroy','scope']){const pending=deferred();const f=await ready({invoke:(command,_args,api)=>command==='hub_detail'?api.settings():pending.promise});await enableAndConfirm(f);const button=f.button('reload');if(mode==='account')f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));if(mode==='view')f.setCurrent(false);if(mode==='destroy')f.widget.destroy();if(mode==='scope')f.setScope({key,generation:2});pending.resolve({viewerId:'viewer-one',address,chainId:137,tipsEnabled:true,minimumAmount:'0',visibility:'public',symbol:'POL'});await settle();button.click();await settle();assert.equal(f.calls.filter(value=>value.command==='hub_detail').length,1);assert.equal(f.writes().length,1);if(mode!=='destroy')assert.doesNotMatch(f.state(),/希望した受取設定を確認しました/u);}
});
test('GET closed fields, duplicate composite keys, malformed metadata and 101 links fail closed; 100 links accepted',async()=>{
  for(const links of [[row(),row()], [row({address:address+'\n'})],[row({chainId:999})],[row({symbol:'ETH'})],[row({minimumAmount:'-1'})],[{...row(),extra:true}],Array.from({length:101},(_,i)=>row({address:'0x'+BigInt(i).toString(16).padStart(40,'0')}))]){
    const f=await ready({invoke:()=>({viewerId:'viewer-one',links})});assert.equal(f.input('walletTipEnabled').disabled,true);assert.equal(f.writes().length,0);assert.match(f.state(),/取得できません/u);
  }
  const f=await ready({rows:Array.from({length:100},(_,i)=>row({address:'0x'+BigInt(i).toString(16).padStart(40,'0')}))});assert.equal(f.input('walletTipAddress').options.length,100);assert.equal(f.input('walletTipEnabled').disabled,false);
});
test('empty/guest/error states stay distinct and all metadata uses textContent',async()=>{
  const empty=await ready({rows:[]});assert.match(empty.state(),/アドレスはありません/u);assert.equal(empty.writes().length,0);
  const guest=fixture();guest.setScope(null);await guest.widget.ready;assert.equal(guest.calls.length,0);assert.match(guest.state(),/接続が必要/u);
  const safe=await ready({rows:[row({network:'<script>metadata</script>'})]});assert.equal(safe.widget.element.querySelector('script,img'),null);assert.match(safe.widget.element.textContent,/<script>metadata<\/script>/u);
});
test('fresh own settings updates untouched fields while preserving unsaved drafts per linked row',async()=>{
  const f=await ready({rows:[row(),row({chainId:1,network:'Ethereum',symbol:'ETH'})]});f.minimum('2');f.select(1);f.minimum('3');f.rows[0].tipsEnabled=true;f.rows[0].visibility='public';f.rows[1].tipsEnabled=true;f.rows[1].visibility='public';await f.click('reload');assert.equal(f.input('walletTipEnabled').checked,true);assert.equal(f.input('walletTipMinimum').value,'3');f.select(137);assert.equal(f.input('walletTipEnabled').checked,true);assert.equal(f.input('walletTipMinimum').value,'2');assert.equal(f.writes().length,0);
});
