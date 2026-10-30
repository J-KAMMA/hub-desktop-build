export const MAX_RESEARCH_PDF_BYTES=10*1024*1024;
const statuses={pending:'検査待ち',failed:'検査に接続できません',rejected:'検査で拒否されました',clean:'検査済み'};
const uuid=value=>typeof value==='string'&&value.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const safeProject=value=>typeof value==='string'&&value.trim()===value&&/^[a-z0-9][a-z0-9_-]{2,127}$/u.test(value);
const clean=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const fail=()=>{throw Error('PDF一覧を確認できませんでした。');};
export function researchPdfList(value,projectId){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.projectId!==projectId||typeof value.canEdit!=='boolean'||typeof value.signedIn!=='boolean'||value.canEdit&&!value.signedIn||!Array.isArray(value.pdfs)||value.pdfs.length>100)fail();
  if(Object.keys(value).some(key=>!['projectId','pdfs','canEdit','signedIn'].includes(key)))fail();
  const seen=new Set(),keys=['id','title','seriesId','version','visibility','scanStatus','size','sha256','createdAt'];
  const pdfs=value.pdfs.map(pdf=>{
    if(!pdf||typeof pdf!=='object'||Array.isArray(pdf)||Object.keys(pdf).length!==keys.length||Object.keys(pdf).some(key=>!keys.includes(key))||!uuid(pdf.id)||!uuid(pdf.seriesId)||seen.has(pdf.id)
      ||!clean(pdf.title,240)||!pdf.title.trim()||!Number.isSafeInteger(pdf.version)||pdf.version<1||!['public','confidential'].includes(pdf.visibility)||!Object.hasOwn(statuses,pdf.scanStatus)
      ||!Number.isSafeInteger(pdf.size)||pdf.size<1||pdf.size>MAX_RESEARCH_PDF_BYTES||typeof pdf.sha256!=='string'||pdf.sha256.length!==64||!/^[a-f0-9]{64}$/u.test(pdf.sha256)
      ||!clean(pdf.createdAt,64)||!Number.isFinite(Date.parse(pdf.createdAt))||!value.canEdit&&(pdf.visibility!=='public'||pdf.scanStatus!=='clean'))fail();
    seen.add(pdf.id);return {...pdf};
  });
  return {projectId,pdfs,canEdit:value.canEdit,signedIn:value.signedIn};
}

