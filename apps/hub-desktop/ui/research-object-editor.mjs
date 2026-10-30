const types = {question:'研究課題',hypothesis:'仮説',protocol:'手順',preregistration:'事前登録',experiment_run:'実験記録',dataset:'データセット',software:'ソフトウェア',model:'モデル',notebook:'ノートブック',claim:'主張',evidence:'根拠',review:'レビュー',replication:'追試',paper:'論文',license:'ライセンス'};
const relations = {supported_by:'根拠が支持',contradicted_by:'根拠が反証',replicated_by:'追試で再現',supersedes:'新版として置換',derived_from:'派生元',uses_protocol:'手順を使用',included_in:'成果に収録',reviewed_by:'レビュー済み'};
const scopes = {confidential:'非公開（自分のみ）',public:'公開',embargoed:'公開猶予',controlled:'申請制',restricted:'限定'};
const safeId = value => typeof value==='string' && value.trim()===value && /^[a-z0-9][a-z0-9_-]{2,127}$/u.test(value);
const clean = (value,max) => typeof value==='string' && value.length<=max && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const invalid = () => {throw Error('成果の種類・名前・版・SHA-256・公開範囲を確認してください。');};

export function researchObjectInput(value) {
  if(!value || !Object.hasOwn(types,value.objectType) || !Object.hasOwn(scopes,value.visibility)
    || !clean(value.title,240) || !value.title.trim() || !clean(value.license,200)
    || typeof value.version!=='string' || !/^[1-9][0-9]*$/u.test(value.version) || value.version.trim()!==value.version || !Number.isSafeInteger(Number(value.version))
    || typeof value.contentHash!=='string' || value.contentHash.length!==71 || !/^sha256:[a-f0-9]{64}$/u.test(value.contentHash)) invalid();
  return {objectType:value.objectType,title:value.title.trim(),version:Number(value.version),contentHash:value.contentHash,license:value.license.trim(),visibility:value.visibility};
}
export function researchRelationInput(value,objects,projectId) {
  const known=new Set(objects.filter(item=>item.projectId===projectId&&safeId(item.id)).map(item=>item.id));
  if(!value || !safeId(value.fromObjectId) || !safeId(value.toObjectId) || value.fromObjectId===value.toObjectId
    || !known.has(value.fromObjectId) || !known.has(value.toObjectId) || !Object.hasOwn(relations,value.relationType)) throw Error('同じプロジェクトにある別の成果と関係の種類を選んでください。');
  return {fromObjectId:value.fromObjectId,toObjectId:value.toObjectId,relationType:value.relationType};
}

