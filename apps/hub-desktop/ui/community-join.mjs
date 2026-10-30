const node=(d,tag,value='',cls='')=>{const n=d.createElement(tag);n.textContent=value;n.className=cls;return n;};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=100&&!/[^A-Za-z0-9_-]/.test(v);
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\ud800-\udfff]/u.test(v);
const dbText=(v,max,min=0)=>text(v,max*2)&&[...v].length>=min&&[...v].length<=max;
const hash=v=>typeof v==='string'&&v.length===64&&!/[^a-f0-9]/.test(v);
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const invalid=()=>{throw Error('参加情報を確認できませんでした。');};
function guide(v,cid,actor){
  try{if(new TextEncoder().encode(JSON.stringify(v)).length>256*1024)invalid();}catch{invalid();}
  if(!v||v.community?.id!==cid||!dbText(v.community.name,100,1)||!dbText(v.community.description,2000)||!['public','approval','private'].includes(v.community.visibility)||!(v.viewerId===null||id(v.viewerId))||typeof v.joined!=='boolean'||typeof v.pending!=='boolean'||(v.joined&&v.pending)||(v.viewerId===null&&(v.joined||v.pending))||!hash(v.snapshot)||!Array.isArray(v.rules)||!Array.isArray(v.questions)||v.questions.length>20)invalid();
  if(v.viewerId!==actor)throw Error('接続が変わりました。参加案内を確認し直してください。');
  if(v.rules.some(r=>!id(r?.id)||!dbText(r.title,80,1)||!dbText(r.body,1000,1)||![0,1].includes(r.required))||v.questions.some(q=>!id(q?.id)||!dbText(q.prompt,200,1)||![0,1].includes(q.required))||new Set(v.rules.map(r=>r.id)).size!==v.rules.length||new Set(v.questions.map(q=>q.id)).size!==v.questions.length)invalid();return structuredClone(v);
}
function acknowledgement(v,cid,op){
  if(!v||v.communityId!==cid||typeof v.joined!=='boolean'||typeof v.pending!=='boolean'||(v.joined&&v.pending)||typeof v.alreadyJoined!=='boolean'||typeof v.alreadyPending!=='boolean')invalid();
  if(v.receipt===null){if(!((v.alreadyJoined&&!v.alreadyPending&&v.joined&&!v.pending)||(v.alreadyPending&&!v.alreadyJoined&&v.pending&&!v.joined)))invalid();}
  else{const r=v.receipt;if(!r||v.alreadyJoined||v.alreadyPending||!uuid(r.auditId)||r.auditId!==op.args.options.operationId||r.action!==op.action||r.targetId!==cid||!text(r.confirmedAt,64)||/[\u0000-\u001f\u007f]/.test(r.confirmedAt)||!Number.isFinite(Date.parse(r.confirmedAt))||typeof r.replayed!=='boolean')invalid();}
  return structuredClone(v);
}

