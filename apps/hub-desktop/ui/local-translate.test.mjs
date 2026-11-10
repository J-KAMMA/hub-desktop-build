import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createLocalTranslator, attachTranslateAction, errorMessage, parseError} from './local-translate.mjs';
import {renderTranslateSettings} from './local-translate-settings.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json', import.meta.url))('jsdom');

function fakeInvoke({cached = null, run = (a) => ({text: `T:${a.request.text}`, family: 'plamo', modelId: 'plamo-0.8b'}), status = null} = {}) {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push([name, args]);
    if (name === 'local_translate_cached') return cached;
    if (name === 'local_translate_run') return run(args);
    if (name === 'local_translate_status') return status;
    if (name === 'local_translate_share_payload') return {visibility: 'shared', targetId: args.targetId};
    return null;
  };
  return {invoke, calls, names: () => calls.map((c) => c[0])};
}
const base = {getLocale: () => 'en', getHubBase: () => 'https://hub.example'};
const post = {id: 'p1', revision: 'r1', type: 'social_post', isPublic: true, text: 'こんにちは', sourceLang: 'ja'};

test('public items ask the Hub cache first and skip the device on a hit', async () => {
  const f = fakeInvoke({cached: 'Hello (shared)'});
  const t = createLocalTranslator({...base, invoke: f.invoke});
  assert.deepEqual(await t.translate(post), {text: 'Hello (shared)', source: 'hub', label: '機械翻訳・共有された翻訳'});
  assert.deepEqual(f.names(), ['local_translate_cached']);
});

test('a miss translates on the device; the result is cached per item+revision+locale', async () => {
  const f = fakeInvoke();
  const t = createLocalTranslator({...base, invoke: f.invoke});
  assert.equal((await t.translate(post)).source, 'device');
  await t.translate(post);
  assert.equal(f.names().filter((n) => n === 'local_translate_run').length, 1);
  await t.translate({...post, revision: 'r2'});
  assert.equal(f.names().filter((n) => n === 'local_translate_run').length, 2);
});

test('non-public items never touch the Hub cache or the share path', async () => {
  const f = fakeInvoke();
  const shared = [];
  const t = createLocalTranslator({...base, invoke: f.invoke, isSharingEnabled: () => true, shareSink: (p) => shared.push(p)});
  for (const item of [{...post, id: 'd', isPublic: false}, {...post, id: 'g', type: 'gated_post'}, {...post, id: 'm', type: 'direct_message'}]) await t.translate(item);
  assert.ok(!f.names().includes('local_translate_cached'));
  assert.ok(!f.names().includes('local_translate_share_payload'));
  assert.equal(shared.length, 0);
});

const gemmaRun = (a) => ({text: `T:${a.request.text}`, family: 'gemma', modelId: 'translategemma-4b'});
test('sharing is off by default and only runs for public items when enabled', async () => {
  const off = fakeInvoke({run: gemmaRun}); const sinkOff = [];
  await createLocalTranslator({...base, invoke: off.invoke, shareSink: (p) => sinkOff.push(p)}).translate(post);
  assert.equal(sinkOff.length, 0);
  const on = fakeInvoke({run: gemmaRun}); const sinkOn = [];
  await createLocalTranslator({...base, invoke: on.invoke, isSharingEnabled: () => true, shareSink: (p) => sinkOn.push(p)}).translate(post);
  assert.equal(sinkOn.length, 1);
  const sp = on.calls.find((c) => c[0] === 'local_translate_share_payload')[1];
  assert.equal(sp.sharedOptIn, true);
  assert.equal(sp.modelId, 'translategemma-4b');
});

test('PLaMo and user-supplied GGUF outputs are never shared; only the pinned Gemma model may be', async () => {
  for (const [modelId, family, expected] of [['plamo-0.8b', 'plamo', 0], ['gemma-local', 'gemma', 0], ['translategemma-4b', 'gemma', 1]]) {
    const f = fakeInvoke({run: (a) => ({text: `T:${a.request.text}`, family, modelId})});
    const sink = [];
    await createLocalTranslator({...base, invoke: f.invoke, isSharingEnabled: () => true, shareSink: (p) => sink.push(p)}).translate(post);
    assert.equal(sink.length, expected, modelId);
    assert.equal(f.names().includes('local_translate_share_payload'), expected === 1, modelId);
  }
});

