import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const origin = 'http://127.0.0.1:9876';
const a = 'https://a.synthetic.invalid', b = 'https://b.synthetic.invalid';

test('actual app startup isolates remote Hub authorization failures and actor invalidation', {timeout: 60000}, async t => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1240, height: 900}});
  const pageErrors = [], blocked = [], modules = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { blocked.push(url.origin); await route.abort(); return; }
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.split('/').includes('..')) { await route.abort(); return; }
    try {
      const body = await readFile(new URL(path, import.meta.url));
      if (/\.(mjs|js)$/.test(path)) modules.push(path);
      await route.fulfill({body, contentType: /\.(mjs|js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'});
    } catch { await route.fulfill({status: 404, body: ''}); }
  });
  await page.addInitScript(({a,b}) => {
    const stamp = '2026-10-08T00:00:00.000Z';
    window.fixture = {aStatus: 200, bStatus: 200, calls: [], actor: {state: 'registered', deviceId: 'synthetic-device', keyThumbprint: 'a'.repeat(43)}, actorChanged: false};
    window.__TAURI__ = {event: {listen: async () => () => {}}, core: {invoke: async (name,args={}) => {
      const f=window.fixture; f.calls.push({name,args});
      if(name==='browser_tab_overlay'){if(args.left!==0)throw Error('unexpected fixture overlay');return null;}
      if (name==='hub_origin') return 'https://synthetic.invalid';
      if (['desktop_account_status','poll_desktop_account'].includes(name)) return {...f.actor};
      if (name==='desktop_build_mode') return 'development';
      if (name==='hub_network_sources') { if(args.action!=='list') throw Error('unexpected source mutation'); return {sources: f.actorChanged ? [] : [a,b]}; }
      if (name==='hub_network_read') {
        const status=args.origin===a?f.aStatus:f.bStatus;
        if(status!==200) throw `ハブが ${status} を返しています`;
        const paths={post:'/v2/posts/same',research:'/v2/research/same'};
        return {protocol:'hub.catalog.v1',kind:args.kind,items:[{id:'same',path:paths[args.kind],title:(args.origin===a?'A':'B')+' public '+args.kind,summary:'Public metadata',updatedAt:stamp}]};
      }
      if (name==='open_external') return {synthetic:true};
      if (name==='commerce_catalog') return {products:[],paymentAssets:[],paymentsEnabled:false,nextCursor:null};
      if (name==='hub_resource') return {resources:[]};
      if (name==='hub_client') {if((args.name==='me'||args.name==='me_summary')) return {profile:{id:'viewer',handle:'fixture',displayName:'Fixture'}}; if(args.name==='federated_feed') return {items:[]}; throw Error('synthetic_unavailable');}
      if (name==='hub_social_stream') return {version:1,filter:args.filter,scope:args.scope,viewerId:'viewer',signedIn:true,items:[{kind:'thread',id:'synthetic-thread',createdAt:stamp,origin:'https://synthetic.invalid',payload:{id:'synthetic-thread',title:'Synthetic thread',boardKey:'board',postCount:3,threadType:'discussion',status:'open',updatedAt:stamp}}],hasMore:false,nextCursor:null,failures:[]};
      if (name==='hub_feed') return {posts:[],signedIn:true,hasMore:false};
      if (name==='music_tracks') return {tracks:[],works:[]};
      if (['dev_history','dev_agents','list_games','pi_work_list'].includes(name)) return [];
      if (['workspace','dev_workspace'].includes(name)) return '';
      if (name==='dev_active_run') return null;
      throw Error('synthetic_unavailable');
    }}};
  }, {a,b});
  await page.goto(origin);
  await page.locator('#view-feed .hub-network-card').first().waitFor();
  const feed = () => page.locator('#view-feed .hub-network-card');
  const market = () => page.locator('#view-research .hub-network-card');
  const goMarket = async () => {
    await page.evaluate(() => document.querySelector('.nav-item[data-view="research"]').click());
    await market().filter({hasText:'B public research'}).waitFor();
  };
  await feed().filter({hasText:'B public post'}).waitFor();
  assert.equal(await feed().count(),2);
  await goMarket();
  assert.equal(await market().count(),2);
  assert.ok(modules.includes('app.js') && modules.includes('hub-network.mjs'));

  for(const status of [401,403]) await t.test(`A ${status} keeps B and blocks failed A card actions`, async () => {
    // Capture old connected controls before a real full app market reload.
    await page.evaluate(a => { const c=document.querySelector(`#view-research [data-hub-origin="${a}"]`);window.fixture.oldOpen=c?.querySelector('button');window.fixture.oldShare=[...c?.querySelectorAll('button')??[]].find(n=>n.textContent==='投稿で紹介'); },a);
    await page.evaluate(status => {window.fixture.aStatus=status;},status);
    await page.locator('.icon-nav-item[data-view="feed"]').click();
    await feed().filter({hasText:'B public post'}).waitFor();
    assert.equal(await feed().filter({hasText:'B public post'}).getAttribute('data-hub-origin'),b);
    assert.equal(await feed().filter({hasText:'A public post'}).count(),0);
    await feed().filter({hasText:'B public post'}).getByRole('button',{name:'元のHubで開く ↗',exact:true}).click();
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(c=>c.name==='open_external').at(-1)?.args.url),b+'/v2/posts/same');
    await goMarket();
    await page.waitForFunction(() => [...document.querySelectorAll('#view-research .hub-network-feedback')].some(n=>n.textContent.includes('a.synthetic.invalid は接続できません')));
    const bCard=market().filter({hasText:'B public research'});
    assert.equal(await bCard.count(),1);
    assert.equal(await bCard.getAttribute('data-hub-origin'),b);
    await bCard.getByRole('button',{name:'元のHubで開く ↗',exact:true}).click();
    const canonical=await page.evaluate(() => window.fixture.calls.filter(c=>c.name==='open_external').at(-1)?.args.url);
    assert.equal(canonical,b+'/v2/research/same');
    const outcome=await page.evaluate(async a => {
      const f=window.fixture,start=f.calls.filter(c=>c.name==='open_external').length;
      f.oldOpen?.onclick();await f.oldShare?.onclick();
      const stale=document.querySelector(`#view-research [data-hub-origin="${a}"]`);
      stale?.querySelector('button')?.onclick();
      await [...stale?.querySelectorAll('button')??[]].find(n=>n.textContent==='投稿で紹介')?.onclick();
      return {opens:f.calls.filter(c=>c.name==='open_external').slice(start).map(c=>c.args.url),sharePreview:document.querySelector('#composer [aria-label="投稿で紹介"]')?.hidden===false,staleVisible:!!stale};
    },a);
    assert.deepEqual(outcome.opens,[],`Failed Hub card opened: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.sharePreview,false,`Failed Hub card shared: ${JSON.stringify(outcome)}`);
  });

  await t.test('main Hub actor-change invalidates every old source card',async()=>{
    await page.evaluate(() => {window.fixture.actorChanged=true;window.fixture.actor={state:'signed_out'};window.dispatchEvent(new Event('hub-account-changed'));});
    await page.waitForFunction(() => document.querySelectorAll('.hub-network-card').length===0);
    const calls=await page.evaluate(async()=>{const f=window.fixture,start=f.calls.filter(c=>c.name==='open_external').length;f.oldOpen?.onclick();await f.oldShare?.onclick();return f.calls.filter(c=>c.name==='open_external').slice(start);});
    assert.deepEqual(calls,[]);
  });
  assert.deepEqual(pageErrors,[]);
  assert.deepEqual(blocked,[]);
  const writes=await page.evaluate(()=>window.fixture.calls.filter(c=>/^(hub_client_action|commerce_order|wallet_sign|wallet_send|begin_desktop|logout_desktop)/.test(c.name)));
  assert.deepEqual(writes,[]);
});
