import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {communityMembershipRequests,communityMembershipReview,communityMembershipReviewRequest} from './community-membership-review.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),button=(root,label)=>[...root.querySelectorAll('button')].find(item=>item.textContent===label);
const data={communityId:'c1',viewerId:'manager',role:'owner',request:{profileId:'p1',displayName:'Applicant',createdAt:'2026-10-02T00:00:00.000Z',status:'pending',canApprove:true},answers:[{prompt:'<script>Question</script>',answer:'<img src=x onerror=alert(1)>Answer'}]};
test('request lists page only on a matching response, retain position on failure, and open a selected request',async()=>{
 const dom=new JSDOM(''),state={},calls=[],opened=[];let fail=true;
 const page=offset=>({communityId:'c1',requests:[{profileId:'p'+offset,displayName:'Person '+offset,createdAt:'now'}],page:{offset,hasMore:offset===0,nextOffset:offset===0?20:null}});
 const root=communityMembershipRequests(dom.window.document,{communityId:'c1',data:page(0),state,onOpen:(...args)=>opened.push(args),invoke:async(_,p)=>{calls.push(p);if(fail)throw Error('offline');return page(Number(p.ids[1]));}});
 button(root,'次の20件').click();await tick();assert.equal(state.offset,0);assert.match(root.textContent,/Person 0/);assert.match(root.textContent,/offline/);
 fail=false;button(root,'次の20件').click();await tick();assert.equal(state.offset,20);assert.deepEqual(calls[1],{name:'community_membership_requests_page',ids:['c1','20']});button(root,'Person 20').click();assert.deepEqual(opened,[['community_membership_request',['c1','p20'],'Person 20の参加申請']]);
 assert.deepEqual(communityMembershipReviewRequest({name:'community_membership_requests',ids:['c1'],membershipReviewPage:state}),{name:'community_membership_requests_page',ids:['c1','20']});dom.window.close();
});
test('review confirmation sends nothing; unknown results retain the same ID and input; only a matching acknowledgement clears the draft',async()=>{
 const dom=new JSDOM(''),state={},calls=[];let release,fail=true;
 const root=communityMembershipReview(dom.window.document,{communityId:'c1',profileId:'p1',data,state,onReload:async()=>{throw Error('offline');},invoke:async(_,p)=>{calls.push(p);if(fail){await new Promise(resolve=>release=resolve);throw Error('lost response');}return {ok:true,receipt:{auditId:p.requestId,targetId:'p1',action:'membership'},request:{profileId:'p1',status:'approved',createdAt:data.request.createdAt}};}});
 assert.equal(root.querySelector('script'),null);assert.equal(root.querySelector('img'),null);const reason=root.querySelector('textarea');reason.value='回答を確認しました';reason.dispatchEvent(new dom.window.Event('input'));
 button(root,'承認').click();assert.equal(calls.length,0);button(root,'確認して実行').click();button(root,'確認して実行').click();assert.equal(calls.length,1);release();await tick();assert.equal(state.note,'回答を確認しました');assert.match(root.textContent,/lost response/);
 fail=false;button(root,'確認して実行').click();await tick();assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[1].options.expectedCreatedAt,data.request.createdAt);assert.deepEqual(state,{});assert.equal(reason.value,'');assert.equal(button(root,'承認').disabled,true);assert.match(root.textContent,/承認済み/);
 button(root,'状態を再読込').click();await tick();assert.match(root.textContent,/審査は保存済み/);assert.equal(calls.length,2);dom.window.close();
});
test('wrong receipts keep the draft, editing requires confirmation again and a new ID, and UTF-16 limits are enforced',async()=>{
 const dom=new JSDOM(''),state={},calls=[],root=communityMembershipReview(dom.window.document,{communityId:'c1',profileId:'p1',data,state,invoke:async(_,p)=>{calls.push(p);return{ok:true,receipt:{auditId:p.requestId,targetId:'other',action:'membership'}};}});
 const reason=root.querySelector('textarea');reason.value='😀'.repeat(500);reason.dispatchEvent(new dom.window.Event('input'));button(root,'却下').click();button(root,'確認して実行').click();await tick();assert.match(root.textContent,/保存結果を確認できません/);assert.equal(reason.value.length,1000);
 reason.value='Changed reason';reason.dispatchEvent(new dom.window.Event('input'));button(root,'確認して実行').click();await tick();assert.equal(calls.length,1);button(root,'却下').click();button(root,'確認して実行').click();await tick();assert.notEqual(calls[0].requestId,calls[1].requestId);
 reason.value='😀'.repeat(501);reason.dispatchEvent(new dom.window.Event('input'));button(root,'承認').click();assert.match(root.textContent,/5〜1000/);assert.equal(calls.length,2);dom.window.close();
});
test('processed and self requests cannot be reviewed; restricted applicants can only be rejected',()=>{
 const dom=new JSDOM('');
 for(const change of [{request:{...data.request,status:'cancelled'}},{viewerId:'p1'},{role:'member'}]){
  const root=communityMembershipReview(dom.window.document,{communityId:'c1',profileId:'p1',data:{...data,...change},invoke:async()=>assert.fail('no write')});assert.equal(button(root,'承認'),undefined);assert.equal(button(root,'却下'),undefined);
 }
 const root=communityMembershipReview(dom.window.document,{communityId:'c1',profileId:'p1',data:{...data,request:{...data.request,canApprove:false}},invoke:async()=>{}});assert.equal(button(root,'承認'),undefined);assert.ok(button(root,'却下'));dom.window.close();
});
