import {validateCommunityGovernanceProposalDetail} from './community-governance.mjs';

const choices={for:'賛成',against:'反対',abstain:'棄権'};
const actions={start_voting:'投票開始',close_voting:'締切',execute:'実行済みの記録',cancel:'中止'};
const statuses={discussion:'議論中',voting:'投票中',passed:'可決',rejected:'否決',executed:'実行済み（記録）',cancelled:'中止'};
const node=(d,tag,text='',cls='')=>{const n=d.createElement(tag);n.textContent=text;n.className=cls;return n;};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=100&&!/[^A-Za-z0-9_-]/.test(v);
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&v.length===64&&!/[^a-f0-9]/.test(v);
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\ud800-\udfff]/u.test(v);
const date=v=>text(v,64)&&v.length>0&&!/[\u0000-\u001f\u007f]/.test(v)&&Number.isFinite(Date.parse(v));
const number=v=>Number.isSafeInteger(v)&&v>=0;
const invalid=()=>{throw Error('DAO提案の操作条件または保存結果を確認できませんでした。');};
function bounded(v){try{if(new TextEncoder().encode(JSON.stringify(v)).length>1024*1024)invalid();}catch{invalid();}}
function power(v,method){
 if(!v||['weight','memberWeight','tokenWeight'].some(k=>!number(v[k])))invalid();
 if(method==='one_member_one_vote'&&(v.weight!==1||v.memberWeight!==1||v.tokenWeight!==0)||method==='dual_chamber'&&(v.memberWeight!==1||v.weight!==Math.max(1,v.tokenWeight))||!['one_member_one_vote','dual_chamber'].includes(method)&&(v.memberWeight!==0||v.weight!==v.tokenWeight))invalid();
 return v;
}
function detail(v,cid,pid,actor){return validateCommunityGovernanceProposalDetail({communityId:cid,viewerId:actor,proposal:{...v.proposal,tally:v.tally,myVote:v.myVote}},cid,pid).proposal;}
const fixedFields=['id','communityId','authorProfileId','kind','title','body','votingStrategy','governanceTokenId','governanceTokenSymbol','tokensPerVote','voteWeightCap','quorum','approvalThreshold','votingMethod','decisionScope','executionMode','snapshotPolicy','snapshotBlockNumber','quorumMemberBps','quorumTokenBps','approvalBps','linkedGuideProposalId','createdAt','governanceTokenRules'];
async function proof(p){const bytes=new TextEncoder().encode(JSON.stringify(Object.fromEntries(fixedFields.map(key=>[key,p[key]]))));return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
function context(v,cid,pid){
 bounded(v);if(v?.communityId!==cid||v.proposalId!==pid||!(v.viewerId===null||id(v.viewerId))||!hash(v.snapshot)||!Array.isArray(v.allowedActions)||v.allowedActions.some(a=>!Object.hasOwn(actions,a))||new Set(v.allowedActions).size!==v.allowedActions.length||['canVote','canManage','canExecute','legacySnapshot'].some(k=>typeof v[k]!=='boolean')||!number(v.eligibleMembers)||!number(v.eligibleTokenWeight)||!['membership','recent_verified_balance'].includes(v.sourceBasis)||!(v.unavailableReason===null||text(v.unavailableReason,4000)))invalid();
 const p=detail(v,cid,pid,v.viewerId);
 if(v.votingPower!==null)power(v.votingPower,p.votingMethod);
 if(v.sourceBasis!==(p.votingMethod==='one_member_one_vote'?'membership':'recent_verified_balance')||v.canVote&&(p.status!=='voting'||v.viewerId===null||!v.votingPower||v.votingPower.weight<1||v.unavailableReason!==null||v.legacySnapshot)||v.viewerId===null&&(v.canManage||v.canExecute||v.allowedActions.length)||v.allowedActions.some(a=>a==='execute'?!v.canExecute:!v.canManage)||v.canExecute!==v.allowedActions.includes('execute'))invalid();
 for(const a of v.allowedActions)if(a==='start_voting'&&p.status!=='discussion'||a==='close_voting'&&p.status!=='voting'||a==='execute'&&p.status!=='passed'||a==='cancel'&&!['discussion','voting'].includes(p.status)||a!=='cancel'&&v.unavailableReason!==null)invalid();
 return structuredClone(v);
}
function receiptAction(op){return op.kind==='vote'?'governance_vote_cast':'governance_'+op.payload.action;}
async function ack(v,cid,pid,actor,op){
 bounded(v);const p=detail(v,cid,pid,actor),r=v.receipt;
 if(!r||!uuid(r.auditId)||r.auditId!==op.payload.operationId||r.action!==receiptAction(op)||r.targetId!==pid||!date(r.confirmedAt)||typeof r.replayed!=='boolean'||!number(v.eligibleMembers)||!number(v.eligibleTokenWeight)||!Array.isArray(v.votes))invalid();
 if(await proof(p)!==op.proposalProof)invalid();
 const buckets=Object.fromEntries(['for','against','abstain','total'].map(c=>[c,{count:0,weight:0,memberWeight:0,tokenWeight:0}])),profiles=new Set();
 for(const vote of v.votes){
  if(vote?.proposalId!==pid||!id(vote.profileId)||profiles.has(vote.profileId)||!Object.hasOwn(choices,vote.choice)||!date(vote.createdAt)||!date(vote.updatedAt)||Date.parse(vote.updatedAt)<Date.parse(vote.createdAt)||vote.weight<1)invalid();
  power(vote,p.votingMethod);profiles.add(vote.profileId);
  for(const key of ['count','weight','memberWeight','tokenWeight']){const n=key==='count'?1:vote[key];for(const choice of [vote.choice,'total']){buckets[choice][key]+=n;if(!number(buckets[choice][key]))invalid();}}
 }
 for(const choice of Object.keys(buckets))for(const key of Object.keys(buckets[choice]))if(buckets[choice][key]!==v.tally[choice][key])invalid();
 const own=v.votes.find(vote=>vote.profileId===actor);
 if(own?(!v.myVote||['choice','weight','memberWeight','tokenWeight','createdAt','updatedAt'].some(key=>own[key]!==v.myVote[key])):v.myVote!==null)invalid();
 return {proposal:p,receipt:structuredClone(r),eligibleMembers:v.eligibleMembers,eligibleTokenWeight:v.eligibleTokenWeight};
}

export function communityGovernanceMutations(target,{communityId,proposalId},{invoke,state:storage={},prepared,isCurrent=()=>true,onChanged,onOpen=()=>{},connectAccount,friendlyError=e=>String(e?.message??e)}={}){
 const document=target.ownerDocument??target,root=node(document,'section','','detail-form community-governance-native'),entries=storage.governance??={},key=JSON.stringify([communityId,'mutations',proposalId]),s=entries[key]??={},validScope=id(communityId)&&id(proposalId)&&typeof invoke==='function';let active=true,ready=Promise.resolve();
 const retained=()=>entries[key]===s&&!s.invalidated;
 const current=()=>{try{return isCurrent()!==false;}catch{return false;}};
 const live=()=>active&&retained()&&current(),sync=()=>s.sync?.();
 const message=e=>String(friendlyError(e)).replace(/^community_governance_mutation_rejected:(?:400|401|403|404|409|413):/,'');
 const known=e=>/community_governance_mutation_rejected:(?:400|401|403|404|409|413):|desktop_not_connected/.test(String(e?.message??e));
 const denied=e=>/desktop_not_connected|接続が変わりました|権限がありません|見つかりませんでした|このアカウントは停止|ハブが (?:401|403|404) を返しています|community_governance_mutation_rejected:(?:401|403|404):/.test(String(e?.message??e));
 const fresh=()=>Boolean(s.data&&!s.stale&&!s.loading&&!s.sending&&!s.preparing&&s.data.viewerId===s.actor);
 const canClose=()=>Boolean(s.rejected&&fresh());
 const allowed=(kind,value)=>Boolean(s.data&&s.data.viewerId!==null&&(kind==='vote'?s.data.canVote:s.data.allowedActions.includes(value)));
 function button(label,fn){const b=node(document,'button',label,'head-action');b.type='button';b.onclick=()=>{if(live())return fn();};return b;}
 function clearReader(){delete s.data;s.readToken={};s.loading=false;s.stale=true;if(s.operation){delete s.operation.proposal;delete s.operation.power;}if(s.saved)delete s.saved.proposal;sync();}
 function render(){
  if(!live())return;root.replaceChildren(); root.setAttribute('aria-label','投票と提案の進行'); root.classList.add('community-governance-mutations');
  const status=node(document,'p',s.error||s.notice||'','meta');status.setAttribute('role','status');if(s.error)status.classList.add('warning');root.append(status);
  if(s.loading)root.append(node(document,'p','最新の操作条件を読み込み中…','meta'));
  if(s.data){const d=s.data;root.append(node(document,'p',`${d.proposal.title} · ${statuses[d.proposal.status]}`),node(document,'p',`開始時の資格: ${d.eligibleMembers}人 · トークン票 ${d.eligibleTokenWeight}`,'meta'));
   root.append(node(document,'p',d.sourceBasis==='membership'?'投票開始時のメンバー資格を固定して使用します。':'投票開始時に直近15分以内の検証済み残高観測を固定します。現在のオンチェーン残高ではありません。','meta'));
   if(d.votingPower)root.append(node(document,'p',`自分の固定投票力: ${d.votingPower.weight} · メンバー票 ${d.votingPower.memberWeight} · トークン票 ${d.votingPower.tokenWeight}`,'meta'));
   if(d.myVote)root.append(node(document,'p',`現在の自分の投票: ${choices[d.myVote.choice]}`,'meta'));
   if(d.unavailableReason)root.append(node(document,'p',d.unavailableReason,'warning'));
   if(s.stale)root.append(node(document,'p','以前の読取結果です。現在の操作条件を再確認してください。','meta'));
  }
  if(s.saved){root.append(node(document,'p','操作は保存済みです。同じ操作を再送しません。','meta'));if(s.saved.proposal)root.append(node(document,'p',`保存結果の状態: ${statuses[s.saved.proposal.status]}`,'meta'));root.append(node(document,'p','保存した操作は記録です。後の投票や状態変更を以前の内容に戻しません。','meta'));const next=button('別の投票・進行操作へ',()=>{if(!fresh()||!s.saved)return;delete s.saved;delete s.operation;delete s.attempted;delete s.rejected;s.notice='';s.error='';sync();});next.disabled=!fresh();root.append(next);}
  else if(s.operation){
   const op=s.operation,preview=node(document,'section','','card detail-form community-governance-preview');preview.setAttribute('aria-label','DAO操作の全文確認');
   if(s.data&&!s.stale&&op.proposal){preview.append(node(document,'h4',op.proposal.title),node(document,'pre',op.proposal.body,'document-body'),node(document,'p',`${op.kind==='vote'?'投票': '進行操作'}: ${op.kind==='vote'?choices[op.payload.choice]:actions[op.payload.action]}`));if(op.kind==='vote')preview.append(node(document,'p',`固定投票力: ${op.power.weight} · メンバー票 ${op.power.memberWeight} · トークン票 ${op.power.tokenWeight}`,'meta'));else if(op.payload.action==='execute')preview.append(node(document,'p','実行済みという状態を記録します。外部の送金・契約・処分や自動執行は行いません。','meta'));else if(op.payload.action==='start_voting')preview.append(node(document,'p','開始時の資格と投票力を固定し、7日間の投票を開始します。','meta'));}
   else preview.append(node(document,'p','本文と操作条件を再確認してください。操作IDと確認済み送信内容は保持しています。','meta'));
   if(op.unknown)preview.append(node(document,'p','保存結果が不明です。同じ操作IDと確認済み内容だけで保存結果を確認します。','meta'));
   if(s.rejected)preview.append(node(document,'p','操作が拒否されました。以前の保存結果は確定できない場合があります。現在の状態を読んでから以前の操作を閉じられます。','meta'));
   const save=button(s.attempted?'同じ操作の保存結果を確認':op.kind==='vote'?'確認して投票を保存':'確認して進行操作を保存',saveOperation);save.disabled=!fresh()||s.rejected||!s.actor;preview.append(save);
   if(!s.attempted&&!s.sending)preview.append(button('確認を取り消す',()=>{delete s.operation;s.notice='';sync();}));
   if(canClose())preview.append(button('現在の提案を確認して以前の操作を閉じる',()=>{if(!canClose())return;delete s.operation;delete s.rejected;delete s.attempted;s.error='';s.notice='以前の操作を閉じました。再送していません。現在の投票と提案の状態は変更していません。';sync();}));root.append(preview);
  }else if(s.data){const controls=node(document,'div','','detail-form-row');
   if(s.data.canVote)for(const[value,label]of Object.entries(choices)){const b=button(label+'を確認',()=>prepare('vote',value));b.disabled=!fresh();controls.append(b);}
   for(const value of s.data.allowedActions){const b=button(actions[value]+'を確認',()=>prepare('lifecycle',value));b.disabled=!fresh();controls.append(b);}root.append(controls);
   if(s.data.viewerId===null)root.append(node(document,'p','投票や進行操作にはDesktopをHubへ接続してください。','meta'));
  }
  const read=button('投票・進行操作の条件を再読み込み',()=>load());read.disabled=Boolean(s.loading||s.sending);root.append(read);
  if((s.connect||s.data?.viewerId===null)&&connectAccount)root.append(button('Desktopを接続',connectAccount));
  root.append(button('提案の詳細へ戻る',()=>onOpen('community_governance_proposal',[communityId,proposalId],'DAO提案の詳細')));
 }
 function adopt(value){const next=context(value,communityId,proposalId);if(Object.hasOwn(s,'actor')&&next.viewerId!==s.actor){invalidate();return false;}s.actor=next.viewerId;s.data=next;s.stale=false;s.connect=false;return true;}
 function load(){if(!validScope||!live()||s.loading||s.sending)return ready;const token={};s.readToken=token;s.loading=true;s.error='';sync();return ready=(async()=>{try{const value=await invoke('hub_detail',{name:'community_governance_mutation_context',ids:[communityId,proposalId]});if(!live()||s.readToken!==token)return false;if(!adopt(value))return false;return true;}catch(e){if(live()&&s.readToken===token){s.error=message(e);s.stale=true;if(denied(e)){s.connect=String(e?.message??e).includes('desktop_not_connected');clearReader();}}return false;}finally{if(retained()&&s.readToken===token){s.loading=false;sync();}}})();}
 async function prepare(kind,value){if(!live()||s.operation||s.saved||s.loading||s.sending||s.preparing||!allowed(kind,value))return;const token={};s.prepareToken=token;s.preparing=true;try{const read=await load();if(!read||!live()||s.prepareToken!==token||s.stale||!allowed(kind,value))return;const proposal=structuredClone(s.data.proposal),proposalProof=await proof(proposal);if(!live()||s.prepareToken!==token||s.stale||!allowed(kind,value))return;const operationId=document.defaultView.crypto.randomUUID(),payload={operationId,snapshot:s.data.snapshot,[kind==='vote'?'choice':'action']:value};s.operation={kind,payload,proposal,proposalProof,power:structuredClone(s.data.votingPower),actor:s.actor};s.error='';s.notice='';}catch(e){if(live()&&s.prepareToken===token)s.error=message(e);}finally{if(retained()&&s.prepareToken===token){s.preparing=false;sync();}}}
 async function saveOperation(){
  if(!live()||!fresh()||s.rejected||!s.operation||!s.actor)return;const op=s.operation;
  if(!s.attempted&&(!allowed(op.kind,op.payload.choice??op.payload.action)||op.payload.snapshot!==s.data.snapshot)){s.error='操作条件が変更されています。読み直してから確認してください。';s.rejected=true;s.stale=true;sync();return;}
  if(!s.attempted&&op.kind==='vote'&&(Date.now()<Date.parse(op.proposal.votingStartsAt)||Date.now()>=Date.parse(op.proposal.votingEndsAt))){s.error='投票開始時刻または締切を過ぎています。現在の状態を再確認してください。';s.rejected=true;s.stale=true;sync();return;}
  s.sending=true;s.attempted=true;s.error='';const token={};s.postToken=token;sync();
  try{const value=await invoke('hub_client_action',{action:op.kind==='vote'?'community_governance_vote':'community_governance_lifecycle',target:communityId,text:proposalId,options:structuredClone(op.payload)});if(!retained()||s.postToken!==token||s.operation!==op||s.actor!==op.actor)return;if(active&&!current()){invalidate();return;}const result=await ack(value,communityId,proposalId,op.actor,op);if(!retained()||s.postToken!==token||s.operation!==op||s.actor!==op.actor)return;if(active&&!current()){invalidate();return;}s.saved=result;s.saved.operationId=op.payload.operationId;delete s.rejected;s.notice='投票・進行操作は保存済みです。';}
  catch(e){if(retained()&&s.postToken===token&&s.operation===op&&s.actor===op.actor){op.unknown ||= !known(e);s.error=message(e);if(known(e)){s.rejected=true;s.stale=true;}if(denied(e)){s.connect=String(e?.message??e).includes('desktop_not_connected');clearReader();}}}
  finally{if(retained()&&s.postToken===token){s.sending=false;if(s.saved)s.stale=true;sync();if(s.saved)await s.afterSaved?.();}if(!active)document.defaultView.removeEventListener('hub-account-changed',invalidate);}
 }
 async function afterSaved(){if(!live())return;await load();if(live())onChanged?.();}
 function dispose(){if(!active)return;active=false;if(s.sync===render)delete s.sync;if(s.afterSaved===afterSaved)delete s.afterSaved;if(s.preparing){s.prepareToken={};s.preparing=false;}if(s.loading){s.readToken={};s.loading=false;s.stale=true;}root.querySelectorAll('button').forEach(b=>b.disabled=true);root.replaceChildren();if(!s.sending)document.defaultView.removeEventListener('hub-account-changed',invalidate);}
 function invalidate(){if(entries[key]===s){for(const name of Object.keys(s))delete s[name];s.invalidated=true;delete entries[key];}dispose();root.replaceChildren(node(document,'p','接続が変わりました。投票・進行操作を開き直してください。','meta'));document.defaultView.removeEventListener('hub-account-changed',invalidate);}
 document.defaultView.addEventListener('hub-account-changed',invalidate);s.sync=render;s.afterSaved=afterSaved;
 try{if(!id(communityId)||!id(proposalId)||typeof invoke!=='function')invalid();if(prepared!==undefined)adopt(prepared);}catch(e){s.error=message(e);clearReader();}
 render();if(prepared===undefined&&!s.loading&&!s.sending)load();
 return{root,get ready(){return ready;},dispose,invalidate,clearReader};
}