test('a share failure does not fail the translation', async () => {
  const f = fakeInvoke({run: gemmaRun});
  const t = createLocalTranslator({...base, invoke: f.invoke, isSharingEnabled: () => true, shareSink: () => { throw new Error('x'); }});
  assert.equal((await t.translate(post)).text, 'T:こんにちは');
});

test('a hub lookup failure falls back to the device', async () => {
  const f = fakeInvoke();
  const invoke = async (n, a) => { if (n === 'local_translate_cached') throw new Error('net'); return f.invoke(n, a); };
  assert.equal((await createLocalTranslator({...base, invoke}).translate(post)).source, 'device');
});

test('error codes become short Japanese lines and never echo unknown text', () => {
  assert.match(errorMessage('translate_same_language'), /必要/);
  assert.match(errorMessage('translate_gguf_invalid'), /GGUF/);
  assert.match(errorMessage('translate_model_missing:translategemma-4b'), /モデル/);
  assert.deepEqual(parseError('translate_model_missing:translategemma-4b'), {code: 'translate_model_missing', param: 'translategemma-4b'});
  assert.equal(errorMessage(new Error('secret body text')), '翻訳できませんでした');
});

function dom() {
  const d = new JSDOM('<div id="row"><p id="body">こんにちは</p><span id="host"></span></div>');
  return {d, doc: d.window.document};
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('the button replaces the body in place and toggles back to the original', async () => {
  const {doc} = dom();
  const t = createLocalTranslator({...base, invoke: fakeInvoke().invoke});
  attachTranslateAction({doc, host: doc.getElementById('host'), body: doc.getElementById('body'), item: post, translator: t});
  const btn = doc.querySelector('.local-translate-btn');
  assert.equal(btn.getAttribute('aria-label'), '翻訳');
  btn.click(); await flush(); await flush();
  assert.equal(doc.getElementById('body').textContent, 'T:こんにちは');
  assert.equal(btn.dataset.state, 'done');
  btn.click();
  assert.equal(doc.getElementById('body').textContent, 'こんにちは');
  assert.equal(btn.dataset.state, 'idle');
});

test('custom show/restore hooks let a caller keep its own rendering (links, structure)', async () => {
  const {doc} = dom();
  const body = doc.getElementById('body');
  const log = [];
  const t = createLocalTranslator({...base, invoke: fakeInvoke().invoke});
  attachTranslateAction({doc, host: doc.getElementById('host'), body, item: post, translator: t, getText: () => 'ORIG', show: (x) => { log.push(['show', x]); }, restore: (x) => { log.push(['restore', x]); }});
  const btn = doc.querySelector('.local-translate-btn');
  btn.click(); await flush(); await flush();
  btn.click();
  assert.deepEqual(log, [['show', 'T:ORIG'], ['restore', 'ORIG']]);
});

test('pressing again while running cancels and leaves the original text', async () => {
  const {doc} = dom();
  let release;
  const slow = fakeInvoke({run: () => new Promise((r) => { release = () => r({text: 'late', modelId: 'plamo-0.8b'}); })});
  const t = createLocalTranslator({...base, invoke: slow.invoke});
  attachTranslateAction({doc, host: doc.getElementById('host'), body: doc.getElementById('body'), item: post, translator: t});
  const btn = doc.querySelector('.local-translate-btn');
  btn.click(); await flush(); await flush();
  assert.equal(btn.dataset.state, 'busy');
  btn.click(); await flush();
  release(); await flush(); await flush();
  assert.equal(doc.getElementById('body').textContent, 'こんにちは');
  assert.ok(slow.names().includes('local_translate_stop'));
});

test('an error shows a short status and keeps the original', async () => {
  const {doc} = dom();
  const f = fakeInvoke({run: () => { throw 'translate_timeout'; }});
  attachTranslateAction({doc, host: doc.getElementById('host'), body: doc.getElementById('body'), item: post, translator: createLocalTranslator({...base, invoke: f.invoke})});
  doc.querySelector('.local-translate-btn').click(); await flush(); await flush();
  assert.match(doc.querySelector('.local-translate-status').textContent, /時間/);
  assert.equal(doc.getElementById('body').textContent, 'こんにちは');
});

test('a missing model for the pair offers a short download button with name and size, then asks to press again', async () => {
  const {doc} = dom();
  const status = {models: [{id: 'translategemma-4b', family: 'gemma', bytes: 2489909312}], progress: {state: 'idle'}};
  let downloaded = false;
  const invoke = async (n) => {
    if (n === 'local_translate_run') throw 'translate_model_missing:translategemma-4b';
    if (n === 'local_translate_status') return {...status, progress: downloaded ? {state: 'done', size: 'translategemma-4b'} : status.progress};
    if (n === 'local_translate_download') { downloaded = true; return null; }
    return null;
  };
  const item = {...post, type: 'direct_message', isPublic: false, sourceLang: 'ja'};
  attachTranslateAction({doc, host: doc.getElementById('host'), body: doc.getElementById('body'), item, translator: createLocalTranslator({...base, getLocale: () => 'ko', invoke})});
  doc.querySelector('.local-translate-btn').click(); await flush(); await flush(); await flush();
  assert.match(doc.querySelector('.local-translate-status').textContent, /TranslateGemma 4B.*2\.5 GB/);
  const get = doc.querySelector('.local-translate-get');
  assert.ok(get);
  get.click(); await flush(); await flush(); await flush(); await flush();
  assert.match(doc.querySelector('.local-translate-status').textContent, /もう一度/);
  assert.ok(!doc.querySelector('.local-translate-get'));
});

test('download without the notice accepted is refused with a pointer to settings', async () => {
  const {doc} = dom();
  const invoke = async (n) => {
    if (n === 'local_translate_run') throw 'translate_model_missing:plamo-0.8b';
    if (n === 'local_translate_status') return {models: [{id: 'plamo-0.8b', family: 'plamo', bytes: 573123200}], progress: {state: 'idle'}};
    if (n === 'local_translate_download') throw 'translate_licence_required:plamo';
    return null;
  };
  attachTranslateAction({doc, host: doc.getElementById('host'), body: doc.getElementById('body'), item: post, translator: createLocalTranslator({...base, invoke})});
  doc.querySelector('.local-translate-btn').click(); await flush(); await flush(); await flush();
  doc.querySelector('.local-translate-get').click(); await flush(); await flush();
  assert.match(doc.querySelector('.local-translate-status').textContent, /設定/);
});

const GEMMA_TERMS = 'https://ai.google.dev/gemma/terms';
const GEMMA_PUP = 'https://ai.google.dev/gemma/prohibited_use_policy';
function settingsState() {
  const fam = (family, accepted) => (family === 'plamo'
    ? {family, licenceAccepted: accepted, licenceUrlJa: 'https://plamo.preferredai.jp/info/plamo-community-license-ja', licenceUrlEn: 'https://plamo.preferredai.jp/info/plamo-community-license-en'}
    : {family, licenceAccepted: accepted, licenceUrlJa: GEMMA_TERMS, licenceUrlEn: GEMMA_TERMS, prohibitedUseUrl: GEMMA_PUP});
  return {families: [fam('plamo', false), fam('gemma', false)], selected: 'plamo-0.8b', runtimeFound: true, localGguf: null, progress: {state: 'idle'},
    models: [
      {id: 'plamo-0.8b', family: 'plamo', bytes: 573123200, installed: false, partialBytes: 0},
      {id: 'plamo-2b', family: 'plamo', bytes: 1807199392, installed: false, partialBytes: 0},
      {id: 'translategemma-4b', family: 'gemma', bytes: 2489909312, installed: false, partialBytes: 0, thirdParty: true}]};
}

test('settings: each model needs its own confirmation before any download is offered; links go to the official text', async () => {
  const d = new JSDOM('<div id="r"></div>'); const doc = d.window.document;
  const state = settingsState();
  const calls = [];
  const invoke = async (n, a) => {
    calls.push([n, a]);
    if (n === 'local_translate_accept_licence') state.families.find((f) => f.family === a.family).licenceAccepted = true;
    return n === 'local_translate_status' ? state : null;
  };
  const s = renderTranslateSettings({doc, root: doc.getElementById('r'), invoke});
  await s.ready;
  assert.ok(!doc.querySelector('[data-action="download"]'));
  const links = [...doc.querySelectorAll('[data-family="plamo"] a')].map((a) => a.href);
  assert.deepEqual(links, [state.families[0].licenceUrlJa, state.families[0].licenceUrlEn]);
  // Gemma: 規約と禁止使用方針の両方へのリンク、第三者の変換物であることの明示、大きさ。MADLAD はもう無い。
  const gemmaBox = doc.querySelector('[data-family="gemma"]');
  assert.deepEqual([...gemmaBox.querySelectorAll('a')].map((a) => a.href), [GEMMA_TERMS, GEMMA_PUP]);
  assert.match(gemmaBox.textContent, /第三者/);
  assert.match(gemmaBox.textContent, /2\.5 GB/);
  assert.ok(!doc.querySelector('[data-family="madlad"]'));
  assert.ok(!/MADLAD/i.test(doc.getElementById('r').textContent));
  assert.ok(!gemmaBox.querySelector('[data-action="download"], [data-action="pick-gguf"]'), 'nothing is offered before the notice is accepted');
  gemmaBox.querySelector('[data-action="accept"]').click(); await flush(); await flush();
  const gemmaDl = doc.querySelector('[data-family="gemma"] [data-action="download"]');
  assert.ok(gemmaDl);
  assert.match(gemmaDl.textContent, /第三者の変換物を取得/);
  assert.ok(doc.querySelector('[data-family="gemma"] [data-action="pick-gguf"]'), 'a user-supplied GGUF can be chosen');
  assert.ok(!doc.querySelector('[data-family="plamo"] [data-action="download"]'), 'PLaMo still needs its own consent');
  doc.querySelector('[data-family="plamo"] [data-action="accept"]').click(); await flush(); await flush();
  const get = doc.querySelector('[data-family="plamo"] [data-action="download"]');
  assert.match(get.textContent, /573 MB/);
  assert.match(doc.querySelector('[data-family="plamo"]').textContent, /共有しません/);
  get.click(); await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'local_translate_download')[1], {size: 'plamo-0.8b'});
  s.dispose();
});

