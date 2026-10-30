const strategies={one_member_one_vote:'1メンバー1票',token_weighted:'トークン保有量比例',token_capped:'トークン保有量比例＋上限'};
const methods={one_member_one_vote:'1メンバー1票',one_holder_one_vote:'保有者1人1票',token_linear:'トークン保有量比例',token_sqrt:'トークン平方根加重',token_log:'トークン対数加重',dual_chamber:'複合投票（メンバー＋トークン）'};
const statuses={discussion:'議論中',voting:'投票中',passed:'可決',rejected:'否決',executed:'実行済み（記録）',cancelled:'中止'};
const kinds={guide:'共同ページの編集',channel:'チャンネル',rule:'コミュニティルール',moderator:'モデレーター'};
const scopes={community:'コミュニティの通常事項',budget:'予算・報奨金',token:'トークン固有事項',project:'プロジェクト優先順位',rules:'コミュニティ規約',moderation:'モデレーション（意向調査）',hub_policy:'Hub共通規約',security:'セキュリティ'};
const modes={advisory:'意向調査（拘束力なし）',operator:'運営実行型',timelock:'タイムロック後に実行',veto:'安全上の拒否権付き'};
const snapshots={proposal_start:'提案開始時',seven_day_prior:'7日前',time_weighted:'時間加重'};
const node=(d,tag,value='',cls='')=>{const n=d.createElement(tag);n.textContent=value;n.className=cls;return n;};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=100&&!/[^A-Za-z0-9_-]/.test(v);
const text=(v,max,min=0)=>typeof v==='string'&&v.length>=min&&v.length<=max&&!/[\ud800-\udfff]/u.test(v);
const dbText=(v,max,min=0)=>text(v,max*2)&&[...v].length>=min&&[...v].length<=max;
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&v.length===64&&!/[^a-f0-9]/.test(v);
const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=Number.MAX_SAFE_INTEGER;
const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER;
const date=v=>text(v,64,1)&&!/[\u0000-\u001f\u007f]/.test(v)&&Number.isFinite(Date.parse(v));
const offset=v=>Number.isSafeInteger(v)&&v>=0&&v<=Number.MAX_SAFE_INTEGER-20;
const invalid=()=>{throw Error('ガバナンスの情報を確認できませんでした。');};
const bounded=v=>{try{if(new TextEncoder().encode(JSON.stringify(v)).length>1024*1024)invalid();}catch{invalid();}};
const member=v=>v===null||id(v);
function community(v,cid){if(v?.id!==cid||!dbText(v.name,100,1)||!dbText(v.description,2000)||v.governanceMode!=='dao')invalid();return structuredClone(v);}
function rules(v){
 if(!Array.isArray(v)||v.length>100||v.some(r=>!id(r?.tokenId)||!positive(r.tokensPerVote)||!positive(r.weight)||r.weight>1000)||new Set(v.map(r=>r.tokenId)).size!==v.length)invalid();return structuredClone(v);
}

