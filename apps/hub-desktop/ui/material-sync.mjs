// Windows 11 の Mica を、アプリの配色（data-theme）とその設定（data-theme-mode）に合わせ続ける。
// Mica は OS の配色ではなく窓の暗モード属性に従うので、Rust 側へ「解決した配色」と「設定」を毎回渡す。
// 起動時に 1 回、そのあと data-theme / data-theme-mode が変わるたびに呼ぶ。同じ組なら呼ばない。
export function createMaterialSync({ root, invoke, MutationObserverImpl = globalThis.MutationObserver }) {
  let last = '';
  let token = 0;
  const sync = () => {
    const dark = root.dataset.theme !== 'light';
    const mode = ['dark', 'light', 'system'].includes(root.dataset.themeMode) ? root.dataset.themeMode : (dark ? 'dark' : 'light');
    const key = `${mode}:${dark}`;
    if (last === key) return Promise.resolve();
    last = key;
    const mine = ++token;
    // 呼び出しは順番どおりに Rust へ届く。遅れて返った古い結果は捨てる。
    return Promise.resolve().then(() => invoke('window_material', { dark, mode })).then((on) => {
      if (mine !== token) return;
      if (on) root.dataset.material = 'mica'; else delete root.dataset.material;
    }).catch(() => { if (mine === token) delete root.dataset.material; });
  };
  if (MutationObserverImpl) new MutationObserverImpl(sync).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-theme-mode'] });
  sync();
  return { sync };
}
