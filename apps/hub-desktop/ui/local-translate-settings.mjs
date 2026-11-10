// 設定の「端末内翻訳」。モデルは用途別に別々で、使うものだけ取得する。重みは同梱しない。
//   日本語↔英語: PLaMo 3 Translate（PLaMo Community License。同意が要る）
//   その他の言語: TranslateGemma 4B（Gemma 利用規約と禁止使用方針。同意が要る。
//     自分で用意した GGUF を使うか、第三者の変換物を取得する）
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

export const GEMMA_TERMS_URL = 'https://ai.google.dev/gemma/terms';
export const GEMMA_PROHIBITED_USE_URL = 'https://ai.google.dev/gemma/prohibited_use_policy';

export const FAMILIES = {
  plamo: {
    title: '日本語 ↔ 英語（PLaMo 3 Translate）',
    notice: [
      'モデルは Preferred Networks の PLaMo Community License で提供されます。オープンソースではありません。',
      '個人利用と非営利利用（学術を含む）は無料で、事前の登録は要りません。',
      '営利利用は、利用者と関連会社の直近の年間売上が10億円以下なら、PFN の登録フォームで登録すれば無料です。',
      '10億円を超える場合は PFN との別の契約が要ります。',
      '訳文を公開するときは、モデルの出力であることを明示する必要があります。そのため、PLaMo の訳は共有しません。',
    ],
    agree: '内容を読んで同意する',
  },
  gemma: {
    title: 'その他の言語（TranslateGemma 4B）',
    notice: [
      'モデルは Google の TranslateGemma 4B です。Gemma 利用規約と、Gemma 禁止使用方針に従って使います。',
      '禁止使用方針は、他人の権利の侵害、違法・有害な目的、だます目的、嫌がらせや憎悪をあおる使い方などを禁じています。他人の投稿を訳すときも同じです。',
      'Google の公式の配布は Hugging Face での承認が要り、llama.cpp では読めない形式です。',
      '取得できるのは第三者（bullerwins）が変換したファイルで、Google が作ったものではありません。自分で変換した GGUF を指定して使うこともできます。',
    ],
    agree: 'Gemma 利用規約と禁止使用方針に同意する',
  },
};
// 旧名（互換）
export const LICENCE_SUMMARY = FAMILIES.plamo.notice;

