import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {AI_PAID_EXECUTION,PAID_AI_COMMANDS,isPaidAiCommand} from './ai-paid-execution.mjs';
import {chainLabel,confirmNetworkSwitch,createWalletNetwork,createWalletTokens,formatUnits,guardWalletChain,networkNotice,walletSwitchRequest} from './wallet-network.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');

const chains=[
 {chainId:43114,name:'Avalanche C-Chain',symbol:'AVAX',mainnet:true},
 {chainId:137,name:'Polygon',symbol:'POL',mainnet:true},
 {chainId:1,name:'Ethereum',symbol:'ETH',mainnet:true},
 {chainId:8453,name:'Base',symbol:'ETH',mainnet:true},
 {chainId:42161,name:'Arbitrum One',symbol:'ETH',mainnet:true},
 {chainId:10,name:'OP Mainnet',symbol:'ETH',mainnet:true},
];
const testnets=[
 {chainId:43113,name:'Avalanche Fuji',symbol:'AVAX',mainnet:false},
 {chainId:80002,name:'Polygon Amoy',symbol:'POL',mainnet:false},
];
const statusOf=(chainId=43114,extra={})=>{
 const chain=[...chains,...testnets].find(item=>item.chainId===chainId);
 return{address:'0x'+'a'.repeat(40),chainId,chainName:chain.name,symbol:chain.symbol,mainnet:chain.mainnet,developer:false,chains,tokens:[],...extra};
};
const page=()=>new JSDOM('<body></body>').window;

test('switch-required codes are recognised exactly and nothing else is',()=>{
 assert.equal(walletSwitchRequest('wallet_chain_switch_required:137'),137);
 assert.equal(walletSwitchRequest(new Error('wallet_chain_switch_required:43114')),43114);
 for(const bad of ['wallet_chain_switch_required:','wallet_chain_switch_required:0','wallet_chain_switch_required:1e3',' wallet_chain_switch_required:137','wallet_chain_switch_required:137 ','x wallet_chain_switch_required:137','wallet_chain_switch_required:99999999999999999999',{message:'wallet_chain_switch_required:137'},null,undefined,137])
  assert.equal(walletSwitchRequest(bad),null,String(bad));
});

test('a request for another network is never switched without an explicit yes',async()=>{
 const calls=[],asked=[];
 let refused=true;
 const raw=async(name,args)=>{calls.push([name,args]);if(name==='wallet_send_native'&&refused){refused=false;throw 'wallet_chain_switch_required:137';}return'0xhash';};
 const refuse=guardWalletChain(raw,async chainId=>{asked.push(chainId);return false;});
 await assert.rejects(refuse('wallet_send_native',{chainId:137}),{message:'wallet_user_rejected'});
 assert.deepEqual(asked,[137]);assert.equal(calls.length,1,'no retry and no switch after a refusal');
 refused=true;calls.length=0;asked.length=0;
 const accept=guardWalletChain(raw,async chainId=>{asked.push(chainId);return true;});
 assert.equal(await accept('wallet_send_native',{chainId:137}),'0xhash');
 assert.deepEqual(asked,[137]);assert.equal(calls.length,2,'retried exactly once after consent');
});

test('a second refusal after consent surfaces and other errors pass through untouched',async()=>{
 let asked=0;
 const looping=guardWalletChain(async()=>{throw 'wallet_chain_switch_required:1';},async()=>{asked++;return true;});
 await assert.rejects(looping('wallet_send_contract',{}),error=>error==='wallet_chain_switch_required:1');
 assert.equal(asked,1);
 const other=guardWalletChain(async()=>{throw new Error('rpc_unreachable');},async()=>{asked++;return true;});
 await assert.rejects(other('wallet_balance'),{message:'rpc_unreachable'});
 assert.equal(asked,1);
 const plain=guardWalletChain(async(name,args)=>({name,args}),async()=>assert.fail('not asked'));
 assert.deepEqual(await plain('wallet_status',undefined),{name:'wallet_status',args:undefined});
});