export function researchObjectEditor(root,data,options={}) {
  if(!data.canEdit || !data.signedIn || !options.invoke || options.sourceOrigin || !safeId(data.project?.id))return null;
  const d=root.ownerDocument,project=data.project,objects=data.objects??[],storage=options.state??{};
  const store=storage.objectRegistration??(storage.objectRegistration={});
  const box=d.createElement('section');box.className='research-editor';box.setAttribute('aria-label','研究成果と関係の登録');
  root.querySelector('[data-research-section="研究成果"]')?.after(box);
  if(!box.parentNode)root.append(box);
  let active=true;
  const valid=()=>storage.objectRegistration===store&&!store.invalidated;
  const live=()=>active&&valid()&&box.isConnected&&(options.isCurrent?.()??true);
  const message=error=>options.friendlyError?.(error)??String(error?.message??error);
  const node=(tag,text)=>{const n=d.createElement(tag);if(text!=null)n.textContent=text;return n;};
  const button=(text,run)=>{const b=node('button',text);b.type='button';b.disabled=Boolean(store.sending);b.onclick=()=>{if(live()&&!store.sending)return run();};return b;};
  const defaults=kind=>kind==='object'?{objectType:'software',title:'',version:'1',contentHash:'',license:project.defaultLicense??'',visibility:'confidential'}:{fromObjectId:'',toObjectId:'',relationType:'supported_by'};
  function field(form,draft,key,title,{choices,max,type='text'}={}) {
    const label=node('label',title),input=node(choices?'select':'input');input.name=key;input.required=true;
    if(choices)for(const [value,text] of Object.entries(choices)){const option=node('option',text);option.value=value;input.append(option);}
    else {input.type=type;if(max)input.maxLength=max;if(type==='number'){input.min='1';input.max=String(Number.MAX_SAFE_INTEGER);input.step='1';}}
    input.value=draft[key];input.disabled=Boolean(store.sending||store.uncertain);
    input.oninput=()=>{if(live()&&!store.sending&&!store.uncertain)draft[key]=input.value;};label.append(input);form.append(label);return input;
  }
  function render() {
    if(!live())return;box.replaceChildren();
    for(const kind of ['object','relation']){
      const draft=store[kind]??(store[kind]=defaults(kind)),details=node('details'),summary=node('summary',kind==='object'?'研究成果を登録':'主張と根拠の関係を登録');
      details.open=Boolean(store[kind+'Open']);details.ontoggle=()=>{if(live()&&details.isConnected)store[kind+'Open']=details.open;};details.append(summary);box.append(details);
      const form=node('form');form.className='research-edit-form';form.dataset.researchRegistration=kind;details.append(form);
      if(kind==='object'){
        field(form,draft,'objectType','成果の種類',{choices:types});field(form,draft,'title','成果の名前',{max:240});field(form,draft,'version','版',{type:'number'});field(form,draft,'contentHash','成果のSHA-256',{max:71});
        field(form,draft,'license','ライセンス',{max:200}).required=false;field(form,draft,'visibility','公開範囲',{choices:scopes});
        const label=node('label','公開を選んだとき、成果の名前・版・ハッシュを公開する'),check=node('input');check.type='checkbox';check.name='publicConfirmation';check.checked=Boolean(store.publicConfirmed);check.disabled=Boolean(store.sending||store.uncertain);check.onchange=()=>{if(live())store.publicConfirmed=check.checked;};label.prepend(check);form.append(label,node('p','成果本体はアップロードされません。登録する成果と一致するSHA-256を指定してください。'));
      }else{
        const choices=Object.fromEntries(objects.filter(item=>item.projectId===project.id&&safeId(item.id)).map(item=>[item.id,`${item.title} · v${item.version}`]));
        field(form,draft,'fromObjectId','関係の起点',{choices:{'':'成果を選択',...choices}});field(form,draft,'toObjectId','関係の相手',{choices:{'':'別の成果を選択',...choices}});field(form,draft,'relationType','関係の種類',{choices:relations});
      }
      const submit=node('button',kind==='object'?'成果を登録':'関係を登録');submit.type='submit';submit.disabled=Boolean(store.sending||store.uncertain);form.append(submit);
      const status=node('p',store[kind+'Status']??'');status.className='meta';status.setAttribute('role','status');form.append(status);
      form.onsubmit=async event=>{
        event.preventDefault();if(!live()||store.sending||store.uncertain)return;
        let payload;
        try{payload=kind==='object'?researchObjectInput(draft):researchRelationInput(draft,objects,project.id);if(kind==='object'&&payload.visibility==='public'&&!store.publicConfirmed)throw Error('成果の公開を確認してください。');}
        catch(error){store[kind+'Status']=message(error);render();return;}
        store.sending=true;store.reviewed=false;store[kind+'Status']='登録しています…';render();
        try{
          const result=await options.invoke('hub_client_action',{action:kind==='object'?'research_register_object':'research_register_relation',target:project.id,options:payload});
          if(!valid())return;
          if(kind==='object'?!safeId(result?.objectId):result?.created!==true)throw Error('登録結果を確認できませんでした。');
          store[kind]=defaults(kind);if(kind==='object')store.publicConfirmed=false;store[kind+'Status']=kind==='object'?'成果を登録しました。':'関係を登録しました。';
          try{if(live())await options.reload?.();}catch(error){if(valid())store[kind+'Status']=`登録済みです。表示の更新に失敗しました: ${message(error)}`;}
        }catch(error){if(valid()){
          const rejected=new RegExp(`^research_register_${kind}_rejected:(?:400|403|404|409|429):`).test(String(error?.message??error));
          if(/接続が変わりました/.test(String(error?.message??error))){invalidate();return;}
          store.uncertain=!rejected;store[kind+'Status']=rejected?message(error):`登録結果が未確認です。一覧を読み直して確認してください: ${message(error)}`;
        }}finally{if(valid()){store.sending=false;store.sync?.();}if(!active)d.defaultView?.removeEventListener('hub-account-changed',invalidate);}
      };
    }
    if(store.uncertain){
      box.append(button('一覧を読み直す',async()=>{
        store.sending=true;store.sync?.();
        try{await options.reload?.();if(valid())store.reviewed=typeof options.reload==='function';}
        catch(error){if(valid())store.objectStatus=`一覧を取得できませんでした: ${message(error)}`;}
        finally{if(valid()){store.sending=false;store.sync?.();}}
      }));
      const retry=button('登録済み一覧を確認したので入力を再開する',()=>{store.uncertain=false;store.reviewed=false;store.sync?.();});retry.disabled=Boolean(store.sending||!store.reviewed);box.append(retry);
    }
  }
  function invalidate(){store.invalidated=true;for(const key of Object.keys(store))delete store[key];store.invalidated=true;delete storage.objectRegistration;box.replaceChildren(node('p','接続が変わりました。プロジェクトを読み直してください。'));dispose();}
  function dispose(){active=false;if(store.sync===render)delete store.sync;if(!store.sending)d.defaultView?.removeEventListener('hub-account-changed',invalidate);for(const input of box.querySelectorAll('input,select,button'))input.disabled=true;}
  store.sync=render;d.defaultView?.addEventListener('hub-account-changed',invalidate);render();return {root:box,ready:Promise.resolve(),dispose,invalidate};
}