export function renderTranslateSettings({doc = document, root, invoke, onChange = () => {}, poll = (fn) => setInterval(fn, 1000), unpoll = clearInterval}) {
  root.className = 'local-translate-panel';
  let timer = null;
  async function draw() {
    const s = await invoke('local_translate_status', {});
    root.textContent = '';
    const el = (tag, text, cls) => { const e = doc.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
    let downloading = false;
    for (const fam of s.families) {
      const meta = FAMILIES[fam.family];
      if (!meta) continue;
      const section = el('section', undefined, 'lt-family');
      section.dataset.family = fam.family;
      section.append(el('h3', meta.title));
      const models = s.models.filter((m) => m.family === fam.family);
      if (!fam.licenceAccepted) {
        const box = el('div', undefined, 'lt-licence');
        for (const line of meta.notice) box.append(el('p', line));
        box.append(el('p', `取得できるモデル: ${models.map((m) => `${m.id} ${fmt(m.bytes)}${m.thirdParty ? '（第三者の変換物）' : ''}`).join(' / ')}`));
        const links = fam.family === 'gemma'
          ? [['Gemma 利用規約', fam.licenceUrlJa || GEMMA_TERMS_URL], ['Gemma 禁止使用方針', fam.prohibitedUseUrl || GEMMA_PROHIBITED_USE_URL]]
          : [['ライセンス全文', fam.licenceUrlJa], ['License (English)', fam.licenceUrlEn]];
        for (const [label, href] of links) {
          if (!href) continue;
          const a = el('a', label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; box.append(a, doc.createTextNode(' '));
        }
        const agree = el('button', meta.agree);
        agree.dataset.action = 'accept';
        agree.addEventListener('click', async () => { await invoke('local_translate_accept_licence', {family: fam.family, accept: true}); await draw(); onChange(); });
        section.append(box, agree);
        root.append(section);
        continue;
      }
      let cur = models[0];
      if (models.length > 1) {
        cur = models.find((m) => m.id === s.selected) ?? models[0];
        const sizeRow = el('div', undefined, 'lt-row');
        for (const m of models) {
          const b = el('button', `${m.id.replace(/^plamo-/, '').toUpperCase()}（${fmt(m.bytes)}）${m.installed ? ' 取得済み' : ''}`);
          b.dataset.size = m.id;
          b.setAttribute('aria-pressed', String(m.id === cur.id));
          b.addEventListener('click', async () => { await invoke('local_translate_select', {size: m.id}); await draw(); onChange(); });
          sizeRow.append(b);
        }
        section.append(sizeRow);
      }
      const p = s.progress;
      const status = el('p', '');
      let hasLocal = false;
      if (fam.family === 'gemma') {
        // 自分で用意した GGUF（公式の重みから変換したものなど）。あれば取得版より先に使う。
        const lg = s.localGguf;
        const row = el('div', undefined, 'lt-row');
        row.dataset.role = 'local-gguf';
        if (lg) {
          hasLocal = true;
          row.append(el('span', `使用中: ${lg.name}（${fmt(lg.bytes)}）SHA-256 ${String(lg.sha256).slice(0, 12)}…${lg.present ? '' : ' ファイルが見つかりません'}`));
          const verify = el('button', '検証');
          verify.dataset.action = 'verify-local';
          verify.addEventListener('click', async () => {
            verify.disabled = true;
            const ok = await invoke('local_translate_verify', {size: 'gemma-local'});
            status.textContent = ok ? '記録したハッシュと一致します' : '一致しません。ファイルが変わっています';
            verify.disabled = false;
          });
          const clear = el('button', '登録を外す');
          clear.dataset.action = 'clear-gguf';
          clear.addEventListener('click', async () => { await invoke('local_translate_clear_gguf', {}); await draw(); onChange(); });
          row.append(verify, clear);
        } else {
          const pick = el('button', '自分で用意した GGUF を使う');
          pick.dataset.action = 'pick-gguf';
          pick.addEventListener('click', async () => {
            pick.disabled = true;
            try { await invoke('local_translate_pick_gguf', {}); await draw(); onChange(); }
            catch { status.textContent = 'GGUF ファイルではありません'; pick.disabled = false; }
          });
          row.append(pick);
        }
        section.append(row);
        if (lg) section.append(el('p', '登録したファイルは複製せず、その場所のまま使います。登録を外してもファイルは消えません。', 'meta'));
      }
      if (p.state === 'downloading' && p.size === cur.id) {
        downloading = true;
        const bar = doc.createElement('progress');
        bar.max = p.total; bar.value = p.done;
        const stop = el('button', '中止');
        stop.dataset.action = 'cancel';
        stop.addEventListener('click', () => invoke('local_translate_cancel_download', {}));
        section.append(bar, el('span', `${fmt(p.done)} / ${fmt(p.total)}`), stop);
      } else if (!hasLocal) {
        const row = el('div', undefined, 'lt-row');
        if (!cur.installed) {
          const label = cur.thirdParty ? '第三者の変換物を取得' : '取得する';
          const get = el('button', cur.partialBytes ? `続きから取得（残り ${fmt(cur.bytes - cur.partialBytes)}）` : `${label}（${fmt(cur.bytes)}）`);
          get.dataset.action = 'download';
          get.addEventListener('click', async () => { await invoke('local_translate_download', {size: cur.id}); await draw(); });
          row.append(get);
        } else {
          const verify = el('button', '検証');
          verify.dataset.action = 'verify';
          verify.addEventListener('click', async () => {
            verify.disabled = true;
            const ok = await invoke('local_translate_verify', {size: cur.id});
            status.textContent = ok ? '正しいファイルです' : '一致しません。削除して取り直してください';
            verify.disabled = false;
          });
          const del = el('button', '削除');
          del.dataset.action = 'delete';
          del.addEventListener('click', async () => { await invoke('local_translate_delete', {size: cur.id}); await draw(); onChange(); });
          row.append(verify, del);
        }
        section.append(row);
        if (p.state === 'failed' && p.size === cur.id && p.error) section.append(el('p', p.error === 'translate_hash_mismatch' ? '取得したファイルが一致しなかったため消しました' : '取得できませんでした'));
      }
      if (!s.runtimeFound) status.textContent = 'llama-server が見つかりません。llama.cpp を入れるか、場所を指定してください。';
      section.append(status);
      if (fam.family === 'plamo') section.append(el('p', 'PLaMo の訳は共有しません（公開するには出力であることの明示が要るため）。', 'meta'));
      root.append(section);
    }
    if (s.api) root.append(drawApi(s.api));
    if (downloading && !timer) timer = poll(draw);
    if (!downloading && timer) { unpoll(timer); timer = null; }
  }
  // 2 段目: 「AIの接続」に保存済みの自分の API モデルで訳す。キーは扱わない（接続 ID とモデル名だけ）。既定は使わない。
  function drawApi(api) {
    const el = (tag, text, cls) => { const e = doc.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
    const section = el('section', undefined, 'lt-family lt-api');
    section.dataset.family = 'api';
    section.append(el('h3', '自分の API モデルで訳す'));
    const note = el('p', '', 'meta');
    const pick = el('select');
    pick.setAttribute('aria-label', '翻訳に使う API の接続');
    const none = el('option', '使わない（端末のモデルで訳す）'); none.value = '';
    pick.append(none);
    for (const c of api.choices || []) { const o = el('option', c.name); o.value = c.id; if (c.id === api.connectionId) o.selected = true; pick.append(o); }
    const model = el('input'); model.type = 'text'; model.value = api.model || ''; model.placeholder = 'モデル名（空なら接続の既定）'; model.disabled = !api.connectionId;
    model.setAttribute('aria-label', '翻訳に使う API のモデル名');
    const allow = el('input'); allow.type = 'checkbox'; allow.checked = api.allowPrivate === true; allow.disabled = !api.connectionId;
    const allowLabel = el('label'); allowLabel.append(allow, doc.createTextNode(' 非公開の中身もAPIで訳す'));
    const warn = el('p', 'オンにすると、DM・フォロワー限定・非公開グループ・ゲート付きの本文が、選んだ提供元に送られます。オフなら、これらは端末の中だけで訳します。', 'meta');
    const fail = (error) => { note.textContent = String(error?.message ?? error ?? '').startsWith('byok_') ? 'この接続は使えません。「AIの接続」で有効にしてください' : '保存できませんでした'; };
    const save = async () => { try { await invoke('local_translate_api_set', {connectionId: pick.value || null, model: model.value.trim() || null}); await draw(); onChange(); } catch (error) { fail(error); } };
    pick.addEventListener('change', save);
    model.addEventListener('change', save);
    allow.addEventListener('change', async () => { try { await invoke('local_translate_api_allow_private', {allow: allow.checked}); await draw(); onChange(); } catch (error) { fail(error); } });
    section.append(pick, model, allowLabel, warn, note);
    if (!(api.choices || []).length) note.textContent = '使える接続がありません。「AIの接続」で API キーを登録してください。';
    return section;
  }
  const ready = draw();
  return {ready, redraw: draw, dispose: () => { if (timer) unpoll(timer); }};
}
