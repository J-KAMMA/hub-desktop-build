// APIの窓口（API market, docs/hub-ai-market/DESIGN.md §2・§5）の一覧と詳細。Web の /v2/market/ai と同じ配置で、
// OpenRouter の models 一覧の配置だけを写す：左に絞り込みの列、右に並べ替えと比べられる行、行を押すと詳細。
// この部品は app.js から呼ばれるまで何もしない（差し込み方は docs/hub-ui-reference/patch-notes-api-market.md）。
// 鍵もプロンプトも扱わない。速さとデータの扱いは提供者の申告として示し、使う前に上限額を見せる。
// 載せられない種類は Hub の登録で断られ、normalizeListing も知らない種類を落とすので、ここには出ない。
import { DATA_HANDLING_LABEL, KINDS, KIND_LABEL, splitAmount } from './ai-market.mjs';

export const SORTS = Object.freeze(['newest', 'price', 'speed']);
export const SORT_LABEL = Object.freeze({ newest: '新しい順', price: '安い順', speed: '速い順（申告）' });

export const amount = (atomic) => (atomic / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
export const priceText = (atomic) => `${amount(atomic)} USDC（テスト用）`;
const latencyText = (ms) => (ms ? `${ms.toLocaleString('ja-JP')} ms` : '未申告');
const dataText = (l) => `${l.dataHandling.retention ? '保存あり' : '保存なし'} · ${l.dataHandling.training ? '学習あり' : '学習なし'}`;
const time = (l) => (l.createdAt ? Date.parse(l.createdAt) : 0);

/** The rows to show: every given condition must hold, then one sort. Speed sorts undeclared last. Pure. */
export function filterApiListings(listings, { kind = null, q = '', sort = 'newest', noRetention = false, noTraining = false, attested = false } = {}) {
  const words = String(q).toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 4);
  const out = listings.filter((l) => (kind === null || l.kind === kind)
    && (!noRetention || l.dataHandling.retention === false)
    && (!noTraining || l.dataHandling.training === false)
    // Attestation is never verified yet (normalizeListing forces false), so this honestly leaves nothing.
    && (!attested || l.attested === true)
    && words.every((w) => [l.providerName, l.purpose ?? '', ...l.modelIds].some((t) => t.toLowerCase().includes(w))));
  const by = {
    newest: (a, b) => time(b) - time(a),
    price: (a, b) => (a.priceAtomic ?? a.maxPriceAtomic) - (b.priceAtomic ?? b.maxPriceAtomic) || a.maxPriceAtomic - b.maxPriceAtomic,
    speed: (a, b) => (a.declaredLatencyMs ?? Infinity) - (b.declaredLatencyMs ?? Infinity),
  }[SORTS.includes(sort) ? sort : 'newest'];
  return [...out].sort((a, b) => by(a, b) || a.id.localeCompare(b.id));
}

/**
 * Mounts the list into `host`. getListings() returns normalized listings (ai-market.mjs). market is the AI picker's
 * controller (its confirmUse shows the one-time disclosure). onUse(listing, model) is called only after the user agreed,
 * and only for kind ai. openExternal(url) opens a link outside the app.
 */