/** File selection, bounded binary transfer and save/open are owned by the injected native commands. */
export function researchPdfs(target,{projectId},options={}){
  if(!safeProject(projectId)||typeof options.invoke!=='function')throw Error('PDFのプロジェクトを確認してください。');
  const d=target.ownerDocument,storage=options.state??{},store=storage.pdfs??(storage.pdfs={draft:{title:'',seriesId:''}});
  const root=d.createElement('section');root.className='research-editor research-files';root.dataset.researchSection='論文PDF';target.append(root);
  let active=true,inFlight=0;
  const valid=()=>storage.pdfs===store&&!store.invalidated;
  const live=()=>active&&valid()&&root.isConnected&&(options.isCurrent?.()??true);
  const message=error=>options.friendlyError?.(error)??String(error?.message??error);
  const node=(tag,text)=>{const n=d.createElement(tag);if(text!=null)n.textContent=text;return n;};
  const detach=()=>d.defaultView?.removeEventListener('hub-account-changed',invalidate);
  const request=async run=>{inFlight++;try{return await run();}finally{inFlight--;if(!active&&!inFlight)detach();}};
  const button=(text,run)=>{const b=node('button',text);b.type='button';b.disabled=Boolean(store.pending||store.loading);b.onclick=()=>{if(live()&&b.isConnected&&!store.pending&&!store.loading)return run();};return b;};
  const sync=()=>store.sync?.();
  async function refresh(){
    if(!live())return false;
    const revision=store.readRevision=(store.readRevision??0)+1;store.loading=true;store.readError='';sync();
    try{const value=await request(()=>options.invoke('hub_detail',{name:'research_pdfs',ids:[projectId]}));if(!valid()||revision!==store.readRevision)return false;store.data=researchPdfList(value,projectId);return true;}
    catch(error){if(valid()&&revision===store.readRevision){store.readError=message(error);store.data=null;}return false;}
    finally{if(valid()&&revision===store.readRevision){store.loading=false;sync();}}
  }
  async function action(id,kind,visibility){
    store.pending=true;store.status='PDFを処理しています…';sync();
    try{
      const value=await request(()=>options.invoke('hub_client_action',{action:kind==='scan'?'research_pdf_scan':'research_pdf_visibility',target:projectId,options:{id,...(kind==='visibility'?{visibility}:{})}}));if(!valid())return;
      if(value?.id!==id||(kind==='scan'?!Object.hasOwn(statuses,value?.scanStatus):value?.visibility!==visibility))throw Error('PDFの操作結果を確認できませんでした。');
      store.status=kind==='scan'?statuses[value.scanStatus]:'この版の公開範囲を変更しました。';
      if(await store.refresh?.()===false&&valid())store.status+=' 一覧の更新に失敗しました。';
    }catch(error){if(valid())store.status=message(error);}
    finally{if(valid()){store.pending=false;sync();}}
  }
  async function file(pdf,open=false){
    store.pending=true;store.status=open?'PDFを開いています…':'PDFを保存しています…';sync();
    try{const value=await request(()=>(open?options.openPdf:options.downloadPdf)({projectId,pdfId:pdf.id}));if(!valid())return;
      if(value?.cancelled===true)store.status='PDFの操作を中止しました。';
      else if(open?value?.opened===true:value?.saved===true)store.status=open?'PDFを開きました。':'PDFを保存しました。';
      else throw Error('PDFの操作結果を確認できませんでした。');
    }catch(error){if(valid())store.status=message(error);}
    finally{if(valid()){store.pending=false;sync();}}
  }
  async function upload(){
    if(!clean(store.draft.title,240)||!store.draft.title.trim()){store.status='PDFの名前を確認してください。';sync();return;}
    const seriesId=store.draft.seriesId;
    if(seriesId&&(!uuid(seriesId)||!store.data.pdfs.some(pdf=>pdf.seriesId===seriesId))){store.status='改訂元のPDFを読み直してください。';sync();return;}
    store.pending=true;store.reviewed=false;store.status='PDFを選択して非公開でアップロードします…';sync();
    try{
      const value=await request(()=>options.uploadPdf({projectId,title:store.draft.title.trim(),...(seriesId?{seriesId}:{})}));if(!valid())return;
      if(value?.cancelled===true){store.status='アップロードを中止しました。';return;}
      if(!uuid(value?.id)||!Number.isSafeInteger(value.version)||value.version<1||value.scanStatus!=='pending')throw Error('PDFの保存結果を確認できませんでした。');
      store.draft={title:'',seriesId:''};store.uploadOpen=false;store.status=`PDFのv${value.version}を非公開で保存しました。検査待ちです。`;
      if(await store.refresh?.()===false&&valid())store.status+=' 一覧の更新に失敗しました。';
    }catch(error){if(valid()){
      const code=String(error?.message??error),rejected=['invalid_id','invalid_origin','invalid_title','dialog_failed','file_unavailable','too_large','read_failed','invalid_format'].some(kind=>code===`research_pdf_${kind}`)||/^research_pdf_upload_rejected:(?:400|401|403|404|409|413|415|429):/u.test(code);
      store.uncertain=!rejected;store.status=rejected?message(error):`保存結果が未確認です。PDF一覧を読み直してください: ${message(error)}`;
    }}finally{if(valid()){store.pending=false;sync();}}
  }
  function render(){
    if(!live())return;root.replaceChildren(node('h3','論文PDF'),node('p','PDFは10MBまで。非公開で保存した版を検査し、検査済みの版ごとに公開できます。'));
    const status=node('p',store.status??'');status.className='meta';status.setAttribute('role','status');root.append(status,button('PDF一覧を更新',refresh));
    if(store.loading)root.append(node('p','PDF一覧を読み込んでいます…'));
    if(store.readError){const error=node('p',store.readError);error.setAttribute('role','alert');root.append(error);}
    root.setAttribute('aria-busy',String(Boolean(store.pending||store.loading)));
    if(!store.data)return;
    if(!store.data.pdfs.length)root.append(node('p','PDFはまだありません。'));
    for(const pdf of store.data.pdfs){
      const row=node('article');row.append(node('h4',`${pdf.title} · v${pdf.version}`),node('p',`${statuses[pdf.scanStatus]} · ${pdf.visibility==='public'?'公開':'非公開'} · ${(pdf.size/1024).toFixed(0)}KB`));root.append(row);
      if(pdf.scanStatus==='clean'){
        if(options.downloadPdf)row.append(button('PDFを保存',()=>file(pdf)));
        else row.append(node('p','PDFの保存操作を利用できません。'));
        if(options.openPdf)row.append(button('PDFを開く',()=>file(pdf,true)));
      }
      if(store.data.canEdit&&['pending','failed'].includes(pdf.scanStatus))row.append(button('検査する',()=>action(pdf.id,'scan')));
      if(store.data.canEdit&&pdf.scanStatus==='clean'){
        if(pdf.visibility==='public')row.append(button('この版を非公開にする',()=>action(pdf.id,'visibility','confidential')));
        else{
          const detail=node('details');detail.append(node('summary','この版の公開範囲を変更'),node('p','この版のPDFを公開します。非公開プロジェクトでは所有者だけが閲覧できます。'));
          const label=node('label','この版のPDFを公開する'),check=node('input');check.type='checkbox';check.disabled=Boolean(store.pending||store.loading);label.prepend(check);detail.append(label);
          const publish=button('確認してこの版を公開',()=>{if(check.checked)return action(pdf.id,'visibility','public');});publish.disabled=true;check.onchange=()=>{publish.disabled=!check.checked||Boolean(store.pending||store.loading);};detail.append(publish);row.append(detail);
        }
      }
    }
    if(store.data.canEdit){
      const details=node('details');details.open=Boolean(store.uploadOpen);details.append(node('summary','PDFを非公開でアップロード'));details.ontoggle=()=>{if(live()&&details.isConnected)store.uploadOpen=details.open;};root.append(details);
      const form=node('form');form.className='research-edit-form';const titleLabel=node('label','PDFの名前'),title=node('input');title.name='title';title.required=true;title.maxLength=240;title.placeholder='PDFの名前';title.value=store.draft.title;title.disabled=Boolean(store.pending||store.loading||store.uncertain);title.oninput=()=>{if(live()&&!store.pending&&!store.uncertain)store.draft.title=title.value;};titleLabel.append(title);
      const seriesLabel=node('label','改訂先'),series=node('select');series.name='seriesId';const first=node('option','新しい論文');first.value='';series.append(first);
      for(const pdf of new Map(store.data.pdfs.map(pdf=>[pdf.seriesId,pdf])).values()){const option=node('option',pdf.title);option.value=pdf.seriesId;series.append(option);}series.value=store.draft.seriesId;series.disabled=title.disabled;series.onchange=()=>{if(live()&&!store.pending&&!store.uncertain)store.draft.seriesId=series.value;};seriesLabel.append(series);
      const submit=node('button','PDFを選択して非公開でアップロード');submit.type='submit';submit.disabled=Boolean(!options.uploadPdf||store.pending||store.loading||store.uncertain);form.append(titleLabel,seriesLabel,submit);form.onsubmit=event=>{event.preventDefault();if(live()&&form.isConnected&&options.uploadPdf&&!store.pending&&!store.loading&&!store.uncertain)return upload();};details.append(form);
      if(!options.uploadPdf)details.append(node('p','ネイティブのPDFファイル選択を利用できません。'));
      if(store.uncertain){
        details.append(node('p','保存結果が分かるまで同じPDFを再送しません。'),button('保存済みPDF一覧を確認する',async()=>{if(await refresh()&&valid()){store.reviewed=true;sync();}}));
        const resume=button('保存済み一覧を確認したので入力を再開する',()=>{if(store.reviewed){store.uncertain=false;store.reviewed=false;sync();}});resume.disabled=Boolean(!store.reviewed||store.pending||store.loading);details.append(resume);
      }
    }
  }
  function invalidate(){store.invalidated=true;for(const key of Object.keys(store))delete store[key];store.invalidated=true;delete storage.pdfs;root.replaceChildren(node('p','接続が変わりました。PDF一覧を読み直してください。'));dispose();}
  function dispose(){active=false;if(store.sync===render)delete store.sync;if(store.refresh===refresh)delete store.refresh;if(!inFlight)detach();for(const control of root.querySelectorAll('button,input,select'))control.disabled=true;}
  store.sync=render;store.refresh=refresh;d.defaultView?.addEventListener('hub-account-changed',invalidate);
  let ready;
  if(options.prepared!==undefined){try{store.data=researchPdfList(options.prepared,projectId);store.loading=false;store.readError='';render();ready=Promise.resolve(true);}catch(error){store.data=null;store.readError=message(error);render();ready=Promise.resolve(false);}}
  else {render();ready=refresh();}
  return {root,ready,refresh,dispose,invalidate};
}