export function communityJoinControls(target,{community,membership,viewerId,viewerRole,viewerStatus,invoke,refresh=()=>{},connectAccount,isCurrent=()=>true,state={},confirm=text=>target.defaultView?.confirm(text),friendlyError=error=>String(error?.message??error)}={}){
  const document=target.ownerDocument??target,root=node(document,'div','','detail-form community-membership community-join'),cid=community?.id,actor=viewerId??null,scope=JSON.stringify([cid,actor]);
  if(state.scope!==scope){for(const key of Object.keys(state))delete state[key];Object.assign(state,{scope,epoch:0,draft:{accepted:false,answers:{}},listeners:new Set()});}
  state.current=membership?{joined:membership.joined,pending:membership.pending}:null;
  let active=true,ready=Promise.resolve();const epoch=state.epoch;
  const retained=()=>state.scope===scope&&state.epoch===epoch,live=()=>active&&retained()&&isCurrent();
  const notify=()=>{for(const listener of state.listeners)listener();};
  const button=(label,fn)=>{const b=node(document,'button',label,'head-action');b.type='button';b.onclick=()=>{if(live())fn();};return b;};
  const status=()=>state.current??{joined:false,pending:false};
  const blocked=()=>!id(cid)?'コミュニティを確認できません。':['muted','banned'].includes(viewerStatus)?'制限中は参加状態を変更できません。':status().joined&&viewerRole==='owner'?'オーナーは退出できません。':!status().joined&&!status().pending&&(state.guide?.community.visibility??community.visibility)==='private'?'招待制のコミュニティです。':'';
  function render(){
    if(!live())return;const note=node(document,'p',state.notice??'','meta');note.setAttribute('role','status');root.replaceChildren(note);
    if(!membership||actor===null){root.append(node(document,'p','参加するにはDesktop接続が必要です。','meta'));if(connectAccount)root.append(button('Desktopを接続',()=>connectAccount()));return;}
    if(state.saved){const current=status();root.append(node(document,'p',current.joined?'参加中です。':current.pending?'参加申請の承認待ちです。':state.saved.legacyAction?'退出・申請取消の結果を確認しました。現在は参加中でも承認待ちでもありません。':state.saved.receipt?'以前の参加操作は保存されていますが、現在は参加中でも承認待ちでもありません。再参加・再申請はしていません。':'現在は参加中でも承認待ちでもありません。以前に確認した参加状態から変わっています。'));
      root.append(button('参加状態を更新',()=>void refreshRead()));
      if(!current.joined&&!current.pending&&!state.operation){root.append(button('現在の参加案内を読み直す',()=>{state.open=true;void load();}));if(!state.open)return;}
    }
    const unavailable=blocked(),current=status(),label=current.joined?'退出する':current.pending?'申請を取り下げる':community.visibility==='approval'?'参加を申請する':'参加する';
    const control=button(label,async()=>{
      if(state.busy||state.reading||state.operation||unavailable)return;
      if(current.joined){if(confirm('このコミュニティから退出しますか？'))void legacy('community_leave');return;}
      state.open=!state.open;
      if(state.open&&!current.pending&&!state.guide&&!state.operation)ready=load();else render();
    });control.disabled=Boolean(unavailable)||Boolean(state.busy)||Boolean(state.reading)||Boolean(state.operation);root.append(control);
    if(unavailable){note.textContent=unavailable;return;}
    if(current.joined&&!state.operation)return;
    if(!state.open)return;
    if(current.pending&&!state.operation){const preview=node(document,'section','','card');preview.append(node(document,'p','参加申請を取り下げますか？ 承認待ちの申請を取り消します。'),button('取り下げを確定',()=>{state.cancellationId??=document.defaultView.crypto.randomUUID();void legacy('community_cancel_request');}));preview.lastChild.disabled=Boolean(state.busy);root.append(preview);return;}
    if(!state.guide){root.append(button('参加案内を再読み込み',()=>{if(!state.reading&&!state.busy)ready=load();}));root.lastChild.disabled=Boolean(state.reading)||Boolean(state.busy);if(state.connect&&connectAccount)root.append(button('Desktopを接続',()=>connectAccount()));return;}
    const data=state.guide;
    for(const rule of data.rules){const section=node(document,'section','','card');section.append(node(document,'p',rule.required?'同意必須':'参考ルール','meta'),node(document,'h4',rule.title),node(document,'p',rule.body));root.append(section);}
    const form=node(document,'form','','detail-form');form.onsubmit=e=>{e.preventDefault();if(live())prepare();};
    const required=data.rules.some(r=>r.required===1);
    if(required){const label=node(document,'label'),consent=node(document,'input');consent.type='checkbox';consent.setAttribute('aria-label','必須ルールを読み、同意します');consent.checked=state.draft.accepted;consent.disabled=Boolean(state.operation);consent.onchange=()=>{if(live())state.draft.accepted=consent.checked;};label.append(consent,document.createTextNode('必須ルールを読み、同意します'));form.append(label);}
    for(const q of data.questions){const label=node(document,'label',q.prompt+(q.required?'（必須）':'（任意）')),field=node(document,'textarea');field.maxLength=1000;field.setAttribute('aria-label',q.prompt);field.value=state.draft.answers[q.id]??'';field.disabled=Boolean(state.operation);field.oninput=()=>{if(live())state.draft.answers[q.id]=field.value;};label.append(field);form.append(label);}
    if(!state.operation)form.append(button('参加内容を確認',prepare));
    else{
      const op=state.operation,preview=node(document,'section','','card community-join-preview');preview.setAttribute('aria-label','参加内容の確認');preview.append(node(document,'h4',op.action==='membership_requested'?'参加を申請します':'このコミュニティに参加します'),node(document,'p',data.community.name));
      for(const answer of op.args.options.answers){preview.append(node(document,'h4',data.questions.find(q=>q.id===answer.questionId)?.prompt??'以前の参加質問'),node(document,'pre',answer.answer));}
      preview.append(button(state.busy?'保存中…':op.unknown?'同じ参加操作の保存結果を確認':'確認して参加内容を保存',()=>void save()));preview.lastChild.disabled=Boolean(state.busy);
      if(!op.unknown&&!state.busy)preview.append(button('編集に戻る',()=>{state.operation=null;state.notice='';render();}));form.append(preview);
      if(op.unknown&&op.refused&&state.freshForClose&&!state.busy){preview.append(node(document,'p',op.refusalMessage+' 以前の操作の保存結果は確定していません。現在の案内では参加中でも承認待ちでもありません。以前の操作は再送せず、最新の案内で入力し直します。'),button('以前の操作を閉じ、最新の案内で入力し直す',()=>{if(state.operation!==op||!state.freshForClose||state.busy)return;state.operation=null;state.freshForClose=false;state.draft={accepted:false,answers:{}};state.notice='以前の操作を閉じました。保存結果は断定していません。入力と確認からやり直してください。';render();}));}
    }
    root.append(form);
  }
  async function load(){
    if(!live()||state.reading||state.busy)return;state.reading=true;state.freshForClose=false;state.notice='参加案内を読み込み中…';notify();
    try{const value=await invoke('hub_detail',{name:'community_onboarding',ids:[cid]});if(!live())return;state.guide=guide(value,cid,actor);state.current={joined:state.guide.joined,pending:state.guide.pending};state.notice='';state.connect=false;state.freshForClose=Boolean(state.operation?.unknown&&state.operation.refused&&!state.guide.joined&&!state.guide.pending);
      if(state.guide.joined||state.guide.pending){state.saved??={...state.guide,communityId:cid};if(!state.operation)state.open=false;}
    }catch(error){if(!live())return;state.guide=null;state.notice=friendlyError(error);state.connect=String(error).includes('desktop_not_connected')||/接続が変わりました/.test(String(error));if(/接続が変わりました/.test(String(error))){state.operation=null;state.draft={accepted:false,answers:{}};}}
    finally{if(retained()){state.reading=false;notify();}}
  }
  function prepare(){
    if(!live()||!state.guide||state.operation||state.busy||actor===null||blocked())return;
    const data=state.guide,required=data.rules.some(r=>r.required===1);
    if(status().joined||status().pending){state.saved??={...data,communityId:cid};render();return;}
    if(required&&!state.draft.accepted){state.notice='コミュニティルールへの同意が必要です。';render();return;}
    const raw=data.questions.map(q=>({questionId:q.id,answer:state.draft.answers[q.id]??''}));
    if(raw.some(v=>!text(v.answer,1000))){state.notice='回答は1000文字以内で入力してください。';render();return;}
    const answers=raw.map(v=>({...v,answer:v.answer.normalize('NFKC').trim()}));
    if(answers.some(v=>!text(v.answer,1000))){state.notice='回答は1000文字以内で入力してください。';render();return;}
    if(data.questions.some(q=>q.required&&!answers.find(v=>v.questionId===q.id).answer)){state.notice='必須の参加質問に回答してください。';render();return;}
    state.operation={action:data.community.visibility==='approval'?'membership_requested':'member_joined',args:{action:'community_join_complete',target:cid,options:{operationId:document.defaultView.crypto.randomUUID(),snapshot:data.snapshot,acceptedRules:required?state.draft.accepted:true,answers}}};state.notice='全文を確認してください。まだ保存していません。';render();
  }
  async function refreshRead(){
    if(!live()||state.refreshing)return;state.refreshing=true;
    try{await refresh();}catch(error){if(live()){state.notice=(state.saved?.receipt||state.saved?.legacyAction?'保存結果は保持しています。':'現在確認できた参加状態は保持しています。')+'参加状態を読み直せませんでした。 '+friendlyError(error);render();}}
    finally{if(retained())state.refreshing=false;}
  }
  async function save(){
    if(!live()||state.busy||!state.operation||!state.guide)return;const op=state.operation;state.busy=true;state.freshForClose=false;state.notice='保存中…';notify();
    try{const value=await invoke('hub_client_action',structuredClone(op.args));if(!retained()||state.operation!==op)return;state.saved=acknowledgement(value,cid,op);state.current={joined:state.saved.joined,pending:state.saved.pending};state.operation=null;state.open=false;state.draft={accepted:false,answers:{}};state.notice=state.saved.receipt?'参加操作の保存結果を確認しました。':'現在の参加状態を確認しました。';notify();if(live())await refreshRead();}
    catch(error){if(!retained()||state.operation!==op)return;const message=String(error),definite=message.includes('desktop_not_connected')||/community_join_rejected:(400|403|404|409):/.test(message);state.notice=friendlyError(error);
      if(definite){state.guide=null;state.connect=message.includes('desktop_not_connected');state.draft={accepted:false,answers:{}};if(!op.unknown)state.operation=null;else{op.refused=/community_join_rejected:(400|409):/.test(message);op.refusalMessage=friendlyError(error);}}
      if(state.operation){op.unknown=true;state.notice+=' 保存結果が不明です。同じUUID・回答だけで確認します。';}
    }finally{if(retained()){state.busy=false;notify();}}
  }
  async function legacy(action){
    if(!live()||state.busy||blocked())return;state.busy=true;state.notice='更新中…';notify();
    const args={action,target:cid,...(action==='community_cancel_request'?{requestId:state.cancellationId}:{})};
    try{const value=await invoke('hub_client_action',args);if(!retained())return;
      if(action==='community_cancel_request'?!(value.pending===false&&value.currentMembership?.pending===false&&value.receipt?.auditId===state.cancellationId&&value.receipt?.targetId===actor):!(value.joined===false&&value.pending===false))invalid();
      state.saved={communityId:cid,joined:action==='community_cancel_request'&&value.currentMembership?.joined===true,pending:false,legacyAction:action};state.current={joined:state.saved.joined,pending:state.saved.pending};state.cancellationId=undefined;state.guide=null;state.open=false;state.notice='参加状態を更新しました。';if(live())await refreshRead();
    }catch(error){if(retained())state.notice=friendlyError(error);}
    finally{if(retained()){state.busy=false;notify();}}
  }
  const listener=()=>render();state.listeners.add(listener);
  function dispose(){if(!active)return;active=false;state.listeners.delete(listener);document.defaultView?.removeEventListener('hub-account-changed',accountChanged);root.querySelectorAll('input,textarea,button').forEach(n=>{n.disabled=true;});root.replaceChildren();}
  function invalidate(){if(!retained()){dispose();return;}state.epoch++;state.guide=null;state.operation=null;state.saved=null;state.current=null;state.draft={accepted:false,answers:{}};state.busy=false;state.reading=false;state.listeners.clear();dispose();root.append(node(document,'p','接続が変わりました。参加画面を開き直してください。','meta'));}
  const accountChanged=()=>invalidate();document.defaultView?.addEventListener('hub-account-changed',accountChanged);
  render();return{root,get ready(){return ready;},dispose,invalidate};
}
