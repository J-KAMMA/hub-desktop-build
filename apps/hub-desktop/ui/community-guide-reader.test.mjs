import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {communityGuideCatalog,communityGuidePage,communityGuideRequest} from './community-guide-reader.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const catalog=(offset=0,last=false)=>({pages:[{id:`g${offset}`,title:`Guide ${offset}`,version:1,directoryName:'Start',updatedAt:'now'}],page:{offset,hasMore:!last,nextOffset:last?null:offset+20}});
const history=(offset=0,last=false)=>({revisions:[{id:`r${offset}`,title:`Revision ${offset}`,revisionNo:41-offset,editorName:null,createdAt:'then'}],page:{offset,hasMore:!last,nextOffset:last?null:offset+20}});
const button=(root,label)=>[...root.querySelectorAll('button')].find(node=>node.textContent===label);
test('catalogue paging preserves the current page on failure and reuses the page when returning from a guide',async()=>{
  const dom=new JSDOM(''),state={},entry={name:'community_guides',ids:['c1'],guidePage:state},calls=[],opened=[];let fail=true;
  const root=communityGuideCatalog(dom.window.document,{communityId:'c1',data:catalog(),state,invoke:async(_,payload)=>{calls.push(payload);if(fail)throw Error('offline');return catalog(20)},onOpen:(...args)=>opened.push(args)});
  button(root,'次の20件').click();await tick();assert.match(root.textContent,/offline/);assert.match(root.textContent,/Guide 0/);assert.equal(state.offset,0);
  fail=false;button(root,'次の20件').click();await tick();assert.equal(state.offset,20);assert.match(root.textContent,/Guide 20/);assert.deepEqual(calls[1],{name:'community_guides_page',ids:['c1','20']});
  button(root,'Guide 20').click();assert.deepEqual(opened,[['community_guide',['c1','g20'],'Guide 20']]);assert.deepEqual(communityGuideRequest(entry),{name:'community_guides_page',ids:['c1','20']});
  dom.window.close();
});
test('history pages are metadata only; the selected revision opens with all three IDs',async()=>{
  const dom=new JSDOM(''),state={},opened=[];let release;const calls=[];
  const root=communityGuideCatalog(dom.window.document,{communityId:'c1',pageId:'g1',history:true,data:history(),state,onOpen:(...args)=>opened.push(args),invoke:async(_,p)=>{calls.push(p);await new Promise(resolve=>release=resolve);return history(20,true)}});
  button(root,'次の20件').click();button(root,'次の20件').click();assert.equal(calls.length,1);assert.equal(button(root,'次の20件').disabled,true);release();await tick();
  assert.match(root.textContent,/退会したユーザー/);assert.equal(button(root,'次の20件').disabled,true);button(root,'v21 Revision 20').click();assert.deepEqual(opened,[['community_guide_revision',['c1','g1','r20'],'Revision 20']]);
  assert.deepEqual(communityGuideRequest({name:'community_guide_revisions',ids:['c1','g1'],guidePage:state}),{name:'community_guide_revisions_page',ids:['c1','g1','20']});dom.window.close();
});
test('full pages and removed-editor revisions render text literally and retain the history action',()=>{
  const dom=new JSDOM(''),opened=[],body='<img src=x onerror=alert(1)>\n'+ '長い本文'.repeat(800);
  const root=communityGuidePage(dom.window.document,{data:{page:{title:'Guide',body,version:42}},communityId:'c1',pageId:'g1',onOpen:(...args)=>opened.push(args)});
  assert.equal(root.querySelector('img'),null);assert.equal(root.querySelector('.community-guide-body').textContent,body);button(root,'改訂履歴').click();assert.deepEqual(opened,[['community_guide_revisions',['c1','g1'],'Guide']]);
  const old=communityGuidePage(dom.window.document,{data:{revision:{title:'Old',body,revisionNo:1,editorName:null}},revision:true});assert.match(old.textContent,/退会したユーザー/);assert.equal(old.querySelector('button'),null);dom.window.close();
});
test('empty lists and malformed pagination never remove the existing page or move its history cursor',async()=>{
  const dom=new JSDOM(''),state={},root=communityGuideCatalog(dom.window.document,{communityId:'c1',data:catalog(),state,invoke:async()=>catalog(0),onOpen:()=>{}});
  button(root,'次の20件').click();await tick();assert.equal(state.offset,0);assert.match(root.textContent,/ページを確認できません/);assert.match(root.textContent,/Guide 0/);
  const empty=communityGuideCatalog(dom.window.document,{communityId:'c1',data:{pages:[],page:{offset:0,hasMore:false,nextOffset:null}},onOpen:()=>{}});assert.match(empty.textContent,/ガイドはまだありません/);assert.equal(button(empty,'次の20件').disabled,true);
  assert.deepEqual(communityGuideRequest({name:'thread',ids:['t1'],guidePage:{offset:20}}),{name:'thread',ids:['t1']});dom.window.close();
});

test('classification browsing preserves its successful selection and cursor across failures, paging and returning',async()=>{
 const dom=new JSDOM(''),state={},calls=[];let fail=true;
 const data={...catalog(20),directoryId:null,directories:[{id:'start',name:'Start'},{id:'child',name:'Child',parentId:'start'}]};
 const root=communityGuideCatalog(dom.window.document,{communityId:'c1',data,state,onOpen:()=>{},invoke:async(_,p)=>{calls.push(p);if(fail)throw Error('offline');return {...catalog(Number(p.ids[1])),directories:data.directories,directoryId:p.ids[2]??null};}});
 const select=root.querySelector('select');assert.equal(select.options[2].textContent,'Start / Child');
 select.value='child';select.dispatchEvent(new dom.window.Event('change'));await tick();assert.equal(select.value,'');assert.deepEqual(state,{offset:20,directoryId:null});
 fail=false;select.value='child';select.dispatchEvent(new dom.window.Event('change'));await tick();assert.deepEqual(state,{offset:0,directoryId:'child'});assert.deepEqual(calls.at(-1),{name:'community_guides_directory_page',ids:['c1','0','child']});
 button(root,'次の20件').click();await tick();assert.equal(state.offset,20);assert.deepEqual(communityGuideRequest({name:'community_guides',ids:['c1'],guidePage:state}),{name:'community_guides_directory_page',ids:['c1','20','child']});
 select.value='';select.dispatchEvent(new dom.window.Event('change'));await tick();assert.deepEqual(state,{offset:0,directoryId:null});assert.deepEqual(calls.at(-1),{name:'community_guides_page',ids:['c1','0']});dom.window.close();
});
test('wrong classification acknowledgements keep the old page, and cyclic directory labels render once as literal text',async()=>{
 const dom=new JSDOM(''),state={},data={...catalog(),directories:[{id:'a',name:'<script>x</script>',parentId:'b'},{id:'b',name:'B',parentId:'a'}]};
 const root=communityGuideCatalog(dom.window.document,{communityId:'c1',data,state,onOpen:()=>{},invoke:async()=>({...catalog(),directoryId:'other'})});
 const select=root.querySelector('select');assert.equal(root.querySelector('script'),null);assert.equal(select.options[1].textContent,'B / <script>x</script>');
 select.value='a';select.dispatchEvent(new dom.window.Event('change'));await tick();assert.equal(state.directoryId,null);assert.equal(select.value,'');assert.match(root.textContent,/分類を確認できません/);dom.window.close();
});
