const kinds={question:'質問',issue:'不具合報告',discussion:'議題整理'};
const projectId=value=>typeof value==='string'&&/^rp_[a-f0-9]{32}$/.test(value);
const oid=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const wellFormed=value=>!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);
const metadata=value=>typeof value==='string'&&value.trim().length>0&&value.length<=240&&!/[\u0000-\u001f\u007f]/u.test(value)&&wellFormed(value);
const node=(d,tag,text,cls)=>{const value=d.createElement(tag);if(text!=null)value.textContent=text;if(cls)value.className=cls;return value;};
const button=(d,text,run)=>{const value=node(d,'button',text);value.type='button';value.onclick=run;return value;};
export function formatResearchGitDiscussionBody(source,body) {
  return `${body.trim()}\n\n参照Git: ${source.projectTitle} / ${source.subject}\n${source.oid}\n${source.href}`;
}
function preparation(value,reference) {
  const raw=value?.source;
  if(!raw||Array.isArray(raw)||raw.projectId!==reference.projectId||raw.oid!==reference.oid
    ||!metadata(raw.projectTitle)||!metadata(raw.subject)
    ||raw.href!==`/v2/research/${reference.projectId}?commit=${reference.oid}#git`
    ||!Array.isArray(value.boards)||typeof value.canLink!=='boolean'
    ||value.boards.some(board=>!board||typeof board.key!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(board.key)||!metadata(board.title))
    ||new Set(value.boards.map(board=>board.key)).size!==value.boards.length)throw new Error('公開されたGit変更を確認できません。');
  return {source:{projectId:raw.projectId,projectTitle:raw.projectTitle,oid:raw.oid,subject:raw.subject,href:raw.href},boards:value.boards.map(({key,title})=>({key,title})),canLink:value.canLink};
}
export function researchGitDiscussion(target,reference,options={}) {
  const d=target.ownerDocument,root=node(d,'section',null,'research-git-discussion research-discussion research-project-detail');target.append(root);
  reference={projectId:reference?.projectId,oid:reference?.oid};
  const storage=options.state??{},entries=storage.gitDiscussions??(storage.gitDiscussions={}),key=JSON.stringify([reference.projectId,reference.oid]),state=entries[key]??(entries[key]={});
  let active=true;
  const valid=()=>!state.invalidated&&entries[key]===state;
  const live=()=>active&&valid();
  const refresh=()=>state.refresh?.();
  const fail=error=>{const message=String(error?.message??error).replace(/^research_git_discuss_rejected:(400|404|409):/,'');return options.friendlyError?.(message)??message;};
  const render=()=>{
    if(!active)return;
    if(!valid()){root.replaceChildren(node(d,'p','接続が変わりました。画面を読み直してください。','meta'));return;}
    root.replaceChildren(node(d,'h3','公開Git変更を参照して検証する'));
    root.append(node(d,'p','自分の質問・検証内容と固定コミットの短い参照を投稿します。差分や変更説明は自動で転載しません。','meta'));
    const status=node(d,'p',state.error??'',state.error?'meta warning':'meta');status.setAttribute('role','status');root.append(status);
    if(state.needsConnection&&options.connectAccount){const connect=button(d,'Desktopを接続',()=>{if(live())return options.connectAccount();});connect.dataset.researchGitDiscussionConnect='';root.append(connect);}
    const pinned=state.locked&&state.preview?state.preview.payload.source:null;
    const source=state.createdSource??pinned??state.prepared?.source;
    if(source)root.append(node(d,'p',`${source.projectTitle} / ${source.subject}`,'meta'),node(d,'code',source.oid));
    if(projectId(reference.projectId)&&oid(reference.oid)&&options.openCommit)root.append(button(d,'元のコミットへ戻る',()=>{if(live())return options.openCommit(reference.projectId,reference.oid);}));
    if(state.created){
      root.append(node(d,'p','スレッドを作成しました。','meta'),button(d,'作成したスレッドを開く',()=>{if(live())return options.openThread?.(state.created);}));
      if(!state.prepared){
        root.append(node(d,'p','関連付けには現在の公開状態と権限の確認が必要です。','meta'));
        const read=button(d,'関連付けの可否を確認',()=>load(true));read.disabled=Boolean(state.loading);root.append(read);
      }else if(state.prepared.canLink===true){
        const link=button(d,state.linked?'関連付け済み':'プロジェクトへ関連付ける',async()=>{
          if(!live()||state.linking||state.linked||!state.prepared?.canLink)return;
          state.linking=true;state.error='';refresh();
          try{
            await options.invoke('hub_client_action',{action:'research_link',target:reference.projectId,options:{kind:'thread',targetId:state.created.id}});
            if(valid())state.linked=true;
          }catch(error){if(valid())state.error=fail(error);}
          finally{if(valid()){state.linking=false;refresh();}}
          if(live()&&state.linked)try{await options.reload?.();}catch(error){if(valid()){state.error=`関連付け済みです。表示の更新に失敗しました: ${fail(error)}`;refresh();}}
        });link.dataset.researchGitDiscussionLink='';link.disabled=Boolean(state.linked||state.linking||state.loading);root.append(link);
      }
      return;
    }
    if(!state.prepared&&!pinned){
      if(state.loading)status.textContent='公開されたGit変更と投稿先を確認しています…';
      else root.append(button(d,'公開コミットを再確認',()=>load(true)));
      return;
    }
    const boards=pinned?[{key:state.preview.payload.boardKey,title:state.preview.boardTitle}]:state.prepared.boards;
    if(!boards.length){root.append(node(d,'p','投稿できる掲示板がありません。','meta'),button(d,'投稿先を再確認',()=>load(true)));return;}
    const form=node(d,'form',null,'research-edit-form'),controls=[];
    const field=(name,labelText,tag,max)=>{
      const label=node(d,'label',labelText),input=node(d,tag);input.name=name;input.required=true;
      if(max)input.maxLength=max;input.value=state[name]??'';
      input.oninput=()=>{if(!live()||state.locked||state.sending)return;state[name]=input.value;state.preview=undefined;preview.hidden=create.hidden=true;};
      controls.push(input);label.append(input);form.append(label);return input;
    };
    const title=field('title','スレッドの題（8〜100文字）','input',100),body=field('body','検証したい内容（30文字以上。参照を含め4000文字まで）','textarea',4000);body.rows=8;
    const board=field('boardKey','投稿先の板','select');
    for(const item of boards){const option=node(d,'option',item.title);option.value=item.key;board.append(option);}
    board.value=boards.some(item=>item.key===state.boardKey)?state.boardKey:boards[0].key;
    const kind=field('threadType','スレッドの種別','select');
    for(const [value,label] of Object.entries(kinds)){const option=node(d,'option',label);option.value=value;kind.append(option);}kind.value=Object.hasOwn(kinds,state.threadType)?state.threadType:'discussion';
    const review=node(d,'button','投稿全文を確認');review.type='submit';review.dataset.researchGitDiscussionPreview='';controls.push(review);form.append(review);root.append(form);
    const preview=node(d,'section',null,'research-discussion-preview');
    const create=button(d,state.locked?'同じ内容で作成結果を確認する':'確認してスレッドを作成',async()=>{
      if(!live()||state.created||state.sending||!state.preview)return;
      const snapshot=state.preview,wasUncertain=state.uncertain;
      state.locked=true;state.sending=true;state.error='';refresh();
      try{
        const result=await options.invoke('hub_client_action',{action:'research_git_discuss',target:reference.projectId,options:snapshot.payload});
        if(!valid())return;
        if(result?.thread?.id!==snapshot.payload.requestId)throw new Error('作成結果を確認できません。同じ内容で再試行してください。');
        state.created={id:result.thread.id,title:snapshot.payload.title};state.createdSource=snapshot.payload.source;state.preview=undefined;state.uncertain=false;
      }catch(error){
        if(valid()){
          state.error=fail(error);const rejected=/^research_git_discuss_rejected:(400|404|409):/.test(String(error?.message??error));
          state.uncertain=Boolean(wasUncertain||!rejected);state.locked=state.uncertain;
          if(!state.uncertain){state.preview=undefined;state.prepared=undefined;state.needsPreparation=true;}
        }
      }finally{if(valid()){state.sending=false;refresh();}}
    });create.dataset.researchGitDiscussionCreate='';create.disabled=Boolean(state.sending);preview.hidden=create.hidden=!state.preview;
    if(state.preview)preview.append(node(d,'h4',state.preview.payload.title),node(d,'p',`${state.preview.boardTitle} · ${kinds[state.preview.payload.threadType]} · アカウント名 · 日本語 · 全地域 · 公開`,'meta'),node(d,'pre',state.preview.finalBody,'research-document-body'));
    root.append(preview,create);for(const control of controls)control.disabled=Boolean(state.locked||state.sending||state.loading);
    if(state.uncertain)status.textContent=`${state.error??''}\n作成結果が不明です。内容を変えずに同じ操作を再試行してください。`;
    form.onsubmit=event=>{
      event.preventDefault();if(!live()||state.locked||state.sending||state.loading||state.created||!state.prepared)return;
      try{
        const titleValue=title.value.trim(),bodyValue=body.value.trim(),boardItem=state.prepared.boards.find(item=>item.key===board.value);
        if(titleValue.length<8||titleValue.length>100||bodyValue.length<30||bodyValue.length>4000||!wellFormed(titleValue)||!wellFormed(bodyValue)||!boardItem||!Object.hasOwn(kinds,kind.value))throw new Error('題・本文・投稿先・種別を確認してください。');
        const finalBody=formatResearchGitDiscussionBody(state.prepared.source,bodyValue);if(finalBody.length>4000)throw new Error('参照を含む投稿全文を4000文字以内にしてください。');
        const content={oid:reference.oid,source:Object.freeze({...state.prepared.source}),title:titleValue,body:bodyValue,boardKey:board.value,threadType:kind.value},fingerprint=JSON.stringify(content);
        const requestId=state.preview?.fingerprint===fingerprint?state.preview.payload.requestId:crypto.randomUUID();
        state.title=title.value;state.body=body.value;state.boardKey=board.value;state.threadType=kind.value;
        state.preview={payload:Object.freeze({...content,requestId}),fingerprint,finalBody,boardTitle:boardItem.title,canLink:state.prepared.canLink};state.error='';refresh();
      }catch(error){state.preview=undefined;state.error=fail(error);refresh();}
    };
  };
  const load=async(force=false)=>{
    if(!live())return;
    const token={};state.readToken=token;state.loading=true;state.prepared=undefined;state.error='';state.needsConnection=false;refresh();
    try{
      if(!projectId(reference.projectId)||!oid(reference.oid))throw new Error('Git変更の指定が正しくありません。');
      const value=(!force&&!state.needsPreparation&&options.prepared)||await options.invoke('hub_detail',{name:'research_git_discussion',ids:[reference.projectId,reference.oid]});
      if(!valid()||state.readToken!==token)return;
      const prepared=preparation(value,reference);state.prepared=prepared;state.needsPreparation=false;
      if(state.preview&&!state.locked&&(JSON.stringify(state.preview.payload.source)!==JSON.stringify(prepared.source)||prepared.canLink!==state.preview.canLink||!prepared.boards.some(board=>board.key===state.preview.payload.boardKey&&board.title===state.preview.boardTitle)))state.preview=undefined;
    }catch(error){
      if(valid()&&state.readToken===token){state.prepared=undefined;state.needsPreparation=true;state.error=fail(error);state.needsConnection=/desktop_not_connected|ハブが\s*401\s*を返/.test(String(error?.message??error));if(!state.locked)state.preview=undefined;}
    }finally{if(valid()&&state.readToken===token){state.loading=false;delete state.readToken;refresh();}}
  };
  const invalidate=()=>{
    for(const entry of Object.values(entries)){
      const notify=entry.refresh;for(const name of Object.keys(entry))delete entry[name];entry.invalidated=true;notify?.();
    }
    for(const name of Object.keys(entries))delete entries[name];
  };
  const dispose=()=>{if(!active)return;active=false;d.defaultView?.removeEventListener('hub-account-changed',invalidate);if(state.refresh===render)delete state.refresh;for(const control of root.querySelectorAll('button,input,textarea,select'))control.disabled=true;};
  d.defaultView?.addEventListener('hub-account-changed',invalidate);state.refresh=render;render();const ready=load();
  return {root,ready,state,invalidate,dispose};
}