test('the app routes every command through the guard and never switches by itself',()=>{
 assert.match(source,/const invoke = guardWalletChain\(rawInvoke,/);
 const prompt=source.slice(source.indexOf('async function confirmWalletNetworkSwitch'),source.indexOf('invoke("desktop_build_mode")'));
 assert.match(prompt,/confirmNetworkSwitch\(/);
 assert.doesNotMatch(prompt,/wallet_select_chain/,'the switch happens only inside the confirmed dialog');
 const callers=[...source.matchAll(/wallet_select_chain/g)].length;
 assert.equal(callers,0,'app.js itself never selects a network; the picker and dialog do');
});

test('the picker lists network name and native currency, mainnets only by default',()=>{
 const {document}=page();
 const view=createWalletNetwork({document,invoke:async()=>{},status:statusOf()});
 const labels=[...view.select.options].map(option=>option.textContent);
 assert.deepEqual(labels,chains.map(chainLabel));
 assert.ok(labels[0].includes('Avalanche C-Chain')&&labels[0].includes('AVAX'));
 assert.equal(view.select.value,'43114');
 assert.ok(!labels.some(label=>/Fuji|Amoy|Sepolia|Kairos/.test(label)),'testnets stay hidden');
 assert.equal(view.toggle.checked,false);
 assert.match(view.element.textContent,/本物のお金が動きます/);
});

test('selecting a network is an explicit native call and a failure restores the old choice',async()=>{
 const {document}=page(),calls=[];
 let changed=[];
 const view=createWalletNetwork({document,invoke:async(name,args)=>{calls.push([name,args]);if(args.chainId===1)throw 'wallet_chain_unsupported';},status:statusOf(),onChanged:id=>changed.push(id),describeError:String});
 view.select.value='137';await view.select.onchange();
 assert.deepEqual(calls,[['wallet_select_chain',{chainId:137}]]);assert.deepEqual(changed,[137]);
 view.select.value='1';await view.select.onchange();
 assert.equal(view.select.value,'43114');assert.match(view.note.textContent,/wallet_chain_unsupported/);assert.deepEqual(changed,[137]);
});

test('testnets appear only with the developer setting and are labelled as test networks',async()=>{
 const {document}=page(),calls=[];
 const view=createWalletNetwork({document,invoke:async(name,args)=>{calls.push([name,args]);},status:statusOf(80002,{developer:true,chains:[...chains,...testnets]})});
 const labels=[...view.select.options].map(option=>option.textContent);
 assert.ok(labels.some(label=>label.includes('Polygon Amoy')&&label.includes('テスト用')));
 assert.equal(view.select.value,'80002');assert.equal(view.toggle.checked,true);
 assert.doesNotMatch(view.element.textContent,/本物のお金が動きます/);
 assert.match(view.element.textContent,/本物のお金は動きません/);
 view.toggle.checked=false;await view.toggle.onchange();
 assert.deepEqual(calls,[['wallet_set_developer',{enabled:false}]]);
});

test('the mainnet warning is present on mainnets and absent on testnets',()=>{
 const {document}=page();
 assert.match(networkNotice(document,true).textContent,/本物のお金が動きます/);
 assert.equal(networkNotice(document,true).className,'wallet-mainnet-warning');
 assert.doesNotMatch(networkNotice(document,false).textContent,/本物のお金が動きます/);
});

test('the network picker can keep the mainnet warning out of the rail summary',()=>{
 const {document}=page();
 const view=createWalletNetwork({document,invoke:async()=>{},status:statusOf(),showWarning:false});
 assert.equal(view.warning,null);
 assert.doesNotMatch(view.element.textContent,/本物のお金が動きます/);
 assert.equal(view.select.value,'43114');
});

test('the switch prompt names both networks, warns on mainnet and switches only on the button',async()=>{
 const {document}=page(),calls=[],switched=[];
 const pending=confirmNetworkSwitch({document,invoke:async(name,args)=>{calls.push([name,args]);},requested:137,status:statusOf(),onSwitched:id=>switched.push(id)});
 const dialog=document.querySelector('dialog.wallet-network-dialog');
 assert.ok(dialog);
 assert.match(dialog.textContent,/Polygon/);assert.match(dialog.textContent,/chain ID 137/);
 assert.match(dialog.textContent,/Avalanche C-Chain/);assert.match(dialog.textContent,/chain ID 43114/);
 assert.match(dialog.textContent,/本物のお金が動きます/);
 assert.match(dialog.textContent,/署名も送金も行いません/);
 assert.deepEqual(calls,[],'opening the prompt switches nothing');
 [...dialog.querySelectorAll('button')].find(button=>button.textContent==='切り替える').onclick();
 assert.equal(await pending,true);
 assert.deepEqual(calls,[['wallet_select_chain',{chainId:137}]]);assert.deepEqual(switched,[137]);
 assert.equal(document.querySelector('dialog'),null);
});

test('cancelling the switch prompt, or a failed switch, does not switch',async()=>{
 const {document}=page(),calls=[];
 const denied=confirmNetworkSwitch({document,invoke:async(...args)=>calls.push(args),requested:137,status:statusOf()});
 [...document.querySelectorAll('button')].find(button=>button.textContent==='キャンセル').onclick();
 assert.equal(await denied,false);assert.deepEqual(calls,[]);
 const failing=confirmNetworkSwitch({document,invoke:async()=>{throw 'wallet_settings_unavailable';},requested:137,status:statusOf(),describeError:String});
 const approve=[...document.querySelectorAll('button')].find(button=>button.textContent==='切り替える');
 await approve.onclick();
 assert.match(document.querySelector('dialog').textContent,/wallet_settings_unavailable/);
 assert.equal(approve.disabled,false);
 [...document.querySelectorAll('button')].find(button=>button.textContent==='キャンセル').onclick();
 assert.equal(await failing,false);
});

test('a network that cannot be selected gets an explanation and no switch button',async()=>{
 const {document}=page(),calls=[];
 const pending=confirmNetworkSwitch({document,invoke:async(...args)=>calls.push(args),requested:80002,status:statusOf()});
 const dialog=document.querySelector('dialog');
 assert.match(dialog.textContent,/chain ID 80002/);assert.match(dialog.textContent,/開発者向け設定/);
 assert.ok(![...dialog.querySelectorAll('button')].some(button=>button.textContent==='切り替える'));
 [...dialog.querySelectorAll('button')].find(button=>button.textContent==='閉じる').onclick();
 assert.equal(await pending,false);assert.deepEqual(calls,[]);
});

test('token balances show the selected network only and mark failures',async()=>{
 const {document}=page();
 const status=statusOf(43114,{tokens:[{symbol:'JPYC',address:'0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',decimals:18}]});
 const ok=createWalletTokens({document,status,invoke:async()=>({chainId:43114,tokens:[{symbol:'JPYC',address:status.tokens[0].address.toLowerCase(),decimals:18,balanceRaw:'1234500000000000000000'}]})});
 await ok.ready;assert.match(ok.element.textContent,/JPYC/);assert.match(ok.element.textContent,/1234\.5/);assert.match(ok.element.textContent,/Avalanche C-Chain/);
 const other=createWalletTokens({document,status,invoke:async()=>({chainId:137,tokens:[{address:status.tokens[0].address,balanceRaw:'5'}]})});
 await other.ready;assert.match(other.element.textContent,/取得できません/);assert.doesNotMatch(other.element.textContent,/\b5\b/);
 const missing=createWalletTokens({document,status,invoke:async()=>({chainId:43114,tokens:[{address:status.tokens[0].address,balanceRaw:null}]})});
 await missing.ready;assert.match(missing.element.textContent,/取得できません/);
 const none=createWalletTokens({document,status:statusOf(8453),invoke:async()=>assert.fail('no token list, no call')});
 assert.equal(none.element.hidden,true);
 assert.equal(formatUnits('0',18),'0');assert.equal(formatUnits('1',18),'0.000001未満');assert.equal(formatUnits('x',18),null);assert.equal(formatUnits('5',-1),null);
});

// renderWallet itself: network, chain id, currency and the mainnet warning are on the balance and send screens.
const begin=source.indexOf('async function renderWallet('),end=source.indexOf('\nlet videoCollection',begin);
assert.ok(begin>=0&&end>begin);
const renderWallet=new Function('deps',`
 const {document,target,data,status,invoke,isCurrent,createWalletNetwork,createWalletTokens,networkNotice}=deps;
 let walletHistoryController=null,walletTipSettingsController=null,researchAccountGeneration=0;
 const desktopAccount={},currentView='wallet',navigator={clipboard:{writeText:async()=>{}}};
 const releaseWalletTipSettings=()=>{},settleWithin=value=>value,friendlyError=error=>String(error);
 const walletText=(tag,className,text)=>{const element=document.createElement(tag);element.className=className;element.textContent=text;return element;};
 const walletBalanceSummary=value=>({label:value,canSend:value!=='0'}),tokenToWei=()=>null;
 const linkDeviceWallet=async()=>{},loadCatalog=()=>{},showNotice=()=>{},articleEditorScope=async()=>null,enterBrowser=()=>{};
 const createWalletHistory=()=>({element:document.createElement('section'),destroy(){}});
 const createWalletTipSettings=()=>({element:document.createElement('section'),destroy(){}});
 ${source.slice(begin,end)}
 return renderWallet(target,data,isCurrent);
`);
async function wallet(status,balance){
 const {document}=page(),target=document.createElement('main');document.body.append(target);
 const calls=[];
 await renderWallet({document,target,data:{links:[]},status,isCurrent:()=>true,createWalletNetwork,createWalletTokens,networkNotice,
  invoke:async(command,args)=>{calls.push([command,args]);if(command==='wallet_status')return status;if(command==='wallet_balance')return balance;if(command==='wallet_token_balances')return{chainId:status.chainId,tokens:[]};throw Error('fixture forbids '+command);}});
 await new Promise(resolve=>setTimeout(resolve,0));
 return{target,calls};
}
test('balance and send screens state the network, chain id, currency and mainnet warning',async()=>{
 const f=await wallet(statusOf(137),{chainId:137,balanceWei:'5'});
 const text=f.target.textContent;
 assert.match(f.target.querySelector('.wallet-network').textContent,/Polygon · chain 137/);
 assert.match(f.target.querySelector('.wallet-unit').textContent,/POL（Polygon）/);
 assert.match(f.target.querySelector('.wallet-send-network').textContent,/Polygon（chain ID 137）の POL/);
 assert.ok(f.target.querySelector('.wallet-send-panel .wallet-mainnet-warning'));
 assert.match(text,/数量（POL）/);
 assert.match(text,/受取ネットワークは Polygon（chain ID 137）/);
 assert.equal(f.target.querySelector('.wallet-send-panel .wallet-mainnet-warning').textContent.includes('本物のお金が動きます'),true);
});
test('the send warning stays inside the flow until 送金する is pressed',async()=>{
 const f=await wallet(statusOf(137),{chainId:137,balanceWei:'5'});
 const panel=f.target.querySelector('.wallet-send-panel');
 assert.equal(panel.hidden,true);
 const send=[...f.target.querySelectorAll('.wallet-actions button')].find(button=>button.textContent==='送金する');
 assert.equal(send.disabled,false);
 send.click();
 assert.equal(panel.hidden,false);
 assert.match(panel.textContent,/本物のお金が動きます/);
});
test('a testnet send screen shows the test note instead of the mainnet warning',async()=>{
 const status=statusOf(80002,{developer:true,chains:[...chains,...testnets]});
 const f=await wallet(status,{chainId:80002,balanceWei:'5'});
 assert.match(f.target.querySelector('.wallet-network').textContent,/テスト用/);
 assert.ok(!f.target.querySelector('.wallet-send-panel .wallet-mainnet-warning'));
 assert.ok(f.target.querySelector('.wallet-send-panel .wallet-testnet-note'));
});
test('a balance answered for another network is never shown as the selected network balance',async()=>{
 const f=await wallet(statusOf(43114),{chainId:137,balanceWei:'999'});
 assert.equal(f.target.querySelector('.wallet-balance').textContent,'残高を確認できません');
 assert.ok(!f.target.textContent.includes('999'));
 const send=[...f.target.querySelectorAll('.wallet-actions button')].find(button=>button.textContent==='送金する');
 assert.equal(send.disabled,true,'send stays disabled when the balance cannot be tied to this network');
});
test('the send call carries the displayed chain id so a stale view is refused natively',async()=>{
 assert.match(source,/invoke\("wallet_send_native", \{ chainId: status\.chainId, to, amountWei: wei\.toString\(\) \}\)/);
});

// Paid AI execution (x402) is off by default (owner decision 2026-10-15; ai-paid-execution.mjs).
test('paid AI commands are refused before Rust and never raise a network-switch prompt',async()=>{
 const calls=[];let asked=0;
 const guarded=guardWalletChain(async(name)=>{calls.push(name);throw 'wallet_chain_switch_required:137';},async()=>{asked++;return true;});
 for(const name of PAID_AI_COMMANDS)await assert.rejects(guarded(name,{}),{message:'ai_paid_execution_disabled'},name);
 assert.deepEqual(calls,[],'nothing reaches the native side');
 assert.equal(asked,0,'no switch prompt for an AI payment');
 assert.equal(AI_PAID_EXECUTION,false,'the flag defaults off');
 assert.equal(isPaidAiCommand('wallet_send_native'),false,'ordinary wallet sends are unaffected');
});

test('with the flag explicitly on the paid AI path (guarded x402 switch) still works',async()=>{
 const calls=[];let asked=0,first=true;
 const guarded=guardWalletChain(async(name)=>{calls.push(name);if(first){first=false;throw 'wallet_chain_switch_required:43114';}return{status:'ok'};},async(id)=>{asked+=id===43114?1:0;return true;},{paidAiExecution:true});
 assert.deepEqual(await guarded('ai_pay_and_call',{}),{status:'ok'});
 assert.deepEqual(calls,['ai_pay_and_call','ai_pay_and_call']);
 assert.equal(asked,1);
});

test('the AI tools card is hidden and its handlers are inert while the flag is off',()=>{
 const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
 assert.match(html,/<div class="card" id="ai-tools" hidden>/);
 assert.match(source,/const invoke = guardWalletChain\(rawInvoke, [^\n]*\{ paidAiExecution: AI_PAID_EXECUTION \}\);/);
 assert.match(source,/if \(AI_PAID_EXECUTION\) document\.querySelector\("#ai-tools"\)\.hidden = false;/);
 for(const head of ['document.querySelector("#ai-catalog-load").onclick = async () => {','aiRunButton.onclick = async () => {','async function aiPay(entry, display, params, description) {'])
  assert.ok(source.includes(head+'\n  if (!AI_PAID_EXECUTION) return;'),head);
});
