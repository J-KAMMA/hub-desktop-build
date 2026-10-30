const kinds={question:'質問',issue:'課題・不具合',discussion:'議論'};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const version=value=>Number.isSafeInteger(value)&&value>0;
const node=(d,tag,text,cls)=>{const n=d.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const button=(d,text,run)=>{const n=node(d,'button',text);n.type='button';n.onclick=run;return n;};
export function formatResearchDiscussionBody(source,body) {
  return `${body.trim()}\n\n参照: ${source.projectTitle} / ${source.title} · v${source.version}\n${source.contentHash}\n${source.href}`;
}
function preparedSource(value,reference) {
  const raw=value?.source;
  if(!raw||raw.projectId!==reference.projectId||raw.documentId!==reference.documentId||raw.version!==reference.version
    ||typeof raw.projectTitle!=='string'||typeof raw.title!=='string'||!/^sha256:[0-9a-f]{64}$/.test(raw.contentHash)
    ||raw.href!==`/v2/research/${encodeURIComponent(reference.projectId)}?document=${encodeURIComponent(reference.documentId)}&version=${reference.version}`)throw new Error('公開された文書の版を確認できません。');
  return {projectId:raw.projectId,projectTitle:raw.projectTitle,documentId:raw.documentId,title:raw.title,version:raw.version,contentHash:raw.contentHash,href:raw.href};
}
export function researchDiscussion(target,reference,options={}) {
  const d=target.ownerDocument,root=node(d,'section',null,'research-discussion research-project-detail');target.append(root);
  const key=JSON.stringify([reference.projectId,reference.documentId,reference.version]),drafts=options.state??{},states=drafts.discussions??(drafts.discussions={}),state=states[key]??(states[key]={});
  let active=true,prepared;
  const fail=error=>{const message=String(error?.message??error).replace(/^research_discuss_rejected:(400|404|409):/,'');return options.friendlyError?.(message)??message;};
  const check=()=>{if(!active)throw new Error('接続が変わりました。画面を読み直してください。');};
  const render=()=>{
    if(!active)return;
    root.replaceChildren(node(d,'h3','公開文書の版を参照して議論する'));
    const status=node(d,'p',state.error??'',state.error?'meta warning':'meta');status.setAttribute('role','status');root.append(status);
    if(!prepared||state.needsPreparation){
      if(state.loading)status.textContent='公開された参照と投稿先を確認しています…';
      else root.append(button(d,'参照を読み直す',()=>load(true)));
      return;
    }
    const source=prepared.source;
    root.append(node(d,'p',`${source.projectTitle} / ${source.title} · v${source.version}`,'meta'),node(d,'code',source.contentHash));
    if(state.created){
      root.append(node(d,'p','スレッドを作成しました。','meta'),button(d,'作成したスレッドを開く',()=>options.openThread?.(state.created)));
      if(options.openRevision)root.append(button(d,`参照したv${source.version}へ戻る`,()=>options.openRevision(source.projectId,source.documentId,source.version,source.title)));
      if(prepared.canLink===true){
        const link=button(d,state.linked?'関連付け済み':'プロジェクトへ関連付ける',async()=>{
          if(state.linking||state.linked||!active)return;state.linking=true;state.error='';render();
          try{await options.invoke('hub_client_action',{action:'research_link',target:reference.projectId,options:{action:'link',kind:'thread',targetId:state.created.id}});check();state.linked=true;}
          catch(error){if(active)state.error=fail(error);}
          finally{state.linking=false;state.refresh();}
          if(state.linked)try{await options.reload?.();}catch(error){if(active){state.error=`関連付け済みです。表示の更新に失敗しました: ${fail(error)}`;render();}}
        });link.dataset.researchDiscussionLink='';link.disabled=Boolean(state.linked||state.linking);root.append(link);
      }
      return;
    }
    if(!prepared.boards.length){root.append(node(d,'p','投稿できる掲示板がありません。','meta'));return;}
    const form=node(d,'form',null,'research-edit-form'),controls=[];
    const field=(name,title,tag,max)=>{
      const label=node(d,'label',title),input=node(d,tag);input.name=name;
      if(max)input.maxLength=max;input.required=true;input.value=state[name]??'';
      input.oninput=()=>{if(state.locked)return;state[name]=input.value;state.preview=undefined;preview.hidden=true;create.hidden=true;};
      controls.push(input);label.append(input);form.append(label);return input;
    };
    const title=field('title','タイトル（8〜100文字）','input',100),body=field('body','本文（30文字以上。参照を含め4000文字まで）','textarea',4000);body.rows=8;
    const board=field('boardKey','投稿先','select');
    for(const item of prepared.boards){const option=node(d,'option',item.title);option.value=item.key;board.append(option);}
    board.value=prepared.boards.some(item=>item.key===state.boardKey)?state.boardKey:prepared.boards[0].key;
    const kind=field('threadType','種類','select');
    for(const [value,text] of Object.entries(kinds)){const option=node(d,'option',text);option.value=value;kind.append(option);}kind.value=Object.hasOwn(kinds,state.threadType)?state.threadType:'question';
    const review=node(d,'button','全文を確認');review.type='submit';review.dataset.researchDiscussionPreview='';controls.push(review);form.append(review);root.append(form);
    const preview=node(d,'div',null,'research-discussion-preview'),create=button(d,state.locked?'同じ内容で作成結果を確認する':'この内容でスレッドを作成',async()=>{
      if(state.created||state.sending||!state.preview||!active)return;const snapshot=state.preview,wasUncertain=state.uncertain;
      state.locked=true;state.sending=true;state.error='';render();
      try{
        const result=await options.invoke('hub_client_action',{action:'research_discuss',target:reference.projectId,options:snapshot.payload});check();
        const created=result?.thread??result;
        if(!id(created?.id))throw new Error('作成結果を確認できません。同じ内容で再試行してください。');
        state.created={id:created.id,title:typeof created.title==='string'?created.title:snapshot.payload.title};state.uncertain=false;
      }catch(error){if(active){state.error=fail(error);const rejected=/^research_discuss_rejected:(400|404|409):/.test(String(error?.message??error));state.uncertain=wasUncertain||!rejected;state.locked=state.uncertain;if(!state.uncertain){state.preview=undefined;state.needsPreparation=true;prepared=undefined;}}}
      finally{state.sending=false;state.refresh();}
    });create.dataset.researchDiscussionCreate='';create.disabled=Boolean(state.sending);
    preview.hidden=create.hidden=!state.preview;
    if(state.preview){preview.append(node(d,'h4',state.preview.payload.title),node(d,'p',`${state.preview.boardTitle} · ${kinds[state.preview.payload.threadType]}`,'meta'),node(d,'p','アカウント名で投稿 · 日本語 · 全地域 · 公開','meta'),node(d,'pre',state.preview.finalBody,'research-document-body'));}
    root.append(preview,create);for(const input of controls)input.disabled=Boolean(state.locked||state.sending);
    if(state.uncertain)status.textContent=`${state.error}\n作成結果が不明です。内容を変えずに同じ操作を再試行してください。`;
    form.onsubmit=event=>{
      event.preventDefault();if(state.locked||state.created||!active)return;
      try{
        const titleValue=title.value.trim(),bodyValue=body.value.trim(),boardItem=prepared.boards.find(item=>item.key===board.value);
        if(titleValue.length<8||titleValue.length>100||bodyValue.length<30||bodyValue.length>4000||!boardItem||!Object.hasOwn(kinds,kind.value))throw new Error('タイトル・本文・投稿先・種類を確認してください。');
        const finalBody=formatResearchDiscussionBody(source,bodyValue);if(finalBody.length>4000)throw new Error('参照を含む本文を4000文字以内にしてください。');
        const content={action:'discuss',documentId:reference.documentId,version:reference.version,source:{...source},title:titleValue,body:bodyValue,boardKey:board.value,threadType:kind.value};
        const fingerprint=JSON.stringify(content),requestId=state.preview?.fingerprint===fingerprint?state.preview.payload.requestId:crypto.randomUUID();
        state.title=title.value;state.body=body.value;state.boardKey=board.value;state.threadType=kind.value;
        state.preview={payload:{...content,requestId},fingerprint,finalBody,boardTitle:boardItem.title};state.error='';render();
      }catch(error){state.preview=undefined;state.error=fail(error);render();}
    };
  };
  const load=async(force=false)=>{
    if(!active)return;state.loading=true;state.error='';render();
    try{
      if(!id(reference.projectId)||!id(reference.documentId)||!version(reference.version))throw new Error('文書の版が正しくありません。');
      const value=(!force&&!state.needsPreparation&&options.prepared)||await options.invoke('hub_detail',{name:'research_discussion',ids:[reference.projectId,reference.documentId,String(reference.version)]});check();
      const source=preparedSource(value,reference),boards=(value.boards??[]).filter(item=>id(item.key)&&typeof item.title==='string');
      prepared={source,boards,canLink:value.canLink===true};state.needsPreparation=false;
      if(state.preview&&!state.locked&&(JSON.stringify(state.preview.payload.source)!==JSON.stringify(source)||!boards.some(item=>item.key===state.preview.payload.boardKey)))state.preview=undefined;
    }catch(error){if(active){state.error=fail(error);prepared=undefined;}}
    finally{state.loading=false;state.refresh();}
  };
  const invalidate=()=>{active=false;delete states[key];root.replaceChildren(node(d,'p','接続が変わりました。画面を読み直してください。','meta'));};
  d.defaultView?.addEventListener('hub-account-changed',invalidate,{once:true});
  state.refresh=render;render();const ready=load();return {root,ready,state,invalidate};
}