export function createApiMarketView({ document, host, getListings, market = null, onUse = () => {}, openExternal = () => {} }) {
  const state = { kind: null, q: '', sort: 'newest', noRetention: false, noTraining: false, attested: false, openId: null };
  const make = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const button = (className, text, onClick) => { const b = make('button', className, text); b.type = 'button'; b.onclick = onClick; return b; };
  const pressed = (b, on) => { b.setAttribute('aria-pressed', String(Boolean(on))); return b; };

  function option(text, on, onClick) {
    const b = pressed(button('amv-option', '', onClick), on);
    if (on !== null) b.append(make('span', 'amv-check'));
    b.append(document.createTextNode(text));
    return b;
  }
  function group(title, children, help) {
    const section = make('section', 'amv-group');
    const heading = make('h3', 'amv-group-title', title);
    const list = make('div', 'amv-options'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', title);
    list.append(...children);
    section.append(heading, list);
    if (help) section.append(make('p', 'amv-help', help));
    return section;
  }

  function filtersColumn() {
    const aside = make('aside', 'amv-filters'); aside.setAttribute('aria-label', '絞り込み');
    const search = make('input', 'amv-search'); search.type = 'search'; search.placeholder = '名前・用途・モデル'; search.value = state.q; search.maxLength = 80;
    search.setAttribute('aria-label', '名前・用途・モデルで探す');
    search.oninput = () => { state.q = search.value; renderResults(); };
    const kinds = [pressed(button('amv-option', 'すべて', () => { state.kind = null; render(); }), state.kind === null),
      ...KINDS.map((k) => pressed(button('amv-option', KIND_LABEL[k], () => { state.kind = k; render(); }), state.kind === k))];
    aside.append(
      make('div', 'amv-search-wrap'),
      group('種類', kinds),
      group(`データの扱い（${DATA_HANDLING_LABEL}）`, [
        option('保存しない', state.noRetention, () => { state.noRetention = !state.noRetention; render(); }),
        option('学習に使わない', state.noTraining, () => { state.noTraining = !state.noTraining; render(); }),
      ]),
      group('秘密計算の証明', [option('証明つきだけ', state.attested, () => { state.attested = !state.attested; render(); })],
        '証明の確認はまだ対応していません。証明つきの窓口は今は0件です。'),
    );
    aside.firstChild.append(search);
    return aside;
  }

  let results = null;
  function renderResults() {
    if (!results) return;
    const rows = filterApiListings(getListings(), state);
    const toolbar = make('div', 'amv-toolbar');
    const count = make('p', 'amv-count', `${rows.length} 件`); count.setAttribute('role', 'status');
    const sorts = make('div', 'amv-sorts'); sorts.setAttribute('role', 'group'); sorts.setAttribute('aria-label', '並べ替え');
    for (const key of SORTS) sorts.append(pressed(button('amv-sort', SORT_LABEL[key], () => { state.sort = key; renderResults(); }), state.sort === key));
    toolbar.append(count, sorts);
    const nodes = [toolbar];
    if (!rows.length) {
      const empty = make('div', 'amv-empty');
      empty.append(make('p', 'amv-empty-title', getListings().length ? '条件に合う窓口はありません' : 'まだ出品がありません'));
      nodes.push(empty);
    } else {
      const head = make('div', 'amv-head'); head.setAttribute('aria-hidden', 'true');
      for (const label of ['窓口', '1 回の価格（USDC）', '上限額（USDC）', '速さ（申告）', 'データ（申告）', '証明']) head.append(make('span', '', label));
      const list = make('ul', 'amv-rows'); list.setAttribute('aria-label', '窓口の一覧');
      for (const l of rows) {
        const item = make('li');
        const row = button('amv-row', '', () => open(l.id));
        const name = make('span', 'amv-name');
        const title = make('span', 'amv-title');
        title.append(make('strong', '', l.providerName), make('span', 'amv-kind', KIND_LABEL[l.kind]));
        const meta = l.kind === 'ai' ? `${l.modelIds.slice(0, 3).join(', ')}${l.modelIds.length > 3 ? ` ほか ${l.modelIds.length - 3}` : ''}` : (l.purpose || '用途の申告なし');
        name.append(title, make('span', 'amv-meta', meta));
        const cell = (label, value, sub) => { const c = make('span', 'amv-cell'); c.append(make('span', 'amv-label', `${label} `), make('span', 'amv-num', value)); if (sub) c.append(make('span', 'amv-sub', sub)); return c; };
        row.append(name, cell('1 回の価格（USDC）', amount(l.priceAtomic ?? l.maxPriceAtomic)), cell('上限額（USDC）', amount(l.maxPriceAtomic)),
          cell('速さ（申告）', latencyText(l.declaredLatencyMs)), cell(`データ（${DATA_HANDLING_LABEL}）`, dataText(l), l.dataHandling.processingRegion), cell('証明', 'なし'));
        item.append(row); list.append(item);
      }
      nodes.push(head, list);
    }
    results.replaceChildren(...nodes);
  }

  function fact(dl, term, value) { const d = make('div'); d.append(make('dt', '', term)); const dd = make('dd'); if (typeof value === 'string') dd.textContent = value; else dd.append(value); d.append(dd); dl.append(d); }
  function section(title, ...children) { const s = make('section', 'amv-sec'); s.append(make('h3', 'amv-sec-title', title), ...children); return s; }

  function detail(l) {
    const split = splitAmount(l.maxPriceAtomic);
    const sent = l.kind === 'ai' ? 'プロンプト' : '送ったデータ';
    let hostName = ''; try { hostName = new URL(l.baseUrl).host; } catch { hostName = ''; }
    const wrap = make('div', 'amv-detail');
    const head = make('div', 'amv-detail-head');
    const back = button('amv-back', '', () => { state.openId = null; render(); }); back.setAttribute('aria-label', '一覧へ戻る'); back.title = '一覧へ戻る';
    back.append(make('span', 'amv-back-glyph', '←'));
    const heading = make('h2', 'amv-detail-title', l.providerName);
    head.append(back, heading, make('span', 'amv-kind', KIND_LABEL[l.kind]));
    const main = make('div', 'amv-detail-main');
    const intro = make('div', 'amv-intro');
    intro.append(make('p', 'amv-purpose', l.purpose || '用途の申告はありません。'), make('p', 'amv-seller', `売り手は ${l.providerName} です。jkamma は売り手ではありません。${sent}はこの提供者に届きます。`));
    const endpoint = make('dl', 'amv-facts');
    const url = make('code', '', l.baseUrl); fact(endpoint, 'URL', url);
    fact(endpoint, '種類', KIND_LABEL[l.kind]);
    if (l.kind === 'ai') fact(endpoint, 'モデル', l.modelIds.join(', '));
    fact(endpoint, `速さ（${DATA_HANDLING_LABEL}）`, latencyText(l.declaredLatencyMs));
    if (l.openapiUrl) {
      const link = button('amv-link', 'OpenAPI の説明書を開く（アプリの外へ）', () => openExternal(l.openapiUrl));
      fact(endpoint, 'API の説明書', link);
    }
    const pricing = make('dl', 'amv-facts');
    fact(pricing, '1 回あたりの価格', priceText(l.priceAtomic ?? l.maxPriceAtomic));
    fact(pricing, '1 回あたりの上限額', priceText(l.maxPriceAtomic));
    fact(pricing, '上限額の内訳', `売り手 ${priceText(split.sellerAtomic)} ／ Hub 手数料 1%（${priceText(split.feeAtomic)}）`);
    fact(pricing, '支払い先（スプリッター）', make('code', '', l.payeeAddress));
    fact(pricing, 'ネットワーク', 'テスト用ネットワークのみ');
    const data = make('dl', 'amv-facts');
    fact(data, '保存', l.dataHandling.retention ? 'あり' : 'なし');
    fact(data, '学習への利用', l.dataHandling.training ? 'あり' : 'なし');
    fact(data, '処理する国・地域', l.dataHandling.processingRegion);
    fact(data, '秘密計算の証明', 'なし（未対応のため、秘密の内容は送られません）');
    main.append(intro, section('窓口', endpoint), section('料金', pricing),
      section(`データの扱い（${DATA_HANDLING_LABEL}）`, data, make('p', 'amv-note', 'これは提供者の申告で、jkamma は確認していません。')));

    const use = make('aside', 'amv-use'); use.setAttribute('aria-label', '使う');
    use.append(make('h3', 'amv-sec-title', '使う'), make('p', 'amv-use-label', '1 回あたりの上限額'), make('p', 'amv-use-max amv-num', priceText(l.maxPriceAtomic)),
      make('p', 'amv-use-text', '支払いの前に、この上限額がウォレットに表示されます。署名はこの端末で行い、支払いは売り手のスプリッターへ直接届きます。'),
      make('p', 'amv-use-text', `${sent}は${hostName ? ` ${hostName} ` : 'この窓口'}へ、この端末から直接送られます。Hub は中継しません。`));
    if (l.kind === 'ai' && market) {
      const status = make('p', 'amv-use-text'); status.setAttribute('role', 'status');
      const model = l.modelIds[0];
      const go = button('amv-btn amv-btn-primary', `AI 画面で ${model} を使う`, async () => {
        if (await market.confirmUse(l) === true) onUse(l, model);
        else status.textContent = '使うのをやめました。';
      });
      use.append(go, status);
    } else {
      use.append(make('p', 'amv-use-text', l.kind === 'ai' ? 'AI 画面のモデルの一覧から選べます。' : '使うには、説明書に沿ってあなたのアプリから窓口を呼びます。'));
    }
    const body = make('div', 'amv-detail-body');
    body.append(main, use);
    wrap.append(head, body);
    return wrap;
  }

  function open(id) { state.openId = id; render(); }

  function render() {
    const l = state.openId ? getListings().find((x) => x.id === state.openId) : null;
    if (state.openId && !l) state.openId = null;
    const root = make('div', 'amv');
    root.append(make('p', 'amv-lead', '売り手が自分で出品したAPIの窓口です。jkamma は売り手ではありません。呼び出しはこの端末から窓口へ直接行われ、Hub は中継しません。支払いはテスト用ネットワークだけです。'));
    if (l) { root.append(detail(l)); results = null; }
    else {
      const layout = make('div', 'amv-layout');
      results = make('section', 'amv-results'); results.setAttribute('aria-label', '窓口の一覧');
      layout.append(filtersColumn(), results);
      root.append(layout);
      renderResults();
    }
    host.replaceChildren(root);
  }

  return { render, open, state: () => ({ ...state }) };
}
