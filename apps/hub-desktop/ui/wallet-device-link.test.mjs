import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const begin=source.indexOf('async function renderWallet('),end=source.indexOf('\nlet videoCollection',begin);
assert.ok(begin>=0&&end>begin);
const render=new Function('deps',`
 const {document,target,data,status,invoke,isCurrent,onLink}=deps;
 let walletHistoryController=null,walletTipSettingsController=null,researchAccountGeneration=0;
 const desktopAccount={},currentView='wallet',navigator={clipboard:{writeText:async()=>{}}};
 const releaseWalletTipSettings=()=>{},settleWithin=value=>value,friendlyError=error=>String(error);
 const walletText=(tag,className,text)=>{const element=document.createElement(tag);element.className=className;element.textContent=text;return element;};
 const walletBalanceSummary=()=>({label:'0',canSend:false}),tokenToWei=()=>null;
 const linkDeviceWallet=async value=>onLink({...value});
 const loadCatalog=()=>{},showNotice=()=>{},articleEditorScope=async()=>null,enterBrowser=()=>{};
 const createWalletHistory=()=>({element:document.createElement('section'),destroy(){}});
 const createWalletTipSettings=()=>({element:document.createElement('section'),destroy(){}});
 const createWalletNetwork=()=>({element:document.createElement('section'),destroy(){}}),createWalletTokens=()=>({element:document.createElement('section')}),networkNotice=()=>document.createElement('p');
 ${source.slice(begin,end)}
 return renderWallet(target,data,isCurrent);
`);
const address='0x'+'a'.repeat(40);
const link=(chainId,extra={})=>({address,chainId,network:'Test network',...extra});
async function fixture(links,chainId=137){
 const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),calls=[],linked=[];
 let active=true;
 const status={address,chainId,chainName:'Polygon'};
 await render({document:dom.window.document,target,data:{links},status,isCurrent:()=>active,
  invoke:async command=>{calls.push(command);if(command==='wallet_status')return status;if(command==='wallet_balance')return{chainId,balanceWei:'0'};throw Error('fixture forbids wallet effects');},
  onLink:value=>linked.push(value)});
 return{dom,target,calls,linked,invalidate:()=>active=false,button:label=>[...target.querySelectorAll('button')].find(button=>button.textContent===label)};
}
test('another chain does not hide the current chain link entry or invoke a signature',async()=>{
 const f=await fixture([link(1)]);assert.ok(f.button('このウォレットを連携する'));
 await f.button('このウォレットを連携する').onclick();assert.deepEqual(f.linked,[{address,chainId:137,chainName:'Polygon'}]);
 assert.deepEqual(f.calls,['wallet_status','wallet_balance']);f.dom.window.close();
});
test('same chain address matching is case insensitive and routes to the existing unlink preview',async()=>{
 const f=await fixture([link(137,{address:address.toUpperCase().replace('0X','0x')})]);
 const button=f.button('連携一覧で解除を確認');assert.ok(button);
 f.target.querySelector('[data-wallet-unlink]').scrollIntoView=()=>{};
 await button.onclick();assert.equal(f.linked.length,0);assert.equal([...f.target.querySelectorAll('.wallet-action-panel')].at(-1).hidden,false);
 assert.deepEqual(f.calls,['wallet_status','wallet_balance']);f.dom.window.close();
});
test('invalid link metadata and other addresses never become an acknowledged current link',async()=>{
 for(const value of [link('137'),link(137,{network:''}),link(137,{network:'bad\u0000'}),link(137,{address:'0x'+'b'.repeat(40)})]){
  const f=await fixture([value]);assert.ok(f.button('このウォレットを連携する'));assert.equal(f.linked.length,0);f.dom.window.close();
 }
});
test('a stale device link button cannot continue into the signing flow',async()=>{
 const f=await fixture([link(1)]);f.invalidate();await f.button('このウォレットを連携する').onclick();assert.equal(f.linked.length,0);f.dom.window.close();
});
