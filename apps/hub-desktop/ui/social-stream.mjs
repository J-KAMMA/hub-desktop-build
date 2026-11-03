import {isReadAccessDenied} from './hub-read-recovery.mjs';
const filters=['all','post','thread','community'],scopes=['latest','following'],kinds=['post','thread','community_post'];
const bad=()=>Error('social_stream_invalid_response');
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=(value,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max&&/^[A-Za-z0-9]/.test(value)&&!/[^A-Za-z0-9._:-]/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const date=value=>typeof value==='string'&&value.length<=64&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const origin=value=>{try{const url=new URL(value);return typeof value==='string'&&value.length<=2048&&!/[\u0000-\u0020\u007f-\u009f]/.test(value)&&url.origin===value&&!url.username&&!url.password&&['http:','https:'].includes(url.protocol);}catch{return false;}};
const url=(value,base)=>{try{if(!text(value,2048)||!value||/[\u0000-\u0020\u007f-\u009f]/.test(value)||value.startsWith('//'))return false;const parsed=new URL(value,base);return ['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password;}catch{return false;}};
const nullable=(value,check)=>value===null||check(value);
const key=item=>JSON.stringify([item.origin,item.kind,item.id]);
const permitted=filter=>filter==='all'?kinds:filter==='community'?['community_post']:[filter];
const cursor=value=>value===null||text(value,4096)&&value.length>0&&new TextEncoder().encode(value).length<=4096&&!/[\u0000-\u0020\u007f-\u009f]/.test(value);
const compare=(a,b)=>a.createdAt===b.createdAt?kinds.indexOf(a.kind)-kinds.indexOf(b.kind)||(a.id===b.id?0:a.id>b.id?-1:1):a.createdAt>b.createdAt?-1:1;
const postKeys=['id','body','createdAt','authorName','authorHandle','authorProfileId','avatarUrl','replyCount','repostCount','likeCount','likedByViewer','bookmarkedByViewer','viewerRepostId','images','tags','referenced','identityMode','replyToPostId'];
function post(value,base){
 if(!exact(value,postKeys)||!id(value.id)||!text(value.body,40000)||!date(value.createdAt)||!text(value.authorName,160)||!nullable(value.authorHandle,item=>text(item,64))||!nullable(value.authorProfileId,id)||!nullable(value.avatarUrl,item=>url(item,base))||!['replyCount','repostCount','likeCount'].every(name=>count(value[name]))||typeof value.likedByViewer!=='boolean'||typeof value.bookmarkedByViewer!=='boolean'||!nullable(value.viewerRepostId,id)||!Array.isArray(value.images)||value.images.length>4||!Array.isArray(value.tags)||value.tags.length>32||!value.tags.every(tag=>text(tag,160)&&tag.length>0))throw bad();
 if(!['account','anonymous','guest'].includes(value.identityMode)||!nullable(value.replyToPostId,id)||value.identityMode!=='account'&&[value.authorHandle,value.authorProfileId,value.avatarUrl].some(field=>field!==null))throw bad();
 for(const image of value.images)if(!exact(image,['id','url','width','height','altText'])||!id(image.id)||!url(image.url,base)||!count(image.width)||image.width>16384||!count(image.height)||image.height>16384||!text(image.altText,600))throw bad();
 if(new Set(value.images.map(image=>image.id)).size!==value.images.length)throw bad();
 if(value.referenced!==null){const ref=value.referenced,keys=['label','title','body','href'];if(Object.hasOwn(ref??{},'contextLabel'))keys.push('contextLabel');if(!exact(ref,keys)||!text(ref.label,300)||!text(ref.title,480)||!text(ref.body,40000)||!url(ref.href,base)||Object.hasOwn(ref,'contextLabel')&&!text(ref.contextLabel,300))throw bad();}
}
function payload(item){
 const value=item.payload;
 if(item.kind==='post'){post(value,item.origin);if(value.id!==item.id||value.createdAt!==item.createdAt)throw bad();}
 else if(item.kind==='thread'){
  if(!exact(value,['id','title','boardKey','postCount','threadType','status','updatedAt'])||value.id!==item.id||!text(value.title,480)||!id(value.boardKey)||!count(value.postCount)||!['question','information','discussion','recruitment','issue','chat'].includes(value.threadType)||!['open','closed'].includes(value.status)||!date(value.updatedAt))throw bad();
 }else if(!exact(value,['id','communityId','communityName','body','createdAt','authorName','authorHandle','replyCount','likeCount','kind'])||value.id!==item.id||!id(value.communityId)||!text(value.communityName,200)||!text(value.body,4000)||value.createdAt!==item.createdAt||!text(value.authorName,160)||!nullable(value.authorHandle,item=>text(item,64))||!count(value.replyCount)||!count(value.likeCount)||!['chat','guide','question','party'].includes(value.kind))throw bad();
}
export function parseSocialStream(raw,context){
 if(!exact(raw,['version','filter','scope','viewerId','signedIn','items','hasMore','nextCursor','failures'])||raw.version!==1||!filters.includes(raw.filter)||!scopes.includes(raw.scope)||typeof raw.signedIn!=='boolean'||!nullable(raw.viewerId,value=>id(value,128))||raw.signedIn!==(raw.viewerId!==null)||!Array.isArray(raw.items)||raw.items.length>20||typeof raw.hasMore!=='boolean'||!cursor(raw.nextCursor)||raw.hasMore!==(raw.nextCursor!==null)||!Array.isArray(raw.failures)||raw.failures.length>3||new Set(raw.failures).size!==raw.failures.length||!raw.failures.every(kind=>permitted(raw.filter).includes(kind))||raw.failures.length&&!raw.hasMore)throw bad();
 if(raw.filter!==context.filter||raw.scope!==context.scope||raw.viewerId!==context.viewerId)throw Error('social_stream_scope_changed');
 for(const item of raw.items){if(!exact(item,['kind','id','createdAt','origin','payload'])||!permitted(raw.filter).includes(item.kind)||!id(item.id)||!date(item.createdAt)||!origin(item.origin))throw bad();if(item.origin!==context.origin)throw Error('social_stream_scope_changed');payload(item);}
 if(new Set(raw.items.map(key)).size!==raw.items.length||raw.items.some((item,index)=>index&&compare(raw.items[index-1],item)>0))throw bad();
 if(new TextEncoder().encode(JSON.stringify(raw)).length>2*1024*1024)throw bad();
 return structuredClone(raw);
}
function source(getContext){const value=getContext();if(!value||!origin(value.origin)||!filters.includes(value.filter)||!scopes.includes(value.scope)||!nullable(value.viewerId,item=>id(item,128))||value.generation===undefined)throw Error('social_stream_unavailable');return{origin:value.origin,viewerId:value.viewerId,generation:value.generation,filter:value.filter,scope:value.scope};}
const same=(a,b)=>a&&b&&['origin','viewerId','generation','filter','scope'].every(name=>a[name]===b[name]);
const node=(document,tag,className,value)=>{const result=document.createElement(tag);result.className=className;if(value!==undefined)result.textContent=value;return result;};
export function renderSocialItem(document,item,{renderPost,onOpenThread,onOpenCommunityPost,isCurrent,primaryOrigin=null,formatTime=value=>new Date(value).toLocaleString('ja-JP')}){
 // 接続中のHub（primaryOrigin）の普通の投稿には「投稿 · アドレス」の行を出さない。別のHubのもの、匿名・ゲストのものだけ出す。
 const elsewhere=item.origin&&item.origin!==primaryOrigin;
 let card;
 if(item.kind==='post'){
  card=node(document,'section','social-stream-item');
  const label=item.payload.identityMode==='anonymous'?'匿名の投稿':item.payload.identityMode==='guest'?'ゲストの投稿':'投稿';
  if(label!=='投稿'||elsewhere)card.append(node(document,'p','meta social-stream-kind',elsewhere?`${label} · ${item.origin}`:label));
  card.append(renderPost(item.payload,{isCurrent}));
 }
 else{
  // スレッドとコミュニティの投稿も、タイムラインの投稿と同じカード（.post：アイコン・名前・時刻・本文・足元）で描く。
  const p=item.payload,thread=item.kind==='thread';
  card=node(document,'article','post social-stream-post');
  const title=thread?p.title:p.authorName,when=thread?p.updatedAt:p.createdAt;
  const avatar=node(document,'span','post-avatar',(title||'?').trim().slice(0,1).toUpperCase());
  const content=node(document,'div','post-content'),head=node(document,'div','post-head');
  const who=node(document,'span','post-author-link');
  who.append(node(document,'strong','post-author',thread?'スレッド':p.authorName));
  if(!thread&&p.authorHandle)who.append(node(document,'span','meta','@'+p.authorHandle));
  const time=node(document,'span','meta when',formatTime(when));time.title=new Date(when).toLocaleString('ja-JP');
  head.append(who,time);
  const kind=node(document,'p','meta social-stream-kind',[thread?(p.status==='closed'?'受付終了':'受付中'):p.communityName,elsewhere?item.origin:null].filter(Boolean).join(' · '));
  const body=node(document,'div','post-body',thread?p.title:p.body);
  const foot=node(document,'div','post-foot');
  foot.append(node(document,'span','meta',thread?`${p.postCount} 投稿`:`返信 ${p.replyCount} · いいね ${p.likeCount}`));
  const open=node(document,'button','btn btn-ghost social-stream-open',thread?'スレッドを開く':'コミュニティで見る');open.type='button';open.onclick=()=>{if(isCurrent())return thread?onOpenThread(p):onOpenCommunityPost(p);};foot.append(open);
  content.append(head,kind,body,foot);card.append(avatar,content);
  card.tabIndex=0;
  card.addEventListener('click',e=>{if(!e.target.closest('a,button,input,textarea,select'))open.click();});
  card.addEventListener('keydown',e=>{if(e.target===card&&(e.key==='Enter'||e.key===' ')){e.preventDefault();open.click();}});
 }
 if(!card||card.ownerDocument!==document)throw bad();card.dataset.socialKind=item.kind;card.dataset.socialId=item.id;card.dataset.socialOrigin=item.origin;
 for(const event of ['click','auxclick','keydown'])card.addEventListener(event,e=>{if(!isCurrent()){e.preventDefault();e.stopImmediatePropagation();}},true);
 return card;
}
const labels={post:'投稿',thread:'スレッド',community_post:'コミュニティの投稿'};
export function createSocialStream({document,invoke,getContext,isCurrent=()=>true,renderPost,onOpenThread,onOpenCommunityPost,formatTime,onStatus=()=>{}}){
 const element=node(document,'section','social-stream'),state=node(document,'p','meta'),list=node(document,'div','social-stream-list'),actions=node(document,'div','actions'),retry=node(document,'button','head-action','再取得'),more=node(document,'button','head-action','もっと見る');state.setAttribute('role','status');retry.type=more.type='button';actions.append(retry,more);element.append(state,list,actions);
 let disposed=false,context=null,data=[],nextCursor=null,hasMore=false,failures=[],busy=false,request=null,paintToken={},pages=0,restoration=null;
 const navigations=new WeakSet();
 const live=captured=>{try{return !disposed&&isCurrent()&&same(captured,source(getContext));}catch{return false;}};
 const snapshot=()=>({context:context?{...context}:null,items:structuredClone(data),hasMore,nextCursor,failures:[...failures],busy});
 function paint(message=''){
  paintToken={};const token=paintToken,captured=context,goal=restoration;
  state.textContent=message;retry.disabled=busy||disposed;more.disabled=busy||disposed;more.hidden=!hasMore||failures.length>0;element.setAttribute('aria-busy',String(busy));
  const current=()=>live(captured)&&token===paintToken;
  retry.onclick=()=>current()&&(goal?runRestore(goal):manualRead(false));more.onclick=()=>current()&&manualRead(true);
  list.replaceChildren(...data.map(item=>renderSocialItem(document,item,{renderPost,onOpenThread,onOpenCommunityPost,isCurrent:current,primaryOrigin:captured?.origin??null,formatTime})));
  onStatus(snapshot());
 }
 function invalidate(){request={};context=null;data=[];nextCursor=null;hasMore=false;failures=[];busy=false;pages=0;restoration=null;paint('表示条件を確認して再取得してください。');}
 async function read(append,goal=null){
  if(disposed||!isCurrent()||goal&&restoration!==goal)return false;
  let captured;try{captured=source(getContext);}catch{invalidate();return false;}
  if(busy&&same(context,captured))return false;
  if(!same(context,captured)){request={};context=captured;data=[];nextCursor=null;hasMore=false;failures=[];pages=0;}
  if(append&&(!hasMore||failures.length))return false;
  const token={},before=data,after=append?nextCursor:null;request=token;busy=true;paint(before.length?'一覧を更新しています…':'タイムラインを読み込んでいます…');
  try{
   const raw=await invoke('hub_social_stream',{filter:captured.filter,scope:captured.scope,limit:20,cursor:after});
   if(request!==token||!live(captured)||goal&&restoration!==goal)return false;
   const page=parseSocialStream(raw,captured);if(append&&page.hasMore&&page.nextCursor===after)throw bad();
   const retained=append?before:before.filter(item=>page.failures.includes(item.kind)),seen=new Set(retained.map(key));
   const merged=[...retained,...page.items.filter(item=>!seen.has(key(item)))];
   if(append&&merged.some((item,index)=>index&&compare(merged[index-1],item)>0))throw bad();
   data=merged;
   if(!append&&retained.length)data.sort(compare);
   pages=append?pages+1:1;failures=page.failures;hasMore=page.hasMore;nextCursor=page.nextCursor;busy=false;
   paint(failures.length?`${failures.map(kind=>labels[kind]).join('・')}を再取得できませんでした。${retained.length?'同じ条件の前回表示を残しています。':''}`:data.length?'':({post:'投稿はまだありません。',thread:'スレッドはまだありません。',community:'コミュニティの投稿はまだありません。'}[context?.filter]??'表示できるものはまだありません。'));return true;
  }catch(error){
   if(request!==token||!live(captured)||goal&&restoration!==goal)return false;
   if(['social_stream_scope_changed','social_stream_auth_unavailable','social_stream_access_denied','scope_changed','auth_unavailable','access_denied'].includes(String(error?.message??error))||isReadAccessDenied(error)){data=[];hasMore=false;nextCursor=null;failures=[];pages=0;}
   busy=false;paint(data.length?'一覧を更新できませんでした。同じ条件の前回表示を残しています。':'タイムラインを読み込めませんでした。条件を確認して再取得してください。');return false;
  }finally{if(request===token&&!live(captured))busy=false;}
 }
 function manualRead(append){if(restoration){restoration=null;request={};busy=false;paint();}return read(append);}
 function navigation(){
  if(!live(context)||!pages||restoration)return null;
  const value=Object.freeze({context:Object.freeze({...context}),pages});navigations.add(value);return value;
 }
 async function runRestore(goal){
  if(restoration!==goal||goal.running)return false;
  if(!live(goal.captured)){invalidate();return false;}
  goal.running=true;request={};context=goal.captured;data=[];nextCursor=null;hasMore=false;failures=[];busy=false;pages=0;paint('戻り先の閲覧権限を確認しています…');
  const cursors=new Set();
  try{
   for(let index=0;index<goal.navigation.pages;index++){
    if(restoration!==goal)return false;
    if(!live(goal.captured)){invalidate();return false;}
    const loaded=await read(index>0,goal);
    if(restoration!==goal)return false;
    if(!live(goal.captured)){invalidate();return false;}
    if(!loaded||failures.length)return false;
    if(!hasMore)break;
    if(cursors.has(nextCursor)){paint('戻り先の続きの取得を確認できませんでした。再取得してください。');return false;}
    cursors.add(nextCursor);
   }
   if(restoration!==goal||!live(goal.captured))return false;
   restoration=null;paint();goal.onRestored?.();return true;
  }finally{goal.running=false;}
 }
 async function restore(value,onRestored){
  let captured;try{captured=source(getContext);}catch{return null;}
  if(disposed||!isCurrent()||!value||!navigations.has(value)||!same(captured,value.context))return null;
  const goal={navigation:value,captured,onRestored:typeof onRestored==='function'?onRestored:null,running:false};restoration=goal;return runRestore(goal);
 }
 paint();
 return{element,load:()=>manualRead(false),more:()=>manualRead(true),navigation,restore,invalidate,status:snapshot,destroy(){if(disposed)return;disposed=true;request={};context=null;data=[];hasMore=false;nextCursor=null;failures=[];busy=false;pages=0;restoration=null;paintToken={};list.replaceChildren();retry.disabled=more.disabled=true;}};
}
