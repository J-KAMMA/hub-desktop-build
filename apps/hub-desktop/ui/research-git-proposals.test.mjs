
import {createResearchGitChangePackage} from './research-git-change-package.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {researchGitBrowser} from './research-git-browser.mjs';
import {researchGitProposals,nativeGitProposal,nativeGitProposalPage,nativeGitProposalReview,nativeGitComparisonHash} from './research-git-proposals.mjs';
import {JSDOM} from 'jsdom';
const p='rp_'+'a'.repeat(32),a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40),id='00000000-0000-4000-8000-000000000001',date='2026-01-01T00:00:00.000Z';
const commit=oid=>({oid,parentOids:[],subject:'Change '+oid[0],committedAt:date}),comparison={projectId:p,commit:{...commit(b),message:'Change\n'},files:[{path:'a.ts',status:'M'}],diff:'<script>literal</script>\n-base\n+head',truncated:false,baseOid:a},hash=createHash('sha256').update(JSON.stringify(comparison)).digest('hex');
const proposal={id,projectId:p,baseOid:a,headOid:b,title:'My proposal',summary:'Private reason',status:'open',createdAt:date,resolvedAt:null,mine:true},review={proposal,canManage:true,canReview:true,snapshot:'c'.repeat(64),comparison,comparisonHash:hash},page={projectId:p,proposals:[proposal],nextCursor:null};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),button=(root,label)=>[...root.querySelectorAll('button')].find(v=>v.textContent===label);
function fixture({proposalId,prepared=proposalId?review:page,state={gitComparison:comparison},invoke,...rest}={}){const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),calls=[],opened=[];const options={state,prepared,openGitProposal:(...args)=>opened.push(args),invoke:async(name,args)=>{calls.push({name,args});if(invoke)return invoke(name,args);if(name==='hub_client_action')return {...proposal,id:args.requestId??id,status:args.action==='research_git_approve'?'approved':args.action==='research_git_reject'?'rejected':'open',resolvedAt:args.action==='research_git_propose'?null:date};return args.name==='research_git_proposal'?review:page;},...rest};const view=researchGitProposals(target,{projectId:p,proposalId},options);return {...view,dom,target,state,calls,opened,options};}
async function preview(v){for(const [label,value]of [['Git提案の題',proposal.title],['Git変更の理由',proposal.summary]]){const field=v.root.querySelector(`[aria-label="${label}"]`);field.value=value;field.dispatchEvent(new v.dom.window.Event('input'));}v.root.querySelector('form').dispatchEvent(new v.dom.window.Event('submit',{cancelable:true}));for(let tries=0;tries<100&&!button(v.root,'確認してGit提案を保存');tries++)await new Promise(resolve=>setTimeout(resolve,2));}
test('native parsers bind project, exact IDs/widths/timestamps and review roles and match the independent hash',async()=>{assert.equal(await nativeGitComparisonHash(comparison),hash);assert.deepEqual(nativeGitProposal({...proposal,author:'private'},p),proposal);assert.deepEqual(nativeGitProposalReview(review,p,id),review);for(const change of [{id:id+'\n'},{headOid:b+'\n'},{headOid:'b'.repeat(64)},{createdAt:'2026-02-30T00:00:00.000Z'},{summary:'\ud800'},{title:'x'.repeat(241)}])assert.throws(()=>nativeGitProposal({...proposal,...change},p));for(const change of [{canManage:false},{comparisonHash:hash+'\n'},{comparison:{...comparison,baseOid:c}},{comparisonError:'error'},{extra:'x'.repeat(524288)}])assert.throws(()=>nativeGitProposalReview({...review,...change},p,id));assert.throws(()=>nativeGitProposalPage({...page,proposals:[proposal,proposal]},p));});
test('native creation previews before the only explicit write and renders code literally',async()=>{const v=fixture();await v.ready;await preview(v);assert.equal(v.calls.length,0);const save=button(v.root,'確認してGit提案を保存');save.click();save.click();await tick();assert.equal(v.calls.length,1);assert.deepEqual(v.calls[0],{name:'hub_client_action',args:{action:'research_git_propose',target:p,requestId:v.state.gitProposals.creates.values().next().value.id,options:{baseOid:a,headOid:b,title:proposal.title,summary:proposal.summary,comparisonHash:hash}}});assert.equal(v.opened.length,1);v.dispose();v.dom.window.close();});
test('unknown creation preserves exact request through disposal and recovers without another operation ID',async()=>{let offline=true;const state={gitComparison:comparison};const v=fixture({state,invoke:async()=>{if(offline)throw Error('offline');return {...proposal,id:state.gitProposals.creates.values().next().value.id};}});await preview(v);button(v.root,'確認してGit提案を保存').click();await tick();const first=v.calls[0].args;v.dispose();v.dom.window.close();offline=false;const next=fixture({state,invoke:async()=>({...proposal,id:first.requestId})});button(next.root,'同じ提案の保存を確認').click();await tick();assert.deepEqual(next.calls[0].args,first);assert.equal(next.opened.length,1);next.dispose();next.dom.window.close();});
test('mismatched saved content is never acknowledged and result can be read by its original ID',async()=>{const v=fixture({invoke:async(name,args)=>name==='hub_client_action'?{...proposal,id:args.requestId,headOid:c}:{...review,proposal:{...proposal,id:args.ids[1]}}});await preview(v);button(v.root,'確認してGit提案を保存').click();await tick();assert.equal(v.opened.length,0);button(v.root,'このIDの保存結果を読む').click();await tick();assert.equal(v.calls.filter(v=>v.name==='hub_client_action').length,1);assert.equal(v.opened.length,1);v.dispose();v.dom.window.close();});
test('account invalidation discards drafts and ignores a late save acknowledgement',async()=>{let finish;const v=fixture({invoke:()=>new Promise(resolve=>{finish=resolve;})});await preview(v);button(v.root,'確認してGit提案を保存').click();await tick();v.invalidate();finish({...proposal,id:v.calls[0].args.requestId});await tick();assert.equal(v.state.gitProposals,undefined);assert.equal(v.state.gitComparison,undefined);assert.equal(v.opened.length,0);v.dom.window.close();});
test('only current owner can prepare decisions; approved means unapplied and requires a separate confirmation',async()=>{const v=fixture({proposalId:id});assert.equal(v.root.querySelector('script'),null);assert.equal(v.root.querySelector('pre').textContent,comparison.diff);button(v.root,'レビューを承認').click();assert.equal(v.calls.length,0);const save=button(v.root,'確認してレビューを確定');save.click();save.click();await tick();assert.equal(v.calls.filter(v=>v.name==='hub_client_action').length,1);assert.deepEqual(v.calls[0].args,{action:'research_git_approve',target:p,options:{proposalId:id,snapshot:review.snapshot,comparisonHash:hash,fullReviewConfirmed:false}});v.dispose();v.dom.window.close();const author=fixture({proposalId:id,prepared:{...review,canManage:false,canReview:false}});assert.equal(button(author.root,'レビューを承認'),undefined);author.dispose();author.dom.window.close();});
test('truncated comparison requires full review and decision retry is disabled after failed role reads',async()=>{let denied=false;const v=fixture({proposalId:id,prepared:{...review,comparison:{...comparison,truncated:true}},invoke:async(name)=>{if(name==='hub_client_action'){denied=true;throw Error('offline');}throw Error('permission lost');}});assert.equal(button(v.root,'レビューを承認').disabled,true);const checkbox=v.root.querySelector('[type="checkbox"]');checkbox.checked=true;checkbox.dispatchEvent(new v.dom.window.Event('change'));button(v.root,'レビューを承認').click();button(v.root,'確認してレビューを確定').click();await tick();assert.equal(denied,true);button(v.root,'この提案の現在状態を読む').click();await tick();assert.equal(button(v.root,'同じレビューの結果を確認').disabled,true);const before=v.calls.length;button(v.root,'同じレビューの結果を確認').click();assert.equal(v.calls.length,before);v.dispose();v.dom.window.close();});
test('paging stays typed, errors clear prior private content and distinct projects do not share drafts',async()=>{const cursor=JSON.stringify({createdAt:date,id}),v=fixture({prepared:{...page,nextCursor:cursor},invoke:async()=>({...page,proposals:[]})});button(v.root,'次の50件').click();await tick();assert.deepEqual(v.calls[0].args,{name:'research_git_proposals_page',ids:[p,cursor]});assert.equal(v.root.textContent.includes(proposal.summary),false);const old=v.state.gitProposals;v.dispose();const view=researchGitProposals(v.target,{projectId:'rp_'+'d'.repeat(32)},{state:v.state,prepared:{projectId:'rp_'+'d'.repeat(32),proposals:[],nextCursor:null}});assert.notEqual(v.state.gitProposals,old);view.dispose();v.dom.window.close();});
test('native comparison sends both IDs, rejects a foreign baseline, shares a correct fixed URL and proposes the displayed pair',async()=>{const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),calls=[],opened=[],state={};const v=researchGitBrowser(target,{projectId:p,oid:b,base:a},{state,prepared:comparison,signedIn:true,invoke:async(name,args)=>{calls.push(args);return {projectId:p,commits:[commit(a),commit(b)]};},openGitProposals:(...args)=>opened.push(args)});await v.ready;assert.equal(v.root.querySelector('script'),null);assert.equal(v.root.querySelector('[href*="base="]').getAttribute('href'),`/v2/research/${p}?commit=${b}&base=${a}#git`);button(v.root,'比較した二版をGit提案にする').click();assert.deepEqual(opened,[[p,comparison]]);v.dispose();const wrong=researchGitBrowser(target,{projectId:p,oid:b,base:c},{prepared:comparison,invoke:async()=>assert.fail('bad prepared should require explicit recovery')});await wrong.ready;assert.equal(wrong.root.querySelector('pre'),null);wrong.dispose();dom.window.close();});
test('changing baseline during an in-flight comparison rejects the old response and invalidates on access loss',async()=>{const dom=new JSDOM('<main></main>'),target=dom.window.document.querySelector('main'),requests=[];let old;const v=researchGitBrowser(target,{projectId:p,oid:b,base:a},{publicRepository:true,prepared:comparison,invoke:async(name,args)=>{requests.push(args);if(args.name==='research_git_history')return {projectId:p,commits:[]};if(args.ids[2]===a)return new Promise(resolve=>{old=resolve;});return {...comparison,baseOid:c,diff:'new baseline'};}});await v.ready;button(v.root,'このコミットを再読み込み').click();await tick();const input=v.root.querySelector('[aria-label="比較の基準コミット"]');input.value=c;input.closest('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await tick();assert.ok(requests.some(v=>v.name==='research_git_compare'&&v.ids[2]===c));old({...comparison,diff:'STALE'});await tick();assert.equal(v.root.textContent.includes('STALE'),false);assert.equal(v.root.textContent.includes('new baseline'),true);v.invalidate();assert.equal(v.root.querySelector('pre'),null);dom.window.close();});
test('actual native routing accepts only exact comparison/proposal URLs',()=>{const source=readFileSync(new URL('./app.js',import.meta.url),'utf8'),start=source.indexOf('function detailForHubPath(path) {'),end=source.indexOf('\n}',start)+2,detail=new Function(`return (${source.slice(start,end)});`)();assert.deepEqual(detail(`/v2/research/${p}?commit=${b}&base=${a}#git`),{name:'research_git_compare',ids:[p,b,a],title:'Gitの二版比較'});assert.deepEqual(detail(`/v2/research/${p}?gitProposal=${id}#git`),{name:'research_git_proposal',ids:[p,id],title:'Git提案のレビュー'});for(const path of [`/v2/research/${p}?commit=${b}&base=${'a'.repeat(64)}#git`,`/v2/research/${p}?gitProposal=${id}&other=a#git`,`https://evil.invalid/v2/research/${p}?gitProposal=${id}#git`,`/v2/research/${p}?gitProposal=${id}#git\n`])assert.equal(detail(path),null);});

test('approved owner prepares application within Native without opening Web or eager writes',async()=>{const opened=[],approved={...review,proposal:{...proposal,status:'approved',resolvedAt:date},canReview:false},v=fixture({proposalId:id,prepared:approved,openWeb:path=>opened.push(path)});await v.ready;assert.equal(v.root.textContent.includes('Gitへ未反映'),false);assert.ok(button(v.root,'反映先を確認'));assert.equal([...v.root.querySelectorAll('a')].some(n=>n.textContent==='Webで反映先を確認'),false);assert.deepEqual(v.calls,[]);assert.deepEqual(opened,[]);v.invalidate();assert.equal(v.root.querySelector('a'),null);v.dom.window.close();const denied=fixture({proposalId:id,prepared:{...approved,canManage:false}});await denied.ready;assert.equal(button(denied.root,'反映先を確認'),undefined);denied.dispose();denied.dom.window.close();});

const approvedReview={...review,proposal:{...proposal,status:'approved',resolvedAt:date},canReview:false};
const applicationPlan={projectId:p,proposalId:id,snapshot:review.snapshot,comparisonHash:hash,baseOid:a,headOid:b,branches:[{branch:'main',oid:a}]};
async function selectApplication(v){button(v.root,'反映先を確認').click();await tick();const select=v.root.querySelector('[aria-label="反映先ブランチ"]');select.value='main';select.dispatchEvent(new v.dom.window.Event('change'));button(v.root,'このブランチへ反映する').click();}
test('parent navigation and reload preserve unknown application and recover only through fixed check',async()=>{const state={};const v=fixture({proposalId:id,prepared:approvedReview,state,invoke:async(name,args)=>{if(name==='hub_detail')return approvedReview;if(args.action==='research_git_application_preview')return applicationPlan;throw Error('response lost');}});await selectApplication(v);button(v.root,'確認してGitへ反映').click();await tick();assert.ok(v.root.textContent.includes('反映結果は未確認'));button(v.root,'この提案の現在状態を読む').click();await tick();assert.equal(button(v.root,'反映先を確認'),undefined);v.dispose();v.dom.window.close();const next=fixture({proposalId:id,prepared:approvedReview,state,invoke:async(name,args)=>{assert.equal(name,'hub_client_action');assert.equal(args.action,'research_git_application_check');return {...applicationPlan,branch:'main',currentOid:b,outcome:'already_included'};}});assert.equal(next.calls.length,0);assert.equal(button(next.root,'確認してGitへ反映'),undefined);button(next.root,'このブランチの反映状態を確認').click();await tick();assert.equal(next.calls.length,1);assert.ok(next.root.textContent.includes('確認時点で、この変更はブランチに含まれています'));next.dispose();next.dom.window.close();});
test('parent permission refresh suppresses late application acknowledgement and account invalidation drops state',async()=>{let finish,denied=false;const v=fixture({proposalId:id,prepared:approvedReview,invoke:async(name,args)=>{if(name==='hub_detail')return {...approvedReview,canManage:!denied};if(args.action==='research_git_application_preview')return applicationPlan;return new Promise(resolve=>{finish=resolve;});}});await selectApplication(v);button(v.root,'確認してGitへ反映').click();await tick();denied=true;button(v.root,'この提案の現在状態を読む').click();await tick();finish({...applicationPlan,branch:'main',currentOid:b,outcome:'updated'});await tick();assert.equal(button(v.root,'このブランチの反映状態を確認'),undefined);assert.equal(v.state.gitProposals.applications.get(id).sent,true);assert.equal(v.state.gitProposals.applications.get(id).result,undefined);v.invalidate();assert.equal(v.state.gitProposals,undefined);v.dom.window.close();});

const receiverComparison={...comparison,diff:'Receiver independent diff'};
async function receivePacket(v){
 const packet=await createResearchGitChangePackage({protocol:'hub.research-git-change.v1',target:{origin:'https://receiver.example',projectId:p},baseOid:a,headOid:b,title:proposal.title,summary:proposal.summary});
 const bytes=new TextEncoder().encode(JSON.stringify(packet)),input=v.root.querySelector('[aria-label="受信した変更ファイル"]');
 Object.defineProperty(input,'files',{configurable:true,value:[{size:bytes.length,arrayBuffer:async()=>bytes.buffer}]});
 input.dispatchEvent(new v.dom.window.Event('change'));
 for(let i=0;i<100&&!button(v.root,'提案フォームへ取り込む');i++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.ok(button(v.root,'提案フォームへ取り込む'));return packet;
}
const receiverInvoke=(v,name,args)=>name==='hub_origin'?'https://receiver.example':name==='hub_detail'?receiverComparison:{...proposal,id:args.requestId};
test('parent imports only a confirmed receiver comparison, uses local operation ID/hash, then separately saves',async()=>{
 const v=fixture({state:{},invoke:async(name,args)=>receiverInvoke(v,name,args)});
 await receivePacket(v);assert.deepEqual(v.calls,[]);assert.equal(v.state.gitComparison,undefined);
 button(v.root,'提案フォームへ取り込む').click();await tick();
 assert.deepEqual(v.calls.map(c=>c.name),['hub_origin','hub_detail']);
 assert.deepEqual(v.calls[1].args,{name:'research_git_compare',ids:[p,b,a]});
 const entry=v.state.gitProposals.creates.values().next().value;
 assert.notEqual(entry.id,id);assert.equal(entry.title,proposal.title);assert.equal(entry.summary,proposal.summary);assert.equal(entry.open,true);
 assert.equal(v.root.querySelector('[aria-label="Git提案の題"]').value,proposal.title);
 v.root.querySelector('form').dispatchEvent(new v.dom.window.Event('submit',{cancelable:true}));
 for(let i=0;i<100&&!button(v.root,'確認してGit提案を保存');i++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(v.calls.length,2);assert.equal(entry.body.comparisonHash,createHash('sha256').update(JSON.stringify(receiverComparison)).digest('hex'));assert.notEqual(entry.body.comparisonHash,hash);
 button(v.root,'確認してGit提案を保存').click();await tick();
 assert.equal(v.calls.filter(c=>c.name==='hub_client_action').length,1);assert.equal(v.calls[2].args.requestId,entry.id);
 assert.deepEqual(Object.keys(v.calls[2].args.options).sort(),['baseOid','comparisonHash','headOid','summary','title']);v.dispose();v.dom.window.close();
});
test('parent import preserves an existing different draft and its operation ID',async()=>{
 const v=fixture({invoke:async(name,args)=>receiverInvoke(v,name,args)}),field=v.root.querySelector('[aria-label="Git提案の題"]');field.value='Existing private input';field.dispatchEvent(new v.dom.window.Event('input'));
 const entry=v.state.gitProposals.creates.values().next().value,operation=entry.id;await receivePacket(v);button(v.root,'提案フォームへ取り込む').click();await tick();
 assert.equal(entry.id,operation);assert.equal(entry.title,'Existing private input');assert.equal(entry.summary,'');assert.ok(v.root.textContent.includes('既存の下書きや保存中の操作を保護'));assert.equal(v.root.querySelector('[aria-label="Git提案の題"]').value,'Existing private input');assert.equal(v.calls.some(c=>c.name==='hub_client_action'),false);v.dispose();v.dom.window.close();
});
test('parent import cannot overwrite an unknown saved proposal or regenerate its ID',async()=>{
 const v=fixture({invoke:async(name,args)=>{if(name==='hub_client_action')throw Error('lost');return receiverInvoke(v,name,args);}});await preview(v);button(v.root,'確認してGit提案を保存').click();await tick();const entry=v.state.gitProposals.creates.values().next().value,body=entry.body,operation=entry.id;
 await receivePacket(v);button(v.root,'提案フォームへ取り込む').click();await tick();assert.equal(entry.sent,true);assert.equal(entry.body,body);assert.equal(entry.id,operation);assert.equal(v.calls.filter(c=>c.name==='hub_client_action').length,1);assert.ok(v.root.textContent.includes('既存の下書きや保存中の操作を保護'));v.dispose();v.dom.window.close();
});
test('parent account invalidation suppresses a late receiver comparison and private draft',async()=>{
 let finish;const v=fixture({state:{},invoke:async(name)=>name==='hub_origin'?'https://receiver.example':new Promise(resolve=>{finish=resolve;})});await receivePacket(v);button(v.root,'提案フォームへ取り込む').click();await tick();v.invalidate();finish(receiverComparison);await tick();assert.equal(v.state.gitProposals,undefined);assert.equal(v.state.gitComparison,undefined);assert.equal(v.root.querySelector('input'),null);v.dom.window.close();
});

test('parent opens export lazily and preserves destination while the details toggle settles',async()=>{
 const v=fixture({proposalId:id});assert.equal(v.root.querySelector('[aria-label="受信先プロジェクトのURL"]'),null);assert.deepEqual(v.calls,[]);
 const outer=[...v.root.querySelectorAll('details')].find(e=>e.querySelector('summary')?.textContent==='この提案内容を別のHubへ渡す');assert.ok(outer);outer.open=true;outer.dispatchEvent(new v.dom.window.Event('toggle'));
 const destination=v.root.querySelector('[aria-label="受信先プロジェクトのURL"]');assert.ok(destination);destination.value='https://receiver.example/v2/research/'+p;destination.dispatchEvent(new v.dom.window.Event('input'));
 outer.dispatchEvent(new v.dom.window.Event('toggle'));await tick();assert.equal(v.root.querySelector('[aria-label="受信先プロジェクトのURL"]'),destination);assert.equal(destination.value,'https://receiver.example/v2/research/'+p);
 assert.equal(v.root.querySelector('[aria-label="持ち出す提案の題"]').value,proposal.title);button(v.root,'持ち出す内容を確認').click();for(let i=0;i<100&&!button(v.root,'確認してファイルを準備');i++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(button(v.root,'確認してファイルを準備'));assert.deepEqual(v.calls,[]);v.dispose();v.dom.window.close();
});


test('unknown sent proposal rejects valid GET content mismatches and retains its frozen confirmation until exact recovery',async()=>{
 for(const mismatch of [{title:'Different title'},{summary:'Different summary'},{baseOid:c},{headOid:c},{baseOid:'d'.repeat(64),headOid:'e'.repeat(64)}]){
  let different=true;
  const v=fixture({invoke:async(name,args)=>{
   if(name==='hub_client_action')throw Error('response lost');
   const recovered={proposal:{...proposal,id:args.ids[1],...(different?mismatch:{})},canManage:true,canReview:true,snapshot:review.snapshot};
   assert.doesNotThrow(()=>nativeGitProposalReview(recovered,p,args.ids[1]));return recovered;
  }});
  await preview(v);const entry=v.state.gitProposals.creates.values().next().value,body=entry.body,operation=entry.id;
  button(v.root,'確認してGit提案を保存').click();await tick();assert.equal(entry.sent,true);assert.equal(Object.isFrozen(body),true);
  assert.throws(()=>{body.title='Edited after send';},TypeError);
  button(v.root,'このIDの保存結果を読む').click();await tick();
  assert.equal(entry.id,operation);assert.equal(entry.body,body);assert.equal(entry.sent,true);assert.equal(entry.result,undefined);
  assert.equal(v.opened.length,0);assert.ok(v.root.textContent.includes('保存結果は未確認'));assert.equal(button(v.root,'操作IDを保持して入力へ戻る').disabled,true);
  assert.deepEqual(v.calls.map(call=>call.name),['hub_client_action','hub_detail']);
  assert.deepEqual(v.calls[1].args,{name:'research_git_proposal',ids:[p,operation]});
  different=false;button(v.root,'このIDの保存結果を読む').click();await tick();await tick();
  assert.equal(entry.id,operation);assert.equal(entry.body,undefined);assert.equal(entry.sent,false);assert.equal(entry.result.title,body.title);
  assert.equal(v.opened.length,1);assert.deepEqual(v.calls.map(call=>call.name),['hub_client_action','hub_detail','hub_detail']);
  v.dispose();v.dom.window.close();
 }
});

test('unknown sent proposal blocks returning to input and stale input or preview events under the same ID',async()=>{
 const v=fixture({invoke:async()=>{throw Error('response lost');}});
 const staleTitle=v.root.querySelector('[aria-label="Git提案の題"]'),staleSummary=v.root.querySelector('[aria-label="Git変更の理由"]'),staleForm=staleTitle.closest('form');
 await preview(v);const entry=v.state.gitProposals.creates.values().next().value,body=entry.body,operation=entry.id;
 button(v.root,'確認してGit提案を保存').click();await tick();
 const back=button(v.root,'操作IDを保持して入力へ戻る');assert.equal(back.disabled,true);
 back.disabled=false;back.click();
 staleTitle.value='New unsent title';staleTitle.dispatchEvent(new v.dom.window.Event('input'));
 staleSummary.value='New unsent reason';staleSummary.dispatchEvent(new v.dom.window.Event('input'));
 staleForm.dispatchEvent(new v.dom.window.Event('submit',{cancelable:true}));await tick();await tick();
 assert.equal(entry.id,operation);assert.equal(entry.body,body);assert.equal(entry.sent,true);assert.equal(entry.title,proposal.title);assert.equal(entry.summary,proposal.summary);
 assert.equal(v.root.querySelector('[aria-label="Git提案の題"]'),null);assert.equal(v.opened.length,0);assert.equal(v.calls.length,1);
 assert.deepEqual(v.calls[0].args.options,{baseOid:a,headOid:b,title:proposal.title,summary:proposal.summary,comparisonHash:hash});
 v.dispose();v.dom.window.close();
});

test('unsent confirmation can return to input, keep its operation ID, and confirm an edited proposal before one explicit save',async()=>{
 const v=fixture({invoke:async(name,args)=>({...proposal,id:args.requestId,...args.options})});await preview(v);
 const entry=v.state.gitProposals.creates.values().next().value,operation=entry.id,first=entry.body,back=button(v.root,'操作IDを保持して入力へ戻る');
 assert.equal(back.disabled,false);back.click();assert.equal(entry.body,undefined);assert.equal(entry.id,operation);
 const title=v.root.querySelector('[aria-label="Git提案の題"]'),summary=v.root.querySelector('[aria-label="Git変更の理由"]');
 title.value='Edited proposal';title.dispatchEvent(new v.dom.window.Event('input'));summary.value='Edited reason';summary.dispatchEvent(new v.dom.window.Event('input'));
 title.closest('form').dispatchEvent(new v.dom.window.Event('submit',{cancelable:true}));
 for(let tries=0;tries<100&&!button(v.root,'確認してGit提案を保存');tries++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.notEqual(entry.body,first);assert.equal(entry.id,operation);assert.equal(entry.body.title,'Edited proposal');assert.equal(entry.body.summary,'Edited reason');assert.deepEqual(v.calls,[]);
 button(v.root,'確認してGit提案を保存').click();await tick();assert.equal(v.calls.length,1);assert.equal(v.calls[0].args.requestId,operation);assert.equal(v.opened.length,1);
 v.dispose();v.dom.window.close();
});