function createContext(v,cid){
 bounded(v);if(v?.communityId!==cid||!member(v.viewerId)||typeof v.canCreate!=='boolean'||v.canCreate&&v.viewerId===null||!Number.isSafeInteger(v.memberCount)||v.memberCount<0||!hash(v.snapshot))invalid();
 const s=v.settings;if(!s||!Object.hasOwn(strategies,s.votingStrategy)||!(s.governanceTokenId===null||id(s.governanceTokenId))||!positive(s.tokensPerVote)||s.voteWeightCap!==null&&(!Number.isSafeInteger(s.voteWeightCap)||s.voteWeightCap<1)||rules(s.tokenRules).some(r=>!dbText(r.tokenSymbol,16,1)))invalid();return structuredClone(v);
}
function guideSelectionPage(v,cid,requested,actor){
 bounded(v);if(!v||v.communityId!==undefined&&v.communityId!==cid||v.viewerId!==undefined&&v.viewerId!==actor||typeof v.canPropose!=='boolean'||!Array.isArray(v.proposals)||v.proposals.length>20||!offset(requested)||v.page?.offset!==requested||typeof v.page.hasMore!=='boolean'||v.page.nextOffset!==(v.page.hasMore?requested+20:null)||v.page.hasMore&&v.proposals.length!==20)invalid();
 const proposals=v.proposals.map(p=>{if(!id(p?.id)||!dbText(p.title,120,1)||p.communityId!==undefined&&p.communityId!==cid)invalid();return{id:p.id,title:p.title};});if(new Set(proposals.map(p=>p.id)).size!==proposals.length)invalid();return{proposals,page:structuredClone(v.page)};
}
function createPayload(d,snapshot,operationId){
 const title=d.title.trim(),body=d.body.trim(),linkedGuideProposalId=d.linkedGuideProposalId.trim()||null;
 if(!text(d.title,120)||!text(title,120,5)||!text(d.body,4000)||!text(body,4000,20)||!text(d.linkedGuideProposalId,100)||linkedGuideProposalId!==null&&!id(linkedGuideProposalId))invalid();
 for(const[key,allowed]of Object.entries({kind:kinds,votingMethod:methods,decisionScope:scopes,executionMode:modes,snapshotPolicy:snapshots}))if(!Object.hasOwn(allowed,d[key]))invalid();
 if(['hub_policy','security'].includes(d.decisionScope)||(d.kind==='moderator'||d.decisionScope==='moderation')&&(d.votingMethod!=='one_member_one_vote'||d.executionMode!=='advisory'))invalid();
 const bps=Object.fromEntries(['quorumMemberBps','quorumTokenBps','approvalBps'].map(k=>[k,Number(d[k])]));for(const[k,v]of Object.entries(bps))if(!String(d[k]).trim()||!Number.isSafeInteger(v)||v<(k==='approvalBps'?1:0)||v>10000)invalid();
 return{operationId,snapshot,kind:d.kind,title,body,linkedGuideProposalId,votingMethod:d.votingMethod,decisionScope:d.decisionScope,executionMode:d.executionMode,snapshotPolicy:d.snapshotPolicy,...bps};
}
function createAck(v,cid,actor,op){
 bounded(v);const p=proposal(v?.proposal,cid,true,false),r=v.receipt,pid='governance-'+op.payload.operationId;
 if(p.id!==pid||p.authorProfileId!==actor||!r||!uuid(r.auditId)||r.auditId!==op.payload.operationId||r.action!=='governance_proposal_created'||r.targetId!==pid||!date(r.confirmedAt)||typeof r.replayed!=='boolean')invalid();
 for(const k of ['kind','title','body','linkedGuideProposalId','votingMethod','decisionScope','executionMode','snapshotPolicy','quorumMemberBps','quorumTokenBps','approvalBps'])if(p[k]!==op.payload[k])invalid();
 const fixedRules=op.payload.votingMethod==='one_member_one_vote'?[]:op.context.settings.tokenRules,first=fixedRules[0];
 if(p.votingStrategy!==(op.payload.votingMethod==='one_member_one_vote'?'one_member_one_vote':'token_weighted')||p.governanceTokenId!==(first?.tokenId??null)||p.governanceTokenSymbol!==(first?.tokenSymbol??null)||p.tokensPerVote!==(first?.tokensPerVote??1)||p.voteWeightCap!==(op.context.settings.votingStrategy==='token_capped'?op.context.settings.voteWeightCap:null)||p.quorum!==Math.max(1,Math.ceil(op.context.memberCount/2))||p.approvalThreshold!==0.6||p.governanceTokenRules.length!==fixedRules.length||fixedRules.some((r,i)=>['tokenId','tokenSymbol','tokensPerVote','weight'].some(k=>p.governanceTokenRules[i][k]!==r[k])))invalid();
 return{proposal:p,receipt:structuredClone(r)};
}
export function communityGovernanceCreate(target,{communityId},{invoke,state:storage={},prepared,isCurrent=()=>true,onChanged,onOpen=()=>{},openWeb,connectAccount,friendlyError=e=>String(e?.message??e)}={}){
 const document=target.ownerDocument??target,root=node(document,'section','','detail-form community-governance-native'),entries=storage.governance??={},key=JSON.stringify([communityId,'create','']),s=entries[key]??={};let active=true,ready=Promise.resolve();
 const retained=()=>entries[key]===s&&!s.invalidated,live=()=>active&&retained()&&isCurrent(),sync=()=>s.sync?.();
 const denied=e=>/desktop_not_connected|接続が変わりました|権限がありません|見つかりませんでした|このアカウントは停止|ハブが (?:401|403|404) を返しています|community_governance_create_rejected:(?:401|403|404):/.test(String(e?.message??e));
 const errorText=e=>friendlyError(e).replace(/^community_governance_create_rejected:(?:400|401|403|404|409|413):/,'');
 const editable=()=>Boolean(s.data?.canCreate&&!s.stale&&!s.loading&&!s.sending&&!s.operation&&!s.saved);
 const closeable=()=>Boolean(s.rejected&&s.data?.canCreate&&s.data.viewerId===s.actor&&!s.stale&&!s.loading&&!s.sending);
 function button(label,fn){const b=node(document,'button',label,'head-action');b.type='button';b.onclick=()=>{if(live())return fn();};return b;}
 function stopGuides(){if(s.picker){s.picker.token={};s.picker.loading=false;}}
 function clearReader(){delete s.data;delete s.draft;stopGuides();delete s.picker;s.readToken={};s.loading=false;s.stale=true;if(s.saved)delete s.saved.proposal;sync();}
 function resetDraft(){s.draft={kind:'rule',title:'',body:'',linkedGuideProposalId:'',votingMethod:'one_member_one_vote',decisionScope:'community',executionMode:'operator',snapshotPolicy:'proposal_start',quorumMemberBps:'2000',quorumTokenBps:'0',approvalBps:'5001'};}
 function render(){
  if(!live())return;root.replaceChildren(node(document,'h3','内容と投票条件'));const notice=node(document,'p',s.error||s.notice||'','meta');notice.setAttribute('role','status');root.append(notice);
  root.append(node(document,'p','作成後は議論中になり、運営が投票を開始します。投票や提案の進行操作はWebで行います。','meta'));
  if(s.loading)root.append(node(document,'p','作成条件を読み込み中…','meta'));
  if(s.data&&s.stale)root.append(node(document,'p','以前の作成条件です。現在の条件を再確認してください。','meta'));
  if(s.saved){root.append(node(document,'p','DAO提案は作成済みです。同じ提案を再送しません。','meta'));if(s.saved.proposal)root.append(node(document,'p',`${s.saved.proposal.title} · ${statuses[s.saved.proposal.status]}`));const open=button('作成したDAO提案を読む',()=>onOpen('community_governance_proposal',[communityId,s.saved.proposalId],'DAO提案の詳細'));open.disabled=!s.data||Boolean(s.stale||s.loading);root.append(open);const next=button('別のDAO提案を作る',()=>{if(!s.data?.canCreate||s.stale||s.loading||s.sending)return;delete s.saved;delete s.operation;delete s.attempted;delete s.rejected;resetDraft();s.error='';s.notice='';sync();});next.disabled=!s.data?.canCreate||Boolean(s.stale||s.loading||s.sending);root.append(next);}
  else if(s.operation){const preview=node(document,'section','','card detail-form community-governance-preview');preview.setAttribute('aria-label','DAO提案の全文確認');const op=s.operation;
   if(s.data&&!s.stale){appendPreview(preview,op);}else preview.append(node(document,'p','作成条件を読み直してください。以前の操作IDと送信内容は保持しています。','meta'));
   if(op.unknown)preview.append(node(document,'p','作成結果が不明です。同じ操作IDと確認済み内容だけで結果を確認します。','meta'));
   if(s.rejected)preview.append(node(document,'p','この操作は受け付けられませんでした。以前の結果が不明な場合は、現在の作成条件を読んでから操作を閉じられます。','meta'));
   const save=button(s.attempted?'同じDAO提案の作成結果を確認':'確認してDAO提案を作成',saveOperation);save.disabled=!s.data?.canCreate||Boolean(s.stale||s.loading||s.sending||s.rejected);preview.append(save);
   if(!s.attempted&&!s.sending)preview.append(button('編集に戻る',()=>{delete s.operation;sync();}));
   if(closeable())preview.append(button('現在の作成条件を確認して操作を閉じる',()=>{if(!closeable())return;const draft=s.operation?.draft;delete s.operation;delete s.rejected;delete s.attempted;s.draft=draft??s.draft;if(!s.draft)resetDraft();s.notice='以前の操作を閉じました。再送していません。新しく全文確認してから作成してください。';s.error='';sync();}));root.append(preview);
  }else if(s.data){if(s.data.canCreate){s.draft??=null;if(!s.draft)resetDraft();renderForm();}else root.append(node(document,'p','DAO提案の作成には有効なコミュニティメンバー資格が必要です。','meta'));}
  const read=button('提案の作成条件を再読み込み',load);read.disabled=Boolean(s.loading||s.sending);root.append(read);
  if((s.connect||s.data?.viewerId===null)&&connectAccount)root.append(button('Desktopを接続',connectAccount));
  root.append(button('投票・提案を操作',()=>onOpen('community_governance_mutation_context',[communityId,proposalId],'投票と提案の進行')));root.append(button('DAO提案一覧へ戻る',()=>onOpen('community_governance',[communityId],'ガバナンス')));
  if(s.data&&openWeb)root.append(button('Webでガバナンスの操作を開く',()=>openWeb(`/v2/community?community=${encodeURIComponent(communityId)}&section=governance`)));
 }
 function renderForm(){
  const d=s.draft,form=node(document,'form','','detail-form');form.onsubmit=e=>{e.preventDefault();if(live())prepare();};
  const select=(key,label,values)=>{const n=node(document,'select');n.setAttribute('aria-label',label);for(const[value,caption]of Object.entries(values)){const option=node(document,'option',caption);option.value=value;n.append(option);}n.value=d[key];n.disabled=!editable()||(key==='votingMethod'||key==='executionMode')&&(d.kind==='moderator'||d.decisionScope==='moderation');n.onchange=()=>{if(!live()||!editable())return;d[key]=n.value;if(key==='kind'&&d.kind==='moderator')d.decisionScope='moderation';if(d.kind==='moderator'||d.decisionScope==='moderation'){d.votingMethod='one_member_one_vote';d.executionMode='advisory';d.quorumTokenBps='0';}if(key==='votingMethod')d.quorumTokenBps=d.votingMethod==='one_member_one_vote'?'0':'2000';if(key==='decisionScope')d.approvalBps=d.decisionScope==='rules'?'6667':'5001';sync();};const l=node(document,'label',label);l.append(n);form.append(l);};
  select('kind','提案の種類',kinds);select('decisionScope','決定する範囲',Object.fromEntries(Object.entries(scopes).filter(([k])=>!['hub_policy','security'].includes(k))));select('votingMethod','投票方式',methods);select('executionMode','可決後の効果',modes);select('snapshotPolicy','残高の参照方針',snapshots);
  form.append(node(document,'p','参照方針と可決後の効果は保存する設定です。7日前・時間加重の残高取得、タイムロック、自動実行や拒否権の執行を保証しません。BAN、投稿削除、違反認定、Hub共通規約、緊急セキュリティ対応はトークン多数決だけでは変更できません。','meta'));
  for(const[key,label,tag,max]of [['title','タイトル','input',120],['body','提案内容','textarea',4000],['quorumMemberBps','メンバー定足率（1万分率）','input',5],['quorumTokenBps','トークン定足率（1万分率）','input',5],['approvalBps','承認率（1万分率）','input',5]]){const input=node(document,tag);input.setAttribute('aria-label',label);input.value=d[key];input.maxLength=max;input.disabled=!editable();if(key.endsWith('Bps')){input.type='number';input.min=key==='approvalBps'?'1':'0';input.max='10000';input.step='1';}input.oninput=()=>{if(live()&&editable())d[key]=input.value;};const l=node(document,'label',label);l.append(input);form.append(l);}
  renderGuidePicker(form);form.append(button('共同ページの編集提案一覧を読む',()=>onOpen('community_guide_proposals',[communityId],'共同ページの編集提案')),button('DAO提案の全文を確認',prepare));root.append(form);
 }
 function renderGuidePicker(parent){const picker=s.picker,d=s.draft;parent.append(node(document,'p',`参照する編集提案: ${d.selectedGuide?.title??(d.linkedGuideProposalId?'選択済みの編集提案':'なし')}`,'meta'),button('編集提案を選ぶ',()=>{if(!editable())return;s.picker??={offset:0};s.picker.open=true;if(!s.picker.data)loadGuides(s.picker.offset);else sync();}));if(!picker?.open)return;
  const region=node(document,'section','','card detail-form');region.setAttribute('aria-label','参照する編集提案の選択');if(picker.loading)region.append(node(document,'p','編集提案を読み込み中…','meta'));if(picker.error){const error=node(document,'p',picker.error,'warning');error.setAttribute('role','status');region.append(error);}
  const select=node(document,'select');select.setAttribute('aria-label','参照する編集提案（任意）');const empty=node(document,'option','参照なし');empty.value='';select.append(empty);const choices=[...(picker.data?.proposals??[])];if(d.linkedGuideProposalId&&!choices.some(p=>p.id===d.linkedGuideProposalId))choices.unshift({id:d.linkedGuideProposalId,title:d.selectedGuide?.title??'選択済みの編集提案'});for(const p of choices){const option=node(document,'option',p.title);option.value=p.id;select.append(option);}select.value=d.linkedGuideProposalId;select.disabled=!editable()||Boolean(picker.loading);select.onchange=()=>{if(!live()||!editable()||picker.loading)return;const selected=choices.find(p=>p.id===select.value);if(select.value&&!selected)return;d.linkedGuideProposalId=selected?.id??'';d.selectedGuide=selected?structuredClone(selected):undefined;sync();};region.append(select);
  if(picker.data){const nav=node(document,'nav','','detail-form-row');nav.setAttribute('aria-label','編集提案のページ');const previous=button('前の編集提案20件',()=>loadGuides(picker.offset-20)),next=button('次の編集提案20件',()=>loadGuides(picker.data.page.nextOffset));previous.disabled=picker.offset<20||picker.loading||!editable();next.disabled=!picker.data.page.hasMore||!offset(picker.data.page.nextOffset)||picker.loading||!editable();nav.append(previous,next,node(document,'span',`${Math.floor(picker.offset/20)+1}ページ`,'meta'));region.append(nav);if(!picker.data.proposals.length)region.append(node(document,'p','編集提案はまだありません。','meta'));}
  const read=button('編集提案を再読み込み',()=>loadGuides(picker.failedOffset??picker.offset));read.disabled=picker.loading||!editable();region.append(read,button('選択を閉じる',()=>{picker.open=false;sync();}));parent.append(region);
 }
 async function loadGuides(requested){if(!live()||!editable()||!offset(requested))return;const picker=s.picker??={offset:0};if(picker.loading)return;const token={},actor=s.actor;picker.token=token;picker.loading=true;picker.error='';sync();try{const value=await invoke('hub_detail',{name:'community_guide_proposals_page',ids:[communityId,String(requested)]});if(!live()||s.picker!==picker||picker.token!==token||s.actor!==actor)return;picker.data=guideSelectionPage(value,communityId,requested,actor);picker.offset=requested;delete picker.failedOffset;}catch(e){if(live()&&s.picker===picker&&picker.token===token){picker.error=errorText(e);picker.failedOffset=requested;if(denied(e)){clearReader();s.error=errorText(e);s.connect=String(e).includes('desktop_not_connected');}}}finally{if(retained()&&s.picker===picker&&picker.token===token){picker.loading=false;sync();}}}
 function appendPreview(parent,op){const p=op.payload;parent.append(node(document,'h4',p.title),node(document,'pre',p.body,'community-governance-body'),node(document,'p',`${kinds[p.kind]} · ${scopes[p.decisionScope]} · ${methods[p.votingMethod]} · ${modes[p.executionMode]}`),node(document,'p',`残高の参照方針（設定）: ${snapshots[p.snapshotPolicy]}`),node(document,'p',`記録する基準（複合投票用）: メンバー定足率: ${p.quorumMemberBps}/10000 · トークン定足率: ${p.quorumTokenBps}/10000 · 承認率: ${p.approvalBps}/10000`),node(document,'p',`参照する編集提案: ${op.draft.selectedGuide?.title??(p.linkedGuideProposalId?'選択済みの編集提案':'なし')}`),node(document,'p',p.votingMethod==='dual_chamber'?`複合投票の基準 · メンバー参加率: ${p.quorumMemberBps/100}% · トークン参加率: ${p.quorumTokenBps/100}% · 賛成率: ${p.approvalBps/100}%`:`作成時の有効メンバー: ${op.context.memberCount}人 · 定足人数: ${Math.max(1,Math.ceil(op.context.memberCount/2))}人 · 賛否の有効票の60%以上が賛成`));
  if(p.votingMethod!=='one_member_one_vote')for(const r of op.context.settings.tokenRules)parent.append(node(document,'p',`固定するトークン: ${r.tokenSymbol} · ${r.tokensPerVote}枚につき${r.weight}点`));parent.append(node(document,'p',`票数上限: ${op.context.settings.voteWeightCap??'なし'}。作成後は議論中になります。投票は開始しません。`,'meta'));
 }
 function prepare(){if(!live()||!editable())return;try{const payload=createPayload(s.draft,s.data.snapshot,document.defaultView.crypto.randomUUID());if(payload.votingMethod!=='one_member_one_vote'&&!s.data.settings.tokenRules.length)invalid();s.operation={payload,draft:structuredClone(s.draft),context:structuredClone(s.data)};s.error='';s.notice='全文を確認してください。まだ作成していません。';sync();}catch{s.error='タイトル（5〜120文字）、提案内容（20〜4000文字）、参照する編集提案、投票方式と1万分率を確認してください。';sync();}}
 async function saveOperation(){
  const op=s.operation;if(!live()||!op||s.sending||s.loading||s.stale||s.rejected||s.saved||!s.data?.canCreate)return;s.sending=true;s.attempted=true;sync();
  try{const value=await invoke('hub_client_action',{action:'community_governance_create_proposal',target:communityId,options:structuredClone(op.payload)});if(!retained()||s.operation!==op)return;const result=createAck(value,communityId,s.actor,op);s.saved={...result,proposalId:result.proposal.id};delete s.operation;delete s.draft;delete s.rejected;s.stale=true;s.sending=false;s.notice='DAO提案は作成済みです。';sync();if(live()){try{await onChanged?.({communityId,proposalId:result.proposal.id,receipt:result.receipt});}catch(e){if(retained())s.error='作成済みです。画面を更新できませんでした: '+errorText(e);}if(live())await load();}}
  catch(e){if(!retained()||s.operation!==op)return;if(/接続が変わりました/.test(String(e))){invalidate();return;}s.error=errorText(e);const rejection=String(e?.message??e).match(/^community_governance_create_rejected:(400|401|403|404|409|413):/);s.rejected=rejection?Number(rejection[1]):String(e).includes('desktop_not_connected')?401:undefined;if(!s.rejected)op.unknown=true;s.stale=Boolean(s.rejected);if(denied(e)){clearReader();s.connect=String(e).includes('desktop_not_connected');}}
  finally{if(retained()){s.sending=false;sync();}if(!active)document.defaultView.removeEventListener('hub-account-changed',invalidate);}
 }
 function adopt(value){const data=createContext(value,communityId);if(Object.hasOwn(s,'actor')&&s.actor!==data.viewerId){invalidate();return;}s.actor=data.viewerId;s.data=data;s.stale=false;s.connect=false;}
 async function read(){if(!live()||s.loading||s.sending)return;stopGuides();const token={};s.readToken=token;s.loading=true;s.error='';sync();try{if(!id(communityId))invalid();const value=await invoke('hub_detail',{name:'community_governance_create_context',ids:[communityId]});if(retained()&&s.readToken===token)adopt(value);}catch(e){if(retained()&&s.readToken===token){s.error=(s.saved?'DAO提案は作成済みです。作成条件を読み直せませんでした: ':'')+errorText(e);s.stale=true;if(denied(e)){const message=s.error;clearReader();s.error=message;s.connect=String(e).includes('desktop_not_connected');sync();}}}finally{if(retained()&&s.readToken===token){s.loading=false;delete s.readToken;sync();}}}
 function load(){return ready=read();}
 function dispose(){if(!active)return;active=false;stopGuides();if(s.sync===render)delete s.sync;if(s.loading){s.readToken={};s.loading=false;s.stale=true;}root.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=true);root.replaceChildren();if(!s.sending)document.defaultView.removeEventListener('hub-account-changed',invalidate);}
 function invalidate(){for(const[k,value]of Object.entries(entries)){if(JSON.parse(k)[0]!==communityId)continue;const notify=value.sync;for(const name of Object.keys(value))delete value[name];value.invalidated=true;notify?.();delete entries[k];}const wasActive=active;dispose();if(wasActive)root.append(node(document,'p','接続が変わりました。DAO提案の作成画面を開き直してください。','meta'));document.defaultView.removeEventListener('hub-account-changed',invalidate);}
 document.defaultView.addEventListener('hub-account-changed',invalidate);s.sync=render;try{if(prepared!==undefined)adopt(prepared);}catch(e){s.error=errorText(e);clearReader();}render();if(prepared===undefined&&!s.loading&&!s.sending)load();return{root,get ready(){return ready;},dispose,invalidate,clearReader};
}
function settings(v){
 if(!v||!Object.hasOwn(strategies,v.votingStrategy)||!(v.governanceTokenId===null||id(v.governanceTokenId))||!positive(v.tokensPerVote))invalid();const tokenRules=rules(v.tokenRules);
 if(tokenRules.some(r=>!dbText(r.tokenSymbol,16,1))||(v.voteWeightCap!==null&&(!Number.isSafeInteger(v.voteWeightCap)||v.voteWeightCap<1)))invalid();
 if(v.votingStrategy==='one_member_one_vote'?(tokenRules.length!==0||v.voteWeightCap!==null||v.governanceTokenId!==null):(!tokenRules.length||v.votingStrategy==='token_weighted'&&v.voteWeightCap!==null||v.votingStrategy==='token_capped'&&v.voteWeightCap===null))invalid();return structuredClone(v);
}
function settingsPage(v,cid){
 bounded(v);community(v?.community,cid);if(!member(v.viewerId)||typeof v.canEdit!=='boolean'||v.canEdit&&v.viewerId===null||!hash(v.snapshot)||!Array.isArray(v.availableTokens)||v.availableTokens.length>100||v.availableTokens.some(t=>!id(t?.id)||!dbText(t.name,80,1)||!dbText(t.symbol,16,1))||new Set(v.availableTokens.map(t=>t.id)).size!==v.availableTokens.length)invalid();settings(v.settings);return structuredClone(v);
}
const canonical=s=>({votingStrategy:s.votingStrategy,tokenRules:s.tokenRules.map(({tokenId,tokensPerVote,weight})=>({tokenId,tokensPerVote,weight})).sort((a,b)=>a.tokenId.localeCompare(b.tokenId)),voteWeightCap:s.voteWeightCap});
function ack(v,cid,op){
 bounded(v);if(v?.communityId!==cid)invalid();const current=settings(v.settings),r=v.receipt;
 if(!r||!uuid(r.auditId)||r.auditId!==op.options.operationId||r.action!=='governance_settings_updated'||r.targetId!==cid||!date(r.confirmedAt)||typeof r.replayed!=='boolean')invalid();
 return{settings:current,receipt:structuredClone(r)};
}
function proposal(value,cid,detail=false,withVotes=true){
 if(!value||value.communityId!==cid||!id(value.id)||!id(value.authorProfileId)||!dbText(value.title,120,1)||detail&&!dbText(value.body,4000,1)||!detail&&Object.hasOwn(value,'body'))invalid();
 for(const[key,allowed]of Object.entries({kind:kinds,status:statuses,votingStrategy:strategies,votingMethod:methods,decisionScope:scopes,executionMode:modes,snapshotPolicy:snapshots}))if(!Object.hasOwn(allowed,value[key]))invalid();
 if(!positive(value.tokensPerVote)||value.voteWeightCap!==null&&(!Number.isSafeInteger(value.voteWeightCap)||value.voteWeightCap<1)||!Number.isSafeInteger(value.quorum)||value.quorum<0||!numeric(value.approvalThreshold)||value.approvalThreshold>1)invalid();
 for(const k of ['quorumMemberBps','quorumTokenBps','approvalBps'])if(!Number.isSafeInteger(value[k])||value[k]<(k==='approvalBps'?1:0)||value[k]>10000)invalid();
 for(const k of ['votingStartsAt','votingEndsAt','createdAt','updatedAt'])if(!date(value[k]))invalid();
 for(const k of ['snapshotCapturedAt','executedAt'])if(value[k]!==null&&!date(value[k]))invalid();
 for(const k of ['governanceTokenId','linkedGuideProposalId'])if(value[k]!==null&&!id(value[k]))invalid();
 if(value.governanceTokenSymbol!==null&&!dbText(value.governanceTokenSymbol,16,1)||value.snapshotBlockNumber!==null&&!dbText(value.snapshotBlockNumber,128))invalid();
 const tokenRules=rules(value.governanceTokenRules);if(tokenRules.some(r=>!dbText(r.tokenSymbol,16,1)))invalid();
 if(!withVotes)return structuredClone(value);
 if(!value.tally)invalid();for(const choice of ['for','against','abstain','total'])for(const k of ['count','weight','memberWeight','tokenWeight'])if(!Number.isSafeInteger(value.tally[choice]?.[k])||value.tally[choice][k]<0)invalid();
 for(const k of ['count','weight','memberWeight','tokenWeight']){const sum=['for','against','abstain'].reduce((n,choice)=>n+value.tally[choice][k],0);if(!Number.isSafeInteger(sum)||sum!==value.tally.total[k])invalid();}
 if(value.myVote!==null){const vote=value.myVote;if(!vote||!['for','against','abstain'].includes(vote.choice)||!date(vote.createdAt)||!date(vote.updatedAt)||['weight','memberWeight','tokenWeight'].some(k=>!Number.isSafeInteger(vote[k])||vote[k]<0))invalid();}
 return structuredClone(value);
}
function proposalPage(v,cid,requested){
 bounded(v);if(v?.communityId!==cid||!member(v.viewerId)||!Array.isArray(v.proposals)||v.proposals.length>20||v.page?.offset!==requested||!offset(requested)||typeof v.page.hasMore!=='boolean'||v.page.nextOffset!==(v.page.hasMore?requested+20:null)||v.page.hasMore&&v.proposals.length!==20)invalid();
 const proposals=v.proposals.map(p=>proposal(p,cid));if(new Set(proposals.map(p=>p.id)).size!==proposals.length||v.viewerId===null&&proposals.some(p=>p.myVote!==null))invalid();return structuredClone(v);
}
function proposalDetail(v,cid,pid){bounded(v);if(v?.communityId!==cid||!member(v.viewerId)||v.proposal?.id!==pid)invalid();const value=proposal(v.proposal,cid,true);if(v.viewerId===null&&value.myVote!==null)invalid();return structuredClone(v);}

