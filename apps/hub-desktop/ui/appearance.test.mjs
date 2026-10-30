import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {APPEARANCE_KEY, normalizeAppearance, loadAppearance, saveAppearance, resolveTheme, applyAppearance, createAppearanceSettings} from './appearance.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const memory=()=>{const map=new Map();return{getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),map};};
const fakeMedia=(matches)=>{const listeners=[];return{matches,addEventListener:(_,fn)=>listeners.push(fn),flip(next){this.matches=next;for(const fn of listeners)fn();}};};
const fixture=(stored,media=fakeMedia(true))=>{
  const dom=new JSDOM('<html><body></body></html>');const storage=memory();
  if(stored!==undefined)storage.setItem(APPEARANCE_KEY,typeof stored==='string'?stored:JSON.stringify(stored));
  const widget=createAppearanceSettings({document:dom.window.document,storage,media});dom.window.document.body.append(widget.element);
  const root=dom.window.document.documentElement;
  const pick=(name,value)=>{const input=widget.element.querySelector(`input[name="appearance-${name}"][value="${value}"]`);input.checked=true;input.dispatchEvent(new dom.window.Event('change'));};
  return{dom,storage,widget,root,pick,media};
};

test('defaults keep the existing dark look and reject unknown values',()=>{
  assert.deepEqual(normalizeAppearance(null),{theme:'dark',palette:'standard',textSize:'normal',density:'normal',reduceMotion:false,reduceTransparency:false});
  assert.deepEqual(normalizeAppearance({theme:'blue',textSize:'huge',density:'tight',reduceMotion:'yes'}),{theme:'dark',palette:'standard',textSize:'normal',density:'normal',reduceMotion:false,reduceTransparency:false});
});
test('load and save survive broken or throwing storage',()=>{
  const s=memory();assert.equal(saveAppearance(s,{theme:'light',palette:'standard',textSize:'large',density:'roomy',reduceMotion:true,reduceTransparency:true}),true);
  assert.deepEqual(loadAppearance(s),{theme:'light',palette:'standard',textSize:'large',density:'roomy',reduceMotion:true,reduceTransparency:true});
  s.setItem(APPEARANCE_KEY,'{broken');assert.equal(loadAppearance(s).theme,'dark');
  const bad={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  assert.equal(loadAppearance(bad).theme,'dark');assert.equal(saveAppearance(bad,{}),false);assert.equal(loadAppearance(null).textSize,'normal');
});
test('system theme follows the OS, explicit theme does not',()=>{
  assert.equal(resolveTheme('system',true),'dark');assert.equal(resolveTheme('system',false),'light');
  assert.equal(resolveTheme('light',true),'light');assert.equal(resolveTheme('dark',false),'dark');
});
test('applyAppearance writes the html attributes and clears motion',()=>{
  const {root}=fixture();
  applyAppearance(root,{theme:'light',palette:'standard',textSize:'xlarge',density:'roomy',reduceMotion:true,reduceTransparency:true},true);
  assert.deepEqual([root.dataset.theme,root.dataset.textSize,root.dataset.density,root.dataset.motion],['light','xlarge','roomy','reduce']);
  applyAppearance(root,{},true);assert.equal(root.dataset.motion,undefined);assert.equal(root.dataset.theme,'dark');
});
test('choosing a setting applies at once and persists; stored settings apply on creation',()=>{
  const f=fixture({theme:'light',palette:'standard',textSize:'large',density:'normal',reduceMotion:false,reduceTransparency:false});
  assert.equal(f.root.dataset.theme,'light');assert.equal(f.root.dataset.textSize,'large');
  assert.equal(f.widget.element.querySelector('input[name="appearance-theme"][value="light"]').checked,true);
  f.pick('textSize','xlarge');f.pick('density','roomy');
  const check=f.widget.element.querySelector('.appearance-motion input');check.checked=true;check.dispatchEvent(new f.dom.window.Event('change'));
  assert.deepEqual(JSON.parse(f.storage.map.get(APPEARANCE_KEY)),{theme:'light',palette:'standard',textSize:'xlarge',density:'roomy',reduceMotion:true,reduceTransparency:false});
  assert.equal(f.root.dataset.textSize,'xlarge');assert.equal(f.root.dataset.motion,'reduce');
  f.widget.element.querySelector('.head-action').click();
  assert.deepEqual(f.widget.value,{theme:'dark',palette:'standard',textSize:'normal',density:'normal',reduceMotion:false,reduceTransparency:false});assert.equal(f.root.dataset.theme,'dark');
});
test('system theme re-resolves when the OS scheme changes, other themes ignore it',()=>{
  const f=fixture({theme:'system'},fakeMedia(true));assert.equal(f.root.dataset.theme,'dark');
  f.media.flip(false);assert.equal(f.root.dataset.theme,'light');
  f.pick('theme','dark');f.media.flip(true);f.media.flip(false);assert.equal(f.root.dataset.theme,'dark');
});
test('unwritable storage still applies for this run and says so',()=>{
  const dom=new JSDOM('<body></body>');const storage={getItem(){throw Error('x');},setItem(){throw Error('x');}};
  const w=createAppearanceSettings({document:dom.window.document,storage,media:fakeMedia(false)});
  const input=w.element.querySelector('input[name="appearance-theme"][value="light"]');input.checked=true;input.dispatchEvent(new dom.window.Event('change'));
  assert.equal(dom.window.document.documentElement.dataset.theme,'light');assert.match(w.element.querySelector('[role=status]').textContent,/保存できませんでした/);
});
test('appearance-early.js applies the same attributes as appearance.mjs before first paint',()=>{
  const source=readFileSync(new URL('./appearance-early.js',import.meta.url),'utf8');
  for(const [stored,dark] of [[null,false],[{theme:'light',palette:'standard',textSize:'large',density:'roomy',reduceMotion:true,reduceTransparency:true},true],[{theme:'system'},false],[{theme:'system'},true],['{broken',true],[{theme:'x',textSize:'y'},false]]){
    const dom=new JSDOM('<html></html>');const store=memory();if(stored!==null)store.setItem(APPEARANCE_KEY,typeof stored==='string'?stored:JSON.stringify(stored));
    const win={localStorage:store,matchMedia:()=>({matches:dark})};
    vm.runInNewContext(source,{window:win,document:dom.window.document});
    const expected=dom.window.document.implementation.createHTMLDocument('').documentElement;
    applyAppearance(expected,typeof stored==='string'?null:stored,dark);
    for(const key of ['data-theme','data-theme-mode','data-text-size','data-density','data-motion','data-transparency'])assert.equal(dom.window.document.documentElement.getAttribute(key),expected.getAttribute(key),`${key} for ${JSON.stringify(stored)} dark=${dark}`);
  }
  const noStorage=new JSDOM('<html></html>');
  vm.runInNewContext(source,{window:{get localStorage(){throw Error('blocked');},matchMedia(){throw Error('none');}},document:noStorage.window.document});
  assert.equal(noStorage.window.document.documentElement.dataset.theme,'dark');
});
test('index.html loads the early script first, settings css uses tokens only, dark stays the default',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.ok(html.indexOf('appearance-early.js')>0&&html.indexOf('appearance-early.js')<html.indexOf('styles.css'));
  assert.ok(html.indexOf('settings-view.css')>html.indexOf('hub-design.css'));
  const css=readFileSync(new URL('./settings-view.css',import.meta.url),'utf8');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g,''),/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\bwhite\b|\bblack\b/);
  assert.match(readFileSync(new URL('./tokens.css',import.meta.url),'utf8'),/html\[data-theme="dark"\]/);
});
test('gold palette sets data-palette on top of either theme and standard removes it',()=>{
  const f=fixture();
  f.pick('palette','gold-ivory');
  assert.equal(f.root.dataset.palette,'gold-ivory');assert.equal(f.root.dataset.theme,'dark');
  assert.equal(JSON.parse(f.storage.map.get(APPEARANCE_KEY)).palette,'gold-ivory');
  f.pick('theme','light');
  assert.deepEqual([f.root.dataset.palette,f.root.dataset.theme],['gold-ivory','light']);
  f.pick('palette','standard');
  assert.equal(f.root.dataset.palette,undefined);
});
