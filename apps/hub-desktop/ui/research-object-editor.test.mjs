import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {researchObjectEditor,researchObjectInput,researchRelationInput} from './research-object-editor.mjs';
import {renderResearchProject} from './research.mjs';
const project={id:'rp_project',defaultLicense:'CC0',visibility:'public'};
const objects=[{id:'ro_first',projectId:project.id,title:'first',version:1},{id:'ro_second',projectId:project.id,title:'second',version:2},{id:'ro_foreign',projectId:'rp_other',title:'foreign',version:1}];
const input={objectType:'evidence',title:'成果',version:'1',contentHash:'sha256:'+'a'.repeat(64),license:'CC0',visibility:'confidential'};
const tick=()=>new Promise(setImmediate);
function fixture(t,{state={},data={},...options}={}){
  const dom=new JSDOM('<main><h3 data-research-section="研究成果">研究成果</h3></main>',{url:'http://localhost'}),root=dom.window.document.querySelector('main');
  const f={dom,root,state,calls:[],reloads:0,respond:async args=>args.action==='research_register_object'?{objectId:'ro_created'}:{created:true}};
  const settings={state,invoke:async(name,args)=>{f.calls.push({name,...args});return f.respond(args);},reload:async()=>{f.reloads++;},...options};
  f.controller=researchObjectEditor(root,{project,objects,signedIn:true,canEdit:true,...data},settings);
  t.after(()=>{f.controller?.dispose();dom.window.close();});return f;
}
function form(f,kind='object'){return f.root.querySelector(`[data-research-registration="${kind}"]`);}
function fill(f,values=input,kind='object'){
  for(const [key,value] of Object.entries(values)){const control=form(f,kind).elements[key];control.value=value;control.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));}
}
function submit(f,kind='object'){return form(f,kind).onsubmit(new f.dom.window.Event('submit',{cancelable:true}));}

