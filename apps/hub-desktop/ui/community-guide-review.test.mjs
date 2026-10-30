import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {communityGuideReview} from './community-guide-review.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const button=(root,text)=>[...root.querySelectorAll('button')].find(item=>item.textContent===text);
const initial=()=>({proposal:{id:'p1',communityId:'c1',title:'Proposal',proposedTitle:'Guide',proposedBody:'<script>unsafe()</script>',baseVersion:1,status:'open',updatedAt:'old'},currentPage:{title:'Guide',body:'Old body',version:1},reviews:[],reviewPage:{offset:0,hasMore:false,nextOffset:null},permissions:{canComment:true,canApprove:true,canRequestChanges:true,canClose:true,canMerge:true}});
test('review confirmation sends nothing, retries an unknown result with the same ID, and clears acknowledged input even when refresh fails',async()=>{
 const dom=new JSDOM(''),state={},calls=[];let fail=true;
 const root=communityGuideReview(dom.window.document,{communityId:'c1',proposalId:'p1',data:initial(),state,invoke:async(command,p)=>{
  if(command==='hub_detail')throw Error('read failed');calls.push(p);if(fail)throw Error('lost response');return {operationId:p.requestId,proposal:{id:'p1',communityId:'c1',status:'open',updatedAt:'new'},review:{id:p.requestId}};
 }});
 const field=root.querySelector('[aria-label="レビュー本文"]');field.value='Review';field.dispatchEvent(new dom.window.Event('input'));
 button(root,'承認').click();assert.equal(calls.length,0);assert.match(root.textContent,/Review/);button(root,'確認して実行').click();await tick();assert.equal(state.reviewBody,'Review');
 fail=false;button(root,'確認して実行').click();await tick();assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[1].options.expectedUpdatedAt,'old');assert.equal(field.value,'');assert.match(root.textContent,/保存済み/);assert.equal(button(root,'承認'),undefined);assert.equal(root.querySelector('script'),null);dom.window.close();
});
test('merge is confirmed once, busy buttons cannot double-send, and a saved transition adopts the returned current state',async()=>{
 const dom=new JSDOM(''),calls=[],updates=[];let release;const data=initial();
 const root=communityGuideReview(dom.window.document,{communityId:'c1',proposalId:'p1',data,invoke:async(command,p)=>{if(command==='hub_detail')return {...data,proposal:{...data.proposal,status:'merged'},permissions:{}};calls.push(p);await new Promise(resolve=>release=resolve);return {operationId:p.requestId,proposal:{id:'p1',communityId:'c1',status:'merged'}};},onUpdated:d=>updates.push(d.proposal.status)});
 button(root,'統合して公開').click();assert.equal(calls.length,0);assert.match(root.textContent,/改訂履歴/);button(root,'確認して実行').click();button(root,'確認して実行').click();assert.equal(calls.length,1);release();await tick();assert.equal(calls[0].action,'community_guide_update');assert.equal(calls[0].options.action,'merge');assert.deepEqual(updates,['merged','merged']);assert.equal(button(root,'統合して公開'),undefined);dom.window.close();
});
test('a mismatched acknowledgement keeps the review and editing invalidates its confirmation',async()=>{
 const dom=new JSDOM(''),state={},calls=[];const root=communityGuideReview(dom.window.document,{communityId:'c1',proposalId:'p1',data:initial(),state,invoke:async(_,p)=>{calls.push(p);return {operationId:p.requestId,proposal:{id:'other',communityId:'c1'},review:{id:p.requestId}};}});
 const field=root.querySelector('textarea');field.value='First';field.dispatchEvent(new dom.window.Event('input'));button(root,'コメント').click();button(root,'確認して実行').click();await tick();assert.equal(state.reviewBody,'First');assert.match(root.textContent,/保存結果を確認できません/);
 field.value='Changed';field.dispatchEvent(new dom.window.Event('input'));button(root,'確認して実行').click();await tick();assert.equal(calls.length,1);button(root,'コメント').click();button(root,'確認して実行').click();await tick();assert.notEqual(calls[0].requestId,calls[1].requestId);dom.window.close();
});
test('read-only and closed proposals expose only authorized controls; review paging preserves position only on matching responses',async()=>{
 const dom=new JSDOM(''),data=initial(),state={};const readOnly=communityGuideReview(dom.window.document,{communityId:'c1',proposalId:'p1',data:{...data,permissions:{}},invoke:async()=>{}});assert.equal(button(readOnly,'コメント'),undefined);assert.equal(readOnly.querySelector('textarea').hidden,true);
 const closed=communityGuideReview(dom.window.document,{communityId:'c1',proposalId:'p1',data:{...data,permissions:{canReopen:true}},invoke:async()=>{}});assert.ok(button(closed,'編集案を再開'));assert.equal(button(closed,'統合して公開'),undefined);
 const root=communityGuideReview(dom.window.document,{communityId:'c1',proposalId:'p1',state,data:{...data,reviewPage:{offset:0,hasMore:true,nextOffset:20}},invoke:async(command,p)=>{assert.equal(command,'hub_detail');assert.deepEqual(p,{name:'community_guide_reviews_page',ids:['c1','p1','20']});return {reviews:[{body:'<img onerror=unsafe()>',authorName:'Reader',decision:'comment'}],reviewPage:{offset:20,hasMore:false,nextOffset:null},permissions:data.permissions};}});
 button(root,'次の20件').click();await tick();assert.equal(state.reviewOffset,20);assert.equal(root.querySelector('img'),null);assert.match(root.textContent,/<img onerror/);dom.window.close();
});