test('settings: picking a local GGUF shows its name and hash, replaces the download, and can be unregistered', async () => {
  const d = new JSDOM('<div id="r"></div>'); const doc = d.window.document;
  const state = settingsState();
  state.families[1].licenceAccepted = true;
  const calls = [];
  const invoke = async (n, a) => {
    calls.push([n, a]);
    if (n === 'local_translate_pick_gguf') { state.localGguf = {name: 'tg-4b.gguf', bytes: 2489909312, sha256: 'ab'.repeat(32), present: true}; return state.localGguf; }
    if (n === 'local_translate_clear_gguf') state.localGguf = null;
    if (n === 'local_translate_verify') return true;
    return n === 'local_translate_status' ? state : null;
  };
  const s = renderTranslateSettings({doc, root: doc.getElementById('r'), invoke});
  await s.ready;
  doc.querySelector('[data-action="pick-gguf"]').click(); await flush(); await flush();
  const row = doc.querySelector('[data-role="local-gguf"]');
  assert.match(row.textContent, /tg-4b\.gguf/);
  assert.match(row.textContent, /abababababab/);
  assert.ok(!doc.querySelector('[data-family="gemma"] [data-action="download"]'), 'the local file replaces the third-party download');
  doc.querySelector('[data-action="verify-local"]').click(); await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'local_translate_verify')[1], {size: 'gemma-local'});
  doc.querySelector('[data-action="clear-gguf"]').click(); await flush(); await flush();
  assert.ok(doc.querySelector('[data-family="gemma"] [data-action="download"]'));
  s.dispose();
});