export const validateCommunityGovernanceProposalDetail = proposalDetail;

export function communityGovernanceRequest(entry){
 if(entry.name==='community_governance'&&entry.governanceState?.governance?.[JSON.stringify([entry.ids[0],'catalog',''])]?.offset)return{name:'community_governance_page',ids:[entry.ids[0],String(entry.governanceState.governance[JSON.stringify([entry.ids[0],'catalog',''])].offset)]};
 return null;
}
export const communityGovernanceCatalog=(target,reference,options)=>view(target,reference,options,'catalog');
export const communityGovernanceProposal=(target,reference,options)=>view(target,reference,options,'proposal');
export const communityGovernanceSettings=(target,reference,options)=>view(target,reference,options,'settings');
function view(target,{communityId,proposalId=''},{invoke,state:storage={},prepared,isCurrent=()=>true,onChanged,onOpen=()=>{},openWeb,connectAccount,friendlyError=e=>String(e?.message??e)}={},mode){
 const document=target.ownerDocument??target,root=node(document,'section','','detail-form community-governance-native'),entries=storage.governance??={},key=JSON.stringify([communityId,mode,mode==='proposal'?proposalId:'']),s=entries[key]??={offset:0};let active=true,ready=Promise.resolve();
 const retained=()=>entries[key]===s&&!s.invalidated,live=()=>active&&retained()&&isCurrent();
 const sync=()=>s.sync?.(),errorText=e=>friendlyError(e).replace(/^community_governance_settings_rejected:(?:400|401|403|404|409):/,'');
 const denied=e=>/desktop_not_connected|接続が変わりました|権限がありません|見つかりませんでした|このアカウントは停止|ハブが (?:401|403|404) を返しています|community_governance_settings_rejected:(?:401|403|404):/.test(String(e?.message??e));
 function button(label,fn){const n=node(document,'button',label,'head-action');n.type='button';n.onclick=()=>{if(live())return fn();};return n;}
 function clearReader(){delete s.data;delete s.draft;s.stale=true;s.readToken={};s.loading=false;if(s.saved)delete s.saved.settings;sync();}
 function resetDraft(){s.draft={votingStrategy:s.data.settings.votingStrategy,tokenRules:s.data.settings.tokenRules.map(({tokenId,tokensPerVote,weight})=>({tokenId,tokensPerVote:String(tokensPerVote),weight:String(weight)})),voteWeightCap:String(s.data.settings.voteWeightCap??100)};}
 const canEdit=()=>Boolean(s.data?.canEdit&&!s.loading&&!s.sending&&!s.stale&&!s.operation&&!s.saved);
 const canClose=()=>Boolean(s.rejected&&s.data?.canEdit&&!s.stale&&!s.loading&&!s.sending&&s.data.viewerId===s.actor);
 function render(){
  if(!live())return;root.replaceChildren(node(document,'h3',s.data?.community?.name??'ガバナンス'));
  const notice=node(document,'p',s.error||s.notice||'','meta');notice.setAttribute('role','status');if(s.error)notice.classList.add('warning');root.append(notice);
  if(s.loading)root.append(node(document,'p','ガバナンスの情報を読み込み中…','meta'));
  if(s.data&&s.stale)root.append(node(document,'p','以前の読み込み結果を表示しています。現在の内容を再確認してください。','meta'));
  if(mode==='settings')renderSettings();else if(mode==='catalog')renderCatalog();else renderProposal();
  const reread=button('ガバナンス情報を再読み込み',()=>load(s.failedOffset??s.offset));reread.disabled=Boolean(s.loading||s.sending);root.append(reread);
  if(s.connect&&connectAccount)root.append(button('Desktopを接続',connectAccount));
  if(s.data&&mode==='catalog')root.append(button('新しいDAO提案',()=>onOpen('community_governance_create_context',[communityId],'DAO提案の作成')));
  if(s.data&&openWeb){root.append(node(document,'p','提案はこの画面またはWebで作成できます。賛成・反対・棄権、投票開始・締切・中止、実行済みの記録、投票委任はWebのガバナンス画面で行います。','meta'),button('Webでガバナンスの操作を開く',()=>openWeb(`/v2/community?community=${encodeURIComponent(communityId)}&section=governance`)));}
 }
 function appendSettings(parent,value){
  parent.append(node(document,'p',`投票方式: ${strategies[value.votingStrategy]}`));
  for(const r of value.tokenRules)parent.append(node(document,'p',`${r.tokenSymbol??r.tokenId}: ${r.tokensPerVote}枚につき${r.weight}点`));
  parent.append(node(document,'p',value.voteWeightCap===null?'1人あたりの上限なし':`1人あたり最大${value.voteWeightCap}票`));
 }
 function renderSettings(){
  if(s.data){root.append(node(document,'h4','現在の投票設定'));appendSettings(root,s.data.settings);root.append(node(document,'p','設定変更は新しく作る提案から適用されます。作成済み提案の固定設定は変更しません。','meta'));}
  if(s.saved){root.append(node(document,'p','投票設定の変更は保存済みです。同じ操作を再送しません。','meta'));if(s.data&&JSON.stringify(canonical(s.data.settings))!==JSON.stringify(canonical(s.saved.options)))root.append(node(document,'p','現在の設定は保存時の変更内容と異なります。以前の設定を再適用しません。','meta'));const next=button('別の投票設定を変更',()=>{if(!s.data?.canEdit||s.stale||s.loading||s.sending)return;delete s.saved;delete s.operation;delete s.rejected;delete s.attempted;s.notice='';s.error='';resetDraft();sync();});next.disabled=!s.data?.canEdit||Boolean(s.stale||s.loading||s.sending);root.append(next);return;}
  if(s.operation){
   const op=s.operation,preview=node(document,'section','','card detail-form community-governance-preview');preview.setAttribute('aria-label','投票設定の確認');
   if(s.data&&!s.stale){appendSettings(preview,{...op.options,tokenRules:op.options.tokenRules.map(r=>({...r,tokenSymbol:s.data.availableTokens.find(t=>t.id===r.tokenId)?.symbol??r.tokenId}))});preview.append(node(document,'p','新規提案から適用します。既存提案の票や結果は変更しません。','meta'));}else preview.append(node(document,'p','現在の投票設定を読み直してください。','meta'));
   if(op.unknown)preview.append(node(document,'p','保存結果が不明です。同じ操作IDと確認済み設定だけで結果を確認します。','meta'));
   if(s.rejected)preview.append(node(document,'p','この操作は受け付けられませんでした。現在の設定を再確認してください。以前の保存結果は確定できない場合があります。','meta'));
   const save=button(s.attempted?'同じ投票設定の保存結果を確認':'確認して投票設定を保存',saveOperation);save.disabled=Boolean(!s.data?.canEdit||s.loading||s.sending||s.stale||s.rejected);preview.append(save);
   if(!s.attempted&&!s.sending)preview.append(button('編集に戻る',()=>{delete s.operation;sync();}));
   if(canClose())preview.append(button('現在の設定を確認して操作を閉じる',()=>{if(!canClose())return;delete s.operation;delete s.attempted;delete s.rejected;resetDraft();s.notice='以前の操作を閉じました。再送せず、現在の設定は変更していません。';s.error='';sync();}));root.append(preview);return;
  }
  if(!s.data)return;if(!s.data.canEdit){root.append(node(document,'p','投票設定を変更できるのはオーナーだけです。','meta'));return;}s.draft??=null;if(!s.draft)resetDraft();
  const draft=s.draft,form=node(document,'form','','detail-form');form.onsubmit=e=>{e.preventDefault();if(live())prepare();};
  const strategy=node(document,'select');strategy.setAttribute('aria-label','投票方式');for(const[value,label]of Object.entries(strategies)){const n=node(document,'option',label);n.value=value;strategy.append(n);}strategy.value=draft.votingStrategy;strategy.disabled=!canEdit();strategy.onchange=()=>{if(!live()||!canEdit())return;draft.votingStrategy=strategy.value;sync();};form.append(node(document,'label','投票方式'),strategy);
  if(draft.votingStrategy!=='one_member_one_vote'){
   form.append(node(document,'h4','投票トークンと重み'));for(const token of s.data.availableTokens){const row=node(document,'section','','card detail-form'),choice=node(document,'input');choice.type='checkbox';choice.setAttribute('aria-label',`投票に使う ${token.symbol}`);choice.checked=draft.tokenRules.some(r=>r.tokenId===token.id);choice.disabled=!canEdit();choice.onchange=()=>{if(!live()||!canEdit())return;draft.tokenRules=choice.checked?[...draft.tokenRules,{tokenId:token.id,tokensPerVote:'1',weight:'1'}]:draft.tokenRules.filter(r=>r.tokenId!==token.id);sync();};const label=node(document,'label',`${token.name} · ${token.symbol}`);label.prepend(choice);row.append(label);const rule=draft.tokenRules.find(r=>r.tokenId===token.id);if(rule)for(const[name,caption]of [['tokensPerVote','1票分のトークン枚数'],['weight','票の重み']]){const field=node(document,'input');field.type='number';field.min='0';field.step='any';field.value=rule[name];field.setAttribute('aria-label',`${token.symbol} ${caption}`);field.disabled=!canEdit();field.oninput=()=>{if(live()&&canEdit())rule[name]=field.value;};const l=node(document,'label',caption);l.append(field);row.append(l);}form.append(row);}if(!s.data.availableTokens.length)form.append(node(document,'p','投票に使えるコミュニティトークンはありません。','meta'));
  }
  if(draft.votingStrategy==='token_capped'){const cap=node(document,'input');cap.type='number';cap.min='1';cap.step='1';cap.value=draft.voteWeightCap;cap.setAttribute('aria-label','1人あたりの最大票数');cap.disabled=!canEdit();cap.oninput=()=>{if(live()&&canEdit())draft.voteWeightCap=cap.value;};const label=node(document,'label','1人あたりの最大票数');label.append(cap);form.append(label);}
  const preview=button('投票設定の全文を確認',prepare);preview.disabled=!canEdit();form.append(preview);root.append(form);
 }
 function prepare(){
  if(!live()||!canEdit())return;const d=s.draft,tokenRules=d.votingStrategy==='one_member_one_vote'?[]:d.tokenRules.map(r=>({tokenId:r.tokenId,tokensPerVote:Number(r.tokensPerVote),weight:Number(r.weight)})).sort((a,b)=>a.tokenId.localeCompare(b.tokenId)),voteWeightCap=d.votingStrategy==='token_capped'?Number(d.voteWeightCap):null;
  try{rules(tokenRules);if(!Object.hasOwn(strategies,d.votingStrategy)||d.votingStrategy!=='one_member_one_vote'&&(!tokenRules.length||tokenRules.some(r=>!s.data.availableTokens.some(t=>t.id===r.tokenId)))||voteWeightCap!==null&&(!Number.isSafeInteger(voteWeightCap)||voteWeightCap<1))invalid();}catch{ s.error='投票トークン、正の換算枚数と重み（最大1000）、票数上限を確認してください。';sync();return;}
  s.operation={options:{operationId:document.defaultView.crypto.randomUUID(),snapshot:s.data.snapshot,votingStrategy:d.votingStrategy,tokenRules,voteWeightCap}};s.error='';s.notice='全文を確認してください。まだ保存していません。';sync();
 }
 async function saveOperation(){
  const op=s.operation;if(!live()||!op||s.sending||s.loading||s.saved||s.rejected||s.stale||!s.data?.canEdit)return;s.sending=true;s.attempted=true;sync();
  try{const value=await invoke('hub_client_action',{action:'community_governance_settings',target:communityId,options:structuredClone(op.options)});if(!retained()||s.operation!==op)return;const result=ack(value,communityId,op);s.saved={...op,...result};delete s.operation;delete s.rejected;s.stale=true;s.notice='投票設定の変更は保存済みです。';s.sending=false;sync();if(live()){try{await onChanged?.({communityId,receipt:result.receipt});}catch(error){if(retained())s.error='変更は保存済みです。画面を更新できませんでした: '+errorText(error);}if(live())await load(s.offset);}}
  catch(error){if(!retained()||s.operation!==op)return;if(/接続が変わりました/.test(String(error))){invalidate();return;}s.error=errorText(error);const rejection=String(error?.message??error).match(/^community_governance_settings_rejected:(400|401|403|404|409):/);s.rejected=rejection?Number(rejection[1]):undefined;if(!rejection&&!String(error).includes('desktop_not_connected'))op.unknown=true;s.stale=Boolean(rejection)||denied(error);if(denied(error)){clearReader();s.connect=String(error).includes('desktop_not_connected');}}
  finally{if(retained()){s.sending=false;sync();}if(!active)document.defaultView.removeEventListener('hub-account-changed',invalidate);}
 }
 function validate(value,requested){return mode==='settings'?settingsPage(value,communityId):mode==='catalog'?proposalPage(value,communityId,requested):proposalDetail(value,communityId,proposalId);}
 function adopt(value,requested){
  const next=validate(value,requested);if(Object.hasOwn(s,'actor')&&s.actor!==next.viewerId){invalidate();return false;}s.actor=next.viewerId;s.data=next;s.stale=false;s.connect=false;delete s.failedOffset;if(mode==='catalog')s.offset=next.page.offset;if(mode==='settings'&&!s.operation&&!s.saved&&!s.draft)resetDraft();return true;
 }
 async function read(requested){
  if(!live()||s.loading||s.sending)return;const token={};s.readToken=token;s.loading=true;s.error='';sync();
  try{if(!id(communityId)||mode==='proposal'&&!id(proposalId)||mode==='catalog'&&!offset(requested))invalid();const name=mode==='settings'?'community_governance_settings':mode==='proposal'?'community_governance_proposal':'community_governance_page',ids=mode==='catalog'?[communityId,String(requested)]:mode==='proposal'?[communityId,proposalId]:[communityId];const value=await invoke('hub_detail',{name,ids});if(!retained()||s.readToken!==token)return;adopt(value,requested);}
  catch(error){if(retained()&&s.readToken===token){s.error=(s.saved?'変更は保存済みです。現在の情報を読み直せませんでした: ':'')+errorText(error);s.stale=true;s.failedOffset=requested;if(denied(error)){const message=s.error;clearReader();s.error=message;s.connect=String(error).includes('desktop_not_connected');sync();}}}
  finally{if(retained()&&s.readToken===token){s.loading=false;delete s.readToken;sync();}}
 }
 function load(requested=s.offset){return ready=read(requested);}
 function renderCatalog(){if(!s.data)return;root.append(node(document,'h4','DAO提案'));for(const p of s.data.proposals){const row=node(document,'article','','card detail-form');row.append(button(p.title,()=>onOpen('community_governance_proposal',[communityId,p.id],'DAO提案の詳細')),node(document,'p',`${kinds[p.kind]} · ${statuses[p.status]} · ${methods[p.votingMethod]} · 更新 ${p.updatedAt}`,'meta'));root.append(row);}if(!s.data.proposals.length)root.append(node(document,'p','DAO提案はまだありません。','meta'));const nav=node(document,'nav','','detail-form-row');nav.setAttribute('aria-label','DAO提案のページ');const previous=button('前の20件',()=>load(s.offset-20)),next=button('次の20件',()=>load(s.data.page.nextOffset));previous.disabled=!s.offset||Boolean(s.loading);next.disabled=!s.data.page.hasMore||Boolean(s.loading);nav.append(previous,next,node(document,'span',`${s.offset/20+1}ページ`,'meta'));root.append(nav,button('投票設定を読む',()=>onOpen('community_governance_settings',[communityId],'DAO投票設定')));}
 function renderProposal(){
  if(!s.data)return;const p=s.data.proposal;root.append(node(document,'h4',p.title),node(document,'p',`${kinds[p.kind]} · ${statuses[p.status]}`,'meta'),node(document,'pre',p.body,'community-governance-body'));
  const fixed=node(document,'section','','card detail-form');fixed.setAttribute('aria-label','提案の固定設定');fixed.append(node(document,'h4','提案の固定設定'),node(document,'p',`投票方式: ${methods[p.votingMethod]} · 従来設定: ${strategies[p.votingStrategy]}`),node(document,'p',`決定範囲: ${scopes[p.decisionScope]} · 可決後の効果: ${modes[p.executionMode]}`),node(document,'p',`定足人数: ${p.quorum} · 承認割合: ${p.approvalThreshold*100}%`),node(document,'p',`メンバー定足率: ${p.quorumMemberBps/100}% · トークン定足率: ${p.quorumTokenBps/100}% · 承認率: ${p.approvalBps/100}%`),node(document,'p',`投票開始: ${p.votingStartsAt} · 締切: ${p.votingEndsAt}`),node(document,'p',`残高の参照方針（記録）: ${snapshots[p.snapshotPolicy]} · 固定日時: ${p.snapshotCapturedAt??'未記録'} · ブロック: ${p.snapshotBlockNumber??'未記録'}`,'meta'));
  for(const r of p.governanceTokenRules)fixed.append(node(document,'p',`固定トークン: ${r.tokenSymbol} · ${r.tokensPerVote}枚につき${r.weight}点`));if(!p.governanceTokenRules.length&&p.governanceTokenId)fixed.append(node(document,'p',`固定トークン: ${p.governanceTokenSymbol??p.governanceTokenId} · ${p.tokensPerVote}枚につき1票`));fixed.append(node(document,'p',p.voteWeightCap===null?'票数上限なし':`最大${p.voteWeightCap}票`),node(document,'p','表示は保存されている方針と状態の記録です。自動実行や残高取得の保証を示すものではありません。','meta'));root.append(fixed);
  const table=node(document,'table'),head=node(document,'thead'),header=node(document,'tr');for(const caption of ['選択','人数','票数','メンバー点／トークン点'])header.append(node(document,'th',caption));head.append(header);const body=node(document,'tbody');for(const[key,label]of [['for','賛成'],['against','反対'],['abstain','棄権'],['total','合計']]){const bucket=p.tally[key],row=node(document,'tr');for(const value of [label,bucket.count,bucket.weight,`${bucket.memberWeight}／${bucket.tokenWeight}`])row.append(node(document,'td',String(value)));body.append(row);}table.append(head,body);root.append(node(document,'h4','投票集計'),table,node(document,'p',p.myVote?`自分の投票: ${{for:'賛成',against:'反対',abstain:'棄権'}[p.myVote.choice]} · ${p.myVote.weight}票 · メンバー${p.myVote.memberWeight}点／トークン${p.myVote.tokenWeight}点 · 更新${p.myVote.updatedAt}`:'自分の投票は記録されていません。','meta'));
  if(p.linkedGuideProposalId)root.append(button('参照する共同ページ編集提案を読む',()=>onOpen('community_guide_proposal',[communityId,p.linkedGuideProposalId],'共同ページの編集提案')));if(p.executedAt)root.append(node(document,'p',`実行済みの記録日時: ${p.executedAt}`,'meta'));root.append(button('DAO提案一覧へ戻る',()=>onOpen('community_governance',[communityId],'ガバナンス')));
 }
 function invalidate(){for(const[k,value]of Object.entries(entries)){if(JSON.parse(k)[0]!==communityId)continue;const notify=value.sync;for(const name of Object.keys(value))delete value[name];value.invalidated=true;notify?.();delete entries[k];}const wasActive=active;dispose();if(wasActive)root.append(node(document,'p','接続が変わりました。ガバナンスを開き直してください。','meta'));document.defaultView.removeEventListener('hub-account-changed',invalidate);}
 function dispose(){if(!active)return;active=false;if(s.sync===render)delete s.sync;if(s.loading){s.readToken={};s.loading=false;s.stale=true;}root.querySelectorAll('button,input,select').forEach(n=>n.disabled=true);root.replaceChildren();if(!s.sending)document.defaultView.removeEventListener('hub-account-changed',invalidate);}
 document.defaultView.addEventListener('hub-account-changed',invalidate);s.sync=render;
 try{if(prepared!==undefined)adopt(prepared,s.offset??0);}catch(error){s.error=errorText(error);clearReader();}
 render();if(prepared===undefined&&!s.loading&&!s.sending)load(s.offset);return{root,get ready(){return ready;},dispose,invalidate,clearReader};
}
