// 最初の描画の前に外観を適用する小さな同期スクリプト（CSPの 'self' で読み込む）。
// 規則は appearance.mjs の applyAppearance / loadAppearance と同じ。変えるときは両方と appearance.test.mjs を揃える。
(function () {
  var TEMPLATE_KEY = 'hub.desktop.template', APPEARANCE_KEY = 'hub.desktop.appearance';
  var IDS = { light: 'light', dark: 'dark', noir: 'dark', ivory: 'light', midnight: 'dark' };
  var template = 'noir', crisp = false, textSize = 'normal', density = 'normal', reduce = false, clear = false;
  var storage = null, old = null, saved = null;
  try { storage = window.localStorage; } catch (e) { /* 保存が読めなければ既定 */ }
  function read(key) { try { return JSON.parse(storage.getItem(key) || 'null'); } catch (e) { return null; } }
  old = read(APPEARANCE_KEY);
  saved = read(TEMPLATE_KEY);
  if (saved && typeof saved === 'object') {
    if (saved.template === 'device' || IDS.hasOwnProperty(saved.template)) template = saved.template;
    crisp = saved.crisp === true;
  } else if (old && typeof old === 'object') {
    // 旧い theme / palette から 1 度だけ移す: 黒金ダーク→noir、黒金ライト→ivory、白黒ライト→light、白黒ダーク→dark。
    var theme = old.theme === 'light' || old.theme === 'system' || old.theme === 'dark' ? old.theme : null;
    var gold = old.palette === 'gold-ivory';
    if (theme !== null || gold || old.palette === 'standard') {
      template = theme === 'system' ? 'device' : theme === 'light' ? (gold ? 'ivory' : 'light') : (gold ? 'noir' : 'dark');
      try { storage.setItem(TEMPLATE_KEY, JSON.stringify({ template: template, crisp: false })); } catch (e) { /* 書けなくてもこの起動では効く */ }
    }
  }
  if (old && typeof old === 'object') {
    if (old.textSize === 'large' || old.textSize === 'xlarge') textSize = old.textSize;
    if (old.density === 'roomy') density = 'roomy';
    reduce = old.reduceMotion === true;
    clear = old.reduceTransparency === true;
  }
  var dark = true;
  try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { /* 既定はダーク */ }
  var id = template === 'device' ? (dark ? 'dark' : 'light') : template;
  var root = document.documentElement;
  root.setAttribute('data-template', id);
  root.setAttribute('data-theme', IDS[id]);
  root.setAttribute('data-theme-mode', template === 'device' ? 'system' : IDS[id]);
  if (crisp) root.setAttribute('data-crisp', '');
  root.setAttribute('data-text-size', textSize);
  root.setAttribute('data-density', density);
  if (reduce) root.setAttribute('data-motion', 'reduce');
  if (clear) root.setAttribute('data-transparency', 'reduce');
})();