test('settings: choosing a file is refused with a short line when the file is not GGUF', async () => {
  const d = new JSDOM('<div id="r"></div>'); const doc = d.window.document;
  const state = settingsState();
  state.families[1].licenceAccepted = true;
  const invoke = async (n) => { if (n === 'local_translate_pick_gguf') throw 'translate_gguf_invalid'; return n === 'local_translate_status' ? state : null; };
  const s = renderTranslateSettings({doc, root: doc.getElementById('r'), invoke});
  await s.ready;
  doc.querySelector('[data-action="pick-gguf"]').click(); await flush(); await flush();
  assert.match(doc.querySelector('[data-family="gemma"]').textContent, /GGUF ファイルではありません/);
  assert.ok(!doc.querySelector('[data-role="local-gguf"] [data-action="clear-gguf"]'));
  s.dispose();
});

test('module never writes translated text to storage or network by itself', () => {
  const src = readFileSync(new URL('./local-translate.mjs', import.meta.url), 'utf8');
  for (const bad of ['localStorage', 'sessionStorage', 'fetch(', 'console.', 'XMLHttpRequest']) assert.ok(!src.includes(bad), bad);
});

test('app.js wiring: one translator with sharing off, public-only flag from the post audience, settings rendered, stylesheet linked', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(app, /createLocalTranslator\(\{ invoke, getLocale: \(\) => "ja", getHubBase: \(\) => invoke\("hub_origin"\), isSharingEnabled: \(\) => false, shareSink: null \}\)/);
  assert.match(app, /type: "social_post", isPublic: post\.audience === "public"/);
  assert.match(app, /type: "article", isPublic: false/);
  assert.match(app, /type: "article_comment", isPublic: false/);
  assert.match(app, /renderTranslateSettings\(\{ doc: document, root: localTranslateHost, invoke \}\)/);
  assert.match(html, /href="\.\/local-translate\.css"/);
  assert.match(html, /id="settings-local-translate"/);
  assert.equal(app.match(/createLocalTranslator\(/g).length, 1);
});

