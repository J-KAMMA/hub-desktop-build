import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {APPEARANCE_KEY, TEMPLATE_KEY, TEMPLATES, normalizeAppearance, loadAppearance, saveAppearance, resolveTemplate, migrateTemplate, applyAppearance, createAppearanceSettings} from './appearance.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const memory=()=>{const map=new Map();return{getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),map};};
const fakeMedia=(matches)=>{const listeners=[];return{matches,addEventListener:(_,fn)=>listeners.push(fn),flip(next){this.matches=next;for(const fn of listeners)fn();}};};
const put=(storage,key,value)=>{if(value!==undefined)storage.setItem(key,typeof value==='string'?value:JSON.stringify(value));};
const fixture=(stored,media=fakeMedia(true),template)=>{
  const dom=new JSDOM('<html><body></body></html>');const storage=memory();
  put(storage,APPEARANCE_KEY,stored);put(storage,TEMPLATE_KEY,template);
  const widget=createAppearanceSettings({document:dom.window.document,storage,media});dom.window.document.body.append(widget.element);
  const root=dom.window.document.documentElement;
  const choose=(id)=>widget.element.querySelector(`button[data-template-choice="${id}"]`).click();
  return{dom,storage,widget,root,choose,media};
};
const DEFAULTS={template:'noir',crisp:false,textSize:'normal',density:'normal',reduceMotion:false,reduceTransparency:false};