test('object input accepts canonical metadata and scalar/safe-integer bounds; refuses coercions and controls',()=>{
  assert.deepEqual(researchObjectInput(input),{...input,version:1});
  assert.equal(researchObjectInput({...input,version:String(Number.MAX_SAFE_INTEGER),title:'🧪'.repeat(120),license:'x'.repeat(200)}).version,Number.MAX_SAFE_INTEGER);
  for(const change of [{version:'0'},{version:'-1'},{version:'1.5'},{version:'1e3'},{version:'1\n'},{version:'01'},{version:'9007199254740992'},{version:1},{title:'x'.repeat(241)},{title:'\ud800'},{title:'x\u0085'},{title:' '},{license:'x'.repeat(201)},{visibility:'everyone'},{objectType:'post'},{contentHash:input.contentHash+'\n'}])assert.throws(()=>researchObjectInput({...input,...change}));
});
test('relations require distinct selectable objects of this project',()=>{
  const value={fromObjectId:'ro_first',toObjectId:'ro_second',relationType:'replicated_by'};assert.deepEqual(researchRelationInput(value,objects,project.id),value);
  for(const change of [{toObjectId:'ro_first'},{toObjectId:'ro_foreign'},{toObjectId:'ro_missing'},{relationType:'follows'},{fromObjectId:'ro_first\n'}])assert.throws(()=>researchRelationInput({...value,...change},objects,project.id));
});
test('gates editor on local ownership, verified account and injected mutation path',t=>{
  for(const options of [{data:{canEdit:false}},{data:{signedIn:false}},{invoke:undefined},{sourceOrigin:'https://other.example'},{data:{project:{id:'rp_project\n'}}}])assert.equal(fixture(t,options).controller,null);
});
test('registers an object and relation through closed payloads and clears only the saved draft',async t=>{
  const f=fixture(t);fill(f);await submit(f);
  assert.deepEqual(f.calls[0],{name:'hub_client_action',action:'research_register_object',target:project.id,options:{...input,version:1}});assert.equal(f.reloads,1);assert.equal(form(f).elements.title.value,'');assert.match(f.root.textContent,/成果を登録しました/);
  assert.equal(form(f,'relation').querySelector('option[value="ro_foreign"]'),null);
  fill(f,{fromObjectId:'ro_first',toObjectId:'ro_second',relationType:'supported_by'},'relation');await submit(f,'relation');
  assert.deepEqual(f.calls[1],{name:'hub_client_action',action:'research_register_relation',target:project.id,options:{fromObjectId:'ro_first',toObjectId:'ro_second',relationType:'supported_by'}});assert.match(f.root.textContent,/関係を登録しました/);
});
test('validates public confirmation, keeps input on rejection and renders titles as inert text',async t=>{
  const f=fixture(t);fill(f,{...input,title:'<script>run()</script>',visibility:'public'});await submit(f);assert.equal(f.calls.length,0);assert.equal(form(f).elements.title.value,'<script>run()</script>');assert.match(f.root.textContent,/公開を確認/);
  form(f).elements.publicConfirmation.checked=true;form(f).elements.publicConfirmation.dispatchEvent(new f.dom.window.Event('change'));
  f.respond=async()=>{throw Error('research_register_object_rejected:400:拒否');};await submit(f);assert.equal(f.calls.length,1);assert.equal(form(f).elements.title.value,'<script>run()</script>');assert.equal(form(f).elements.title.disabled,false);assert.equal(f.root.querySelector('script'),null);
});
test('ambiguous transport or acknowledgement locks duplicate sending until explicit review after fresh reload',async t=>{
  for(const respond of [async()=>{throw Error('network offline');},async()=>({})]){
    const f=fixture(t);f.respond=respond;fill(f);await submit(f);assert.equal(form(f).elements.title.value,input.title);assert.equal(form(f).elements.title.disabled,true);await submit(f);assert.equal(f.calls.length,1);
    const button=text=>[...f.root.querySelectorAll('button')].find(item=>item.textContent===text);
    assert.equal(button('登録済み一覧を確認したので入力を再開する').disabled,true);await button('一覧を読み直す').onclick();assert.equal(f.reloads,1);assert.equal(button('登録済み一覧を確認したので入力を再開する').disabled,false);button('登録済み一覧を確認したので入力を再開する').click();assert.equal(form(f).elements.title.disabled,false);assert.equal(form(f).elements.title.value,input.title);
  }
});
test('failed list reload cannot unlock ambiguous registration',async t=>{
  const f=fixture(t,{reload:async()=>{throw Error('read unavailable');}});f.respond=async()=>({});fill(f);await submit(f);await [...f.root.querySelectorAll('button')].find(item=>item.textContent==='一覧を読み直す').onclick();
  assert.equal([...f.root.querySelectorAll('button')].find(item=>item.textContent==='登録済み一覧を確認したので入力を再開する').disabled,true);assert.match(f.root.textContent,/一覧を取得できません/);assert.equal(f.calls.length,1);
});
test('suppresses double submit and stale completion after account change, even after disposal',async t=>{
  for(const dispose of [false,true]){
    const f=fixture(t);let finish;f.respond=()=>new Promise(resolve=>finish=resolve);fill(f);const pending=submit(f);await submit(f);assert.equal(f.calls.length,1);
    if(dispose)f.controller.dispose();f.dom.window.dispatchEvent(new f.dom.window.Event('hub-account-changed'));finish({objectId:'ro_created'});await pending;
    assert.equal(f.reloads,0);assert.equal(f.state.objectRegistration,undefined);assert.doesNotMatch(f.root.textContent,/成果を登録しました/);assert.match(f.root.textContent,/接続が変わりました/);
  }
});
test('navigation return preserves pending operation and receives acknowledgement without another write',async t=>{
  const state={},old=fixture(t,{state});let finish;old.respond=()=>new Promise(resolve=>finish=resolve);fill(old);const pending=submit(old);old.controller.dispose();const returned=fixture(t,{state});assert.equal(form(returned).elements.title.disabled,true);finish({objectId:'ro_created'});await pending;
  assert.equal(returned.calls.length,0);assert.equal(returned.reloads,0);assert.equal(form(returned).elements.title.value,'');assert.match(returned.root.textContent,/成果を登録しました/);
});
test('saved registration with reload failure cannot be mistaken for an unsaved draft',async t=>{
  const f=fixture(t,{reload:async()=>{throw Error('read offline');}});fill(f);await submit(f);assert.equal(form(f).elements.title.value,'');assert.match(f.root.textContent,/登録済みです。表示の更新に失敗/);await submit(f);assert.equal(f.calls.length,1);
});
test('project renderer mounts owner editor and returns a lifecycle controller',async t=>{
  const f=fixture(t);f.controller.dispose();let calls=0;
  const controller=renderResearchProject(f.root,{project,objects,relations:[],signedIn:true,canEdit:true},()=>{},()=>{},()=>{},{state:{},invoke:async(name,args)=>{if(name==='hub_detail'&&args.name==='research_pdfs')return{projectId:project.id,pdfs:[],signedIn:true,canEdit:true};calls++;return {objectId:'ro_created'};}});
  assert.equal(f.root.querySelectorAll('[data-research-registration]').length,2);assert.equal(calls,0);assert.equal(typeof controller.dispose,'function');controller.dispose();assert.equal(form(f).elements.title.disabled,true);await tick();
});
