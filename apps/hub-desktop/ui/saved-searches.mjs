import {normalizeHubSearchFilters,hasHubSearchFilters} from './hub-search-filters.mjs';

const PREFIX='hub.desktop.search.saved.v1:',MAX_BYTES=32768,MAX_ITEMS=10;
export const SAVED_SEARCH_GROUPS=Object.freeze(['all','boards','profiles','threads','posts','images','hubpedia','communities','videos','products','lists','tokens','work','realEstate','vehicles','listings','coreEntities','results','works','games','rankings','articles','projects','tracks','books']);
const groups=new Set(SAVED_SEARCH_GROUPS),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const groupLabels={all:'すべて',boards:'掲示板',profiles:'人物',threads:'スレッド',posts:'投稿',images:'画像',hubpedia:'Hubpedia',communities:'コミュニティ',videos:'動画',products:'商品',lists:'リスト',tokens:'トークン',work:'仕事',realEstate:'不動産',vehicles:'車',listings:'出品',coreEntities:'その他',results:'検索結果',works:'楽曲',games:'ゲーム',rankings:'ランキング',articles:'記事',projects:'プロジェクト',tracks:'公開曲',books:'本'};
const bad=()=>{throw Error('saved_search_invalid');};
const exact=(value,keys)=>!!value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const unicode=value=>typeof value==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const clean=(value,max)=>unicode(value)&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value);
function name(value){if(!clean(value,32)||!value.trim())return bad();const result=value.normalize('NFKC').trim();if(!clean(result,32))return bad();return result;}
function normalizedValue(value){
  if(!exact(value,['query','group','filters','order'])||!unicode(value.query)||!groups.has(value.group)||!['recommended','kind'].includes(value.order))return bad();
  if(/[\u0000-\u001f\u007f-\u009f]/u.test(value.query.replace(/\s/gu,'')))return bad();
  const query=value.query.normalize('NFKC').trim().toLocaleLowerCase('ja');
  if(query.length>100||query&&query.split(/\s/u).filter(Boolean).length>8)return bad();
  if(!value.filters||typeof value.filters!=='object'||Reflect.ownKeys(value.filters).some(key=>typeof key!=='string'||!unicode(value.filters[key])))return bad();
  const filters=normalizeHubSearchFilters(value.filters);
  if(!query&&!hasHubSearchFilters(filters))return bad();
  return {query,group:value.group,filters,order:value.order};
}
const valueKey=value=>JSON.stringify([value.query,value.group,value.filters,value.order]);
function scopeValue(scope){
  if(!exact(scope,['key','generation'])||typeof scope.key!=='string'||scope.key.length>2048||scope.generation===undefined)return bad();
  let tuple;try{tuple=JSON.parse(scope.key);}catch{return bad();}
  if(!Array.isArray(tuple)||tuple.length!==2||!clean(tuple[0],1024)||!clean(tuple[1],160)||!tuple[1]||tuple[1].trim()!==tuple[1])return bad();
  let url;try{url=new URL(tuple[0]);}catch{return bad();}
  if(!['http:','https:'].includes(url.protocol)||url.origin!==tuple[0]||url.username||url.password||JSON.stringify(tuple)!==scope.key)return bad();
  return {key:scope.key,generation:scope.generation};
}
function decode(raw){
  if(raw===null)return [];
  if(typeof raw!=='string'||raw.length>MAX_BYTES||new TextEncoder().encode(raw).byteLength>MAX_BYTES)return bad();
  let data;try{data=JSON.parse(raw);}catch{return bad();}
  if(!exact(data,['version','items'])||data.version!==1||!Array.isArray(data.items)||data.items.length>MAX_ITEMS)return bad();
  const items=data.items.map(item=>{
    if(!exact(item,['id','name','value'])||typeof item.id!=='string'||item.id.length!==36||!uuid.test(item.id))return bad();
    return {id:item.id,name:name(item.name),value:normalizedValue(item.value)};
  });
  if(new Set(items.map(item=>item.id)).size!==items.length||new Set(items.map(item=>valueKey(item.value))).size!==items.length)return bad();
  return items;
}
const copy=value=>JSON.parse(JSON.stringify(value));