test('there are five templates and the default is Noir',()=>{
  assert.deepEqual(TEMPLATES.map(t=>t.id),['light','dark','noir','ivory','midnight']);
  assert.deepEqual(normalizeAppearance(null),DEFAULTS);
  assert.deepEqual(normalizeAppearance({template:'blue',crisp:'yes',textSize:'huge',density:'tight',reduceMotion:'yes'}),DEFAULTS);
  for(const t of [...TEMPLATES.map(x=>x.id),'device'])assert.equal(normalizeAppearance({template:t}).template,t);
});
test('load and save survive broken or throwing storage',()=>{
  const s=memory();assert.equal(saveAppearance(s,{template:'midnight',crisp:true,textSize:'large',density:'roomy',reduceMotion:true,reduceTransparency:true}),true);
  assert.deepEqual(loadAppearance(s),{template:'midnight',crisp:true,textSize:'large',density:'roomy',reduceMotion:true,reduceTransparency:true});
  assert.deepEqual(JSON.parse(s.map.get(TEMPLATE_KEY)),{template:'midnight',crisp:true});
  assert.equal(JSON.parse(s.map.get(APPEARANCE_KEY)).template,undefined);
  s.setItem(TEMPLATE_KEY,'{broken');s.setItem(APPEARANCE_KEY,'{broken');assert.equal(loadAppearance(s).template,'noir');
  const bad={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  assert.equal(loadAppearance(bad).template,'noir');assert.equal(saveAppearance(bad,{}),false);assert.equal(loadAppearance(null).textSize,'normal');
});
test('the new key lives under the hub.desktop. prefix',()=>{
  assert.equal(TEMPLATE_KEY,'hub.desktop.template');assert.ok(APPEARANCE_KEY.startsWith('hub.desktop.'));
});
test('migration: old theme and palette map to the new templates, once',()=>{
  const cases=[[{theme:'dark',palette:'gold-ivory'},'noir'],[{theme:'light',palette:'gold-ivory'},'ivory'],[{theme:'light',palette:'standard'},'light'],[{theme:'dark',palette:'standard'},'dark'],
    [{theme:'light'},'light'],[{theme:'dark'},'dark'],[{palette:'gold-ivory'},'noir'],[{theme:'system'},'device'],[{theme:'system',palette:'gold-ivory'},'device'],
    [{textSize:'large'},'noir'],[{},'noir'],[null,'noir']];
  for(const [old,expected] of cases){
    assert.equal(migrateTemplate(old),expected,JSON.stringify(old));
    const s=memory();put(s,APPEARANCE_KEY,old??undefined);
    assert.equal(loadAppearance(s).template,expected,`load ${JSON.stringify(old)}`);
  }
  const s=memory();put(s,APPEARANCE_KEY,{theme:'light',palette:'gold-ivory',textSize:'large'});
  const first=loadAppearance(s);
  assert.deepEqual(JSON.parse(s.map.get(TEMPLATE_KEY)),{template:'ivory',crisp:false});
  assert.equal(first.textSize,'large');
  // 2 回目以降は新しい鍵だけを読む: 旧い theme / palette を書き換えても結果は変わらない
  put(s,APPEARANCE_KEY,{theme:'dark',palette:'standard',textSize:'large'});
  assert.equal(loadAppearance(s).template,'ivory');
  // 保存が書けなくても、この起動では移行先が効く
  const readOnly={getItem:k=>(k===APPEARANCE_KEY?JSON.stringify({theme:'light'}):null),setItem(){throw Error('blocked');}};
  assert.equal(loadAppearance(readOnly).template,'light');
  // 何も選んでいなければ新しい鍵を作らない
  const fresh=memory();loadAppearance(fresh);assert.equal(fresh.map.has(TEMPLATE_KEY),false);
});
test('端末に合わせる follows the OS, an explicit template does not',()=>{
  assert.equal(resolveTemplate('device',true),'dark');assert.equal(resolveTemplate('device',false),'light');
  for(const t of TEMPLATES)for(const dark of [true,false])assert.equal(resolveTemplate(t.id,dark),t.id);
  assert.equal(resolveTemplate('nonsense',false),'noir');
});
test('applyAppearance writes data-template, the light/dark scheme, crisp and the other attributes',()=>{
  const {root}=fixture();
  const expected={light:'light',dark:'dark',noir:'dark',ivory:'light',midnight:'dark'};
  for(const [id,scheme] of Object.entries(expected)){
    applyAppearance(root,{template:id},false);
    assert.deepEqual([root.dataset.template,root.dataset.theme,root.dataset.themeMode],[id,scheme,scheme],id);
  }
  applyAppearance(root,{template:'device',crisp:true,textSize:'xlarge',density:'roomy',reduceMotion:true,reduceTransparency:true},false);
  assert.deepEqual([root.dataset.template,root.dataset.theme,root.dataset.themeMode,root.hasAttribute('data-crisp'),root.dataset.textSize,root.dataset.density,root.dataset.motion,root.dataset.transparency],['light','light','system',true,'xlarge','roomy','reduce','reduce']);
  root.setAttribute('data-palette','gold-ivory');
  applyAppearance(root,{},true);
  assert.deepEqual([root.dataset.template,root.dataset.theme,root.hasAttribute('data-crisp'),root.dataset.motion,root.hasAttribute('data-palette')],['noir','dark',false,undefined,false]);
});
test('the settings UI is one row of five swatches plus 端末に合わせる, a くっきり toggle, and no old テーマ / 配色 rows',()=>{
  const f=fixture();
  const names=[...f.widget.element.querySelectorAll('.template-swatch .template-name')].map(n=>n.textContent);
  assert.deepEqual(names,['Light','Dark','Noir','Ivory','Midnight','端末に合わせる']);
  assert.equal(f.widget.element.querySelectorAll('.template-swatches > button').length,6);
  assert.equal(f.widget.element.querySelectorAll('.template-swatches [data-template]').length,5+2);
  assert.equal(f.widget.element.querySelector('input[name="appearance-theme"]'),null);
  assert.equal(f.widget.element.querySelector('input[name="appearance-palette"]'),null);
  const labels=[...f.widget.element.querySelectorAll('.setting-label')].map(n=>n.textContent);
  assert.ok(labels.includes('くっきり表示')&&labels.includes('カラーテンプレート'));
  assert.ok(!labels.includes('配色')&&!labels.includes('色合い'));
  assert.equal(f.widget.element.querySelector('.template-swatches').getAttribute('role'),'radiogroup');
  const checked=[...f.widget.element.querySelectorAll('.template-swatch[aria-checked="true"]')];
  assert.deepEqual(checked.map(b=>b.dataset.templateChoice),['noir']);
});
test('choosing a swatch applies at once, persists, and stays a single selection',()=>{
  const f=fixture({textSize:'large'});
  assert.equal(f.root.dataset.template,'noir');assert.equal(f.root.dataset.textSize,'large');
  f.choose('midnight');
  assert.deepEqual([f.root.dataset.template,f.root.dataset.theme],['midnight','dark']);
  assert.deepEqual(JSON.parse(f.storage.map.get(TEMPLATE_KEY)),{template:'midnight',crisp:false});
  assert.deepEqual([...f.widget.element.querySelectorAll('[aria-checked="true"]')].map(b=>b.dataset.templateChoice),['midnight']);
  f.choose('ivory');assert.deepEqual([f.root.dataset.template,f.root.dataset.theme],['ivory','light']);
  f.choose('device');
  assert.deepEqual([...f.widget.element.querySelectorAll('[aria-checked="true"]')].map(b=>b.dataset.templateChoice),['device']);
  assert.equal(f.root.dataset.template,'dark');
  const crisp=f.widget.element.querySelector('.appearance-crisp input');crisp.checked=true;crisp.dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(f.root.hasAttribute('data-crisp'),true);
  assert.deepEqual(JSON.parse(f.storage.map.get(TEMPLATE_KEY)),{template:'device',crisp:true});
  assert.equal(f.widget.element.querySelectorAll('.template-chip[data-crisp]').length,8);
  f.widget.element.querySelector('.head-action').click();
  assert.deepEqual(f.widget.value,DEFAULTS);assert.equal(f.root.dataset.template,'noir');assert.equal(f.root.hasAttribute('data-crisp'),false);
});
test('くっきり is independent of the template',()=>{
  const f=fixture();
  const crisp=f.widget.element.querySelector('.appearance-crisp input');crisp.checked=true;crisp.dispatchEvent(new f.dom.window.Event('change'));
  for(const t of TEMPLATES){f.choose(t.id);assert.equal(f.root.hasAttribute('data-crisp'),true,t.id);assert.equal(crisp.checked,true);}
});
test('端末に合わせる re-resolves when the OS scheme changes, other templates ignore it',()=>{
  const f=fixture(undefined,fakeMedia(true),{template:'device'});assert.equal(f.root.dataset.template,'dark');
  f.media.flip(false);assert.equal(f.root.dataset.template,'light');assert.equal(f.root.dataset.theme,'light');
  f.choose('noir');f.media.flip(true);f.media.flip(false);assert.equal(f.root.dataset.template,'noir');
});
test('stored settings apply on creation and old text-size choices survive the move',()=>{
  const f=fixture({theme:'light',palette:'gold-ivory',textSize:'large',density:'roomy',reduceMotion:true},fakeMedia(false));
  assert.deepEqual([f.root.dataset.template,f.root.dataset.textSize,f.root.dataset.density,f.root.dataset.motion],['ivory','large','roomy','reduce']);
  assert.equal(f.widget.element.querySelector('[data-template-choice="ivory"]').getAttribute('aria-checked'),'true');
});
test('unwritable storage still applies for this run and says so',()=>{
  const dom=new JSDOM('<body></body>');const storage={getItem(){throw Error('x');},setItem(){throw Error('x');}};
  const w=createAppearanceSettings({document:dom.window.document,storage,media:fakeMedia(false)});
  w.element.querySelector('[data-template-choice="light"]').click();
  assert.equal(dom.window.document.documentElement.dataset.template,'light');assert.match(w.element.querySelector('[role=status]').textContent,/保存できませんでした/);
});
const RUN_KEYS=['data-template','data-theme','data-theme-mode','data-crisp','data-text-size','data-density','data-motion','data-transparency'];
function runEarly(stored,template,dark){
  const source=readFileSync(new URL('./appearance-early.js',import.meta.url),'utf8');
  const dom=new JSDOM('<html></html>');const store=memory();put(store,APPEARANCE_KEY,stored);put(store,TEMPLATE_KEY,template);
  vm.runInNewContext(source,{window:{localStorage:store,matchMedia:()=>({matches:dark})},document:dom.window.document});
  return{root:dom.window.document.documentElement,store};
}
test('no flash: appearance-early.js sets the same attributes as appearance.mjs before first paint, including migration',()=>{
  const cases=[[undefined,undefined],[{theme:'light',palette:'standard',textSize:'large',density:'roomy',reduceMotion:true,reduceTransparency:true},undefined],
    [{theme:'dark',palette:'gold-ivory'},undefined],[{theme:'light',palette:'gold-ivory'},undefined],[{theme:'dark',palette:'standard'},undefined],[{theme:'system'},undefined],
    ['{broken',undefined],[{theme:'x',textSize:'y'},undefined],[undefined,{template:'midnight',crisp:true}],[undefined,{template:'device'}],[{theme:'light'},{template:'ivory',crisp:true}],[undefined,{template:'nope'}],[undefined,'{broken']];
  for(const [stored,template] of cases)for(const dark of [true,false]){
    const early=runEarly(stored,template,dark);
    const s=memory();put(s,APPEARANCE_KEY,stored);put(s,TEMPLATE_KEY,template);
    const expected=new JSDOM('<html></html>').window.document.documentElement;
    applyAppearance(expected,loadAppearance(s),dark);
    for(const key of RUN_KEYS)assert.equal(early.root.getAttribute(key),expected.getAttribute(key),`${key} for ${JSON.stringify([stored,template])} dark=${dark}`);
    assert.equal(early.root.hasAttribute('data-palette'),false);
  }
});
test('no flash: the early script migrates the old keys once and tolerates blocked storage',()=>{
  const a=runEarly({theme:'light',palette:'gold-ivory'},undefined,true);
  assert.equal(a.root.getAttribute('data-template'),'ivory');assert.deepEqual(JSON.parse(a.store.map.get(TEMPLATE_KEY)),{template:'ivory',crisp:false});
  const fresh=runEarly(undefined,undefined,false);
  assert.equal(fresh.root.getAttribute('data-template'),'noir');assert.equal(fresh.store.map.has(TEMPLATE_KEY),false);
  const dom=new JSDOM('<html></html>');
  vm.runInNewContext(readFileSync(new URL('./appearance-early.js',import.meta.url),'utf8'),{window:{get localStorage(){throw Error('blocked');},matchMedia(){throw Error('none');}},document:dom.window.document});
  assert.deepEqual([dom.window.document.documentElement.dataset.template,dom.window.document.documentElement.dataset.theme],['noir','dark']);
  const blockedWrite=new JSDOM('<html></html>');
  vm.runInNewContext(readFileSync(new URL('./appearance-early.js',import.meta.url),'utf8'),{window:{localStorage:{getItem:k=>(k===APPEARANCE_KEY?'{"theme":"light"}':null),setItem(){throw Error('full');}},matchMedia:()=>({matches:true})},document:blockedWrite.window.document});
  assert.equal(blockedWrite.window.document.documentElement.dataset.template,'light');
});
test('index.html and newtab.html load the early script before any stylesheet; settings css uses tokens only; every template is defined in tokens.css',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.ok(html.indexOf('appearance-early.js')>0&&html.indexOf('appearance-early.js')<html.indexOf('styles.css'));
  const newtab=readFileSync(new URL('./newtab.html',import.meta.url),'utf8');
  assert.ok(newtab.indexOf('appearance-early.js')>0&&newtab.indexOf('appearance-early.js')<newtab.indexOf('tokens.css'));
  assert.ok(html.indexOf('settings-view.css')>html.indexOf('hub-design.css'));
  const css=readFileSync(new URL('./settings-view.css',import.meta.url),'utf8');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g,''),/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\bwhite\b|\bblack\b/);
  const tokens=readFileSync(new URL('./tokens.css',import.meta.url),'utf8');
  for(const t of TEMPLATES){
    assert.equal(tokens.split(`[data-template="${t.id}"] {`).length-1,1,`${t.id} tokens are defined exactly once`);
    assert.equal(tokens.split(`[data-template="${t.id}"][data-crisp] {`).length-1,1,`${t.id} くっきり tokens are defined exactly once`);
  }
  assert.match(tokens,/html:not\(\[data-template\]\),\s*\[data-template="noir"\] \{/);
  assert.doesNotMatch(tokens,/data-palette/);
});
