import {parseResearchChangePackage} from "./research-change-package.mjs";
const kinds = {paper:'論文',software:'コード',dataset:'データ',notebook:'ノート'};
const linkKinds = {article:'記事',video:'動画',music:'音楽',hubpedia:'資料・知識',thread:'スレッド',community:'コミュニティ'};
const node = (d,tag,text,cls) => { const n=d.createElement(tag); if(text!=null)n.textContent=text; if(cls)n.className=cls; return n; };
const button = (d,text,run) => {const n=node(d,'button',text);n.type='button';n.onclick=run;return n;};
function disclosure(d,title,key,state) {
  const n=node(d,'details',null,'research-editor');n.open=Boolean(state[key]);n.ontoggle=()=>{state[key]=n.open;};n.append(node(d,'summary',title));return n;
}
function field(d,form,state,key,title,{multiline=false,max=240,options,value='',required=true}={}) {
  const label=node(d,'label',title),input=node(d,options?'select':multiline?'textarea':'input');
  if(options)for(const [id,text] of Object.entries(options)){const item=node(d,'option',text);item.value=id;input.append(item);}
  else {input.maxLength=max;if(!multiline)input.type='text';else input.rows=key==="description"?3:8;}
  input.required=required;input.name=key;input.value=state[key]??(value||(options?Object.keys(options)[0]:''));
  input.oninput=()=>{state[key]=input.value;state[`${key}Selection`]=[input.selectionStart,input.selectionEnd];};
  input.onselect=()=>{state[`${key}Selection`]=[input.selectionStart,input.selectionEnd];};
  input.onfocus=()=>{const range=state[`${key}Selection`];if(range&&input.setSelectionRange)input.setSelectionRange(...range);};
  label.append(input);form.append(label);return input;
}
function form(d,parent,options,label,run) {
  const f=node(d,'form',null,'research-edit-form'),status=node(d,'p',null,'meta');status.setAttribute('role','status');
  const submit=node(d,'button',label);submit.type='submit';
  let pending=false;
  f.onsubmit=async event=>{event.preventDefault();if(pending||!f.reportValidity())return;pending=true;
    const controls=[...f.elements];controls.forEach(n=>{n.disabled=true;});status.textContent='保存しています…';
    try {const saved=await run(status);if(saved===false)status.textContent='変更を中止しました。';else if((globalThis.__hubI18n?.source(status)??status.textContent)==='保存しています…')status.textContent='保存しました。';status.classList.remove('warning');}
    catch(error){status.textContent=options.friendlyError?.(error)??String(error);status.classList.add('warning');}
    finally {pending=false;controls.forEach(n=>{n.disabled=false;});}
  };
  parent.append(f);f.append(submit,status);return f;
}
const putFieldsLast = f => f.append(...[...f.children].filter(n=>n.tagName==='BUTTON'||n.getAttribute('role')==='status'));
export function projectCreation(target,options) {
  const d=target.ownerDocument,state=options.state??{},box=disclosure(d,'プロジェクトを作成','createOpen',state);
  const f=form(d,box,options,'作成',async()=>{
    const result=await options.invoke('hub_client_action',{action:'research_create_project',options:{title:f.elements.title.value,description:f.elements.description.value,visibility:f.elements.visibility.value,defaultLicense:f.elements.defaultLicense.value}});
    for(const key of Object.keys(state))delete state[key];f.reset();box.open=false;await options.openProject(result.project);
  });
  field(d,f,state,'title','タイトル');field(d,f,state,'description','概要',{multiline:true,max:5000,required:false});
  field(d,f,state,'visibility','公開範囲',{options:{confidential:'非公開（自分のみ）',public:'公開'}});
  field(d,f,state,'defaultLicense','ライセンス',{max:200,required:false});
  f.append(node(d,'p','作成先は接続中のHubです。公開を選ぶとタイトルと概要が公開されます。','meta'));putFieldsLast(f);
  target.append(box);return box;
}
export function projectWorkspace(root,data,options={}) {
  const d=root.ownerDocument,{project,workspace={}}=data,state=options.state??{};
  const mutate=async input=>options.invoke('hub_client_action',{action:`research_${input.action}`,target:project.id,options:input});
  const reload=async(status)=>{try{await options.reload?.();}catch(error){status.textContent=`保存済みです。表示の更新に失敗しました: ${options.friendlyError?.(error)??error}`;}};
  if(data.canEdit&&options.invoke) {
    const metadata=disclosure(d,'プロジェクトを編集','metadataOpen',state),meta=state.metadata??(state.metadata={});
    const m=form(d,metadata,options,'変更を保存',async status=>{
      await options.invoke('hub_client_action',{action:'research_update_project',target:project.id,options:{title:m.elements.title.value,description:m.elements.description.value,defaultLicense:m.elements.defaultLicense.value,status:m.elements.status.value}});
      state.metadata={};state.metadataOpen=false;await reload(status);
    });field(d,m,meta,'title','タイトル',{value:project.title});field(d,m,meta,'description','概要',{multiline:true,max:5000,required:false,value:project.description});field(d,m,meta,'defaultLicense','ライセンス',{max:200,required:false,value:project.defaultLicense??''});field(d,m,meta,'status','状態',{options:{draft:'準備中',active:'進行中',paused:'中断中',completed:'完了',withdrawn:'撤回済み'},value:project.status});putFieldsLast(m);root.querySelector('.meta')?.after(metadata);
    const box=disclosure(d,'文書・コードを追加','documentOpen',state),draft=state.document??(state.document={});
    const f=form(d,box,options,'追加',async status=>{
      await mutate({action:'create',title:f.elements.title.value,body:f.elements.body.value,kind:f.elements.kind.value,visibility:f.elements.visibility.value});
      state.document={};f.reset();box.open=false;state.documentOpen=false;await reload(status);
    });
    field(d,f,draft,'title','文書名');field(d,f,draft,'kind','種類',{options:kinds});field(d,f,draft,'visibility','公開範囲',{options:{confidential:'非公開',public:'公開'}});field(d,f,draft,'body','本文・コード',{multiline:true,max:100000});putFieldsLast(f);
    root.querySelector('[data-research-section="文書・コード"]')?.after(box);
  }
  const referenceHeading=root.querySelector('[data-research-section="資料・作品・議論"]');
  if(data.canEdit&&options.invoke&&referenceHeading){
    const box=disclosure(d,'関連資料を追加','linkOpen',state),draft=state.link??(state.link={});
    const search=node(d,'form',null,'research-link-search'),results=node(d,'div',null,'research-link-results'),status=node(d,'p',null,'meta');status.setAttribute('role','status');
    const kind=field(d,search,draft,'kind','種類',{options:linkKinds});const query=field(d,search,draft,'query','検索語',{max:100,required:false});
    const find=node(d,'button','検索');find.type='submit';search.append(find);box.append(search,status,results);
    let revision=0;
    const invalidate=()=>{revision++;results.replaceChildren();status.textContent='';find.disabled=false;};
    for(const input of [kind,query])input.addEventListener('input',invalidate);
    search.onsubmit=async e=>{e.preventDefault();const request=++revision;find.disabled=true;status.textContent='検索しています…';
      try {const payload=await options.invoke('hub_detail',{name:`research_links_${kind.value}`,ids:[project.id,query.value]});if(request!==revision)return;
        const links=payload.links??payload;results.replaceChildren();status.textContent=links.length?`${links.length}件`:'公開された関連資料が見つかりません。';
        for(const item of links){const row=node(d,'div',null,'research-link-row');const open=button(d,item.title,()=>options.openLink?.(item.href));
          const added=(workspace.links??[]).some(l=>l.kind===item.kind&&l.targetId===item.targetId);
          const add=button(d,added?'追加済み':'追加',async()=>{add.disabled=true;
            try{await mutate({action:'link',kind:item.kind,targetId:item.targetId});add.textContent='追加済み';await reload(status);}
            catch(error){status.textContent=options.friendlyError?.(error)??String(error);add.disabled=false;}
          });add.disabled=added;row.append(open,add);results.append(row);
        }
      }catch(error){if(request===revision)status.textContent=options.friendlyError?.(error)??String(error);}
      finally{if(request===revision)find.disabled=false;}
    };
    const pasted=disclosure(d,'URLまたはIDから追加','pasteOpen',draft);
    const paste=form(d,pasted,options,'追加',async status=>{await mutate({action:'link',kind:kind.value,targetId:paste.elements.targetId.value});draft.targetId='';paste.reset();await reload(status);});
    field(d,paste,draft,'targetId','関連先のURLまたはID',{max:1000});putFieldsLast(paste);box.append(pasted);referenceHeading.after(box);
    for(const link of workspace.links??[]){const anchor=[...root.querySelectorAll('a')].find(n=>n.getAttribute('href')===link.href);if(!anchor)continue;
      const remove=button(d,'関連を外す',async()=>{remove.disabled=true;try{await mutate({action:'unlink',kind:link.kind,targetId:link.targetId});await reload(status);}catch(error){status.textContent=options.friendlyError?.(error)??String(error);remove.disabled=false;}});anchor.after(remove);
    }
  }
  if((workspace.proposals??[]).length){
    const section=node(d,'section',null,'research-proposals');section.dataset.researchSection='変更提案';section.append(node(d,'h3','変更提案'));
    for(const p of workspace.proposals){const item=disclosure(d,`${p.summary} · v${p.baseVersion} · ${p.status==='open'?'確認待ち':p.status==='accepted'?'採用済み':'見送り済み'}`,`proposal_${p.id}`,state);
      const doc=(workspace.documents??[]).find(doc=>doc.id===p.documentId);
      item.append(node(d,'p',doc?.title??'文書の変更提案','meta'));
      const compare=button(d,'比較して確認',()=>options.openProposal?.(project.id,p.id));compare.disabled=!options.openProposal;item.append(compare);
      if(options.openDiscussion&&project.visibility==='public'&&doc?.visibility==='public')item.append(button(d,`元のv${p.baseVersion}について議論する`,()=>options.openDiscussion(project.id,p.documentId,p.baseVersion,'参照した版について議論')));
      section.append(item);
    }root.append(section);
  }
}
function proposalSubmission(root, data, options, storage) {
  const d=root.ownerDocument,doc=data.document,revision=data.revision,key=JSON.stringify([doc.projectId,doc.id]),entries=storage.proposalSubmissions??(storage.proposalSubmissions={});
  const previous=storage.edit;
  const draft=entries[key]??(entries[key]=previous&&!previous.target?previous:{});storage.edit=draft;draft.target=key;
  if(draft.baseVersion===undefined)draft.baseVersion=revision.version;
  const box=node(d,'details',null,'research-editor research-proposal-create');box.open=Boolean(storage.editOpen||draft.review||draft.saved);box.append(node(d,'summary','本文を編集して変更を提案'));
  box.ontoggle=()=>{if(live())storage.editOpen=box.open;};root.append(box);
  let active=true;
  const valid=()=>!draft.invalidated&&entries[key]===draft;
  const live=()=>active&&valid();
  const refresh=()=>draft.sync?.();
  const fail=error=>{const message=String(error?.message??error).replace(/^research_propose_rejected:(?:400|403|404|409|429):/,'');return options.friendlyError?.(message)??message;};
  const runButton=(label,run)=>button(d,label,()=>{if(live())return run();});
  const uuid=value=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=128&&/^[A-Za-z0-9_.-]+$/.test(value);
  const safeVersion=value=>Number.isSafeInteger(value)&&value>0;
  const baseReady=()=>safeVersion(doc.head)&&revision.version===doc.head&&draft.baseVersion===doc.head;
  const hash=value=>typeof value==='string'&&value.length===71&&/^sha256:[a-f0-9]{64}$/.test(value);
  const render=()=>{
    if(!live())return;
    box.open=Boolean(storage.editOpen||draft.review||draft.saved);box.replaceChildren(node(d,'summary','本文を編集して変更を提案'));
    const status=node(d,'p',draft.error??'',draft.error?'meta warning':'meta');status.setAttribute('role','status');box.append(status);
    if(draft.reloadError)box.append(node(d,'p',draft.reloadError,'meta warning'));
    if(draft.error&&options.reload){const reread=runButton('文書を再読み込み',async()=>{
      if(draft.rereading||draft.sending||draft.preparing)return;draft.rereading=true;delete draft.reloadError;refresh();
      try{await options.reload();}catch(error){if(valid())draft.reloadError=`文書を再読み込みできませんでした: ${fail(error)}`;}
      finally{if(valid()){draft.rereading=false;refresh();}}
    });reread.disabled=Boolean(draft.rereading||draft.sending||draft.preparing);box.append(reread);}
    if(draft.saved){
      box.append(node(d,'p','変更提案は保存済みです。','meta'),node(d,'p',`状態: ${draft.saved.status==='open'?'確認待ち':draft.saved.status==='accepted'?'採用済み':'見送り済み'} · 基準 v${draft.saved.baseVersion}`,'meta'));
      const open=runButton('保存した変更提案を開く',async()=>{
        if(draft.opening)return;draft.opening=true;draft.error='';refresh();
        try{if(!options.openProposal)throw Error('比較詳細を開く導線を利用できません。');await options.openProposal(doc.projectId,draft.saved.proposalId);}
        catch(error){if(valid())draft.error=`変更提案は保存済みです。比較詳細を開けませんでした: ${fail(error)}`;}
        finally{if(valid()){draft.opening=false;refresh();}}
      });open.disabled=Boolean(draft.opening);box.append(open,node(d,'p',`新しい提案は、表示中のv${revision.version}を基準に作成します。`,'meta'));
      const reset=runButton('新しい変更提案を作る',()=>{
        if(!draft.saved||draft.sending||draft.preparing||draft.uncertain||draft.opening)return;
        const sync=draft.sync;for(const name of Object.keys(draft))delete draft[name];draft.target=key;draft.baseVersion=revision.version;draft.sync=sync;storage.editOpen=true;refresh();
      });reset.disabled=Boolean(draft.sending||draft.preparing||draft.uncertain||draft.opening);box.append(reset);return;
    }
    const f=node(d,'form',null,'research-edit-form');
    const body=field(d,f,draft,'body','提案する本文',{multiline:true,max:100000,value:revision.body}),summary=field(d,f,draft,'summary','変更の説明',{max:500});
    for(const control of [body,summary]){
      control.oninput=()=>{if(!live()||draft.locked||draft.sending||draft.preparing)return;draft[control.name]=control.value;draft[`${control.name}Selection`]=[control.selectionStart,control.selectionEnd];delete draft.review;preview.hidden=true;execute.hidden=true;};
      control.onselect=()=>{if(live())draft[`${control.name}Selection`]=[control.selectionStart,control.selectionEnd];};
      control.onfocus=()=>{if(!live())return;const range=draft[`${control.name}Selection`];if(range&&control.setSelectionRange)control.setSelectionRange(...range);};
      control.disabled=Boolean(draft.locked||draft.sending||draft.preparing);
    }
    const review=node(d,'button','提案全文を確認');review.type='submit';review.disabled=Boolean(draft.locked||draft.sending||draft.preparing||!baseReady());review.dataset.researchProposePreview='';f.append(node(d,'p',`基準 v${draft.baseVersion} · 現在の最新版 v${doc.head}。所有者が採用するまで公開本文は変わりません。`,'meta'),review);box.append(f);
    if(!baseReady()&&!draft.locked){
      box.append(node(d,'p','過去の版や以前の基準版のまま新しい変更提案は保存できません。最新版の本文を確認して基準版を更新してください。','meta'));
      if(revision.version===doc.head){
        const rebase=runButton('表示中の最新版を基準にする',()=>{
          if(draft.locked||draft.sending||draft.preparing||draft.uncertain||!safeVersion(doc.head)||revision.version!==doc.head)return;
          draft.baseVersion=revision.version;delete draft.expectedBaseHash;delete draft.review;delete draft.error;delete draft.reloadError;refresh();
        });rebase.disabled=Boolean(draft.sending||draft.preparing);box.append(rebase);
      }else if(options.openRevision){
        const latest=runButton('最新版を確認',()=>{
          if(draft.locked||draft.sending||draft.preparing)return;
          return options.openRevision(doc.projectId,doc.id,doc.head,doc.title);
        });latest.disabled=Boolean(draft.sending||draft.preparing);box.append(latest);
      }
    }
    const preview=node(d,'section',null,'research-proposal-preview'),execute=runButton(draft.locked?'同じ提案の保存結果を確認する':'確認して変更提案を保存',()=>save());preview.dataset.researchProposePreviewBody='';execute.dataset.researchProposeSave='';preview.hidden=execute.hidden=!draft.review;
    if(draft.review){preview.append(node(d,'h4','変更提案の確認'),node(d,'p',`基準 v${draft.review.payload.baseVersion} · 未採用の本文は提案者と所有者だけが確認できます。`,'meta'),node(d,'h4','変更の理由'),node(d,'p',draft.review.payload.summary),node(d,'h4','提案する本文'),node(d,'pre',draft.review.payload.body,'research-document-body'));
      if(draft.uncertain)preview.append(node(d,'p','保存結果が不明です。対象・基準版・本文・理由を変えず、同じ提案の結果を確認してください。','meta'));
      if(!draft.locked)preview.append(runButton('編集に戻る',()=>{delete draft.review;refresh();}));
    }
    execute.disabled=Boolean(draft.sending||draft.preparing||(!draft.locked&&!baseReady()));box.append(preview,execute);
    f.onsubmit=async event=>{
      event.preventDefault();if(!live()||draft.locked||draft.sending||draft.preparing||!baseReady())return;
      const bodyValue=body.value,summaryValue=summary.value.trim(),previousReview=draft.review;
      try{
        if(!safeId(doc.projectId)||!safeId(doc.id)||!safeVersion(draft.baseVersion)||!bodyValue.trim()||bodyValue.length>100000||!summaryValue||summaryValue.length>500||/[\ud800-\udfff]/u.test(bodyValue)||/[\ud800-\udfff]/u.test(summaryValue))throw Error('本文・変更の説明・基準版を確認してください。');
        draft.body=bodyValue;draft.summary=summary.value;draft.preparing=true;draft.error='';refresh();
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bodyValue));
        if(!valid())return;
        const requestId=previousReview&&previousReview.payload.body===bodyValue&&previousReview.payload.summary===summaryValue&&previousReview.payload.baseVersion===draft.baseVersion&&previousReview.payload.expectedBaseHash===draft.expectedBaseHash?previousReview.payload.requestId:crypto.randomUUID();
        const payload=Object.freeze({requestId,documentId:doc.id,baseVersion:draft.baseVersion,body:bodyValue,summary:summaryValue,...(draft.expectedBaseHash?{expectedBaseHash:draft.expectedBaseHash}:{})});
        draft.review={payload,contentHash:'sha256:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')};storage.editOpen=true;if(live())box.open=true;
      }catch(error){if(valid()){delete draft.review;draft.error=fail(error);}}
      finally{if(valid()){draft.preparing=false;refresh();if(!active)d.defaultView?.removeEventListener('hub-account-changed',invalidate);}}
    };
  };
  const save=async()=>{
    if(!live()||draft.saved||draft.sending||draft.preparing||!draft.review||(!draft.locked&&!baseReady()))return;
    const confirmed=draft.review,wasUncertain=draft.uncertain;draft.locked=true;draft.sending=true;draft.error='';refresh();
    try{
      const result=await options.invoke('hub_client_action',{action:'research_propose',target:doc.projectId,options:confirmed.payload});
      if(!valid())return;
      if(!result||!uuid(result.proposalId)||result.proposalId!==confirmed.payload.requestId||result.documentId!==doc.id||result.baseVersion!==confirmed.payload.baseVersion||!hash(result.contentHash)||result.contentHash!==confirmed.contentHash||!['open','accepted','rejected'].includes(result.status))throw Error('提案の保存結果を確認できません。同じ内容で再試行してください。');
      draft.saved={proposalId:result.proposalId,documentId:result.documentId,baseVersion:result.baseVersion,contentHash:result.contentHash,status:result.status};draft.uncertain=false;delete draft.review;delete draft.body;delete draft.summary;delete draft.bodySelection;delete draft.summarySelection;
    }catch(error){if(/接続が変わりました/.test(String(error?.message??error))){invalidate();return;}if(valid()){const rejected=/^research_propose_rejected:(?:400|403|404|409|429):/.test(String(error?.message??error));draft.uncertain=Boolean(wasUncertain||!rejected);draft.locked=draft.uncertain;draft.error=fail(error);}}
    finally{if(valid()){draft.sending=false;refresh();if(!active)d.defaultView?.removeEventListener('hub-account-changed',invalidate);}}
  };
  const invalidate=()=>{
    for(const entry of Object.values(entries)){const notify=entry.sync;for(const name of Object.keys(entry))delete entry[name];entry.invalidated=true;notify?.();}
    for(const name of Object.keys(entries))delete entries[name];delete storage.edit;if(active)root.replaceChildren(node(d,'p','接続が変わりました。文書を読み直してください。','meta'));d.defaultView?.removeEventListener('hub-account-changed',invalidate);
  };
  const dispose=()=>{if(!active)return;active=false;if(!draft.sending&&!draft.preparing)d.defaultView?.removeEventListener('hub-account-changed',invalidate);if(draft.sync===render)delete draft.sync;for(const control of root.querySelectorAll('button,input,textarea,select'))control.disabled=true;};
  async function importChange(input) {
    if(!live()||options.isCurrent?.()===false||draft.locked||draft.sending||draft.preparing||draft.review||draft.saved||draft.rereading||draft.opening)return false;
    const beforeBody=draft.body,beforeSummary=draft.summary,beforeBase=draft.baseVersion;
    const packet=await parseResearchChangePackage(input);
    const scope=await options.getScope?.();
    if(!live()||options.isCurrent?.()===false||!scope)return false;
    const [origin]=JSON.parse(scope.key);
    if(packet.target.origin!==origin||packet.target.projectId!==doc.projectId||packet.target.documentId!==doc.id
      ||packet.target.baseVersion!==revision.version||packet.target.baseHash!==revision.contentHash)return false;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(revision.body));
    const baseHash='sha256:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    const nextScope=await options.getScope();
    if(!live()||options.isCurrent?.()===false||!nextScope||nextScope.key!==scope.key||nextScope.generation!==scope.generation
      ||baseHash!==packet.target.baseHash||draft.locked||draft.sending||draft.preparing||draft.review||draft.saved
      ||draft.body!==beforeBody||draft.summary!==beforeSummary||draft.baseVersion!==beforeBase)return false;
    if((draft.body!==undefined&&draft.body!==revision.body||draft.summary?.trim())
      &&!(options.confirm??(message=>d.defaultView.confirm(message)))('入力中の提案下書きを、確認した変更ファイルの本文と理由に置き換えますか。'))return false;
    if(!live()||options.isCurrent?.()===false)return false;
    draft.body=packet.body;draft.summary=packet.summary;draft.baseVersion=packet.target.baseVersion;draft.expectedBaseHash=packet.target.baseHash;
    delete draft.bodySelection;delete draft.summarySelection;delete draft.error;delete draft.reloadError;
    storage.editOpen=true;refresh();box.open=true;return true;
  }
  d.defaultView?.addEventListener('hub-account-changed',invalidate);draft.sync=render;render();return {root,ready:Promise.resolve(),dispose,invalidate,importChange};
}
export function documentWorkspace(root,data,options={}) {
  const d=root.ownerDocument,state=options.state??{},{document:doc,revision}=data;
  const versions=node(d,'label','版を表示'),select=node(d,'select');select.setAttribute('aria-label','版を表示');
  for(const item of data.history??[]){const option=node(d,'option',`v${item.version} · ${item.summary}`);option.value=item.version;select.append(option);}select.value=revision.version;
  select.onchange=()=>options.openRevision?.(doc.projectId,doc.id,Number(select.value),doc.title);versions.append(select);root.querySelector('pre')?.before(versions);
  if(data.canDiscuss===true&&options.openDiscussion)root.append(button(d,`表示中のv${revision.version}について議論する`,()=>options.openDiscussion(doc.projectId,doc.id,revision.version,'参照した版について議論')));
  let navigation;
  if(typeof options.openGit==='function' && typeof doc.projectId==='string' && doc.projectId.length===35 && /^rp_[a-f0-9]{32}$/.test(doc.projectId) && root.isConnected && options.isCurrent?.()!==false){
    const projectId=doc.projectId;let active=true;
    const code=button(d,'このプロジェクトのコード',()=>{if(active && root.isConnected && options.isCurrent?.()!==false)return options.openGit(projectId);});
    root.querySelector('pre')?.before(code);
    const stop=()=>{active=false;code.disabled=true;};navigation={root,dispose:stop,invalidate:stop};
  }
  if(!data.signedIn||!options.invoke){root.append(node(d,'p','変更提案にはDesktopの接続が必要です。','meta'));return navigation;}
  const controller=proposalSubmission(root,data,options,state);
  if(data.canEdit){
    const visibility=disclosure(d,'文書の公開範囲','visibilityOpen',state);
    const v=form(d,visibility,options,'公開範囲を変更',async()=>{
      if(v.elements.visibility.value==='public'&&doc.visibility!=='public'&&!v.elements.publicConfirmation.checked)throw new Error('全バージョンを公開する確認を選んでください。');
      await options.invoke('hub_client_action',{action:'research_visibility',target:doc.projectId,options:{documentId:doc.id,visibility:v.elements.visibility.value}});await options.reload?.();
    });field(d,v,state,'visibility','公開範囲',{options:{confidential:'非公開',public:'公開'},value:doc.visibility});
    if(doc.visibility!=='public'){const label=node(d,'label','採用済みの全バージョンを公開する');const check=node(d,'input');check.type='checkbox';check.name='publicConfirmation';label.prepend(check);v.append(label);}putFieldsLast(v);root.append(visibility);
  }
  return navigation?{...controller,dispose(){navigation.dispose();controller.dispose();},invalidate(){navigation.invalidate();controller.invalidate();}}:controller;
}