/** A local, explicitly saved conditions bucket. Scope authority and fresh search execution belong to the caller. */
export function createSavedSearches({document,storage,getScope,getValue,apply,isCurrent}){
  let destroyed=false,token={},scope=null,items=[],available=false,applying=false;
  const element=document.createElement('details');element.className='settings-note saved-searches';
  const summary=document.createElement('summary');summary.textContent='保存した検索';
  const form=document.createElement('form'),label=document.createElement('label'),input=document.createElement('input');
  input.type='text';input.maxLength=32;input.setAttribute('aria-label','検索条件の名前');input.placeholder='検索条件の名前（任意）';label.append(input);
  const save=document.createElement('button');save.type='submit';save.className='head-action';save.textContent='現在の検索を保存';form.append(label,save);
  const note=document.createElement('p');note.className='meta';note.textContent='検索語・結果の区分・条件・表示順を10件まで保存します。接続先とログイン状態ごとに分かれます。';
  const status=document.createElement('p');status.className='meta';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const list=document.createElement('div');element.append(summary,note,form,status,list);
  function current(captured=scope,request=token){
    if(destroyed||request!==token||!captured)return false;
    try{if(!isCurrent())return false;const now=scopeValue(getScope());return now.key===captured.key&&Object.is(now.generation,captured.generation);}catch{return false;}
  }
  function read(captured){const raw=storage.getItem(PREFIX+captured.key);return {raw,items:decode(raw)};}
  function button(text,handler){const node=document.createElement('button');node.type='button';node.className='head-action';node.textContent=text;node.disabled=!available||applying;node.onclick=handler;return node;}
  function render(){
    const renderedScope=scope,renderedToken=token;
    form.onsubmit=event=>{event.preventDefault();if(current(renderedScope,renderedToken))saveCurrent();};
    save.disabled=!available||applying;input.disabled=!available||applying;list.replaceChildren();
    for(const item of items){
      const row=document.createElement('details'),caption=document.createElement('summary');caption.textContent=item.name;
      const description=document.createElement('p');description.className='meta';description.textContent=`${item.value.query||'条件のみ'} · ${groupLabels[item.value.group]} · ${item.value.order==='kind'?'種別順':'おすすめ順'}`;
      const rename=document.createElement('form'),field=document.createElement('input');rename.className='detail-form-row';field.type='text';field.value=item.name;field.maxLength=32;field.setAttribute('aria-label',`${item.name}の名前`);field.disabled=!available||applying;
      const update=document.createElement('button');update.type='submit';update.className='head-action';update.textContent='名前を保存';update.disabled=!available||applying;
      rename.append(field,update);rename.onsubmit=event=>{event.preventDefault();if(current(renderedScope,renderedToken))mutate(item,next=>next.map(entry=>entry.id===item.id?{...entry,name:name(field.value)}:entry));};
      row.append(caption,description,button('この検索を呼び出す',()=>{if(current(renderedScope,renderedToken))void recall(item);}),button('削除',()=>{if(current(renderedScope,renderedToken))mutate(item,next=>next.filter(entry=>entry.id!==item.id));}),rename);list.append(row);
    }
    if(available&&!items.length){const empty=document.createElement('p');empty.className='meta';empty.textContent='保存した検索はありません。';list.append(empty);}
  }
  function mutate(expected,transform){
    const captured=scope,request=token;if(applying||!available||!current(captured,request))return false;
    let previous;
    try{
      previous=read(captured);
      if(expected&&!previous.items.some(item=>item.id===expected.id&&valueKey(item.value)===valueKey(expected.value)))throw Error('saved_search_changed');
      const next=transform(copy(previous.items));
      if(next.length>MAX_ITEMS){status.textContent='保存は10件までです。不要な条件を削除してください。';return false;}
      const encoded=JSON.stringify({version:1,items:next});decode(encoded);
      if(!current(captured,request))return false;
      try{
        storage.setItem(PREFIX+captured.key,encoded);
        if(storage.getItem(PREFIX+captured.key)!==encoded)throw Error('saved_search_write_failed');
        if(!current(captured,request))throw Error('saved_search_scope_changed');
      }catch{
        try{if(storage.getItem(PREFIX+captured.key)!==previous.raw){if(previous.raw===null)storage.removeItem(PREFIX+captured.key);else storage.setItem(PREFIX+captured.key,previous.raw);}}catch{}
        throw Error('saved_search_write_failed');
      }
      if(!current(captured,request))return false;
      items=next;status.textContent='保存した検索を更新しました。';render();return true;
    }catch{if(current(captured,request)){status.textContent='保存できませんでした。保存状態を確認してください。';render();}return false;}
  }
  function saveCurrent(){
    if(!available||applying||!current())return;
    try{
      const value=normalizedValue(getValue()),title=name(input.value.trim()?input.value:'保存した検索');
      if(mutate(null,next=>{const old=next.find(item=>valueKey(item.value)===valueKey(value));const item={id:old?.id??globalThis.crypto.randomUUID(),name:title,value};return [item,...next.filter(entry=>entry.id!==item.id)];}))input.value='';
    }catch{if(current())status.textContent='検索語・条件・名前を確認してください。検索語は100文字・8語以内です。';}
  }
  async function recall(expected){
    const captured=scope,request=token;if(applying||!available||!current(captured,request))return false;
    try{
      const latest=read(captured),item=latest.items.find(entry=>entry.id===expected.id&&valueKey(entry.value)===valueKey(expected.value));
      if(!item||!current(captured,request))throw Error('saved_search_changed');
      applying=true;render();status.textContent='検索条件を呼び出しています…';
      const guard=()=>current(captured,request);
      const result=await apply(copy(item.value),guard);
      if(!guard())return false;
      if(result===false)throw Error('saved_search_apply_failed');
      status.textContent='保存した検索条件を呼び出しました。';return true;
    }catch{if(current(captured,request))status.textContent='検索条件を呼び出せませんでした。現在の画面と保存状態を確認してください。';return false;}
    finally{if(request===token){applying=false;if(current(captured,request))render();else{available=false;items=[];scope=null;status.textContent='接続先またはプロフィールが変わりました。保存した検索を確認してください。';render();}}}
  }
  function refreshScope(){
    token={};applying=false;available=false;items=[];scope=null;input.value='';
    try{if(destroyed||!isCurrent())throw Error('inactive');scope=scopeValue(getScope());items=read(scope).items;if(!current())throw Error('changed');available=true;status.textContent='';}
    catch{status.textContent='保存した検索を確認できません。接続先とプロフィール、保存状態を確認してください。';}
    render();return available;
  }
  const ready=Promise.resolve(refreshScope());
  return {element,ready,refreshScope,destroy(){if(destroyed)return;destroyed=true;token={};scope=null;items=[];form.onsubmit=null;element.replaceChildren();element.remove();}};
}