// ---- 3 段（Hub の共有 → 自分の API → 端末）: 画面側 ----

const apiRun = (a) => ({text: `A:${a.request.text}`, family: 'api', modelId: 'api', via: 'api', label: '機械翻訳・claude-haiku-5-5', fallback: null});
const runRequest = (f) => f.calls.find((c) => c[0] === 'local_translate_run')[1].request;

test('the item is sent to Rust with its public flag and the offline state; tier choice stays in Rust', async () => {
  for (const [isPublic, offline] of [[true, false], [false, false], [true, true], [false, true]]) {
    const f = fakeInvoke({run: apiRun});
    const t = createLocalTranslator({...base, invoke: f.invoke, isOffline: () => offline});
    await t.translate({...post, id: `x${isPublic}${offline}`, isPublic});
    assert.equal(runRequest(f).public, isPublic);
    assert.equal(runRequest(f).offline, offline);
  }
  // 公開項目だけ Hub の保存済み翻訳を引く（非公開は引かない）。
  const f = fakeInvoke({run: apiRun});
  await createLocalTranslator({...base, invoke: f.invoke}).translate({...post, id: 'priv', isPublic: false});
  assert.ok(!f.names().includes('local_translate_cached'));
});

test('an API result carries its label and is never shared, even with sharing on', async () => {
  const sink = [];
  const f = fakeInvoke({run: apiRun});
  const t = createLocalTranslator({...base, invoke: f.invoke, isSharingEnabled: () => true, shareSink: (p) => sink.push(p)});
  const r = await t.translate(post);
  assert.deepEqual([r.source, r.label, r.fallback], ['api', '機械翻訳・claude-haiku-5-5', null]);
  assert.ok(!f.names().includes('local_translate_share_payload'));
  assert.deepEqual(sink, []);
});

test('every translated text shows the machine-translation label, and it goes away with the original', async () => {
  const cases = [
    [{cached: 'Hello'}, /機械翻訳・共有された翻訳/],
    [{run: apiRun}, /機械翻訳・claude-haiku-5-5/],
    [{run: (a) => ({text: `T:${a.request.text}`, family: 'plamo', modelId: 'plamo-0.8b', via: 'device', label: '機械翻訳・PLaMo 3 Translate 0.8B'})}, /機械翻訳・PLaMo 3 Translate 0\.8B/],
  ];
  let n = 0;
  for (const [opts, pattern] of cases) {
    const {doc} = dom();
    attachTranslateAction({doc, host: doc.getElementById('host'), body: doc.getElementById('body'), item: {...post, id: `l${n++}`}, translator: createLocalTranslator({...base, invoke: fakeInvoke(opts).invoke})});
    const btn = doc.querySelector('.local-translate-btn'), label = doc.querySelector('.local-translate-label');
    assert.equal(label.hidden, true);
    btn.click(); await flush(); await flush();
    assert.equal(label.hidden, false);
    assert.match(label.textContent, pattern);
    btn.click();
    assert.equal(label.hidden, true);
  }
});

