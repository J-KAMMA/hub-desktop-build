import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createSettingsNav, createIdentityPanel, createCachePanel, createBrowserPanel, createAboutPanel} from './settings-view.mjs';
import {createAppearanceSettings} from './appearance.mjs';
import {createMediaP2pSettings} from './media-p2p-settings.mjs';
import {createAiConnectionsPanel} from './byok-connections.mjs';
import {createSettingsSearch, matchSettings, normalizeForSearch, collectSettingItems} from './settings-search.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,0));};
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');

const invoke=async(command)=>{
  if(command==='byok_list')return{connections:[],cli:[]};
  if(command==='media_p2p_settings_get')return{receiveFromPeers:false,seed:false,relayOnly:false,cacheLimitMib:2048};
  if(command==='media_cache_usage')return[0,0];
  if(command==='browser_protection_status')return{supported:true,enabled:false,ready:true};
  if(command==='portable_identity_public')return{didKey:'did:key:zTest'};
  return null;
};
/** index.html に、app.js と同じように各節の部品を載せた画面。 */
function mounted(){
  const dom=new JSDOM(html.replace(/<script[^>]*src=[^>]*><\/script>/g,''),{pretendToBeVisual:true});
  const document=dom.window.document;
  const storage={getItem:()=>null,setItem:()=>{}};
  const media=createMediaP2pSettings({document,invoke});
  document.querySelector('#settings-media-p2p').append(media.element);
  const panels={
    appearance:createAppearanceSettings({document,storage,media:{matches:false,addEventListener(){}}}),
    identity:createIdentityPanel({document,invoke}),cache:createCachePanel({document,invoke}),
    browser:createBrowserPanel({document,invoke}),ai:createAiConnectionsPanel({document,invoke,listen:async()=>()=>{}}),
    about:createAboutPanel({document,invoke,getVersion:async()=>'0.0.0'}),
  };
  for(const [id,panel] of Object.entries(panels))document.querySelector(`#settings-${id}`)?.append(panel.element);
  const nav=createSettingsNav({document});
  const input=document.querySelector('#settings-search');
  const search=createSettingsSearch({document,input,panel:document.querySelector('[data-settings-panel="search"]'),nav});
  return{dom,document,nav,input,search,panels};
}
const type=(t,text)=>{t.input.value=text;t.input.dispatchEvent(new t.dom.window.Event('input'));};
const visiblePanel=(document)=>[...document.querySelectorAll('#view-settings [data-settings-panel]')].filter(p=>!p.hidden).map(p=>p.dataset.settingsPanel).join();

// 再設計の前にあった設定の操作部品を、id・data属性・name・ラベルで1つずつ数える。1つでも消えたら落ちる。
test('every control that existed before the redesign is still in the settings screen',async()=>{
  const t=mounted();const d=t.document;
  await t.panels.ai.refresh();await t.panels.browser.refresh();
  const one=(selector)=>assert.ok(d.querySelector(`#view-settings ${selector}`),selector);
  // 静的な部品
  for(const id of ['settings-identity','settings-appearance','settings-cache','settings-media-p2p','settings-state','settings-notifications','settings-dm','settings-muted','settings-sensitive','settings-save','settings-ai','settings-browser','settings-about'])one(`#${id}`);
  for(const key of ['state','copy','login','logout'])one(`[data-account="${key}"]`);
  for(const view of ['profile','wallet','node'])one(`[data-open-view="${view}"]`);
  assert.deepEqual([...d.querySelectorAll('#settings-dm option')].map(o=>o.value),['mutuals','following','nobody']);
  assert.equal(d.querySelector('#settings-muted').maxLength,4000);
  // 外観
  for(const [name,values] of [['textSize',['normal','large','xlarge']],['density',['normal','roomy']]])
    for(const value of values)one(`input[name="appearance-${name}"][value="${value}"]`);
  for(const id of ['light','dark','noir','ivory','midnight','device'])one(`button[data-template-choice="${id}"]`);one('.appearance-crisp input');one('.appearance-motion input');one('.appearance-transparency input');
  assert.ok([...d.querySelectorAll('#settings-appearance button')].some(b=>b.textContent==='標準に戻す'));
  // この端末
  for(const key of ['receive','seed','relayOnly'])one(`[data-media-p2p="${key}"]`);
  assert.ok([...d.querySelectorAll('#settings-cache button')].some(b=>b.textContent==='キャッシュを消す'));
  // ブラウザ
  one('#settings-browser input[type=checkbox]');
  // 詳細
  const identityButtons=[...d.querySelectorAll('#settings-identity button')].map(b=>b.textContent);
  for(const label of ['引っ越し宣言を作る','登録文を作る'])assert.ok(identityButtons.includes(label),label);
  assert.equal(d.querySelectorAll('#settings-identity input[type=url]').length,3);
  assert.equal(d.querySelector('#settings-identity input[aria-label^="公開している根鍵"]')!==null,true);
  // AIの接続
  assert.ok([...d.querySelectorAll('#settings-ai button')].some(b=>b.textContent==='＋ 接続を追加'));
  // 通知の7項目は app.js が起動時に並べる（キーを数える）
  for(const key of ['replies','reactions','follows','messages','commercePayments','commerceDelivery','commerceReturns'])assert.match(app,new RegExp(`\\["${key}", "`),key);
  assert.match(app,/dataset\.prefKey = key/);
});

