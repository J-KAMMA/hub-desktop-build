import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
const source=(await readFile(new URL('./app.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
const extract=(from,to)=>{const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start);return source.slice(start,end);};
const storage=extract('const SHOP_CART_KEY','function mergeShopProducts');
const detail=extract('let detailOrderId = null;','async function supplementPayment');
const errors=extract('function shopPaymentError(error) {','function renderCartReview()');
const saveReceipt=extract('function saveShopReceipt(', 'const shopCartLocked');
const controls=extract('function syncCartControls() {','// 未操作の注文だけ');
const HASH='0x'+'a'.repeat(64),OTHERHASH='0x'+'b'.repeat(64);
const order=(id='o1',extra={})=>({id,chainId:1,status:'awaiting_payment',productId:id==='o1'?'p1':'p2',quantity:1,amountJpyc:100,transactionHash:null,...extra});
const receipt=(id='o1',extra={})=>({id,productId:id==='o1'?'p1':'p2',quantity:1,title:'商品😀<img>',amountJpyc:100,status:'wallet_unknown',transactionHash:null,operationId:'11111111-1111-4111-8111-111111111111',...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function fixture(t,{orders=[receipt()],body={order:order()}}={}){
 const dom=new JSDOM(html,{url:'http://localhost'}),document=dom.window.document,stored=new Map(),calls=[],f={dom,document,stored,calls,body,saveFails:false,recoverCalls:[],knownCalls:[],finishes:[],controls:0,badges:0,approvalCalls:[],payCalls:[],writes:[]};
 const helper={recoverApproval:async line=>{f.approvalCalls.push(line);return f.inspect?f.inspect(line):{approvalHash:OTHERHASH};},pay:async line=>{f.payCalls.push(line);return f.pay?f.pay(line):{order:order(line.order.id,{status:"submitted"}),transactionHash:HASH};},recoverUnknown:async args=>{f.recoverCalls.push(args);if(f.unknown)return f.unknown(args);await args.onRecovered(HASH);return {order:{...order(args.orderId),status:'submitted'},transactionHash:HASH};},recover:async args=>{f.knownCalls.push(args);return {order:{...order(args.orderId),status:'submitted'},transactionHash:args.transactionHash};}};
 const localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>{if(f.saveFails&&key==='hub.desktop.shop-orders.v1')throw Error('private storage failure');stored.set(key,value);f.writes.push({key,value});}};
 const ctx=vm.createContext({document,window:dom.window,localStorage,sessionStorage:dom.window.sessionStorage,Date,Error,shopPayment:helper,showView:()=>{},renderCartReview:()=>{f.controls++;},shopCartLocked:()=>vm.runInContext('checkoutBusy',ctx),shopReviewKey:()=> 'review',shopPendingOrder:id=>f.shop.orders.some(item=>item.id===id&&(item.status==='wallet_unknown'||item.transactionHash)),updateCartBadge:()=>{f.badges++;},finishCheckoutForOrder:async(...args)=>{f.finishes.push(args);},invoke:async(name,args)=>{calls.push({name,args});if(name==='commerce_order_status'){if(f.status)return f.status(args);return {order:order(args.orderId,{status:f.shop.orders.find(item=>item.id===args.orderId)?.status==='submitted'?'submitted':'awaiting_payment'})};}throw Error(`unexpected ${name}`);}});
 vm.runInContext(storage+'let checkoutBusy=false;'+errors+saveReceipt+controls+detail,ctx);f.ctx=ctx;f.shop=vm.runInContext('shop',ctx);
 Object.assign(f.shop,{orders:structuredClone(orders),cart:{p1:1,p2:2},cartProducts:{p1:{id:'p1'},p2:{id:'p2'}},assertions:{p1:'proof',p2:'proof2'},zones:{p1:'JP',p2:'US'},prepared:{key:'review',lines:[{order:order()},{order:order('o2')} ]}});
 f.render=(next=body)=>{ctx.body=next;vm.runInContext('detailOrderId=body.order.id;detailOrder=body.order;renderOrderDetail(body)',ctx);};f.render();
 f.button=label=>[...document.querySelectorAll('#order-detail button')].find(button=>button.textContent===label);f.saved=()=>JSON.parse(stored.get('hub.desktop.shop-orders.v1')??'[]');f.busy=()=>vm.runInContext('checkoutBusy',ctx);
 t.after(()=>dom.window.close());return f;
}
const preparedERC20=(f,extra={})=>{
 const product=Object.freeze({id:'p1',title:'元の商品😀<img>'}),reviewed=Object.freeze(order('o1',{assetKind:'erc20',...extra}));
 const line={product,quantity:1,order:reviewed};f.shop.prepared.lines[0]=line;f.render();return line;
};
test('inspection requires the matching frozen original ERC20 line and otherwise gives saved-cart guidance',async t=>{
 for(const alter of [f=>{f.shop.prepared=null;},f=>{f.shop.prepared.lines[0].order=order('o1',{assetKind:'erc20'});},f=>{f.shop.prepared.lines[0].order=Object.freeze(order('o1',{assetKind:'native'}));},f=>{f.shop.prepared.lines[0].quantity=2;},f=>{f.shop.prepared.lines[0].order=Object.freeze(order('o1',{assetKind:'erc20',chainId:137}));}]){const f=await fixture(t);preparedERC20(f);alter(f);f.render();assert.equal(f.button('承認取引を照合'),undefined);assert.equal(f.button('承認を再送せず支払いを確認'),undefined);assert.match(f.document.querySelector('#order-detail').textContent,/カートの保存した注文を復旧/);assert.equal(f.approvalCalls.length,0);assert.equal(f.payCalls.length,0);assert.ok(f.button('保存した取引を照合'));}
});
test('ready inspection is read-only and retains the unknown receipt/cart lock before a separate continuation',async t=>{
 const f=await fixture(t),line=preparedERC20(f);await f.button('承認取引を照合').onclick();assert.equal(f.approvalCalls[0],line);assert.equal(f.payCalls.length,0);assert.equal(f.calls.length,0);assert.equal(f.finishes.length,0);assert.equal(f.writes.length,0);assert.equal(f.shop.orders[0].status,'wallet_unknown');assert.equal(f.shop.orders[0].transactionHash,null);assert.equal(f.shop.cart.p1,1);assert.equal(f.shop.prepared.lines.length,2);assert.equal(f.button('この注文を取り消す'),undefined);assert.equal(f.button('承認を再送せず支払いを確認').hidden,false);assert.match(f.document.querySelector('#order-detail').textContent,/現在の利用枠を確認/);assert.match(f.document.querySelector('#order-detail').textContent,/支払い完了や最終確定を示すものではありません/);
});
test('explicit continuation pays only the original selected line and uses the same saved receipt/cleanup path',async t=>{
 const f=await fixture(t),line=preparedERC20(f);await f.button('承認取引を照合').onclick();await f.button('承認を再送せず支払いを確認').onclick();assert.deepEqual(f.payCalls,[line]);assert.equal(f.shop.orders[0].transactionHash,HASH);assert.equal(f.shop.orders[0].status,'submitted');assert.equal(f.shop.cart.p1,undefined);assert.equal(f.shop.cart.p2,2);assert.equal(f.shop.prepared.lines.length,1);assert.equal(f.shop.prepared.lines[0].order.id,'o2');assert.equal(f.finishes[0][0],'o1');assert.ok(f.calls.every(call=>call.name==='commerce_order_status'));assert.equal(f.busy(),false);
});
test('missing/pending/failed/insufficient inspections keep receipt unknown and never offer payment',async t=>{
 for(const state of ['missing','pending','failed','insufficient']){const f=await fixture(t);preparedERC20(f);f.inspect=async()=>{throw Error('shop_payment_unknown');};await f.button('承認取引を照合').onclick();assert.equal(f.button('承認を再送せず支払いを確認').hidden,true);assert.equal(f.shop.orders[0].status,'wallet_unknown');assert.equal(f.shop.orders[0].transactionHash,null);assert.equal(f.shop.cart.p1,1);assert.equal(f.payCalls.length,0);assert.equal(f.writes.length,0);assert.equal(f.finishes.length,0);assert.equal(f.button('この注文を取り消す'),undefined);assert.match(f.document.querySelector('#order-detail').textContent,/再送せず/);}
});
test('deferred inspection ignores duplicate, old callback, changed prepared snapshot and A/B views',async t=>{
 for(const change of ['view','quantity','key','rerender']){const f=await fixture(t),wait=deferred();preparedERC20(f);f.inspect=()=>wait.promise;const inspect=f.button('承認取引を照合'),continuation=f.button('承認を再送せず支払いを確認');const pending=inspect.onclick();assert.equal(f.busy(),true);assert.equal(f.document.querySelector('#cart-country').disabled,true);await inspect.onclick();assert.equal(f.approvalCalls.length,1);if(change==='view')f.render({order:order('o2')});if(change==='quantity')f.shop.prepared.lines[0].quantity=2;if(change==='key')f.shop.prepared.key='changed';if(change==='rerender')f.render();wait.resolve({approvalHash:OTHERHASH});await pending;assert.equal(continuation.hidden,true);await continuation.onclick();assert.equal(f.payCalls.length,0);assert.equal(f.shop.orders[0].status,'wallet_unknown');assert.equal(f.busy(),false);}
});
test('ready flag is discarded on rerender and old ready handlers cannot continue',async t=>{
 const f=await fixture(t);preparedERC20(f);await f.button('承認取引を照合').onclick();const old=f.button('承認を再送せず支払いを確認');f.render();await old.onclick();assert.equal(f.payCalls.length,0);assert.equal(f.button('承認を再送せず支払いを確認').hidden,true);assert.equal(f.shop.orders[0].status,'wallet_unknown');assert.equal(f.writes.length,0);
});
test('wallet refusal or approval recheck failure preserves unknown lock and needs another explicit inspection',async t=>{
 for(const error of ['wallet_user_rejected','shop_payment_unknown','shop_payment_recovery_unavailable']){const f=await fixture(t);preparedERC20(f);await f.button('承認取引を照合').onclick();f.pay=async()=>{throw Error(error);};const continuation=f.button('承認を再送せず支払いを確認');await continuation.onclick();await continuation.onclick();assert.equal(f.payCalls.length,1);assert.equal(continuation.hidden,true);assert.equal(f.shop.orders[0].status,'wallet_unknown');assert.equal(f.shop.orders[0].transactionHash,null);assert.equal(f.shop.cart.p1,1);assert.equal(f.finishes.length,0);assert.equal(f.writes.length,0);assert.equal(f.button('この注文を取り消す'),undefined);}
});
test('payment callback save failure preserves known hash for payment recovery with no cleanup',async t=>{
 const f=await fixture(t);preparedERC20(f);await f.button('承認取引を照合').onclick();f.saveFails=true;await f.button('承認を再送せず支払いを確認').onclick();assert.equal(f.shop.orders[0].status,'status_pending');assert.equal(f.shop.orders[0].transactionHash,HASH);assert.equal(f.shop.cart.p1,1);assert.equal(f.shop.prepared.lines.length,2);assert.equal(f.finishes.length,0);assert.match(f.document.querySelector('#order-detail').textContent,/端末へ記録できませんでした/);f.saveFails=false;f.render();assert.equal(f.button('承認取引を照合'),undefined);assert.ok(f.button('保存した取引を照合'));
});
test('late selected-line payment result cleans only A and never replaces B or pays another line',async t=>{
 const f=await fixture(t,{orders:[receipt(),receipt('o2')]}),wait=deferred();preparedERC20(f);await f.button('承認取引を照合').onclick();f.pay=()=>wait.promise;const continuation=f.button('承認を再送せず支払いを確認'),pending=continuation.onclick();f.render({order:order('o2')});const text=f.document.querySelector('#order-detail').textContent;f.document.querySelector('#order-state').textContent='Bの状態';wait.resolve({order:order('o1',{status:'submitted'}),transactionHash:HASH});await pending;assert.equal(f.document.querySelector('#order-detail').textContent,text);assert.equal(f.document.querySelector('#order-state').textContent,'Bの状態');assert.equal(f.shop.cart.p1,undefined);assert.equal(f.shop.cart.p2,2);assert.equal(f.shop.orders.find(item=>item.id==='o2').status,'wallet_unknown');assert.equal(f.payCalls.length,1);assert.equal(f.calls.length,0);await continuation.onclick();assert.equal(f.payCalls.length,1);
});
test('payment journal recovery retains priority and approval UI never appears for known hashes',async t=>{
 const f=await fixture(t,{orders:[receipt('o1',{status:'status_pending',transactionHash:HASH})]});preparedERC20(f);assert.ok(f.button('保存した取引を照合'));assert.equal(f.button('承認取引を照合'),undefined);await f.button('保存した取引を照合').onclick();assert.equal(f.knownCalls.length,1);assert.equal(f.approvalCalls.length,0);assert.equal(f.payCalls.length,0);assert.equal(f.shop.cart.p1,undefined);assert.equal(f.shop.cart.p2,2);
});

test('approval controls have a separate wrapping action group after payment recovery and guidance',async t=>{
 const f=await fixture(t);preparedERC20(f);await f.button('承認取引を照合').onclick();const payment=f.button('保存した取引を照合'),inspect=f.button('承認取引を照合'),continuation=f.button('承認を再送せず支払いを確認');assert.notEqual(payment.parentNode,inspect.parentNode);assert.equal(inspect.parentNode,continuation.parentNode);assert.equal(inspect.parentNode.style.flexWrap,'wrap');for(const button of [inspect,continuation]){assert.equal(button.style.flex,'0 0 auto');assert.equal(button.style.whiteSpace,'nowrap');}const blocks=[...payment.parentNode.parentNode.children];assert.ok(blocks.indexOf(payment.parentNode)<blocks.indexOf(inspect.parentNode));assert.match(inspect.parentNode.previousElementSibling.textContent,/現在の利用枠/);
});

test('A deferred inspection or payment recovery releases the latest B recovery and approval controls without rerender',async t=>{
 for(const mode of ['approval','payment']){const f=await fixture(t,{orders:[receipt(),receipt('o2',{quantity:2})]}),wait=deferred();preparedERC20(f);f.shop.prepared.lines[1]={product:Object.freeze({id:'p2',title:'Bの商品'}),quantity:2,order:Object.freeze(order('o2',{assetKind:'erc20',quantity:2}))};let pending;if(mode==='approval'){f.inspect=()=>wait.promise;pending=f.button('承認取引を照合').onclick();}else{f.unknown=async args=>{await wait.promise;await args.onRecovered(HASH);return {order:order('o1',{status:'submitted'}),transactionHash:HASH};};pending=f.button('保存した取引を照合').onclick();}f.render({order:order('o2',{quantity:2})});const recovery=f.button('保存した取引を照合'),inspect=f.button('承認取引を照合'),continuation=f.button('承認を再送せず支払いを確認'),content=f.document.querySelector('#order-detail').textContent;assert.equal(recovery.disabled,true);assert.equal(inspect.disabled,true);wait.resolve({approvalHash:OTHERHASH});await pending;assert.equal(recovery.disabled,false);assert.equal(inspect.disabled,false);assert.equal(continuation.hidden,true);assert.equal(f.document.querySelector('#order-detail').textContent,content);}
});