test('a provider error that fell back to the device is told in one short line; the text still gets its label', async () => {
  const {doc} = dom();
  const run = (a) => ({text: `T:${a.request.text}`, family: 'plamo', modelId: 'plamo-0.8b', via: 'device', label: '機械翻訳・PLaMo 3 Translate 0.8B', fallback: 'byok_quota_exceeded'});
  attachTranslateAction({doc, host: doc.getElementById('host'), body: doc.getElementById('body'), item: post, translator: createLocalTranslator({...base, invoke: fakeInvoke({run}).invoke})});
  doc.querySelector('.local-translate-btn').click(); await flush(); await flush();
  assert.match(doc.querySelector('.local-translate-status').textContent, /利用枠を超えています。端末で訳しました/);
  assert.match(doc.querySelector('.local-translate-label').textContent, /PLaMo/);
});

test('an API failure with no usable device model shows the API reason, without the text or any key', () => {
  assert.match(errorMessage('translate_api_failed:byok_auth_failed'), /API キーが通りません/);
  assert.match(errorMessage('translate_api_failed:byok_rate_limited'), /混み合って/);
  assert.match(errorMessage('translate_api_failed:weird'), /API で訳せませんでした/);
  assert.deepEqual(parseError('translate_api_failed:byok_timeout'), {code: 'translate_api_failed', param: 'byok_timeout'});
});

function apiSettingsState(api) { return {...settingsState(), api}; }

test('settings: the API model is off until chosen, shows names only, and the private permission is off by default', async () => {
  const d = new JSDOM('<div id="r"></div>'); const doc = d.window.document;
  const state = apiSettingsState({connectionId: null, connectionName: null, model: null, allowPrivate: false, choices: [{id: 'c1', name: 'my-claude', kind: 'anthropic', defaultModel: 'claude-haiku-5-5'}]});
  const calls = [];
  const invoke = async (n, a) => {
    calls.push([n, a]);
    if (n === 'local_translate_api_set') Object.assign(state.api, {connectionId: a.connectionId, model: a.model, connectionName: 'my-claude'});
    if (n === 'local_translate_api_allow_private') state.api.allowPrivate = a.allow;
    return n === 'local_translate_status' ? state : null;
  };
  const s = renderTranslateSettings({doc, root: doc.getElementById('r'), invoke});
  await s.ready;
  const section = doc.querySelector('[data-family="api"]');
  const pick = section.querySelector('select');
  assert.equal(pick.value, '', 'default: 使わない');
  assert.deepEqual([...pick.options].map((o) => o.textContent), ['使わない（端末のモデルで訳す）', 'my-claude']);
  const [model, allow] = [section.querySelector('input[type="text"]'), section.querySelector('input[type="checkbox"]')];
  assert.ok(model.disabled && allow.disabled && !allow.checked, 'nothing to configure until a connection is chosen');
  assert.match(section.textContent, /非公開の中身もAPIで訳す/);
  assert.match(section.textContent, /DM・フォロワー限定・非公開グループ・ゲート付き/);
  pick.value = 'c1'; pick.dispatchEvent(new d.window.Event('change')); await flush(); await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'local_translate_api_set')[1], {connectionId: 'c1', model: null});
  const allow2 = doc.querySelector('[data-family="api"] input[type="checkbox"]');
  assert.ok(!allow2.disabled && !allow2.checked);
  allow2.checked = true; allow2.dispatchEvent(new d.window.Event('change')); await flush(); await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'local_translate_api_allow_private')[1], {allow: true});
  // 画面側の経路に鍵に当たるものは無い。
  assert.ok(!JSON.stringify(calls).match(/sk-|api[_-]?key/i));
});

test('settings: with no connection saved, the page says where to register one', async () => {
  const d = new JSDOM('<div id="r"></div>'); const doc = d.window.document;
  const state = apiSettingsState({connectionId: null, connectionName: null, model: null, allowPrivate: false, choices: []});
  const s = renderTranslateSettings({doc, root: doc.getElementById('r'), invoke: async (n) => (n === 'local_translate_status' ? state : null)});
  await s.ready;
  assert.match(doc.querySelector('[data-family="api"]').textContent, /AIの接続/);
});