test('sections switch and each shows only its own panel',()=>{
  const t=mounted();const ids=[...t.document.querySelectorAll('#view-settings .inner-nav-item')].map(i=>i.dataset.settingsSec);
  assert.equal(ids.length,10);
  for(const id of ids){assert.equal(t.nav.select(id),true);assert.equal(visiblePanel(t.document),id);}
  assert.equal(t.nav.select('identity'),true);assert.equal(visiblePanel(t.document),'advanced');
});

test('search: Japanese-aware substring match over label and description',()=>{
  assert.equal(normalizeForSearch('ＡＰＩ キー'),'apiきー');
  assert.equal(normalizeForSearch('ブラウザ'),normalizeForSearch('ぶらうざ'));
  const items=[{label:'広告と追跡を止める',desc:'すべてのタブに効きます',keywords:'トラッカー'},{label:'文字の大きさ',desc:'一覧・詳細の文字を大きくします'}];
  assert.deepEqual(matchSettings(items,'ひろこく'),[]);
  assert.equal(matchSettings(items,'広告').length,1);
  assert.equal(matchSettings(items,'トラッカー').length,1,'keywords count');
  assert.equal(matchSettings(items,'大きく 文字').length,1,'terms are ANDed');
  assert.equal(matchSettings(items,'  ').length,0);
});

