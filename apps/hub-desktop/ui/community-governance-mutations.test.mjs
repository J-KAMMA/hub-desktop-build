import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const artifact=import.meta.url.includes('/visualizations/');
const require=createRequire(artifact?new URL('../../../package.json',import.meta.url).href:import.meta.url);
const {JSDOM}=require('jsdom');
const moduleURL=new URL('./community-governance-mutations.mjs',import.meta.url);
const reader=artifact?new URL('./community-governance.mjs',import.meta.url).href:new URL('./community-governance.mjs',import.meta.url).href;
const source=readFileSync(moduleURL,'utf8').replace("'./community-governance.mjs'",JSON.stringify(reader));
const {communityGovernanceMutations}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const cid='cid',pid='proposal',stamp='2026-10-03T00:00:00.000Z',snapshot='a'.repeat(64);
const tick=()=>new Promise(resolve=>setTimeout(resolve,1));
const zero=()=>({count:0,weight:0,memberWeight:0,tokenWeight:0});
const tally=votes=>{const value=Object.fromEntries(['for','against','abstain','total'].map(c=>[c,zero()]));for(const vote of votes)for(const c of [vote.choice,'total']){value[c].count++;for(const k of ['weight','memberWeight','tokenWeight'])value[c][k]+=vote[k];}return value;};
export function makeMutationContext(status='voting'){
 const proposal={id:pid,communityId:cid,authorProfileId:'author',kind:'rule',title:'提案 <img src=x onerror=alert(1)>',body:'PRIVATE_BODY <script>alert(1)</script>\n'+'長い本文'.repeat(30),status,votingStrategy:'one_member_one_vote',governanceTokenId:null,governanceTokenSymbol:null,tokensPerVote:1,voteWeightCap:null,quorum:1,approvalThreshold:.6,votingMethod:'one_member_one_vote',decisionScope:'community',executionMode:'operator',snapshotPolicy:'proposal_start',snapshotBlockNumber:null,snapshotCapturedAt:status==='discussion'?null:stamp,quorumMemberBps:2000,quorumTokenBps:0,approvalBps:5001,linkedGuideProposalId:null,votingStartsAt:new Date(Date.now()-60000).toISOString(),votingEndsAt:new Date(Date.now()+3600000).toISOString(),createdAt:stamp,updatedAt:stamp,executedAt:status==='executed'?stamp:null,governanceTokenRules:[]};
 return {communityId:cid,proposalId:pid,viewerId:'actor',snapshot,proposal,tally:tally([]),myVote:null,allowedActions:status==='discussion'?['start_voting','cancel']:status==='voting'?['close_voting','cancel']:status==='passed'?['execute']:[],canVote:status==='voting',canManage:true,canExecute:status==='passed',votingPower:{weight:1,memberWeight:1,tokenWeight:0},eligibleMembers:2,eligibleTokenWeight:0,legacySnapshot:false,sourceBasis:'membership',unavailableReason:null};
}
export function makeMutationAck(args,ctx,replayed=false,votes=[]){
 const p=structuredClone(ctx.proposal),action=args.options.action;
 if(args.action==='community_governance_vote')votes=[{proposalId:pid,profileId:ctx.viewerId,choice:args.options.choice,...ctx.votingPower,createdAt:stamp,updatedAt:stamp}];
 else {p.status=action==='start_voting'?'voting':action==='close_voting'?'passed':action==='execute'?'executed':'cancelled';if(action==='execute')p.executedAt=stamp;}
 const own=votes.find(v=>v.profileId===ctx.viewerId),myVote=own?Object.fromEntries(['choice','weight','memberWeight','tokenWeight','createdAt','updatedAt'].map(k=>[k,own[k]])):null;
 return {proposal:p,votes,tally:tally(votes),myVote,eligibleMembers:ctx.eligibleMembers,eligibleTokenWeight:ctx.eligibleTokenWeight,receipt:{auditId:args.options.operationId,action:args.action==='community_governance_vote'?'governance_vote_cast':'governance_'+action,targetId:pid,confirmedAt:stamp,replayed}};
}
function fixture({state={},prepared=makeMutationContext(),invoke,isCurrent=()=>true,onChanged}={}){
 const dom=new JSDOM(''),calls=[],opened=[];let ctx=prepared??makeMutationContext();
 const controller=communityGovernanceMutations(dom.window.document,{communityId:cid,proposalId:pid},{state,prepared,isCurrent,onChanged,connectAccount:()=>opened.push('connect'),onOpen:(...args)=>opened.push(args),invoke:async(name,args)=>{calls.push({name,args:structuredClone(args)});return invoke?invoke(name,args,ctx):name==='hub_detail'?ctx:makeMutationAck(args,ctx);}});
 const root=controller.root;dom.window.document.body.append(root);
 const button=name=>[...root.querySelectorAll('button')].find(b=>b.textContent===name);
 const wait=async predicate=>{for(let i=0;i<80;i++){if(predicate())return;await tick();}assert.ok(predicate(),'Expected UI state did not arrive: '+root.textContent);};
 const preview=async label=>{assert.ok(button(label));button(label).click();await wait(()=>root.querySelector('[aria-label="DAO操作の全文確認"]'));};
 const save=()=>{const b=button('確認して投票を保存')??button('確認して進行操作を保存')??button('同じ操作の保存結果を確認');assert.ok(b);b.click();};
 return {dom,controller,root,state,calls,opened,button,wait,preview,save,posts:()=>calls.filter(c=>c.name==='hub_client_action'),setContext:value=>ctx=value,close(){controller.dispose();dom.window.close();}};
}

