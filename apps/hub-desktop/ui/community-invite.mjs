const codePattern=/^[a-f0-9]{32}$/;
const id=v=>typeof v==='string'&&v.length>0&&v.length<=100&&!/[^A-Za-z0-9_-]/.test(v);
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\ud800-\udfff]/u.test(v);
const dbText=(v,max,min=0)=>text(v,max*2)&&[...v].length>=min&&[...v].length<=max;
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const invalid=()=>{throw Error('招待の情報を確認できませんでした。');};
const node=(d,tag,value='',cls='')=>{const n=d.createElement(tag);n.textContent=value;n.className=cls;return n;};

export function parseCommunityInvite(value,origin){
  if(typeof value!=='string'||value.length>2048||value!==value.trim()||/[\u0000-\u001f\u007f]/.test(value))throw Error('現在のHubの招待リンク、または32文字の招待コードを入力してください。');
  if(codePattern.test(value))return value;
  try{
    const base=new URL(origin),url=new URL(value);
    if(!['https:','http:'].includes(base.protocol)||url.origin!==base.origin||url.username||url.password||url.search||url.hash)throw Error();
    const match=/^\/(?:v2\/)?community\/invite\/([a-f0-9]{32})$/.exec(url.pathname);
    if(!match)throw Error();return match[1];
  }catch{throw Error('現在のHubの招待リンクだけを使用できます。');}
}

function guide(value){
  try{if(new TextEncoder().encode(JSON.stringify(value)).length>256*1024)invalid();}catch{invalid();}
  if(!value||!id(value.community?.id)||!dbText(value.community.name,100,1)||!dbText(value.community.description,2000)||typeof value.snapshot!=='string'||value.snapshot.length!==64||/[^a-f0-9]/.test(value.snapshot)||!(value.viewerId===null||id(value.viewerId))||typeof value.joined!=='boolean'||(value.joined&&value.viewerId===null))invalid();
  if(!Array.isArray(value.rules)||!Array.isArray(value.questions)||value.questions.length>20)invalid();
  if(value.rules.some(v=>!id(v?.id)||!dbText(v.title,80,1)||!dbText(v.body,1000,1)||![0,1].includes(v.required))||value.questions.some(v=>!id(v?.id)||!dbText(v.prompt,200,1)||![0,1].includes(v.required)))invalid();
  if(new Set(value.rules.map(v=>v.id)).size!==value.rules.length||new Set(value.questions.map(v=>v.id)).size!==value.questions.length)invalid();
  return structuredClone(value);
}

function acknowledgement(value,operation){
  if(!value||value.communityId!==operation.communityId||typeof value.joined!=='boolean'||value.pending!==false||typeof value.alreadyJoined!=='boolean')invalid();
  if(value.receipt===null){if(!value.alreadyJoined||!value.joined)invalid();}
  else{
    const r=value.receipt;
    if(!r||value.alreadyJoined||r.auditId!==operation.args.requestId||!uuid(r.auditId)||r.action!=='member_joined_invite'||r.targetId!==operation.communityId||!text(r.confirmedAt,64)||/[\u0000-\u001f\u007f]/.test(r.confirmedAt)||!Number.isFinite(Date.parse(r.confirmedAt))||typeof r.replayed!=='boolean')invalid();
  }
  return structuredClone(value);
}

