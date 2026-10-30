const node=(d,tag,text,cls='')=>{const n=d.createElement(tag);if(text!=null)n.textContent=text;n.className=cls;return n;};
const id=v=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[^A-Za-z0-9_-]/.test(v);
const uuid=v=>typeof v==='string'&&v.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const href=v=>`/v2/threads/${encodeURIComponent(v)}`;
const denied=e=>/見つかりませんでした|このアカウントは停止|権限がありません|ハブが (?:401|403|404) を返しています|desktop_not_connected|research_proposal_(?:link|unlink)_rejected:(?:401|403|404):/.test(String(e?.message??e));
const invalid=()=>{throw Error('関連スレッドの内容を確認できませんでした。');};
function parse(value,proposalId){
  try{if(new TextEncoder().encode(JSON.stringify(value)).length>512*1024)invalid();}catch{invalid();}
  if(value?.proposalId!==proposalId||typeof value.canManage!=='boolean'||!Array.isArray(value.links)||value.links.length>100)invalid();
  const ids=new Set(),threads=new Set(),links=value.links.map(row=>{
    if(!uuid(row?.linkId)||!id(row.threadId)||typeof row.linked!=='boolean'||typeof row.available!=='boolean'||ids.has(row.linkId)||threads.has(row.threadId))invalid();
    if(row.available){if(typeof row.title!=='string'||!row.title.trim()||row.title.length>240||/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(row.title)||row.href!==href(row.threadId))invalid();}
    else if(row.title!==null||row.href!==null)invalid();
    ids.add(row.linkId);threads.add(row.threadId);return{linkId:row.linkId,threadId:row.threadId,linked:row.linked,available:row.available,title:row.title,href:row.href};
  });return{proposalId,canManage:value.canManage,links};
}
function hubOrigin(value){
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u001f\u007f-\u009f]/.test(value))return null;
  try{const url=new URL(value);return !url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))?url.origin:null;}catch{return null;}
}
function targetId(value,origin){
  if(typeof value!=='string'||value.length>2048||/[\u0000-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))return null;
  const input=value.trim();if(id(input))return input;if(!origin||input.startsWith('//')||input.includes('\\'))return null;
  try{const url=new URL(input,origin);if(url.origin!==origin||url.username||url.password||!['http:','https:'].includes(url.protocol))return null;
    const rawPath=input.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i,'').split(/[?#]/)[0];
    const match=url.pathname.match(/^\/(?:v2\/)?threads\/([^/]+)\/?$/),target=match&&decodeURIComponent(match[1]);return id(target)&&rawPath===url.pathname&&url.pathname===`/${url.pathname.startsWith('/v2/')?'v2/':''}threads/${encodeURIComponent(target)}${url.pathname.endsWith('/')?'/':''}`?target:null;
  }catch{return null;}
}

export function researchProposalDiscussions(target,reference,options={}){
  reference={projectId:reference?.projectId,proposalId:reference?.proposalId};
  const d=target.ownerDocument,root=node(d,'section',null,'research-proposal-discussions research-editor'),storage=options.state??{},entries=storage.proposalDiscussions??={},key=JSON.stringify([reference.projectId,reference.proposalId]),state=entries[key]??={};
  target.append(root);let active=true,currentOrigin=null;
  const valid=()=>!state.invalidated&&entries[key]===state,live=()=>active&&valid(),sync=()=>state.sync?.();
  const fail=e=>{const message=String(e?.message??e).replace(/^research_proposal_(?:link|unlink)_rejected:(?:400|401|403|404|409):/,'');return options.friendlyError?.(message)??message;};
  function button(label,run){const n=node(d,'button',label,'head-action');n.type='button';n.onclick=()=>{if(live())return run();};return n;}
  function clearReader(){delete state.data;delete state.input;state.readToken={};state.loading=false;state.blocked=true;if(!state.uncertain&&!state.sending)delete state.operation;sync();}
  function replacementKnown(){const operation=state.operation,current=state.data?.links.find(row=>row.threadId===operation?.options.threadId);return Boolean(state.conflicted&&state.uncertain&&!state.loading&&!state.sending&&!state.blocked&&state.data?.canManage&&current&&(operation.action==='link'?current.linkId!==operation.options.requestId&&current.linkId!==operation.options.expectedLinkId:current.linkId!==operation.options.linkId));}
  function render(){
    if(!live())return;root.replaceChildren(node(d,'h4','関連する公開スレッド'),node(d,'p','公開スレッドの議論を参照できます。関連付けは本文や変更の理由をスレッドへ転記しません。','meta'));
    const notice=node(d,'p',state.error||state.notice||'',state.error?'meta warning':'meta');notice.setAttribute('role','status');root.append(notice);
    if(state.loading)root.append(node(d,'p','関連スレッドを確認しています…','meta'));
    if(state.needsConnection&&options.connectAccount)root.append(button('Desktopを接続',options.connectAccount));
    const data=state.data;
    if(data){
      const list=node(d,'ul',null,'research-links'),visible=data.links.filter(row=>row.linked);
      for(const row of visible){const item=node(d,'li',null,'research-link-row');
        if(row.available){const a=node(d,'a',row.title);a.href=row.href;if(options.openThread)a.onclick=e=>{e.preventDefault();if(live())return options.openThread({id:row.threadId,title:row.title});};item.append(a);}
        else item.append(node(d,'p','公開スレッドを現在確認できません。','meta'),node(d,'code',row.threadId));
        if(data.canManage){const remove=button('関連付けを解除',()=>previewUnlink(row));remove.disabled=Boolean(state.operation||state.sending||state.loading);item.append(remove);}list.append(item);
      }root.append(list);if(!visible.length)root.append(node(d,'p','関連する公開スレッドはありません。','meta'));
      if(!data.canManage)root.append(node(d,'p','関連付けの追加・解除にはプロジェクト所有者の権限が必要です。','meta'));
      else if(!state.operation){const form=node(d,'form',null,'research-edit-form'),label=node(d,'label','公開スレッドのURLまたはID'),input=node(d,'input');input.name='thread';input.type='text';input.maxLength=2048;input.required=true;input.value=state.input??'';input.disabled=Boolean(state.loading||state.sending);input.oninput=()=>{if(live()&&!state.operation&&!state.loading&&!state.sending)state.input=input.value;};label.append(input);
        const review=node(d,'button','関連付けを確認');review.type='submit';review.disabled=input.disabled;form.append(label,review);form.onsubmit=e=>{e.preventDefault();if(!live()||state.operation||state.loading||state.sending||!state.data?.canManage)return;const threadId=targetId(input.value,currentOrigin);state.input=input.value;
          if(!threadId){state.error='公開HubスレッドのURLまたはIDを入力してください。';sync();return;}
          const prior=state.data.links.find(row=>row.threadId===threadId);if(prior?.linked){state.error='このスレッドは関連付け済みです。';sync();return;}
          state.operation={action:'link',options:Object.freeze({proposalId:reference.proposalId,requestId:crypto.randomUUID(),threadId,expectedLinkId:prior?.linkId??null})};state.error='';state.notice='';sync();
        };root.append(form);}
    }
    if(state.operation){const operation=state.operation,preview=node(d,'section',null,'research-proposal-preview');preview.dataset.researchProposalDiscussionPreview='';preview.append(node(d,'h5',operation.action==='link'?'関連付けの確認':'解除の確認'),node(d,'p',operation.action==='link'?'この公開スレッドを提案の議論として関連付けます。スレッドの本文や提案の理由は変更しません。':'この提案との関連付けだけを解除します。スレッドは削除しません。'),node(d,'code',operation.options.threadId),node(d,'a',href(operation.options.threadId)));
      preview.querySelector('a').href=href(operation.options.threadId);if(state.uncertain)preview.append(node(d,'p','操作結果が不明です。対象と操作IDを変えずに同じ操作の結果を確認してください。','meta'));
      const save=button(state.uncertain?'同じ関連操作の結果を確認する':operation.action==='link'?'確認して関連付けを保存':'確認して関連付けを解除',()=>mutate());save.dataset.researchProposalDiscussionExecute='';save.disabled=Boolean(state.loading||state.sending||!data?.canManage||state.blocked);preview.append(save);
      if(replacementKnown()){preview.append(node(d,'p','関連付けは別の操作で更新されています。現在の状態を確認して、以前の操作を閉じます。再送しません。','meta'),button('現在の関連を確認して操作を閉じる',()=>{
        if(!replacementKnown())return;delete state.operation;delete state.uncertain;delete state.conflicted;delete state.input;state.error='';state.notice='以前の操作を閉じました。再送していません。現在の関連付けは変更していません。';sync();
      }));}
      if(!state.uncertain&&!state.sending)preview.append(button('入力に戻る',()=>{delete state.operation;sync();}));root.append(preview);
    }
    const read=button('関連スレッドを再確認',()=>load());read.disabled=Boolean(state.sending);root.append(read);
  }
  function previewUnlink(row){if(!live()||state.operation||state.sending||state.loading||!state.data?.canManage)return;const current=state.data.links.find(item=>item.linkId===row.linkId&&item.threadId===row.threadId&&item.linked);if(!current)return;
    state.operation={action:'unlink',options:Object.freeze({proposalId:reference.proposalId,linkId:row.linkId,threadId:row.threadId})};state.error='';state.notice='';sync();}
  async function mutate(){
    if(!live()||state.sending||state.loading||state.blocked||!state.data?.canManage||!state.operation)return;
    const operation=state.operation,wasUncertain=state.uncertain;state.sending=true;state.change=(state.change??0)+1;state.error='';sync();
    try{const response=await options.invoke('hub_client_action',{action:`research_proposal_${operation.action}`,target:reference.projectId,options:operation.options});if(!valid())return;
      if(response?.proposalId!==reference.proposalId||response.threadId!==operation.options.threadId||!uuid(response.linkId)||response.linkId!==(operation.action==='link'?operation.options.requestId:operation.options.linkId)||typeof response.linked!=='boolean'||(operation.action==='unlink'&&response.linked!==false))throw Error('関連操作の結果を確認できません。同じ操作で再試行してください。');
      const row=state.data?.links.find(item=>item.threadId===response.threadId),replacement={linkId:response.linkId,threadId:response.threadId,linked:response.linked,available:row?.linkId===response.linkId?row.available:false,title:row?.linkId===response.linkId?row.title:null,href:row?.linkId===response.linkId?row.href:null};
      if(state.data)state.data={...state.data,links:[...state.data.links.filter(item=>item.threadId!==response.threadId),replacement]};
      state.notice=operation.action==='unlink'?'関連付けの解除は保存済みです。':response.linked?'関連付けは保存済みです。タイトルは再確認で取得できます。':'この関連付けはすでに解除されています。再び関連付けていません。';delete state.operation;delete state.input;delete state.conflicted;state.uncertain=false;state.change++;state.needsRead=true;
    }catch(error){if(!valid())return;if(/接続が変わりました/.test(String(error?.message??error))){invalidate();return;}
      const confirmed=new RegExp(`^research_proposal_${operation.action}_rejected:(?:400|403|404|409):`).test(String(error?.message??error));state.uncertain=Boolean(wasUncertain||!confirmed);state.error=fail(error);
      if(wasUncertain&&new RegExp(`^research_proposal_${operation.action}_rejected:409:`).test(String(error?.message??error)))state.conflicted=true;
      if(!state.uncertain)delete state.operation;if(denied(error)||confirmed)clearReader();state.needsConnection=/desktop_not_connected|ハブが 401 を返しています/.test(String(error?.message??error));
    }finally{if(valid()){state.sending=false;sync();if(!active)d.defaultView?.removeEventListener('hub-account-changed',invalidate);}}
  }
  async function load(){
    if(!live()||state.sending)return;
    const token={},change=state.change??0;state.readToken=token;state.loading=true;state.error='';delete state.data;sync();
    try{if(!id(reference.projectId)||!uuid(reference.proposalId))invalid();const value=await options.invoke('hub_detail',{name:'research_proposal_discussions',ids:[reference.projectId,reference.proposalId]});if(!valid()||state.readToken!==token||change!==(state.change??0))return;
      const data=parse(value,reference.proposalId);state.data=data;state.blocked=false;state.needsConnection=false;state.needsRead=false;
      if(!data.canManage){delete state.input;if(!state.uncertain)delete state.operation;}
      if(state.operation&&!state.uncertain){const op=state.operation,row=data.links.find(item=>item.threadId===op.options.threadId);if(op.action==='unlink'?(!row?.linked||row.linkId!==op.options.linkId):(row?.linked||(row?.linkId??null)!==op.options.expectedLinkId))delete state.operation;}
    }catch(error){if(valid()&&state.readToken===token){clearReader();state.error=fail(error);state.needsConnection=/desktop_not_connected|ハブが 401 を返しています/.test(String(error?.message??error));sync();}}
    finally{if(valid()&&state.readToken===token){state.loading=false;delete state.readToken;sync();}if(!active&&!state.sending)d.defaultView?.removeEventListener('hub-account-changed',invalidate);}
  }
  function invalidate(){currentOrigin=null;for(const entry of Object.values(entries)){const notify=entry.sync;for(const name of Object.keys(entry))delete entry[name];entry.invalidated=true;notify?.();}for(const name of Object.keys(entries))delete entries[name];if(active)root.replaceChildren(node(d,'p','接続が変わりました。関連スレッドを読み直してください。','meta'));d.defaultView?.removeEventListener('hub-account-changed',invalidate);}
  function dispose(){if(!active)return;active=false;if(!state.sending&&!state.loading)d.defaultView?.removeEventListener('hub-account-changed',invalidate);if(state.sync===render)delete state.sync;for(const control of root.querySelectorAll('button,input'))control.disabled=true;}
  d.defaultView?.addEventListener('hub-account-changed',invalidate);state.sync=render;render();
  const originReady=Promise.resolve().then(()=>options.invoke('hub_origin')).then(value=>{if(live())currentOrigin=hubOrigin(value);},()=>{});
  const ready=Promise.all([load(),originReady]);return{root,ready,dispose,invalidate,clearReader};
}