test('search box finds items in every section, shows results, jumps to the section and Escape clears',async()=>{
  const t=mounted();const d=t.document;
  assert.equal(d.querySelector('#settings-search').getAttribute('aria-label'),'設定を検索');
  type(t,'ミュート');
  assert.equal(visiblePanel(d),'search');
  assert.equal(d.querySelectorAll('#view-settings .inner-nav-item[aria-current]').length,0);
  const results=[...d.querySelectorAll('.settings-result')];
  assert.ok(results.length>=1);assert.match(results[0].textContent,/ミュートする言葉/);assert.match(results[0].textContent,/プライバシーと安全/);
  results[0].click();
  assert.equal(visiblePanel(d),'privacy');assert.equal(d.querySelector('#settings-search').value,'');
  assert.equal(d.activeElement.id,'settings-muted');
  // 動的に作った節の項目も見つかる
  for(const [word,section] of [['キャッシュ','device'],['透明','appearance'],['スマホ','ai'],['did:key','advanced'],['テストネット','advanced'],['広告','browser'],['ログアウト','account'],['送金','wallet'],['受け取る','device'],['DM','privacy']]){
    type(t,word);
    const hit=[...d.querySelectorAll('.settings-result')];
    assert.ok(hit.length>0,word);
    hit[0].click();
    assert.ok(visiblePanel(d).length>0&&visiblePanel(d)!=='search',word);
  }
  type(t,'そんな設定はない');
  assert.equal(d.querySelectorAll('.settings-result').length,0);assert.match(d.querySelector('.settings-empty').textContent,/見つかりませんでした/);
  t.nav.select('device');type(t,'キャッシュ');
  d.querySelector('#settings-search').dispatchEvent(new t.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(d.querySelector('#settings-search').value,'');assert.equal(visiblePanel(d),'device','Escape returns to the section that was open');
});

test('search is keyboard reachable: the field is focusable and arrows move into the results',()=>{
  const t=mounted();const d=t.document;
  const input=d.querySelector('#settings-search');
  assert.equal(input.disabled,false);assert.notEqual(input.tabIndex,-1);
  type(t,'通知');
  input.dispatchEvent(new t.dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  assert.ok(d.activeElement.classList.contains('settings-result'));
  const buttons=[...d.querySelectorAll('.settings-result')];
  assert.ok(buttons.every(b=>b.tagName==='BUTTON'));
});

test('every searchable row has a label; labels are unique per section and nothing says BYOK or P2P配布',async()=>{
  const t=mounted();await t.panels.ai.refresh();
  const items=collectSettingItems(t.document);
  assert.ok(items.length>=20,'rows found: '+items.length);
  for(const item of items)assert.ok(item.label,'label for '+item.el.dataset.setting);
  const keys=items.map(i=>i.el.dataset.setting);
  assert.equal(new Set(keys).size,keys.length,'data-setting keys are unique');
  const visible=t.document.querySelector('#view-settings').textContent;
  assert.doesNotMatch(visible,/BYOK|byok/);
  assert.doesNotMatch(visible,/P2P配布/);
  assert.doesNotMatch(visible,/Mica/);
  assert.doesNotMatch(visible,/メディアのキャッシュ|メディアの共有/);
});

test('technical items live under 詳細 only',()=>{
  const t=mounted();const d=t.document;
  const advanced=d.querySelector('[data-settings-panel="advanced"]');
  for(const selector of ['#settings-identity','#settings-about','[data-setting="テスト用ネットワーク"]'])assert.ok(advanced.querySelector(selector),selector);
  for(const panel of d.querySelectorAll('[data-settings-panel]')){
    if(panel.dataset.settingsPanel==='advanced'||panel.dataset.settingsPanel==='search')continue;
    assert.doesNotMatch(panel.textContent,/did:key|Fuji|Amoy|Sepolia|Kairos/,panel.dataset.settingsPanel);
  }
});

test('dangerous actions sit at the end of their section with the danger style and keep their confirmations',async()=>{
  const t=mounted();const d=t.document;await t.panels.cache.refresh();
  const account=d.querySelector('[data-settings-panel="account"]');
  const last=[...account.children].at(-1);
  assert.ok(last.querySelector('[data-account="logout"].deny'),'logout is the last block of アカウント');
  const device=d.querySelector('[data-settings-panel="device"]');
  assert.equal([...device.children].at(-1).id,'settings-cache','cache clear is the last block of この端末');
  assert.ok(device.querySelector('#settings-cache button.deny'));
  // どちらの確認も今のまま
  assert.match(app,/window\.confirm\("この端末に保存したDesktop認証鍵を削除してログアウトします/);
  assert.ok(device.querySelectorAll('.settings-confirm').length===0);
  [...device.querySelectorAll('#settings-cache button')].find(b=>b.textContent==='キャッシュを消す').click();
  assert.match(device.querySelector('.settings-confirm').textContent,/元に戻せません/);
});

test('wiring: both save buttons send the same full settings, and the search is created from the settings code only',()=>{
  assert.match(app,/for \(const save of settingsSaves\(\)\) save\.onclick = saveSettings/);
  assert.match(app,/createSettingsSearch\(\{ document, input: settingsSearchInput/);
  assert.match(app,/update_settings/);
  for(const key of ['notifications','directMessages','mutedTerms','showSensitive'])assert.match(app,new RegExp(`${key}`));
  assert.ok(html.includes('id="settings-save-safety"'));
});

test('the settings stylesheet uses tokens only and shows rows as label-left, control-right',()=>{
  const css=readFileSync(new URL('./settings-view.css',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  assert.doesNotMatch(css,/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\bwhite\b|\bblack\b/);
  assert.match(css,/\.setting-row\s*\{[^}]*justify-content:\s*space-between/);
  assert.match(css,/\.setting-control\s*\{[^}]*flex:\s*none/);
});