test('three choices read the latest context before full literal preview and explicitly save strict UUID payload',async()=>{
 for(const[choice,label]of [['for','賛成'],['against','反対'],['abstain','棄権']]){const f=fixture();assert.equal(f.calls.length,0);await f.preview(label+'を確認');assert.equal(f.posts().length,0);assert.equal(f.calls[0].args.name,'community_governance_mutation_context');assert.deepEqual(f.calls[0].args.ids,[cid,pid]);assert.equal(f.root.querySelector('script'),null);assert.equal(f.root.querySelector('img'),null);assert.match(f.root.querySelector('pre').textContent,/PRIVATE_BODY <script>/);f.save();await f.wait(()=>/操作は保存済み/.test(f.root.textContent));const a=f.posts()[0].args;assert.equal(a.action,'community_governance_vote');assert.equal(a.target,cid);assert.equal(a.text,pid);assert.deepEqual(Object.keys(a.options).sort(),['choice','operationId','snapshot']);assert.equal(a.options.choice,choice);assert.equal(a.options.snapshot,snapshot);assert.match(a.options.operationId,/^[a-f0-9-]{36}$/);assert.equal(f.posts().length,1);f.close();}
});
test('start, close, execute record and cancel keep independent explicit confirmation without external execution claims',async()=>{
 for(const[status,label,action]of [['discussion','投票開始','start_voting'],['voting','締切','close_voting'],['passed','実行済みの記録','execute'],['discussion','中止','cancel']]){const f=fixture({prepared:makeMutationContext(status)});await f.preview(label+'を確認');assert.equal(f.posts().length,0);if(action==='execute')assert.match(f.root.textContent,/外部の送金・契約・処分や自動執行は行いません/);f.save();await f.wait(()=>/操作は保存済み/.test(f.root.textContent));assert.equal(f.posts()[0].args.options.action,action);assert.deepEqual(Object.keys(f.posts()[0].args.options).sort(),['action','operationId','snapshot']);f.close();}
});
test('unavailable legacy and advanced modes expose reason and cancel only, anonymous keeps connect/read controls',()=>{
 const legacy=makeMutationContext();legacy.legacySnapshot=true;legacy.canVote=false;legacy.allowedActions=['cancel'];legacy.unavailableReason='完全な開始資格を確認できません。';const f=fixture({prepared:legacy});assert.equal(f.button('賛成を確認'),undefined);assert.ok(f.button('中止を確認'));assert.match(f.root.textContent,/完全な開始資格/);f.close();
 const advanced=makeMutationContext('passed');advanced.proposal.executionMode='timelock';advanced.allowedActions=[];advanced.canExecute=false;advanced.unavailableReason='timelockは未対応です。';const g=fixture({prepared:advanced});assert.equal(g.button('実行済みの記録を確認'),undefined);assert.match(g.root.textContent,/未対応/);g.close();
 const anon=makeMutationContext();Object.assign(anon,{viewerId:null,canVote:false,canManage:false,canExecute:false,allowedActions:[],votingPower:null});const h=fixture({prepared:anon});assert.equal(h.button('賛成を確認'),undefined);h.button('Desktopを接続').click();assert.deepEqual(h.opened,['connect']);assert.equal(h.posts().length,0);h.close();
});
test('prepare uses changed snapshot, refuses lost action, and double clicks prepare/save only once',async()=>{
 const initial=makeMutationContext(),fresh=structuredClone(initial);fresh.snapshot='b'.repeat(64);let finish;
 const f=fixture({prepared:initial,invoke:async(name,args)=>name==='hub_detail'?fresh:new Promise(resolve=>finish=()=>resolve(makeMutationAck(args,fresh)))});
 const captured=f.button('賛成を確認');captured.click();captured.click();await f.wait(()=>f.root.querySelector('pre'));assert.equal(f.calls.length,1);f.save();f.save();assert.equal(f.posts().length,1);assert.equal(f.posts()[0].args.options.snapshot,fresh.snapshot);finish();await f.wait(()=>/保存済み/.test(f.root.textContent));f.close();
 const denied=structuredClone(initial);denied.canVote=false;denied.allowedActions=[];const g=fixture({prepared:initial,invoke:async()=>denied});g.button('賛成を確認').click();await g.controller.ready;await tick();assert.equal(g.root.querySelector('pre'),null);assert.equal(g.posts().length,0);g.close();
});
test('unknown retry retains exact UUID/snapshot/choice across remount and advanced current state',async()=>{
 const state={},ctx=makeMutationContext();let attempt=0;
 const invoke=async(name,args)=>{if(name==='hub_detail')return ctx;if(++attempt===1)throw Error('network');return makeMutationAck(args,ctx,true);};
 const f=fixture({state,prepared:ctx,invoke});await f.preview('賛成を確認');f.save();await f.wait(()=>/保存結果が不明/.test(f.root.textContent));const original=f.posts()[0].args;f.controller.dispose();
 const advanced=structuredClone(ctx);advanced.proposal.status='passed';advanced.canVote=false;advanced.canExecute=true;advanced.allowedActions=['execute'];const g=fixture({state,prepared:advanced,invoke});assert.ok(g.button('同じ操作の保存結果を確認'));g.save();await g.wait(()=>/操作は保存済み/.test(g.root.textContent));assert.deepEqual(g.posts()[0].args,original);assert.equal(attempt,2);f.close();g.close();
});
test('unknown then 409 requires fresh read before explicit local close, preserves current state and POST count',async()=>{
 const ctx=makeMutationContext();let attempt=0,readsFail=false;const f=fixture({prepared:ctx,invoke:async(name)=>{if(name==='hub_detail'){if(readsFail)throw Error('503');return ctx;}if(++attempt===1)throw Error('network');throw Error('community_governance_mutation_rejected:409:状態が変わりました');}});
 await f.preview('賛成を確認');f.save();await f.wait(()=>/保存結果が不明/.test(f.root.textContent));f.save();await f.wait(()=>/操作が拒否/.test(f.root.textContent));assert.equal(f.button('現在の提案を確認して以前の操作を閉じる'),undefined);
 readsFail=true;f.button('投票・進行操作の条件を再読み込み').click();await f.controller.ready;assert.equal(f.button('現在の提案を確認して以前の操作を閉じる'),undefined);
 readsFail=false;f.button('投票・進行操作の条件を再読み込み').click();await f.controller.ready;assert.ok(f.button('現在の提案を確認して以前の操作を閉じる'));const posts=f.posts().length;f.button('現在の提案を確認して以前の操作を閉じる').click();assert.equal(f.posts().length,posts);assert.ok(f.button('賛成を確認'));await f.preview('反対を確認');assert.notEqual(f.state.governance[JSON.stringify([cid,'mutations',pid])].operation.payload.operationId,f.posts()[0].args.options.operationId);f.close();
});
test('saved ACK followed by GET failure remains saved, and reread/reset never reposts the old operation',async()=>{
 const ctx=makeMutationContext();let saved=false;const f=fixture({prepared:ctx,invoke:async(name,args)=>{if(name==='hub_detail'){if(saved)throw Error('503');return ctx;}saved=true;return makeMutationAck(args,ctx);}});
 await f.preview('賛成を確認');f.save();await f.wait(()=>/保存済み/.test(f.root.textContent)&&/503/.test(f.root.textContent));assert.equal(f.posts().length,1);assert.equal(f.button('同じ操作の保存結果を確認'),undefined);assert.equal(f.button('別の投票・進行操作へ').disabled,true);f.button('投票・進行操作の条件を再読み込み').click();await f.controller.ready;assert.equal(f.posts().length,1);f.close();
});
test('malformed ACK receipt, target, votes, tally, actor vote and immutable body never become successful',async()=>{
 const corruptions=[v=>v.receipt.auditId+='\n',v=>v.receipt.targetId='foreign',v=>v.receipt.action='governance_cancel',v=>v.votes.push({...v.votes[0]}),v=>v.votes[0].proposalId='foreign',v=>v.tally.total.weight++,v=>v.myVote.choice='against',v=>v.proposal.body='Changed private body',v=>v.votes[0].weight=Number.MAX_SAFE_INTEGER+1];
 for(const corrupt of corruptions){const ctx=makeMutationContext(),f=fixture({prepared:ctx,invoke:async(name,args)=>{if(name==='hub_detail')return ctx;const value=makeMutationAck(args,ctx);corrupt(value);return value;}});await f.preview('賛成を確認');f.save();await f.wait(()=>/保存結果が不明/.test(f.root.textContent));assert.doesNotMatch(f.root.textContent,/操作は保存済み/);assert.ok(f.button('同じ操作の保存結果を確認'));f.close();}
});
test('malformed context, one MiB overflow, anonymous vote, IDs and inconsistent powers fail closed',()=>{
 const corruptions=[v=>v.proposalId+='\n',v=>v.viewerId+='\n',v=>v.snapshot+='\n',v=>v.proposal.body='x\ud800',v=>v.votingPower.memberWeight=0,v=>v.allowedActions=['execute'],v=>v.viewerId=null,v=>v.padding='x'.repeat(1024*1024),v=>v.tally.total.count=1,v=>v.eligibleMembers=Number.MAX_SAFE_INTEGER+1];
 for(const corrupt of corruptions){const value=makeMutationContext();corrupt(value);const f=fixture({prepared:value});assert.equal(f.button('賛成を確認'),undefined);assert.equal(f.root.querySelector('pre'),null);assert.equal(f.posts().length,0);f.close();}
});
test('all six methods retain correct fixed power, eligibility and recent observation wording',async()=>{
 for(const method of ['one_member_one_vote','one_holder_one_vote','token_linear','token_sqrt','token_log','dual_chamber']){const ctx=makeMutationContext();ctx.proposal.votingMethod=method;if(method!=='one_member_one_vote'){ctx.sourceBasis='recent_verified_balance';ctx.proposal.votingStrategy='token_weighted';ctx.proposal.governanceTokenRules=[{tokenId:'t',tokenSymbol:'T',tokensPerVote:1,weight:1}];ctx.votingPower=method==='dual_chamber'?{weight:2,memberWeight:1,tokenWeight:2}:{weight:2,memberWeight:0,tokenWeight:2};ctx.eligibleTokenWeight=4;}const f=fixture({prepared:ctx});await f.preview('棄権を確認');assert.match(f.root.textContent,/固定投票力/);if(method!=='one_member_one_vote')assert.match(f.root.textContent,/現在のオンチェーン残高ではありません/);f.save();await f.wait(()=>/保存済み/.test(f.root.textContent));f.close();}
});
test('permission loss strips private reader/confirmation data, preserves only frozen recovery and same-actor fresh-close',async()=>{
 const ctx=makeMutationContext();const f=fixture({prepared:ctx,invoke:async(name)=>{if(name==='hub_detail')return ctx;throw Error('community_governance_mutation_rejected:403:権限がありません');}});
 await f.preview('賛成を確認');f.save();await f.wait(()=>/操作が拒否/.test(f.root.textContent));assert.doesNotMatch(f.root.textContent,/PRIVATE_BODY|提案 <img/);const s=f.state.governance[JSON.stringify([cid,'mutations',pid])];assert.equal(s.data,undefined);assert.equal(s.operation.proposal,undefined);assert.equal(s.operation.power,undefined);assert.equal(s.operation.payload.snapshot,snapshot);assert.equal(s.operation.proposalProof.length,64);f.button('投票・進行操作の条件を再読み込み').click();await f.controller.ready;assert.ok(f.button('現在の提案を確認して以前の操作を閉じる'));f.close();
});
test('back navigation retains confirmation and pending saved ACK for same actor remount',async()=>{
 const state={},ctx=makeMutationContext();let finish;const invoke=async(name,args)=>name==='hub_detail'?ctx:new Promise(resolve=>finish=()=>resolve(makeMutationAck(args,ctx)));
 const f=fixture({state,prepared:ctx,invoke});await f.preview('賛成を確認');const original=state.governance[JSON.stringify([cid,'mutations',pid])].operation.payload;f.button('提案の詳細へ戻る').click();assert.deepEqual(f.opened[0],['community_governance_proposal',[cid,pid],'DAO提案の詳細']);f.controller.dispose();
 const g=fixture({state,prepared:ctx,invoke});assert.deepEqual(state.governance[JSON.stringify([cid,'mutations',pid])].operation.payload,original);g.save();g.controller.dispose();const h=fixture({state,prepared:ctx,invoke});finish();await h.wait(()=>/保存済み/.test(h.root.textContent)&&h.calls.some(call=>call.name==='hub_detail'));await h.controller.ready;assert.equal(h.posts().length,0);assert.equal(h.calls.filter(call=>call.name==='hub_detail').length,1);f.close();g.close();h.close();
});
test('account change invalidates private data and ignores pending ACK and captured buttons',async()=>{
 const ctx=makeMutationContext();let finish;const f=fixture({prepared:ctx,invoke:async(name,args)=>name==='hub_detail'?ctx:new Promise(resolve=>finish=()=>resolve(makeMutationAck(args,ctx)))});
 const captured=f.button('反対を確認');await f.preview('賛成を確認');f.save();f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));finish();await tick();await tick();assert.match(f.root.textContent,/接続が変わりました/);assert.doesNotMatch(f.root.textContent,/PRIVATE_BODY|保存済み/);assert.equal(Object.keys(f.state.governance).length,0);captured.click();assert.equal(f.posts().length,1);f.close();
});
test('scope staleness blocks captured callbacks and mounted late ACK; fresh actor mismatch wipes previous data',async()=>{
 let current=true,finish;const ctx=makeMutationContext();const f=fixture({prepared:ctx,isCurrent:()=>current,invoke:async(name,args)=>name==='hub_detail'?ctx:new Promise(resolve=>finish=()=>resolve(makeMutationAck(args,ctx)))});
 await f.preview('賛成を確認');f.save();current=false;finish();await f.wait(()=>/接続が変わりました/.test(f.root.textContent));assert.doesNotMatch(f.root.textContent,/PRIVATE_BODY|保存済み/);f.close();
 const other=structuredClone(ctx);other.viewerId='other';const g=fixture({prepared:ctx,invoke:async()=>other});g.button('投票・進行操作の条件を再読み込み').click();await g.controller.ready;assert.match(g.root.textContent,/接続が変わりました/);assert.doesNotMatch(g.root.textContent,/PRIVATE_BODY/);g.close();
});
test('known first rejection requires reread/local close and deadline stops first POST but allows receipt recovery',async()=>{
 const ctx=makeMutationContext();const f=fixture({prepared:ctx,invoke:async(name)=>{if(name==='hub_detail')return ctx;throw Error('community_governance_mutation_rejected:409:変更されています');}});
 await f.preview('中止を確認');f.save();await f.wait(()=>/操作が拒否/.test(f.root.textContent));assert.equal(f.button('現在の提案を確認して以前の操作を閉じる'),undefined);f.close();
 const expired=makeMutationContext();expired.proposal.votingEndsAt=new Date(Date.now()-1).toISOString();const g=fixture({prepared:expired});await g.preview('賛成を確認');g.save();assert.equal(g.posts().length,0);assert.match(g.root.textContent,/締切/);g.close();
});
test('legacy cancel ACK can acknowledge recorded votes despite missing eligible cohort',async()=>{
 const ctx=makeMutationContext();ctx.legacySnapshot=true;ctx.canVote=false;ctx.allowedActions=['cancel'];ctx.unavailableReason='開始集合が不完全です。';ctx.eligibleMembers=0;
 const f=fixture({prepared:ctx,invoke:async(name,args)=>{if(name==='hub_detail')return ctx;return makeMutationAck(args,ctx,false,[{proposalId:pid,profileId:'actor',choice:'for',weight:1,memberWeight:1,tokenWeight:0,createdAt:stamp,updatedAt:stamp}]);}});
 await f.preview('中止を確認');f.save();await f.wait(()=>/保存済み/.test(f.root.textContent));assert.match(f.root.textContent,/開始集合が不完全/);f.close();
});
test('leaving during preparation releases the read lock; invalid scope never sends a native read',async()=>{
 const state={},ctx=makeMutationContext();let finish;const f=fixture({state,prepared:ctx,invoke:()=>new Promise(resolve=>finish=()=>resolve(ctx))});
 f.button('賛成を確認').click();assert.equal(state.governance[JSON.stringify([cid,'mutations',pid])].preparing,true);f.controller.dispose();const g=fixture({state,prepared:ctx});await g.preview('反対を確認');const operation=structuredClone(state.governance[JSON.stringify([cid,'mutations',pid])].operation.payload);finish();await tick();assert.deepEqual(state.governance[JSON.stringify([cid,'mutations',pid])].operation.payload,operation);f.close();g.close();
 const dom=new JSDOM(''),calls=[];const c=communityGovernanceMutations(dom.window.document,{communityId:cid+'\n',proposalId:pid},{invoke:async(...args)=>calls.push(args)});await c.ready;assert.equal(calls.length,0);c.dispose();dom.window.close();
});
