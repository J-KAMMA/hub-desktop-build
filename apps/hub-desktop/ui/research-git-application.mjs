const fail=()=>{throw Error('Gitの反映結果を確認できません。');};
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:fail();
const id=value=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash=value=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/.test(value);
const oid=value=>typeof value==='string'&&(value.length===40||value.length===64)&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export const nativeGitBranchName=value=>typeof value==='string'&&value.trim().length>0&&value.length<=200&&new TextEncoder().encode(value).length<=200&&!/[\x00-\x20\x7f\\]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);
function bounded(value){try{if(new TextEncoder().encode(JSON.stringify(value)).length>65536)fail();}catch{fail();}}
export function parseNativeGitApplicationIdentity(value,projectId,proposalId){
 bounded(value);const row=record(value);
 if(!id(proposalId)||row.projectId!==projectId||row.proposalId!==proposalId||!hash(row.snapshot)||!hash(row.comparisonHash)||!oid(row.baseOid)||!oid(row.headOid)||row.baseOid.length!==row.headOid.length||row.baseOid===row.headOid)fail();
 return {projectId,proposalId,snapshot:row.snapshot,baseOid:row.baseOid,headOid:row.headOid,comparisonHash:row.comparisonHash};
}
export function parseNativeGitApplicationPlan(value,projectId,proposalId){
 const identity=parseNativeGitApplicationIdentity(value,projectId,proposalId),row=record(value);
 if(!Array.isArray(row.branches)||row.branches.length>100)fail();
 const branches=Array.from(row.branches,value=>{const branch=record(value);if(!nativeGitBranchName(branch.branch)||!oid(branch.oid)||branch.oid.length!==identity.headOid.length)fail();return {branch:branch.branch,oid:branch.oid};});
 if(new Set(branches.map(value=>value.branch)).size!==branches.length)fail();return {...identity,branches};
}
export function parseNativeGitApplicationResult(value,expected,branch,readOnly=false){
 const identity=parseNativeGitApplicationIdentity(value,expected.projectId,expected.proposalId),row=record(value);
 if(Object.keys(identity).some(key=>identity[key]!==expected[key])||row.branch!==branch||!nativeGitBranchName(row.branch)||!oid(row.currentOid)||row.currentOid.length!==identity.headOid.length||!['already_included',readOnly?'not_included':'updated'].includes(row.outcome))fail();
 return {...identity,branch,currentOid:row.currentOid,outcome:row.outcome};
}
const node=(document,tag,value,className='')=>{const element=document.createElement(tag);element.className=className;if(value!==undefined)element.textContent=value;return element;};
/** Requests stay account-bound to the caller. The caller retains memory across remounts. */
export function researchGitApplication(target,{projectId,review},options={}){
 const document=target.ownerDocument,memory=options.memory??new Map(),proposalId=review?.proposal?.id,entry=memory.get(proposalId)??{};
 memory.set(proposalId,entry);entry.syncs??=new Set();const root=node(document,'section',undefined,'detail-form');root.setAttribute('aria-label','Gitブランチへの反映');
 Object.assign(root.style,{minWidth:'0',overflowWrap:'anywhere',display:'grid',gridTemplateColumns:'minmax(0,1fr)',justifyItems:'start',gap:'8px'});target.append(root);
 let active=true,revision=0;const cancellations=new Set();
 const scope=()=>JSON.stringify([review?.proposal?.id,review?.proposal?.projectId,review?.proposal?.baseOid,review?.proposal?.headOid,review?.proposal?.status,review?.canManage,review?.snapshot,review?.comparisonHash]);
 const initialScope=scope(),ownsMemory=()=>memory.get(proposalId)===entry;
 const current=()=>active&&ownsMemory()&&scope()===initialScope&&(!options.isCurrent||options.isCurrent());
 const owner=()=>id(proposalId)&&review?.proposal?.projectId===projectId&&review.canManage===true&&review.proposal.status==='approved'&&hash(review.snapshot)&&oid(review.proposal.baseOid)&&oid(review.proposal.headOid)&&review.proposal.baseOid.length===review.proposal.headOid.length&&review.proposal.baseOid!==review.proposal.headOid;
 const samePair=plan=>plan&&plan.projectId===projectId&&plan.proposalId===proposalId&&plan.baseOid===review.proposal.baseOid&&plan.headOid===review.proposal.headOid;
 const fresh=()=>samePair(entry.plan)&&entry.plan.snapshot===review.snapshot&&entry.plan.comparisonHash===review.comparisonHash;
 const notice=(value,alert=false)=>{const element=node(document,'p',value,'meta');element.setAttribute('role',alert?'alert':'status');return element;};
 const button=(label,run,disabled=false)=>{const element=node(document,'button',label,'head-action');element.type='button';element.disabled=!!disabled;element.onclick=()=>{if(current()&&!element.disabled)void run();};return element;};
 const sync=()=>{for(const render of entry.syncs)render();};
 async function request(args){let timer,cancel;try{return await Promise.race([Promise.resolve().then(()=>{if(!current())throw Error('接続が変わりました。');return options.invoke('hub_client_action',args);}),new Promise((_,reject)=>{cancel=()=>{clearTimeout(timer);reject(Error('画面を離れました。反映結果は同じブランチで確認してください。'));};cancellations.add(cancel);timer=setTimeout(()=>reject(Error('Gitの応答を確認できません。反映を再送せず、現在状態を確認してください。')),60000);})]);}finally{clearTimeout(timer);cancellations.delete(cancel);}}
 async function run(action){
  if(!current()||!owner()||entry.busy||action!=='check'&&entry.sent)return;
  if(action==='preview'&&(!review.comparison||!hash(review.comparisonHash)))return;
  if(action!=='preview'&&(!samePair(entry.plan)||!nativeGitBranchName(entry.branch)||!entry.plan.branches.some(value=>value.branch===entry.branch)))return;
  if(action==='apply'&&(!fresh()||!entry.confirm||entry.result||entry.plan.branches.find(value=>value.branch===entry.branch)?.oid!==entry.plan.baseOid))return;
  const token=++revision,pending=Symbol(),identity=action==='preview'?undefined:{...parseNativeGitApplicationIdentity(entry.plan,projectId,proposalId),snapshot:review.snapshot},branch=entry.branch;
  const body=action==='preview'?{proposalId,snapshot:review.snapshot}:{proposalId,snapshot:identity.snapshot,comparisonHash:identity.comparisonHash,branch,...(action==='apply'?{confirmed:true}:{})};
  entry.pending=pending;entry.busy=true;entry.error='';if(action==='apply'){entry.sent=true;entry.confirm=false;delete entry.result;}sync();
  try{
   const value=await request({action:`research_git_application_${action}`,target:projectId,options:body});
   if(!current()||token!==revision)return;
   if(action==='preview'){
    const plan=parseNativeGitApplicationPlan(value,projectId,proposalId);
    if(!samePair(plan)||plan.snapshot!==review.snapshot||plan.comparisonHash!==review.comparisonHash)fail();
    entry.plan=plan;entry.branch='';entry.confirm=false;delete entry.result;
   }else{
    const result=parseNativeGitApplicationResult(value,identity,branch,action==='check');
    entry.result=result;entry.sent=false;entry.confirm=false;
   }
  }catch(error){if(current()&&token===revision)entry.error=options.friendlyError?.(error)||error?.message||'Gitの結果を確認できません。';}
  finally{if(ownsMemory()&&entry.pending===pending){delete entry.pending;entry.busy=false;sync();}}
 }
 function render(){
  if(!current())return;
  const children=[node(document,'h5','ブランチへ反映'),node(document,'p','承認した変更を、選んだブランチへ反映します。先端が基準版と異なる場合は更新しません。')];
  if(entry.error)children.push(notice(entry.error,true));
  if(entry.sent)children.push(notice('反映結果は未確認です。反映を再送せず、同じブランチの現在状態を確認してください。'));
  if(entry.result)children.push(notice(`${entry.result.outcome==='not_included'?'確認時点では、この変更はブランチに含まれていません。再度反映先を確認してから操作してください。':'確認時点で、この変更はブランチに含まれています。'} ${entry.result.branch} · ${entry.result.currentOid}`));
  if(!entry.sent)children.push(button('反映先を確認',()=>run('preview'),entry.busy||!owner()||!review.comparison||!hash(review.comparisonHash)));
  if(entry.plan){
   const label=node(document,'label','反映先ブランチ'),select=node(document,'select');Object.assign(label.style,{width:'100%',minWidth:'0'});Object.assign(select.style,{width:'100%',minWidth:'0',maxWidth:'100%'});select.setAttribute('aria-label','反映先ブランチ');select.disabled=!!(entry.busy||entry.sent||!owner()||!samePair(entry.plan));
   const blank=node(document,'option','選択してください');blank.value='';select.append(blank);
   for(const branch of entry.plan.branches){const option=node(document,'option',branch.branch+(branch.oid===entry.plan.baseOid?'（基準版）':''));option.value=branch.branch;select.append(option);}
   select.value=entry.branch??'';select.onchange=()=>{if(current()&&!select.disabled){entry.branch=select.value;entry.confirm=false;render();}};label.append(select);children.push(label);
   const selected=entry.plan.branches.find(value=>value.branch===entry.branch),canApply=fresh()&&selected?.oid===entry.plan.baseOid&&!entry.sent&&!entry.result;
   if(selected)children.push(node(document,'p',`現在の先端 ${selected.oid}\n基準 ${entry.plan.baseOid} → 変更後 ${entry.plan.headOid}`,'meta'));
   if(entry.branch)children.push(button('このブランチの反映状態を確認',()=>run('check'),entry.busy||!owner()||!samePair(entry.plan)));
   if(canApply&&!entry.confirm)children.push(button('このブランチへ反映する',()=>{entry.confirm=true;render();},entry.busy||!owner()));
   if(canApply&&entry.confirm){const confirmation=node(document,'section',undefined,'detail-form');confirmation.setAttribute('aria-label','Git反映の確定確認');confirmation.append(node(document,'p',`${entry.branch} を上の基準版から変更後の版へ進めます。`),button('確認してGitへ反映',()=>run('apply'),entry.busy||!owner()),button('戻る',()=>{entry.confirm=false;render();},entry.busy));children.push(confirmation);}
   if(entry.branch&&!canApply&&!entry.sent)children.push(notice('先端や提案の状態が変わっている場合は、反映先を読み直してください。'));
   if(!entry.plan.branches.length)children.push(node(document,'p','反映先のブランチがありません。Gitで最初のブランチをpushしてください。'));
  }
  root.replaceChildren(...children);
 }
 entry.syncs.add(render);render();
 function dispose(){if(!active)return;active=false;++revision;entry.syncs.delete(render);if(cancellations.size&&ownsMemory()){delete entry.pending;entry.busy=false;sync();}for(const cancel of cancellations)cancel();cancellations.clear();for(const control of root.querySelectorAll('button,select')){control.onclick=null;control.onchange=null;}}
 function invalidate(){dispose();memory.clear();root.replaceChildren(notice('接続が変わりました。提案を読み直してください。'));}
 return {root,ready:Promise.resolve(),dispose,invalidate};
}
