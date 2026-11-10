import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {createThreadReplyTarget} from './thread-reply-target.mjs';
import {walletExplorerUrl,appendWalletHistoryLinks} from './wallet-history-links.mjs';
test('quote reply replaces target, preserves draft, clears relationship without deleting body',()=>{
 const {document}=new JSDOM('<textarea maxlength="2000"></textarea>').window;const textarea=document.querySelector('textarea');document.body.append(textarea);const draft={body:'下書き'};textarea.value=draft.body;textarea.oninput=()=>draft.body=textarea.value;
 const target=createThreadReplyTarget(document,{draft,textarea});document.body.append(target.root);
 target.quote({id:'post1',no:1,body:'本文'});assert.equal(draft.replyToPostId,'post1');assert.ok(draft.body.includes('>>1'));
 target.quote({id:'post2',no:2,body:'別の本文'});assert.equal(draft.replyToPostId,'post2');const body=draft.body;target.root.querySelector('button').click();assert.equal(draft.replyToPostId,undefined);assert.equal(draft.body,body);
 target.quote({id:'../unsafe',no:3,body:'x'});assert.equal(draft.replyToPostId,undefined);assert.equal(draft.body,body);
 const separate={};assert.equal(createThreadReplyTarget(document,{draft:separate,textarea}).root.hidden,true);
});
test('wallet explorer is bound to supported chain and exact transaction, copy/open never sends funds',async()=>{
 const txHash='0x'+'a'.repeat(64),item={chainId:137,txHash,explorerUrl:'https://polygonscan.com/tx/'+txHash};assert.equal(walletExplorerUrl(item),item.explorerUrl);
 for(const explorerUrl of ['http://polygonscan.com/tx/'+txHash,'https://polygonscan.com.evil.invalid/tx/'+txHash,'https://user@polygonscan.com/tx/'+txHash,item.explorerUrl+'?secret=1','https://etherscan.io/tx/'+txHash,item.explorerUrl.replace(txHash,'0x'+'b'.repeat(64))])assert.equal(walletExplorerUrl({...item,explorerUrl}),null);
 assert.equal(walletExplorerUrl({...item,chainId:9999}),null);assert.equal(walletExplorerUrl({...item,txHash:'bad'}),null);
 const {document}=new JSDOM('<main/>').window,row=document.querySelector('main'),calls=[];let current=true;appendWalletHistoryLinks(document,row,item,{copy:v=>calls.push(['copy',v]),open:v=>calls.push(['open',v]),isCurrent:()=>current});
 const buttons=row.querySelectorAll('button');await buttons[0].onclick();await buttons[1].onclick();assert.deepEqual(calls,[['copy',txHash],['open',item.explorerUrl]]);current=false;await buttons[1].onclick();assert.equal(calls.length,2);
});
test('orders can reach records beyond first twenty, filtering resets page, refresh keeps visible tail',async()=>{
 const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');const from=source.indexOf('async function refreshOrderReceipt('),to=source.indexOf('// ---- 注文詳細',from);assert.ok(from>=0&&to>from);
 const {document}=new JSDOM('<div id="purchased-items"></div><div id="orders-list"></div>').window;
 const {createOrdersList,createLibrary}=await import('./market-me.mjs');
 const shop={orders:Array.from({length:45},(_,i)=>({id:'order-'+i,title:'商品'+i,status:i%2?'paid':'refunded',amountJpyc:100,createdAt:'2026-10-01'}))},opened=[];
 const render=new Function('document','shop','orderAutoRefreshed','openOrderDetail','invoke','shopToken','shopSave','orderStatusText','fulfillmentText','orderBuyerAttention','orderBuyerDone','hubAsset','openHubWebPath','showNotice','friendlyError','createOrdersList','createLibrary',source.slice(from,to)+'; return renderOrders;')(document,shop,new Set(shop.orders.map(x=>x.id)),id=>opened.push(id),()=>Promise.reject(),()=>null,()=>{},s=>s,s=>s,()=>false,r=>r.status==='refunded',()=>{},()=>{},()=>{},String,createOrdersList,createLibrary);
 render();const rows=()=>document.querySelectorAll('#orders-list .mk-row');assert.equal(rows().length,20);
 document.querySelector('#orders-list .mk-more .mk-btn').click();assert.equal(rows().length,40);
 document.querySelector('#orders-list .mk-more .mk-btn').click();assert.equal(rows().length,45);
 rows()[44].querySelector('.mk-btn').click();assert.deepEqual(opened,['order-44']);
 document.querySelector('.mk-chip[data-filter="done"]').click();assert.equal(rows().length,20);
 document.querySelector('#orders-list .mk-more .mk-btn').click();assert.equal(rows().length,23);
 document.querySelector('.mk-chip[data-filter="all"]').click();assert.equal(rows().length,20);
});

test('real thread form sends quote parent, retains it on failure, clears confirmed draft and safely handles closed threads',async()=>{
 const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');const start=source.indexOf('function renderThreadDetail('),end=source.indexOf('// --- 記事・Hubpedia・本 ---',start);assert.ok(start>=0&&end>start);
 const {window}=new JSDOM('<main/>'),document=window.document,target=document.querySelector('main');const entry={ids:['t1']},calls=[];let fails=true;
 const invoke=async(name,args)=>{calls.push({name,args});if(fails)throw Error('network failure');return {post:{id:'new'}};};
 const globals={createThreadContentCard:()=>({root:document.createElement("span")}),openCommunityContent(){},createThreadPostControls:()=>({element:document.createElement('span'),destroy(){}}),articleEditorScope:async()=>null,document,window,LANGUAGE_LABELS:{},REGION_LABELS:{},relTime:()=>'',invoke,openDetail:()=>{},openListPicker:()=>{},detailRenderRevision:0,researchAccountGeneration:0,currentView:'detail',detailTrail:[entry],researchEditorOptions:()=>({invoke}),createThreadStateControls:()=>document.createElement('section'),createThreadReader:(_d,{posts,renderPost})=>{const n=document.createElement('div');n.append(...posts.map(renderPost));return n;},threadPostCard:(post,context)=>{const b=document.createElement('button');b.type='button';b.textContent='quote'+post.no;b.onclick=()=>context.quote(post);return b;},threadKnowledgeControls:()=>document.createElement('section'),createThreadReplyTarget,friendlyError:String,renderDetailEntry:()=>{},detailSection:()=>document.createElement('section'),catalogCard:()=>document.createElement('div')};
 const render=new Function(...Object.keys(globals),source.slice(start,end)+';return renderThreadDetail;')(...Object.values(globals));
 const data={thread:{id:'t1',postCount:2,status:'open'},posts:[{id:'post1',no:1,body:'first'},{id:'post2',no:2,body:'second'}],viewer:{id:'me'}};render(target,data,entry);
 target.querySelectorAll('button')[2].click();const quote=[...target.querySelectorAll('button')].find(n=>n.textContent==='quote1');quote.click();const textarea=target.querySelector('textarea'),form=textarea.closest('form');
 await form.onsubmit({preventDefault(){}});assert.equal(calls.at(-1).args.options.replyToPostId,'post1');assert.equal(entry.replyDraft.replyToPostId,'post1');assert.equal(textarea.disabled,false);
 [...target.querySelectorAll('button')].find(n=>n.textContent==='quote2').click();fails=false;await form.onsubmit({preventDefault(){}});assert.equal(calls.at(-1).args.options.replyToPostId,'post2');assert.deepEqual(entry.replyDraft,{});
 render(target,{...data,thread:{...data.thread,status:'closed'}},entry);assert.equal(target.querySelector('textarea'),null);assert.doesNotThrow(()=>[...target.querySelectorAll('button')].find(n=>n.textContent==='quote1').click());
});