export function communityInvite(target,{invoke,onJoined,connectAccount,isCurrent=()=>true,friendlyError=error=>String(error?.message??error)}={}){
  const document=target.ownerDocument??target,root=node(document,'details','','card detail-form community-invite');
  let active=true,generation=0,reading=false,sending=false,input='',code=null,data=null,operation=null,result=null,notice='',connectionRequired=false,answers={},accepted=false,freshRead=false;
  const current=token=>active&&isCurrent()&&token===generation;
  const button=(label,fn)=>{const token=generation,b=node(document,'button',label,'head-action');b.type='button';b.onclick=()=>{if(current(token))fn();};return b;};
  const clear=()=>{input='';code=null;data=null;operation=null;result=null;answers={};accepted=false;reading=false;sending=false;freshRead=false;};
  const openCommunity=()=>{if(data?.joined)onJoined?.(data.community.id);else if(result?.joined)onJoined?.(result.communityId);};
  function render(){
    if(!active)return;
    const frame=generation;
    const summary=node(document,'summary','招待から参加'),status=node(document,'p',notice,'meta');status.setAttribute('role','status');root.replaceChildren(summary,status);
    if(connectionRequired&&!data&&connectAccount)root.append(button('Desktopを接続',()=>connectAccount()));
    if(result){root.append(node(document,'p',result.joined?'参加済みです。':'以前の参加は保存されていますが、現在は参加していません。再参加は行いません。'));if(result.joined)root.append(button('参加したコミュニティを開く',openCommunity));return;}
    if(!data&&operation){root.append(node(document,'p','以前の参加操作の結果は不明です。参加案内を読み直してから、同じ内容で確認してください。'),button('参加案内を再確認',()=>{if(!reading)void load(input);}));root.lastChild.disabled=reading;return;}
    if(!data){
      const form=node(document,'form','','detail-form'),field=node(document,'input');field.type='text';field.autocomplete='off';field.spellcheck=false;field.maxLength=2048;field.setAttribute('aria-label','招待リンクまたはコード');field.placeholder='招待リンクまたはコード';field.value=input;field.disabled=reading;field.oninput=()=>{if(current(frame))input=field.value;};
      const submit=button(reading?'招待を確認しています…':'招待を確認',()=>{});submit.type='submit';submit.disabled=reading;
      form.onsubmit=e=>{e.preventDefault();if(current(frame)&&!reading)void load(field.value);};form.append(field,submit,node(document,'p','入力したコードは、現在接続しているHubの招待として確認します。','meta'));root.append(form);return;
    }
    root.append(node(document,'h3',data.community.name),node(document,'p',data.community.description));
    if(data.joined&&!operation){root.append(node(document,'p','すでに参加しています。'),button('コミュニティを開く',openCommunity));return;}
    for(const rule of data.rules){const article=node(document,'article','','card');article.append(node(document,'h4',rule.title),node(document,'p',rule.body));root.append(article);}
    const form=node(document,'form','','detail-form'),requiredConsent=data.rules.some(v=>v.required===1);
    if(requiredConsent){const label=node(document,'label'),consent=node(document,'input');consent.type='checkbox';consent.checked=accepted;consent.disabled=Boolean(operation)||sending;consent.setAttribute('aria-label','ルールを確認し参加に同意する');consent.onchange=()=>{if(current(frame))accepted=consent.checked;};label.append(consent,document.createTextNode('ルールを確認し参加に同意する'));form.append(label);}
    for(const q of data.questions){const l=node(document,'label',q.prompt+(q.required?'（必須）':'（任意）')),field=node(document,'textarea');field.setAttribute('aria-label',q.prompt);field.maxLength=1000;field.value=answers[q.id]??'';field.disabled=Boolean(operation)||sending;field.oninput=()=>{if(current(frame))answers[q.id]=field.value;};l.append(field);form.append(l);}
    if(operation){
      const preview=node(document,'section','','card');preview.setAttribute('aria-label','招待参加の確認');preview.append(node(document,'h4','この招待で参加します'),node(document,'p','承認制・招待制でも、この招待から参加するとメンバーになります。'));
      for(const answer of operation.args.options.answers){const q=data.questions.find(v=>v.id===answer.questionId);preview.append(node(document,'h4',q?.prompt??'以前の参加質問'),node(document,'pre',answer.answer));}
      preview.append(button(sending?'参加を保存しています…':operation.unknown?'同じ参加の保存結果を確認':'確認して参加を保存',()=>void save()));preview.lastChild.disabled=sending;
      if(!operation.unknown&&!sending)preview.append(button('編集に戻る',()=>{operation=null;render();}));form.append(preview);
      if(operation.unknown&&freshRead&&!sending){const pinned=operation;preview.append(node(document,'p','以前の参加操作の保存結果は確定していません。再取得した現在の参加案内でやり直す場合、以前の操作は再送せず、内容を確認してから新しい操作として保存します。'),button('現在の参加案内でやり直す',()=>{if(operation!==pinned||!freshRead||sending)return;operation=null;freshRead=false;accepted=false;notice='以前の操作を閉じました。保存結果は断定していません。現在の内容で参加を確認してください。';render();}));}
    }else{
      const preview=button('参加内容を確認',()=>{});preview.type='submit';preview.disabled=data.viewerId===null;form.append(preview);
      form.onsubmit=e=>{e.preventDefault();if(!current(frame)||sending||operation)return;
        if(data.viewerId===null){connectionRequired=true;notice='参加するにはDesktopをHubへ接続してください。';render();return;}
        if(requiredConsent&&!accepted){notice='ルールを確認し、参加に同意してください。';render();return;}
        if(data.questions.some(q=>!text(answers[q.id]??'',1000))){notice='回答は1000文字以内で入力してください。';render();return;}
        const values=data.questions.map(q=>({questionId:q.id,answer:(answers[q.id]??'').normalize('NFKC').trim()}));
        if(values.some(v=>!text(v.answer,1000))){notice='回答は1000文字以内で入力してください。';render();return;}
        if(data.questions.some(q=>q.required&&!values.find(v=>v.questionId===q.id).answer)){notice='必須の参加質問に回答してください。';render();return;}
        operation={communityId:data.community.id,viewerId:data.viewerId,args:{action:'community_invite_accept',target:code,requestId:document.defaultView.crypto.randomUUID(),options:{snapshot:data.snapshot,acceptedRules:true,answers:values}}};notice='参加内容を確認してください。まだ保存していません。';render();
      };
    }
    if(data.viewerId===null){connectionRequired=true;form.append(node(document,'p','参加するにはDesktopをHubへ接続してください。','meta'));if(connectAccount)form.append(button('Desktopを接続',()=>connectAccount()));}
    root.append(form);
  }
  async function load(value){
    const token=generation;reading=true;freshRead=false;input=value;notice='';connectionRequired=false;render();
    try{const origin=await invoke('hub_origin');if(!current(token))return;const parsed=parseCommunityInvite(value,origin);const response=await invoke('hub_detail',{name:'community_invite',ids:[parsed]});if(!current(token))return;const fresh=guide(response);if(operation&&(fresh.viewerId!==operation.viewerId||fresh.community.id!==operation.communityId)){clear();notice='接続が変わりました。招待を確認し直してください。';return;}code=parsed;data=fresh;freshRead=Boolean(operation);answers=operation?Object.fromEntries(operation.args.options.answers.map(v=>[v.questionId,v.answer])):{};accepted=Boolean(operation);}
    catch(error){if(!current(token))return;data=null;code=null;notice=friendlyError(error);connectionRequired=String(error).includes('desktop_not_connected')||/community_invite_rejected:401:/.test(String(error));}
    finally{if(current(token)){reading=false;render();}}
  }
  async function save(){
    if(!active||!isCurrent()||sending||!operation)return;
    if(data.viewerId===null){connectionRequired=true;notice='参加するにはDesktopをHubへ接続してください。';render();return;}
    const token=generation,pinned=operation;sending=true;freshRead=false;notice='';render();
    try{const response=await invoke('hub_client_action',structuredClone(pinned.args));if(!current(token)||operation!==pinned)return;result=acknowledgement(response,pinned);notice=result.receipt?.replayed?'以前の参加操作の保存結果を確認しました。':'参加を確認しました。';code=null;input='';answers={};accepted=false;operation=null;render();}
    catch(error){if(!current(token)||operation!==pinned)return;
      const message=String(error),definite=message.includes('desktop_not_connected')||/community_invite_rejected:(400|401|403|404|409):/.test(message);
      notice=friendlyError(error);
      if(definite&&!pinned.unknown){operation=null;data=null;answers={};accepted=false;connectionRequired=message.includes('desktop_not_connected')||/community_invite_rejected:401:/.test(message);}
      else{pinned.unknown=true;if(definite){data=null;answers={};accepted=false;connectionRequired=message.includes('desktop_not_connected')||/community_invite_rejected:401:/.test(message);}notice+=' 保存結果が不明です。同じ内容だけを再送して確認します。';}
    }finally{if(current(token)){sending=false;render();}}
  }
  function invalidate(){if(!active)return;generation++;clear();notice='接続が変わりました。招待を確認し直してください。';connectionRequired=true;render();}
  const accountChanged=()=>invalidate();document.defaultView?.addEventListener('hub-account-changed',accountChanged);
  function dispose(){if(!active)return;active=false;generation++;clear();document.defaultView?.removeEventListener('hub-account-changed',accountChanged);root.replaceChildren();}
  render();return{root,dispose,invalidate};
}
